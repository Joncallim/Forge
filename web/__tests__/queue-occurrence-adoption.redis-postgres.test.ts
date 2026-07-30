import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { recordArchitectPlanVersion } from '@/lib/mcps/s4-protocol-store'
import { appendArchitectClarificationAnswer } from '@/lib/mcps/history-reader'
import { computeCredentialDigest } from '@/lib/session-credential-digest'

const required = process.env.CI === 'true'
  || process.env.FORGE_QUEUE_ADOPTION_TEST_REQUIRED === '1'
const destructive = process.env.CI === 'true'
  || process.env.FORGE_QUEUE_ADOPTION_DESTRUCTIVE_TEST === '1'
const configuredRedisUrl = process.env.FORGE_QUEUE_ADOPTION_REDIS_TEST_URL
const redisUrl = configuredRedisUrl ?? (process.env.CI === 'true'
  ? 'redis://localhost:6380/12'
  : undefined)
const databaseUrl = process.env.FORGE_QUEUE_ADOPTION_POSTGRES_TEST_URL
  ?? process.env.DATABASE_URL
const fixtureAdminUrl = process.env.FORGE_QUEUE_ADOPTION_POSTGRES_ADMIN_TEST_URL
const fixtureWriterUrl = process.env.FORGE_QUEUE_ADOPTION_WRITER_DATABASE_URL
const fixtureHistoryReaderUrl = process.env.FORGE_QUEUE_ADOPTION_HISTORY_READER_DATABASE_URL
const fixtureResolverUrl = process.env.FORGE_QUEUE_ADOPTION_RESOLVER_DATABASE_URL
const moduleEndpointEnvNames = [
  'DATABASE_URL',
  'REDIS_URL',
  'FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL',
] as const
const originalModuleEndpointEnvironment = new Map(
  moduleEndpointEnvNames.map((name) => [name, process.env[name]]),
)

function restoreEnvironment(
  names: readonly string[],
  original: ReadonlyMap<string, string | undefined>,
): void {
  let failed = false
  for (const name of names) {
    const value = original.get(name)
    try {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    } catch {
      failed = true
    }
  }
  if (failed) throw new Error('Endpoint environment restoration failed.')
}

function verifyEnvironmentRestored(
  names: readonly string[],
  original: ReadonlyMap<string, string | undefined>,
): void {
  if (names.some((name) => process.env[name] !== original.get(name))) {
    throw new Error('Endpoint environment restoration verification failed.')
  }
}

function restoreOriginalModuleEndpointEnvironment(): void {
  restoreEnvironment(moduleEndpointEnvNames, originalModuleEndpointEnvironment)
}

function assertOriginalModuleEndpointEnvironment(): void {
  verifyEnvironmentRestored(moduleEndpointEnvNames, originalModuleEndpointEnvironment)
}

type CleanupCategory =
  | 'redis_cleanup'
  | 's4_deactivate'
  | 'redis_quit'
  | 'sql_close'
  | 'admin_close'
  | 'endpoint_restore'

type CleanupStage = {
  category: CleanupCategory
  run: () => void | Promise<void>
}

async function runCleanupStages(stages: readonly CleanupStage[]): Promise<void> {
  const failures: CleanupCategory[] = []
  for (const stage of stages) {
    try {
      await stage.run()
    } catch {
      failures.push(stage.category)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Queue adoption cleanup failed: ${failures.join(',')}`)
  }
}

function validatedRedisUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Queue adoption proof requires a valid dedicated Redis URL.')
  }
  if ((parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:')
    || parsed.search
    || parsed.hash
    || !/^\/[1-9][0-9]*$/.test(parsed.pathname)) {
    throw new Error('Queue adoption proof requires an unambiguous nonzero Redis database.')
  }
  return value
}

if (required && (!destructive || !redisUrl || !databaseUrl
  || !fixtureAdminUrl || !fixtureWriterUrl || !fixtureResolverUrl || !fixtureHistoryReaderUrl)) {
  throw new Error(
    'Mandatory queue adoption proof requires dedicated Redis, app/admin/writer/resolver/history PostgreSQL URLs, and destructive-test authorization.',
  )
}

const enabled = Boolean(destructive && redisUrl && databaseUrl
  && fixtureAdminUrl && fixtureWriterUrl && fixtureResolverUrl && fixtureHistoryReaderUrl)
const proofRedisUrl = enabled ? validatedRedisUrl(redisUrl!) : null

// DB and queue modules cache their connections at import time. Bind the
// dedicated proof endpoints before any production worker module is imported;
// this makes CI's DB 12 proof unable to observe the shared worker Redis URL.
if (enabled) {
  process.env.DATABASE_URL = databaseUrl!
  process.env.REDIS_URL = proofRedisUrl!
  process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = fixtureWriterUrl!
  process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL = fixtureResolverUrl!
  process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL = fixtureHistoryReaderUrl!
}
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

type QueueKind = 'answers' | 'approval' | 'task'
type QueueCoordinates = {
  ackReceipts: string
  claims: string
  processing: string
  ready: string
}
type WorkerHandle = {
  done: Promise<void>
  stop: () => Promise<void>
}

const COORDINATES: Record<QueueKind, QueueCoordinates> = {
  answers: {
    ackReceipts: 'forge:answers:ack-receipts',
    claims: 'forge:answers:claims',
    processing: 'forge:answers:processing',
    ready: 'forge:answers',
  },
  approval: {
    ackReceipts: 'forge:approvals:ack-receipts',
    claims: 'forge:approvals:claims',
    processing: 'forge:approvals:processing',
    ready: 'forge:approvals',
  },
  task: {
    ackReceipts: 'forge:tasks:ack-receipts',
    claims: 'forge:tasks:claims',
    processing: 'forge:tasks:processing',
    ready: 'forge:tasks',
  },
}

function architectPlan(): string {
  return [
    'Recovered queue occurrence plan',
    '',
    'Implementation steps:',
    '- [Backend] Prove the recovered owner resumes the exact occurrence.',
    '',
    'Verification steps:',
    '- Confirm only the recovered owner completes the queue attempt.',
    '',
    '```agent_breakdown_json',
    '{"agents":[{"role":"Backend","tasks":1,"summary":"Prove exact queue occurrence adoption"}]}',
    '```',
    '',
    '```capability_classification_json',
    '{"schemaVersion":1,"required":["business-logic"],"optional":[],"excluded":[]}',
    '```',
    '',
    '```mcp_execution_design_json',
    '{"schemaVersion":1,"requirements":[],"promptOverlays":{},"requirementContexts":[],"mcpAwareSubtasks":[]}',
    '```',
    '',
    '```open_questions_json',
    '{"questions":[]}',
    '```',
  ].join('\n')
}

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseClaimedOccurrence(
  raw: string,
  kind: QueueKind,
  expectedTaskId: string,
): { occurrenceId: string } | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const envelope = value as Record<string, unknown>
    if (!hasExactKeys(envelope, ['schemaVersion', 'occurrenceId', 'job'])
      || envelope.schemaVersion !== 1
      || typeof envelope.occurrenceId !== 'string'
      || !CANONICAL_UUID_PATTERN.test(envelope.occurrenceId)
      || !envelope.job || typeof envelope.job !== 'object' || Array.isArray(envelope.job)) {
      return null
    }
    const job = envelope.job as Record<string, unknown>
    const expectedJobKeys = kind === 'approval'
      ? ['taskId', 'action', 'attempt']
      : ['taskId', 'attempt']
    const attempt = job.attempt
    if (!hasExactKeys(job, expectedJobKeys)
      || job.taskId !== expectedTaskId
      || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1
      || (kind === 'approval' && job.action !== 'approve')) {
      return null
    }
    const canonicalJob = kind === 'approval'
      ? { taskId: job.taskId, action: job.action, attempt: job.attempt }
      : { taskId: job.taskId, attempt: job.attempt }
    const canonical = JSON.stringify({
      schemaVersion: 1,
      occurrenceId: envelope.occurrenceId,
      job: canonicalJob,
    })
    return canonical === raw ? { occurrenceId: envelope.occurrenceId } : null
  } catch {
    return null
  }
}

function markerNonce(marker: string): string {
  const parts = marker.split(':')
  if (parts.length !== 2 || !parts[1]) {
    throw new Error('Queue adoption proof observed an invalid claim marker.')
  }
  return parts[1]
}

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

const MAX_FAILURE_DIAGNOSTIC_ITEMS = 9

function answerFailureDiagnosticSnapshot(input: {
  attempts: Array<{ status: string }>
  latestArchitectRun: { errorMessage: string | null; status: string } | undefined
  providerCalls: number
  task: { errorMessage: string | null; status: string } | undefined
}): string {
  return JSON.stringify({
    attemptStatusCount: Math.min(input.attempts.length, MAX_FAILURE_DIAGNOSTIC_ITEMS),
    attemptStatuses: input.attempts.slice(0, MAX_FAILURE_DIAGNOSTIC_ITEMS).map(({ status }) => status),
    latestArchitectRun: input.latestArchitectRun
      ? { hasError: input.latestArchitectRun.errorMessage !== null, status: input.latestArchitectRun.status }
      : null,
    providerCallCount: Math.min(input.providerCalls, MAX_FAILURE_DIAGNOSTIC_ITEMS),
    task: input.task
      ? { hasError: input.task.errorMessage !== null, status: input.task.status }
      : null,
  })
}

describe('queue occurrence adoption diagnostic redaction', () => {
  it('ignores a transient legacy processing payload until the canonical target envelope arrives', () => {
    const taskId = '11111111-1111-4111-8111-111111111111'
    const occurrenceId = '22222222-2222-4222-8222-222222222222'
    const transientLegacy = JSON.stringify({ attempt: 1, taskId })
    const canonical = JSON.stringify({
      schemaVersion: 1,
      occurrenceId,
      job: { taskId, attempt: 1 },
    })

    expect(parseClaimedOccurrence(transientLegacy, 'task', taskId)).toBeNull()
    expect(parseClaimedOccurrence(canonical, 'task', taskId)).toEqual({ occurrenceId })
  })

  it('never emits hostile failure values or value-derived surrogates', () => {
    const hostilePlan = 'HOSTILE_PLAN_TEXT'
    const hostileAnswer = 'HOSTILE_ANSWER_TEXT'
    const hostilePayload = 'HOSTILE_PAYLOAD_TEXT'
    const hostileCredential = 'HOSTILE_CREDENTIAL_TEXT'
    const hostileMarker = 'HOSTILE_MARKER_TEXT'
    const hostileNonce = 'HOSTILE_NONCE_TEXT'
    const hostileProvider = 'HOSTILE_PROVIDER_TEXT'
    const hostileError = 'HOSTILE_ERROR_TEXT'
    const diagnostic = answerFailureDiagnosticSnapshot({
      attempts: Array.from({ length: 20 }, () => ({ status: 'failed' })),
      latestArchitectRun: { errorMessage: `${hostilePlan}:${hostileAnswer}:${hostileProvider}:${hostileError}`, status: 'failed' },
      providerCalls: 20,
      task: { errorMessage: `${hostilePayload}:${hostileCredential}:${hostileMarker}:${hostileNonce}`, status: 'failed' },
    })

    for (const value of [
      hostilePlan, hostileAnswer, hostilePayload, hostileCredential,
      hostileMarker, hostileNonce, hostileProvider, hostileError,
    ]) {
      expect(diagnostic).not.toContain(value)
    }
    expect(diagnostic).not.toMatch(/digest|hash|length|sha/i)
    expect(JSON.parse(diagnostic)).toEqual({
      attemptStatusCount: 9,
      attemptStatuses: Array.from({ length: 9 }, () => 'failed'),
      latestArchitectRun: { hasError: true, status: 'failed' },
      providerCallCount: 9,
      task: { hasError: true, status: 'failed' },
    })
  })
})

describe('queue occurrence adoption cleanup discipline', () => {
  it('aggregates fixed failures, runs every stage, and restores endpoints', async () => {
    const original = new Map(moduleEndpointEnvNames.map((name) => [name, process.env[name]]))
    const hostileRedisFailure = 'HOSTILE_REDIS_CLEANUP_TEXT'
    const hostileS4Failure = 'HOSTILE_S4_DEACTIVATION_TEXT'
    const ran: CleanupCategory[] = []
    process.env.DATABASE_URL = 'HOSTILE_DATABASE_ENDPOINT'
    delete process.env.REDIS_URL

    try {
      let report = ''
      try {
        await runCleanupStages([
          { category: 'redis_cleanup', run: () => { ran.push('redis_cleanup'); throw new Error(hostileRedisFailure) } },
          { category: 's4_deactivate', run: () => { ran.push('s4_deactivate'); throw new Error(hostileS4Failure) } },
          { category: 'redis_quit', run: () => { ran.push('redis_quit') } },
          { category: 'sql_close', run: () => { ran.push('sql_close') } },
          { category: 'admin_close', run: () => { ran.push('admin_close') } },
          {
            category: 'endpoint_restore',
            run: () => {
              ran.push('endpoint_restore')
              restoreEnvironment(moduleEndpointEnvNames, original)
              verifyEnvironmentRestored(moduleEndpointEnvNames, original)
            },
          },
        ])
      } catch (error) {
        report = error instanceof Error ? error.message : 'unexpected_cleanup_failure'
      }

      expect(report).toBe('Queue adoption cleanup failed: redis_cleanup,s4_deactivate')
      expect(ran).toEqual([
        'redis_cleanup', 's4_deactivate', 'redis_quit', 'sql_close', 'admin_close', 'endpoint_restore',
      ])
      expect(report).not.toContain(hostileRedisFailure)
      expect(report).not.toContain(hostileS4Failure)
      expect(report).not.toMatch(/digest|hash|length|sha/i)
      expect(() => verifyEnvironmentRestored(moduleEndpointEnvNames, original)).not.toThrow()
    } finally {
      restoreEnvironment(moduleEndpointEnvNames, original)
      verifyEnvironmentRestored(moduleEndpointEnvNames, original)
    }
  })
})

describe.skipIf(!enabled)('queue occurrence adoption with production runtimes', () => {
  let redis: Redis
  let sql: ReturnType<typeof postgres>
  let admin: ReturnType<typeof postgres>
  let redisInitialized = false
  let adminInitialized = false
  let projectId: string
  let providerId: string
  const authority = {
    enablementReceipt: randomUUID(),
    readinessReceipt: randomUUID(),
    signerKey: randomUUID(),
  }
  const protectedDigestKeyHex = 'c'.repeat(64)
  const protectedDigestKeyId = 'queue-adoption-key'
  const handles = new Set<WorkerHandle>()
  const priorEnv = new Map<string, string | undefined>()
  const envNames = [
    'FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS',
    'FORGE_HOST_REPOSITORY_WRITES',
    'FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS',
    'FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS',
    'FORGE_WORKER_CLAIM_TIMEOUT_SECONDS',
    'FORGE_WORKER_MAX_ATTEMPTS',
    'FORGE_WORKER_MOCK_ARCHITECT',
    'FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS',
    'FORGE_WORKFORCE_MATERIALIZATION',
    'FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL',
    'FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL',
    'FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX',
    'FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID',
    'FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL',
    'DATABASE_URL',
    'REDIS_URL',
  ] as const

  async function redisTimeMs(): Promise<number> {
    const reply = await redis.time()
    return (Number(reply[0]) * 1000) + Math.floor(Number(reply[1]) / 1000)
  }

  async function cleanRedis(): Promise<void> {
    const existing = await redis.exists(...QUEUE_KEYS)
    if (existing > 0) await redis.del(...QUEUE_KEYS)
    if (await redis.dbsize() !== 0) {
      throw new Error('Queue adoption proof did not restore its disposable Redis database.')
    }
  }

  function configureRuntimeEnvironment(): void {
    for (const name of envNames) priorEnv.set(name, process.env[name])
    process.env.REDIS_URL = proofRedisUrl!
    process.env.FORGE_BLOCKED_HANDOFF_SWEEP_INTERVAL_SECONDS = '0'
    process.env.FORGE_HOST_REPOSITORY_WRITES = '0'
    process.env.FORGE_PROVIDER_HEALTH_INTERVAL_SECONDS = '0'
    process.env.FORGE_SESSION_CACHE_PURGE_INTERVAL_SECONDS = '0'
    process.env.FORGE_WORKER_CLAIM_TIMEOUT_SECONDS = '1'
    process.env.FORGE_WORKER_MAX_ATTEMPTS = '3'
    process.env.FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS = '1'
    process.env.FORGE_WORKFORCE_MATERIALIZATION = '1'
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX = protectedDigestKeyHex
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID = protectedDigestKeyId
    delete process.env.FORGE_WORKER_MOCK_ARCHITECT
  }

  function restoreRuntimeEnvironment(): void {
    for (const name of envNames) {
      const value = priorEnv.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    priorEnv.clear()
  }

  function installExternalBoundaryMocks(streamText: ReturnType<typeof vi.fn>): void {
    vi.doMock('ai', async (importOriginal) => ({
      ...await importOriginal<typeof import('ai')>(),
      streamText,
    }))
    vi.doMock('@/lib/providers/registry', async (importOriginal) => ({
      ...await importOriginal<typeof import('@/lib/providers/registry')>(),
      getModel: vi.fn().mockResolvedValue({ modelId: 'queue-adoption-model' }),
      getProvider: vi.fn().mockResolvedValue({
        config: {
          apiKeyCiphertext: null,
          apiKeyEnvVar: null,
          baseUrl: null,
          createdAt: new Date('2026-07-29T00:00:00.000Z'),
          displayName: 'Queue adoption provider',
          id: providerId,
          isLocal: false,
          isActive: true,
          modelId: 'queue-adoption-model',
          providerType: 'openai',
          updatedAt: new Date('2026-07-29T00:00:00.000Z'),
        },
      }),
    }))
    vi.doMock('@/lib/mcps/manager', async (importOriginal) => ({
      ...await importOriginal<typeof import('@/lib/mcps/manager')>(),
      getProjectMcpOverview: vi.fn().mockResolvedValue({
        catalog: [],
        config: {},
        missingRequired: [],
        projectId,
        statuses: [],
        summary: {},
        warnings: [],
      }),
    }))
    vi.doMock('@/lib/mcps/s4-lease', async (importOriginal) => ({
      ...await importOriginal<typeof import('@/lib/mcps/s4-lease')>(),
      readS4RuntimeModeV1: vi.fn().mockResolvedValue('protected'),
    }))
    vi.doMock('@/worker/events', () => ({
      publishTaskEvent: vi.fn().mockResolvedValue(undefined),
    }))
    vi.doMock('@/worker/checkpoints', async (importOriginal) => ({
      ...await importOriginal<typeof import('@/worker/checkpoints')>(),
      readLatestArchitectCheckpointSafely: vi.fn().mockResolvedValue(null),
      writeArchitectCheckpointSafely: vi.fn().mockResolvedValue({
        latestPath: '/tmp/queue-adoption-latest',
        runPath: '/tmp/queue-adoption-run',
      }),
    }))
  }

  async function importRuntime(): Promise<typeof import('@/worker/runtime')> {
    vi.resetModules()
    return import('@/worker/runtime')
  }

  async function enqueue(kind: QueueKind, taskId: string): Promise<void> {
    const job = kind === 'approval'
      ? { action: 'approve', attempt: 1, taskId }
      : { attempt: 1, taskId }
    await redis.lpush(COORDINATES[kind].ready, JSON.stringify(job))
  }

  async function runningAttempt(taskId: string): Promise<boolean> {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM task_attempts
      WHERE task_id = ${taskId}::uuid
        AND status = 'running'
    `
    return (row?.count ?? 0) > 0
  }

  async function claimedOccurrence(kind: QueueKind, expectedTaskId: string): Promise<{
    marker: string
    occurrenceId: string
    raw: string
  }> {
    const coordinates = COORDINATES[kind]
    const raw = await eventually(
      async () => {
        const entries = await redis.lrange(coordinates.processing, 0, 15)
        return entries.find((entry) => parseClaimedOccurrence(entry, kind, expectedTaskId) !== null) ?? null
      },
      (value): value is string => typeof value === 'string',
      'Queue adoption proof did not observe the canonical processing occurrence.',
    )
    if (raw === null) throw new Error('Queue adoption proof lost its canonical processing occurrence.')
    const occurrence = parseClaimedOccurrence(raw, kind, expectedTaskId)
    if (!occurrence) throw new Error('Queue adoption proof lost its canonical processing occurrence.')
    const { occurrenceId } = occurrence
    const marker = await eventually(
      () => redis.hget(coordinates.claims, occurrenceId),
      (value): value is string => typeof value === 'string',
      'Queue adoption proof did not observe the first claim marker.',
    )
    if (marker === null) throw new Error('Queue adoption proof lost its claim marker.')
    return { marker, occurrenceId, raw }
  }

  async function transferOccurrence(
    kind: QueueKind,
    first: { marker: string; occurrenceId: string },
    startRecoveredRuntime: () => Promise<WorkerHandle>,
  ): Promise<{ handle: WorkerHandle; marker: string }> {
    const coordinates = COORDINATES[kind]
    const originalNonce = markerNonce(first.marker)
    const staleTimestamp = (await redisTimeMs()) - 2_000
    await redis.hset(coordinates.claims, first.occurrenceId, `${staleTimestamp}:${originalNonce}`)
    const handle = await startRecoveredRuntime()
    handles.add(handle)

    const marker = await eventually(
      async () => {
        const current = await redis.hget(coordinates.claims, first.occurrenceId)
        if (current && markerNonce(current) === originalNonce) {
          await redis.hset(
            coordinates.claims,
            first.occurrenceId,
            `${(await redisTimeMs()) - 2_000}:${originalNonce}`,
          )
        }
        return current
      },
      (value) => typeof value === 'string' && markerNonce(value) !== originalNonce,
      'Queue adoption proof did not transfer the occurrence to the recovered runtime.',
    )
    if (marker === null) throw new Error('Queue adoption proof lost its recovered claim marker.')
    return { handle, marker }
  }

  async function answerFailureDiagnostic(taskId: string, providerCalls: number): Promise<string> {
    const [task] = await sql<{ errorMessage: string | null; status: string }[]>`
      SELECT status, error_message AS "errorMessage"
      FROM tasks
      WHERE id = ${taskId}::uuid
    `
    const [run] = await sql<{ errorMessage: string | null; status: string }[]>`
      SELECT status, error_message AS "errorMessage"
      FROM agent_runs
      WHERE task_id = ${taskId}::uuid
        AND agent_type = 'architect'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `
    const attempts = await sql<{ status: string }[]>`
      SELECT status
      FROM task_attempts
      WHERE task_id = ${taskId}::uuid
        AND queue_name = 'answers'
      ORDER BY created_at, id
    `
    return answerFailureDiagnosticSnapshot({ attempts, latestArchitectRun: run, providerCalls, task })
  }

  async function waitForFinalState(taskId: string, expected: string, answerProviderCalls?: () => number): Promise<void> {
    if (answerProviderCalls === undefined) {
      await eventually(
        async () => (await sql<{ status: string }[]>`
          SELECT status FROM tasks WHERE id = ${taskId}::uuid
        `)[0]?.status ?? null,
        (value) => value === expected,
        'Queue adoption proof did not reach its expected durable task state.',
        25_000,
      )
      return
    }

    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const [task] = await sql<{ status: string }[]>`
        SELECT status FROM tasks WHERE id = ${taskId}::uuid
      `
      if (task?.status === expected) return
      if (task?.status === 'failed') {
        throw new Error(`Queue adoption answers proof failed: ${await answerFailureDiagnostic(taskId, answerProviderCalls())}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Queue adoption answers proof timed out: ${await answerFailureDiagnostic(taskId, answerProviderCalls())}`)
  }

  async function assertOnlyRecoveredOwnerCompleted(input: {
    kind: QueueKind
    newMarker: string
    occurrenceId: string
    taskId: string
  }): Promise<void> {
    const coordinates = COORDINATES[input.kind]
    const queueName = input.kind === 'approval' ? 'approvals' : input.kind === 'task' ? 'tasks' : 'answers'
    const hasCompleteDurablePostcondition = async (): Promise<boolean> => {
      const attempts = await sql<{
        job_payload: unknown
        status: string
      }[]>`
        SELECT job_payload, status
        FROM task_attempts
        WHERE task_id = ${input.taskId}::uuid
          AND queue_name = ${queueName}
        ORDER BY created_at, id
      `
      if (attempts.length !== 2
        || attempts[0]?.status !== 'indeterminate'
        || attempts[1]?.status !== 'completed'
        || attempts.some((attempt) => {
          const payload = attempt.job_payload
          return typeof payload !== 'object' || payload === null
            || (payload as { schemaVersion?: unknown }).schemaVersion !== 1
            || (payload as { occurrenceId?: unknown }).occurrenceId !== input.occurrenceId
            || JSON.stringify(payload).includes('nonce')
        })) {
        return false
      }
      if (await redis.llen(coordinates.ready) !== 0
        || await redis.llen(coordinates.processing) !== 0
        || await redis.hget(coordinates.claims, input.occurrenceId) !== null) {
        return false
      }
      const newNonce = markerNonce(input.newMarker)
      return (await redis.zscore(coordinates.ackReceipts, `${input.occurrenceId}:${newNonce}`)) !== null
    }

    await eventually(
      hasCompleteDurablePostcondition,
      Boolean,
      'Queue adoption proof did not reach the complete durable recovered-owner postcondition.',
      25_000,
    )

    const attempts = await sql<{
      job_payload: unknown
      status: string
    }[]>`
      SELECT job_payload, status
      FROM task_attempts
      WHERE task_id = ${input.taskId}::uuid
        AND queue_name = ${queueName}
      ORDER BY created_at, id
    `
    expect(attempts.map((attempt) => attempt.status)).toEqual(['indeterminate', 'completed'])
    for (const attempt of attempts) {
      expect(attempt.job_payload).toEqual(expect.objectContaining({
        schemaVersion: 1,
        occurrenceId: input.occurrenceId,
      }))
      expect(JSON.stringify(attempt.job_payload)).not.toContain('nonce')
    }

    expect(await redis.llen(coordinates.ready)).toBe(0)
    expect(await redis.llen(coordinates.processing)).toBe(0)
    expect(await redis.hget(coordinates.claims, input.occurrenceId)).toBeNull()
    const newNonce = markerNonce(input.newMarker)
    expect(await redis.zscore(
      coordinates.ackReceipts,
      `${input.occurrenceId}:${newNonce}`,
    )).not.toBeNull()
  }

  async function insertTask(status: string): Promise<string> {
    const taskId = randomUUID()
    await sql`
      INSERT INTO tasks (id, project_id, title, prompt, status, pm_provider_config_id)
      VALUES (
        ${taskId}::uuid,
        ${projectId}::uuid,
        'Queue occurrence adoption proof',
        'Create a bounded queue adoption proof.',
        ${status},
        ${providerId}::uuid
      )
    `
    return taskId
  }

  async function insertCanonicalAnsweredQuestion(taskId: string): Promise<void> {
    const userId = randomUUID()
    const sessionCredential = randomUUID()
    const sessionId = randomUUID()
    const runId = randomUUID()
    const questionId = randomUUID()
    const answerId = randomUUID()
    const digestKey = Buffer.from(protectedDigestKeyHex, 'hex')
      await sql`
        INSERT INTO users (id, display_name) VALUES (${userId}::uuid, 'Queue adoption answer user')
      `
      await sql`
        UPDATE tasks SET submitted_by = ${userId}::uuid WHERE id = ${taskId}::uuid
      `
      await sql`
        INSERT INTO sessions (id, user_id, credential_digest_v1, expires_at, credential_storage_version)
        VALUES (${sessionId}::uuid, ${userId}::uuid,
          ${computeCredentialDigest(sessionCredential).digest}::bytea,
          clock_timestamp() + interval '1 hour', 2)
      `
      await sql`
        INSERT INTO agent_runs (id, task_id, agent_type, model_id_used, status)
        VALUES (${runId}::uuid, ${taskId}::uuid, 'architect', 'queue-adoption', 'completed')
      `
      const source = await recordArchitectPlanVersion({
        agentRunId: runId,
        digestKey,
        digestKeyId: protectedDigestKeyId,
        entries: [
          { agent: null, bindingFingerprint: null, content: 'Queue adoption plan.', entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null },
          { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' },
          { agent: null, bindingFingerprint: null, content: JSON.stringify({ schemaVersion: 1, questionId, question: 'Resume the queue adoption plan?', suggestions: [] }), entryId: `clarification_question:${questionId}`, entryKind: 'clarification_question', projectionEligible: false, requirementKey: null },
        ],
        planVersion: '1', taskId,
      })
      await sql`
        UPDATE artifacts
        SET metadata = ${JSON.stringify({
          entryCount: 3,
          historyAvailable: true,
          planVersion: '1',
          schemaVersion: 1,
          stage: 'architect_plan',
        })}::jsonb
        WHERE id = ${source.artifactId}::uuid
      `
      await sql`
        INSERT INTO task_questions (id, task_id, question_entry_id, source_plan_artifact_id, source_plan_version, status)
        VALUES (${questionId}::uuid, ${taskId}::uuid, ${`clarification_question:${questionId}`}, ${source.artifactId}::uuid, 1, 'open')
      `
      await appendArchitectClarificationAnswer({
        answer: 'yes', answerId, digestKey, digestKeyId: protectedDigestKeyId, questionId,
        sessionCredential, sourcePlanArtifactId: source.artifactId, sourcePlanVersion: '1', taskId,
      })
  }

  async function activateS4Authority(): Promise<void> {
    const [state] = await admin<{ state: string; ownerOperationId: string | null }[]>`
      SELECT state, owner_operation_id AS "ownerOperationId"
      FROM forge_epic_172_enablement_state WHERE singleton_id = 'epic-172'
    `
    if (state?.state !== 'disabled' || state.ownerOperationId !== null) {
      throw new Error('Queue adoption proof requires a canonically disabled isolated S4 authority.')
    }
    const builds = JSON.stringify([
      `issue_179_s4@${'a'.repeat(40)}`,
      `issue_180_s5@${'a'.repeat(40)}`,
      `issue_181_s6@${'a'.repeat(40)}`,
    ])
    await admin`
      INSERT INTO forge_release_signer_keys (id, generation, public_key_spki, github_app_id, ruleset_fingerprint, status, valid_from, valid_until)
      VALUES (${authority.signerKey}::uuid, 991, decode('00', 'hex'), 'queue-adoption-fixture', ${'7'.repeat(64)}, 'staged', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour')
    `
    for (const [id, kind, slice, transitionDigest, envelopeDigest, signature] of [
      [authority.enablementReceipt, 'ingress_and_issuance_enabled', 's4', '8'.repeat(64), 'a'.repeat(64), 'aa'],
      [authority.readinessReceipt, 's5_s6_release_ready', 's6', '9'.repeat(64), 'b'.repeat(64), 'bb'],
    ] as const) {
      await admin`
        INSERT INTO forge_epic_172_release_evidence (id, evidence_kind, owner_issue, owner_slice, exact_builds, required_evidence, reviewed_sha, epoch, predecessor_receipt_ids, predecessor_set_digest, transition_identity_digest, signer_key_id, signer_generation, github_app_id, controller_run_id, controller_job_id, envelope_digest, detached_signature, nonce, issued_at, envelope)
        VALUES (${id}::uuid, ${kind}, 179, ${slice}, ${builds}::text::jsonb,
          '[{"name":"postgres_fixture","measurementDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
          ${'a'.repeat(40)}, 2, '[]'::jsonb, ${'0'.repeat(64)}, ${transitionDigest}, ${authority.signerKey}::uuid, 991,
          'queue-adoption-fixture', 'queue-adoption-fixture', ${kind}, ${envelopeDigest}, decode(repeat(${signature}, 64), 'hex'), ${randomUUID()}::uuid, transaction_timestamp(), '{}'::jsonb)
      `
    }
    await admin`
      UPDATE forge_epic_172_enablement_state
      SET state = 'active', owner_operation_id = 'queue-adoption-fixture', exact_builds = ${builds}::text::jsonb,
          reviewed_sha = ${'a'.repeat(40)}, epoch = 2, enablement_receipt_id = ${authority.enablementReceipt}::uuid,
          final_readiness_receipt_id = ${authority.readinessReceipt}::uuid, state_fingerprint = ${'9'.repeat(64)}, updated_at = clock_timestamp()
      WHERE singleton_id = 'epic-172'
    `
    const [enabledState] = await admin<{ enabled: boolean }[]>`SELECT forge.s4_protected_paths_enabled_v1() AS enabled`
    if (!enabledState?.enabled) throw new Error('Queue adoption proof could not activate its isolated S4 authority.')
  }

  async function deactivateS4Authority(): Promise<void> {
    await admin`
      UPDATE forge_epic_172_enablement_state
      SET state = 'disabled', owner_operation_id = null, exact_builds = null, reviewed_sha = null, epoch = null,
          started_at = null, expires_at = null, enablement_receipt_id = null, final_readiness_receipt_id = null,
          opening_authorization_id = null, controller_login_id = null, controller_run_id = null, controller_token_digest = null,
          lease_generation = null, last_heartbeat_at = null, lease_expires_at = null,
          state_fingerprint = 'b0789177e07f4a9307f3397a938999b6fcc8c835a97e03d2770f83e4978c2585', updated_at = clock_timestamp()
      WHERE singleton_id = 'epic-172'
    `
    const [disabledState] = await admin<{ enabled: boolean }[]>`SELECT forge.s4_protected_paths_enabled_v1() AS enabled`
    if (disabledState?.enabled) throw new Error('Queue adoption proof could not restore its isolated S4 authority.')
  }

  async function insertRunningTaskAttempt(taskId: string, jobPayload: unknown): Promise<void> {
    await sql`
      INSERT INTO task_attempts (
        id, task_id, queue_name, attempt_number, worker_id, job_payload,
        status, claimed_at, started_at
      ) VALUES (
        ${randomUUID()}::uuid, ${taskId}::uuid, 'tasks', 1, 'negative-proof-owner',
        ${JSON.stringify(jobPayload)}::jsonb, 'running', clock_timestamp(), clock_timestamp()
      )
    `
  }

  async function occurrenceAttempts(taskId: string, occurrenceId: string): Promise<string[]> {
    const rows = await sql<{ status: string }[]>`
      SELECT status
      FROM task_attempts
      WHERE task_id = ${taskId}::uuid
        AND queue_name = 'tasks'
        AND job_payload->>'occurrenceId' = ${occurrenceId}
      ORDER BY created_at, id
    `
    return rows.map((row) => row.status)
  }

  beforeAll(async () => {
    redis = new Redis(proofRedisUrl!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    })
    redisInitialized = true
    await redis.connect()
    if (await redis.dbsize() !== 0) {
      throw new Error('Queue adoption proof requires an empty disposable Redis database.')
    }
    sql = postgres(databaseUrl!, { max: 8 })
    await sql`SELECT 1`
    admin = postgres(fixtureAdminUrl!, { max: 1, onnotice: () => {} })
    adminInitialized = true
    await activateS4Authority()

    providerId = randomUUID()
    projectId = randomUUID()
    await sql`
      INSERT INTO provider_configs (
        id, display_name, provider_type, model_id, is_local, is_active
      ) VALUES (
        ${providerId}::uuid,
        'Queue adoption proof provider',
        'openai',
        'queue-adoption-model',
        false,
        true
      )
    `
    await sql`
      INSERT INTO projects (id, name, mcp_config, default_branch)
      VALUES (
        ${projectId}::uuid,
        'Queue occurrence adoption proof',
        '{"profile":"custom","requiredMcps":[],"overrides":{}}'::jsonb,
        'main'
      )
    `
    await sql`
      INSERT INTO agent_configs (
        id, agent_type, display_name, description, is_system, is_active, system_prompt
      ) VALUES (
        ${randomUUID()}::uuid,
        'architect',
        'Architect',
        'Queue adoption proof Architect.',
        true,
        true,
        'Produce a bounded implementation plan.'
      )
      ON CONFLICT (agent_type) DO NOTHING
    `
    await sql`
      INSERT INTO agent_configs (
        id, agent_type, display_name, description, is_system, is_active, system_prompt
      ) VALUES (
        ${randomUUID()}::uuid,
        'backend',
        'Backend',
        'Queue adoption proof Backend.',
        true,
        true,
        'Implement backend work safely.'
      )
      ON CONFLICT (agent_type) DO NOTHING
    `
  })

  afterEach(async () => {
    for (const handle of handles) await handle.stop()
    handles.clear()
    delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime
    restoreRuntimeEnvironment()
    await cleanRedis()
    vi.restoreAllMocks()
    vi.doUnmock('ai')
    vi.doUnmock('@/lib/providers/registry')
    vi.doUnmock('@/lib/mcps/manager')
    vi.doUnmock('@/lib/mcps/s4-lease')
    vi.doUnmock('@/worker/events')
    vi.doUnmock('@/worker/checkpoints')
    vi.resetModules()
  })

  afterAll(async () => {
    await runCleanupStages([
      { category: 'redis_cleanup', run: async () => { if (redisInitialized) await cleanRedis() } },
      { category: 's4_deactivate', run: async () => { if (adminInitialized) await deactivateS4Authority() } },
      { category: 'redis_quit', run: async () => { await redis?.quit() } },
      { category: 'sql_close', run: async () => { await sql?.end({ timeout: 5 }) } },
      { category: 'admin_close', run: async () => { await admin?.end({ timeout: 5 }) } },
      {
        category: 'endpoint_restore',
        run: () => {
          try {
            restoreOriginalModuleEndpointEnvironment()
          } finally {
            assertOriginalModuleEndpointEnvironment()
          }
        },
      },
    ])
  })

  for (const kind of ['task', 'answers'] as const) {
    it(`lets only the recovered production ${kind} runtime resume and complete`, async () => {
      configureRuntimeEnvironment()
      const taskId = await insertTask(kind === 'task' ? 'pending' : 'awaiting_answers')
      if (kind === 'answers') {
        await insertCanonicalAnsweredQuestion(taskId)
      }

      let providerCalls = 0
      let firstProviderStarted!: () => void
      let firstProviderAborted!: (reason: unknown) => void
      let recoveredProviderStarted!: () => void
      let releaseRecoveredProvider!: () => void
      const firstStarted = new Promise<void>((resolve) => {
        firstProviderStarted = resolve
      })
      const firstAborted = new Promise<unknown>((resolve) => {
        firstProviderAborted = resolve
      })
      const recoveredStarted = new Promise<void>((resolve) => {
        recoveredProviderStarted = resolve
      })
      const recoveredGate = new Promise<void>((resolve) => {
        releaseRecoveredProvider = resolve
      })
      const streamText = vi.fn((input: { abortSignal: AbortSignal }) => {
        providerCalls += 1
        if (providerCalls === 1) {
          firstProviderStarted()
          return {
            textStream: {
              async *[Symbol.asyncIterator]() {
                await new Promise<void>((_resolve, reject) => {
                  const abort = () => {
                    firstProviderAborted(input.abortSignal.reason)
                    reject(input.abortSignal.reason)
                  }
                  if (input.abortSignal.aborted) abort()
                  else input.abortSignal.addEventListener('abort', abort, { once: true })
                })
              },
            },
            finishReason: Promise.resolve('stop'),
            usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
          }
        }
        if (providerCalls === 2) {
          recoveredProviderStarted()
          return {
            textStream: {
              async *[Symbol.asyncIterator]() {
                await recoveredGate
                yield architectPlan()
              },
            },
            finishReason: Promise.resolve('stop'),
            usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
          }
        }
        throw new Error('Queue adoption proof observed an unexpected provider call.')
      })
      installExternalBoundaryMocks(streamText)

      const runtimeA = await importRuntime()
      const handleA = await runtimeA.startWorker('standalone')
      handles.add(handleA)
      await enqueue(kind, taskId)
      await firstStarted
      await eventually(
        () => runningAttempt(taskId),
        Boolean,
        'Queue adoption proof did not persist the first running attempt.',
      )
      const first = await claimedOccurrence(kind, taskId)

      const runtimeB = await importRuntime()
      delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime
      const transferred = await transferOccurrence(
        kind,
        first,
        () => runtimeB.startWorker('standalone'),
      )
      await recoveredStarted
      const lossReason = await firstAborted
      expect(lossReason).toEqual(expect.objectContaining({ code: 'claim_lease_lost' }))
      releaseRecoveredProvider()

      await waitForFinalState(taskId, 'awaiting_approval', kind === 'answers' ? () => providerCalls : undefined)
      await assertOnlyRecoveredOwnerCompleted({
        kind,
        newMarker: transferred.marker,
        occurrenceId: first.occurrenceId,
        taskId,
      })
      expect(streamText).toHaveBeenCalledTimes(2)
      console.info(`QUEUE_OCCURRENCE_ADOPTION_${kind.toUpperCase()}_OK`)
    }, 45_000)
  }

  it('lets only the recovered production approval runtime complete running work', async () => {
    configureRuntimeEnvironment()
    const taskId = await insertTask('running')
    await sql`
      INSERT INTO work_packages (id, task_id, assigned_role, title, summary, sequence, status, review_requirement)
      VALUES (
        ${randomUUID()}::uuid, ${taskId}::uuid, 'backend',
        'Recovered approval package', 'A completed package for continuation recovery.',
        1, 'completed', 'none'
      )
    `
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const streamText = vi.fn(() => {
      throw new Error('Approval adoption proof must not launch an Architect provider.')
    })
    installExternalBoundaryMocks(streamText)

    let releaseTableLock!: () => void
    let tableLockReady!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      releaseTableLock = resolve
    })
    const lockReady = new Promise<void>((resolve) => {
      tableLockReady = resolve
    })
    const tableLock = sql.begin(async (transaction) => {
      await transaction`LOCK TABLE work_packages IN ACCESS EXCLUSIVE MODE`
      tableLockReady()
      await releaseGate
    })
    await lockReady

    try {
      const runtimeA = await importRuntime()
      const handleA = await runtimeA.startWorker('standalone')
      handles.add(handleA)
      await enqueue('approval', taskId)
      await eventually(
        () => runningAttempt(taskId),
        Boolean,
        'Approval adoption proof did not persist the first running attempt.',
      )
      await eventually(
        async () => Number((await sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND usename = current_user
            AND wait_event_type = 'Lock'
            AND query ILIKE '%work_packages%'
        `)[0]?.count ?? 0),
        (count) => count > 0,
        'Approval adoption proof did not observe the first production handler boundary.',
      )
      const first = await claimedOccurrence('approval', taskId)

      const runtimeB = await importRuntime()
      delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime
      const transferred = await transferOccurrence(
        'approval',
        first,
        () => runtimeB.startWorker('standalone'),
      )
      await eventually(
        async () => warn.mock.calls.some(([message, metadata]) =>
          message === '[worker] Queue claim lease lost'
          && (metadata as { queueName?: unknown } | undefined)?.queueName === 'approval'
          && (metadata as { taskId?: unknown } | undefined)?.taskId === taskId),
        Boolean,
        'Approval adoption proof did not observe the old runtime lose ownership.',
      )
      releaseTableLock()
      await tableLock

      await waitForFinalState(taskId, 'completed')
      await assertOnlyRecoveredOwnerCompleted({
        kind: 'approval',
        newMarker: transferred.marker,
        occurrenceId: first.occurrenceId,
        taskId,
      })
      expect(streamText).not.toHaveBeenCalled()
      console.info('QUEUE_OCCURRENCE_ADOPTION_APPROVAL_OK')
    } finally {
      releaseTableLock()
      await tableLock
    }
  }, 45_000)

  it.each([
    ['different occurrence', (taskId: string) => ({
      schemaVersion: 1,
      occurrenceId: randomUUID(),
      job: { attempt: 1, taskId },
    })],
    ['legacy payload', (taskId: string) => ({ attempt: 1, taskId })],
    ['malformed occurrence', (taskId: string) => ({
      schemaVersion: 1,
      occurrenceId: 'not-a-uuid',
      job: { attempt: 1, taskId },
    })],
  ])('keeps a %s occurrence unacked across repeated production recovery', async (_label, priorPayload) => {
    configureRuntimeEnvironment()
    const taskId = await insertTask('running')
    await insertRunningTaskAttempt(taskId, priorPayload(taskId))
    const streamText = vi.fn(() => {
      throw new Error('A refused occurrence must not launch the Architect boundary.')
    })
    installExternalBoundaryMocks(streamText)

    const runtimeA = await importRuntime()
    const handleA = await runtimeA.startWorker('standalone')
    handles.add(handleA)
    await enqueue('task', taskId)
    const first = await claimedOccurrence('task', taskId)
    await eventually(
      () => occurrenceAttempts(taskId, first.occurrenceId),
      (statuses) => statuses.length === 1 && statuses[0] === 'indeterminate',
      'Refused occurrence was not marked indeterminate before recovery.',
    )

    const runtimeB = await importRuntime()
    delete (globalThis as typeof globalThis & { forgeWorkerRuntime?: unknown }).forgeWorkerRuntime
    await transferOccurrence('task', first, () => runtimeB.startWorker('standalone'))
    await eventually(
      () => occurrenceAttempts(taskId, first.occurrenceId),
      (statuses) => statuses.length === 2 && statuses.every((status) => status === 'indeterminate'),
      'Repeated recovery incorrectly adopted its own refused occurrence.',
    )

    expect(streamText).not.toHaveBeenCalled()
    expect(await redis.llen(COORDINATES.task.processing)).toBe(1)
    expect(await redis.llen(COORDINATES.task.ready)).toBe(0)
    expect(await redis.zcard(COORDINATES.task.ackReceipts)).toBe(0)
    console.info('QUEUE_OCCURRENCE_NEGATIVE_RECOVERY_OK')
  }, 45_000)
})
