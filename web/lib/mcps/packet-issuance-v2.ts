import { createHash } from 'node:crypto'
import type { FilesystemProjectCapability } from './filesystem-grants'

export const PACKET_REDACTION_CATEGORIES = [
  'private_key_blocks',
  'authorization_bearer',
  'docker_auth',
  'netrc_credentials',
  'pgpass_credentials',
  'secret_like_assignments',
  'structured_secret_keys',
  'database_urls',
  'url_userinfo',
  'well_known_token_prefixes',
  'cloud_api_tokens',
  'jwt',
] as const

export type PacketRedactionCategory = typeof PACKET_REDACTION_CATEGORIES[number]
export type PacketRedactionSummary = Partial<Record<PacketRedactionCategory, number>>

export type PacketAuthorizationSnapshotCommon = {
  schemaVersion: 2
  grantDecisionRevision: string
  rootBindingRevision: string
  approvedCapabilities: FilesystemProjectCapability[]
  requiredCapabilities: FilesystemProjectCapability[]
  decidedByUserId: string
  decidedAt: string
  coverageFingerprint: string
}

export type PacketAuthorizationSnapshot = PacketAuthorizationSnapshotCommon & (
  | {
      source: 'package_allow_once'
      grantMode: 'allow_once'
      grantApprovalId: string
      grantDecisionNonce: string
    }
  | {
      source: 'project_always_allow'
      grantMode: 'always_allow'
      grantApprovalId: null
      grantDecisionNonce: null
    }
)

export type TerminalPacketAssemblyState =
  | {
      state: 'assembled'
      rootRef: string
      includedCount: number
      byteCount: number
      omittedCount: number
      redactionSummary: PacketRedactionSummary
    }
  | { state: 'not_assembled'; failureStage: 'claim' | 'preflight' }
  | { state: 'assembly_unconfirmed'; failureStage: 'assembly'; assemblyAttemptId: string }

export type TerminalPacketDeliveryOutcome =
  | { state: 'not_exposed' }
  | { state: 'submission_failed' }
  | { state: 'submitted'; submittedAt: string }
  | { state: 'submission_uncertain' }

export type PacketTerminalOutcome =
  | { status: 'succeeded' }
  | {
      status: 'failed'
      failureCode:
        | 'authorization_changed'
        | 'execution_lease_expired'
        | 'local_evidence_lease_expired'
        | 'issuance_lease_expired'
        | 'worker_stopped'
        | 'preflight_failed'
        | 'assembly_failed'
        | 'submission_rejected'
        | 'submission_uncertain'
        | 'provider_response_invalid'
        | 'external_repository_change_requires_review'
    }
  | {
      status: 'failed'
      failureCode: 'post_submission_execution_failed'
      failureStage: 'sandbox_apply' | 'validation' | 'host_apply' | 'repository_evidence' | 'completion_preparation'
    }

export type PacketIssuanceRecoveryMarkerV2 = {
  schemaVersion: 2
  kind: 'packet_issuance'
  priorAgentRunId: string
  priorRuntimeAuditId: string
  recoveryFailure: Extract<PacketTerminalOutcome, { status: 'failed' }>
  deliveryState: TerminalPacketDeliveryOutcome['state']
  grantMode: 'allow_once' | 'always_allow'
  disposition:
    | 'review_local_changes'
    | 'reapprove_allow_once'
    | 'review_then_reapprove_allow_once'
    | 'retry_execution'
    | 'review_submission'
    | 'reviewed_submission'
  nextDisposition?:
    | 'reapprove_allow_once'
    | 'review_then_reapprove_allow_once'
    | 'retry_execution'
    | 'review_submission'
  acknowledgedAt: string | null
  acknowledgedByUserId: string | null
  combinedRepositoryReviewFingerprint: string
  markerFingerprint: string
  policyFingerprint: string
  coverageFingerprint: string
  autoRetryable: false
}

export type PacketIntegrityHoldV2 = {
  schemaVersion: 2
  kind: 'packet_integrity_hold'
  priorAgentRunId: string
  priorRuntimeAuditId: string
  reason: 'audit_artifact_mismatch' | 'terminal_success_materialization_incomplete'
  autoRetryable: false
  markerFingerprint: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REVISION = /^[1-9][0-9]*$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const ROOT_REF = /^[A-Za-z0-9_-]{1,80}$/
const CAPABILITIES = new Set<FilesystemProjectCapability>([
  'filesystem.project.read',
  'filesystem.project.list',
  'filesystem.project.search',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(row).every((key) => allowed.includes(key)) && allowed.every((key) => Object.hasOwn(row, key))
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function canonicalCapabilities(value: unknown): FilesystemProjectCapability[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > CAPABILITIES.size) return null
  if (value.some((entry) => typeof entry !== 'string' || !CAPABILITIES.has(entry as FilesystemProjectCapability))) return null
  const sorted = [...value].sort()
  if (new Set(value).size !== value.length || sorted.some((entry, index) => entry !== value[index])) return null
  return value as FilesystemProjectCapability[]
}

export function parsePacketAuthorizationSnapshot(value: unknown): PacketAuthorizationSnapshot | null {
  if (!isRecord(value)) return null
  const common = [
    'schemaVersion', 'grantDecisionRevision', 'rootBindingRevision',
    'approvedCapabilities', 'requiredCapabilities', 'decidedByUserId',
    'decidedAt', 'coverageFingerprint', 'source', 'grantMode',
    'grantApprovalId', 'grantDecisionNonce',
  ]
  if (!exactKeys(value, common)) return null
  const approvedCapabilities = canonicalCapabilities(value.approvedCapabilities)
  const requiredCapabilities = canonicalCapabilities(value.requiredCapabilities)
  if (
    value.schemaVersion !== 2 ||
    typeof value.grantDecisionRevision !== 'string' || !REVISION.test(value.grantDecisionRevision) ||
    typeof value.rootBindingRevision !== 'string' || !REVISION.test(value.rootBindingRevision) ||
    !approvedCapabilities || !requiredCapabilities ||
    requiredCapabilities.some((capability) => !approvedCapabilities.includes(capability)) ||
    !canonicalUuid(value.decidedByUserId) ||
    !canonicalTimestamp(value.decidedAt) ||
    typeof value.coverageFingerprint !== 'string' || !FINGERPRINT.test(value.coverageFingerprint)
  ) return null

  const base = {
    schemaVersion: 2 as const,
    grantDecisionRevision: value.grantDecisionRevision,
    rootBindingRevision: value.rootBindingRevision,
    approvedCapabilities,
    requiredCapabilities,
    decidedByUserId: value.decidedByUserId,
    decidedAt: value.decidedAt,
    coverageFingerprint: value.coverageFingerprint,
  }
  if (
    value.source === 'package_allow_once' && value.grantMode === 'allow_once' &&
    canonicalUuid(value.grantApprovalId) && canonicalUuid(value.grantDecisionNonce)
  ) {
    return { ...base, source: value.source, grantMode: value.grantMode, grantApprovalId: value.grantApprovalId, grantDecisionNonce: value.grantDecisionNonce }
  }
  if (
    value.source === 'project_always_allow' && value.grantMode === 'always_allow' &&
    value.grantApprovalId === null && value.grantDecisionNonce === null
  ) {
    return { ...base, source: value.source, grantMode: value.grantMode, grantApprovalId: null, grantDecisionNonce: null }
  }
  return null
}

export function parsePacketRedactionSummary(value: unknown): PacketRedactionSummary | null {
  if (!isRecord(value) || Object.keys(value).length > PACKET_REDACTION_CATEGORIES.length) return null
  const allowed = new Set<string>(PACKET_REDACTION_CATEGORIES)
  const result: PacketRedactionSummary = {}
  for (const [key, count] of Object.entries(value)) {
    if (!allowed.has(key) || !Number.isInteger(count) || (count as number) < 0 || (count as number) > 5_000) return null
    result[key as PacketRedactionCategory] = count as number
  }
  return result
}

export function parseTerminalPacketAssembly(value: unknown): TerminalPacketAssemblyState | null {
  if (!isRecord(value) || typeof value.state !== 'string') return null
  if (
    value.state === 'assembled' &&
    exactKeys(value, ['state', 'rootRef', 'includedCount', 'byteCount', 'omittedCount', 'redactionSummary']) &&
    typeof value.rootRef === 'string' && ROOT_REF.test(value.rootRef) &&
    Number.isInteger(value.includedCount) && (value.includedCount as number) >= 0 && (value.includedCount as number) <= 50 &&
    Number.isInteger(value.byteCount) && (value.byteCount as number) >= 0 && (value.byteCount as number) <= 160 * 1024 &&
    Number.isInteger(value.omittedCount) && (value.omittedCount as number) >= 0 && (value.omittedCount as number) <= 5_000
  ) {
    const redactionSummary = parsePacketRedactionSummary(value.redactionSummary)
    return redactionSummary ? {
      state: 'assembled', rootRef: value.rootRef, includedCount: value.includedCount as number,
      byteCount: value.byteCount as number, omittedCount: value.omittedCount as number, redactionSummary,
    } : null
  }
  if (
    value.state === 'not_assembled' && exactKeys(value, ['state', 'failureStage']) &&
    (value.failureStage === 'claim' || value.failureStage === 'preflight')
  ) return { state: value.state, failureStage: value.failureStage }
  if (
    value.state === 'assembly_unconfirmed' && exactKeys(value, ['state', 'failureStage', 'assemblyAttemptId']) &&
    value.failureStage === 'assembly' && canonicalUuid(value.assemblyAttemptId)
  ) return { state: value.state, failureStage: value.failureStage, assemblyAttemptId: value.assemblyAttemptId }
  return null
}

function parseFailure(value: unknown): Extract<PacketTerminalOutcome, { status: 'failed' }> | null {
  if (!isRecord(value) || value.status !== 'failed' || typeof value.failureCode !== 'string') return null
  if (value.failureCode === 'post_submission_execution_failed') {
    if (!exactKeys(value, ['status', 'failureCode', 'failureStage'])) return null
    if (!['sandbox_apply', 'validation', 'host_apply', 'repository_evidence', 'completion_preparation'].includes(value.failureStage as string)) return null
    return value as Extract<PacketTerminalOutcome, { status: 'failed' }>
  }
  const codes = [
    'authorization_changed', 'execution_lease_expired', 'local_evidence_lease_expired',
    'issuance_lease_expired', 'worker_stopped', 'preflight_failed', 'assembly_failed',
    'submission_rejected', 'submission_uncertain', 'provider_response_invalid',
    'external_repository_change_requires_review',
  ]
  return exactKeys(value, ['status', 'failureCode']) && codes.includes(value.failureCode)
    ? value as Extract<PacketTerminalOutcome, { status: 'failed' }>
    : null
}

export function packetTerminalTupleIsValid(input: {
  assembly: TerminalPacketAssemblyState
  delivery: TerminalPacketDeliveryOutcome
  terminal: PacketTerminalOutcome
}): boolean {
  const { assembly, delivery, terminal } = input
  if (terminal.status === 'succeeded') return assembly.state === 'assembled' && delivery.state === 'submitted'
  const code = terminal.failureCode
  if (assembly.state === 'not_assembled') {
    if (delivery.state !== 'not_exposed') return false
    const claimCodes = ['authorization_changed', 'execution_lease_expired', 'local_evidence_lease_expired', 'issuance_lease_expired']
    return claimCodes.includes(code) || (assembly.failureStage === 'preflight' && ['worker_stopped', 'preflight_failed'].includes(code))
  }
  if (assembly.state === 'assembly_unconfirmed') {
    return delivery.state === 'not_exposed' && [
      'authorization_changed', 'execution_lease_expired', 'local_evidence_lease_expired',
      'issuance_lease_expired', 'worker_stopped', 'assembly_failed',
    ].includes(code)
  }
  if (delivery.state === 'not_exposed') {
    return ['authorization_changed', 'execution_lease_expired', 'local_evidence_lease_expired', 'issuance_lease_expired', 'worker_stopped'].includes(code)
  }
  if (delivery.state === 'submission_failed') return code === 'submission_rejected'
  if (delivery.state === 'submission_uncertain') {
    return ['authorization_changed', 'execution_lease_expired', 'local_evidence_lease_expired', 'issuance_lease_expired', 'worker_stopped', 'submission_uncertain'].includes(code)
  }
  return ['authorization_changed', 'execution_lease_expired', 'local_evidence_lease_expired', 'issuance_lease_expired', 'worker_stopped', 'provider_response_invalid', 'external_repository_change_requires_review', 'post_submission_execution_failed'].includes(code)
}

export function packetRecoveryMarkerFingerprint(value: Omit<PacketIssuanceRecoveryMarkerV2, 'markerFingerprint'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

export function parsePacketIntegrityHold(value: unknown): PacketIntegrityHoldV2 | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'priorAgentRunId', 'priorRuntimeAuditId', 'reason', 'autoRetryable', 'markerFingerprint',
  ])) return null
  if (
    value.schemaVersion !== 2 || value.kind !== 'packet_integrity_hold' ||
    !canonicalUuid(value.priorAgentRunId) || !canonicalUuid(value.priorRuntimeAuditId) ||
    !['audit_artifact_mismatch', 'terminal_success_materialization_incomplete'].includes(value.reason as string) ||
    value.autoRetryable !== false || typeof value.markerFingerprint !== 'string' || !FINGERPRINT.test(value.markerFingerprint)
  ) return null
  return value as PacketIntegrityHoldV2
}

export function parsePacketIssuanceRecoveryMarker(value: unknown): PacketIssuanceRecoveryMarkerV2 | null {
  if (!isRecord(value)) return null
  const requiredKeys = [
    'schemaVersion', 'kind', 'priorAgentRunId', 'priorRuntimeAuditId', 'recoveryFailure',
    'deliveryState', 'grantMode', 'disposition', 'acknowledgedAt', 'acknowledgedByUserId',
    'combinedRepositoryReviewFingerprint', 'markerFingerprint', 'policyFingerprint',
    'coverageFingerprint', 'autoRetryable',
  ]
  const allowed = [...requiredKeys, 'nextDisposition']
  if (Object.keys(value).some((key) => !allowed.includes(key)) || requiredKeys.some((key) => !Object.hasOwn(value, key))) return null
  const failure = parseFailure(value.recoveryFailure)
  if (
    value.schemaVersion !== 2 || value.kind !== 'packet_issuance' || !failure ||
    !canonicalUuid(value.priorAgentRunId) || !canonicalUuid(value.priorRuntimeAuditId) ||
    !['not_exposed', 'submission_failed', 'submission_uncertain', 'submitted'].includes(value.deliveryState as string) ||
    !['allow_once', 'always_allow'].includes(value.grantMode as string) ||
    !['review_local_changes', 'reapprove_allow_once', 'review_then_reapprove_allow_once', 'retry_execution', 'review_submission', 'reviewed_submission'].includes(value.disposition as string) ||
    value.autoRetryable !== false ||
    ![value.combinedRepositoryReviewFingerprint, value.markerFingerprint, value.policyFingerprint, value.coverageFingerprint]
      .every((item) => typeof item === 'string' && FINGERPRINT.test(item))
  ) return null

  const acknowledged = canonicalTimestamp(value.acknowledgedAt) && canonicalUuid(value.acknowledgedByUserId)
  const unacknowledged = value.acknowledgedAt === null && value.acknowledgedByUserId === null
  if (!acknowledged && !unacknowledged) return null

  const delivery = value.deliveryState
  const mode = value.grantMode
  const disposition = value.disposition
  const coherent =
    (disposition === 'review_local_changes' && unacknowledged && typeof value.nextDisposition === 'string') ||
    (mode === 'allow_once' && ['not_exposed', 'submission_failed'].includes(delivery as string) && disposition === 'reapprove_allow_once' && unacknowledged) ||
    (mode === 'allow_once' && ['submission_uncertain', 'submitted'].includes(delivery as string) && disposition === 'review_then_reapprove_allow_once' && unacknowledged) ||
    (mode === 'allow_once' && ['submission_uncertain', 'submitted'].includes(delivery as string) && disposition === 'reapprove_allow_once' && acknowledged) ||
    (mode === 'always_allow' && ['not_exposed', 'submission_failed'].includes(delivery as string) && disposition === 'retry_execution' && unacknowledged) ||
    (mode === 'always_allow' && ['submission_uncertain', 'submitted'].includes(delivery as string) && disposition === 'review_submission' && unacknowledged) ||
    (mode === 'always_allow' && ['submission_uncertain', 'submitted'].includes(delivery as string) && disposition === 'reviewed_submission' && acknowledged)
  return coherent ? value as PacketIssuanceRecoveryMarkerV2 : null
}

export type PacketCandidateGuard =
  | { blocked: false }
  | { blocked: true; kind: 'packet_issuance' | 'packet_integrity_hold' | 'invalid_packet_marker' }

/** Any recognized key is an absolute block; malformed known-v2 data fails closed. */
export function packetCandidateGuard(metadata: unknown): PacketCandidateGuard {
  if (!isRecord(metadata)) return { blocked: false }
  if (Object.hasOwn(metadata, 'packet_integrity_hold')) {
    return parsePacketIntegrityHold(metadata.packet_integrity_hold)
      ? { blocked: true, kind: 'packet_integrity_hold' }
      : { blocked: true, kind: 'invalid_packet_marker' }
  }
  if (Object.hasOwn(metadata, 'packet_issuance')) {
    return parsePacketIssuanceRecoveryMarker(metadata.packet_issuance)
      ? { blocked: true, kind: 'packet_issuance' }
      : { blocked: true, kind: 'invalid_packet_marker' }
  }
  return { blocked: false }
}
