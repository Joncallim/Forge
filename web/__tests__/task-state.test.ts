import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbUpdate: vi.fn(),
  publishTaskEvent: vi.fn(),
}))

function updateChain(returnValue: unknown) {
  const chain: Record<string, unknown> = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn(() => Promise.resolve(returnValue)),
  }
  return chain
}

vi.mock('@/db', () => ({
  db: {
    update: mocks.dbUpdate,
  },
}))

vi.mock('@/worker/events', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}))

import { updateTaskStatus } from '@/worker/task-state'

describe('task status updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('publishes when a non-terminal task is updated', async () => {
    mocks.dbUpdate.mockReturnValueOnce(updateChain([{ id: 'task-1' }]))

    await expect(updateTaskStatus('task-1', 'failed', 'model failed')).resolves.toBe(true)

    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:status', expect.objectContaining({
      errorMessage: 'model failed',
      status: 'failed',
    }))
  })

  it('does not publish when a terminal task guard prevents a stale update', async () => {
    mocks.dbUpdate.mockReturnValueOnce(updateChain([]))

    await expect(updateTaskStatus('task-1', 'failed', 'late worker failure')).resolves.toBe(false)

    expect(mocks.publishTaskEvent).not.toHaveBeenCalled()
  })
})
