import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/db'
import { workPackages } from '@/db/schema'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import {
  parseLocalEffectRecoveryRequest,
} from '@/lib/mcps/recovery-actions-v2'
import {
  applyLocalEffectRecoveryActionV2,
  S4LifecycleError,
} from '@/lib/mcps/s4-lease'
import { convergeRecognizedOperatorHoldTask } from '@/lib/mcps/filesystem-grant-reconciliation'
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

    const body = parseLocalEffectRecoveryRequest(await request.json().catch(() => null))
    if (!body) {
      return NextResponse.json({ error: 'Invalid local-effect recovery payload.' }, { status: 400 })
    }
    if (task.status !== 'approved' || task.localProjectionScopeState !== 'active') {
      return NextResponse.json({ error: 'Recovery state changed. Reload and retry.' }, { status: 409 })
    }

    const result = await applyLocalEffectRecoveryActionV2({
      taskId,
      workPackageId: packageId,
      localRunEvidenceId: body.localRunEvidenceId,
      action: body.action,
      expectedMarkerFingerprint: body.evidenceFingerprint,
      actorUserId: session.userId,
    })

    let continuationStatus: 'not_required' | 'enqueued' | 'already_queued' | 'pending' = 'not_required'
    try {
      await convergeRecognizedOperatorHoldTask(taskId)
      if (result.packageStatus === 'ready') {
        const retry = await enqueueBlockedHandoffRetry(taskId, { source: 'local-effect-recovery' })
        continuationStatus = retry.status
      }
    } catch (error) {
      continuationStatus = 'pending'
      console.error('[POST local-effect-recovery] Recovery committed but continuation is pending', error)
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
    console.error('[POST local-effect-recovery] Unexpected error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
