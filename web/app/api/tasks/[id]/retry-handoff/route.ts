import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { tasks } from '@/db/schema'
import { getSession } from '@/lib/session'
import { enqueueBlockedHandoffRetry } from '@/worker/blocked-handoff-retry'

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/retry-handoff
//
// Re-enqueues an approval job for a task parked at `approved` or already
// `running`. This is the operator recovery path for broker-blocked packages and
// for ambiguous approval/review continuation enqueue outcomes. processApproval
// re-runs all handoff gates, so retries never bypass broker or review checks.
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

    const { id: taskId } = await params

    const [task] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (task.status !== 'approved' && task.status !== 'running') {
      return NextResponse.json(
        { error: `Cannot retry handoff for a task with status '${task.status}'. The task must be 'approved' or 'running'.` },
        { status: 409 },
      )
    }

    const retry = await enqueueBlockedHandoffRetry(taskId, { source: 'operator' })

    return NextResponse.json({ result: { status: retry.status === 'enqueued' ? 'retry_enqueued' : 'retry_already_queued' } })
  } catch (err) {
    console.error('[POST /api/tasks/:id/retry-handoff] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
