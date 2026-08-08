import { describe, expect, it } from 'vitest'

import { computeReliability } from '@/lib/reliability/metrics'
import type {
  CapabilityAdjudicationRecord,
  CapabilityAttemptRecord,
  ReliabilityWindow,
} from '@/lib/reliability/contracts'

const WINDOW: ReliabilityWindow = { maxAttempts: 50, maxAgeMs: 90 * 24 * 60 * 60 * 1000, minSamples: 5 }
const NOW = new Date('2026-08-01T00:00:00.000Z')

let attemptCounter = 0
function attempt(overrides: Partial<CapabilityAttemptRecord> = {}): CapabilityAttemptRecord {
  attemptCounter += 1
  const id = overrides.id ?? `attempt-${attemptCounter}`
  return {
    id,
    attemptGroupId: overrides.attemptGroupId ?? id,
    executionOutcomeId: `outcome-${attemptCounter}`,
    capabilityKey: 'workpackage:backend/api-implementation',
    classificationState: 'classified',
    capabilityMultiplicity: 1,
    cohortFingerprint: 'a'.repeat(64),
    outcomeDigest: 'b'.repeat(64),
    transportStatus: 'ok',
    result: 'completed',
    stopReasonCode: null,
    retryable: false,
    attemptNumber: 1,
    severityClass: 'normal',
    verifierRequired: false,
    verificationMode: 'none',
    verificationStatus: 'not_required',
    observedAt: NOW.toISOString(),
    ...overrides,
  }
}

function verification(
  attemptId: string,
  overrides: Partial<CapabilityAdjudicationRecord> = {},
): CapabilityAdjudicationRecord {
  return {
    id: `adj-${attemptId}-${overrides.sequence ?? 0}`,
    capabilityAttemptId: attemptId,
    sequence: 0,
    kind: 'verification_recorded',
    verificationMode: 'deterministic_adapter',
    verificationResult: 'passed',
    humanDecision: null,
    observedAt: NOW.toISOString(),
    ...overrides,
  }
}

describe('computeReliability', () => {
  it('is a pure function: identical inputs produce byte-identical output', () => {
    const attempts = Array.from({ length: 6 }, () => attempt())
    const a = computeReliability({ attempts, adjudications: [], window: WINDOW, now: NOW })
    const b = computeReliability({ attempts, adjudications: [], window: WINDOW, now: NOW })
    expect(a).toEqual(b)
  })

  it('reports insufficient_evidence with all-null rates below minSamples', () => {
    const attempts = Array.from({ length: 3 }, () => attempt())
    const summary = computeReliability({ attempts, adjudications: [], window: WINDOW, now: NOW })
    expect(summary.state).toBe('insufficient_evidence')
    expect(Object.values(summary.rates).every((rate) => rate === null)).toBe(true)
  })

  it('reports a critical failure regardless of the aggregate pass rate', () => {
    const attempts = [
      ...Array.from({ length: 20 }, () => attempt({ result: 'completed' })),
      attempt({ result: 'blocked', stopReasonCode: 'security_blocked', severityClass: 'critical' }),
    ]
    const summary = computeReliability({ attempts, adjudications: [], window: WINDOW, now: NOW })
    expect(summary.criticalFailureCount).toBe(1)
    expect(summary.lastCriticalAt).not.toBeNull()
  })

  it('never counts self_reported or human_review as an independently verified pass', () => {
    const attempts = Array.from({ length: 10 }, () =>
      attempt({ verifierRequired: true, verificationMode: 'human_review', verificationStatus: 'passed' }))
    const adjudications = attempts.map((a) => verification(a.id, { verificationMode: 'human_review', verificationResult: 'passed' }))
    const summary = computeReliability({ attempts, adjudications, window: WINDOW, now: NOW })
    expect(summary.rates.independentlyVerifiedPass).toBe(0)
    expect(summary.rates.unverifiedCompletion).toBe(1)
  })

  it('counts deterministic_adapter verification as independently verified', () => {
    const attempts = Array.from({ length: 10 }, () =>
      attempt({ verifierRequired: true, verificationMode: 'deterministic_adapter', verificationStatus: 'passed' }))
    const adjudications = attempts.map((a) => verification(a.id))
    const summary = computeReliability({ attempts, adjudications, window: WINDOW, now: NOW })
    expect(summary.rates.independentlyVerifiedPass).toBe(1)
    expect(summary.rates.unverifiedCompletion).toBe(0)
  })

  it('resets consecutiveVerifiedPasses at the first non-verified row from the newest attempt', () => {
    const older = attempt({ observedAt: new Date(NOW.getTime() - 5000).toISOString(), verifierRequired: true, verificationMode: 'deterministic_adapter' })
    const middle = attempt({ observedAt: new Date(NOW.getTime() - 4000).toISOString(), verifierRequired: false, verificationMode: 'none' })
    const newer1 = attempt({ observedAt: new Date(NOW.getTime() - 3000).toISOString(), verifierRequired: true, verificationMode: 'deterministic_adapter' })
    const newer2 = attempt({ observedAt: new Date(NOW.getTime() - 2000).toISOString(), verifierRequired: true, verificationMode: 'deterministic_adapter' })
    const pad = Array.from({ length: 3 }, () => attempt({ observedAt: new Date(NOW.getTime() - 6000).toISOString() }))
    const attempts = [...pad, older, middle, newer1, newer2]
    const adjudications = [older, newer1, newer2].map((a) => verification(a.id))
    const summary = computeReliability({ attempts, adjudications, window: WINDOW, now: NOW })
    // newest two are verified passes, then a non-verified attempt breaks the streak.
    expect(summary.consecutiveVerifiedPasses).toBe(2)
  })

  it('returns null rates when a denominator is zero, never 0 or 1', () => {
    const attempts = Array.from({ length: 5 }, () => attempt({ attemptNumber: 2, verifierRequired: false }))
    const summary = computeReliability({ attempts, adjudications: [], window: WINDOW, now: NOW })
    expect(summary.rates.firstAttemptSuccess).toBeNull()
    expect(summary.rates.independentlyVerifiedPass).toBeNull()
    expect(summary.rates.humanAccepted).toBeNull()
    expect(summary.rates.humanRejection).toBeNull()
  })

  it('suppresses all rates and reports evidence_drift when an attempt has drifted, but keeps critical counts', () => {
    const attempts = [
      ...Array.from({ length: 5 }, () => attempt()),
      attempt({ result: 'blocked', severityClass: 'critical', currentOutcomeDigest: 'c'.repeat(64) }),
    ]
    const summary = computeReliability({ attempts, adjudications: [], window: WINDOW, now: NOW })
    expect(summary.state).toBe('evidence_drift')
    expect(Object.values(summary.rates).every((rate) => rate === null)).toBe(true)
    expect(summary.criticalFailureCount).toBe(1)
    expect(summary.evidence.driftedAttemptCount).toBe(1)
  })

  it('reports sampleCount by row and uniqueAttemptCount by attempt group for a multi-capability failure', () => {
    const groupId = 'group-1'
    const attempts = [
      ...Array.from({ length: 4 }, () => attempt()),
      attempt({ attemptGroupId: groupId, capabilityMultiplicity: 5 }),
      attempt({ attemptGroupId: groupId, capabilityMultiplicity: 5 }),
      attempt({ attemptGroupId: groupId, capabilityMultiplicity: 5 }),
      attempt({ attemptGroupId: groupId, capabilityMultiplicity: 5 }),
      attempt({ attemptGroupId: groupId, capabilityMultiplicity: 5 }),
    ]
    const summary = computeReliability({ attempts, adjudications: [], window: WINDOW, now: NOW })
    expect(summary.sampleCount).toBe(9)
    // 4 solo attempts (each its own group) + 1 shared group of 5 = 5 unique groups.
    expect(summary.uniqueAttemptCount).toBe(5)
  })
})
