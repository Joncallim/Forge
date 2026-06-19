import { db } from '../db'
import { tasks } from '../db/schema'
import { and, eq } from 'drizzle-orm'
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

export async function updateTaskStatusIfCurrent(
  taskId: string,
  currentStatus: TaskStatus,
  nextStatus: TaskStatus,
  errorMessage: string | null = null,
): Promise<boolean> {
  const now = new Date()

  const [updated] = await db
    .update(tasks)
    .set({
      status: nextStatus,
      errorMessage,
      updatedAt: now,
      completedAt: TERMINAL_STATUSES.has(nextStatus) ? now : null,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, currentStatus)))
    .returning({ id: tasks.id })

  if (!updated) return false

  await publishTaskEvent(taskId, 'task:status', {
    status: nextStatus,
    errorMessage,
    updatedAt: now.toISOString(),
  })

  return true
}
