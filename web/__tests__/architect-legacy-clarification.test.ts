import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockBuildWebResearchContext,
  mockDbDelete,
  mockDbInsert,
  mockDbSelect,
  mockDbUpdate,
  mockGetModel,
  mockGetProjectMcpOverview,
  mockGetProvider,
  mockGetWorkspaceSettings,
  mockLoadCurrentProjectFilesystemDecision,
  mockPublishTaskEvent,
  mockReadS4RuntimeModeV1,
  mockRecordArchitectPlanVersion,
  mockRecordTaskLogBestEffort,
  mockStreamText,
  mockUpdateTaskStatusIfCurrent,
  mockWriteArchitectCheckpointSafely,
} = vi.hoisted(() => ({
  mockBuildWebResearchContext: vi.fn(),
  mockDbDelete: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockGetModel: vi.fn(),
  mockGetProjectMcpOverview: vi.fn(),
  mockGetProvider: vi.fn(),
  mockGetWorkspaceSettings: vi.fn(),
  mockLoadCurrentProjectFilesystemDecision: vi.fn(),
  mockPublishTaskEvent: vi.fn(),
  mockReadS4RuntimeModeV1: vi.fn(),
  mockRecordArchitectPlanVersion: vi.fn(),
  mockRecordTaskLogBestEffort: vi.fn(),
  mockStreamText: vi.fn(),
  mockUpdateTaskStatusIfCurrent: vi.fn(),
  mockWriteArchitectCheckpointSafely: vi.fn(),
}))

vi.mock('ai', () => ({ streamText: mockStreamText }))

vi.mock('@/db', () => ({
  db: {
    delete: mockDbDelete,
    insert: mockDbInsert,
    select: mockDbSelect,
    update: mockDbUpdate,
  },
}))

vi.mock('@/lib/providers/registry', () => ({
  getModel: mockGetModel,
  getProvider: mockGetProvider,
  providerExecutionSnapshot: (config: {
    id: string
    isLocal: boolean
    modelId: string
    providerType: string
    updatedAt: Date
  }) => ({
    acpExecutionMode: 'not_applicable',
    configId: config.id,
    fingerprint: 'provider-snapshot',
    isLocal: config.isLocal,
    modelId: config.modelId,
    providerType: config.providerType,
    updatedAt: config.updatedAt,
  }),
}))

vi.mock('@/lib/providers/default', () => ({
  resolveDefaultProvider: vi.fn(),
}))

vi.mock('@/lib/mcps/manager', () => ({
  getProjectMcpOverview: mockGetProjectMcpOverview,
}))

vi.mock('@/lib/mcps/filesystem-grant-reconciliation', () => ({
  loadCurrentProjectFilesystemDecision: mockLoadCurrentProjectFilesystemDecision,
}))

vi.mock('@/lib/workspace', () => ({
  displayPathForWorkspacePath: vi.fn(),
  getWorkspaceSettings: mockGetWorkspaceSettings,
}))

vi.mock('@/worker/architect-context', () => ({
  buildSpecialistContext: vi.fn(() => ''),
  buildWebResearchContext: mockBuildWebResearchContext,
  detectSoftwareProfile: vi.fn(() => ({ kind: 'software' })),
}))

vi.mock('@/worker/events', () => ({
  publishTaskEvent: mockPublishTaskEvent,
}))

vi.mock('@/worker/task-logs', () => ({
  recordTaskLogBestEffort: mockRecordTaskLogBestEffort,
}))

vi.mock('@/worker/task-state', () => ({
  updateTaskStatus: vi.fn(),
  updateTaskStatusIfCurrent: mockUpdateTaskStatusIfCurrent,
}))

vi.mock('@/worker/checkpoints', () => ({
  readLatestArchitectCheckpointSafely: vi.fn().mockResolvedValue(null),
  writeArchitectCheckpointSafely: mockWriteArchitectCheckpointSafely,
}))

vi.mock('@/worker/workforce-materializer', () => ({
  materializeWorkforceFromArchitectArtifact: vi.fn(),
}))

vi.mock('@/lib/mcps/s4-lease', () => ({
  readS4RuntimeModeV1: mockReadS4RuntimeModeV1,
}))

vi.mock('@/lib/mcps/s4-protocol-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/s4-protocol-store')>(),
  bindArchitectReplanContext: vi.fn(),
  recordArchitectPlanVersion: mockRecordArchitectPlanVersion,
  resolveArchitectReplanEntry: vi.fn(),
}))

type ChainHooks = {
  set?: (value: unknown) => void
  values?: (value: unknown) => void
}

function chain(resolveValue: unknown, hooks: ChainHooks = {}) {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(onFulfilled, onRejected),
  }
  for (const method of [
    'from',
    'innerJoin',
    'limit',
    'orderBy',
    'returning',
    'set',
    'values',
    'where',
  ]) {
    thenable[method] = (value: unknown) => {
      if (method === 'set') hooks.set?.(value)
      if (method === 'values') hooks.values?.(value)
      return thenable
    }
  }
  return thenable
}

const taskId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const runId = '33333333-3333-4333-8333-333333333333'
const artifactId = '44444444-4444-4444-8444-444444444444'
const questionId = '55555555-5555-4555-8555-555555555555'
const questionText = 'Which branch should receive the change?'
const planText = [
  '# Implementation plan',
  '',
  'Confirm the target branch before changing the repository.',
  '',
  '```open_questions_json',
  JSON.stringify({
    questions: [{ question: questionText, suggestions: ['main', 'release'] }],
  }),
  '```',
].join('\n')

describe('Architect clarification storage mode', () => {
  const priorEnv = {
    digestKey: process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX,
    digestKeyId: process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID,
    mockArchitect: process.env.FORGE_WORKER_MOCK_ARCHITECT,
    writerUrl: process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL,
  }

  const selectResults: unknown[] = []
  const insertResults: unknown[] = []
  const updateResults: unknown[] = []
  const insertedValues: unknown[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    selectResults.length = 0
    insertResults.length = 0
    updateResults.length = 0
    insertedValues.length = 0

    delete process.env.FORGE_WORKER_MOCK_ARCHITECT
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX = 'a'.repeat(64)
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID = 'test-key-v1'
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = 'postgresql://writer/test'

    mockDbSelect.mockImplementation(() => chain(selectResults.shift() ?? []))
    mockDbInsert.mockImplementation(() => chain(insertResults.shift() ?? [], {
      values: (value) => insertedValues.push(value),
    }))
    mockDbUpdate.mockImplementation(() => chain(updateResults.shift() ?? []))
    mockDbDelete.mockImplementation(() => chain(undefined))
    mockGetModel.mockResolvedValue({})
    mockGetProvider.mockResolvedValue({
      config: {
        displayName: 'Test provider',
        id: 'provider-1',
        isLocal: false,
        modelId: 'test-model',
        providerType: 'openai',
        updatedAt: new Date('2026-07-30T00:00:00.000Z'),
      },
    })
    mockGetProjectMcpOverview.mockResolvedValue({
      catalog: [],
      missingRequired: [],
      statuses: [],
      warnings: [],
    })
    mockGetWorkspaceSettings.mockResolvedValue({})
    mockLoadCurrentProjectFilesystemDecision.mockResolvedValue(null)
    mockBuildWebResearchContext.mockResolvedValue('')
    mockPublishTaskEvent.mockResolvedValue(undefined)
    mockRecordTaskLogBestEffort.mockResolvedValue(undefined)
    mockUpdateTaskStatusIfCurrent.mockResolvedValue(true)
    mockWriteArchitectCheckpointSafely.mockResolvedValue({
      latestPath: '/tmp/latest.md',
      runPath: '/tmp/run.md',
    })
    mockStreamText.mockReturnValue({
      finishReason: Promise.resolve('stop'),
      textStream: (async function* () {
        yield planText
      })(),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 20 }),
    })
  })

  afterEach(() => {
    for (const [name, value] of [
      ['FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX', priorEnv.digestKey],
      ['FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID', priorEnv.digestKeyId],
      ['FORGE_WORKER_MOCK_ARCHITECT', priorEnv.mockArchitect],
      ['FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL', priorEnv.writerUrl],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  async function runOpenQuestionFlow(mode: 'legacy' | 'protected') {
    const task = {
      id: taskId,
      pmProviderConfigId: 'provider-1',
      projectId,
      prompt: 'Plan this change.',
      status: 'pending',
      title: 'Clarification storage',
    }
    const project = {
      defaultBranch: 'main',
      githubRepo: 'owner/repo',
      id: projectId,
      localPath: null,
      name: 'Clarification project',
    }
    const run = {
      agentType: 'architect',
      id: runId,
      modelIdUsed: 'test-model',
      providerConfigId: 'provider-1',
      startedAt: new Date('2026-07-30T00:00:00.000Z'),
      status: 'running',
      taskId,
    }
    const artifact = {
      agentRunId: runId,
      artifactType: 'adr_text',
      content: mode === 'protected'
        ? 'Architect plan available in protected history'
        : 'Confirm the target branch before changing the repository.',
      createdAt: new Date('2026-07-30T00:01:00.000Z'),
      id: artifactId,
      metadata: mode === 'protected'
        ? { historyAvailable: true, planVersion: '1' }
        : { historyAvailable: false, planVersion: '1', storageMode: 'legacy' },
    }
    const question = {
      id: questionId,
      status: mode === 'protected' ? 'open' : 'legacy_unavailable',
      taskId,
    }

    selectResults.push(
      [{ project, task }],
      [{
        agentType: 'architect',
        displayName: 'Architect',
        id: 'architect-config',
        isActive: true,
        providerConfigId: 'provider-1',
        systemPrompt: 'Plan carefully.',
      }],
      [],
      [],
      [],
    )
    if (mode === 'legacy') {
      insertResults.push([run], [artifact], [question])
      updateResults.push([{ id: runId }])
    } else {
      insertResults.push([run], [question])
      updateResults.push([artifact], [{ id: runId }])
    }

    mockReadS4RuntimeModeV1.mockResolvedValue(mode)
    mockRecordArchitectPlanVersion.mockResolvedValue({
      artifactId,
      entries: [{
        agent: null,
        bindingFingerprint: null,
        content: 'Confirm the target branch before changing the repository.',
        contentDigest: `hmac-sha256:${'b'.repeat(64)}`,
        digestKeyId: 'test-key-v1',
        entryId: 'plan_body:000000',
        entryKind: 'plan_body',
        planArtifactId: artifactId,
        planVersion: '1',
        projectionEligible: false,
        requirementKey: null,
        schemaVersion: 1,
        taskId,
      }],
      entrySetDigest: `hmac-sha256:${'c'.repeat(64)}`,
    })

    const orchestrator = await import('@/worker/orchestrator')
    await expect(orchestrator.processTask(taskId)).resolves.toBe('completed')
    return { artifact, orchestrator }
  }

  it('keeps legacy open questions on the legacy artifact path and advances to awaiting_answers', async () => {
    const { artifact, orchestrator } = await runOpenQuestionFlow('legacy')
    const questionValues = insertedValues.find(Array.isArray) as Array<Record<string, unknown>>

    expect(mockRecordArchitectPlanVersion).not.toHaveBeenCalled()
    expect(questionValues).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        status: 'legacy_unavailable',
        taskId,
      }),
    ])
    expect(questionValues[0]).not.toHaveProperty('questionEntryId')
    expect(questionValues[0]).not.toHaveProperty('sourcePlanArtifactId')
    expect(questionValues[0]).not.toHaveProperty('sourcePlanVersion')
    expect(mockUpdateTaskStatusIfCurrent).toHaveBeenNthCalledWith(1, taskId, 'pending', 'running')
    expect(mockUpdateTaskStatusIfCurrent).toHaveBeenNthCalledWith(2, taskId, 'running', 'awaiting_answers')
    await expect(orchestrator.previousPlanForArchitectRun({
      agentRunId: runId,
      artifact,
      checkpoint: null,
      taskId,
    })).resolves.toBe(artifact.content)
  })

  it('retains protected clarification bindings for protected artifacts', async () => {
    await runOpenQuestionFlow('protected')
    const questionValues = insertedValues.find(Array.isArray) as Array<Record<string, unknown>>
    const persistedQuestionId = questionValues[0]?.id

    expect(mockRecordArchitectPlanVersion).toHaveBeenCalledOnce()
    expect(persistedQuestionId).toEqual(expect.any(String))
    expect(questionValues).toEqual([
      expect.objectContaining({
        id: persistedQuestionId,
        questionEntryId: `clarification_question:${persistedQuestionId}`,
        sourcePlanArtifactId: artifactId,
        sourcePlanVersion: 1,
        status: 'open',
        taskId,
      }),
    ])
    expect(mockUpdateTaskStatusIfCurrent).toHaveBeenNthCalledWith(2, taskId, 'running', 'awaiting_answers')
  })
})
