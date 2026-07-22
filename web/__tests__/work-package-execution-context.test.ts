import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  getProvider: vi.fn(),
  getModel: vi.fn(),
  providerExecutionSnapshot: vi.fn((config: Record<string, unknown>) => ({
    acpExecutionMode: config.providerType === 'acp' ? 'unconfined_host_process' : 'not_applicable',
    configId: String(config.id ?? 'provider-task'),
    fingerprint: 'a'.repeat(64),
    isLocal: config.isLocal === true,
    modelId: String(config.modelId),
    providerType: String(config.providerType),
    updatedAt: new Date('2026-07-22T00:00:00.000Z'),
  })),
  loadCurrentProjectFilesystemDecision: vi.fn().mockResolvedValue(null),
  resolveDefaultProvider: vi.fn(),
  assertProjectLocalPathForExecution: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: { select: mocks.dbSelect },
}))

vi.mock('@/lib/providers/registry', () => ({
  getProvider: mocks.getProvider,
  getModel: mocks.getModel,
  providerExecutionSnapshot: mocks.providerExecutionSnapshot,
}))

vi.mock('@/lib/providers/default', () => ({
  resolveDefaultProvider: mocks.resolveDefaultProvider,
}))

vi.mock('@/lib/projects/local-path', () => ({
  assertProjectLocalPathForExecution: mocks.assertProjectLocalPathForExecution,
}))

vi.mock('@/lib/mcps/filesystem-grant-reconciliation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mcps/filesystem-grant-reconciliation')>(),
  loadCurrentProjectFilesystemDecision: mocks.loadCurrentProjectFilesystemDecision,
}))

import { loadWorkPackageExecutionContext } from '@/worker/work-package-executor'

function chain(resolveValue: unknown) {
  const t: Record<string, unknown> = {
    then: (ok: (value: unknown) => unknown, err?: (reason: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(ok, err),
  }
  ;['from', 'innerJoin', 'where', 'limit'].forEach((method) => { t[method] = () => t })
  return t
}

describe('loadWorkPackageExecutionContext', () => {
  it('rejects archived assigned agents before provider/model execution', async () => {
    vi.clearAllMocks()
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        task: { id: 'task-1', projectId: 'project-1', pmProviderConfigId: null },
        project: { id: 'project-1', localPath: '/workspace/project' },
        workPackage: { id: 'pkg-1', assignedRole: 'backend' },
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ id: 'agent-archived' }]))

    await expect(loadWorkPackageExecutionContext('task-1', 'pkg-1'))
      .rejects.toThrow(/backend.*archived/i)

    expect(mocks.resolveDefaultProvider).not.toHaveBeenCalled()
    expect(mocks.getProvider).not.toHaveBeenCalled()
    expect(mocks.getModel).not.toHaveBeenCalled()
    expect(mocks.assertProjectLocalPathForExecution).not.toHaveBeenCalled()
  })

  it.each(['architect', 'security'])(
    'rejects stale Architect-created reserved %s packages before provider/model execution',
    async (assignedRole) => {
      vi.clearAllMocks()
      mocks.dbSelect.mockReturnValueOnce(chain([{
        task: { id: 'task-1', projectId: 'project-1', pmProviderConfigId: 'provider-task' },
        project: { id: 'project-1', localPath: '/workspace/project' },
        workPackage: {
          id: 'pkg-1',
          assignedRole,
          metadata: { source: 'architect-artifact' },
        },
      }]))

      await expect(loadWorkPackageExecutionContext('task-1', 'pkg-1'))
        .rejects.toThrow(/reserved for review gates/i)

      expect(mocks.dbSelect).toHaveBeenCalledTimes(1)
      expect(mocks.resolveDefaultProvider).not.toHaveBeenCalled()
      expect(mocks.getProvider).not.toHaveBeenCalled()
      expect(mocks.getModel).not.toHaveBeenCalled()
      expect(mocks.assertProjectLocalPathForExecution).not.toHaveBeenCalled()
    },
  )

  it('validates the project path and defers model construction until the sandbox cwd exists', async () => {
    vi.clearAllMocks()
    const project = { id: 'project-1', localPath: '/workspace/link' }
    const task = { id: 'task-1', projectId: 'project-1', pmProviderConfigId: 'provider-task' }
    const workPackage = { id: 'pkg-1', assignedRole: 'backend' }
    mocks.dbSelect
      .mockReturnValueOnce(chain([{ task, project, workPackage }]))
      .mockReturnValueOnce(chain([{ id: 'agent-backend', providerConfigId: null }]))
    mocks.getProvider.mockResolvedValue({
      config: { providerType: 'anthropic', modelId: 'claude-opus-4-5' },
    })
    mocks.assertProjectLocalPathForExecution.mockResolvedValue('/workspace/real-project')

    const context = await loadWorkPackageExecutionContext('task-1', 'pkg-1')

    expect(mocks.assertProjectLocalPathForExecution).toHaveBeenCalledWith(project)
    expect(mocks.getProvider).toHaveBeenCalledWith('provider-task')
    expect(mocks.getModel).not.toHaveBeenCalled()
    expect(context.providerConfigId).toBe('provider-task')
    expect(context.validatedProjectRoot).toBe('/workspace/real-project')
  })

  it.each([undefined, '', 'flase', '0'])(
    'blocks ACP-backed executable work packages when the setting is %s',
    async (setting) => {
      vi.clearAllMocks()
      const previous = process.env.FORGE_ACP_WORK_PACKAGE_EXECUTION
      if (setting === undefined) delete process.env.FORGE_ACP_WORK_PACKAGE_EXECUTION
      else process.env.FORGE_ACP_WORK_PACKAGE_EXECUTION = setting
      const project = { id: 'project-1', localPath: '/workspace/project' }
      const task = { id: 'task-1', projectId: 'project-1', pmProviderConfigId: 'provider-task' }
      const workPackage = { id: 'pkg-1', assignedRole: 'backend' }
      mocks.dbSelect
        .mockReturnValueOnce(chain([{ task, project, workPackage }]))
        .mockReturnValueOnce(chain([{ id: 'agent-backend', providerConfigId: null }]))
      mocks.getProvider.mockResolvedValue({
        config: { providerType: 'acp', modelId: 'codex-cli::gpt-5.3-codex-spark' },
      })

      try {
        await expect(loadWorkPackageExecutionContext('task-1', 'pkg-1'))
          .rejects.toThrow(/ACP work-package execution is disabled/i)
      } finally {
        if (previous === undefined) delete process.env.FORGE_ACP_WORK_PACKAGE_EXECUTION
        else process.env.FORGE_ACP_WORK_PACKAGE_EXECUTION = previous
      }

      expect(mocks.assertProjectLocalPathForExecution).not.toHaveBeenCalled()
      expect(mocks.getModel).not.toHaveBeenCalled()
    },
  )

  it('allows ACP-backed executable work packages only after an affirmative request', async () => {
    vi.clearAllMocks()
    const previous = process.env.FORGE_ACP_WORK_PACKAGE_EXECUTION
    process.env.FORGE_ACP_WORK_PACKAGE_EXECUTION = '1'
    const project = { id: 'project-1', localPath: '/workspace/project' }
    const task = { id: 'task-1', projectId: 'project-1', pmProviderConfigId: 'provider-task' }
    const workPackage = { id: 'pkg-1', assignedRole: 'backend' }
    mocks.dbSelect
      .mockReturnValueOnce(chain([{ task, project, workPackage }]))
      .mockReturnValueOnce(chain([{ id: 'agent-backend', providerConfigId: null }]))
    mocks.getProvider.mockResolvedValue({
      config: { providerType: 'acp', modelId: 'codex-cli::gpt-5.3-codex-spark' },
    })
    mocks.assertProjectLocalPathForExecution.mockResolvedValue('/workspace/project')

    try {
      const context = await loadWorkPackageExecutionContext('task-1', 'pkg-1')

      expect(context.providerConfigId).toBe('provider-task')
      expect(context.modelIdUsed).toBe('codex-cli::gpt-5.3-codex-spark')
      expect(mocks.assertProjectLocalPathForExecution).toHaveBeenCalledWith(project)
    } finally {
      if (previous === undefined) delete process.env.FORGE_ACP_WORK_PACKAGE_EXECUTION
      else process.env.FORGE_ACP_WORK_PACKAGE_EXECUTION = previous
    }
    expect(mocks.getModel).not.toHaveBeenCalled()
  })

  it('rejects invented roles that do not resolve to an active configured agent', async () => {
    vi.clearAllMocks()
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        task: { id: 'task-1', projectId: 'project-1', pmProviderConfigId: 'provider-task' },
        project: { id: 'project-1', localPath: '/workspace/project' },
        workPackage: { id: 'pkg-1', assignedRole: 'near-backend' },
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))

    await expect(loadWorkPackageExecutionContext('task-1', 'pkg-1'))
      .rejects.toThrow(/near-backend.*not configured or active/i)

    expect(mocks.getProvider).not.toHaveBeenCalled()
    expect(mocks.getModel).not.toHaveBeenCalled()
  })
})
