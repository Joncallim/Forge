import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbUpdate: vi.fn(),
  handoffApprovedWorkPackages: vi.fn(),
  isWorkPackageHandoffEnabled: vi.fn(),
  previewWorkPackageHandoff: vi.fn(),
  progressWorkforce: vi.fn(),
  completeTaskIfReviewGatesSatisfied: vi.fn(),
  publishTaskEvent: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: {
    select: mocks.dbSelect,
    update: mocks.dbUpdate,
  },
}))

vi.mock('@/worker/events', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}))

vi.mock('@/worker/work-package-handoff', () => ({
  handoffApprovedWorkPackages: mocks.handoffApprovedWorkPackages,
  isWorkPackageHandoffEnabled: mocks.isWorkPackageHandoffEnabled,
  previewWorkPackageHandoff: mocks.previewWorkPackageHandoff,
  progressWorkforce: mocks.progressWorkforce,
}))

vi.mock('@/worker/review-gates', () => ({
  completeTaskIfReviewGatesSatisfied: mocks.completeTaskIfReviewGatesSatisfied,
}))

import { processApproval } from '@/worker/orchestrator'

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

describe('processApproval handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isWorkPackageHandoffEnabled.mockReturnValue(true)
    mocks.completeTaskIfReviewGatesSatisfied.mockResolvedValue({
      status: 'blocked',
      reason: 'work packages are not complete',
    })
    mocks.progressWorkforce.mockResolvedValue({
      status: 'no_ready_packages',
      readyPackageIds: [],
      claimedPackageId: null,
    })
  })

  it('keeps the legacy approval completion path when no work packages exist', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    const update = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate.mockReturnValue(update)
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'no_work_packages',
      readyPackageIds: [],
      claimedPackageId: null,
    })

    await processApproval('task-1')

    expect(mocks.previewWorkPackageHandoff).toHaveBeenCalledWith('task-1')
    expect(mocks.handoffApprovedWorkPackages).not.toHaveBeenCalled()
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:status', expect.objectContaining({
      status: 'completed',
    }))
    expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'task:handoff', expect.anything())
  })

  it('moves approved tasks with work packages into execution handoff', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    const update = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate.mockReturnValue(update)
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'claimable',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })
    mocks.handoffApprovedWorkPackages.mockResolvedValue({
      status: 'handed_off',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })

    await processApproval('task-1')

    expect(mocks.previewWorkPackageHandoff).toHaveBeenCalledWith('task-1')
    expect(mocks.handoffApprovedWorkPackages).toHaveBeenCalledWith('task-1', { claimEnabled: true, finalAttempt: true })
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', expect.objectContaining({
      claimedPackageId: 'pkg-1',
      readyPackageIds: ['pkg-1'],
      status: 'handed_off',
    }))
  })

  it('restores approved status when package handoff fails after claiming the task', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    const runningUpdate = updateChain([{ id: 'task-1' }])
    const restoreUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(runningUpdate)
      .mockReturnValueOnce(restoreUpdate)
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'claimable',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })
    mocks.handoffApprovedWorkPackages.mockRejectedValue(new Error('handoff insert failed'))

    await expect(processApproval('task-1', { finalAttempt: false })).rejects.toThrow('handoff insert failed')

    expect(runningUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
    expect(restoreUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: 'Retrying handoff after error: handoff insert failed',
      status: 'approved',
    }))
    expect(mocks.handoffApprovedWorkPackages).toHaveBeenCalledWith('task-1', { claimEnabled: true, finalAttempt: false })
  })

  it('fails the task when package handoff fails on the final approval attempt', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    const runningUpdate = updateChain([{ id: 'task-1' }])
    const failUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(runningUpdate)
      .mockReturnValueOnce(failUpdate)
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'claimable',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })
    mocks.handoffApprovedWorkPackages.mockRejectedValue(new Error('handoff insert failed'))

    await expect(processApproval('task-1', { finalAttempt: true })).rejects.toThrow('handoff insert failed')

    expect(runningUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
    expect(failUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: 'handoff insert failed',
      status: 'failed',
    }))
    expect(mocks.handoffApprovedWorkPackages).toHaveBeenCalledWith('task-1', { claimEnabled: true, finalAttempt: true })
  })

  it('keeps broker-blocked handoff recoverable instead of failing the task', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    const runningUpdate = updateChain([{ id: 'task-1' }])
    const restoreUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(runningUpdate)
      .mockReturnValueOnce(restoreUpdate)
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'claimable',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })
    mocks.handoffApprovedWorkPackages.mockResolvedValue({
      status: 'blocked',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: null,
      blockedReason: 'MCP/capability broker blocked "Backend package": Connect GitHub.',
    })

    await processApproval('task-1', { finalAttempt: true })

    expect(runningUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
    expect(restoreUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: 'MCP/capability broker blocked "Backend package": Connect GitHub.',
      status: 'approved',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', expect.objectContaining({
      blockedReason: 'MCP/capability broker blocked "Backend package": Connect GitHub.',
      claimedPackageId: null,
      readyPackageIds: ['pkg-1'],
      status: 'blocked',
    }))
  })

  it('fails the task for terminal handoff safety blocks after claiming the task', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    const runningUpdate = updateChain([{ id: 'task-1' }])
    const failUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate
      .mockReturnValueOnce(runningUpdate)
      .mockReturnValueOnce(failUpdate)
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'claimable',
      readyPackageIds: ['pkg-security'],
      claimedPackageId: 'pkg-security',
    })
    mocks.handoffApprovedWorkPackages.mockResolvedValue({
      status: 'blocked',
      readyPackageIds: [],
      claimedPackageId: null,
      blockedReason: 'Architect-assigned "security" work packages are reserved for review gates and cannot execute.',
      terminalBlock: true,
    })

    await processApproval('task-1', { finalAttempt: true })

    expect(runningUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
    expect(failUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: 'Architect-assigned "security" work packages are reserved for review gates and cannot execute.',
      status: 'failed',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', expect.objectContaining({
      blockedReason: 'Architect-assigned "security" work packages are reserved for review gates and cannot execute.',
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
      terminalBlock: true,
    }))
  })

  it('does not move the task to running when no package can be claimed', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'no_ready_packages',
      readyPackageIds: [],
      claimedPackageId: null,
    })

    await processApproval('task-1')

    expect(mocks.dbUpdate).not.toHaveBeenCalled()
    expect(mocks.handoffApprovedWorkPackages).not.toHaveBeenCalled()
    expect(mocks.completeTaskIfReviewGatesSatisfied).toHaveBeenCalledWith('task-1')
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', expect.objectContaining({
      claimedPackageId: null,
      readyPackageIds: [],
      reviewBlockReason: 'work packages are not complete',
      reviewStatus: 'blocked',
      status: 'no_ready_packages',
    }))
  })

  it('completes the task when no packages are ready because all review gates are satisfied', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'no_ready_packages',
      readyPackageIds: [],
      claimedPackageId: null,
    })
    mocks.completeTaskIfReviewGatesSatisfied.mockResolvedValue({ status: 'completed' })

    await processApproval('task-1')

    expect(mocks.completeTaskIfReviewGatesSatisfied).toHaveBeenCalledWith('task-1')
    expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith('task-1', 'task:handoff', expect.anything())
  })

  it('marks packages ready without claiming when handoff execution is disabled', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    mocks.isWorkPackageHandoffEnabled.mockReturnValue(false)
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'claimable',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: 'pkg-1',
    })
    mocks.handoffApprovedWorkPackages.mockResolvedValue({
      status: 'ready_only',
      readyPackageIds: ['pkg-1'],
      claimedPackageId: null,
    })

    await processApproval('task-1')

    expect(mocks.dbUpdate).not.toHaveBeenCalled()
    expect(mocks.handoffApprovedWorkPackages).toHaveBeenCalledWith('task-1', { claimEnabled: false })
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', expect.objectContaining({
      claimedPackageId: null,
      readyPackageIds: ['pkg-1'],
      status: 'ready_only',
    }))
  })

  it('continues an already-running task after review gates without resetting approval state', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'running' }]))
    mocks.progressWorkforce.mockResolvedValue({
      status: 'handed_off',
      readyPackageIds: ['pkg-2'],
      claimedPackageId: 'pkg-2',
    })

    await processApproval('task-1')

    expect(mocks.previewWorkPackageHandoff).not.toHaveBeenCalled()
    expect(mocks.handoffApprovedWorkPackages).not.toHaveBeenCalled()
    expect(mocks.dbUpdate).not.toHaveBeenCalled()
    expect(mocks.progressWorkforce).toHaveBeenCalledWith('task-1', { claimEnabled: true, finalAttempt: true })
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', expect.objectContaining({
      claimedPackageId: 'pkg-2',
      readyPackageIds: ['pkg-2'],
      status: 'handed_off',
    }))
  })

  it('leaves an already-running task running when continuation fails before the final retry', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'running' }]))
    mocks.progressWorkforce.mockRejectedValue(new Error('handoff insert failed'))

    await expect(processApproval('task-1', { finalAttempt: false })).rejects.toThrow('handoff insert failed')

    expect(mocks.dbUpdate).not.toHaveBeenCalled()
    expect(mocks.progressWorkforce).toHaveBeenCalledWith('task-1', { claimEnabled: true, finalAttempt: false })
  })

  it('parks a running task back at approved when continuation hits a recoverable broker block', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'running' }]))
    const restoreUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate.mockReturnValueOnce(restoreUpdate)
    mocks.progressWorkforce.mockResolvedValue({
      status: 'blocked',
      readyPackageIds: [],
      claimedPackageId: null,
      blockedReason: 'MCP/capability broker blocked this work package.',
      terminalBlock: false,
    })

    await processApproval('task-1')

    expect(restoreUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: 'MCP/capability broker blocked this work package.',
      status: 'approved',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', expect.objectContaining({
      blockedReason: 'MCP/capability broker blocked this work package.',
      status: 'blocked',
      terminalBlock: false,
    }))
  })

  it('fails an already-running task when continuation fails on the final retry', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'running' }]))
    mocks.progressWorkforce.mockRejectedValue(new Error('handoff insert failed'))
    const failUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate.mockReturnValueOnce(failUpdate)

    await expect(processApproval('task-1', { finalAttempt: true })).rejects.toThrow('handoff insert failed')

    expect(failUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: 'handoff insert failed',
      status: 'failed',
    }))
    expect(mocks.progressWorkforce).toHaveBeenCalledWith('task-1', { claimEnabled: true, finalAttempt: true })
  })

  it('fails the task for terminal handoff safety blocks when handoff execution is disabled', async () => {
    mocks.dbSelect.mockReturnValue(chain([{ status: 'approved' }]))
    mocks.isWorkPackageHandoffEnabled.mockReturnValue(false)
    const failUpdate = updateChain([{ id: 'task-1' }])
    mocks.dbUpdate.mockReturnValueOnce(failUpdate)
    mocks.previewWorkPackageHandoff.mockResolvedValue({
      status: 'claimable',
      readyPackageIds: ['pkg-security'],
      claimedPackageId: 'pkg-security',
    })
    mocks.handoffApprovedWorkPackages.mockResolvedValue({
      status: 'blocked',
      readyPackageIds: [],
      claimedPackageId: null,
      blockedReason: 'Architect-assigned "security" work packages are reserved for review gates and cannot execute.',
      terminalBlock: true,
    })

    await processApproval('task-1')

    expect(failUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: 'Architect-assigned "security" work packages are reserved for review gates and cannot execute.',
      status: 'failed',
    }))
    expect(mocks.handoffApprovedWorkPackages).toHaveBeenCalledWith('task-1', { claimEnabled: false })
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', expect.objectContaining({
      blockedReason: 'Architect-assigned "security" work packages are reserved for review gates and cannot execute.',
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
      terminalBlock: true,
    }))
  })
})
