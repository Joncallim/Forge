import { randomUUID } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'

import { db } from '@/db'
import { capabilityAttemptAdjudications, capabilityAttempts, executionOutcomes } from '@/db/schema'
import type { ExecutionOutcome } from '@/lib/execution-outcomes'
import {
  MAX_CAPABILITY_FAN_OUT,
  cohortFingerprint,
  isValidCapabilityKey,
  outcomeDigest,
  policyFingerprint,
  runtimeFingerprint,
  scopeFingerprint,
  unclassifiedCapabilityKey,
  type CapabilityVerificationResult,
  type HumanDecision,
  type ReliabilityPolicyInput,
  type ReliabilityRuntimeInput,
  type ReliabilityScopeInput,
  type SeverityClass,
  type VerificationMode,
} from '@/lib/reliability/contracts'
import { defaultOnFeatureFlagEnabled } from '../feature-flags'

export type CapabilitySource =
  | { kind: 'work_package'; role: string; capabilities: string[] | null }
  | { kind: 'operation'; operationId: string; operationVersion: number }

export type RecordCapabilityAttemptsInput = {
  projectId: string
  taskId: string
  workPackageId: string | null
  agentRunId: string | null
  taskAttemptId: string | null
  executionOutcomeId: string
  operationRunId: string | null
  outcome: ExecutionOutcome
  attemptNumber: number
  source: CapabilitySource
  scope: ReliabilityScopeInput
  runtime: ReliabilityRuntimeInput
  policy: ReliabilityPolicyInput
  verificationMode: VerificationMode
  acceptanceCriteriaTotal: number
  validationCommandTotal: number
  validationCommandFailed: number
  observedAt: Date
}

function ledgerEnabled(): boolean {
  return defaultOnFeatureFlagEnabled(process.env.FORGE_CAPABILITY_RELIABILITY_LEDGER)
}

function slugifyRoleSegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug.length > 0 ? slug : 'unassigned'
}

function severityFor(input: RecordCapabilityAttemptsInput): SeverityClass {
  if (input.outcome.stopReasonCode === 'security_blocked' || input.outcome.stopReasonCode === 'policy_blocked') {
    return 'critical'
  }
  if (input.scope.repositoryWriteIntent && input.validationCommandFailed > 0) return 'critical'
  return 'normal'
}

function resolveCapabilityKeys(source: CapabilitySource): {
  keys: string[]
  classificationState: 'classified' | 'missing' | 'overflow'
} {
  if (source.kind === 'operation') {
    return {
      keys: [`operation:${source.operationId}@${source.operationVersion}`],
      classificationState: 'classified',
    }
  }
  const role = slugifyRoleSegment(source.role)
  const raw = source.capabilities ?? []
  const normalized = [...new Set(raw.filter((c) => typeof c === 'string' && c.trim().length > 0))]
  if (normalized.length === 0) {
    return { keys: [unclassifiedCapabilityKey(role)], classificationState: 'missing' }
  }
  if (normalized.length > MAX_CAPABILITY_FAN_OUT) {
    return { keys: [unclassifiedCapabilityKey(role)], classificationState: 'overflow' }
  }
  return {
    keys: normalized.map((capability) => `workpackage:${role}/${capability}`),
    classificationState: 'classified',
  }
}

/**
 * Idempotently records one capability-attempt row per exercised capability,
 * sharing an attempt_group_id and multiplicity count. Best-effort by design:
 * a ledger write failure never fails the caller's task, package, run, or
 * operation (see recordCapabilityAttemptsBestEffort).
 */
export async function recordCapabilityAttempts(input: RecordCapabilityAttemptsInput): Promise<void> {
  if (!ledgerEnabled()) return

  // independent_agent has no producer until #188; refuse rather than store
  // an unbacked verification claim.
  if (input.outcome.verifierRequired && input.verificationMode === 'independent_agent') return

  const { keys, classificationState } = resolveCapabilityKeys(input.source)
  const validKeys = keys.filter(isValidCapabilityKey)
  if (validKeys.length === 0) return

  const scopeFp = scopeFingerprint(input.scope)
  const runtimeFp = runtimeFingerprint(input.runtime)
  const policyFp = policyFingerprint(input.policy)
  const digest = outcomeDigest(input.outcome)
  const attemptGroupId = randomUUID()
  const multiplicity = validKeys.length
  const verificationMode = input.outcome.verifierRequired ? input.verificationMode : 'none'

  const rows = validKeys.map((capabilityKey) => ({
    id: randomUUID(),
    attemptGroupId,
    projectId: input.projectId,
    taskId: input.taskId,
    workPackageId: input.workPackageId,
    agentRunId: input.agentRunId,
    taskAttemptId: input.taskAttemptId,
    executionOutcomeId: input.executionOutcomeId,
    operationRunId: input.operationRunId,
    contractVersion: 1,
    capabilityKey,
    classificationState,
    capabilityMultiplicity: multiplicity,
    cohortFingerprint: cohortFingerprint({
      projectId: input.projectId,
      capabilityKey,
      scopeFingerprint: scopeFp,
      runtimeFingerprint: runtimeFp,
      policyFingerprint: policyFp,
    }),
    scopeFingerprint: scopeFp,
    runtimeFingerprint: runtimeFp,
    policyFingerprint: policyFp,
    outcomeDigest: digest,
    transportStatus: input.outcome.transportStatus,
    result: input.outcome.result,
    stopReasonCode: input.outcome.stopReasonCode,
    retryable: input.outcome.retryable,
    attemptNumber: input.attemptNumber,
    severityClass: severityFor(input),
    verifierRequired: input.outcome.verifierRequired,
    verificationMode,
    verificationStatus: input.outcome.verificationStatus,
    acceptanceCriteriaTotal: input.acceptanceCriteriaTotal,
    validationCommandTotal: input.validationCommandTotal,
    validationCommandFailed: input.validationCommandFailed,
    evidenceRefs: input.outcome.evidenceRefs,
    observedAt: input.observedAt,
  }))

  await db
    .insert(capabilityAttempts)
    .values(rows)
    .onConflictDoNothing({
      target: [capabilityAttempts.executionOutcomeId, capabilityAttempts.capabilityKey],
    })
}

export async function recordCapabilityAttemptsBestEffort(input: RecordCapabilityAttemptsInput): Promise<void> {
  try {
    await recordCapabilityAttempts(input)
  } catch {
    // Best-effort: the ledger is an interpretation layer, never a gate.
  }
}

async function nextAdjudicationSequence(capabilityAttemptId: string): Promise<number> {
  const [last] = await db
    .select({ sequence: capabilityAttemptAdjudications.sequence })
    .from(capabilityAttemptAdjudications)
    .where(eq(capabilityAttemptAdjudications.capabilityAttemptId, capabilityAttemptId))
    .orderBy(desc(capabilityAttemptAdjudications.sequence))
    .limit(1)
  return last ? last.sequence + 1 : 0
}

async function findAttemptRowsForOutcome(executionOutcomeId: string): Promise<Array<{ id: string }>> {
  return db
    .select({ id: capabilityAttempts.id })
    .from(capabilityAttempts)
    .where(eq(capabilityAttempts.executionOutcomeId, executionOutcomeId))
}

async function findAttemptRowsForAttemptKey(taskId: string, attemptKey: string): Promise<Array<{ id: string }>> {
  const [outcome] = await db
    .select({ id: executionOutcomes.id })
    .from(executionOutcomes)
    .where(and(eq(executionOutcomes.taskId, taskId), eq(executionOutcomes.attemptKey, attemptKey)))
    .limit(1)
  if (!outcome) return []
  return findAttemptRowsForOutcome(outcome.id)
}

/** Appends one verification_recorded adjudication per attempt row linked to (taskId, attemptKey). */
export async function recordVerificationAdjudicationBestEffort(input: {
  taskId: string
  attemptKey: string
  verificationMode: Exclude<VerificationMode, 'none'>
  verificationResult: CapabilityVerificationResult
  observedAt: Date
}): Promise<void> {
  if (!ledgerEnabled()) return
  try {
    const rows = await findAttemptRowsForAttemptKey(input.taskId, input.attemptKey)
    for (const row of rows) {
      const sequence = await nextAdjudicationSequence(row.id)
      await db.insert(capabilityAttemptAdjudications).values({
        capabilityAttemptId: row.id,
        sequence,
        kind: 'verification_recorded',
        verificationMode: input.verificationMode,
        verificationResult: input.verificationResult,
        observedAt: input.observedAt,
      })
    }
  } catch {
    // Best-effort: a missing attempt (ledger disabled window, or predates
    // this table) is missing evidence, not an error to escalate.
  }
}

/** Appends one human_decision adjudication per attempt row linked to (taskId, attemptKey). */
export async function recordHumanDecisionAdjudicationBestEffort(input: {
  taskId: string
  attemptKey: string
  humanDecision: HumanDecision
  decidedBy: string | null
  approvalGateId: string | null
  observedAt: Date
}): Promise<void> {
  if (!ledgerEnabled()) return
  try {
    const rows = await findAttemptRowsForAttemptKey(input.taskId, input.attemptKey)
    for (const row of rows) {
      const sequence = await nextAdjudicationSequence(row.id)
      await db.insert(capabilityAttemptAdjudications).values({
        capabilityAttemptId: row.id,
        sequence,
        kind: 'human_decision',
        humanDecision: input.humanDecision,
        decidedBy: input.decidedBy,
        approvalGateId: input.approvalGateId,
        observedAt: input.observedAt,
      })
    }
  } catch {
    // Best-effort, same rationale as above.
  }
}

/** Appends one evidence_drift_detected adjudication for a single attempt row. */
export async function recordEvidenceDriftAdjudicationBestEffort(input: {
  capabilityAttemptId: string
  observedOutcomeDigest: string
  observedAt: Date
}): Promise<void> {
  if (!ledgerEnabled()) return
  try {
    const sequence = await nextAdjudicationSequence(input.capabilityAttemptId)
    await db.insert(capabilityAttemptAdjudications).values({
      capabilityAttemptId: input.capabilityAttemptId,
      sequence,
      kind: 'evidence_drift_detected',
      observedOutcomeDigest: input.observedOutcomeDigest,
      observedAt: input.observedAt,
    })
  } catch {
    // Best-effort.
  }
}
