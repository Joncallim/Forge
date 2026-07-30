import { describe, expect, it } from 'vitest'
import {
  localEffectRecoveryActionsForDisposition,
  packetIssuanceRecoveryActionsForDisposition,
} from '@/lib/mcps/recovery-action-contract'

describe('recovery action contract', () => {
  it.each([
    ['review_local_changes', ['review_local_changes']],
    ['acknowledge_possible_local_invocation', ['acknowledge_possible_local_invocation', 'decline_local_retry']],
    ['retry_local_execution', ['retry_local_execution', 'decline_local_retry']],
    ['dependent_packet', []],
  ])('maps local disposition %s to its exact operator actions', (disposition, actions) => {
    expect(localEffectRecoveryActionsForDisposition(disposition)).toEqual(actions)
  })

  it.each([
    ['review_local_changes', []],
    ['reapprove_allow_once', ['decline_packet_recovery']],
    ['review_then_reapprove_allow_once', ['acknowledge_possible_submission', 'decline_packet_recovery']],
    ['retry_execution', ['retry_execution', 'decline_packet_recovery']],
    ['review_submission', ['acknowledge_possible_submission', 'decline_packet_recovery']],
    ['reviewed_submission', ['retry_execution', 'decline_packet_recovery']],
  ])('maps packet disposition %s to its exact operator actions', (disposition, actions) => {
    expect(packetIssuanceRecoveryActionsForDisposition(disposition)).toEqual(actions)
  })

  it('fails closed for an unknown persisted disposition', () => {
    expect(localEffectRecoveryActionsForDisposition('decline_local_retry')).toEqual([])
    expect(packetIssuanceRecoveryActionsForDisposition('decline_packet_recovery')).toEqual([])
  })
})
