import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbSelect: vi.fn(),
  dbTransaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback({
      insert: vi.fn(),
      update: vi.fn(),
    }),
  ),
  dbUpdate: vi.fn(),
  getProjectMcpOverview: vi.fn(),
  materializeReviewGatesForWorkPackageCompletion: vi.fn(),
  completeTaskIfReviewGatesSatisfied: vi.fn(),
  publishTaskEvent: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: {
    insert: mocks.dbInsert,
    select: mocks.dbSelect,
    transaction: mocks.dbTransaction,
    update: mocks.dbUpdate,
  },
}))

vi.mock('@/worker/events', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}))

vi.mock('@/lib/mcps/manager', () => ({
  getProjectMcpOverview: mocks.getProjectMcpOverview,
}))

vi.mock('@/worker/review-gates', () => ({
  materializeReviewGatesForWorkPackageCompletion: mocks.materializeReviewGatesForWorkPackageCompletion,
  completeTaskIfReviewGatesSatisfied: mocks.completeTaskIfReviewGatesSatisfied,
}))

import { handoffApprovedWorkPackages, progressWorkforce } from '@/worker/work-package-handoff'

function chain(resolveValue: unknown) {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'returning', 'set', 'offset', 'innerJoin', 'leftJoin']
  methods.forEach((method) => {
    thenable[method] = () => thenable
  })
  return thenable
}

function updateChain(returnValue: unknown) {
  const update = chain(returnValue)
  update.set = vi.fn(() => update)
  return update
}

function insertChain(returnValue: unknown = []) {
  const insert = chain(returnValue)
  insert.values = vi.fn(() => insert)
  return insert
}

describe('handoffApprovedWorkPackages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: [], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [],
      summary: {
        label: 'No MCPs configured',
        status: 'missing',
        missing: 0,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValue({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [
        { id: 'gate-qa', gateType: 'qa_review', requiredRole: 'qa', title: 'QA review' },
        { id: 'gate-reviewer', gateType: 'reviewer_review', requiredRole: 'reviewer', title: 'Reviewer review' },
      ],
    })
  })

  it('marks root packages ready, claims the first package, and records a no-op handoff run', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        },
        {
          id: 'pkg-2',
          assignedRole: 'qa',
          harnessId: 'harness-2',
          sequence: 2,
          status: 'pending',
          title: 'QA package',
        },
      ]))
      .mockReturnValueOnce(chain([
        { workPackageId: 'pkg-2', dependsOnWorkPackageId: 'pkg-1' },
      ]))
    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const run = {
      id: 'run-1',
      agentType: 'handoff',
      modelIdUsed: 'forge-handoff/no-op',
      stage: 'handoff',
      status: 'completed',
    }
    const artifact = {
      id: 'artifact-1',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'handoff log',
      metadata: {
        repositoryWrites: false,
        source: 'work-package-handoff',
        workPackageId: 'pkg-1',
      },
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const runInsert = insertChain([run])
    const artifactInsert = insertChain([artifact])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn()
          .mockReturnValueOnce(runInsert)
          .mockReturnValueOnce(artifactInsert),
        update: vi.fn().mockReturnValueOnce(claimUpdate),
      }),
    )

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toEqual({
      status: 'handed_off',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })
    expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }))
    expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'running',
    }))
    expect(runInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'handoff',
      harnessId: 'harness-1',
      modelIdUsed: 'forge-handoff/no-op',
      stage: 'handoff',
      status: 'completed',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    }))
    expect(artifactInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      agentRunId: 'run-1',
      artifactType: 'log_output',
      metadata: expect.objectContaining({
        repositoryWrites: false,
        source: 'work-package-handoff',
        workPackageId: 'pkg-1',
      }),
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'artifact:created', expect.objectContaining({
      agentRunId: 'run-1',
      artifactId: 'artifact-1',
      content: 'handoff log',
      metadata: expect.objectContaining({ repositoryWrites: false }),
      workPackageId: 'pkg-1',
    }))
    expect(mocks.materializeReviewGatesForWorkPackageCompletion).toHaveBeenCalledWith({
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:handoff', expect.objectContaining({
      repositoryWrites: false,
      runId: 'run-1',
      stage: 'handoff',
      status: 'awaiting_review',
      workPackageId: 'pkg-1',
    }))
  })

  it('auto-advances to the next ready package when no review is required for the completed one', async () => {
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValue({
      status: 'not_required',
      packageStatus: 'completed',
      createdGates: [],
    })
    mocks.completeTaskIfReviewGatesSatisfied.mockResolvedValue({ status: 'completed' })

    const firstPackages = [
      { id: 'pkg-1', assignedRole: 'qa', harnessId: 'harness-1', sequence: 1, status: 'pending', title: 'QA package' },
    ]
    const secondPackages = [
      { id: 'pkg-1', assignedRole: 'qa', harnessId: 'harness-1', sequence: 1, status: 'completed', title: 'QA package' },
    ]

    mocks.dbSelect
      .mockReturnValueOnce(chain(firstPackages))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain(secondPackages))
      .mockReturnValueOnce(chain([]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const run = {
      id: 'run-1',
      agentType: 'handoff',
      modelIdUsed: 'forge-handoff/no-op',
      stage: 'handoff',
      status: 'completed',
    }
    const artifact = {
      id: 'artifact-1',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'handoff log',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const runInsert = insertChain([run])
    const artifactInsert = insertChain([artifact])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn()
          .mockReturnValueOnce(runInsert)
          .mockReturnValueOnce(artifactInsert),
        update: vi.fn().mockReturnValueOnce(claimUpdate),
      }),
    )

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toEqual({
      status: 'handed_off',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })
    expect(mocks.completeTaskIfReviewGatesSatisfied).toHaveBeenCalledWith('task-1')
  })

  it('blocks a required unavailable MCP before claiming the package', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          harnessToolPolicy: {
            mcpGrants: [{
              mcpId: 'github',
              requirement: 'required',
              status: 'blocked',
              capabilities: ['github.issues.read'],
              fallback: { action: 'block', message: 'Connect GitHub first.' },
            }],
          },
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'required',
            permissions: ['github.issues.read'],
            fallback: { action: 'block', message: 'Connect GitHub first.' },
          }],
          metadata: {},
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: [], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [],
      summary: {
        label: 'No MCPs configured',
        status: 'missing',
        missing: 1,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })

    const blockUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(blockUpdate)

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      status: 'blocked',
      claimedPackageId: null,
      blockedReason: expect.stringContaining("MCP 'github' is not configured"),
    })

    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining("MCP 'github' is not configured"),
      metadata: expect.objectContaining({
        mcpBroker: expect.objectContaining({
          retryable: true,
          status: 'blocked',
        }),
      }),
      status: 'blocked',
    }))
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      blockedReason: expect.stringContaining("MCP 'github' is not configured"),
      status: 'blocked',
      workPackageId: 'pkg-1',
    }))
  })

  it.each([
    ['architect', 'harness-architect', 'Architect package'],
    ['reviewer', 'harness-reviewer', 'Reviewer package'],
  ])('fails stale Architect-created reserved %s packages before no-op handoff', async (assignedRole, harnessId, title) => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-review',
          assignedRole,
          harnessId,
          mcpRequirements: [],
          metadata: { source: 'architect-artifact' },
          sequence: 1,
          status: 'pending',
          title,
        },
      ]))
      .mockReturnValueOnce(chain([]))

    const failedUpdate = updateChain([{ id: 'pkg-review' }])
    mocks.dbUpdate.mockReturnValueOnce(failedUpdate)

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('reserved for review gates'),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(failedUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('reserved for review gates'),
      metadata: expect.objectContaining({
        handoffSafety: expect.objectContaining({
          source: 'architect-reserved-role',
          status: 'failed',
        }),
        source: 'architect-artifact',
      }),
      status: 'failed',
    }))
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      blockedReason: expect.stringContaining('reserved for review gates'),
      handoffSafety: expect.objectContaining({
        source: 'architect-reserved-role',
        status: 'failed',
      }),
      status: 'failed',
      workPackageId: 'pkg-review',
    }))
  })

  it('fails the task when review-gate auto-progress reaches a terminal reserved-role handoff block', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-review',
          assignedRole: 'reviewer',
          harnessId: 'harness-reviewer',
          mcpRequirements: [],
          metadata: { source: 'architect-artifact' },
          sequence: 1,
          status: 'pending',
          title: 'Reviewer package',
        },
      ]))
      .mockReturnValueOnce(chain([]))

    const failedPackageUpdate = updateChain([{ id: 'pkg-review' }])
    const failedTaskUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(failedPackageUpdate)
      .mockReturnValueOnce(failedTaskUpdate)

    const result = await progressWorkforce('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('reserved for review gates'),
      claimedPackageId: null,
      status: 'blocked',
      terminalBlock: true,
    })
    expect(failedPackageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
    }))
    expect(failedTaskUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining('reserved for review gates'),
      status: 'failed',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:status', expect.objectContaining({
      errorMessage: expect.stringContaining('reserved for review gates'),
      status: 'failed',
    }))
  })

  it('runs the broker before ready promotion when handoff claiming is disabled', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          mcpRequirements: [{
            mcpId: 'slack',
            requirement: 'optional',
            permissions: ['slack.messages.read'],
            fallback: { action: 'continue_without_mcp', message: 'Use local context.' },
          }],
          metadata: {},
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))

    const blockUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(blockUpdate)

    const result = await handoffApprovedWorkPackages('task-1', { claimEnabled: false })

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining("Unknown MCP 'slack'"),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining("Unknown MCP 'slack'"),
      metadata: expect.objectContaining({
        mcpBroker: expect.objectContaining({
          retryable: false,
          status: 'blocked',
        }),
      }),
      status: 'blocked',
    }))
    expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      status: 'ready',
      workPackageId: 'pkg-1',
    }))
  })

  it('claims the next sequential package instead of letting a later ready package block the wave', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          mcpRequirements: [],
          metadata: {},
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        },
        {
          id: 'pkg-2',
          assignedRole: 'frontend',
          harnessId: 'harness-2',
          mcpRequirements: [{
            mcpId: 'slack',
            requirement: 'optional',
            permissions: ['slack.messages.read'],
            fallback: { action: 'continue_without_mcp', message: 'Use local context.' },
          }],
          metadata: {},
          sequence: 2,
          status: 'pending',
          title: 'Frontend package',
        },
      ]))
      .mockReturnValueOnce(chain([]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const run = {
      id: 'run-1',
      agentType: 'handoff',
      modelIdUsed: 'forge-handoff/no-op',
      stage: 'handoff',
      status: 'completed',
    }
    const artifact = {
      id: 'artifact-1',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'handoff log',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const runInsert = insertChain([run])
    const artifactInsert = insertChain([artifact])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn()
          .mockReturnValueOnce(runInsert)
          .mockReturnValueOnce(artifactInsert),
        update: vi.fn().mockReturnValueOnce(claimUpdate),
      }),
    )

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      claimedPackageId: 'pkg-1',
      readyPackageIds: ['pkg-1'],
      status: 'handed_off',
    })
    expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'ready',
    }))
    expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'running',
    }))
    expect(mocks.getProjectMcpOverview).not.toHaveBeenCalled()
  })

  it('rechecks the broker for packages that were already ready before handoff', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'required',
            permissions: ['github.contents.write'],
            fallback: { action: 'block', message: 'Use read-only GitHub access.' },
          }],
          metadata: {},
          sequence: 1,
          status: 'ready',
          title: 'Backend package',
        },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: ['github'], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [{
        mcpId: 'github',
        displayName: 'GitHub',
        description: 'GitHub MCP',
        enabled: true,
        error: null,
        installPath: '/tmp/forge/mcps/github',
        installState: 'installed',
        status: 'healthy',
      }],
      summary: {
        label: 'MCPs healthy',
        status: 'healthy',
        missing: 0,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })

    const blockUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(blockUpdate)

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining('outside the allowed beta scope'),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining('outside the allowed beta scope'),
      metadata: expect.objectContaining({
        mcpBroker: expect.objectContaining({
          retryable: false,
          status: 'blocked',
        }),
      }),
      status: 'blocked',
    }))
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
  })

  it('continues handoff for an optional unavailable MCP with continue_without_mcp fallback', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          harnessToolPolicy: null,
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'optional',
            permissions: ['github.issues.read'],
            fallback: { action: 'continue_without_mcp', message: 'Use local context.' },
          }],
          metadata: {},
          sequence: 1,
          status: 'pending',
          title: 'Backend package',
        },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const run = {
      id: 'run-1',
      agentType: 'handoff',
      modelIdUsed: 'forge-handoff/no-op',
      stage: 'handoff',
      status: 'completed',
    }
    const artifact = {
      id: 'artifact-1',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'handoff log',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const runInsert = insertChain([run])
    const artifactInsert = insertChain([artifact])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn()
          .mockReturnValueOnce(runInsert)
          .mockReturnValueOnce(artifactInsert),
        update: vi.fn().mockReturnValueOnce(claimUpdate),
      }),
    )

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      status: 'handed_off',
      claimedPackageId: 'pkg-1',
    })
    expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'running',
    }))
    expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      status: 'blocked',
      workPackageId: 'pkg-1',
    }))
  })

  it('recovers a previously broker-blocked package once MCP access is available', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          harnessToolPolicy: null,
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'required',
            permissions: ['github.issues.read'],
            fallback: { action: 'block', message: 'Connect GitHub first.' },
          }],
          metadata: {},
          sequence: 1,
          status: 'blocked',
          title: 'Backend package',
        },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))
    mocks.getProjectMcpOverview.mockResolvedValue({
      projectId: 'project-1',
      config: { profile: 'default', requiredMcps: ['github'], overrides: {} },
      catalog: [],
      mcpsRoot: '/tmp/forge/mcps',
      statuses: [{
        mcpId: 'github',
        displayName: 'GitHub',
        description: 'GitHub MCP',
        enabled: true,
        error: null,
        installPath: '/tmp/forge/mcps/github',
        installState: 'installed',
        status: 'healthy',
      }],
      summary: {
        label: 'MCPs healthy',
        status: 'healthy',
        missing: 0,
        authRequired: 0,
        unhealthy: 0,
        disabled: 0,
      },
    })

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const run = {
      id: 'run-1',
      agentType: 'handoff',
      modelIdUsed: 'forge-handoff/no-op',
      stage: 'handoff',
      status: 'completed',
    }
    const artifact = {
      id: 'artifact-1',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'handoff log',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }
    const runInsert = insertChain([run])
    const artifactInsert = insertChain([artifact])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn()
          .mockReturnValueOnce(runInsert)
          .mockReturnValueOnce(artifactInsert),
        update: vi.fn().mockReturnValueOnce(claimUpdate),
      }),
    )

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      status: 'handed_off',
      claimedPackageId: 'pkg-1',
    })
    expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'ready',
    }))
    expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: null,
      status: 'running',
    }))
  })
})
