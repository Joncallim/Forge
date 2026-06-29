import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { agentRuns, approvalGates, artifacts, workPackages } from '../db/schema'
import { publishTaskEvent } from './events'
import { updateTaskStatusIfCurrent } from './task-state'

export const REVIEW_GATE_TYPES = ['qa_review', 'reviewer_review', 'security_review'] as const
export type ReviewGateType = typeof REVIEW_GATE_TYPES[number]
export type ReviewGateDecision = 'completed' | 'needs_rework'
export type ReviewRequirement = 'none' | 'qa_only' | 'reviewer_only' | 'both'

const REVIEW_GATE_TYPE_VALUES = [...REVIEW_GATE_TYPES]
const STANDARD_REVIEW_GATE_TYPES: ReviewGateType[] = ['qa_review', 'reviewer_review']
const REVIEW_EXEMPT_ROLES = new Set([
  'architect',
  'handoff',
  'pm',
  'qa',
  'reviewer',
  'security',
  'security-review',
  'security_review',
])
const HIGH_RISK_TEXT_PATTERN =
  /\b(auth|authorization|authenticate|oauth|login|session|cookie|csrf|jwt|token|secret|password|api\s*key|credential|filesystem|file\s*system|fs|shell|command|exec|spawn|child_process|terminal|repository|repo|git|github|pull\s*request|pr|branch|commit|merge|diff|checkout)\b/i
const SECURITY_REVIEW_CAPABILITY_PATTERN = /\bsecurity[-_\s]?review\b/i

function isReviewRequirement(value: string): value is ReviewRequirement {
  return value === 'none' || value === 'qa_only' || value === 'reviewer_only' || value === 'both'
}

export function requiredGateTypesForRequirement(requirement: string): ReviewGateType[] {
  if (!isReviewRequirement(requirement)) return [...STANDARD_REVIEW_GATE_TYPES]
  if (requirement === 'none') return []
  if (requirement === 'qa_only') return ['qa_review']
  if (requirement === 'reviewer_only') return ['reviewer_review']
  return [...STANDARD_REVIEW_GATE_TYPES]
}

type ReviewGatePackage = {
  acceptanceCriteria?: unknown
  id: string
  assignedRole: string
  mcpRequirements?: unknown
  metadata?: unknown
  requiredCapabilities?: unknown
  reviewRequirement: string
  steps?: unknown
  status: string
  summary?: string | null
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

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : []
}

function flattenStrings(value: unknown, result: string[] = []): string[] {
  if (typeof value === 'string') {
    result.push(value)
    return result
  }

  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, result)
    return result
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) flattenStrings(item, result)
  }

  return result
}

export function isReviewGateType(value: string | null | undefined): value is ReviewGateType {
  return value === 'qa_review' || value === 'reviewer_review' || value === 'security_review'
}

export function requiredRoleForGate(gateType: ReviewGateType): 'qa' | 'reviewer' {
  return gateType === 'qa_review' ? 'qa' : 'reviewer'
}

export function isImplementationPackageRole(role: string): boolean {
  const normalized = role.trim().toLowerCase()
  return normalized !== '' && !REVIEW_EXEMPT_ROLES.has(normalized)
}

export function isHighRiskImplementationPackage(pkg: {
  acceptanceCriteria?: unknown
  assignedRole: string
  mcpRequirements?: unknown
  metadata?: unknown
  requiredCapabilities?: unknown
  steps?: unknown
  summary?: string | null
  title?: string | null
}): boolean {
  if (!isImplementationPackageRole(pkg.assignedRole)) return false

  const metadata = metadataRecord(pkg.metadata)
  if (
    recordArray(pkg.mcpRequirements).length > 0 ||
    recordArray(metadata.mcpGrants).length > 0 ||
    recordArray(metadata.mcpAwareSubtasks).length > 0 ||
    typeof metadata.promptOverlay === 'string'
  ) {
    return true
  }

  const searchable = flattenStrings([
    pkg.acceptanceCriteria,
    pkg.requiredCapabilities,
    pkg.steps,
    pkg.summary,
    pkg.title,
    metadata.promptOverlay,
    metadata.mcpAwareSubtasks,
    metadata.plannedTasks,
  ]).join('\n')

  return SECURITY_REVIEW_CAPABILITY_PATTERN.test(searchable) || HIGH_RISK_TEXT_PATTERN.test(searchable)
}

function requiredGateTypesForPackage(pkg: ReviewGatePackage | null): ReviewGateType[] {
  if (!pkg) return requiredGateTypesForRequirement('both')
  const gateTypes = requiredGateTypesForRequirement(pkg.reviewRequirement ?? 'both')
  const assignedRole = typeof pkg.assignedRole === 'string' ? pkg.assignedRole : ''
  if (assignedRole !== '' && !isImplementationPackageRole(assignedRole)) return []

  if (assignedRole !== '' && isHighRiskImplementationPackage({
    acceptanceCriteria: pkg.acceptanceCriteria,
    assignedRole,
    mcpRequirements: pkg.mcpRequirements,
    metadata: pkg.metadata,
    requiredCapabilities: pkg.requiredCapabilities,
    steps: pkg.steps,
    summary: pkg.summary,
    title: pkg.title,
  }) && !gateTypes.includes('security_review')) {
    gateTypes.push('security_review')
  }
  return gateTypes
}

function reviewGateTitle(gateType: ReviewGateType, pkg: ReviewGatePackage): string {
  if (gateType === 'security_review') return `Security review: ${pkg.title}`
  const role = requiredRoleForGate(gateType)
  return `${role === 'qa' ? 'QA' : 'Reviewer'} review: ${pkg.title}`
}

function reviewGateInstructions(gateType: ReviewGateType, pkg: ReviewGatePackage): string {
  if (gateType === 'qa_review') {
    return `QA must verify the output for "${pkg.title}" before reviewer approval.`
  }
  if (gateType === 'security_review') {
    return `Reviewer must perform a security review for high-risk implementation output from "${pkg.title}".`
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
      acceptanceCriteria: workPackages.acceptanceCriteria,
      id: workPackages.id,
      assignedRole: workPackages.assignedRole,
      mcpRequirements: workPackages.mcpRequirements,
      metadata: workPackages.metadata,
      requiredCapabilities: workPackages.requiredCapabilities,
      reviewRequirement: workPackages.reviewRequirement,
      steps: workPackages.steps,
      status: workPackages.status,
      summary: workPackages.summary,
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
  const requiredGateTypes = requiredGateTypesForPackage(pkg)
  const reviewRequired = requiredGateTypes.length > 0
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
        sourceAgentRunId: approvalGates.sourceAgentRunId,
        sourceArtifactId: approvalGates.sourceArtifactId,
        status: approvalGates.status,
      })
      .from(approvalGates)
      .where(
        and(
          eq(approvalGates.taskId, input.taskId),
          eq(approvalGates.workPackageId, pkg.id),
          inArray(approvalGates.gateType, REVIEW_GATE_TYPE_VALUES),
        ),
      )

    // Stale gates from a prior rework cycle (needs_rework/cancelled) must not
    // block re-materialization of a fresh pending gate for the new attempt. A
    // completed gate only still satisfies the requirement if it was decided
    // against the artifact we're materializing for now — a completed gate tied
    // to an older artifact is stale and must be replaced by a fresh pending one.
    const stalePendingGateTypes = existingGates
      .filter((gate) =>
        gate.status === 'pending' &&
        (gate.sourceArtifactId !== input.sourceArtifactId || gate.sourceAgentRunId !== input.sourceAgentRunId)
      )
      .map((gate) => gate.gateType)

    if (stalePendingGateTypes.length > 0) {
      await tx
        .update(approvalGates)
        .set({
          status: 'cancelled',
          updatedAt: now,
          metadata: {
            cancelledReason: 'Stale pending gate replaced for a newer package artifact.',
            source: 'review-gates',
          },
        })
        .where(
          and(
            eq(approvalGates.taskId, input.taskId),
            eq(approvalGates.workPackageId, pkg.id),
            eq(approvalGates.status, 'pending'),
            inArray(approvalGates.gateType, stalePendingGateTypes),
          ),
        )
    }

    const existingGateTypes = new Set(
      existingGates
        .filter((gate) =>
          (gate.status === 'pending' || gate.status === 'completed') &&
          gate.sourceArtifactId === input.sourceArtifactId &&
          gate.sourceAgentRunId === input.sourceAgentRunId,
        )
        .map((gate) => gate.gateType),
    )
    const missingGateTypes = requiredGateTypes.filter((gateType) => !existingGateTypes.has(gateType))
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

  const completedPackageIds = new Set(
    packages.filter((pkg) => pkg.status === 'completed').map((pkg) => pkg.id),
  )

  const gates = await db
    .select({
      id: approvalGates.id,
      createdAt: approvalGates.createdAt,
      gateType: approvalGates.gateType,
      status: approvalGates.status,
      workPackageId: approvalGates.workPackageId,
    })
    .from(approvalGates)
    .where(and(eq(approvalGates.taskId, taskId), inArray(approvalGates.gateType, REVIEW_GATE_TYPE_VALUES)))
    .orderBy(desc(approvalGates.createdAt))

  // Only the latest gate per work package + gate type matters: a rework cycle
  // leaves stale cancelled/completed gates from earlier attempts behind, and
  // those must not block completion once a fresh attempt has been approved.
  const latestGateByKey = new Map<string, { gateType: string; id: string; status: string }>()
  for (const gate of gates) {
    if (!gate.workPackageId || !completedPackageIds.has(gate.workPackageId)) continue
    const key = `${gate.workPackageId}:${gate.gateType}`
    if (!latestGateByKey.has(key)) {
      latestGateByKey.set(key, gate)
    }
  }

  const blockingGate = [...latestGateByKey.values()].find((gate) => gate.status !== 'completed')
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
    return { status: 'not_review_gate', message: 'Only QA, Reviewer, and Security gates can be decided here.' }
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

  const [workPackage] = await db
    .select({
      acceptanceCriteria: workPackages.acceptanceCriteria,
      assignedRole: workPackages.assignedRole,
      id: workPackages.id,
      mcpRequirements: workPackages.mcpRequirements,
      metadata: workPackages.metadata,
      requiredCapabilities: workPackages.requiredCapabilities,
      reviewRequirement: workPackages.reviewRequirement,
      status: workPackages.status,
      steps: workPackages.steps,
      summary: workPackages.summary,
      taskId: workPackages.taskId,
      title: workPackages.title,
    })
    .from(workPackages)
    .where(eq(workPackages.id, workPackageId))
    .limit(1)
  const requiredGateTypes = requiredGateTypesForPackage(workPackage ?? null)

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

  const [latestPackageArtifact] = await db
    .select({
      id: artifacts.id,
      agentRunId: artifacts.agentRunId,
    })
    .from(artifacts)
    .innerJoin(agentRuns, eq(artifacts.agentRunId, agentRuns.id))
    .where(and(eq(agentRuns.taskId, input.taskId), eq(agentRuns.workPackageId, workPackageId)))
    .orderBy(desc(artifacts.createdAt))
    .limit(1)

  if (
    latestPackageArtifact &&
    (latestPackageArtifact.id !== input.sourceArtifactId || latestPackageArtifact.agentRunId !== sourceAgentRunId)
  ) {
    return {
      status: 'source_artifact_mismatch',
      message: 'Review gate source artifact is stale. Reload the task before deciding this review.',
    }
  }

  if (
    gate.gateType === 'reviewer_review' &&
    input.decision === 'completed' &&
    requiredGateTypes.includes('qa_review')
  ) {
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
      .orderBy(desc(approvalGates.createdAt))
      .limit(1)

    if (qaGate && qaGate.status !== 'completed') {
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
        createdAt: approvalGates.createdAt,
      })
      .from(approvalGates)
      .where(
        and(
          eq(approvalGates.taskId, input.taskId),
          eq(approvalGates.workPackageId, workPackageId),
          inArray(approvalGates.gateType, REVIEW_GATE_TYPE_VALUES),
        ),
      )
      .orderBy(desc(approvalGates.createdAt))

    const latestStatusByGateType = new Map<string, string>()
    for (const reviewGate of reviewGates) {
      if (!latestStatusByGateType.has(reviewGate.gateType)) {
        latestStatusByGateType.set(reviewGate.gateType, reviewGate.status)
      }
    }

    const packageComplete = requiredGateTypes.every(
      (gateType) => latestStatusByGateType.get(gateType) === 'completed',
    )

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
