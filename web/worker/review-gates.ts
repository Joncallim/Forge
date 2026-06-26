import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { approvalGates, artifacts, workPackages } from '../db/schema'
import { publishTaskEvent } from './events'
import { updateTaskStatusIfCurrent } from './task-state'

export const REVIEW_GATE_TYPES = ['qa_review', 'reviewer_review'] as const
export type ReviewGateType = typeof REVIEW_GATE_TYPES[number]
export type ReviewGateDecision = 'completed' | 'needs_rework'

const REVIEW_GATE_TYPE_VALUES = [...REVIEW_GATE_TYPES]
const REVIEW_EXEMPT_ROLES = new Set(['architect', 'handoff', 'pm', 'qa', 'reviewer'])

type ReviewGatePackage = {
  id: string
  assignedRole: string
  status: string
  taskId: string
  title: string
}

type MaterializedGate = {
  id: string
  gateType: ReviewGateType
  requiredRole: 'qa' | 'reviewer'
  title: string
}

export type ReviewGateMaterializationResult =
  | {
      status: 'not_found'
      packageStatus: null
      createdGates: []
    }
  | {
      status: 'materialized' | 'already_materialized' | 'not_required'
      packageStatus: 'awaiting_review' | 'completed'
      createdGates: MaterializedGate[]
    }

export type ReviewGateDecisionResult =
  | {
      status: 'decided'
      gateId: string
      gateType: ReviewGateType
      decision: ReviewGateDecision
      packageStatus: 'awaiting_review' | 'completed' | 'needs_rework' | null
      taskCompleted: boolean
      cancelledGateIds: string[]
    }
  | {
      status: 'not_found' | 'not_review_gate' | 'already_decided' | 'missing_work_package' | 'reviewer_blocked' | 'source_artifact_mismatch'
      message: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function isReviewGateType(value: string | null | undefined): value is ReviewGateType {
  return value === 'qa_review' || value === 'reviewer_review'
}

export function requiredRoleForGate(gateType: ReviewGateType): 'qa' | 'reviewer' {
  return gateType === 'qa_review' ? 'qa' : 'reviewer'
}

export function isImplementationPackageRole(role: string): boolean {
  const normalized = role.trim().toLowerCase()
  return normalized !== '' && !REVIEW_EXEMPT_ROLES.has(normalized)
}

function reviewGateTitle(gateType: ReviewGateType, pkg: ReviewGatePackage): string {
  const role = requiredRoleForGate(gateType)
  return `${role === 'qa' ? 'QA' : 'Reviewer'} review: ${pkg.title}`
}

function reviewGateInstructions(gateType: ReviewGateType, pkg: ReviewGatePackage): string {
  if (gateType === 'qa_review') {
    return `QA must verify the output for "${pkg.title}" before reviewer approval.`
  }
  return `Reviewer must approve the output for "${pkg.title}" after QA completion.`
}

function reviewGateMetadata(
  gateType: ReviewGateType,
  pkg: ReviewGatePackage,
  sourceAgentRunId: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    requiredRole: requiredRoleForGate(gateType),
    source: 'review-gates',
    sourcePackageId: pkg.id,
    sourceRunId: sourceAgentRunId,
  }
}

async function loadPackage(taskId: string, workPackageId: string): Promise<ReviewGatePackage | null> {
  const [pkg] = await db
    .select({
      id: workPackages.id,
      assignedRole: workPackages.assignedRole,
      status: workPackages.status,
      taskId: workPackages.taskId,
      title: workPackages.title,
    })
    .from(workPackages)
    .where(and(eq(workPackages.id, workPackageId), eq(workPackages.taskId, taskId)))
    .limit(1)

  return pkg ?? null
}

export async function materializeReviewGatesForWorkPackageCompletion(input: {
  sourceAgentRunId: string
  sourceArtifactId: string | null
  taskId: string
  workPackageId: string
}): Promise<ReviewGateMaterializationResult> {
  const pkg = await loadPackage(input.taskId, input.workPackageId)
  if (!pkg) {
    return { status: 'not_found', packageStatus: null, createdGates: [] }
  }

  const now = new Date()
  const reviewRequired = isImplementationPackageRole(pkg.assignedRole)
  const packageStatus = reviewRequired ? 'awaiting_review' : 'completed'

  const createdGates = await db.transaction(async (tx) => {
    await tx
      .update(workPackages)
      .set({
        blockedReason: null,
        status: packageStatus,
        updatedAt: now,
      })
      .where(eq(workPackages.id, pkg.id))

    if (!reviewRequired) {
      return [] as MaterializedGate[]
    }

    const existingGates = await tx
      .select({
        gateType: approvalGates.gateType,
      })
      .from(approvalGates)
      .where(
        and(
          eq(approvalGates.taskId, input.taskId),
          eq(approvalGates.workPackageId, pkg.id),
          inArray(approvalGates.gateType, REVIEW_GATE_TYPE_VALUES),
        ),
      )

    const existingGateTypes = new Set(existingGates.map((gate) => gate.gateType))
    const missingGateTypes = REVIEW_GATE_TYPES.filter((gateType) => !existingGateTypes.has(gateType))
    const inserted: MaterializedGate[] = []

    for (const gateType of missingGateTypes) {
      const [gate] = await tx
        .insert(approvalGates)
        .values({
          taskId: input.taskId,
          workPackageId: pkg.id,
          gateType,
          status: 'pending',
          sourceAgentRunId: input.sourceAgentRunId,
          sourceArtifactId: input.sourceArtifactId,
          title: reviewGateTitle(gateType, pkg),
          instructions: reviewGateInstructions(gateType, pkg),
          metadata: reviewGateMetadata(gateType, pkg, input.sourceAgentRunId),
        })
        .returning({
          id: approvalGates.id,
          gateType: approvalGates.gateType,
          title: approvalGates.title,
        })

      if (gate && isReviewGateType(gate.gateType)) {
        inserted.push({
          id: gate.id,
          gateType: gate.gateType,
          requiredRole: requiredRoleForGate(gate.gateType),
          title: gate.title,
        })
      }
    }

    return inserted
  })

  await publishTaskEvent(input.taskId, 'work_package:status', {
    status: packageStatus,
    updatedAt: now.toISOString(),
    workPackageId: pkg.id,
  })

  for (const gate of createdGates) {
    await publishTaskEvent(input.taskId, 'approval_gate:created', {
      gateId: gate.id,
      gateType: gate.gateType,
      requiredRole: gate.requiredRole,
      status: 'pending',
      title: gate.title,
      updatedAt: now.toISOString(),
      workPackageId: pkg.id,
    })
  }

  return {
    status: reviewRequired
      ? createdGates.length > 0 ? 'materialized' : 'already_materialized'
      : 'not_required',
    packageStatus,
    createdGates,
  }
}

export async function completeTaskIfReviewGatesSatisfied(taskId: string): Promise<{
  status: 'completed' | 'blocked' | 'no_work_packages'
  reason?: string
}> {
  const packages = await db
    .select({
      id: workPackages.id,
      status: workPackages.status,
    })
    .from(workPackages)
    .where(eq(workPackages.taskId, taskId))
    .orderBy(asc(workPackages.sequence), asc(workPackages.createdAt))

  if (packages.length === 0) return { status: 'no_work_packages' }

  const unfinishedPackage = packages.find((pkg) => pkg.status !== 'completed' && pkg.status !== 'cancelled')
  if (unfinishedPackage) {
    return { status: 'blocked', reason: `work package ${unfinishedPackage.id} is ${unfinishedPackage.status}` }
  }

  const gates = await db
    .select({
      id: approvalGates.id,
      gateType: approvalGates.gateType,
      status: approvalGates.status,
    })
    .from(approvalGates)
    .where(and(eq(approvalGates.taskId, taskId), inArray(approvalGates.gateType, REVIEW_GATE_TYPE_VALUES)))

  const blockingGate = gates.find((gate) => gate.status !== 'completed')
  if (blockingGate) {
    return { status: 'blocked', reason: `${blockingGate.gateType} gate ${blockingGate.id} is ${blockingGate.status}` }
  }

  const completed = await updateTaskStatusIfCurrent(taskId, 'running', 'completed')
  return completed ? { status: 'completed' } : { status: 'blocked', reason: 'task is no longer running' }
}

export async function decideReviewGate(input: {
  decision: ReviewGateDecision
  gateId: string
  reason: string
  sourceArtifactId: string
  taskId: string
  userId: string
}): Promise<ReviewGateDecisionResult> {
  const [gate] = await db
    .select({
      id: approvalGates.id,
      gateType: approvalGates.gateType,
      metadata: approvalGates.metadata,
      sourceAgentRunId: approvalGates.sourceAgentRunId,
      sourceArtifactId: approvalGates.sourceArtifactId,
      status: approvalGates.status,
      workPackageId: approvalGates.workPackageId,
    })
    .from(approvalGates)
    .where(and(eq(approvalGates.id, input.gateId), eq(approvalGates.taskId, input.taskId)))
    .limit(1)

  if (!gate) return { status: 'not_found', message: 'Approval gate not found.' }
  if (!isReviewGateType(gate.gateType)) {
    return { status: 'not_review_gate', message: 'Only QA and Reviewer gates can be decided here.' }
  }
  if (gate.status !== 'pending') {
    return { status: 'already_decided', message: `Approval gate is already ${gate.status}.` }
  }
  if (!gate.workPackageId) {
    return { status: 'missing_work_package', message: 'Review gate is not linked to a work package.' }
  }
  if (!gate.sourceArtifactId || gate.sourceArtifactId !== input.sourceArtifactId) {
    return {
      status: 'source_artifact_mismatch',
      message: 'Review gate source artifact changed. Reload the task before deciding this review.',
    }
  }
  if (!gate.sourceAgentRunId) {
    return {
      status: 'source_artifact_mismatch',
      message: 'Review gate source run is missing. Reload the task before deciding this review.',
    }
  }
  const workPackageId = gate.workPackageId
  const sourceAgentRunId = gate.sourceAgentRunId

  const [sourceArtifact] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, input.sourceArtifactId),
        eq(artifacts.agentRunId, sourceAgentRunId),
      ),
    )
    .limit(1)

  if (!sourceArtifact) {
    return {
      status: 'source_artifact_mismatch',
      message: 'Review gate source artifact is not available. Reload the task before deciding this review.',
    }
  }

  if (gate.gateType === 'reviewer_review' && input.decision === 'completed') {
    const [qaGate] = await db
      .select({ status: approvalGates.status })
      .from(approvalGates)
      .where(
        and(
          eq(approvalGates.taskId, input.taskId),
          eq(approvalGates.workPackageId, workPackageId),
          eq(approvalGates.gateType, 'qa_review'),
        ),
      )
      .limit(1)

    if (!qaGate || qaGate.status !== 'completed') {
      return { status: 'reviewer_blocked', message: 'QA review must be completed before reviewer approval.' }
    }
  }

  const now = new Date()
  const reason = input.reason.trim()
  const decided = await db.transaction(async (tx) => {
    const metadata = {
      ...metadataRecord(gate.metadata),
      decision: input.decision,
      decisionReason: reason,
      decidedAt: now.toISOString(),
      decidedBy: input.userId,
      source: 'review-gates',
    }

    const [decidedGate] = await tx
      .update(approvalGates)
      .set({
        status: input.decision,
        metadata,
        decidedAt: now,
        decidedBy: input.userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(approvalGates.id, gate.id),
          eq(approvalGates.status, 'pending'),
          eq(approvalGates.sourceArtifactId, input.sourceArtifactId),
          eq(approvalGates.sourceAgentRunId, sourceAgentRunId),
        ),
      )
      .returning({ id: approvalGates.id })

    if (!decidedGate) {
      return {
        cancelledGateIds: [] as string[],
        packageStatus: null,
        sourceArtifactChanged: true,
      }
    }

    if (input.decision === 'needs_rework') {
      await tx
        .update(workPackages)
        .set({
          blockedReason: reason,
          status: 'needs_rework',
          updatedAt: now,
        })
        .where(eq(workPackages.id, workPackageId))

      const cancelledGates = await tx
        .update(approvalGates)
        .set({
          status: 'cancelled',
          updatedAt: now,
          metadata: {
            cancelledByGateId: gate.id,
            cancelledReason: 'Package sent back for rework.',
            source: 'review-gates',
          },
        })
        .where(
          and(
            eq(approvalGates.taskId, input.taskId),
            eq(approvalGates.workPackageId, workPackageId),
            eq(approvalGates.status, 'pending'),
            inArray(approvalGates.gateType, REVIEW_GATE_TYPE_VALUES),
          ),
        )
        .returning({ id: approvalGates.id })

      return {
        cancelledGateIds: cancelledGates.map((cancelledGate) => cancelledGate.id),
        packageStatus: 'needs_rework' as const,
        sourceArtifactChanged: false,
      }
    }

    const reviewGates = await tx
      .select({
        gateType: approvalGates.gateType,
        status: approvalGates.status,
      })
      .from(approvalGates)
      .where(
        and(
          eq(approvalGates.taskId, input.taskId),
          eq(approvalGates.workPackageId, workPackageId),
          inArray(approvalGates.gateType, REVIEW_GATE_TYPE_VALUES),
        ),
      )

    const completedGateTypes = new Set(
      reviewGates
        .filter((reviewGate) => reviewGate.status === 'completed')
        .map((reviewGate) => reviewGate.gateType),
    )
    const packageComplete = REVIEW_GATE_TYPES.every((gateType) => completedGateTypes.has(gateType))

    if (packageComplete) {
      await tx
        .update(workPackages)
        .set({
          blockedReason: null,
          status: 'completed',
          updatedAt: now,
        })
        .where(eq(workPackages.id, workPackageId))
    }

    return {
      cancelledGateIds: [] as string[],
      packageStatus: packageComplete ? 'completed' as const : 'awaiting_review' as const,
      sourceArtifactChanged: false,
    }
  })

  if (decided.sourceArtifactChanged) {
    return {
      status: 'source_artifact_mismatch',
      message: 'Review gate source artifact changed. Reload the task before deciding this review.',
    }
  }

  await publishTaskEvent(input.taskId, 'approval_gate:decided', {
    decision: input.decision,
    gateId: gate.id,
    gateType: gate.gateType,
    reason,
    requiredRole: requiredRoleForGate(gate.gateType),
    status: input.decision,
    updatedAt: now.toISOString(),
    workPackageId,
  })

  for (const cancelledGateId of decided.cancelledGateIds) {
    await publishTaskEvent(input.taskId, 'approval_gate:decided', {
      gateId: cancelledGateId,
      reason: 'Package sent back for rework.',
      status: 'cancelled',
      updatedAt: now.toISOString(),
      workPackageId,
    })
  }

  if (decided.packageStatus) {
    await publishTaskEvent(input.taskId, 'work_package:status', {
      blockedReason: input.decision === 'needs_rework' ? reason : null,
      status: decided.packageStatus,
      updatedAt: now.toISOString(),
      workPackageId,
    })
  }

  const completion = decided.packageStatus === 'completed'
    ? await completeTaskIfReviewGatesSatisfied(input.taskId)
    : { status: 'blocked' as const }

  return {
    status: 'decided',
    gateId: gate.id,
    gateType: gate.gateType,
    decision: input.decision,
    packageStatus: decided.packageStatus,
    taskCompleted: completion.status === 'completed',
    cancelledGateIds: decided.cancelledGateIds,
  }
}
