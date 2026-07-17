import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { isDeepStrictEqual } from 'node:util'
import { db } from '@/db'
import { approvalGates, projects, tasks, workPackages } from '@/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { redis } from '@/lib/redis'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'
import { getProjectMcpOverview, normalizeProjectMcpConfig } from '@/lib/mcps/manager'
import {
  type McpHealthSnapshot,
  type McpWorkPackageAdmission,
} from '@/lib/mcps/admission'
import { admitWorkPackageMcpBroker } from '@/worker/mcp-execution-design'
import {
  latestMcpOperatorReview,
  projectReviewedMcpPlanToPackages,
} from '@/worker/mcp-plan-review'
import type { ProjectMcpOverview } from '@/lib/mcps/types'
import {
  isExplicitFilesystemEffectivePhase,
  isRecord as isFilesystemGrantRecord,
  projectFilesystemEffectivePhase,
  projectFilesystemGrantCovers,
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

function admissionForLockedPackage(input: {
  assignedRole: string
  mcpOverview: ProjectMcpOverview
  mcpConfig: unknown
  mcpRequirements: unknown
  metadata: unknown
  title: string
}): McpWorkPackageAdmission {
  return admitWorkPackageMcpBroker({
    assignedRole: input.assignedRole,
    mcpOverview: input.mcpOverview,
    mcpRequirements: input.mcpRequirements,
    metadata: input.metadata,
    projectMcpConfig: input.mcpConfig,
    title: input.title,
  })
}

function approvalHealthSnapshot(admissions: McpWorkPackageAdmission[]): McpHealthSnapshot[] {
  const byMcpId = new Map<string, McpHealthSnapshot>()
  for (const admission of admissions) {
    for (const evaluation of admission.evaluations) {
      byMcpId.set(evaluation.health.mcpId, { ...evaluation.health })
    }
  }
  return [...byMcpId.values()].sort((left, right) => left.mcpId.localeCompare(right.mcpId))
}

function healthSnapshotMatchesLockedPolicy(
  overview: ProjectMcpOverview,
  capturedLocalPath: unknown,
  lockedProject: { localPath?: unknown; mcpConfig: ProjectMcpOverview['config'] },
): boolean {
  // The overview is captured before the transaction because probing MCP health
  // may write cache rows. Approval may consume it only while the normalized
  // project policy it was captured for is still the locked project policy.
  return capturedLocalPath === lockedProject.localPath &&
    isDeepStrictEqual(
      normalizeProjectMcpConfig(overview.config),
      normalizeProjectMcpConfig(lockedProject.mcpConfig),
    )
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
        approvedRequirements: Array.isArray(pkg.mcpRequirements) ? pkg.mcpRequirements : [],
        promptOverlayPresent: typeof metadata.promptOverlay === 'string' && metadata.promptOverlay.trim() !== '',
        ...(isRecord(metadata.mcpOperatorReview) ? { mcpOperatorReview: metadata.mcpOperatorReview } : {}),
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


    const [projectForHealth] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, existing.projectId))
      .limit(1)
    if (!projectForHealth) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    // Live MCP checks may update cached status rows, so they must complete
    // before the status-flip transaction acquires any project/task locks.
    const mcpOverview = await getProjectMcpOverview(projectForHealth)

    const approvedAt = new Date()
    const { task, approvedGates, approvalBlock } = await db.transaction(async (tx) => {
      const [lockedProject] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, existing.projectId))
        .for('update')
      if (!lockedProject) {
        return { task: null, approvedGates: [] as { id: string }[], approvalBlock: null }
      }

      if (!healthSnapshotMatchesLockedPolicy(mcpOverview, projectForHealth.localPath, lockedProject)) {
        const reason = 'Project MCP health inputs changed while approval health was being checked (configuration or local path). Review the latest project settings and approve again.'
        return {
          task: null,
          approvedGates: [] as { id: string }[],
          approvalBlock: {
            error: reason,
            evidenceRefs: [] as string[],
            primaryDecision: null,
            primaryMode: 'blocked' as const,
            reason,
            primaryRecoveryAction: 'revise_plan' as const,
            primaryRetryableContribution: false,
            retryable: false,
            workPackageId: null,
          },
        }
      }

      const [lockedTask] = await tx
        .select()
        .from(tasks)
        .where(and(accessibleTaskCondition(taskId, session.userId), eq(tasks.status, 'awaiting_approval')))
        .for('update')
      if (!lockedTask) {
        return { task: null, approvedGates: [] as { id: string }[], approvalBlock: null }
      }

      const storedPackageRows = await tx
        .select({
          id: workPackages.id,
          assignedRole: workPackages.assignedRole,
          title: workPackages.title,
          mcpRequirements: workPackages.mcpRequirements,
          metadata: workPackages.metadata,
          planGateMetadata: sql<unknown>`(
            select ${approvalGates.metadata} from ${approvalGates}
            where ${approvalGates.taskId} = ${taskId}
              and ${approvalGates.gateType} = 'plan_approval'
              and ${approvalGates.status} = 'pending'
            limit 1
          )`,
          planGateSourceArtifactId: sql<string | null>`(
            select ${approvalGates.sourceArtifactId} from ${approvalGates}
            where ${approvalGates.taskId} = ${taskId}
              and ${approvalGates.gateType} = 'plan_approval'
              and ${approvalGates.status} = 'pending'
            limit 1
          )`,
        })
        .from(workPackages)
        .where(eq(workPackages.taskId, taskId))
        .orderBy(asc(workPackages.id))
        .for('update')
      const gateMetadata = isRecord(storedPackageRows[0]?.planGateMetadata) ? storedPackageRows[0].planGateMetadata : {}
      const operatorReview = latestMcpOperatorReview(gateMetadata)
      const planGateSourceArtifactId = storedPackageRows[0]?.planGateSourceArtifactId
      const reviewBlockReason = isRecord(gateMetadata.mcpOperatorReview) && !operatorReview
        ? 'The saved MCP operator review failed its integrity check. Reload or revise the plan before approval.'
        : gateMetadata.mcpOperatorReviewRequired === true && !operatorReview
          ? 'Review and save every proposed MCP requirement before approving this plan.'
        : operatorReview && operatorReview.sourceArtifactId !== planGateSourceArtifactId
          ? 'The MCP operator review targets a different Architect artifact. Reload and review the current plan.'
          : operatorReview?.blockers.join(' ') || null
      if (reviewBlockReason) {
        return {
          task: null,
          approvedGates: [] as { id: string }[],
          approvalBlock: {
            error: reviewBlockReason,
            evidenceRefs: operatorReview ? [`mcp-review:${operatorReview.digest}`] : [] as string[],
            primaryDecision: null,
            primaryMode: 'blocked' as const,
            reason: reviewBlockReason,
            primaryRecoveryAction: 'revise_plan' as const,
            primaryRetryableContribution: false,
            retryable: false,
            workPackageId: null,
          },
        }
      }
      const rawPackageRows = operatorReview
        ? projectReviewedMcpPlanToPackages({
            review: operatorReview,
            overview: mcpOverview,
            packages: storedPackageRows,
          })
        : storedPackageRows

      const admissions = rawPackageRows.map((pkg) => admissionForLockedPackage({
        assignedRole: pkg.assignedRole,
        mcpOverview,
        mcpConfig: lockedProject.mcpConfig,
        mcpRequirements: pkg.mcpRequirements,
        metadata: pkg.metadata,
        title: pkg.title,
      }))
      const blockedIndex = admissions.findIndex((admission) => admission.aggregate.status === 'blocked')
      if (blockedIndex >= 0) {
        const admission = admissions[blockedIndex]
        const pkg = rawPackageRows[blockedIndex]
        const primaryDecision = admission.aggregate.primaryDecision
        const reason = primaryDecision?.reason ?? admission.aggregate.blocked[0] ?? 'MCP admission blocked this work package.'
        return {
          task: null,
          approvedGates: [] as { id: string }[],
          approvalBlock: {
            error: admission.aggregate.blockedReason ?? reason,
            evidenceRefs: primaryDecision ? [...primaryDecision.evidenceRefs] : [],
            primaryDecision: primaryDecision ? {
              ...primaryDecision,
              evidenceRefs: [...primaryDecision.evidenceRefs],
            } : null,
            primaryMode: primaryDecision?.mode ?? 'blocked',
            reason,
            primaryRecoveryAction: primaryDecision?.recoveryAction ?? 'revise_plan',
            primaryRetryableContribution: primaryDecision?.retryableContribution ?? false,
            retryable: admission.aggregate.retryable,
            workPackageId: pkg.id,
          },
        }
      }
      const consumedHealthSnapshot = approvalHealthSnapshot(admissions)

      const packageRows = rawPackageRows.map((pkg) => {
        const grant = projectFilesystemGrantCovers({
          mcpConfig: lockedProject.mcpConfig,
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

      const [approvedTask] = await tx
        .update(tasks)
        .set({ errorMessage: null, status: 'approved', updatedAt: approvedAt })
        .where(and(accessibleTaskCondition(taskId, session.userId), eq(tasks.status, 'awaiting_approval')))
        .returning()

      if (!approvedTask) {
        return { task: null, approvedGates: [] as { id: string }[], approvalBlock: null }
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
        const update = operatorReview
          ? {
              mcpRequirements: pkg.mcpRequirements,
              metadata: { ...(isRecord(pkg.metadata) ? pkg.metadata : {}), mcpGrantPhases: phases },
              updatedAt: approvedAt,
            }
          : {
              metadata: sql`jsonb_set(${workPackages.metadata}, '{mcpGrantPhases}', ${JSON.stringify(phases)}::jsonb, true)`,
              updatedAt: approvedAt,
            }
        await tx
          .update(workPackages)
          .set(update)
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
            approvalHealthSnapshot: consumedHealthSnapshot,
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

      return { task: approvedTask, approvedGates: gates, approvalBlock: null }
    })

    if (approvalBlock) {
      return NextResponse.json(approvalBlock, { status: 409 })
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
