import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockDbInsert,
  mockDbUpdate,
  mockPublishTaskEvent,
  mockRecordArchitectPlanVersion,
} = vi.hoisted(() => ({
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockPublishTaskEvent: vi.fn(),
  mockRecordArchitectPlanVersion: vi.fn(),
}))

function chain(value: unknown, onValues?: (value: unknown) => void) {
  const result: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(value).then(resolve),
  }
  for (const method of ['values', 'returning', 'set', 'where']) {
    result[method] = (input: unknown) => {
      if (method === 'values') onValues?.(input)
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
  recordArchitectPlanVersion: mockRecordArchitectPlanVersion,
}))

const protectedEnvNames = [
  'FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID',
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

describe('Architect plan storage compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const name of protectedEnvNames) delete process.env[name]
    mockPublishTaskEvent.mockResolvedValue(undefined)
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
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = 'postgresql://writer/test'
    const { createArchitectPlanArtifact } = await import('@/worker/orchestrator')

    await expect(createArchitectPlanArtifact('task-1', 'run-1', '# Plan', '1')).rejects.toThrow(
      /partially configured/i,
    )
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockRecordArchitectPlanVersion).not.toHaveBeenCalled()
  })

  it('keeps the protected writer path when all protected settings are configured', async () => {
    process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = 'postgresql://writer/test'
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX = 'a'.repeat(64)
    process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID = 'test-key-v1'
    mockRecordArchitectPlanVersion.mockResolvedValue({
      artifactId: 'artifact-1',
      entries: [{ entryId: 'plan_body:000000' }],
      entrySetDigest: `hmac-sha256:${'b'.repeat(64)}`,
    })
    mockDbUpdate.mockReturnValue(chain([artifact(
      'Architect plan available in protected history',
      { historyAvailable: true },
    )]))

    const { createArchitectPlanArtifact } = await import('@/worker/orchestrator')
    await createArchitectPlanArtifact('task-1', 'run-1', '# Protected plan', '1')

    expect(mockRecordArchitectPlanVersion).toHaveBeenCalledWith(expect.objectContaining({
      agentRunId: 'run-1',
      digestKeyId: 'test-key-v1',
      planVersion: '1',
      taskId: 'task-1',
    }))
    expect(mockDbInsert).not.toHaveBeenCalled()
  })
})

describe('Architect durable replan source', () => {
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

  it('fails closed for a protected artifact until a purpose-bound replan resolver exists', async () => {
    const { previousPlanForReplan } = await import('@/worker/orchestrator')
    expect(() => previousPlanForReplan(
      {
        content: 'Architect plan available in protected history',
        metadata: { historyAvailable: true, planVersion: '2' },
      },
      null,
    )).toThrow(/purpose-bound Architect replan resolver.*failed closed/i)
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
})
