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
      blocked: ["MCP 'github' is not configured for this project."],
      blockedAt,
      blockedReason: 'GitHub missing.',
      existingMetadata: { source: 'architect-artifact' },
      retryable: true,
      warnings: [],
    })

    expect(metadata).toMatchObject({
      source: 'architect-artifact',
      mcpBroker: {
        autoRetryAttempts: 1,
        blockedReason: 'GitHub missing.',
        retryable: true,
        status: 'blocked',
      },
    })
    expect(shouldAutoRetryBlockedHandoff(metadata, new Date('2026-06-29T17:04:59.000Z'))).toBe(false)
    expect(shouldAutoRetryBlockedHandoff(metadata, new Date('2026-06-29T17:05:00.000Z'))).toBe(true)
  })

  it('stops auto-retry metadata after the retry budget is exhausted', () => {
    let metadata: unknown = {}
    for (let attempt = 0; attempt < 4; attempt += 1) {
      metadata = buildMcpBrokerBlockMetadata({
        blocked: ["MCP 'github' is auth_required/auth_required: Connect GitHub."],
        blockedAt: new Date(`2026-06-29T17:0${attempt}:00.000Z`),
        blockedReason: 'GitHub auth required.',
        existingMetadata: metadata,
        retryable: true,
        warnings: [],
      })
    }

    expect(metadata).toMatchObject({
      mcpBroker: {
        autoRetryAttempts: 4,
        nextAutoRetryAt: null,
        retryable: false,
      },
    })
    expect(shouldAutoRetryBlockedHandoff(metadata, new Date('2026-06-29T18:00:00.000Z'))).toBe(false)
  })

  it('does not auto-retry permanent policy blocks', () => {
    const metadata = buildMcpBrokerBlockMetadata({
      blocked: ["MCP 'github' capability 'github.contents.write' is outside the allowed beta scope."],
      blockedAt: new Date('2026-06-29T17:00:00.000Z'),
      blockedReason: 'Unsafe capability.',
      existingMetadata: {},
      retryable: false,
      warnings: [],
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
      blocked: ["MCP 'github' is not configured for this project."],
      blockedAt: new Date('2026-06-29T17:00:00.000Z'),
      blockedReason: 'GitHub missing.',
      existingMetadata: {},
      retryable: true,
      warnings: [],
    })
    const notDueRetryable = buildMcpBrokerBlockMetadata({
      blocked: ["MCP 'github' is auth_required/auth_required: Connect GitHub."],
      blockedAt: new Date('2026-06-29T17:09:00.000Z'),
      blockedReason: 'GitHub auth required.',
      existingMetadata: {},
      retryable: true,
      warnings: [],
    })
    const permanent = buildMcpBrokerBlockMetadata({
      blocked: ["Unknown MCP 'slack' was requested."],
      blockedAt: new Date('2026-06-29T17:00:00.000Z'),
      blockedReason: 'Unknown MCP.',
      existingMetadata: {},
      retryable: false,
      warnings: [],
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
