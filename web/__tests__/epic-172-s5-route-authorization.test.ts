import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({ default: {} }))

const getSession = vi.fn()
const getAccessibleTask = vi.fn()
const readS5AuthoritativeTaskState = vi.fn()

vi.mock('@/lib/session', () => ({ getSession }))
vi.mock('@/lib/task-access', () => ({ getAccessibleTask }))
vi.mock('@/lib/mcps/s5-server-reader', () => ({
  readS5AuthoritativeTaskState,
  S5TaskNotFoundError: class S5TaskNotFoundError extends Error {},
}))

describe('S5 shared route authorization', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects before a database read when no session exists', async () => {
    getSession.mockResolvedValue(null)
    const { readAuthorizedS5State } = await import('@/lib/mcps/s5-route')
    await expect(readAuthorizedS5State({} as never, 'task-1')).rejects.toMatchObject({ status: 401 })
    expect(getAccessibleTask).not.toHaveBeenCalled()
    expect(readS5AuthoritativeTaskState).not.toHaveBeenCalled()
  })

  it('rejects a non-owner without reading S5 state', async () => {
    getSession.mockResolvedValue({ userId: 'user-1' })
    getAccessibleTask.mockResolvedValue({ id: 'task-1', submittedBy: 'user-2' })
    const { readAuthorizedS5State } = await import('@/lib/mcps/s5-route')
    await expect(readAuthorizedS5State({} as never, 'task-1')).rejects.toMatchObject({ status: 404 })
    expect(readS5AuthoritativeTaskState).not.toHaveBeenCalled()
  })

  it('binds the authoritative read to the authenticated owner', async () => {
    const state = { taskId: 'task-1' }
    getSession.mockResolvedValue({ userId: 'user-1' })
    getAccessibleTask.mockResolvedValue({ id: 'task-1', submittedBy: 'user-1' })
    readS5AuthoritativeTaskState.mockResolvedValue(state)
    const { readAuthorizedS5State } = await import('@/lib/mcps/s5-route')
    await expect(readAuthorizedS5State({} as never, 'task-1')).resolves.toEqual({ state, userId: 'user-1' })
    expect(readS5AuthoritativeTaskState).toHaveBeenCalledWith('task-1', 'user-1')
  })
})
