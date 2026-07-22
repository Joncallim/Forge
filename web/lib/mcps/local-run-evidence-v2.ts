export type HostApplyRecoveryReview =
  | { state: 'not_applicable' }
  | { state: 'review_required'; ledgerFingerprint: string; reviewedAt: null; reviewedByUserId: null }
  | { state: 'reviewed'; ledgerFingerprint: string; reviewedAt: string; reviewedByUserId: string }

export type RepositoryChangeReview =
  | { state: 'not_applicable'; baselineFingerprint: string | null; changeResult: 'not_observed' | 'unchanged' }
  | {
      state: 'review_required'
      baselineFingerprint: string
      changeResult: 'changed' | 'unverifiable'
      changeFingerprint: string
      reviewedAt: null
      reviewedByUserId: null
    }
  | {
      state: 'reviewed'
      baselineFingerprint: string
      changeResult: 'changed' | 'unverifiable'
      changeFingerprint: string
      reviewedAt: string
      reviewedByUserId: string
    }

export type LocalReviewReason =
  | 'host_apply_requires_review'
  | 'repository_change_requires_review'
  | 'host_and_repository_change_require_review'

export type LocalEffectRecoveryMarkerV1 = {
  schemaVersion: 1
  kind: 'local_effect_recovery'
  source: 'local-run-evidence'
  priorAgentRunId: string
  localRunEvidenceId: string
  evidenceFingerprint: string
  taskDisposition: 'operator_hold'
  autoRetryable: false
} & (
  | {
      reason: LocalReviewReason
      disposition: 'review_local_changes'
      nextDisposition: 'retry_local_execution' | 'acknowledge_possible_local_invocation' | 'dependent_packet'
      reviewState: 'review_required'
      invocationAttemptId?: string
    }
  | {
      reason: LocalReviewReason
      disposition: 'retry_local_execution'
      reviewState: 'reviewed'
    }
  | {
      reason: 'local_execution_interrupted'
      disposition: 'retry_local_execution'
      reviewState: 'not_applicable'
    }
  | {
      reason: 'local_invocation_uncertain'
      disposition: 'acknowledge_possible_local_invocation'
      reviewState: 'not_applicable' | 'reviewed'
      invocationAttemptId: string
      acknowledgedAt: null
      acknowledgedByUserId: null
    }
  | {
      reason: 'local_invocation_uncertain'
      disposition: 'retry_local_execution'
      reviewState: 'not_applicable' | 'reviewed'
      invocationAttemptId: string
      acknowledgedAt: string
      acknowledgedByUserId: string
    }
)

export type LocalEffectIntegrityHoldV1 = {
  schemaVersion: 1
  kind: 'local_effect_integrity_hold'
  source: 'local-run-evidence'
  priorAgentRunId: string
  alertId: string
  evidenceFingerprint: string
  taskDisposition: 'operator_hold'
  autoRetryable: false
} & (
  | {
      reason: 'missing_local_evidence'
      localRunEvidenceId: null
      expectedLocalRunEvidenceId: string
      packetAuditId: string | null
      projectId: string
      taskId: string
      packageId: string
      claimIdentityFingerprint: string
    }
  | {
      reason: 'local_evidence_mismatch' | 'task_projection_mismatch' | 'quiescence_state_incoherent'
      localRunEvidenceId: string
      expectedLocalRunEvidenceId: null
      packetAuditId: string | null
    }
)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function fingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

const RECOVERY_COMMON_KEYS = [
  'schemaVersion', 'kind', 'source', 'priorAgentRunId', 'localRunEvidenceId',
  'evidenceFingerprint', 'taskDisposition', 'autoRetryable', 'reason',
  'disposition', 'reviewState',
] as const

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

export function parseHostApplyRecoveryReview(value: unknown): HostApplyRecoveryReview | null {
  if (!isRecord(value)) return null
  if (value.state === 'not_applicable' && Object.keys(value).length === 1) return { state: 'not_applicable' }
  if (
    (value.state === 'review_required' || value.state === 'reviewed') &&
    Object.keys(value).length === 4 && fingerprint(value.ledgerFingerprint)
  ) {
    if (value.state === 'review_required' && value.reviewedAt === null && value.reviewedByUserId === null) {
      return value as HostApplyRecoveryReview
    }
    if (value.state === 'reviewed' && timestamp(value.reviewedAt) && uuid(value.reviewedByUserId)) {
      return value as HostApplyRecoveryReview
    }
  }
  return null
}

export function parseRepositoryChangeReview(value: unknown): RepositoryChangeReview | null {
  if (!isRecord(value)) return null
  if (
    value.state === 'not_applicable' && Object.keys(value).length === 3 &&
    (value.baselineFingerprint === null || fingerprint(value.baselineFingerprint)) &&
    (value.changeResult === 'not_observed' || value.changeResult === 'unchanged')
  ) return value as RepositoryChangeReview
  if (
    (value.state === 'review_required' || value.state === 'reviewed') && Object.keys(value).length === 6 &&
    fingerprint(value.baselineFingerprint) && fingerprint(value.changeFingerprint) &&
    (value.changeResult === 'changed' || value.changeResult === 'unverifiable')
  ) {
    if (value.state === 'review_required' && value.reviewedAt === null && value.reviewedByUserId === null) {
      return value as RepositoryChangeReview
    }
    if (value.state === 'reviewed' && timestamp(value.reviewedAt) && uuid(value.reviewedByUserId)) {
      return value as RepositoryChangeReview
    }
  }
  return null
}

function commonRecovery(value: Record<string, unknown>): boolean {
  return value.schemaVersion === 1 && value.kind === 'local_effect_recovery' &&
    value.source === 'local-run-evidence' && uuid(value.priorAgentRunId) &&
    uuid(value.localRunEvidenceId) && fingerprint(value.evidenceFingerprint) &&
    value.taskDisposition === 'operator_hold' && value.autoRetryable === false
}

export function parseLocalEffectRecoveryMarker(value: unknown): LocalEffectRecoveryMarkerV1 | null {
  if (!isRecord(value) || !commonRecovery(value)) return null
  const reason = value.reason
  const reviewReason = reason === 'host_apply_requires_review' || reason === 'repository_change_requires_review' || reason === 'host_and_repository_change_require_review'
  const reviewKeys = value.nextDisposition === 'acknowledge_possible_local_invocation'
    ? [...RECOVERY_COMMON_KEYS, 'nextDisposition', 'invocationAttemptId']
    : [...RECOVERY_COMMON_KEYS, 'nextDisposition']
  if (
    exactKeys(value, reviewKeys) &&
    reviewReason && value.disposition === 'review_local_changes' && value.reviewState === 'review_required' &&
    ['retry_local_execution', 'acknowledge_possible_local_invocation', 'dependent_packet'].includes(value.nextDisposition as string) &&
    (value.nextDisposition !== 'acknowledge_possible_local_invocation' || uuid(value.invocationAttemptId))
  ) return value as LocalEffectRecoveryMarkerV1
  if (exactKeys(value, RECOVERY_COMMON_KEYS) && reviewReason && value.disposition === 'retry_local_execution' && value.reviewState === 'reviewed') {
    return value as LocalEffectRecoveryMarkerV1
  }
  if (exactKeys(value, RECOVERY_COMMON_KEYS) && reason === 'local_execution_interrupted' && value.disposition === 'retry_local_execution' && value.reviewState === 'not_applicable') {
    return value as LocalEffectRecoveryMarkerV1
  }
  if (reason === 'local_invocation_uncertain' && uuid(value.invocationAttemptId) && (value.reviewState === 'not_applicable' || value.reviewState === 'reviewed')) {
    if (exactKeys(value, [...RECOVERY_COMMON_KEYS, 'invocationAttemptId', 'acknowledgedAt', 'acknowledgedByUserId']) && value.disposition === 'acknowledge_possible_local_invocation' && value.acknowledgedAt === null && value.acknowledgedByUserId === null) {
      return value as LocalEffectRecoveryMarkerV1
    }
    if (exactKeys(value, [...RECOVERY_COMMON_KEYS, 'invocationAttemptId', 'acknowledgedAt', 'acknowledgedByUserId']) && value.disposition === 'retry_local_execution' && timestamp(value.acknowledgedAt) && uuid(value.acknowledgedByUserId)) {
      return value as LocalEffectRecoveryMarkerV1
    }
  }
  return null
}

export function parseLocalEffectIntegrityHold(value: unknown): LocalEffectIntegrityHoldV1 | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'local_effect_integrity_hold' ||
      value.source !== 'local-run-evidence' || !uuid(value.priorAgentRunId) || !uuid(value.alertId) ||
      !fingerprint(value.evidenceFingerprint) || value.taskDisposition !== 'operator_hold' || value.autoRetryable !== false) {
    return null
  }
  if (
    exactKeys(value, [
      'schemaVersion', 'kind', 'source', 'priorAgentRunId', 'alertId', 'evidenceFingerprint',
      'taskDisposition', 'autoRetryable', 'reason', 'localRunEvidenceId',
      'expectedLocalRunEvidenceId', 'packetAuditId', 'projectId', 'taskId', 'packageId',
      'claimIdentityFingerprint',
    ]) &&
    value.reason === 'missing_local_evidence' && value.localRunEvidenceId === null && uuid(value.expectedLocalRunEvidenceId) &&
    (value.packetAuditId === null || uuid(value.packetAuditId)) && uuid(value.projectId) && uuid(value.taskId) &&
    uuid(value.packageId) && fingerprint(value.claimIdentityFingerprint)
  ) return value as LocalEffectIntegrityHoldV1
  if (
    exactKeys(value, [
      'schemaVersion', 'kind', 'source', 'priorAgentRunId', 'alertId', 'evidenceFingerprint',
      'taskDisposition', 'autoRetryable', 'reason', 'localRunEvidenceId',
      'expectedLocalRunEvidenceId', 'packetAuditId',
    ]) &&
    ['local_evidence_mismatch', 'task_projection_mismatch', 'quiescence_state_incoherent'].includes(value.reason as string) &&
    uuid(value.localRunEvidenceId) && value.expectedLocalRunEvidenceId === null &&
    (value.packetAuditId === null || uuid(value.packetAuditId))
  ) return value as LocalEffectIntegrityHoldV1
  return null
}

export function localEffectCandidateGuard(metadata: unknown): { blocked: boolean; kind?: string } {
  if (!isRecord(metadata)) return { blocked: false }
  if (Object.hasOwn(metadata, 'local_effect_integrity_hold')) {
    return { blocked: true, kind: parseLocalEffectIntegrityHold(metadata.local_effect_integrity_hold) ? 'local_effect_integrity_hold' : 'invalid_local_effect_marker' }
  }
  if (Object.hasOwn(metadata, 'local_effect_recovery')) {
    return { blocked: true, kind: parseLocalEffectRecoveryMarker(metadata.local_effect_recovery) ? 'local_effect_recovery' : 'invalid_local_effect_marker' }
  }
  return { blocked: false }
}
