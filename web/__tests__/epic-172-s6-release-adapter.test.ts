import { describe, expect, it, vi } from 'vitest'
import {
  EPIC_172_S6_CONTROLLER_DEFAULT_STATE,
  EPIC_172_S6_OWNED_NODE_IDS,
  EPIC_172_S6_RECORDABLE_EVIDENCE_KINDS,
  assertEpic172S6ReleaseOrderOwnership,
  executeEpic172S6AtomicTransition,
} from '@/lib/mcps/epic-172-s6-release-adapter'

describe('Epic 172 S6 release adapter', () => {
  it('[scenarioId=epic-172.release-order-s6-ownership] imports Step 0 ownership for only the three S6 nodes', () => {
    expect(() => assertEpic172S6ReleaseOrderOwnership()).not.toThrow()
    expect(EPIC_172_S6_OWNED_NODE_IDS).toEqual([
      's6_pre_activation_green', 's6_post_activation_green', 's5_s6_release_ready',
    ])
    expect(EPIC_172_S6_RECORDABLE_EVIDENCE_KINDS).toEqual([
      's6_pre_activation_green', 's6_post_activation_green', 'enabled_build_tests_green',
    ])
    expect(EPIC_172_S6_RECORDABLE_EVIDENCE_KINDS).not.toContain('s5_s6_release_ready')
  })

  it('[scenarioId=epic-172.controller-disabled-by-default] exposes no local activation authority', () => {
    expect(EPIC_172_S6_CONTROLLER_DEFAULT_STATE).toEqual({
      externalControllerRequired: true, hostBoundaryEvidenceTrustedLocally: false,
      ingressEnabled: false, issuanceEnabled: false, liveActivationEnabled: false,
      mode: 'disabled', protocolEpochMayAdvance: false,
    })
    expect(Object.isFrozen(EPIC_172_S6_CONTROLLER_DEFAULT_STATE)).toBe(true)
  })

  it('[scenarioId=epic-172.signed-evidence-step0-adapter] rejects transition without database URL', async () => {
    delete process.env.FORGE_EPIC_172_TRANSITION_DATABASE_URL
    await expect(executeEpic172S6AtomicTransition({
      authorizationAttemptId: 'auth-1', buildSha: 'sha', consumerNode: 's6_pre_activation_green',
      controllerIdentity: 'ctrl', operationId: 'op-1', reviewedSha: 'reviewed-sha',
    })).rejects.toThrow('FORGE_EPIC_172_TRANSITION_DATABASE_URL')
  })
})
