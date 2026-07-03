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
  normalizeSecurityReviewPayload,
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

function noFindingsSecurityReview() {
  return {
    schemaVersion: 1,
    findings: [],
    noFindings: {
      reviewSurface: 'Backend package sandbox execution',
      evidenceRefs: ['artifact-1'],
      verificationState: 'Reviewed sandbox metadata and no host repository writes were present.',
    },
  }
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

  it('flags security-sensitive wording including plurals and derivatives', () => {
    for (const text of [
      'Store user credentials securely',
      'Rotate API secrets',
      'Validate JWT tokens',
      'Implement OAuth authentication',
      'Read filesystem files',
      'Guard against command injection',
      'Mitigate prompt-injection in context packets',
      'Control repository-write permission requests',
      'Review tool-permission escalation',
      'Audit MCP tool grants',
      'Protect data-privacy and PII exports',
    ]) {
      expect(isHighRiskImplementationPackage({ assignedRole: 'backend', title: text })).toBe(true)
    }
  })

  it('flags documented high-risk required capabilities for security review', () => {
    for (const capability of [
      'prompt-injection',
      'repository-write',
      'tool-permission',
      'mcp-grants',
      'data-privacy',
    ]) {
      expect(isHighRiskImplementationPackage({
        assignedRole: 'backend',
        requiredCapabilities: { required: [capability] },
        title: 'Backend package',
      })).toBe(true)
    }
  })

  it('does not flag benign packages that merely mention git/UI vocabulary', () => {
    for (const text of [
      'Implement merge sort',
      'Render diff view of changes',
      'Add a command to the CLI',
      'Create a PR template',
      'Commit message preview component',
      'Render the task list and empty state',
    ]) {
      expect(isHighRiskImplementationPackage({ assignedRole: 'frontend', title: text })).toBe(false)
    }
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

  it('refuses to materialize review gates when the source run no longer owns the execution lease', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      metadata: {
        executionLease: {
          acquiredAt: '2026-06-25T00:00:00.000Z',
          attemptNumber: 1,
          heartbeatAt: '2026-06-25T00:00:00.000Z',
          runId: 'newer-run',
        },
      },
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([])
    const gateInsert = vi.fn()
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn().mockReturnValue(packageUpdate),
        select: vi.fn().mockReturnValue(chain([])),
        insert: gateInsert,
      }),
    )

    const result = await materializeReviewGatesForWorkPackageCompletion({
      completeSourceRun: {
        artifactType: 'log_output',
        completedAt: new Date('2026-06-25T00:01:00.000Z'),
        content: 'stale output',
        metadata: { source: 'work-package-executor' },
      },
      requireExecutionLease: true,
      sourceAgentRunId: 'stale-run',
      sourceArtifactId: null,
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toEqual({ status: 'not_owned', packageStatus: null, createdGates: [] })
    expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'awaiting_review',
    }))
    expect(gateInsert).not.toHaveBeenCalled()
    expect(mocks.publishTaskEvent).not.toHaveBeenCalledWith(
      'task-1',
      'approval_gate:created',
      expect.anything(),
    )
  })

  it('rolls back materialization when package ownership is lost after the package update', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      metadata: {
        executionLease: {
          acquiredAt: '2026-06-25T00:00:00.000Z',
          attemptNumber: 1,
          heartbeatAt: '2026-06-25T00:00:00.000Z',
          runId: 'run-1',
        },
      },
      reviewRequirement: 'qa_only',
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    const runCompleteUpdate = updateChain([])
    const txInsert = vi.fn()
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn()
          .mockReturnValueOnce(packageUpdate)
          .mockReturnValueOnce(runCompleteUpdate),
        select: vi.fn().mockReturnValue(chain([])),
        insert: txInsert,
      }),
    )

    const result = await materializeReviewGatesForWorkPackageCompletion({
      completeSourceRun: {
        artifactType: 'log_output',
        completedAt: new Date('2026-06-25T00:01:00.000Z'),
        content: 'final output',
        metadata: { source: 'work-package-executor' },
      },
      requireExecutionLease: true,
      sourceAgentRunId: 'run-1',
      sourceArtifactId: null,
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toEqual({ status: 'not_owned', packageStatus: null, createdGates: [] })
    expect(txInsert).not.toHaveBeenCalled()
    expect(mocks.publishTaskEvent).not.toHaveBeenCalled()
  })

  it('completes the source run and creates the source artifact inside the guarded materialization transaction', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      metadata: {
        executionLease: {
          acquiredAt: '2026-06-25T00:00:00.000Z',
          attemptNumber: 1,
          heartbeatAt: '2026-06-25T00:00:00.000Z',
          runId: 'run-1',
        },
      },
      reviewRequirement: 'qa_only',
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
    }]))
    const packageUpdate = updateChain([{ id: 'pkg-1' }])
    const runCompleteUpdate = updateChain([{ id: 'run-1' }])
    const sourceArtifactInsert = insertChain([{
      id: 'artifact-1',
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'final output',
      metadata: { source: 'work-package-executor' },
      createdAt: new Date('2026-06-25T00:01:00.000Z'),
    }])
    const qaGateInsert = insertChain([{ id: 'gate-qa', gateType: 'qa_review', title: 'QA review: Backend package' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        update: vi.fn()
          .mockReturnValueOnce(packageUpdate)
          .mockReturnValueOnce(runCompleteUpdate),
        select: vi.fn().mockReturnValue(chain([])),
        insert: vi.fn()
          .mockReturnValueOnce(sourceArtifactInsert)
          .mockReturnValueOnce(qaGateInsert),
      }),
    )

    const completedAt = new Date('2026-06-25T00:01:00.000Z')
    const result = await materializeReviewGatesForWorkPackageCompletion({
      completeSourceRun: {
        artifactType: 'log_output',
        completedAt,
        content: 'final output',
        metadata: { source: 'work-package-executor' },
      },
      requireExecutionLease: true,
      sourceAgentRunId: 'run-1',
      sourceArtifactId: null,
      taskId: 'task-1',
      workPackageId: 'pkg-1',
    })

    expect(result).toMatchObject({
      status: 'materialized',
      packageStatus: 'awaiting_review',
      sourceArtifact: { id: 'artifact-1', agentRunId: 'run-1' },
      createdGates: [{ id: 'gate-qa', gateType: 'qa_review', requiredRole: 'qa' }],
    })
    expect(runCompleteUpdate.set).toHaveBeenCalledWith({
      completedAt,
      status: 'completed',
    })
    expect(sourceArtifactInsert.values).toHaveBeenCalledWith({
      agentRunId: 'run-1',
      artifactType: 'log_output',
      content: 'final output',
      metadata: { source: 'work-package-executor' },
    })
    expect(qaGateInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      gateType: 'qa_review',
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      workPackageId: 'pkg-1',
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

  it('keeps materialization successful when post-commit event publishing fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
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
    mocks.publishTaskEvent.mockRejectedValueOnce(new Error('redis down'))

    try {
      const result = await materializeReviewGatesForWorkPackageCompletion({
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        taskId: 'task-1',
        workPackageId: 'pkg-1',
      })

      expect(result).toMatchObject({
        status: 'materialized',
        packageStatus: 'awaiting_review',
        createdGates: [{ id: 'gate-qa', gateType: 'qa_review' }],
      })
    } finally {
      warn.mockRestore()
    }
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
      createdGates: [{ id: 'gate-security', gateType: 'security_review', requiredRole: 'security' }],
    })
    expect(securityGateInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      gateType: 'security_review',
      instructions: expect.stringMatching(/security review/i),
      metadata: expect.objectContaining({ requiredRole: 'security' }),
    }))
  })

  it.each([
    ['prompt-injection wording', { steps: ['Mitigate prompt-injection in executable context packets.'], requiredCapabilities: {} }],
    ['repository-write required capability', { steps: ['Implement the worker handoff path.'], requiredCapabilities: { required: ['repository-write'] } }],
    ['tool-permission required capability', { steps: ['Implement the worker handoff path.'], requiredCapabilities: { required: ['tool-permission'] } }],
  ])('materializes a security review gate for %s', async (_label, packageRiskFields) => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'pkg-1',
      assignedRole: 'backend',
      mcpRequirements: [],
      metadata: {},
      reviewRequirement: 'none',
      status: 'running',
      taskId: 'task-1',
      title: 'Backend package',
      ...packageRiskFields,
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
      createdGates: [{ id: 'gate-security', gateType: 'security_review', requiredRole: 'security' }],
    })
    expect(securityGateInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      gateType: 'security_review',
      sourceArtifactId: 'artifact-1',
      metadata: expect.objectContaining({ requiredRole: 'security' }),
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

  it('fails the task when a work package is terminally failed instead of hanging', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([
      { id: 'pkg-1', status: 'completed' },
      { id: 'pkg-2', status: 'failed' },
    ]))
    mocks.updateTaskStatusIfCurrent.mockResolvedValueOnce(true)

    const result = await completeTaskIfReviewGatesSatisfied('task-1')

    expect(result).toMatchObject({ status: 'failed' })
    expect(mocks.updateTaskStatusIfCurrent).toHaveBeenCalledWith(
      'task-1',
      'running',
      'failed',
      expect.stringContaining('failed'),
    )
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

  it('keeps a gate decision successful when post-commit event publishing fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
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
    mocks.publishTaskEvent.mockRejectedValueOnce(new Error('redis down'))
    mocks.updateTaskStatusIfCurrent.mockResolvedValue(true)

    try {
      const result = await decideReviewGate({
        decision: 'completed',
        gateId: 'gate-qa',
        reason: 'All good.',
        sourceArtifactId: 'artifact-1',
        taskId: 'task-1',
        userId: 'user-1',
      })

      expect(result).toMatchObject({ status: 'decided', decision: 'completed' })
    } finally {
      warn.mockRestore()
    }
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

  it('rejects review decisions when a newer package run has produced artifacts', async () => {
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
      .mockReturnValueOnce(chain([{ id: 'artifact-new', agentRunId: 'run-2' }]))

    const result = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-reviewer',
      reason: 'Looks good.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({
      status: 'source_artifact_mismatch',
      message: expect.stringMatching(/stale/i),
    })
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
  })

  it('completes a security-review-only high-risk package after security approval', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'gate-security',
        gateType: 'security_review',
        metadata: {},
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        status: 'pending',
        workPackageId: 'pkg-1',
      }]))
      .mockReturnValueOnce(chain([{
        assignedRole: 'backend',
        id: 'pkg-1',
        mcpRequirements: [{ mcpId: 'github', requirement: 'required' }],
        metadata: {},
        requiredCapabilities: {},
        reviewRequirement: 'none',
        status: 'awaiting_review',
        steps: ['Inspect GitHub issue context.'],
        taskId: 'task-1',
        title: 'Backend package',
      }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', agentRunId: 'run-1' }]))
      .mockReturnValueOnce(chain([{ id: 'pkg-1', status: 'completed' }]))
      .mockReturnValueOnce(chain([
        { id: 'gate-security', gateType: 'security_review', status: 'completed', workPackageId: 'pkg-1', createdAt: new Date() },
      ]))
    const securityGateUpdate = updateChain([{ id: 'gate-security' }])
    const packageCompleteUpdate = updateChain([{ id: 'pkg-1' }])
    mocks.dbTransaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: vi.fn().mockReturnValue(chain([
          { gateType: 'security_review', status: 'completed', createdAt: new Date() },
        ])),
        update: vi.fn()
          .mockReturnValueOnce(securityGateUpdate)
          .mockReturnValueOnce(packageCompleteUpdate),
      }),
    )
    mocks.updateTaskStatusIfCurrent.mockResolvedValue(true)

    const result = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-security',
      reason: 'Security review passed.',
      securityReview: noFindingsSecurityReview(),
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({
      decision: 'completed',
      gateType: 'security_review',
      packageStatus: 'completed',
      status: 'decided',
      taskCompleted: true,
    })
    expect(packageCompleteUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
    expect(securityGateUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        securityReview: expect.objectContaining({
          noFindings: expect.objectContaining({ reviewSurface: 'Backend package sandbox execution' }),
          reviewedSource: {
            agentRunId: 'run-1',
            artifactId: 'artifact-1',
            workPackageId: 'pkg-1',
          },
          schemaVersion: 1,
        }),
      }),
    }))
  })

  it('rejects security-review completion without structured findings or no-findings payload', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'gate-security',
      gateType: 'security_review',
      metadata: {},
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      status: 'pending',
      workPackageId: 'pkg-1',
    }]))

    const result = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-security',
      reason: 'Security review passed.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({
      status: 'invalid_security_review_payload',
      message: expect.stringMatching(/SecurityFindingV1/i),
    })
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
  })

  it('rejects security-review rework without structured findings or no-findings payload', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'gate-security',
      gateType: 'security_review',
      metadata: {},
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      status: 'pending',
      workPackageId: 'pkg-1',
    }]))

    const result = await decideReviewGate({
      decision: 'needs_rework',
      gateId: 'gate-security',
      reason: 'Security review found issues.',
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({
      status: 'invalid_security_review_payload',
      message: expect.stringMatching(/SecurityFindingV1/i),
    })
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
  })

  it('rejects security-review decisions whose evidence does not include the source artifact', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'gate-security',
      gateType: 'security_review',
      metadata: {},
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      status: 'pending',
      workPackageId: 'pkg-1',
    }]))

    const result = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-security',
      reason: 'Security review passed.',
      securityReview: {
        schemaVersion: 1,
        findings: [],
        noFindings: {
          reviewSurface: 'Backend package sandbox execution',
          evidenceRefs: ['artifact-other'],
          verificationState: 'Reviewed the wrong artifact.',
        },
      },
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({
      status: 'invalid_security_review_payload',
      message: expect.stringMatching(/source artifact/i),
    })
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
  })

  it('rejects security-review approval when structured findings are present', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'gate-security',
      gateType: 'security_review',
      metadata: {},
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      status: 'pending',
      workPackageId: 'pkg-1',
    }]))

    const result = await decideReviewGate({
      decision: 'completed',
      gateId: 'gate-security',
      reason: 'Approving despite findings.',
      securityReview: {
        schemaVersion: 1,
        findings: [{
          reviewSurface: 'Backend package sandbox execution',
          asset: 'web/worker/work-package-executor.ts',
          trustBoundary: 'Model output to sandbox filesystem',
          exploitPath: 'A generated path can escape the sandbox.',
          impact: 'Host files could be overwritten.',
          requiredFix: 'Reject paths outside the sandbox root.',
          evidenceRefs: ['artifact-1'],
          severity: 'high',
          confidence: 'high',
          verificationState: 'Reviewed artifact artifact-1.',
        }],
      },
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({
      status: 'invalid_security_review_payload',
      message: expect.stringMatching(/requesting changes/i),
    })
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
  })

  it('rejects security-review rework when the payload says no findings', async () => {
    mocks.dbSelect.mockReturnValueOnce(chain([{
      id: 'gate-security',
      gateType: 'security_review',
      metadata: {},
      sourceAgentRunId: 'run-1',
      sourceArtifactId: 'artifact-1',
      status: 'pending',
      workPackageId: 'pkg-1',
    }]))

    const result = await decideReviewGate({
      decision: 'needs_rework',
      gateId: 'gate-security',
      reason: 'Needs security changes.',
      securityReview: {
        schemaVersion: 1,
        findings: [],
        noFindings: {
          reviewSurface: 'Backend package sandbox execution',
          evidenceRefs: ['artifact-1'],
          verificationState: 'Reviewed artifact artifact-1 and no findings remain.',
        },
        verdict: 'no_findings',
      },
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({
      status: 'invalid_security_review_payload',
      message: expect.stringMatching(/structured SecurityFindingV1/i),
    })
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
  })

  it('normalizes SecurityFindingV1 payloads and rejects legacy unstructured findings', () => {
    const structuredFinding = {
      reviewSurface: 'Sandbox execution',
      asset: 'web/worker/work-package-executor.ts',
      trustBoundary: 'Model output to sandbox filesystem',
      exploitPath: 'A generated path escapes the attempt directory.',
      impact: 'Host repository files could be overwritten.',
      requiredFix: 'Reject paths that resolve outside the sandbox root.',
      evidenceRefs: [' artifact-1 ', '', 'web/__tests__/work-package-executor.test.ts'],
      severity: 'HIGH',
      confidence: 'Medium',
      verificationState: 'Regression test added.',
    }
    const noFindings = {
      reviewSurface: 'Sandbox execution',
      evidenceRefs: ['artifact-1'],
      verificationState: 'Reviewed artifact artifact-1 and no findings remain.',
    }

    expect(normalizeSecurityReviewPayload({
      schemaVersion: 1,
      findings: [structuredFinding],
    })).toMatchObject({
      findings: [{
        asset: 'web/worker/work-package-executor.ts',
        confidence: 'medium',
        evidenceRefs: ['artifact-1', 'web/__tests__/work-package-executor.test.ts'],
        requiredFix: 'Reject paths that resolve outside the sandbox root.',
        reviewSurface: 'Sandbox execution',
        severity: 'high',
        verificationState: 'Regression test added.',
      }],
      schemaVersion: 1,
      summary: '1 structured security finding recorded.',
      verdict: 'findings',
    })

    expect(normalizeSecurityReviewPayload({
      schemaVersion: 1,
      findings: [{
        file: 'web/app/api/tasks/route.ts',
        recommendation: 'Validate argv before execution.',
        severity: 'high',
        title: 'Unsafe command execution',
      }],
    })).toBeNull()

    expect(normalizeSecurityReviewPayload({
      schemaVersion: 1,
      findings: [structuredFinding, { ...structuredFinding, asset: '' }],
    })).toBeNull()

    expect(normalizeSecurityReviewPayload({
      schemaVersion: 1,
      findings: [structuredFinding],
      noFindings,
    })).toBeNull()

    expect(normalizeSecurityReviewPayload({
      schemaVersion: 1,
      findings: [structuredFinding],
      verdict: 'no_findings',
    })).toBeNull()

    expect(normalizeSecurityReviewPayload({
      schemaVersion: 1,
      findings: [],
      noFindings,
      verdict: 'findings',
    })).toBeNull()

    expect(normalizeSecurityReviewPayload({
      schemaVersion: 1,
      findings: Array.from({ length: 51 }, (_, index) => ({
        ...structuredFinding,
        asset: `web/worker/work-package-executor.ts:${index}`,
      })),
    })).toBeNull()
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

  it('routes a security-reviewed package to rework with stamped structured findings', async () => {
    mocks.dbSelect
      .mockReturnValueOnce(chain([{
        id: 'gate-security',
        gateType: 'security_review',
        metadata: {},
        sourceAgentRunId: 'run-1',
        sourceArtifactId: 'artifact-1',
        status: 'pending',
        workPackageId: 'pkg-1',
      }]))
      .mockReturnValueOnce(chain([{ reviewRequirement: 'none' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1' }]))
      .mockReturnValueOnce(chain([{ id: 'artifact-1', agentRunId: 'run-1' }]))
    const gateUpdate = updateChain([{ id: 'gate-security' }])
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
      gateId: 'gate-security',
      reason: 'Needs security fixes.',
      securityReview: {
        schemaVersion: 1,
        findings: [{
          reviewSurface: 'Backend package sandbox execution',
          asset: 'web/worker/work-package-executor.ts',
          trustBoundary: 'Model output to sandbox filesystem',
          exploitPath: 'A generated path can escape the sandbox.',
          impact: 'Host files could be overwritten.',
          requiredFix: 'Reject paths outside the sandbox root.',
          evidenceRefs: ['artifact-1'],
          severity: 'high',
          confidence: 'high',
          verificationState: 'Reviewed artifact artifact-1.',
        }],
      },
      sourceArtifactId: 'artifact-1',
      taskId: 'task-1',
      userId: 'user-1',
    })

    expect(result).toMatchObject({ status: 'decided', decision: 'needs_rework' })
    expect(gateUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        securityReview: expect.objectContaining({
          findings: [expect.objectContaining({ evidenceRefs: ['artifact-1'] })],
          reviewedSource: {
            agentRunId: 'run-1',
            artifactId: 'artifact-1',
            workPackageId: 'pkg-1',
          },
          verdict: 'findings',
        }),
      }),
    }))
    expect(packageUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'needs_rework' }))
  })
})
