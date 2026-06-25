import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbUpdate: vi.fn(),
  handoffApprovedWorkPackages: vi.fn(),
  isWorkPackageHandoffEnabled: vi.fn(),
  previewWorkPackageHandoff: vi.fn(),
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
    expect(mocks.handoffApprovedWorkPackages).toHaveBeenCalledWith('task-1', { claimEnabled: true })
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', {
      claimedPackageId: 'pkg-1',
      readyPackageIds: ['pkg-1'],
      status: 'handed_off',
    })
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
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', {
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'no_ready_packages',
    })
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
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:handoff', {
      claimedPackageId: null,
      readyPackageIds: ['pkg-1'],
      status: 'ready_only',
    })
  })
})
