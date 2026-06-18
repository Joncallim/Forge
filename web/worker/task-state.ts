import { db } from '../db'
import { tasks } from '../db/schema'
import { eq } from 'drizzle-orm'
import { publishTaskEvent } from './events'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'failed'
  | 'cancelled'

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'cancelled', 'rejected'])

export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  errorMessage: string | null = null,
): Promise<void> {
  const now = new Date()

  await db
    .update(tasks)
    .set({
      status,
      errorMessage,
      updatedAt: now,
      completedAt: TERMINAL_STATUSES.has(status) ? now : null,
    })
    .where(eq(tasks.id, taskId))

  await publishTaskEvent(taskId, 'task:status', {
    status,
    errorMessage,
    updatedAt: now.toISOString(),
  })
}
