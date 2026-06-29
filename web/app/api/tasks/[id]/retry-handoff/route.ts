import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { tasks, workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/retry-handoff
//
// Re-enqueues an approval job for a task that is parked at `approved` with one
// or more work packages blocked by the MCP/capability broker (e.g. an MCP was
// temporarily unhealthy). The normal approve route only accepts
// `awaiting_approval`, so this is the operator's path to retry a blocked
// handoff once the underlying issue is resolved. processApproval re-runs the
// broker, so a still-unresolved block simply re-blocks — it never bypasses the
// gate.
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

    if (task.status !== 'approved') {
      return NextResponse.json(
        { error: `Cannot retry handoff for a task with status '${task.status}'. The task must be 'approved'.` },
        { status: 409 },
      )
    }

    const [blockedPackage] = await db
      .select({ id: workPackages.id })
      .from(workPackages)
      .where(and(eq(workPackages.taskId, taskId), eq(workPackages.status, 'blocked')))
      .limit(1)

    if (!blockedPackage) {
      return NextResponse.json(
        { error: 'No blocked work packages to retry for this task.' },
        { status: 409 },
      )
    }

    await redis.lpush('forge:approvals', JSON.stringify({ taskId, action: 'approve' }))

    return NextResponse.json({ result: { status: 'retry_enqueued' } })
  } catch (err) {
    console.error('[POST /api/tasks/:id/retry-handoff] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
