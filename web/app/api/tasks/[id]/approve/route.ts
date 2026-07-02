import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { approvalGates, tasks, workPackages } from '@/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildApprovedGrantSnapshot(input: {
  approvedAt: Date
  approvedBy: string
  packages: Array<{
    assignedRole: string
    id: string
    mcpRequirements: unknown
    metadata: unknown
    title: string
  }>
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    phase: 'approved',
    approvedAt: input.approvedAt.toISOString(),
    approvedBy: input.approvedBy,
    runtimeIssued: false,
    runtimeEnforcement: 'not_implemented',
    note: 'Plan approval records a non-runtime MCP/capability grant snapshot only; Forge beta does not issue live MCP tools from this approval.',
    packages: input.packages.map((pkg) => {
      const metadata = isRecord(pkg.metadata) ? pkg.metadata : {}
      return {
        workPackageId: pkg.id,
        title: pkg.title,
        assignedRole: pkg.assignedRole,
        proposedGrants: Array.isArray(metadata.mcpGrants) ? metadata.mcpGrants : [],
        proposedRequirements: Array.isArray(pkg.mcpRequirements) ? pkg.mcpRequirements : [],
        promptOverlayPresent: typeof metadata.promptOverlay === 'string' && metadata.promptOverlay.trim() !== '',
      }
    }),
  }
}

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

    const existing = await getAccessibleTask(taskId, session.userId)

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
        .set({ errorMessage: null, status: 'approved', updatedAt: approvedAt })
        .where(and(accessibleTaskCondition(taskId, session.userId), eq(tasks.status, 'awaiting_approval')))
        .returning()

      if (!approvedTask) {
        return { task: null, approvedGates: [] as { id: string }[] }
      }

      const packageRows = await tx
        .select({
          id: workPackages.id,
          assignedRole: workPackages.assignedRole,
          title: workPackages.title,
          mcpRequirements: workPackages.mcpRequirements,
          metadata: workPackages.metadata,
        })
        .from(workPackages)
        .where(eq(workPackages.taskId, taskId))
      const approvedGrantSnapshot = buildApprovedGrantSnapshot({
        approvedAt,
        approvedBy: session.userId,
        packages: packageRows,
      })

      const gates = await tx
        .update(approvalGates)
        .set({
          status: 'approved',
          metadata: sql`${approvalGates.metadata} || ${JSON.stringify({
            approval: {
              approvedAt: approvedAt.toISOString(),
              approvedBy: session.userId,
              source: 'task-approval',
            },
            mcpGrantPhases: {
              approved: approvedGrantSnapshot,
              effective: {
                schemaVersion: 1,
                phase: 'effective',
                runtimeIssued: false,
                runtimeEnforcement: 'not_implemented',
                status: 'not_issued',
                note: 'Effective run instructions remain prompt/context metadata only; Forge beta does not issue live MCP runtime tools.',
              },
            },
          })}::jsonb`,
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

    await recordTaskLogBestEffort({
      eventType: 'task.approved',
      level: 'success',
      message: `Task plan was approved by ${session.userId}.`,
      metadata: { approvedAt: approvedAt.toISOString(), approvedGateIds: approvedGates.map((gate) => gate.id) },
      source: 'api',
      taskId,
      title: 'Task approved',
    })

    try {
      await redis.lpush('forge:approvals', JSON.stringify({ taskId, action: 'approve' }))
    } catch (err) {
      console.error('[POST /api/tasks/:id/approve] Failed to enqueue approval worker job', err)
      return NextResponse.json(
        {
          error: 'Approval worker queue result could not be confirmed; approval was saved and can be retried from the task.',
          task,
        },
        { status: 202 },
      )
    }
    try {
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
    } catch (err) {
      console.error('[POST /api/tasks/:id/approve] Failed to publish approval progress event', err)
    }

    console.info('[POST /api/tasks/:id/approve] Approved task', { id: taskId })
    return NextResponse.json({ task })
  } catch (err) {
    console.error('[POST /api/tasks/:id/approve] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
