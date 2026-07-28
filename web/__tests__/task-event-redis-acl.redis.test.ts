import { spawn } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspect } from 'node:util'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLegacyLeakageRedisAdapter } from '@/scripts/scrub-legacy-leakage'
import { TASK_EVENT_V2_LIVE_PATTERN, taskEventRedisConfiguration, taskEventRedisKeys } from '@/lib/task-event-redis'
import { publishTaskEvent } from '@/worker/events'

vi.mock('@/lib/mcps/s4-lease', () => ({
  readS4RuntimeModeV1: vi.fn(async () => 'protected'),
}))

const required = process.env.FORGE_S4_REDIS_ACL_TEST_REQUIRED === '1'
const destructive = process.env.FORGE_S4_REDIS_ACL_DESTRUCTIVE_TEST === '1'
const adminUrl = process.env.FORGE_S4_REDIS_ACL_TEST_ADMIN_URL

function validateDestructiveRedisUrl(value: string): Readonly<{ url: string; database: number }> {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('S4 Redis ACL proof requires a valid dedicated Redis URL.')
  }
  if ((parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') || parsed.search || parsed.hash || !/^\/[1-9][0-9]*$/.test(parsed.pathname)) {
    throw new Error('S4 Redis ACL proof requires an unambiguous redis: or rediss: URL with an explicit nonzero database.')
  }
  const database = Number(parsed.pathname.slice(1))
  if (!Number.isSafeInteger(database) || database < 1) {
    throw new Error('S4 Redis ACL proof requires an unambiguous redis: or rediss: URL with an explicit nonzero database.')
  }
  return { url: value, database }
}

if (required && (!destructive || !adminUrl)) {
  throw new Error('The mandatory S4 Redis ACL proof requires FORGE_S4_REDIS_ACL_DESTRUCTIVE_TEST=1 and FORGE_S4_REDIS_ACL_TEST_ADMIN_URL; it may not skip.')
}

const destructiveTarget = adminUrl && destructive ? validateDestructiveRedisUrl(adminUrl) : null
const destructiveAdminUrl = destructiveTarget?.url ?? null
const destructiveDatabase = destructiveTarget?.database ?? -1
const enabled = Boolean(destructiveTarget)
const fingerprintKey = Buffer.alloc(32, 59)
const legacyFixtureTaskId = randomUUID()
const selectRule = `+select|${destructiveDatabase}`
const publisherRules = [
  '~forge:task-events:v2:*:history', '~forge:task-events:v2:*:seq', '&forge:task-events:v2:*:live',
  selectRule, '+ping', '+info', '+client|setinfo', '+eval', '+incr', '+zadd', '+zcard', '+zremrangebyrank', '+publish',
] as const
const aclGetUserFields = ['flags', 'passwords', 'commands', 'keys', 'channels', 'selectors'] as const
const safeAclFlags = ['on', 'sanitize-payload'] as const
const subscriberRules = [
  '~forge:task-events:v2:*:history', '~forge:task-events:v2:*:seq', '&forge:task-events:v2:*:live',
  selectRule, '+ping', '+info', '+client|setinfo', '+get', '+zrangebyscore', '+subscribe', '+unsubscribe', '+psubscribe', '+punsubscribe',
] as const
const safeFailureProofEnvironment = 'FORGE_S4_REDIS_ACL_SAFE_FAILURE_PROOF'
const safeFailureMessage = 'S4 Redis ACL proof sanitized a Redis operation failure.'
const failureSentinels = [
  'S4_ACL_COMMAND_ARGUMENT_SENTINEL',
  'S4_ACL_CONNECTION_URL_SENTINEL',
  'S4_ACL_PASSWORD_SENTINEL',
  'deadcafedeadcafedeadcafedeadcafedeadcafedeadcafedeadcafedeadcafe',
  'S4_ACL_USERNAME_SENTINEL',
  'S4_ACL_TASK_ID_SENTINEL',
  'S4_ACL_KEY_SENTINEL',
  'S4_ACL_CHANNEL_SENTINEL',
] as const

async function runRedisStep<T>(fixedMessage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch {
    throw new Error(fixedMessage)
  }
}

function fabricatedEnumerableRedisFailure(): object {
  return {
    command: { args: [failureSentinels[0], failureSentinels[6], failureSentinels[7]] },
    connection: {
      url: `redis://user:${failureSentinels[2]}@localhost:6379/14#${failureSentinels[1]}`,
      options: { password: failureSentinels[2], username: failureSentinels[4] },
    },
    passwordHash: failureSentinels[3],
    identity: failureSentinels[4],
    task: { id: failureSentinels[5], key: failureSentinels[6], channel: failureSentinels[7] },
  }
}

function enumerableStrings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null || seen.has(value)) return []
  seen.add(value)
  return Object.keys(value).flatMap((key) => [key, ...enumerableStrings((value as Record<string, unknown>)[key], seen)])
}

function assertSentinelsAbsent(value: string): void {
  if (failureSentinels.some((sentinel) => value.includes(sentinel))) {
    throw new Error('S4 Redis ACL proof exposed enumerable Redis failure data.')
  }
}

async function captureSanitizedRedisFailure(): Promise<Error> {
  try {
    await runRedisStep(safeFailureMessage, async () => {
      throw fabricatedEnumerableRedisFailure()
    })
  } catch (error) {
    if (error instanceof Error) return error
  }
  throw new Error('S4 Redis ACL proof did not receive a sanitized Redis failure.')
}

function opaque(value: Buffer | null): string {
  return createHmac('sha256', fingerprintKey).update(value ?? Buffer.alloc(0)).digest('hex')
}

function eventEnvelope(id: number): string {
  return JSON.stringify({
    schemaVersion: 2,
    id,
    type: 'task:status',
    data: { errorMessage: null, status: 'running', updatedAt: '2026-07-28T00:00:00.000Z' },
  })
}

async function proveSafeFailureReport(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'forge-s4-redis-acl-safe-failure-'))
  const reportPath = join(directory, 'vitest.json')
  try {
    const child = spawn(process.execPath, [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      '__tests__/task-event-redis-acl.redis.test.ts',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, [safeFailureProofEnvironment]: '1' },
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
    const evidence = `${stdout}\n${stderr}\n${report}`
    if (status === 0 || !evidence.includes(safeFailureMessage)) {
      throw new Error('S4 Redis ACL proof did not observe the fixed safe reporter diagnostic.')
    }
    assertSentinelsAbsent(evidence)
  } catch (error) {
    if (error instanceof Error && (error.message === 'S4 Redis ACL proof did not observe the fixed safe reporter diagnostic.' || error.message === 'S4 Redis ACL proof exposed enumerable Redis failure data.')) throw error
    throw new Error('S4 Redis ACL proof could not verify safe runner and report output.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe.skipIf(!enabled)('S4 real Redis ACL task-event proof', () => {
  let admin: Redis
  let otherDatabaseAdmin: Redis
  let publisherUrl: string
  let subscriberUrl: string
  let legacyUrl: string
  let publisherUser: string
  let subscriberUser: string
  let legacyUser: string
  const ownedKeys = new Set<string>()
  const ownedUsers = new Set<string>()
  const clients = new Set<Redis>()
  let otherDatabaseBaseline: Readonly<{ count: number; fingerprint: string }>
  let restoreConsoleWarn: (() => void) | undefined

  function client(url: string): Redis {
    try {
      const instance = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
      instance.on('error', () => undefined)
      clients.add(instance)
      return instance
    } catch {
      throw new Error('S4 Redis ACL proof could not create a Redis client.')
    }
  }

  function disconnectClient(instance: Redis): void {
    try {
      instance.disconnect()
    } catch {
      throw new Error('S4 Redis ACL proof could not disconnect a temporary Redis client.')
    }
  }

  function taskKeys(taskId = randomUUID()) {
    const keys = taskEventRedisKeys(taskId)
    ownedKeys.add(keys.history)
    ownedKeys.add(keys.sequence)
    return keys
  }

  function legacyKeys(taskId = randomUUID()) {
    const keys = { history: `forge:task:${taskId}:history`, sequence: `forge:task:${taskId}:seq` }
    ownedKeys.add(keys.history)
    ownedKeys.add(keys.sequence)
    return keys
  }

  function authenticatedUrl(user: string, password: string): string {
    try {
      const parsed = new URL(destructiveAdminUrl!)
      parsed.username = user
      parsed.password = password
      return parsed.toString()
    } catch {
      throw new Error('S4 Redis ACL proof could not create an authenticated Redis target.')
    }
  }

  function adminUrlForDatabase(database: number): string {
    try {
      const parsed = new URL(destructiveAdminUrl!)
      parsed.pathname = `/${database}`
      return parsed.toString()
    } catch {
      throw new Error('S4 Redis ACL proof could not create the alternate Redis database target.')
    }
  }

  async function sendSetUser(user: string, password: string, rules: readonly string[]): Promise<void> {
    await runRedisStep('S4 Redis ACL proof could not create the temporary ACL identity.', async () => {
      await admin.call('ACL', 'SETUSER', user, 'reset', 'on', `>${password}`, ...rules)
    })
  }

  async function setUser(
    user: string,
    password: string,
    rules: readonly string[],
    send: (user: string, password: string, rules: readonly string[]) => Promise<void> = sendSetUser,
  ): Promise<void> {
    ownedUsers.add(user)
    await send(user, password, rules)
  }

  function aclTokens(value: unknown): readonly string[] {
    if (typeof value === 'string') return value.trim().split(/\s+/).filter(Boolean)
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value
    throw new Error('S4 Redis ACL proof received an invalid non-secret ACL field shape.')
  }

  function aclFields(value: unknown): ReadonlyMap<string, unknown> {
    if (!Array.isArray(value) || value.length % 2 !== 0) {
      throw new Error('S4 Redis ACL proof could not verify the configured ACL identity.')
    }
    const fields = new Map<string, unknown>()
    for (let index = 0; index < value.length; index += 2) {
      if (typeof value[index] !== 'string') throw new Error('S4 Redis ACL proof could not verify the configured ACL identity.')
      fields.set(value[index], value[index + 1])
    }
    if (fields.size !== aclGetUserFields.length || !aclGetUserFields.every((field) => fields.has(field))) {
      throw new Error('S4 Redis ACL proof received an unexpected ACL identity field.')
    }
    return fields
  }

  function sameTokenSet(actual: readonly string[], expected: readonly string[]): boolean {
    const actualSet = new Set(actual)
    const expectedSet = new Set(expected)
    return actual.length === actualSet.size && expected.length === expectedSet.size && actualSet.size === expectedSet.size && [...actualSet].every((token) => expectedSet.has(token))
  }

  function isEmptySelectorList(value: unknown): boolean {
    return Array.isArray(value) && value.length === 0
  }

  function hasOneOpaquePassword(value: unknown): boolean {
    return Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' && /^[0-9a-f]{64}$/.test(value[0])
  }

  async function assertAclIdentity(user: string, expected: Readonly<{ keys: readonly string[]; channels: readonly string[]; commands: readonly string[] }>): Promise<void> {
    const result = await runRedisStep('S4 Redis ACL proof could not inspect the temporary ACL identity.', () => admin.call('ACL', 'GETUSER', user))
    if (result === null) throw new Error('S4 Redis ACL proof could not find the configured ACL identity.')
    const fields = aclFields(result)
    const flags = aclTokens(fields.get('flags'))
    const keys = aclTokens(fields.get('keys'))
    const channels = aclTokens(fields.get('channels'))
    const commands = aclTokens(fields.get('commands'))
    if (!sameTokenSet(flags, safeAclFlags) || !sameTokenSet(keys, expected.keys) || !sameTokenSet(channels, expected.channels) || !sameTokenSet(commands, ['-@all', ...expected.commands]) || !isEmptySelectorList(fields.get('selectors')) || !hasOneOpaquePassword(fields.get('passwords'))) {
      throw new Error('S4 Redis ACL proof found an inconsistent closed-world ACL identity.')
    }
  }

  async function assertAclAbsent(user: string): Promise<void> {
    const result = await runRedisStep('S4 Redis ACL proof could not verify ACL identity cleanup.', () => admin.call('ACL', 'GETUSER', user))
    if (result !== null) {
      throw new Error('S4 Redis ACL proof found a temporary ACL identity after cleanup.')
    }
  }

  async function cleanupTrackedUsers(users: Iterable<string>): Promise<void> {
    for (const user of users) {
      if (!ownedUsers.has(user)) throw new Error('S4 Redis ACL proof refused to clean an untracked ACL identity.')
      await runRedisStep('S4 Redis ACL proof could not remove a temporary ACL identity.', () => admin.call('ACL', 'DELUSER', user))
      await assertAclAbsent(user)
    }
  }

  async function assertActiveClientUsers(users: readonly string[]): Promise<void> {
    if (new Set(users).size !== users.length) throw new Error('S4 Redis ACL proof configured non-distinct ACL identities.')
    const listing = await runRedisStep('S4 Redis ACL proof could not inspect active Redis identities.', () => admin.client('LIST'))
    if (typeof listing !== 'string' || !users.every((user) => listing.includes(`user=${user}`))) {
      throw new Error('S4 Redis ACL proof could not verify the active ACL client identities.')
    }
  }

  async function databaseEvidence(connection: Redis): Promise<Readonly<{ count: number; fingerprint: string }>> {
    const [count, keyspace] = await runRedisStep('S4 Redis ACL proof could not inspect database isolation evidence.', () => Promise.all([connection.dbsize(), connection.info('keyspace')]))
    if (!Number.isSafeInteger(count) || count < 0 || typeof keyspace !== 'string') {
      throw new Error('S4 Redis ACL proof could not read the disposable database evidence.')
    }
    return { count, fingerprint: opaque(Buffer.from(keyspace, 'utf8')) }
  }

  function assertDatabaseEvidence(actual: Readonly<{ count: number; fingerprint: string }>, expected: Readonly<{ count: number; fingerprint: string }>): void {
    if (actual.count !== expected.count || actual.fingerprint !== expected.fingerprint) {
      throw new Error('S4 Redis ACL proof found an unexpected database mutation.')
    }
  }

  function isExpectedTaskEventMessage(value: string): boolean {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'object' && parsed !== null
        && (parsed as { schemaVersion?: unknown }).schemaVersion === 2
        && (parsed as { id?: unknown }).id === 1
        && (parsed as { type?: unknown }).type === 'task:status'
    } catch {
      return false
    }
  }

  async function dumpFingerprint(key: string): Promise<Readonly<{ type: string; dump: string }>> {
    const [type, dumped] = await runRedisStep('S4 Redis ACL proof could not inspect opaque key evidence.', () => Promise.all([admin.type(key), admin.callBuffer('DUMP', key)]))
    if (dumped !== null && !Buffer.isBuffer(dumped)) throw new Error('S4 Redis ACL proof requires binary DUMP replies.')
    return { type, dump: opaque(dumped as Buffer | null) }
  }

  async function expectNoPerm(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
    } catch (error) {
      if (error instanceof Error && (/^NOPERM\b/.test(error.message) || /^ERR ACL failure\b/.test(error.message))) return
    }
    throw new Error('S4 Redis ACL proof expected an exact Redis permission denial.')
  }

  async function expectRejected(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
    } catch {
      return
    }
    throw new Error('S4 Redis ACL proof expected the revoked Redis client to be rejected.')
  }

  async function expectRevokedCredentialConnection(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
    } catch (error) {
      if (error instanceof Error && /WRONGPASS|NOAUTH|NOPERM|Connection is closed/.test(error.message)) return
    }
    throw new Error('S4 Redis ACL proof expected the revoked Redis credentials to be denied.')
  }

  beforeAll(async () => {
    if (process.env[safeFailureProofEnvironment] === '1') {
      await runRedisStep(safeFailureMessage, async () => {
        throw fabricatedEnumerableRedisFailure()
      })
    }
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    restoreConsoleWarn = () => consoleWarn.mockRestore()
    admin = client(destructiveAdminUrl!)
    await runRedisStep('S4 Redis ACL proof could not connect to the dedicated admin target.', () => admin.connect())
    const info = await runRedisStep('S4 Redis ACL proof could not inspect the Redis server version.', () => admin.info('server'))
    const major = /^redis_version:(\d+)/m.exec(info)?.[1]
    if (!major || Number(major) < 7) throw new Error('S4 Redis ACL proof requires Redis major version 7 or newer.')
    const initialDatabaseSize = await runRedisStep('S4 Redis ACL proof could not inspect the disposable database.', () => admin.dbsize())
    if (initialDatabaseSize !== 0) throw new Error('S4 Redis ACL proof requires an empty dedicated disposable database.')
    otherDatabaseAdmin = client(adminUrlForDatabase(destructiveDatabase + 1))
    await runRedisStep('S4 Redis ACL proof could not connect to the alternate database inspector.', () => otherDatabaseAdmin.connect())
    otherDatabaseBaseline = await databaseEvidence(otherDatabaseAdmin)

    publisherUser = `s4pub_${randomUUID().replaceAll('-', '')}`
    subscriberUser = `s4sub_${randomUUID().replaceAll('-', '')}`
    legacyUser = `s4legacy_${randomUUID().replaceAll('-', '')}`
    const publisherPassword = randomBytes(32).toString('base64url')
    const subscriberPassword = randomBytes(32).toString('base64url')
    const legacyPassword = randomBytes(32).toString('base64url')
    publisherUrl = authenticatedUrl(publisherUser, publisherPassword)
    subscriberUrl = authenticatedUrl(subscriberUser, subscriberPassword)
    legacyUrl = authenticatedUrl(legacyUser, legacyPassword)

    await setUser(publisherUser, publisherPassword, publisherRules)
    await setUser(subscriberUser, subscriberPassword, subscriberRules)
    const legacyRules = [
      `~forge:task:${legacyFixtureTaskId}:history`, `~forge:task:${legacyFixtureTaskId}:seq`,
      selectRule, '+ping', '+info', '+client|setinfo', '+zadd', '+set',
    ] as const
    await setUser(legacyUser, legacyPassword, legacyRules)
    await assertAclIdentity(publisherUser, { keys: publisherRules.filter((rule) => rule.startsWith('~')), channels: publisherRules.filter((rule) => rule.startsWith('&')), commands: publisherRules.filter((rule) => rule.startsWith('+')) })
    await assertAclIdentity(subscriberUser, { keys: subscriberRules.filter((rule) => rule.startsWith('~')), channels: subscriberRules.filter((rule) => rule.startsWith('&')), commands: subscriberRules.filter((rule) => rule.startsWith('+')) })
    await assertAclIdentity(legacyUser, { keys: legacyRules.filter((rule) => rule.startsWith('~')), channels: [], commands: legacyRules.filter((rule) => rule.startsWith('+')) })
  })

  afterAll(async () => {
    if (process.env[safeFailureProofEnvironment] === '1') return
    try {
      await cleanupTrackedUsers(ownedUsers)
      if (ownedKeys.size > 0) {
        await runRedisStep('S4 Redis ACL proof could not remove owned fixture keys.', () => admin.del(...ownedKeys))
      }
      const finalDatabaseSize = await runRedisStep('S4 Redis ACL proof could not verify final database isolation.', () => admin.dbsize())
      if (finalDatabaseSize !== 0) throw new Error('S4 Redis ACL proof left data in the disposable database.')
      assertDatabaseEvidence(await databaseEvidence(otherDatabaseAdmin), otherDatabaseBaseline)
    } finally {
      for (const instance of clients) if (instance !== admin) disconnectClient(instance)
      if (admin) disconnectClient(admin)
      restoreConsoleWarn?.()
    }
  })

  it('S4_REDIS_ACL_ROLE_ISOLATION: production publish, live delivery, and replay use distinct roles', async () => {
    const taskId = randomUUID()
    const keys = taskKeys(taskId)
    const sanitizedFailure = await captureSanitizedRedisFailure()
    const ownProperties = Object.getOwnPropertyNames(sanitizedFailure)
    if (sanitizedFailure.name !== 'Error'
      || sanitizedFailure.message !== safeFailureMessage
      || Object.keys(sanitizedFailure).length !== 0
      || ownProperties.some((property) => property !== 'message' && property !== 'stack')) {
      throw new Error('S4 Redis ACL proof received an invalid sanitized Redis failure shape.')
    }
    const safeReportPayload = { error: sanitizedFailure, phase: 'redis_acl_test' }
    const renderedFailure = [
      String(sanitizedFailure),
      JSON.stringify(sanitizedFailure),
      inspect(sanitizedFailure),
      JSON.stringify(safeReportPayload),
      inspect(safeReportPayload),
      ...enumerableStrings(safeReportPayload),
    ].join('\n')
    assertSentinelsAbsent(renderedFailure)
    await proveSafeFailureReport()

    const responseLossUser = `s4lost_${randomUUID().replaceAll('-', '')}`
    const responseLossPassword = randomBytes(32).toString('base64url')
    let responseWasLost = false
    try {
      await setUser(responseLossUser, responseLossPassword, publisherRules, async (user, password, rules) => {
        await sendSetUser(user, password, rules)
        throw new Error('S4 Redis ACL proof simulated a lost SETUSER response.')
      })
    } catch (error) {
      responseWasLost = error instanceof Error && error.message === 'S4 Redis ACL proof simulated a lost SETUSER response.'
    }
    if (!responseWasLost) throw new Error('S4 Redis ACL proof did not observe the simulated SETUSER response loss.')
    await assertAclIdentity(responseLossUser, { keys: publisherRules.filter((rule) => rule.startsWith('~')), channels: publisherRules.filter((rule) => rule.startsWith('&')), commands: publisherRules.filter((rule) => rule.startsWith('+')) })
    await cleanupTrackedUsers([responseLossUser])
    await assertAclAbsent(responseLossUser)
    await cleanupTrackedUsers([responseLossUser])

    const configuration = await runRedisStep('S4 Redis ACL proof could not resolve the protected Redis configuration.', async () => {
      const previousPublisher = process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
      const previousSubscriber = process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL
      process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = publisherUrl
      process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = subscriberUrl
      try {
        return taskEventRedisConfiguration('protected')
      } finally {
        if (previousPublisher === undefined) delete process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
        else process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = previousPublisher
        if (previousSubscriber === undefined) delete process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL
        else process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = previousSubscriber
      }
    })
    if (!configuration.dedicated || configuration.publisherUrl !== publisherUrl || configuration.subscriberUrl !== subscriberUrl) {
      throw new Error('S4 Redis ACL proof could not verify the protected Redis configuration.')
    }
    const safeMismatchFailure = (() => {
      const previousPublisher = process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
      const previousSubscriber = process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL
      process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = publisherUrl
      process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = publisherUrl
      try {
        taskEventRedisConfiguration('protected')
        return false
      } catch (error) {
        return error instanceof Error && error.message === 'Task-event publisher and subscriber Redis URLs must use distinct ACL principals.'
      } finally {
        if (previousPublisher === undefined) delete process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
        else process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = previousPublisher
        if (previousSubscriber === undefined) delete process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL
        else process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = previousSubscriber
      }
    })()
    if (!safeMismatchFailure) throw new Error('S4 Redis ACL proof did not receive the fixed protected Redis configuration failure.')

    const live = client(subscriberUrl)
    const patternLive = client(subscriberUrl)
    const replay = client(subscriberUrl)
    await Promise.all([
      runRedisStep('S4 Redis ACL proof could not connect the direct subscriber.', () => live.connect()),
      runRedisStep('S4 Redis ACL proof could not connect the pattern subscriber.', () => patternLive.connect()),
      runRedisStep('S4 Redis ACL proof could not connect the replay reader.', () => replay.connect()),
    ])
    const delivered = new Promise<string>((resolve) => live.once('message', (_channel, message) => resolve(message)))
    const patternDelivered = new Promise<Readonly<{ channel: string; message: string }>>((resolve) => patternLive.once('pmessage', (_pattern, channel, message) => resolve({ channel, message })))
    await runRedisStep('S4 Redis ACL proof could not subscribe to the direct live channel.', () => live.subscribe(keys.live))
    await runRedisStep('S4 Redis ACL proof could not subscribe to the live-channel pattern.', () => patternLive.psubscribe(TASK_EVENT_V2_LIVE_PATTERN))

    const previousPublisher = process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
    const previousSubscriber = process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = publisherUrl
    process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = subscriberUrl
    try {
      await runRedisStep('S4 Redis ACL proof could not publish the protected task event.', () => publishTaskEvent(taskId, 'task:status', { status: 'running', updatedAt: '2026-07-28T00:00:00.000Z' }))
    } finally {
      if (previousPublisher === undefined) delete process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
      else process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = previousPublisher
      if (previousSubscriber === undefined) delete process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL
      else process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = previousSubscriber
    }
    const message = await delivered
    const patterned = await patternDelivered
    const replayRows = await runRedisStep('S4 Redis ACL proof could not read protected task-event history.', () => replay.zrangebyscore(keys.history, 1, '+inf', 'WITHSCORES'))
    const sequence = await runRedisStep('S4 Redis ACL proof could not read the protected task-event sequence.', () => replay.get(keys.sequence))
    if (!isExpectedTaskEventMessage(message) || patterned.channel !== keys.live || !isExpectedTaskEventMessage(patterned.message)) {
      throw new Error('S4 Redis ACL proof did not receive the expected protected task event.')
    }
    expect(replayRows).toHaveLength(2)
    expect(sequence).toBe('1')
    await Promise.all([
      runRedisStep('S4 Redis ACL proof could not unsubscribe the direct subscriber.', () => live.unsubscribe(keys.live)),
      runRedisStep('S4 Redis ACL proof could not unsubscribe the pattern subscriber.', () => patternLive.punsubscribe(TASK_EVENT_V2_LIVE_PATTERN)),
    ])
    const publisherClient = (globalThis as { forgeTaskEventPublisherRedis?: Redis }).forgeTaskEventPublisherRedis
    if (publisherClient) clients.add(publisherClient)
    await assertActiveClientUsers([publisherUser, subscriberUser])
    console.info('S4_REDIS_ACL_ROLE_ISOLATION_OK')
  })

  it('S4_REDIS_ACL_DENIALS: each role is denied commands outside its exact authority', async () => {
    const keys = taskKeys()
    await runRedisStep('S4 Redis ACL proof could not seed protected history evidence.', () => admin.zadd(keys.history, 1, eventEnvelope(1)))
    await runRedisStep('S4 Redis ACL proof could not seed protected sequence evidence.', () => admin.set(keys.sequence, '1'))
    const beforeHistory = await dumpFingerprint(keys.history)
    const beforeSequence = await dumpFingerprint(keys.sequence)
    const unrelatedChannel = `forge:unrelated:${randomUUID()}:live`
    const legacy = legacyKeys(legacyFixtureTaskId)
    const nonCanonicalV2Key = `forge:task-events:v2:${randomUUID()}:live`
    ownedKeys.add(nonCanonicalV2Key)
    await runRedisStep('S4 Redis ACL proof could not seed legacy denial evidence.', () => admin.zadd(legacy.history, 1, 'legacy-fixture'))
    await runRedisStep('S4 Redis ACL proof could not seed noncanonical denial evidence.', () => admin.zadd(nonCanonicalV2Key, 1, 'noncanonical-fixture'))
    const publisher = client(publisherUrl)
    const subscriber = client(subscriberUrl)
    const oldWriter = client(legacyUrl)
    await Promise.all([
      runRedisStep('S4 Redis ACL proof could not connect the publisher denial client.', () => publisher.connect()),
      runRedisStep('S4 Redis ACL proof could not connect the subscriber denial client.', () => subscriber.connect()),
      runRedisStep('S4 Redis ACL proof could not connect the legacy denial client.', () => oldWriter.connect()),
    ])
    await assertActiveClientUsers([publisherUser, subscriberUser, legacyUser])
    const beforeConfiguredDatabase = await databaseEvidence(admin)
    const beforeOtherDatabase = await databaseEvidence(otherDatabaseAdmin)
    const deniedDatabase = destructiveDatabase === 15 ? 14 : 15
    await Promise.all([
      runRedisStep('S4 Redis ACL proof could not select the publisher database.', () => publisher.select(destructiveDatabase)),
      runRedisStep('S4 Redis ACL proof could not select the subscriber database.', () => subscriber.select(destructiveDatabase)),
      runRedisStep('S4 Redis ACL proof could not select the legacy database.', () => oldWriter.select(destructiveDatabase)),
    ])
    await Promise.all([
      expectNoPerm(() => publisher.select(deniedDatabase)),
      expectNoPerm(() => subscriber.select(deniedDatabase)),
      expectNoPerm(() => oldWriter.select(deniedDatabase)),
      expectNoPerm(() => publisher.zrangebyscore(keys.history, 1, '+inf')),
      expectNoPerm(() => publisher.subscribe(keys.live)),
      expectNoPerm(() => publisher.del(keys.history)),
      expectNoPerm(() => publisher.set(legacy.sequence, '1')),
      expectNoPerm(() => publisher.publish(unrelatedChannel, 'x')),
      expectNoPerm(() => publisher.eval("return redis.call('DEL', KEYS[1])", 1, keys.history)),
      expectNoPerm(() => publisher.eval("return redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])", 1, legacy.history, '2', 'legacy-probe')),
      expectNoPerm(() => publisher.eval("return redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])", 1, nonCanonicalV2Key, '2', 'v2-probe')),
      expectNoPerm(() => publisher.eval("return redis.call('PUBLISH', ARGV[1], ARGV[2])", 0, unrelatedChannel, 'lua-probe')),
      expectNoPerm(() => subscriber.publish(keys.live, 'x')),
      expectNoPerm(() => subscriber.eval('return 1', 0)),
      expectNoPerm(() => subscriber.zadd(keys.history, 2, eventEnvelope(2))),
      expectNoPerm(() => subscriber.del(keys.history)),
      expectNoPerm(() => subscriber.set(legacy.sequence, '1')),
      expectNoPerm(() => oldWriter.zadd(keys.history, 2, eventEnvelope(2))),
    ])
    expect(await dumpFingerprint(keys.history)).toEqual(beforeHistory)
    expect(await dumpFingerprint(keys.sequence)).toEqual(beforeSequence)
    assertDatabaseEvidence(await databaseEvidence(admin), beforeConfiguredDatabase)
    assertDatabaseEvidence(await databaseEvidence(otherDatabaseAdmin), beforeOtherDatabase)
    await runRedisStep('S4 Redis ACL proof could not remove denial fixture keys.', () => admin.del(legacy.history, nonCanonicalV2Key))
    console.info('S4_REDIS_ACL_DENIALS_OK')
  })

  it('S4_REDIS_ACL_LEGACY_REVOKED: legacy credentials cannot recreate purged keys after revocation', async () => {
    const legacy = legacyKeys(legacyFixtureTaskId)
    const oldWriter = client(legacyUrl)
    await runRedisStep('S4 Redis ACL proof could not connect the legacy fixture writer.', () => oldWriter.connect())
    await runRedisStep('S4 Redis ACL proof could not write legacy history.', () => oldWriter.zadd(legacy.history, 1, 'legacy-history'))
    await runRedisStep('S4 Redis ACL proof could not write the legacy sequence.', () => oldWriter.set(legacy.sequence, '1'))
    const v2Task = taskKeys()
    await runRedisStep('S4 Redis ACL proof could not seed immutable v2 history.', () => admin.zadd(v2Task.history, 1, eventEnvelope(1)))
    await runRedisStep('S4 Redis ACL proof could not seed the immutable v2 sequence.', () => admin.set(v2Task.sequence, '1'))
    const beforeV2 = await Promise.all([dumpFingerprint(v2Task.history), dumpFingerprint(v2Task.sequence)])
    const purge = await runRedisStep('S4 Redis ACL proof could not run the production legacy purge.', () => createLegacyLeakageRedisAdapter(admin).purgeLegacyTaskEventKeys({ apply: true }))
    expect(purge).toMatchObject({ complete: true, remainingKeys: 0, violations: 0 })
    const legacyCountAfterPurge = await runRedisStep('S4 Redis ACL proof could not verify legacy purge state.', () => admin.exists(legacy.history, legacy.sequence))
    expect(legacyCountAfterPurge).toBe(0)

    const terminated = new Promise<boolean>((resolve) => oldWriter.once('end', () => resolve(true)))
    const removedLegacyUsers = await runRedisStep('S4 Redis ACL proof could not revoke the legacy ACL identity.', () => admin.call('ACL', 'DELUSER', legacyUser))
    if (removedLegacyUsers !== 1) throw new Error('S4 Redis ACL proof did not revoke exactly one legacy ACL identity.')
    await assertAclAbsent(legacyUser)
    const ended = await Promise.race([terminated, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))])
    expect(ended).toBe(true)
    await expectRejected(() => oldWriter.set(legacy.sequence, '1'))

    const staleConnection = client(legacyUrl)
    await expectRevokedCredentialConnection(() => staleConnection.connect())
    const legacyCountAfterRevocation = await runRedisStep('S4 Redis ACL proof could not verify legacy revocation state.', () => admin.exists(legacy.history, legacy.sequence))
    expect(legacyCountAfterRevocation).toBe(0)
    const v2Evidence = await runRedisStep('S4 Redis ACL proof could not verify final v2 evidence.', () => createLegacyLeakageRedisAdapter(admin).scanV2TaskEventHistory([]))
    expect(v2Evidence).toMatchObject({ complete: true, violations: 0 })
    expect(await Promise.all([dumpFingerprint(v2Task.history), dumpFingerprint(v2Task.sequence)])).toEqual(beforeV2)
    console.info('S4_REDIS_ACL_LEGACY_REVOKED_OK')
  })
})
