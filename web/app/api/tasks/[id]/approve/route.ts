import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { approvalGates, projects, tasks, workPackages } from '@/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'
import {
  isExplicitFilesystemEffectivePhase,
  isRecord as isFilesystemGrantRecord,
  projectFilesystemEffectivePhase,
  projectFilesystemGrantCovers,
  requiresFilesystemGrantApproval,
} from '@/lib/mcps/filesystem-grants'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : []
}

function approvedStatusForGrant(status: unknown): string {
  return typeof status === 'string' ? status : 'unknown'
}

function buildApprovedPackageGrantPhases(input: {
  approvedAt: Date
  approvedBy: string
  metadata: unknown
}): Record<string, unknown> {
  const metadata = isRecord(input.metadata) ? input.metadata : {}
  const existingPhases = isRecord(metadata.mcpGrantPhases) ? metadata.mcpGrantPhases : {}
  const proposedGrants = recordArray(metadata.mcpGrants)
  const approvedGrants = proposedGrants.map((grant) => ({
    ...grant,
    approvedAt: input.approvedAt.toISOString(),
    approvedBy: input.approvedBy,
    sourceStatus: typeof grant.status === 'string' ? grant.status : null,
    status: approvedStatusForGrant(grant.status),
  }))
  const existingEffective = isExplicitFilesystemEffectivePhase(existingPhases.effective)
    ? existingPhases.effective
    : null

  return {
    ...existingPhases,
    schemaVersion: 1,
    proposed: Array.isArray(existingPhases.proposed) ? existingPhases.proposed : proposedGrants,
    approved: {
      schemaVersion: 1,
      phase: 'approved',
      approvedAt: input.approvedAt.toISOString(),
      approvedBy: input.approvedBy,
      grants: approvedGrants,
      runtimeIssued: false,
      runtimeEnforcement: 'approved_snapshot',
      note: 'Plan approval converted proposed MCP grant decisions into package-local approved grants. Runtime context is issued later by the work-package executor from the effective grant phase.',
    },
    effective: existingEffective ?? {
      schemaVersion: 1,
      phase: 'effective',
      source: 'task-approval',
      grants: [],
      runtimeIssued: false,
      runtimeEnforcement: 'approved_snapshot',
      status: 'not_issued',
      note: 'Task plan approval does not convert Architect-proposed MCP grants into runtime-effective grants. Effective grants must come from an explicit grant approval path before bounded runtime context can be issued.',
    },
  }
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
    runtimeEnforcement: 'approved_snapshot',
    note: 'Plan approval records package-local approved/effective MCP grant snapshots. Forge beta may issue bounded read-only filesystem context packets during package execution, but does not issue live MCP tool handles from this approval.',
    packages: input.packages.map((pkg) => {
      const metadata = isRecord(pkg.metadata) ? pkg.metadata : {}
      const mcpGrantPhases = buildApprovedPackageGrantPhases({
        approvedAt: input.approvedAt,
        approvedBy: input.approvedBy,
        metadata,
      })
      const approved = isRecord(mcpGrantPhases.approved) ? mcpGrantPhases.approved : {}
      const effective = isRecord(mcpGrantPhases.effective) ? mcpGrantPhases.effective : {}
      return {
        workPackageId: pkg.id,
        title: pkg.title,
        assignedRole: pkg.assignedRole,
        proposedGrants: Array.isArray(metadata.mcpGrants) ? metadata.mcpGrants : [],
        approvedGrants: Array.isArray(approved.grants) ? approved.grants : [],
        effectiveGrants: Array.isArray(effective.grants) ? effective.grants : [],
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
    const { task, approvedGates, missingFilesystemGrant } = await db.transaction(async (tx) => {
      const rawPackageRows = await tx
        .select({
          id: workPackages.id,
          assignedRole: workPackages.assignedRole,
          title: workPackages.title,
          mcpRequirements: workPackages.mcpRequirements,
          metadata: workPackages.metadata,
        })
        .from(workPackages)
        .where(eq(workPackages.taskId, taskId))
      const [projectGrantRow] = await tx
        .select({ mcpConfig: projects.mcpConfig })
        .from(projects)
        .where(eq(projects.id, existing.projectId))
        .limit(1)

      const packageRows = rawPackageRows.map((pkg) => {
        const grant = projectFilesystemGrantCovers({
          mcpConfig: projectGrantRow?.mcpConfig,
          mcpRequirements: pkg.mcpRequirements,
          metadata: pkg.metadata,
        })
        if (!grant) return pkg
        const metadata = isFilesystemGrantRecord(pkg.metadata) ? pkg.metadata : {}
        const phases = isFilesystemGrantRecord(metadata.mcpGrantPhases) ? metadata.mcpGrantPhases : {}
        return {
          ...pkg,
          metadata: {
            ...metadata,
            mcpGrantPhases: {
              ...phases,
              schemaVersion: 1,
              effective: projectFilesystemEffectivePhase(grant),
            },
          },
        }
      })

      const missingGrant = packageRows
        .map((pkg) => ({
          pkg,
          grant: requiresFilesystemGrantApproval({
            mcpRequirements: pkg.mcpRequirements,
            metadata: pkg.metadata,
          }),
        }))
        .find(({ grant }) => grant.blocked)

      if (missingGrant) {
        return {
          task: null,
          approvedGates: [] as { id: string }[],
          missingFilesystemGrant: {
            error: `Approve or deny required filesystem context for "${missingGrant.pkg.title}" before approving the plan.`,
            missingCapabilities: missingGrant.grant.missingCapabilities,
            workPackageId: missingGrant.pkg.id,
          },
        }
      }

      const [approvedTask] = await tx
        .update(tasks)
        .set({ errorMessage: null, status: 'approved', updatedAt: approvedAt })
        .where(and(accessibleTaskCondition(taskId, session.userId), eq(tasks.status, 'awaiting_approval')))
        .returning()

      if (!approvedTask) {
        return { task: null, approvedGates: [] as { id: string }[], missingFilesystemGrant: null }
      }

      const approvedGrantSnapshot = buildApprovedGrantSnapshot({
        approvedAt,
        approvedBy: session.userId,
        packages: packageRows,
      })

      for (const pkg of packageRows) {
        const phases = buildApprovedPackageGrantPhases({
          approvedAt,
          approvedBy: session.userId,
          metadata: pkg.metadata,
        })
        await tx
          .update(workPackages)
          .set({
            metadata: sql`jsonb_set(${workPackages.metadata}, '{mcpGrantPhases}', ${JSON.stringify(phases)}::jsonb, true)`,
            updatedAt: approvedAt,
          })
          .where(eq(workPackages.id, pkg.id))
      }

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
                runtimeEnforcement: 'approved_snapshot',
                status: 'package_scoped',
                note: 'Effective MCP grants are persisted on each work package. The executor may issue bounded read-only filesystem context packets from those package snapshots; live MCP tools remain disabled.',
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

      return { task: approvedTask, approvedGates: gates, missingFilesystemGrant: null }
    })

    if (missingFilesystemGrant) {
      return NextResponse.json(missingFilesystemGrant, { status: 409 })
    }

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
