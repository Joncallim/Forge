import type {
  CapabilityAdjudicationRecord,
  CapabilityAttemptRecord,
  ReliabilityRates,
  ReliabilitySummary,
  ReliabilityWindow,
} from './contracts'

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return numerator / denominator
}

function isCritical(attempt: CapabilityAttemptRecord, adjudications: CapabilityAdjudicationRecord[]): boolean {
  if (attempt.severityClass === 'critical') return true
  return adjudications.some((a) => a.kind === 'rollback_recorded')
}

function latestHumanDecision(adjudications: CapabilityAdjudicationRecord[]): CapabilityAdjudicationRecord | null {
  const decisions = adjudications
    .filter((a) => a.kind === 'human_decision')
    .sort((a, b) => a.sequence - b.sequence)
  return decisions.length > 0 ? decisions[decisions.length - 1] : null
}

function latestVerification(adjudications: CapabilityAdjudicationRecord[]): CapabilityAdjudicationRecord | null {
  const verifications = adjudications
    .filter((a) => a.kind === 'verification_recorded')
    .sort((a, b) => a.sequence - b.sequence)
  return verifications.length > 0 ? verifications[verifications.length - 1] : null
}

function isIndependentlyVerifiedPass(adjudications: CapabilityAdjudicationRecord[]): boolean {
  const latest = latestVerification(adjudications)
  if (!latest) return false
  return (latest.verificationMode === 'deterministic_adapter' || latest.verificationMode === 'independent_agent')
    && latest.verificationResult === 'passed'
}

function hasRollback(adjudications: CapabilityAdjudicationRecord[]): boolean {
  return adjudications.some((a) => a.kind === 'rollback_recorded')
}

/**
 * Pure function: no clock, no I/O. Every rate is null when its denominator is
 * zero. Below minSamples or under any evidence drift, all rates are null but
 * critical counts are still reported.
 */
export function computeReliability(input: {
  attempts: CapabilityAttemptRecord[]
  adjudications: CapabilityAdjudicationRecord[]
  window: ReliabilityWindow
  now: Date
}): ReliabilitySummary {
  const { window, now } = input
  const adjudicationsByAttempt = new Map<string, CapabilityAdjudicationRecord[]>()
  for (const adj of input.adjudications) {
    const list = adjudicationsByAttempt.get(adj.capabilityAttemptId) ?? []
    list.push(adj)
    adjudicationsByAttempt.set(adj.capabilityAttemptId, list)
  }

  const cutoff = now.getTime() - window.maxAgeMs
  const sorted = [...input.attempts].sort(
    (a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime(),
  )

  const inWindow: CapabilityAttemptRecord[] = []
  let outsideWindowCount = 0
  for (const attempt of sorted) {
    if (inWindow.length >= window.maxAttempts) {
      outsideWindowCount += 1
      continue
    }
    if (new Date(attempt.observedAt).getTime() < cutoff) {
      outsideWindowCount += 1
      continue
    }
    inWindow.push(attempt)
  }

  const cohortFingerprint = input.attempts[0]?.cohortFingerprint ?? ''
  const capabilityKey = input.attempts[0]?.capabilityKey ?? ''

  // Critical failures are reported unconditionally, whatever state we end in
  // (I7). They are computed over the FULL attempt set, not just the bounded
  // in-window rate sample: the reader supplies critical-history rows that
  // fall outside maxAgeMs/maxAttempts precisely so an old critical failure
  // can never scroll out of sight. Rates still use only inWindow below.
  let criticalFailureCount = 0
  let lastCriticalAt: string | null = null
  for (const attempt of sorted) {
    const adjs = adjudicationsByAttempt.get(attempt.id) ?? []
    if (isCritical(attempt, adjs)) {
      criticalFailureCount += 1
      if (!lastCriticalAt || new Date(attempt.observedAt) > new Date(lastCriticalAt)) {
        lastCriticalAt = attempt.observedAt
      }
    }
  }

  const driftedAttempts = inWindow.filter(
    (a) => a.currentOutcomeDigest !== undefined && a.currentOutcomeDigest !== a.outcomeDigest,
  )
  const driftedAttemptCount = driftedAttempts.length

  const newestObservedAt = inWindow.length > 0 ? inWindow[0].observedAt : null
  const oldestObservedAt = inWindow.length > 0 ? inWindow[inWindow.length - 1].observedAt : null
  const freshnessMs = newestObservedAt ? now.getTime() - new Date(newestObservedAt).getTime() : null

  const excluded: ReliabilitySummary['excluded'] = []
  if (outsideWindowCount > 0) excluded.push({ reason: 'outside_window', count: outsideWindowCount })
  if (driftedAttemptCount > 0) excluded.push({ reason: 'drifted', count: driftedAttemptCount })

  const evidence = { newestObservedAt, oldestObservedAt, freshnessMs, driftedAttemptCount }

  if (driftedAttemptCount > 0) {
    return {
      schemaVersion: 1,
      cohortFingerprint,
      capabilityKey,
      state: 'evidence_drift',
      sampleCount: inWindow.length,
      uniqueAttemptCount: new Set(inWindow.map((a) => a.attemptGroupId)).size,
      rates: emptyRates(),
      consecutiveVerifiedPasses: 0,
      criticalFailureCount,
      lastCriticalAt,
      evidence,
      excluded,
    }
  }

  if (inWindow.length < window.minSamples) {
    return {
      schemaVersion: 1,
      cohortFingerprint,
      capabilityKey,
      state: 'insufficient_evidence',
      sampleCount: inWindow.length,
      uniqueAttemptCount: new Set(inWindow.map((a) => a.attemptGroupId)).size,
      rates: emptyRates(),
      consecutiveVerifiedPasses: 0,
      criticalFailureCount,
      lastCriticalAt,
      evidence,
      excluded,
    }
  }

  let firstAttemptTotal = 0
  let firstAttemptSuccess = 0
  let verifierRequiredTotal = 0
  let verifiedPassTotal = 0
  let completedTotal = 0
  let unverifiedCompletionTotal = 0
  let repairRetryTotal = 0
  let humanDecisionTotal = 0
  let humanAcceptedTotal = 0
  let humanRejectedTotal = 0
  let rollbackTotal = 0
  let policyBlockTotal = 0

  for (const attempt of inWindow) {
    const adjs = adjudicationsByAttempt.get(attempt.id) ?? []

    if (attempt.attemptNumber === 1) {
      firstAttemptTotal += 1
      if (attempt.result === 'completed') firstAttemptSuccess += 1
    } else {
      repairRetryTotal += 1
    }

    if (attempt.verifierRequired) {
      verifierRequiredTotal += 1
      if (isIndependentlyVerifiedPass(adjs)) verifiedPassTotal += 1
    }

    if (attempt.result === 'completed') {
      completedTotal += 1
      if (!isIndependentlyVerifiedPass(adjs)) unverifiedCompletionTotal += 1
    }

    const humanDecision = latestHumanDecision(adjs)
    if (humanDecision) {
      humanDecisionTotal += 1
      if (humanDecision.humanDecision === 'accepted') humanAcceptedTotal += 1
      if (humanDecision.humanDecision === 'rejected') humanRejectedTotal += 1
    }

    if (hasRollback(adjs)) rollbackTotal += 1
    if (attempt.result === 'blocked') policyBlockTotal += 1
  }

  const rates: ReliabilityRates = {
    firstAttemptSuccess: rate(firstAttemptSuccess, firstAttemptTotal),
    independentlyVerifiedPass: rate(verifiedPassTotal, verifierRequiredTotal),
    humanAccepted: rate(humanAcceptedTotal, humanDecisionTotal),
    unverifiedCompletion: rate(unverifiedCompletionTotal, completedTotal),
    repairRetry: rate(repairRetryTotal, inWindow.length),
    humanRejection: rate(humanRejectedTotal, humanDecisionTotal),
    rollback: rate(rollbackTotal, inWindow.length),
    policyBlock: rate(policyBlockTotal, inWindow.length),
  }

  let consecutiveVerifiedPasses = 0
  for (const attempt of inWindow) {
    const adjs = adjudicationsByAttempt.get(attempt.id) ?? []
    if (isIndependentlyVerifiedPass(adjs)) {
      consecutiveVerifiedPasses += 1
    } else {
      break
    }
  }

  return {
    schemaVersion: 1,
    cohortFingerprint,
    capabilityKey,
    state: 'ready',
    sampleCount: inWindow.length,
    uniqueAttemptCount: new Set(inWindow.map((a) => a.attemptGroupId)).size,
    rates,
    consecutiveVerifiedPasses,
    criticalFailureCount,
    lastCriticalAt,
    evidence,
    excluded,
  }
}

function emptyRates(): ReliabilityRates {
  return {
    firstAttemptSuccess: null,
    independentlyVerifiedPass: null,
    humanAccepted: null,
    unverifiedCompletion: null,
    repairRetry: null,
    humanRejection: null,
    rollback: null,
    policyBlock: null,
  }
}
