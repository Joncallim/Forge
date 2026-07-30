import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAccessibleTask: vi.fn(),
  getSession: vi.fn(),
  guardIngress: vi.fn(),
  publishTaskEvent: vi.fn(),
  recordTaskLog: vi.fn(),
  update: vi.fn(),
}))

function updateChain(row: unknown) {
  const chain: Record<string, unknown> = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn(() => Promise.resolve([row])),
  }
  return chain
}

vi.mock('@/db', () => ({ db: { update: mocks.update } }))
vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }))
vi.mock('@/lib/task-access', () => ({
  accessibleTaskCondition: vi.fn(() => undefined),
  getAccessibleTask: mocks.getAccessibleTask,
}))
vi.mock('@/lib/projects/epic-172-project-ingress', () => ({
  guardEpic172ProjectManagementIngress: mocks.guardIngress,
}))
vi.mock('@/worker/events', () => ({ publishTaskEvent: mocks.publishTaskEvent }))
vi.mock('@/worker/task-logs', () => ({ recordTaskLogBestEffort: mocks.recordTaskLog }))

describe('task rejection compatibility projection', () => {
  afterEach(() => vi.restoreAllMocks())

  it('retains the operator reason only in the update intent while closing HTTP, event, log, and console outputs', async () => {
    const reason = 'PROMPT-SENTINEL /private/task token=SECRET-SENTINEL'
    const task = {
      id: 'task-1', projectId: 'project-1', submittedBy: 'user-1', title: 'Reject', prompt: 'canonical task prompt',
      status: 'rejected', errorMessage: reason, updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    }
    const update = updateChain(task)
    mocks.getSession.mockResolvedValue({ userId: 'user-1' })
    mocks.getAccessibleTask.mockResolvedValue({ ...task, status: 'awaiting_approval' })
    mocks.guardIngress.mockResolvedValue(null)
    mocks.update.mockReturnValue(update)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    const { POST } = await import('@/app/api/tasks/[id]/reject/route')
    const response = await POST(new Request('http://localhost/api/tasks/task-1/reject', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    }) as never, { params: Promise.resolve({ id: 'task-1' }) })

    expect(response.status).toBe(200)
    expect((update.set as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: reason }))
    expect((await response.json()).task.errorMessage).toBe('legacy_task_log_unavailable')
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'task:status', expect.objectContaining({
      errorMessage: 'legacy_task_log_unavailable',
    }))
    expect(mocks.recordTaskLog).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Task was rejected: legacy_task_log_unavailable',
    }))
    expect(JSON.stringify(info.mock.calls)).not.toContain(reason)
  })
})
