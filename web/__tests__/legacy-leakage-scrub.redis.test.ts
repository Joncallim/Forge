import { createHmac, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  runLegacyLeakageScrub,
  type LegacyLeakageScrubCheckpoint,
  type LegacyLeakageScrubDatabase,
  type LegacyLeakageScrubRow,
  type LoadedLegacyLeakageCheckpoint,
} from '@/lib/mcps/legacy-leakage-scrub'
import { createLegacyLeakageRedisAdapter } from '@/scripts/scrub-legacy-leakage'

const required = process.env.FORGE_S4_REQUIRE_REDIS_TEST === '1'
const destructive = process.env.FORGE_S4_REDIS_DESTRUCTIVE_TEST === '1'
const redisUrl = process.env.FORGE_S4_REDIS_TEST_URL

function validateDestructiveRedisUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('S4 Redis proof requires a valid dedicated Redis URL.')
  }
  if ((parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') || parsed.search || parsed.hash) {
    throw new Error('S4 Redis proof requires an unambiguous redis: or rediss: URL.')
  }
  if (!/^\/[1-9][0-9]*$/.test(parsed.pathname)) {
    throw new Error('S4 Redis proof requires an explicit nonzero disposable database path.')
  }
  const database = Number(parsed.pathname.slice(1))
  if (!Number.isSafeInteger(database) || database < 1) {
    throw new Error('S4 Redis proof requires an explicit nonzero disposable database path.')
  }
  return value
}

if (required && (!redisUrl || !destructive)) {
  throw new Error('FORGE_S4_REQUIRE_REDIS_TEST=1 requires FORGE_S4_REDIS_TEST_URL and FORGE_S4_REDIS_DESTRUCTIVE_TEST=1; the mandatory Redis proof may not skip.')
}

const destructiveRedisUrl = redisUrl && destructive ? validateDestructiveRedisUrl(redisUrl) : null
const enabled = Boolean(destructiveRedisUrl)
const fingerprintKey = Buffer.alloc(32, 41)
const fingerprintKeyId = 's4-redis-proof-v1'
const receipt = randomUUID()
const hmacKey = Buffer.alloc(32, 73)

class MemoryScrubDatabase implements LegacyLeakageScrubDatabase {
  checkpoint: LoadedLegacyLeakageCheckpoint | null = null

  async verifyDrainAuthorization(receiptId: string): Promise<boolean> {
    return receiptId === receipt
  }

  async databaseTime(): Promise<string> {
    return '2026-07-28T00:00:00.000Z'
  }

  async loadCheckpoint(): Promise<LoadedLegacyLeakageCheckpoint | null> {
    return this.checkpoint
  }

  async createCheckpoint(checkpoint: LegacyLeakageScrubCheckpoint): Promise<LoadedLegacyLeakageCheckpoint | null> {
    if (this.checkpoint) return null
    this.checkpoint = { checkpoint, token: JSON.stringify(checkpoint) }
    return this.checkpoint
  }

  async compareAndSetCheckpoint(
    current: LoadedLegacyLeakageCheckpoint,
    next: LegacyLeakageScrubCheckpoint,
  ): Promise<LoadedLegacyLeakageCheckpoint | null> {
    if (this.checkpoint?.token !== current.token) return null
    this.checkpoint = { checkpoint: next, token: JSON.stringify(next) }
    return this.checkpoint
  }

  async scanRows(): Promise<LegacyLeakageScrubRow[]> {
    return []
  }

  async commitRow(): Promise<'committed' | 'row_conflict' | 'checkpoint_conflict'> {
    throw new Error('Redis proof must not invoke a database row commit.')
  }
}

function eventEnvelope(id: number): string {
  return JSON.stringify({
    schemaVersion: 2,
    id,
    type: 'task:status',
    data: { errorMessage: null, status: 'running', updatedAt: '2026-07-28T00:00:00.000Z' },
  })
}

function opaque(value: Buffer | null): string {
  return createHmac('sha256', hmacKey).update(value ?? Buffer.alloc(0)).digest('hex')
}

describe.skipIf(!enabled)('S4 real Redis legacy leakage scrub proof', () => {
  let redis: Redis
  const ownedKeys = new Set<string>()

  function taskKeys(taskId: string): Readonly<{ legacyHistory: string; legacySequence: string; v2History: string; v2Sequence: string; v2Unknown: string }> {
    return {
      legacyHistory: `forge:task:${taskId}:history`,
      legacySequence: `forge:task:${taskId}:seq`,
      v2History: `forge:task-events:v2:${taskId}:history`,
      v2Sequence: `forge:task-events:v2:${taskId}:seq`,
      v2Unknown: `forge:task-events:v2:${taskId}:live`,
    }
  }

  async function seedValid(taskId: string): Promise<ReturnType<typeof taskKeys>> {
    const keys = taskKeys(taskId)
    ownedKeys.add(keys.legacyHistory)
    ownedKeys.add(keys.legacySequence)
    ownedKeys.add(keys.v2History)
    ownedKeys.add(keys.v2Sequence)
    await redis.zadd(keys.legacyHistory, 1, 'legacy-history')
    await redis.set(keys.legacySequence, '1')
    await redis.zadd(keys.v2History, 1, eventEnvelope(1))
    await redis.set(keys.v2Sequence, '1')
    return keys
  }

  async function dumpBuffer(key: string): Promise<Buffer | null> {
    const dumped = await redis.callBuffer('DUMP', key)
    if (dumped === null) return null
    if (!Buffer.isBuffer(dumped)) throw new Error('S4 Redis proof requires binary DUMP replies for immutable fingerprints.')
    return dumped
  }

  async function snapshotV2(keys: ReturnType<typeof taskKeys>): Promise<Readonly<{ historyType: string; sequenceType: string; history: string; sequence: string }>> {
    const [historyType, sequenceType, history, sequence] = await Promise.all([
      redis.type(keys.v2History), redis.type(keys.v2Sequence),
      dumpBuffer(keys.v2History), dumpBuffer(keys.v2Sequence),
    ])
    return {
      historyType,
      sequenceType,
      history: opaque(history),
      sequence: opaque(sequence),
    }
  }

  async function runApply(database: MemoryScrubDatabase, operationId: string, adapter = createLegacyLeakageRedisAdapter(redis)) {
    return runLegacyLeakageScrub({
      actor: 's4-redis-proof', authorizationReceiptId: receipt, fingerprintKey, fingerprintKeyId,
      mode: 'apply', operationId, batchSize: 100, maxBatches: 100,
    }, { database, redis: adapter })
  }

  beforeAll(async () => {
    redis = new Redis(destructiveRedisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    await redis.connect()
    const info = await redis.info('server')
    const version = /^redis_version:(\d+)/m.exec(info)?.[1]
    if (!version || Number(version) < 7) throw new Error('S4 Redis proof requires Redis major version 7 or newer.')
    if (await redis.dbsize() !== 0) throw new Error('S4 Redis proof requires an empty dedicated disposable database.')
  })

  afterAll(async () => {
    try {
      if (ownedKeys.size > 0) await redis.del(...ownedKeys)
      const remaining = await Promise.all([...ownedKeys].map((key) => redis.exists(key)))
      expect(remaining.every((count) => count === 0)).toBe(true)
      expect(await redis.dbsize()).toBe(0)
    } finally {
      await redis?.quit()
    }
  })

  it('S4_SCRUB_REDIS: purges exact legacy keys, retries lost responses, and preserves v2 evidence', async () => {
    console.info('S4_SCRUB_REDIS_START')
    const successTask = randomUUID()
    const successKeys = await seedValid(successTask)
    const before = await snapshotV2(successKeys)
    const successDatabase = new MemoryScrubDatabase()
    const success = await runApply(successDatabase, `redis-success-${randomUUID()}`)
    expect(success.checkpoint).toMatchObject({ state: 'complete', phase: 'complete', authorizationReceiptId: receipt })
    expect(await redis.exists(successKeys.legacyHistory, successKeys.legacySequence)).toBe(0)
    expect(await snapshotV2(successKeys)).toEqual(before)
    expect(success.checkpoint?.redisV2ValuesExamined).toBeGreaterThanOrEqual(1)
    console.info('S4_SCRUB_REDIS_V2_IMMUTABLE_OK')

    const retryTask = randomUUID()
    const retryKeys = await seedValid(retryTask)
    const retryBefore = await snapshotV2(retryKeys)
    const retryDatabase = new MemoryScrubDatabase()
    const production = createLegacyLeakageRedisAdapter(redis)
    let lostResponse = true
    const lostResponseAdapter = {
      ...production,
      async purgeLegacyTaskEventKeys(options: Parameters<typeof production.purgeLegacyTaskEventKeys>[0]) {
        const result = await production.purgeLegacyTaskEventKeys(options)
        if (options.apply && lostResponse) {
          lostResponse = false
          throw new Error('simulated Redis response loss after production legacy delete')
        }
        return result
      },
    }
    const operationId = `redis-retry-${randomUUID()}`
    await expect(runApply(retryDatabase, operationId, lostResponseAdapter)).rejects.toThrow('simulated Redis response loss')
    expect(await redis.exists(retryKeys.legacyHistory, retryKeys.legacySequence)).toBe(0)
    const resumed = await runLegacyLeakageScrub({
      actor: 's4-redis-proof', authorizationReceiptId: receipt, fingerprintKey, fingerprintKeyId,
      mode: 'resume', operationId, batchSize: 100, maxBatches: 100,
    }, { database: retryDatabase, redis: production })
    expect(resumed.checkpoint).toMatchObject({ state: 'complete', phase: 'complete', authorizationReceiptId: receipt })
    expect(await snapshotV2(retryKeys)).toEqual(retryBefore)
    console.info('S4_SCRUB_REDIS_PURGE_RETRY_OK')
  })

  it('fails closed on real Redis v2 preflight violations before any legacy delete', async () => {
    const cases = [
      'malformed_legacy', 'stored_live', 'wrong_type', 'bad_sequence', 'bad_envelope', 'score_mismatch', 'duplicate_sentinel',
    ] as const
    for (const kind of cases) {
      const taskId = randomUUID()
      const keys = await seedValid(taskId)
      if (kind === 'malformed_legacy') {
        const malformed = `forge:task:not-a-uuid-${randomUUID()}:history`
        ownedKeys.add(malformed)
        await redis.zadd(malformed, 1, 'legacy')
      } else if (kind === 'stored_live') {
        ownedKeys.add(keys.v2Unknown)
        await redis.set(keys.v2Unknown, 'stored-key')
      } else if (kind === 'wrong_type') {
        await redis.del(keys.v2History)
        await redis.set(keys.v2History, 'not-a-zset')
      } else if (kind === 'bad_sequence') {
        await redis.set(keys.v2Sequence, '01')
      } else if (kind === 'bad_envelope') {
        await redis.zadd(keys.v2History, 2, JSON.stringify({ schemaVersion: 2, id: 2, type: 'run:chunk', data: {} }))
      } else if (kind === 'score_mismatch') {
        await redis.del(keys.v2History)
        await redis.zadd(keys.v2History, 1, eventEnvelope(2))
      } else {
        await redis.del(keys.v2History)
        await redis.zadd(keys.v2History, 1, String.raw`{"schemaVersion":2,"id":1,"type":"task:status","data":{"errorMessage":null,"\u0065rrorMessage":"S4-REDIS-SENTINEL","status":"running","updatedAt":"2026-07-28T00:00:00.000Z"}}`)
      }
      const before = await snapshotV2(keys)
      const del = vi.spyOn(redis, 'del')
      const result = await runApply(new MemoryScrubDatabase(), `redis-invalid-${kind}-${randomUUID()}`)
      expect(result.checkpoint).toMatchObject({ phase: 'redis_legacy', state: 'paused_conflict' })
      expect(del).not.toHaveBeenCalled()
      expect(await redis.exists(keys.legacyHistory, keys.legacySequence)).toBe(2)
      expect(await snapshotV2(keys)).toEqual(before)
      del.mockRestore()
      await redis.del(keys.legacyHistory, keys.legacySequence, keys.v2History, keys.v2Sequence, keys.v2Unknown)
      if (kind === 'malformed_legacy') await redis.del(...[...ownedKeys].filter((key) => key.startsWith('forge:task:not-a-uuid-')))
    }
  })

  it('refuses completion when a malformed legacy key reappears at the production post-delete boundary', async () => {
    const taskId = randomUUID()
    const keys = await seedValid(taskId)
    const malformed = `forge:task:not-a-uuid-${randomUUID()}:history`
    ownedKeys.add(malformed)
    const originalDel = redis.del.bind(redis)
    const injectMalformedReappearance = async (...keysToDelete: string[]): Promise<number> => {
      const deleted = await originalDel(...keysToDelete)
      await redis.set(malformed, 'post-delete-reappearance')
      return deleted
    }
    const del = vi.spyOn(redis, 'del').mockImplementation(injectMalformedReappearance as never)
    try {
      const result = await runApply(new MemoryScrubDatabase(), `redis-reappear-${randomUUID()}`)
      expect(result.checkpoint).toMatchObject({ phase: 'redis_legacy', state: 'paused_conflict' })
      expect(await redis.exists(keys.legacyHistory, keys.legacySequence)).toBe(0)
    } finally {
      del.mockRestore()
    }
  })
})
