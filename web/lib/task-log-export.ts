import type { TaskLog } from '@/db/schema'
import { sanitizeWorkerMessage } from '@/worker/redaction'
import { sanitizeLogRecordForOutput, sanitizePromptSnapshot } from '@/lib/task-log-sanitization'

type TaskLogExportTask = {
  completedAt?: Date | string | null
  createdAt?: Date | string | null
  errorMessage?: string | null
  id: string
  prompt: string
  status: string
  title: string
  updatedAt?: Date | string | null
}

type TaskLogExportInput = {
  exportedAt?: Date
  logs: TaskLog[]
  task: TaskLogExportTask
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function latestFrontMatterValue(logs: TaskLog[], key: string): string | null {
  for (const log of [...logs].reverse()) {
    if (!isRecord(log.frontMatter)) continue
    const value = log.frontMatter[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function yamlString(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value)
}

function jsonBlock(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length === 0) return ''
  return [
    '```json',
    JSON.stringify(value, null, 2),
    '```',
  ].join('\n')
}

function taskErrorSnapshot(errorMessage: string): string {
  const snapshot = sanitizePromptSnapshot(errorMessage)
  return [
    'Task error snapshot:',
    `byte_length=${snapshot.byteLength}`,
    `sha256=${snapshot.sha256}`,
    `truncated=${snapshot.truncated ? 'true' : 'false'}`,
  ].join(' ')
}

function entryFrontMatter(log: TaskLog): string[] {
  const frontMatter = isRecord(log.frontMatter) ? log.frontMatter : {}
  const model = firstString([frontMatter.model, frontMatter.modelId, frontMatter.modelIdUsed])
  const connector = firstString([frontMatter.connector, frontMatter.providerType, frontMatter.provider])
  const promptSnapshot = isRecord(frontMatter.prompt)
    ? frontMatter.prompt
    : isRecord(frontMatter.promptInput)
      ? frontMatter.promptInput
      : null
  return [
    `event_type: ${yamlString(log.eventType)}`,
    `source: ${yamlString(log.source)}`,
    `model: ${yamlString(model)}`,
    `connector: ${yamlString(connector)}`,
    `prompt_byte_length: ${typeof promptSnapshot?.byteLength === 'number' ? promptSnapshot.byteLength : 'null'}`,
    `prompt_sha256: ${yamlString(typeof promptSnapshot?.sha256 === 'string' ? promptSnapshot.sha256 : null)}`,
    `prompt_truncated: ${promptSnapshot?.truncated === true ? 'true' : 'false'}`,
  ]
}

export function taskLogExportFilename(taskId: string, exportedAt = new Date()): string {
  const stamp = exportedAt.toISOString().replace(/[:.]/g, '-')
  return `forge-task-log-${taskId}-${stamp}.md`
}

export function formatTaskLogsMarkdown(input: TaskLogExportInput): string {
  const exportedAt = input.exportedAt ?? new Date()
  const logs = input.logs.map((log) => sanitizeLogRecordForOutput(log))
  const model = latestFrontMatterValue(logs, 'model')
  const connector = latestFrontMatterValue(logs, 'connector')
  const prompt = sanitizePromptSnapshot(input.task.prompt)
  const taskTitle = sanitizeWorkerMessage(input.task.title)
  const lines = [
    '---',
    'schema_version: 1',
    `task_id: ${yamlString(input.task.id)}`,
    `title: ${yamlString(taskTitle)}`,
    `status: ${yamlString(input.task.status)}`,
    `exported_at: ${yamlString(exportedAt.toISOString())}`,
    `created_at: ${yamlString(iso(input.task.createdAt))}`,
    `updated_at: ${yamlString(iso(input.task.updatedAt))}`,
    `completed_at: ${yamlString(iso(input.task.completedAt))}`,
    `model: ${yamlString(model)}`,
    `connector: ${yamlString(connector)}`,
    `prompt_byte_length: ${prompt.byteLength}`,
    `prompt_sha256: ${yamlString(prompt.sha256)}`,
    `prompt_truncated: ${prompt.truncated ? 'true' : 'false'}`,
    '---',
    '',
    `# Task Log: ${taskTitle}`,
    '',
    input.task.errorMessage ? taskErrorSnapshot(input.task.errorMessage) : null,
    logs.length === 0 ? 'No log entries have been recorded for this task.' : null,
  ].filter((line): line is string => line !== null)

  for (const log of logs) {
    const createdAt = iso(log.occurredAt) ?? iso(log.createdAt) ?? 'unknown time'
    lines.push(
      '',
      `## ${createdAt} - #${log.sequence} - ${log.level.toUpperCase()} - ${log.title}`,
      '',
      '```yaml',
      ...entryFrontMatter(log),
      '```',
      '',
      sanitizeWorkerMessage(log.message),
    )
    const metadata = jsonBlock(log.metadata)
    if (metadata !== '') {
      lines.push('', 'Metadata:', '', metadata)
    }
  }

  return `${lines.join('\n')}\n`
}

export function formatTaskLogsJsonl(input: TaskLogExportInput): string {
  return input.logs
    .map((rawLog) => {
      const log = sanitizeLogRecordForOutput(rawLog)
      const frontMatter = isRecord(log.frontMatter) ? log.frontMatter : {}
      return JSON.stringify({
        id: log.id,
        sequence: log.sequence,
        taskId: log.taskId,
        taskAttemptId: log.taskAttemptId,
        agentRunId: log.agentRunId,
        workPackageId: log.workPackageId,
        artifactId: log.artifactId,
        approvalGateId: log.approvalGateId,
        level: log.level,
        eventType: log.eventType,
        source: log.source,
        title: log.title,
        message: sanitizeWorkerMessage(log.message),
        frontMatter,
        metadata: log.metadata,
        occurredAt: iso(log.occurredAt),
        createdAt: iso(log.createdAt),
      })
    })
    .join('\n') + (input.logs.length > 0 ? '\n' : '')
}
