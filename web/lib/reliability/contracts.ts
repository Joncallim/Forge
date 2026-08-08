import { createHash } from 'node:crypto'

import { canonicalJson, isPlainRecord } from '@/lib/operations/contracts'

/** Versioned, provider-neutral capability reliability ledger contract. */
export const RELIABILITY_LEDGER_CONTRACT_VERSION = 1 as const

/** Bumped when the meaning of a cohort input changes; part of the policy fingerprint. */
export const RELIABILITY_POLICY_VERSION = 'reliability-policy-v1' as const

export const MAX_CAPABILITY_FAN_OUT = 12
export const CAPABILITY_KEY_MAX_LENGTH = 120

export const CAPABILITY_KEY_PATTERN =
  /^(?:workpackage:[a-z][a-z0-9-]{0,39}\/[a-z][a-z0-9-]{0,39}|operation:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+@[1-9][0-9]{0,3})$/

export function isValidCapabilityKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= CAPABILITY_KEY_MAX_LENGTH
    && CAPABILITY_KEY_PATTERN.test(value)
}

export function unclassifiedCapabilityKey(role: string): string {
  return `workpackage:${role}/unclassified`
}

export const CAPABILITY_CLASSIFICATION_STATES = ['classified', 'missing', 'overflow'] as const
export type CapabilityClassificationState = typeof CAPABILITY_CLASSIFICATION_STATES[number]

export const VERIFICATION_MODES = [
  'none',
  'self_reported',
  'human_review',
  'deterministic_adapter',
  'independent_agent',
] as const
export type VerificationMode = typeof VERIFICATION_MODES[number]

export const SEVERITY_CLASSES = ['normal', 'critical'] as const
export type SeverityClass = typeof SEVERITY_CLASSES[number]

export const ADJUDICATION_KINDS = [
  'verification_recorded',
  'human_decision',
  'rollback_recorded',
  'override_recorded',
  'evidence_drift_detected',
] as const
export type AdjudicationKind = typeof ADJUDICATION_KINDS[number]

export const HUMAN_DECISIONS = ['accepted', 'rejected', 'cancelled'] as const
export type HumanDecision = typeof HUMAN_DECISIONS[number]

export const VERIFICATION_RESULTS = ['passed', 'failed', 'inconclusive'] as const
export type CapabilityVerificationResult = typeof VERIFICATION_RESULTS[number]

/** Domain-separated SHA-256, matching `operationFingerprint`'s construction. */
export function reliabilityFingerprint(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`forge:reliability:${domain}:v1\0`, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex')
}

export type ReliabilityScopeInput = {
  contractVersion: 1
  projectId: string
  rootRef: string | null
  rootBindingRevision: string
  grantDecisionRevision: string
  repositoryWriteIntent: boolean
  capabilities: string[]
  mcpRequirementKeys: string[]
}

export type ReliabilityRuntimeInput =
  | {
    kind: 'model'
    providerType: string | null
    modelId: string
    providerIsLocal: boolean | null
    providerConfigUpdatedAt: string | null
    acpExecutionMode: string
  }
  | {
    kind: 'deterministic_adapter'
    adapterKind: string
  }

export type ReliabilityPolicyInput = {
  contractVersion: 1
  policyVersion: string
  harnessId: string | null
  harnessUpdatedAt: string | null
  reviewRequirement: 'none' | 'qa_only' | 'reviewer_only' | 'both'
  repositoryWritesEnabled: boolean
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export function scopeFingerprint(input: ReliabilityScopeInput): string {
  return reliabilityFingerprint('scope', {
    ...input,
    capabilities: sortedUnique(input.capabilities),
    mcpRequirementKeys: sortedUnique(input.mcpRequirementKeys),
  })
}

export function runtimeFingerprint(input: ReliabilityRuntimeInput): string {
  return reliabilityFingerprint('runtime', input)
}

export function policyFingerprint(input: ReliabilityPolicyInput): string {
  return reliabilityFingerprint('policy', input)
}

export function cohortFingerprint(input: {
  projectId: string
  capabilityKey: string
  scopeFingerprint: string
  runtimeFingerprint: string
  policyFingerprint: string
}): string {
  return reliabilityFingerprint('cohort', {
    contractVersion: RELIABILITY_LEDGER_CONTRACT_VERSION,
    projectId: input.projectId,
    capabilityKey: input.capabilityKey,
    scopeFingerprint: input.scopeFingerprint,
    runtimeFingerprint: input.runtimeFingerprint,
    policyFingerprint: input.policyFingerprint,
  })
}

/** Fingerprints the normalized outcome so drift is detectable at read time. */
export function outcomeDigest(outcome: unknown): string {
  if (!isPlainRecord(outcome)) throw new Error('Outcome digest requires a plain object.')
  return reliabilityFingerprint('outcome-digest', outcome)
}

export const RELIABILITY_WINDOW_DEFAULTS = {
  maxAttempts: 50,
  maxAgeMs: 90 * 24 * 60 * 60 * 1000,
  minSamples: 5,
} as const

export type ReliabilityWindow = {
  maxAttempts: number
  maxAgeMs: number
  minSamples: number
}

export const DEFAULT_RELIABILITY_WINDOW: ReliabilityWindow = { ...RELIABILITY_WINDOW_DEFAULTS }

export type ReliabilityState = 'ready' | 'insufficient_evidence' | 'evidence_drift'

export type ReliabilityRates = {
  firstAttemptSuccess: number | null
  independentlyVerifiedPass: number | null
  humanAccepted: number | null
  unverifiedCompletion: number | null
  repairRetry: number | null
  humanRejection: number | null
  rollback: number | null
  policyBlock: number | null
}

export type ReliabilityExclusion = {
  reason: 'outside_window' | 'unclassified' | 'drifted'
  count: number
}

export type ReliabilitySummary = {
  schemaVersion: 1
  cohortFingerprint: string
  capabilityKey: string
  state: ReliabilityState
  sampleCount: number
  uniqueAttemptCount: number
  rates: ReliabilityRates
  consecutiveVerifiedPasses: number
  criticalFailureCount: number
  lastCriticalAt: string | null
  evidence: {
    newestObservedAt: string | null
    oldestObservedAt: string | null
    freshnessMs: number | null
    driftedAttemptCount: number
  }
  excluded: ReliabilityExclusion[]
}

/** Immutable evidence row, as read back from `capability_attempts`. */
export type CapabilityAttemptRecord = {
  id: string
  attemptGroupId: string
  executionOutcomeId: string
  capabilityKey: string
  classificationState: CapabilityClassificationState
  capabilityMultiplicity: number
  cohortFingerprint: string
  outcomeDigest: string
  transportStatus: 'ok' | 'error'
  result: 'completed' | 'partial' | 'refused' | 'blocked' | 'needs_attention' | 'failed' | 'cancelled'
  stopReasonCode: string | null
  retryable: boolean
  attemptNumber: number
  severityClass: SeverityClass
  verifierRequired: boolean
  verificationMode: VerificationMode
  verificationStatus: 'not_required' | 'pending' | 'passed' | 'failed' | 'inconclusive'
  observedAt: string
  currentOutcomeDigest?: string
}

export type CapabilityAdjudicationRecord = {
  id: string
  capabilityAttemptId: string
  sequence: number
  kind: AdjudicationKind
  verificationMode: VerificationMode | null
  verificationResult: CapabilityVerificationResult | null
  humanDecision: HumanDecision | null
  observedAt: string
}
