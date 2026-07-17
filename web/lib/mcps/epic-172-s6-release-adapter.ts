import {
  epic172ReleaseOrder,
  getEpic172ReleaseOrderNode,
  validateEpic172ReleaseOrder,
  type Epic172ReleaseNodeId,
} from './epic-172-release-order'
import {
  verifyEpic172ReleaseEvidence,
  verifyEpic172TransitionAuthorization,
} from './epic-172-release-verifier'

export const EPIC_172_S6_OWNED_NODE_IDS = Object.freeze([
  's6_pre_activation_green',
  's6_post_activation_green',
  's5_s6_release_ready',
] as const satisfies readonly Epic172ReleaseNodeId[])

export type Epic172S6OwnedNodeId = typeof EPIC_172_S6_OWNED_NODE_IDS[number]

export const EPIC_172_S6_CONTROLLER_DEFAULT_STATE = Object.freeze({
  externalControllerRequired: true,
  hostBoundaryEvidenceTrustedLocally: false,
  ingressEnabled: false,
  issuanceEnabled: false,
  liveActivationEnabled: false,
  mode: 'disabled' as const,
  protocolEpochMayAdvance: false,
})

/**
 * S6 verifies ownership through Step 0's canonical release-order manifest. It
 * deliberately has no fallback registry because a copied graph could drift and
 * accidentally authorize the wrong transition.
 */
export function assertEpic172S6ReleaseOrderOwnership(): void {
  validateEpic172ReleaseOrder(epic172ReleaseOrder)
  for (const nodeId of EPIC_172_S6_OWNED_NODE_IDS) {
    const node = getEpic172ReleaseOrderNode(nodeId)
    if (node.owner.issue !== 181 || node.owner.slice !== 's6') {
      throw new Error(`Canonical release node ${nodeId} is not owned by issue 181 / S6.`)
    }
  }
}

/**
 * This is an intentionally transparent adapter over Step 0's verifier. S6 must
 * not parse, canonicalize, hash, or reinterpret durable release evidence itself.
 */
export function verifyEpic172S6ReleaseEvidenceInput(
  input: Parameters<typeof verifyEpic172ReleaseEvidence>[0],
): ReturnType<typeof verifyEpic172ReleaseEvidence> {
  assertEpic172S6ReleaseOrderOwnership()
  return verifyEpic172ReleaseEvidence(input)
}

/**
 * Transition authorizations use Step 0's separate signature domain and verifier.
 * Keeping the wrapper exact prevents a host-attestation key from becoming release
 * authority and preserves Step 0's expiry/replay checks.
 */
export function verifyEpic172S6TransitionAuthorizationInput(
  input: Parameters<typeof verifyEpic172TransitionAuthorization>[0],
): ReturnType<typeof verifyEpic172TransitionAuthorization> {
  assertEpic172S6ReleaseOrderOwnership()
  return verifyEpic172TransitionAuthorization(input)
}

export type Epic172S6ReleaseStoreAdapter = Readonly<{
  /**
   * The implementation is supplied by Step 0. It must record one already-verified
   * S6-owned envelope in the same transaction as its canonical consumption rows.
   */
  recordOwnedEvidence: (
    nodeId: Epic172S6OwnedNodeId,
    verified: ReturnType<typeof verifyEpic172ReleaseEvidence>,
  ) => Promise<unknown>
  /**
   * The implementation is supplied by Step 0. It must consume a verified fresh
   * authorization and its exact predecessors atomically or roll back all writes.
   */
  consumeOwnedTransition: (
    nodeId: Epic172S6OwnedNodeId,
    verified: ReturnType<typeof verifyEpic172TransitionAuthorization>,
  ) => Promise<unknown>
}>

export function createEpic172S6ReleaseStoreAdapter(
  adapter: Epic172S6ReleaseStoreAdapter,
): Epic172S6ReleaseStoreAdapter {
  assertEpic172S6ReleaseOrderOwnership()
  if (!adapter || typeof adapter.recordOwnedEvidence !== 'function' || typeof adapter.consumeOwnedTransition !== 'function') {
    throw new Error('Step 0 release store and transition consumer adapters are required.')
  }
  return Object.freeze({
    recordOwnedEvidence: adapter.recordOwnedEvidence,
    consumeOwnedTransition: adapter.consumeOwnedTransition,
  })
}
