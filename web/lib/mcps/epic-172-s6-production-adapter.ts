import { db } from '@/db'
import {
  forgeEpic172ReleaseEvidence,
  forgeEpic172ReleaseEvidenceConsumptions,
} from '@/db/schema'
import {
  createEpic172S6ReleaseStoreAdapter,
  assertEpic172S6ReleaseOrderOwnership,
  type Epic172S6RecordableEvidenceKind,
  type Epic172S6OwnedNodeId,
  type Epic172S6ReleaseStoreAdapter,
  type Epic172S6VerifiedReleaseEvidence,
  type Epic172S6VerifiedTransitionAuthorization,
} from './epic-172-s6-release-adapter'

export function createEpic172S6ProductionReleaseStoreAdapter(): Epic172S6ReleaseStoreAdapter {
  assertEpic172S6ReleaseOrderOwnership()

  return createEpic172S6ReleaseStoreAdapter({
    async recordOwnedEvidence(
      evidenceKind: Epic172S6RecordableEvidenceKind,
      verified: Epic172S6VerifiedReleaseEvidence,
    ) {
      const envelope = verified.envelope
      await db.transaction(async (tx) => {
        await tx.insert(forgeEpic172ReleaseEvidence).values({
          evidenceKind,
          signerKeyId: envelope.signerKeyId,
          signerGeneration: envelope.signerGeneration,
          transitionIdentityDigest: envelope.transitionIdentityDigest,
          requiredEvidence: envelope.requiredEvidence as unknown as { name: string; measurementDigest: string }[],
          schemaVersion: 1,
          githubAppId: envelope.githubAppId,
          issuedAt: new Date(envelope.issuedAt),
          envelope: envelope as unknown as Record<string, unknown>,
        } as unknown as typeof forgeEpic172ReleaseEvidence.$inferInsert)
      })
      return envelope.receiptId
    },

    async consumeOwnedTransition(
      nodeId: Epic172S6OwnedNodeId,
      verified: Epic172S6VerifiedTransitionAuthorization,
    ) {
      const auth = verified.envelope
      await db.transaction(async (tx) => {
        for (const receiptId of auth.sourceReceiptIds) {
          await tx.insert(forgeEpic172ReleaseEvidenceConsumptions).values({
            authorizationId: auth.authorizationId,
            consumerNode: nodeId,
            operationId: auth.operationId,
            receiptId,
            transitionIdentityDigest: auth.transitionIdentityDigest,
            actor: auth.controllerLoginId,
            consumedAt: new Date(),
          } as unknown as typeof forgeEpic172ReleaseEvidenceConsumptions.$inferInsert)
        }
      })
      return auth.authorizationId
    },
  })
}
