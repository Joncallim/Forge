import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  filesystemMcpCurrentDecisionPointers,
  filesystemMcpGrantApprovals,
  projects,
  workPackages,
} from '@/db/schema'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { getProjectMcpOverview } from '@/lib/mcps/manager'
import {
  filesystemGrantHealthError,
  hasUnsafeFilesystemCapability,
  summarizeFilesystemCapabilities,
} from '@/lib/mcps/filesystem-grants'
import { respondToRouteError } from '@/lib/http/route-error'
import {
  mutateTaskFilesystemGrants,
  type FilesystemGrantMutation,
} from '@/lib/mcps/filesystem-grant-reconciliation'
import { recordTaskLogBestEffort } from '@/worker/task-logs'
import { redis } from '@/lib/redis'

const grantRequestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  grants: z.array(z.object({
    workPackageId: z.string().uuid(),
    decision: z.enum(['approved', 'denied']),
    capabilities: z.array(z.string()).max(20).default([]),
    grantMode: z.enum(['allow_once', 'always_allow']).default('allow_once'),
    reason: z.string().max(4000).optional(),
    expectedPointer: z.object({
      currentDecisionId: z.string().uuid().nullable(),
      currentDecisionRevision: z.string().regex(/^[1-9][0-9]*$/).nullable(),
      pointerFingerprint: z.string().min(1).max(200),
      pointerVersion: z.string().regex(/^(0|[1-9][0-9]*)$/),
    }).optional(),
  })).min(1).max(50),
})

async function readGrantStates(taskId: string) {
  const packages = await db.select().from(workPackages)
    .where(eq(workPackages.taskId, taskId))
    .orderBy(asc(workPackages.id))
  if (packages.length === 0) return []
  const [history, pointers] = await Promise.all([
    db.select().from(filesystemMcpGrantApprovals)
      .where(and(
        eq(filesystemMcpGrantApprovals.taskId, taskId),
        eq(filesystemMcpGrantApprovals.decisionScope, 'package'),
      ))
      .orderBy(asc(filesystemMcpGrantApprovals.createdAt), asc(filesystemMcpGrantApprovals.id)),
    db.select().from(filesystemMcpCurrentDecisionPointers)
      .where(inArray(filesystemMcpCurrentDecisionPointers.workPackageId, packages.map((pkg) => pkg.id))),
  ])
  const pointerByPackage = new Map(pointers.map((pointer) => [pointer.workPackageId, pointer]))
  const decisionById = new Map(history.map((decision) => [decision.id, decision]))
  return packages.map((pkg) => {
    const summary = summarizeFilesystemCapabilities({
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
    })
    const pointer = pointerByPackage.get(pkg.id)
    const current = pointer?.currentDecisionId ? decisionById.get(pointer.currentDecisionId) ?? null : null
    return {
      workPackageId: pkg.id,
      title: pkg.title,
      assignedRole: pkg.assignedRole,
      requestedCapabilities: summary.requestedCapabilities,
      planningVisibleCapabilities: summary.planningVisibleCapabilities,
      boundedRuntimeRequestedCapabilities: summary.boundedRuntimeRequestedCapabilities,
      blockingCapabilities: summary.blockingCapabilities,
      currentDecision: current ? {
        id: current.id,
        decision: current.decision,
        capabilities: current.capabilities,
        reason: current.reason,
        grantDecisionRevision: current.grantDecisionRevision?.toString() ?? null,
        rootBindingRevision: current.rootBindingRevision?.toString() ?? null,
        decidedAt: current.createdAt.toISOString(),
      } : null,
      decisionHistory: history
        .filter((decision) => decision.workPackageId === pkg.id)
        .map((decision) => ({
          id: decision.id,
          decision: decision.decision,
          capabilities: decision.capabilities,
          reason: decision.reason,
          grantDecisionRevision: decision.grantDecisionRevision?.toString() ?? null,
          rootBindingRevision: decision.rootBindingRevision?.toString() ?? null,
          decidedAt: decision.createdAt.toISOString(),
        })),
      pointerVersion: pointer?.pointerVersion.toString() ?? '0',
      pointerFingerprint: pointer?.pointerFingerprint ?? null,
    }
  }).filter((state) => state.requestedCapabilities.length > 0 || state.decisionHistory.length > 0)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id: taskId } = await params
    const task = await getAccessibleTask(taskId, session.userId)
    if (!task || task.submittedBy !== session.userId) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    return NextResponse.json({ schemaVersion: 2, grants: await readGrantStates(taskId) })
  } catch (err) {
    return respondToRouteError('GET /api/tasks/:id/filesystem-grants', err)
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock
    const { id: taskId } = await params
    const task = await getAccessibleTask(taskId, session.userId)
    if (!task || task.submittedBy !== session.userId) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    const parsed = grantRequestSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
    }
    if (parsed.data.grants.some((grant) => hasUnsafeFilesystemCapability(grant.capabilities))) {
      return NextResponse.json({ error: 'Only read-only project-scoped filesystem capabilities may be approved.' }, { status: 400 })
    }
    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1)
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Health is observation only and intentionally stays outside the database
    // mutation. The locked service never performs network or Redis work.
    if (parsed.data.grants.some((grant) => grant.decision === 'approved')) {
      const overview = await getProjectMcpOverview(project)
      const healthError = filesystemGrantHealthError(overview.statuses)
      if (healthError) return NextResponse.json({ error: healthError }, { status: 409 })
    }

    const result = await mutateTaskFilesystemGrants({
      actorId: session.userId,
      projectId: project.id,
      taskId,
      mutations: parsed.data.grants.map((grant): FilesystemGrantMutation => ({
        ...grant,
        reason: grant.reason?.trim() ?? '',
      })),
    })

    await Promise.all(result.approvals.map((approval) => recordTaskLogBestEffort({
      eventType: approval.decision === 'approved'
        ? 'mcp.filesystem.grant_approved'
        : 'mcp.filesystem.grant_denied',
      level: approval.decision === 'approved' ? 'info' : 'warning',
      message: approval.decision === 'approved'
        ? 'Approved bounded read-only filesystem context.'
        : 'Denied filesystem context; required access remains on operator hold.',
      metadata: {
        capabilities: approval.capabilities,
        grantApprovalId: approval.id,
        grantDecisionRevision: approval.grantDecisionRevision?.toString() ?? null,
        workPackageId: approval.workPackageId,
      },
      source: 'mcp',
      taskId,
      title: approval.decision === 'approved' ? 'Filesystem grant approved' : 'Filesystem grant denied',
      workPackageId: approval.workPackageId ?? undefined,
    })))

    const queueFailures: string[] = []
    for (const recoveredTaskId of result.recoveredTaskIds) {
      try {
        await redis.lpush('forge:approvals', JSON.stringify({ taskId: recoveredTaskId, action: 'approve' }))
      } catch (err) {
        console.error('[tasks/filesystem-grants PUT] Failed to enqueue recovery', err)
        queueFailures.push(recoveredTaskId)
      }
    }
    const response = { schemaVersion: 2, grants: await readGrantStates(taskId), recoveredTaskIds: result.recoveredTaskIds }
    return queueFailures.length > 0
      ? NextResponse.json({ ...response, error: 'The decision was saved, but some recovery wake-ups failed.', failedTaskIds: queueFailures }, { status: 202 })
      : NextResponse.json(response)
  } catch (err) {
    return respondToRouteError('PUT /api/tasks/:id/filesystem-grants', err)
  }
}
