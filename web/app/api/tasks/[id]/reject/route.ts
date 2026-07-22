import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { tasks } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { publishTaskEvent } from '@/worker/events'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const rejectSchema = z.object({
  reason: z.string().optional(),
})

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/reject
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock

    const { id: taskId } = await params

    const existing = await getAccessibleTask(taskId, session.userId)

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (existing.status !== 'awaiting_approval') {
      return NextResponse.json(
        { error: `Cannot reject task with status '${existing.status}'. Task must be in 'awaiting_approval' status.` },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      // Body is optional for reject
      body = {}
    }

    const parsed = rejectSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const { reason } = parsed.data

    const [task] = await db
      .update(tasks)
      .set({
        status: 'rejected',
        errorMessage: reason ?? null,
        updatedAt: new Date(),
      })
      .where(and(accessibleTaskCondition(taskId, session.userId), eq(tasks.status, 'awaiting_approval')))
      .returning()

    if (!task) {
      return NextResponse.json(
        { error: `Cannot reject task with status '${existing.status}'. Task must be in 'awaiting_approval' status.` },
        { status: 409 },
      )
    }

    await recordTaskLogBestEffort({
      eventType: 'task.rejected',
      level: 'error',
      message: reason ? `Task was rejected: ${reason}` : 'Task was rejected.',
      metadata: { rejectedBy: session.userId, updatedAt: task.updatedAt.toISOString() },
      source: 'api',
      taskId,
      title: 'Task rejected',
    })

    await publishTaskEvent(taskId, 'task:status', {
      status: 'rejected',
      errorMessage: task.errorMessage,
      updatedAt: task.updatedAt.toISOString(),
    })

    console.info('[POST /api/tasks/:id/reject] Rejected task', { id: taskId, reason })
    return NextResponse.json({ task })
  } catch (err) {
    console.error('[POST /api/tasks/:id/reject] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
