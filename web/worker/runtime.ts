import { sanitizeWorkerMessage } from './redaction'
import { defaultOnFeatureFlagState, explicitOptInFeatureFlagEnabled } from './feature-flags'
import { hostRepositoryWritePolicyState } from './repository-edit-policy'
import type { QueueRetryResult } from './queue'

const DEFAULT_CLAIM_TIMEOUT_SECONDS = 5
const APPROVAL_CLAIM_TIMEOUT_SECONDS = 1
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_STUCK_JOB_RECOVERY_SECONDS = 15 * 60
const MAX_QUEUE_RECOVERY_INTERVAL_MS = 60_000
const DEFAULT_PROVIDER_HEALTH_INTERVAL_SECONDS = 5 * 60
const DEFAULT_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = 5 * 60
const DEFAULT_SESSION_CACHE_PURGE_INTERVAL_SECONDS = 60

type WorkerSource = 'standalone' | 'embedded'

export type WorkerHandle = {
  done: Promise<void>
  stop: () => Promise<void>
}

type WorkerState = {
  handle: WorkerHandle | null
  starting: Promise<WorkerHandle> | null
}

const globalForWorker = globalThis as unknown as {
  forgeWorkerRuntime?: WorkerState
}

function state(): WorkerState {
  globalForWorker.forgeWorkerRuntime ??= { handle: null, starting: null }
  return globalForWorker.forgeWorkerRuntime
}

function getClaimTimeoutSeconds(): number {
  const raw = process.env.FORGE_WORKER_CLAIM_TIMEOUT_SECONDS
  if (!raw) return DEFAULT_CLAIM_TIMEOUT_SECONDS

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('FORGE_WORKER_CLAIM_TIMEOUT_SECONDS must be a positive number')
  }

  return parsed
}

function getPositiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }

  return parsed
}

function getNonNegativeIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }

  return parsed
}

function backoffDelayMs(attempt: number): number {
  return Math.min(2 ** Math.max(attempt - 1, 0) * 1000, 30_000)
}

function retainedErrorMessage(err: unknown): string {
  return sanitizeWorkerMessage(err instanceof Error ? err.message : String(err))
}

export async function startWorker(source: WorkerSource = 'standalone'): Promise<WorkerHandle> {
  const currentState = state()
  if (currentState.handle) return currentState.handle
  if (currentState.starting) return currentState.starting

  const starting = startWorkerOnce(source, currentState)
  currentState.starting = starting

  try {
    return await starting
  } finally {
    currentState.starting = null
  }
}

async function startWorkerOnce(
  source: WorkerSource,
  currentState: WorkerState,
): Promise<WorkerHandle> {
  const [{
    AnswersQueue,
    ApprovalQueue,
    RetryPromotionConflictError,
    TaskQueue,
  }, {
    processAnsweredQuestions,
    processApproval,
    processTask,
  }] = await Promise.all([
    import('./queue'),
    import('./orchestrator'),
  ])
  const { finishTaskAttempt, startTaskAttempt } = await import('./task-attempts')
  const [{ db }, { tasks }, { eq }] = await Promise.all([
    import('../db'),
    import('../db/schema'),
    import('drizzle-orm'),
  ])

  const taskQueue = new TaskQueue()
  const approvalQueue = new ApprovalQueue()
  const answersQueue = new AnswersQueue()
  const claimTimeoutSeconds = getClaimTimeoutSeconds()
  const maxAttempts = getPositiveIntegerEnv('FORGE_WORKER_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS)
  const stuckJobRecoveryMs =
    getPositiveIntegerEnv('FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS', DEFAULT_STUCK_JOB_RECOVERY_SECONDS) *
    1000
  const providerHealthIntervalSeconds = getNonNegativeIntegerEnv(
    'FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS',
    DEFAULT_PROVIDER_HEALTH_INTERVAL_SECONDS,
  )
  const blockedHandoffSweepIntervalSeconds = getNonNegativeIntegerEnv(
    'FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS',
    DEFAULT_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS,
  )
  const sessionCachePurgeIntervalSeconds = getNonNegativeIntegerEnv(
    'FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS',
    DEFAULT_SESSION_CACHE_PURGE_INTERVAL_SECONDS,
  )
  const workerId = `${source}-${process.pid}-${Date.now().toString(36)}`
  let shuttingDown = false
  let providerHealthTimer: ReturnType<typeof setInterval> | null = null
  let providerHealthRunning = false
  let blockedHandoffSweepTimer: ReturnType<typeof setInterval> | null = null
  let blockedHandoffSweepRunning = false
  let sessionCachePurgeTimer: ReturnType<typeof setInterval> | null = null
  let sessionCachePurgeRunning = false
  let queueRecoveryTimer: ReturnType<typeof setInterval> | null = null
  let queueRecoveryRun: Promise<void> | null = null

  const taskExists = async (taskId: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    return row !== undefined
  }

  type RuntimeJob = {
    attempt: number
    taskId: string
  }
  type RuntimeQueue<TJob extends RuntimeJob> = {
    ack: (raw: string) => Promise<unknown>
    deadLetter: (raw: string, job: TJob) => Promise<unknown>
    release: (raw: string) => Promise<unknown>
    retry: (raw: string, job: TJob, delayMs: number) => Promise<QueueRetryResult>
  }
  type QueueOperation = 'approval' | 'answers' | 'task'
  type QueueInfrastructurePhase =
    | 'ack_after_success'
    | 'ack_missing_task'
    | 'dead_letter'
    | 'release_after_shutdown'
    | 'retry'
    | 'retry_reconciliation'
    | 'task_lookup'
  type AttemptInfrastructurePhase = 'finish_after_failure' | 'finish_after_success' | 'start'

  const logQueueInfrastructureFailure = (
    phase: QueueInfrastructurePhase,
    queueName: QueueOperation,
    taskId: string,
  ): void => {
    console.error('[worker] Queue infrastructure failure', {
      phase,
      queueName,
      taskId,
      workerId,
    })
  }

  const logAttemptInfrastructureFailure = (
    phase: AttemptInfrastructurePhase,
    queueName: QueueOperation,
    taskId: string,
  ): void => {
    console.error('[worker] Attempt persistence failure', {
      phase,
      queueName,
      taskId,
      workerId,
    })
  }

  const acknowledgeMissingTaskJob = async (
    queueName: QueueOperation,
    taskId: string,
    ack: () => Promise<unknown>,
  ): Promise<'acknowledged' | 'present' | 'retained'> => {
    let exists: boolean
    try {
      exists = await taskExists(taskId)
    } catch {
      logQueueInfrastructureFailure('task_lookup', queueName, taskId)
      return 'retained'
    }
    if (exists) return 'present'

    try {
      await ack()
      console.info('[worker] Dropped job for deleted task', {
        queueName,
        taskId,
        workerId,
      })
      return 'acknowledged'
    } catch {
      logQueueInfrastructureFailure('ack_missing_task', queueName, taskId)
      return 'retained'
    }
  }

  const processClaimedJob = async <TJob extends RuntimeJob>(input: {
    attemptQueueName: 'answers' | 'approvals' | 'tasks'
    claimed: { job: TJob; raw: string }
    processBusiness: (finalAttempt: boolean) => Promise<void>
    queue: RuntimeQueue<TJob>
    queueName: QueueOperation
  }): Promise<void> => {
    const { claimed, queue, queueName } = input
    const { job, raw } = claimed
    const finalAttempt = job.attempt >= maxAttempts

    const missingTaskDisposition = await acknowledgeMissingTaskJob(
      queueName,
      job.taskId,
      () => queue.ack(raw),
    )
    if (missingTaskDisposition !== 'present') return

    let attemptId: string
    try {
      attemptId = await startTaskAttempt({
        attemptNumber: job.attempt,
        jobPayload: job,
        queueName: input.attemptQueueName,
        taskId: job.taskId,
        workerId,
      })
    } catch {
      logAttemptInfrastructureFailure('start', queueName, job.taskId)
      return
    }

    console.info('[worker] Processing job', {
      attempt: job.attempt,
      finalAttempt,
      queueName,
      taskId: job.taskId,
      workerId,
    })

    try {
      await input.processBusiness(finalAttempt)
    } catch (err) {
      const message = retainedErrorMessage(err)
      console.error('[worker] Job processing failed', {
        attempt: job.attempt,
        finalAttempt,
        queueName,
        taskId: job.taskId,
        workerId,
      })

      if (finalAttempt) {
        try {
          await finishTaskAttempt({
            attemptId,
            errorMessage: message,
            nextRetryAt: null,
            status: 'dead_lettered',
          })
        } catch {
          logAttemptInfrastructureFailure('finish_after_failure', queueName, job.taskId)
        }
        try {
          await queue.deadLetter(raw, job)
        } catch {
          logQueueInfrastructureFailure('dead_letter', queueName, job.taskId)
        }
        return
      }

      const retryDelayMs = backoffDelayMs(job.attempt)
      let retryResult: QueueRetryResult
      try {
        retryResult = await queue.retry(raw, job, retryDelayMs)
      } catch {
        logQueueInfrastructureFailure('retry', queueName, job.taskId)
        try {
          retryResult = await queue.retry(raw, job, retryDelayMs)
        } catch {
          logQueueInfrastructureFailure('retry_reconciliation', queueName, job.taskId)
          try {
            await finishTaskAttempt({
              attemptId,
              errorMessage: message,
              nextRetryAt: null,
              status: 'indeterminate',
            })
          } catch {
            logAttemptInfrastructureFailure('finish_after_failure', queueName, job.taskId)
          }
          return
        }
      }
      try {
        await finishTaskAttempt({
          attemptId,
          errorMessage: message,
          nextRetryAt: retryResult.nextRetryAt,
          status: 'failed',
        })
      } catch {
        logAttemptInfrastructureFailure('finish_after_failure', queueName, job.taskId)
      }
      return
    }

    try {
      await finishTaskAttempt({ attemptId, status: 'completed' })
    } catch {
      logAttemptInfrastructureFailure('finish_after_success', queueName, job.taskId)
    }
    try {
      await queue.ack(raw)
    } catch {
      logQueueInfrastructureFailure('ack_after_success', queueName, job.taskId)
    }
  }

  const releaseClaimAfterShutdown = async <TJob extends RuntimeJob>(input: {
    claimed: { job: TJob; raw: string }
    queue: RuntimeQueue<TJob>
    queueName: QueueOperation
  }): Promise<void> => {
    try {
      await input.queue.release(input.claimed.raw)
    } catch {
      logQueueInfrastructureFailure(
        'release_after_shutdown',
        input.queueName,
        input.claimed.job.taskId,
      )
    }
  }

  const refreshProviderHealth = async (): Promise<void> => {
    if (providerHealthIntervalSeconds === 0 || providerHealthRunning) return
    providerHealthRunning = true
    try {
      const { refreshStaleProviderHealth } = await import('../lib/providers/health')
      const checked = await refreshStaleProviderHealth(providerHealthIntervalSeconds * 1000)
      if (checked > 0) {
        console.info('[worker] Refreshed provider health cache', { checked, workerId })
      }
    } catch {
      console.warn('[worker] Provider health refresh failed', { workerId })
    } finally {
      providerHealthRunning = false
    }
  }

  // Auto-recovery for packages parked at `blocked` by the MCP/capability broker
  // (e.g. a transiently-unhealthy MCP). The task is left at `approved`, so we
  // re-enqueue an approval job and let processApproval re-run the broker — if the
  // block still applies it simply re-blocks, so this never bypasses the gate.
  const sweepBlockedHandoffs = async (options: { startup?: boolean } = {}): Promise<void> => {
    if ((!options.startup && blockedHandoffSweepIntervalSeconds === 0) || blockedHandoffSweepRunning) return
    blockedHandoffSweepRunning = true
    try {
      const [
        { db },
        { tasks, workPackages },
        { enqueueDueBlockedHandoffRetries },
        { convergeRecognizedOperatorHolds },
        { reconcilePendingS4CompletionHandoffs },
        { and, eq },
      ] = await Promise.all([
        import('../db'),
        import('../db/schema'),
        import('./blocked-handoff-retry'),
        import('../lib/mcps/filesystem-grant-reconciliation'),
        import('./work-package-handoff'),
        import('drizzle-orm'),
      ])
      const stuck = await db
        .select({
          metadata: workPackages.metadata,
          taskId: workPackages.taskId,
        })
        .from(workPackages)
        .innerJoin(tasks, eq(tasks.id, workPackages.taskId))
        .where(and(eq(workPackages.status, 'blocked'), eq(tasks.status, 'approved')))

      const recoveredS4Handoffs = await reconcilePendingS4CompletionHandoffs(100, {
        drain: options.startup === true,
        workerId,
      })
      const enqueued = await enqueueDueBlockedHandoffRetries(stuck)
      const converged = await convergeRecognizedOperatorHolds()
      if (enqueued > 0) {
        console.info('[worker] Re-enqueued blocked handoffs for retry', { count: enqueued, workerId })
      }
      if (converged > 0) {
        console.info('[worker] Converged running tasks with operator holds', { count: converged, workerId })
      }
      if (recoveredS4Handoffs > 0) {
        console.info('[worker] Recovered protected completion handoffs', { count: recoveredS4Handoffs, workerId })
      }
    } catch {
      console.warn('[worker] Blocked-handoff sweep failed', { workerId })
    } finally {
      blockedHandoffSweepRunning = false
    }
  }

  // This maintenance path is deliberately independent of handoff/S4 recovery:
  // a failed handoff sweep must never strand a revoked session cache key.
  const sweepSessionCachePurges = async (options: { startup?: boolean } = {}): Promise<void> => {
    if ((!options.startup && sessionCachePurgeIntervalSeconds === 0) || sessionCachePurgeRunning) return
    sessionCachePurgeRunning = true
    try {
      const { reconcilePendingSessionCacheInvalidations } = await import('../lib/session')
      const reconciled = await reconcilePendingSessionCacheInvalidations(100)
      if (reconciled.claimed > 0) {
        console.info('[worker] Reconciled revoked session caches', {
          claimed: reconciled.claimed,
          completed: reconciled.completed,
          deferred: reconciled.deferred,
          stale: reconciled.stale,
          workerId,
        })
      }
    } catch {
      console.warn('[worker] Session cache purge sweep failed', { workerId })
    } finally {
      sessionCachePurgeRunning = false
    }
  }

  const recoverQueueWork = (options: { drain?: boolean } = {}): Promise<void> => {
    if (queueRecoveryRun) return queueRecoveryRun
    queueRecoveryRun = (async () => {
      try {
        const [recoveredApprovals, recoveredAnswers, recoveredTasks] = await Promise.all([
          approvalQueue.recoverStuckJobs(stuckJobRecoveryMs, options),
          answersQueue.recoverStuckJobs(stuckJobRecoveryMs, options),
          taskQueue.recoverStuckJobs(stuckJobRecoveryMs, options),
        ])
        if (recoveredApprovals > 0 || recoveredAnswers > 0 || recoveredTasks > 0) {
          console.warn('[worker] Recovered stuck jobs', {
            approvals: recoveredApprovals,
            answers: recoveredAnswers,
            tasks: recoveredTasks,
            workerId,
          })
        }
      } catch {
        console.error('[worker] Queue recovery fault', { workerId })
      }
    })().finally(() => {
      queueRecoveryRun = null
    })
    return queueRecoveryRun
  }

  const clearWorkerTimers = (): void => {
    if (providerHealthTimer !== null) {
      clearInterval(providerHealthTimer)
      providerHealthTimer = null
    }
    if (blockedHandoffSweepTimer !== null) {
      clearInterval(blockedHandoffSweepTimer)
      blockedHandoffSweepTimer = null
    }
    if (sessionCachePurgeTimer !== null) {
      clearInterval(sessionCachePurgeTimer)
      sessionCachePurgeTimer = null
    }
    if (queueRecoveryTimer !== null) {
      clearInterval(queueRecoveryTimer)
      queueRecoveryTimer = null
    }
  }

  const run = async (): Promise<void> => {
    const executionRequestFlag = defaultOnFeatureFlagState(process.env.FORGE_WORK_PACKAGE_EXECUTION)
    const executionMode = {
      enabled: false,
      recognized: executionRequestFlag.recognized,
      requested: explicitOptInFeatureFlagEnabled(process.env.FORGE_WORK_PACKAGE_EXECUTION),
    }
    const hostWriteMode = hostRepositoryWritePolicyState()
    console.info('[worker] Started', {
      claimTimeoutSeconds,
      hostRepositoryWritesAvailable: hostWriteMode.available,
      hostRepositoryWritesEnabled: hostWriteMode.enabled,
      hostRepositoryWritesFlagRecognized: hostWriteMode.recognized,
      hostRepositoryWritesRequested: hostWriteMode.requested,
      maxAttempts,
      providerHealthIntervalSeconds,
      sessionCachePurgeIntervalSeconds,
      source,
      stuckJobRecoveryMs,
      workPackageExecutionEnabled: executionMode.enabled,
      workPackageExecutionFlagRecognized: executionMode.recognized,
      workPackageExecutionRequested: executionMode.requested,
      workerId,
    })

    if (hostWriteMode.requested) {
      console.warn('[worker] Host repository writes are unavailable; enabled requests fail closed after sandbox output is preserved', {
        flag: hostWriteMode.source,
        workerId,
      })
    }

    try {
      if (providerHealthIntervalSeconds > 0) {
        void refreshProviderHealth()
        providerHealthTimer = setInterval(
          () => void refreshProviderHealth(),
          providerHealthIntervalSeconds * 1000,
        )
      }

      void sweepBlockedHandoffs({ startup: true })
      if (blockedHandoffSweepIntervalSeconds > 0) {
        blockedHandoffSweepTimer = setInterval(
          () => void sweepBlockedHandoffs(),
          blockedHandoffSweepIntervalSeconds * 1000,
        )
      }
      void sweepSessionCachePurges({ startup: true })
      if (sessionCachePurgeIntervalSeconds > 0) {
        sessionCachePurgeTimer = setInterval(
          () => void sweepSessionCachePurges(),
          sessionCachePurgeIntervalSeconds * 1000,
        )
      }

      await recoverQueueWork({ drain: true })
      queueRecoveryTimer = setInterval(
        () => void recoverQueueWork(),
        Math.min(stuckJobRecoveryMs, MAX_QUEUE_RECOVERY_INTERVAL_MS),
      )

      const promoteQueueRetries = async (
        queueName: 'answers' | 'approvals' | 'tasks',
        queue: { promoteDueRetries(): Promise<number> },
      ): Promise<number> => {
        try {
          return await queue.promoteDueRetries()
        } catch (error) {
          if (!(error instanceof RetryPromotionConflictError)) throw error
          console.warn('[worker] Retry promotion compatibility conflict', {
            category: 'mixed_version_retry_promotion',
            queue: queueName,
          })
          return 0
        }
      }

      while (!shuttingDown) {
        const [promotedApprovals, promotedAnswers, promotedTasks] = await Promise.all([
          promoteQueueRetries('approvals', approvalQueue),
          promoteQueueRetries('answers', answersQueue),
          promoteQueueRetries('tasks', taskQueue),
        ])
        if (promotedApprovals > 0 || promotedAnswers > 0 || promotedTasks > 0) {
          console.info('[worker] Promoted retry jobs', {
            approvals: promotedApprovals,
            answers: promotedAnswers,
            tasks: promotedTasks,
            workerId,
          })
        }
        if (shuttingDown) break

        let claimedApproval = null as Awaited<ReturnType<InstanceType<typeof ApprovalQueue>['claim']>>

        try {
          claimedApproval = await approvalQueue.claim(APPROVAL_CLAIM_TIMEOUT_SECONDS)
        } catch {
          if (shuttingDown) break
          console.error('[worker] Failed to claim approval', { workerId })
        }

        if (shuttingDown) {
          if (claimedApproval !== null) {
            await releaseClaimAfterShutdown({
              claimed: claimedApproval,
              queue: approvalQueue,
              queueName: 'approval',
            })
          }
          break
        }
        if (claimedApproval !== null) {
          await processClaimedJob({
            attemptQueueName: 'approvals',
            claimed: claimedApproval,
            processBusiness: (finalAttempt) =>
              processApproval(claimedApproval.job.taskId, { finalAttempt }),
            queue: approvalQueue,
            queueName: 'approval',
          })
        }
        if (shuttingDown) break

        let claimedAnswers = null as Awaited<ReturnType<InstanceType<typeof AnswersQueue>['claim']>>

        try {
          claimedAnswers = await answersQueue.claim(APPROVAL_CLAIM_TIMEOUT_SECONDS)
        } catch {
          if (shuttingDown) break
          console.error('[worker] Failed to claim answers job', { workerId })
        }

        if (shuttingDown) {
          if (claimedAnswers !== null) {
            await releaseClaimAfterShutdown({
              claimed: claimedAnswers,
              queue: answersQueue,
              queueName: 'answers',
            })
          }
          break
        }
        if (claimedAnswers !== null) {
          await processClaimedJob({
            attemptQueueName: 'answers',
            claimed: claimedAnswers,
            processBusiness: async (finalAttempt) =>
              await processAnsweredQuestions(claimedAnswers.job.taskId, { finalAttempt }),
            queue: answersQueue,
            queueName: 'answers',
          })
        }
        if (shuttingDown) break

        let claimedTask = null as Awaited<ReturnType<InstanceType<typeof TaskQueue>['claim']>>

        try {
          claimedTask = await taskQueue.claim(claimTimeoutSeconds)
        } catch {
          if (shuttingDown) break
          console.error('[worker] Failed to claim task', { workerId })
          continue
        }

        if (shuttingDown) {
          if (claimedTask !== null) {
            await releaseClaimAfterShutdown({
              claimed: claimedTask,
              queue: taskQueue,
              queueName: 'task',
            })
          }
          break
        }
        if (claimedTask === null) continue

        await processClaimedJob({
          attemptQueueName: 'tasks',
          claimed: claimedTask,
          processBusiness: (finalAttempt) =>
            processTask(claimedTask.job.taskId, { finalAttempt }),
          queue: taskQueue,
          queueName: 'task',
        })
      }
    } finally {
      clearWorkerTimers()
      await queueRecoveryRun?.catch(() => {})
      taskQueue.disconnect()
      approvalQueue.disconnect()
      answersQueue.disconnect()
      currentState.handle = null
      console.info('[worker] Stopped')
    }
  }

  const done = run()
  done.catch(() => {
    console.error('[worker] Fatal error', { workerId })
  })

  const handle: WorkerHandle = {
    done,
    stop: async () => {
      if (!shuttingDown) {
        shuttingDown = true
        clearWorkerTimers()
      }
      await done.catch(() => {})
    },
  }

  currentState.handle = handle
  return handle
}
