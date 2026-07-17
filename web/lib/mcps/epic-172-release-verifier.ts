import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import {
  getEpic172ReleaseOrderNode,
  getEpic172RequiredEvidenceNames,
  type Epic172ReleaseNodeId,
} from './epic-172-release-order'

export const EPIC_172_RELEASE_EVIDENCE_DOMAIN = 'forge:epic-172-release-evidence:v1\0'
export const EPIC_172_TRANSITION_AUTHORIZATION_DOMAIN = 'forge:epic-172-transition-authorization:v1\0'

const MAX_CANONICAL_BYTES = 64 * 1024
const MAX_STRING_BYTES = 4 * 1024
const MAX_ARRAY_ITEMS = 64
const MAX_DEPTH = 12
const SHA_PATTERN = /^[0-9a-f]{40,64}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_.:-]{0,199}$/

type JsonPrimitive = null | boolean | number | string
export type CanonicalJsonValue = JsonPrimitive | readonly CanonicalJsonValue[] | {
  readonly [key: string]: CanonicalJsonValue
}

export type Epic172EnvelopeOwner = Readonly<{
  issue: number
  slice: 'step0' | 's3' | 's4' | 's5' | 's6'
}>

export type Epic172ReleaseEvidenceKind = Epic172ReleaseNodeId | 'enabled_build_tests_green'

export type Epic172RequiredEvidenceClaim = Readonly<{
  name: string
  measurementDigest: string
}>

export type Epic172ReleaseEvidenceEnvelope = Readonly<{
  envelopeVersion: 1
  receiptId: string
  manifestVersion: 1
  evidenceKind: Epic172ReleaseEvidenceKind
  owner: Epic172EnvelopeOwner
  exactBuilds: readonly string[]
  requiredEvidence: readonly Epic172RequiredEvidenceClaim[]
  reviewedSha: string
  epoch: number | null
  predecessorReceiptIds: readonly string[]
  predecessorSetDigest: string
  transitionIdentityDigest: string
  signerKeyId: string
  signerGeneration: number
  githubAppId: string
  controllerRunId: string
  controllerJobId: string
  nonce: string
  issuedAt: string
}>

export type Epic172TransitionAuthorizationEnvelope = Readonly<{
  envelopeVersion: 1
  authorizationId: string
  manifestVersion: 1
  targetNode: Exclude<Epic172ReleaseNodeId, 'step0_retention_bridge'>
  transitionIdentityDigest: string
  sourceReceiptIds: readonly string[]
  sourceReceiptSetDigest: string
  owner: Epic172EnvelopeOwner
  exactBuilds: readonly string[]
  reviewedSha: string
  epoch: number | null
  operationId: string
  operation: string
  controllerLoginId: string
  controllerRunId: string
  signerKeyId: string
  signerGeneration: number
  nonce: string
  issuedAt: string
  expiresAt: string
}>

export type Epic172VerificationFailureReason =
  | 'invalid_envelope'
  | 'digest_mismatch'
  | 'future_issued_at'
  | 'expired_authorization'
  | 'invalid_public_key'
  | 'invalid_signature'

export type Epic172VerificationResult<Envelope> =
  | { ok: true; envelope: Envelope; envelopeDigest: string }
  | { ok: false; reason: Epic172VerificationFailureReason }

type JsonRecord = Record<string, unknown>

export class Epic172EnvelopeValidationError extends Error {
  constructor(path: string, message: string) {
    super(`Invalid Epic 172 envelope at ${path}: ${message}`)
    this.name = 'Epic172EnvelopeValidationError'
  }
}

function fail(path: string, message: string): never {
  throw new Epic172EnvelopeValidationError(path, message)
}

function recordAt(value: unknown, path: string, keys: readonly string[]): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object')
  }
  const record = value as JsonRecord
  const expected = new Set(keys)
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) fail(path, `unknown field ${JSON.stringify(key)}`)
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) fail(path, `missing field ${JSON.stringify(key)}`)
  }
  return record
}

function stringAt(value: unknown, path: string, maxBytes = 200): string {
  if (typeof value !== 'string') fail(path, 'expected a string')
  const normalized = value.normalize('NFC')
  const byteLength = Buffer.byteLength(normalized, 'utf8')
  if (byteLength === 0 || byteLength > maxBytes) fail(path, `expected 1..${maxBytes} UTF-8 bytes`)
  return normalized
}

function matchingStringAt(value: unknown, path: string, pattern: RegExp, label: string): string {
  const normalized = stringAt(value, path)
  if (!pattern.test(normalized)) fail(path, `expected ${label}`)
  return normalized
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(path, 'expected a positive safe integer')
  return value as number
}

function nullablePositiveIntegerAt(value: unknown, path: string): number | null {
  return value === null ? null : positiveIntegerAt(value, path)
}

function timestampAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path, 32)
  const parsed = new Date(timestamp)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail(path, 'expected a canonical UTC timestamp')
  }
  return timestamp
}

function uniqueStringsAt(
  value: unknown,
  path: string,
  options: { min: number; max: number; pattern?: RegExp; label?: string },
): readonly string[] {
  if (!Array.isArray(value) || value.length < options.min || value.length > options.max) {
    fail(path, `expected ${options.min}..${options.max} entries`)
  }
  const strings = value.map((entry, index) => {
    const parsed = stringAt(entry, `${path}[${index}]`, 256)
    if (options.pattern && !options.pattern.test(parsed)) {
      fail(`${path}[${index}]`, `expected ${options.label ?? 'a valid value'}`)
    }
    return parsed
  })
  if (new Set(strings).size !== strings.length) fail(path, 'duplicate entries are forbidden')
  return strings
}

function ownerAt(value: unknown, path: string): Epic172EnvelopeOwner {
  const record = recordAt(value, path, ['issue', 'slice'])
  const issue = positiveIntegerAt(record.issue, `${path}.issue`)
  const slice = stringAt(record.slice, `${path}.slice`, 16)
  if (!['step0', 's3', 's4', 's5', 's6'].includes(slice)) fail(`${path}.slice`, 'unknown owner slice')
  return { issue, slice: slice as Epic172EnvelopeOwner['slice'] }
}

function assertOwner(kind: Epic172ReleaseEvidenceKind, owner: Epic172EnvelopeOwner): void {
  const expected = kind === 'enabled_build_tests_green'
    ? { issue: 181, slice: 's6' }
    : getEpic172ReleaseOrderNode(kind).owner
  if (owner.issue !== expected.issue || owner.slice !== expected.slice) {
    fail('owner', `does not own ${JSON.stringify(kind)}`)
  }
}

function assertBuildAndEpochContract(
  kind: Epic172ReleaseEvidenceKind,
  exactBuilds: readonly string[],
  epoch: number | null,
): void {
  const contract = kind === 'enabled_build_tests_green'
    ? {
      exactBuilds: ['issue_179_s4', 'issue_180_s5', 'issue_181_s6'] as const,
      epoch: 'required' as const,
    }
    : {
      exactBuilds: getEpic172ReleaseOrderNode(kind).buildIdentity.exactBuilds,
      epoch: getEpic172ReleaseOrderNode(kind).buildIdentity.epoch,
    }
  if (exactBuilds.length !== contract.exactBuilds.length) {
    fail('exactBuilds', `expected exactly ${contract.exactBuilds.length} build identities for ${JSON.stringify(kind)}`)
  }
  for (const [index, buildSlot] of contract.exactBuilds.entries()) {
    if (!exactBuilds[index]?.startsWith(`${buildSlot}@`) || exactBuilds[index].length === buildSlot.length + 1) {
      fail(`exactBuilds[${index}]`, `expected the ${JSON.stringify(buildSlot)} build slot in manifest order`)
    }
  }
  if ((contract.epoch === 'required') !== (epoch !== null)) {
    fail('epoch', `${contract.epoch === 'required' ? 'is required' : 'must be null'} for ${JSON.stringify(kind)}`)
  }
}

function releaseEvidenceKindAt(value: unknown): Epic172ReleaseEvidenceKind {
  const kind = stringAt(value, 'evidenceKind', 64)
  if (kind === 'enabled_build_tests_green') return kind
  try {
    getEpic172ReleaseOrderNode(kind as Epic172ReleaseNodeId)
    return kind as Epic172ReleaseNodeId
  } catch {
    fail('evidenceKind', `unknown evidence kind ${JSON.stringify(kind)}`)
  }
}

function requiredEvidenceAt(
  value: unknown,
  kind: Epic172ReleaseEvidenceKind,
): readonly Epic172RequiredEvidenceClaim[] {
  const expectedNames = getEpic172RequiredEvidenceNames(kind)
  if (!Array.isArray(value) || value.length !== expectedNames.length) {
    fail('requiredEvidence', `expected exactly ${expectedNames.length} ordered measurement claims for ${JSON.stringify(kind)}`)
  }
  return value.map((entry, index) => {
    const record = recordAt(entry, `requiredEvidence[${index}]`, ['name', 'measurementDigest'])
    const name = stringAt(record.name, `requiredEvidence[${index}].name`, 128)
    if (name !== expectedNames[index]) {
      fail(`requiredEvidence[${index}].name`, `expected ${JSON.stringify(expectedNames[index])}`)
    }
    return {
      name,
      measurementDigest: matchingStringAt(
        record.measurementDigest,
        `requiredEvidence[${index}].measurementDigest`,
        DIGEST_PATTERN,
        'a lowercase SHA-256 measurement digest',
      ),
    }
  })
}

function targetNodeAt(value: unknown): Exclude<Epic172ReleaseNodeId, 'step0_retention_bridge'> {
  const node = releaseEvidenceKindAt(value)
  if (node === 'enabled_build_tests_green' || node === 'step0_retention_bridge') {
    fail('targetNode', 'expected a transition target after Step 0')
  }
  return node
}

export function parseEpic172ReleaseEvidenceEnvelope(value: unknown): Epic172ReleaseEvidenceEnvelope {
  const record = recordAt(value, 'root', [
    'envelopeVersion',
    'receiptId',
    'manifestVersion',
    'evidenceKind',
    'owner',
    'exactBuilds',
    'requiredEvidence',
    'reviewedSha',
    'epoch',
    'predecessorReceiptIds',
    'predecessorSetDigest',
    'transitionIdentityDigest',
    'signerKeyId',
    'signerGeneration',
    'githubAppId',
    'controllerRunId',
    'controllerJobId',
    'nonce',
    'issuedAt',
  ])
  if (record.envelopeVersion !== 1) fail('envelopeVersion', 'expected 1')
  if (record.manifestVersion !== 1) fail('manifestVersion', 'expected 1')
  const evidenceKind = releaseEvidenceKindAt(record.evidenceKind)
  const owner = ownerAt(record.owner, 'owner')
  assertOwner(evidenceKind, owner)
  const exactBuilds = uniqueStringsAt(record.exactBuilds, 'exactBuilds', { min: 1, max: 8 })
  const epoch = nullablePositiveIntegerAt(record.epoch, 'epoch')
  assertBuildAndEpochContract(evidenceKind, exactBuilds, epoch)
  const requiredEvidence = requiredEvidenceAt(record.requiredEvidence, evidenceKind)
  const predecessorReceiptIds = uniqueStringsAt(record.predecessorReceiptIds, 'predecessorReceiptIds', {
    min: 0,
    max: MAX_ARRAY_ITEMS,
    pattern: UUID_PATTERN,
    label: 'a UUID',
  })
  if ((evidenceKind === 'step0_retention_bridge') !== (predecessorReceiptIds.length === 0)) {
    fail('predecessorReceiptIds', 'only Step 0 may use the empty predecessor set')
  }
  const predecessorSetDigest = matchingStringAt(
    record.predecessorSetDigest,
    'predecessorSetDigest',
    DIGEST_PATTERN,
    'a SHA-256 digest',
  )
  assertCanonicalReceiptSet(predecessorReceiptIds, predecessorSetDigest, 'predecessorReceiptIds')
  const reviewedSha = matchingStringAt(record.reviewedSha, 'reviewedSha', SHA_PATTERN, 'a reviewed Git SHA')
  const transitionIdentityDigest = matchingStringAt(
    record.transitionIdentityDigest,
    'transitionIdentityDigest',
    DIGEST_PATTERN,
    'a SHA-256 digest',
  )
  assertTransitionIdentity({
    kind: evidenceKind,
    owner,
    exactBuilds,
    reviewedSha,
    epoch,
    predecessorSetDigest,
    transitionIdentityDigest,
  })
  return {
    envelopeVersion: 1,
    receiptId: matchingStringAt(record.receiptId, 'receiptId', UUID_PATTERN, 'a UUID'),
    manifestVersion: 1,
    evidenceKind,
    owner,
    exactBuilds,
    requiredEvidence,
    reviewedSha,
    epoch,
    predecessorReceiptIds,
    predecessorSetDigest,
    transitionIdentityDigest,
    signerKeyId: matchingStringAt(record.signerKeyId, 'signerKeyId', UUID_PATTERN, 'a UUID'),
    signerGeneration: positiveIntegerAt(record.signerGeneration, 'signerGeneration'),
    githubAppId: matchingStringAt(record.githubAppId, 'githubAppId', /^[1-9][0-9]{0,19}$/, 'a GitHub App ID'),
    controllerRunId: stringAt(record.controllerRunId, 'controllerRunId'),
    controllerJobId: stringAt(record.controllerJobId, 'controllerJobId'),
    nonce: matchingStringAt(record.nonce, 'nonce', UUID_PATTERN, 'a UUID'),
    issuedAt: timestampAt(record.issuedAt, 'issuedAt'),
  }
}

export function parseEpic172TransitionAuthorizationEnvelope(
  value: unknown,
): Epic172TransitionAuthorizationEnvelope {
  const record = recordAt(value, 'root', [
    'envelopeVersion',
    'authorizationId',
    'manifestVersion',
    'targetNode',
    'transitionIdentityDigest',
    'sourceReceiptIds',
    'sourceReceiptSetDigest',
    'owner',
    'exactBuilds',
    'reviewedSha',
    'epoch',
    'operationId',
    'operation',
    'controllerLoginId',
    'controllerRunId',
    'signerKeyId',
    'signerGeneration',
    'nonce',
    'issuedAt',
    'expiresAt',
  ])
  if (record.envelopeVersion !== 1) fail('envelopeVersion', 'expected 1')
  if (record.manifestVersion !== 1) fail('manifestVersion', 'expected 1')
  const targetNode = targetNodeAt(record.targetNode)
  const owner = ownerAt(record.owner, 'owner')
  assertOwner(targetNode, owner)
  const exactBuilds = uniqueStringsAt(record.exactBuilds, 'exactBuilds', { min: 1, max: 8 })
  const epoch = nullablePositiveIntegerAt(record.epoch, 'epoch')
  assertBuildAndEpochContract(targetNode, exactBuilds, epoch)
  const issuedAt = timestampAt(record.issuedAt, 'issuedAt')
  const expiresAt = timestampAt(record.expiresAt, 'expiresAt')
  const lifetimeMs = Date.parse(expiresAt) - Date.parse(issuedAt)
  if (lifetimeMs <= 0 || lifetimeMs > 30 * 60 * 1000) {
    fail('expiresAt', 'authorization lifetime must be greater than zero and at most 30 minutes')
  }
  const sourceReceiptIds = uniqueStringsAt(record.sourceReceiptIds, 'sourceReceiptIds', {
    min: 1,
    max: MAX_ARRAY_ITEMS,
    pattern: UUID_PATTERN,
    label: 'a UUID',
  })
  const sourceReceiptSetDigest = matchingStringAt(
    record.sourceReceiptSetDigest,
    'sourceReceiptSetDigest',
    DIGEST_PATTERN,
    'a SHA-256 digest',
  )
  assertCanonicalReceiptSet(sourceReceiptIds, sourceReceiptSetDigest, 'sourceReceiptIds')
  const reviewedSha = matchingStringAt(record.reviewedSha, 'reviewedSha', SHA_PATTERN, 'a reviewed Git SHA')
  const transitionIdentityDigest = matchingStringAt(
    record.transitionIdentityDigest,
    'transitionIdentityDigest',
    DIGEST_PATTERN,
    'a SHA-256 digest',
  )
  assertTransitionIdentity({
    kind: targetNode,
    owner,
    exactBuilds,
    reviewedSha,
    epoch,
    predecessorSetDigest: sourceReceiptSetDigest,
    transitionIdentityDigest,
  })
  return {
    envelopeVersion: 1,
    authorizationId: matchingStringAt(record.authorizationId, 'authorizationId', UUID_PATTERN, 'a UUID'),
    manifestVersion: 1,
    targetNode,
    transitionIdentityDigest,
    sourceReceiptIds,
    sourceReceiptSetDigest,
    owner,
    exactBuilds,
    reviewedSha,
    epoch,
    operationId: stringAt(record.operationId, 'operationId'),
    operation: matchingStringAt(record.operation, 'operation', IDENTIFIER_PATTERN, 'a bounded operation'),
    controllerLoginId: stringAt(record.controllerLoginId, 'controllerLoginId'),
    controllerRunId: stringAt(record.controllerRunId, 'controllerRunId'),
    signerKeyId: matchingStringAt(record.signerKeyId, 'signerKeyId', UUID_PATTERN, 'a UUID'),
    signerGeneration: positiveIntegerAt(record.signerGeneration, 'signerGeneration'),
    nonce: matchingStringAt(record.nonce, 'nonce', UUID_PATTERN, 'a UUID'),
    issuedAt,
    expiresAt,
  }
}

function canonicalize(value: unknown, path: string, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) fail(path, `maximum depth is ${MAX_DEPTH}`)
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    const normalized = value.normalize('NFC')
    if (Buffer.byteLength(normalized, 'utf8') > MAX_STRING_BYTES) fail(path, 'string is too large')
    return JSON.stringify(normalized)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'numbers must be finite')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object' || value === undefined) fail(path, 'unsupported JSON value')
  if (seen.has(value)) fail(path, 'cyclic values are forbidden')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) fail(path, `maximum array length is ${MAX_ARRAY_ITEMS}`)
      return `[${value.map((entry, index) => canonicalize(entry, `${path}[${index}]`, depth + 1, seen)).join(',')}]`
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      fail(path, 'expected a plain object')
    }
    const normalizedEntries = Object.entries(value).map(([key, entry]) => [key.normalize('NFC'), entry] as const)
    if (normalizedEntries.length > MAX_ARRAY_ITEMS) fail(path, `maximum object size is ${MAX_ARRAY_ITEMS}`)
    if (new Set(normalizedEntries.map(([key]) => key)).size !== normalizedEntries.length) {
      fail(path, 'keys collide after NFC normalization')
    }
    normalizedEntries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return `{${normalizedEntries.map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalize(entry, `${path}.${key}`, depth + 1, seen)}`
    )).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

export function canonicalizeEpic172Json(value: CanonicalJsonValue): Buffer {
  const encoded = Buffer.from(canonicalize(value, 'root', 0, new Set()), 'utf8')
  if (encoded.length > MAX_CANONICAL_BYTES) fail('root', `canonical envelope exceeds ${MAX_CANONICAL_BYTES} bytes`)
  return encoded
}

export function epic172EnvelopeDigest(envelope: CanonicalJsonValue): string {
  return createHash('sha256').update(canonicalizeEpic172Json(envelope)).digest('hex')
}

export function epic172ReceiptSetDigest(receiptIds: readonly string[]): string {
  const canonicalIds = [...receiptIds].sort()
  if (new Set(canonicalIds).size !== canonicalIds.length) {
    fail('receiptIds', 'duplicate entries are forbidden')
  }
  for (const [index, receiptId] of canonicalIds.entries()) {
    matchingStringAt(receiptId, `receiptIds[${index}]`, UUID_PATTERN, 'a UUID')
  }
  return epic172EnvelopeDigest(canonicalIds)
}

export function epic172TransitionIdentityDigest(input: {
  manifestVersion: 1
  nodeOrRequiredEvidenceKind: Epic172ReleaseEvidenceKind
  owner: Epic172EnvelopeOwner
  exactBuilds: readonly string[]
  reviewedSha: string
  epoch: number | null
  canonicalPredecessorReceiptSetDigest: string
}): string {
  return epic172EnvelopeDigest({
    manifestVersion: input.manifestVersion,
    nodeOrRequiredEvidenceKind: input.nodeOrRequiredEvidenceKind,
    owner: input.owner,
    exactBuilds: input.exactBuilds,
    reviewedSha: input.reviewedSha,
    epochOrNone: input.epoch ?? 'none',
    canonicalPredecessorReceiptSetDigest: input.canonicalPredecessorReceiptSetDigest,
  })
}

function assertCanonicalReceiptSet(
  receiptIds: readonly string[],
  receiptSetDigest: string,
  path: string,
): void {
  const sorted = [...receiptIds].sort()
  if (sorted.some((receiptId, index) => receiptId !== receiptIds[index])) {
    fail(path, 'receipt IDs must use canonical ascending order')
  }
  if (epic172ReceiptSetDigest(receiptIds) !== receiptSetDigest) {
    fail(`${path}Digest`, 'does not match the canonical receipt set')
  }
}

function assertTransitionIdentity(input: {
  kind: Epic172ReleaseEvidenceKind
  owner: Epic172EnvelopeOwner
  exactBuilds: readonly string[]
  reviewedSha: string
  epoch: number | null
  predecessorSetDigest: string
  transitionIdentityDigest: string
}): void {
  const expected = epic172TransitionIdentityDigest({
    manifestVersion: 1,
    nodeOrRequiredEvidenceKind: input.kind,
    owner: input.owner,
    exactBuilds: input.exactBuilds,
    reviewedSha: input.reviewedSha,
    epoch: input.epoch,
    canonicalPredecessorReceiptSetDigest: input.predecessorSetDigest,
  })
  if (expected !== input.transitionIdentityDigest) {
    fail('transitionIdentityDigest', 'does not match the canonical transition identity')
  }
}

function signedBytes(domain: string, envelope: CanonicalJsonValue): Buffer {
  return Buffer.concat([Buffer.from(domain, 'utf8'), canonicalizeEpic172Json(envelope)])
}

export function epic172ReleaseEvidenceSignedBytes(value: unknown): Buffer {
  const envelope = parseEpic172ReleaseEvidenceEnvelope(value)
  return signedBytes(EPIC_172_RELEASE_EVIDENCE_DOMAIN, envelope)
}

export function epic172TransitionAuthorizationSignedBytes(value: unknown): Buffer {
  const envelope = parseEpic172TransitionAuthorizationEnvelope(value)
  return signedBytes(EPIC_172_TRANSITION_AUTHORIZATION_DOMAIN, envelope)
}

function digestMatches(envelope: CanonicalJsonValue, expectedDigest: string): boolean {
  if (!DIGEST_PATTERN.test(expectedDigest)) return false
  return timingSafeEqual(
    Buffer.from(epic172EnvelopeDigest(envelope), 'hex'),
    Buffer.from(expectedDigest, 'hex'),
  )
}

function verifyEd25519(publicKeySpki: Uint8Array, data: Uint8Array, signature: Uint8Array): Epic172VerificationFailureReason | null {
  if (publicKeySpki.byteLength === 0 || publicKeySpki.byteLength > 512) return 'invalid_public_key'
  if (signature.byteLength !== 64) return 'invalid_signature'
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpki), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') return 'invalid_public_key'
    return verifySignature(null, data, key, signature) ? null : 'invalid_signature'
  } catch {
    return 'invalid_public_key'
  }
}

export function verifyEpic172ReleaseEvidence(input: {
  envelope: unknown
  envelopeDigest: string
  detachedSignature: Uint8Array
  publicKeySpki: Uint8Array
  databaseNow: Date
}): Epic172VerificationResult<Epic172ReleaseEvidenceEnvelope> {
  let envelope: Epic172ReleaseEvidenceEnvelope
  try {
    envelope = parseEpic172ReleaseEvidenceEnvelope(input.envelope)
  } catch {
    return { ok: false, reason: 'invalid_envelope' }
  }
  if (!digestMatches(envelope, input.envelopeDigest)) return { ok: false, reason: 'digest_mismatch' }
  if (!Number.isFinite(input.databaseNow.getTime()) || Date.parse(envelope.issuedAt) > input.databaseNow.getTime()) {
    return { ok: false, reason: 'future_issued_at' }
  }
  const failure = verifyEd25519(
    input.publicKeySpki,
    signedBytes(EPIC_172_RELEASE_EVIDENCE_DOMAIN, envelope),
    input.detachedSignature,
  )
  return failure ? { ok: false, reason: failure } : { ok: true, envelope, envelopeDigest: input.envelopeDigest }
}

export function verifyEpic172TransitionAuthorization(input: {
  envelope: unknown
  envelopeDigest: string
  detachedSignature: Uint8Array
  publicKeySpki: Uint8Array
  databaseNow: Date
}): Epic172VerificationResult<Epic172TransitionAuthorizationEnvelope> {
  let envelope: Epic172TransitionAuthorizationEnvelope
  try {
    envelope = parseEpic172TransitionAuthorizationEnvelope(input.envelope)
  } catch {
    return { ok: false, reason: 'invalid_envelope' }
  }
  if (!digestMatches(envelope, input.envelopeDigest)) return { ok: false, reason: 'digest_mismatch' }
  const nowMs = input.databaseNow.getTime()
  if (!Number.isFinite(nowMs) || Date.parse(envelope.issuedAt) > nowMs) {
    return { ok: false, reason: 'future_issued_at' }
  }
  if (nowMs >= Date.parse(envelope.expiresAt)) {
    return { ok: false, reason: 'expired_authorization' }
  }
  const failure = verifyEd25519(
    input.publicKeySpki,
    signedBytes(EPIC_172_TRANSITION_AUTHORIZATION_DOMAIN, envelope),
    input.detachedSignature,
  )
  return failure ? { ok: false, reason: failure } : { ok: true, envelope, envelopeDigest: input.envelopeDigest }
}
