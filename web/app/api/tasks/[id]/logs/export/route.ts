import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { taskLogs, type TaskLog } from '@/db/schema'
import { formatTaskLogsJsonl, formatTaskLogsMarkdown, taskLogExportFilename } from '@/lib/task-log-export'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import { taskLogsUnavailableMessage } from '@/lib/task-log-db-errors'

const MAX_EXPORT_LOGS = 1000
const MAX_EXPORT_BYTES = 2 * 1024 * 1024
const MARKDOWN_TRUNCATED_NOTICE = '\n_Export truncated by Forge size limits._\n'

function enforceByteCap(value: string): string {
  const buffer = Buffer.from(value)
  if (buffer.byteLength <= MAX_EXPORT_BYTES) return value
  return buffer.subarray(0, MAX_EXPORT_BYTES).toString('utf8')
}

function renderBoundedExport(input: {
  exportedAt: Date
  format: 'jsonl' | 'markdown'
  logs: TaskLog[]
  task: NonNullable<Awaited<ReturnType<typeof getAccessibleTask>>>
}): { body: string; truncated: boolean } {
  let logs = input.logs.slice(0, MAX_EXPORT_LOGS)
  let truncated = input.logs.length > MAX_EXPORT_LOGS
  let body = input.format === 'jsonl'
    ? formatTaskLogsJsonl({ exportedAt: input.exportedAt, logs, task: input.task })
    : formatTaskLogsMarkdown({ exportedAt: input.exportedAt, logs, task: input.task })

  while (Buffer.byteLength(body) > MAX_EXPORT_BYTES && logs.length > 0) {
    truncated = true
    logs = logs.slice(0, Math.max(0, Math.floor(logs.length * 0.75)))
    body = input.format === 'jsonl'
      ? formatTaskLogsJsonl({ exportedAt: input.exportedAt, logs, task: input.task })
      : formatTaskLogsMarkdown({ exportedAt: input.exportedAt, logs, task: input.task })
  }

  if (truncated && input.format === 'markdown') {
    body += MARKDOWN_TRUNCATED_NOTICE
  }

  const cappedBody = enforceByteCap(body)
  return { body: cappedBody, truncated: truncated || cappedBody.length !== body.length }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: taskId } = await params
    const task = await getAccessibleTask(taskId, session.userId)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const logs = await db
      .select()
      .from(taskLogs)
      .where(eq(taskLogs.taskId, taskId))
      .orderBy(asc(taskLogs.occurredAt), asc(taskLogs.sequence))
      .limit(MAX_EXPORT_LOGS + 1)

    const exportedAt = new Date()
    const format = request.nextUrl.searchParams.get('format') === 'jsonl' ? 'jsonl' : 'markdown'
    const { body, truncated } = renderBoundedExport({ exportedAt, format, logs, task })
    const extension = format === 'jsonl' ? 'jsonl' : 'md'
    const filename = taskLogExportFilename(taskId, exportedAt).replace(/\.md$/, `.${extension}`)

    return new NextResponse(body, {
      headers: {
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': format === 'jsonl'
          ? 'application/x-ndjson; charset=utf-8'
          : 'text/markdown; charset=utf-8',
        'X-Forge-Task-Log-Truncated': truncated ? 'true' : 'false',
      },
    })
  } catch (err) {
    const unavailableMessage = taskLogsUnavailableMessage(err)
    if (unavailableMessage) {
      return NextResponse.json({ error: unavailableMessage }, { status: 503 })
    }
    console.error('[GET /api/tasks/:id/logs/export] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
