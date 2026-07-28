import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLegacyLeakageRedisAdapter } from '@/scripts/scrub-legacy-leakage'
import { taskEventRedisConfiguration, taskEventRedisKeys } from '@/lib/task-event-redis'
import { publishTaskEvent } from '@/worker/events'

vi.mock('@/lib/mcps/s4-lease', () => ({
  readS4RuntimeModeV1: vi.fn(async () => 'protected'),
}))

const required = process.env.FORGE_S4_REDIS_ACL_TEST_REQUIRED === '1'
const destructive = process.env.FORGE_S4_REDIS_ACL_DESTRUCTIVE_TEST === '1'
const adminUrl = process.env.FORGE_S4_REDIS_ACL_TEST_ADMIN_URL

function validateDestructiveRedisUrl(value: string): string {
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
  return value
}

if (required && (!destructive || !adminUrl)) {
  throw new Error('The mandatory S4 Redis ACL proof requires FORGE_S4_REDIS_ACL_DESTRUCTIVE_TEST=1 and FORGE_S4_REDIS_ACL_TEST_ADMIN_URL; it may not skip.')
}

const destructiveAdminUrl = adminUrl && destructive ? validateDestructiveRedisUrl(adminUrl) : null
const enabled = Boolean(destructiveAdminUrl)
const fingerprintKey = Buffer.alloc(32, 59)
const legacyFixtureTaskId = randomUUID()

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

describe.skipIf(!enabled)('S4 real Redis ACL task-event proof', () => {
  let admin: Redis
  let publisherUrl: string
  let subscriberUrl: string
  let legacyUrl: string
  let publisherUser: string
  let subscriberUser: string
  let legacyUser: string
  const ownedKeys = new Set<string>()
  const ownedUsers = new Set<string>()
  const clients = new Set<Redis>()

  function client(url: string): Redis {
    const instance = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    clients.add(instance)
    return instance
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
    const parsed = new URL(destructiveAdminUrl!)
    parsed.username = user
    parsed.password = password
    return parsed.toString()
  }

  async function setUser(user: string, password: string, rules: readonly string[]): Promise<void> {
    await admin.call('ACL', 'SETUSER', user, 'reset', 'on', `>${password}`, ...rules)
    ownedUsers.add(user)
  }

  async function dumpFingerprint(key: string): Promise<Readonly<{ type: string; dump: string }>> {
    const [type, dumped] = await Promise.all([admin.type(key), admin.callBuffer('DUMP', key)])
    if (dumped !== null && !Buffer.isBuffer(dumped)) throw new Error('S4 Redis ACL proof requires binary DUMP replies.')
    return { type, dump: opaque(dumped as Buffer | null) }
  }

  async function expectNoPerm(action: () => Promise<unknown>): Promise<void> {
    await expect(action()).rejects.toThrow(/NOPERM/)
  }

  beforeAll(async () => {
    admin = client(destructiveAdminUrl!)
    await admin.connect()
    const info = await admin.info('server')
    const major = /^redis_version:(\d+)/m.exec(info)?.[1]
    if (!major || Number(major) < 7) throw new Error('S4 Redis ACL proof requires Redis major version 7 or newer.')
    if (await admin.dbsize() !== 0) throw new Error('S4 Redis ACL proof requires an empty dedicated disposable database.')

    publisherUser = `s4pub_${randomUUID().replaceAll('-', '')}`
    subscriberUser = `s4sub_${randomUUID().replaceAll('-', '')}`
    legacyUser = `s4legacy_${randomUUID().replaceAll('-', '')}`
    const publisherPassword = randomBytes(32).toString('base64url')
    const subscriberPassword = randomBytes(32).toString('base64url')
    const legacyPassword = randomBytes(32).toString('base64url')
    publisherUrl = authenticatedUrl(publisherUser, publisherPassword)
    subscriberUrl = authenticatedUrl(subscriberUser, subscriberPassword)
    legacyUrl = authenticatedUrl(legacyUser, legacyPassword)

    await setUser(publisherUser, publisherPassword, [
      '~forge:task-events:v2:*:history', '~forge:task-events:v2:*:seq', '&forge:task-events:v2:*:live',
      '+select', '+ping', '+info', '+client|setinfo', '+eval', '+incr', '+zadd', '+zcard', '+zremrangebyrank', '+publish',
    ])
    await setUser(subscriberUser, subscriberPassword, [
      '~forge:task-events:v2:*:history', '~forge:task-events:v2:*:seq', '&forge:task-events:v2:*:live',
      '+select', '+ping', '+info', '+client|setinfo', '+get', '+zrangebyscore', '+subscribe', '+unsubscribe', '+psubscribe', '+punsubscribe',
    ])
    await setUser(legacyUser, legacyPassword, [
      `~forge:task:${legacyFixtureTaskId}:history`, `~forge:task:${legacyFixtureTaskId}:seq`,
      '+select', '+ping', '+info', '+client|setinfo', '+zadd', '+set',
    ])
  })

  afterAll(async () => {
    try {
      for (const instance of clients) if (instance !== admin) instance.disconnect()
      for (const user of ownedUsers) await admin.call('ACL', 'DELUSER', user)
      if (ownedKeys.size > 0) await admin.del(...ownedKeys)
      expect(await admin.dbsize()).toBe(0)
      const users = await admin.call('ACL', 'USERS') as string[]
      for (const user of ownedUsers) expect(users).not.toContain(user)
    } finally {
      admin?.disconnect()
    }
  })

  it('S4_REDIS_ACL_ROLE_ISOLATION: production publish, live delivery, and replay use distinct roles', async () => {
    const taskId = randomUUID()
    const keys = taskKeys(taskId)
    const configuration = (() => {
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
    })()
    expect(configuration).toMatchObject({ dedicated: true, publisherUrl, subscriberUrl })

    const live = client(subscriberUrl)
    const replay = client(subscriberUrl)
    await Promise.all([live.connect(), replay.connect()])
    const delivered = new Promise<string>((resolve) => live.once('message', (_channel, message) => resolve(message)))
    await live.subscribe(keys.live)

    const previousPublisher = process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
    const previousSubscriber = process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL
    process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = publisherUrl
    process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = subscriberUrl
    try {
      await publishTaskEvent(taskId, 'task:status', { status: 'running', updatedAt: '2026-07-28T00:00:00.000Z' })
    } finally {
      if (previousPublisher === undefined) delete process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL
      else process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = previousPublisher
      if (previousSubscriber === undefined) delete process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL
      else process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = previousSubscriber
    }
    const message = await delivered
    const replayRows = await replay.zrangebyscore(keys.history, 1, '+inf', 'WITHSCORES')
    const sequence = await replay.get(keys.sequence)
    expect(JSON.parse(message)).toMatchObject({ schemaVersion: 2, id: 1, type: 'task:status' })
    expect(replayRows).toHaveLength(2)
    expect(sequence).toBe('1')
    const publisherClient = (globalThis as { forgeTaskEventPublisherRedis?: Redis }).forgeTaskEventPublisherRedis
    if (publisherClient) clients.add(publisherClient)
    const clientList = await admin.client('LIST')
    expect(clientList).toContain(`user=${publisherUser}`)
    expect(clientList).toContain(`user=${subscriberUser}`)
    console.info('S4_REDIS_ACL_ROLE_ISOLATION_OK')
  })

  it('S4_REDIS_ACL_DENIALS: each role is denied commands outside its exact authority', async () => {
    const keys = taskKeys()
    await admin.zadd(keys.history, 1, eventEnvelope(1))
    await admin.set(keys.sequence, '1')
    const beforeHistory = await dumpFingerprint(keys.history)
    const beforeSequence = await dumpFingerprint(keys.sequence)
    const unrelatedChannel = `forge:unrelated:${randomUUID()}:live`
    const legacy = legacyKeys(legacyFixtureTaskId)
    const publisher = client(publisherUrl)
    const subscriber = client(subscriberUrl)
    const oldWriter = client(legacyUrl)
    await Promise.all([publisher.connect(), subscriber.connect(), oldWriter.connect()])
    await Promise.all([
      expectNoPerm(() => publisher.zrangebyscore(keys.history, 1, '+inf')),
      expectNoPerm(() => publisher.subscribe(keys.live)),
      expectNoPerm(() => publisher.del(keys.history)),
      expectNoPerm(() => publisher.set(legacy.sequence, '1')),
      expectNoPerm(() => publisher.publish(unrelatedChannel, 'x')),
      expectNoPerm(() => subscriber.publish(keys.live, 'x')),
      expectNoPerm(() => subscriber.eval('return 1', 0)),
      expectNoPerm(() => subscriber.zadd(keys.history, 2, eventEnvelope(2))),
      expectNoPerm(() => subscriber.del(keys.history)),
      expectNoPerm(() => subscriber.set(legacy.sequence, '1')),
      expectNoPerm(() => oldWriter.zadd(keys.history, 2, eventEnvelope(2))),
    ])
    expect(await dumpFingerprint(keys.history)).toEqual(beforeHistory)
    expect(await dumpFingerprint(keys.sequence)).toEqual(beforeSequence)
    console.info('S4_REDIS_ACL_DENIALS_OK')
  })

  it('S4_REDIS_ACL_LEGACY_REVOKED: legacy credentials cannot recreate purged keys after revocation', async () => {
    const legacy = legacyKeys(legacyFixtureTaskId)
    const oldWriter = client(legacyUrl)
    await oldWriter.connect()
    await oldWriter.zadd(legacy.history, 1, 'legacy-history')
    await oldWriter.set(legacy.sequence, '1')
    const v2Task = taskKeys()
    await admin.zadd(v2Task.history, 1, eventEnvelope(1))
    await admin.set(v2Task.sequence, '1')
    const beforeV2 = await Promise.all([dumpFingerprint(v2Task.history), dumpFingerprint(v2Task.sequence)])
    const purge = await createLegacyLeakageRedisAdapter(admin).purgeLegacyTaskEventKeys({ apply: true })
    expect(purge).toMatchObject({ complete: true, remainingKeys: 0, violations: 0 })
    expect(await admin.exists(legacy.history, legacy.sequence)).toBe(0)

    const terminated = new Promise<boolean>((resolve) => oldWriter.once('end', () => resolve(true)))
    expect(await admin.call('ACL', 'DELUSER', legacyUser)).toBe(1)
    const ended = await Promise.race([terminated, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))])
    expect(ended).toBe(true)
    await expect(oldWriter.set(legacy.sequence, '1')).rejects.toThrow()

    const staleConnection = client(legacyUrl)
    staleConnection.on('error', () => undefined)
    await expect(staleConnection.connect()).rejects.toThrow(/WRONGPASS|NOAUTH|NOPERM|Connection is closed/)
    expect(await admin.exists(legacy.history, legacy.sequence)).toBe(0)
    expect(await createLegacyLeakageRedisAdapter(admin).scanV2TaskEventHistory([])).toMatchObject({ complete: true, violations: 0 })
    expect(await Promise.all([dumpFingerprint(v2Task.history), dumpFingerprint(v2Task.sequence)])).toEqual(beforeV2)
    console.info('S4_REDIS_ACL_LEGACY_REVOKED_OK')
  })
})
