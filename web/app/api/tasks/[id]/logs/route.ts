import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { taskLogs } from '@/db/schema'
import { getSession } from '@/lib/session'
import { sanitizeLogRecordForOutput } from '@/lib/task-log-sanitization'
import { getAccessibleTask } from '@/lib/task-access'
import { taskLogsUnavailableMessage } from '@/lib/task-log-db-errors'

const MAX_LIMIT = 250

export function parseLimit(value: string | null): number {
  // An absent/empty param must fall back to the default; `Number(null)` and
  // `Number('')` are 0 (a valid integer), which would otherwise clamp to 1.
  if (value === null || value.trim() === '') return 100
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return 100
  return Math.min(MAX_LIMIT, Math.max(1, parsed))
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

    const { searchParams } = request.nextUrl
    const limit = parseLimit(searchParams.get('limit'))
    const afterSequenceRaw = searchParams.get('afterSequence')
    const afterSequence = afterSequenceRaw === null ? null : Number(afterSequenceRaw)
    const level = searchParams.get('level')
    const eventType = searchParams.get('eventType')

    const conditions: SQL[] = [eq(taskLogs.taskId, taskId)]
    if (Number.isInteger(afterSequence) && afterSequence !== null) {
      conditions.push(gt(taskLogs.sequence, afterSequence))
    }
    if (level) conditions.push(eq(taskLogs.level, level))
    if (eventType) conditions.push(eq(taskLogs.eventType, eventType))

    const logs = await db
      .select()
      .from(taskLogs)
      .where(and(...conditions) ?? sql`true`)
      .orderBy(asc(taskLogs.sequence))
      .limit(limit)

    return NextResponse.json({
      logs: logs.map((log) => sanitizeLogRecordForOutput(log)),
      nextAfterSequence: logs.length > 0 ? logs[logs.length - 1].sequence : afterSequence,
    })
  } catch (err) {
    const unavailableMessage = taskLogsUnavailableMessage(err)
    if (unavailableMessage) {
      return NextResponse.json({ error: unavailableMessage }, { status: 503 })
    }
    console.error('[GET /api/tasks/:id/logs] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
