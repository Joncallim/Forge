import 'server-only'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { filesystemMcpGrantApprovals, filesystemMcpCurrentDecisionPointers, workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import { computeFreshnessFingerprint } from '@/lib/mcps/s5-server-reader'

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
      db.select({
        id: filesystemMcpGrantApprovals.id,
        taskId: filesystemMcpGrantApprovals.taskId,
        workPackageId: filesystemMcpGrantApprovals.workPackageId,
        decision: filesystemMcpGrantApprovals.decision,
        decisionScope: filesystemMcpGrantApprovals.decisionScope,
        capabilities: filesystemMcpGrantApprovals.capabilities,
        reason: filesystemMcpGrantApprovals.reason,
        grantDecisionRevision: filesystemMcpGrantApprovals.grantDecisionRevision,
        rootBindingRevision: filesystemMcpGrantApprovals.rootBindingRevision,
        pointerFingerprint: filesystemMcpGrantApprovals.pointerFingerprint,
        createdAt: filesystemMcpGrantApprovals.createdAt,
      }).from(filesystemMcpGrantApprovals).where(eq(filesystemMcpGrantApprovals.taskId, taskId)).orderBy(asc(filesystemMcpGrantApprovals.createdAt)),
      db.select().from(filesystemMcpCurrentDecisionPointers).where(eq(filesystemMcpCurrentDecisionPointers.taskId, taskId)),
    ])
    const pointerByPackage = new Map(pointers.map((p) => [p.workPackageId, p]))
    const decisionsByPackage = new Map<string, (typeof decisions)[0][]>()
    for (const d of decisions) { if (!d.workPackageId) continue; const list = decisionsByPackage.get(d.workPackageId) ?? []; list.push(d); decisionsByPackage.set(d.workPackageId, list) }
    const grants = packages.map((pkg) => {
      const pointer = pointerByPackage.get(pkg.id)
      const history = decisionsByPackage.get(pkg.id) ?? []
      return {
        workPackageId: pkg.id, title: pkg.title,
        currentDecision: pointer?.currentDecisionId ? history.find((d) => d.id === pointer.currentDecisionId) ?? null : null,
        decisionHistory: history.map((d) => ({ id: d.id, decision: d.decision, capabilities: d.capabilities, grantDecisionRevision: d.grantDecisionRevision?.toString() ?? null, rootBindingRevision: d.rootBindingRevision?.toString() ?? null, decidedAt: d.createdAt?.toISOString() ?? '' })),
        pointerFingerprint: pointer?.pointerFingerprint ?? null,
        pointerVersion: pointer?.pointerVersion?.toString() ?? '0',
      }
    })
    return NextResponse.json({ computedAt: new Date().toISOString(), freshnessFingerprint: computeFreshnessFingerprint({ taskId, grantIds: decisions.map((d) => d.id) }), taskId, grants })
  } catch (err) {
    console.error('[mcps/grant-state GET] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
