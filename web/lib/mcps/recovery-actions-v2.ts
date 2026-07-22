export const LOCAL_EFFECT_RECOVERY_ACTIONS = [
  'review_local_changes',
  'acknowledge_possible_local_invocation',
  'retry_local_execution',
  'decline_local_retry',
] as const

export const PACKET_ISSUANCE_RECOVERY_ACTIONS = [
  'acknowledge_possible_submission',
  'retry_execution',
  'decline_packet_recovery',
] as const

export type LocalEffectRecoveryAction = typeof LOCAL_EFFECT_RECOVERY_ACTIONS[number]
export type PacketIssuanceRecoveryAction = typeof PACKET_ISSUANCE_RECOVERY_ACTIONS[number]

export const MCP_ADMISSION_OPERATOR_RECOVERY_SUITE_ID = 'mcp-admission.operator-recovery'

export type LocalEffectRecoveryRequestV1 = {
  schemaVersion: 1
  action: LocalEffectRecoveryAction
  localRunEvidenceId: string
  evidenceFingerprint: string
}

export type PacketIssuanceRecoveryRequestV2 = {
  schemaVersion: 2
  action: PacketIssuanceRecoveryAction
  priorRuntimeAuditId: string
  markerFingerprint: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function parseLocalEffectRecoveryRequest(value: unknown): LocalEffectRecoveryRequestV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'action', 'localRunEvidenceId', 'evidenceFingerprint'])) return null
  if (
    value.schemaVersion !== 1 ||
    !LOCAL_EFFECT_RECOVERY_ACTIONS.includes(value.action as LocalEffectRecoveryAction) ||
    typeof value.localRunEvidenceId !== 'string' || !UUID.test(value.localRunEvidenceId) ||
    typeof value.evidenceFingerprint !== 'string' || !FINGERPRINT.test(value.evidenceFingerprint)
  ) return null
  return value as LocalEffectRecoveryRequestV1
}

export function parsePacketIssuanceRecoveryRequest(value: unknown): PacketIssuanceRecoveryRequestV2 | null {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'action', 'priorRuntimeAuditId', 'markerFingerprint'])) return null
  if (
    value.schemaVersion !== 2 ||
    !PACKET_ISSUANCE_RECOVERY_ACTIONS.includes(value.action as PacketIssuanceRecoveryAction) ||
    typeof value.priorRuntimeAuditId !== 'string' || !UUID.test(value.priorRuntimeAuditId) ||
    typeof value.markerFingerprint !== 'string' || !FINGERPRINT.test(value.markerFingerprint)
  ) return null
  return value as PacketIssuanceRecoveryRequestV2
}

/** Generic stale-package cleanup delegates every linked local-v2 run here. */
export async function delegateLinkedV2Cleanup(input: {
  agentRunId: string
}): Promise<{ result: S4LinkedRecoveryResult; completionArtifactId: string | null }> {
  return recoverLinkedS4LifecycleV2(input)
}
import {
  recoverLinkedS4LifecycleV2,
  type S4LinkedRecoveryResult,
} from './s4-lease'
