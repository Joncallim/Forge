import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({ default: {} }))

import {
  assertCasRecheckValid,
  computeCasRecheckToken,
  computeFreshnessFingerprint,
  normalizeS5RecoveryMarkers,
  normalizeS5TerminalAudit,
} from '@/lib/mcps/s5-server-reader'

describe('S5 authoritative reader identities', () => {
  it('canonicalizes nested mutable state independent of object insertion order', () => {
    expect(computeFreshnessFingerprint({
      task: { status: 'approved', id: 'task-1' },
      packages: [{ version: '2', id: 'package-1' }],
    })).toBe(computeFreshnessFingerprint({
      packages: [{ id: 'package-1', version: '2' }],
      task: { id: 'task-1', status: 'approved' },
    }))
  })

  it('changes when nested authoritative state changes', () => {
    const before = computeFreshnessFingerprint({ packages: [{ id: 'package-1', version: '1' }] })
    const after = computeFreshnessFingerprint({ packages: [{ id: 'package-1', version: '2' }] })
    expect(after).not.toBe(before)
  })

  it('binds the deterministic CAS identity to task and operator', () => {
    const fingerprint = computeFreshnessFingerprint({ status: 'blocked' })
    const token = computeCasRecheckToken({ fingerprint, taskId: 'task-1', userId: 'user-1' })
    expect(computeCasRecheckToken({ fingerprint, taskId: 'task-1', userId: 'user-1' })).toBe(token)
    expect(assertCasRecheckValid({ fingerprint, taskId: 'task-1', token, userId: 'user-1' })).toBe(true)
    expect(assertCasRecheckValid({ fingerprint, taskId: 'task-2', token, userId: 'user-1' })).toBe(false)
    expect(assertCasRecheckValid({ fingerprint, taskId: 'task-1', token, userId: 'user-2' })).toBe(false)
  })

  it.each([
    'local_effect_recovery',
    'local_effect_integrity_hold',
    'packet_issuance',
    'packet_integrity_hold',
  ])('fails malformed %s state closed without echoing its value', (key) => {
    const markers = normalizeS5RecoveryMarkers({
      id: '00000000-0000-4000-8000-000000000001',
      metadata: { [key]: { schemaVersion: 999, secret: '/Users/operator/.ssh/id_ed25519' } },
    }, [], [])
    expect(markers).toEqual([{
      workPackageId: '00000000-0000-4000-8000-000000000001',
      kind: 'invalid',
      state: 'invalid',
      action: null,
      evidenceId: null,
      evidenceFingerprint: null,
    }])
    expect(JSON.stringify(markers)).not.toContain('/Users/')
  })

  it('accepts only a coherent terminal audit joined to its terminal local evidence', () => {
    const audit = {
      id: '00000000-0000-4000-8000-000000000001',
      workPackageId: '00000000-0000-4000-8000-000000000002',
      agentRunId: '00000000-0000-4000-8000-000000000003',
      localRunEvidenceId: '00000000-0000-4000-8000-000000000004',
      assembly: {
        state: 'assembled', rootRef: 'opaque-root', includedCount: 1,
        byteCount: 12, omittedCount: 0, redactionSummary: {},
      },
      delivery: { state: 'submitted' },
      terminal: { status: 'succeeded' },
      terminalAt: new Date('2026-07-18T00:00:00.000Z'),
    }
    const evidence = [{
      id: audit.localRunEvidenceId,
      workPackageId: audit.workPackageId,
      agentRunId: audit.agentRunId,
      state: 'terminal',
    }]
    expect(normalizeS5TerminalAudit(audit, evidence)).toMatchObject({
      state: 'terminal',
      assemblyState: 'assembled',
      deliveryOutcome: 'submitted',
      terminalOutcome: 'succeeded',
    })
    expect(normalizeS5TerminalAudit({ ...audit, delivery: { state: 'submitted', extra: true } }, evidence)).toMatchObject({
      state: 'unavailable',
      assemblyState: null,
      deliveryOutcome: null,
      terminalOutcome: null,
    })
    expect(normalizeS5TerminalAudit(audit, [{ ...evidence[0], state: 'uncertain' }])).toMatchObject({
      state: 'unavailable',
    })
  })
})
