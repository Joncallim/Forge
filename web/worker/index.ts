import path from 'node:path'
import { loadEnvConfig } from '@next/env'

loadEnvConfig(path.resolve(process.cwd(), '..'))
loadEnvConfig(process.cwd())

const { ApprovalQueue, TaskQueue } = await import('./queue')
const { processApproval, processTask } = await import('./orchestrator')

const DEFAULT_CLAIM_TIMEOUT_SECONDS = 5
const APPROVAL_CLAIM_TIMEOUT_SECONDS = 1

function getClaimTimeoutSeconds(): number {
  const raw = process.env.FORGE_WORKER_CLAIM_TIMEOUT_SECONDS
  if (!raw) return DEFAULT_CLAIM_TIMEOUT_SECONDS

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('FORGE_WORKER_CLAIM_TIMEOUT_SECONDS must be a positive number')
  }

  return parsed
}

async function main(): Promise<void> {
  const taskQueue = new TaskQueue()
  const approvalQueue = new ApprovalQueue()
  const claimTimeoutSeconds = getClaimTimeoutSeconds()
  let shuttingDown = false

  const requestShutdown = (signal: NodeJS.Signals) => {
    console.info(`[worker] Received ${signal}; shutting down after current task`)
    shuttingDown = true
    taskQueue.disconnect()
    approvalQueue.disconnect()
  }

  process.once('SIGINT', requestShutdown)
  process.once('SIGTERM', requestShutdown)

  console.info('[worker] Started', { claimTimeoutSeconds })

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

  taskQueue.disconnect()
  approvalQueue.disconnect()
  console.info('[worker] Stopped')
}

main().catch((err) => {
  console.error('[worker] Fatal error', err)
  process.exit(1)
})
