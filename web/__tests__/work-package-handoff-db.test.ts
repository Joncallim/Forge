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
  executeWorkPackage: vi.fn(),
  loadWorkPackageExecutionContext: vi.fn(),
  publishTaskEvent: vi.fn(),
  WorkPackageExecutionError: class WorkPackageExecutionError extends Error {
    failureDetails: unknown

    constructor(message: string, failureDetails: unknown) {
      super(message)
      this.name = 'WorkPackageExecutionError'
      this.failureDetails = failureDetails
    }
  },
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
  REVIEW_GATE_TYPES: ['qa_review', 'reviewer_review', 'security_review'],
  materializeReviewGatesForWorkPackageCompletion: mocks.materializeReviewGatesForWorkPackageCompletion,
  completeTaskIfReviewGatesSatisfied: mocks.completeTaskIfReviewGatesSatisfied,
}))

vi.mock('@/worker/work-package-executor', () => ({
  executeWorkPackage: mocks.executeWorkPackage,
  loadWorkPackageExecutionContext: mocks.loadWorkPackageExecutionContext,
  MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS: 3,
  WorkPackageExecutionError: mocks.WorkPackageExecutionError,
  isArchitectReservedExecutionRole: (role: string) =>
    ['architect', 'qa', 'reviewer', 'security', 'security-review', 'security_review'].includes(role.trim().toLowerCase()),
}))

function fixtureSecret(...parts: string[]) {
  return parts.join('')
}

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

function chainWithLimit<T>(resolveValue: T[]) {
  const thenable = chain(resolveValue) as Record<string, unknown>
  thenable.limit = (count: number) => chain(resolveValue.slice(0, count))
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

function defaultSourceArtifact(input: {
  content?: string
  id?: string
  metadata?: Record<string, unknown>
  runId?: string
} = {}) {
  return {
    id: input.id ?? 'artifact-1',
    agentRunId: input.runId ?? 'run-1',
    artifactType: 'log_output',
    content: input.content ?? 'handoff log',
    metadata: input.metadata ?? {
      hostRepositoryWrites: false,
      repositoryWrites: false,
      sandboxWrites: false,
      source: 'work-package-handoff',
      workPackageId: 'pkg-1',
    },
    createdAt: new Date('2026-06-25T00:00:00.000Z'),
  }
}

function mockNoOpHandoffTransaction(input: {
  packageId?: string
  runId?: string
} = {}) {
  const packageId = input.packageId ?? 'pkg-1'
  const runId = input.runId ?? 'run-1'
  const claimUpdate = updateChain([{ id: packageId }])
  const leaseUpdate = updateChain([{ id: packageId }])
  const runInsert = insertChain([{
    id: runId,
    agentType: 'handoff',
    modelIdUsed: 'forge-handoff/no-op',
    stage: 'handoff',
    status: 'running',
  }])
  mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
    callback({
      insert: vi.fn().mockReturnValueOnce(runInsert),
      update: vi.fn()
        .mockReturnValueOnce(claimUpdate)
        .mockReturnValueOnce(leaseUpdate),
    }),
  )
  return { claimUpdate, leaseUpdate, runInsert }
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
      sourceArtifact: defaultSourceArtifact(),
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
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const { claimUpdate, leaseUpdate, runInsert } = mockNoOpHandoffTransaction()

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
      status: 'running',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    }))
    expect(leaseUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        executionLease: expect.objectContaining({
          attemptNumber: 1,
          runId: 'run-1',
          source: 'work-package-handoff',
        }),
      }),
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'artifact:created', expect.objectContaining({
      agentRunId: 'run-1',
      artifactId: 'artifact-1',
      content: 'handoff log',
      metadata: expect.objectContaining({ repositoryWrites: false }),
      workPackageId: 'pkg-1',
    }))
    expect(mocks.materializeReviewGatesForWorkPackageCompletion).toHaveBeenCalledWith(expect.objectContaining({
      completeSourceRun: expect.objectContaining({
        artifactType: 'log_output',
        content: expect.stringContaining('Forge handed off work package "Backend package" to backend.'),
        metadata: expect.objectContaining({
          hostRepositoryWrites: false,
          repositoryWrites: false,
          sandboxWrites: false,
          source: 'work-package-handoff',
          workPackageId: 'pkg-1',
        }),
      }),
      requireExecutionLease: true,
      sourceAgentRunId: 'run-1',
      sourceArtifactId: null,
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    }))
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
      sourceArtifact: defaultSourceArtifact(),
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
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    mockNoOpHandoffTransaction()

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
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const { claimUpdate } = mockNoOpHandoffTransaction()

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
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const { claimUpdate } = mockNoOpHandoffTransaction()

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

  it('blocks an optional unavailable MCP with ask_user fallback before claiming the package', async () => {
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
            fallback: { action: 'ask_user', message: 'Connect GitHub or choose a local-only plan.' },
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

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining("MCP 'github' is not configured"),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
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
  })

  it('returns blocked when auto-advancing into a broker-blocked follow-on package', async () => {
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValueOnce({
      status: 'not_required',
      packageStatus: 'completed',
      createdGates: [],
      sourceArtifact: defaultSourceArtifact(),
    })

    mocks.dbSelect
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          harnessToolPolicy: null,
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
          harnessToolPolicy: null,
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'optional',
            permissions: ['github.issues.read'],
            fallback: { action: 'ask_user', message: 'Connect GitHub before frontend handoff.' },
          }],
          metadata: {},
          sequence: 2,
          status: 'pending',
          title: 'Frontend package',
        },
      ]))
      .mockReturnValueOnce(chain([
        { workPackageId: 'pkg-2', dependsOnWorkPackageId: 'pkg-1' },
      ]))
      .mockReturnValueOnce(chain([
        {
          id: 'pkg-1',
          assignedRole: 'backend',
          harnessId: 'harness-1',
          harnessToolPolicy: null,
          mcpRequirements: [],
          metadata: {},
          sequence: 1,
          status: 'completed',
          title: 'Backend package',
        },
        {
          id: 'pkg-2',
          assignedRole: 'frontend',
          harnessId: 'harness-2',
          harnessToolPolicy: null,
          mcpRequirements: [{
            mcpId: 'github',
            requirement: 'optional',
            permissions: ['github.issues.read'],
            fallback: { action: 'ask_user', message: 'Connect GitHub before frontend handoff.' },
          }],
          metadata: {},
          sequence: 2,
          status: 'pending',
          title: 'Frontend package',
        },
      ]))
      .mockReturnValueOnce(chain([
        { workPackageId: 'pkg-2', dependsOnWorkPackageId: 'pkg-1' },
      ]))
      .mockReturnValueOnce(chain([{ project: { id: 'project-1' } }]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const blockUpdate = updateChain([{ id: 'pkg-2' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(blockUpdate)
    mockNoOpHandoffTransaction()

    const result = await handoffApprovedWorkPackages('task-1')

    expect(result).toMatchObject({
      blockedReason: expect.stringContaining("MCP 'github' is not configured"),
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
    })
    expect(blockUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: expect.stringContaining("MCP 'github' is not configured"),
      status: 'blocked',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
      blockedReason: expect.stringContaining("MCP 'github' is not configured"),
      status: 'blocked',
      workPackageId: 'pkg-2',
    }))
  })

  it('uses prior implementation runs for attempt number and passes rework context into sandbox execution', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    const workPackage = {
      id: 'pkg-1',
      assignedRole: 'backend',
      blockedReason: 'Needs rework from QA.',
      harnessId: 'harness-1',
      mcpRequirements: [],
      metadata: {},
      sequence: 1,
      status: 'needs_rework',
      title: 'Backend package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([workPackage]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chainWithLimit([{ attemptNumber: null }, { attemptNumber: 1 }]))
      .mockReturnValueOnce(chain([{
        id: 'gate-qa',
        gateType: 'qa_review',
        metadata: { decisionReason: 'Add regression tests.' },
        sourceArtifactId: 'artifact-old',
        status: 'needs_rework',
      }]))
      .mockReturnValueOnce(chain([{
        id: 'artifact-old',
        content: 'Prior implementation output:\n- Added API route but skipped regression tests.',
      }]))
      .mockReturnValueOnce(chain([{
        metadata: {
          executionLease: {
            acquiredAt: '2026-06-25T00:00:00.000Z',
            attemptNumber: 2,
            heartbeatAt: '2026-06-25T00:00:00.000Z',
            runId: 'run-2',
          },
        },
        status: 'running',
      }]))
    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    const leaseUpdate = updateChain([{ id: 'pkg-1' }])
    const runModelUpdate = updateChain([{ id: 'run-2' }])
    const contextArtifactLeaseUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runModelUpdate)
      .mockReturnValueOnce(contextArtifactLeaseUpdate)

    const runInsert = insertChain([{ id: 'run-2', agentRunId: 'run-2' }])
    const contextArtifactInsert = insertChain([{
      id: 'artifact-context',
      agentRunId: 'run-2',
      artifactType: 'log_output',
      content: 'context packet',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }])
    mocks.dbTransaction
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: vi.fn().mockReturnValueOnce(runInsert),
          update: vi.fn()
            .mockReturnValueOnce(claimUpdate)
            .mockReturnValueOnce(leaseUpdate),
        }),
      )
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: mocks.dbInsert,
          update: mocks.dbUpdate,
        }),
      )
    mocks.dbInsert.mockReturnValueOnce(contextArtifactInsert)
    mocks.materializeReviewGatesForWorkPackageCompletion.mockResolvedValueOnce({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [
        { id: 'gate-qa', gateType: 'qa_review', requiredRole: 'qa', title: 'QA review' },
        { id: 'gate-reviewer', gateType: 'reviewer_review', requiredRole: 'reviewer', title: 'Reviewer review' },
      ],
      sourceArtifact: defaultSourceArtifact({
        content: 'final output',
        id: 'artifact-final',
        metadata: {
          attemptNumber: 2,
          hostRepositoryWrites: false,
          repositoryWrites: false,
          sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-2',
          sandboxWrites: true,
          source: 'work-package-executor',
          workPackageId: 'pkg-1',
        },
        runId: 'run-2',
      }),
    })
    mocks.loadWorkPackageExecutionContext.mockResolvedValueOnce({
      agentConfig: null,
      modelIdUsed: 'test-model',
      project: { id: 'project-1' },
      task: { id: 'task-1' },
      validatedProjectRoot: '/workspace/project',
      workPackage: {
        id: 'pkg-1',
        metadata: { repositoryWrites: false },
        requiredCapabilities: {},
        title: 'Backend package',
        assignedRole: 'backend',
      },
    })
    mocks.executeWorkPackage.mockResolvedValue({
      artifactContent: 'final output',
      artifactMetadata: {
        hostRepositoryWrites: false,
        repositoryWrites: false,
        sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-2',
        sandboxWrites: true,
      },
      commandResults: [],
      executionContextArtifactContent: 'context packet',
      executionContextArtifactMetadata: {
        artifactKind: 'host_readonly_execution_context',
        hostRepositoryWrites: false,
        sandboxWrites: false,
      },
      executionContextPacket: {},
      fileCount: 1,
      sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-2',
      summary: 'Implemented rework.',
    })

    try {
      const result = await handoffApprovedWorkPackages('task-1')

      expect(result).toMatchObject({
        status: 'handed_off',
        claimedPackageId: 'pkg-1',
      })
      expect(runInsert.values).toHaveBeenCalledWith(expect.objectContaining({
        attemptNumber: 2,
        modelIdUsed: 'pending',
        stage: 'implementation',
        workPackageId: 'pkg-1',
      }))
      expect(leaseUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          executionLease: expect.objectContaining({
            attemptNumber: 2,
            runId: 'run-2',
            source: 'work-package-handoff',
          }),
        }),
      }))
      expect(runModelUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ modelIdUsed: 'test-model' }))
      expect(mocks.executeWorkPackage).toHaveBeenCalledWith(expect.objectContaining({
        attemptNumber: 2,
        priorReviewContext: expect.objectContaining({
          packageBlockedReason: 'Needs rework from QA.',
          notes: [expect.objectContaining({
            gateId: 'gate-qa',
            reason: expect.stringContaining('Add regression tests.'),
            sourceArtifactId: 'artifact-old',
          })],
        }),
      }))
      expect(mocks.executeWorkPackage.mock.calls[0][0].priorReviewContext.notes[0].reason)
        .toContain('Prior implementation output')
      expect(contextArtifactInsert.values).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          artifactKind: 'host_readonly_execution_context',
          attemptNumber: 2,
          hostRepositoryWrites: false,
          sandboxWrites: false,
          source: 'execution-context-packet',
        }),
      }))
      expect(mocks.materializeReviewGatesForWorkPackageCompletion).toHaveBeenCalledWith(expect.objectContaining({
        completeSourceRun: expect.objectContaining({
          artifactType: 'log_output',
          content: 'final output',
          metadata: expect.objectContaining({
            attemptNumber: 2,
            hostRepositoryWrites: false,
            repositoryWrites: false,
            sandboxWrites: true,
            source: 'work-package-executor',
          }),
        }),
        requireExecutionLease: true,
        sourceAgentRunId: 'run-2',
        sourceArtifactId: null,
        taskId: 'task-1',
        workPackageId: 'pkg-1',
      }))
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'artifact:created', expect.objectContaining({
        agentRunId: 'run-2',
        artifactId: 'artifact-final',
        content: 'final output',
        metadata: expect.objectContaining({
          attemptNumber: 2,
          source: 'work-package-executor',
        }),
      }))
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:handoff', expect.objectContaining({
        hostRepositoryWrites: false,
        repositoryWrites: false,
        sandboxWrites: true,
        sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-2',
      }))
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('does not write stale package artifacts after execution if the lease was cancelled', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    const workPackage = {
      id: 'pkg-1',
      assignedRole: 'backend',
      harnessId: 'harness-1',
      mcpRequirements: [],
      metadata: {},
      sequence: 1,
      status: 'pending',
      title: 'Backend package',
    }
    mocks.dbSelect
      .mockReturnValueOnce(chain([workPackage]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    const leaseUpdate = updateChain([{ id: 'pkg-1' }])
    const runModelUpdate = updateChain([{ id: 'run-1' }])
    const lostLeaseUpdate = updateChain([])
    const staleRunUpdate = updateChain([{ id: 'run-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runModelUpdate)
      .mockReturnValueOnce(lostLeaseUpdate)
      .mockReturnValueOnce(staleRunUpdate)

    const runInsert = insertChain([{ id: 'run-1', agentRunId: 'run-1' }])
    mocks.dbTransaction
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: vi.fn().mockReturnValueOnce(runInsert),
          update: vi.fn()
            .mockReturnValueOnce(claimUpdate)
            .mockReturnValueOnce(leaseUpdate),
        }),
      )
      .mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
        callback({
          insert: mocks.dbInsert,
          update: mocks.dbUpdate,
        }),
      )
    mocks.loadWorkPackageExecutionContext.mockResolvedValueOnce({
      agentConfig: null,
      modelIdUsed: 'test-model',
      project: { id: 'project-1' },
      task: { id: 'task-1' },
      validatedProjectRoot: '/workspace/project',
      workPackage: {
        id: 'pkg-1',
        metadata: { repositoryWrites: false },
        requiredCapabilities: { repository: false },
        title: 'Backend package',
        assignedRole: 'backend',
      },
    })
    mocks.executeWorkPackage.mockResolvedValueOnce({
      artifactContent: 'final output after cancel',
      artifactMetadata: {
        hostRepositoryWrites: false,
        repositoryWrites: false,
        sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
        sandboxWrites: true,
      },
      commandResults: [],
      executionContextArtifactContent: 'context packet after cancel',
      executionContextArtifactMetadata: {
        artifactKind: 'host_readonly_execution_context',
        hostRepositoryWrites: false,
        sandboxWrites: false,
      },
      executionContextPacket: {},
      fileCount: 1,
      sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
      summary: 'Completed after cancellation.',
    })

    try {
      const result = await handoffApprovedWorkPackages('task-1')

      expect(result).toMatchObject({
        status: 'already_handed_off',
        claimedPackageId: 'pkg-1',
      })
      expect(mocks.executeWorkPackage).toHaveBeenCalled()
      expect(mocks.dbInsert).not.toHaveBeenCalled()
      expect(mocks.materializeReviewGatesForWorkPackageCompletion).not.toHaveBeenCalled()
      expect(staleRunUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: expect.stringContaining('no longer active'),
        status: 'failed',
      }))
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'run:failed', expect.objectContaining({
        errorMessage: expect.stringContaining('ignoring stale completion'),
        runId: 'run-1',
      }))
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('fails the package and task instead of starting a fourth implementation attempt', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'pkg-1',
        assignedRole: 'backend',
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: {},
        sequence: 1,
        status: 'needs_rework',
        title: 'Backend package',
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ attemptNumber: 3 }]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    const failedPackageUpdate = updateChain([{ id: 'pkg-1' }])
    const runningTaskUpdate = updateChain([])
    const approvedTaskUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runningTaskUpdate)
      .mockReturnValueOnce(approvedTaskUpdate)
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn(),
        update: vi.fn()
          .mockReturnValueOnce(claimUpdate)
          .mockReturnValueOnce(failedPackageUpdate),
      }),
    )

    try {
      const result = await handoffApprovedWorkPackages('task-1')

      expect(result).toMatchObject({
        status: 'blocked',
        terminalBlock: true,
        blockedReason: expect.stringContaining('maximum of 3 implementation attempts'),
      })
      expect(failedPackageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: expect.stringContaining('maximum of 3 implementation attempts'),
        metadata: expect.objectContaining({
          executionAttempts: expect.objectContaining({
            maxAttempts: 3,
            nextAttemptNumber: 4,
            status: 'failed',
          }),
        }),
        status: 'failed',
      }))
      expect(claimUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: null,
        status: 'running',
      }))
      expect(approvedTaskUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: expect.stringContaining('maximum of 3 implementation attempts'),
        status: 'failed',
      }))
      expect(mocks.loadWorkPackageExecutionContext).not.toHaveBeenCalled()
      expect(mocks.executeWorkPackage).not.toHaveBeenCalled()
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('keeps package execution failures retryable before the final approval attempt', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'pkg-1',
        assignedRole: 'backend',
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: {},
        sequence: 1,
        status: 'pending',
        title: 'Backend package',
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{
        metadata: {
          executionLease: {
            acquiredAt: '2026-06-25T00:00:00.000Z',
            attemptNumber: 1,
            heartbeatAt: '2026-06-25T00:00:00.000Z',
            runId: 'run-1',
          },
        },
        status: 'running',
      }]))

    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    const claimUpdate = updateChain([{ id: 'pkg-1' }])
    const leaseUpdate = updateChain([{ id: 'pkg-1' }])
    const runModelUpdate = updateChain([{ id: 'run-1' }])
    const runFailedUpdate = updateChain([{ id: 'run-1' }])
    const packageBlockedUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(readyUpdate)
      .mockReturnValueOnce(runModelUpdate)
      .mockReturnValueOnce(packageBlockedUpdate)
      .mockReturnValueOnce(runFailedUpdate)
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn().mockReturnValueOnce(insertChain([{ id: 'run-1', agentRunId: 'run-1' }])),
        update: vi.fn()
          .mockReturnValueOnce(claimUpdate)
          .mockReturnValueOnce(leaseUpdate),
      }),
    )
    const failedArtifactInsert = insertChain([{
      id: 'artifact-failed',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'Generated files before failure.',
      metadata: {},
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    }])
    mocks.dbInsert.mockReturnValueOnce(failedArtifactInsert)
    mocks.loadWorkPackageExecutionContext.mockResolvedValue({
      agentConfig: null,
      modelIdUsed: 'test-model',
      project: { id: 'project-1' },
      task: { id: 'task-1' },
      validatedProjectRoot: '/workspace/project',
      workPackage: {
        id: 'pkg-1',
        metadata: { repositoryWrites: false },
        requiredCapabilities: {},
        title: 'Backend package',
        assignedRole: 'backend',
      },
    })
    const leakedBearerToken = fixtureSecret('sk', '-live', '-secret')
    mocks.executeWorkPackage.mockRejectedValueOnce(new mocks.WorkPackageExecutionError(
      `model unavailable Authorization: Bearer ${leakedBearerToken} https://user:remote-secret@example.com/repo.git`,
      {
        artifactContent: 'Generated files before failure.',
        artifactMetadata: {
          commandResults: [{ command: ['npm', 'test'], exitCode: 1, stdout: '', stderr: 'failed' }],
          files: ['package.json'],
          generatedBy: 'work-package-executor',
          repositoryWrites: false,
          sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
          sandboxWrites: true,
          validationStatus: 'failed',
        },
        commandResults: [{ command: ['npm', 'test'], exitCode: 1, stdout: '', stderr: 'failed' }],
        fileCount: 1,
        sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
      },
    ))

    try {
      await expect(handoffApprovedWorkPackages('task-1', { finalAttempt: false }))
        .rejects.toThrow('model unavailable')

      expect(packageBlockedUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: 'Retrying package execution after error: model unavailable Authorization: Bearer [REDACTED_TOKEN] https://[REDACTED_USERINFO]@example.com/repo.git',
        status: 'blocked',
      }))
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
        blockedReason: 'Retrying package execution after error: model unavailable Authorization: Bearer [REDACTED_TOKEN] https://[REDACTED_USERINFO]@example.com/repo.git',
        status: 'blocked',
        workPackageId: 'pkg-1',
      }))
      expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'run:failed', expect.objectContaining({
        errorMessage: expect.stringContaining(leakedBearerToken),
      }))
      expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'work_package:status', expect.objectContaining({
        status: 'failed',
        workPackageId: 'pkg-1',
      }))
      expect(failedArtifactInsert.values).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Generated files before failure.'),
        metadata: expect.objectContaining({
          errorMessage: 'model unavailable Authorization: Bearer [REDACTED_TOKEN] https://[REDACTED_USERINFO]@example.com/repo.git',
          failure: true,
          files: ['package.json'],
          generatedBy: 'work-package-executor',
          sandboxPath: '/workspace/project/.forge/task-runs/task-1/pkg-1/attempt-1',
          sandboxWrites: true,
          validationStatus: 'failed',
        }),
      }))
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
  })

  it('recovers a stale running package before retrying the next implementation attempt', async () => {
    const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    const staleUpdatedAt = new Date(Date.now() - 60 * 60 * 1000)
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'pkg-1',
        assignedRole: 'backend',
        blockedReason: null,
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: {},
        sequence: 1,
        status: 'running',
        title: 'Backend package',
        updatedAt: staleUpdatedAt,
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{
        id: 'run-stale',
        attemptNumber: 1,
        stage: 'implementation',
      }]))
      .mockReturnValueOnce(chain([{
        id: 'pkg-1',
        assignedRole: 'backend',
        blockedReason: 'Recovered stale running work package.',
        harnessId: 'harness-1',
        mcpRequirements: [],
        metadata: {},
        sequence: 1,
        status: 'blocked',
        title: 'Backend package',
        updatedAt: new Date(),
      }]))
      .mockReturnValueOnce(chain([]))

    const recoveredPackageUpdate = updateChain([{ id: 'pkg-1' }])
    const recoveredRunUpdate = updateChain([{ id: 'run-stale' }])
    const readyUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(recoveredPackageUpdate)
      .mockReturnValueOnce(recoveredRunUpdate)
      .mockReturnValueOnce(readyUpdate)

    try {
      const result = await handoffApprovedWorkPackages('task-1', { claimEnabled: false })

      expect(result).toMatchObject({
        status: 'ready_only',
        readyPackageIds: ['pkg-1'],
        claimedPackageId: null,
      })
      expect(recoveredPackageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        status: 'blocked',
        blockedReason: expect.stringContaining('Recovered stale running work package'),
      }))
      expect(recoveredRunUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('Recovered stale running work package'),
      }))
      expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'run:failed', expect.objectContaining({
        runId: 'run-stale',
        workPackageId: 'pkg-1',
      }))
      expect(readyUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
        blockedReason: null,
        status: 'ready',
      }))
    } finally {
      if (previousExecutionFlag === undefined) {
        delete process.env.FORGE_WORK_PACKAGE_EXECUTION
      } else {
        process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
      }
    }
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
    mocks.dbUpdate.mockReturnValueOnce(readyUpdate)
    const { claimUpdate } = mockNoOpHandoffTransaction()

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
