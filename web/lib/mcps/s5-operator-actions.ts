import {
  LOCAL_EFFECT_RECOVERY_ACTIONS,
  PACKET_ISSUANCE_RECOVERY_ACTIONS,
  type LocalEffectRecoveryAction,
  type PacketIssuanceRecoveryAction,
} from '@/lib/mcps/recovery-actions-v2'

// ---------------------------------------------------------------------------
// The closed S5 operator action union.
//
// Every request names one exact action plus the exact immutable identity of
// the evidence it acts on, and echoes the freshness fingerprint of the state
// the operator actually saw. No request may carry authority fields: no
// capabilities, no decision revisions the caller invented, no reason strings
// that unlock anything. The server re-reads the authoritative state and
// refuses (409, zero mutation) unless the fingerprint and the exact tuple
// still match.
// ---------------------------------------------------------------------------

export const S5_OPERATOR_ACTIONS = [
  ...LOCAL_EFFECT_RECOVERY_ACTIONS,
  ...PACKET_ISSUANCE_RECOVERY_ACTIONS,
  'approve_project_filesystem_context',
] as const

export type S5OperatorAction = typeof S5_OPERATOR_ACTIONS[number]

export type S5LocalEffectActionRequest = {
  schemaVersion: 1
  action: LocalEffectRecoveryAction
  expectedFreshnessFingerprint: string
  localRunEvidenceId: string
  evidenceFingerprint: string
}

export type S5PacketActionRequest = {
  schemaVersion: 1
  action: PacketIssuanceRecoveryAction
  expectedFreshnessFingerprint: string
  priorRuntimeAuditId: string
  markerFingerprint: string
}

export type S5ProjectGrantActionRequest = {
  schemaVersion: 1
  action: 'approve_project_filesystem_context'
  expectedFreshnessFingerprint: string
  projectId: string
  expectedProjectDecisionId: string | null
  expectedProjectDecisionRevision: string | null
}

export type S5OperatorActionRequest =
  | S5LocalEffectActionRequest
  | S5PacketActionRequest
  | S5ProjectGrantActionRequest

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const POSITIVE_REVISION = /^[1-9][0-9]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function fingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value)
}

// The evidence identity is globally unique and is the only thing the operator
// surface actually holds; the work package is derived server-side from the
// marker that owns that evidence, never asserted by the caller.
const LOCAL_KEYS = [
  'schemaVersion', 'action', 'expectedFreshnessFingerprint',
  'localRunEvidenceId', 'evidenceFingerprint',
] as const

const PACKET_KEYS = [
  'schemaVersion', 'action', 'expectedFreshnessFingerprint',
  'priorRuntimeAuditId', 'markerFingerprint',
] as const

const PROJECT_KEYS = [
  'schemaVersion', 'action', 'expectedFreshnessFingerprint',
  'projectId', 'expectedProjectDecisionId', 'expectedProjectDecisionRevision',
] as const

/**
 * Parses an operator action request. Returns `null` for anything that is not
 * an exact member of the closed union — unknown actions, missing identity,
 * extra keys, or malformed identifiers all fail closed with no partial parse.
 */
export function parseS5OperatorActionRequest(value: unknown): S5OperatorActionRequest | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null
  if (!fingerprint(value.expectedFreshnessFingerprint)) return null
  const action = value.action

  if (LOCAL_EFFECT_RECOVERY_ACTIONS.includes(action as LocalEffectRecoveryAction)) {
    if (!exactKeys(value, LOCAL_KEYS)) return null
    if (!uuid(value.localRunEvidenceId)) return null
    if (!fingerprint(value.evidenceFingerprint)) return null
    return value as S5LocalEffectActionRequest
  }

  if (PACKET_ISSUANCE_RECOVERY_ACTIONS.includes(action as PacketIssuanceRecoveryAction)) {
    if (!exactKeys(value, PACKET_KEYS)) return null
    if (!uuid(value.priorRuntimeAuditId)) return null
    if (!fingerprint(value.markerFingerprint)) return null
    return value as S5PacketActionRequest
  }

  if (action === 'approve_project_filesystem_context') {
    if (!exactKeys(value, PROJECT_KEYS)) return null
    if (!uuid(value.projectId)) return null
    if (value.expectedProjectDecisionId !== null && !uuid(value.expectedProjectDecisionId)) return null
    if (
      value.expectedProjectDecisionRevision !== null
      && (typeof value.expectedProjectDecisionRevision !== 'string'
        || !POSITIVE_REVISION.test(value.expectedProjectDecisionRevision))
    ) return null
    // A decision id and its revision are one immutable pair: neither half may
    // be supplied without the other.
    if ((value.expectedProjectDecisionId === null) !== (value.expectedProjectDecisionRevision === null)) return null
    return value as S5ProjectGrantActionRequest
  }

  return null
}

export function isLocalEffectActionRequest(
  request: S5OperatorActionRequest,
): request is S5LocalEffectActionRequest {
  return LOCAL_EFFECT_RECOVERY_ACTIONS.includes(request.action as LocalEffectRecoveryAction)
}

export function isPacketActionRequest(
  request: S5OperatorActionRequest,
): request is S5PacketActionRequest {
  return PACKET_ISSUANCE_RECOVERY_ACTIONS.includes(request.action as PacketIssuanceRecoveryAction)
}
