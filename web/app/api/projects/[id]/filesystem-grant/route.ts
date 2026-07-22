import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { getSession } from '@/lib/session'
import { accessibleProjectCondition } from '@/lib/project-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { getProjectMcpOverview } from '@/lib/mcps/manager'
import { redis } from '@/lib/redis'
import {
  filesystemGrantHealthError,
  projectFilesystemGrantFromAuthority,
} from '@/lib/mcps/filesystem-grants'
import { respondToRouteError } from '@/lib/http/route-error'
import { logged500Error } from '@/lib/logged-500'
import {
  loadCurrentProjectFilesystemDecision,
  mutateProjectFilesystemGrant,
} from '@/lib/mcps/filesystem-grant-reconciliation'

const ALL_READ_ONLY_CAPABILITIES = [
  'filesystem.project.read',
  'filesystem.project.list',
  'filesystem.project.search',
] as const

const putSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().max(4000).optional(),
})

async function findProject(id: string, userId: string) {
  const [project] = await db.select().from(projects)
    .where(accessibleProjectCondition(id, userId)).limit(1)
  return project ?? null
}

function grantSummary(authority: unknown) {
  const grant = projectFilesystemGrantFromAuthority(authority)
  return grant ? {
    enabled: true,
    capabilities: grant.capabilities,
    approvedAt: grant.approvedAt,
    approvedBy: grant.approvedBy,
    reason: grant.reason,
    grantApprovalId: grant.grantApprovalId,
    grantDecisionRevision: grant.grantDecisionRevision,
    rootBindingRevision: grant.rootBindingRevision,
  } : {
    enabled: false,
    capabilities: [] as string[],
    approvedAt: null,
    approvedBy: null,
    reason: '',
    grantApprovalId: null,
    grantDecisionRevision: null,
    rootBindingRevision: null,
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    const project = await findProject(id, session.userId)
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    const authority = await loadCurrentProjectFilesystemDecision(project.id)
    const overview = await getProjectMcpOverview(
      project,
      authority,
      { cache: false, ensureWorkspace: false },
    )
    return NextResponse.json({
      schemaVersion: 2,
      grant: grantSummary(authority),
      healthError: filesystemGrantHealthError(overview.statuses),
    })
  } catch (err) {
    return respondToRouteError('GET /api/projects/:id/filesystem-grant', err)
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock
    const { id } = await params
    const project = await findProject(id, session.userId)
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    const parsed = putSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
    }

    let healthError: string | null = null
    if (parsed.data.enabled) {
      const overview = await getProjectMcpOverview(project)
      healthError = filesystemGrantHealthError(overview.statuses)
      if (healthError) return NextResponse.json({ error: healthError }, { status: 409 })
    }
    const result = await mutateProjectFilesystemGrant({
      actorId: session.userId,
      capabilities: ALL_READ_ONLY_CAPABILITIES,
      enabled: parsed.data.enabled,
      projectId: project.id,
      reason: parsed.data.reason?.trim() ?? '',
    })

    const queueFailures: string[] = []
    for (const taskId of result.recoveredTaskIds) {
      try {
        await redis.lpush('forge:approvals', JSON.stringify({ taskId, action: 'approve' }))
      } catch (err) {
        logged500Error('PUT /api/projects/:id/filesystem-grant', err)
        queueFailures.push(taskId)
      }
    }
    const response = {
      schemaVersion: 2,
      grant: grantSummary(result.authority),
      healthError,
      recoveredTaskIds: result.recoveredTaskIds,
    }
    return queueFailures.length > 0
      ? NextResponse.json({ ...response, error: 'The project decision was saved, but some recovery wake-ups failed.', failedTaskIds: queueFailures }, { status: 202 })
      : NextResponse.json(response)
  } catch (err) {
    return respondToRouteError('PUT /api/projects/:id/filesystem-grant', err)
  }
}
