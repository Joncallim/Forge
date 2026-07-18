import 'server-only'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db'
import { filesystemMcpGrantApprovals, filesystemMcpCurrentDecisionPointers, projects, workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import { computeFreshnessFingerprint } from '@/lib/mcps/s5-server-reader'
import { hasUnsafeFilesystemCapability } from '@/lib/mcps/filesystem-grants'
import { mutateTaskFilesystemGrants } from '@/lib/mcps/filesystem-grant-reconciliation'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'

const putSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  grants: z.array(z.object({
    workPackageId: z.string().uuid(),
    decision: z.enum(['approved', 'denied']),
    capabilities: z.array(z.string()).max(20),
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { taskId } = await params
    const task = await getAccessibleTask(taskId, session.userId)
    if (!task || task.submittedBy !== session.userId) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    const [packages, decisions, pointers] = await Promise.all([
      db.select({ id: workPackages.id, title: workPackages.title }).from(workPackages).where(eq(workPackages.taskId, taskId)).orderBy(asc(workPackages.sequence)),
      db.select().from(filesystemMcpGrantApprovals).where(eq(filesystemMcpGrantApprovals.taskId, taskId)).orderBy(asc(filesystemMcpGrantApprovals.createdAt)),
      db.select().from(filesystemMcpCurrentDecisionPointers).where(eq(filesystemMcpCurrentDecisionPointers.taskId, taskId)),
    ])
    const pointerByPackage = new Map(pointers.map((p) => [p.workPackageId, p]))
    const decisionsByPackage = new Map<string, (typeof decisions)[0][]>()
    for (const d of decisions) { if (!d.workPackageId) continue; const list = decisionsByPackage.get(d.workPackageId) ?? []; list.push(d); decisionsByPackage.set(d.workPackageId, list) }
    const grants = packages.map((pkg) => {
      const pointer = pointerByPackage.get(pkg.id)
      const history = decisionsByPackage.get(pkg.id) ?? []
      return { workPackageId: pkg.id, title: pkg.title, currentDecision: pointer?.currentDecisionId ? history.find((d) => d.id === pointer.currentDecisionId) ?? null : null, decisionHistory: history.map((d) => ({ id: d.id, decision: d.decision, capabilities: d.capabilities, grantDecisionRevision: d.grantDecisionRevision?.toString() ?? null, rootBindingRevision: d.rootBindingRevision?.toString() ?? null, decidedAt: d.createdAt.toISOString() })), pointerFingerprint: pointer?.pointerFingerprint ?? null, pointerVersion: pointer?.pointerVersion?.toString() ?? '0' }
    })
    return NextResponse.json({ computedAt: new Date().toISOString(), freshnessFingerprint: computeFreshnessFingerprint({ taskId, grantIds: decisions.map((d) => d.id) }), taskId, grants })
  } catch (err) {
    console.error('[mcps/grant-state GET] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock
    const { taskId } = await params
    const task = await getAccessibleTask(taskId, session.userId)
    if (!task || task.submittedBy !== session.userId) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    const parsed = putSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
    if (parsed.data.grants.some((g) => hasUnsafeFilesystemCapability(g.capabilities))) {
      return NextResponse.json({ error: 'Only read-only project-scoped filesystem capabilities may be approved.' }, { status: 400 })
    }
    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1)
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    const result = await mutateTaskFilesystemGrants({ actorId: session.userId, projectId: project.id, taskId, mutations: parsed.data.grants.map((g) => ({ workPackageId: g.workPackageId, decision: g.decision, capabilities: g.capabilities, grantMode: g.grantMode, reason: g.reason ?? '', expectedPointer: g.expectedPointer })) })
    return NextResponse.json({ computedAt: new Date().toISOString(), freshnessFingerprint: computeFreshnessFingerprint({ taskId, approvals: result.approvals.map((a) => a.id) }), approvals: result.approvals, recoveredTaskIds: result.recoveredTaskIds })
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err ? Number((err as { status?: unknown }).status) : 500
    if (status === 500) console.error('[mcps/grant-state PUT] Unexpected error', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status })
  }
}
