import { describe, expect, it, vi } from 'vitest'
import {
  reconcileSessionCacheInvalidations,
  sessionCachePurgeBackoffSeconds,
  sessionCachePurgeKeys,
  type SessionCachePurgeTarget,
} from '@/lib/session-cache-invalidation'

const digest = 'a'.repeat(64)

function target(overrides: Partial<SessionCachePurgeTarget> = {}): SessionCachePurgeTarget {
  return {
    attemptCount: 1,
    claimToken: 'claim-1',
    credentialDigestHex: digest,
    generation: 'generation-1',
    legacyCredential: null,
    sessionId: 'session-1',
    ...overrides,
  }
}

describe('session cache invalidation', () => {
  it('derives only the v2 key, plus an existing v1 legacy key when supplied', () => {
    expect(sessionCachePurgeKeys(target())).toEqual([`session:v2:${digest}`])
    expect(sessionCachePurgeKeys(target({ legacyCredential: 'legacy-id' }))).toEqual([
      `session:v2:${digest}`,
      'session:legacy-id',
    ])
    expect(sessionCachePurgeKeys(target({ credentialDigestHex: 'not-a-digest' }))).toEqual([])
  })

  it('completes a claimed invalidation after idempotent Redis deletion', async () => {
    const claimed = target({ legacyCredential: 'legacy-id' })
    const deleteKeys = vi.fn().mockResolvedValue(2)
    const complete = vi.fn().mockResolvedValue(true)
    const defer = vi.fn().mockResolvedValue(true)

    await expect(reconcileSessionCacheInvalidations({
      limit: 100,
      deleteKeys,
      store: { claimDue: vi.fn().mockResolvedValue([claimed]), complete, defer },
    })).resolves.toEqual({ claimed: 1, completed: 1, deferred: 0, stale: 0 })

    expect(deleteKeys).toHaveBeenCalledWith([`session:v2:${digest}`, 'session:legacy-id'])
    expect(complete).toHaveBeenCalledWith(claimed)
    expect(defer).not.toHaveBeenCalled()
  })

  it('keeps failed Redis deletion retryable and safely completes a later claim', async () => {
    const first = target({ claimToken: 'claim-first', attemptCount: 1 })
    const recovered = target({ claimToken: 'claim-recovered', attemptCount: 2 })
    const deleteKeys = vi.fn()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValueOnce(0)
    const complete = vi.fn().mockResolvedValue(true)
    const defer = vi.fn().mockResolvedValue(true)
    const claimDue = vi.fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([recovered])

    await expect(reconcileSessionCacheInvalidations({
      limit: 1,
      deleteKeys,
      store: { claimDue, complete, defer },
    })).resolves.toEqual({ claimed: 1, completed: 0, deferred: 1, stale: 0 })
    expect(defer).toHaveBeenCalledWith(first)
    expect(complete).not.toHaveBeenCalled()

    await expect(reconcileSessionCacheInvalidations({
      limit: 1,
      deleteKeys,
      store: { claimDue, complete, defer },
    })).resolves.toEqual({ claimed: 1, completed: 1, deferred: 0, stale: 0 })
    expect(complete).toHaveBeenCalledWith(recovered)
    expect(deleteKeys).toHaveBeenCalledTimes(2)
  })

  it('uses bounded exponential retry backoff', () => {
    expect(sessionCachePurgeBackoffSeconds(1)).toBe(1)
    expect(sessionCachePurgeBackoffSeconds(2)).toBe(2)
    expect(sessionCachePurgeBackoffSeconds(9)).toBe(256)
    expect(sessionCachePurgeBackoffSeconds(10)).toBe(300)
  })

  it('does not complete malformed targets or use them as cache authority', async () => {
    const malformed = target({ credentialDigestHex: 'not-a-digest' })
    const deleteKeys = vi.fn()
    const complete = vi.fn()
    const defer = vi.fn().mockResolvedValue(true)

    await expect(reconcileSessionCacheInvalidations({
      limit: 1,
      deleteKeys,
      store: { claimDue: vi.fn().mockResolvedValue([malformed]), complete, defer },
    })).resolves.toEqual({ claimed: 1, completed: 0, deferred: 1, stale: 0 })

    expect(deleteKeys).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(defer).toHaveBeenCalledWith(malformed)
  })

  it('reports a reclaimed claim as stale instead of inventing completion', async () => {
    const claimed = target({ claimToken: 'expired-claim' })
    const deleteKeys = vi.fn().mockResolvedValue(0)
    const complete = vi.fn().mockResolvedValue(false)
    const defer = vi.fn().mockResolvedValue(false)

    await expect(reconcileSessionCacheInvalidations({
      limit: 1,
      deleteKeys,
      store: { claimDue: vi.fn().mockResolvedValue([claimed]), complete, defer },
    })).resolves.toEqual({ claimed: 1, completed: 0, deferred: 0, stale: 1 })
    expect(defer).not.toHaveBeenCalled()
  })

  it('reports a late failed worker as stale when its defer claim was reclaimed', async () => {
    const claimed = target({ claimToken: 'expired-claim' })
    const deleteKeys = vi.fn().mockRejectedValue(new Error('redis unavailable'))
    const complete = vi.fn()
    const defer = vi.fn().mockResolvedValue(false)

    await expect(reconcileSessionCacheInvalidations({
      limit: 1,
      deleteKeys,
      store: { claimDue: vi.fn().mockResolvedValue([claimed]), complete, defer },
    })).resolves.toEqual({ claimed: 1, completed: 0, deferred: 0, stale: 1 })
    expect(complete).not.toHaveBeenCalled()
    expect(defer).toHaveBeenCalledWith(claimed)
  })
})
