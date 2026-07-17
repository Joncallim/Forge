import { describe, expect, it } from 'vitest'
import {
  executionLeaseBlocksConvergence,
  executionLeaseIsStale,
  parseExecutionLeaseMetadata,
} from '@/worker/execution-lease'

const lease = {
  acquiredAt: '2026-07-17T00:00:00.000Z',
  attemptNumber: 1,
  heartbeatAt: '2026-07-17T00:00:10.000Z',
  runId: '00000000-0000-4000-8000-000000000001',
  source: 'work-package-handoff' as const,
  staleAfterSeconds: 30,
}

describe('canonical execution lease', () => {
  it('distinguishes absent, valid, and malformed persisted leases', () => {
    expect(parseExecutionLeaseMetadata({})).toEqual({ state: 'absent' })
    expect(parseExecutionLeaseMetadata({ executionLease: lease })).toEqual({ state: 'valid', lease })
    expect(parseExecutionLeaseMetadata({
      executionLease: { ...lease, heartbeatAt: 'not-a-time' },
    })).toEqual({ state: 'malformed' })
    expect(parseExecutionLeaseMetadata({
      executionLease: { ...lease, heartbeatAt: '2026-02-31T00:00:10.000Z' },
    })).toEqual({ state: 'malformed' })
    expect(parseExecutionLeaseMetadata({
      executionLease: { ...lease, placeholder: true },
    })).toEqual({ state: 'malformed' })
  })

  it('uses the locked transaction time and persisted stale window', () => {
    expect(executionLeaseIsStale(lease, new Date('2026-07-17T00:00:39.999Z'))).toBe(false)
    expect(executionLeaseIsStale(lease, new Date('2026-07-17T00:00:40.000Z'))).toBe(true)
    expect(executionLeaseBlocksConvergence(
      { executionLease: lease },
      new Date('2026-07-17T00:00:39.999Z'),
    )).toBe(true)
    expect(executionLeaseBlocksConvergence(
      { executionLease: lease },
      new Date('2026-07-17T00:00:40.000Z'),
    )).toBe(false)
  })

  it('fails closed for malformed lease-shaped metadata', () => {
    expect(executionLeaseBlocksConvergence(
      { executionLease: { ...lease, staleAfterSeconds: 0 } },
      new Date('2099-01-01T00:00:00.000Z'),
    )).toBe(true)
  })
})
