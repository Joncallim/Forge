const DEFAULT_CLAIM_TIMEOUT_SECONDS = 5
const APPROVAL_CLAIM_TIMEOUT_SECONDS = 1

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
  const [{ ApprovalQueue, TaskQueue }, { processApproval, processTask }] = await Promise.all([
    import('./queue'),
    import('./orchestrator'),
  ])

  const taskQueue = new TaskQueue()
  const approvalQueue = new ApprovalQueue()
  const claimTimeoutSeconds = getClaimTimeoutSeconds()
  let shuttingDown = false

  const run = async (): Promise<void> => {
    console.info('[worker] Started', { claimTimeoutSeconds, source })

    try {
      while (!shuttingDown) {
        let claimedApproval = null as Awaited<ReturnType<InstanceType<typeof ApprovalQueue>['claim']>>

        try {
          claimedApproval = await approvalQueue.claim(APPROVAL_CLAIM_TIMEOUT_SECONDS)
        } catch (err) {
          if (shuttingDown) break
          console.error('[worker] Failed to claim approval', err)
        }

        if (claimedApproval !== null) {
          try {
            console.info('[worker] Processing approval', { taskId: claimedApproval.job.taskId })
            await processApproval(claimedApproval.job.taskId)
          } catch (err) {
            console.error('[worker] Approval failed', { taskId: claimedApproval.job.taskId, err })
          } finally {
            try {
              await approvalQueue.ack(claimedApproval.raw)
            } catch (err) {
              console.error('[worker] Failed to acknowledge approval', {
                taskId: claimedApproval.job.taskId,
                err,
              })
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

        try {
          console.info('[worker] Processing task', { taskId: claimedTask.job.taskId })
          await processTask(claimedTask.job.taskId)
        } catch (err) {
          console.error('[worker] Task failed', { taskId: claimedTask.job.taskId, err })
        } finally {
          try {
            await taskQueue.ack(claimedTask.raw)
          } catch (err) {
            console.error('[worker] Failed to acknowledge task', {
              taskId: claimedTask.job.taskId,
              err,
            })
          }
        }
      }
    } finally {
      taskQueue.disconnect()
      approvalQueue.disconnect()
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
      await done.catch(() => {})
    },
  }

  currentState.handle = handle
  return handle
}
