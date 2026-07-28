import { randomUUID } from 'node:crypto'
import { randomBytes } from 'node:crypto'
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

if (required && (!destructive || !redisUrl || !databaseUrl)) {
  throw new Error(
    'Mandatory queue adoption proof requires dedicated Redis, PostgreSQL, and destructive-test authorization.',
  )
}

const enabled = Boolean(destructive && redisUrl && databaseUrl)
const proofRedisUrl = enabled ? validatedRedisUrl(redisUrl!) : null

// DB and queue modules cache their connections at import time. Bind the
// dedicated proof endpoints before any production worker module is imported;
// this makes CI's DB 12 proof unable to observe the shared worker Redis URL.
if (enabled) {
  process.env.DATABASE_URL = databaseUrl!
  process.env.REDIS_URL = proofRedisUrl!
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

function parseOccurrence(raw: string): { occurrenceId: string } {
  const value = JSON.parse(raw) as { occurrenceId?: unknown }
  if (typeof value.occurrenceId !== 'string') {
    throw new Error('Queue adoption proof observed an invalid occurrence envelope.')
  }
  return { occurrenceId: value.occurrenceId }
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

describe.skipIf(!enabled)('queue occurrence adoption with production runtimes', () => {
  let redis: Redis
  let sql: ReturnType<typeof postgres>
  let projectId: string
  let providerId: string
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
      readS4RuntimeModeV1: vi.fn().mockResolvedValue('legacy'),
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

  async function claimedOccurrence(kind: QueueKind): Promise<{
    marker: string
    occurrenceId: string
    raw: string
  }> {
    const coordinates = COORDINATES[kind]
    const raw = await eventually(
      () => redis.lindex(coordinates.processing, 0),
      (value): value is string => typeof value === 'string',
      'Queue adoption proof did not observe the first processing occurrence.',
    )
    if (raw === null) throw new Error('Queue adoption proof lost its processing occurrence.')
    const { occurrenceId } = parseOccurrence(raw)
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

  async function waitForFinalState(taskId: string, expected: string): Promise<void> {
    await eventually(
      async () => (await sql<{ status: string }[]>`
        SELECT status FROM tasks WHERE id = ${taskId}::uuid
      `)[0]?.status ?? null,
      (value) => value === expected,
      'Queue adoption proof did not reach its expected durable task state.',
      25_000,
    )
  }

  async function assertOnlyRecoveredOwnerCompleted(input: {
    kind: QueueKind
    newMarker: string
    occurrenceId: string
    taskId: string
  }): Promise<void> {
    const attempts = await sql<{
      job_payload: unknown
      status: string
    }[]>`
      SELECT job_payload, status
      FROM task_attempts
      WHERE task_id = ${input.taskId}::uuid
        AND queue_name = ${input.kind === 'approval' ? 'approvals' : input.kind === 'task' ? 'tasks' : 'answers'}
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

    const coordinates = COORDINATES[input.kind]
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
    const digestKey = randomBytes(32)
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
        digestKeyId: 'queue-adoption-key',
        entries: [
          { agent: null, bindingFingerprint: null, content: 'Queue adoption plan.', entryId: 'plan_body:000000', entryKind: 'plan_body', projectionEligible: false, requirementKey: null },
          { agent: null, bindingFingerprint: null, content: JSON.stringify({ requirementKey: 'plan-policy', schemaVersion: 1 }), entryId: 'requirement:plan-policy', entryKind: 'requirement', projectionEligible: false, requirementKey: 'plan-policy' },
          { agent: null, bindingFingerprint: null, content: JSON.stringify({ schemaVersion: 1, questionId, question: 'Resume the queue adoption plan?', suggestions: [] }), entryId: `clarification_question:${questionId}`, entryKind: 'clarification_question', projectionEligible: false, requirementKey: null },
        ],
        planVersion: '1', taskId,
      })
      await sql`
        INSERT INTO task_questions (id, task_id, question_entry_id, source_plan_artifact_id, source_plan_version, status)
        VALUES (${questionId}::uuid, ${taskId}::uuid, ${`clarification_question:${questionId}`}, ${source.artifactId}::uuid, 1, 'open')
      `
      await appendArchitectClarificationAnswer({
        answer: 'yes', answerId, digestKey, digestKeyId: 'queue-adoption-key', questionId,
        sessionCredential, sourcePlanArtifactId: source.artifactId, sourcePlanVersion: '1', taskId,
      })
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
    await redis.connect()
    if (await redis.dbsize() !== 0) {
      throw new Error('Queue adoption proof requires an empty disposable Redis database.')
    }
    sql = postgres(databaseUrl!, { max: 8 })
    await sql`SELECT 1`

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
    try {
      await cleanRedis()
    } finally {
      await redis?.quit()
      await sql?.end({ timeout: 5 })
    }
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
      const first = await claimedOccurrence(kind)

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

      await waitForFinalState(taskId, 'awaiting_approval')
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
      const first = await claimedOccurrence('approval')

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
    const first = await claimedOccurrence('task')
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
