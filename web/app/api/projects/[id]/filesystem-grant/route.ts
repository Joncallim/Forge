import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { projects, tasks, workPackages, type ProjectMcpConfig } from '@/db/schema'
import { getSession } from '@/lib/session'
import { accessibleProjectCondition } from '@/lib/project-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { getProjectMcpOverview } from '@/lib/mcps/manager'
import { redis } from '@/lib/redis'
import {
  canonicalFilesystemProjectCapabilities,
  FILESYSTEM_MCP_ID,
  filesystemGrantHealthError,
  isFilesystemGrantBlockedPackageMetadata,
  isRecord,
  projectFilesystemGrantCovers,
  projectFilesystemEffectivePhase,
  projectFilesystemGrantFromConfig,
} from '@/lib/mcps/filesystem-grants'

// ---------------------------------------------------------------------------
// Project-level filesystem access grant.
//
// This is the "set it once for the whole project" counterpart to the per-work-
// package approval in /api/tasks/:id/filesystem-grants. Turning it on stores an
// `always_allow` grant on the project's mcpConfig so every ready package that
// needs read-only project filesystem context is covered without a per-package
// approval. It only issues a bounded, read-only context packet — never live
// filesystem tool handles or writes — mirroring the per-task grant.
// ---------------------------------------------------------------------------

const ALL_READ_ONLY_CAPABILITIES = [
  'filesystem.project.read',
  'filesystem.project.list',
  'filesystem.project.search',
]

const putSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().max(4000).optional(),
})

async function findProject(id: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(accessibleProjectCondition(id, userId))
    .limit(1)
  return project ?? null
}

function grantSummary(mcpConfig: ProjectMcpConfig) {
  const grant = projectFilesystemGrantFromConfig(mcpConfig)
  return grant
    ? {
      enabled: true,
      capabilities: grant.capabilities,
      approvedAt: grant.approvedAt,
      approvedBy: grant.approvedBy,
      reason: grant.reason,
    }
    : { enabled: false, capabilities: [] as string[], approvedAt: null, approvedBy: null, reason: '' }
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

    const { id } = await params
    const project = await findProject(id, session.userId)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const overview = await getProjectMcpOverview(project)
    return NextResponse.json({
      grant: grantSummary(project.mcpConfig),
      healthError: filesystemGrantHealthError(overview.statuses),
    })
  } catch (err) {
    console.error('[GET /api/projects/:id/filesystem-grant] Unexpected error', err)
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

    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock

    const { id } = await params
    const project = await findProject(id, session.userId)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const parsed = putSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const overview = await getProjectMcpOverview(project)
    const healthError = filesystemGrantHealthError(overview.statuses)

    // Approving requires a healthy filesystem MCP; revoking never does.
    if (parsed.data.enabled && healthError) {
      return NextResponse.json({ error: healthError }, { status: 409 })
    }

    const existingGrants = isRecord(project.mcpConfig.grants) ? project.mcpConfig.grants : {}
    const now = new Date()

    // Revoking is a config write. Runtime gates re-check the current project
    // grant before issuing filesystem context, so already-materialized packages
    // cannot keep using stale project approval after this is removed.
    if (!parsed.data.enabled) {
      const nextGrants = Object.fromEntries(
        Object.entries(existingGrants).filter(([key]) => key !== 'filesystem'),
      )
      const nextConfig: ProjectMcpConfig = { ...project.mcpConfig, grants: nextGrants }
      await db.update(projects).set({ mcpConfig: nextConfig, updatedAt: now }).where(eq(projects.id, project.id))
      return NextResponse.json({ grant: grantSummary(nextConfig), healthError })
    }

    const nextConfig: ProjectMcpConfig = {
      ...project.mcpConfig,
      grants: {
        ...existingGrants,
        filesystem: {
          schemaVersion: 1,
          mcpId: FILESYSTEM_MCP_ID,
          status: 'approved',
          grantMode: 'always_allow',
          capabilities: canonicalFilesystemProjectCapabilities(ALL_READ_ONLY_CAPABILITIES),
          grantApprovalId: randomUUID(),
          approvedAt: now.toISOString(),
          approvedBy: session.userId,
          reason: parsed.data.reason?.trim() ?? '',
        },
      },
    }

    // Persist the grant AND reconcile packages that already blocked on a filesystem
    // grant. Without this, enabling the project grant would only affect future
    // evaluations: an awaiting-approval task would still show its Approve button
    // disabled (the UI reads package metadata, not the project config), and a
    // handoff that already failed on the grant would re-block. This mirrors the
    // sibling propagation the per-task grant route performs, extended across every
    // task in the project.
    const RECONCILABLE_PACKAGE_STATUSES = new Set(['pending', 'ready', 'blocked', 'needs_rework', 'failed'])
    const reconcilablePackageStatuses = [...RECONCILABLE_PACKAGE_STATUSES]
    const recoveredTaskIds = await db.transaction(async (tx) => {
      await tx.update(projects).set({ mcpConfig: nextConfig, updatedAt: now }).where(eq(projects.id, project.id))

      const grant = projectFilesystemGrantFromConfig(nextConfig)
      if (!grant) return [] as string[]
      const effectivePhase = projectFilesystemEffectivePhase(grant)

      const projectTasks = await tx
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.projectId, project.id))
      if (projectTasks.length === 0) return [] as string[]

      const packageRows = await tx
        .select()
        .from(workPackages)
        .where(inArray(workPackages.taskId, projectTasks.map((task) => task.id)))

      const clearedTaskIds = new Set<string>()
      for (const pkg of packageRows) {
        if (!RECONCILABLE_PACKAGE_STATUSES.has(pkg.status)) continue
        const covered = projectFilesystemGrantCovers({
          mcpConfig: nextConfig,
          mcpRequirements: pkg.mcpRequirements,
          metadata: pkg.metadata,
        })
        if (!covered) continue

        const phases = isRecord(pkg.metadata.mcpGrantPhases) ? pkg.metadata.mcpGrantPhases : {}
        const wasGrantBlocked = isFilesystemGrantBlockedPackageMetadata(pkg.metadata)
        const nextMetadata: Record<string, unknown> = {
          ...pkg.metadata,
          mcpGrantPhases: { ...phases, schemaVersion: 1, effective: effectivePhase },
        }
        if (wasGrantBlocked) delete nextMetadata.mcpGrantBlock

        const nextStatus = wasGrantBlocked && (pkg.status === 'failed' || pkg.status === 'blocked')
          ? 'ready'
          : pkg.status

        const [updatedPackage] = await tx
          .update(workPackages)
          .set({
            metadata: nextMetadata,
            status: nextStatus,
            blockedReason: wasGrantBlocked ? null : pkg.blockedReason,
            updatedAt: now,
          })
          .where(and(
            eq(workPackages.id, pkg.id),
            eq(workPackages.taskId, pkg.taskId),
            inArray(workPackages.status, reconcilablePackageStatuses),
          ))
          .returning({ id: workPackages.id })

        if (updatedPackage && wasGrantBlocked) clearedTaskIds.add(pkg.taskId)
      }

      // Recover tasks that had failed solely because of a filesystem grant block.
      const recovered: string[] = []
      for (const task of projectTasks) {
        if (task.status !== 'failed' || !clearedTaskIds.has(task.id)) continue
        const remaining = await tx
          .select({ status: workPackages.status, metadata: workPackages.metadata })
          .from(workPackages)
          .where(eq(workPackages.taskId, task.id))
        if (remaining.some((pkg) => pkg.status === 'failed' || isFilesystemGrantBlockedPackageMetadata(pkg.metadata))) {
          continue
        }
        const [updated] = await tx
          .update(tasks)
          .set({ status: 'approved', errorMessage: null, updatedAt: now })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, 'failed')))
          .returning({ id: tasks.id })
        if (updated) recovered.push(updated.id)
      }
      return recovered
    })

    // Re-drive recovered tasks so the worker continues them (after the commit).
    const queueFailureTaskIds: string[] = []
    for (const taskId of recoveredTaskIds) {
      try {
        await redis.lpush('forge:approvals', JSON.stringify({ taskId, action: 'approve' }))
      } catch (err) {
        console.error('[PUT /api/projects/:id/filesystem-grant] Failed to enqueue recovered task', err)
        queueFailureTaskIds.push(taskId)
        continue
      }

      try {
        await redis.publish('forge:task:' + taskId, JSON.stringify({
          type: 'task:status',
          status: 'approved',
          updatedAt: now.toISOString(),
        }))
      } catch (err) {
        console.error('[PUT /api/projects/:id/filesystem-grant] Failed to publish recovered task status', err)
      }
    }

    if (queueFailureTaskIds.length > 0) {
      return NextResponse.json({
        error: 'Project filesystem grant was saved and matching tasks were recovered, but Forge could not enqueue every recovery job. Retry handoff once Redis is healthy.',
        failedTaskIds: queueFailureTaskIds,
        grant: grantSummary(nextConfig),
        healthError,
        recoveredTaskIds,
      }, { status: 202 })
    }

    return NextResponse.json({ grant: grantSummary(nextConfig), healthError })
  } catch (err) {
    console.error('[PUT /api/projects/:id/filesystem-grant] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
