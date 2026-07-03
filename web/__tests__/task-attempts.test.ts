import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbUpdate: vi.fn(),
  recordTaskLogBestEffort: vi.fn(),
}))

function chain(returnValue: unknown) {
  const thenable: Record<string, unknown> = {
    returning: vi.fn(() => Promise.resolve(returnValue)),
    set: vi.fn(() => thenable),
    values: vi.fn(() => thenable),
    where: vi.fn(() => thenable),
  }
  return thenable
}

vi.mock('@/db', () => ({
  db: {
    insert: mocks.dbInsert,
    update: mocks.dbUpdate,
  },
}))

vi.mock('@/worker/task-logs', () => ({
  recordTaskLogBestEffort: mocks.recordTaskLogBestEffort,
}))

import { describeQueueWorker, finishTaskAttempt, startTaskAttempt } from '@/worker/task-attempts'

describe('task attempt logs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses a friendly queue worker name and role for started attempts', async () => {
    mocks.dbInsert.mockReturnValueOnce(chain([{ id: 'attempt-1' }]))

    await startTaskAttempt({
      attemptNumber: 1,
      jobPayload: { taskId: 'task-1' },
      queueName: 'tasks',
      taskId: 'task-1',
      workerId: 'embedded-20008-mr48e1f1',
    })

    expect(mocks.recordTaskLogBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'queue.attempt.started',
      message: expect.stringContaining('Forge Task Worker claimed tasks attempt 1. Role:'),
      metadata: expect.objectContaining({
        workerId: 'embedded-20008-mr48e1f1',
        workerName: 'Forge Task Worker',
        workerRole: expect.stringContaining('Architect planning'),
      }),
    }))
    expect(mocks.recordTaskLogBestEffort.mock.calls[0][0].message).not.toContain('embedded-20008-mr48e1f1')
  })

  it('keeps friendly worker context on finished attempts', async () => {
    mocks.dbUpdate.mockReturnValueOnce(chain([{
      attemptNumber: 2,
      queueName: 'answers',
      taskId: 'task-1',
      workerId: 'embedded-20008-mr48e1f1',
    }]))

    await finishTaskAttempt({
      attemptId: 'attempt-1',
      errorMessage: 'replan failed',
      status: 'failed',
    })

    expect(mocks.recordTaskLogBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'queue.attempt.failed',
      message: 'Forge Answers Worker finished answers attempt 2 as failed: replan failed',
      metadata: expect.objectContaining({
        workerName: 'Forge Answers Worker',
        workerRole: expect.stringContaining('follow-up questions'),
      }),
    }))
  })

  it('describes approval workers by their handoff role', () => {
    expect(describeQueueWorker('approvals')).toMatchObject({
      name: 'Forge Approval Worker',
      role: expect.stringContaining('handoff'),
    })
  })
})
