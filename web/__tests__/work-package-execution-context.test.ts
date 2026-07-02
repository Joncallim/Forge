import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  getProvider: vi.fn(),
  getModel: vi.fn(),
  resolveDefaultProvider: vi.fn(),
  assertProjectLocalPathForExecution: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: { select: mocks.dbSelect },
}))

vi.mock('@/lib/providers/registry', () => ({
  getProvider: mocks.getProvider,
  getModel: mocks.getModel,
}))

vi.mock('@/lib/providers/default', () => ({
  resolveDefaultProvider: mocks.resolveDefaultProvider,
}))

vi.mock('@/lib/projects/local-path', () => ({
  assertProjectLocalPathForExecution: mocks.assertProjectLocalPathForExecution,
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

  it('rejects ACP-backed executable work packages until a hard sandbox exists', async () => {
    vi.clearAllMocks()
    const project = { id: 'project-1', localPath: '/workspace/project' }
    const task = { id: 'task-1', projectId: 'project-1', pmProviderConfigId: 'provider-task' }
    const workPackage = { id: 'pkg-1', assignedRole: 'backend' }
    mocks.dbSelect
      .mockReturnValueOnce(chain([{ task, project, workPackage }]))
      .mockReturnValueOnce(chain([{ id: 'agent-backend', providerConfigId: null }]))
    mocks.getProvider.mockResolvedValue({
      config: { providerType: 'acp', modelId: 'codex-cli::gpt-5.3-codex-spark' },
    })

    await expect(loadWorkPackageExecutionContext('task-1', 'pkg-1'))
      .rejects.toThrow(/does not execute work packages through ACP/i)

    expect(mocks.assertProjectLocalPathForExecution).not.toHaveBeenCalled()
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
