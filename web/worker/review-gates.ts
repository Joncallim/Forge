import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { agentRuns, approvalGates, artifacts, workPackages } from '../db/schema'
import { publishTaskEvent, type TaskEventPayload } from './events'
import { sanitizeWorkerMessage } from './redaction'
import { updateTaskStatusIfCurrent } from './task-state'
import { convergeRecognizedOperatorHoldTask } from '../lib/mcps/filesystem-grant-reconciliation'
import { resolveS4ReviewSourceV1 } from '../lib/mcps/review-source-resolver'

export const REVIEW_GATE_TYPES = ['qa_review', 'reviewer_review', 'security_review'] as const
export type ReviewGateType = typeof REVIEW_GATE_TYPES[number]
export type ReviewGateDecision = 'completed' | 'needs_rework'
export type ReviewRequirement = 'none' | 'qa_only' | 'reviewer_only' | 'both'
export type ReviewGateRequiredRole = 'qa' | 'reviewer' | 'security'

export type SecurityFindingV1 = {
  reviewSurface: string
  asset: string
  trustBoundary: string
  exploitPath: string
  impact: string
  requiredFix: string
  evidenceRefs: string[]
  severity: string
  confidence: string
  verificationState: string
}

export type SecurityReviewNoFindingsV1 = {
  reviewSurface: string
  evidenceRefs: string[]
  verificationState: string
}

export type SecurityReviewPayloadV1 = {
  schemaVersion: 1
  findings: SecurityFindingV1[]
  noFindings?: SecurityReviewNoFindingsV1
  summary?: string
  verdict?: 'findings' | 'no_findings'
}

const REVIEW_GATE_TYPE_VALUES = [...REVIEW_GATE_TYPES]
const STANDARD_REVIEW_GATE_TYPES: ReviewGateType[] = ['qa_review', 'reviewer_review']
const MAX_SECURITY_FINDINGS = 50
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
// Free-text fallback signal for security-sensitive work. This is a secondary,
// best-effort heuristic — the primary high-risk signals are structural (MCP
// grants, prompt overlays, requiredCapabilities). The patterns below favour
// stem tolerance (so plurals/derivatives like "tokens", "credentials",
// "authentication" match) while deliberately avoiding short ambiguous words
// (`pr`, `fs`, `diff`, bare `merge`/`branch`/`commit`/`command`/`repo`) that
// flood benign UI packages with spurious security gates. Ambiguous words are
// only treated as risky when they co-occur with an action that implies real
// repository/command/credential handling.
const HIGH_RISK_TEXT_PATTERN = new RegExp(
  [
    'auth(?:n|z|entication|enticate|enticated|orization|orize|orized)?\\b',
    'oauth',
    'sign[-\\s]?(?:in|on)\\b',
    'log(?:in|out)\\b',
    'session\\b|sessions\\b',
    'cookie',
    'csrf|xsrf|\\bxss\\b|jwt',
    'token',
    'secret',
    'pass(?:word|phrase)',
    'api[-\\s]?key',
    'credential',
    'file[-\\s]?system|filesystem',
    'child_process|subprocess|\\bspawn\\b|execve|\\bexec\\b',
    'shell\\b|terminal\\b',
    'command[-\\s]?(?:execution|injection)',
    'prompt[-\\s]?injection|instruction[-\\s]?injection|jailbreak',
    '(?:repository|repo)[-\\s]?(?:write|writes|mutation|mutations|permission|permissions)',
    '(?:tool|mcp)[-\\s]?(?:grant|grants|permission|permissions|access|scope|scopes|capabilit)',
    'grant[-\\s]?(?:tool|mcp|permission|access)',
    'data[-\\s]?(?:privacy|access|exfiltration|exfiltrate)|\\bprivacy\\b',
    '\\bpii\\b|personally\\s+identifiable|personal\\s+data|sensitive\\s+data',
    'pull[-\\s]?request',
    'force[-\\s]?push|git\\s+(?:push|commit|merge|clone|checkout|reset)',
    'merge[-\\s]?conflict',
    'encrypt|decrypt|\\bcipher\\b',
    'privilege|escalat|\\brce\\b|remote\\s+code',
  ].join('|'),
  'i',
)
const SECURITY_REVIEW_CAPABILITY_PATTERN = /\bsecurity[-_\s]?review\b/i

class ReviewGateMaterializationOwnershipLost extends Error {
  constructor() {
    super('Review gate materialization ownership was lost.')
    this.name = 'ReviewGateMaterializationOwnershipLost'
  }
}

async function publishTaskEventBestEffort(
  taskId: string,
  type: string,
  payload: TaskEventPayload = {},
): Promise<void> {
  try {
    await publishTaskEvent(taskId, type, payload)
  } catch (err) {
    const message = sanitizeWorkerMessage(err instanceof Error ? err.message : String(err))
    console.warn('[review-gates] Failed to publish task event after DB commit', { taskId, type, message })
  }
}

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
  requiredRole: ReviewGateRequiredRole
  title: string
}

type MaterializedSourceArtifact = typeof artifacts.$inferSelect

type SourceRunCompletion = {
  artifactType: string
  completedAt: Date
  content: string
  metadata: Record<string, unknown> | null
}

export type ReviewGateMaterializationResult =
  | {
      status: 'not_found'
      packageStatus: null
      createdGates: []
      sourceArtifact?: null
    }
  | {
      status: 'not_owned'
      packageStatus: null
      createdGates: []
      sourceArtifact?: null
    }
  | {
      status: 'materialized' | 'already_materialized' | 'not_required'
      packageStatus: 'awaiting_review' | 'completed'
      createdGates: MaterializedGate[]
      sourceArtifact?: MaterializedSourceArtifact | null
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
  | {
      status: 'invalid_security_review_payload'
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

function cleanSecurityText(value: unknown, maxLength = 1000): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : ''
}

function cleanEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const refs: string[] = []
  for (const item of value) {
    const ref = cleanSecurityText(item, 500)
    if (ref === '') continue
    refs.push(ref)
    if (refs.length >= 20) break
  }
  return refs
}

function normalizeSecurityFinding(value: unknown): SecurityFindingV1 | null {
  if (!isRecord(value)) return null
  const finding: SecurityFindingV1 = {
    reviewSurface: cleanSecurityText(value.reviewSurface),
    asset: cleanSecurityText(value.asset),
    trustBoundary: cleanSecurityText(value.trustBoundary),
    exploitPath: cleanSecurityText(value.exploitPath),
    impact: cleanSecurityText(value.impact),
    requiredFix: cleanSecurityText(value.requiredFix),
    evidenceRefs: cleanEvidenceRefs(value.evidenceRefs),
    severity: cleanSecurityText(value.severity, 80).toLowerCase(),
    confidence: cleanSecurityText(value.confidence, 80).toLowerCase(),
    verificationState: cleanSecurityText(value.verificationState),
  }
  const requiredText = [
    finding.reviewSurface,
    finding.asset,
    finding.trustBoundary,
    finding.exploitPath,
    finding.impact,
    finding.requiredFix,
    finding.severity,
    finding.confidence,
    finding.verificationState,
  ]
  if (requiredText.some((field) => field === '') || finding.evidenceRefs.length === 0) return null
  return finding
}

function isSecurityReviewVerdict(value: unknown): value is 'findings' | 'no_findings' {
  return value === 'findings' || value === 'no_findings'
}

function normalizeNoFindings(value: unknown): SecurityReviewNoFindingsV1 | null {
  if (!isRecord(value)) return null
  const noFindings: SecurityReviewNoFindingsV1 = {
    reviewSurface: cleanSecurityText(value.reviewSurface),
    evidenceRefs: cleanEvidenceRefs(value.evidenceRefs),
    verificationState: cleanSecurityText(value.verificationState),
  }
  if (noFindings.reviewSurface === '' || noFindings.evidenceRefs.length === 0 || noFindings.verificationState === '') {
    return null
  }
  return noFindings
}

export function normalizeSecurityReviewPayload(value: unknown): SecurityReviewPayloadV1 | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null
  if (Array.isArray(value.findings) && value.findings.length > MAX_SECURITY_FINDINGS) return null
  const rawFindings = Array.isArray(value.findings) ? value.findings : []
  const findings: SecurityFindingV1[] = []
  for (const rawFinding of rawFindings) {
    const finding = normalizeSecurityFinding(rawFinding)
    if (!finding) return null
    findings.push(finding)
  }
  const noFindings = normalizeNoFindings(value.noFindings)
  if (findings.length > 0 && noFindings) return null
  if (findings.length === 0 && !noFindings) return null
  const verdict = findings.length > 0 ? 'findings' : 'no_findings'
  if (isSecurityReviewVerdict(value.verdict) && value.verdict !== verdict) return null
  return {
    schemaVersion: 1,
    findings,
    ...(noFindings ? { noFindings } : {}),
    summary: verdict === 'findings'
      ? `${findings.length} structured security finding${findings.length === 1 ? '' : 's'} recorded.`
      : noFindings?.verificationState,
    verdict,
  }
}

function securityReviewIncludesSourceArtifact(
  payload: SecurityReviewPayloadV1,
  sourceArtifactId: string,
): boolean {
  const evidenceGroups = payload.findings.length > 0
    ? payload.findings.map((finding) => finding.evidenceRefs)
    : payload.noFindings ? [payload.noFindings.evidenceRefs] : []
  return evidenceGroups.length > 0 &&
    evidenceGroups.every((refs) => refs.includes(sourceArtifactId))
}

function stampSecurityReviewPayload(input: {
  payload: SecurityReviewPayloadV1
  sourceAgentRunId: string
  sourceArtifactId: string
  workPackageId: string
}): Record<string, unknown> {
  return {
    ...input.payload,
    reviewedSource: {
      agentRunId: input.sourceAgentRunId,
      artifactId: input.sourceArtifactId,
      workPackageId: input.workPackageId,
    },
  }
}

// Caps so a pathologically deep/large JSONB metadata value can't blow the stack
// or build an unbounded string for the high-risk regex scan.
const FLATTEN_MAX_DEPTH = 8
const FLATTEN_MAX_ITEMS = 2000

function flattenStrings(value: unknown, result: string[] = [], depth = 0): string[] {
  if (depth > FLATTEN_MAX_DEPTH || result.length >= FLATTEN_MAX_ITEMS) return result

  if (typeof value === 'string') {
    result.push(value)
    return result
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (result.length >= FLATTEN_MAX_ITEMS) break
      flattenStrings(item, result, depth + 1)
    }
    return result
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      if (result.length >= FLATTEN_MAX_ITEMS) break
      flattenStrings(item, result, depth + 1)
    }
  }

  return result
}

export function isReviewGateType(value: string | null | undefined): value is ReviewGateType {
  return value === 'qa_review' || value === 'reviewer_review' || value === 'security_review'
}

export function requiredRoleForGate(gateType: ReviewGateType): ReviewGateRequiredRole {
  if (gateType === 'qa_review') return 'qa'
  if (gateType === 'security_review') return 'security'
  return 'reviewer'
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
    return `Security review must inspect high-risk implementation output from "${pkg.title}" and record structured findings or explicit no-findings evidence.`
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
  completeSourceRun?: SourceRunCompletion
  requireExecutionLease?: boolean
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

  let materialized: { createdGates: MaterializedGate[]; sourceArtifact: MaterializedSourceArtifact | null }
  try {
    materialized = await db.transaction(async (tx) => {
    const ownershipGuard = input.requireExecutionLease
      ? [
          eq(workPackages.status, 'running'),
          sql`${workPackages.metadata}->'executionLease'->>'runId' = ${input.sourceAgentRunId}`,
        ]
      : []
    const [updatedPackage] = await tx
      .update(workPackages)
      .set({
        blockedReason: null,
        metadata: sql`${workPackages.metadata} - 'executionLease'`,
        status: packageStatus,
        updatedAt: now,
      })
      .where(and(eq(workPackages.id, pkg.id), ...ownershipGuard))
      .returning({ id: workPackages.id })

    if (!updatedPackage) {
      throw new ReviewGateMaterializationOwnershipLost()
    }

    let sourceArtifactId = input.sourceArtifactId
    let sourceArtifact: MaterializedSourceArtifact | null = null
    if (input.completeSourceRun) {
      const [completedRun] = await tx
        .update(agentRuns)
        .set({
          completedAt: input.completeSourceRun.completedAt,
          status: 'completed',
        })
        .where(and(eq(agentRuns.id, input.sourceAgentRunId), eq(agentRuns.status, 'running')))
        .returning({ id: agentRuns.id })

      if (!completedRun) throw new ReviewGateMaterializationOwnershipLost()

      const [artifact] = await tx
        .insert(artifacts)
        .values({
          agentRunId: input.sourceAgentRunId,
          artifactType: input.completeSourceRun.artifactType,
          content: input.completeSourceRun.content,
          metadata: input.completeSourceRun.metadata,
        })
        .returning()
      if (!artifact) throw new ReviewGateMaterializationOwnershipLost()
      sourceArtifact = artifact ?? null
      sourceArtifactId = sourceArtifact?.id ?? null
    }

    if (!reviewRequired) {
      return { createdGates: [] as MaterializedGate[], sourceArtifact }
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
        (gate.sourceArtifactId !== sourceArtifactId || gate.sourceAgentRunId !== input.sourceAgentRunId)
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
          gate.sourceArtifactId === sourceArtifactId &&
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
          sourceArtifactId,
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

    return { createdGates: inserted, sourceArtifact }
  })
  } catch (err) {
    if (!(err instanceof ReviewGateMaterializationOwnershipLost)) throw err
    return { status: 'not_owned', packageStatus: null, createdGates: [] }
  }
  const { createdGates, sourceArtifact } = materialized

  await publishTaskEventBestEffort(input.taskId, 'work_package:status', {
    status: packageStatus,
    updatedAt: now.toISOString(),
    workPackageId: pkg.id,
  })

  for (const gate of createdGates) {
    await publishTaskEventBestEffort(input.taskId, 'approval_gate:created', {
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
    sourceArtifact,
  }
}

export async function completeTaskIfReviewGatesSatisfied(taskId: string): Promise<{
  status: 'completed' | 'blocked' | 'failed' | 'no_work_packages'
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

  // A 'failed' package is terminal: it will never become 'completed', and QA/
  // Reviewer packages that depend on it can never become ready. Left as a plain
  // "unfinished" block the task would loop between blocked and approved forever,
  // so fail the task with an actionable reason (e.g. create the missing agent
  // and retry) instead of hanging.
  const failedPackage = packages.find((pkg) => pkg.status === 'failed')
  if (failedPackage) {
    const reason = `Work package ${failedPackage.id} failed and cannot be completed. Resolve the cause and retry the task.`
    const failed =
      (await updateTaskStatusIfCurrent(taskId, 'running', 'failed', reason)) ||
      (await updateTaskStatusIfCurrent(taskId, 'approved', 'failed', reason))
    return { status: failed ? 'failed' : 'blocked', reason }
  }

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
  securityReview?: unknown
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
  const securityReviewPayload = gate.gateType === 'security_review'
    ? normalizeSecurityReviewPayload(input.securityReview)
    : null
  if (gate.gateType === 'security_review' && !securityReviewPayload) {
    return {
      status: 'invalid_security_review_payload',
      message: 'Security review decisions require SecurityFindingV1 findings or an explicit structured no-findings payload.',
    }
  }
  if (
    gate.gateType === 'security_review' &&
    securityReviewPayload &&
    !securityReviewIncludesSourceArtifact(securityReviewPayload, gate.sourceArtifactId)
  ) {
    return {
      status: 'invalid_security_review_payload',
      message: 'Security review evidenceRefs must include the reviewed source artifact.',
    }
  }
  if (
    gate.gateType === 'security_review' &&
    input.decision === 'completed' &&
    securityReviewPayload?.verdict === 'findings'
  ) {
    return {
      status: 'invalid_security_review_payload',
      message: 'Security review findings require requesting changes; approvals must submit an explicit no-findings payload.',
    }
  }
  if (
    gate.gateType === 'security_review' &&
    input.decision === 'needs_rework' &&
    securityReviewPayload?.verdict !== 'findings'
  ) {
    return {
      status: 'invalid_security_review_payload',
      message: 'Security review rework requires at least one structured SecurityFindingV1 finding.',
    }
  }
  const workPackageId = gate.workPackageId
  const sourceAgentRunId = gate.sourceAgentRunId
  const stampedSecurityReviewPayload = securityReviewPayload
    ? stampSecurityReviewPayload({
      payload: securityReviewPayload,
      sourceAgentRunId,
      sourceArtifactId: gate.sourceArtifactId,
      workPackageId,
    })
    : null

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
    .select({ id: artifacts.id, content: artifacts.content, metadata: artifacts.metadata })
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

  const protectedReviewSource = sourceArtifact.content === 'Protected review source available through its approval gate.'
    || (metadataRecord(sourceArtifact.metadata).protectedReviewSource === true)
  let protectedReviewSourceFingerprint: string | null = null
  if (protectedReviewSource) {
    try {
      const resolved = await resolveS4ReviewSourceV1({ approvalGateId: gate.id })
      if (
        resolved.sourceArtifactId !== gate.sourceArtifactId
        || resolved.sourceAgentRunId !== sourceAgentRunId
      ) {
        return {
          status: 'source_artifact_mismatch',
          message: 'Review gate source artifact changed. Reload the task before deciding this review.',
        }
      }
      // Content and metadata are purpose-bound and deliberately discarded at
      // this boundary. Only the safe digest is retained on the gate decision.
      protectedReviewSourceFingerprint = resolved.contentFingerprint
    } catch {
      return {
        status: 'source_artifact_mismatch',
        message: 'Review gate source artifact is not available. Reload the task before deciding this review.',
      }
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

  // A gate is stale only when a *newer run* has produced artifacts for this
  // package (a fresh execution attempt supersedes the one under review). Compare
  // by run rather than artifact id: a single execution run emits several
  // artifacts (repository readiness, diff, validation, final log) that all share
  // the source run, and createdAt ties between them must not be misread as a
  // superseding attempt.
  if (latestPackageArtifact && latestPackageArtifact.agentRunId !== sourceAgentRunId) {
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
      ...(stampedSecurityReviewPayload ? { securityReview: stampedSecurityReviewPayload } : {}),
      ...(protectedReviewSourceFingerprint ? { protectedReviewSourceFingerprint } : {}),
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

  await publishTaskEventBestEffort(input.taskId, 'approval_gate:decided', {
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
    await publishTaskEventBestEffort(input.taskId, 'approval_gate:decided', {
      gateId: cancelledGateId,
      reason: 'Package sent back for rework.',
      status: 'cancelled',
      updatedAt: now.toISOString(),
      workPackageId,
    })
  }

  if (decided.packageStatus) {
    await publishTaskEventBestEffort(input.taskId, 'work_package:status', {
      blockedReason: input.decision === 'needs_rework' ? reason : null,
      status: decided.packageStatus,
      updatedAt: now.toISOString(),
      workPackageId,
    })
  }

  const completion = decided.packageStatus === 'completed'
    ? await completeTaskIfReviewGatesSatisfied(input.taskId)
    : { status: 'blocked' as const }

  // A review barrier may have been the last reason a running task could not
  // return to its durable operator hold. Recheck after every existing
  // post-decision projection has consumed the committed review state; no wake
  // or claim is created here.
  try {
    await convergeRecognizedOperatorHoldTask(input.taskId)
  } catch (err) {
    // The review decision is already durable. Startup and periodic convergence
    // will retry this database-derived transition without relying on Redis.
    console.warn('[review-gates] Deferred operator-hold convergence to fallback sweep', err)
  }

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
