import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { workPackages } from '@/db/schema'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import {
  parsePacketIssuanceRecoveryRequest,
} from '@/lib/mcps/recovery-actions-v2'
import {
  applyPacketIssuanceRecoveryActionV2,
  S4LifecycleError,
} from '@/lib/mcps/s4-lease'
import {
  convergeRecognizedOperatorHoldTask,
  loadCurrentProjectFilesystemDecision,
} from '@/lib/mcps/filesystem-grant-reconciliation'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import { enqueueBlockedHandoffRetry } from '@/worker/blocked-handoff-retry'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; packageId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock

    const { id: taskId, packageId } = await params
    const [task, ownedPackage] = await Promise.all([
      getAccessibleTask(taskId, session.userId),
      db.select({ id: workPackages.id }).from(workPackages).where(and(
        eq(workPackages.id, packageId),
        eq(workPackages.taskId, taskId),
      )).limit(1),
    ])
    if (!task || !ownedPackage[0]) {
      return NextResponse.json({ error: 'Recovery target not found' }, { status: 404 })
    }

    const body = parsePacketIssuanceRecoveryRequest(await request.json().catch(() => null))
    if (!body) {
      return NextResponse.json({ error: 'Invalid packet-issuance recovery payload.' }, { status: 400 })
    }
    if (task.status !== 'approved' || task.localProjectionScopeState !== 'active') {
      return NextResponse.json({ error: 'Recovery state changed. Reload and retry.' }, { status: 409 })
    }
    const authorizingDecision = body.action === 'retry_execution'
      ? await loadCurrentProjectFilesystemDecision(task.projectId)
      : null
    if (body.action === 'retry_execution' && authorizingDecision?.decision !== 'approved') {
      return NextResponse.json({ error: 'Recovery state changed. Reload and retry.' }, { status: 409 })
    }

    const result = await applyPacketIssuanceRecoveryActionV2({
      taskId,
      workPackageId: packageId,
      priorRuntimeAuditId: body.priorRuntimeAuditId,
      action: body.action,
      expectedMarkerFingerprint: body.markerFingerprint,
      actorUserId: session.userId,
      authorizingDecisionId: authorizingDecision?.decisionId ?? null,
    })

    let continuationStatus: 'not_required' | 'enqueued' | 'already_queued' | 'pending' = 'not_required'
    try {
      await convergeRecognizedOperatorHoldTask(taskId)
      if (result.packageStatus === 'ready') {
        const retry = await enqueueBlockedHandoffRetry(taskId, { source: 'packet-issuance-recovery' })
        continuationStatus = retry.status
      }
    } catch (error) {
      continuationStatus = 'pending'
      console.error('[POST packet-issuance-recovery] Recovery committed but continuation is pending', error)
    }

    return NextResponse.json({ result: { ...result, continuationStatus } }, {
      status: continuationStatus === 'pending' ? 202 : 200,
    })
  } catch (error) {
    if (error instanceof S4LifecycleError) {
      return NextResponse.json(
        { error: error.code === 'configuration' ? 'Protected recovery is unavailable.' : 'Recovery state changed. Reload and retry.' },
        { status: error.code === 'configuration' ? 503 : 409 },
      )
    }
    console.error('[POST packet-issuance-recovery] Unexpected error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
