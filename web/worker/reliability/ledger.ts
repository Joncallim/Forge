import { randomUUID } from 'node:crypto'

import { and, desc, eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { capabilityAttemptAdjudications, capabilityAttempts, executionOutcomes } from '@/db/schema'
import { normalizeExecutionOutcome, type ExecutionOutcome } from '@/lib/execution-outcomes'
import {
  MAX_CAPABILITY_FAN_OUT,
  cohortFingerprint,
  isValidCapabilityKey,
  outcomeDigest,
  policyFingerprint,
  runtimeFingerprint,
  scopeFingerprint,
  unclassifiedCapabilityKey,
  type AdjudicationKind,
  type CapabilityVerificationResult,
  type HumanDecision,
  type ReliabilityPolicyInput,
  type ReliabilityRuntimeInput,
  type ReliabilityScopeInput,
  type SeverityClass,
  type VerificationMode,
} from '@/lib/reliability/contracts'
import { defaultOnFeatureFlagEnabled } from '../feature-flags'
import { sanitizeWorkerMessage } from '../redaction'

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
  // The digest must be computed over the same canonical, normalized form the
  // reader recomputes from the linked execution_outcomes row: the stored row
  // holds the sanitized/truncated summary, so digesting the raw in-memory
  // outcome here would mismatch the read side for every redacted or truncated
  // failure message and permanently mark the attempt as drifted. Normalizing
  // again is idempotent for outcomes already read back from a stored row.
  const digest = outcomeDigest(normalizeExecutionOutcome(input.outcome, sanitizeWorkerMessage))
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

type AdjudicationValues = {
  kind: AdjudicationKind
  verificationMode?: VerificationMode | null
  verificationResult?: CapabilityVerificationResult | null
  humanDecision?: HumanDecision | null
  decidedBy?: string | null
  approvalGateId?: string | null
  observedAt: Date
}

/**
 * Appends one adjudication under a transaction-scoped advisory lock keyed on
 * the attempt id. Sequence allocation and insertion happen in the same
 * transaction so concurrent writers (e.g. QA and reviewer gates decided at
 * the same moment for the same attempt) serialize here instead of both
 * reading the same maximum sequence and silently dropping the second
 * decision. The lock is an advisory lock rather than SELECT ... FOR UPDATE
 * because the ordinary application role deliberately has no UPDATE privilege
 * on the attempt table; the migration's insert guard takes the same lock and
 * re-checks gapless order, so the two can never disagree.
 */
async function appendAdjudication(capabilityAttemptId: string, values: AdjudicationValues): Promise<void> {
  // The migration's insert guard derives its lock key from the canonical
  // uuid::text form; normalize here so a non-canonical spelling (e.g. an
  // uppercase id from a future caller) can never derive a different key and
  // silently disable cross-writer serialization.
  const lockKey = capabilityAttemptId.toLowerCase()
  await db.transaction(async (tx) => {
    // Bound the advisory-lock wait: the critical section is milliseconds, so
    // 5s is generous, but a peer that parks the lock must not be able to pin
    // this connection (and its worker) indefinitely.
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`)
    await tx.execute(sql`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(${lockKey}::text, 0)
      )
    `)
    const [last] = await tx
      .select({ sequence: capabilityAttemptAdjudications.sequence })
      .from(capabilityAttemptAdjudications)
      .where(eq(capabilityAttemptAdjudications.capabilityAttemptId, capabilityAttemptId))
      .orderBy(desc(capabilityAttemptAdjudications.sequence))
      .limit(1)
    await tx.insert(capabilityAttemptAdjudications).values({
      capabilityAttemptId,
      sequence: last ? last.sequence + 1 : 0,
      ...values,
    })
  })
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
      await appendAdjudication(row.id, {
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

/**
 * Appends one deterministic_adapter verification_recorded adjudication per
 * attempt row of an operation outcome. ADR 0011 canonical outcomes always
 * carry verifier_required = false, so the schema forbids storing the run's
 * verdict on the attempt row itself; the adjudication is where the
 * deterministic verdict belongs. Only called once the run reached a real
 * verdict ('passed' or 'failed') -- blocked or aborted runs have no verdict
 * to record.
 */
export async function recordDeterministicAdapterVerdictBestEffort(input: {
  executionOutcomeId: string
  verificationResult: CapabilityVerificationResult
  observedAt: Date
}): Promise<void> {
  if (!ledgerEnabled()) return
  try {
    const rows = await findAttemptRowsForOutcome(input.executionOutcomeId)
    for (const row of rows) {
      await appendAdjudication(row.id, {
        kind: 'verification_recorded',
        verificationMode: 'deterministic_adapter',
        verificationResult: input.verificationResult,
        observedAt: input.observedAt,
      })
    }
  } catch {
    // Best-effort, same rationale as above.
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
      await appendAdjudication(row.id, {
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
