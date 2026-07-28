import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClaimLeaseFence,
  ClaimLeaseLostError,
} from '@/worker/claim-lease-fence'

const {
  mockDbDelete,
  mockDbInsert,
  mockDbSelect,
  mockDbUpdate,
  mockGetModel,
  mockGetProjectMcpOverview,
  mockGetProvider,
  mockPublishTaskEvent,
  mockReadCheckpoint,
  mockRecordTaskLog,
  mockStreamText,
  mockUpdateTaskStatus,
  mockUpdateTaskStatusIfCurrent,
  mockWriteCheckpoint,
} = vi.hoisted(() => ({
  mockDbDelete: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockGetModel: vi.fn(),
  mockGetProjectMcpOverview: vi.fn(),
  mockGetProvider: vi.fn(),
  mockPublishTaskEvent: vi.fn(),
  mockReadCheckpoint: vi.fn(),
  mockRecordTaskLog: vi.fn(),
  mockStreamText: vi.fn(),
  mockUpdateTaskStatus: vi.fn(),
  mockUpdateTaskStatusIfCurrent: vi.fn(),
  mockWriteCheckpoint: vi.fn(),
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
}))
vi.mock('@/lib/providers/default', () => ({
  resolveDefaultProvider: vi.fn(),
}))
vi.mock('@/lib/mcps/manager', () => ({
  getProjectMcpOverview: mockGetProjectMcpOverview,
}))
vi.mock('@/lib/mcps/filesystem-grant-reconciliation', () => ({
  loadCurrentProjectFilesystemDecision: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/mcps/s4-lease', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/s4-lease')>(),
  readS4RuntimeModeV1: vi.fn().mockResolvedValue('legacy'),
}))
vi.mock('@/lib/workspace', () => ({
  displayPathForWorkspacePath: vi.fn((_workspace, value: string) => value),
  getWorkspaceSettings: vi.fn().mockResolvedValue({
    runtimeRoot: '/safe-runtime',
  }),
}))
vi.mock('@/worker/architect-context', () => ({
  buildSpecialistContext: vi.fn().mockReturnValue(''),
  buildWebResearchContext: vi.fn().mockResolvedValue(''),
  detectSoftwareProfile: vi.fn().mockReturnValue({}),
}))
vi.mock('@/worker/events', () => ({
  publishTaskEvent: mockPublishTaskEvent,
}))
vi.mock('@/worker/task-logs', () => ({
  recordTaskLogBestEffort: mockRecordTaskLog,
}))
vi.mock('@/worker/task-state', () => ({
  updateTaskStatus: mockUpdateTaskStatus,
  updateTaskStatusIfCurrent: mockUpdateTaskStatusIfCurrent,
}))
vi.mock('@/worker/checkpoints', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/worker/checkpoints')>(),
  readLatestArchitectCheckpointSafely: mockReadCheckpoint,
  writeArchitectCheckpointSafely: mockWriteCheckpoint,
}))

function chain(resolveValue: unknown, onValues?: (value: unknown) => void) {
  const thenable: Record<string, unknown> = {
    then: (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(resolveValue).then(resolve, reject),
  }
  for (const method of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'returning']) {
    thenable[method] = () => thenable
  }
  thenable.values = (value: unknown) => {
    onValues?.(value)
    return thenable
  }
  thenable.set = () => thenable
  return thenable
}

describe('Architect queue-claim cancellation', () => {
  const previousMock = process.env.FORGE_WORKER_MOCK_ARCHITECT

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.FORGE_WORKER_MOCK_ARCHITECT
  })

  afterEach(() => {
    if (previousMock === undefined) delete process.env.FORGE_WORKER_MOCK_ARCHITECT
    else process.env.FORGE_WORKER_MOCK_ARCHITECT = previousMock
  })

  it('aborts the in-flight stream and bypasses ordinary failure persistence', async () => {
    const task = {
      id: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      title: 'Fence the Architect',
      prompt: 'Authorized task prompt',
      status: 'pending',
      pmProviderConfigId: 'provider-1',
    }
    const project = {
      id: task.projectId,
      name: 'Fence Project',
      githubRepo: 'owner/repo',
      localPath: null,
      defaultBranch: 'main',
      mcpConfig: null,
    }
    const config = {
      id: 'config-1',
      agentType: 'architect',
      displayName: 'Architect',
      description: '',
      isSystem: true,
      isActive: true,
      providerConfigId: 'provider-1',
      systemPrompt: 'Plan safely.',
    }
    const run = {
      id: '33333333-3333-4333-8333-333333333333',
      taskId: task.id,
      status: 'running',
    }
    const selectResults = [
      [{ task, project }],
      [config],
      [],
      [config],
    ]
    mockDbSelect.mockImplementation(() => chain(selectResults.shift() ?? []))
    mockDbInsert.mockImplementation(() => chain([run]))
    mockDbUpdate.mockImplementation(() => chain([]))
    mockDbDelete.mockImplementation(() => chain(undefined))
    mockUpdateTaskStatusIfCurrent.mockResolvedValue(true)
    mockReadCheckpoint.mockResolvedValue(null)
    mockGetProvider.mockResolvedValue({
      config: {
        displayName: 'Provider',
        modelId: 'model-1',
        providerType: 'openai',
      },
    })
    mockGetModel.mockResolvedValue({ modelId: 'model-1' })
    mockGetProjectMcpOverview.mockResolvedValue({
      catalog: [],
      config: {},
      missingRequired: [],
      projectId: project.id,
      statuses: [],
      summary: {},
      warnings: [],
    })
    mockPublishTaskEvent.mockResolvedValue(undefined)
    mockRecordTaskLog.mockResolvedValue(undefined)

    let providerSignal: AbortSignal | null = null
    let providerStarted!: () => void
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve
    })
    mockStreamText.mockImplementation((input: { abortSignal: AbortSignal }) => {
      providerSignal = input.abortSignal
      providerStarted()
      return {
        textStream: {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((_resolve, reject) => {
              if (input.abortSignal.aborted) {
                reject(input.abortSignal.reason)
                return
              }
              input.abortSignal.addEventListener(
                'abort',
                () => reject(input.abortSignal.reason),
                { once: true },
              )
            })
          },
        },
        finishReason: Promise.resolve('stop'),
        usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      }
    })

    const fence = new ClaimLeaseFence()
    const { processTask } = await import('@/worker/orchestrator')
    const processing = processTask(task.id, {
      claimLeaseFence: fence,
      finalAttempt: true,
    })
    await started
    const activeProviderSignal = providerSignal as AbortSignal | null
    expect(activeProviderSignal).not.toBeNull()
    expect(fence.markLost()).toBe(true)
    await expect(processing).resolves.toBe('retained')

    expect(activeProviderSignal?.aborted).toBe(true)
    expect(activeProviderSignal?.reason).toBeInstanceOf(ClaimLeaseLostError)
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled()
    expect(mockWriteCheckpoint).not.toHaveBeenCalled()
    expect(mockPublishTaskEvent.mock.calls.map((call) => call[1]))
      .toEqual(['run:started'])
    expect(mockRecordTaskLog.mock.calls.map((call) => call[0]?.eventType))
      .toEqual(['run.started'])
  })
})
