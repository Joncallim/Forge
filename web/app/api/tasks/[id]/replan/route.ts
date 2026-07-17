import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { tasks } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'
import { sanitizePromptSnapshot } from '@/lib/task-log-sanitization'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const replanSchema = z.object({
  feedback: z.string().trim().min(1, 'Feedback is required to change the plan'),
})

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/replan
//
// Requests a revised plan for a task awaiting approval. The reviewer's feedback
// is appended as a clearly delimited revision note, while the orchestrator also
// loads the previous plan artifact and edits that plan in place. The task is
// re-queued for the architect stage (status -> pending).
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
        { error: `Cannot change the plan for a task with status '${existing.status}'. Task must be in 'awaiting_approval' status.` },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = replanSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const { feedback } = parsed.data
    const revisionNote = [
      '',
      '',
      '---',
      `## Plan revision requested (${new Date().toISOString()})`,
      feedback,
    ].join('\n')

    const [task] = await db
      .update(tasks)
      .set({
        prompt: existing.prompt + revisionNote,
        status: 'pending',
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(and(accessibleTaskCondition(taskId, session.userId), eq(tasks.status, 'awaiting_approval')))
      .returning()

    if (!task) {
      return NextResponse.json(
        { error: `Cannot change the plan for a task with status '${existing.status}'. Task must be in 'awaiting_approval' status.` },
        { status: 409 },
      )
    }

    // Re-queue for the architect stage, the same way new tasks are enqueued.
    await redis.lpush('forge:tasks', JSON.stringify({ taskId: task.id }))
    await redis.publish('forge:task:' + taskId, JSON.stringify({
      type: 'task:status',
      status: 'pending',
      updatedAt: task.updatedAt.toISOString(),
    }))

    await recordTaskLogBestEffort({
      eventType: 'task.replan_requested',
      frontMatter: {
        model: task.pmProviderConfigId ?? null,
        connector: 'task-default',
      },
      level: 'warning',
      message: 'Plan revision was requested.',
      metadata: { feedback: sanitizePromptSnapshot(feedback), requestedBy: session.userId },
      source: 'api',
      taskId,
      title: 'Plan revision requested',
    })

    console.info('[POST /api/tasks/:id/replan] Re-queued task for revised plan', { id: taskId })
    return NextResponse.json({ task })
  } catch (err) {
    console.error('[POST /api/tasks/:id/replan] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
