import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/session'
import { getAccessibleTask } from '@/lib/task-access'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import { getProjectMcpOverview } from '@/lib/mcps/manager'
import { filesystemGrantHealthError } from '@/lib/mcps/filesystem-grants'
import {
  convergeRecognizedOperatorHoldTask,
  loadCurrentProjectFilesystemDecision,
  mutateProjectFilesystemGrant,
} from '@/lib/mcps/filesystem-grant-reconciliation'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { accessibleProjectCondition } from '@/lib/project-access'
import {
  readS5AuthoritativeTaskState,
  S5TaskNotFoundError,
  type S5AuthoritativeTaskState,
} from '@/lib/mcps/s5-server-reader'
import {
  applyLocalEffectRecoveryActionV2,
  applyPacketIssuanceRecoveryActionV2,
  S4LifecycleError,
  type S4OperatorRecoveryResult,
} from '@/lib/mcps/s4-lease'
import {
  isLocalEffectActionRequest,
  isPacketActionRequest,
  parseS5OperatorActionRequest,
  type S5OperatorActionRequest,
} from '@/lib/mcps/s5-operator-actions'
import { enqueueBlockedHandoffRetry } from '@/worker/blocked-handoff-retry'

const ALL_READ_ONLY_CAPABILITIES = [
  'filesystem.project.read',
  'filesystem.project.list',
  'filesystem.project.search',
] as const

type Refusal = { status: 400 | 401 | 403 | 404 | 409 | 503; code: string; error: string }
type AuthorizedTarget =
  | { kind: 'local_effect'; workPackageId: string }
  | { kind: 'packet_issuance'; workPackageId: string }
  | { kind: 'project_grant' }

function refuse(refusal: Refusal) {
  return NextResponse.json({ code: refusal.code, error: refusal.error }, { status: refusal.status })
}

/**
 * Proves the persisted state actually offers this exact action on this exact
 * evidence. Presentation copy never authorizes anything: an action is
 * admissible only when a *current* recovery marker names it, and only when the
 * immutable identity in the request matches that marker byte for byte.
 */
function authorizeAgainstPersistedState(
  request: S5OperatorActionRequest,
  state: S5AuthoritativeTaskState,
): Refusal | AuthorizedTarget {
  const stale: Refusal = {
    status: 409,
    code: 'stale_action',
    error: 'This control refers to state that has since changed. Reload the task and review the current state before acting.',
  }

  if (isLocalEffectActionRequest(request)) {
    const marker = state.recoveryMarkers.find((candidate) => (
      candidate.kind === 'local_effect_recovery'
      && candidate.state === 'current'
      && candidate.evidenceId === request.localRunEvidenceId
    ))
    if (!marker) return stale
    if (marker.evidenceFingerprint !== request.evidenceFingerprint) return stale
    // `review_local_changes` is a review step the marker may require before it
    // advances to a retry disposition; every other action must be the exact
    // disposition the marker currently carries.
    if (marker.action !== request.action) return stale
    return { kind: 'local_effect', workPackageId: marker.workPackageId }
  }

  if (isPacketActionRequest(request)) {
    const marker = state.recoveryMarkers.find((candidate) => (
      candidate.kind === 'packet_issuance'
      && candidate.state === 'current'
      && candidate.evidenceId === request.priorRuntimeAuditId
    ))
    if (!marker) return stale
    if (marker.evidenceFingerprint !== request.markerFingerprint) return stale
    if (marker.action !== request.action) return stale
    return { kind: 'packet_issuance', workPackageId: marker.workPackageId }
  }

  if (request.projectId !== state.projectId) return stale
  const current = state.projectGrant
  const expectedId = request.expectedProjectDecisionId
  if (expectedId === null) {
    // The operator acted on "no current project decision"; if one exists now,
    // they have not seen it.
    if (current !== null) return stale
    return { kind: 'project_grant' }
  }
  if (current === null) return stale
  if (current.id !== expectedId) return stale
  if (current.grantDecisionRevision !== request.expectedProjectDecisionRevision) return stale
  return { kind: 'project_grant' }
}

async function continueCommittedRecovery(
  taskId: string,
  result: S4OperatorRecoveryResult,
  source: 'local-effect-recovery' | 'packet-issuance-recovery',
): Promise<'not_required' | 'enqueued' | 'already_queued' | 'pending'> {
  try {
    await convergeRecognizedOperatorHoldTask(taskId)
    if (result.packageStatus !== 'ready') return 'not_required'
    return (await enqueueBlockedHandoffRetry(taskId, { source })).status
  } catch {
    console.error('[mcps/actions POST] Committed recovery continuation pending')
    return 'pending'
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return refuse({ status: 401, code: 'unauthorized', error: 'Unauthorized' })

    // The Step 0 retention bridge gates every operator mutation, ahead of any
    // task-scoped read. Its state is global, so answering it first discloses
    // nothing task-specific.
    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock

    const { taskId } = await params
    const task = await getAccessibleTask(taskId, session.userId)
    if (!task || task.submittedBy !== session.userId) {
      return refuse({ status: 404, code: 'not_found', error: 'Task not found' })
    }

    const parsed = parseS5OperatorActionRequest(await request.json().catch(() => null))
    if (!parsed) {
      return refuse({ status: 400, code: 'invalid_action', error: 'Unrecognised operator action request.' })
    }

    let state: S5AuthoritativeTaskState
    try {
      state = await readS5AuthoritativeTaskState(taskId, session.userId)
    } catch (error) {
      if (error instanceof S5TaskNotFoundError) {
        return refuse({ status: 404, code: 'not_found', error: 'Task not found' })
      }
      throw error
    }

    // Compare-and-set on the exact rows the operator saw. Any drift refuses
    // with zero mutation; the client must reload and reconfirm.
    if (state.freshnessFingerprint !== parsed.expectedFreshnessFingerprint) {
      return refuse({
        status: 409,
        code: 'stale_state',
        error: 'The task changed since this view was loaded. Reload and review the current state before acting.',
      })
    }

    const authorization = authorizeAgainstPersistedState(parsed, state)
    if ('status' in authorization) return refuse(authorization)

    if (authorization.kind === 'local_effect' && isLocalEffectActionRequest(parsed)) {
      const result = await applyLocalEffectRecoveryActionV2({
        taskId,
        workPackageId: authorization.workPackageId,
        localRunEvidenceId: parsed.localRunEvidenceId,
        action: parsed.action,
        expectedMarkerFingerprint: parsed.evidenceFingerprint,
        actorUserId: session.userId,
      })
      const continuationStatus = await continueCommittedRecovery(taskId, result, 'local-effect-recovery')
      return NextResponse.json(
        { action: parsed.action, applied: true, result, continuationStatus },
        { status: continuationStatus === 'pending' ? 202 : 200 },
      )
    }

    if (authorization.kind === 'packet_issuance' && isPacketActionRequest(parsed)) {
      const authorizingDecision = parsed.action === 'retry_execution'
        ? await loadCurrentProjectFilesystemDecision(state.projectId)
        : null
      if (parsed.action === 'retry_execution' && authorizingDecision?.decision !== 'approved') {
        return refuse({
          status: 409,
          code: 'stale_action',
          error: 'This control refers to state that has since changed. Reload the task and review the current state before acting.',
        })
      }
      const result = await applyPacketIssuanceRecoveryActionV2({
        taskId,
        workPackageId: authorization.workPackageId,
        priorRuntimeAuditId: parsed.priorRuntimeAuditId,
        action: parsed.action,
        expectedMarkerFingerprint: parsed.markerFingerprint,
        actorUserId: session.userId,
        authorizingDecisionId: authorizingDecision?.decisionId ?? null,
      })
      const continuationStatus = await continueCommittedRecovery(taskId, result, 'packet-issuance-recovery')
      return NextResponse.json(
        { action: parsed.action, applied: true, result, continuationStatus },
        { status: continuationStatus === 'pending' ? 202 : 200 },
      )
    }

    if (authorization.kind !== 'project_grant' || parsed.action !== 'approve_project_filesystem_context') {
      return refuse({ status: 409, code: 'stale_action', error: 'Recovery state changed. Reload and retry.' })
    }
    const [project] = await db.select().from(projects)
      .where(accessibleProjectCondition(parsed.projectId, session.userId)).limit(1)
    if (!project) return refuse({ status: 404, code: 'not_found', error: 'Project not found' })

    const overview = await getProjectMcpOverview(project)
    const healthError = filesystemGrantHealthError(overview.statuses)
    if (healthError) return refuse({ status: 409, code: 'mcp_unhealthy', error: healthError })

    const result = await mutateProjectFilesystemGrant({
      actorId: session.userId,
      capabilities: ALL_READ_ONLY_CAPABILITIES,
      enabled: true,
      projectId: project.id,
      reason: '',
    })

    // Enqueue only after the transaction committed, and never fail the
    // committed mutation because a wake-up could not be queued.
    const queueFailures: string[] = []
    for (const recoveredTaskId of result.recoveredTaskIds) {
      try {
        await enqueueBlockedHandoffRetry(recoveredTaskId, { source: 'project-filesystem-approval' })
      } catch {
        console.error('[mcps/actions POST] Project recovery continuation pending')
        queueFailures.push(recoveredTaskId)
      }
    }

    const body = {
      action: parsed.action,
      applied: true,
      recoveredTaskIds: result.recoveredTaskIds,
    }
    return queueFailures.length > 0
      ? NextResponse.json(
          { ...body, error: 'The decision was saved, but some recovery wake-ups failed.', failedTaskIds: queueFailures },
          { status: 202 },
        )
      : NextResponse.json(body)
  } catch (error) {
    if (error instanceof S4LifecycleError) {
      return refuse(error.code === 'configuration'
        ? { status: 503, code: 'recovery_unavailable', error: 'Protected recovery is unavailable.' }
        : { status: 409, code: 'stale_action', error: 'Recovery state changed. Reload and retry.' })
    }
    console.error('[mcps/actions POST] Unexpected fixed-category failure')
    return NextResponse.json({ code: 'internal_error', error: 'Internal server error' }, { status: 500 })
  }
}
