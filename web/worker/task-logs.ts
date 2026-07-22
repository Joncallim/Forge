import { db } from '../db'
import { taskLogs } from '../db/schema'
import { publishTaskEvent } from './events'
import { sanitizeWorkerMessage } from './redaction'
import {
  LEGACY_TASK_LOG_UNAVAILABLE,
  sanitizeLogFrontMatter,
  sanitizeLogRecordForOutput,
  sanitizeLogStructuredValue,
  sanitizePromptSnapshot,
} from '@/lib/task-log-sanitization'
import { taskLogsUnavailableMessage } from '@/lib/task-log-db-errors'

export type TaskLogLevel = 'info' | 'success' | 'warning' | 'error'

export type TaskLogFrontMatter = {
  connector?: string | null
  model?: string | null
  timestamp?: string
}

export type RecordTaskLogInput = {
  agentRunId?: string | null
  approvalGateId?: string | null
  artifactId?: string | null
  eventType: string
  frontMatter?: TaskLogFrontMatter & Record<string, unknown>
  level?: TaskLogLevel
  message: string
  metadata?: Record<string, unknown>
  source?: string
  taskAttemptId?: string | null
  taskId: string
  title: string
  workPackageId?: string | null
}

function cleanText(value: string, maxLength = 60_000): string {
  return sanitizeWorkerMessage(value).slice(0, maxLength)
}

function frontMatterWithTimestamp(frontMatter: Record<string, unknown>, createdAt: Date): Record<string, unknown> {
  return sanitizeLogFrontMatter({
    timestamp: createdAt.toISOString(),
    ...frontMatter,
  })
}

function errorField(value: unknown): ReturnType<typeof sanitizePromptSnapshot> | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? sanitizePromptSnapshot(value)
    : undefined
}

function taskLogErrorDiagnostic(err: unknown): Record<string, unknown> {
  const diagnostic: Record<string, unknown> = {}
  const seen = new Set<unknown>()
  let current: unknown = err
  let depth = 0

  while (current && depth < 4 && !seen.has(current)) {
    seen.add(current)
    const label = depth === 0 ? 'error' : `cause${depth}`
    if (current instanceof Error) {
      diagnostic[`${label}Name`] = current.name
      diagnostic[`${label}Message`] = errorField(current.message)
    } else {
      diagnostic[`${label}Message`] = errorField(current)
    }

    if (typeof current === 'object' && current !== null) {
      const record = current as Record<string, unknown>
      for (const key of ['code', 'constraint', 'detail', 'schema', 'table']) {
        const value = errorField(record[key])
        if (value) diagnostic[`${label}${key[0].toUpperCase()}${key.slice(1)}`] = value
      }
      current = record.cause
    } else {
      current = null
    }
    depth += 1
  }

  if (taskLogsUnavailableMessage(err)) {
    diagnostic.remediation = 'Run `npm run db:migrate` from the web directory so the task_logs table exists.'
  }

  return diagnostic
}

export async function recordTaskLog(input: RecordTaskLogInput): Promise<typeof taskLogs.$inferSelect> {
  const createdAt = new Date()
  const [log] = await db
    .insert(taskLogs)
    .values({
      agentRunId: input.agentRunId ?? null,
      approvalGateId: input.approvalGateId ?? null,
      artifactId: input.artifactId ?? null,
      eventType: cleanText(input.eventType, 500),
      frontMatter: frontMatterWithTimestamp(input.frontMatter ?? {}, createdAt),
      level: input.level ?? 'info',
      message: LEGACY_TASK_LOG_UNAVAILABLE,
      metadata: sanitizeLogStructuredValue(input.metadata ?? {}, { stringByteLimit: 16 * 1024 }) as Record<string, unknown>,
      occurredAt: createdAt,
      source: cleanText(input.source ?? 'system', 100),
      taskAttemptId: input.taskAttemptId ?? null,
      taskId: input.taskId,
      title: cleanText(input.title, 500),
      workPackageId: input.workPackageId ?? null,
      createdAt,
    })
    .returning()

  const safeLog = sanitizeLogRecordForOutput(log)

  await publishTaskEvent(input.taskId, 'task:log', {
    id: log.id,
    createdAt: safeLog.createdAt.toISOString(),
    eventType: safeLog.eventType,
    level: safeLog.level,
    occurredAt: safeLog.occurredAt.toISOString(),
    sequence: log.sequence,
    source: safeLog.source,
    title: safeLog.title,
  })

  return safeLog
}

export async function recordTaskLogBestEffort(input: RecordTaskLogInput): Promise<void> {
  if (process.env.NODE_ENV === 'test' && process.env.FORGE_ENABLE_TASK_LOGS_IN_TEST !== '1') return
  try {
    await recordTaskLog(input)
  } catch (err) {
    console.warn('[task-logs] Failed to record task log', {
      ...taskLogErrorDiagnostic(err),
      eventType: cleanText(input.eventType, 500),
      taskId: input.taskId,
    })
  }
}
