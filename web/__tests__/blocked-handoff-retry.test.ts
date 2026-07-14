import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  redisDel: vi.fn(),
  redisLpush: vi.fn(),
  redisSet: vi.fn(),
}))

vi.mock('@/lib/redis', () => ({
  redis: {
    del: mocks.redisDel,
    lpush: mocks.redisLpush,
    set: mocks.redisSet,
  },
}))

import {
  buildMcpBrokerBlockMetadata,
  enqueueDueBlockedHandoffRetries,
  enqueueBlockedHandoffRetry,
  shouldAutoRetryBlockedHandoff,
} from '@/worker/blocked-handoff-retry'
import { evaluateWorkPackageMcpBroker } from '@/worker/mcp-execution-design'
import type { McpBrokerAdmissionCheck } from '@/lib/mcps/admission'

function brokerCheck(input: {
  blocked: string[]
  blockedReason?: string
  primaryRecoveryAction: 'install_or_fix_mcp' | 'revise_plan'
  retryable: boolean
}): McpBrokerAdmissionCheck {
  return {
    status: 'blocked',
    blocked: input.blocked,
    warnings: [],
    blockedReason: input.blockedReason ?? input.blocked.join('; '),
    retryable: input.retryable,
    primaryMode: 'blocked',
    primaryRecoveryAction: input.primaryRecoveryAction,
    evaluations: [],
    subtaskDecisions: [],
  }
}

describe('blocked handoff retry helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.redisSet.mockResolvedValue('OK')
    mocks.redisLpush.mockResolvedValue(1)
    mocks.redisDel.mockResolvedValue(1)
  })

  it('marks transient broker blocks for bounded auto-retry', () => {
    const blockedAt = new Date('2026-06-29T17:00:00.000Z')
    const metadata = buildMcpBrokerBlockMetadata({
      blockedAt,
      check: brokerCheck({
        blocked: ["MCP 'github' is not configured for this project."],
        blockedReason: 'GitHub missing.',
        primaryRecoveryAction: 'install_or_fix_mcp',
        retryable: true,
      }),
      existingMetadata: { source: 'architect-artifact' },
    })

    expect(metadata).toMatchObject({
      source: 'architect-artifact',
      mcpBroker: {
        schemaVersion: 1,
        autoRetryAttempts: 1,
        blockedReason: 'GitHub missing.',
        mode: 'blocked',
        recoveryAction: 'install_or_fix_mcp',
        retryable: true,
        status: 'blocked',
      },
    })
    expect(shouldAutoRetryBlockedHandoff(metadata, new Date('2026-06-29T17:04:59.000Z'))).toBe(false)
    expect(shouldAutoRetryBlockedHandoff(metadata, new Date('2026-06-29T17:05:00.000Z'))).toBe(true)
  })

  it('persists the canonical mode, recovery action, decisions, and evidence structurally', () => {
    const check = evaluateWorkPackageMcpBroker({
      assignedRole: 'backend',
      mcpRequirements: [
        {
          requirementKey: 'mcp-policy-v1-read-1',
          sourceRequirementIndex: 0,
          agent: 'backend',
          mcpId: 'github',
          requirement: 'required',
          permissions: ['github.issues.read'],
          assignment: { type: 'agent', targetId: null },
          fallback: { action: 'block', message: '' },
        },
        {
          requirementKey: 'mcp-policy-v1-write-1',
          sourceRequirementIndex: 1,
          agent: 'backend',
          mcpId: 'github',
          requirement: 'required',
          permissions: ['github.contents.write'],
          assignment: { type: 'agent', targetId: null },
          fallback: { action: 'block', message: '' },
        },
      ],
      metadata: {
        requirementContexts: [{
          requirementKey: 'mcp-policy-v1-read-1',
          agent: 'backend',
          mcpId: 'github',
          promptOverlay: 'Use the supplied issue context.',
        }],
      },
      title: 'Backend package',
    })

    expect(check.status).toBe('blocked')
    expect(check.primaryRecoveryAction).toBe('revise_plan')
    expect(check.retryable).toBe(false)

    const metadata = buildMcpBrokerBlockMetadata({
      blockedAt: new Date('2026-06-29T17:00:00.000Z'),
      check,
      existingMetadata: {},
    })

    expect(metadata).toMatchObject({
      mcpBroker: {
        schemaVersion: 1,
        status: 'blocked',
        mode: check.primaryMode,
        primaryMode: check.primaryMode,
        recoveryAction: check.primaryRecoveryAction,
        primaryRecoveryAction: check.primaryRecoveryAction,
        primaryDecision: check.primaryDecision,
        retryable: check.retryable,
        decisions: [expect.objectContaining({
          kind: 'requirement',
          requirementKey: 'mcp-policy-v1-read-1',
        }), expect.objectContaining({
          kind: 'requirement',
          requirementKey: 'mcp-policy-v1-write-1',
        })],
        evidence: [expect.objectContaining({
          requirementKey: 'mcp-policy-v1-read-1',
          health: expect.objectContaining({ observed: false, checkedAt: null }),
        }), expect.objectContaining({ requirementKey: 'mcp-policy-v1-write-1' })],
      },
    })
  })

  it('stops auto-retry metadata after the retry budget is exhausted', () => {
    let metadata: unknown = {}
    for (let attempt = 0; attempt < 4; attempt += 1) {
      metadata = buildMcpBrokerBlockMetadata({
        blockedAt: new Date(`2026-06-29T17:0${attempt}:00.000Z`),
        check: brokerCheck({
          blocked: ["MCP 'github' is auth_required/auth_required: Connect GitHub."],
          blockedReason: 'GitHub auth required.',
          primaryRecoveryAction: 'install_or_fix_mcp',
          retryable: true,
        }),
        existingMetadata: metadata,
      })
    }

    expect(metadata).toMatchObject({
      mcpBroker: {
        autoRetryAttempts: 4,
        nextAutoRetryAt: null,
        retryable: true,
      },
    })
    expect(shouldAutoRetryBlockedHandoff(metadata, new Date('2026-06-29T18:00:00.000Z'))).toBe(false)
  })

  it('does not auto-retry permanent policy blocks', () => {
    const metadata = buildMcpBrokerBlockMetadata({
      blockedAt: new Date('2026-06-29T17:00:00.000Z'),
      check: brokerCheck({
        blocked: ["MCP 'github' capability 'github.contents.write' is outside the allowed beta scope."],
        blockedReason: 'Unsafe capability.',
        primaryRecoveryAction: 'revise_plan',
        retryable: false,
      }),
      existingMetadata: {},
    })

    expect(metadata).toMatchObject({
      mcpBroker: {
        autoRetryAttempts: 0,
        nextAutoRetryAt: null,
        retryable: false,
      },
    })
    expect(shouldAutoRetryBlockedHandoff(metadata, new Date('2026-06-29T18:00:00.000Z'))).toBe(false)
  })

  it('refuses to persist metadata for a non-blocked or reasonless canonical check', () => {
    const blockedAt = new Date('2026-06-29T17:00:00.000Z')
    const allowed = {
      ...brokerCheck({ blocked: ['temporary'], primaryRecoveryAction: 'revise_plan', retryable: false }),
      status: 'allowed' as const,
      blocked: [],
      blockedReason: null,
    }
    expect(() => buildMcpBrokerBlockMetadata({
      blockedAt,
      check: allowed,
      existingMetadata: {},
    })).toThrow(/requires a blocked check with a blocked reason/)
  })

  it('dedupes queued retry approval jobs per task', async () => {
    await expect(enqueueBlockedHandoffRetry('task-1', { source: 'test' })).resolves.toEqual({ status: 'enqueued' })
    expect(mocks.redisSet).toHaveBeenCalledWith(
      'forge:blocked-handoff-retry:task-1',
      expect.stringContaining('"source":"test"'),
      'EX',
      60,
      'NX',
    )
    expect(mocks.redisLpush).toHaveBeenCalledWith(
      'forge:approvals',
      JSON.stringify({ taskId: 'task-1', action: 'approve' }),
    )

    mocks.redisSet.mockResolvedValueOnce(null)
    await expect(enqueueBlockedHandoffRetry('task-1', { source: 'test' })).resolves.toEqual({ status: 'already_queued' })
    expect(mocks.redisLpush).toHaveBeenCalledTimes(1)
  })

  it('clears the dedupe marker when enqueueing the approval job fails', async () => {
    mocks.redisLpush.mockRejectedValueOnce(new Error('redis down'))

    await expect(enqueueBlockedHandoffRetry('task-1', { source: 'test' })).rejects.toThrow(/redis down/)
    expect(mocks.redisDel).toHaveBeenCalledWith('forge:blocked-handoff-retry:task-1')
  })

  it('sweep helper enqueues only due retryable blocked handoffs once per task', async () => {
    const now = new Date('2026-06-29T17:10:00.000Z')
    const dueRetryable = buildMcpBrokerBlockMetadata({
      blockedAt: new Date('2026-06-29T17:00:00.000Z'),
      check: brokerCheck({
        blocked: ["MCP 'github' is not configured for this project."],
        blockedReason: 'GitHub missing.',
        primaryRecoveryAction: 'install_or_fix_mcp',
        retryable: true,
      }),
      existingMetadata: {},
    })
    const notDueRetryable = buildMcpBrokerBlockMetadata({
      blockedAt: new Date('2026-06-29T17:09:00.000Z'),
      check: brokerCheck({
        blocked: ["MCP 'github' is auth_required/auth_required: Connect GitHub."],
        blockedReason: 'GitHub auth required.',
        primaryRecoveryAction: 'install_or_fix_mcp',
        retryable: true,
      }),
      existingMetadata: {},
    })
    const permanent = buildMcpBrokerBlockMetadata({
      blockedAt: new Date('2026-06-29T17:00:00.000Z'),
      check: brokerCheck({
        blocked: ["Unknown MCP 'slack' was requested."],
        blockedReason: 'Unknown MCP.',
        primaryRecoveryAction: 'revise_plan',
        retryable: false,
      }),
      existingMetadata: {},
    })
    const enqueue = vi.fn(async () => ({ status: 'enqueued' as const }))

    await expect(enqueueDueBlockedHandoffRetries([
      { taskId: 'task-due', metadata: dueRetryable },
      { taskId: 'task-due', metadata: dueRetryable },
      { taskId: 'task-future', metadata: notDueRetryable },
      { taskId: 'task-permanent', metadata: permanent },
    ], { enqueue, now })).resolves.toBe(1)

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith('task-due', { source: 'blocked-handoff-sweep' })
  })
})
