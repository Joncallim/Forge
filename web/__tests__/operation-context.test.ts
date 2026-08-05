import { describe, expect, it, vi } from 'vitest'

import { loadTrustedOperationContextForTest } from '@/worker/operations/context'

const taskId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const workPackageId = '33333333-3333-4333-8333-333333333333'

function joined(overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    taskStatus: 'approved',
    taskUpdatedAt: new Date('2026-08-06T00:00:00.000Z'),
    projectId,
    localPath: '/uncanonical/project',
    grantDecisionRevision: BigInt(1),
    rootBindingRevision: BigInt(12),
    projectUpdatedAt: new Date('2026-08-06T00:00:00.000Z'),
    projectMcpConfig: { profile: 'default', requiredMcps: [], overrides: {} },
    ...overrides,
  }
}

function approvedAllowOnceMetadata() {
  return {
    mcpGrantPhases: {
      effective: {
        schemaVersion: 2,
        phase: 'effective',
        source: 'explicit-grant-approval',
        grantMode: 'allow_once',
        runtimeIssued: false,
        runtimeEnforcement: 'bounded_context_packet',
        status: 'approved',
        grantDecisionRevision: '1',
        rootBindingRevision: '12',
        grants: [{ mcpId: 'filesystem', status: 'approved', capabilities: ['filesystem.project.read'] }],
      },
    },
  }
}

function approvedAlwaysAllowMetadata() {
  return {
    mcpGrantPhases: {
      effective: {
        schemaVersion: 2,
        phase: 'effective',
        source: 'project-filesystem-approval',
        runtimeEnforcement: 'bounded_context_packet',
        status: 'approved',
        grantDecisionRevision: '1',
        rootBindingRevision: '12',
        grants: [{ mcpId: 'filesystem', status: 'approved', capabilities: ['filesystem.project.read'] }],
      },
    },
  }
}

function approvedProjectDecision() {
  return {
    schemaVersion: 2,
    decisionId: 'decision-1',
    projectId,
    decision: 'approved',
    capabilities: ['filesystem.project.read'],
    grantDecisionRevision: '1',
    rootBindingRevision: '12',
    decisionFingerprint: `sha256:${'a'.repeat(64)}`,
    decisionGeneration: '1',
    decidedAt: '2026-08-06T00:00:00.000Z',
    decidedBy: 'user-1',
    reason: 'Approved project read authority.',
    revocationReason: null,
  }
}

describe('trusted operation context loader', () => {
  it('derives repository policy from the authoritative active task and linked package grant', async () => {
    const canonicalizeProjectRoot = vi.fn(async () => '/workspace/projects/forge')
    const context = await loadTrustedOperationContextForTest({
      taskId,
      attemptKey: 'attempt-1',
      workPackageId,
    }, {
      loadTaskProject: vi.fn(async () => joined()),
      canonicalizeProjectRoot,
      loadLinkedIds: vi.fn(async () => ({
        workPackageId,
        workPackageMetadata: approvedAlwaysAllowMetadata(),
        workPackageUpdatedAt: new Date('2026-08-06T00:00:01.000Z'),
        agentRunId: null,
        taskAttemptId: null,
      })),
      loadProjectFilesystemDecision: vi.fn(async () => approvedProjectDecision()),
    })

    expect(canonicalizeProjectRoot).toHaveBeenCalledWith({ id: projectId, localPath: '/uncanonical/project' })
    expect(context).toMatchObject({
      taskId,
      projectId,
      projectRoot: '/workspace/projects/forge',
      rootBindingRevision: '12',
      projectRevision: '2026-08-06T00:00:00.000Z',
      policy: {
        projectId,
        scopedProjectId: projectId,
        allowedCapabilities: ['filesystem.project.read'],
        policyCeilings: { repository_read: true },
      },
    })
    expect(context.policy.policyVersion).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not grant repository operations from an unconsumed allow-once grant', async () => {
    const context = await loadTrustedOperationContextForTest({ taskId, attemptKey: 'attempt-1', workPackageId }, {
      loadTaskProject: vi.fn(async () => joined()),
      canonicalizeProjectRoot: vi.fn(async () => '/workspace/projects/forge'),
      loadLinkedIds: vi.fn(async () => ({
        workPackageId,
        workPackageMetadata: approvedAllowOnceMetadata(),
        workPackageUpdatedAt: new Date('2026-08-06T00:00:01.000Z'),
        agentRunId: null,
        taskAttemptId: null,
      })),
    })
    expect(context.policy).toMatchObject({
      allowedCapabilities: [],
      policyCeilings: { repository_read: false },
    })
  })

  it('does not grant repository reads without an authoritative linked package', async () => {
    const canonicalizeProjectRoot = vi.fn()
    const context = await loadTrustedOperationContextForTest({ taskId, attemptKey: 'attempt-1' }, {
      loadTaskProject: vi.fn(async () => joined({ localPath: null, rootBindingRevision: BigInt(0) })),
      canonicalizeProjectRoot,
    })
    expect(context.projectRoot).toBeNull()
    expect(context.policy).toMatchObject({ allowedCapabilities: [], policyCeilings: { repository_read: false } })
    expect(canonicalizeProjectRoot).not.toHaveBeenCalled()
  })

  it('rejects inactive tasks, mismatched joins, and unrelated run links', async () => {
    const canonicalizeProjectRoot = vi.fn()
    await expect(loadTrustedOperationContextForTest({ taskId, attemptKey: 'attempt-1' }, {
      loadTaskProject: vi.fn(async () => joined({ taskStatus: 'completed' })),
      canonicalizeProjectRoot,
    })).rejects.toThrow('approved or running')

    await expect(loadTrustedOperationContextForTest({ taskId, attemptKey: 'attempt-1' }, {
      loadTaskProject: vi.fn(async () => joined({ taskId: '44444444-4444-4444-8444-444444444444' })),
      canonicalizeProjectRoot,
    })).rejects.toThrow('could not be resolved')

    await expect(loadTrustedOperationContextForTest({ taskId, attemptKey: 'attempt-1', workPackageId }, {
      loadTaskProject: vi.fn(async () => joined({ localPath: null })),
      canonicalizeProjectRoot,
      loadLinkedIds: vi.fn(async () => null),
    })).rejects.toThrow('do not belong')
  })

  it('changes authoritative policyVersion when task or package revision changes', async () => {
    const load = (taskUpdatedAt: string, packageUpdatedAt: string) => loadTrustedOperationContextForTest({
      taskId,
      attemptKey: 'attempt-1',
      workPackageId,
    }, {
      loadTaskProject: vi.fn(async () => joined({ taskUpdatedAt: new Date(taskUpdatedAt) })),
      canonicalizeProjectRoot: vi.fn(async () => '/workspace/projects/forge'),
      loadLinkedIds: vi.fn(async () => ({
        workPackageId,
        workPackageMetadata: approvedAlwaysAllowMetadata(),
        workPackageUpdatedAt: new Date(packageUpdatedAt),
        agentRunId: null,
        taskAttemptId: null,
      })),
      loadProjectFilesystemDecision: vi.fn(async () => approvedProjectDecision()),
    })
    const baseline = await load('2026-08-06T00:00:00.000Z', '2026-08-06T00:00:01.000Z')
    const taskChanged = await load('2026-08-06T00:00:02.000Z', '2026-08-06T00:00:01.000Z')
    const packageChanged = await load('2026-08-06T00:00:00.000Z', '2026-08-06T00:00:03.000Z')
    expect(taskChanged.policy.policyVersion).not.toBe(baseline.policy.policyVersion)
    expect(packageChanged.policy.policyVersion).not.toBe(baseline.policy.policyVersion)
  })
})
