import { db } from '../db'
import { taskAttempts } from '../db/schema'
import { eq } from 'drizzle-orm'

type QueueName = 'tasks' | 'approvals'
type AttemptStatus = 'running' | 'completed' | 'failed' | 'dead_lettered'

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
  await db
    .update(taskAttempts)
    .set({
      status,
      errorMessage,
      nextRetryAt,
      completedAt: new Date(),
    })
    .where(eq(taskAttempts.id, attemptId))
}
