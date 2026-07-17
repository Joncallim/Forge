import { createPublicKey } from 'node:crypto'
import postgres from 'postgres'
import {
  parseEpic172ReleaseEvidenceEnvelope,
  parseEpic172TransitionAuthorizationEnvelope,
  verifyEpic172ReleaseEvidence,
  verifyEpic172TransitionAuthorization,
  type Epic172ReleaseEvidenceEnvelope,
  type Epic172TransitionAuthorizationEnvelope,
} from './epic-172-release-verifier'

const EVIDENCE_WRITER = 'forge_release_evidence_writer'
const RELEASE_TRANSITION = 'forge_release_transition'

type SignedEnvelopeInput = Readonly<{
  envelope: unknown
  envelopeDigest: string
  detachedSignature: Uint8Array
}>

type SignerRow = Readonly<{
  id: string
  generation: string
  publicKeySpki: Uint8Array
}>

type StoredReleaseRow = Readonly<{
  envelope: unknown
  envelopeDigest: string
  detachedSignature: Uint8Array
  signerKeyId: string
  transitionIdentityDigest: string
}>

type StoredAuthorizationRow = Readonly<{
  envelope: unknown
  envelopeDigest: string
  detachedSignature: Uint8Array
  signerKeyId: string
  transitionIdentityDigest: string
  operationId: string
  targetNode: string
}>

export type Epic172RecordedEvidence = Readonly<{
  receiptId: string
  recordedAt: Date
}>

export type Epic172RecordedAuthorization = Readonly<{
  authorizationId: string
  recordedAt: Date
}>

export type Epic172EvidenceConsumption = Readonly<{
  consumptionId: string
  consumedAt: Date
}>

export class Epic172ReleaseTransactionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Epic172ReleaseTransactionError'
  }
}

function boundedLifecycleText(actor: string, reason: string): void {
  if (actor.trim().length === 0 || Buffer.byteLength(actor.trim(), 'utf8') > 200) {
    throw new Epic172ReleaseTransactionError('Signer lifecycle actor must contain 1..200 UTF-8 bytes.')
  }
  if (Buffer.byteLength(reason, 'utf8') > 1000) {
    throw new Epic172ReleaseTransactionError('Signer lifecycle reason must contain at most 1000 UTF-8 bytes.')
  }
}

function assertEd25519Spki(publicKeySpki: Uint8Array): void {
  if (publicKeySpki.byteLength === 0 || publicKeySpki.byteLength > 512) {
    throw new Epic172ReleaseTransactionError('The reviewed signer public key must be a bounded Ed25519 SPKI key.')
  }
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpki), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type')
  } catch {
    throw new Epic172ReleaseTransactionError('The reviewed signer public key must be a bounded Ed25519 SPKI key.')
  }
}

export async function installEpic172ReleaseSigner(input: Readonly<{
  databaseUrl: string
  signerKeyId: string
  generation: number
  publicKeySpki: Uint8Array
  githubAppId: string
  rulesetFingerprint: string
  validFrom: Date
  validUntil: Date
  actor: string
  reason: string
}>): Promise<string> {
  assertEd25519Spki(input.publicKeySpki)
  boundedLifecycleText(input.actor, input.reason)
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
    throw new Epic172ReleaseTransactionError('Signer generation must be a positive safe integer.')
  }
  if (!Number.isFinite(input.validFrom.getTime()) || input.validUntil.getTime() <= input.validFrom.getTime()) {
    throw new Epic172ReleaseTransactionError('Signer validity must be a non-empty finite interval.')
  }
  const client = releaseClient(input.databaseUrl)
  try {
    return await client.begin('isolation level serializable', async (tx) => {
      await assertPrincipal(tx, EVIDENCE_WRITER)
      const [row] = await tx<{ signerKeyId: string }[]>`
        select forge.install_epic_172_release_signer_v1(
          ${input.signerKeyId}::uuid,
          ${input.generation}::bigint,
          ${Buffer.from(input.publicKeySpki)}::bytea,
          ${input.githubAppId}::text,
          ${input.rulesetFingerprint}::text,
          ${input.validFrom.toISOString()}::timestamptz,
          ${input.validUntil.toISOString()}::timestamptz,
          ${input.actor.trim()}::text,
          ${input.reason}::text
        )::text as "signerKeyId"
      `
      if (!row) throw new Epic172ReleaseTransactionError('The reviewed signer key was not installed.')
      return row.signerKeyId
    })
  } finally {
    await client.end({ timeout: 5 })
  }
}

async function changeEpic172ReleaseSignerState(input: Readonly<{
  databaseUrl: string
  signerKeyId: string
  actor: string
  reason: string
  action: 'activate' | 'retire'
}>): Promise<string> {
  boundedLifecycleText(input.actor, input.reason)
  const client = releaseClient(input.databaseUrl)
  try {
    return await client.begin('isolation level serializable', async (tx) => {
      await assertPrincipal(tx, EVIDENCE_WRITER)
      const rows = input.action === 'activate'
        ? await tx<{ signerKeyId: string }[]>`
          select forge.activate_epic_172_release_signer_v1(
            ${input.signerKeyId}::uuid, ${input.actor.trim()}::text, ${input.reason}::text
          )::text as "signerKeyId"
        `
        : await tx<{ signerKeyId: string }[]>`
          select forge.retire_epic_172_release_signer_v1(
            ${input.signerKeyId}::uuid, ${input.actor.trim()}::text, ${input.reason}::text
          )::text as "signerKeyId"
        `
      if (!rows[0]) throw new Epic172ReleaseTransactionError(`The signer ${input.action} operation did not commit.`)
      return rows[0].signerKeyId
    })
  } finally {
    await client.end({ timeout: 5 })
  }
}

export function activateEpic172ReleaseSigner(input: Readonly<{
  databaseUrl: string
  signerKeyId: string
  actor: string
  reason: string
}>): Promise<string> {
  return changeEpic172ReleaseSignerState({ ...input, action: 'activate' })
}

export function retireEpic172ReleaseSigner(input: Readonly<{
  databaseUrl: string
  signerKeyId: string
  actor: string
  reason: string
}>): Promise<string> {
  return changeEpic172ReleaseSignerState({ ...input, action: 'retire' })
}

function releaseClient(databaseUrl: string): postgres.Sql {
  if (databaseUrl.trim() === '') {
    throw new Epic172ReleaseTransactionError('A dedicated release-principal database URL is required.')
  }
  return postgres(databaseUrl, {
    max: 1,
    onnotice: () => {},
    // These transactions carry signatures and release identities. Never enable a
    // query logger here: bound values are intentionally not an operator log.
    debug: false,
  })
}

async function assertPrincipal(
  tx: postgres.TransactionSql,
  expected: typeof EVIDENCE_WRITER | typeof RELEASE_TRANSITION,
): Promise<Date> {
  const [identity] = await tx<{ sessionUser: string; databaseNow: Date }[]>`
    select session_user as "sessionUser", pg_catalog.clock_timestamp() as "databaseNow"
  `
  if (!identity || identity.sessionUser !== expected) {
    throw new Epic172ReleaseTransactionError(`Release operation requires the dedicated ${expected} login.`)
  }
  return identity.databaseNow
}

async function lockSigner(
  tx: postgres.TransactionSql,
  signerKeyId: string,
): Promise<SignerRow> {
  const [signer] = await tx<SignerRow[]>`
    select
      id::text as id,
      generation::text as generation,
      public_key_spki as "publicKeySpki"
    from forge.lock_epic_172_signer_for_verification_v1(${signerKeyId}::uuid)
  `
  if (!signer) throw new Epic172ReleaseTransactionError('The pinned release signer key does not exist.')
  return signer
}

async function lockReceiptSet(
  tx: postgres.TransactionSql,
  receiptIds: readonly string[],
): Promise<void> {
  if (receiptIds.length === 0) return
  const rows = await tx<{ id: string }[]>`
    select id::text as id
    from forge.lock_epic_172_release_receipts_v1(${tx.array([...receiptIds])}::uuid[])
  `
  if (rows.length !== receiptIds.length || rows.some((row, index) => row.id !== receiptIds[index])) {
    throw new Epic172ReleaseTransactionError('The exact canonical predecessor receipt set is not retained.')
  }
}

async function lockEvidenceIdentity(
  tx: postgres.TransactionSql,
  transitionIdentityDigest: string,
  nonce: string,
): Promise<void> {
  const identityLock = `forge:epic-172:evidence:identity:${transitionIdentityDigest}`
  const nonceLock = `forge:epic-172:evidence:nonce:${nonce}`
  await tx`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${identityLock}, 0)
    )
  `
  await tx`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${nonceLock}, 0)
    )
  `
}

async function lockAuthorizationIdentity(
  tx: postgres.TransactionSql,
  transitionIdentityDigest: string,
  nonce: string,
): Promise<void> {
  const identityLock = `forge:epic-172:authorization:identity:${transitionIdentityDigest}`
  const nonceLock = `forge:epic-172:authorization:nonce:${nonce}`
  await tx`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${identityLock}, 0)
    )
  `
  await tx`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${nonceLock}, 0)
    )
  `
}

function assertSignerGeneration(signer: SignerRow, envelopeGeneration: number): void {
  if (BigInt(signer.generation) !== BigInt(envelopeGeneration)) {
    throw new Epic172ReleaseTransactionError('The signed envelope does not use the locked signer generation.')
  }
}

function requireVerified<Envelope>(
  result:
    | { ok: true; envelope: Envelope; envelopeDigest: string }
    | { ok: false; reason: string },
): Envelope {
  if (!result.ok) {
    throw new Epic172ReleaseTransactionError(`Release envelope verification failed: ${result.reason}.`)
  }
  return result.envelope
}

async function insertVerifiedEvidence(
  tx: postgres.TransactionSql,
  envelope: Epic172ReleaseEvidenceEnvelope,
  input: SignedEnvelopeInput,
): Promise<Epic172RecordedEvidence> {
  const [recorded] = await tx<Epic172RecordedEvidence[]>`
    select
      receipt_id::text as "receiptId",
      recorded_at as "recordedAt"
    from forge.record_epic_172_release_evidence_v1(
      ${envelope.receiptId}::uuid,
      ${envelope.evidenceKind}::text,
      ${envelope.owner.issue}::integer,
      ${envelope.owner.slice}::text,
      ${tx.json([...envelope.exactBuilds])}::jsonb,
      ${envelope.reviewedSha}::text,
      ${envelope.epoch}::bigint,
      ${tx.json([...envelope.predecessorReceiptIds])}::jsonb,
      ${envelope.predecessorSetDigest}::text,
      ${envelope.transitionIdentityDigest}::text,
      ${envelope.signerKeyId}::uuid,
      ${envelope.signerGeneration}::bigint,
      ${envelope.githubAppId}::text,
      ${envelope.controllerRunId}::text,
      ${envelope.controllerJobId}::text,
      ${input.envelopeDigest}::text,
      ${Buffer.from(input.detachedSignature)}::bytea,
      ${envelope.nonce}::uuid,
      ${envelope.issuedAt}::timestamptz,
      ${tx.json(envelope)}::jsonb
    )
  `
  if (!recorded) throw new Epic172ReleaseTransactionError('The verified release receipt was not recorded.')
  return recorded
}

export async function recordEpic172ReleaseEvidence(
  input: SignedEnvelopeInput & Readonly<{ databaseUrl: string }>,
): Promise<Epic172RecordedEvidence> {
  const parsed = parseEpic172ReleaseEvidenceEnvelope(input.envelope)
  const client = releaseClient(input.databaseUrl)
  try {
    return await client.begin('isolation level serializable', async (tx) => {
      const databaseNow = await assertPrincipal(tx, EVIDENCE_WRITER)
      await lockEvidenceIdentity(tx, parsed.transitionIdentityDigest, parsed.nonce)
      const signer = await lockSigner(tx, parsed.signerKeyId)
      assertSignerGeneration(signer, parsed.signerGeneration)
      await lockReceiptSet(tx, parsed.predecessorReceiptIds)
      const envelope = requireVerified(verifyEpic172ReleaseEvidence({
        envelope: input.envelope,
        envelopeDigest: input.envelopeDigest,
        detachedSignature: input.detachedSignature,
        publicKeySpki: signer.publicKeySpki,
        databaseNow,
      }))
      return insertVerifiedEvidence(tx, envelope, input)
    })
  } finally {
    await client.end({ timeout: 5 })
  }
}

async function insertVerifiedAuthorization(
  tx: postgres.TransactionSql,
  envelope: Epic172TransitionAuthorizationEnvelope,
  input: SignedEnvelopeInput,
): Promise<Epic172RecordedAuthorization> {
  const [recorded] = await tx<Epic172RecordedAuthorization[]>`
    select
      authorization_id::text as "authorizationId",
      recorded_at as "recordedAt"
    from forge.record_epic_172_transition_authorization_v1(
      ${envelope.authorizationId}::uuid,
      ${envelope.targetNode}::text,
      ${envelope.transitionIdentityDigest}::text,
      ${tx.json([...envelope.sourceReceiptIds])}::jsonb,
      ${envelope.sourceReceiptSetDigest}::text,
      ${envelope.owner.issue}::integer,
      ${envelope.owner.slice}::text,
      ${tx.json([...envelope.exactBuilds])}::jsonb,
      ${envelope.reviewedSha}::text,
      ${envelope.epoch}::bigint,
      ${envelope.operationId}::text,
      ${envelope.operation}::text,
      ${envelope.controllerLoginId}::text,
      ${envelope.controllerRunId}::text,
      ${envelope.signerKeyId}::uuid,
      ${envelope.signerGeneration}::bigint,
      ${input.envelopeDigest}::text,
      ${Buffer.from(input.detachedSignature)}::bytea,
      ${envelope.nonce}::uuid,
      ${envelope.issuedAt}::timestamptz,
      ${envelope.expiresAt}::timestamptz,
      ${tx.json(envelope)}::jsonb
    )
  `
  if (!recorded) throw new Epic172ReleaseTransactionError('The verified transition authorization was not recorded.')
  return recorded
}

export async function recordEpic172TransitionAuthorization(
  input: SignedEnvelopeInput & Readonly<{ databaseUrl: string }>,
): Promise<Epic172RecordedAuthorization> {
  const parsed = parseEpic172TransitionAuthorizationEnvelope(input.envelope)
  const client = releaseClient(input.databaseUrl)
  try {
    return await client.begin('isolation level serializable', async (tx) => {
      const databaseNow = await assertPrincipal(tx, EVIDENCE_WRITER)
      await lockAuthorizationIdentity(tx, parsed.transitionIdentityDigest, parsed.nonce)
      const signer = await lockSigner(tx, parsed.signerKeyId)
      assertSignerGeneration(signer, parsed.signerGeneration)
      await lockReceiptSet(tx, parsed.sourceReceiptIds)
      const envelope = requireVerified(verifyEpic172TransitionAuthorization({
        envelope: input.envelope,
        envelopeDigest: input.envelopeDigest,
        detachedSignature: input.detachedSignature,
        publicKeySpki: signer.publicKeySpki,
        databaseNow,
      }))
      return insertVerifiedAuthorization(tx, envelope, input)
    })
  } finally {
    await client.end({ timeout: 5 })
  }
}

async function lockStoredTransition(
  tx: postgres.TransactionSql,
  receiptId: string,
  authorizationId: string,
): Promise<{
  receipt: StoredReleaseRow
  authorization: StoredAuthorizationRow
  signerById: Map<string, SignerRow>
}> {
  await tx`
    select forge.lock_epic_172_transition_verification_v1(
      ${receiptId}::uuid,
      ${authorizationId}::uuid
    )
  `
  const [receipt] = await tx<StoredReleaseRow[]>`
    select
      envelope,
      envelope_digest as "envelopeDigest",
      detached_signature as "detachedSignature",
      signer_key_id::text as "signerKeyId",
      transition_identity_digest as "transitionIdentityDigest"
    from public.forge_epic_172_release_evidence
    where id = ${receiptId}::uuid
  `
  const [authorization] = await tx<StoredAuthorizationRow[]>`
    select
      envelope,
      envelope_digest as "envelopeDigest",
      detached_signature as "detachedSignature",
      signer_key_id::text as "signerKeyId",
      transition_identity_digest as "transitionIdentityDigest",
      operation_id as "operationId",
      target_node as "targetNode"
    from public.forge_epic_172_transition_authorizations
    where id = ${authorizationId}::uuid
  `
  if (!receipt || !authorization) {
    throw new Epic172ReleaseTransactionError('The exact release receipt and transition authorization are required.')
  }
  const signerIds = [...new Set([receipt.signerKeyId, authorization.signerKeyId])].sort()
  const signers = await tx<SignerRow[]>`
    select
      id::text as id,
      generation::text as generation,
      public_key_spki as "publicKeySpki"
    from public.forge_release_signer_keys
    where id = any(${tx.array(signerIds)}::uuid[])
    order by id
  `
  if (signers.length !== signerIds.length) {
    throw new Epic172ReleaseTransactionError('A signer key required by the transition is missing.')
  }
  return { receipt, authorization, signerById: new Map(signers.map((signer) => [signer.id, signer])) }
}

function verifyStoredTransition(
  locked: Awaited<ReturnType<typeof lockStoredTransition>>,
  databaseNow: Date,
  input: {
    consumerNode: string
    operationId: string
    transitionIdentityDigest: string
  },
): void {
  const receiptSigner = locked.signerById.get(locked.receipt.signerKeyId)
  const authorizationSigner = locked.signerById.get(locked.authorization.signerKeyId)
  if (!receiptSigner || !authorizationSigner) {
    throw new Epic172ReleaseTransactionError('The transition signer lock was lost.')
  }
  const receipt = requireVerified(verifyEpic172ReleaseEvidence({
    envelope: locked.receipt.envelope,
    envelopeDigest: locked.receipt.envelopeDigest,
    detachedSignature: locked.receipt.detachedSignature,
    publicKeySpki: receiptSigner.publicKeySpki,
    databaseNow,
  }))
  const authorization = requireVerified(verifyEpic172TransitionAuthorization({
    envelope: locked.authorization.envelope,
    envelopeDigest: locked.authorization.envelopeDigest,
    detachedSignature: locked.authorization.detachedSignature,
    publicKeySpki: authorizationSigner.publicKeySpki,
    databaseNow,
  }))
  assertSignerGeneration(receiptSigner, receipt.signerGeneration)
  assertSignerGeneration(authorizationSigner, authorization.signerGeneration)
  if (
    locked.receipt.transitionIdentityDigest !== receipt.transitionIdentityDigest
    || locked.authorization.transitionIdentityDigest !== authorization.transitionIdentityDigest
    || authorization.transitionIdentityDigest !== input.transitionIdentityDigest
    || authorization.targetNode !== input.consumerNode
    || authorization.operationId !== input.operationId
    || !authorization.sourceReceiptIds.includes(receipt.receiptId)
  ) {
    throw new Epic172ReleaseTransactionError('The receipt and authorization do not bind the exact requested transition.')
  }
}

export async function runEpic172AuthorizedTransition<Result>(input: Readonly<{
  databaseUrl: string
  receiptId: string
  authorizationId: string
  consumerNode: string
  transitionIdentityDigest: string
  operationId: string
  applyTransition: (tx: postgres.TransactionSql) => Promise<Result>
}>): Promise<{ consumption: Epic172EvidenceConsumption; result: Result }> {
  const client = releaseClient(input.databaseUrl)
  try {
    return await client.begin('isolation level serializable', async (tx) => {
      const databaseNow = await assertPrincipal(tx, RELEASE_TRANSITION)
      const locked = await lockStoredTransition(tx, input.receiptId, input.authorizationId)
      verifyStoredTransition(locked, databaseNow, input)

      const [consumption] = await tx<Epic172EvidenceConsumption[]>`
        select
          consumption_id::text as "consumptionId",
          consumed_at as "consumedAt"
        from forge.consume_epic_172_release_evidence_v1(
          ${input.receiptId}::uuid,
          ${input.authorizationId}::uuid,
          ${input.consumerNode}::text,
          ${input.transitionIdentityDigest}::text,
          ${input.operationId}::text
        )
      `
      if (!consumption) throw new Epic172ReleaseTransactionError('The release receipt was not consumed.')

      const result = await input.applyTransition(tx)
      await tx`
        select forge.assert_epic_172_transition_authorization_live_v1(
          ${input.authorizationId}::uuid,
          ${input.operationId}::text
        )
      `
      return { consumption, result }
    })
  } finally {
    await client.end({ timeout: 5 })
  }
}
