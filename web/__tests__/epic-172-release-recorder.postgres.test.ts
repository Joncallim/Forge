import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import controllerLeaseFixture from './__fixtures__/epic-172-controller-lease-v1.json'
import {
  activateEpic172ReleaseSigner,
  installEpic172ReleaseSigner,
  recordEpic172ReleaseEvidence,
  recordEpic172TransitionAuthorization,
  retireEpic172ReleaseSigner,
  runEpic172AuthorizedTransition,
} from '@/lib/mcps/epic-172-release-recorder'
import {
  epic172EnvelopeDigest,
  epic172ReceiptSetDigest,
  epic172ReleaseEvidenceSignedBytes,
  epic172TransitionAuthorizationSignedBytes,
  epic172TransitionIdentityDigest,
  type CanonicalJsonValue,
} from '@/lib/mcps/epic-172-release-verifier'

const WRITER_URL = process.env.FORGE_EPIC_172_TEST_WRITER_DATABASE_URL
const TRANSITION_URL = process.env.FORGE_EPIC_172_TEST_TRANSITION_DATABASE_URL
const APP_URL = process.env.FORGE_EPIC_172_TEST_APP_DATABASE_URL
const hasPostgresFixture = Boolean(WRITER_URL && TRANSITION_URL && APP_URL)

describe.skipIf(!hasPostgresFixture)('Epic 172 release recorder PostgreSQL contract', () => {
  const writer = postgres(WRITER_URL!, { max: 2 })
  const transition = postgres(TRANSITION_URL!, { max: 2 })
  const app = postgres(APP_URL!, { max: 1 })
  const keys = generateKeyPairSync('ed25519')
  const signerKeyId = randomUUID()
  const githubAppId = '172179'
  let step0ReceiptId = ''
  let step0Envelope: ReturnType<typeof makeStep0Envelope>

  function makeStep0Envelope(overrides: Record<string, unknown> = {}) {
    const predecessorReceiptIds: string[] = []
    const predecessorSetDigest = epic172ReceiptSetDigest(predecessorReceiptIds)
    const reviewedSha = randomBytes(20).toString('hex')
    const exactBuilds = [`issue_179_step0@${reviewedSha}`]
    const envelope = {
      envelopeVersion: 1,
      receiptId: randomUUID(),
      manifestVersion: 1,
      evidenceKind: 'step0_retention_bridge',
      owner: { issue: 179, slice: 'step0' },
      exactBuilds,
      reviewedSha,
      epoch: null,
      predecessorReceiptIds,
      predecessorSetDigest,
      transitionIdentityDigest: epic172TransitionIdentityDigest({
        manifestVersion: 1,
        nodeOrRequiredEvidenceKind: 'step0_retention_bridge',
        owner: { issue: 179, slice: 'step0' },
        exactBuilds,
        reviewedSha,
        epoch: null,
        canonicalPredecessorReceiptSetDigest: predecessorSetDigest,
      }),
      signerKeyId,
      signerGeneration: 1,
      githubAppId,
      controllerRunId: 'postgres-recorder-run',
      controllerJobId: 'postgres-recorder-job',
      nonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      ...overrides,
    }
    return envelope
  }

  function makeS3Authorization(receiptId: string, lifetimeMs = 5 * 60_000) {
    const issuedAt = new Date()
    const sourceReceiptIds = [receiptId]
    const sourceReceiptSetDigest = epic172ReceiptSetDigest(sourceReceiptIds)
    const reviewedSha = randomBytes(20).toString('hex')
    const exactBuilds = [`issue_178_s3@${reviewedSha}`]
    return {
      envelopeVersion: 1,
      authorizationId: randomUUID(),
      manifestVersion: 1,
      targetNode: 's3_issue_178',
      transitionIdentityDigest: epic172TransitionIdentityDigest({
        manifestVersion: 1,
        nodeOrRequiredEvidenceKind: 's3_issue_178',
        owner: { issue: 178, slice: 's3' },
        exactBuilds,
        reviewedSha,
        epoch: null,
        canonicalPredecessorReceiptSetDigest: sourceReceiptSetDigest,
      }),
      sourceReceiptIds,
      sourceReceiptSetDigest,
      owner: { issue: 178, slice: 's3' },
      exactBuilds,
      reviewedSha,
      epoch: null,
      operationId: `postgres-transition-${randomUUID()}`,
      operation: 'record_s3_receipt',
      controllerLoginId: 'forge-epic-172-postgres-test',
      controllerRunId: 'postgres-recorder-run',
      signerKeyId,
      signerGeneration: 1,
      nonce: randomUUID(),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + lifetimeMs).toISOString(),
    }
  }

  async function recordRelease(envelope: ReturnType<typeof makeStep0Envelope>) {
    const detachedSignature = sign(null, epic172ReleaseEvidenceSignedBytes(envelope), keys.privateKey)
    return recordEpic172ReleaseEvidence({
      databaseUrl: WRITER_URL!,
      envelope,
      envelopeDigest: epic172EnvelopeDigest(envelope as CanonicalJsonValue),
      detachedSignature,
    })
  }

  async function recordAuthorization(envelope: ReturnType<typeof makeS3Authorization>) {
    const detachedSignature = sign(null, epic172TransitionAuthorizationSignedBytes(envelope), keys.privateKey)
    return recordEpic172TransitionAuthorization({
      databaseUrl: WRITER_URL!,
      envelope,
      envelopeDigest: epic172EnvelopeDigest(envelope as CanonicalJsonValue),
      detachedSignature,
    })
  }

  beforeAll(async () => {
    const [database] = await app<{ name: string }[]>`select current_database() as name`
    const [fixture] = await writer<{ empty: boolean }[]>`
      select not exists(select 1 from public.forge_release_signer_keys) as empty
    `
    if (!database?.name.includes('_test') || !fixture?.empty) {
      throw new Error('Epic 172 PostgreSQL recorder tests require a fresh disposable *_test database.')
    }
    const publicKeySpki = keys.publicKey.export({ format: 'der', type: 'spki' })
    await installEpic172ReleaseSigner({
      databaseUrl: WRITER_URL!,
      signerKeyId,
      generation: 1,
      publicKeySpki,
      githubAppId,
      rulesetFingerprint: randomBytes(32).toString('hex'),
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60 * 60_000),
      actor: 'postgres-test',
      reason: 'reviewed disposable PostgreSQL fixture',
    })
    await activateEpic172ReleaseSigner({
      databaseUrl: WRITER_URL!,
      signerKeyId,
      actor: 'postgres-test',
      reason: 'activate reviewed disposable signer',
    })
    step0Envelope = makeStep0Envelope()
    step0ReceiptId = (await recordRelease(step0Envelope)).receiptId
  })

  afterAll(async () => {
    await Promise.all([
      writer.end({ timeout: 5 }),
      transition.end({ timeout: 5 }),
      app.end({ timeout: 5 }),
    ])
  })

  it('keeps direct DML closed while the app can read the disabled gate', async () => {
    const [privileges] = await app<{ canInsert: boolean; canSelectState: boolean }[]>`
      select
        has_table_privilege(current_user, 'public.forge_epic_172_release_evidence', 'INSERT') as "canInsert",
        has_table_privilege(current_user, 'public.forge_epic_172_enablement_state', 'SELECT') as "canSelectState"
    `
    expect(privileges).toEqual({ canInsert: false, canSelectState: false })
    const [gate] = await app<{ state: string }[]>`select state from forge.read_epic_172_enablement_state_v1()`
    expect(gate).toEqual({ state: 'disabled' })
    await expect(app`select * from public.forge_epic_172_enablement_state`).rejects.toThrow(/permission denied/)
    await expect(app`
      select forge.record_epic_172_release_evidence_v1(
        null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null
      )
    `).rejects.toThrow(/permission denied/)
  })

  it('stores exact 32-byte lease digests and exposes hashing only to the transition principal', async () => {
    const [column] = await app<{ dataType: string }[]>`
      select pg_catalog.format_type(a.atttypid, a.atttypmod) as "dataType"
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'forge_epic_172_enablement_state'
        and a.attname = 'controller_token_digest'
        and not a.attisdropped
    `
    expect(column).toEqual({ dataType: 'bytea' })
    const [row] = await transition<{ digest: Uint8Array }[]>`
      select forge.epic_172_controller_lease_digest_v1(
        ${Buffer.from(controllerLeaseFixture.secretHex, 'hex')}::bytea
      ) as digest
    `
    expect(Buffer.from(row.digest).toString('hex')).toBe(controllerLeaseFixture.digestHex)
    await expect(transition`
      select forge.constant_time_equal_32_v1(${Buffer.alloc(32)}::bytea, ${Buffer.alloc(32)}::bytea)
    `).rejects.toThrow(/permission denied/)
    await expect(app`
      select forge.epic_172_controller_lease_digest_v1(${Buffer.alloc(32)}::bytea)
    `).rejects.toThrow(/permission denied/)
  })

  it('retains one canonical identity and rejects wrong signatures before insertion', async () => {
    const duplicate = {
      ...step0Envelope,
      receiptId: randomUUID(),
      nonce: randomUUID(),
      issuedAt: new Date(Date.now() - 500).toISOString(),
    }
    await expect(recordRelease(duplicate)).rejects.toThrow()

    const invalid = makeStep0Envelope()
    await expect(recordEpic172ReleaseEvidence({
      databaseUrl: WRITER_URL!,
      envelope: invalid,
      envelopeDigest: epic172EnvelopeDigest(invalid as CanonicalJsonValue),
      detachedSignature: randomBytes(64),
    })).rejects.toThrow(/invalid_signature/)
    const [{ count }] = await writer<{ count: number }[]>`
      select count(*)::integer as count
      from public.forge_epic_172_release_evidence
      where id = ${invalid.receiptId}::uuid
    `
    expect(count).toBe(0)
  })

  it('rolls consumption back with the transition and permits one race winner', async () => {
    const authorization = makeS3Authorization(step0ReceiptId)
    await recordAuthorization(authorization)
    const transitionInput = {
      databaseUrl: TRANSITION_URL!,
      receiptId: step0ReceiptId,
      authorizationId: authorization.authorizationId,
      consumerNode: authorization.targetNode,
      transitionIdentityDigest: authorization.transitionIdentityDigest,
      operationId: authorization.operationId,
    }
    await expect(runEpic172AuthorizedTransition({
      ...transitionInput,
      applyTransition: async () => { throw new Error('injected transition failure') },
    })).rejects.toThrow(/injected transition failure/)
    const [{ afterRollback }] = await transition<{ afterRollback: number }[]>`
      select count(*)::integer as "afterRollback"
      from public.forge_epic_172_release_evidence_consumptions
      where authorization_id = ${authorization.authorizationId}::uuid
    `
    expect(afterRollback).toBe(0)

    const outcomes = await Promise.allSettled([
      runEpic172AuthorizedTransition({ ...transitionInput, applyTransition: async () => 'first' }),
      runEpic172AuthorizedTransition({ ...transitionInput, applyTransition: async () => 'second' }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
  })

  it('rechecks expiry after transition work and rolls back a late consumption', async () => {
    const freshReceipt = await recordRelease(makeStep0Envelope())
    const authorization = makeS3Authorization(freshReceipt.receiptId, 1_200)
    await recordAuthorization(authorization)
    await expect(runEpic172AuthorizedTransition({
      databaseUrl: TRANSITION_URL!,
      receiptId: freshReceipt.receiptId,
      authorizationId: authorization.authorizationId,
      consumerNode: authorization.targetNode,
      transitionIdentityDigest: authorization.transitionIdentityDigest,
      operationId: authorization.operationId,
      applyTransition: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        return 'too late'
      },
    })).rejects.toThrow(/expired/)
    const [{ count }] = await transition<{ count: number }[]>`
      select count(*)::integer as count
      from public.forge_epic_172_release_evidence_consumptions
      where authorization_id = ${authorization.authorizationId}::uuid
    `
    expect(count).toBe(0)
  })

  it('does not let the writer rotate or retire without signed predecessor-bound lifecycle evidence', async () => {
    const nextKeys = generateKeyPairSync('ed25519')
    const nextKeyId = randomUUID()
    await expect(installEpic172ReleaseSigner({
      databaseUrl: WRITER_URL!,
      signerKeyId: nextKeyId,
      generation: 2,
      publicKeySpki: nextKeys.publicKey.export({ format: 'der', type: 'spki' }),
      githubAppId,
      rulesetFingerprint: randomBytes(32).toString('hex'),
      validFrom: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60 * 60_000),
      actor: 'postgres-test',
      reason: 'rotate disposable signer',
    })).rejects.toThrow(/signed predecessor-bound lifecycle evidence/)
    await expect(retireEpic172ReleaseSigner({
      databaseUrl: WRITER_URL!, signerKeyId, actor: 'postgres-test', reason: 'complete generation-one retirement',
    })).rejects.toThrow(/signed predecessor-bound lifecycle evidence/)
    const rows = await writer<{ generation: string; status: string }[]>`
      select generation::text as generation, status
      from public.forge_release_signer_keys
      order by generation
    `
    expect(rows).toEqual([{ generation: '1', status: 'active' }])
    const audits = await writer<{ action: string }[]>`
      select action from public.forge_release_signer_key_lifecycle_audits order by occurred_at, id
    `
    expect(audits.map((row) => row.action).sort()).toEqual(['activated', 'installed'])
  })
})
