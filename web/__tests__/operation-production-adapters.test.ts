import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  assertProjectLocalPathForExecution: vi.fn(),
  loadTrustedOperationContext: vi.fn(),
  recordScopedCommandAudit: vi.fn(),
  runScopedRepositoryCommand: vi.fn(),
}))

const project = {
  id: '22222222-2222-4222-8222-222222222222',
  localPath: '/trusted/project',
  rootBindingRevision: BigInt(7),
  updatedAt: new Date('2026-08-06T00:00:00.000Z'),
}

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [project]) })),
      })),
    })),
  },
}))
vi.mock('@/lib/projects/local-path', () => ({
  assertProjectLocalPathForExecution: mocks.assertProjectLocalPathForExecution,
}))
vi.mock('@/worker/operations/context', () => ({
  loadTrustedOperationContext: mocks.loadTrustedOperationContext,
}))
vi.mock('@/worker/repository-evidence', () => ({
  recordScopedCommandAudit: mocks.recordScopedCommandAudit,
  runScopedRepositoryCommand: mocks.runScopedRepositoryCommand,
}))

import { OperationAdapterExecutionError, type TrustedOperationContext } from '@/worker/operations/executor'
import { productionOperationAdapters } from '@/worker/operations/production-adapters'

const context: TrustedOperationContext = {
  taskId: '11111111-1111-4111-8111-111111111111',
  projectId: project.id,
  attemptKey: 'attempt-1',
  projectRoot: '/trusted/project',
  rootBindingRevision: '7',
  projectRevision: '2026-08-06T00:00:00.000Z',
  policy: {
    projectId: project.id,
    scopedProjectId: project.id,
    policyVersion: 'policy-v1',
    allowedCapabilities: ['filesystem.project.read'],
    policyCeilings: { repository_read: true },
  },
}

describe('production operation adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runScopedRepositoryCommand.mockResolvedValue({
      argv: ['status', '--short'],
      command: 'git',
      cwd: '/trusted/project',
      exitCode: 0,
      finishedAt: new Date(),
      outputSummary: 'M file.ts',
      riskClass: 'read_only',
      startedAt: new Date(),
      stderr: '',
      stdout: 'M file.ts',
    })
    mocks.recordScopedCommandAudit.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333' })
    mocks.assertProjectLocalPathForExecution.mockResolvedValue('/trusted/project')
    mocks.loadTrustedOperationContext.mockResolvedValue(context)
  })

  it('runs only the fixed Git argv with cancellation and records command evidence', async () => {
    const controller = new AbortController()
    const result = await productionOperationAdapters.repositoryStatusRead(context, {
      signal: controller.signal,
      deadline: new Date(Date.now() + 30_000),
    })
    expect(mocks.runScopedRepositoryCommand).toHaveBeenCalledWith({
      cwd: '/trusted/project',
      command: 'git',
      argv: ['status', '--short'],
      signal: controller.signal,
    })
    expect(mocks.recordScopedCommandAudit).toHaveBeenCalledOnce()
    expect(mocks.assertProjectLocalPathForExecution).toHaveBeenCalledWith(project)
    expect(result.evidenceRefs).toEqual(['33333333-3333-4333-8333-333333333333'])
  })

  it('uses the fixed current-branch argv for the third cancellable operation', async () => {
    await productionOperationAdapters.repositoryBranchRead(context, {
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 30_000),
    })
    expect(mocks.runScopedRepositoryCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'git',
      argv: ['branch', '--show-current'],
    }))
  })

  it('returns typed command-audit evidence for a nonzero Git exit', async () => {
    mocks.runScopedRepositoryCommand.mockResolvedValue({
      argv: ['status', '--short'],
      command: 'git',
      cwd: '/trusted/project',
      exitCode: 1,
      finishedAt: new Date(),
      outputSummary: 'redacted failure',
      riskClass: 'read_only',
      startedAt: new Date(),
      stderr: 'redacted failure',
      stdout: '',
    })
    const error = await productionOperationAdapters.repositoryStatusRead(context, {
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 30_000),
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(OperationAdapterExecutionError)
    expect(error).toMatchObject({
      code: 'adapter_failed',
      evidenceRefs: ['33333333-3333-4333-8333-333333333333'],
    })
  })

  it('settles an aborted command audit before returning typed cancellation evidence', async () => {
    const controller = new AbortController()
    mocks.runScopedRepositoryCommand.mockImplementation(async () => {
      controller.abort()
      return {
        argv: ['status', '--short'],
        command: 'git',
        cwd: '/trusted/project',
        exitCode: 1,
        finishedAt: new Date(),
        outputSummary: 'cancelled',
        riskClass: 'read_only',
        startedAt: new Date(),
        stderr: '',
        stdout: '',
      }
    })
    const error = await productionOperationAdapters.repositoryStatusRead(context, {
      signal: controller.signal,
      deadline: new Date(Date.now() + 30_000),
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(OperationAdapterExecutionError)
    expect(error).toMatchObject({
      code: 'cancelled',
      evidenceRefs: ['33333333-3333-4333-8333-333333333333'],
    })
    expect(mocks.recordScopedCommandAudit).toHaveBeenCalledOnce()
  })

  it('fails before the child process when live task/package authority changed', async () => {
    mocks.loadTrustedOperationContext.mockResolvedValue({
      ...context,
      policy: { ...context.policy, policyVersion: 'different-policy-version' },
    })
    const error = await productionOperationAdapters.repositoryStatusRead(context, {
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 30_000),
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(OperationAdapterExecutionError)
    expect(error).toMatchObject({ code: 'authority_changed' })
    expect(mocks.runScopedRepositoryCommand).not.toHaveBeenCalled()
  })
})
