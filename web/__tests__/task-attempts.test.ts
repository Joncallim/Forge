import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbTransaction: vi.fn(),
  dbUpdate: vi.fn(),
  recordTaskLogBestEffort: vi.fn(),
}))

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const OCCURRENCE_ID = '22222222-2222-4222-8222-222222222222'

function chain(returnValue: unknown) {
  const thenable: Record<string, unknown> = {
    returning: vi.fn(() => Promise.resolve(returnValue)),
    set: vi.fn(() => thenable),
    values: vi.fn(() => thenable),
    where: vi.fn(() => thenable),
  }
  return thenable
}

function selectChain(returnValue: unknown) {
  const query: Record<string, unknown> = {}
  for (const method of ['from', 'where', 'orderBy', 'limit']) {
    query[method] = vi.fn(() => query)
  }
  query.for = vi.fn(() => Promise.resolve(returnValue))
  return query
}

function transactionWithRunningAttempts(
  runningAttempts: unknown[],
  attemptId = '33333333-3333-4333-8333-333333333333',
) {
  const insert = vi.fn(() => chain([{ id: attemptId }]))
  const updateWhere = vi.fn().mockResolvedValue(undefined)
  const updateSet = vi.fn(() => ({ where: updateWhere }))
  const update = vi.fn(() => ({ set: updateSet }))
  const tx = {
    insert,
    select: vi.fn(() => selectChain(runningAttempts)),
    update,
  }
  mocks.dbTransaction.mockImplementationOnce(async (callback: (value: typeof tx) => unknown) =>
    await callback(tx))
  return { insert, tx, update, updateSet, updateWhere }
}

vi.mock('@/db', () => ({
  db: {
    insert: mocks.dbInsert,
    transaction: mocks.dbTransaction,
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
    const transaction = transactionWithRunningAttempts([])

    await expect(startTaskAttempt({
      attemptNumber: 1,
      jobPayload: { taskId: TASK_ID, attempt: 1 },
      occurrenceId: OCCURRENCE_ID,
      queueName: 'tasks',
      taskId: TASK_ID,
      workerId: 'embedded-20008-mr48e1f1',
    })).resolves.toEqual({
      attemptId: '33333333-3333-4333-8333-333333333333',
      recoveredOccurrence: false,
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
    expect(transaction.insert.mock.results[0]?.value.values).toHaveBeenCalledWith(
      expect.objectContaining({
        jobPayload: {
          schemaVersion: 1,
          occurrenceId: OCCURRENCE_ID,
          job: { taskId: TASK_ID, attempt: 1 },
        },
      }),
    )
    expect(mocks.recordTaskLogBestEffort.mock.calls[0][0].message).not.toContain('embedded-20008-mr48e1f1')
  })

  it('atomically adopts only an exact closed same-occurrence running attempt', async () => {
    const priorAttemptId = '44444444-4444-4444-8444-444444444444'
    const transaction = transactionWithRunningAttempts([{
      id: priorAttemptId,
      jobPayload: {
        schemaVersion: 1,
        occurrenceId: OCCURRENCE_ID,
        job: { taskId: TASK_ID, attempt: 1 },
      },
    }])

    await expect(startTaskAttempt({
      attemptNumber: 1,
      jobPayload: { taskId: TASK_ID, attempt: 1 },
      occurrenceId: OCCURRENCE_ID,
      queueName: 'tasks',
      taskId: TASK_ID,
      workerId: 'worker-b',
    })).resolves.toEqual({
      attemptId: '33333333-3333-4333-8333-333333333333',
      recoveredOccurrence: true,
    })

    expect(transaction.updateSet).toHaveBeenCalledWith({
      completedAt: expect.any(Date),
      errorMessage: 'Queue occurrence ownership transferred to a recovered worker.',
      nextRetryAt: null,
      status: 'indeterminate',
    })
    expect(transaction.updateWhere).toHaveBeenCalledOnce()
  })

  it.each([
    ['different occurrence', {
      schemaVersion: 1,
      occurrenceId: '55555555-5555-4555-8555-555555555555',
      job: { taskId: TASK_ID, attempt: 1 },
    }],
    ['different attempt', {
      schemaVersion: 1,
      occurrenceId: OCCURRENCE_ID,
      job: { taskId: TASK_ID, attempt: 2 },
    }],
    ['legacy payload', { taskId: TASK_ID, attempt: 1 }],
    ['extra wrapper key', {
      schemaVersion: 1,
      occurrenceId: OCCURRENCE_ID,
      job: { taskId: TASK_ID, attempt: 1 },
      raw: 'not-authority',
    }],
    ['extra job key', {
      schemaVersion: 1,
      occurrenceId: OCCURRENCE_ID,
      job: { taskId: TASK_ID, attempt: 1, prompt: 'not-authority' },
    }],
    ['malformed occurrence', {
      schemaVersion: 1,
      occurrenceId: 'not-a-uuid',
      job: { taskId: TASK_ID, attempt: 1 },
    }],
  ])('refuses adoption for a %s', async (_label, priorPayload) => {
    const transaction = transactionWithRunningAttempts([{
      id: '44444444-4444-4444-8444-444444444444',
      jobPayload: priorPayload,
    }])

    await expect(startTaskAttempt({
      attemptNumber: 1,
      jobPayload: { taskId: TASK_ID, attempt: 1 },
      occurrenceId: OCCURRENCE_ID,
      queueName: 'tasks',
      taskId: TASK_ID,
      workerId: 'worker-b',
    })).resolves.toEqual(expect.objectContaining({ recoveredOccurrence: false }))

    expect(transaction.update).not.toHaveBeenCalled()
  })

  it('refuses approval adoption when the same occurrence carries a different action', async () => {
    const transaction = transactionWithRunningAttempts([{
      id: '44444444-4444-4444-8444-444444444444',
      jobPayload: {
        schemaVersion: 1,
        occurrenceId: OCCURRENCE_ID,
        job: { taskId: TASK_ID, action: 'reject', attempt: 1 },
      },
    }])

    await expect(startTaskAttempt({
      attemptNumber: 1,
      jobPayload: { taskId: TASK_ID, action: 'approve', attempt: 1 },
      occurrenceId: OCCURRENCE_ID,
      queueName: 'approvals',
      taskId: TASK_ID,
      workerId: 'worker-b',
    })).resolves.toEqual(expect.objectContaining({ recoveredOccurrence: false }))

    expect(transaction.update).not.toHaveBeenCalled()
  })

  it('keeps friendly worker context on finished attempts', async () => {
    const update = chain([{
      attemptNumber: 2,
      queueName: 'answers',
      taskId: 'task-1',
      workerId: 'embedded-20008-mr48e1f1',
    }])
    mocks.dbUpdate.mockReturnValueOnce(update)

    await finishTaskAttempt({
      attemptId: 'attempt-1',
      errorMessage: 'replan failed',
      status: 'failed',
    })

    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: 'replan failed' }))

    expect(mocks.recordTaskLogBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'queue.attempt.failed',
      message: 'Forge Answers Worker finished answers attempt 2 as failed: legacy_task_log_unavailable',
      metadata: expect.objectContaining({
        workerName: 'Forge Answers Worker',
        workerRole: expect.stringContaining('follow-up questions'),
      }),
    }))
  })

  it('records retry uncertainty as a terminal warning without exposing retained diagnostics', async () => {
    const retainedError = 'retry failed with prompt=/private/repo token=secret-value'
    const update = chain([{
      attemptNumber: 3,
      queueName: 'tasks',
      taskId: 'task-1',
      workerId: 'standalone-20008-mr48e1f1',
    }])
    mocks.dbUpdate.mockReturnValueOnce(update)

    await finishTaskAttempt({
      attemptId: 'attempt-indeterminate',
      errorMessage: retainedError,
      nextRetryAt: null,
      status: 'indeterminate',
    })

    expect(update.set).toHaveBeenCalledWith({
      completedAt: expect.any(Date),
      errorMessage: retainedError,
      nextRetryAt: null,
      status: 'indeterminate',
    })
    expect(mocks.recordTaskLogBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'queue.attempt.indeterminate',
      level: 'warning',
      message: 'Forge Task Worker finished tasks attempt 3 as Retry status unknown: legacy_task_log_unavailable',
      metadata: {
        attemptNumber: 3,
        nextRetryAt: null,
        queueName: 'tasks',
        status: 'indeterminate',
        workerId: 'standalone-20008-mr48e1f1',
        workerName: 'Forge Task Worker',
        workerRole: expect.stringContaining('Architect planning'),
      },
      taskAttemptId: 'attempt-indeterminate',
      title: 'Retry status unknown',
    }))
    const projectedLog = JSON.stringify(mocks.recordTaskLogBestEffort.mock.calls)
    expect(projectedLog).not.toContain('/private/repo')
    expect(projectedLog).not.toContain('secret-value')
  })

  it('describes approval workers by their handoff role', () => {
    expect(describeQueueWorker('approvals')).toMatchObject({
      name: 'Forge Approval Worker',
      role: expect.stringContaining('handoff'),
    })
  })
})
