import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbTransaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  })),
  dbUpdate: vi.fn(),
  publishTaskEvent: vi.fn(),
  updateTaskStatusIfCurrent: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: {
    select: mocks.dbSelect,
    transaction: mocks.dbTransaction,
    update: mocks.dbUpdate,
  },
}))

vi.mock('@/worker/events', () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}))

vi.mock('@/worker/task-state', () => ({
  updateTaskStatusIfCurrent: mocks.updateTaskStatusIfCurrent,
}))

import {
  completeTaskIfReviewGatesSatisfied,
  decideReviewGate,
  isHighRiskImplementationPackage,
  isImplementationPackageRole,
  materializeReviewGatesForWorkPackageCompletion,
} from '@/worker/review-gates'

function chain(resolveValue: unknown) {
  const thenable: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) =>
      Promise.resolve(resolveValue).catch(onRejected),
  }
  const methods = ['from', 'where', 'innerJoin', 'limit', 'orderBy', 'values', 'returning', 'set']
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

describe('review gate contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires review gates for implementation roles only', () => {
    expect(isImplementationPackageRole('backend')).toBe(true)
    expect(isImplementationPackageRole('frontend')).toBe(true)
    expect(isImplementationPackageRole('devops')).toBe(true)
    expect(isImplementationPackageRole('qa')).toBe(false)
    expect(isImplementationPackageRole('reviewer')).toBe(false)
    expect(isImplementationPackageRole('architect')).toBe(false)
    expect(isImplementationPackageRole('security')).toBe(false)
  })

  it('treats unknown roles as implementation roles, but exempt roles stay exempt regardless of casing', () => {
    expect(isImplementationPackageRole('specialist')).toBe(true)
    expect(isImplementationPackageRole('QA')).toBe(false)
    expect(isImplementationPackageRole('  Reviewer  ')).toBe(false)
    expect(isImplementationPackageRole('Security-Review')).toBe(false)
    expect(isImplementationPackageRole('')).toBe(false)
  })

  it('detects high-risk implementation packages but exempts security and normal low-risk packages', () => {
    expect(isHighRiskImplementationPackage({
      assignedRole: 'backend',
      mcpRequirements: [{ mcpId: 'github', requirement: 'required' }],
      title: 'Backend package',
    })).toBe(true)
    expect(isHighRiskImplementationPackage({
      assignedRole: 'backend',
      requiredCapabilities: { required: ['security-review'] },
      title: 'Backend package',
    })).toBe(true)
    expect(isHighRiskImplementationPackage({
      assignedRole: 'frontend',
      steps: ['Render the task list and empty state.'],
      summary: 'Build presentational task list UI.',
      title: 'Frontend package',
    })).toBe(false)
    expect(isHighRiskImplementationPackage({
      assignedRole: 'security',
      steps: ['Review auth tokens and secrets handling.'],
      title: 'Security package',
    })).toBe(false)
  })

  it('materializes QA and Reviewer gates when an implementation package finishes', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    const qaGateInsert = insertChain([{ id: 'gate-qa', gateType: 'qa_review', title: 'QA review: Backend package' }])
    const reviewerGateInsert = insertChain([{ id: 'gate-reviewer', gateType: 'reviewer_review', title: 'Reviewer review: Backend package' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn().mockReturnValue(packageUpdate),
        select: vi.fn().mockReturnValue(chain([])),
        insert: vi.fn()
          .mockReturnValueOnce(qaGateInsert)
          .mockReturnValueOnce(reviewerGateInsert),
      }),
    )

    const result = await materializeReviewGatesForWorkPackageCompletion({
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toMatchObject({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [
        { id: 'gate-qa', gateType: 'qa_review', requiredRole: 'qa' },
        { id: 'gate-reviewer', gateType: 'reviewer_review', requiredRole: 'reviewer' },
      ],
    })
    expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'awaiting_review',
    }))
    expect(qaGateInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      gateType: 'qa_review',
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      workPackageId: 'pkg-1',
    }))
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith('task-1', 'approval_gate:created', expect.objectContaining({
      gateId: 'gate-qa',
      gateType: 'qa_review',
      requiredRole: 'qa',
    }))
  })

  it('completes the package immediately when no review is required', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      reviewRequirement: 'none',
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn().mockReturnValue(packageUpdate),
        select: vi.fn().mockReturnValue(chain([])),
        insert: vi.fn(),
      }),
    )

    const result = await materializeReviewGatesForWorkPackageCompletion({
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toMatchObject({ status: 'not_required', packageStatus: 'completed', createdGates: [] })
    expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('only materializes the QA gate when the package requires qa_only review', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      reviewRequirement: 'qa_only',
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    const qaGateInsert = insertChain([{ id: 'gate-qa', gateType: 'qa_review', title: 'QA review: Backend package' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn().mockReturnValue(packageUpdate),
        select: vi.fn().mockReturnValue(chain([])),
        insert: vi.fn().mockReturnValueOnce(qaGateInsert),
      }),
    )

    const result = await materializeReviewGatesForWorkPackageCompletion({
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toMatchObject({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [{ id: 'gate-qa', gateType: 'qa_review', requiredRole: 'qa' }],
    })
  })

  it('only materializes the Reviewer gate when the package requires reviewer_only review', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      reviewRequirement: 'reviewer_only',
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    const reviewerGateInsert = insertChain([{ id: 'gate-reviewer', gateType: 'reviewer_review', title: 'Reviewer review: Backend package' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn().mockReturnValue(packageUpdate),
        select: vi.fn().mockReturnValue(chain([])),
        insert: vi.fn().mockReturnValueOnce(reviewerGateInsert),
      }),
    )

    const result = await materializeReviewGatesForWorkPackageCompletion({
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toMatchObject({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [{ id: 'gate-reviewer', gateType: 'reviewer_review', requiredRole: 'reviewer' }],
    })
  })

  it('materializes a security review gate for high-risk implementation packages', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      mcpRequirements: [{ mcpId: 'github', requirement: 'required' }],
      metadata: {},
      requiredCapabilities: {},
      reviewRequirement: 'none',
      status: 'running',
      steps: ['Inspect GitHub issue context.'],
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    const securityGateInsert = insertChain([
      { id: 'gate-security', gateType: 'security_review', title: 'Security review: Backend package' },
    ])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn().mockReturnValue(packageUpdate),
        select: vi.fn().mockReturnValue(chain([])),
        insert: vi.fn().mockReturnValueOnce(securityGateInsert),
      }),
    )

    const result = await materializeReviewGatesForWorkPackageCompletion({
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toMatchObject({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      createdGates: [{ id: 'gate-security', gateType: 'security_review', requiredRole: 'reviewer' }],
    })
    expect(securityGateInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      gateType: 'security_review',
      instructions: expect.stringMatching(/security review/i),
      metadata: expect.objectContaining({ requiredRole: 'reviewer' }),
    }))
  })

  it('re-creates a fresh pending gate after a prior rework cycle', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      reviewRequirement: 'qa_only',
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    const staleQaGate = chain([{ gateType: 'qa_review', status: 'needs_rework' }])
    const qaGateInsert = insertChain([{ id: 'gate-qa-2', gateType: 'qa_review', title: 'QA review: Backend package' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn().mockReturnValue(packageUpdate),
        select: vi.fn().mockReturnValue(staleQaGate),
        insert: vi.fn().mockReturnValueOnce(qaGateInsert),
      }),
    )

    const result = await materializeReviewGatesForWorkPackageCompletion({
      sourceAgentRunId: 'run-2',
      sourceArtifactId: 'artifact-2',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toMatchObject({
      status: 'materialized',
      createdGates: [{ id: 'gate-qa-2', gateType: 'qa_review' }],
    })
  })

  it('recreates the QA gate when the only existing one was completed against a stale artifact', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      reviewRequirement: 'both',
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    // QA was completed against the prior artifact ("artifact-1"); reviewer then
    // sent the package back for rework, which only cancels *pending* gates, so
    // this completed QA gate is left behind unchanged.
    const existingGates = chain([
      { gateType: 'qa_review', sourceArtifactId: 'artifact-1', status: 'completed' },
    ])
    const reviewerGateInsert = insertChain([
      { id: 'gate-reviewer-2', gateType: 'reviewer_review', title: 'Reviewer review: Backend package' },
    ])
    const qaGateInsert = insertChain([{ id: 'gate-qa-2', gateType: 'qa_review', title: 'QA review: Backend package' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn().mockReturnValue(packageUpdate),
        select: vi.fn().mockReturnValue(existingGates),
        insert: vi.fn()
          .mockReturnValueOnce(qaGateInsert)
          .mockReturnValueOnce(reviewerGateInsert),
      }),
    )

    const result = await materializeReviewGatesForWorkPackageCompletion({
      sourceAgentRunId: 'run-2',
      sourceArtifactId: 'artifact-2',
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toMatchObject({
      status: 'materialized',
      createdGates: [
        { id: 'gate-qa-2', gateType: 'qa_review' },
        { id: 'gate-reviewer-2', gateType: 'reviewer_review' },
      ],
    })
  })

  it('blocks final task completion while work packages are still awaiting review', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{ id: 'pkg-1', status: 'awaiting_review' }]))

    const result = await completeTaskIfReviewGatesSatisfied('task-1')

    expect(result).toMatchObject({ status: 'blocked' })
    expect(mocks.updateTaskStatusIfCurrent).not.toHaveBeenCalled()
  })

  it('completes the task only after all packages and review gates are completed', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([{ id: 'pkg-1', status: 'completed' }]))
      .mockReturnValueOnce(chain([
        { id: 'gate-qa', gateType: 'qa_review', status: 'completed', workPackageId: 'pkg-1', createdAt: new Date() },
        { id: 'gate-reviewer', gateType: 'reviewer_review', status: 'completed', workPackageId: 'pkg-1', createdAt: new Date() },
      ]))
    mocks.updateTaskStatusIfCurrent.mockResolvedValue(true)

    const result = await completeTaskIfReviewGatesSatisfied('task-1')

    expect(result).toEqual({ status: 'completed' })
    expect(mocks.updateTaskStatusIfCurrent).toHaveBeenCalledWith('task-1', 'running', 'completed')
  })

  it('ignores a stale cancelled gate from an earlier rework cycle when the latest attempt is completed', async () => {
    const olderCreatedAt = new Date('2024-01-01T00:00:00Z')
    const newerCreatedAt = new Date('2024-01-02T00:00:00Z')
    mocks.dbSelect
      .mockReturnValueOnce(chain([{ id: 'pkg-1', status: 'completed' }]))
      .mockReturnValueOnce(chain([
        // Latest attempt: QA approved the reworked artifact.
        { id: 'gate-qa-2', gateType: 'qa_review', status: 'completed', workPackageId: 'pkg-1', createdAt: newerCreatedAt },
        // Stale attempt: cancelled when the package was sent back for rework.
        { id: 'gate-qa-1', gateType: 'qa_review', status: 'cancelled', workPackageId: 'pkg-1', createdAt: olderCreatedAt },
        { id: 'gate-reviewer-1', gateType: 'reviewer_review', status: 'completed', workPackageId: 'pkg-1', createdAt: newerCreatedAt },
      ]))
    mocks.updateTaskStatusIfCurrent.mockResolvedValue(true)

    const result = await completeTaskIfReviewGatesSatisfied('task-1')

    expect(result).toEqual({ status: 'completed' })
    expect(mocks.updateTaskStatusIfCurrent).toHaveBeenCalledWith('task-1', 'running', 'completed')
  })

  it('blocks reviewer completion until QA is completed', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'gate-reviewer',
        gateType: 'reviewer_review',
        metadata: {},
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        status: 'pending',
        workPackageId: 'pkg-1',
      }]))
      .mockReturnValueOnce(chain([{ reviewRequirement: 'both' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', agentRunId: 'run-1' }]))
      .mockReturnValueOnce(chain([{ status: 'pending' }]))

    const result = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-reviewer',
      reason: 'Looks good.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({
      status: 'reviewer_blocked',
    })
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
  })

  it('completes a qa_only package once the single QA gate is approved', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'gate-qa',
        gateType: 'qa_review',
        metadata: {},
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        status: 'pending',
        workPackageId: 'pkg-1',
      }]))
      .mockReturnValueOnce(chain([{ reviewRequirement: 'qa_only' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', agentRunId: 'run-1' }]))
      .mockReturnValueOnce(chain([{ id: 'pkg-1', status: 'completed' }]))
      .mockReturnValueOnce(chain([
        { id: 'gate-qa', gateType: 'qa_review', status: 'completed', workPackageId: 'pkg-1', createdAt: new Date() },
      ]))
    const gateUpdate = updateChain([{ id: 'gate-qa' }])
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: vi.fn().mockReturnValue(chain([
          { id: 'gate-qa', gateType: 'qa_review', status: 'completed', createdAt: new Date() },
        ])),
        update: vi.fn()
          .mockReturnValueOnce(gateUpdate)
          .mockReturnValueOnce(packageUpdate),
      }),
    )
    mocks.updateTaskStatusIfCurrent.mockResolvedValue(true)

    const result = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-qa',
      reason: 'All good.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({ status: 'decided', decision: 'completed' })
  })

  it('completes a reviewer_only package without ever checking for a QA gate', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'gate-reviewer',
        gateType: 'reviewer_review',
        metadata: {},
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        status: 'pending',
        workPackageId: 'pkg-1',
      }]))
      .mockReturnValueOnce(chain([{ reviewRequirement: 'reviewer_only' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', agentRunId: 'run-1' }]))
      .mockReturnValueOnce(chain([{ id: 'pkg-1', status: 'completed' }]))
      .mockReturnValueOnce(chain([
        { id: 'gate-reviewer', gateType: 'reviewer_review', status: 'completed', workPackageId: 'pkg-1', createdAt: new Date() },
      ]))
    const gateUpdate = updateChain([{ id: 'gate-reviewer' }])
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: vi.fn().mockReturnValue(chain([
          { gateType: 'reviewer_review', status: 'completed', createdAt: new Date() },
        ])),
        update: vi.fn()
          .mockReturnValueOnce(gateUpdate)
          .mockReturnValueOnce(packageUpdate),
      }),
    )
    mocks.updateTaskStatusIfCurrent.mockResolvedValue(true)

    const result = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-reviewer',
      reason: 'Looks good.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({ status: 'decided', decision: 'completed' })
    // dbSelect is called 6 times: gate, reviewRequirement, sourceArtifact,
    // latest package artifact, then
    // completeTaskIfReviewGatesSatisfied's package list + gate list. No QA-blocks-
    // reviewer lookup happens for reviewer_only.
    expect(mocks.dbSelect).toHaveBeenCalledTimes(6)
  })

  it('completes a both-review package only after QA approves first and then Reviewer approves', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'gate-qa',
        gateType: 'qa_review',
        metadata: {},
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        status: 'pending',
        workPackageId: 'pkg-1',
      }]))
      .mockReturnValueOnce(chain([{ reviewRequirement: 'both' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', agentRunId: 'run-1' }]))
    const qaGateUpdate = updateChain([{ id: 'gate-qa' }])
    const qaPackageUpdateAttempt = updateChain([{ id: 'pkg-1' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: vi.fn().mockReturnValue(chain([
          { gateType: 'qa_review', status: 'completed', createdAt: new Date() },
          { gateType: 'reviewer_review', status: 'pending', createdAt: new Date() },
        ])),
        update: vi.fn()
          .mockReturnValueOnce(qaGateUpdate)
          .mockReturnValueOnce(qaPackageUpdateAttempt),
      }),
    )

    const qaResult = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-qa',
      reason: 'QA passed.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(qaResult).toMatchObject({ status: 'decided', decision: 'completed' })
    // Reviewer gate is still pending, so the package must not be marked completed yet.
    expect(qaPackageUpdateAttempt.set).not.toHaveBeenCalled()

    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'gate-reviewer',
        gateType: 'reviewer_review',
        metadata: {},
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        status: 'pending',
        workPackageId: 'pkg-1',
      }]))
      .mockReturnValueOnce(chain([{ reviewRequirement: 'both' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', agentRunId: 'run-1' }]))
      .mockReturnValueOnce(chain([{ status: 'completed' }]))
      .mockReturnValueOnce(chain([{ id: 'pkg-1', status: 'completed' }]))
      .mockReturnValueOnce(chain([
        { id: 'gate-qa', gateType: 'qa_review', status: 'completed', workPackageId: 'pkg-1', createdAt: new Date() },
        { id: 'gate-reviewer', gateType: 'reviewer_review', status: 'completed', workPackageId: 'pkg-1', createdAt: new Date() },
      ]))
    const reviewerGateUpdate = updateChain([{ id: 'gate-reviewer' }])
    const packageCompleteUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: vi.fn().mockReturnValue(chain([
          { gateType: 'qa_review', status: 'completed', createdAt: new Date() },
          { gateType: 'reviewer_review', status: 'completed', createdAt: new Date() },
        ])),
        update: vi.fn()
          .mockReturnValueOnce(reviewerGateUpdate)
          .mockReturnValueOnce(packageCompleteUpdate),
      }),
    )
    mocks.updateTaskStatusIfCurrent.mockResolvedValue(true)

    const reviewerResult = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-reviewer',
      reason: 'Reviewer approved.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(reviewerResult).toMatchObject({ status: 'decided', decision: 'completed' })
    expect(packageCompleteUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('defaults to requiring both gates when the work package row cannot be found', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'gate-reviewer',
        gateType: 'reviewer_review',
        metadata: {},
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        status: 'pending',
        workPackageId: 'pkg-1',
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', agentRunId: 'run-1' }]))
      .mockReturnValueOnce(chain([{ status: 'pending' }]))

    const result = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-reviewer',
      reason: 'Looks good.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({ status: 'reviewer_blocked' })
  })

  it('routes a package to rework and cancels the other pending gate', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'gate-qa',
        gateType: 'qa_review',
        metadata: {},
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        status: 'pending',
        workPackageId: 'pkg-1',
      }]))
      .mockReturnValueOnce(chain([{ reviewRequirement: 'both' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', agentRunId: 'run-1' }]))
    const gateUpdate = updateChain([{ id: 'gate-qa' }])
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    const cancelledUpdate = updateChain([{ id: 'gate-reviewer' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: vi.fn(),
        update: vi.fn()
          .mockReturnValueOnce(gateUpdate)
          .mockReturnValueOnce(packageUpdate)
          .mockReturnValueOnce(cancelledUpdate),
      }),
    )

    const result = await decideReviewGate({
      decision: 'needs_rework',
      gateId: 'gate-qa',
      reason: 'Needs fixes.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({ status: 'decided', decision: 'needs_rework' })
    expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs_rework' }))
  })
})
