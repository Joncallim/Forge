import { db } from '../db'
import { taskAttempts, type TaskAttemptStatus } from '../db/schema'
import { eq } from 'drizzle-orm'
import { recordTaskLogBestEffort } from './task-logs'
import { taskCompatibilityError } from '@/lib/mcps/leakage-drain'

type QueueName = 'tasks' | 'approvals' | 'answers'

export function describeQueueWorker(queueName: string): { name: string; role: string } {
  if (queueName === 'approvals') {
    return {
      name: 'Forge Approval Worker',
      role: 'continues approved tasks, advances ready work packages, and records handoff or review-gate progress',
    }
  }
  if (queueName === 'answers') {
    return {
      name: 'Forge Answers Worker',
      role: 'incorporates answered follow-up questions and reruns Architect planning',
    }
  }
  return {
    name: 'Forge Task Worker',
    role: 'runs Architect planning and task replanning jobs from the task queue',
  }
}

function statusLevel(status: TaskAttemptStatus): 'info' | 'success' | 'warning' | 'error' {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'indeterminate') return 'warning'
  if (status === 'dead_lettered') return 'error'
  return 'info'
}

function statusLabel(status: TaskAttemptStatus): string {
  return status === 'indeterminate' ? 'Retry status unknown' : status
}

function statusEventType(status: TaskAttemptStatus): string {
  if (status === 'dead_lettered') return 'queue.attempt.dead_lettered'
  if (status === 'indeterminate') return 'queue.attempt.indeterminate'
  return `queue.attempt.${status}`
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
  const worker = describeQueueWorker(queueName)
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
    message: `${worker.name} claimed ${queueName} attempt ${attemptNumber}. Role: ${worker.role}.`,
    metadata: {
      attemptNumber,
      jobPayload,
      queueName,
      workerId,
      workerName: worker.name,
      workerRole: worker.role,
    },
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
  status: TaskAttemptStatus
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
    const worker = describeQueueWorker(attempt.queueName)
    const label = statusLabel(status)
    await recordTaskLogBestEffort({
      eventType: statusEventType(status),
      level: statusLevel(status),
      message: errorMessage
        ? `${worker.name} finished ${attempt.queueName} attempt ${attempt.attemptNumber} as ${label}: ${taskCompatibilityError(errorMessage)}`
        : `${worker.name} finished ${attempt.queueName} attempt ${attempt.attemptNumber} as ${label}.`,
      metadata: {
        attemptNumber: attempt.attemptNumber,
        nextRetryAt: nextRetryAt?.toISOString() ?? null,
        queueName: attempt.queueName,
        status,
        workerId: attempt.workerId,
        workerName: worker.name,
        workerRole: worker.role,
      },
      source: 'queue',
      taskAttemptId: attemptId,
      taskId: attempt.taskId,
      title: status === 'completed'
        ? 'Queue attempt completed'
        : status === 'dead_lettered'
          ? 'Queue attempt dead-lettered'
          : status === 'indeterminate'
            ? 'Retry status unknown'
            : 'Queue attempt warning',
    })
  }
}
