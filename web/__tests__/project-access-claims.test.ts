import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDbSelect = vi.fn()
const mockDbUpdate = vi.fn()

vi.mock('@/db', () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
  },
}))

function chain(resolveValue: unknown) {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  const methods = ['from', 'where', 'limit', 'set', 'returning']
  methods.forEach((m) => { thenable[m] = () => thenable })
  return thenable
}

describe('project access ownership claiming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('claims a direct project access row when it is still unowned', async () => {
    mockDbSelect.mockReturnValueOnce(chain([]))
    mockDbUpdate.mockReturnValueOnce(chain([{
      id: 'project-123',
      name: 'Legacy project',
      submittedBy: 'user-abc',
    }]))

    const { getAccessibleProject } = await import('@/lib/project-access')
    const project = await getAccessibleProject('project-123', 'user-abc')

    expect(project).toMatchObject({
      id: 'project-123',
      submittedBy: 'user-abc',
    })
    expect(mockDbUpdate).toHaveBeenCalled()
  })

  it('bulk-claims unowned projects for the first authenticated project listing', async () => {
    mockDbUpdate.mockReturnValueOnce(chain([{ id: 'project-123' }]))

    const { claimUnownedProjects } = await import('@/lib/project-access')
    const claimed = await claimUnownedProjects('user-abc')

    expect(claimed).toEqual([{ id: 'project-123' }])
    expect(mockDbUpdate).toHaveBeenCalled()
  })
})
