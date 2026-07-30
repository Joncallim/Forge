import type {
  LocalEffectRecoveryAction,
  PacketIssuanceRecoveryAction,
} from './recovery-actions-v2'

type LocalEffectRecoveryDisposition =
  | 'review_local_changes'
  | 'acknowledge_possible_local_invocation'
  | 'retry_local_execution'
  | 'dependent_packet'

type PacketIssuanceRecoveryDisposition =
  | 'review_local_changes'
  | 'reapprove_allow_once'
  | 'review_then_reapprove_allow_once'
  | 'retry_execution'
  | 'review_submission'
  | 'reviewed_submission'

// A persisted disposition describes the recovery state; it is not itself a
// request action. Keep this matrix shared by S5 presentation and authorization
// so secondary close/decline controls retain the marker's identity and CAS.
const LOCAL_EFFECT_ACTIONS_BY_DISPOSITION: Readonly<Record<
  LocalEffectRecoveryDisposition,
  readonly LocalEffectRecoveryAction[]
>> = {
  review_local_changes: ['review_local_changes'],
  acknowledge_possible_local_invocation: [
    'acknowledge_possible_local_invocation',
    'decline_local_retry',
  ],
  retry_local_execution: ['retry_local_execution', 'decline_local_retry'],
  dependent_packet: [],
}

const PACKET_ISSUANCE_ACTIONS_BY_DISPOSITION: Readonly<Record<
  PacketIssuanceRecoveryDisposition,
  readonly PacketIssuanceRecoveryAction[]
>> = {
  review_local_changes: [],
  reapprove_allow_once: ['decline_packet_recovery'],
  review_then_reapprove_allow_once: [
    'acknowledge_possible_submission',
    'decline_packet_recovery',
  ],
  retry_execution: ['retry_execution', 'decline_packet_recovery'],
  review_submission: ['acknowledge_possible_submission', 'decline_packet_recovery'],
  reviewed_submission: ['retry_execution', 'decline_packet_recovery'],
}

export function localEffectRecoveryActionsForDisposition(
  disposition: string | null,
): readonly LocalEffectRecoveryAction[] {
  return disposition && disposition in LOCAL_EFFECT_ACTIONS_BY_DISPOSITION
    ? LOCAL_EFFECT_ACTIONS_BY_DISPOSITION[disposition as LocalEffectRecoveryDisposition]
    : []
}

export function packetIssuanceRecoveryActionsForDisposition(
  disposition: string | null,
): readonly PacketIssuanceRecoveryAction[] {
  return disposition && disposition in PACKET_ISSUANCE_ACTIONS_BY_DISPOSITION
    ? PACKET_ISSUANCE_ACTIONS_BY_DISPOSITION[disposition as PacketIssuanceRecoveryDisposition]
    : []
}
