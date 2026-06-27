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

vi.mock('@/worker/review-gates', () => ({
  materializeReviewGatesForWorkPackageCompletion: mocks.materializeReviewGatesForWorkPackageCompletion,
  completeTaskIfReviewGatesSatisfied: mocks.completeTaskIfReviewGatesSatisfied,
}))

import { handoffApprovedWorkPackages } from '@/worker/work-package-handoff'

function chain(resolveValue: unknown) {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'returning', 'set', 'offset', 'innerJoin']
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
})
