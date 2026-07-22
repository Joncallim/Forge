import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockDbSelect,
  mockDbInsert,
  mockDbUpdate,
  mockDbDelete,
  mockGetProvider,
  mockGetModel,
  mockGetProjectMcpOverview,
  mockMaterializeWorkforce,
  mockPublishTaskEvent,
  mockReadLatestArchitectCheckpointSafely,
  mockWriteArchitectCheckpointSafely,
  mockRecordArchitectPlanVersion,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbDelete: vi.fn(),
  mockGetProvider: vi.fn(),
  mockGetModel: vi.fn(),
  mockGetProjectMcpOverview: vi.fn(),
  mockMaterializeWorkforce: vi.fn(),
  mockPublishTaskEvent: vi.fn(),
  mockReadLatestArchitectCheckpointSafely: vi.fn(),
  mockWriteArchitectCheckpointSafely: vi.fn(),
  mockRecordArchitectPlanVersion: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
    delete: mockDbDelete,
  },
}))

vi.mock('@/lib/providers/registry', () => ({
  getProvider: mockGetProvider,
  getModel: mockGetModel,
}))

vi.mock('@/lib/mcps/manager', () => ({
  getProjectMcpOverview: mockGetProjectMcpOverview,
}))

vi.mock('@/worker/workforce-materializer', () => ({
  materializeWorkforceFromArchitectArtifact: mockMaterializeWorkforce,
}))

vi.mock('@/worker/events', () => ({
  publishTaskEvent: mockPublishTaskEvent,
}))

vi.mock('@/lib/mcps/s4-protocol-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/s4-protocol-store')>(),
  recordArchitectPlanVersion: mockRecordArchitectPlanVersion,
}))

vi.mock('@/worker/checkpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/worker/checkpoints')>()
  return {
    ...actual,
    readLatestArchitectCheckpointSafely: mockReadLatestArchitectCheckpointSafely,
    writeArchitectCheckpointSafely: mockWriteArchitectCheckpointSafely,
  }
})

type ChainHooks = {
  set?: (value: unknown) => void
  values?: (value: unknown) => void
}

function chain(resolveValue: unknown, hooks: ChainHooks = {}) {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  const methods = [
    'from',
    'innerJoin',
    'where',
    'limit',
    'orderBy',
    'returning',
    'set',
    'values',
  ]
  methods.forEach((method) => {
    thenable[method] = (value: unknown) => {
      if (method === 'set') hooks.set?.(value)
      if (method === 'values') hooks.values?.(value)
      return thenable
    }
  })
  return thenable
}

const repoRoot = path.resolve(__dirname, '..')

describe('answered-question retry contract', () => {
  const previousMockArchitect = process.env.FORGE_WORKER_MOCK_ARCHITECT
  const previousArchitectPlanWriterUrl = process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL
  const selectResults: unknown[] = []
  const insertResults: unknown[] = []
  const updateResults: unknown[] = []
  const deleteResults: unknown[] = []
  const updateSets: unknown[] = []
  const insertValues: unknown[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX = 'a'.repeat(64)
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID = 'test-v1'
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = 'postgresql://writer/test'
    mockRecordArchitectPlanVersion.mockResolvedValue({
      artifactId: 'artifact-1',
      entries: [{ entryId: 'plan_body:000000' }],
      entrySetDigest: `hmac-sha256:${'a'.repeat(64)}`,
    })
    vi.resetModules()
    selectResults.length = 0
    insertResults.length = 0
    updateResults.length = 0
    deleteResults.length = 0
    updateSets.length = 0
    insertValues.length = 0

    process.env.FORGE_WORKER_MOCK_ARCHITECT = '1'
    mockDbSelect.mockImplementation(() => chain(selectResults.shift() ?? []))
    mockDbInsert.mockImplementation(() =>
      chain(insertResults.shift() ?? [], {
        values: (value) => insertValues.push(value),
      }),
    )
    mockDbUpdate.mockImplementation(() =>
      chain(updateResults.shift() ?? undefined, {
        set: (value) => updateSets.push(value),
      }),
    )
    mockDbDelete.mockImplementation(() => chain(deleteResults.shift() ?? undefined))
    mockPublishTaskEvent.mockResolvedValue(undefined)
    mockReadLatestArchitectCheckpointSafely.mockResolvedValue(null)
    mockWriteArchitectCheckpointSafely.mockResolvedValue({
      runPath: '/tmp/forge-run.md',
      latestPath: '/tmp/forge-latest.md',
    })
    mockGetProvider.mockResolvedValue({
      config: { id: 'provider-1', modelId: 'mock-model' },
    })
    mockGetModel.mockResolvedValue({ modelId: 'mock-model' })
    mockGetProjectMcpOverview.mockResolvedValue({
      catalog: [],
      statuses: [],
      missingRequired: [],
      warnings: [],
    })
    mockMaterializeWorkforce.mockRejectedValue(new Error('materialize failed'))
  })

  afterEach(() => {
    if (previousMockArchitect === undefined) {
      delete process.env.FORGE_WORKER_MOCK_ARCHITECT
    } else {
      process.env.FORGE_WORKER_MOCK_ARCHITECT = previousMockArchitect
    }
    if (previousArchitectPlanWriterUrl === undefined) {
      delete process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL
    } else {
      process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = previousArchitectPlanWriterUrl
    }
  })

  it('passes finalAttempt into answered-question processing', () => {
    const runtimeSource = fs.readFileSync(path.join(repoRoot, 'worker/runtime.ts'), 'utf8')

    expect(runtimeSource).toContain(
      'await processAnsweredQuestions(claimedAnswers.job.taskId, { finalAttempt })',
    )
  })

  it('acknowledges retry jobs for deleted tasks before writing attempt rows', () => {
    const runtimeSource = fs.readFileSync(path.join(repoRoot, 'worker/runtime.ts'), 'utf8')

    expect(runtimeSource).toContain('Dropped job for deleted task')
    expect(runtimeSource).toContain('acknowledgeMissingTaskJob(')
    expect(runtimeSource.indexOf('acknowledgeMissingTaskJob(')).toBeLessThan(
      runtimeSource.indexOf('startTaskAttempt({'),
    )
  })

  it('restores answered rows and awaiting_answers status on retryable re-plan failure', async () => {
    const task = {
      id: 'task-answers',
      projectId: 'project-1',
      title: 'Answer follow-up',
      prompt: 'Plan the work',
      status: 'awaiting_answers',
      pmProviderConfigId: null,
    }
    const project = {
      id: 'project-1',
      name: 'Retry Project',
      githubRepo: 'owner/repo',
      localPath: '/tmp/retry-project',
      defaultBranch: 'main',
    }
    const answeredRows = [
      {
        id: 'question-1',
        taskId: task.id,
        question: 'Which branch?',
        suggestions: ['main'],
        answer: 'main',
        status: 'answered',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        answeredAt: new Date('2026-01-01T00:01:00Z'),
        answeredBy: 'user-1',
      },
    ]
    const restoredRows = [
      {
        id: 'restored-question-1',
        taskId: task.id,
        question: 'Which branch?',
        suggestions: [],
        answer: 'main',
        status: 'answered',
      },
    ]

    selectResults.push(
      [{ task, project }],
      answeredRows,
      [{
        id: 'agent-config-architect',
        agentType: 'architect',
        displayName: 'Architect',
        description: '',
        isSystem: true,
        isActive: true,
        providerConfigId: 'provider-1',
        systemPrompt: 'Plan carefully.',
      }],
      [],
      [],
    )
    updateResults.push(
      [{ id: task.id }],
      [{
        id: 'artifact-1',
        agentRunId: 'run-1',
        artifactType: 'adr_text',
        content: 'Architect plan available in protected history',
        metadata: {},
        createdAt: new Date('2026-01-01T00:03:00Z'),
      }],
      undefined,
      [{ id: task.id }],
    )
    insertResults.push(
      [{
        id: 'run-1',
        taskId: task.id,
        agentType: 'architect',
        providerConfigId: 'provider-1',
        modelIdUsed: 'mock-model',
        status: 'running',
        startedAt: new Date('2026-01-01T00:02:00Z'),
      }],
      restoredRows,
    )
    deleteResults.push(undefined, undefined)

    const { processAnsweredQuestions } = await import('@/worker/orchestrator')

    await expect(processAnsweredQuestions(task.id, { finalAttempt: false })).rejects.toThrow(
      /materialize failed/,
    )

    expect(mockMaterializeWorkforce).toHaveBeenCalledOnce()
    expect(mockDbDelete).toHaveBeenCalledTimes(2)
    expect(insertValues).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            taskId: task.id,
            question: 'Which branch?',
            answer: 'main',
            status: 'answered',
          }),
        ]),
      ]),
    )
    expect(updateSets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'awaiting_answers' }),
      ]),
    )
    expect(mockWriteArchitectCheckpointSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        taskStatus: 'awaiting_answers',
        checkpointKind: 'architect-failure',
        errorMessage: 'materialize failed',
      }),
    )
    expect(mockPublishTaskEvent).toHaveBeenCalledWith(
      task.id,
      'questions:created',
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            question: 'Which branch?',
            answer: 'main',
            status: 'answered',
          }),
        ],
      }),
    )
  })
})
