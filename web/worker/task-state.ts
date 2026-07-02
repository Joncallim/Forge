import { db } from '../db'
import { tasks } from '../db/schema'
import { and, eq, notInArray } from 'drizzle-orm'
import { publishTaskEvent } from './events'
import { sanitizeWorkerMessage } from './redaction'
import { recordTaskLogBestEffort, type TaskLogLevel } from './task-logs'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_answers'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'failed'
  | 'cancelled'

const TERMINAL_STATUS_LIST: TaskStatus[] = ['completed', 'failed', 'cancelled', 'rejected']
const TERMINAL_STATUSES = new Set<TaskStatus>(TERMINAL_STATUS_LIST)

function taskStatusLogLevel(status: TaskStatus): TaskLogLevel {
  if (status === 'completed' || status === 'awaiting_approval') return 'success'
  if (status === 'failed' || status === 'rejected') return 'error'
  if (status === 'cancelled' || status === 'awaiting_answers') return 'warning'
  return 'info'
}

function taskStatusLogTitle(status: TaskStatus): string {
  return `Task ${status.replace(/_/g, ' ')}`
}

export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  errorMessage: string | null = null,
): Promise<boolean> {
  const now = new Date()
  const sanitizedErrorMessage = errorMessage === null ? null : sanitizeWorkerMessage(errorMessage)

  const [updated] = await db
    .update(tasks)
    .set({
      status,
      errorMessage: sanitizedErrorMessage,
      updatedAt: now,
      completedAt: TERMINAL_STATUSES.has(status) ? now : null,
    })
    .where(and(eq(tasks.id, taskId), notInArray(tasks.status, TERMINAL_STATUS_LIST)))
    .returning({ id: tasks.id })

  if (!updated) return false

  await recordTaskLogBestEffort({
    eventType: 'task.status_changed',
    level: taskStatusLogLevel(status),
    message: sanitizedErrorMessage
      ? `Task status changed to ${status}: ${sanitizedErrorMessage}`
      : `Task status changed to ${status}.`,
    metadata: { status, updatedAt: now.toISOString() },
    source: 'worker',
    taskId,
    title: taskStatusLogTitle(status),
  })

  await publishTaskEvent(taskId, 'task:status', {
    status,
    errorMessage: sanitizedErrorMessage,
    updatedAt: now.toISOString(),
  })

  return true
}

export async function updateTaskStatusIfCurrent(
  taskId: string,
  currentStatus: TaskStatus,
  nextStatus: TaskStatus,
  errorMessage: string | null = null,
): Promise<boolean> {
  const now = new Date()
  const sanitizedErrorMessage = errorMessage === null ? null : sanitizeWorkerMessage(errorMessage)

  const [updated] = await db
    .update(tasks)
    .set({
      status: nextStatus,
      errorMessage: sanitizedErrorMessage,
      updatedAt: now,
      completedAt: TERMINAL_STATUSES.has(nextStatus) ? now : null,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, currentStatus)))
    .returning({ id: tasks.id })

  if (!updated) return false

  await recordTaskLogBestEffort({
    eventType: 'task.status_changed',
    level: taskStatusLogLevel(nextStatus),
    message: sanitizedErrorMessage
      ? `Task status changed from ${currentStatus} to ${nextStatus}: ${sanitizedErrorMessage}`
      : `Task status changed from ${currentStatus} to ${nextStatus}.`,
    metadata: { currentStatus, nextStatus, updatedAt: now.toISOString() },
    source: 'worker',
    taskId,
    title: taskStatusLogTitle(nextStatus),
  })

  await publishTaskEvent(taskId, 'task:status', {
    status: nextStatus,
    errorMessage: sanitizedErrorMessage,
    updatedAt: now.toISOString(),
  })

  return true
}
