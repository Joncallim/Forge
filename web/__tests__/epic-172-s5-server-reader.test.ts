import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({ default: {} }))

import {
  computeFreshnessFingerprint,
  canonicalTaskPresentationProjection,
  isS5FreshnessFingerprint,
  normalizeS5RecoveryMarkers,
  normalizeS5TerminalAudit,
} from '@/lib/mcps/s5-server-reader'

describe('S5 authoritative reader identities', () => {
  it('joins recovery actions and terminal evidence into one fail-closed task DTO', () => {
    const taskId = '00000000-0000-4000-8000-000000000001'
    const packageId = '00000000-0000-4000-8000-000000000002'
    const auditId = '00000000-0000-4000-8000-000000000003'
    const fingerprint = `sha256:${'a'.repeat(64)}`
    const state = {
      computedAt: '2026-07-30T00:00:00.000Z', observedAtMs: 0, localEvidenceAvailable: true,
      taskId, projectId: '00000000-0000-4000-8000-000000000004', taskStatus: 'approved', freshnessFingerprint: fingerprint,
      packages: [{
        workPackageId: packageId, title: 'Packet package', assignedRole: 'backend', status: 'blocked',
        requestedCapabilities: [], boundedRuntimeRequestedCapabilities: [], blockingCapabilities: [],
        currentDecision: null, decisionHistory: [], blockMetadata: null, pointerFingerprint: '', pointerVersion: '0',
      }],
      projectGrant: null,
      recoveryMarkers: [{
        workPackageId: packageId, kind: 'packet_issuance' as const, state: 'current' as const, action: 'retry_execution',
        allowedActions: ['retry_execution', 'decline_packet_recovery'], evidenceId: auditId, evidenceFingerprint: fingerprint,
      }],
      terminalPackages: [{
        runtimeAuditId: auditId, workPackageId: packageId, state: 'terminal' as const, assemblyState: 'assembled' as const,
        deliveryOutcome: 'submitted' as const, terminalOutcome: 'succeeded' as const, terminalAt: '2026-07-30T00:00:00.000Z',
      }], evidenceRecords: [],
    }

    const projection = canonicalTaskPresentationProjection(state)
    expect(projection.freshnessFingerprint).toBe(fingerprint)
    expect(projection.admission).toEqual([{ workPackageId: packageId, title: 'Packet package', requiresMcp: false, decision: 'unavailable' }])
    expect(projection.recoveries[0].actions).toEqual([])
    expect(projection.terminals[0]).toMatchObject({ workPackageId: packageId, state: 'terminal', outcome: 'succeeded' })
    expect(JSON.stringify(projection)).not.toContain('claimToken')
  })

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

  it('exposes a plain digest rather than a browser-minted recheck token', () => {
    const fingerprint = computeFreshnessFingerprint({ status: 'blocked' })
    // Deterministic: no random nonce, so a previously issued fingerprint can
    // actually be revalidated by re-reading the same state.
    expect(computeFreshnessFingerprint({ status: 'blocked' })).toBe(fingerprint)
    expect(isS5FreshnessFingerprint(fingerprint)).toBe(true)
    expect(isS5FreshnessFingerprint('recheck:deadbeef')).toBe(false)
    expect(isS5FreshnessFingerprint(`sha256:${'z'.repeat(64)}`)).toBe(false)
    expect(isS5FreshnessFingerprint(null)).toBe(false)
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
      allowedActions: [],
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
      delivery: { state: 'submitted', submittedAt: '2026-07-18T00:00:00.000Z' },
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
    // A submitted delivery carries exactly one extra field, its timestamp.
    // Anything else — an unexpected key, a missing or unparsable timestamp —
    // is not the persisted shape and must not present as terminal.
    expect(normalizeS5TerminalAudit({ ...audit, delivery: { state: 'submitted', extra: true } }, evidence)).toMatchObject({
      state: 'unavailable',
      assemblyState: null,
      deliveryOutcome: null,
      terminalOutcome: null,
    })
    expect(normalizeS5TerminalAudit({ ...audit, delivery: { state: 'submitted' } }, evidence)).toMatchObject({
      state: 'unavailable',
      deliveryOutcome: null,
    })
    expect(normalizeS5TerminalAudit({ ...audit, delivery: { state: 'submitted', submittedAt: 'not-a-date' } }, evidence)).toMatchObject({
      state: 'unavailable',
      deliveryOutcome: null,
    })
    // A non-submitted outcome is exactly `{ state }`; a stray timestamp there
    // is not the persisted shape either.
    expect(normalizeS5TerminalAudit({
      ...audit,
      delivery: { state: 'not_exposed', submittedAt: '2026-07-18T00:00:00.000Z' },
    }, evidence)).toMatchObject({
      state: 'unavailable',
      deliveryOutcome: null,
    })
    expect(normalizeS5TerminalAudit(audit, [{ ...evidence[0], state: 'uncertain' }])).toMatchObject({
      state: 'unavailable',
    })
  })
})
