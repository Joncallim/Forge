import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { approvalGates, tasks } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/approve
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

    const [existing] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (existing.status !== 'awaiting_approval') {
      return NextResponse.json(
        { error: `Cannot approve task with status '${existing.status}'. Task must be in 'awaiting_approval' status.` },
        { status: 409 },
      )
    }

    const approvedAt = new Date()
    const { task, approvedGates } = await db.transaction(async (tx) => {
      const [approvedTask] = await tx
        .update(tasks)
        .set({ status: 'approved', updatedAt: approvedAt })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, 'awaiting_approval')))
        .returning()

      if (!approvedTask) {
        return { task: null, approvedGates: [] as { id: string }[] }
      }

      const gates = await tx
        .update(approvalGates)
        .set({
          status: 'approved',
          decidedAt: approvedAt,
          decidedBy: session.userId,
          updatedAt: approvedAt,
        })
        .where(
          and(
            eq(approvalGates.taskId, taskId),
            eq(approvalGates.gateType, 'plan_approval'),
            eq(approvalGates.status, 'pending'),
          ),
        )
        .returning({ id: approvalGates.id })

      return { task: approvedTask, approvedGates: gates }
    })

    if (!task) {
      return NextResponse.json(
        { error: `Cannot approve task with status '${existing.status}'. Task must be in 'awaiting_approval' status.` },
        { status: 409 },
      )
    }

    await redis.lpush('forge:approvals', JSON.stringify({ taskId, action: 'approve' }))
    await redis.publish('forge:task:' + taskId, JSON.stringify({
      type: 'task:status',
      status: 'approved',
      updatedAt: task.updatedAt.toISOString(),
    }))
    for (const gate of approvedGates) {
      await redis.publish('forge:task:' + taskId, JSON.stringify({
        type: 'approval_gate:decided',
        gateId: gate.id,
        gateType: 'plan_approval',
        status: 'approved',
        updatedAt: approvedAt.toISOString(),
      }))
    }

    console.info('[POST /api/tasks/:id/approve] Approved task', { id: taskId })
    return NextResponse.json({ task })
  } catch (err) {
    console.error('[POST /api/tasks/:id/approve] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
