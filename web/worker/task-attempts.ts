import { db } from '../db'
import { taskAttempts, type TaskAttemptStatus } from '../db/schema'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { recordTaskLogBestEffort } from './task-logs'
import { taskCompatibilityError } from '@/lib/mcps/leakage-drain'

type QueueName = 'tasks' | 'approvals' | 'answers'
type ClosedQueueJob = {
  action?: 'approve'
  attempt: number
  taskId: string
}
type QueueAttemptPayloadV1 = {
  schemaVersion: 1
  occurrenceId: string
  job: ClosedQueueJob
}

export type StartTaskAttemptResult = {
  attemptId: string
  recoveredOccurrence: boolean
}

const QUEUE_ATTEMPT_PAYLOAD_SCHEMA_VERSION = 1
const MAX_RUNNING_OCCURRENCE_ATTEMPTS = 32
const QUEUE_OCCURRENCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TASK_ID_PATTERN = QUEUE_OCCURRENCE_ID_PATTERN
const SUPERSEDED_OCCURRENCE_MESSAGE =
  'Queue occurrence ownership transferred to a recovered worker.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const target = [...expected].sort()
  return keys.length === target.length && keys.every((key, index) => key === target[index])
}

function closedQueueJob(queueName: QueueName, value: unknown): ClosedQueueJob | null {
  if (!isRecord(value)) return null
  const expectedKeys = queueName === 'approvals'
    ? ['taskId', 'action', 'attempt']
    : ['taskId', 'attempt']
  if (!hasExactKeys(value, expectedKeys)
    || typeof value.taskId !== 'string'
    || !TASK_ID_PATTERN.test(value.taskId)
    || typeof value.attempt !== 'number'
    || !Number.isSafeInteger(value.attempt)
    || value.attempt < 1
    || (queueName === 'approvals' && value.action !== 'approve')) {
    return null
  }
  return queueName === 'approvals'
    ? { action: 'approve', attempt: value.attempt, taskId: value.taskId }
    : { attempt: value.attempt, taskId: value.taskId }
}

function sameClosedQueueJob(left: ClosedQueueJob, right: ClosedQueueJob): boolean {
  return left.taskId === right.taskId
    && left.attempt === right.attempt
    && left.action === right.action
}

function queueAttemptPayload(
  queueName: QueueName,
  value: unknown,
): QueueAttemptPayloadV1 | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'occurrenceId', 'job'])
    || value.schemaVersion !== QUEUE_ATTEMPT_PAYLOAD_SCHEMA_VERSION
    || typeof value.occurrenceId !== 'string'
    || !QUEUE_OCCURRENCE_ID_PATTERN.test(value.occurrenceId)) {
    return null
  }
  const job = closedQueueJob(queueName, value.job)
  if (!job) return null
  return {
    schemaVersion: QUEUE_ATTEMPT_PAYLOAD_SCHEMA_VERSION,
    occurrenceId: value.occurrenceId,
    job,
  }
}

function requiredQueueAttemptPayload(input: {
  jobPayload: unknown
  occurrenceId: string
  queueName: QueueName
  taskId: string
}): QueueAttemptPayloadV1 {
  const job = closedQueueJob(input.queueName, input.jobPayload)
  if (!job
    || job.taskId !== input.taskId
    || !QUEUE_OCCURRENCE_ID_PATTERN.test(input.occurrenceId)) {
    throw new Error('Queue attempt identity is invalid.')
  }
  return {
    schemaVersion: QUEUE_ATTEMPT_PAYLOAD_SCHEMA_VERSION,
    occurrenceId: input.occurrenceId,
    job,
  }
}

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
  occurrenceId,
  queueName,
  taskId,
  workerId,
}: {
  attemptNumber: number
  jobPayload: unknown
  occurrenceId: string
  queueName: QueueName
  taskId: string
  workerId: string
}): Promise<StartTaskAttemptResult> {
  const now = new Date()
  const worker = describeQueueWorker(queueName)
  const payload = requiredQueueAttemptPayload({
    jobPayload,
    occurrenceId,
    queueName,
    taskId,
  })
  const result = await db.transaction(async (tx) => {
    const runningAttempts = await tx
      .select({
        id: taskAttempts.id,
        jobPayload: taskAttempts.jobPayload,
      })
      .from(taskAttempts)
      .where(and(
        eq(taskAttempts.taskId, taskId),
        eq(taskAttempts.queueName, queueName),
        eq(taskAttempts.status, 'running'),
      ))
      .orderBy(desc(taskAttempts.createdAt), desc(taskAttempts.id))
      .limit(MAX_RUNNING_OCCURRENCE_ATTEMPTS + 1)
      .for('update')

    if (runningAttempts.length > MAX_RUNNING_OCCURRENCE_ATTEMPTS) {
      throw new Error('Queue attempt adoption backlog exceeds the safe bound.')
    }

    const supersededAttemptIds = runningAttempts
      .filter((attempt) => {
        const existing = queueAttemptPayload(queueName, attempt.jobPayload)
        return existing?.occurrenceId === occurrenceId
          && sameClosedQueueJob(existing.job, payload.job)
      })
      .map((attempt) => attempt.id)

    if (supersededAttemptIds.length > 0) {
      await tx
        .update(taskAttempts)
        .set({
          completedAt: now,
          errorMessage: SUPERSEDED_OCCURRENCE_MESSAGE,
          nextRetryAt: null,
          status: 'indeterminate',
        })
        .where(inArray(taskAttempts.id, supersededAttemptIds))
    }

    const [attempt] = await tx
      .insert(taskAttempts)
      .values({
        taskId,
        queueName,
        attemptNumber,
        workerId,
        jobPayload: payload,
        status: 'running',
        claimedAt: now,
        startedAt: now,
      })
      .returning({ id: taskAttempts.id })
    if (!attempt) throw new Error('Queue attempt could not be created.')

    return {
      attemptId: attempt.id,
      recoveredOccurrence: supersededAttemptIds.length > 0,
    }
  })

  await recordTaskLogBestEffort({
    eventType: 'queue.attempt.started',
    level: 'info',
    message: `${worker.name} claimed ${queueName} attempt ${attemptNumber}. Role: ${worker.role}.`,
    metadata: {
      attemptNumber,
      jobPayload: payload,
      queueName,
      recoveredOccurrence: result.recoveredOccurrence,
      workerId,
      workerName: worker.name,
      workerRole: worker.role,
    },
    source: 'queue',
    taskAttemptId: result.attemptId,
    taskId,
    title: 'Queue attempt started',
  })

  return result
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
