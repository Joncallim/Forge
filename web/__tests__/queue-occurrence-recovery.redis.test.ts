import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AnswersQueue,
  ApprovalQueue,
  TaskQueue,
  type AnswersJob,
  type ApprovalJob,
  type ClaimedAnswersJob,
  type ClaimedApprovalJob,
  type ClaimedTaskJob,
  type TaskJob,
} from '@/worker/queue'

const QUEUE_KEYS = [
  'forge:tasks',
  'forge:tasks:processing',
  'forge:tasks:retry',
  'forge:tasks:dead',
  'forge:tasks:claims',
  'forge:tasks:ack-receipts',
  'forge:tasks:release-receipts',
  'forge:approvals',
  'forge:approvals:processing',
  'forge:approvals:retry',
  'forge:approvals:dead',
  'forge:approvals:claims',
  'forge:approvals:ack-receipts',
  'forge:approvals:release-receipts',
  'forge:answers',
  'forge:answers:processing',
  'forge:answers:retry',
  'forge:answers:dead',
  'forge:answers:claims',
  'forge:answers:ack-receipts',
  'forge:answers:release-receipts',
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

type Occurrence = {
  schemaVersion: number
  occurrenceId: string
  job: { taskId: string; attempt: number }
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

describe.skipIf(!enabled)('queue occurrence and recovery real Redis proof', () => {
  let admin: Redis
  const queues = new Set<TaskQueue>()

  function queue(): TaskQueue {
    const created = new TaskQueue(destructiveRedisUrl!)
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
    console.info('QUEUE_OCCURRENCE_REDIS_MULTIPLICITY_OK')
  }, 20_000)

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
    const processTask = vi.fn(() => new Promise<void>((resolve) => {
      businessGate.release = resolve
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
      startTaskAttempt: vi.fn().mockResolvedValue('queue-shutdown-attempt'),
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
