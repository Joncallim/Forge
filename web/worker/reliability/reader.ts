import { and, desc, eq, exists, gte, inArray, or } from 'drizzle-orm'

import { db } from '@/db'
import { capabilityAttemptAdjudications, capabilityAttempts, executionOutcomes } from '@/db/schema'
import {
  isExecutionOutcome,
  normalizeExecutionOutcome,
  type ExecutionOutcome,
} from '@/lib/execution-outcomes'
import { computeReliability } from '@/lib/reliability/metrics'
import {
  DEFAULT_RELIABILITY_WINDOW,
  outcomeDigest,
  type CapabilityAdjudicationRecord,
  type CapabilityAttemptRecord,
  type ReliabilitySummary,
  type ReliabilityWindow,
} from '@/lib/reliability/contracts'
import { sanitizeWorkerMessage } from '../redaction'

function storedOutcome(row: typeof executionOutcomes.$inferSelect): ExecutionOutcome | null {
  const candidate: unknown = {
    schemaVersion: row.schemaVersion,
    transportStatus: row.transportStatus,
    result: row.result,
    stopReasonCode: row.stopReasonCode,
    stopReasonSummary: row.stopReasonSummary,
    retryable: row.retryable,
    evidenceRefs: row.evidenceRefs,
    verifierRequired: row.verifierRequired,
    verificationStatus: row.verificationStatus,
  }
  if (!isExecutionOutcome(candidate)) return null
  return candidate
}

/**
 * Reads a cohort's attempts and adjudications, detects drift against the
 * linked execution_outcomes row, and computes the summary with the pure
 * metrics function. Performs no arithmetic itself and performs NO writes:
 * reading a cohort is side-effect-free (the CLI advertises this). Drift is
 * reported through the summary state, never appended to the ledger here.
 *
 * Two reads: the bounded rate sample (newest `maxAttempts` rows within
 * `maxAgeMs`) and the unbounded-by-age critical history. Critical rows are
 * rare, and the safety property (I7) requires them to stay visible whatever
 * the window, so the ledger's full critical history -- severity-class
 * critical rows plus rows with a rollback adjudication -- is fetched even
 * when it predates the sample.
 */
export async function readCohortReliability(input: {
  cohortFingerprint: string
  window?: ReliabilityWindow
  now?: Date
}): Promise<ReliabilitySummary> {
  const window = input.window ?? DEFAULT_RELIABILITY_WINDOW
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - window.maxAgeMs)

  const sampleRows = await db
    .select()
    .from(capabilityAttempts)
    .where(and(
      eq(capabilityAttempts.cohortFingerprint, input.cohortFingerprint),
      gte(capabilityAttempts.observedAt, cutoff),
    ))
    .orderBy(desc(capabilityAttempts.observedAt))
    .limit(window.maxAttempts)

  const criticalHistoryRows = await db
    .select()
    .from(capabilityAttempts)
    .where(and(
      eq(capabilityAttempts.cohortFingerprint, input.cohortFingerprint),
      or(
        eq(capabilityAttempts.severityClass, 'critical'),
        exists(db
          .select({ id: capabilityAttemptAdjudications.id })
          .from(capabilityAttemptAdjudications)
          .where(and(
            eq(capabilityAttemptAdjudications.capabilityAttemptId, capabilityAttempts.id),
            eq(capabilityAttemptAdjudications.kind, 'rollback_recorded'),
          ))),
      ),
    ))
    .orderBy(desc(capabilityAttempts.observedAt))

  const sampleIds = new Set(sampleRows.map((row) => row.id))
  const attemptRows = [...sampleRows]
  for (const row of criticalHistoryRows) {
    if (!sampleIds.has(row.id)) attemptRows.push(row)
  }

  if (attemptRows.length === 0) {
    return computeReliability({ attempts: [], adjudications: [], window, now })
  }

  const outcomeIds = [...new Set(attemptRows.map((r) => r.executionOutcomeId))]
  const outcomeRows = await db
    .select()
    .from(executionOutcomes)
    .where(inArray(executionOutcomes.id, outcomeIds))
  const outcomesById = new Map(outcomeRows.map((row) => [row.id, row]))

  const attempts: CapabilityAttemptRecord[] = []
  for (const row of attemptRows) {
    const outcomeRow = outcomesById.get(row.executionOutcomeId)
    let currentDigest: string | undefined
    if (outcomeRow) {
      const outcome = storedOutcome(outcomeRow)
      if (outcome) {
        const normalized = normalizeExecutionOutcome(outcome, sanitizeWorkerMessage)
        currentDigest = outcomeDigest(normalized)
      }
    }
    attempts.push({
      id: row.id,
      attemptGroupId: row.attemptGroupId,
      executionOutcomeId: row.executionOutcomeId,
      capabilityKey: row.capabilityKey,
      classificationState: row.classificationState as CapabilityAttemptRecord['classificationState'],
      capabilityMultiplicity: row.capabilityMultiplicity,
      cohortFingerprint: row.cohortFingerprint,
      outcomeDigest: row.outcomeDigest,
      transportStatus: row.transportStatus as CapabilityAttemptRecord['transportStatus'],
      result: row.result as CapabilityAttemptRecord['result'],
      stopReasonCode: row.stopReasonCode,
      retryable: row.retryable,
      attemptNumber: row.attemptNumber,
      severityClass: row.severityClass as CapabilityAttemptRecord['severityClass'],
      verifierRequired: row.verifierRequired,
      verificationMode: row.verificationMode as CapabilityAttemptRecord['verificationMode'],
      verificationStatus: row.verificationStatus as CapabilityAttemptRecord['verificationStatus'],
      observedAt: row.observedAt.toISOString(),
      currentOutcomeDigest: currentDigest,
    })
  }

  const attemptIds = attempts.map((a) => a.id)
  const adjudicationRows = attemptIds.length > 0
    ? await db
      .select()
      .from(capabilityAttemptAdjudications)
      .where(inArray(capabilityAttemptAdjudications.capabilityAttemptId, attemptIds))
    : []

  const adjudications: CapabilityAdjudicationRecord[] = adjudicationRows.map((row) => ({
    id: row.id,
    capabilityAttemptId: row.capabilityAttemptId,
    sequence: row.sequence,
    kind: row.kind as CapabilityAdjudicationRecord['kind'],
    verificationMode: row.verificationMode as CapabilityAdjudicationRecord['verificationMode'],
    verificationResult: row.verificationResult as CapabilityAdjudicationRecord['verificationResult'],
    humanDecision: row.humanDecision as CapabilityAdjudicationRecord['humanDecision'],
    observedAt: row.observedAt.toISOString(),
  }))

  return computeReliability({ attempts, adjudications, window, now })
}
