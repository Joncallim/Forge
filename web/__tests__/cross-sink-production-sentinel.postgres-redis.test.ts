import { spawn } from 'node:child_process'
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import Redis, { ReplyError } from 'ioredis'
import postgres from 'postgres'
import { describe, expect, it, vi } from 'vitest'
import {
  activateEpic172ReleaseSigner,
  completeEpic172S3ReleaseTransition,
  installEpic172ReleaseSigner,
  recordEpic172ReleaseEvidence,
  recordEpic172TransitionAuthorization,
} from '@/lib/mcps/epic-172-release-recorder'
import {
  getEpic172ReleaseOrderNode,
  getEpic172RequiredEvidenceNames,
  type Epic172ReleaseNodeId,
} from '@/lib/mcps/epic-172-release-order'
import {
  epic172EnvelopeDigest,
  epic172ReceiptSetDigest,
  epic172ReleaseEvidenceSignedBytes,
  epic172TransitionAuthorizationSignedBytes,
  epic172TransitionIdentityDigest,
  type CanonicalJsonValue,
  type Epic172ReleaseEvidenceEnvelope,
  type Epic172TransitionAuthorizationEnvelope,
} from '@/lib/mcps/epic-172-release-verifier'
import {
  LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX,
  runLegacyLeakageScrub,
  type LegacyLeakageScrubDatabase,
} from '@/lib/mcps/legacy-leakage-scrub'
import {
  createLegacyLeakagePostgresAdapter,
  createLegacyLeakageRedisAdapter,
} from '@/scripts/scrub-legacy-leakage'
import { taskEventRedisKeys } from '@/lib/task-event-redis'

const sessionState = vi.hoisted(() => ({ userId: '' }))
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(async () => sessionState.userId
    ? { id: 'cross-sink-session', userId: sessionState.userId }
    : null),
}))

const required = process.env.FORGE_CROSS_SINK_REQUIRE_TEST === '1'
const destructive = process.env.FORGE_CROSS_SINK_DESTRUCTIVE_TEST === '1'
const postgresAdminUrl = process.env.FORGE_CROSS_SINK_POSTGRES_ADMIN_URL?.trim()
const postgresAppUrl = process.env.FORGE_CROSS_SINK_POSTGRES_APP_URL?.trim()
const redisAdminUrl = process.env.FORGE_CROSS_SINK_REDIS_ADMIN_URL?.trim()

if (required && (!destructive || !postgresAdminUrl || !postgresAppUrl || !redisAdminUrl)) {
  throw new Error(
    'The mandatory cross-sink proof requires explicit destructive opt-in and dedicated PostgreSQL and Redis URLs.',
  )
}

function validatePostgresTarget(value: string, expectedDatabase: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('The cross-sink proof requires a valid dedicated PostgreSQL URL.')
  }
  const database = parsed.pathname.slice(1)
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
    || parsed.search
    || parsed.hash
    || database !== expectedDatabase
    || !database.includes('cross_sink')
  ) {
    throw new Error('The cross-sink proof requires the exact disposable cross-sink PostgreSQL database.')
  }
  return value
}

function validateRedisTarget(value: string): Readonly<{ database: number; url: string }> {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('The cross-sink proof requires a valid dedicated Redis URL.')
  }
  if (
    (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:')
    || parsed.search
    || parsed.hash
    || !/^\/[1-9][0-9]*$/.test(parsed.pathname)
  ) {
    throw new Error('The cross-sink proof requires an unambiguous nonzero disposable Redis database.')
  }
  const database = Number(parsed.pathname.slice(1))
  if (!Number.isSafeInteger(database) || database < 1 || database > 15) {
    throw new Error('The cross-sink proof requires an unambiguous nonzero disposable Redis database.')
  }
  return { database, url: value }
}

const enabled = Boolean(destructive && postgresAdminUrl && postgresAppUrl && redisAdminUrl)
const expectedDatabase = 'forge_cross_sink_ci_test'
const validatedPostgresAdminUrl = enabled
  ? validatePostgresTarget(postgresAdminUrl!, expectedDatabase)
  : null
const validatedPostgresAppUrl = enabled
  ? validatePostgresTarget(postgresAppUrl!, expectedDatabase)
  : null
const validatedRedis = enabled ? validateRedisTarget(redisAdminUrl!) : null

const hostile = {
  prompt: 'CROSS-SINK-RAW-PROMPT-7c79d4e2',
  plan: 'CROSS-SINK-ARCHITECT-PLAN-c63463a1',
  path: '/private/tmp/cross-sink-secret-repository/project.txt',
  credential: 'password=CROSS-SINK-CREDENTIAL-6a445d63',
  error: 'CROSS-SINK-ERROR-STACK-f1724609',
  digest: `UNKEYED-DIGEST-${'d'.repeat(64)}`,
} as const
const hostileValues = Object.values(hostile)
const fingerprintKey = Buffer.alloc(32, 83)
const fingerprintKeyId = 'cross-sink-proof-hmac-v1'
const safeFailureProofEnvironment = 'FORGE_CROSS_SINK_SAFE_FAILURE_PROOF'
const safeFailureMode = process.env[safeFailureProofEnvironment]
const safeFailureCategory = 'cross_sink.redis.operation_failed'
const cleanupFailurePrefix = 'cross_sink.cleanup_failed:'
const failureSentinels = [
  'CROSS_SINK_REPLY_MESSAGE_SENTINEL',
  'CROSS_SINK_REDIS_URL_SENTINEL',
  'CROSS_SINK_REDIS_AUTH_SECRET_SENTINEL',
  'CROSS_SINK_REDIS_ACL_IDENTITY_SENTINEL',
  'CROSS_SINK_REDIS_KEY_SENTINEL',
  'CROSS_SINK_REDIS_CHANNEL_SENTINEL',
] as const
const environmentKeys = [
  'DATABASE_URL',
  'FORGE_TASK_EVENT_PUBLISHER_REDIS_URL',
  'FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL',
  'FORGE_ENABLE_TASK_LOGS_IN_TEST',
] as const
type EnvironmentKey = typeof environmentKeys[number]
type EnvironmentSnapshot = Readonly<Record<EnvironmentKey, Readonly<{
  present: boolean
  value: string | undefined
}>>>
type CleanupStage = Readonly<{
  category: string
  run: () => Promise<void> | void
}>

function assertFixed(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function fixedError(message: string): Error {
  const error = new Error(message)
  delete error.stack
  return error
}

async function runRedisStep<T>(
  category: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  try {
    return await operation()
  } catch {
    throw fixedError(category)
  }
}

function createRedisClient(url: string, category: string): Redis {
  try {
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    })
    client.on('error', () => undefined)
    return client
  } catch {
    throw fixedError(category)
  }
}

function disconnectRedisClient(client: Redis, category: string): void {
  try {
    client.disconnect()
  } catch {
    throw fixedError(category)
  }
}

function fabricatedRedisFailure(): object {
  const original = Object.assign(new ReplyError(failureSentinels[0]), {
    cause: {
      command: {
        args: [failureSentinels[4], failureSentinels[5]],
      },
      connection: {
        options: {
          password: failureSentinels[2],
          username: failureSentinels[3],
        },
        url: `redis://${failureSentinels[3]}:${failureSentinels[2]}@localhost:6380/12#${failureSentinels[1]}`,
      },
    },
    command: {
      args: [failureSentinels[4], failureSentinels[5]],
    },
  })
  original.stack = `${failureSentinels[0]}\n${failureSentinels[1]}`
  return original
}

function enumerableStrings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null || seen.has(value)) return []
  seen.add(value)
  return Object.keys(value).flatMap(
    (key) => [key, ...enumerableStrings((value as Record<string, unknown>)[key], seen)],
  )
}

function assertFailureSentinelsAbsent(value: string): void {
  assertFixed(
    failureSentinels.every((sentinel) => !value.includes(sentinel)),
    'The cross-sink proof exposed credential-bearing Redis failure data.',
  )
}

async function captureSanitizedRedisFailure(): Promise<Error> {
  try {
    await runRedisStep(safeFailureCategory, async () => {
      throw fabricatedRedisFailure()
    })
  } catch (error) {
    if (
      error instanceof Error
      && error.message === safeFailureCategory
      && Object.keys(error).length === 0
      && Object.getOwnPropertyNames(error).every((property) => property === 'message')
    ) {
      return error
    }
  }
  throw new Error('The cross-sink proof did not receive a closed Redis failure.')
}

async function proveSafeFailureReport(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'forge-cross-sink-safe-failure-'))
  try {
    for (const mode of ['redis', 'cleanup'] as const) {
      const reportPath = join(directory, `${mode}.json`)
      const child = spawn(process.execPath, [
        resolve('node_modules/vitest/vitest.mjs'),
        'run',
        '__tests__/cross-sink-production-sentinel.postgres-redis.test.ts',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, [safeFailureProofEnvironment]: mode },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      const status = await new Promise<number | null>((resolveStatus, rejectStatus) => {
        child.once('error', rejectStatus)
        child.once('close', resolveStatus)
      })
      const report = await readFile(reportPath, 'utf8')
      const visible = `${stdout}\n${stderr}\n${report}`
      const category = mode === 'redis'
        ? safeFailureCategory
        : `${cleanupFailurePrefix}redis,postgres`
      assertFixed(status !== 0 && visible.includes(category),
        'The cross-sink proof did not observe its fixed reporter category.')
      assertFailureSentinelsAbsent(visible)
    }
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message === 'The cross-sink proof did not observe its fixed reporter category.'
        || error.message === 'The cross-sink proof exposed credential-bearing Redis failure data.'
      )
    ) {
      throw error
    }
    throw new Error('The cross-sink proof could not verify Redis reporter non-disclosure.')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

async function runCleanupStages(stages: readonly CleanupStage[]): Promise<readonly string[]> {
  const failures: string[] = []
  for (const stage of stages) {
    try {
      await stage.run()
    } catch {
      failures.push(stage.category)
    }
  }
  return failures
}

function throwAfterCleanup(primary: unknown, cleanupFailures: readonly string[]): void {
  if (primary !== undefined) throw primary
  if (cleanupFailures.length > 0) {
    throw fixedError(`${cleanupFailurePrefix}${cleanupFailures.join(',')}`)
  }
}

async function proveCleanupFailureIsolation(): Promise<void> {
  const trace: string[] = []
  const primary = fixedError('cross_sink.primary_failure')
  const cleanupFailures = await runCleanupStages([
    {
      category: 'redis',
      run: () => {
        trace.push('redis')
        throw fabricatedRedisFailure()
      },
    },
    {
      category: 'postgres',
      run: () => {
        trace.push('postgres')
        throw Object.assign(new Error(failureSentinels[0]), {
          connection: failureSentinels[1],
        })
      },
    },
    {
      category: 'environment',
      run: () => {
        trace.push('environment')
      },
    },
    {
      category: 'final_assertion',
      run: () => {
        trace.push('final_assertion')
      },
    },
  ])
  assertFixed(
    trace.join(',') === 'redis,postgres,environment,final_assertion'
      && cleanupFailures.join(',') === 'redis,postgres',
    'The cross-sink proof cleanup harness did not attempt every ordered stage.',
  )
  try {
    throwAfterCleanup(primary, cleanupFailures)
  } catch (error) {
    assertFixed(error === primary, 'The cross-sink proof cleanup harness replaced the primary failure.')
    const visible = [
      String(error),
      JSON.stringify(error),
      inspect(error),
      JSON.stringify({ cleanupFailures, error }),
      inspect({ cleanupFailures, error }),
      ...enumerableStrings({ cleanupFailures, error }),
    ].join('\n')
    assertFailureSentinelsAbsent(visible)
  }
  try {
    throwAfterCleanup(undefined, cleanupFailures)
  } catch (error) {
    assertFixed(
      error instanceof Error
        && error.message === `${cleanupFailurePrefix}redis,postgres`
        && Object.keys(error).length === 0,
      'The cross-sink proof cleanup harness exposed an unsafe cleanup-only failure.',
    )
    assertFailureSentinelsAbsent([
      String(error),
      JSON.stringify(error),
      inspect(error),
      ...enumerableStrings(error),
    ].join('\n'))
    return
  }
  throw new Error('The cross-sink proof cleanup harness lost its cleanup failures.')
}

function captureEnvironment(): EnvironmentSnapshot {
  return Object.fromEntries(environmentKeys.map((key) => [
    key,
    {
      present: Object.prototype.hasOwnProperty.call(process.env, key),
      value: process.env[key],
    },
  ])) as EnvironmentSnapshot
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const key of environmentKeys) {
    const prior = snapshot[key]
    if (prior.present) process.env[key] = prior.value!
    else delete process.env[key]
  }
}

function assertEnvironmentRestored(snapshot: EnvironmentSnapshot): void {
  for (const key of environmentKeys) {
    const present = Object.prototype.hasOwnProperty.call(process.env, key)
    assertFixed(
      present === snapshot[key].present && process.env[key] === snapshot[key].value,
      'The cross-sink proof did not restore its exact environment boundary.',
    )
  }
}

function roleDatabaseUrl(
  adminUrl: string,
  username: 'forge_release_evidence_writer' | 'forge_release_transition',
  password: 'forge_writer_test' | 'forge_transition_test',
): string {
  try {
    const parsed = new URL(adminUrl)
    parsed.username = username
    parsed.password = password
    return parsed.toString()
  } catch {
    throw new Error('The cross-sink proof could not construct a dedicated release-principal target.')
  }
}

function serverAdminUrl(adminUrl: string): string {
  try {
    const parsed = new URL(adminUrl)
    parsed.pathname = '/postgres'
    return parsed.toString()
  } catch {
    throw new Error('The cross-sink proof could not construct its disposable server-admin target.')
  }
}

function containsHostile(value: unknown): boolean {
  const pending: unknown[] = [value]
  const seen = new Set<unknown>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (hostileValues.some((sentinel) => current.includes(sentinel))) return true
      continue
    }
    if (current === null || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    if (Array.isArray(current)) pending.push(...current)
    else pending.push(...Object.values(current as Record<string, unknown>))
  }
  return false
}

function assertHostileAbsent(value: unknown, boundary: string): void {
  if (containsHostile(value)) {
    throw new Error(`The cross-sink proof found protected source material in ${boundary}.`)
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item)
}

function opaqueDigest(value: Buffer | null): string {
  return createHash('sha256').update(value ?? Buffer.alloc(0)).digest('hex')
}

function credentialUrl(adminUrl: string, username: string, password: string): string {
  try {
    const parsed = new URL(adminUrl)
    parsed.username = encodeURIComponent(username)
    parsed.password = encodeURIComponent(password)
    return parsed.toString()
  } catch {
    throw fixedError('cross_sink.redis.credential_target_invalid')
  }
}

function releaseContract(evidenceKind: Epic172ReleaseNodeId): Readonly<{
  buildSlots: readonly string[]
  epoch: number | null
  owner: Readonly<{ issue: number; slice: 'step0' | 's3' | 's4' | 's5' | 's6' }>
}> {
  const node = getEpic172ReleaseOrderNode(evidenceKind)
  return {
    buildSlots: node.buildIdentity.exactBuilds,
    epoch: node.buildIdentity.epoch === 'required' ? 7 : null,
    owner: node.owner,
  }
}

function makeReleaseEnvelope(input: Readonly<{
  evidenceKind: Epic172ReleaseNodeId
  githubAppId: string
  issuedAt: string
  predecessorReceiptIds: readonly string[]
  receiptId?: string
  signerGeneration: number
  signerKeyId: string
}>): Epic172ReleaseEvidenceEnvelope {
  const contract = releaseContract(input.evidenceKind)
  const reviewedSha = randomBytes(20).toString('hex')
  const exactBuilds = contract.buildSlots.map((slot) => `${slot}@${reviewedSha}`)
  const predecessorReceiptIds = [...input.predecessorReceiptIds].sort()
  const predecessorSetDigest = epic172ReceiptSetDigest(predecessorReceiptIds)
  return {
    envelopeVersion: 1,
    receiptId: input.receiptId ?? randomUUID(),
    manifestVersion: 1,
    evidenceKind: input.evidenceKind,
    owner: contract.owner,
    exactBuilds,
    requiredEvidence: getEpic172RequiredEvidenceNames(input.evidenceKind).map((name, index) => ({
      name,
      measurementDigest: (index + 1).toString(16).padStart(64, '0'),
    })),
    reviewedSha,
    epoch: contract.epoch,
    predecessorReceiptIds,
    predecessorSetDigest,
    transitionIdentityDigest: epic172TransitionIdentityDigest({
      manifestVersion: 1,
      nodeOrRequiredEvidenceKind: input.evidenceKind,
      owner: contract.owner,
      exactBuilds,
      reviewedSha,
      epoch: contract.epoch,
      canonicalPredecessorReceiptSetDigest: predecessorSetDigest,
    }),
    signerKeyId: input.signerKeyId,
    signerGeneration: input.signerGeneration,
    githubAppId: input.githubAppId,
    controllerRunId: 'cross-sink-release-recorder',
    controllerJobId: 'cross-sink-release-evidence',
    nonce: randomUUID(),
    issuedAt: input.issuedAt,
  }
}

function makeReleaseSuccessorEnvelope(input: Readonly<{
  evidenceKind: Epic172ReleaseNodeId
  githubAppId: string
  issuedAt: string
  predecessor: Epic172ReleaseEvidenceEnvelope
  predecessorReceiptIds?: readonly string[]
  receiptId?: string
  signerGeneration: number
  signerKeyId: string
}>): Epic172ReleaseEvidenceEnvelope {
  const predecessorReceiptIds = input.predecessorReceiptIds
    ?? [input.predecessor.receiptId]
  const predecessorSetDigest = epic172ReceiptSetDigest(predecessorReceiptIds)
  const contract = releaseContract(input.evidenceKind)
  return {
    ...makeReleaseEnvelope({
      evidenceKind: input.evidenceKind,
      githubAppId: input.githubAppId,
      issuedAt: input.issuedAt,
      predecessorReceiptIds,
      receiptId: input.receiptId,
      signerGeneration: input.signerGeneration,
      signerKeyId: input.signerKeyId,
    }),
    exactBuilds: input.predecessor.exactBuilds,
    reviewedSha: input.predecessor.reviewedSha,
    epoch: input.predecessor.epoch,
    predecessorReceiptIds,
    predecessorSetDigest,
    transitionIdentityDigest: epic172TransitionIdentityDigest({
      manifestVersion: 1,
      nodeOrRequiredEvidenceKind: input.evidenceKind,
      owner: contract.owner,
      exactBuilds: input.predecessor.exactBuilds,
      reviewedSha: input.predecessor.reviewedSha,
      epoch: input.predecessor.epoch,
      canonicalPredecessorReceiptSetDigest: predecessorSetDigest,
    }),
  }
}

function makeS3Authorization(input: Readonly<{
  issuedAt: string
  predecessorReceiptId: string
  signerGeneration: number
  signerKeyId: string
}>): Epic172TransitionAuthorizationEnvelope {
  const reviewedSha = randomBytes(20).toString('hex')
  const exactBuilds = [`issue_178_s3@${reviewedSha}`]
  const sourceReceiptIds = [input.predecessorReceiptId]
  const sourceReceiptSetDigest = epic172ReceiptSetDigest(sourceReceiptIds)
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
    operationId: `cross-sink-s3-${randomUUID()}`,
    operation: 'record_s3_receipt',
    controllerLoginId: 'cross-sink-release-controller',
    controllerRunId: 'cross-sink-release-recorder',
    signerKeyId: input.signerKeyId,
    signerGeneration: input.signerGeneration,
    nonce: randomUUID(),
    issuedAt: input.issuedAt,
    expiresAt: new Date(new Date(input.issuedAt).getTime() + 5 * 60_000).toISOString(),
  }
}

function makeS3ReleaseEnvelope(
  authorization: Epic172TransitionAuthorizationEnvelope,
  signer: Readonly<{
    githubAppId: string
    issuedAt: string
    signerGeneration: number
    signerKeyId: string
  }>,
): Epic172ReleaseEvidenceEnvelope {
  return {
    ...makeReleaseEnvelope({
      evidenceKind: 's3_issue_178',
      githubAppId: signer.githubAppId,
      issuedAt: signer.issuedAt,
      predecessorReceiptIds: authorization.sourceReceiptIds,
      signerGeneration: signer.signerGeneration,
      signerKeyId: signer.signerKeyId,
    }),
    exactBuilds: authorization.exactBuilds,
    reviewedSha: authorization.reviewedSha,
    predecessorReceiptIds: authorization.sourceReceiptIds,
    predecessorSetDigest: authorization.sourceReceiptSetDigest,
    transitionIdentityDigest: authorization.transitionIdentityDigest,
    controllerRunId: authorization.controllerRunId,
  }
}

function signedRelease(
  envelope: Epic172ReleaseEvidenceEnvelope,
  privateKey: KeyObject,
): Readonly<{
  detachedSignature: Buffer
  envelope: Epic172ReleaseEvidenceEnvelope
  envelopeDigest: string
}> {
  return {
    envelope,
    envelopeDigest: epic172EnvelopeDigest(envelope as CanonicalJsonValue),
    detachedSignature: sign(null, epic172ReleaseEvidenceSignedBytes(envelope), privateKey),
  }
}

function signedAuthorization(
  envelope: Epic172TransitionAuthorizationEnvelope,
  privateKey: KeyObject,
): Readonly<{
  detachedSignature: Buffer
  envelope: Epic172TransitionAuthorizationEnvelope
  envelopeDigest: string
}> {
  return {
    envelope,
    envelopeDigest: epic172EnvelopeDigest(envelope as CanonicalJsonValue),
    detachedSignature: sign(null, epic172TransitionAuthorizationSignedBytes(envelope), privateKey),
  }
}

async function runReleaseStep<T>(
  category: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch {
    throw fixedError(category)
  }
}

async function expectReleaseRejected(
  category: string,
  classify: (error: unknown) => boolean,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (classify(error)) return
    throw fixedError(category)
  }
  throw fixedError(category)
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function redisDump(redis: Redis, key: string): Promise<Readonly<{ digest: string; type: string }>> {
  const [type, dumped] = await runRedisStep(
    'cross_sink.redis.dump_failed',
    () => Promise.all([redis.type(key), redis.callBuffer('DUMP', key)]),
  )
  assertFixed(dumped === null || Buffer.isBuffer(dumped), 'The cross-sink proof received a non-binary Redis DUMP reply.')
  return { digest: opaqueDigest(dumped), type }
}

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  current: string,
  predicate: (value: string) => boolean,
  message: string,
): Promise<string> {
  let output = current
  try {
    while (!predicate(output)) {
      const next = await withTimeout(reader.read(), message)
      if (next.done) break
      output += new TextDecoder().decode(next.value, { stream: true })
    }
  } catch {
    throw fixedError(message)
  }
  assertFixed(predicate(output), message)
  return output
}

function parseAclGetUser(reply: unknown): Readonly<Record<string, unknown>> | null {
  if (reply === null) return null
  if (!Array.isArray(reply) || reply.length % 2 !== 0) {
    throw new Error('The cross-sink proof received malformed ACL identity evidence.')
  }
  const record: Record<string, unknown> = {}
  for (let index = 0; index < reply.length; index += 2) {
    const key = reply[index]
    if (typeof key !== 'string') {
      throw new Error('The cross-sink proof received malformed ACL identity evidence.')
    }
    record[key] = reply[index + 1]
  }
  return record
}

function aclTokens(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.trim().split(/\s+/).filter(Boolean)
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value
  throw new Error('The cross-sink proof received malformed ACL identity evidence.')
}

function assertAclIdentity(
  reply: unknown,
  expectedKeys: readonly string[],
  expectedChannels: readonly string[],
  expectedCommands: readonly string[],
): void {
  const record = parseAclGetUser(reply)
  assertFixed(record !== null, 'The cross-sink proof could not find a configured Redis ACL identity.')
  const flags = record.flags
  const keys = record.keys
  const channels = record.channels
  const commands = record.commands
  const flagTokens = aclTokens(flags)
  const keyTokens = aclTokens(keys)
  const channelTokens = aclTokens(channels)
  const commandValues = aclTokens(commands)
  assertFixed(flagTokens.includes('on') && !flagTokens.includes('off') && !flagTokens.includes('nopass'),
    'The cross-sink proof found an invalid Redis ACL identity state.')
  assertFixed(
    [...keyTokens].sort().join('\n') === [...expectedKeys].sort().join('\n'),
    'The cross-sink proof found unexpected Redis ACL key authority.',
  )
  assertFixed(
    [...channelTokens].sort().join('\n') === [...expectedChannels].sort().join('\n'),
    'The cross-sink proof found unexpected Redis ACL channel authority.',
  )
  const commandTokens = new Set(commandValues)
  assertFixed(commandTokens.has('-@all') && !commandTokens.has('+@all'),
    'The cross-sink proof found broad Redis ACL command authority.')
  for (const command of expectedCommands) {
    assertFixed(commandTokens.has(command), 'The cross-sink proof found incomplete Redis ACL command authority.')
  }
}

type LegacyClientBinding = Readonly<{
  active: boolean
  clientId: number
  database: number
  status: string
  user: string
  whoami: string
}>

function clientListContains(
  listing: string,
  clientId: number,
  user: string,
  database: number,
): boolean {
  return listing.split('\n').some((line) => {
    const tokens = new Set(line.trim().split(/\s+/))
    return tokens.has(`id=${clientId}`)
      && tokens.has(`user=${user}`)
      && tokens.has(`db=${database}`)
  })
}

function requireLiveLegacyBinding(binding: LegacyClientBinding): void {
  if (
    !binding.active
    || !Number.isSafeInteger(binding.clientId)
    || binding.clientId <= 0
    || binding.database < 1
    || binding.status !== 'ready'
    || binding.user.length === 0
    || binding.whoami !== binding.user
  ) {
    throw fixedError('cross_sink.redis.legacy_client_not_bound')
  }
}

async function bindLegacyClient(
  admin: Redis,
  client: Redis,
  user: string,
  database: number,
): Promise<LegacyClientBinding> {
  const [whoami, clientIdReply, listing] = await Promise.all([
    runRedisStep('cross_sink.redis.legacy_whoami_failed', () => client.call('ACL', 'WHOAMI')),
    runRedisStep('cross_sink.redis.legacy_client_id_failed', () => client.client('ID')),
    runRedisStep('cross_sink.redis.client_list_failed', () => admin.client('LIST')),
  ])
  const clientId = Number(clientIdReply)
  const binding = {
    active: typeof listing === 'string' && clientListContains(listing, clientId, user, database),
    clientId,
    database,
    status: client.status,
    user,
    whoami: typeof whoami === 'string' ? whoami : '',
  }
  requireLiveLegacyBinding(binding)
  return binding
}

async function requireLegacyClientTerminated(
  admin: Redis,
  client: Redis,
  binding: LegacyClientBinding,
): Promise<void> {
  await runRedisStep(
    'cross_sink.redis.legacy_client_did_not_terminate',
    () => withTimeout(new Promise<void>((resolve) => {
      if (client.status === 'end') {
        resolve()
        return
      }
      client.once('end', resolve)
    }), 'cross_sink.redis.legacy_client_did_not_terminate'),
  )
  const listing = await runRedisStep(
    'cross_sink.redis.post_revocation_client_list_failed',
    () => admin.client('LIST'),
  )
  assertFixed(
    client.status === 'end'
      && typeof listing === 'string'
      && !clientListContains(
        listing,
        binding.clientId,
        binding.user,
        binding.database,
      ),
    'The cross-sink proof found the bound legacy client after revocation.',
  )
}

async function expectFreshCredentialDenial(
  operation: () => Promise<unknown>,
  observedError: () => unknown,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    const candidate = observedError() ?? error
    const accepted = candidate instanceof Error
      && candidate.name === 'ReplyError'
      && (
        /^WRONGPASS invalid username-password pair(?: or user is disabled)?\.?$/.test(candidate.message)
        || /^NOAUTH Authentication required\.?$/.test(candidate.message)
    )
    if (accepted) return
    throw fixedError('cross_sink.redis.fresh_revocation_mismatch')
  }
  throw fixedError('cross_sink.redis.fresh_revocation_missing')
}

function proveClosedClientCannotBind(): void {
  try {
    requireLiveLegacyBinding({
      active: false,
      clientId: 1,
      database: 12,
      status: 'end',
      user: 'closed_fixture',
      whoami: 'closed_fixture',
    })
  } catch (error) {
    assertFixed(
      error instanceof Error
        && error.message === 'cross_sink.redis.legacy_client_not_bound'
        && Object.keys(error).length === 0,
      'The cross-sink proof did not reject an already-closed legacy client.',
    )
    return
  }
  throw new Error('The cross-sink proof accepted an already-closed legacy client.')
}

if (safeFailureMode === 'redis') {
  describe('S4 cross-sink Redis failure reporter boundary', () => {
    it('emits only the fixed non-disclosing Redis category', async () => {
      await runRedisStep(safeFailureCategory, async () => {
        throw fabricatedRedisFailure()
      })
    })
  })
} else if (safeFailureMode === 'cleanup') {
  describe('S4 cross-sink cleanup failure reporter boundary', () => {
    it('emits only fixed ordered cleanup categories', async () => {
      const failures = await runCleanupStages([
        {
          category: 'redis',
          run: () => {
            throw fabricatedRedisFailure()
          },
        },
        {
          category: 'postgres',
          run: () => {
            throw Object.assign(new Error(failureSentinels[0]), {
              connection: failureSentinels[1],
            })
          },
        },
      ])
      throwAfterCleanup(undefined, failures)
    })
  })
} else describe.skipIf(!enabled)('S4 cross-sink production sentinel proof', () => {
  it('keeps one hostile producer corpus out of every prohibited durable and public sink', async () => {
    const admin = postgres(validatedPostgresAdminUrl!, { max: 5, onnotice: () => {} })
    const redisAdmin = createRedisClient(
      validatedRedis!.url,
      'cross_sink.redis.admin_client_create_failed',
    )
    const writerUrl = roleDatabaseUrl(
      validatedPostgresAdminUrl!,
      'forge_release_evidence_writer',
      'forge_writer_test',
    )
    const transitionUrl = roleDatabaseUrl(
      validatedPostgresAdminUrl!,
      'forge_release_transition',
      'forge_transition_test',
    )
    const disposableServerAdminUrl = serverAdminUrl(validatedPostgresAdminUrl!)

    const ids = {
      user: randomUUID(),
      project: randomUUID(),
      task: randomUUID(),
      run: randomUUID(),
      workPackage: randomUUID(),
      approvalGate: randomUUID(),
      expandReceipt: randomUUID(),
      disabledReceipt: randomUUID(),
    }
    const ownedEvidenceIds = new Set<string>()
    const ownedAuthorizationIds = new Set<string>()
    const signerKeyId = randomUUID()
    const operationId = `cross-sink-${randomUUID()}`
    const checkpointKey = `${LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX}${operationId}`
    const redisKeys = taskEventRedisKeys(ids.task)
    const legacyKeys = {
      history: `forge:task:${ids.task}:history`,
      sequence: `forge:task:${ids.task}:seq`,
    }
    const ownedKeys = new Set([
      redisKeys.history,
      redisKeys.sequence,
      legacyKeys.history,
      legacyKeys.sequence,
    ])
    const publisherUser = `cross_pub_${randomUUID().replaceAll('-', '')}`
    const subscriberUser = `cross_sub_${randomUUID().replaceAll('-', '')}`
    const legacyUser = `cross_legacy_${randomUUID().replaceAll('-', '')}`
    const ownedUsers = new Set([publisherUser, subscriberUser, legacyUser])
    const publisherPassword = randomBytes(32).toString('base64url')
    const subscriberPassword = randomBytes(32).toString('base64url')
    const legacyPassword = randomBytes(32).toString('base64url')
    const publisherUrl = credentialUrl(validatedRedis!.url, publisherUser, publisherPassword)
    const subscriberUrl = credentialUrl(validatedRedis!.url, subscriberUser, subscriberPassword)
    const legacyUrl = credentialUrl(validatedRedis!.url, legacyUser, legacyPassword)
    const clients = new Set<Redis>()
    const diagnosticArguments: unknown[] = []
    const originalWarn = console.warn
    const originalError = console.error
    const previousEnvironment = captureEnvironment()
    let liveReader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let replayReader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let liveAbort: AbortController | null = null
    let replayAbort: AbortController | null = null
    let legacyBinding: LegacyClientBinding | null = null
    let serverAdmin: ReturnType<typeof postgres> | null = null
    let proofComplete = false
    let primaryFailure: unknown
    const verifiedContracts = new Set<string>()
    const requiredContracts = new Set([
      'acl_revocation',
      'authorization_rejected',
      'canonical_prompt_database',
      'checkpoint_replay',
      'cleanup_failure_harness',
      'crash_resume',
      'database_reappearance',
      'database_zero_scan',
      'final_combined_zero_scan',
      'production_composition',
      'producer_disable_predecessor_rejected',
      'producer_disable_epoch_rejected',
      'producer_disable_signature_rejected',
      'producer_disable_signed',
      'redis_failure_reporter',
      'redis_history',
      'redis_live',
      'redis_reappearance',
      'redis_zero_scan',
      'legacy_client_bound',
      'sse_live',
      'sse_replay',
      'sse_snapshot',
      'task_api',
      'task_log_api',
      'task_log_export',
      'worker_diagnostics',
    ])

    const verifyBoundary = (contract: string, value: unknown, boundary: string): void => {
      assertHostileAbsent(value, boundary)
      verifiedContracts.add(contract)
    }

    const trackClient = (url: string, category: string): Redis => {
      const client = createRedisClient(url, category)
      clients.add(client)
      return client
    }

    const scrubOptions = {
      actor: 'cross-sink-proof',
      authorizationReceiptId: ids.disabledReceipt,
      batchSize: 1_000,
      fingerprintKey,
      fingerprintKeyId,
      maxBatches: 1_000,
      operationId,
      sentinels: hostileValues,
    } as const

    try {
      const sanitizedFailure = await captureSanitizedRedisFailure()
      const sanitizedVisible = [
        String(sanitizedFailure),
        JSON.stringify(sanitizedFailure),
        inspect(sanitizedFailure),
        JSON.stringify({ error: sanitizedFailure }),
        inspect({ error: sanitizedFailure }),
        ...enumerableStrings({ error: sanitizedFailure }),
      ].join('\n')
      assertFailureSentinelsAbsent(sanitizedVisible)
      await proveSafeFailureReport()
      verifiedContracts.add('redis_failure_reporter')
      await proveCleanupFailureIsolation()
      verifiedContracts.add('cleanup_failure_harness')
      proveClosedClientCannotBind()

      const proofSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
      const productionComposition = [
        "from '@/lib/mcps/epic-172-release-recorder'",
        "await import('@/worker/orchestrator')",
        "await import('@/worker/task-logs')",
        "await import('@/worker/events')",
        "await import('@/app/api/tasks/[id]/route')",
        "await import('@/app/api/tasks/[id]/logs/route')",
        "await import('@/app/api/tasks/[id]/logs/export/route')",
        "await import('@/app/api/tasks/[id]/runs/route')",
        'const taskResponse = await getTask(',
        'const logsResponse = await getLogs(',
        'const exportResponse = await getExport(',
        'const liveResponse = await runRedisStep(',
        'const replayResponse = await runRedisStep(',
        'createLegacyLeakagePostgresAdapter(admin, fingerprintKey)',
        'createLegacyLeakageRedisAdapter(redisAdmin)',
      ]
      assertFixed(productionComposition.every(
        (fragment) => proofSource.split(fragment).length - 1 === 2,
      ),
        'The cross-sink proof no longer composes every required production surface.')
      verifiedContracts.add('production_composition')

      await runRedisStep('cross_sink.redis.admin_connect_failed', () => redisAdmin.connect())
      const serverInfo = await runRedisStep(
        'cross_sink.redis.server_info_failed',
        () => redisAdmin.info('server'),
      )
      const version = /^redis_version:(\d+)/m.exec(serverInfo)?.[1]
      assertFixed(version !== undefined && Number(version) >= 7,
        'The cross-sink proof requires Redis major version 7 or newer.')
      const initialRedisSize = await runRedisStep(
        'cross_sink.redis.initial_size_failed',
        () => redisAdmin.dbsize(),
      )
      assertFixed(initialRedisSize === 0,
        'The cross-sink proof requires an empty dedicated disposable Redis database.')

      const databaseRows = await admin<{ database: string }[]>`
        select current_database() as database
      `
      assertFixed(databaseRows[0]?.database === expectedDatabase,
        'The cross-sink proof connected to an unexpected PostgreSQL database.')

      const databaseRule = `+select|${validatedRedis!.database}`
      const publisherRules = [
        'reset', 'on', `>${publisherPassword}`,
        `~${redisKeys.history}`, `~${redisKeys.sequence}`, `&${redisKeys.live}`,
        databaseRule, '+ping', '+info', '+client|setinfo', '+eval', '+incr',
        '+zadd', '+zcard', '+zremrangebyrank', '+publish',
      ]
      const subscriberRules = [
        'reset', 'on', `>${subscriberPassword}`,
        `~${redisKeys.history}`, `~${redisKeys.sequence}`, `&${redisKeys.live}`,
        databaseRule, '+ping', '+info', '+client|setinfo', '+get',
        '+zrangebyscore', '+subscribe', '+unsubscribe',
      ]
      const legacyRules = [
        'reset', 'on', `>${legacyPassword}`,
        `~${legacyKeys.history}`, `~${legacyKeys.sequence}`,
        databaseRule, '+ping', '+info', '+client|setinfo', '+client|id',
        '+acl|whoami', '+zadd', '+set',
      ]
      await runRedisStep(
        'cross_sink.redis.publisher_acl_create_failed',
        () => redisAdmin.call('ACL', 'SETUSER', publisherUser, ...publisherRules),
      )
      await runRedisStep(
        'cross_sink.redis.subscriber_acl_create_failed',
        () => redisAdmin.call('ACL', 'SETUSER', subscriberUser, ...subscriberRules),
      )
      await runRedisStep(
        'cross_sink.redis.legacy_acl_create_failed',
        () => redisAdmin.call('ACL', 'SETUSER', legacyUser, ...legacyRules),
      )
      assertAclIdentity(
        await runRedisStep(
          'cross_sink.redis.publisher_acl_read_failed',
          () => redisAdmin.call('ACL', 'GETUSER', publisherUser),
        ),
        [`~${redisKeys.history}`, `~${redisKeys.sequence}`],
        [`&${redisKeys.live}`],
        [databaseRule, '+eval', '+incr', '+zadd', '+publish'],
      )
      assertAclIdentity(
        await runRedisStep(
          'cross_sink.redis.subscriber_acl_read_failed',
          () => redisAdmin.call('ACL', 'GETUSER', subscriberUser),
        ),
        [`~${redisKeys.history}`, `~${redisKeys.sequence}`],
        [`&${redisKeys.live}`],
        [databaseRule, '+get', '+zrangebyscore', '+subscribe'],
      )
      assertAclIdentity(
        await runRedisStep(
          'cross_sink.redis.legacy_acl_read_failed',
          () => redisAdmin.call('ACL', 'GETUSER', legacyUser),
        ),
        [`~${legacyKeys.history}`, `~${legacyKeys.sequence}`],
        [],
        [databaseRule, '+acl|whoami', '+client|id', '+zadd', '+set'],
      )

      process.env.DATABASE_URL = validatedPostgresAppUrl!
      process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = publisherUrl
      process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = subscriberUrl
      process.env.FORGE_ENABLE_TASK_LOGS_IN_TEST = '1'
      sessionState.userId = ids.user
      console.warn = (...args: unknown[]) => { diagnosticArguments.push(args) }
      console.error = (...args: unknown[]) => { diagnosticArguments.push(args) }

      const signerKeys = generateKeyPairSync('ed25519')
      const publicKeySpki = signerKeys.publicKey.export({ format: 'der', type: 'spki' })
      const [signerFixture] = await admin<{
        activeGeneration: number | null
        activeSignerKeyId: string | null
        databaseNow: Date
        nextGeneration: number
      }[]>`
        select
          (
            select generation::integer
            from forge_release_signer_keys
            where policy_id = 'forge-epic-172-release-signing-v1'
              and status = 'active'
          ) as "activeGeneration",
          (
            select id::text
            from forge_release_signer_keys
            where policy_id = 'forge-epic-172-release-signing-v1'
              and status = 'active'
          ) as "activeSignerKeyId",
          clock_timestamp() as "databaseNow",
          (
            select coalesce(max(generation), 0)::integer + 1
            from forge_release_signer_keys
            where policy_id = 'forge-epic-172-release-signing-v1'
          ) as "nextGeneration"
      `
      assertFixed(
        signerFixture !== undefined
          && Number.isSafeInteger(signerFixture.nextGeneration)
          && signerFixture.nextGeneration > 0,
        'The cross-sink proof could not establish an ephemeral signer generation.',
      )
      const signerGeneration = signerFixture.nextGeneration
      const githubAppId = String(1_000_000_000 + randomInt(900_000_000))
      await runReleaseStep('cross_sink.release.signer_install_failed', () => (
        installEpic172ReleaseSigner({
          databaseUrl: writerUrl,
          signerKeyId,
          generation: signerGeneration,
          publicKeySpki,
          githubAppId,
          rulesetFingerprint: randomBytes(32).toString('hex'),
          validFrom: new Date(signerFixture.databaseNow.getTime() - 60_000),
          validUntil: new Date(signerFixture.databaseNow.getTime() + 60 * 60_000),
          actor: 'cross-sink-proof',
          reason: 'install disposable cross-sink proof signer',
        })
      ))
      await runReleaseStep('cross_sink.release.signer_activation_failed', () => (
        activateEpic172ReleaseSigner({
          databaseUrl: writerUrl,
          signerKeyId,
          ...(signerFixture.activeSignerKeyId && signerFixture.activeGeneration
            ? {
              expectedActiveSignerKeyId: signerFixture.activeSignerKeyId,
              expectedActiveGeneration: signerFixture.activeGeneration,
            }
            : {}),
          actor: 'cross-sink-proof',
          reason: 'activate disposable cross-sink proof signer',
        })
      ))
      const [activatedClock] = await admin<{ databaseNow: Date }[]>`
        select clock_timestamp() as "databaseNow"
      `
      assertFixed(activatedClock !== undefined,
        'The cross-sink proof could not read the activated signer clock.')
      const issuedAt = activatedClock.databaseNow.toISOString()

      const step0Envelope = makeReleaseEnvelope({
        evidenceKind: 'step0_retention_bridge',
        githubAppId,
        issuedAt,
        predecessorReceiptIds: [],
        signerGeneration,
        signerKeyId,
      })
      const step0Recorded = await runReleaseStep(
        'cross_sink.release.step0_record_failed',
        () => recordEpic172ReleaseEvidence({
          databaseUrl: writerUrl,
          ...signedRelease(step0Envelope, signerKeys.privateKey),
        }),
      )
      ownedEvidenceIds.add(step0Recorded.receiptId)
      const s3Authorization = makeS3Authorization({
        issuedAt,
        predecessorReceiptId: step0Recorded.receiptId,
        signerGeneration,
        signerKeyId,
      })
      const recordedAuthorization = await runReleaseStep(
        'cross_sink.release.s3_authorization_failed',
        () => recordEpic172TransitionAuthorization({
          databaseUrl: writerUrl,
          ...signedAuthorization(s3Authorization, signerKeys.privateKey),
        }),
      )
      ownedAuthorizationIds.add(recordedAuthorization.authorizationId)
      const s3Envelope = makeS3ReleaseEnvelope(s3Authorization, {
        githubAppId,
        issuedAt,
        signerGeneration,
        signerKeyId,
      })
      const s3Recorded = await runReleaseStep(
        'cross_sink.release.s3_completion_failed',
        () => completeEpic172S3ReleaseTransition({
          databaseUrl: transitionUrl,
          authorizationId: recordedAuthorization.authorizationId,
          buildSha: s3Authorization.exactBuilds[0].slice('issue_178_s3@'.length),
          controllerIdentity: s3Authorization.controllerLoginId,
          operationId: s3Authorization.operationId,
          reviewedSha: s3Authorization.reviewedSha,
          ...signedRelease(s3Envelope, signerKeys.privateKey),
        }),
      )
      ownedEvidenceIds.add(s3Recorded.receiptId)

      await admin.begin(async (tx) => {
        await tx`insert into users (id, display_name) values (${ids.user}::uuid, 'Cross-sink proof')`
        await tx`
          insert into projects (
            id, name, submitted_by, grant_decision_revision, root_binding_revision
          ) values (${ids.project}::uuid, 'Cross-sink proof', ${ids.user}::uuid, 1, 1)
        `
        await tx`
          insert into tasks (id, project_id, submitted_by, title, prompt, status)
          values (
            ${ids.task}::uuid, ${ids.project}::uuid, ${ids.user}::uuid,
            'Cross-sink proof task', ${hostile.prompt}, 'running'
          )
        `
        await tx`
          insert into work_packages (
            id, task_id, assigned_role, title, summary, sequence, status, metadata
          ) values (
            ${ids.workPackage}::uuid, ${ids.task}::uuid, 'backend',
            'Cross-sink package', 'Bounded cross-sink fixture', 1, 'ready',
            ${tx.json({
              prompt: hostile.prompt,
              selectedPath: hostile.path,
              credentials: { password: hostile.credential },
              nested: { message: hostile.error, promptDigest: hostile.digest },
            } as never)}
          )
        `
        await tx`
          insert into agent_runs (
            id, task_id, work_package_id, agent_type, model_id_used, status
          ) values (
            ${ids.run}::uuid, ${ids.task}::uuid, null, 'architect',
            'cross-sink-proof', 'completed'
          )
        `
      })

      const { createArchitectPlanArtifact } = await import('@/worker/orchestrator')
      const { recordTaskLog, recordTaskLogBestEffort } = await import('@/worker/task-logs')
      const { publishTaskEvent } = await import('@/worker/events')
      const artifact = await createArchitectPlanArtifact(
        ids.task,
        ids.run,
        [
          hostile.plan,
          hostile.prompt,
          hostile.path,
          hostile.credential,
          hostile.error,
          hostile.digest,
        ].join('\n'),
        '1',
        {
          prompt: hostile.prompt,
          selectedPath: hostile.path,
          credentials: { password: hostile.credential },
          nested: { message: hostile.error, promptDigest: hostile.digest },
        },
      )

      await recordTaskLog({
        agentRunId: ids.run,
        eventType: 'cross_sink.supported_writer',
        frontMatter: {
          prompt: hostile.prompt,
          selectedPath: hostile.path,
          credential: hostile.credential,
        },
        level: 'warning',
        message: `${hostile.error}\n${hostile.plan}`,
        metadata: {
          prompt: hostile.prompt,
          selectedPath: hostile.path,
          credential: hostile.credential,
          diagnostic: { message: hostile.error, promptDigest: hostile.digest },
        },
        source: 'worker',
        taskId: ids.task,
        title: 'Cross-sink writer projection',
      })
      await runRedisStep(
        'cross_sink.redis.initial_event_publish_failed',
        () => publishTaskEvent(ids.task, 'task:status', {
          errorMessage: `${hostile.error} ${hostile.path}`,
          status: 'running',
          updatedAt: new Date().toISOString(),
        }),
      )
      await recordTaskLogBestEffort({
        eventType: 'cross_sink.diagnostic',
        message: `${hostile.error}\n${hostile.credential}`,
        metadata: { prompt: hostile.prompt, path: hostile.path },
        source: 'worker',
        taskId: randomUUID(),
        title: 'Cross-sink diagnostic failure',
      })
      assertFixed(diagnosticArguments.length > 0,
        'The cross-sink proof did not exercise a worker diagnostic boundary.')
      verifyBoundary('worker_diagnostics', diagnosticArguments, 'worker diagnostics')

      await admin`
        insert into approval_gates (
          id, task_id, work_package_id, gate_type, status, source_agent_run_id,
          source_artifact_id, title, instructions, metadata
        ) values (
          ${ids.approvalGate}::uuid, ${ids.task}::uuid, ${ids.workPackage}::uuid,
          'plan_approval', 'pending', ${ids.run}::uuid, ${artifact.id}::uuid,
          'Cross-sink gate', 'Review the bounded fixture',
          ${admin.json({
            prompt: hostile.prompt,
            storageLocator: hostile.path,
            credentials: { password: hostile.credential },
            errorMessage: hostile.error,
            promptDigest: hostile.digest,
          } as never)}
        )
      `
      await admin`
        insert into task_logs (
          task_id, agent_run_id, work_package_id, approval_gate_id, artifact_id,
          event_type, source, title, message, front_matter, metadata
        ) values (
          ${ids.task}::uuid, ${ids.run}::uuid, ${ids.workPackage}::uuid,
          ${ids.approvalGate}::uuid, ${artifact.id}::uuid,
          'cross_sink.legacy_fixture', 'legacy', 'Legacy cross-sink fixture',
          ${hostile.plan},
          ${admin.json({ prompt: hostile.prompt, selectedPath: hostile.path } as never)},
          ${admin.json({
            credential: hostile.credential,
            errorMessage: hostile.error,
            promptDigest: hostile.digest,
          } as never)}
        )
      `

      const legacyClient = trackClient(
        legacyUrl,
        'cross_sink.redis.legacy_client_create_failed',
      )
      await runRedisStep(
        'cross_sink.redis.legacy_client_connect_failed',
        () => legacyClient.connect(),
      )
      legacyBinding = await bindLegacyClient(
        redisAdmin,
        legacyClient,
        legacyUser,
        validatedRedis!.database,
      )
      verifiedContracts.add('legacy_client_bound')
      await runRedisStep(
        'cross_sink.redis.legacy_history_write_failed',
        () => legacyClient.zadd(legacyKeys.history, 1, hostile.plan),
      )
      await runRedisStep(
        'cross_sink.redis.legacy_sequence_write_failed',
        () => legacyClient.set(legacyKeys.sequence, '1'),
      )

      const directSubscriber = trackClient(
        subscriberUrl,
        'cross_sink.redis.subscriber_client_create_failed',
      )
      await runRedisStep(
        'cross_sink.redis.subscriber_connect_failed',
        () => directSubscriber.connect(),
      )
      const directMessage = new Promise<string>((resolve) => {
        directSubscriber.once('message', (_channel, message) => resolve(message))
      })
      await runRedisStep(
        'cross_sink.redis.subscriber_subscribe_failed',
        () => directSubscriber.subscribe(redisKeys.live),
      )

      const { NextRequest } = await import('next/server')
      const { GET: getRuns } = await import('@/app/api/tasks/[id]/runs/route')
      liveAbort = new AbortController()
      const liveResponse = await runRedisStep(
        'cross_sink.redis.sse_snapshot_open_failed',
        () => getRuns(
          new NextRequest(`http://localhost/api/tasks/${ids.task}/runs`, {
            signal: liveAbort!.signal,
          }),
          { params: Promise.resolve({ id: ids.task }) },
        ),
      )
      assertFixed(liveResponse.status === 200 && liveResponse.body !== null,
        'The cross-sink proof could not open the production SSE route.')
      liveReader = liveResponse.body.getReader()
      let liveOutput = await readStreamUntil(
        liveReader,
        '',
        (value) => value.includes('event: artifact:created') && value.includes('event: task:status'),
        'The cross-sink proof did not receive the production SSE snapshot.',
      )
      verifyBoundary('sse_snapshot', liveOutput, 'SSE snapshot')

      const sequenceBeforeLive = Number(await runRedisStep(
        'cross_sink.redis.sequence_read_failed',
        () => redisAdmin.get(redisKeys.sequence),
      ))
      assertFixed(Number.isSafeInteger(sequenceBeforeLive) && sequenceBeforeLive > 0,
        'The cross-sink proof could not establish the Redis event baseline.')
      await runRedisStep(
        'cross_sink.redis.live_event_publish_failed',
        () => publishTaskEvent(ids.task, 'task:status', {
          errorMessage: `${hostile.error} ${hostile.credential}`,
          status: 'running',
          updatedAt: new Date().toISOString(),
        }),
      )
      const liveSequence = Number(await runRedisStep(
        'cross_sink.redis.live_sequence_read_failed',
        () => redisAdmin.get(redisKeys.sequence),
      ))
      assertFixed(liveSequence === sequenceBeforeLive + 1,
        'The cross-sink proof observed an invalid production event sequence.')
      liveOutput = await readStreamUntil(
        liveReader,
        liveOutput,
        (value) => value.includes(`id: ${liveSequence}\n`),
        'The cross-sink proof did not receive the production SSE live event.',
      )
      const rawLiveMessage = await withTimeout(
        directMessage,
        'The cross-sink proof did not receive the Redis live-channel event.',
      )
      verifyBoundary('sse_live', liveOutput, 'SSE live output')
      verifyBoundary('redis_live', rawLiveMessage, 'Redis live namespace')
      liveAbort.abort()
      await liveReader.cancel().catch(() => undefined)
      liveReader = null

      replayAbort = new AbortController()
      const replayResponse = await runRedisStep(
        'cross_sink.redis.sse_replay_open_failed',
        () => getRuns(
          new NextRequest(`http://localhost/api/tasks/${ids.task}/runs`, {
            headers: { 'Last-Event-ID': String(liveSequence - 1) },
            signal: replayAbort!.signal,
          }),
          { params: Promise.resolve({ id: ids.task }) },
        ),
      )
      assertFixed(replayResponse.status === 200 && replayResponse.body !== null,
        'The cross-sink proof could not open the production SSE replay route.')
      replayReader = replayResponse.body.getReader()
      const replayOutput = await readStreamUntil(
        replayReader,
        '',
        (value) => value.includes(`id: ${liveSequence}\n`),
        'The cross-sink proof did not receive the Last-Event-ID replay.',
      )
      verifyBoundary('sse_replay', replayOutput, 'SSE Last-Event-ID replay')
      replayAbort.abort()
      await replayReader.cancel().catch(() => undefined)
      replayReader = null
      await runRedisStep(
        'cross_sink.redis.subscriber_unsubscribe_failed',
        () => directSubscriber.unsubscribe(redisKeys.live),
      )

      const v2Before = {
        history: await redisDump(redisAdmin, redisKeys.history),
        sequence: await redisDump(redisAdmin, redisKeys.sequence),
      }
      const rawHistoryBefore = await runRedisStep(
        'cross_sink.redis.history_read_failed',
        () => redisAdmin.zrange(redisKeys.history, 0, -1),
      )
      assertFixed(rawHistoryBefore.length === liveSequence,
        'The cross-sink proof did not inspect complete production Redis history.')
      verifyBoundary('redis_history', rawHistoryBefore, 'Redis v2 history')

      const expandEnvelope = makeReleaseEnvelope({
        evidenceKind: 's4_expand',
        githubAppId,
        issuedAt,
        predecessorReceiptIds: [s3Recorded.receiptId],
        receiptId: ids.expandReceipt,
        signerGeneration,
        signerKeyId,
      })
      const [trustedEvidenceBaseline] = await admin<{
        count: number
        state: string
      }[]>`
        select
          (
            select count(*)::integer
            from forge_epic_172_release_evidence
          ) as count,
          (
            select state
            from forge_epic_172_enablement_state
            where singleton_id = 'epic-172'
          ) as state
      `
      assertFixed(trustedEvidenceBaseline !== undefined,
        'The cross-sink proof could not establish the trusted release baseline.')
      const invalidSignatureEnvelope = {
        ...expandEnvelope,
        receiptId: randomUUID(),
        nonce: randomUUID(),
      }
      const invalidSignatureKeys = generateKeyPairSync('ed25519')
      await expectReleaseRejected(
        'cross_sink.release.invalid_signature_accepted',
        (error) => error instanceof Error
          && error.message === 'Release envelope verification failed: invalid_signature.',
        () => recordEpic172ReleaseEvidence({
          databaseUrl: writerUrl,
          ...signedRelease(invalidSignatureEnvelope, invalidSignatureKeys.privateKey),
        }),
      )
      const [afterInvalidSignature] = await admin<{
        checkpoints: number
        evidence: number
        state: string
        trustedCount: number
      }[]>`
        select
          (
            select count(*)::integer
            from app_settings
            where key = ${checkpointKey}
          ) as checkpoints,
          (
            select count(*)::integer
            from forge_epic_172_release_evidence
            where id = ${invalidSignatureEnvelope.receiptId}::uuid
          ) as evidence,
          (
            select count(*)::integer
            from forge_epic_172_release_evidence
          ) as "trustedCount",
          (
            select state
            from forge_epic_172_enablement_state
            where singleton_id = 'epic-172'
          ) as state
      `
      assertFixed(
        afterInvalidSignature.checkpoints === 0
          && afterInvalidSignature.evidence === 0
          && afterInvalidSignature.trustedCount === trustedEvidenceBaseline.count
          && afterInvalidSignature.state === trustedEvidenceBaseline.state,
        'The cross-sink proof trusted an invalid signed release envelope.',
      )
      verifiedContracts.add('producer_disable_signature_rejected')

      const wrongPredecessorEnvelope = makeReleaseSuccessorEnvelope({
        evidenceKind: 's4_producers_disabled',
        githubAppId,
        issuedAt,
        predecessor: expandEnvelope,
        predecessorReceiptIds: [s3Recorded.receiptId],
        signerGeneration,
        signerKeyId,
      })
      await expectReleaseRejected(
        'cross_sink.release.wrong_predecessor_accepted',
        (error) => error instanceof Error
          && error.message
            === 'Epic 172 predecessor receipts do not match the runtime activation contract for s4_producers_disabled',
        () => recordEpic172ReleaseEvidence({
          databaseUrl: writerUrl,
          ...signedRelease(wrongPredecessorEnvelope, signerKeys.privateKey),
        }),
      )
      const [afterWrongPredecessor] = await admin<{
        checkpoints: number
        evidence: number
        state: string
        trustedCount: number
      }[]>`
        select
          (
            select count(*)::integer
            from app_settings
            where key = ${checkpointKey}
          ) as checkpoints,
          (
            select count(*)::integer
            from forge_epic_172_release_evidence
            where id = ${wrongPredecessorEnvelope.receiptId}::uuid
          ) as evidence,
          (
            select count(*)::integer
            from forge_epic_172_release_evidence
          ) as "trustedCount",
          (
            select state
            from forge_epic_172_enablement_state
            where singleton_id = 'epic-172'
          ) as state
      `
      assertFixed(
        afterWrongPredecessor.checkpoints === 0
          && afterWrongPredecessor.evidence === 0
          && afterWrongPredecessor.trustedCount === trustedEvidenceBaseline.count
          && afterWrongPredecessor.state === trustedEvidenceBaseline.state,
        'The cross-sink proof trusted a release envelope with the wrong predecessor.',
      )
      verifiedContracts.add('producer_disable_predecessor_rejected')

      const expandRecorded = await runReleaseStep(
        'cross_sink.release.expand_record_failed',
        () => recordEpic172ReleaseEvidence({
          databaseUrl: writerUrl,
          ...signedRelease(expandEnvelope, signerKeys.privateKey),
        }),
      )
      ownedEvidenceIds.add(expandRecorded.receiptId)
      const numericEpochDraft = makeReleaseSuccessorEnvelope({
        evidenceKind: 's4_producers_disabled',
        githubAppId,
        issuedAt,
        predecessor: expandEnvelope,
        predecessorReceiptIds: [expandRecorded.receiptId],
        signerGeneration,
        signerKeyId,
      })
      const numericEpochEnvelope: Epic172ReleaseEvidenceEnvelope = {
        ...numericEpochDraft,
        epoch: 7,
        transitionIdentityDigest: epic172TransitionIdentityDigest({
          manifestVersion: 1,
          nodeOrRequiredEvidenceKind: 's4_producers_disabled',
          owner: releaseContract('s4_producers_disabled').owner,
          exactBuilds: numericEpochDraft.exactBuilds,
          reviewedSha: numericEpochDraft.reviewedSha,
          epoch: 7,
          canonicalPredecessorReceiptSetDigest: numericEpochDraft.predecessorSetDigest,
        }),
      }
      const [numericEpochBaseline] = await admin<{ count: number }[]>`
        select count(*)::integer as count
        from forge_epic_172_release_evidence
      `
      await expectReleaseRejected(
        'cross_sink.release.numeric_epoch_accepted',
        (error) => error instanceof Error
          && error.message
            === 'Invalid Epic 172 envelope at epoch: must be null for "s4_producers_disabled"',
        () => recordEpic172ReleaseEvidence({
          databaseUrl: writerUrl,
          ...signedRelease(numericEpochEnvelope, signerKeys.privateKey),
        }),
      )
      const [afterNumericEpoch] = await admin<{
        checkpoints: number
        evidence: number
        trustedCount: number
      }[]>`
        select
          (
            select count(*)::integer
            from app_settings
            where key = ${checkpointKey}
          ) as checkpoints,
          (
            select count(*)::integer
            from forge_epic_172_release_evidence
            where id = ${numericEpochEnvelope.receiptId}::uuid
          ) as evidence,
          (
            select count(*)::integer
            from forge_epic_172_release_evidence
          ) as "trustedCount"
      `
      assertFixed(
        afterNumericEpoch.checkpoints === 0
          && afterNumericEpoch.evidence === 0
          && afterNumericEpoch.trustedCount === numericEpochBaseline.count,
        'The cross-sink proof trusted a numeric epoch for producers-disabled evidence.',
      )
      verifiedContracts.add('producer_disable_epoch_rejected')
      const disabledEnvelope = makeReleaseSuccessorEnvelope({
        evidenceKind: 's4_producers_disabled',
        githubAppId,
        issuedAt,
        predecessor: expandEnvelope,
        predecessorReceiptIds: [expandRecorded.receiptId],
        receiptId: ids.disabledReceipt,
        signerGeneration,
        signerKeyId,
      })
      const disabledRecorded = await runReleaseStep(
        'cross_sink.release.producers_disabled_record_failed',
        () => recordEpic172ReleaseEvidence({
          databaseUrl: writerUrl,
          ...signedRelease(disabledEnvelope, signerKeys.privateKey),
        }),
      )
      ownedEvidenceIds.add(disabledRecorded.receiptId)
      assertFixed(
        ownedEvidenceIds.size === 4 && ownedAuthorizationIds.size === 1,
        'The cross-sink proof did not track its complete authenticated release evidence.',
      )
      const recordedEvidence = await admin<{
        envelope: unknown
        evidenceKind: string
        receiptId: string
        signatureLength: number
        signerKeyId: string
      }[]>`
        select
          id::text as "receiptId",
          evidence_kind as "evidenceKind",
          signer_key_id::text as "signerKeyId",
          octet_length(detached_signature)::integer as "signatureLength",
          envelope
        from forge_epic_172_release_evidence
        where id in (${ids.expandReceipt}::uuid, ${ids.disabledReceipt}::uuid)
        order by evidence_kind
      `
      assertFixed(
        recordedEvidence.length === 2
          && recordedEvidence.every(
            (row) => row.signatureLength === 64 && row.signerKeyId === signerKeyId,
          )
          && recordedEvidence.some(
            (row) => row.receiptId === ids.expandReceipt
              && row.evidenceKind === 's4_expand'
              && epic172EnvelopeDigest(row.envelope as CanonicalJsonValue)
                === epic172EnvelopeDigest(expandEnvelope as CanonicalJsonValue),
          )
          && recordedEvidence.some(
            (row) => row.receiptId === ids.disabledReceipt
              && row.evidenceKind === 's4_producers_disabled'
              && epic172EnvelopeDigest(row.envelope as CanonicalJsonValue)
                === epic172EnvelopeDigest(disabledEnvelope as CanonicalJsonValue),
          ),
        'The cross-sink proof did not retain both authenticated production recorder envelopes.',
      )
      verifiedContracts.add('producer_disable_signed')

      const [enablement] = await admin<{ state: string }[]>`
        select state from forge_epic_172_enablement_state where singleton_id = 'epic-172'
      `
      assertFixed(enablement?.state === 'disabled',
        'The cross-sink proof requires the database-authoritative producers-disabled state.')

      const databaseAdapter = createLegacyLeakagePostgresAdapter(admin, fingerprintKey)
      const rawRedisAdapter = createLegacyLeakageRedisAdapter(redisAdmin)
      const redisAdapter = {
        purgeLegacyTaskEventKeys: (input: Parameters<typeof rawRedisAdapter.purgeLegacyTaskEventKeys>[0]) => (
          runRedisStep(
            'cross_sink.redis.legacy_purge_failed',
            () => rawRedisAdapter.purgeLegacyTaskEventKeys(input),
          )
        ),
        scanV2TaskEventHistory: (
          sentinels: Parameters<typeof rawRedisAdapter.scanV2TaskEventHistory>[0],
        ) => runRedisStep(
          'cross_sink.redis.v2_scan_failed',
          () => rawRedisAdapter.scanV2TaskEventHistory(sentinels),
        ),
      }
      const invalidOperation = `cross-sink-invalid-${randomUUID()}`
      await expect(runLegacyLeakageScrub({
        ...scrubOptions,
        authorizationReceiptId: randomUUID(),
        mode: 'apply',
        operationId: invalidOperation,
      }, { database: databaseAdapter, redis: redisAdapter })).rejects.toThrow(
        'The supplied authorization receipt does not satisfy the fixed S4 producers-disabled drain contract.',
      )
      const [invalidCheckpoint] = await admin<{ count: number }[]>`
        select count(*)::integer as count
        from app_settings
        where key = ${`${LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX}${invalidOperation}`}
      `
      assertFixed(invalidCheckpoint.count === 0,
        'The cross-sink proof observed a checkpoint created without producer-disable authorization.')
      verifiedContracts.add('authorization_rejected')

      let simulatedLostResponse = true
      const lostResponseDatabase: LegacyLeakageScrubDatabase = {
        ...databaseAdapter,
        async commitRow(input) {
          const result = await databaseAdapter.commitRow(input)
          if (simulatedLostResponse && result === 'committed') {
            simulatedLostResponse = false
            throw new Error('cross-sink simulated committed-batch response loss')
          }
          return result
        },
      }
      await expect(runLegacyLeakageScrub({
        ...scrubOptions,
        mode: 'apply',
      }, { database: lostResponseDatabase, redis: redisAdapter })).rejects.toThrow(
        'cross-sink simulated committed-batch response loss',
      )
      assertFixed(!simulatedLostResponse,
        'The cross-sink proof did not simulate a lost response after a committed database batch.')
      const resumed = await runLegacyLeakageScrub({
        ...scrubOptions,
        mode: 'resume',
      }, { database: databaseAdapter, redis: redisAdapter })
      assertFixed(resumed.checkpoint?.state === 'complete' && resumed.checkpoint.phase === 'complete',
        'The cross-sink proof did not complete the production database and Redis scrub.')
      verifiedContracts.add('crash_resume')
      const replayedCompletion = await runLegacyLeakageScrub({
        ...scrubOptions,
        mode: 'resume',
      }, { database: databaseAdapter, redis: redisAdapter })
      assertFixed(
        replayedCompletion.checkpoint?.operationId === operationId
          && replayedCompletion.checkpoint.state === 'complete',
        'The cross-sink proof did not replay a completed checkpoint idempotently.',
      )
      verifiedContracts.add('checkpoint_replay')

      const [checkpoint] = await admin<{ value: string }[]>`
        select value from app_settings where key = ${checkpointKey}
      `
      assertFixed(checkpoint !== undefined,
        'The cross-sink proof could not inspect the completed production checkpoint.')
      assertHostileAbsent(checkpoint.value, 'the keyed scrub checkpoint')

      const [databaseEvidence] = await admin<{
        approvalMetadata: unknown
        artifactContent: string
        artifactMetadata: unknown
        packageMetadata: unknown
      }[]>`
        select
          (select metadata from approval_gates where id = ${ids.approvalGate}::uuid)
            as "approvalMetadata",
          (select content from artifacts where id = ${artifact.id}::uuid)
            as "artifactContent",
          (select metadata from artifacts where id = ${artifact.id}::uuid)
            as "artifactMetadata",
          (select metadata from work_packages where id = ${ids.workPackage}::uuid)
            as "packageMetadata"
      `
      const taskLogEvidence = await admin`
        select message, front_matter as "frontMatter", metadata
        from task_logs where task_id = ${ids.task}::uuid
      `
      verifyBoundary('database_zero_scan', databaseEvidence.artifactContent,
        'the scrubbed PostgreSQL artifact content sink')
      assertHostileAbsent(databaseEvidence.artifactMetadata, 'the scrubbed PostgreSQL artifact metadata sink')
      assertHostileAbsent(databaseEvidence.packageMetadata, 'the scrubbed PostgreSQL work-package metadata sink')
      assertHostileAbsent(databaseEvidence.approvalMetadata, 'the scrubbed PostgreSQL approval-gate metadata sink')
      assertHostileAbsent(taskLogEvidence.map((row) => row.message),
        'the scrubbed PostgreSQL task-log message sink')
      assertHostileAbsent(taskLogEvidence.map((row) => row.frontMatter),
        'the scrubbed PostgreSQL task-log front-matter sink')
      assertHostileAbsent(taskLogEvidence.map((row) => row.metadata),
        'the scrubbed PostgreSQL task-log metadata sink')
      const [canonicalTask] = await admin<{ prompt: string }[]>`
        select prompt from tasks where id = ${ids.task}::uuid
      `
      assertFixed(canonicalTask.prompt === hostile.prompt,
        'The cross-sink proof did not preserve the authorized canonical task prompt.')
      verifiedContracts.add('canonical_prompt_database')

      assertFixed(await runRedisStep(
        'cross_sink.redis.legacy_zero_check_failed',
        () => redisAdmin.exists(legacyKeys.history, legacyKeys.sequence),
      ) === 0,
        'The cross-sink proof found legacy Redis task-event storage after purge.')
      assertFixed(
        safeJson({
          history: await redisDump(redisAdmin, redisKeys.history),
          sequence: await redisDump(redisAdmin, redisKeys.sequence),
        }) === safeJson(v2Before),
        'The cross-sink proof observed mutation of v2 Redis evidence during scrub.',
      )
      const v2Evidence = await redisAdapter.scanV2TaskEventHistory(hostileValues)
      assertFixed(v2Evidence.complete && v2Evidence.violations === 0,
        'The cross-sink proof did not complete the production v2 Redis zero-scan.')
      verifiedContracts.add('redis_zero_scan')

      const { GET: getTask } = await import('@/app/api/tasks/[id]/route')
      const { GET: getLogs } = await import('@/app/api/tasks/[id]/logs/route')
      const { GET: getExport } = await import('@/app/api/tasks/[id]/logs/export/route')
      const taskResponse = await getTask(
        new NextRequest(`http://localhost/api/tasks/${ids.task}`),
        { params: Promise.resolve({ id: ids.task }) },
      )
      const taskBody = await taskResponse.json() as Record<string, unknown>
      assertFixed(taskResponse.status === 200,
        'The cross-sink proof could not inspect the production task projection.')
      const projectedTask = taskBody.task as Record<string, unknown>
      assertFixed(projectedTask.prompt === hostile.prompt,
        'The cross-sink proof did not preserve the authorized task prompt projection.')
      const prohibitedTaskProjection = {
        ...taskBody,
        task: { ...projectedTask, prompt: '[authorized-canonical-prompt]' },
      }
      verifyBoundary('task_api', prohibitedTaskProjection, 'the task API projection')

      const logsResponse = await getLogs(
        new NextRequest(`http://localhost/api/tasks/${ids.task}/logs?limit=250`),
        { params: Promise.resolve({ id: ids.task }) },
      )
      assertFixed(logsResponse.status === 200,
        'The cross-sink proof could not inspect the production task-log route.')
      verifyBoundary('task_log_api', await logsResponse.json(), 'the task-log API')

      const exportResponse = await getExport(
        new NextRequest(`http://localhost/api/tasks/${ids.task}/logs/export?format=jsonl`),
        { params: Promise.resolve({ id: ids.task }) },
      )
      assertFixed(exportResponse.status === 200,
        'The cross-sink proof could not inspect the production task-log export.')
      verifyBoundary('task_log_export', await exportResponse.text(), 'the task-log export')

      await admin`
        insert into task_logs (task_id, event_type, title, message, front_matter, metadata)
        values (
          ${ids.task}::uuid, 'cross_sink.reappearance', 'Reappearance fixture',
          ${hostile.error}, '{}'::jsonb, '{}'::jsonb
        )
      `
      await expect(runLegacyLeakageScrub({
        ...scrubOptions,
        mode: 'resume',
      }, { database: databaseAdapter, redis: redisAdapter })).rejects.toThrow(
        'Completed leakage scrub verification failed; database or Redis leakage reappeared.',
      )
      verifiedContracts.add('database_reappearance')
      await admin`
        delete from task_logs
        where task_id = ${ids.task}::uuid and event_type = 'cross_sink.reappearance'
      `
      await runRedisStep(
        'cross_sink.redis.reappearance_history_write_failed',
        () => redisAdmin.zadd(legacyKeys.history, 1, 'reappeared-after-complete'),
      )
      await runRedisStep(
        'cross_sink.redis.reappearance_sequence_write_failed',
        () => redisAdmin.set(legacyKeys.sequence, '1'),
      )
      await expect(runLegacyLeakageScrub({
        ...scrubOptions,
        mode: 'resume',
      }, { database: databaseAdapter, redis: redisAdapter })).rejects.toThrow(
        'Completed leakage scrub verification failed; database or Redis leakage reappeared.',
      )
      verifiedContracts.add('redis_reappearance')
      await runRedisStep(
        'cross_sink.redis.reappearance_cleanup_failed',
        () => redisAdmin.del(legacyKeys.history, legacyKeys.sequence),
      )
      const finalCompletion = await runLegacyLeakageScrub({
        ...scrubOptions,
        mode: 'resume',
      }, { database: databaseAdapter, redis: redisAdapter })
      assertFixed(finalCompletion.checkpoint?.state === 'complete',
        'The cross-sink proof did not restore the final combined zero-scan.')
      verifiedContracts.add('final_combined_zero_scan')

      assertFixed(legacyBinding !== null,
        'The cross-sink proof did not retain its bound legacy client identity.')
      requireLiveLegacyBinding(legacyBinding)
      const removedUsers = Number(await runRedisStep(
        'cross_sink.redis.legacy_acl_revoke_failed',
        () => redisAdmin.call('ACL', 'DELUSER', legacyUser),
      ))
      assertFixed(removedUsers === 1,
        'The cross-sink proof did not revoke exactly one legacy Redis ACL identity.')
      ownedUsers.delete(legacyUser)
      assertFixed(await runRedisStep(
        'cross_sink.redis.revoked_acl_read_failed',
        () => redisAdmin.call('ACL', 'GETUSER', legacyUser),
      ) === null,
        'The cross-sink proof found the revoked legacy Redis ACL identity.')
      await requireLegacyClientTerminated(redisAdmin, legacyClient, legacyBinding)
      const staleLegacyClient = trackClient(
        legacyUrl,
        'cross_sink.redis.revoked_client_create_failed',
      )
      let freshAuthenticationError: unknown
      staleLegacyClient.on('error', (error) => {
        freshAuthenticationError ??= error
      })
      await expectFreshCredentialDenial(
        async () => {
          await staleLegacyClient.connect()
          await staleLegacyClient.set(legacyKeys.sequence, '1')
        },
        () => freshAuthenticationError,
      )
      assertFixed(await runRedisStep(
        'cross_sink.redis.post_revocation_zero_check_failed',
        () => redisAdmin.exists(legacyKeys.history, legacyKeys.sequence),
      ) === 0,
        'The cross-sink proof found recreated legacy Redis keys after credential revocation.')
      verifiedContracts.add('acl_revocation')
      const finalV2Evidence = await redisAdapter.scanV2TaskEventHistory(hostileValues)
      assertFixed(finalV2Evidence.complete && finalV2Evidence.violations === 0,
        'The cross-sink proof did not retain a clean final v2 Redis zero-scan.')
      assertHostileAbsent(diagnosticArguments, 'the final worker diagnostic inventory')
      assertFixed(
        verifiedContracts.size === requiredContracts.size
          && [...requiredContracts].every((contract) => verifiedContracts.has(contract)),
        'The cross-sink proof did not execute its exact closed production contract inventory.',
      )
      proofComplete = true
    } catch (error) {
      primaryFailure = error
    } finally {
      const publisherClient = (globalThis as { forgeTaskEventPublisherRedis?: Redis })
        .forgeTaskEventPublisherRedis
      const cleanupStages: CleanupStage[] = [
        {
          category: 'stream_abort',
          run: () => {
            liveAbort?.abort()
            replayAbort?.abort()
          },
        },
        {
          category: 'live_reader_close',
          run: async () => {
            await liveReader?.cancel()
          },
        },
        {
          category: 'replay_reader_close',
          run: async () => {
            await replayReader?.cancel()
          },
        },
        {
          category: 'process_state_restore',
          run: () => {
            console.warn = originalWarn
            console.error = originalError
            sessionState.userId = ''
          },
        },
        {
          category: 'application_database_close',
          run: async () => {
            const { closeDb } = await import('@/db')
            await closeDb()
          },
        },
        {
          category: 'publisher_client_close',
          run: () => {
            if (publisherClient) {
              disconnectRedisClient(
                publisherClient,
                'cross_sink.redis.publisher_client_close_failed',
              )
            }
            delete (globalThis as { forgeTaskEventPublisherRedis?: Redis })
              .forgeTaskEventPublisherRedis
          },
        },
        ...[...clients].map((client, index): CleanupStage => ({
          category: `redis_client_close_${index + 1}`,
          run: () => {
            disconnectRedisClient(
              client,
              'cross_sink.redis.credential_client_close_failed',
            )
          },
        })),
        {
          category: 'redis_key_cleanup',
          run: async () => {
            if (ownedKeys.size > 0) {
              await runRedisStep(
                'cross_sink.redis.owned_key_cleanup_failed',
                () => redisAdmin.del(...ownedKeys),
              )
            }
          },
        },
        ...[publisherUser, subscriberUser, legacyUser].map(
          (user, index): CleanupStage => ({
            category: `redis_acl_remove_${index + 1}`,
            run: async () => {
              const removed = Number(await runRedisStep(
                'cross_sink.redis.owned_acl_remove_failed',
                () => redisAdmin.call('ACL', 'DELUSER', user),
              ))
              assertFixed(
                removed === 0 || removed === 1,
                'The cross-sink proof received an invalid ACL cleanup result.',
              )
              ownedUsers.delete(user)
            },
          }),
        ),
        ...[publisherUser, subscriberUser, legacyUser].map(
          (user, index): CleanupStage => ({
            category: `redis_acl_absence_${index + 1}`,
            run: async () => {
              const identity = await runRedisStep(
                'cross_sink.redis.owned_acl_absence_check_failed',
                () => redisAdmin.call('ACL', 'GETUSER', user),
              )
              assertFixed(identity === null,
                'The cross-sink proof left a temporary Redis ACL identity.')
            },
          }),
        ),
        {
          category: 'redis_database_zero',
          run: async () => {
            const size = await runRedisStep(
              'cross_sink.redis.final_size_check_failed',
              () => redisAdmin.dbsize(),
            )
            assertFixed(size === 0,
              'The cross-sink proof left data in the disposable Redis database.')
          },
        },
        {
          category: 'redis_admin_close',
          run: () => {
            disconnectRedisClient(redisAdmin, 'cross_sink.redis.admin_close_failed')
          },
        },
        {
          category: 'postgres_application_admin_close',
          run: async () => {
            await admin.end({ timeout: 5 })
          },
        },
        {
          category: 'postgres_server_admin_open',
          run: async () => {
            serverAdmin = postgres(disposableServerAdminUrl, {
              max: 1,
              onnotice: () => {},
            })
            const [connected] = await serverAdmin<{ database: string }[]>`
              select current_database() as database
            `
            assertFixed(connected?.database === 'postgres',
              'The cross-sink proof could not establish its cleanup database.')
          },
        },
        {
          category: 'postgres_disposable_database_drop',
          run: async () => {
            assertFixed(serverAdmin !== null,
              'The cross-sink proof could not open its cleanup database.')
            await serverAdmin.unsafe(
              'drop database "forge_cross_sink_ci_test" with (force)',
            )
          },
        },
        {
          category: 'postgres_owned_state_absence',
          run: async () => {
            assertFixed(serverAdmin !== null,
              'The cross-sink proof could not inspect its cleanup database.')
            const [remaining] = await serverAdmin<{ count: number }[]>`
              select count(*)::integer as count
              from pg_database
              where datname = ${expectedDatabase}
            `
            assertFixed(
              remaining?.count === 0,
              'The cross-sink proof left its owned PostgreSQL state.',
            )
          },
        },
        {
          category: 'postgres_server_admin_close',
          run: async () => {
            if (serverAdmin) await serverAdmin.end({ timeout: 5 })
          },
        },
        {
          category: 'environment_restore',
          run: () => {
            restoreEnvironment(previousEnvironment)
          },
        },
        {
          category: 'environment_restoration_check',
          run: () => {
            assertEnvironmentRestored(previousEnvironment)
          },
        },
      ]
      const cleanupFailures = await runCleanupStages(cleanupStages)
      if (primaryFailure === undefined && !proofComplete) {
        primaryFailure = fixedError(
          'The cross-sink proof did not complete every production sink assertion.',
        )
      }
      throwAfterCleanup(primaryFailure, cleanupFailures)
    }

    console.info('S4_CROSS_SINK_PRODUCTION_SENTINEL_OK')
  })
})
