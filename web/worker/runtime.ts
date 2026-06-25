const DEFAULT_CLAIM_TIMEOUT_SECONDS = 5
const APPROVAL_CLAIM_TIMEOUT_SECONDS = 1
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_STUCK_JOB_RECOVERY_SECONDS = 15 * 60
const DEFAULT_PROVIDER_HEALTH_INTERVAL_SECONDS = 5 * 60

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  const [{ AnswersQueue, ApprovalQueue, TaskQueue }, { processAnsweredQuestions, processApproval, processTask }] = await Promise.all([
    import('./queue'),
    import('./orchestrator'),
  ])
  const { finishTaskAttempt, startTaskAttempt } = await import('./task-attempts')

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
  const workerId = `${source}-${process.pid}-${Date.now().toString(36)}`
  let shuttingDown = false
  let providerHealthTimer: ReturnType<typeof setInterval> | null = null
  let providerHealthRunning = false

  const refreshProviderHealth = async (): Promise<void> => {
    if (providerHealthIntervalSeconds === 0 || providerHealthRunning) return
    providerHealthRunning = true
    try {
      const { refreshStaleProviderHealth } = await import('../lib/providers/health')
      const checked = await refreshStaleProviderHealth(providerHealthIntervalSeconds * 1000)
      if (checked > 0) {
        console.info('[worker] Refreshed provider health cache', { checked, workerId })
      }
    } catch (err) {
      console.warn('[worker] Provider health refresh failed', {
        err: errorMessage(err),
        workerId,
      })
    } finally {
      providerHealthRunning = false
    }
  }

  const run = async (): Promise<void> => {
    console.info('[worker] Started', {
      claimTimeoutSeconds,
      maxAttempts,
      providerHealthIntervalSeconds,
      source,
      stuckJobRecoveryMs,
      workerId,
    })

    try {
      if (providerHealthIntervalSeconds > 0) {
        void refreshProviderHealth()
        providerHealthTimer = setInterval(
          () => void refreshProviderHealth(),
          providerHealthIntervalSeconds * 1000,
        )
      }

      const [recoveredApprovals, recoveredAnswers, recoveredTasks] = await Promise.all([
        approvalQueue.recoverStuckJobs(stuckJobRecoveryMs),
        answersQueue.recoverStuckJobs(stuckJobRecoveryMs),
        taskQueue.recoverStuckJobs(stuckJobRecoveryMs),
      ])
      if (recoveredApprovals > 0 || recoveredAnswers > 0 || recoveredTasks > 0) {
        console.warn('[worker] Recovered stuck jobs', {
          approvals: recoveredApprovals,
          answers: recoveredAnswers,
          tasks: recoveredTasks,
          workerId,
        })
      }

      while (!shuttingDown) {
        const [promotedApprovals, promotedAnswers, promotedTasks] = await Promise.all([
          approvalQueue.promoteDueRetries(),
          answersQueue.promoteDueRetries(),
          taskQueue.promoteDueRetries(),
        ])
        if (promotedApprovals > 0 || promotedAnswers > 0 || promotedTasks > 0) {
          console.info('[worker] Promoted retry jobs', {
            approvals: promotedApprovals,
            answers: promotedAnswers,
            tasks: promotedTasks,
            workerId,
          })
        }

        let claimedApproval = null as Awaited<ReturnType<InstanceType<typeof ApprovalQueue>['claim']>>

        try {
          claimedApproval = await approvalQueue.claim(APPROVAL_CLAIM_TIMEOUT_SECONDS)
        } catch (err) {
          if (shuttingDown) break
          console.error('[worker] Failed to claim approval', err)
        }

        if (claimedApproval !== null) {
          let ackedApproval = false
          let approvalAttemptId: string | null = null
          const finalAttempt = claimedApproval.job.attempt >= maxAttempts
          try {
            approvalAttemptId = await startTaskAttempt({
              attemptNumber: claimedApproval.job.attempt,
              jobPayload: claimedApproval.job,
              queueName: 'approvals',
              taskId: claimedApproval.job.taskId,
              workerId,
            })
            console.info('[worker] Processing approval', {
              attempt: claimedApproval.job.attempt,
              taskId: claimedApproval.job.taskId,
              workerId,
            })
            await processApproval(claimedApproval.job.taskId, { finalAttempt })
            if (approvalAttemptId) {
              await finishTaskAttempt({ attemptId: approvalAttemptId, status: 'completed' })
            }
            await approvalQueue.ack(claimedApproval.raw)
            ackedApproval = true
          } catch (err) {
            const message = errorMessage(err)
            const nextRetryAt = finalAttempt
              ? null
              : new Date(Date.now() + backoffDelayMs(claimedApproval.job.attempt))
            if (approvalAttemptId) {
              await finishTaskAttempt({
                attemptId: approvalAttemptId,
                errorMessage: message,
                nextRetryAt,
                status: finalAttempt ? 'dead_lettered' : 'failed',
              })
            }
            if (finalAttempt) {
              await approvalQueue.deadLetter(claimedApproval.raw, message)
            } else {
              await approvalQueue.retry(
                claimedApproval.raw,
                claimedApproval.job,
                backoffDelayMs(claimedApproval.job.attempt),
              )
            }
            ackedApproval = true
            console.error('[worker] Approval failed', {
              attempt: claimedApproval.job.attempt,
              finalAttempt,
              taskId: claimedApproval.job.taskId,
              err,
              workerId,
            })
          } finally {
            if (!ackedApproval) {
              try {
                await approvalQueue.ack(claimedApproval.raw)
              } catch (err) {
                console.error('[worker] Failed to acknowledge approval', {
                  taskId: claimedApproval.job.taskId,
                  err,
                  workerId,
                })
              }
            }
          }
        }

        let claimedAnswers = null as Awaited<ReturnType<InstanceType<typeof AnswersQueue>['claim']>>

        try {
          claimedAnswers = await answersQueue.claim(APPROVAL_CLAIM_TIMEOUT_SECONDS)
        } catch (err) {
          if (shuttingDown) break
          console.error('[worker] Failed to claim answers job', err)
        }

        if (claimedAnswers !== null) {
          let ackedAnswers = false
          let answersAttemptId: string | null = null
          const finalAttempt = claimedAnswers.job.attempt >= maxAttempts
          try {
            answersAttemptId = await startTaskAttempt({
              attemptNumber: claimedAnswers.job.attempt,
              jobPayload: claimedAnswers.job,
              queueName: 'answers',
              taskId: claimedAnswers.job.taskId,
              workerId,
            })
            console.info('[worker] Processing answered questions', {
              attempt: claimedAnswers.job.attempt,
              taskId: claimedAnswers.job.taskId,
              workerId,
            })
            await processAnsweredQuestions(claimedAnswers.job.taskId, { finalAttempt })
            if (answersAttemptId) {
              await finishTaskAttempt({ attemptId: answersAttemptId, status: 'completed' })
            }
            await answersQueue.ack(claimedAnswers.raw)
            ackedAnswers = true
          } catch (err) {
            const message = errorMessage(err)
            const nextRetryAt = finalAttempt
              ? null
              : new Date(Date.now() + backoffDelayMs(claimedAnswers.job.attempt))
            if (answersAttemptId) {
              await finishTaskAttempt({
                attemptId: answersAttemptId,
                errorMessage: message,
                nextRetryAt,
                status: finalAttempt ? 'dead_lettered' : 'failed',
              })
            }
            if (finalAttempt) {
              await answersQueue.deadLetter(claimedAnswers.raw, message)
            } else {
              await answersQueue.retry(
                claimedAnswers.raw,
                claimedAnswers.job,
                backoffDelayMs(claimedAnswers.job.attempt),
              )
            }
            ackedAnswers = true
            console.error('[worker] Answered-questions re-plan failed', {
              attempt: claimedAnswers.job.attempt,
              finalAttempt,
              taskId: claimedAnswers.job.taskId,
              err,
              workerId,
            })
          } finally {
            if (!ackedAnswers) {
              try {
                await answersQueue.ack(claimedAnswers.raw)
              } catch (err) {
                console.error('[worker] Failed to acknowledge answers job', {
                  taskId: claimedAnswers.job.taskId,
                  err,
                  workerId,
                })
              }
            }
          }
        }

        let claimedTask = null as Awaited<ReturnType<InstanceType<typeof TaskQueue>['claim']>>

        try {
          claimedTask = await taskQueue.claim(claimTimeoutSeconds)
        } catch (err) {
          if (shuttingDown) break
          console.error('[worker] Failed to claim task', err)
          continue
        }

        if (claimedTask === null) continue

        let ackedTask = false
        let taskAttemptId: string | null = null
        try {
          const finalAttempt = claimedTask.job.attempt >= maxAttempts
          taskAttemptId = await startTaskAttempt({
            attemptNumber: claimedTask.job.attempt,
            jobPayload: claimedTask.job,
            queueName: 'tasks',
            taskId: claimedTask.job.taskId,
            workerId,
          })
          console.info('[worker] Processing task', {
            attempt: claimedTask.job.attempt,
            finalAttempt,
            taskId: claimedTask.job.taskId,
            workerId,
          })
          await processTask(claimedTask.job.taskId, { finalAttempt })
          if (taskAttemptId) {
            await finishTaskAttempt({ attemptId: taskAttemptId, status: 'completed' })
          }
          await taskQueue.ack(claimedTask.raw)
          ackedTask = true
        } catch (err) {
          const message = errorMessage(err)
          const finalAttempt = claimedTask.job.attempt >= maxAttempts
          const nextRetryAt = finalAttempt
            ? null
            : new Date(Date.now() + backoffDelayMs(claimedTask.job.attempt))
          if (taskAttemptId) {
            await finishTaskAttempt({
              attemptId: taskAttemptId,
              errorMessage: message,
              nextRetryAt,
              status: finalAttempt ? 'dead_lettered' : 'failed',
            })
          }
          if (finalAttempt) {
            await taskQueue.deadLetter(claimedTask.raw, message)
          } else {
            await taskQueue.retry(
              claimedTask.raw,
              claimedTask.job,
              backoffDelayMs(claimedTask.job.attempt),
            )
          }
          ackedTask = true
          console.error('[worker] Task failed', {
            attempt: claimedTask.job.attempt,
            finalAttempt,
            taskId: claimedTask.job.taskId,
            err,
            workerId,
          })
        } finally {
          if (!ackedTask) {
            try {
              await taskQueue.ack(claimedTask.raw)
            } catch (err) {
              console.error('[worker] Failed to acknowledge task', {
                taskId: claimedTask.job.taskId,
                err,
                workerId,
              })
            }
          }
        }
      }
    } finally {
      if (providerHealthTimer !== null) {
        clearInterval(providerHealthTimer)
        providerHealthTimer = null
      }
      taskQueue.disconnect()
      approvalQueue.disconnect()
      answersQueue.disconnect()
      currentState.handle = null
      console.info('[worker] Stopped')
    }
  }

  const done = run()
  done.catch((err) => {
    console.error('[worker] Fatal error', err)
  })

  const handle: WorkerHandle = {
    done,
    stop: async () => {
      if (shuttingDown) return
      shuttingDown = true
      taskQueue.disconnect()
      approvalQueue.disconnect()
      answersQueue.disconnect()
      await done.catch(() => {})
    },
  }

  currentState.handle = handle
  return handle
}
