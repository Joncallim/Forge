import { sanitizeWorkerMessage } from './redaction'
import { defaultOnFeatureFlagState, explicitOptInFeatureFlagEnabled } from './feature-flags'
import { hostRepositoryWritePolicyState } from './repository-edit-policy'
import type { QueueClaimRenewalResult, QueueRetryResult } from './queue'
import {
  ClaimLeaseFence,
  isClaimLeaseLostError,
  type QueueClaimBusinessDisposition,
  type QueueClaimExecutionContext,
} from './claim-lease-fence'

const DEFAULT_CLAIM_TIMEOUT_SECONDS = 5
const APPROVAL_CLAIM_TIMEOUT_SECONDS = 1
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_STUCK_JOB_RECOVERY_SECONDS = 15 * 60
const MIN_CLAIM_RENEWAL_INTERVAL_MS = 100
const MAX_QUEUE_RECOVERY_INTERVAL_MS = 60_000
const DEFAULT_PROVIDER_HEALTH_INTERVAL_SECONDS = 5 * 60
const DEFAULT_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = 5 * 60
const DEFAULT_SESSION_CACHE_PURGE_INTERVAL_SECONDS = 60
const ADOPTION_PENDING_OCCURRENCE_MESSAGE =
  'Queue occurrence is retained pending a verified recovery claim.'

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
  const claimRenewalIntervalMs = Math.max(
    MIN_CLAIM_RENEWAL_INTERVAL_MS,
    Math.min(MAX_QUEUE_RECOVERY_INTERVAL_MS, Math.floor(stuckJobRecoveryMs / 3)),
  )
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
    renewClaim: (raw: string) => Promise<QueueClaimRenewalResult>
    retry: (raw: string, job: TJob, delayMs: number) => Promise<QueueRetryResult>
  }
  type QueueOperation = 'approval' | 'answers' | 'task'
  type QueueInfrastructurePhase =
    | 'ack_after_success'
    | 'ack_missing_task'
    | 'claim_renewal_initial'
    | 'claim_renewal_periodic'
    | 'dead_letter'
    | 'release_after_shutdown'
    | 'retry'
    | 'retry_reconciliation'
    | 'task_lookup'
  type AttemptInfrastructurePhase =
    | 'finish_after_failure'
    | 'finish_after_success'
    | 'retain_for_adoption'
    | 'start'

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

  const logClaimLeaseLost = (
    queueName: QueueOperation,
    taskId: string,
  ): void => {
    console.warn('[worker] Queue claim lease lost', {
      phase: 'claim_lease_lost',
      queueName,
      taskId,
      workerId,
    })
  }

  const acknowledgeMissingTaskJob = async (
    queueName: QueueOperation,
    taskId: string,
    ack: () => Promise<unknown>,
    claimLeaseFence?: ClaimLeaseFence,
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
    } catch (err) {
      if (claimLeaseFence?.lost || isClaimLeaseLostError(err)) return 'retained'
      logQueueInfrastructureFailure('ack_missing_task', queueName, taskId)
      return 'retained'
    }
  }

  const startClaimRenewal = async <TJob extends RuntimeJob>(input: {
    claimed: { job: TJob; raw: string }
    fence: ClaimLeaseFence
    queue: RuntimeQueue<TJob>
    queueName: QueueOperation
  }): Promise<{
    startDisposition: 'established' | 'lost' | 'unavailable'
    stop: () => Promise<void>
  }> => {
    const { claimed, fence, queue, queueName } = input
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null
    let inFlight: Promise<'lost' | 'renewed' | 'transient_error'> | null = null

    const stopScheduling = (): void => {
      if (stopped) return
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }

    const renew = async (
      phase: 'claim_renewal_initial' | 'claim_renewal_periodic',
    ): Promise<'lost' | 'renewed' | 'transient_error'> => {
      try {
        const result = await queue.renewClaim(claimed.raw)
        if (result === 'renewed') return 'renewed'
        fence.markLost()
        stopScheduling()
        logClaimLeaseLost(queueName, claimed.job.taskId)
        return 'lost'
      } catch {
        logQueueInfrastructureFailure(phase, queueName, claimed.job.taskId)
        return 'transient_error'
      }
    }

    const initialDisposition = await renew('claim_renewal_initial')
    if (initialDisposition !== 'renewed') stopScheduling()

    const tick = (): void => {
      if (stopped || inFlight) return
      const current = renew('claim_renewal_periodic')
      inFlight = current
      void current.finally(() => {
        if (inFlight === current) inFlight = null
      })
    }
    if (initialDisposition === 'renewed') {
      timer = setInterval(tick, claimRenewalIntervalMs)
    }

    return {
      startDisposition: initialDisposition === 'renewed'
        ? 'established'
        : initialDisposition === 'lost'
          ? 'lost'
          : 'unavailable',
      stop: async (): Promise<void> => {
        stopScheduling()
        const pending = inFlight
        if (pending) await pending
      },
    }
  }

  const processClaimedJob = async <TJob extends RuntimeJob>(input: {
    attemptQueueName: 'answers' | 'approvals' | 'tasks'
    claimed: { job: TJob; occurrenceId: string; raw: string }
    processBusiness: (
      finalAttempt: boolean,
      fence: ClaimLeaseFence,
      executionContext: QueueClaimExecutionContext,
    ) => Promise<QueueClaimBusinessDisposition>
    queue: RuntimeQueue<TJob>
    queueName: QueueOperation
  }): Promise<void> => {
    const { claimed, queue, queueName } = input
    const { job, raw } = claimed
    const finalAttempt = job.attempt >= maxAttempts
    const claimLeaseFence = new ClaimLeaseFence()
    const claimRenewal = await startClaimRenewal({
      claimed,
      fence: claimLeaseFence,
      queue,
      queueName,
    })
    if (claimRenewal.startDisposition !== 'established') return
    let claimRenewalStopped = false
    const stopClaimRenewal = async (): Promise<void> => {
      if (claimRenewalStopped) return
      claimRenewalStopped = true
      await claimRenewal.stop()
    }

    try {
      const missingTaskDisposition = await acknowledgeMissingTaskJob(
        queueName,
        job.taskId,
        async () => {
          await stopClaimRenewal()
          claimLeaseFence.assertOwned()
          return queue.ack(raw)
        },
        claimLeaseFence,
      )
      if (missingTaskDisposition !== 'present') return

      let attemptId: string
      let executionContext: QueueClaimExecutionContext
      try {
        claimLeaseFence.assertOwned()
        const startedAttempt = await startTaskAttempt({
          attemptNumber: job.attempt,
          jobPayload: job,
          occurrenceId: claimed.occurrenceId,
          queueName: input.attemptQueueName,
          taskId: job.taskId,
          workerId,
        })
        attemptId = startedAttempt.attemptId
        executionContext = {
          occurrenceId: claimed.occurrenceId,
          recoveredOccurrence: startedAttempt.recoveredOccurrence,
        }
      } catch (err) {
        if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
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
        claimLeaseFence.assertOwned()
        const businessDisposition = await input.processBusiness(
          finalAttempt,
          claimLeaseFence,
          executionContext,
        )
        claimLeaseFence.assertOwned()
        if (businessDisposition === 'retained') {
          // Do not leave a refused occurrence running: a later recovery of Y
          // must not adopt Y's own prior ledger row. This follows the ownership
          // fence so a genuine loss still preserves A for B's recovery of A.
          try {
            await finishTaskAttempt({
              attemptId,
              errorMessage: ADOPTION_PENDING_OCCURRENCE_MESSAGE,
              status: 'indeterminate',
            })
          } catch (err) {
            if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
            logAttemptInfrastructureFailure('retain_for_adoption', queueName, job.taskId)
          }
          await stopClaimRenewal()
          return
        }
        if (businessDisposition !== 'completed') {
          throw new Error('Queue business disposition is invalid.')
        }
      } catch (err) {
        if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
        const message = retainedErrorMessage(err)
        console.error('[worker] Job processing failed', {
          attempt: job.attempt,
          finalAttempt,
          queueName,
          taskId: job.taskId,
          workerId,
        })

        if (finalAttempt) {
          claimLeaseFence.assertOwned()
          try {
            await finishTaskAttempt({
              attemptId,
              errorMessage: message,
              nextRetryAt: null,
              status: 'dead_lettered',
            })
          } catch (err) {
            if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
            logAttemptInfrastructureFailure('finish_after_failure', queueName, job.taskId)
          }
          await stopClaimRenewal()
          claimLeaseFence.assertOwned()
          try {
            await queue.deadLetter(raw, job)
          } catch (err) {
            if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
            logQueueInfrastructureFailure('dead_letter', queueName, job.taskId)
          }
          return
        }

        const retryDelayMs = backoffDelayMs(job.attempt)
        await stopClaimRenewal()
        claimLeaseFence.assertOwned()
        let retryResult: QueueRetryResult
        try {
          retryResult = await queue.retry(raw, job, retryDelayMs)
        } catch (err) {
          if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
          logQueueInfrastructureFailure('retry', queueName, job.taskId)
          try {
            retryResult = await queue.retry(raw, job, retryDelayMs)
          } catch (reconciliationError) {
            if (claimLeaseFence.lost || isClaimLeaseLostError(reconciliationError)) return
            logQueueInfrastructureFailure('retry_reconciliation', queueName, job.taskId)
            claimLeaseFence.assertOwned()
            try {
              await finishTaskAttempt({
                attemptId,
                errorMessage: message,
                nextRetryAt: null,
                status: 'indeterminate',
              })
            } catch (finishError) {
              if (claimLeaseFence.lost || isClaimLeaseLostError(finishError)) return
              logAttemptInfrastructureFailure('finish_after_failure', queueName, job.taskId)
            }
            return
          }
        }
        claimLeaseFence.assertOwned()
        try {
          await finishTaskAttempt({
            attemptId,
            errorMessage: message,
            nextRetryAt: retryResult.nextRetryAt,
            status: 'failed',
          })
        } catch (err) {
          if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
          logAttemptInfrastructureFailure('finish_after_failure', queueName, job.taskId)
        }
        return
      }

      claimLeaseFence.assertOwned()
      try {
        await finishTaskAttempt({ attemptId, status: 'completed' })
      } catch (err) {
        if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
        logAttemptInfrastructureFailure('finish_after_success', queueName, job.taskId)
      }
      await stopClaimRenewal()
      claimLeaseFence.assertOwned()
      try {
        await queue.ack(raw)
      } catch (err) {
        if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
        logQueueInfrastructureFailure('ack_after_success', queueName, job.taskId)
      }
    } catch (err) {
      if (claimLeaseFence.lost || isClaimLeaseLostError(err)) return
      throw err
    } finally {
      await stopClaimRenewal()
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
            processBusiness: (finalAttempt, claimLeaseFence, executionContext) =>
              processApproval(claimedApproval.job.taskId, {
                claimLeaseFence,
                executionContext,
                finalAttempt,
              }),
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
            processBusiness: async (finalAttempt, claimLeaseFence, executionContext) =>
              await processAnsweredQuestions(claimedAnswers.job.taskId, {
                claimLeaseFence,
                executionContext,
                finalAttempt,
              }),
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
          processBusiness: (finalAttempt, claimLeaseFence, executionContext) =>
            processTask(claimedTask.job.taskId, {
              claimLeaseFence,
              executionContext,
              finalAttempt,
            }),
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
