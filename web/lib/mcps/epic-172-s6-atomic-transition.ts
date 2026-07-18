import postgres from 'postgres'
import { createHash, randomUUID } from 'node:crypto'
import {
  assertEpic172S6ReleaseOrderOwnership,
  type Epic172S6OwnedNodeId,
  type Epic172S6VerifiedReleaseEvidence,
  type Epic172S6VerifiedTransitionAuthorization,
} from './epic-172-s6-release-adapter'

function transitionDatabaseUrl(): string {
  const value = process.env.FORGE_EPIC_172_TRANSITION_DATABASE_URL?.trim()
  if (!value) throw new Error('FORGE_EPIC_172_TRANSITION_DATABASE_URL is required for S6 release transitions.')
  return value
}

function computeTransitionIdentityDigest(input: {
  authorizationId: string
  consumerNode: Epic172S6OwnedNodeId
  operationId: string
  receiptId: string
}): string {
  const hmac = createHash('sha256')
  hmac.update('forge:epic-172:s6-transition:v1\0')
  hmac.update(`${input.receiptId}\0${input.authorizationId}\0${input.consumerNode}\0${input.operationId}`)
  return hmac.digest('hex')
}

export async function completeEpic172S6ReleaseTransition(input: {
  authorizationAttemptId: string
  buildSha: string
  consumerNode: Epic172S6OwnedNodeId
  controllerIdentity: string
  operationId: string
  reviewedSha: string
  verifiedAuthorization: Epic172S6VerifiedTransitionAuthorization
  verifiedEvidence: Epic172S6VerifiedReleaseEvidence
}): Promise<{ receiptId: string; consumptionId: string; transitionIdentityDigest: string }> {
  assertEpic172S6ReleaseOrderOwnership()

  const evidence = input.verifiedEvidence.envelope
  const authorization = input.verifiedAuthorization.envelope
  const receiptId = evidence.receiptId
  const transitionIdentityDigest = computeTransitionIdentityDigest({
    authorizationId: authorization.authorizationId,
    consumerNode: input.consumerNode,
    operationId: input.operationId,
    receiptId,
  })

  const sql = postgres(transitionDatabaseUrl(), {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })

  try {
    await sql.unsafe('set local role forge_release_transition')

    await sql.begin(async (tx) => {
      await tx.unsafe(`
        select forge.consume_epic_172_release_evidence_v1(
          '${receiptId}'::uuid,
          '${authorization.authorizationId}'::uuid,
          '${transitionIdentityDigest}'::text,
          '${input.consumerNode}'::text,
          '${input.operationId}'::text
        )
      `)

      await tx.unsafe(`
        insert into forge_epic_172_release_evidence (
          id, evidence_kind, signer_key_id, signer_generation,
          envelope, transition_identity_digest,
          required_evidence, schema_version, github_app_id,
          issued_at, build_sha
        ) values (
          '${receiptId}'::uuid,
          '${evidence.evidenceKind}'::text,
          '${evidence.signerKeyId}'::uuid,
          ${evidence.signerGeneration}::integer,
          '${JSON.stringify(evidence).replace(/'/g, "''")}'::jsonb,
          '${transitionIdentityDigest}'::text,
          '${JSON.stringify(evidence.requiredEvidence ?? []).replace(/'/g, "''")}'::jsonb,
          1,
          '${evidence.githubAppId}'::text,
          '${evidence.issuedAt}'::timestamptz,
          '${input.buildSha}'::text
        )
      `)
    })

    return {
      receiptId,
      consumptionId: randomUUID(),
      transitionIdentityDigest,
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
