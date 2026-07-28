import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RedisHarnessInstance = {
  brpoplpush: ReturnType<typeof vi.fn>
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

const redisHarness = vi.hoisted(() => ({
  claimPayloads: [] as Array<string | null>,
  instances: [] as RedisHarnessInstance[],
}))

vi.mock('ioredis', () => {
  class RedisMock {
    private readonly listeners = new Map<string, Array<(value: unknown) => void>>()
    brpoplpush = vi.fn(async () => redisHarness.claimPayloads.shift() ?? null)
    hdel = vi.fn().mockResolvedValue(1)
    hget = vi.fn().mockResolvedValue(null)
    hset = vi.fn().mockResolvedValue(1)
    lpush = vi.fn().mockResolvedValue(1)
    lrange = vi.fn().mockResolvedValue([])
    lrem = vi.fn().mockResolvedValue(1)
    zadd = vi.fn().mockResolvedValue(1)
    zrangebyscore = vi.fn().mockResolvedValue([])
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
  redisHarness.instances.length = 0
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
    expect(client.lrem).toHaveBeenCalledWith('forge:tasks:processing', 1, malformed)
    expect(client.hdel).toHaveBeenCalledWith('forge:tasks:claims', malformed)
    expect(client.hset).not.toHaveBeenCalled()
    expect(client.lpush).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('[worker/queue] Dropped invalid job payload')
    assertNoSentinels(serializedConsoleCalls(warn))
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
    expect(client.hset).toHaveBeenCalledWith('forge:tasks:claims', raw, expect.any(String))
    expect(client.lrem).toHaveBeenCalledWith('forge:tasks:processing', 1, raw)
    expect(client.hdel).toHaveBeenCalledWith('forge:tasks:claims', raw)
    expect(client.lpush).toHaveBeenCalledOnce()

    const [deadKey, deadRaw] = client.lpush.mock.calls[0] as [string, string]
    expect(deadKey).toBe('forge:tasks:dead')
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
    expect(retryClient.zadd).toHaveBeenCalledWith(
      'forge:tasks:retry',
      retryAt.getTime(),
      JSON.stringify({ taskId: TASK_ID, attempt: 2 }),
    )
    expect(retryClient.lrem).toHaveBeenCalledWith('forge:tasks:processing', 1, retryRaw)
    expect(retryClient.hdel).toHaveBeenCalledWith('forge:tasks:claims', retryRaw)
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
    const finishTaskAttempt = vi.fn().mockResolvedValue(undefined)
    const startTaskAttempt = vi.fn().mockResolvedValue('attempt-1')
    const processFailure = hostileError()
    const deadLetter = vi.fn().mockResolvedValue(undefined)
    const taskAck = vi.fn().mockResolvedValue(undefined)
    const taskClaimWaiter = {
      release: null as ((value: null) => void) | null,
    }
    let taskClaimCount = 0

    class PassiveQueue {
      ack = vi.fn().mockResolvedValue(undefined)
      deadLetter = vi.fn().mockResolvedValue(undefined)
      retry = vi.fn().mockResolvedValue(new Date())
      recoverStuckJobs = vi.fn().mockResolvedValue(0)
      promoteDueRetries = vi.fn().mockResolvedValue(0)
      claim = vi.fn().mockResolvedValue(null)
      disconnect = vi.fn()
    }

    class RuntimeTaskQueue extends PassiveQueue {
      override ack = taskAck
      override deadLetter = deadLetter
      override claim = vi.fn(async () => {
        taskClaimCount += 1
        if (taskClaimCount === 1) {
          const raw = JSON.stringify({ taskId: TASK_ID, attempt: 1 })
          return { raw, job: { taskId: TASK_ID, attempt: 1 } }
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
      AnswersQueue: PassiveQueue,
      ApprovalQueue: PassiveQueue,
      TaskQueue: RuntimeTaskQueue,
    }))
    vi.doMock('@/worker/orchestrator', () => ({
      processAnsweredQuestions: vi.fn(),
      processApproval: vi.fn(),
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

    process.env.FORGE_WORKER_MAX_ATTEMPTS = '1'
    process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = '0'
    process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = '0'
    process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = '0'

    try {
      const { startWorker } = await import('@/worker/runtime')
      const handle = await startWorker('standalone')
      await vi.waitFor(() => expect(deadLetter).toHaveBeenCalledOnce())
      await handle.stop()

      expect(finishTaskAttempt).toHaveBeenCalledWith(expect.objectContaining({
        attemptId: 'attempt-1',
        errorMessage: expect.stringContaining(SENTINELS[0]),
        status: 'dead_lettered',
      }))
      expect(finishTaskAttempt).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: expect.stringContaining(SENTINELS[1]),
      }))
      expect(deadLetter).toHaveBeenCalledWith(
        JSON.stringify({ taskId: TASK_ID, attempt: 1 }),
        { taskId: TASK_ID, attempt: 1 },
      )
      expect(taskAck).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(
        '[worker] Task failed',
        expect.objectContaining({
          attempt: 1,
          finalAttempt: true,
          taskId: TASK_ID,
        }),
      )
      assertNoSentinels([
        ...consoleError.mock.calls,
        ...consoleInfo.mock.calls,
        ...consoleWarn.mock.calls,
        ...deadLetter.mock.calls,
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
    expect(runtimeSource).toContain(
      'taskQueue.deadLetter(claimedTask.raw, claimedTask.job)',
    )
    expect(runtimeSource).not.toMatch(/deadLetter\([^)]*\bmessage\b/)
  })
})
