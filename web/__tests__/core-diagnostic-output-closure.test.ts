import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RedisHarnessInstance = {
  brpoplpush: ReturnType<typeof vi.fn>
  call: ReturnType<typeof vi.fn>
  eval: ReturnType<typeof vi.fn>
  hdel: ReturnType<typeof vi.fn>
  hget: ReturnType<typeof vi.fn>
  hset: ReturnType<typeof vi.fn>
  lpush: ReturnType<typeof vi.fn>
  lrange: ReturnType<typeof vi.fn>
  lrem: ReturnType<typeof vi.fn>
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
  ack: (raw: string) => Promise<void>
  claim: (timeoutSeconds: number) => Promise<{ job: AtomicQueueJob; raw: string } | null>
  deadLetter: (raw: string, job: AtomicQueueJob) => Promise<void>
  promoteDueRetries: () => Promise<number>
  recoverStuckJobs: (staleMs: number) => Promise<number>
  retry: (raw: string, job: AtomicQueueJob, delayMs: number) => Promise<Date>
}

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
    eval = vi.fn(async (script: string, numberOfKeys: number, ...values: string[]) => {
      if (injectedFailure(script, 'before')) throw new Error('injected_redis_failure')
      const keys = values.slice(0, numberOfKeys)
      const args = values.slice(numberOfKeys)
      let result: number | string = 0

      if (script.includes('forge:queue:claim-v1')) {
        if (list(keys[0]).includes(args[0]) && !hash(keys[1]).has(args[0])) {
          const marker = `${redisHarness.nowMs}:${args[1]}`
          hash(keys[1]).set(args[0], marker)
          result = marker
        }
      } else if (script.includes('forge:queue:ack-v1')) {
        if (hash(keys[1]).get(args[0]) === args[1] && removeFirst(list(keys[0]), args[0])) {
          hash(keys[1]).delete(args[0])
          result = 1
        }
      } else if (script.includes('forge:queue:discard-invalid-v1')) {
        if (removeFirst(list(keys[0]), args[0])) {
          hash(keys[1]).delete(args[0])
          result = 1
        }
      } else if (script.includes('forge:queue:retry-v1')) {
        if (hash(keys[1]).get(args[0]) === args[1] && list(keys[0]).includes(args[0])) {
          zset(keys[2]).set(args[3], Number(args[2]))
          hash(keys[1]).delete(args[0])
          removeFirst(list(keys[0]), args[0])
          result = 1
        }
      } else if (script.includes('forge:queue:dead-letter-v1')) {
        if (hash(keys[1]).get(args[0]) === args[1] && list(keys[0]).includes(args[0])) {
          list(keys[2]).unshift(args[2])
          hash(keys[1]).delete(args[0])
          removeFirst(list(keys[0]), args[0])
          result = 1
        }
      } else if (script.includes('forge:queue:promote-retry-v1')) {
        if (zset(keys[0]).has(args[0])) {
          zset(keys[0]).delete(args[0])
          if (!list(keys[1]).includes(args[0])) list(keys[1]).unshift(args[0])
          result = 1
        }
      } else if (script.includes('forge:queue:recover-stuck-v1')) {
        const claimedAt = Number((hash(keys[1]).get(args[0]) ?? '0').split(':', 1)[0])
        if (list(keys[0]).includes(args[0])
          && (claimedAt <= 0 || redisHarness.nowMs - claimedAt >= Number(args[1]))) {
          hash(keys[1]).delete(args[0])
          removeFirst(list(keys[0]), args[0])
          if (!list(keys[2]).includes(args[0])) list(keys[2]).unshift(args[0])
          result = 1
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
      ...values: string[]
    ) => {
      if (command !== 'EVAL') throw new Error('unknown_redis_command')
      return await this.eval(script, numberOfKeys, ...values)
    })
    hdel = vi.fn().mockResolvedValue(1)
    hget = vi.fn().mockResolvedValue(null)
    hset = vi.fn().mockResolvedValue(1)
    lpush = vi.fn().mockResolvedValue(1)
    lrange = vi.fn(async (key: string, start: number, stop: number) => {
      const values = list(key)
      const inclusiveStop = stop < 0 ? values.length : stop + 1
      return values.slice(start, inclusiveStop)
    })
    lrem = vi.fn().mockResolvedValue(1)
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
      expect.stringContaining('forge:queue:discard-invalid-v1'),
      2,
      'forge:tasks:processing',
      'forge:tasks:claims',
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
    expect(claimed).toEqual({
      raw,
      job: { taskId: TASK_ID, attempt: 3 },
    })
    if (!claimed) throw new Error('Expected the closed task job to be claimed.')

    await queue.deadLetter(claimed.raw, claimed.job)
    const [client] = redisHarness.instances
    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([])
    expect(redisHarness.hashes.get('forge:tasks:claims')?.has(raw) ?? false).toBe(false)
    expect(client.hset).not.toHaveBeenCalled()
    expect(client.lrem).not.toHaveBeenCalled()
    expect(client.hdel).not.toHaveBeenCalled()
    expect(client.lpush).not.toHaveBeenCalled()

    const [deadRaw] = redisHarness.lists.get('forge:tasks:dead') ?? []
    const deadRecord = JSON.parse(deadRaw) as Record<string, unknown>
    expect(deadRecord).toEqual({
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
    const retryAt = await retryQueue.retry(retryClaim.raw, retryClaim.job, 500)
    const retryClient = redisHarness.instances[1]
    expect(redisHarness.zsets.get('forge:tasks:retry')).toEqual(new Map([
      [JSON.stringify({ taskId: TASK_ID, attempt: 2 }), retryAt.getTime()],
    ]))
    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([])
    expect(redisHarness.hashes.get('forge:tasks:claims')?.has(retryRaw) ?? false).toBe(false)
    expect(retryClient.zadd).not.toHaveBeenCalled()
    expect(retryClient.lrem).not.toHaveBeenCalled()
    expect(retryClient.hdel).not.toHaveBeenCalled()
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
      redisHarness.failures.push({ marker: 'forge:queue:claim-v1', stage: 'before' })
      const queue = queueCase.create()
      await expect(queue.claim(1)).rejects.toThrow('injected_redis_failure')
      expect(redisHarness.lists.get(queueCase.processing)).toContain(queueCase.raw)
      expect(await queue.recoverStuckJobs(0)).toBe(1)
    }

    expect([...redisHarness.hashes.values()].every((entries) => entries.size === 0)).toBe(true)

    const responseLossRaw = JSON.stringify({ taskId: TASK_ID, attempt: 9 })
    redisHarness.claimPayloads.push(responseLossRaw)
    redisHarness.failures.push({ marker: 'forge:queue:claim-v1', stage: 'after' })
    const responseLossQueue = new TaskQueue('redis://localhost:6379/0')
    await expect(responseLossQueue.claim(1))
      .rejects.toThrow('injected_redis_response_loss')
    expect(redisHarness.lists.get('forge:tasks:processing')).toContain(responseLossRaw)
    expect(redisHarness.hashes.get('forge:tasks:claims')?.has(responseLossRaw)).toBe(true)
    expect(await responseLossQueue.recoverStuckJobs(0)).toBe(1)

    const duplicateRaw = JSON.stringify({ taskId: TASK_ID, attempt: 10 })
    redisHarness.claimPayloads.push(duplicateRaw, duplicateRaw)
    const firstDuplicateQueue = new TaskQueue('redis://localhost:6379/0')
    const secondDuplicateQueue = new TaskQueue('redis://localhost:6379/0')
    const firstDuplicateClaim = await firstDuplicateQueue.claim(1)
    if (!firstDuplicateClaim) throw new Error('Expected the first duplicate fixture claim.')
    await expect(secondDuplicateQueue.claim(1)).rejects.toThrow(
      'Queue claim is no longer available',
    )
    await firstDuplicateQueue.ack(firstDuplicateClaim.raw)
    await firstDuplicateQueue.ack(firstDuplicateClaim.raw)
    expect(
      redisHarness.lists.get('forge:tasks:processing')
        ?.filter((entry) => entry === duplicateRaw),
    ).toHaveLength(1)
    expect(await secondDuplicateQueue.recoverStuckJobs(0)).toBe(1)
    expect(redisHarness.lists.get('forge:tasks')?.filter((entry) => entry === duplicateRaw))
      .toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps malformed work recoverable when atomic discard fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const malformed = `{"taskId":"${TASK_ID}","taskId":"${SENTINELS[0]}"}`
    redisHarness.claimPayloads.push(malformed)
    redisHarness.failures.push({ marker: 'forge:queue:discard-invalid-v1', stage: 'before' })

    const { TaskQueue } = await import('@/worker/queue')
    const queue = new TaskQueue('redis://localhost:6379/0')
    await expect(queue.claim(1)).rejects.toThrow('injected_redis_failure')

    expect(redisHarness.lists.get('forge:tasks:processing')).toEqual([malformed])
    expect(redisHarness.hashes.get('forge:tasks:claims')?.size ?? 0).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('makes every source-to-destination transition atomic and lost-response idempotent', async () => {
    const { AnswersQueue, ApprovalQueue, TaskQueue } = await import('@/worker/queue')
    const cases = [
      {
        claims: 'forge:tasks:claims',
        create: () => new TaskQueue('redis://localhost:6379/0'),
        dead: 'forge:tasks:dead',
        job: (attempt: number) => ({ taskId: TASK_ID, attempt }),
        processing: 'forge:tasks:processing',
        ready: 'forge:tasks',
        retry: 'forge:tasks:retry',
      },
      {
        claims: 'forge:approvals:claims',
        create: () => new ApprovalQueue('redis://localhost:6379/0'),
        dead: 'forge:approvals:dead',
        job: (attempt: number) => ({ taskId: TASK_ID, action: 'approve' as const, attempt }),
        processing: 'forge:approvals:processing',
        ready: 'forge:approvals',
        retry: 'forge:approvals:retry',
      },
      {
        claims: 'forge:answers:claims',
        create: () => new AnswersQueue('redis://localhost:6379/0'),
        dead: 'forge:answers:dead',
        job: (attempt: number) => ({ taskId: TASK_ID, attempt }),
        processing: 'forge:answers:processing',
        ready: 'forge:answers',
        retry: 'forge:answers:retry',
      },
    ]

    for (const [caseIndex, queueCase] of cases.entries()) {
      const queue = queueCase.create() as unknown as AtomicQueue

      const ackRaw = JSON.stringify(queueCase.job(10 + caseIndex))
      redisHarness.claimPayloads.push(ackRaw)
      const ackClaim = await queue.claim(1)
      if (!ackClaim) throw new Error('Expected an acknowledgement fixture claim.')
      redisHarness.failures.push({ marker: 'forge:queue:ack-v1', stage: 'after' })
      await expect(queue.ack(ackClaim.raw)).rejects.toThrow('injected_redis_response_loss')
      await expect(queue.ack(ackClaim.raw)).resolves.toBeUndefined()
      expect(redisHarness.lists.get(queueCase.processing)).not.toContain(ackRaw)
      expect(redisHarness.hashes.get(queueCase.claims)?.has(ackRaw) ?? false).toBe(false)

      const retryRaw = JSON.stringify(queueCase.job(20 + caseIndex))
      redisHarness.claimPayloads.push(retryRaw)
      const retryClaim = await queue.claim(1)
      if (!retryClaim) throw new Error('Expected a retry fixture claim.')
      redisHarness.failures.push({ marker: 'forge:queue:retry-v1', stage: 'before' })
      await expect(queue.retry(retryClaim.raw, retryClaim.job, 0))
        .rejects.toThrow('injected_redis_failure')
      expect(redisHarness.lists.get(queueCase.processing)).toContain(retryRaw)
      expect(redisHarness.zsets.get(queueCase.retry)?.size ?? 0).toBe(0)

      redisHarness.failures.push({ marker: 'forge:queue:retry-v1', stage: 'after' })
      await expect(queue.retry(retryClaim.raw, retryClaim.job, 0))
        .rejects.toThrow('injected_redis_response_loss')
      const retryState = new Map(redisHarness.zsets.get(queueCase.retry))
      await expect(queue.retry(retryClaim.raw, retryClaim.job, 0)).resolves.toBeInstanceOf(Date)
      expect(redisHarness.zsets.get(queueCase.retry)).toEqual(retryState)
      expect(retryState.size).toBe(1)
      expect(redisHarness.lists.get(queueCase.processing)).not.toContain(retryRaw)

      redisHarness.failures.push({ marker: 'forge:queue:promote-retry-v1', stage: 'after' })
      await expect(queue.promoteDueRetries()).rejects.toThrow('injected_redis_response_loss')
      await expect(queue.promoteDueRetries()).resolves.toBe(0)
      const promotedRaw = [...retryState.keys()][0]
      expect(redisHarness.lists.get(queueCase.ready)?.filter((raw) => raw === promotedRaw))
        .toHaveLength(1)
      expect(redisHarness.zsets.get(queueCase.retry)?.size ?? 0).toBe(0)

      const deadRaw = JSON.stringify(queueCase.job(30 + caseIndex))
      redisHarness.claimPayloads.push(deadRaw)
      const deadClaim = await queue.claim(1)
      if (!deadClaim) throw new Error('Expected a dead-letter fixture claim.')
      redisHarness.failures.push({ marker: 'forge:queue:dead-letter-v1', stage: 'before' })
      await expect(queue.deadLetter(deadClaim.raw, deadClaim.job))
        .rejects.toThrow('injected_redis_failure')
      expect(redisHarness.lists.get(queueCase.processing)).toContain(deadRaw)
      expect(redisHarness.lists.get(queueCase.dead)?.length ?? 0).toBe(0)

      redisHarness.failures.push({ marker: 'forge:queue:dead-letter-v1', stage: 'after' })
      await expect(queue.deadLetter(deadClaim.raw, deadClaim.job))
        .rejects.toThrow('injected_redis_response_loss')
      const committedDead = [...(redisHarness.lists.get(queueCase.dead) ?? [])]
      await expect(queue.deadLetter(deadClaim.raw, deadClaim.job)).resolves.toBeUndefined()
      expect(redisHarness.lists.get(queueCase.dead)).toEqual(committedDead)
      expect(committedDead).toHaveLength(1)
      expect(redisHarness.lists.get(queueCase.processing)).not.toContain(deadRaw)

      const recoveryRaw = JSON.stringify(queueCase.job(40 + caseIndex))
      redisHarness.claimPayloads.push(recoveryRaw)
      const recoveryClaim = await queue.claim(1)
      if (!recoveryClaim) throw new Error('Expected a recovery fixture claim.')
      redisHarness.nowMs += 2_000
      redisHarness.failures.push({ marker: 'forge:queue:recover-stuck-v1', stage: 'after' })
      await expect(queue.recoverStuckJobs(1_000)).rejects.toThrow('injected_redis_response_loss')
      await expect(queue.recoverStuckJobs(1_000)).resolves.toBe(0)
      expect(redisHarness.lists.get(queueCase.ready)?.filter((raw) => raw === recoveryRaw))
        .toHaveLength(1)
      expect(redisHarness.lists.get(queueCase.processing)).not.toContain(recoveryRaw)
      expect(redisHarness.hashes.get(queueCase.claims)?.has(recoveryRaw) ?? false).toBe(false)
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
    const taskClaimWaiter = {
      release: null as ((value: null) => void) | null,
    }
    let taskClaimCount = 0
    let approvalClaimCount = 0
    let answersClaimCount = 0

    class PassiveQueue {
      ack = vi.fn().mockResolvedValue(undefined)
      deadLetter = vi.fn().mockResolvedValue(undefined)
      retry = vi.fn().mockResolvedValue(new Date())
      recoverStuckJobs = vi.fn().mockResolvedValue(0)
      promoteDueRetries = vi.fn().mockResolvedValue(0)
      claim = vi.fn().mockResolvedValue(null)
      disconnect = vi.fn()
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
          taskClaimWaiter.release = resolve
        })
      })
      override disconnect = vi.fn(() => {
        taskClaimWaiter.release?.(null)
        taskClaimWaiter.release = null
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
      await handle.stop()

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
      taskClaimWaiter.release?.(null)
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

    expect(queueSource).toContain("failureCategory: DEAD_LETTER_FAILURE_CATEGORY")
    expect(queueSource).not.toMatch(/this\.client\.lpush\(this\.deadQueueKey,[\s\S]{0,300}\braw,/)
    expect(queueSource).not.toMatch(/this\.client\.lpush\(this\.deadQueueKey,[\s\S]{0,300}\berrorMessage\b/)
    expect(runtimeSource).toContain('errorMessage: message')
    expect(runtimeSource).toContain('const message = retainedErrorMessage(err)')
    expect(runtimeSource).toContain('await queue.deadLetter(raw, job)')
    expect(runtimeSource).not.toMatch(/deadLetter\([^)]*\bmessage\b/)
    expect(queueSource).not.toContain('Promise.all([')
  })
})
