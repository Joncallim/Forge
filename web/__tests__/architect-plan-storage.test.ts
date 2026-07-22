import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockDbInsert,
  mockDbUpdate,
  mockPublishTaskEvent,
  mockBindArchitectReplanContext,
  mockRecordArchitectPlanVersion,
  mockReadS4RuntimeModeV1,
  mockResolveArchitectReplanEntry,
} = vi.hoisted(() => ({
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockPublishTaskEvent: vi.fn(),
  mockBindArchitectReplanContext: vi.fn(),
  mockRecordArchitectPlanVersion: vi.fn(),
  mockReadS4RuntimeModeV1: vi.fn(),
  mockResolveArchitectReplanEntry: vi.fn(),
}))

function chain(
  value: unknown,
  onValues?: (value: unknown) => void,
  onSet?: (value: unknown) => void,
) {
  const result: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(value).then(resolve),
  }
  for (const method of ['values', 'returning', 'set', 'where']) {
    result[method] = (input: unknown) => {
      if (method === 'values') onValues?.(input)
      if (method === 'set') onSet?.(input)
      return result
    }
  }
  return result
}

vi.mock('@/db', () => ({
  db: {
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
}))
vi.mock('@/lib/providers/registry', () => ({ getProvider: vi.fn(), getModel: vi.fn() }))
vi.mock('@/lib/providers/default', () => ({ resolveDefaultProvider: vi.fn() }))
vi.mock('@/worker/events', () => ({ publishTaskEvent: mockPublishTaskEvent }))
vi.mock('@/worker/task-logs', () => ({ recordTaskLogBestEffort: vi.fn() }))
vi.mock('@/worker/task-state', () => ({ updateTaskStatus: vi.fn(), updateTaskStatusIfCurrent: vi.fn() }))
vi.mock('@/worker/architect-context', () => ({
  buildSpecialistContext: vi.fn(), buildWebResearchContext: vi.fn(), detectSoftwareProfile: vi.fn(),
}))
vi.mock('@/lib/mcps/manager', () => ({ getProjectMcpOverview: vi.fn() }))
vi.mock('@/lib/mcps/s4-protocol-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/s4-protocol-store')>(),
  bindArchitectReplanContext: mockBindArchitectReplanContext,
  recordArchitectPlanVersion: mockRecordArchitectPlanVersion,
  resolveArchitectReplanEntry: mockResolveArchitectReplanEntry,
}))
vi.mock('@/lib/mcps/s4-lease', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/s4-lease')>(),
  readS4RuntimeModeV1: mockReadS4RuntimeModeV1,
}))

const protectedEnvNames = [
  'FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID',
  'FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL',
] as const
const originalEnv = Object.fromEntries(protectedEnvNames.map((name) => [name, process.env[name]]))

function artifact(content: string, metadata: Record<string, unknown> = {}) {
  return {
    id: 'artifact-1',
    agentRunId: 'run-1',
    artifactType: 'adr_text',
    content,
    metadata,
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
  }
}

function configureProtectedReplan(): void {
  mockReadS4RuntimeModeV1.mockResolvedValue('protected')
  process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = 'postgresql://writer/test'
  process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX = 'a'.repeat(64)
  process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID = 'test-key-v1'
  process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL = 'postgresql://resolver/test'
}

function protectedArtifact() {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    content: 'Architect plan available in protected history',
    metadata: {
      historyAvailable: true,
      planVersion: '2',
    },
  }
}

describe('Architect plan storage compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const name of protectedEnvNames) delete process.env[name]
    mockPublishTaskEvent.mockResolvedValue(undefined)
    mockReadS4RuntimeModeV1.mockResolvedValue('legacy')
    mockBindArchitectReplanContext.mockResolvedValue([{
      referenceId: '44444444-4444-4444-8444-444444444444',
      entryId: 'plan_body:000000',
      entryKind: 'plan_body',
    }])
    mockResolveArchitectReplanEntry.mockResolvedValue({
      sourceKind: 'architect_plan_entry',
      agent: null,
      bindingFingerprint: null,
      content: '# Prior protected plan\n\nKeep this.',
      entryId: 'plan_body:000000',
      entryKind: 'plan_body',
      projectionEligible: false,
      requirementKey: null,
    })
  })

  afterEach(() => {
    for (const name of protectedEnvNames) {
      const value = originalEnv[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('persists a durable legacy adr_text artifact when protected configuration is entirely absent', async () => {
    const insertedValues: unknown[] = []
    mockDbInsert.mockReturnValue(chain([artifact('# Durable legacy plan')], (value) => insertedValues.push(value)))

    const { createArchitectPlanArtifact } = await import('@/worker/orchestrator')
    const result = await createArchitectPlanArtifact(
      'task-1', 'run-1', '# Durable legacy plan', '1', { agentBreakdownSource: 'fence' },
    )

    expect(result.content).toBe('# Durable legacy plan')
    expect(insertedValues).toContainEqual(expect.objectContaining({
      agentRunId: 'run-1',
      artifactType: 'adr_text',
      content: '# Durable legacy plan',
      metadata: expect.objectContaining({ historyAvailable: false, storageMode: 'legacy' }),
    }))
    expect(mockRecordArchitectPlanVersion).not.toHaveBeenCalled()
  })

  it('fails closed for partial protected configuration instead of writing a legacy artifact', async () => {
    mockReadS4RuntimeModeV1.mockResolvedValue('protected')
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = 'postgresql://writer/test'
    const { createArchitectPlanArtifact } = await import('@/worker/orchestrator')

    await expect(createArchitectPlanArtifact('task-1', 'run-1', '# Plan', '1')).rejects.toThrow(
      /partially configured/i,
    )
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockRecordArchitectPlanVersion).not.toHaveBeenCalled()
  })

  it('keeps the protected writer path when all protected settings are configured', async () => {
    mockReadS4RuntimeModeV1.mockResolvedValue('protected')
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = 'postgresql://writer/test'
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX = 'a'.repeat(64)
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID = 'test-key-v1'
    const taskId = '11111111-1111-4111-8111-111111111111'
    const runId = '22222222-2222-4222-8222-222222222222'
    const artifactId = '33333333-3333-4333-8333-333333333333'
    const reference = {
      schemaVersion: 1 as const,
      taskId,
      planArtifactId: artifactId,
      planVersion: '1',
      entryId: 'plan_body:000000',
      entryKind: 'plan_body' as const,
      agent: null,
      requirementKey: null,
      bindingFingerprint: null,
      content: '# Protected plan',
      contentDigest: `hmac-sha256:${'c'.repeat(64)}`,
      digestKeyId: 'test-key-v1',
      projectionEligible: false,
    }
    mockRecordArchitectPlanVersion.mockResolvedValue({
      artifactId,
      entries: [reference],
      entrySetDigest: `hmac-sha256:${'b'.repeat(64)}`,
    })
    const updatedValues: unknown[] = []
    mockDbUpdate.mockReturnValue(chain([artifact(
      'Architect plan available in protected history',
      {
        schemaVersion: 1,
        stage: 'architect_plan',
        historyAvailable: true,
        planVersion: '1',
        entryCount: 1,
      },
    )], undefined, (value) => updatedValues.push(value)))

    const { createArchitectPlanArtifact } = await import('@/worker/orchestrator')
    await createArchitectPlanArtifact(taskId, runId, '# Protected plan', '1')

    expect(mockRecordArchitectPlanVersion).toHaveBeenCalledWith(expect.objectContaining({
      agentRunId: runId,
      digestKeyId: 'test-key-v1',
      planVersion: '1',
      taskId,
    }))
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(updatedValues).toEqual([expect.objectContaining({
      metadata: {
        schemaVersion: 1,
        stage: 'architect_plan',
        historyAvailable: true,
        planVersion: '1',
        entryCount: 1,
      },
    })])
    expect(JSON.stringify(updatedValues)).not.toContain('contentDigest')
    expect(JSON.stringify(updatedValues)).not.toContain('architectReplanReference')
    expect(JSON.stringify(updatedValues)).not.toContain('# Protected plan')
    expect(JSON.stringify(mockPublishTaskEvent.mock.calls)).not.toContain('# Protected plan')
    expect(mockPublishTaskEvent).toHaveBeenCalledWith(taskId, 'artifact:created', {
      agentRunId: runId,
      historyAvailable: true,
    })
    expect(JSON.stringify(mockPublishTaskEvent.mock.calls)).not.toContain('planVersion')
    expect(JSON.stringify(mockPublishTaskEvent.mock.calls)).not.toContain('entryCount')
  })
})

describe('Architect durable replan source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const name of protectedEnvNames) delete process.env[name]
    mockBindArchitectReplanContext.mockResolvedValue([{
      referenceId: '44444444-4444-4444-8444-444444444444',
      entryId: 'plan_body:000000',
      entryKind: 'plan_body',
    }])
    mockReadS4RuntimeModeV1.mockResolvedValue('legacy')
    mockResolveArchitectReplanEntry.mockResolvedValue({
      sourceKind: 'architect_plan_entry',
      agent: null,
      bindingFingerprint: null,
      content: '# Prior protected plan\n\nKeep this.',
      entryId: 'plan_body:000000',
      entryKind: 'plan_body',
      projectionEligible: false,
      requirementKey: null,
    })
  })

  afterEach(() => {
    for (const name of protectedEnvNames) {
      const value = originalEnv[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('uses durable legacy artifact text when the checkpoint is missing', async () => {
    const { previousPlanForReplan } = await import('@/worker/orchestrator')
    expect(previousPlanForReplan(
      { content: '# Durable plan\n\nKeep this.', metadata: { historyAvailable: false } },
      null,
    )).toBe('# Durable plan\n\nKeep this.')
  })

  it('uses durable legacy artifact text ahead of a truncated checkpoint', async () => {
    const { previousPlanForReplan } = await import('@/worker/orchestrator')
    expect(previousPlanForReplan(
      { content: '# Durable plan\n\nKeep this.', metadata: { historyAvailable: false } },
      {
        taskId: 'task-1',
        latestPath: '/tmp/checkpoint.md',
        markdown: '# truncated before the plan marker',
        originalBytes: 24_000,
        maxBytes: 12_000,
        truncated: true,
        loadedAt: new Date('2026-07-22T00:00:00.000Z'),
      },
    )).toBe('# Durable plan\n\nKeep this.')
  })

  it('resolves protected history when the checkpoint is missing', async () => {
    configureProtectedReplan()
    const { previousPlanForArchitectRun } = await import('@/worker/orchestrator')
    await expect(previousPlanForArchitectRun({
      agentRunId: '22222222-2222-4222-8222-222222222222',
      artifact: protectedArtifact(),
      checkpoint: null,
      taskId: '11111111-1111-4111-8111-111111111111',
    })).resolves.toBe('# Prior protected plan\n\nKeep this.')
    expect(mockBindArchitectReplanContext).toHaveBeenCalledOnce()
    expect(mockResolveArchitectReplanEntry).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: '44444444-4444-4444-8444-444444444444',
    }))
    expect(mockBindArchitectReplanContext).toHaveBeenCalledWith({
      agentRunId: '22222222-2222-4222-8222-222222222222',
      priorPlanArtifactId: '99999999-9999-4999-8999-999999999999',
    })
  })

  it('resolves protected history ahead of a truncated checkpoint', async () => {
    configureProtectedReplan()
    const { previousPlanForArchitectRun } = await import('@/worker/orchestrator')
    await expect(previousPlanForArchitectRun({
      agentRunId: '22222222-2222-4222-8222-222222222222',
      artifact: protectedArtifact(),
      checkpoint: {
        taskId: '11111111-1111-4111-8111-111111111111',
        latestPath: '/tmp/checkpoint.md',
        markdown: '# truncated before the plan marker',
        originalBytes: 24_000,
        maxBytes: 12_000,
        truncated: true,
        loadedAt: new Date('2026-07-22T00:00:00.000Z'),
      },
      taskId: '11111111-1111-4111-8111-111111111111',
    })).resolves.toBe('# Prior protected plan\n\nKeep this.')
    expect(mockResolveArchitectReplanEntry).toHaveBeenCalledOnce()
  })

  it('binds and resolves the protected plan body and hidden routing set together', async () => {
    configureProtectedReplan()
    mockBindArchitectReplanContext.mockResolvedValue([
      {
        referenceId: '44444444-4444-4444-8444-444444444444',
        entryId: 'plan_body:000000',
        entryKind: 'plan_body',
      },
      {
        referenceId: '55555555-5555-4555-8555-555555555555',
        entryId: 'routing:mcp-requirement-v1-test-1:backend',
        entryKind: 'routing',
      },
    ])
    mockResolveArchitectReplanEntry
      .mockResolvedValueOnce({
        sourceKind: 'architect_plan_entry',
        agent: null,
        bindingFingerprint: null,
        content: '# Prior protected plan',
        entryId: 'plan_body:000000',
        entryKind: 'plan_body',
        projectionEligible: false,
        requirementKey: null,
      })
      .mockResolvedValueOnce({
        sourceKind: 'architect_plan_entry',
        agent: 'backend',
        bindingFingerprint: `sha256:${'b'.repeat(64)}`,
        content: '{"agent":"backend","requirementKey":"mcp-requirement-v1-test-1","schemaVersion":1}',
        entryId: 'routing:mcp-requirement-v1-test-1:backend',
        entryKind: 'routing',
        projectionEligible: false,
        requirementKey: 'mcp-requirement-v1-test-1',
      })
    const { previousPlanContextForArchitectRun } = await import('@/worker/orchestrator')
    await expect(previousPlanContextForArchitectRun({
      agentRunId: '22222222-2222-4222-8222-222222222222',
      artifact: protectedArtifact(),
      checkpoint: null,
      taskId: '11111111-1111-4111-8111-111111111111',
    })).resolves.toEqual({
      planText: '# Prior protected plan',
      planEntries: [{
        sourceKind: 'architect_plan_entry',
        expectedEntryId: 'plan_body:000000',
        agent: null,
        bindingFingerprint: null,
        content: '# Prior protected plan',
        entryId: 'plan_body:000000',
        entryKind: 'plan_body',
        projectionEligible: false,
        requirementKey: null,
      }, {
        sourceKind: 'architect_plan_entry',
        expectedEntryId: 'routing:mcp-requirement-v1-test-1:backend',
        agent: 'backend',
        bindingFingerprint: `sha256:${'b'.repeat(64)}`,
        entryId: 'routing:mcp-requirement-v1-test-1:backend',
        content: '{"agent":"backend","requirementKey":"mcp-requirement-v1-test-1","schemaVersion":1}',
        entryKind: 'routing',
        projectionEligible: false,
        requirementKey: 'mcp-requirement-v1-test-1',
      }],
      clarificationAnswers: [],
      protectedComparableEntries: [{
        agent: 'backend',
        bindingFingerprint: `sha256:${'b'.repeat(64)}`,
        entryId: 'routing:mcp-requirement-v1-test-1:backend',
        content: '{"agent":"backend","requirementKey":"mcp-requirement-v1-test-1","schemaVersion":1}',
        entryKind: 'routing',
        projectionEligible: false,
        requirementKey: 'mcp-requirement-v1-test-1',
      }],
    })
    expect(mockResolveArchitectReplanEntry).toHaveBeenCalledTimes(2)
  })

  it('fails closed when protected configuration is missing and needs no public replan locator', async () => {
    const { previousPlanForArchitectRun } = await import('@/worker/orchestrator')
    await expect(previousPlanForArchitectRun({
      agentRunId: '22222222-2222-4222-8222-222222222222',
      artifact: protectedArtifact(),
      checkpoint: null,
      taskId: '11111111-1111-4111-8111-111111111111',
    })).rejects.toThrow(/resolver configuration is missing.*failed closed/i)
    expect(mockBindArchitectReplanContext).not.toHaveBeenCalled()

    configureProtectedReplan()
    await expect(previousPlanForArchitectRun({
      agentRunId: '22222222-2222-4222-8222-222222222222',
      artifact: {
        id: '99999999-9999-4999-8999-999999999999',
        content: 'Architect plan available in protected history',
        metadata: { historyAvailable: true },
      },
      checkpoint: null,
      taskId: '11111111-1111-4111-8111-111111111111',
    })).resolves.toBe('# Prior protected plan\n\nKeep this.')
    expect(mockBindArchitectReplanContext).toHaveBeenCalledOnce()
  })

  it('does not retry or fall back when the one-use protected resolver fails', async () => {
    configureProtectedReplan()
    mockResolveArchitectReplanEntry.mockRejectedValueOnce(new Error('reference already consumed'))
    const { previousPlanForArchitectRun } = await import('@/worker/orchestrator')
    await expect(previousPlanForArchitectRun({
      agentRunId: '22222222-2222-4222-8222-222222222222',
      artifact: protectedArtifact(),
      checkpoint: null,
      taskId: '11111111-1111-4111-8111-111111111111',
    })).rejects.toThrow('reference already consumed')
    expect(mockBindArchitectReplanContext).toHaveBeenCalledOnce()
    expect(mockResolveArchitectReplanEntry).toHaveBeenCalledOnce()
  })
})

describe('Architect event leakage boundary', () => {
  it('publishes bounded progress metadata without raw model deltas', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'worker', 'orchestrator.ts'), 'utf8')
    expect(source).not.toContain("publishTaskEvent(task.id, 'run:chunk'")
    expect(source).toContain("publishTaskEvent(task.id, 'run:progress'")
    expect(source).toContain('outputBytes += Buffer.byteLength(delta,')
    expect(source).not.toMatch(/publishTaskEvent\(task\.id, 'run:progress',[\s\S]{0,120}\bdelta\b/)
  })

  it('creates the new running Architect run before resolving protected prior content', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'worker', 'orchestrator.ts'), 'utf8')
    const runArchitect = source.indexOf('async function runArchitect(')
    const createRun = source.indexOf('.insert(agentRuns)', runArchitect)
    const resolvePrior = source.indexOf('previousPlanContextForArchitectRun({', runArchitect)
    expect(runArchitect).toBeGreaterThan(-1)
    expect(createRun).toBeGreaterThan(runArchitect)
    expect(resolvePrior).toBeGreaterThan(createRun)
  })
})
