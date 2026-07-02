import { db } from '../db'
import { taskLogs } from '../db/schema'
import { publishTaskEvent } from './events'
import { sanitizeWorkerMessage } from './redaction'
import { sanitizeLogFrontMatter, sanitizeLogRecordForOutput, sanitizeLogStructuredValue } from '@/lib/task-log-sanitization'

export type TaskLogLevel = 'info' | 'success' | 'warning' | 'error'

export type TaskLogFrontMatter = {
  connector?: string | null
  model?: string | null
  prompt?: string | null
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

export async function recordTaskLog(input: RecordTaskLogInput): Promise<typeof taskLogs.$inferSelect> {
  const createdAt = new Date()
  const [log] = await db
    .insert(taskLogs)
    .values({
      agentRunId: input.agentRunId ?? null,
      approvalGateId: input.approvalGateId ?? null,
      artifactId: input.artifactId ?? null,
      eventType: input.eventType,
      frontMatter: frontMatterWithTimestamp(input.frontMatter ?? {}, createdAt),
      level: input.level ?? 'info',
      message: cleanText(input.message),
      metadata: sanitizeLogStructuredValue(input.metadata ?? {}, { stringByteLimit: 16 * 1024 }) as Record<string, unknown>,
      occurredAt: createdAt,
      source: input.source ?? 'system',
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
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[task-logs] Failed to record task log', {
      err: sanitizeWorkerMessage(message),
      eventType: input.eventType,
      taskId: input.taskId,
    })
  }
}
