import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { filesystemMcpGrantApprovals, projects, tasks, workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import { getProjectMcpOverview } from '@/lib/mcps/manager'
import {
  canonicalFilesystemProjectCapabilities,
  FILESYSTEM_MCP_ID,
  filesystemEffectiveGrantApprovalId,
  filesystemGrantHealthError,
  hasUnsafeFilesystemCapability,
  isFilesystemGrantBlockedPackageMetadata,
  isRecord,
  projectFilesystemEffectivePhase,
  projectFilesystemGrantCovers,
  summarizeFilesystemCapabilities,
} from '@/lib/mcps/filesystem-grants'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import { redis } from '@/lib/redis'

const grantRequestSchema = z.object({
  schemaVersion: z.literal(1),
  grants: z.array(z.object({
    workPackageId: z.string().uuid(),
    decision: z.enum(['approved', 'denied']),
    capabilities: z.array(z.string()).default([]),
    grantMode: z.enum(['allow_once', 'always_allow']).default('allow_once'),
    reason: z.string().max(4000).optional(),
  })).min(1).max(50),
})

function grantReason(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 4000) : ''
}

function existingPhases(metadata: unknown): Record<string, unknown> {
  const record = isRecord(metadata) ? metadata : {}
  return isRecord(record.mcpGrantPhases) ? record.mcpGrantPhases : {}
}

function existingArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function buildEffectivePhase(input: {
  capabilities: string[]
  decision: 'approved' | 'denied'
  decidedAt: Date
  decidedBy: string
  grantApprovalId: string
  grantMode: 'allow_once' | 'always_allow'
  reason: string
  requestedCapabilities: string[]
}): Record<string, unknown> {
  const timestamp = input.decidedAt.toISOString()
  if (input.decision === 'denied') {
    return {
      schemaVersion: 1,
      phase: 'effective',
      source: 'explicit-grant-approval',
      grantApprovalId: input.grantApprovalId,
      deniedAt: timestamp,
      deniedBy: input.decidedBy,
      grants: [],
      deniedCapabilities: input.requestedCapabilities,
      reason: input.reason,
      runtimeIssued: false,
      runtimeEnforcement: 'bounded_context_packet',
      status: 'denied',
      note: 'The operator denied filesystem context for this package. Required denied capabilities block execution until changed.',
    }
  }

  return {
    schemaVersion: 1,
    phase: 'effective',
    source: 'explicit-grant-approval',
    grantApprovalId: input.grantApprovalId,
    approvedAt: timestamp,
    approvedBy: input.decidedBy,
    grants: [{
      grantApprovalId: input.grantApprovalId,
      mcpId: FILESYSTEM_MCP_ID,
      status: 'approved',
      capabilities: input.capabilities,
      grantMode: input.grantMode,
      reason: input.reason,
    }],
    grantMode: input.grantMode,
    scope: input.grantMode === 'allow_once' ? 'next_context_issue' : 'work_package',
    runtimeIssued: false,
    runtimeEnforcement: 'bounded_context_packet',
    status: 'approved',
    note: input.grantMode === 'allow_once'
      ? 'Approved filesystem access is issued once as a bounded read-only project context packet, then the grant is consumed. Live MCP filesystem tool handles and filesystem writes are not issued.'
      : 'Approved filesystem access is issued as a bounded read-only project context packet for this work package until changed. Live MCP filesystem tool handles and filesystem writes are not issued.',
  }
}

function buildGrantPhases(input: {
  effective: Record<string, unknown>
  metadata: unknown
}): Record<string, unknown> {
  const phases = existingPhases(input.metadata)
  const metadata = isRecord(input.metadata) ? input.metadata : {}
  return {
    ...phases,
    schemaVersion: 1,
    proposed: existingArray(phases.proposed).length > 0 ? phases.proposed : existingArray(metadata.mcpGrants),
    approved: isRecord(phases.approved) ? phases.approved : undefined,
    effective: input.effective,
  }
}

const EDITABLE_TASK_STATUSES = ['awaiting_approval', 'approved', 'failed'] as const
const STANDARD_EDITABLE_PACKAGE_STATUSES = ['pending', 'ready', 'blocked', 'needs_rework'] as const
const FAILED_GRANT_RECOVERY_PACKAGE_STATUSES = ['failed', 'blocked'] as const

function canEditPackageGrant(input: {
  pkg: typeof workPackages.$inferSelect
  taskStatus: string
}): boolean {
  if (
    (input.taskStatus === 'awaiting_approval' || input.taskStatus === 'approved') &&
    STANDARD_EDITABLE_PACKAGE_STATUSES.includes(input.pkg.status as typeof STANDARD_EDITABLE_PACKAGE_STATUSES[number])
  ) {
    return true
  }
  // Failed-package recovery is only offered when the failure was caused by a
  // filesystem grant block (the handoff gate leaves an explicit marker). A
  // package that merely requested filesystem access but failed for an unrelated
  // reason (model execution, validation) must stay on the normal retry path so
  // its real failure reason is not silently discarded by a grant edit.
  return (
    input.taskStatus === 'failed' &&
    FAILED_GRANT_RECOVERY_PACKAGE_STATUSES.includes(input.pkg.status as typeof FAILED_GRANT_RECOVERY_PACKAGE_STATUSES[number]) &&
    isFilesystemGrantBlockedPackageMetadata(input.pkg.metadata)
  )
}

function packageUpdateStatus(input: {
  decision: 'approved' | 'denied'
  pkg: typeof workPackages.$inferSelect
  taskStatus: string
}): { blockedReason?: string | null; status?: string } {
  if (
    input.taskStatus !== 'failed' ||
    !FAILED_GRANT_RECOVERY_PACKAGE_STATUSES.includes(input.pkg.status as typeof FAILED_GRANT_RECOVERY_PACKAGE_STATUSES[number])
  ) {
    return {}
  }
  return input.decision === 'approved'
    ? { blockedReason: null, status: 'ready' }
    : { blockedReason: 'Filesystem grant denied by operator; execution remains blocked.', status: 'blocked' }
}

function grantMetadataUpdateSql(input: {
  clearGrantBlock: boolean
  phases: Record<string, unknown>
}) {
  const baseMetadata = input.clearGrantBlock
    ? sql`coalesce(${workPackages.metadata}, '{}'::jsonb) - 'mcpGrantBlock'`
    : workPackages.metadata
  return sql`jsonb_set(${baseMetadata}, '{mcpGrantPhases}', ${JSON.stringify(input.phases)}::jsonb, true)`
}

function grantStateForPackage(input: {
  approval?: typeof filesystemMcpGrantApprovals.$inferSelect
  pkg: typeof workPackages.$inferSelect
}) {
  const summary = summarizeFilesystemCapabilities({
    mcpRequirements: input.pkg.mcpRequirements,
    metadata: input.pkg.metadata,
  })
  const phases = existingPhases(input.pkg.metadata)
  const effective = isRecord(phases.effective) ? phases.effective : {}
  return {
    workPackageId: input.pkg.id,
    title: input.pkg.title,
    assignedRole: input.pkg.assignedRole,
    requestedCapabilities: summary.requestedCapabilities,
    planningVisibleCapabilities: summary.planningVisibleCapabilities,
    boundedRuntimeRequestedCapabilities: summary.boundedRuntimeRequestedCapabilities,
    blockingCapabilities: summary.blockingCapabilities,
    approval: input.approval
      ? {
        id: input.approval.id,
        decision: input.approval.decision,
        capabilities: input.approval.capabilities,
        reason: input.approval.reason,
        updatedAt: input.approval.updatedAt.toISOString(),
      }
      : null,
    effectiveStatus: typeof effective.status === 'string' ? effective.status : 'not_issued',
    grantMode: typeof effective.grantMode === 'string' ? effective.grantMode : null,
    grantApprovalId: filesystemEffectiveGrantApprovalId(effective),
  }
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
    if (task.submittedBy !== session.userId) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const [packages, approvals] = await Promise.all([
      db.select().from(workPackages).where(eq(workPackages.taskId, taskId)),
      db.select().from(filesystemMcpGrantApprovals).where(eq(filesystemMcpGrantApprovals.taskId, taskId)),
    ])
    const approvalsByPackage = new Map(approvals.map((approval) => [approval.workPackageId, approval]))

    return NextResponse.json({
      schemaVersion: 1,
      grants: packages
        .filter((pkg) => {
          const summary = summarizeFilesystemCapabilities({ mcpRequirements: pkg.mcpRequirements, metadata: pkg.metadata })
          return summary.requestedCapabilities.length > 0 || approvalsByPackage.has(pkg.id)
        })
        .map((pkg) => grantStateForPackage({ approval: approvalsByPackage.get(pkg.id), pkg })),
    })
  } catch (err) {
    console.error('[tasks/filesystem-grants GET] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
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
    if (task.submittedBy !== session.userId) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    if (!EDITABLE_TASK_STATUSES.includes(task.status as typeof EDITABLE_TASK_STATUSES[number])) {
      return NextResponse.json(
        { error: `Cannot edit filesystem grants while task status is '${task.status}'. Edit grants before execution starts or from a failed filesystem-grant recovery state.` },
        { status: 409 },
      )
    }

    const parsed = grantRequestSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const requestedPackageIds = [...new Set(parsed.data.grants.map((grant) => grant.workPackageId))]
    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const approvingFilesystem = parsed.data.grants.some((grant) => (
      grant.decision === 'approved' && canonicalFilesystemProjectCapabilities(grant.capabilities).length > 0
    ))
    if (approvingFilesystem) {
      const overview = await getProjectMcpOverview(project)
      const healthError = filesystemGrantHealthError(overview.statuses)
      if (healthError) {
        return NextResponse.json({ error: healthError }, { status: 409 })
      }
    }

    const packageRows = await db
      .select()
      .from(workPackages)
      .where(and(eq(workPackages.taskId, taskId), inArray(workPackages.id, requestedPackageIds)))
    if (packageRows.length !== requestedPackageIds.length) {
      return NextResponse.json({ error: 'One or more work packages do not belong to this task.' }, { status: 404 })
    }
    const lockedPackages = packageRows.filter((pkg) => !canEditPackageGrant({ pkg, taskStatus: task.status }))
    if (lockedPackages.length > 0) {
      return NextResponse.json(
        { error: `Cannot edit filesystem grants for packages already in ${lockedPackages.map((pkg) => `'${pkg.status}'`).join(', ')} status.` },
        { status: 409 },
      )
    }

    const now = new Date()
    const { states: results, recoveredTask } = await db.transaction(async (tx) => {
      // Keep the same global lock order as handoff admission. Always-allow
      // grants can update the project and sibling packages, while failed-grant
      // recovery can update the task. Lock every row this request may touch
      // before the first write so mixed grant batches cannot deadlock with a
      // concurrent project -> task -> package handoff claim.
      const [lockedProject] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, project.id))
        .for('update')
      if (!lockedProject) {
        throw Object.assign(new Error('Project not found.'), { status: 404 })
      }

      const [lockedTask] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, lockedProject.id)))
        .for('update')
      if (!lockedTask) {
        throw Object.assign(new Error('Task not found.'), { status: 404 })
      }
      if (!EDITABLE_TASK_STATUSES.includes(lockedTask.status as typeof EDITABLE_TASK_STATUSES[number])) {
        throw Object.assign(
          new Error(`Cannot edit filesystem grants while task status is '${lockedTask.status}'. Edit grants before execution starts or from a failed filesystem-grant recovery state.`),
          { status: 409 },
        )
      }

      const lockedPackageRows = await tx
        .select()
        .from(workPackages)
        .where(eq(workPackages.taskId, taskId))
        .orderBy(workPackages.id)
        .for('update')
      const lockedPackageById = new Map(lockedPackageRows.map((pkg) => [pkg.id, pkg]))
      if (requestedPackageIds.some((packageId) => !lockedPackageById.has(packageId))) {
        throw Object.assign(new Error('One or more work packages do not belong to this task.'), { status: 404 })
      }
      const noLongerEditable = requestedPackageIds
        .map((packageId) => lockedPackageById.get(packageId)!)
        .filter((pkg) => !canEditPackageGrant({ pkg, taskStatus: lockedTask.status }))
      if (noLongerEditable.length > 0) {
        throw Object.assign(
          new Error(`Cannot edit filesystem grants for packages already in ${noLongerEditable.map((pkg) => `'${pkg.status}'`).join(', ')} status.`),
          { status: 409 },
        )
      }

      const states: Array<ReturnType<typeof grantStateForPackage>> = []
      let shouldRecoverTask = false
      for (const grant of parsed.data.grants) {
        if (hasUnsafeFilesystemCapability(grant.capabilities)) {
          throw Object.assign(new Error('Only read-only project-scoped filesystem capabilities may be approved. filesystem.project.write is not supported.'), { status: 400 })
        }

        const pkg = lockedPackageById.get(grant.workPackageId)
        if (!pkg) {
          throw Object.assign(new Error('Work package not found.'), { status: 404 })
        }

        const summary = summarizeFilesystemCapabilities({
          mcpRequirements: pkg.mcpRequirements,
          metadata: pkg.metadata,
        })
        const requestedSet = new Set(summary.boundedRuntimeRequestedCapabilities)
        if (grant.decision === 'approved' && requestedSet.size === 0) {
          throw Object.assign(new Error('Cannot approve filesystem context for a package that did not request filesystem capabilities.'), { status: 400 })
        }
        const capabilities = canonicalFilesystemProjectCapabilities(grant.capabilities)
          .filter((capability) => requestedSet.has(capability))
        if (grant.decision === 'approved' && capabilities.length > 0 && !capabilities.includes('filesystem.project.read')) {
          throw Object.assign(new Error('Bounded filesystem context packets require filesystem.project.read. Approve read or deny filesystem access.'), { status: 400 })
        }
        if (grant.decision === 'approved' && capabilities.length === 0) {
          throw Object.assign(new Error('Approve at least one requested filesystem capability, or deny filesystem access.'), { status: 400 })
        }
        const missingBlockingCapabilities = summary.blockingCapabilities.filter((capability) => !capabilities.includes(capability))
        if (grant.decision === 'approved' && missingBlockingCapabilities.length > 0) {
          throw Object.assign(
            new Error(`Approved filesystem grants must include required capabilities: ${missingBlockingCapabilities.join(', ')}.`),
            { status: 400 },
          )
        }

        const reason = grantReason(grant.reason)
        const [approval] = await tx
          .insert(filesystemMcpGrantApprovals)
          .values({
            taskId,
            workPackageId: pkg.id,
            decidedBy: session.userId,
            decision: grant.decision,
            capabilities: grant.decision === 'approved' ? capabilities : [],
            reason,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: filesystemMcpGrantApprovals.workPackageId,
            set: {
              capabilities: grant.decision === 'approved' ? capabilities : [],
              decidedBy: session.userId,
              decision: grant.decision,
              reason,
              updatedAt: now,
            },
          })
          .returning()

        const effective = buildEffectivePhase({
          capabilities,
          decidedAt: now,
          decidedBy: session.userId,
          decision: grant.decision,
          grantApprovalId: approval.id,
          grantMode: grant.grantMode,
          reason,
          requestedCapabilities: summary.requestedCapabilities,
        })
        const phases = buildGrantPhases({ effective, metadata: pkg.metadata })
        if (grant.decision === 'approved' && grant.grantMode === 'always_allow') {
          const existingGrants = isRecord(lockedProject.mcpConfig.grants) ? lockedProject.mcpConfig.grants : {}
          const existingFilesystemGrant = isRecord(existingGrants.filesystem) ? existingGrants.filesystem : {}
          const mergedCapabilities = canonicalFilesystemProjectCapabilities([
            ...canonicalFilesystemProjectCapabilities(existingFilesystemGrant.capabilities),
            ...capabilities,
          ])
          const nextMcpConfig = {
            ...lockedProject.mcpConfig,
            grants: {
              ...existingGrants,
              filesystem: {
                schemaVersion: 1,
                mcpId: FILESYSTEM_MCP_ID,
                status: 'approved',
                grantMode: 'always_allow',
                capabilities: mergedCapabilities,
                grantApprovalId: approval.id,
                approvedAt: now.toISOString(),
                approvedBy: session.userId,
                reason,
              },
            },
          }
          const previousMcpConfig = lockedProject.mcpConfig
          const [updatedProject] = await tx
            .update(projects)
            .set({ mcpConfig: nextMcpConfig, updatedAt: now })
            .where(and(
              eq(projects.id, lockedProject.id),
              sql`${projects.mcpConfig} IS NOT DISTINCT FROM ${JSON.stringify(previousMcpConfig)}::jsonb`,
            ))
            .returning({ id: projects.id })
          if (!updatedProject) {
            throw Object.assign(new Error('Project filesystem configuration changed while grants were being saved. Retry the grant update.'), { status: 409 })
          }
          lockedProject.mcpConfig = nextMcpConfig

          const projectGrant = projectFilesystemGrantCovers({
            mcpConfig: nextMcpConfig,
            mcpRequirements: pkg.mcpRequirements,
            metadata: pkg.metadata,
          })
          const projectEffective = projectGrant ? projectFilesystemEffectivePhase(projectGrant) : null
          if (projectEffective) {
            for (const sibling of lockedPackageById.values()) {
              if (sibling.id === pkg.id) continue
              if (!STANDARD_EDITABLE_PACKAGE_STATUSES.includes(sibling.status as typeof STANDARD_EDITABLE_PACKAGE_STATUSES[number])) continue
              if (!projectFilesystemGrantCovers({
                mcpConfig: nextMcpConfig,
                mcpRequirements: sibling.mcpRequirements,
                metadata: sibling.metadata,
              })) {
                continue
              }
              const [updatedSibling] = await tx
                .update(workPackages)
                .set({
                  metadata: grantMetadataUpdateSql({
                    clearGrantBlock: false,
                    phases: buildGrantPhases({
                      effective: projectEffective,
                      metadata: sibling.metadata,
                    }),
                  }),
                  updatedAt: now,
                })
                .where(and(eq(workPackages.id, sibling.id), eq(workPackages.taskId, taskId)))
                .returning()
              if (updatedSibling) lockedPackageById.set(updatedSibling.id, updatedSibling)
            }
          }
        }

        const [updatedApproval] = await tx
          .update(filesystemMcpGrantApprovals)
          .set({ effectiveGrant: effective, updatedAt: now })
          .where(eq(filesystemMcpGrantApprovals.id, approval.id))
          .returning()

        const recoveryStatus = packageUpdateStatus({ decision: grant.decision, pkg, taskStatus: lockedTask.status })
        const updateableStatuses = recoveryStatus.status
          ? [...FAILED_GRANT_RECOVERY_PACKAGE_STATUSES]
          : [...STANDARD_EDITABLE_PACKAGE_STATUSES]
        const [updatedPackage] = await tx
          .update(workPackages)
          .set({
            ...recoveryStatus,
            metadata: grantMetadataUpdateSql({
              clearGrantBlock: recoveryStatus.status === 'ready',
              phases,
            }),
            updatedAt: now,
          })
          .where(and(
            eq(workPackages.id, pkg.id),
            eq(workPackages.taskId, taskId),
            inArray(workPackages.status, updateableStatuses),
          ))
          .returning()
        if (!updatedPackage) {
          throw Object.assign(new Error(`Cannot edit filesystem grants for package '${pkg.title}' because execution has already started or the package is no longer editable.`), { status: 409 })
        }
        lockedPackageById.set(updatedPackage.id, updatedPackage)

        if (recoveryStatus.status === 'ready') {
          shouldRecoverTask = true
        }
        states.push(grantStateForPackage({ approval: updatedApproval, pkg: updatedPackage }))
      }
      let recoveredTask: typeof tasks.$inferSelect | null = null
      if (lockedTask.status === 'failed' && shouldRecoverTask) {
        const remainingBlockedPackages = await tx
          .select({ metadata: workPackages.metadata, status: workPackages.status })
          .from(workPackages)
          .where(and(eq(workPackages.taskId, taskId), inArray(workPackages.status, ['failed', 'blocked'])))
        if (remainingBlockedPackages.some((pkg) => (
          pkg.status === 'failed' || isFilesystemGrantBlockedPackageMetadata(pkg.metadata)
        ))) {
          return { states, recoveredTask }
        }
        const [updatedTask] = await tx
          .update(tasks)
          .set({ errorMessage: null, status: 'approved', updatedAt: now })
          .where(and(eq(tasks.id, taskId), eq(tasks.status, 'failed')))
          .returning()
        recoveredTask = updatedTask ?? null
      }
      return { states, recoveredTask }
    })

    await Promise.all(results.map((state) => recordTaskLogBestEffort({
      eventType: state.approval?.decision === 'approved'
        ? 'mcp.filesystem.grant_approved'
        : 'mcp.filesystem.grant_denied',
      level: state.approval?.decision === 'approved' ? 'info' : 'warning',
      message: state.approval?.decision === 'approved'
        ? `Approved bounded read-only filesystem context for "${state.title}".`
        : `Denied filesystem context for "${state.title}". Required denied access will block execution.`,
      metadata: {
        capabilities: state.approval?.capabilities ?? [],
        grantApprovalId: state.approval?.id ?? null,
        workPackageId: state.workPackageId,
      },
      source: 'mcp',
      taskId,
      title: state.approval?.decision === 'approved' ? 'Filesystem grant approved' : 'Filesystem grant denied',
      workPackageId: state.workPackageId,
    })))

    // Recovering a failed task flips it back to 'approved', but — unlike the plan
    // approve and retry-handoff routes — nothing else re-drives it. Enqueue an
    // approval job and publish the status change so the worker picks the task up
    // again; otherwise the recovered task sits idle until a manual handoff retry.
    if (recoveredTask) {
      const queueFailureMessage = 'Filesystem grants were updated and the task is approved, but Forge could not enqueue the recovery job. Retry handoff once Redis is healthy.'
      try {
        await redis.lpush('forge:approvals', JSON.stringify({ taskId, action: 'approve' }))
      } catch (err) {
        console.error('[tasks/filesystem-grants PUT] Failed to enqueue approval worker job', err)
        return NextResponse.json({
          error: queueFailureMessage,
          grants: results,
          taskStatus: 'approved',
        }, { status: 202 })
      }
      try {
        await redis.publish('forge:task:' + taskId, JSON.stringify({
          type: 'task:status',
          status: 'approved',
          updatedAt: recoveredTask.updatedAt.toISOString(),
        }))
      } catch (err) {
        console.error('[tasks/filesystem-grants PUT] Failed to publish recovery status event', err)
      }
    }

    return NextResponse.json({ schemaVersion: 1, grants: results })
  } catch (err) {
    const status = isRecord(err) && typeof err.status === 'number' ? err.status : 500
    if (status === 500) {
      console.error('[tasks/filesystem-grants PUT] Unexpected error', err)
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status },
    )
  }
}
