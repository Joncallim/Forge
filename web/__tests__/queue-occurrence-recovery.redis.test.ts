import { createHash, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AnswersQueue,
  ApprovalQueue,
  RetryPromotionConflictError,
  TaskQueue,
  type AnswersJob,
  type ApprovalJob,
  type ClaimedAnswersJob,
  type ClaimedApprovalJob,
  type ClaimedTaskJob,
  type TaskJob,
} from '@/worker/queue'
import {
  ClaimLeaseFence,
  ClaimLeaseLostError,
} from '@/worker/claim-lease-fence'

const QUEUE_KEYS = [
  'forge:tasks',
  'forge:tasks:processing',
  'forge:tasks:retry',
  'forge:tasks:dead',
  'forge:tasks:claims',
  'forge:tasks:ack-receipts',
  'forge:tasks:release-receipts',
  'forge:tasks:promotion-dispositions',
  'forge:tasks:promotion-disposition-expiry',
  'forge:approvals',
  'forge:approvals:processing',
  'forge:approvals:retry',
  'forge:approvals:dead',
  'forge:approvals:claims',
  'forge:approvals:ack-receipts',
  'forge:approvals:release-receipts',
  'forge:approvals:promotion-dispositions',
  'forge:approvals:promotion-disposition-expiry',
  'forge:answers',
  'forge:answers:processing',
  'forge:answers:retry',
  'forge:answers:dead',
  'forge:answers:claims',
  'forge:answers:ack-receipts',
  'forge:answers:release-receipts',
  'forge:answers:promotion-dispositions',
  'forge:answers:promotion-disposition-expiry',
] as const

const required = process.env.CI === 'true'
  || process.env.FORGE_QUEUE_REDIS_TEST_REQUIRED === '1'
const destructive = process.env.CI === 'true'
  || process.env.FORGE_QUEUE_REDIS_DESTRUCTIVE_TEST === '1'
const configuredUrl = process.env.FORGE_QUEUE_REDIS_TEST_URL
const redisUrl = configuredUrl ?? (process.env.CI === 'true'
  ? 'redis://localhost:6380/13'
  : undefined)

function validateRedisUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Queue Redis proof requires a valid dedicated Redis URL.')
  }
  if ((parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:')
    || parsed.search
    || parsed.hash
    || !/^\/[1-9][0-9]*$/.test(parsed.pathname)) {
    throw new Error('Queue Redis proof requires an unambiguous nonzero disposable database.')
  }
  const database = Number(parsed.pathname.slice(1))
  if (!Number.isSafeInteger(database) || database < 1) {
    throw new Error('Queue Redis proof requires an unambiguous nonzero disposable database.')
  }
  return value
}

if (required && (!destructive || !redisUrl)) {
  throw new Error('Mandatory queue Redis proof requires its dedicated URL and destructive-test opt-in.')
}

const enabled = Boolean(destructive && redisUrl)
const destructiveRedisUrl = enabled ? validateRedisUrl(redisUrl!) : null
const TASK_ID = '11111111-1111-4111-8111-111111111111'

// Frozen from web/worker/queue.ts at f589d99852441705b93e169ed3798064a6995891.
const HISTORICAL_PROMOTE_RETRY_V2_SCRIPT = `
-- forge:queue:promote-retry-v2

local function assert_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  if actual ~= 'none' and actual ~= expected then
    error('forge_queue_type_mismatch')
  end
end

assert_type(KEYS[1], 'zset')
assert_type(KEYS[2], 'list')
if redis.call('ZREM', KEYS[1], ARGV[1]) == 1 then
  redis.call('LPUSH', KEYS[2], ARGV[1])
  return 1
end
if redis.call('LPOS', KEYS[2], ARGV[1]) then
  return 2
end
return 0
`
const HISTORICAL_PROMOTE_RETRY_V2_SHA256 =
  '17e38f4e0bc247a2d25b801b3c46876cc84f5915c6c11a21d48ff34762c8905e'

type Occurrence = {
  schemaVersion: number
  occurrenceId: string
  job: TaskJob | ApprovalJob | AnswersJob
}

function parseOccurrence(raw: string): Occurrence {
  return JSON.parse(raw) as Occurrence
}

function occurrence(index: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    occurrenceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    job: { taskId: TASK_ID, attempt: 1 },
  })
}

function assertHistoricalV2Occurrence(raw: string): void {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Historical v2 retry occurrence is invalid.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Historical v2 retry occurrence is invalid.')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'job,occurrenceId,schemaVersion'
    || record.schemaVersion !== 1
    || typeof record.occurrenceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(record.occurrenceId)
    || typeof record.job !== 'object'
    || record.job === null
    || Array.isArray(record.job)
    || JSON.stringify(record) !== raw) {
    throw new Error('Historical v2 retry occurrence is invalid.')
  }
}

describe.skipIf(!enabled)('queue occurrence and recovery real Redis proof', () => {
  let admin: Redis
  const queues = new Set<{ disconnect: () => void }>()

  function queue(): TaskQueue {
    const created = new TaskQueue(destructiveRedisUrl!)
    queues.add(created)
    return created
  }

  function approvalQueue(): ApprovalQueue {
    const created = new ApprovalQueue(destructiveRedisUrl!)
    queues.add(created)
    return created
  }

  function answersQueue(): AnswersQueue {
    const created = new AnswersQueue(destructiveRedisUrl!)
    queues.add(created)
    return created
  }

  async function redisTimeMs(): Promise<number> {
    const reply = await admin.time()
    return (Number(reply[0]) * 1000) + Math.floor(Number(reply[1]) / 1000)
  }

  async function cleanOwnedDatabase(): Promise<void> {
    for (const active of queues) active.disconnect()
    queues.clear()
    const existing = await admin.exists(...QUEUE_KEYS)
    if (existing > 0) await admin.del(...QUEUE_KEYS)
    if (await admin.dbsize() !== 0) {
      throw new Error('Queue Redis proof cleanup did not restore the empty database.')
    }
  }

  beforeAll(async () => {
    admin = new Redis(destructiveRedisUrl!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    })
    await admin.connect()
    const version = /^redis_version:(\d+)/m.exec(await admin.info('server'))?.[1]
    if (!version || Number(version) < 7) {
      throw new Error('Queue Redis proof requires Redis major version 7 or newer.')
    }
    if (await admin.dbsize() !== 0) {
      throw new Error('Queue Redis proof requires an empty dedicated disposable database.')
    }
  })

  afterEach(async () => {
    await cleanOwnedDatabase()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  afterAll(async () => {
    try {
      await cleanOwnedDatabase()
    } finally {
      await admin?.quit()
    }
  })

  it('preserves two identical occurrences through recovery, retry, promotion, and dead letter', async () => {
    type RetryClockJob = TaskJob | ApprovalJob | AnswersJob
    type RetryClockQueue = {
      claim: (timeoutSeconds: number) => Promise<{
        job: RetryClockJob
        occurrenceId: string
        raw: string
      } | null>
      promoteDueRetries: (limit?: number) => Promise<number>
      recoverStuckJobs: (staleMs: number) => Promise<number>
      retry: (raw: string, job: RetryClockJob, delayMs: number) => Promise<{
        nextRetryAt: Date
        outcome: 'already_applied' | 'applied'
      }>
    }
    const retryClockCases = [
      {
        create: () => queue() as unknown as RetryClockQueue,
        job: (attempt: number): RetryClockJob => ({ taskId: TASK_ID, attempt }),
        processing: 'forge:tasks:processing',
        ready: 'forge:tasks',
        retry: 'forge:tasks:retry',
      },
      {
        create: () => approvalQueue() as unknown as RetryClockQueue,
        job: (attempt: number): RetryClockJob => ({
          taskId: TASK_ID,
          action: 'approve',
          attempt,
        }),
        processing: 'forge:approvals:processing',
        ready: 'forge:approvals',
        retry: 'forge:approvals:retry',
      },
      {
        create: () => answersQueue() as unknown as RetryClockQueue,
        job: (attempt: number): RetryClockJob => ({ taskId: TASK_ID, attempt }),
        processing: 'forge:answers:processing',
        ready: 'forge:answers',
        retry: 'forge:answers:retry',
      },
    ]
    const retryClockScenarios = [
      { delayMs: 0, loseResponse: false, workerSkewMs: 120_000 },
      { delayMs: 60_000, loseResponse: true, workerSkewMs: -120_000 },
    ] as const
    const dateNow = vi.spyOn(Date, 'now')

    try {
      for (const [caseIndex, queueCase] of retryClockCases.entries()) {
        for (const [scenarioIndex, scenario] of retryClockScenarios.entries()) {
          await admin.del(...QUEUE_KEYS)
          const job = queueCase.job(100 + (caseIndex * 10) + scenarioIndex)
          await admin.lpush(queueCase.ready, JSON.stringify(job))
          const retryQueue = queueCase.create()
          const claimed = await retryQueue.claim(1)
          if (!claimed) throw new Error('Queue Redis retry clock fixture was not claimed.')
          const retryClient = (retryQueue as unknown as { client: Redis }).client
          const originalCall = retryClient.call.bind(retryClient)
          let loseResponse = scenario.loseResponse
          const call = vi.spyOn(retryClient, 'call').mockImplementation(async (
            ...args: Parameters<Redis['call']>
          ) => {
            const result = await originalCall(...args)
            if (loseResponse && String(args[1]).includes('forge:queue:retry-v3')) {
              loseResponse = false
              throw new Error('simulated retry response loss')
            }
            return result
          })

          const redisBefore = await redisTimeMs()
          dateNow.mockReturnValue(redisBefore + scenario.workerSkewMs)
          if (scenario.loseResponse) {
            await expect(retryQueue.retry(claimed.raw, claimed.job, scenario.delayMs))
              .rejects.toThrow('Queue transition failed')
          }
          const retryResult = await retryQueue.retry(
            claimed.raw,
            claimed.job,
            scenario.delayMs,
          )
          const redisAfterApplied = await redisTimeMs()
          const scheduled = await admin.zrange(queueCase.retry, 0, -1, 'WITHSCORES')
          expect(scheduled).toHaveLength(2)
          const scheduledScore = Number(scheduled[1])
          expect(retryResult).toEqual({
            nextRetryAt: new Date(scheduledScore),
            outcome: scenario.loseResponse ? 'already_applied' : 'applied',
          })
          expect(retryResult.nextRetryAt.getTime()).toBe(scheduledScore)
          expect(scheduledScore).toBeGreaterThanOrEqual(redisBefore + scenario.delayMs)
          expect(scheduledScore).toBeLessThanOrEqual(redisAfterApplied + scenario.delayMs)

          const retryCalls = call.mock.calls.filter((args) =>
            String(args[1]).includes('forge:queue:retry-v3'))
          expect(retryCalls.at(-1)?.[9]).toBe(String(scenario.delayMs))
          const rawReply = await call.mock.results.at(-1)?.value
          expect(rawReply).toEqual([
            scenario.loseResponse ? 2 : 1,
            String(scheduledScore),
          ])

          if (scenario.delayMs === 60_000) {
            const scheduledMember = scheduled[0]
            if (!scheduledMember) {
              throw new Error('Queue Redis owned delayed retry member was not scheduled.')
            }
            await expect(retryQueue.promoteDueRetries()).resolves.toBe(0)
            expect(await admin.zscore(queueCase.retry, scheduledMember))
              .toBe(String(scheduledScore))

            const fixturePromotionTime = await redisTimeMs()
            await admin.zadd(queueCase.retry, fixturePromotionTime, scheduledMember)
            await expect(retryQueue.promoteDueRetries()).resolves.toBe(1)
            expect(await admin.zscore(queueCase.retry, scheduledMember)).toBeNull()
            expect(
              (await admin.lrange(queueCase.ready, 0, -1))
                .filter((raw) => raw === scheduledMember),
            ).toEqual([scheduledMember])
          }
        }

        await admin.del(...QUEUE_KEYS)
        const conflictJob = queueCase.job(130 + caseIndex)
        await admin.lpush(queueCase.ready, JSON.stringify(conflictJob))
        const conflictQueue = queueCase.create()
        const conflictClaim = await conflictQueue.claim(1)
        if (!conflictClaim) {
          throw new Error('Queue Redis retry destination conflict fixture was not claimed.')
        }
        const claimsKey = `${queueCase.processing.replace(/:processing$/, '')}:claims`
        const marker = await admin.hget(claimsKey, conflictClaim.occurrenceId)
        if (!marker) throw new Error('Queue Redis retry destination conflict marker is absent.')
        const exactDestination = JSON.stringify({
          schemaVersion: 1,
          occurrenceId: conflictClaim.occurrenceId,
          job: {
            ...conflictClaim.job,
            attempt: (conflictClaim.job.attempt ?? 1) + 1,
          },
        })
        const neighboringDestination = JSON.stringify({
          schemaVersion: 1,
          occurrenceId: `00000000-0000-4000-8000-${String(caseIndex + 901).padStart(12, '0')}`,
          job: {
            ...conflictClaim.job,
            attempt: (conflictClaim.job.attempt ?? 1) + 20,
          },
        })
        const exactDestinationScore = (await redisTimeMs()) + 60_000
        const neighboringDestinationScore = exactDestinationScore + 60_000
        await admin.zadd(
          queueCase.retry,
          exactDestinationScore,
          exactDestination,
          neighboringDestinationScore,
          neighboringDestination,
        )

        await expect(conflictQueue.retry(
          conflictClaim.raw,
          conflictClaim.job,
          60_000,
        )).rejects.toThrow('Queue transition stale_not_owner')
        expect(await admin.lrange(queueCase.processing, 0, -1))
          .toEqual([conflictClaim.raw])
        expect(await admin.hget(claimsKey, conflictClaim.occurrenceId)).toBe(marker)
        expect(await admin.zscore(queueCase.retry, exactDestination))
          .toBe(String(exactDestinationScore))
        expect(await admin.zscore(queueCase.retry, neighboringDestination))
          .toBe(String(neighboringDestinationScore))

        await admin.del(queueCase.retry)
        await admin.set(queueCase.retry, 'wrong-type-fixture')
        await expect(conflictQueue.retry(
          conflictClaim.raw,
          conflictClaim.job,
          60_000,
        )).rejects.toThrow('Queue transition failed')
        expect(await admin.lrange(queueCase.processing, 0, -1))
          .toEqual([conflictClaim.raw])
        expect(await admin.hget(claimsKey, conflictClaim.occurrenceId)).toBe(marker)
        expect(await admin.get(queueCase.retry)).toBe('wrong-type-fixture')

        await admin.del(queueCase.retry)
        await admin.zadd(
          queueCase.retry,
          neighboringDestinationScore,
          neighboringDestination,
        )
        const appliedAfterNeighbor = await conflictQueue.retry(
          conflictClaim.raw,
          conflictClaim.job,
          60_000,
        )
        const appliedDestinationScore = Number(
          await admin.zscore(queueCase.retry, exactDestination),
        )
        expect(appliedAfterNeighbor).toEqual({
          nextRetryAt: new Date(appliedDestinationScore),
          outcome: 'applied',
        })
        expect(await admin.zscore(queueCase.retry, neighboringDestination))
          .toBe(String(neighboringDestinationScore))

        await admin.del(...QUEUE_KEYS)
        const staleJob = queueCase.job(140 + caseIndex)
        await admin.lpush(queueCase.ready, JSON.stringify(staleJob))
        const staleOwner = queueCase.create()
        const staleClaim = await staleOwner.claim(1)
        if (!staleClaim) throw new Error('Queue Redis stale retry fixture was not claimed.')
        const staleClient = (staleOwner as unknown as { client: Redis }).client
        const staleCall = vi.spyOn(staleClient, 'call')
        const laterOwner = queueCase.create()
        await expect(laterOwner.recoverStuckJobs(0)).resolves.toBe(1)
        await expect(staleOwner.retry(staleClaim.raw, staleClaim.job, 60_000))
          .rejects.toThrow('Queue transition stale_not_owner')
        const rawStaleReply = await staleCall.mock.results.at(-1)?.value
        expect(rawStaleReply).toEqual([0, ''])
        expect(await admin.zcard(queueCase.retry)).toBe(0)
        expect(await admin.llen(queueCase.processing)).toBe(0)
      }
    } finally {
      dateNow.mockRestore()
    }

    await admin.del(...QUEUE_KEYS)
    const maxDateMs = 8_640_000_000_000_000
    const maxBoundaryQueue = queue()
    const maxBoundaryJob = { taskId: TASK_ID, attempt: 180 }
    await admin.lpush('forge:tasks', JSON.stringify(maxBoundaryJob))
    const maxBoundaryClaim = await maxBoundaryQueue.claim(1)
    if (!maxBoundaryClaim) throw new Error('Queue Redis maximum retry fixture was not claimed.')
    const redisBeforeBoundary = await redisTimeMs()
    const maxBoundaryHeadroomMs = 60_000
    const maxValidDelayMs = maxDateMs - redisBeforeBoundary - maxBoundaryHeadroomMs
    const maxBoundaryResult = await maxBoundaryQueue.retry(
      maxBoundaryClaim.raw,
      maxBoundaryClaim.job,
      maxValidDelayMs,
    )
    const [maxBoundaryMember] = await admin.zrange('forge:tasks:retry', 0, 0)
    if (!maxBoundaryMember) throw new Error('Queue Redis maximum retry was not scheduled.')
    const maxBoundaryScore = Number(await admin.zscore(
      'forge:tasks:retry',
      maxBoundaryMember,
    ))
    expect(maxBoundaryResult.nextRetryAt.getTime()).toBe(maxBoundaryScore)
    expect(maxBoundaryScore).toBeGreaterThanOrEqual(maxDateMs - maxBoundaryHeadroomMs)
    expect(maxBoundaryScore).toBeLessThanOrEqual(maxDateMs)

    await admin.del(...QUEUE_KEYS)
    const overflowQueue = queue()
    const overflowJob = { taskId: TASK_ID, attempt: 181 }
    await admin.lpush('forge:tasks', JSON.stringify(overflowJob))
    const overflowClaim = await overflowQueue.claim(1)
    if (!overflowClaim) throw new Error('Queue Redis overflowing retry fixture was not claimed.')
    await expect(overflowQueue.retry(overflowClaim.raw, overflowClaim.job, maxDateMs))
      .rejects.toThrow('Queue transition failed')
    expect(await admin.lrange('forge:tasks:processing', 0, -1)).toEqual([overflowClaim.raw])
    expect(await admin.zcard('forge:tasks:retry')).toBe(0)

    for (const invalidDelay of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(overflowQueue.retry('', overflowJob, invalidDelay))
        .rejects.toThrow('Queue retry delay must be a non-negative safe integer')
    }

    await admin.del(...QUEUE_KEYS)
    const taskQueue = queue()
    const legacy = JSON.stringify({ taskId: TASK_ID, attempt: 1 })
    await admin.rpush('forge:tasks', legacy, legacy)
    const first = await taskQueue.claim(1)
    const second = await taskQueue.claim(1)
    if (!first || !second) throw new Error('Queue Redis multiplicity proof could not claim both jobs.')
    expect(first.occurrenceId).not.toBe(second.occurrenceId)
    expect(await taskQueue.recoverStuckJobs(0, { drain: true })).toBe(2)
    const recovered = (await admin.lrange('forge:tasks', 0, -1)).map(parseOccurrence)
    expect(recovered).toHaveLength(2)
    expect(new Set(recovered.map((entry) => entry.occurrenceId))).toEqual(
      new Set([first.occurrenceId, second.occurrenceId]),
    )

    const retryFirst = await taskQueue.claim(1)
    const retrySecond = await taskQueue.claim(1)
    if (!retryFirst || !retrySecond) {
      throw new Error('Queue Redis multiplicity proof could not reclaim both jobs.')
    }
    await taskQueue.retry(retryFirst.raw, retryFirst.job, 0)
    await taskQueue.retry(retrySecond.raw, retrySecond.job, 0)
    expect(await admin.zcard('forge:tasks:retry')).toBe(2)
    expect(await taskQueue.promoteDueRetries()).toBe(2)
    const promoted = (await admin.lrange('forge:tasks', 0, -1)).map(parseOccurrence)
    expect(promoted).toHaveLength(2)
    expect(new Set(promoted.map((entry) => entry.occurrenceId))).toEqual(
      new Set([first.occurrenceId, second.occurrenceId]),
    )

    const deadFirst = await taskQueue.claim(1)
    const deadSecond = await taskQueue.claim(1)
    if (!deadFirst || !deadSecond) {
      throw new Error('Queue Redis multiplicity proof could not claim dead-letter jobs.')
    }
    await taskQueue.deadLetter(deadFirst.raw, deadFirst.job)
    await taskQueue.deadLetter(deadSecond.raw, deadSecond.job)
    const dead = (await admin.lrange('forge:tasks:dead', 0, -1))
      .map((raw) => JSON.parse(raw) as { occurrenceId: string })
    expect(dead).toHaveLength(2)
    expect(new Set(dead.map((entry) => entry.occurrenceId))).toEqual(
      new Set([first.occurrenceId, second.occurrenceId]),
    )

    await admin.del(...QUEUE_KEYS)
    expect(await admin.dbsize()).toBe(0)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = await redisTimeMs()
    const retryUpgradeCases = [
      {
        currentJob: { taskId: TASK_ID, attempt: 5 },
        legacyJob: { taskId: TASK_ID, attempt: 4 },
        queue: queue(),
        ready: 'forge:tasks',
        retry: 'forge:tasks:retry',
      },
      {
        currentJob: { taskId: TASK_ID, action: 'approve' as const, attempt: 7 },
        legacyJob: { taskId: TASK_ID, action: 'approve' as const, attempt: 6 },
        queue: approvalQueue(),
        ready: 'forge:approvals',
        retry: 'forge:approvals:retry',
      },
      {
        currentJob: { taskId: TASK_ID, attempt: 9 },
        legacyJob: { taskId: TASK_ID, attempt: 8 },
        queue: answersQueue(),
        ready: 'forge:answers',
        retry: 'forge:answers:retry',
      },
    ]
    const poisons: string[] = []
    for (const [index, queueCase] of retryUpgradeCases.entries()) {
      const poison = JSON.stringify({
        taskId: TASK_ID,
        attempt: 1,
        prompt: `RETRY_POISON_SENTINEL_${index}_/private/token`,
      })
      poisons.push(poison)
      const legacyRetry = JSON.stringify(queueCase.legacyJob)
      const currentOccurrenceId = `00000000-0000-4000-8000-${String(800 + index)
        .padStart(12, '0')}`
      const currentRetry = JSON.stringify({
        schemaVersion: 1,
        occurrenceId: currentOccurrenceId,
        job: queueCase.currentJob,
      })
      await admin.zadd(
        queueCase.retry,
        now - 3,
        poison,
        now - 2,
        legacyRetry,
        now - 1,
        currentRetry,
      )

      expect(await queueCase.queue.promoteDueRetries(10)).toBe(2)
      expect(await admin.zcard(queueCase.retry)).toBe(0)
      const ready = (await admin.lrange(queueCase.ready, 0, -1)).map(parseOccurrence)
      expect(ready).toHaveLength(2)
      expect(ready.map((entry) => entry.job)).toEqual(
        expect.arrayContaining([queueCase.legacyJob, queueCase.currentJob]),
      )
      expect(ready.find((entry) => entry.occurrenceId === currentOccurrenceId)?.job)
        .toEqual(queueCase.currentJob)
      const upgraded = ready.find((entry) => entry.occurrenceId !== currentOccurrenceId)
      expect(upgraded?.occurrenceId).toMatch(/^[0-9a-f-]{36}$/)
      expect(upgraded?.job).toEqual(queueCase.legacyJob)
      for (const entry of ready) {
        expect(Object.keys(entry).sort()).toEqual(['job', 'occurrenceId', 'schemaVersion'])
      }
    }

    expect(warn.mock.calls).toEqual(retryUpgradeCases.map(() => [
      '[worker/queue] Dropped invalid retry payload',
    ]))
    const persistedQueueValues: string[] = []
    for (const key of QUEUE_KEYS) {
      const type = await admin.type(key)
      if (type === 'list') persistedQueueValues.push(...await admin.lrange(key, 0, -1))
      if (type === 'zset') persistedQueueValues.push(...await admin.zrange(key, 0, -1))
      if (type === 'hash') persistedQueueValues.push(...Object.values(await admin.hgetall(key)))
    }
    for (const poison of poisons) {
      expect(persistedQueueValues.some((value) => value.includes(poison))).toBe(false)
      expect(JSON.stringify(warn.mock.calls)).not.toContain(poison)
    }

    await admin.del(...QUEUE_KEYS)
    warn.mockClear()
    const contentionCases = [
      {
        create: queue,
        job: { taskId: TASK_ID, attempt: 13 },
        ready: 'forge:tasks',
        receipts: 'forge:tasks:promotion-dispositions',
        receiptExpiry: 'forge:tasks:promotion-disposition-expiry',
        retry: 'forge:tasks:retry',
      },
      {
        create: approvalQueue,
        job: { taskId: TASK_ID, action: 'approve' as const, attempt: 14 },
        ready: 'forge:approvals',
        receipts: 'forge:approvals:promotion-dispositions',
        receiptExpiry: 'forge:approvals:promotion-disposition-expiry',
        retry: 'forge:approvals:retry',
      },
      {
        create: answersQueue,
        job: { taskId: TASK_ID, attempt: 15 },
        ready: 'forge:answers',
        receipts: 'forge:answers:promotion-dispositions',
        receiptExpiry: 'forge:answers:promotion-disposition-expiry',
        retry: 'forge:answers:retry',
      },
    ]
    for (const [caseIndex, queueCase] of contentionCases.entries()) {
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
        { kind: 'legacy', raw: JSON.stringify(queueCase.job) },
        {
          kind: 'poison',
          raw: JSON.stringify({
            ...queueCase.job,
            prompt: `RETRY_CONTENTION_POISON_${caseIndex}`,
          }),
        },
      ] as const

      for (const [scenarioIndex, scenario] of scenarios.entries()) {
        await admin.del(
          queueCase.ready,
          queueCase.retry,
          queueCase.receipts,
          queueCase.receiptExpiry,
        )
        const score = (await redisTimeMs()) - 10 - scenarioIndex
        await admin.zadd(queueCase.retry, score, scenario.raw)
        const first = queueCase.create()
        const second = queueCase.create()
        const firstClient = (first as unknown as { client: Redis }).client
        const secondClient = (second as unknown as { client: Redis }).client
        const firstCall = vi.spyOn(firstClient, 'call')
        const secondCall = vi.spyOn(secondClient, 'call')
        let scanCount = 0
        let releaseScan!: () => void
        const scanBarrier = new Promise<void>((resolve) => {
          releaseScan = resolve
        })
        for (const client of [firstClient, secondClient]) {
          const originalCallBuffer = client.callBuffer.bind(client)
          vi.spyOn(client, 'callBuffer').mockImplementation(async (
            ...args: Parameters<Redis['callBuffer']>
          ) => {
            const result = await originalCallBuffer(...args)
            if (String(args[1]).includes('forge:queue:list-due-retries-v1')) {
              scanCount += 1
              if (scanCount === 2) releaseScan()
              await scanBarrier
            }
            return result
          })
        }

        const results = await Promise.all([
          first.promoteDueRetries(1),
          second.promoteDueRetries(1),
        ])
        expect([...results].sort()).toEqual(scenario.kind === 'poison' ? [0, 0] : [0, 1])
        expect(await admin.zcard(queueCase.retry)).toBe(0)
        expect(await admin.llen(queueCase.ready)).toBe(scenario.kind === 'poison' ? 0 : 1)
        expect(await admin.hlen(queueCase.receipts)).toBe(1)
        expect(await admin.zcard(queueCase.receiptExpiry)).toBe(1)

        const promotions = [firstCall, secondCall].map((call) => {
          const callIndex = call.mock.calls.findIndex((args) =>
            String(args[1]).includes('forge:queue:promote-retry-v4'))
          if (callIndex < 0) {
            throw new Error('Queue Redis contention proof did not execute promotion.')
          }
          return {
            args: call.mock.calls[callIndex],
            result: call.mock.results[callIndex].value as Promise<unknown>,
          }
        })
        expect(String(promotions[0].args[9])).toBe(String(promotions[1].args[9]))
        expect(String(promotions[0].args[8])).toBe(String(promotions[1].args[8]))
        const rawOutcomes = await Promise.all(promotions.map(({ result }) => result))
        expect(rawOutcomes.map((raw) => Number((raw as unknown[])[0])).sort()).toEqual([1, 2])
        if (scenario.kind === 'legacy') {
          expect(String(promotions[0].args[12])).not.toBe(String(promotions[1].args[12]))
          const [winningRaw] = await admin.lrange(queueCase.ready, 0, -1)
          const winningOccurrenceId = parseOccurrence(winningRaw).occurrenceId
          expect(Object.values(await admin.hgetall(queueCase.receipts)))
            .toEqual([`promoted:${winningOccurrenceId}`])
        } else if (scenario.kind === 'current') {
          expect(parseOccurrence((await admin.lrange(queueCase.ready, 0, -1))[0]).occurrenceId)
            .toBe(currentOccurrenceId)
          expect(Object.values(await admin.hgetall(queueCase.receipts)))
            .toEqual([`promoted:${currentOccurrenceId}`])
        } else {
          expect(Object.values(await admin.hgetall(queueCase.receipts))).toEqual(['discarded'])
        }
      }
    }
    expect(warn).toHaveBeenCalledTimes(contentionCases.length)

    const dumpRedisValue = async (key: string): Promise<Buffer> => {
      const value = await admin.callBuffer('DUMP', key)
      if (!Buffer.isBuffer(value)) {
        throw new Error('Queue Redis receipt proof could not fingerprint owned state.')
      }
      return value
    }
    for (const [caseIndex, queueCase] of contentionCases.entries()) {
      const candidateOccurrenceId = `00000000-0000-4000-8000-${String(1_300 + caseIndex)
        .padStart(12, '0')}`
      const mismatchedOccurrenceId = `00000000-0000-4000-8000-${String(1_400 + caseIndex)
        .padStart(12, '0')}`
      for (const mismatch of [true, false]) {
        await admin.del(
          queueCase.ready,
          queueCase.retry,
          queueCase.receipts,
          queueCase.receiptExpiry,
        )
        const raw = JSON.stringify({
          schemaVersion: 1,
          occurrenceId: candidateOccurrenceId,
          job: queueCase.job,
        })
        await admin.zadd(queueCase.retry, (await redisTimeMs()) - 1, raw)
        const receiptQueue = queueCase.create()
        const receiptClient = (receiptQueue as unknown as { client: Redis }).client
        const originalBuffer = receiptClient.callBuffer.bind(receiptClient)
        let removeScannedSource = true
        vi.spyOn(receiptClient, 'callBuffer').mockImplementation(async (
          ...args: Parameters<Redis['callBuffer']>
        ) => {
          const result = await originalBuffer(...args)
          if (removeScannedSource
            && String(args[1]).includes('forge:queue:list-due-retries-v1')) {
            removeScannedSource = false
            await admin.zrem(queueCase.retry, raw)
          }
          return result
        })
        const originalCall = receiptClient.call.bind(receiptClient)
        let fingerprint = ''
        let receiptHashBefore: Buffer | undefined
        let receiptExpiryBefore: Buffer | undefined
        vi.spyOn(receiptClient, 'call').mockImplementation(async (
          ...args: Parameters<Redis['call']>
        ) => {
          if (String(args[1]).includes('forge:queue:promote-retry-v4')) {
            fingerprint = String(args[9])
            expect(String(args[10])).toBe('occurrence')
            expect(String(args[12])).toBe(candidateOccurrenceId)
            const winner = mismatch ? mismatchedOccurrenceId : candidateOccurrenceId
            await admin.hset(queueCase.receipts, fingerprint, `promoted:${winner}`)
            await admin.zadd(queueCase.receiptExpiry, (await redisTimeMs()) - 1, fingerprint)
            if (!mismatch) await admin.lpush(queueCase.ready, raw)
            receiptHashBefore = await dumpRedisValue(queueCase.receipts)
            receiptExpiryBefore = await dumpRedisValue(queueCase.receiptExpiry)
          }
          return await originalCall(...args)
        })

        if (mismatch) {
          let failure: unknown
          try {
            await receiptQueue.promoteDueRetries(1)
          } catch (error) {
            failure = error
          }
          expect(failure).toBeInstanceOf(Error)
          expect((failure as Error).message)
            .toBe('Queue retry promotion receipt integrity failure')
          expect(failure).not.toBeInstanceOf(RetryPromotionConflictError)
        } else {
          await expect(receiptQueue.promoteDueRetries(1)).resolves.toBe(0)
        }

        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(receiptHashBefore).toBeDefined()
        expect(receiptExpiryBefore).toBeDefined()
        expect((await dumpRedisValue(queueCase.receipts)).equals(receiptHashBefore!)).toBe(true)
        expect((await dumpRedisValue(queueCase.receiptExpiry)).equals(receiptExpiryBefore!))
          .toBe(true)
        expect(await admin.zcard(queueCase.retry)).toBe(0)
        expect(await admin.lrange(queueCase.ready, 0, -1))
          .toEqual(mismatch ? [] : [raw])
      }
    }

    await admin.del(...QUEUE_KEYS)
    const lostResponseRaw = JSON.stringify({ taskId: TASK_ID, attempt: 16 })
    await admin.zadd('forge:tasks:retry', (await redisTimeMs()) - 1, lostResponseRaw)
    const lostResponseFirst = queue()
    const lostResponseSecond = queue()
    const lostFirstClient = (lostResponseFirst as unknown as { client: Redis }).client
    const lostSecondClient = (lostResponseSecond as unknown as { client: Redis }).client
    const originalLostFirstCall = lostFirstClient.call.bind(lostFirstClient)
    const originalLostSecondCall = lostSecondClient.call.bind(lostSecondClient)
    let firstTransitionApplied!: () => void
    const firstTransition = new Promise<void>((resolve) => {
      firstTransitionApplied = resolve
    })
    vi.spyOn(lostFirstClient, 'call').mockImplementation(async (
      ...args: Parameters<Redis['call']>
    ) => {
      const result = await originalLostFirstCall(...args)
      if (String(args[1]).includes('forge:queue:promote-retry-v4')) {
        firstTransitionApplied()
        throw new Error('simulated promotion response loss')
      }
      return result
    })
    let replayTransition: unknown
    vi.spyOn(lostSecondClient, 'call').mockImplementation(async (
      ...args: Parameters<Redis['call']>
    ) => {
      if (String(args[1]).includes('forge:queue:promote-retry-v4')) {
        await firstTransition
      }
      const result = await originalLostSecondCall(...args)
      if (String(args[1]).includes('forge:queue:promote-retry-v4')) {
        replayTransition = result
      }
      return result
    })
    let lostScanCount = 0
    let releaseLostScans!: () => void
    const lostScanBarrier = new Promise<void>((resolve) => {
      releaseLostScans = resolve
    })
    for (const client of [lostFirstClient, lostSecondClient]) {
      const originalCallBuffer = client.callBuffer.bind(client)
      vi.spyOn(client, 'callBuffer').mockImplementation(async (
        ...args: Parameters<Redis['callBuffer']>
      ) => {
        const result = await originalCallBuffer(...args)
        if (String(args[1]).includes('forge:queue:list-due-retries-v1')) {
          lostScanCount += 1
          if (lostScanCount === 2) releaseLostScans()
          await lostScanBarrier
        }
        return result
      })
    }
    const lostResponseResults = await Promise.allSettled([
      lostResponseFirst.promoteDueRetries(1),
      lostResponseSecond.promoteDueRetries(1),
    ])
    expect(lostResponseResults[0]).toMatchObject({
      reason: expect.objectContaining({ message: 'Queue retry promotion failed' }),
      status: 'rejected',
    })
    expect(lostResponseResults[1]).toEqual({ status: 'fulfilled', value: 0 })
    expect(replayTransition).toEqual([2, 'promoted', expect.stringMatching(/^[0-9a-f-]{36}$/)])
    expect(await admin.zcard('forge:tasks:retry')).toBe(0)
    expect(await admin.llen('forge:tasks')).toBe(1)
    expect(await admin.hlen('forge:tasks:promotion-dispositions')).toBe(1)

    await admin.del(...QUEUE_KEYS)
    const ownershipQueue = queue()
    const ownershipClient = (ownershipQueue as unknown as { client: Redis }).client
    const ownershipRaw = JSON.stringify({ taskId: TASK_ID, attempt: 17 })
    const ownershipScore = (await redisTimeMs()) - 1
    await admin.zadd('forge:tasks:retry', ownershipScore, ownershipRaw)
    const ownershipExpiredFingerprint = '8'.repeat(64)
    const ownershipLiveFingerprint = '9'.repeat(64)
    const ownershipReceiptTime = await redisTimeMs()
    await admin.hset(
      'forge:tasks:promotion-dispositions',
      ownershipExpiredFingerprint,
      'discarded',
      ownershipLiveFingerprint,
      `promoted:${randomUUID()}`,
    )
    await admin.zadd(
      'forge:tasks:promotion-disposition-expiry',
      ownershipReceiptTime - (16 * 60 * 1000),
      ownershipExpiredFingerprint,
      ownershipReceiptTime - 1,
      ownershipLiveFingerprint,
    )
    const originalOwnershipBuffer = ownershipClient.callBuffer.bind(ownershipClient)
    let mutateScore = true
    vi.spyOn(ownershipClient, 'callBuffer').mockImplementation(async (
      ...args: Parameters<Redis['callBuffer']>
    ) => {
      const result = await originalOwnershipBuffer(...args)
      if (mutateScore && String(args[1]).includes('forge:queue:list-due-retries-v1')) {
        mutateScore = false
        await admin.zadd('forge:tasks:retry', ownershipScore + 1, ownershipRaw)
      }
      return result
    })
    await expect(ownershipQueue.promoteDueRetries(1))
      .rejects.toBeInstanceOf(RetryPromotionConflictError)
    expect(await admin.zscore('forge:tasks:retry', ownershipRaw))
      .toBe(String(ownershipScore + 1))
    expect(await admin.llen('forge:tasks')).toBe(0)
    expect(await admin.hgetall('forge:tasks:promotion-dispositions')).toEqual({
      [ownershipExpiredFingerprint]: 'discarded',
      [ownershipLiveFingerprint]: expect.stringMatching(/^promoted:[0-9a-f-]{36}$/),
    })
    expect(await admin.zrange(
      'forge:tasks:promotion-disposition-expiry',
      0,
      -1,
    )).toEqual([ownershipExpiredFingerprint, ownershipLiveFingerprint])

    await admin.del(...QUEUE_KEYS)
    const unrelatedQueue = queue()
    const unrelatedClient = (unrelatedQueue as unknown as { client: Redis }).client
    const unrelatedRaw = JSON.stringify({ taskId: TASK_ID, attempt: 18 })
    await admin.zadd('forge:tasks:retry', (await redisTimeMs()) - 1, unrelatedRaw)
    const originalUnrelatedBuffer = unrelatedClient.callBuffer.bind(unrelatedClient)
    let removeSource = true
    vi.spyOn(unrelatedClient, 'callBuffer').mockImplementation(async (
      ...args: Parameters<Redis['callBuffer']>
    ) => {
      const result = await originalUnrelatedBuffer(...args)
      if (removeSource && String(args[1]).includes('forge:queue:list-due-retries-v1')) {
        removeSource = false
        await admin.zrem('forge:tasks:retry', unrelatedRaw)
        await admin.hset(
          'forge:tasks:promotion-dispositions',
          'a'.repeat(64),
          `promoted:${randomUUID()}`,
        )
      }
      return result
    })
    await expect(unrelatedQueue.promoteDueRetries(1))
      .rejects.toBeInstanceOf(RetryPromotionConflictError)
    expect(await admin.llen('forge:tasks')).toBe(0)

    await admin.del(...QUEUE_KEYS)
    const capacityQueue = queue()
    const capacityClient = (capacityQueue as unknown as { client: Redis }).client
    const capacityRaw = JSON.stringify({ taskId: TASK_ID, attempt: 19 })
    await admin.zadd('forge:tasks:retry', (await redisTimeMs()) - 1, capacityRaw)
    await admin.hset('forge:tasks:promotion-dispositions', 'b'.repeat(64), 'discarded')
    await admin.zadd(
      'forge:tasks:promotion-disposition-expiry',
      await redisTimeMs(),
      'b'.repeat(64),
    )
    const originalCapacityCall = capacityClient.call.bind(capacityClient)
    vi.spyOn(capacityClient, 'call').mockImplementation(async (
      ...args: Parameters<Redis['call']>
    ) => {
      if (String(args[1]).includes('forge:queue:promote-retry-v4')) {
        args[14] = '1'
      }
      return await originalCapacityCall(...args)
    })
    await expect(capacityQueue.promoteDueRetries(1))
      .rejects.toThrow('Queue retry promotion failed')
    expect(await admin.zscore('forge:tasks:retry', capacityRaw)).not.toBeNull()
    expect(await admin.llen('forge:tasks')).toBe(0)

    await admin.del(...QUEUE_KEYS)
    const pruningQueue = queue()
    const pruningClient = (pruningQueue as unknown as { client: Redis }).client
    const pruningRaw = JSON.stringify({ taskId: TASK_ID, attempt: 20 })
    const pruningNow = await redisTimeMs()
    await admin.zadd('forge:tasks:retry', pruningNow - 1, pruningRaw)
    await admin.hset('forge:tasks:promotion-dispositions', 'c'.repeat(64), 'discarded')
    await admin.zadd(
      'forge:tasks:promotion-disposition-expiry',
      pruningNow - (16 * 60 * 1000),
      'c'.repeat(64),
    )
    const originalPruningCall = pruningClient.call.bind(pruningClient)
    vi.spyOn(pruningClient, 'call').mockImplementation(async (
      ...args: Parameters<Redis['call']>
    ) => {
      if (String(args[1]).includes('forge:queue:promote-retry-v4')) {
        args[14] = '1'
      }
      return await originalPruningCall(...args)
    })
    await expect(pruningQueue.promoteDueRetries(1)).resolves.toBe(1)
    expect(await admin.hexists('forge:tasks:promotion-dispositions', 'c'.repeat(64))).toBe(0)
    expect(await admin.zscore('forge:tasks:promotion-disposition-expiry', 'c'.repeat(64)))
      .toBeNull()
    expect(await admin.hlen('forge:tasks:promotion-dispositions')).toBe(1)
    expect(await admin.zcard('forge:tasks:promotion-disposition-expiry')).toBe(1)

    const dispositionKey = 'forge:tasks:promotion-dispositions'
    const dispositionExpiryKey = 'forge:tasks:promotion-disposition-expiry'
    const receiptTtlMs = 15 * 60 * 1000
    const receiptWinner = '00000000-0000-4000-8000-000000001200'
    const exerciseReceiptAuthority = async (options: {
      attempt: number
      expectReplay?: boolean
      sourcePresent?: boolean
      setup: (fingerprint: string, nowMs: number) => Promise<void>
      verify: (fingerprint: string, raw: string) => Promise<void>
    }): Promise<void> => {
      await admin.del(...QUEUE_KEYS)
      const raw = JSON.stringify({ taskId: TASK_ID, attempt: options.attempt })
      await admin.zadd('forge:tasks:retry', (await redisTimeMs()) - 1, raw)
      const receiptQueue = queue()
      const receiptClient = (receiptQueue as unknown as { client: Redis }).client
      const originalBuffer = receiptClient.callBuffer.bind(receiptClient)
      let removeScannedSource = !options.sourcePresent
      vi.spyOn(receiptClient, 'callBuffer').mockImplementation(async (
        ...args: Parameters<Redis['callBuffer']>
      ) => {
        const result = await originalBuffer(...args)
        if (removeScannedSource
          && String(args[1]).includes('forge:queue:list-due-retries-v1')) {
          removeScannedSource = false
          await admin.zrem('forge:tasks:retry', raw)
        }
        return result
      })
      const originalCall = receiptClient.call.bind(receiptClient)
      let fingerprint = ''
      vi.spyOn(receiptClient, 'call').mockImplementation(async (
        ...args: Parameters<Redis['call']>
      ) => {
        if (String(args[1]).includes('forge:queue:promote-retry-v4')) {
          fingerprint = String(args[9])
          await options.setup(fingerprint, await redisTimeMs())
        }
        return await originalCall(...args)
      })

      if (options.expectReplay) {
        await expect(receiptQueue.promoteDueRetries(1)).resolves.toBe(0)
      } else {
        await expect(receiptQueue.promoteDueRetries(1))
          .rejects.toThrow('Queue retry promotion receipt integrity failure')
      }
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
      await options.verify(fingerprint, raw)
    }

    await exerciseReceiptAuthority({
      attempt: 21,
      expectReplay: true,
      setup: async (fingerprint, nowMs) => {
        await admin.hset(dispositionKey, fingerprint, `promoted:${receiptWinner}`)
        await admin.zadd(dispositionExpiryKey, nowMs - receiptTtlMs + 60_000, fingerprint)
      },
      verify: async (fingerprint) => {
        expect(await admin.hget(dispositionKey, fingerprint))
          .toBe(`promoted:${receiptWinner}`)
        expect(await admin.zscore(dispositionExpiryKey, fingerprint)).not.toBeNull()
      },
    })

    const receiptNeighbor = 'd'.repeat(64)
    await exerciseReceiptAuthority({
      attempt: 22,
      setup: async (fingerprint, nowMs) => {
        const expiredPairs: string[] = []
        for (let index = 0; index < 100; index += 1) {
          const older = index.toString(16).padStart(64, '0')
          expiredPairs.push(older, 'discarded')
          await admin.zadd(
            dispositionExpiryKey,
            nowMs - receiptTtlMs - 2_000 - index,
            older,
          )
        }
        await admin.hset(dispositionKey, ...expiredPairs)
        await admin.hset(dispositionKey, fingerprint, `promoted:${receiptWinner}`)
        await admin.zadd(
          dispositionExpiryKey,
          nowMs - receiptTtlMs - 1_000,
          fingerprint,
        )
        await admin.hset(dispositionKey, receiptNeighbor, 'discarded')
        await admin.zadd(dispositionExpiryKey, nowMs - 1, receiptNeighbor)
      },
      verify: async (fingerprint) => {
        expect(await admin.hexists(dispositionKey, fingerprint)).toBe(0)
        expect(await admin.zscore(dispositionExpiryKey, fingerprint)).toBeNull()
        expect(await admin.hget(dispositionKey, receiptNeighbor)).toBe('discarded')
        expect(await admin.zscore(dispositionExpiryKey, receiptNeighbor)).not.toBeNull()
      },
    })

    const authorityCases = [
      {
        attempt: 23,
        setup: async (fingerprint: string) => {
          await admin.hset(dispositionKey, fingerprint, `promoted:${receiptWinner}`)
        },
      },
      {
        attempt: 24,
        setup: async (fingerprint: string, nowMs: number) => {
          await admin.zadd(dispositionExpiryKey, nowMs - 1, fingerprint)
        },
      },
      {
        attempt: 25,
        setup: async (fingerprint: string, nowMs: number) => {
          await admin.hset(dispositionKey, fingerprint, 'unknown')
          await admin.zadd(dispositionExpiryKey, nowMs - 1, fingerprint)
        },
      },
      {
        attempt: 26,
        setup: async (fingerprint: string, nowMs: number) => {
          await admin.hset(dispositionKey, fingerprint, 'promoted:not-a-uuid')
          await admin.zadd(dispositionExpiryKey, nowMs - 1, fingerprint)
        },
      },
      {
        attempt: 27,
        setup: async (fingerprint: string, nowMs: number) => {
          await admin.hset(dispositionKey, fingerprint, 'discarded')
          await admin.zadd(dispositionExpiryKey, nowMs + 60_000, fingerprint)
        },
      },
      {
        attempt: 28,
        setup: async (fingerprint: string) => {
          await admin.hset(dispositionKey, fingerprint, 'discarded')
          await admin.zadd(dispositionExpiryKey, '+inf', fingerprint)
        },
      },
    ]
    for (const authorityCase of authorityCases) {
      await exerciseReceiptAuthority({
        ...authorityCase,
        verify: async (fingerprint) => {
          expect(await admin.hexists(dispositionKey, fingerprint)).toBe(0)
          expect(await admin.zscore(dispositionExpiryKey, fingerprint)).toBeNull()
        },
      })
    }

    await exerciseReceiptAuthority({
      attempt: 29,
      sourcePresent: true,
      setup: async (fingerprint, nowMs) => {
        await admin.hset(dispositionKey, fingerprint, `promoted:${receiptWinner}`)
        await admin.zadd(dispositionExpiryKey, nowMs - 1, fingerprint)
      },
      verify: async (fingerprint, raw) => {
        expect(await admin.zscore('forge:tasks:retry', raw)).not.toBeNull()
        expect(await admin.hget(dispositionKey, fingerprint))
          .toBe(`promoted:${receiptWinner}`)
        expect(await admin.zscore(dispositionExpiryKey, fingerprint)).not.toBeNull()
      },
    })

    expect(createHash('sha256').update(HISTORICAL_PROMOTE_RETRY_V2_SCRIPT).digest('hex'))
      .toBe(HISTORICAL_PROMOTE_RETRY_V2_SHA256)
    const mixedVersionCases = [
      {
        create: () => queue(),
        family: [
          'forge:tasks',
          'forge:tasks:processing',
          'forge:tasks:retry',
          'forge:tasks:dead',
          'forge:tasks:claims',
          'forge:tasks:ack-receipts',
          'forge:tasks:release-receipts',
          'forge:tasks:promotion-dispositions',
          'forge:tasks:promotion-disposition-expiry',
        ],
        job: (attempt: number): TaskJob => ({ taskId: TASK_ID, attempt }),
        ready: 'forge:tasks',
        receiptExpiry: 'forge:tasks:promotion-disposition-expiry',
        receipts: 'forge:tasks:promotion-dispositions',
        retry: 'forge:tasks:retry',
      },
      {
        create: () => approvalQueue(),
        family: [
          'forge:approvals',
          'forge:approvals:processing',
          'forge:approvals:retry',
          'forge:approvals:dead',
          'forge:approvals:claims',
          'forge:approvals:ack-receipts',
          'forge:approvals:release-receipts',
          'forge:approvals:promotion-dispositions',
          'forge:approvals:promotion-disposition-expiry',
        ],
        job: (attempt: number): ApprovalJob => ({
          taskId: TASK_ID,
          action: 'approve',
          attempt,
        }),
        ready: 'forge:approvals',
        receiptExpiry: 'forge:approvals:promotion-disposition-expiry',
        receipts: 'forge:approvals:promotion-dispositions',
        retry: 'forge:approvals:retry',
      },
      {
        create: () => answersQueue(),
        family: [
          'forge:answers',
          'forge:answers:processing',
          'forge:answers:retry',
          'forge:answers:dead',
          'forge:answers:claims',
          'forge:answers:ack-receipts',
          'forge:answers:release-receipts',
          'forge:answers:promotion-dispositions',
          'forge:answers:promotion-disposition-expiry',
        ],
        job: (attempt: number): AnswersJob => ({ taskId: TASK_ID, attempt }),
        ready: 'forge:answers',
        receiptExpiry: 'forge:answers:promotion-disposition-expiry',
        receipts: 'forge:answers:promotion-dispositions',
        retry: 'forge:answers:retry',
      },
    ] as const
    let historicalLuaCalls = 0
    const runHistoricalV2Promotion = async (
      retryKey: string,
      readyKey: string,
      raw: string,
    ): Promise<number> => {
      assertHistoricalV2Occurrence(raw)
      historicalLuaCalls += 1
      return Number(await admin.eval(
        HISTORICAL_PROMOTE_RETRY_V2_SCRIPT,
        2,
        retryKey,
        readyKey,
        raw,
      ))
    }
    const mixedState = async (queueCase: typeof mixedVersionCases[number]) => {
      const family = Object.fromEntries(await Promise.all(queueCase.family.map(async (key) => {
        const dump = await admin.callBuffer('DUMP', key)
        if (dump !== null && !Buffer.isBuffer(dump)) {
          throw new Error('Queue Redis mixed-version proof received a non-binary key dump.')
        }
        return [key, dump?.toString('hex') ?? null]
      })))
      return {
        family,
        ready: await admin.lrange(queueCase.ready, 0, -1),
        receiptExpiry: await admin.zrange(
          queueCase.receiptExpiry,
          0,
          -1,
          'WITHSCORES',
        ),
        receipts: await admin.hgetall(queueCase.receipts),
        retry: await admin.zrange(queueCase.retry, 0, -1, 'WITHSCORES'),
      }
    }

    for (const [caseIndex, queueCase] of mixedVersionCases.entries()) {
      await admin.del(...QUEUE_KEYS)
      const expiredFingerprint = String(caseIndex + 1).repeat(64)
      const liveFingerprint = String(caseIndex + 4).repeat(64)
      const liveOccurrenceId =
        `00000000-0000-4000-8000-${String(1_500 + caseIndex).padStart(12, '0')}`
      const receiptSeedTime = await redisTimeMs()
      await admin.hset(
        queueCase.receipts,
        expiredFingerprint,
        'discarded',
        liveFingerprint,
        `promoted:${liveOccurrenceId}`,
      )
      await admin.zadd(
        queueCase.receiptExpiry,
        receiptSeedTime - (16 * 60 * 1000),
        expiredFingerprint,
        receiptSeedTime - 1,
        liveFingerprint,
      )
      const v2FirstRaw = JSON.stringify({
        schemaVersion: 1,
        occurrenceId: `00000000-0000-4000-8000-${String(1_300 + caseIndex).padStart(12, '0')}`,
        job: queueCase.job(40 + caseIndex),
      })
      await admin.zadd(queueCase.retry, (await redisTimeMs()) - 1, v2FirstRaw)
      const upgradedLoser = queueCase.create()
      const upgradedClient = (upgradedLoser as unknown as { client: Redis }).client
      const originalBuffer = upgradedClient.callBuffer.bind(upgradedClient)
      let scanned!: () => void
      let release!: () => void
      const scanObserved = new Promise<void>((resolve) => {
        scanned = resolve
      })
      const releaseUpgraded = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.spyOn(upgradedClient, 'callBuffer').mockImplementation(async (
        ...args: Parameters<Redis['callBuffer']>
      ) => {
        const result = await originalBuffer(...args)
        if (String(args[1]).includes('forge:queue:list-due-retries-v1')) {
          scanned()
          await releaseUpgraded
        }
        return result
      })
      const upgradedAttempt = upgradedLoser.promoteDueRetries(1)
      await scanObserved
      expect(await runHistoricalV2Promotion(
        queueCase.retry,
        queueCase.ready,
        v2FirstRaw,
      )).toBe(1)
      const afterHistoricalWinner = await mixedState(queueCase)
      release()
      await expect(upgradedAttempt).rejects.toBeInstanceOf(RetryPromotionConflictError)
      expect(await mixedState(queueCase)).toEqual(afterHistoricalWinner)
      expect(afterHistoricalWinner.ready).toEqual([v2FirstRaw])
      expect(afterHistoricalWinner.retry).toEqual([])
      expect(afterHistoricalWinner.receipts).toEqual({
        [expiredFingerprint]: 'discarded',
        [liveFingerprint]: `promoted:${liveOccurrenceId}`,
      })
      expect(new Set(afterHistoricalWinner.receiptExpiry.filter((_, index) => index % 2 === 0)))
        .toEqual(new Set([expiredFingerprint, liveFingerprint]))

      await admin.del(...QUEUE_KEYS)
      const applySeedTime = await redisTimeMs()
      await admin.hset(
        queueCase.receipts,
        expiredFingerprint,
        'discarded',
        liveFingerprint,
        `promoted:${liveOccurrenceId}`,
      )
      await admin.zadd(
        queueCase.receiptExpiry,
        applySeedTime - (16 * 60 * 1000),
        expiredFingerprint,
        applySeedTime - 1,
        liveFingerprint,
      )
      const newFirstRaw = JSON.stringify({
        schemaVersion: 1,
        occurrenceId: `00000000-0000-4000-8000-${String(1_400 + caseIndex).padStart(12, '0')}`,
        job: queueCase.job(50 + caseIndex),
      })
      await admin.zadd(queueCase.retry, (await redisTimeMs()) - 1, newFirstRaw)
      expect(await queueCase.create().promoteDueRetries(1)).toBe(1)
      expect(await runHistoricalV2Promotion(
        queueCase.retry,
        queueCase.ready,
        newFirstRaw,
      )).toBe(2)
      const newFirstState = await mixedState(queueCase)
      expect(newFirstState.ready).toEqual([newFirstRaw])
      expect(newFirstState.retry).toEqual([])
      expect(newFirstState.receipts[expiredFingerprint]).toBeUndefined()
      expect(newFirstState.receipts[liveFingerprint]).toBe(`promoted:${liveOccurrenceId}`)
      expect(Object.values(newFirstState.receipts))
        .toContain(`promoted:${parseOccurrence(newFirstRaw).occurrenceId}`)
      expect(Object.keys(newFirstState.receipts)).toHaveLength(2)
      const newReceiptIndexMembers =
        newFirstState.receiptExpiry.filter((_, index) => index % 2 === 0)
      expect(newReceiptIndexMembers).toHaveLength(2)
      expect(newReceiptIndexMembers).toContain(liveFingerprint)
      expect(newReceiptIndexMembers).not.toContain(expiredFingerprint)
      expect(newReceiptIndexMembers.every((member) => /^[0-9a-f]{64}$/.test(member)))
        .toBe(true)

      await admin.del(...QUEUE_KEYS)
      const legacyRaw = JSON.stringify(queueCase.job(60 + caseIndex))
      const legacyScore = String((await redisTimeMs()) - 1)
      await admin.zadd(queueCase.retry, legacyScore, legacyRaw)
      const callsBeforeLegacy = historicalLuaCalls
      await expect(runHistoricalV2Promotion(
        queueCase.retry,
        queueCase.ready,
        legacyRaw,
      )).rejects.toThrow('Historical v2 retry occurrence is invalid.')
      expect(historicalLuaCalls).toBe(callsBeforeLegacy)
      expect(await admin.zscore(queueCase.retry, legacyRaw)).toBe(legacyScore)
      expect(await admin.llen(queueCase.ready)).toBe(0)
      expect(await admin.hlen(queueCase.receipts)).toBe(0)
      expect(await queueCase.create().promoteDueRetries(1)).toBe(1)
      expect(await queueCase.create().promoteDueRetries(1)).toBe(0)
      const upgradedLegacyState = await mixedState(queueCase)
      expect(upgradedLegacyState.retry).toEqual([])
      expect(upgradedLegacyState.ready).toHaveLength(1)
      const upgradedLegacy = parseOccurrence(upgradedLegacyState.ready[0])
      expect(upgradedLegacy.job).toEqual(queueCase.job(60 + caseIndex))
      expect(Object.values(upgradedLegacyState.receipts))
        .toEqual([`promoted:${upgradedLegacy.occurrenceId}`])
      expect(upgradedLegacyState.receiptExpiry).toHaveLength(2)
    }

    console.info('QUEUE_OCCURRENCE_REDIS_MULTIPLICITY_OK')
  }, 50_000)

  it('covers bounded rotations, response loss, ownership, replay, and strict markers', async () => {
    const taskQueue = queue()
    const now = await redisTimeMs()
    const nonce = randomUUID()
    const staleEntries = Array.from({ length: 125 }, (_, index) => occurrence(index + 1))
    await admin.rpush('forge:tasks:processing', ...staleEntries)
    const staleMarkers = Object.fromEntries(staleEntries.map((raw) => [
      parseOccurrence(raw).occurrenceId,
      `${now - 2_000}:${nonce}`,
    ]))
    await admin.hset('forge:tasks:claims', staleMarkers)
    expect(await taskQueue.recoverStuckJobs(1_000, { drain: true })).toBe(125)
    expect(await admin.llen('forge:tasks')).toBe(125)
    expect(await admin.llen('forge:tasks:processing')).toBe(0)

    await admin.del('forge:tasks')
    const fresh = Array.from({ length: 100 }, (_, index) => occurrence(index + 200))
    const staleTail = occurrence(400)
    const freshNow = await redisTimeMs()
    await admin.rpush('forge:tasks:processing', ...fresh, staleTail)
    await admin.hset('forge:tasks:claims', Object.fromEntries([
      ...fresh.map((raw) => [parseOccurrence(raw).occurrenceId, `${freshNow}:${nonce}`]),
      [parseOccurrence(staleTail).occurrenceId, `${freshNow - 2_000}:${nonce}`],
    ]))
    expect(await taskQueue.recoverStuckJobs(1_000)).toBe(0)
    expect(await taskQueue.recoverStuckJobs(1_000)).toBe(1)
    expect(await admin.lrange('forge:tasks', 0, -1)).toEqual([staleTail])
    expect(await admin.llen('forge:tasks:processing')).toBe(100)

    await admin.del('forge:tasks', 'forge:tasks:processing', 'forge:tasks:claims')
    const claimLossQueue = queue()
    const claimLossClient = (claimLossQueue as unknown as {
      client: Redis
    }).client
    const originalCall = claimLossClient.call.bind(claimLossClient)
    let loseClaimResponse = true
    vi.spyOn(claimLossClient, 'call').mockImplementation(async (...args: Parameters<Redis['call']>) => {
      const result = await originalCall(...args)
      if (loseClaimResponse && String(args[1]).includes('forge:queue:claim-v2')) {
        loseClaimResponse = false
        throw new Error('simulated response loss')
      }
      return result
    })
    await admin.lpush('forge:tasks', JSON.stringify({ taskId: TASK_ID, attempt: 1 }))
    await expect(claimLossQueue.claim(1)).rejects.toThrow('Queue claim transition failed')
    expect(await claimLossQueue.recoverStuckJobs(0)).toBe(1)
    expect(await admin.llen('forge:tasks')).toBe(1)

    const ownedByA = await claimLossQueue.claim(1)
    if (!ownedByA) throw new Error('Queue Redis ownership proof could not claim its job.')
    const markerA = await admin.hget('forge:tasks:claims', ownedByA.occurrenceId)
    if (!markerA) throw new Error('Queue Redis ownership proof has no claim marker.')
    const nonceA = markerA.split(':')[1]
    const queueB = queue()
    expect(await queueB.recoverStuckJobs(0)).toBe(1)
    const readyAfterRecovery = await admin.lrange('forge:tasks', 0, -1)
    await expect(claimLossQueue.ack(ownedByA.raw))
      .rejects.toThrow('Queue transition stale_not_owner')
    expect(await admin.lrange('forge:tasks', 0, -1)).toEqual(readyAfterRecovery)
    const ownedByB = await queueB.claim(1)
    if (!ownedByB) throw new Error('Queue Redis later-owner proof could not reclaim its job.')
    const markerB = await admin.hget('forge:tasks:claims', ownedByB.occurrenceId)
    if (!markerB) throw new Error('Queue Redis later-owner proof has no claim marker.')
    await expect(queueB.ack(ownedByB.raw)).resolves.toBe('applied')
    await expect(claimLossQueue.ack(ownedByA.raw))
      .rejects.toThrow('Queue transition stale_not_owner')
    const ackReceipts = await admin.zrange('forge:tasks:ack-receipts', 0, -1)
    expect(ackReceipts).toContain(`${ownedByB.occurrenceId}:${markerB.split(':')[1]}`)
    expect(ackReceipts).not.toContain(`${ownedByA.occurrenceId}:${nonceA}`)

    vi.spyOn(claimLossClient, 'call').mockRestore()
    await admin.lpush('forge:tasks', JSON.stringify({ taskId: TASK_ID, attempt: 2 }))
    const exactReplay = await claimLossQueue.claim(1)
    if (!exactReplay) throw new Error('Queue Redis acknowledgement replay fixture was not claimed.')
    let loseAckResponse = true
    vi.spyOn(claimLossClient, 'call').mockImplementation(async (...args: Parameters<Redis['call']>) => {
      const result = await originalCall(...args)
      if (loseAckResponse && String(args[1]).includes('forge:queue:ack-v3')) {
        loseAckResponse = false
        throw new Error('simulated response loss')
      }
      return result
    })
    await expect(claimLossQueue.ack(exactReplay.raw)).rejects.toThrow('Queue transition failed')
    await expect(claimLossQueue.ack(exactReplay.raw)).resolves.toBe('already_applied')

    type RenewableQueue = {
      ack: (raw: string) => Promise<'already_applied' | 'applied'>
      claim: (timeoutSeconds: number) => Promise<{
        job: TaskJob | ApprovalJob | AnswersJob
        occurrenceId: string
        raw: string
      } | null>
      deadLetter: (
        raw: string,
        job: TaskJob | ApprovalJob | AnswersJob,
      ) => Promise<'already_applied' | 'applied'>
      recoverStuckJobs: (staleMs: number) => Promise<number>
      release: (raw: string) => Promise<'already_applied' | 'applied'>
      renewClaim: (raw: string) => Promise<'renewed' | 'stale_not_owner'>
      retry: (
        raw: string,
        job: TaskJob | ApprovalJob | AnswersJob,
        delayMs: number,
      ) => Promise<{
        nextRetryAt: Date
        outcome: 'already_applied' | 'applied'
      }>
    }
    const renewalCases = [
      {
        ackReceipts: 'forge:tasks:ack-receipts',
        claims: 'forge:tasks:claims',
        create: () => queue() as unknown as RenewableQueue,
        dead: 'forge:tasks:dead',
        job: { taskId: TASK_ID, attempt: 11 },
        processing: 'forge:tasks:processing',
        ready: 'forge:tasks',
        releaseReceipts: 'forge:tasks:release-receipts',
        retry: 'forge:tasks:retry',
      },
      {
        ackReceipts: 'forge:approvals:ack-receipts',
        claims: 'forge:approvals:claims',
        create: () => approvalQueue() as unknown as RenewableQueue,
        dead: 'forge:approvals:dead',
        job: { taskId: TASK_ID, action: 'approve', attempt: 11 },
        processing: 'forge:approvals:processing',
        ready: 'forge:approvals',
        releaseReceipts: 'forge:approvals:release-receipts',
        retry: 'forge:approvals:retry',
      },
      {
        ackReceipts: 'forge:answers:ack-receipts',
        claims: 'forge:answers:claims',
        create: () => answersQueue() as unknown as RenewableQueue,
        dead: 'forge:answers:dead',
        job: { taskId: TASK_ID, attempt: 11 },
        processing: 'forge:answers:processing',
        ready: 'forge:answers',
        releaseReceipts: 'forge:answers:release-receipts',
        retry: 'forge:answers:retry',
      },
    ]
    const renewalStaleMs = 1_000
    for (const renewalCase of renewalCases) {
      await admin.del(...QUEUE_KEYS)
      const owner = renewalCase.create()
      const recovery = renewalCase.create()
      await admin.lpush(renewalCase.ready, JSON.stringify(renewalCase.job))
      const claimed = await owner.claim(1)
      if (!claimed) throw new Error('Queue Redis renewal proof could not claim its job.')
      const ownerFence = new ClaimLeaseFence()
      const ownerMutation = vi.fn()
      const recoveryMutation = vi.fn()
      let releaseOwnerMutation!: () => void
      const ownerMutationGate = new Promise<void>((resolve) => {
        releaseOwnerMutation = resolve
      })
      const delayedOwnerMutation = (async () => {
        await ownerMutationGate
        ownerFence.assertOwned()
        ownerMutation()
      })()
      const originalMarker = await admin.hget(renewalCase.claims, claimed.occurrenceId)
      if (!originalMarker) throw new Error('Queue Redis renewal proof has no claim marker.')
      const originalNonce = originalMarker.split(':')[1]
      const originalTimestamp = Number(originalMarker.split(':')[0])
      await admin.hset(
        renewalCase.claims,
        claimed.occurrenceId,
        `${originalTimestamp - 2_000}:${originalNonce}`,
      )

      const ownerClient = (owner as unknown as { client: Redis }).client
      const originalOwnerCall = ownerClient.call.bind(ownerClient)
      let loseRenewalResponse = true
      const renewalCall = vi.spyOn(ownerClient, 'call').mockImplementation(
        async (...args: Parameters<Redis['call']>) => {
          const result = await originalOwnerCall(...args)
          if (loseRenewalResponse && String(args[1]).includes('forge:queue:renew-claim-v1')) {
            loseRenewalResponse = false
            throw new Error('simulated response loss')
          }
          return result
        },
      )
      await expect(owner.renewClaim(claimed.raw)).rejects.toThrow('Queue claim renewal failed')
      const responseLossMarker = await admin.hget(
        renewalCase.claims,
        claimed.occurrenceId,
      )
      if (!responseLossMarker) throw new Error('Queue Redis renewal response was not applied.')
      expect(responseLossMarker.split(':')[1]).toBe(originalNonce)
      await expect(owner.renewClaim(claimed.raw)).resolves.toBe('renewed')
      const renewedMarker = await admin.hget(renewalCase.claims, claimed.occurrenceId)
      if (!renewedMarker) throw new Error('Queue Redis renewed marker is unavailable.')
      expect(renewedMarker.split(':')[1]).toBe(originalNonce)
      expect(Number(renewedMarker.split(':')[0])).toBeGreaterThan(originalTimestamp - 2_000)
      expect(await recovery.recoverStuckJobs(renewalStaleMs)).toBe(0)
      await expect(recovery.renewClaim(claimed.raw))
        .rejects.toThrow('Queue transition ownership mismatch')

      expect(await admin.lrem(renewalCase.processing, 1, claimed.raw)).toBe(1)
      await expect(owner.renewClaim(claimed.raw)).resolves.toBe('stale_not_owner')
      await admin.lpush(renewalCase.processing, claimed.raw)
      await admin.hset(
        renewalCase.claims,
        claimed.occurrenceId,
        `${await redisTimeMs()}:malformed`,
      )
      await expect(owner.renewClaim(claimed.raw)).rejects.toThrow('Queue claim renewal failed')
      await admin.hset(renewalCase.claims, claimed.occurrenceId, renewedMarker)

      const renewedAt = Number(renewedMarker.split(':')[0])
      const ageDeadline = Date.now() + 5_000
      while (await redisTimeMs() - renewedAt < renewalStaleMs) {
        if (Date.now() >= ageDeadline) {
          throw new Error('Queue Redis renewal proof did not reach the lease boundary.')
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(await recovery.recoverStuckJobs(renewalStaleMs)).toBe(1)
      expect(await admin.lrange(renewalCase.ready, 0, -1)).toEqual([claimed.raw])
      const ownerRenewal = await owner.renewClaim(claimed.raw)
      expect(ownerRenewal).toBe('stale_not_owner')
      if (ownerRenewal === 'stale_not_owner') ownerFence.markLost()
      releaseOwnerMutation()
      await expect(delayedOwnerMutation).rejects.toBeInstanceOf(ClaimLeaseLostError)
      expect(ownerMutation).not.toHaveBeenCalled()
      await expect(owner.ack(claimed.raw)).rejects.toThrow('Queue transition stale_not_owner')

      const nextOwner = await recovery.claim(1)
      if (!nextOwner) throw new Error('Queue Redis renewal proof could not reclaim its job.')
      expect(nextOwner.occurrenceId).toBe(claimed.occurrenceId)
      const nextMarker = await admin.hget(renewalCase.claims, nextOwner.occurrenceId)
      if (!nextMarker) throw new Error('Queue Redis renewal proof has no later-owner marker.')
      await expect(recovery.renewClaim(nextOwner.raw)).resolves.toBe('renewed')
      await expect(recovery.renewClaim(nextOwner.raw)).resolves.toBe('renewed')
      const recoveryFence = new ClaimLeaseFence()
      recoveryFence.assertOwned()
      recoveryMutation()
      await expect(recovery.ack(nextOwner.raw)).resolves.toBe('applied')
      expect(recoveryMutation).toHaveBeenCalledOnce()
      expect(await admin.zrange(renewalCase.ackReceipts, 0, -1)).toContain(
        `${nextOwner.occurrenceId}:${nextMarker.split(':')[1]}`,
      )
      expect(await admin.zrange(renewalCase.ackReceipts, 0, -1)).not.toContain(
        `${claimed.occurrenceId}:${originalNonce}`,
      )
      renewalCall.mockRestore()
    }

    const claimAndRenew = async (
      renewalCase: (typeof renewalCases)[number],
      attempt: number,
    ) => {
      const owner = renewalCase.create()
      const job = {
        ...renewalCase.job,
        attempt,
      } as TaskJob | ApprovalJob | AnswersJob
      await admin.lpush(renewalCase.ready, JSON.stringify(job))
      const claimed = await owner.claim(1)
      if (!claimed) {
        throw new Error('Queue Redis terminal renewal fixture was not claimed.')
      }
      const originalMarker = await admin.hget(
        renewalCase.claims,
        claimed.occurrenceId,
      )
      if (!originalMarker) {
        throw new Error('Queue Redis terminal renewal fixture has no claim marker.')
      }
      const [originalTimestampRaw, originalNonce] = originalMarker.split(':')
      const originalTimestamp = Number(originalTimestampRaw)
      const renewalDeadline = Date.now() + 1_000
      while (await redisTimeMs() <= originalTimestamp) {
        if (Date.now() >= renewalDeadline) {
          throw new Error('Queue Redis terminal renewal timestamp did not advance.')
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      await expect(owner.renewClaim(claimed.raw)).resolves.toBe('renewed')
      const renewedMarker = await admin.hget(
        renewalCase.claims,
        claimed.occurrenceId,
      )
      if (!renewedMarker) {
        throw new Error('Queue Redis terminal renewal marker is unavailable.')
      }
      expect(Number(renewedMarker.split(':')[0])).toBeGreaterThan(originalTimestamp)
      expect(renewedMarker.split(':')[1]).toBe(originalNonce)
      return {
        claimed,
        originalNonce,
        owner,
      }
    }

    for (const [caseIndex, renewalCase] of renewalCases.entries()) {
      await admin.del(...QUEUE_KEYS)
      const released = await claimAndRenew(renewalCase, 20 + caseIndex)
      await expect(released.owner.release(released.claimed.raw))
        .resolves.toBe('applied')
      expect(await admin.lrange(renewalCase.ready, 0, -1))
        .toEqual([released.claimed.raw])
      expect(await admin.lrange(renewalCase.processing, 0, -1)).toEqual([])
      expect(await admin.hget(
        renewalCase.claims,
        released.claimed.occurrenceId,
      )).toBeNull()
      expect(await admin.zrange(renewalCase.releaseReceipts, 0, -1))
        .toEqual([
          `${released.claimed.occurrenceId}:${released.originalNonce}`,
        ])

      await admin.del(...QUEUE_KEYS)
      const retried = await claimAndRenew(renewalCase, 30 + caseIndex)
      const retryClient = (retried.owner as unknown as { client: Redis }).client
      const originalRetryCall = retryClient.call.bind(retryClient)
      let loseRetryResponse = true
      const retryCall = vi.spyOn(retryClient, 'call').mockImplementation(
        async (...args: Parameters<Redis['call']>) => {
          const result = await originalRetryCall(...args)
          if (loseRetryResponse && String(args[1]).includes('forge:queue:retry-v3')) {
            loseRetryResponse = false
            throw new Error('simulated retry response loss')
          }
          return result
        },
      )
      await expect(retried.owner.retry(
        retried.claimed.raw,
        retried.claimed.job,
        60_000,
      )).rejects.toThrow('Queue transition failed')
      const scheduledAfterLoss = await admin.zrange(
        renewalCase.retry,
        0,
        -1,
        'WITHSCORES',
      )
      expect(scheduledAfterLoss).toHaveLength(2)
      const retryReplay = await retried.owner.retry(
        retried.claimed.raw,
        retried.claimed.job,
        60_000,
      )
      expect(retryReplay).toEqual({
        nextRetryAt: new Date(Number(scheduledAfterLoss[1])),
        outcome: 'already_applied',
      })
      expect(await admin.zrange(renewalCase.retry, 0, -1, 'WITHSCORES'))
        .toEqual(scheduledAfterLoss)
      expect(parseOccurrence(scheduledAfterLoss[0])).toEqual({
        schemaVersion: 1,
        occurrenceId: retried.claimed.occurrenceId,
        job: {
          ...retried.claimed.job,
          attempt: (retried.claimed.job.attempt ?? 1) + 1,
        },
      })
      expect(await admin.lrange(renewalCase.processing, 0, -1)).toEqual([])
      expect(await admin.hget(
        renewalCase.claims,
        retried.claimed.occurrenceId,
      )).toBeNull()
      retryCall.mockRestore()

      await admin.del(...QUEUE_KEYS)
      const deadLettered = await claimAndRenew(renewalCase, 40 + caseIndex)
      const deadClient = (deadLettered.owner as unknown as { client: Redis }).client
      const originalDeadCall = deadClient.call.bind(deadClient)
      let loseDeadResponse = true
      const deadCall = vi.spyOn(deadClient, 'call').mockImplementation(
        async (...args: Parameters<Redis['call']>) => {
          const result = await originalDeadCall(...args)
          if (loseDeadResponse
            && String(args[1]).includes('forge:queue:dead-letter-v2')) {
            loseDeadResponse = false
            throw new Error('simulated dead-letter response loss')
          }
          return result
        },
      )
      await expect(deadLettered.owner.deadLetter(
        deadLettered.claimed.raw,
        deadLettered.claimed.job,
      )).rejects.toThrow('Queue transition failed')
      const deadAfterLoss = await admin.lrange(renewalCase.dead, 0, -1)
      expect(deadAfterLoss).toHaveLength(1)
      await expect(deadLettered.owner.deadLetter(
        deadLettered.claimed.raw,
        deadLettered.claimed.job,
      )).resolves.toBe('already_applied')
      expect(await admin.lrange(renewalCase.dead, 0, -1)).toEqual(deadAfterLoss)
      expect(JSON.parse(deadAfterLoss[0]) as Record<string, unknown>)
        .toMatchObject({
          failureCategory: 'job_processing_failed',
          job: deadLettered.claimed.job,
          occurrenceId: deadLettered.claimed.occurrenceId,
          schemaVersion: 1,
        })
      expect(await admin.lrange(renewalCase.processing, 0, -1)).toEqual([])
      expect(await admin.hget(
        renewalCase.claims,
        deadLettered.claimed.occurrenceId,
      )).toBeNull()
      deadCall.mockRestore()
    }

    for (const [caseIndex, renewalCase] of renewalCases.entries()) {
      for (const terminalKind of ['retry', 'dead_letter'] as const) {
        await admin.del(...QUEUE_KEYS)
        const staleOwner = await claimAndRenew(
          renewalCase,
          50 + (caseIndex * 2) + (terminalKind === 'dead_letter' ? 1 : 0),
        )
        const nextOwnerQueue = renewalCase.create()
        await expect(nextOwnerQueue.recoverStuckJobs(0)).resolves.toBe(1)
        const nextOwner = await nextOwnerQueue.claim(1)
        if (!nextOwner) {
          throw new Error('Queue Redis stale terminal fixture was not reclaimed.')
        }
        expect(nextOwner.occurrenceId).toBe(staleOwner.claimed.occurrenceId)

        if (terminalKind === 'retry') {
          await expect(staleOwner.owner.retry(
            staleOwner.claimed.raw,
            staleOwner.claimed.job,
            60_000,
          )).rejects.toThrow('Queue transition stale_not_owner')
          expect(await admin.zcard(renewalCase.retry)).toBe(0)
          await expect(nextOwnerQueue.retry(
            nextOwner.raw,
            nextOwner.job,
            60_000,
          )).resolves.toMatchObject({ outcome: 'applied' })
          expect(await admin.zcard(renewalCase.retry)).toBe(1)
        } else {
          await expect(staleOwner.owner.deadLetter(
            staleOwner.claimed.raw,
            staleOwner.claimed.job,
          )).rejects.toThrow('Queue transition stale_not_owner')
          expect(await admin.llen(renewalCase.dead)).toBe(0)
          await expect(nextOwnerQueue.deadLetter(nextOwner.raw, nextOwner.job))
            .resolves.toBe('applied')
          expect(await admin.llen(renewalCase.dead)).toBe(1)
        }
        expect(await admin.lrange(renewalCase.processing, 0, -1)).toEqual([])
        expect(await admin.hget(
          renewalCase.claims,
          staleOwner.claimed.occurrenceId,
        )).toBeNull()
      }
    }

    const markerCases = [
      '0:11111111-1111-4111-8111-111111111111',
      '9007199254740992:11111111-1111-4111-8111-111111111111',
      `${(await redisTimeMs()) + 10_000}:11111111-1111-4111-8111-111111111111`,
      `${await redisTimeMs()}:not-a-uuid`,
      `${await redisTimeMs()}:11111111-1111-4111-8111-111111111111:extra`,
    ]
    for (const [index, marker] of markerCases.entries()) {
      await admin.del('forge:tasks:processing', 'forge:tasks:claims')
      const raw = occurrence(500 + index)
      const occurrenceId = parseOccurrence(raw).occurrenceId
      await admin.rpush('forge:tasks:processing', raw)
      await admin.hset('forge:tasks:claims', occurrenceId, marker)
      await expect(claimLossQueue.recoverStuckJobs(0))
        .rejects.toThrow('Queue recovery found an invalid claim marker')
      expect(await admin.lrange('forge:tasks:processing', 0, -1)).toEqual([raw])
      expect(await admin.hget('forge:tasks:claims', occurrenceId)).toBe(marker)
    }
    console.info('QUEUE_OCCURRENCE_REDIS_RECOVERY_OK')
  }, 30_000)

  it('lets an in-flight worker transition finish before queue disconnect', async () => {
    const priorRedisUrl = process.env.REDIS_URL
    const priorIntervals = {
      blocked: process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS,
      provider: process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS,
      session: process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS,
      stuck: process.env.FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS,
    }
    process.env.REDIS_URL = destructiveRedisUrl!
    process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = '0'
    process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = '0'
    process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = '0'
    process.env.FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS = '1'

    const businessGate: { release?: () => void } = {}
    let workerHandle: { stop: () => Promise<void> } | null = null
    const lostClaimGate: { observed?: () => void } = {}
    const lostClaimObserved = new Promise<void>((resolve) => {
      lostClaimGate.observed = resolve
    })
    const processTask = vi.fn(() => new Promise<'completed'>((resolve) => {
      businessGate.release = () => resolve('completed')
    }))
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
    vi.doMock('@/worker/orchestrator', () => ({
      processAnsweredQuestions: vi.fn(),
      processApproval: vi.fn(),
      processTask,
    }))
    vi.doMock('@/worker/task-attempts', () => ({
      finishTaskAttempt: vi.fn().mockResolvedValue(undefined),
      startTaskAttempt: vi.fn().mockResolvedValue({
        attemptId: 'queue-shutdown-attempt',
        recoveredOccurrence: false,
      }),
    }))
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

    try {
      const originalCall = Redis.prototype.call
      let loseClaimResponse = true
      vi.spyOn(Redis.prototype, 'call').mockImplementation(async function (
        this: Redis,
        ...args: Parameters<Redis['call']>
      ) {
        const result = await originalCall.apply(this, args)
        if (loseClaimResponse && String(args[1]).includes('forge:queue:claim-v2')) {
          loseClaimResponse = false
          lostClaimGate.observed?.()
          throw new Error('simulated response loss')
        }
        return result
      })
      await admin.lpush('forge:tasks', JSON.stringify({ taskId: TASK_ID, attempt: 1 }))
      const { startWorker } = await import('@/worker/runtime')
      const handle = await startWorker('standalone')
      workerHandle = handle
      await lostClaimObserved
      expect(await admin.llen('forge:tasks:processing')).toBe(1)
      expect(await admin.hlen('forge:tasks:claims')).toBe(1)
      await vi.waitFor(() => expect(processTask).toHaveBeenCalledOnce(), { timeout: 10_000 })
      const [activeOccurrenceId] = await admin.hkeys('forge:tasks:claims')
      const initialLiveMarker = await admin.hget('forge:tasks:claims', activeOccurrenceId)
      if (!initialLiveMarker) throw new Error('Queue heartbeat proof has no live claim marker.')
      const initialLiveTimestamp = Number(initialLiveMarker.split(':')[0])
      const liveNonce = initialLiveMarker.split(':')[1]
      const heartbeatDeadline = Date.now() + 5_000
      let renewedLiveMarker = initialLiveMarker
      while (Number(renewedLiveMarker.split(':')[0]) <= initialLiveTimestamp
        || await redisTimeMs() - initialLiveTimestamp <= 500) {
        if (Date.now() >= heartbeatDeadline) {
          throw new Error('Queue heartbeat proof did not renew its live claim.')
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
        renewedLiveMarker = await admin.hget('forge:tasks:claims', activeOccurrenceId)
          ?? initialLiveMarker
      }
      expect(renewedLiveMarker.split(':')[1]).toBe(liveNonce)
      expect(await queue().recoverStuckJobs(500)).toBe(0)
      expect(processTask).toHaveBeenCalledOnce()
      const stop = handle.stop()
      expect(await admin.llen('forge:tasks:processing')).toBe(1)
      expect(await admin.hlen('forge:tasks:claims')).toBe(1)
      businessGate.release?.()
      await stop
      expect(await admin.llen('forge:tasks:processing')).toBe(0)
      expect(await admin.hlen('forge:tasks:claims')).toBe(0)

      vi.restoreAllMocks()
      const idlePositions = ['approval', 'answers', 'task'] as const
      for (const position of idlePositions) {
        await admin.del(...QUEUE_KEYS)
        vi.resetModules()
        delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime

        const claimEnteredGate: { resolve?: () => void } = {}
        const claimEntered = new Promise<void>((resolve) => {
          claimEnteredGate.resolve = resolve
        })
        const claimCounts = { approval: 0, answers: 0, task: 0 }

        class IdleApprovalQueue extends ApprovalQueue {
          override async claim(timeoutSeconds: number): Promise<ClaimedApprovalJob | null> {
            claimCounts.approval += 1
            if (position !== 'approval') return null
            claimEnteredGate.resolve?.()
            return await super.claim(timeoutSeconds)
          }
        }
        class IdleAnswersQueue extends AnswersQueue {
          override async claim(timeoutSeconds: number): Promise<ClaimedAnswersJob | null> {
            claimCounts.answers += 1
            if (position !== 'answers') return null
            claimEnteredGate.resolve?.()
            return await super.claim(timeoutSeconds)
          }
        }
        class IdleTaskQueue extends TaskQueue {
          override async claim(timeoutSeconds: number): Promise<ClaimedTaskJob | null> {
            claimCounts.task += 1
            if (position !== 'task') return null
            claimEnteredGate.resolve?.()
            return await super.claim(timeoutSeconds)
          }
        }

        vi.doMock('@/worker/queue', () => ({
          AnswersQueue: IdleAnswersQueue,
          ApprovalQueue: IdleApprovalQueue,
          RetryPromotionConflictError,
          TaskQueue: IdleTaskQueue,
        }))
        const idleProcessAnsweredQuestions = vi.fn()
        const idleProcessApproval = vi.fn()
        const idleProcessTask = vi.fn()
        vi.doMock('@/worker/orchestrator', () => ({
          processAnsweredQuestions: idleProcessAnsweredQuestions,
          processApproval: idleProcessApproval,
          processTask: idleProcessTask,
        }))
        const idleFinishTaskAttempt = vi.fn()
        const idleStartTaskAttempt = vi.fn()
        vi.doMock('@/worker/task-attempts', () => ({
          finishTaskAttempt: idleFinishTaskAttempt,
          startTaskAttempt: idleStartTaskAttempt,
        }))
        const taskLookup = vi.fn()
        vi.doMock('@/db', () => ({
          db: {
            select: vi.fn((selection: Record<string, unknown>) => {
              if (Object.keys(selection).length === 1 && 'id' in selection) taskLookup()
              return query([])
            }),
          },
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

        const idleReadyKey = {
          approval: 'forge:approvals',
          answers: 'forge:answers',
          task: 'forge:tasks',
        }[position]
        const idleProcessingKey = `${idleReadyKey}:processing`
        const idleClaimsKey = `${idleReadyKey}:claims`
        const idleAckReceiptsKey = `${idleReadyKey}:ack-receipts`
        const idleReleaseReceiptsKey = `${idleReadyKey}:release-receipts`
        const idleJob: TaskJob | ApprovalJob | AnswersJob = position === 'approval'
          ? { taskId: TASK_ID, action: 'approve', attempt: 1 }
          : { taskId: TASK_ID, attempt: 1 }

        const idleRuntime = await import('@/worker/runtime')
        const idleHandle = await idleRuntime.startWorker('standalone')
        workerHandle = idleHandle
        await claimEntered
        const idleStop = idleHandle.stop()
        await admin.lpush(idleReadyKey, JSON.stringify(idleJob))
        await idleStop
        workerHandle = null

        const returned = await admin.lrange(idleReadyKey, 0, -1)
        expect(returned).toHaveLength(1)
        expect(parseOccurrence(returned[0]).job).toEqual(idleJob)
        expect(await admin.llen(idleProcessingKey)).toBe(0)
        expect(await admin.hlen(idleClaimsKey)).toBe(0)
        expect(await admin.zcard(idleAckReceiptsKey)).toBe(0)
        expect(await admin.zcard(idleReleaseReceiptsKey)).toBe(1)
        expect(taskLookup).not.toHaveBeenCalled()
        expect(idleStartTaskAttempt).not.toHaveBeenCalled()
        expect(idleFinishTaskAttempt).not.toHaveBeenCalled()
        expect(idleProcessApproval).not.toHaveBeenCalled()
        expect(idleProcessAnsweredQuestions).not.toHaveBeenCalled()
        expect(idleProcessTask).not.toHaveBeenCalled()
        if (position === 'approval') {
          expect(claimCounts.answers).toBe(0)
          expect(claimCounts.task).toBe(0)
        } else if (position === 'answers') {
          expect(claimCounts.task).toBe(0)
        }
      }
      console.info('QUEUE_OCCURRENCE_REDIS_SHUTDOWN_OK')
    } finally {
      businessGate.release?.()
      await workerHandle?.stop()
      if (priorRedisUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = priorRedisUrl
      if (priorIntervals.blocked === undefined) {
        delete process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS
      } else {
        process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = priorIntervals.blocked
      }
      if (priorIntervals.provider === undefined) {
        delete process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS
      } else {
        process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = priorIntervals.provider
      }
      if (priorIntervals.session === undefined) {
        delete process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS
      } else {
        process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = priorIntervals.session
      }
      if (priorIntervals.stuck === undefined) {
        delete process.env.FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS
      } else {
        process.env.FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS = priorIntervals.stuck
      }
    }
  }, 45_000)
})
