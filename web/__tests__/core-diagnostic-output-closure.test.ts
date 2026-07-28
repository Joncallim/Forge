import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RedisHarnessInstance = {
  brpoplpush: ReturnType<typeof vi.fn>
  call: ReturnType<typeof vi.fn>
  callBuffer: ReturnType<typeof vi.fn>
  eval: ReturnType<typeof vi.fn>
  hdel: ReturnType<typeof vi.fn>
  hget: ReturnType<typeof vi.fn>
  hset: ReturnType<typeof vi.fn>
  lpush: ReturnType<typeof vi.fn>
  llen: ReturnType<typeof vi.fn>
  lrange: ReturnType<typeof vi.fn>
  lrem: ReturnType<typeof vi.fn>
  rpush: ReturnType<typeof vi.fn>
  zadd: ReturnType<typeof vi.fn>
  zrangebyscore: ReturnType<typeof vi.fn>
  zrem: ReturnType<typeof vi.fn>
  emit: (event: string, value: unknown) => boolean
}

type InjectedRedisFailure = {
  marker: string
  stage: 'after' | 'before'
}

type AtomicQueueJob = {
  action?: 'approve' | 'reject'
  attempt: number
  taskId: string
}

type AtomicQueue = {
  ack: (raw: string) => Promise<'already_applied' | 'applied'>
  claim: (timeoutSeconds: number) => Promise<{
    job: AtomicQueueJob
    occurrenceId: string
    raw: string
  } | null>
  deadLetter: (raw: string, job: AtomicQueueJob) => Promise<'already_applied' | 'applied'>
  promoteDueRetries: (limit?: number) => Promise<number>
  recoverStuckJobs: (staleMs: number, options?: { drain?: boolean }) => Promise<number>
  release: (raw: string) => Promise<'already_applied' | 'applied'>
  retry: (raw: string, job: AtomicQueueJob, delayMs: number) => Promise<{
    nextRetryAt: Date
    outcome: 'already_applied' | 'applied'
  }>
}

class TestRetryPromotionConflictError extends Error {}

const redisHarness = vi.hoisted(() => ({
  claimPayloads: [] as Array<string | null>,
  failures: [] as InjectedRedisFailure[],
  hashes: new Map<string, Map<string, string>>(),
  instances: [] as RedisHarnessInstance[],
  lists: new Map<string, string[]>(),
  nowMs: 1_800_000_000_000,
  zsets: new Map<string, Map<string, number>>(),
}))

vi.mock('ioredis', () => {
  const list = (key: string): string[] => {
    const existing = redisHarness.lists.get(key) ?? []
    redisHarness.lists.set(key, existing)
    return existing
  }
  const hash = (key: string): Map<string, string> => {
    const existing = redisHarness.hashes.get(key) ?? new Map<string, string>()
    redisHarness.hashes.set(key, existing)
    return existing
  }
  const zset = (key: string): Map<string, number> => {
    const existing = redisHarness.zsets.get(key) ?? new Map<string, number>()
    redisHarness.zsets.set(key, existing)
    return existing
  }
  const removeFirst = (values: string[], value: string): boolean => {
    const index = values.indexOf(value)
    if (index < 0) return false
    values.splice(index, 1)
    return true
  }
  const injectedFailure = (script: string, stage: InjectedRedisFailure['stage']): boolean => {
    const index = redisHarness.failures.findIndex(
      (failure) => failure.stage === stage && script.includes(failure.marker),
    )
    if (index < 0) return false
    redisHarness.failures.splice(index, 1)
    return true
  }

  class RedisMock {
    private readonly listeners = new Map<string, Array<(value: unknown) => void>>()
    brpoplpush = vi.fn(async (source: string, destination: string) => {
      const queued = redisHarness.claimPayloads.length > 0
        ? redisHarness.claimPayloads.shift() ?? null
        : list(source).pop() ?? null
      if (queued !== null) list(destination).unshift(queued)
      return queued
    })
    eval = vi.fn(async (
      script: string,
      numberOfKeys: number,
      ...values: Array<Buffer | string>
    ) => {
      if (injectedFailure(script, 'before')) throw new Error('injected_redis_failure')
      const text = (value: Buffer | string): string => Buffer.isBuffer(value)
        ? value.toString('utf8')
        : value
      const keys = values.slice(0, numberOfKeys).map(text)
      const args = values.slice(numberOfKeys).map(text)
      let result: unknown = 0

      if (script.includes('forge:queue:claim-v2')) {
        const [source, envelope, occurrenceId, nonce, mode] = args
        const available = mode === 'legacy'
          ? removeFirst(list(keys[0]), source)
          : list(keys[0]).includes(envelope)
        if (available && !hash(keys[1]).has(occurrenceId)) {
          if (mode === 'legacy') list(keys[0]).unshift(envelope)
          const marker = `${redisHarness.nowMs}:${nonce}`
          hash(keys[1]).set(occurrenceId, marker)
          result = marker
        }
      } else if (script.includes('forge:queue:ack-v3')) {
        const nonce = args[2].split(':')[1]
        const receipt = `${args[1]}:${nonce}`
        const receiptTtlMs = Number(args[3])
        for (const [member, score] of zset(keys[2])) {
          if (score <= redisHarness.nowMs - receiptTtlMs) zset(keys[2]).delete(member)
        }
        if (hash(keys[1]).get(args[1]) === args[2] && removeFirst(list(keys[0]), args[0])) {
          hash(keys[1]).delete(args[1])
          zset(keys[2]).set(receipt, redisHarness.nowMs)
          result = 1
        } else if (!list(keys[0]).includes(args[0])
          && !hash(keys[1]).has(args[1])
          && zset(keys[2]).has(receipt)) {
          result = 2
        }
      } else if (script.includes('forge:queue:release-v1')) {
        const nonce = args[2].split(':')[1]
        const receipt = `${args[1]}:${nonce}`
        const receiptTtlMs = Number(args[3])
        for (const [member, score] of zset(keys[3])) {
          if (score <= redisHarness.nowMs - receiptTtlMs) zset(keys[3]).delete(member)
        }
        if (hash(keys[1]).get(args[1]) === args[2] && removeFirst(list(keys[0]), args[0])) {
          hash(keys[1]).delete(args[1])
          list(keys[2]).unshift(args[0])
          zset(keys[3]).set(receipt, redisHarness.nowMs)
          result = 1
        } else if (!list(keys[0]).includes(args[0])
          && !hash(keys[1]).has(args[1])
          && list(keys[2]).includes(args[0])
          && zset(keys[3]).has(receipt)) {
          result = 2
        }
      } else if (script.includes('forge:queue:discard-invalid-v2')) {
        if (removeFirst(list(keys[0]), args[0])) {
          result = 1
        } else {
          result = 2
        }
      } else if (script.includes('forge:queue:retry-v3')) {
        const delayMs = Number(args[3])
        if (!/^[0-9]+$/.test(args[3])
          || !Number.isSafeInteger(delayMs)
          || delayMs < 0) {
          throw new Error('forge_queue_retry_delay_invalid')
        }
        if (hash(keys[1]).get(args[1]) === args[2] && list(keys[0]).includes(args[0])) {
          if (zset(keys[2]).has(args[4])) {
            result = [0, '']
            return result
          }
          const deadlineMs = redisHarness.nowMs + delayMs
          if (!Number.isSafeInteger(deadlineMs)
            || deadlineMs > 8_640_000_000_000_000) {
            throw new Error('forge_queue_retry_timestamp_invalid')
          }
          zset(keys[2]).set(args[4], deadlineMs)
          hash(keys[1]).delete(args[1])
          removeFirst(list(keys[0]), args[0])
          result = [1, String(deadlineMs)]
        } else if (!list(keys[0]).includes(args[0])
          && !hash(keys[1]).has(args[1])
          && zset(keys[2]).has(args[4])) {
          result = [2, String(zset(keys[2]).get(args[4]))]
        } else {
          result = [0, '']
        }
      } else if (script.includes('forge:queue:dead-letter-v2')) {
        if (hash(keys[1]).get(args[1]) === args[2] && list(keys[0]).includes(args[0])) {
          list(keys[2]).unshift(args[3])
          hash(keys[1]).delete(args[1])
          removeFirst(list(keys[0]), args[0])
          result = 1
        } else if (!list(keys[0]).includes(args[0])
          && !hash(keys[1]).has(args[1])
          && list(keys[2]).includes(args[3])) {
          result = 2
        }
      } else if (script.includes('forge:queue:list-due-retries-v1')) {
        result = [...zset(keys[0]).entries()]
          .filter(([, score]) => score >= 0 && score <= redisHarness.nowMs)
          .sort((left, right) => left[1] - right[1])
          .slice(0, Number(args[0]))
          .flatMap(([member, score]) => [member, String(score)])
      } else if (script.includes('forge:queue:promote-retry-v4')) {
        const [
          source,
          expectedScore,
          fingerprint,
          mode,
          destination,
          candidateOccurrenceId,
          receiptTtlMsRaw,
          receiptCapRaw,
          pruneLimitRaw,
        ] = args
        const dispositions = hash(keys[2])
        const expiry = zset(keys[3])
        const receiptTtlMs = Number(receiptTtlMsRaw)
        const pruneLimit = Number(pruneLimitRaw)
        const expired = [...expiry.entries()]
          .filter(([, score]) => score <= redisHarness.nowMs - receiptTtlMs)
          .sort((left, right) => left[1] - right[1])
          .slice(0, pruneLimit)
        for (const [expiredFingerprint] of expired) {
          expiry.delete(expiredFingerprint)
          dispositions.delete(expiredFingerprint)
        }
        const existing = dispositions.get(fingerprint)
        const receiptScore = expiry.get(fingerprint)
        const currentScore = zset(keys[0]).get(source)
        if (currentScore === undefined) {
          if (existing === undefined && receiptScore === undefined) {
            result = [0, 'ownership_conflict', '']
          } else if (existing === undefined || receiptScore === undefined) {
            dispositions.delete(fingerprint)
            expiry.delete(fingerprint)
            result = [0, 'receipt_integrity_failure', '']
          } else {
            const winningOccurrenceId = existing.startsWith('promoted:')
              ? existing.slice('promoted:'.length)
              : null
            const validDisposition = existing === 'discarded'
              || (winningOccurrenceId !== null
                && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
                  .test(winningOccurrenceId))
            const validTimestamp = Number.isFinite(receiptScore)
              && receiptScore <= redisHarness.nowMs
              && receiptScore > redisHarness.nowMs - receiptTtlMs
            if (!validDisposition || !validTimestamp) {
              dispositions.delete(fingerprint)
              expiry.delete(fingerprint)
              result = [0, 'receipt_integrity_failure', '']
            } else if (existing === 'discarded' && mode === 'discard') {
              result = [2, 'discarded', '']
            } else if (winningOccurrenceId !== null && mode !== 'discard') {
              result = [2, 'promoted', winningOccurrenceId]
            } else {
              result = [0, 'receipt_integrity_failure', '']
            }
          }
        } else if (String(currentScore) !== expectedScore) {
          result = [0, 'ownership_conflict', '']
        } else if (existing !== undefined || receiptScore !== undefined) {
          result = [0, 'receipt_integrity_failure', '']
        } else if (dispositions.size >= Number(receiptCapRaw)
          || expiry.size >= Number(receiptCapRaw)) {
          throw new Error('forge_queue_retry_receipt_capacity_exhausted')
        } else {
          zset(keys[0]).delete(source)
          if (mode === 'discard') {
            dispositions.set(fingerprint, 'discarded')
            expiry.set(fingerprint, redisHarness.nowMs)
            result = [1, 'discarded', '']
          } else {
            list(keys[1]).unshift(destination)
            dispositions.set(fingerprint, `promoted:${candidateOccurrenceId}`)
            expiry.set(fingerprint, redisHarness.nowMs)
            result = [1, 'promoted', candidateOccurrenceId]
          }
        }
      } else if (script.includes('forge:queue:recover-stuck-v2')) {
        const marker = hash(keys[1]).get(args[1])
        const markerMatch = marker?.match(/^([1-9][0-9]*):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        if (marker && (!markerMatch
          || !Number.isSafeInteger(Number(markerMatch[1]))
          || Number(markerMatch[1]) > redisHarness.nowMs)) {
          throw new Error('forge_queue_claim_marker_invalid')
        }
        const claimedAt = markerMatch ? Number(markerMatch[1]) : 0
        if (!list(keys[0]).includes(args[0])) {
          result = 2
        } else if (claimedAt > 0 && redisHarness.nowMs - claimedAt < Number(args[2])) {
          removeFirst(list(keys[0]), args[0])
          list(keys[0]).push(args[0])
          result = 3
        } else {
          hash(keys[1]).delete(args[1])
          removeFirst(list(keys[0]), args[0])
          list(keys[2]).unshift(args[0])
          result = 1
        }
      } else if (script.includes('forge:queue:recover-legacy-v2')) {
        const marker = hash(keys[1]).get(args[0])
        const markerMatch = marker?.match(/^([1-9][0-9]*):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        if (marker && (!markerMatch
          || !Number.isSafeInteger(Number(markerMatch[1]))
          || Number(markerMatch[1]) > redisHarness.nowMs)) {
          throw new Error('forge_queue_claim_marker_invalid')
        }
        const claimedAt = markerMatch ? Number(markerMatch[1]) : 0
        if (!list(keys[0]).includes(args[0])) {
          result = 2
        } else if (claimedAt > 0 && redisHarness.nowMs - claimedAt < Number(args[2])) {
          removeFirst(list(keys[0]), args[0])
          list(keys[0]).push(args[0])
          result = 3
        } else if (removeFirst(list(keys[0]), args[0])) {
          hash(keys[1]).delete(args[0])
          list(keys[2]).unshift(args[1])
          result = 1
        } else {
          result = 2
        }
      } else {
        throw new Error('unknown_queue_script')
      }

      if (injectedFailure(script, 'after')) throw new Error('injected_redis_response_loss')
      return result
    })
    call = vi.fn(async (
      command: string,
      script: string,
      numberOfKeys: number,
      ...values: Array<Buffer | string>
    ) => {
      if (command !== 'EVAL') throw new Error('unknown_redis_command')
      return await this.eval(script, numberOfKeys, ...values)
    })
    callBuffer = vi.fn(async (
      command: string,
      script: string,
      numberOfKeys: number,
      ...values: Array<Buffer | string>
    ) => {
      const result = await this.call(command, script, numberOfKeys, ...values)
      const encode = (value: unknown): unknown => Array.isArray(value)
        ? value.map(encode)
        : Buffer.from(String(value), 'utf8')
      return encode(result)
    })
    hdel = vi.fn().mockResolvedValue(1)
    hget = vi.fn().mockResolvedValue(null)
    hset = vi.fn().mockResolvedValue(1)
    lpush = vi.fn().mockResolvedValue(1)
    llen = vi.fn(async (key: string) => list(key).length)
    lrange = vi.fn(async (key: string, start: number, stop: number) => {
      const values = list(key)
      const inclusiveStop = stop < 0 ? values.length : stop + 1
      return values.slice(start, inclusiveStop)
    })
    lrem = vi.fn().mockResolvedValue(1)
    rpush = vi.fn().mockResolvedValue(1)
    zadd = vi.fn().mockResolvedValue(1)
    zrangebyscore = vi.fn(async (
      key: string,
      minimum: number,
      maximum: number,
      ...options: Array<number | string>
    ) => {
      const ordered = [...zset(key).entries()]
        .filter(([, score]) => score >= Number(minimum) && score <= Number(maximum))
        .sort((left, right) => left[1] - right[1])
        .map(([member]) => member)
      const limitIndex = options.indexOf('LIMIT')
      if (limitIndex < 0) return ordered
      const offset = Number(options[limitIndex + 1])
      const count = Number(options[limitIndex + 2])
      return ordered.slice(offset, offset + count)
    })
    zrem = vi.fn().mockResolvedValue(1)
    disconnect = vi.fn()

    constructor() {
      redisHarness.instances.push(this)
    }

    on(event: string, listener: (value: unknown) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    emit(event: string, value: unknown): boolean {
      const listeners = this.listeners.get(event) ?? []
      for (const listener of listeners) listener(value)
      return listeners.length > 0
    }
  }
  return { default: RedisMock }
})

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const SENTINELS = [
  'RAW_PROMPT_SENTINEL',
  '/private/forge/repository',
  'redis://identity:password@private.example/15',
  'github_pat_SECRET_SENTINEL_12345678901234567890',
  '0123456789abcdef'.repeat(4),
]
const originalRedisUrl = process.env.REDIS_URL

function serializedConsoleCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return JSON.stringify(spy.mock.calls)
}

function hostileError(): Error {
  const error = new Error(SENTINELS.join(' '))
  Object.assign(error, {
    command: { args: ['SET', SENTINELS[0], { nested: SENTINELS[1] }] },
    connection: {
      token: SENTINELS[3],
      url: SENTINELS[2],
    },
    digest: SENTINELS[4],
  })
  return error
}

function assertNoSentinels(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const sentinel of SENTINELS) {
    expect(serialized).not.toContain(sentinel)
  }
}

function parsedOccurrence(raw: string): {
  job: AtomicQueueJob
  occurrenceId: string
  schemaVersion: number
} {
  return JSON.parse(raw) as {
    job: AtomicQueueJob
    occurrenceId: string
    schemaVersion: number
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  redisHarness.claimPayloads.length = 0
  redisHarness.failures.length = 0
  redisHarness.hashes.clear()
  redisHarness.instances.length = 0
  redisHarness.lists.clear()
  redisHarness.nowMs = 1_800_000_000_000
  redisHarness.zsets.clear()
  process.env.REDIS_URL = 'redis://localhost:6379/0'
  delete (globalThis as typeof globalThis & { redis?: unknown }).redis
  delete (globalThis as typeof globalThis & { forgeTaskEventPublisherRedis?: unknown })
    .forgeTaskEventPublisherRedis
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL
  else process.env.REDIS_URL = originalRedisUrl
})

describe('core operational output closure', () => {
  it('turns Redis connection errors into fixed, non-disclosing categories', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { redis } = await import('@/lib/redis')
    void redis.status

    const { TaskQueue } = await import('@/worker/queue')
    new TaskQueue('redis://localhost:6379/0')

    const { taskEventPublisherRedis } = await import('@/lib/task-event-redis')
    taskEventPublisherRedis({
      dedicated: true,
      publisherUrl: 'redis://publisher:secret@localhost:6379/0',
      subscriberUrl: 'redis://subscriber:secret@localhost:6379/0',
    })

    expect(redisHarness.instances).toHaveLength(3)
    for (const instance of redisHarness.instances) {
      instance.emit('error', hostileError())
    }

    expect(warn.mock.calls).toEqual([
      ['[redis] Connection unavailable'],
      ['[worker/queue] Redis connection unavailable'],
      ['[task-events] Publisher connection unavailable'],
    ])
    assertNoSentinels(serializedConsoleCalls(warn))
  })

  it('acknowledges malformed queue bytes without logging or retaining them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const malformed = JSON.stringify({
      taskId: SENTINELS[0],
      prompt: SENTINELS.join(' '),
      nested: { error: hostileError() },
    })
    redisHarness.claimPayloads.push(malformed)

    const { TaskQueue } = await import('@/worker/queue')
    const queue = new TaskQueue('redis://localhost:6379/0')
    await expect(queue.claim(1)).resolves.toBeNull()

    const [client] = redisHarness.instances
    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([])
    expect(redisHarness.hashes.get('forge:tasks:claims')?.has(malformed) ?? false).toBe(false)
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('forge:queue:discard-invalid-v2'),
      1,
      'forge:tasks:processing',
      malformed,
    )
    expect(client.hset).not.toHaveBeenCalled()
    expect(client.lpush).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('[worker/queue] Dropped invalid job payload')
    assertNoSentinels(serializedConsoleCalls(warn))
  })

  it('discards duplicate decoded keys before lossy parsing for every queue shape', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { AnswersQueue, ApprovalQueue, TaskQueue } = await import('@/worker/queue')
    const cases = [
      {
        Queue: TaskQueue,
        processing: 'forge:tasks:processing',
        raw: `{"taskId":"${TASK_ID}","taskId":"${SENTINELS[0]}"}`,
      },
      {
        Queue: ApprovalQueue,
        processing: 'forge:approvals:processing',
        raw: `{"taskId":"${TASK_ID}","action":"approve","nested":{"hidden":1,"hidden":"${SENTINELS[0]}"}}`,
      },
      {
        Queue: AnswersQueue,
        processing: 'forge:answers:processing',
        raw: String.raw`{"taskId":"${TASK_ID}","task\u0049d":"${SENTINELS[0]}"}`,
      },
    ]

    for (const queueCase of cases) {
      redisHarness.claimPayloads.push(queueCase.raw)
      const queue = new queueCase.Queue('redis://localhost:6379/0')
      await expect(queue.claim(1)).resolves.toBeNull()
      expect(redisHarness.lists.get(queueCase.processing)).toEqual([])
    }

    expect([...redisHarness.hashes.values()].every((entries) => entries.size === 0)).toBe(true)
    expect([...redisHarness.zsets.values()].every((entries) => entries.size === 0)).toBe(true)
    expect(
      [...redisHarness.lists.entries()]
        .filter(([key]) => key.endsWith(':dead') || key.endsWith(':retry'))
        .every(([, entries]) => entries.length === 0),
    ).toBe(true)
    expect(warn.mock.calls).toEqual(cases.map(() => [
      '[worker/queue] Dropped invalid job payload',
    ]))
    assertNoSentinels(warn.mock.calls)
  })

  it('keeps valid retry and dead-letter records closed while preserving queue semantics', async () => {
    const raw = JSON.stringify({ taskId: TASK_ID, attempt: 3 })
    redisHarness.claimPayloads.push(raw)

    const { TaskQueue } = await import('@/worker/queue')
    const queue = new TaskQueue('redis://localhost:6379/0')
    const claimed = await queue.claim(1)
    if (!claimed) throw new Error('Expected the closed task job to be claimed.')
    expect(claimed).toMatchObject({
      occurrenceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      job: { taskId: TASK_ID, attempt: 3 },
    })
    expect(parsedOccurrence(claimed.raw)).toEqual({
      schemaVersion: 1,
      occurrenceId: claimed.occurrenceId,
      job: claimed.job,
    })

    await queue.deadLetter(claimed.raw, claimed.job)
    const [client] = redisHarness.instances
    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([])
    expect(redisHarness.hashes.get('forge:tasks:claims')?.has(claimed.occurrenceId) ?? false)
      .toBe(false)
    expect(client.hset).not.toHaveBeenCalled()
    expect(client.lrem).not.toHaveBeenCalled()
    expect(client.hdel).not.toHaveBeenCalled()
    expect(client.lpush).not.toHaveBeenCalled()

    const [deadRaw] = redisHarness.lists.get('forge:tasks:dead') ?? []
    const deadRecord = JSON.parse(deadRaw) as Record<string, unknown>
    expect(deadRecord).toEqual({
      schemaVersion: 1,
      occurrenceId: claimed.occurrenceId,
      job: { taskId: TASK_ID, attempt: 3 },
      failureCategory: 'job_processing_failed',
      deadLetteredAt: expect.any(String),
    })
    expect(new Date(String(deadRecord.deadLetteredAt)).toISOString())
      .toBe(deadRecord.deadLetteredAt)
    assertNoSentinels(deadRecord)
    expect(deadRecord).not.toHaveProperty('raw')
    expect(deadRecord).not.toHaveProperty('errorMessage')

    const retryRaw = JSON.stringify({ taskId: TASK_ID })
    redisHarness.claimPayloads.push(retryRaw)
    const retryQueue = new TaskQueue('redis://localhost:6379/0')
    const retryClaim = await retryQueue.claim(1)
    if (!retryClaim) throw new Error('Expected the retry task job to be claimed.')
    const retry = await retryQueue.retry(retryClaim.raw, retryClaim.job, 500)
    const retryClient = redisHarness.instances[1]
    const retryEntries = [...(redisHarness.zsets.get('forge:tasks:retry') ?? new Map())]
    expect(retryEntries).toHaveLength(1)
    expect(parsedOccurrence(retryEntries[0][0])).toEqual({
      schemaVersion: 1,
      occurrenceId: retryClaim.occurrenceId,
      job: { taskId: TASK_ID, attempt: 2 },
    })
    expect(retryEntries[0][1]).toBe(retry.nextRetryAt.getTime())
    expect(retry.outcome).toBe('applied')
    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([])
    expect(redisHarness.hashes.get('forge:tasks:claims')?.has(retryClaim.occurrenceId) ?? false)
      .toBe(false)
    expect(retryClient.zadd).not.toHaveBeenCalled()
    expect(retryClient.lrem).not.toHaveBeenCalled()
    expect(retryClient.hdel).not.toHaveBeenCalled()
  })

  it('anchors retry deadlines to Redis time across queues, replay, skew, and bounds', async () => {
    const { AnswersQueue, ApprovalQueue, TaskQueue } = await import('@/worker/queue')
    const queueCases = [
      {
        create: () => new TaskQueue('redis://localhost:6379/0') as unknown as AtomicQueue,
        job: (attempt: number): AtomicQueueJob => ({ taskId: TASK_ID, attempt }),
        readyKey: 'forge:tasks',
        retryKey: 'forge:tasks:retry',
      },
      {
        create: () => new ApprovalQueue('redis://localhost:6379/0') as unknown as AtomicQueue,
        job: (attempt: number): AtomicQueueJob => ({
          taskId: TASK_ID,
          action: 'approve',
          attempt,
        }),
        readyKey: 'forge:approvals',
        retryKey: 'forge:approvals:retry',
      },
      {
        create: () => new AnswersQueue('redis://localhost:6379/0') as unknown as AtomicQueue,
        job: (attempt: number): AtomicQueueJob => ({ taskId: TASK_ID, attempt }),
        readyKey: 'forge:answers',
        retryKey: 'forge:answers:retry',
      },
    ]
    const skewedScenarios = [
      { delayMs: 0, loseResponse: false, workerSkewMs: 120_000 },
      { delayMs: 60_000, loseResponse: true, workerSkewMs: -120_000 },
    ] as const
    const dateNow = vi.spyOn(Date, 'now')

    for (const [caseIndex, queueCase] of queueCases.entries()) {
      for (const [scenarioIndex, scenario] of skewedScenarios.entries()) {
        redisHarness.hashes.clear()
        redisHarness.lists.clear()
        redisHarness.zsets.clear()
        redisHarness.nowMs = 1_800_000_000_000 + (caseIndex * 10_000) + scenarioIndex
        dateNow.mockReturnValue(redisHarness.nowMs + scenario.workerSkewMs)
        const queue = queueCase.create()
        const job = queueCase.job(10 + (caseIndex * 10) + scenarioIndex)
        redisHarness.claimPayloads.push(JSON.stringify(job))
        const claimed = await queue.claim(1)
        if (!claimed) throw new Error('Expected a retry clock fixture claim.')
        const [client] = redisHarness.instances.slice(-1)
        const expectedDeadline = redisHarness.nowMs + scenario.delayMs

        if (scenario.loseResponse) {
          redisHarness.failures.push({ marker: 'forge:queue:retry-v3', stage: 'after' })
          await expect(queue.retry(claimed.raw, claimed.job, scenario.delayMs))
            .rejects.toThrow('Queue transition failed')
        }
        const result = await queue.retry(claimed.raw, claimed.job, scenario.delayMs)
        expect(result).toEqual({
          nextRetryAt: new Date(expectedDeadline),
          outcome: scenario.loseResponse ? 'already_applied' : 'applied',
        })

        const scheduled = [...(redisHarness.zsets.get(queueCase.retryKey) ?? new Map())]
          .find(([raw]) => parsedOccurrence(raw).occurrenceId === claimed.occurrenceId)
        expect(scheduled?.[1]).toBe(expectedDeadline)
        expect(result.nextRetryAt.getTime()).toBe(scheduled?.[1])

        const retryCalls = client.call.mock.calls.filter((args) =>
          String(args[1]).includes('forge:queue:retry-v3'))
        expect(retryCalls.at(-1)?.[9]).toBe(String(scenario.delayMs))
        const rawReply = await client.call.mock.results.at(-1)?.value
        expect(rawReply).toEqual([
          scenario.loseResponse ? 2 : 1,
          String(expectedDeadline),
        ])

        if (scenario.delayMs === 60_000) {
          if (!scheduled) throw new Error('Expected the owned delayed retry member.')
          await expect(queue.promoteDueRetries()).resolves.toBe(0)
          expect(redisHarness.zsets.get(queueCase.retryKey)?.get(scheduled[0]))
            .toBe(expectedDeadline)

          redisHarness.nowMs = expectedDeadline
          await expect(queue.promoteDueRetries()).resolves.toBe(1)
          expect(redisHarness.zsets.get(queueCase.retryKey)?.has(scheduled[0]) ?? false)
            .toBe(false)
          expect(redisHarness.lists.get(queueCase.readyKey)?.filter(
            (raw) => raw === scheduled[0],
          )).toEqual([scheduled[0]])
        }
      }

      redisHarness.nowMs += 1
      dateNow.mockReturnValue(redisHarness.nowMs + 120_000)
      const staleOwner = queueCase.create()
      const staleJob = queueCase.job(40 + caseIndex)
      redisHarness.claimPayloads.push(JSON.stringify(staleJob))
      const staleClaim = await staleOwner.claim(1)
      if (!staleClaim) throw new Error('Expected a stale retry clock fixture claim.')
      const [staleClient] = redisHarness.instances.slice(-1)
      const laterOwner = queueCase.create()
      await expect(laterOwner.recoverStuckJobs(0)).resolves.toBe(1)
      await expect(staleOwner.retry(staleClaim.raw, staleClaim.job, 60_000))
        .rejects.toThrow('Queue transition stale_not_owner')
      const staleReply = await staleClient.call.mock.results.at(-1)?.value
      expect(staleReply).toEqual([0, ''])
    }

    redisHarness.nowMs = 1_800_000_000_000
    dateNow.mockReturnValue(redisHarness.nowMs - 120_000)
    const maxDateMs = 8_640_000_000_000_000
    const maxValidDelayMs = maxDateMs - redisHarness.nowMs
    const maxQueue = new TaskQueue('redis://localhost:6379/0')
    redisHarness.claimPayloads.push(JSON.stringify({ taskId: TASK_ID, attempt: 80 }))
    const maxClaim = await maxQueue.claim(1)
    if (!maxClaim) throw new Error('Expected a maximum retry delay fixture claim.')
    await expect(maxQueue.retry(maxClaim.raw, maxClaim.job, maxValidDelayMs)).resolves.toEqual({
      nextRetryAt: new Date(maxDateMs),
      outcome: 'applied',
    })

    const overflowQueue = new TaskQueue('redis://localhost:6379/0')
    redisHarness.claimPayloads.push(JSON.stringify({ taskId: TASK_ID, attempt: 81 }))
    const overflowClaim = await overflowQueue.claim(1)
    if (!overflowClaim) throw new Error('Expected an overflowing retry delay fixture claim.')
    await expect(overflowQueue.retry(
      overflowClaim.raw,
      overflowClaim.job,
      maxValidDelayMs + 1,
    )).rejects.toThrow('Queue transition failed')
    expect(redisHarness.lists.get('forge:tasks:processing')).toContain(overflowClaim.raw)
    expect(
      [...(redisHarness.zsets.get('forge:tasks:retry') ?? new Map()).keys()]
        .some((raw) => parsedOccurrence(raw).occurrenceId === overflowClaim.occurrenceId),
    ).toBe(false)

    for (const invalidDelay of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(maxQueue.retry('', { taskId: TASK_ID, attempt: 1 }, invalidDelay))
        .rejects.toThrow('Queue retry delay must be a non-negative safe integer')
    }

    const malformedResultQueue = new TaskQueue('redis://localhost:6379/0')
    redisHarness.claimPayloads.push(JSON.stringify({ taskId: TASK_ID, attempt: 82 }))
    const malformedResultClaim = await malformedResultQueue.claim(1)
    if (!malformedResultClaim) throw new Error('Expected a malformed retry result fixture claim.')
    const [malformedResultClient] = redisHarness.instances.slice(-1)
    const malformedResults = [
      null,
      [1],
      [3, String(redisHarness.nowMs)],
      [1, ''],
      [1, '01'],
      [1, '1e3'],
      [1, '1000.0'],
      [1, ' 1000'],
      [1, String(8_640_000_000_000_001)],
      [0, String(redisHarness.nowMs)],
    ]
    for (const malformedResult of malformedResults) {
      malformedResultClient.call.mockResolvedValueOnce(malformedResult)
      await expect(malformedResultQueue.retry(
        malformedResultClaim.raw,
        malformedResultClaim.job,
        0,
      )).rejects.toThrow('Queue retry transition returned an invalid result')
    }
  })

  it('fails retry closed on an exact live destination without disturbing neighboring state', async () => {
    const { AnswersQueue, ApprovalQueue, TaskQueue } = await import('@/worker/queue')
    const queueCases = [
      {
        claimsKey: 'forge:tasks:claims',
        create: () => new TaskQueue('redis://localhost:6379/0') as unknown as AtomicQueue,
        job: { taskId: TASK_ID, attempt: 7 } satisfies AtomicQueueJob,
        processingKey: 'forge:tasks:processing',
        retryKey: 'forge:tasks:retry',
      },
      {
        claimsKey: 'forge:approvals:claims',
        create: () => new ApprovalQueue('redis://localhost:6379/0') as unknown as AtomicQueue,
        job: { taskId: TASK_ID, action: 'approve', attempt: 7 } satisfies AtomicQueueJob,
        processingKey: 'forge:approvals:processing',
        retryKey: 'forge:approvals:retry',
      },
      {
        claimsKey: 'forge:answers:claims',
        create: () => new AnswersQueue('redis://localhost:6379/0') as unknown as AtomicQueue,
        job: { taskId: TASK_ID, attempt: 7 } satisfies AtomicQueueJob,
        processingKey: 'forge:answers:processing',
        retryKey: 'forge:answers:retry',
      },
    ]

    for (const [caseIndex, queueCase] of queueCases.entries()) {
      redisHarness.hashes.clear()
      redisHarness.lists.clear()
      redisHarness.zsets.clear()
      const queue = queueCase.create()
      redisHarness.claimPayloads.push(JSON.stringify(queueCase.job))
      const claimed = await queue.claim(1)
      if (!claimed) throw new Error('Expected a retry destination conflict fixture claim.')
      const marker = redisHarness.hashes.get(queueCase.claimsKey)?.get(claimed.occurrenceId)
      if (!marker) throw new Error('Expected a live retry destination conflict marker.')
      const retryEnvelope = JSON.stringify({
        schemaVersion: 1,
        occurrenceId: claimed.occurrenceId,
        job: { ...queueCase.job, attempt: queueCase.job.attempt + 1 },
      })
      const neighboringEnvelope = JSON.stringify({
        schemaVersion: 1,
        occurrenceId: `00000000-0000-4000-8000-${String(caseIndex + 1).padStart(12, '0')}`,
        job: { ...queueCase.job, attempt: queueCase.job.attempt + 20 },
      })
      const existingScore = redisHarness.nowMs + 60_000
      const neighboringScore = redisHarness.nowMs + 120_000
      redisHarness.zsets.set(queueCase.retryKey, new Map([
        [retryEnvelope, existingScore],
        [neighboringEnvelope, neighboringScore],
      ]))
      const [client] = redisHarness.instances.slice(-1)

      await expect(queue.retry(claimed.raw, claimed.job, 60_000))
        .rejects.toThrow('Queue transition stale_not_owner')
      expect(await client.call.mock.results.at(-1)?.value).toEqual([0, ''])
      expect(redisHarness.lists.get(queueCase.processingKey)).toEqual([claimed.raw])
      expect(redisHarness.hashes.get(queueCase.claimsKey)?.get(claimed.occurrenceId))
        .toBe(marker)
      expect(redisHarness.zsets.get(queueCase.retryKey)).toEqual(new Map([
        [retryEnvelope, existingScore],
        [neighboringEnvelope, neighboringScore],
      ]))

      redisHarness.zsets.get(queueCase.retryKey)?.delete(retryEnvelope)
      const applied = await queue.retry(claimed.raw, claimed.job, 60_000)
      const appliedScore = redisHarness.zsets.get(queueCase.retryKey)?.get(retryEnvelope)
      expect(applied).toEqual({
        nextRetryAt: new Date(redisHarness.nowMs + 60_000),
        outcome: 'applied',
      })
      expect(appliedScore).toBe(redisHarness.nowMs + 60_000)
      expect(redisHarness.zsets.get(queueCase.retryKey)?.get(neighboringEnvelope))
        .toBe(neighboringScore)
    }
  })

  it('rejects non-canonical identifiers and extra fields before claim storage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const invalidPayloads = [
      JSON.stringify({ taskId: 'task-1' }),
      JSON.stringify({ taskId: TASK_ID, attempt: -1 }),
      JSON.stringify({ taskId: TASK_ID, prompt: SENTINELS[0] }),
    ]

    const { TaskQueue } = await import('@/worker/queue')
    for (const raw of invalidPayloads) {
      redisHarness.claimPayloads.push(raw)
      const queue = new TaskQueue('redis://localhost:6379/0')
      await expect(queue.claim(1)).resolves.toBeNull()
    }

    for (const client of redisHarness.instances) {
      expect(client.hset).not.toHaveBeenCalled()
      expect(client.lpush).not.toHaveBeenCalled()
    }
    expect(warn).toHaveBeenCalledTimes(invalidPayloads.length)
    assertNoSentinels(serializedConsoleCalls(warn))
  })

  it('keeps valid work recoverable when claim marking fails for every queue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { AnswersQueue, ApprovalQueue, TaskQueue } = await import('@/worker/queue')
    const cases = [
      {
        create: () => new TaskQueue('redis://localhost:6379/0'),
        processing: 'forge:tasks:processing',
        raw: JSON.stringify({ taskId: TASK_ID, attempt: 1 }),
      },
      {
        create: () => new ApprovalQueue('redis://localhost:6379/0'),
        processing: 'forge:approvals:processing',
        raw: JSON.stringify({ taskId: TASK_ID, action: 'approve', attempt: 1 }),
      },
      {
        create: () => new AnswersQueue('redis://localhost:6379/0'),
        processing: 'forge:answers:processing',
        raw: JSON.stringify({ taskId: TASK_ID, attempt: 1 }),
      },
    ]

    for (const queueCase of cases) {
      redisHarness.claimPayloads.push(queueCase.raw)
      redisHarness.failures.push({ marker: 'forge:queue:claim-v2', stage: 'before' })
      const queue = queueCase.create()
      await expect(queue.claim(1)).rejects.toThrow('Queue claim transition failed')
      expect(redisHarness.lists.get(queueCase.processing)).toContain(queueCase.raw)
      expect(await queue.recoverStuckJobs(0)).toBe(1)
    }

    expect([...redisHarness.hashes.values()].every((entries) => entries.size === 0)).toBe(true)

    const responseLossRaw = JSON.stringify({ taskId: TASK_ID, attempt: 9 })
    redisHarness.claimPayloads.push(responseLossRaw)
    redisHarness.failures.push({ marker: 'forge:queue:claim-v2', stage: 'after' })
    const responseLossQueue = new TaskQueue('redis://localhost:6379/0')
    await expect(responseLossQueue.claim(1))
      .rejects.toThrow('Queue claim transition failed')
    const [lostEnvelope] = redisHarness.lists.get('forge:tasks:processing') ?? []
    const lostOccurrence = parsedOccurrence(lostEnvelope)
    expect(lostOccurrence.job).toEqual({ taskId: TASK_ID, attempt: 9 })
    expect(redisHarness.hashes.get('forge:tasks:claims')?.has(lostOccurrence.occurrenceId))
      .toBe(true)
    expect(await responseLossQueue.recoverStuckJobs(0)).toBe(1)

    const duplicateRaw = JSON.stringify({ taskId: TASK_ID, attempt: 10 })
    redisHarness.claimPayloads.push(duplicateRaw, duplicateRaw)
    const firstDuplicateQueue = new TaskQueue('redis://localhost:6379/0')
    const secondDuplicateQueue = new TaskQueue('redis://localhost:6379/0')
    const firstDuplicateClaim = await firstDuplicateQueue.claim(1)
    if (!firstDuplicateClaim) throw new Error('Expected the first duplicate fixture claim.')
    const secondDuplicateClaim = await secondDuplicateQueue.claim(1)
    if (!secondDuplicateClaim) throw new Error('Expected the second duplicate fixture claim.')
    expect(firstDuplicateClaim.occurrenceId).not.toBe(secondDuplicateClaim.occurrenceId)
    expect(firstDuplicateClaim.job).toEqual(secondDuplicateClaim.job)
    await expect(firstDuplicateQueue.ack(firstDuplicateClaim.raw)).resolves.toBe('applied')
    await expect(secondDuplicateQueue.ack(secondDuplicateClaim.raw)).resolves.toBe('applied')
    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([])
    expect(redisHarness.hashes.get('forge:tasks:claims')?.size ?? 0).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps malformed work recoverable when atomic discard fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const malformed = `{"taskId":"${TASK_ID}","taskId":"${SENTINELS[0]}"}`
    redisHarness.claimPayloads.push(malformed)
    redisHarness.failures.push({ marker: 'forge:queue:discard-invalid-v2', stage: 'before' })

    const { TaskQueue } = await import('@/worker/queue')
    const queue = new TaskQueue('redis://localhost:6379/0')
    await expect(queue.claim(1)).rejects.toThrow('Queue invalid-job discard failed')

    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([malformed])
    expect(redisHarness.hashes.get('forge:tasks:claims')?.size ?? 0).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('makes every source-to-destination transition atomic and lost-response idempotent', async () => {
    const { AnswersQueue, ApprovalQueue, TaskQueue } = await import('@/worker/queue')
    const cases = [
      {
        ackReceipts: 'forge:tasks:ack-receipts',
        claims: 'forge:tasks:claims',
        create: () => new TaskQueue('redis://localhost:6379/0'),
        dead: 'forge:tasks:dead',
        job: (attempt: number) => ({ taskId: TASK_ID, attempt }),
        processing: 'forge:tasks:processing',
        ready: 'forge:tasks',
        releaseReceipts: 'forge:tasks:release-receipts',
        retry: 'forge:tasks:retry',
      },
      {
        ackReceipts: 'forge:approvals:ack-receipts',
        claims: 'forge:approvals:claims',
        create: () => new ApprovalQueue('redis://localhost:6379/0'),
        dead: 'forge:approvals:dead',
        job: (attempt: number) => ({ taskId: TASK_ID, action: 'approve' as const, attempt }),
        processing: 'forge:approvals:processing',
        ready: 'forge:approvals',
        releaseReceipts: 'forge:approvals:release-receipts',
        retry: 'forge:approvals:retry',
      },
      {
        ackReceipts: 'forge:answers:ack-receipts',
        claims: 'forge:answers:claims',
        create: () => new AnswersQueue('redis://localhost:6379/0'),
        dead: 'forge:answers:dead',
        job: (attempt: number) => ({ taskId: TASK_ID, attempt }),
        processing: 'forge:answers:processing',
        ready: 'forge:answers',
        releaseReceipts: 'forge:answers:release-receipts',
        retry: 'forge:answers:retry',
      },
    ]

    for (const [caseIndex, queueCase] of cases.entries()) {
      const queue = queueCase.create() as unknown as AtomicQueue

      const ackRaw = JSON.stringify(queueCase.job(10 + caseIndex))
      redisHarness.claimPayloads.push(ackRaw)
      const ackClaim = await queue.claim(1)
      if (!ackClaim) throw new Error('Expected an acknowledgement fixture claim.')
      redisHarness.failures.push({ marker: 'forge:queue:ack-v3', stage: 'after' })
      await expect(queue.ack(ackClaim.raw)).rejects.toThrow('Queue transition failed')
      await expect(queue.ack(ackClaim.raw)).resolves.toBe('already_applied')
      expect(redisHarness.lists.get(queueCase.processing)).not.toContain(ackClaim.raw)
      expect(redisHarness.hashes.get(queueCase.claims)?.has(ackClaim.occurrenceId) ?? false)
        .toBe(false)
      expect([...(redisHarness.zsets.get(queueCase.ackReceipts)?.keys() ?? [])])
        .toEqual([
          expect.stringMatching(new RegExp(`^${ackClaim.occurrenceId}:[0-9a-f-]{36}$`)),
        ])

      const staleAckRaw = JSON.stringify(queueCase.job(15 + caseIndex))
      redisHarness.claimPayloads.push(staleAckRaw)
      const staleAckClaim = await queue.claim(1)
      if (!staleAckClaim) throw new Error('Expected a stale acknowledgement fixture claim.')
      const staleAckMarker = redisHarness.hashes.get(queueCase.claims)
        ?.get(staleAckClaim.occurrenceId)
      if (!staleAckMarker) throw new Error('Expected a stale acknowledgement marker.')
      redisHarness.nowMs += 2_000
      const recoveryQueue = queueCase.create() as unknown as AtomicQueue
      await expect(recoveryQueue.recoverStuckJobs(1_000)).resolves.toBe(1)
      await expect(queue.ack(staleAckClaim.raw))
        .rejects.toThrow('Queue transition stale_not_owner')
      expect(redisHarness.lists.get(queueCase.ready)).toContain(staleAckClaim.raw)
      const laterOwner = await recoveryQueue.claim(1)
      if (!laterOwner) throw new Error('Expected the later owner to reclaim the occurrence.')
      await expect(recoveryQueue.ack(laterOwner.raw)).resolves.toBe('applied')
      await expect(queue.ack(staleAckClaim.raw))
        .rejects.toThrow('Queue transition stale_not_owner')
      expect(redisHarness.zsets.get(queueCase.ackReceipts)?.has(
        `${staleAckClaim.occurrenceId}:${staleAckMarker.split(':')[1]}`,
      ) ?? false).toBe(false)

      const releaseRaw = JSON.stringify(queueCase.job(18 + caseIndex))
      redisHarness.claimPayloads.push(releaseRaw)
      const releaseClaim = await queue.claim(1)
      if (!releaseClaim) throw new Error('Expected a shutdown-release fixture claim.')
      redisHarness.failures.push({ marker: 'forge:queue:release-v1', stage: 'after' })
      await expect(queue.release(releaseClaim.raw)).rejects.toThrow('Queue transition failed')
      await expect(queue.release(releaseClaim.raw)).resolves.toBe('already_applied')
      expect(redisHarness.lists.get(queueCase.ready)?.filter(
        (raw) => raw === releaseClaim.raw,
      )).toHaveLength(1)
      expect(redisHarness.hashes.get(queueCase.claims)?.has(releaseClaim.occurrenceId) ?? false)
        .toBe(false)
      expect([...(redisHarness.zsets.get(queueCase.releaseReceipts)?.keys() ?? [])])
        .toEqual([
          expect.stringMatching(new RegExp(`^${releaseClaim.occurrenceId}:[0-9a-f-]{36}$`)),
        ])

      const retryRaw = JSON.stringify(queueCase.job(20 + caseIndex))
      redisHarness.claimPayloads.push(retryRaw)
      const retryClaim = await queue.claim(1)
      if (!retryClaim) throw new Error('Expected a retry fixture claim.')
      redisHarness.failures.push({ marker: 'forge:queue:retry-v3', stage: 'before' })
      await expect(queue.retry(retryClaim.raw, retryClaim.job, 0))
        .rejects.toThrow('Queue transition failed')
      expect(redisHarness.lists.get(queueCase.processing)).toContain(retryClaim.raw)
      expect(redisHarness.zsets.get(queueCase.retry)?.size ?? 0).toBe(0)

      redisHarness.failures.push({ marker: 'forge:queue:retry-v3', stage: 'after' })
      await expect(queue.retry(retryClaim.raw, retryClaim.job, 0))
        .rejects.toThrow('Queue transition failed')
      const retryState = new Map(redisHarness.zsets.get(queueCase.retry))
      await expect(queue.retry(retryClaim.raw, retryClaim.job, 0)).resolves.toMatchObject({
        nextRetryAt: expect.any(Date),
        outcome: 'already_applied',
      })
      expect(redisHarness.zsets.get(queueCase.retry)).toEqual(retryState)
      expect(retryState.size).toBe(1)
      expect(redisHarness.lists.get(queueCase.processing)).not.toContain(retryClaim.raw)

      redisHarness.failures.push({ marker: 'forge:queue:promote-retry-v4', stage: 'after' })
      await expect(queue.promoteDueRetries()).rejects.toThrow('Queue retry promotion failed')
      await expect(queue.promoteDueRetries()).resolves.toBe(0)
      const promotedRaw = [...retryState.keys()][0]
      expect(redisHarness.lists.get(queueCase.ready)?.filter((raw) => raw === promotedRaw))
        .toHaveLength(1)
      expect(redisHarness.zsets.get(queueCase.retry)?.size ?? 0).toBe(0)

      const deadRaw = JSON.stringify(queueCase.job(30 + caseIndex))
      redisHarness.claimPayloads.push(deadRaw)
      const deadClaim = await queue.claim(1)
      if (!deadClaim) throw new Error('Expected a dead-letter fixture claim.')
      redisHarness.failures.push({ marker: 'forge:queue:dead-letter-v2', stage: 'before' })
      await expect(queue.deadLetter(deadClaim.raw, deadClaim.job))
        .rejects.toThrow('Queue transition failed')
      expect(redisHarness.lists.get(queueCase.processing)).toContain(deadClaim.raw)
      expect(redisHarness.lists.get(queueCase.dead)?.length ?? 0).toBe(0)

      redisHarness.failures.push({ marker: 'forge:queue:dead-letter-v2', stage: 'after' })
      await expect(queue.deadLetter(deadClaim.raw, deadClaim.job))
        .rejects.toThrow('Queue transition failed')
      const committedDead = [...(redisHarness.lists.get(queueCase.dead) ?? [])]
      await expect(queue.deadLetter(deadClaim.raw, deadClaim.job))
        .resolves.toBe('already_applied')
      expect(redisHarness.lists.get(queueCase.dead)).toEqual(committedDead)
      expect(committedDead).toHaveLength(1)
      expect(redisHarness.lists.get(queueCase.processing)).not.toContain(deadClaim.raw)

      const recoveryRaw = JSON.stringify(queueCase.job(40 + caseIndex))
      redisHarness.claimPayloads.push(recoveryRaw)
      const recoveryClaim = await queue.claim(1)
      if (!recoveryClaim) throw new Error('Expected a recovery fixture claim.')
      redisHarness.nowMs += 2_000
      redisHarness.failures.push({ marker: 'forge:queue:recover-stuck-v2', stage: 'after' })
      await expect(queue.recoverStuckJobs(1_000))
        .rejects.toThrow('Queue recovery found an invalid claim marker')
      await expect(queue.recoverStuckJobs(1_000)).resolves.toBe(0)
      expect(redisHarness.lists.get(queueCase.ready)?.filter((raw) => raw === recoveryClaim.raw))
        .toHaveLength(1)
      expect(redisHarness.lists.get(queueCase.processing)).not.toContain(recoveryClaim.raw)
      expect(
        redisHarness.hashes.get(queueCase.claims)?.has(recoveryClaim.occurrenceId) ?? false,
      ).toBe(false)
    }
  })

  it('atomically upgrades legacy retries and discards poison without blocking later work', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { AnswersQueue, ApprovalQueue, TaskQueue } = await import('@/worker/queue')
    const oversized = `{"taskId":"${TASK_ID}","padding":"${'x'.repeat(1_000_000)}"}`
    const cases = [
      {
        create: () => new TaskQueue('redis://localhost:6379/0'),
        currentJob: { taskId: TASK_ID, attempt: 8 },
        legacyJob: { taskId: TASK_ID, attempt: 7 },
        poisons: [
          String.raw`{"taskId":"${TASK_ID}","task\u0049d":"${SENTINELS[0]}"}`,
          JSON.stringify({ taskId: TASK_ID, attempt: 1, prompt: SENTINELS[0] }),
        ],
        ready: 'forge:tasks',
        retry: 'forge:tasks:retry',
      },
      {
        create: () => new ApprovalQueue('redis://localhost:6379/0'),
        currentJob: { taskId: TASK_ID, action: 'approve' as const, attempt: 10 },
        legacyJob: { taskId: TASK_ID, action: 'approve' as const, attempt: 9 },
        poisons: [
          '{"taskId":',
          JSON.stringify({
            taskId: TASK_ID,
            action: 'reject',
            attempt: 1,
            output: SENTINELS[0],
          }),
        ],
        ready: 'forge:approvals',
        retry: 'forge:approvals:retry',
      },
      {
        create: () => new AnswersQueue('redis://localhost:6379/0'),
        currentJob: { taskId: TASK_ID, attempt: 12 },
        legacyJob: { taskId: TASK_ID, attempt: 11 },
        poisons: [
          oversized,
          JSON.stringify({ taskId: 'not-a-uuid', attempt: 1, token: SENTINELS[3] }),
        ],
        ready: 'forge:answers',
        retry: 'forge:answers:retry',
      },
    ]

    for (const [caseIndex, queueCase] of cases.entries()) {
      const queue = queueCase.create() as unknown as AtomicQueue
      const currentOccurrenceId = `00000000-0000-4000-8000-${String(700 + caseIndex)
        .padStart(12, '0')}`
      const current = JSON.stringify({
        schemaVersion: 1,
        occurrenceId: currentOccurrenceId,
        job: queueCase.currentJob,
      })
      const legacy = JSON.stringify(queueCase.legacyJob)
      const future = JSON.stringify({
        schemaVersion: 1,
        occurrenceId: `00000000-0000-4000-8000-${String(710 + caseIndex)
          .padStart(12, '0')}`,
        job: queueCase.currentJob,
      })
      redisHarness.zsets.set(queueCase.retry, new Map([
        [queueCase.poisons[0], redisHarness.nowMs - 5],
        [queueCase.poisons[1], redisHarness.nowMs - 4],
        [legacy, redisHarness.nowMs - 3],
        [current, redisHarness.nowMs - 2],
        [future, redisHarness.nowMs + 10_000],
      ]))

      const beforeFailure = new Map(redisHarness.zsets.get(queueCase.retry))
      redisHarness.failures.push({ marker: 'forge:queue:promote-retry-v4', stage: 'before' })
      await expect(queue.promoteDueRetries()).rejects.toThrow('Queue retry promotion failed')
      expect(redisHarness.zsets.get(queueCase.retry)).toEqual(beforeFailure)
      expect(redisHarness.lists.get(queueCase.ready)?.length ?? 0).toBe(0)

      await expect(queue.promoteDueRetries()).resolves.toBe(2)
      expect(redisHarness.zsets.get(queueCase.retry)).toEqual(new Map([
        [future, redisHarness.nowMs + 10_000],
      ]))
      const ready = redisHarness.lists.get(queueCase.ready) ?? []
      expect(ready).toHaveLength(2)
      const parsed = ready.map(parsedOccurrence)
      expect(parsed.map((entry) => entry.job)).toEqual(
        expect.arrayContaining([queueCase.currentJob, queueCase.legacyJob]),
      )
      expect(parsed.find((entry) => entry.occurrenceId === currentOccurrenceId)?.job)
        .toEqual(queueCase.currentJob)
      const legacyOccurrence = parsed.find((entry) => entry.occurrenceId !== currentOccurrenceId)
      expect(legacyOccurrence?.occurrenceId).toMatch(/^[0-9a-f-]{36}$/)
      expect(legacyOccurrence?.job).toEqual(queueCase.legacyJob)

      redisHarness.lists.set(queueCase.ready, [])
      redisHarness.zsets.set(queueCase.retry, new Map([
        [legacy, redisHarness.nowMs - 1],
      ]))
      redisHarness.failures.push({ marker: 'forge:queue:promote-retry-v4', stage: 'after' })
      await expect(queue.promoteDueRetries()).rejects.toThrow('Queue retry promotion failed')
      expect(redisHarness.zsets.get(queueCase.retry)?.size ?? 0).toBe(0)
      const responseLossReady = redisHarness.lists.get(queueCase.ready) ?? []
      expect(responseLossReady).toHaveLength(1)
      expect(parsedOccurrence(responseLossReady[0]).job).toEqual(queueCase.legacyJob)
      await expect(queue.promoteDueRetries()).resolves.toBe(0)
      expect(redisHarness.lists.get(queueCase.ready)).toEqual(responseLossReady)
    }

    expect(warn.mock.calls).toEqual(Array.from({ length: cases.length * 2 }, () => [
      '[worker/queue] Dropped invalid retry payload',
    ]))
    assertNoSentinels({
      lists: [...redisHarness.lists.values()],
      logs: warn.mock.calls,
      retry: [...redisHarness.zsets.values()].map((entries) => [...entries]),
    })
  })

  it('arbitrates concurrent current, legacy, and poison retry promotion by exact receipt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { AnswersQueue, ApprovalQueue, TaskQueue } = await import('@/worker/queue')
    const cases = [
      {
        create: () => new TaskQueue('redis://localhost:6379/0'),
        job: { taskId: TASK_ID, attempt: 3 },
        ready: 'forge:tasks',
        receipts: 'forge:tasks:promotion-dispositions',
        receiptExpiry: 'forge:tasks:promotion-disposition-expiry',
        retry: 'forge:tasks:retry',
      },
      {
        create: () => new ApprovalQueue('redis://localhost:6379/0'),
        job: { taskId: TASK_ID, action: 'approve' as const, attempt: 4 },
        ready: 'forge:approvals',
        receipts: 'forge:approvals:promotion-dispositions',
        receiptExpiry: 'forge:approvals:promotion-disposition-expiry',
        retry: 'forge:approvals:retry',
      },
      {
        create: () => new AnswersQueue('redis://localhost:6379/0'),
        job: { taskId: TASK_ID, attempt: 5 },
        ready: 'forge:answers',
        receipts: 'forge:answers:promotion-dispositions',
        receiptExpiry: 'forge:answers:promotion-disposition-expiry',
        retry: 'forge:answers:retry',
      },
    ]

    for (const [caseIndex, queueCase] of cases.entries()) {
      const currentOccurrenceId = `00000000-0000-4000-8000-${String(900 + caseIndex)
        .padStart(12, '0')}`
      const scenarios = [
        {
          kind: 'current',
          raw: JSON.stringify({
            schemaVersion: 1,
            occurrenceId: currentOccurrenceId,
            job: queueCase.job,
          }),
        },
        {
          kind: 'legacy',
          raw: JSON.stringify(queueCase.job),
        },
        {
          kind: 'poison',
          raw: JSON.stringify({
            ...queueCase.job,
            prompt: SENTINELS[0],
          }),
        },
      ] as const

      for (const [scenarioIndex, scenario] of scenarios.entries()) {
        redisHarness.hashes.delete(queueCase.receipts)
        redisHarness.lists.set(queueCase.ready, [])
        redisHarness.zsets.delete(queueCase.receiptExpiry)
        redisHarness.zsets.set(queueCase.retry, new Map([
          [scenario.raw, redisHarness.nowMs - 10 - scenarioIndex],
        ]))

        const first = queueCase.create() as unknown as AtomicQueue
        const firstClient = redisHarness.instances.at(-1)
        const second = queueCase.create() as unknown as AtomicQueue
        const secondClient = redisHarness.instances.at(-1)
        if (!firstClient || !secondClient) {
          throw new Error('Concurrent retry proof did not construct both clients.')
        }

        let scans = 0
        let releaseScan!: () => void
        const scanBarrier = new Promise<void>((resolve) => {
          releaseScan = resolve
        })
        for (const client of [firstClient, secondClient]) {
          const original = client.callBuffer.getMockImplementation()
          if (!original) throw new Error('Concurrent retry proof has no buffer-call adapter.')
          client.callBuffer.mockImplementation(async (...args: unknown[]) => {
            const result = await (original as (...values: unknown[]) => unknown)(...args)
            if (String(args[1]).includes('forge:queue:list-due-retries-v1')) {
              scans += 1
              if (scans === 2) releaseScan()
              await scanBarrier
            }
            return result
          })
        }

        const results = await Promise.all([
          first.promoteDueRetries(),
          second.promoteDueRetries(),
        ])
        expect([...results].sort()).toEqual(scenario.kind === 'poison' ? [0, 0] : [0, 1])
        expect(redisHarness.zsets.get(queueCase.retry)?.size ?? 0).toBe(0)
        const ready = redisHarness.lists.get(queueCase.ready) ?? []
        expect(ready).toHaveLength(scenario.kind === 'poison' ? 0 : 1)
        const receiptEntries = redisHarness.hashes.get(queueCase.receipts)
        expect(receiptEntries?.size ?? 0).toBe(1)
        expect(redisHarness.zsets.get(queueCase.receiptExpiry)?.size ?? 0).toBe(1)

        const promotions = [firstClient, secondClient].map((client) => {
          const callIndex = client.call.mock.calls.findIndex((args) =>
            String(args[1]).includes('forge:queue:promote-retry-v4'))
          if (callIndex < 0) throw new Error('Concurrent retry proof did not execute promotion.')
          return {
            args: client.call.mock.calls[callIndex],
            result: client.call.mock.results[callIndex].value as Promise<unknown>,
          }
        })
        expect(String(promotions[0].args[9])).toBe(String(promotions[1].args[9]))
        expect(String(promotions[0].args[8])).toBe(String(promotions[1].args[8]))
        const rawOutcomes = await Promise.all(promotions.map(({ result }) => result))
        expect(rawOutcomes.map((raw) => Number((raw as unknown[])[0])).sort()).toEqual([1, 2])
        if (scenario.kind === 'legacy') {
          expect(String(promotions[0].args[12])).not.toBe(String(promotions[1].args[12]))
          const winningOccurrenceId = parsedOccurrence(ready[0]).occurrenceId
          expect([...receiptEntries!.values()]).toEqual([`promoted:${winningOccurrenceId}`])
        } else if (scenario.kind === 'current') {
          expect(parsedOccurrence(ready[0]).occurrenceId).toBe(currentOccurrenceId)
          expect([...receiptEntries!.values()]).toEqual([`promoted:${currentOccurrenceId}`])
        } else {
          expect([...receiptEntries!.values()]).toEqual(['discarded'])
        }
      }
    }

    expect(warn).toHaveBeenCalledTimes(cases.length)
    assertNoSentinels({
      logs: warn.mock.calls,
      receipts: [...redisHarness.hashes.values()].map((entries) => [...entries]),
    })
  })

  it('requires a coherent live disposition pair for source-absent retry replay', async () => {
    const {
      RETRY_PROMOTION_CONFLICT_CODE,
      RetryPromotionConflictError,
      TaskQueue,
    } = await import('@/worker/queue')
    const retryKey = 'forge:tasks:retry'
    const readyKey = 'forge:tasks'
    const receiptsKey = 'forge:tasks:promotion-dispositions'
    const expiryKey = 'forge:tasks:promotion-disposition-expiry'
    const ttlMs = 15 * 60 * 1000
    const winningOccurrenceId = '00000000-0000-4000-8000-000000001100'

    const exercise = async (options: {
      attempt: number
      expectOwnershipConflict?: boolean
      expectReplay?: boolean
      sourcePresent?: boolean
      setup: (fingerprint: string) => void
      verify?: (fingerprint: string) => void
    }): Promise<void> => {
      redisHarness.hashes.delete(receiptsKey)
      redisHarness.lists.set(readyKey, [])
      redisHarness.zsets.delete(expiryKey)
      redisHarness.zsets.delete(retryKey)
      const raw = JSON.stringify({ taskId: TASK_ID, attempt: options.attempt })
      const score = String(redisHarness.nowMs - 1)
      if (options.sourcePresent) {
        redisHarness.zsets.set(retryKey, new Map([[raw, Number(score)]]))
      }
      const queue = new TaskQueue('redis://localhost:6379/0') as unknown as AtomicQueue
      const client = redisHarness.instances.at(-1)
      if (!client) throw new Error('Receipt authority proof did not construct a client.')
      if (!options.sourcePresent) {
        const originalBuffer = client.callBuffer.getMockImplementation()
        if (!originalBuffer) throw new Error('Receipt authority proof has no scan adapter.')
        client.callBuffer.mockImplementation(async (...args: unknown[]) => {
          if (String(args[1]).includes('forge:queue:list-due-retries-v1')) {
            return [Buffer.from(raw), Buffer.from(score)]
          }
          return await (originalBuffer as (...values: unknown[]) => unknown)(...args)
        })
      }
      const originalCall = client.call.getMockImplementation()
      if (!originalCall) throw new Error('Receipt authority proof has no command adapter.')
      let fingerprint = ''
      client.call.mockImplementation(async (...args: unknown[]) => {
        if (String(args[1]).includes('forge:queue:promote-retry-v4')) {
          fingerprint = String(args[9])
          options.setup(fingerprint)
        }
        return await (originalCall as (...values: unknown[]) => unknown)(...args)
      })

      if (options.expectReplay) {
        await expect(queue.promoteDueRetries(1)).resolves.toBe(0)
      } else if (options.expectOwnershipConflict) {
        let caught: unknown
        try {
          await queue.promoteDueRetries(1)
        } catch (error) {
          caught = error
        }
        expect(caught instanceof RetryPromotionConflictError).toBe(true)
        if (!(caught instanceof RetryPromotionConflictError)) {
          throw new Error('Retry promotion did not return the closed conflict type.')
        }
        expect(caught.code).toBe(RETRY_PROMOTION_CONFLICT_CODE)
        expect(caught.message).toBe('Queue retry promotion conflict')
        expect(Object.keys(caught)).toEqual([])
      } else {
        await expect(queue.promoteDueRetries(1))
          .rejects.toThrow('Queue retry promotion receipt integrity failure')
      }
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
      options.verify?.(fingerprint)
    }

    await exercise({
      attempt: 20,
      expectOwnershipConflict: true,
      setup: () => {},
    })

    await exercise({
      attempt: 21,
      expectReplay: true,
      setup: (fingerprint) => {
        redisHarness.hashes.set(receiptsKey, new Map([
          [fingerprint, `promoted:${winningOccurrenceId}`],
        ]))
        redisHarness.zsets.set(expiryKey, new Map([
          [fingerprint, redisHarness.nowMs - ttlMs + 1],
        ]))
      },
      verify: (fingerprint) => {
        expect(redisHarness.hashes.get(receiptsKey)?.get(fingerprint))
          .toBe(`promoted:${winningOccurrenceId}`)
        expect(redisHarness.zsets.get(expiryKey)?.get(fingerprint))
          .toBe(redisHarness.nowMs - ttlMs + 1)
      },
    })

    const liveNeighbor = 'd'.repeat(64)
    await exercise({
      attempt: 22,
      setup: (fingerprint) => {
        const dispositions = new Map<string, string>()
        const expiry = new Map<string, number>()
        for (let index = 0; index < 100; index += 1) {
          const older = index.toString(16).padStart(64, '0')
          dispositions.set(older, 'discarded')
          expiry.set(older, redisHarness.nowMs - ttlMs - 200 - index)
        }
        dispositions.set(fingerprint, `promoted:${winningOccurrenceId}`)
        expiry.set(fingerprint, redisHarness.nowMs - ttlMs - 1)
        dispositions.set(liveNeighbor, 'discarded')
        expiry.set(liveNeighbor, redisHarness.nowMs - 1)
        redisHarness.hashes.set(receiptsKey, dispositions)
        redisHarness.zsets.set(expiryKey, expiry)
      },
      verify: (fingerprint) => {
        expect(redisHarness.hashes.get(receiptsKey)?.has(fingerprint) ?? false).toBe(false)
        expect(redisHarness.zsets.get(expiryKey)?.has(fingerprint) ?? false).toBe(false)
        expect(redisHarness.hashes.get(receiptsKey)?.get(liveNeighbor)).toBe('discarded')
        expect(redisHarness.zsets.get(expiryKey)?.get(liveNeighbor))
          .toBe(redisHarness.nowMs - 1)
      },
    })

    const incoherentCases = [
      {
        attempt: 23,
        setup: (fingerprint: string) => {
          redisHarness.hashes.set(receiptsKey, new Map([
            [fingerprint, `promoted:${winningOccurrenceId}`],
          ]))
        },
      },
      {
        attempt: 24,
        setup: (fingerprint: string) => {
          redisHarness.zsets.set(expiryKey, new Map([[fingerprint, redisHarness.nowMs - 1]]))
        },
      },
      {
        attempt: 25,
        setup: (fingerprint: string) => {
          redisHarness.hashes.set(receiptsKey, new Map([[fingerprint, 'unknown']]))
          redisHarness.zsets.set(expiryKey, new Map([[fingerprint, redisHarness.nowMs - 1]]))
        },
      },
      {
        attempt: 26,
        setup: (fingerprint: string) => {
          redisHarness.hashes.set(receiptsKey, new Map([[fingerprint, 'promoted:not-a-uuid']]))
          redisHarness.zsets.set(expiryKey, new Map([[fingerprint, redisHarness.nowMs - 1]]))
        },
      },
      {
        attempt: 27,
        setup: (fingerprint: string) => {
          redisHarness.hashes.set(receiptsKey, new Map([[fingerprint, 'discarded']]))
          redisHarness.zsets.set(expiryKey, new Map([[fingerprint, redisHarness.nowMs + 1]]))
        },
      },
      {
        attempt: 28,
        setup: (fingerprint: string) => {
          redisHarness.hashes.set(receiptsKey, new Map([[fingerprint, 'discarded']]))
          redisHarness.zsets.set(expiryKey, new Map([[fingerprint, Number.POSITIVE_INFINITY]]))
        },
      },
      {
        attempt: 29,
        setup: (fingerprint: string) => {
          redisHarness.hashes.set(receiptsKey, new Map([[fingerprint, 'discarded']]))
          redisHarness.zsets.set(expiryKey, new Map([[fingerprint, Number.NaN]]))
        },
      },
    ]
    for (const receiptCase of incoherentCases) {
      await exercise({
        ...receiptCase,
        verify: (fingerprint) => {
          expect(redisHarness.hashes.get(receiptsKey)?.has(fingerprint) ?? false).toBe(false)
          expect(redisHarness.zsets.get(expiryKey)?.has(fingerprint) ?? false).toBe(false)
        },
      })
    }

    await exercise({
      attempt: 30,
      sourcePresent: true,
      setup: (fingerprint) => {
        redisHarness.hashes.set(receiptsKey, new Map([
          [fingerprint, `promoted:${winningOccurrenceId}`],
        ]))
        redisHarness.zsets.set(expiryKey, new Map([
          [fingerprint, redisHarness.nowMs - 1],
        ]))
      },
      verify: (fingerprint) => {
        expect(redisHarness.zsets.get(retryKey)?.size ?? 0).toBe(1)
        expect(redisHarness.hashes.get(receiptsKey)?.get(fingerprint))
          .toBe(`promoted:${winningOccurrenceId}`)
        expect(redisHarness.zsets.get(expiryKey)?.get(fingerprint))
          .toBe(redisHarness.nowMs - 1)
      },
    })
  })

  it('keeps identical occurrences distinct through retry, promotion, recovery, and dead letter', async () => {
    const { TaskQueue } = await import('@/worker/queue')
    const legacy = JSON.stringify({ taskId: TASK_ID, attempt: 1 })
    const retryQueue = new TaskQueue('redis://localhost:6379/0')
    redisHarness.claimPayloads.push(legacy, legacy)
    const retryFirst = await retryQueue.claim(1)
    const retrySecond = await retryQueue.claim(1)
    if (!retryFirst || !retrySecond) {
      throw new Error('Expected both identical retry occurrences.')
    }
    const retryClaims = [retryFirst, retrySecond]
    expect(retryFirst.occurrenceId).not.toBe(retrySecond.occurrenceId)
    await retryQueue.retry(retryFirst.raw, retryFirst.job, 0)
    await retryQueue.retry(retrySecond.raw, retrySecond.job, 0)
    expect(redisHarness.zsets.get('forge:tasks:retry')?.size).toBe(2)
    expect(await retryQueue.promoteDueRetries()).toBe(2)
    expect(redisHarness.lists.get('forge:tasks')).toHaveLength(2)
    expect(new Set(
      (redisHarness.lists.get('forge:tasks') ?? []).map((raw) => parsedOccurrence(raw).occurrenceId),
    )).toEqual(new Set(retryClaims.map((claim) => claim.occurrenceId)))

    redisHarness.lists.set('forge:tasks', [])
    redisHarness.claimPayloads.push(legacy, legacy)
    const recoveryFirst = await retryQueue.claim(1)
    const recoverySecond = await retryQueue.claim(1)
    if (!recoveryFirst || !recoverySecond) {
      throw new Error('Expected both identical recovery occurrences.')
    }
    const recoveryClaims = [recoveryFirst, recoverySecond]
    redisHarness.nowMs += 2_000
    expect(await retryQueue.recoverStuckJobs(1_000, { drain: true })).toBe(2)
    expect(redisHarness.lists.get('forge:tasks')).toHaveLength(2)
    expect(new Set(
      (redisHarness.lists.get('forge:tasks') ?? []).map((raw) => parsedOccurrence(raw).occurrenceId),
    )).toEqual(new Set(recoveryClaims.map((claim) => claim.occurrenceId)))

    redisHarness.lists.set('forge:tasks', [])
    redisHarness.claimPayloads.push(legacy, legacy)
    const deadFirst = await retryQueue.claim(1)
    const deadSecond = await retryQueue.claim(1)
    if (!deadFirst || !deadSecond) {
      throw new Error('Expected both identical dead-letter occurrences.')
    }
    const deadClaims = [deadFirst, deadSecond]
    await retryQueue.deadLetter(deadFirst.raw, deadFirst.job)
    await retryQueue.deadLetter(deadSecond.raw, deadSecond.job)
    const dead = (redisHarness.lists.get('forge:tasks:dead') ?? [])
      .map((raw) => JSON.parse(raw) as { occurrenceId: string })
    expect(dead).toHaveLength(2)
    expect(new Set(dead.map((record) => record.occurrenceId)))
      .toEqual(new Set(deadClaims.map((claim) => claim.occurrenceId)))
  })

  it('rotates bounded recovery pages and rejects stale ownership and malformed markers', async () => {
    const { TaskQueue } = await import('@/worker/queue')
    const queue = new TaskQueue('redis://localhost:6379/0')
    const processing = redisHarness.lists.get('forge:tasks:processing') ?? []
    redisHarness.lists.set('forge:tasks:processing', processing)
    const claims = redisHarness.hashes.get('forge:tasks:claims') ?? new Map<string, string>()
    redisHarness.hashes.set('forge:tasks:claims', claims)
    const envelope = (index: number): string => JSON.stringify({
      schemaVersion: 1,
      occurrenceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      job: { taskId: TASK_ID, attempt: 1 },
    })

    const legacyProcessing = JSON.stringify({ taskId: TASK_ID, attempt: 1 })
    processing.push(legacyProcessing)
    claims.set(
      legacyProcessing,
      `${redisHarness.nowMs}:11111111-1111-4111-8111-111111111111`,
    )
    expect(await queue.recoverStuckJobs(1_000)).toBe(0)
    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([legacyProcessing])
    redisHarness.nowMs += 2_000
    expect(await queue.recoverStuckJobs(1_000)).toBe(1)
    expect(redisHarness.hashes.get('forge:tasks:claims')?.has(legacyProcessing)).toBe(false)
    expect(parsedOccurrence((redisHarness.lists.get('forge:tasks') ?? [])[0]).job)
      .toEqual({ taskId: TASK_ID, attempt: 1 })
    redisHarness.lists.set('forge:tasks', [])

    for (let index = 1; index <= 150; index += 1) {
      const raw = envelope(index)
      processing.push(raw)
      claims.set(parsedOccurrence(raw).occurrenceId, `${redisHarness.nowMs - 2_000}:11111111-1111-4111-8111-111111111111`)
    }
    expect(await queue.recoverStuckJobs(1_000, { drain: true })).toBe(150)
    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([])
    expect(redisHarness.lists.get('forge:tasks')).toHaveLength(150)

    redisHarness.lists.set('forge:tasks', [])
    for (let index = 1; index <= 101; index += 1) {
      const raw = envelope(index)
      processing.push(raw)
      claims.set(
        parsedOccurrence(raw).occurrenceId,
        `${index <= 100 ? redisHarness.nowMs : redisHarness.nowMs - 2_000}:11111111-1111-4111-8111-111111111111`,
      )
    }
    expect(await queue.recoverStuckJobs(1_000)).toBe(0)
    expect(await queue.recoverStuckJobs(1_000)).toBe(1)
    expect(redisHarness.lists.get('forge:tasks')).toEqual([envelope(101)])
    expect(redisHarness.lists.get('forge:tasks:processing')).toHaveLength(100)

    redisHarness.lists.set('forge:tasks:processing', [])
    redisHarness.hashes.set('forge:tasks:claims', new Map())
    redisHarness.claimPayloads.push(JSON.stringify({ taskId: TASK_ID, attempt: 1 }))
    const owned = await queue.claim(1)
    if (!owned) throw new Error('Expected ownership fixture claim.')
    const ownedClaims = redisHarness.hashes.get('forge:tasks:claims')
    const originalMarker = ownedClaims?.get(owned.occurrenceId)
    if (!originalMarker) throw new Error('Expected ownership fixture marker.')
    ownedClaims?.set(
      owned.occurrenceId,
      `${redisHarness.nowMs}:22222222-2222-4222-8222-222222222222`,
    )
    await expect(queue.ack(owned.raw)).rejects.toThrow('Queue transition stale_not_owner')
    expect(redisHarness.lists.get('forge:tasks:processing')).toContain(owned.raw)
    ownedClaims?.set(owned.occurrenceId, originalMarker)
    await expect(queue.ack(owned.raw)).resolves.toBe('applied')

    const malformedMarkers = [
      '0:11111111-1111-4111-8111-111111111111',
      '9007199254740992:11111111-1111-4111-8111-111111111111',
      `${redisHarness.nowMs + 1}:11111111-1111-4111-8111-111111111111`,
      `${redisHarness.nowMs}:not-a-uuid`,
      `${redisHarness.nowMs}:11111111-1111-4111-8111-111111111111:extra`,
    ]
    for (const [index, marker] of malformedMarkers.entries()) {
      const raw = envelope(500 + index)
      const occurrenceId = parsedOccurrence(raw).occurrenceId
      redisHarness.lists.set('forge:tasks:processing', [raw])
      redisHarness.hashes.set('forge:tasks:claims', new Map([[occurrenceId, marker]]))
      await expect(queue.recoverStuckJobs(0))
        .rejects.toThrow('Queue recovery found an invalid claim marker')
      expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([raw])
      expect(redisHarness.hashes.get('forge:tasks:claims')?.get(occurrenceId)).toBe(marker)
    }
  })

  it('contains only typed mixed-version promotion conflicts and keeps other failures fatal', async () => {
    const workerEnvNames = [
      'FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS',
      'FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS',
      'FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS',
    ] as const
    const workerEnv = Object.fromEntries(workerEnvNames.map((name) => [name, process.env[name]]))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})

    const installSupportMocks = (): void => {
      const query = () => {
        const chain: Record<string, unknown> = {
          then: (
            resolve: (value: unknown[]) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => Promise.resolve([]).then(resolve, reject),
        }
        for (const method of ['from', 'innerJoin', 'where', 'limit']) chain[method] = () => chain
        return chain
      }
      vi.doMock('@/worker/orchestrator', () => ({
        processAnsweredQuestions: vi.fn(),
        processApproval: vi.fn(),
        processTask: vi.fn(),
      }))
      vi.doMock('@/worker/task-attempts', () => ({
        finishTaskAttempt: vi.fn(),
        startTaskAttempt: vi.fn(),
      }))
      vi.doMock('@/db', () => ({ db: { select: vi.fn(query) } }))
      vi.doMock('@/db/schema', () => ({
        tasks: { id: 'tasks.id', status: 'tasks.status' },
        workPackages: {
          metadata: 'work_packages.metadata',
          status: 'work_packages.status',
          taskId: 'work_packages.task_id',
        },
      }))
      vi.doMock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }))
      vi.doMock('@/worker/blocked-handoff-retry', () => ({
        enqueueDueBlockedHandoffRetries: vi.fn().mockResolvedValue(0),
      }))
      vi.doMock('@/lib/mcps/filesystem-grant-reconciliation', () => ({
        convergeRecognizedOperatorHolds: vi.fn().mockResolvedValue(0),
      }))
      vi.doMock('@/worker/work-package-handoff', () => ({
        reconcilePendingS4CompletionHandoffs: vi.fn().mockResolvedValue(0),
      }))
      vi.doMock('@/lib/session', () => ({
        reconcilePendingSessionCacheInvalidations: vi.fn().mockResolvedValue({
          claimed: 0,
          completed: 0,
          deferred: 0,
          stale: 0,
        }),
      }))
    }

    process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = '0'
    process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = '0'
    process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = '0'

    try {
      for (const conflictPosition of ['approvals', 'answers', 'tasks'] as const) {
        vi.resetModules()
        delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown })
          .forgeWorkerRuntime
        warn.mockClear()
        errorLog.mockClear()
        const claims = {
          answers: vi.fn().mockResolvedValue(null),
          approvals: vi.fn().mockResolvedValue(null),
          tasks: vi.fn(async () => await new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), 1)
          })),
        }

        const queueClass = (queueName: keyof typeof claims) => class {
          ack = vi.fn()
          claim = claims[queueName]
          deadLetter = vi.fn()
          disconnect = vi.fn()
          promoteDueRetries = queueName === conflictPosition
            ? vi.fn()
                .mockRejectedValueOnce(new TestRetryPromotionConflictError())
                .mockResolvedValue(0)
            : vi.fn().mockResolvedValue(0)
          recoverStuckJobs = vi.fn().mockResolvedValue(0)
          release = vi.fn()
          retry = vi.fn()
        }

        vi.doMock('@/worker/queue', () => ({
          AnswersQueue: queueClass('answers'),
          ApprovalQueue: queueClass('approvals'),
          RetryPromotionConflictError: TestRetryPromotionConflictError,
          TaskQueue: queueClass('tasks'),
        }))
        installSupportMocks()

        const { startWorker } = await import('@/worker/runtime')
        const handle = await startWorker('standalone')
        await vi.waitFor(() => {
          expect(warn).toHaveBeenCalledWith(
            '[worker] Retry promotion compatibility conflict',
            {
              category: 'mixed_version_retry_promotion',
              queue: conflictPosition,
            },
          )
          expect(claims.approvals).toHaveBeenCalled()
          expect(claims.answers).toHaveBeenCalled()
          expect(claims.tasks).toHaveBeenCalled()
        })
        await handle.stop()
        await expect(handle.done).resolves.toBeUndefined()
        assertNoSentinels(warn.mock.calls)
      }

      for (const fatalFailure of [
        new Error('redis_infrastructure_failure'),
        new Error('retry_receipt_integrity_failure'),
        new TypeError('retry_result_decode_failure'),
      ]) {
        vi.resetModules()
        delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown })
          .forgeWorkerRuntime
        errorLog.mockClear()

        class FatalPromotionQueue {
          ack = vi.fn()
          claim = vi.fn().mockResolvedValue(null)
          deadLetter = vi.fn()
          disconnect = vi.fn()
          promoteDueRetries = vi.fn().mockRejectedValue(fatalFailure)
          recoverStuckJobs = vi.fn().mockResolvedValue(0)
          release = vi.fn()
          retry = vi.fn()
        }

        vi.doMock('@/worker/queue', () => ({
          AnswersQueue: FatalPromotionQueue,
          ApprovalQueue: FatalPromotionQueue,
          RetryPromotionConflictError: TestRetryPromotionConflictError,
          TaskQueue: FatalPromotionQueue,
        }))
        installSupportMocks()

        const { startWorker } = await import('@/worker/runtime')
        const handle = await startWorker('standalone')
        await expect(handle.done).rejects.toBe(fatalFailure)
        expect(errorLog).toHaveBeenCalledWith(
          '[worker] Fatal error',
          expect.objectContaining({ workerId: expect.any(String) }),
        )
        await handle.stop()
      }
    } finally {
      for (const name of workerEnvNames) {
        const value = workerEnv[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('persists only the queue-authoritative retry deadline after worker failure', async () => {
    const workerEnvNames = [
      'FORGE_WORKER_MAX_ATTEMPTS',
      'FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS',
      'FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS',
      'FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS',
    ] as const
    const workerEnv = Object.fromEntries(workerEnvNames.map((name) => [name, process.env[name]]))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_120_000)
    const queueDeadlines = {
      answers: new Date(1_800_000_060_122),
      approvals: new Date(1_800_000_060_121),
      tasks: new Date(1_800_000_060_123),
    }
    const approvalRetry = vi.fn().mockResolvedValue({
      nextRetryAt: queueDeadlines.approvals,
      outcome: 'applied',
    })
    const answersRetry = vi.fn().mockResolvedValue({
      nextRetryAt: queueDeadlines.answers,
      outcome: 'applied',
    })
    const taskRetry = vi.fn()
      .mockResolvedValueOnce({ nextRetryAt: queueDeadlines.tasks, outcome: 'applied' })
      .mockRejectedValueOnce(new Error('redis_retry_unavailable'))
    const finishTaskAttempt = vi.fn().mockResolvedValue(undefined)
    const attemptCounts = { answers: 0, approvals: 0, tasks: 0 }
    const startTaskAttempt = vi.fn(async (input: {
      queueName: keyof typeof attemptCounts
    }) => {
      attemptCounts[input.queueName] += 1
      return `${input.queueName}-retry-clock-${attemptCounts[input.queueName]}`
    })
    let approvalClaimCount = 0
    let answersClaimCount = 0
    let taskClaimCount = 0

    class PassiveQueue {
      ack = vi.fn().mockResolvedValue('applied')
      claim = vi.fn().mockResolvedValue(null)
      deadLetter = vi.fn().mockResolvedValue('applied')
      disconnect = vi.fn()
      promoteDueRetries = vi.fn().mockResolvedValue(0)
      recoverStuckJobs = vi.fn().mockResolvedValue(0)
      release = vi.fn().mockResolvedValue('applied')
      retry = vi.fn()
    }

    class RuntimeApprovalQueue extends PassiveQueue {
      override retry = approvalRetry
      override claim = vi.fn(async () => {
        approvalClaimCount += 1
        if (approvalClaimCount > 1) return null
        const job = { taskId: TASK_ID, action: 'approve' as const, attempt: 1 }
        return { job, raw: JSON.stringify(job) }
      })
    }

    class RuntimeAnswersQueue extends PassiveQueue {
      override retry = answersRetry
      override claim = vi.fn(async () => {
        answersClaimCount += 1
        if (answersClaimCount > 1) return null
        const job = { taskId: TASK_ID, attempt: 1 }
        return { job, raw: JSON.stringify(job) }
      })
    }

    class RuntimeTaskQueue extends PassiveQueue {
      override retry = taskRetry
      override claim = vi.fn(async () => {
        taskClaimCount += 1
        if (taskClaimCount <= 2) {
          const job = { taskId: TASK_ID, attempt: 1 }
          return { job, raw: JSON.stringify(job) }
        }
        return await new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 10)
        })
      })
    }

    const query = (rows: unknown[]) => {
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      }
      for (const method of ['from', 'innerJoin', 'where', 'limit']) chain[method] = () => chain
      return chain
    }

    vi.resetModules()
    delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime
    vi.doMock('@/worker/queue', () => ({
      AnswersQueue: RuntimeAnswersQueue,
      ApprovalQueue: RuntimeApprovalQueue,
      RetryPromotionConflictError: TestRetryPromotionConflictError,
      TaskQueue: RuntimeTaskQueue,
    }))
    vi.doMock('@/worker/orchestrator', () => ({
      processAnsweredQuestions: vi.fn().mockRejectedValue(new Error('business_failure')),
      processApproval: vi.fn().mockRejectedValue(new Error('business_failure')),
      processTask: vi.fn().mockRejectedValue(new Error('business_failure')),
    }))
    vi.doMock('@/worker/task-attempts', () => ({ finishTaskAttempt, startTaskAttempt }))
    vi.doMock('@/db', () => ({
      db: { select: vi.fn(() => query([{ id: TASK_ID }])) },
    }))
    vi.doMock('@/db/schema', () => ({
      tasks: { id: 'tasks.id', status: 'tasks.status' },
      workPackages: {
        metadata: 'work_packages.metadata',
        status: 'work_packages.status',
        taskId: 'work_packages.task_id',
      },
    }))
    vi.doMock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }))
    vi.doMock('@/worker/blocked-handoff-retry', () => ({
      enqueueDueBlockedHandoffRetries: vi.fn().mockResolvedValue(0),
    }))
    vi.doMock('@/lib/mcps/filesystem-grant-reconciliation', () => ({
      convergeRecognizedOperatorHolds: vi.fn().mockResolvedValue(0),
    }))
    vi.doMock('@/worker/work-package-handoff', () => ({
      reconcilePendingS4CompletionHandoffs: vi.fn().mockResolvedValue(0),
    }))
    vi.doMock('@/lib/session', () => ({
      reconcilePendingSessionCacheInvalidations: vi.fn().mockResolvedValue({
        claimed: 0,
        completed: 0,
        deferred: 0,
        stale: 0,
      }),
    }))

    process.env.FORGE_WORKER_MAX_ATTEMPTS = '3'
    process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = '0'
    process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = '0'
    process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = '0'

    try {
      const { startWorker } = await import('@/worker/runtime')
      const handle = await startWorker('standalone')
      await vi.waitFor(() => {
        expect(finishTaskAttempt).toHaveBeenCalledTimes(4)
      })
      await handle.stop()

      expect(approvalRetry).toHaveBeenCalledOnce()
      expect(answersRetry).toHaveBeenCalledOnce()
      expect(taskRetry).toHaveBeenCalledTimes(2)
      expect(finishTaskAttempt.mock.calls).toEqual([
        [{
          attemptId: 'approvals-retry-clock-1',
          errorMessage: 'business_failure',
          nextRetryAt: queueDeadlines.approvals,
          status: 'failed',
        }],
        [{
          attemptId: 'answers-retry-clock-1',
          errorMessage: 'business_failure',
          nextRetryAt: queueDeadlines.answers,
          status: 'failed',
        }],
        [{
          attemptId: 'tasks-retry-clock-1',
          errorMessage: 'business_failure',
          nextRetryAt: queueDeadlines.tasks,
          status: 'failed',
        }],
        [{
          attemptId: 'tasks-retry-clock-2',
          errorMessage: 'business_failure',
          nextRetryAt: null,
          status: 'failed',
        }],
      ])
      expect(finishTaskAttempt.mock.calls.slice(0, 3).map((call) =>
        (call[0] as { nextRetryAt: Date }).nextRetryAt.getTime())).toEqual([
        queueDeadlines.approvals.getTime(),
        queueDeadlines.answers.getTime(),
        queueDeadlines.tasks.getTime(),
      ])
      expect(consoleError).toHaveBeenCalledWith(
        '[worker] Queue infrastructure failure',
        expect.objectContaining({ phase: 'retry', queueName: 'task', taskId: TASK_ID }),
      )
    } finally {
      for (const name of workerEnvNames) {
        const value = workerEnv[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('retains authoritative attempt diagnostics while projecting worker failure output', async () => {
    const workerEnvNames = [
      'FORGE_WORKER_MAX_ATTEMPTS',
      'FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS',
      'FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS',
      'FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS',
    ] as const
    const workerEnv = Object.fromEntries(workerEnvNames.map((name) => [name, process.env[name]]))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const finishTaskAttempt = vi.fn(async (input: { attemptId: string }) => {
      if (input.attemptId === 'approvals-attempt') {
        throw new Error('attempt_finish_infrastructure_failure')
      }
    })
    const startTaskAttempt = vi.fn(async (input: { queueName: string }) => {
      if (input.queueName === 'answers') {
        throw new Error('attempt_start_infrastructure_failure')
      }
      return `${input.queueName}-attempt`
    })
    const processFailure = hostileError()
    const taskDeadLetter = vi.fn().mockRejectedValue(new Error('dead_letter_infrastructure_failure'))
    const taskAck = vi.fn().mockResolvedValue(undefined)
    const approvalAck = vi.fn().mockRejectedValue(new Error('ack_infrastructure_failure'))
    const approvalDeadLetter = vi.fn().mockResolvedValue(undefined)
    const approvalRetry = vi.fn().mockResolvedValue(new Date())
    const answersAck = vi.fn().mockResolvedValue(undefined)
    const answersDeadLetter = vi.fn().mockResolvedValue(undefined)
    const answersRetry = vi.fn().mockResolvedValue(new Date())
    let taskClaimCount = 0
    let approvalClaimCount = 0
    let answersClaimCount = 0
    const runtimeQueues: PassiveQueue[] = []

    class PassiveQueue {
      ack = vi.fn().mockResolvedValue(undefined)
      deadLetter = vi.fn().mockResolvedValue(undefined)
      release = vi.fn().mockResolvedValue(undefined)
      retry = vi.fn().mockResolvedValue(new Date())
      recoverStuckJobs = vi.fn().mockResolvedValue(0)
      promoteDueRetries = vi.fn().mockResolvedValue(0)
      claim = vi.fn().mockResolvedValue(null)
      disconnect = vi.fn()

      constructor() {
        runtimeQueues.push(this)
      }
    }

    class RuntimeApprovalQueue extends PassiveQueue {
      override ack = approvalAck
      override deadLetter = approvalDeadLetter
      override retry = approvalRetry
      override claim = vi.fn(async () => {
        approvalClaimCount += 1
        if (approvalClaimCount > 1) return null
        const raw = JSON.stringify({ taskId: TASK_ID, action: 'approve', attempt: 1 })
        return { raw, job: { taskId: TASK_ID, action: 'approve' as const, attempt: 1 } }
      })
    }

    class RuntimeAnswersQueue extends PassiveQueue {
      override ack = answersAck
      override deadLetter = answersDeadLetter
      override retry = answersRetry
      override claim = vi.fn(async () => {
        answersClaimCount += 1
        if (answersClaimCount > 1) return null
        const raw = JSON.stringify({ taskId: TASK_ID, attempt: 1 })
        return { raw, job: { taskId: TASK_ID, attempt: 1 } }
      })
    }

    class RuntimeTaskQueue extends PassiveQueue {
      override ack = taskAck
      override deadLetter = taskDeadLetter
      override claim = vi.fn(async () => {
        taskClaimCount += 1
        if (taskClaimCount === 1) {
          const raw = JSON.stringify({ taskId: TASK_ID, attempt: 2 })
          return { raw, job: { taskId: TASK_ID, attempt: 2 } }
        }
        return await new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 10)
        })
      })
    }

    const query = (rows: unknown[]) => {
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      }
      for (const method of ['from', 'innerJoin', 'where', 'limit']) {
        chain[method] = () => chain
      }
      return chain
    }
    const dbSelect = vi.fn((selection: Record<string, unknown>) =>
      query(Object.keys(selection).length === 1 && 'id' in selection ? [{ id: TASK_ID }] : []))

    vi.resetModules()
    delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime
    vi.doMock('@/worker/queue', () => ({
      AnswersQueue: RuntimeAnswersQueue,
      ApprovalQueue: RuntimeApprovalQueue,
      RetryPromotionConflictError: TestRetryPromotionConflictError,
      TaskQueue: RuntimeTaskQueue,
    }))
    const processAnsweredQuestions = vi.fn().mockResolvedValue(undefined)
    const processApproval = vi.fn().mockResolvedValue(undefined)
    vi.doMock('@/worker/orchestrator', () => ({
      processAnsweredQuestions,
      processApproval,
      processTask: vi.fn().mockRejectedValue(processFailure),
    }))
    vi.doMock('@/worker/task-attempts', () => ({ finishTaskAttempt, startTaskAttempt }))
    vi.doMock('@/db', () => ({ db: { select: dbSelect } }))
    vi.doMock('@/db/schema', () => ({
      tasks: { id: 'tasks.id', status: 'tasks.status' },
      workPackages: {
        metadata: 'work_packages.metadata',
        status: 'work_packages.status',
        taskId: 'work_packages.task_id',
      },
    }))
    vi.doMock('drizzle-orm', () => ({
      and: vi.fn(),
      eq: vi.fn(),
    }))
    vi.doMock('@/worker/blocked-handoff-retry', () => ({
      enqueueDueBlockedHandoffRetries: vi.fn().mockResolvedValue(0),
    }))
    vi.doMock('@/lib/mcps/filesystem-grant-reconciliation', () => ({
      convergeRecognizedOperatorHolds: vi.fn().mockResolvedValue(0),
    }))
    vi.doMock('@/worker/work-package-handoff', () => ({
      reconcilePendingS4CompletionHandoffs: vi.fn().mockResolvedValue(0),
    }))
    vi.doMock('@/lib/session', () => ({
      reconcilePendingSessionCacheInvalidations: vi.fn().mockResolvedValue({
        claimed: 0,
        completed: 0,
        deferred: 0,
        stale: 0,
      }),
    }))

    process.env.FORGE_WORKER_MAX_ATTEMPTS = '2'
    process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = '0'
    process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = '0'
    process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = '0'

    try {
      const { startWorker } = await import('@/worker/runtime')
      const handle = await startWorker('standalone')
      await vi.waitFor(() => {
        expect(approvalAck).toHaveBeenCalledOnce()
        expect(taskDeadLetter).toHaveBeenCalledOnce()
      })
      const stop = handle.stop()
      expect(runtimeQueues.every((queue) => queue.disconnect.mock.calls.length === 0)).toBe(true)
      await stop
      expect(runtimeQueues.every((queue) => queue.disconnect.mock.calls.length === 1)).toBe(true)

      expect(finishTaskAttempt).toHaveBeenCalledWith(expect.objectContaining({
        attemptId: 'tasks-attempt',
        errorMessage: expect.stringContaining(SENTINELS[0]),
        status: 'dead_lettered',
      }))
      expect(finishTaskAttempt).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: expect.stringContaining(SENTINELS[1]),
      }))
      expect(taskDeadLetter).toHaveBeenCalledWith(
        JSON.stringify({ taskId: TASK_ID, attempt: 2 }),
        { taskId: TASK_ID, attempt: 2 },
      )
      expect(taskAck).not.toHaveBeenCalled()
      expect(approvalRetry).not.toHaveBeenCalled()
      expect(approvalDeadLetter).not.toHaveBeenCalled()
      expect(answersAck).not.toHaveBeenCalled()
      expect(answersDeadLetter).not.toHaveBeenCalled()
      expect(answersRetry).not.toHaveBeenCalled()
      expect(processApproval).toHaveBeenCalledOnce()
      expect(processAnsweredQuestions).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(
        '[worker] Job processing failed',
        expect.objectContaining({
          attempt: 2,
          finalAttempt: true,
          queueName: 'task',
          taskId: TASK_ID,
        }),
      )
      expect(consoleError).toHaveBeenCalledWith(
        '[worker] Queue infrastructure failure',
        expect.objectContaining({ phase: 'ack_after_success', queueName: 'approval' }),
      )
      expect(consoleError).toHaveBeenCalledWith(
        '[worker] Attempt persistence failure',
        expect.objectContaining({ phase: 'finish_after_success', queueName: 'approval' }),
      )
      expect(consoleError).toHaveBeenCalledWith(
        '[worker] Attempt persistence failure',
        expect.objectContaining({ phase: 'start', queueName: 'answers' }),
      )
      expect(consoleError).toHaveBeenCalledWith(
        '[worker] Queue infrastructure failure',
        expect.objectContaining({ phase: 'dead_letter', queueName: 'task' }),
      )
      assertNoSentinels([
        ...consoleError.mock.calls,
        ...consoleInfo.mock.calls,
        ...consoleWarn.mock.calls,
        ...taskDeadLetter.mock.calls,
      ])
    } finally {
      for (const name of workerEnvNames) {
        const value = workerEnv[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('releases post-stop approval, answers, and task claims before any business boundary', async () => {
    const workerEnvNames = [
      'FORGE_WORKER_CLAIM_TIMEOUT_SECONDS',
      'FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS',
      'FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS',
      'FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS',
      'FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS',
    ] as const
    const workerEnv = Object.fromEntries(workerEnvNames.map((name) => [name, process.env[name]]))
    const positions = ['approval', 'answers', 'task'] as const

    try {
      process.env.FORGE_WORKER_CLAIM_TIMEOUT_SECONDS = '1'
      process.env.FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS = '1'
      process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = '0'
      process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = '0'
      process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = '0'

      for (const position of positions) {
        vi.resetModules()
        delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime

        const raw = JSON.stringify({
          schemaVersion: 1,
          occurrenceId: randomUUID(),
          job: position === 'approval'
            ? { taskId: TASK_ID, action: 'approve', attempt: 1 }
            : { taskId: TASK_ID, attempt: 1 },
        })
        const job = position === 'approval'
          ? { taskId: TASK_ID, action: 'approve' as const, attempt: 1 }
          : { taskId: TASK_ID, attempt: 1 }
        const state = {
          claims: 0,
          processing: [] as string[],
          ready: [] as string[],
        }
        let resolveBlockedClaim!: (value: { raw: string; job: typeof job }) => void
        let markClaimStarted: (() => void) | null = null
        const claimStarted = new Promise<void>((resolve) => {
          markClaimStarted = resolve
        })
        const blockedClaim = new Promise<{ raw: string; job: typeof job }>((resolve) => {
          resolveBlockedClaim = resolve
        })
        const claimFns = {
          approval: vi.fn().mockResolvedValue(null),
          answers: vi.fn().mockResolvedValue(null),
          task: vi.fn().mockResolvedValue(null),
        }
        claimFns[position] = vi.fn(async () => {
          markClaimStarted?.()
          return await blockedClaim
        })
        const queueInstances: Array<{
          disconnect: ReturnType<typeof vi.fn>
          kind: typeof position
          release: ReturnType<typeof vi.fn>
        }> = []

        const queueClass = (kind: typeof position) => class {
          ack = vi.fn()
          claim = claimFns[kind]
          deadLetter = vi.fn()
          disconnect = vi.fn()
          promoteDueRetries = vi.fn().mockResolvedValue(0)
          recoverStuckJobs = vi.fn().mockResolvedValue(0)
          release = vi.fn(async (releasedRaw: string) => {
            state.processing = state.processing.filter((entry) => entry !== releasedRaw)
            state.claims = 0
            state.ready.unshift(releasedRaw)
            return 'applied' as const
          })
          retry = vi.fn()

          constructor() {
            queueInstances.push({
              disconnect: this.disconnect,
              kind,
              release: this.release,
            })
          }
        }

        vi.doMock('@/worker/queue', () => ({
          AnswersQueue: queueClass('answers'),
          ApprovalQueue: queueClass('approval'),
          RetryPromotionConflictError: TestRetryPromotionConflictError,
          TaskQueue: queueClass('task'),
        }))
        const processAnsweredQuestions = vi.fn()
        const processApproval = vi.fn()
        const processTask = vi.fn()
        vi.doMock('@/worker/orchestrator', () => ({
          processAnsweredQuestions,
          processApproval,
          processTask,
        }))
        const finishTaskAttempt = vi.fn()
        const startTaskAttempt = vi.fn()
        vi.doMock('@/worker/task-attempts', () => ({ finishTaskAttempt, startTaskAttempt }))
        const query = (rows: unknown[]) => {
          const chain: Record<string, unknown> = {
            then: (
              resolve: (value: unknown[]) => unknown,
              reject?: (reason: unknown) => unknown,
            ) => Promise.resolve(rows).then(resolve, reject),
          }
          for (const method of ['from', 'innerJoin', 'where', 'limit']) {
            chain[method] = () => chain
          }
          return chain
        }
        const taskLookup = vi.fn()
        const dbSelect = vi.fn((selection: Record<string, unknown>) => {
          if (Object.keys(selection).length === 1 && 'id' in selection) taskLookup()
          return query([])
        })
        vi.doMock('@/db', () => ({ db: { select: dbSelect } }))
        vi.doMock('@/db/schema', () => ({
          tasks: { id: 'tasks.id', status: 'tasks.status' },
          workPackages: {
            metadata: 'work_packages.metadata',
            status: 'work_packages.status',
            taskId: 'work_packages.task_id',
          },
        }))
        vi.doMock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }))
        vi.doMock('@/worker/blocked-handoff-retry', () => ({
          enqueueDueBlockedHandoffRetries: vi.fn().mockResolvedValue(0),
        }))
        vi.doMock('@/lib/mcps/filesystem-grant-reconciliation', () => ({
          convergeRecognizedOperatorHolds: vi.fn().mockResolvedValue(0),
        }))
        vi.doMock('@/worker/work-package-handoff', () => ({
          reconcilePendingS4CompletionHandoffs: vi.fn().mockResolvedValue(0),
        }))
        vi.doMock('@/lib/session', () => ({
          reconcilePendingSessionCacheInvalidations: vi.fn().mockResolvedValue({
            claimed: 0,
            completed: 0,
            deferred: 0,
            stale: 0,
          }),
        }))

        const { startWorker } = await import('@/worker/runtime')
        const handle = await startWorker('standalone')
        await claimStarted
        const stop = handle.stop()
        state.processing = [raw]
        state.claims = 1
        resolveBlockedClaim({ raw, job })
        await stop

        const target = queueInstances.find((entry) => entry.kind === position)
        if (!target) throw new Error('Expected the blocked queue fixture.')
        expect(target.release).toHaveBeenCalledOnce()
        expect(target.release).toHaveBeenCalledWith(raw)
        expect(state).toEqual({ claims: 0, processing: [], ready: [raw] })
        expect(taskLookup).not.toHaveBeenCalled()
        expect(startTaskAttempt).not.toHaveBeenCalled()
        expect(finishTaskAttempt).not.toHaveBeenCalled()
        expect(processApproval).not.toHaveBeenCalled()
        expect(processAnsweredQuestions).not.toHaveBeenCalled()
        expect(processTask).not.toHaveBeenCalled()
        if (position === 'approval') {
          expect(claimFns.answers).not.toHaveBeenCalled()
          expect(claimFns.task).not.toHaveBeenCalled()
        } else if (position === 'answers') {
          expect(claimFns.task).not.toHaveBeenCalled()
        }
        expect(queueInstances.every((entry) => entry.disconnect.mock.calls.length === 1))
          .toBe(true)
      }
    } finally {
      for (const name of workerEnvNames) {
        const value = workerEnv[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

describe('core output source sentinel', () => {
  const repoRoot = path.resolve(__dirname, '..')
  const assignedFiles = [
    'lib/redis.ts',
    'lib/task-event-redis.ts',
    'worker/queue.ts',
    'worker/runtime.ts',
  ] as const

  it('keeps dynamic error, raw-payload, and enumerable values out of console calls', () => {
    const forbiddenNames = new Set([
      'cause',
      'command',
      'err',
      'error',
      'errorMessage',
      'errors',
      'message',
      'options',
      'password',
      'raw',
      'stack',
      'token',
      'url',
    ])

    for (const relativePath of assignedFiles) {
      const sourceText = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
      const sourceFile = ts.createSourceFile(
        relativePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const inspect = (node: ts.Node): void => {
        if (ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === 'console') {
          if (relativePath !== 'worker/runtime.ts') {
            if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
              throw new Error(`Core Redis and queue logs must use one fixed category in ${relativePath}.`)
            }
          }
          for (const argument of node.arguments.slice(1)) {
            const inspectArgument = (candidate: ts.Node): void => {
              if (ts.isSpreadElement(candidate)) {
                throw new Error(`Operational console spread is not closed in ${relativePath}.`)
              }
              if (ts.isIdentifier(candidate) && forbiddenNames.has(candidate.text)) {
                throw new Error(`Operational console value is not closed in ${relativePath}.`)
              }
              if ((ts.isPropertyAssignment(candidate)
                  || ts.isShorthandPropertyAssignment(candidate)
                  || ts.isPropertyAccessExpression(candidate))
                && forbiddenNames.has(candidate.name.getText(sourceFile))) {
                throw new Error(`Operational console field is not closed in ${relativePath}.`)
              }
              ts.forEachChild(candidate, inspectArgument)
            }
            inspectArgument(argument)
          }
        }
        ts.forEachChild(node, inspect)
      }
      inspect(sourceFile)
    }
  })

  it('keeps queue failures projected while retaining internal attempt diagnostics', () => {
    const queueSource = fs.readFileSync(path.join(repoRoot, 'worker/queue.ts'), 'utf8')
    const runtimeSource = fs.readFileSync(path.join(repoRoot, 'worker/runtime.ts'), 'utf8')
    const retryScript = queueSource.match(
      /const RETRY_JOB_SCRIPT = `([\s\S]*?)`\n\nconst DEAD_LETTER_JOB_SCRIPT/,
    )?.[1] ?? ''
    const dueScanScript = queueSource.match(
      /const LIST_DUE_RETRIES_SCRIPT = `([\s\S]*?)`\n\nconst PROMOTE_RETRY_SCRIPT/,
    )?.[1] ?? ''
    const retryMethod = queueSource.match(
      /  async retry\([\s\S]*?\n  async deadLetter\(/,
    )?.[0] ?? ''

    expect(queueSource).toContain("failureCategory: DEAD_LETTER_FAILURE_CATEGORY")
    expect(queueSource).toContain('schemaVersion: QUEUE_ENVELOPE_SCHEMA_VERSION')
    expect(queueSource).toContain('occurrenceId: active.occurrenceId')
    expect(queueSource).toContain("return 'stale_not_owner'")
    expect(queueSource).toContain("error('forge_queue_claim_marker_invalid')")
    expect(queueSource.match(/error\('forge_queue_claim_marker_invalid'\)/g)).toHaveLength(10)
    expect(queueSource).toContain("local now = redis.call('TIME')")
    expect(queueSource).toContain("redis.call('ZADD', KEYS[3], now_ms, receipt)")
    expect(queueSource).toContain("redis.call('ZSCORE', KEYS[3], receipt)")
    expect(queueSource).toContain('const TRANSITION_RECEIPT_TTL_MS = 15 * 60 * 1000')
    expect(queueSource).toContain('const TRANSITION_RECEIPT_CAP = 50_000')
    expect(queueSource).toContain('const TRANSITION_RECEIPT_PRUNE_LIMIT = 100')
    expect(queueSource).toContain('-- forge:queue:list-due-retries-v1')
    expect(queueSource).toContain("'WITHSCORES'")
    expect(dueScanScript).toContain("local now = redis.call('TIME')")
    expect(dueScanScript).toContain('now_ms')
    expect(dueScanScript).not.toContain('Date.now')
    expect(retryScript).toContain('-- forge:queue:retry-v3')
    expect(retryScript).toContain('local delay_ms = tonumber(delay_ms_raw)')
    expect(retryScript).toContain('local now_ms = redis_now_ms()')
    expect(retryScript).toContain(
      "redis.call('ZADD', KEYS[3], now_ms + delay_ms, ARGV[5])",
    )
    expect(retryScript).toContain(
      "return {1, redis.call('ZSCORE', KEYS[3], ARGV[5])}",
    )
    expect(retryScript).toMatch(
      /local existing_score = redis\.call\('ZSCORE', KEYS\[3\], ARGV\[5\]\)[\s\S]{0,120}return \{2, existing_score\}/,
    )
    expect(retryScript).toContain(
      "if not current_marker and not redis.call('LPOS', KEYS[1], ARGV[1]) then",
    )
    expect(retryScript).toMatch(
      /if current_marker ~= ARGV\[3\] then[\s\S]*?redis\.call\('ZSCORE', KEYS\[3\], ARGV\[5\]\)[\s\S]*?redis\.call\('LREM', KEYS\[1\], 1, ARGV\[1\]\)/,
    )
    expect(retryScript.indexOf("redis.call('ZSCORE', KEYS[3], ARGV[5])"))
      .toBeLessThan(retryScript.indexOf("redis.call('LREM', KEYS[1], 1, ARGV[1])"))
    expect(retryScript).toContain("return {0, ''}")
    expect(retryMethod).toContain('String(intent.delayMs)')
    expect(retryMethod).not.toContain('Date.now')
    expect(queueSource).toMatch(
      /export type QueueRetryResult = \{[\s\S]{0,120}nextRetryAt: Date[\s\S]{0,40}\}/,
    )
    expect(queueSource).toMatch(
      /private decodeRetryTransition[\s\S]{0,1300}const nextRetryAt = new Date\(score\)[\s\S]{0,300}return \{ outcome, nextRetryAt \}/,
    )
    expect(queueSource).toContain('-- forge:queue:promote-retry-v4')
    expect(queueSource).toContain(
      "export const RETRY_PROMOTION_CONFLICT_CODE = 'queue_retry_promotion_conflict' as const",
    )
    expect(queueSource).toContain('export class RetryPromotionConflictError extends Error')
    expect(queueSource).toContain('throw new RetryPromotionConflictError()')
    expect(queueSource).toContain(
      "throw new Error('Queue retry promotion receipt integrity failure')",
    )
    expect(queueSource).toContain('const PROMOTION_DISPOSITION_TTL_MS = 15 * 60 * 1000')
    expect(queueSource).toContain('const PROMOTION_DISPOSITION_CAP = 50_000')
    expect(queueSource).toContain('const PROMOTION_DISPOSITION_PRUNE_LIMIT = 100')
    expect(queueSource).toContain("createHash('sha256')")
    expect(queueSource).toContain("PROMOTION_FINGERPRINT_DOMAIN")
    expect(queueSource).toContain('length.writeBigUInt64BE(BigInt(part.length))')
    expect(queueSource).toContain("redis.call('ZSCORE', KEYS[1], raw_member)")
    expect(queueSource).toContain("redis.call('HGET', KEYS[3], fingerprint)")
    expect(queueSource).toContain("redis.call('ZSCORE', KEYS[4], fingerprint)")
    expect(queueSource).toContain("redis.call('HSET', KEYS[3], fingerprint, 'discarded')")
    expect(queueSource).toContain(
      "redis.call('HSET', KEYS[3], fingerprint, 'promoted:' .. candidate_occurrence_id)",
    )
    expect(queueSource).toContain("redis.call('ZADD', KEYS[4], now_ms, fingerprint)")
    expect(queueSource).toContain("mode ~= 'discard' and mode ~= 'legacy'")
    expect(queueSource).toContain(
      "return { destination: '', mode: 'discard', occurrenceId: '' }",
    )
    expect(queueSource).toContain("console.warn('[worker/queue] Dropped invalid retry payload')")
    expect(queueSource).toMatch(
      /-- forge:queue:promote-retry-v4[\s\S]{0,4200}redis\.call\('ZREM', KEYS\[1\], raw_member\)[\s\S]{0,500}redis\.call\('LPUSH', KEYS\[2\], destination\)/,
    )
    const promotionScript = queueSource.match(
      /const PROMOTE_RETRY_SCRIPT = `([\s\S]*?)`\n\nconst RECOVER_STUCK_JOB_SCRIPT/,
    )?.[1] ?? ''
    expect(promotionScript).toContain('if not existing and not receipt_score then')
    expect(promotionScript).toMatch(
      /if not existing and not receipt_score then\s+return \{0, 'ownership_conflict', ''\}/,
    )
    expect(promotionScript).toContain('if not existing or not receipt_score then')
    expect(promotionScript).toContain('if current_score ~= expected_score then')
    expect(promotionScript).toContain('if existing or receipt_score then')
    expect(promotionScript).toContain("return {0, 'ownership_conflict', ''}")
    expect(promotionScript).toContain("return {0, 'receipt_integrity_failure', ''}")
    expect(promotionScript).toContain('receipt_timestamp <= now_ms')
    expect(promotionScript).toContain('receipt_timestamp > cutoff')
    expect(promotionScript).toContain('receipt_timestamp ~= math.huge')
    expect(promotionScript).toContain('receipt_timestamp ~= -math.huge')
    expect(promotionScript).toMatch(
      /if not receipt_timestamp_valid or not disposition_valid then[\s\S]{0,220}redis\.call\('HDEL', KEYS\[3\], fingerprint\)[\s\S]{0,120}redis\.call\('ZREM', KEYS\[4\], fingerprint\)/,
    )
    expect(promotionScript).toContain("'LIMIT',\n  0,\n  prune_limit")
    expect(promotionScript).toContain(
      "redis.call('HLEN', KEYS[3]) >= cap or redis.call('ZCARD', KEYS[4]) >= cap",
    )
    expect(promotionScript).toContain("return {2, 'promoted', winning_occurrence_id}")
    expect(promotionScript).toContain("return {2, 'discarded', ''}")
    expect(promotionScript).not.toContain("redis.call('LPOS'")
    expect(promotionScript).not.toContain("redis.call('LRANGE'")
    expect(promotionScript).not.toContain("redis.call('HSET', KEYS[3], raw_member")
    expect(promotionScript).not.toContain("redis.call('ZADD', KEYS[4], now_ms, raw_member")
    expect(runtimeSource).toContain('error instanceof RetryPromotionConflictError')
    expect(runtimeSource).toContain(
      "category: 'mixed_version_retry_promotion'",
    )
    expect(runtimeSource).toContain(
      "promoteQueueRetries('approvals', approvalQueue)",
    )
    expect(runtimeSource).toContain(
      "promoteQueueRetries('answers', answersQueue)",
    )
    expect(runtimeSource).toContain(
      "promoteQueueRetries('tasks', taskQueue)",
    )
    expect(runtimeSource).not.toMatch(
      /Retry promotion compatibility conflict[\s\S]{0,180}\b(?:error|message|stack|raw)\b/,
    )
    expect(queueSource).not.toMatch(
      /promoteDueRetries[\s\S]{0,300}this\.client\.zrangebyscore/,
    )
    expect(queueSource).not.toMatch(
      /promoteDueRetries[\s\S]{0,1500}this\.client\.(?:zrem|lpush)/,
    )
    expect(queueSource).toContain("redis.call('RPUSH', KEYS[1], ARGV[1])")
    expect(queueSource).toContain('const STUCK_RECOVERY_SCAN_LIMIT = 100')
    expect(queueSource).not.toMatch(/this\.client\.lpush\(this\.deadQueueKey,[\s\S]{0,300}\braw,/)
    expect(queueSource).not.toMatch(/this\.client\.lpush\(this\.deadQueueKey,[\s\S]{0,300}\berrorMessage\b/)
    expect(runtimeSource).toContain('errorMessage: message')
    expect(runtimeSource).toContain('const message = retainedErrorMessage(err)')
    expect(runtimeSource).toMatch(
      /retryResult = await queue\.retry\([\s\S]{0,650}nextRetryAt: retryResult\.nextRetryAt/,
    )
    expect(runtimeSource).toMatch(
      /logQueueInfrastructureFailure\('retry'[\s\S]{0,500}nextRetryAt: null/,
    )
    expect(runtimeSource).not.toMatch(
      /nextRetryAt\s*=\s*[\s\S]{0,80}Date\.now\(\)/,
    )
    expect(runtimeSource).toContain('await queue.deadLetter(raw, job)')
    expect(runtimeSource).toContain('await recoverQueueWork({ drain: true })')
    expect(runtimeSource).toContain('queueRecoveryTimer = setInterval(')
    expect(runtimeSource).toContain('await queueRecoveryRun?.catch(() => {})')
    expect(runtimeSource.match(/if \(shuttingDown\) \{[\s\S]{0,300}releaseClaimAfterShutdown/g))
      .toHaveLength(3)
    expect(runtimeSource).toMatch(
      /logQueueInfrastructureFailure\(\s*'release_after_shutdown'/,
    )
    expect(runtimeSource).not.toMatch(
      /stop:\s*async[\s\S]{0,300}(?:taskQueue|approvalQueue|answersQueue)\.disconnect\(\)/,
    )
    expect(runtimeSource).not.toMatch(/deadLetter\([^)]*\bmessage\b/)
    expect(queueSource).not.toContain('Promise.all([')
  })
})
