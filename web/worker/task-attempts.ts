import { db } from '../db'
import { taskAttempts } from '../db/schema'
import { eq } from 'drizzle-orm'
import { recordTaskLogBestEffort } from './task-logs'

type QueueName = 'tasks' | 'approvals' | 'answers'
type AttemptStatus = 'running' | 'completed' | 'failed' | 'dead_lettered'

function statusLevel(status: AttemptStatus): 'info' | 'success' | 'warning' | 'error' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'warning'
  if (status === 'dead_lettered') return 'error'
  return 'info'
}

export async function startTaskAttempt({
  attemptNumber,
  jobPayload,
  queueName,
  taskId,
  workerId,
}: {
  attemptNumber: number
  jobPayload: unknown
  queueName: QueueName
  taskId: string
  workerId: string
}): Promise<string> {
  const now = new Date()
  const [attempt] = await db
    .insert(taskAttempts)
    .values({
      taskId,
      queueName,
      attemptNumber,
      workerId,
      jobPayload,
      status: 'running',
      claimedAt: now,
      startedAt: now,
    })
    .returning({ id: taskAttempts.id })

  await recordTaskLogBestEffort({
    eventType: 'queue.attempt.started',
    level: 'info',
    message: `Worker ${workerId} claimed ${queueName} attempt ${attemptNumber}.`,
    metadata: { attemptNumber, jobPayload, queueName, workerId },
    source: 'queue',
    taskAttemptId: attempt.id,
    taskId,
    title: 'Queue attempt started',
  })

  return attempt.id
}

export async function finishTaskAttempt({
  attemptId,
  errorMessage = null,
  nextRetryAt = null,
  status,
}: {
  attemptId: string
  errorMessage?: string | null
  nextRetryAt?: Date | null
  status: AttemptStatus
}): Promise<void> {
  const [attempt] = await db
    .update(taskAttempts)
    .set({
      status,
      errorMessage,
      nextRetryAt,
      completedAt: new Date(),
    })
    .where(eq(taskAttempts.id, attemptId))
    .returning({
      attemptNumber: taskAttempts.attemptNumber,
      queueName: taskAttempts.queueName,
      taskId: taskAttempts.taskId,
      workerId: taskAttempts.workerId,
    })

  if (attempt) {
    await recordTaskLogBestEffort({
      eventType: status === 'dead_lettered' ? 'queue.attempt.dead_lettered' : `queue.attempt.${status}`,
      level: statusLevel(status),
      message: errorMessage
        ? `${attempt.queueName} attempt ${attempt.attemptNumber} finished as ${status}: ${errorMessage}`
        : `${attempt.queueName} attempt ${attempt.attemptNumber} finished as ${status}.`,
      metadata: {
        attemptNumber: attempt.attemptNumber,
        nextRetryAt: nextRetryAt?.toISOString() ?? null,
        queueName: attempt.queueName,
        status,
        workerId: attempt.workerId,
      },
      source: 'queue',
      taskAttemptId: attemptId,
      taskId: attempt.taskId,
      title: status === 'completed'
        ? 'Queue attempt completed'
        : status === 'dead_lettered'
          ? 'Queue attempt dead-lettered'
          : 'Queue attempt warning',
    })
  }
}
