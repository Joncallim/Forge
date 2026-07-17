import { describe, expect, it } from 'vitest'
import {
  buildFilesystemGrantBlockMetadata,
  canonicalPositiveDecisionRevision,
  parseFilesystemGrantBlockMetadata,
  parseFilesystemGrantHoldState,
  type FilesystemGrantHoldState,
} from '@/lib/mcps/filesystem-grant-lifecycle'

const REVISION = canonicalPositiveDecisionRevision('12')!

const validStates: FilesystemGrantHoldState[] = [
  { holdKind: 'approval_required', grantPhase: 'none', grantConsumed: false, grantDecisionRevision: null, revocationReason: null },
  { holdKind: 'approval_required', grantPhase: 'proposed', grantConsumed: false, grantDecisionRevision: null, revocationReason: null },
  { holdKind: 'approval_required', grantPhase: 'not_issued', grantConsumed: false, grantDecisionRevision: null, revocationReason: null },
  { holdKind: 'denied_required', grantPhase: 'denied', grantConsumed: false, grantDecisionRevision: null, revocationReason: null },
  { holdKind: 'denied_required', grantPhase: 'denied', grantConsumed: false, grantDecisionRevision: REVISION, revocationReason: null },
  { holdKind: 'revoked_required', grantPhase: 'revoked', grantConsumed: false, grantDecisionRevision: REVISION, revocationReason: 'project_grant_removed' },
  { holdKind: 'revoked_required', grantPhase: 'revoked', grantConsumed: false, grantDecisionRevision: REVISION, revocationReason: 'project_grant_narrowed' },
  { holdKind: 'revoked_required', grantPhase: 'revoked', grantConsumed: false, grantDecisionRevision: REVISION, revocationReason: 'project_root_repoint' },
  { holdKind: 'consumed_once', grantPhase: 'approved', grantConsumed: true, grantDecisionRevision: REVISION, revocationReason: null },
]

describe('filesystem grant lifecycle', () => {
  it.each(validStates)('accepts the canonical $holdKind/$grantPhase arm', (state) => {
    expect(parseFilesystemGrantHoldState(state)).toEqual(state)
  })

  it.each([
    { holdKind: 'consumed_once', grantPhase: 'denied', grantConsumed: true, grantDecisionRevision: '1', revocationReason: null },
    { holdKind: 'consumed_once', grantPhase: 'approved', grantConsumed: false, grantDecisionRevision: '1', revocationReason: null },
    { holdKind: 'revoked_required', grantPhase: 'revoked', grantConsumed: false, grantDecisionRevision: '1', revocationReason: null },
    { holdKind: 'revoked_required', grantPhase: 'revoked', grantConsumed: false, grantDecisionRevision: '0', revocationReason: 'project_root_repoint' },
    { holdKind: 'denied_required', grantPhase: 'denied', grantConsumed: false, grantDecisionRevision: '01', revocationReason: null },
    { holdKind: 'approval_required', grantPhase: 'not_issued', grantConsumed: false, grantDecisionRevision: '1', revocationReason: null },
  ])('rejects invalid cross-product %#', (state) => {
    expect(parseFilesystemGrantHoldState(state)).toBeNull()
  })

  it('builds a deterministic, strict v2 marker', () => {
    const marker = buildFilesystemGrantBlockMetadata({
      blockedAt: new Date('2026-07-17T00:00:00.000Z'),
      hold: validStates[5],
      requirementKeys: ['r2', 'r1'],
      requestedCapabilities: ['filesystem.project.read', 'filesystem.project.list'],
      rootBindingRevision: '7',
    })
    expect(parseFilesystemGrantBlockMetadata(marker)).toEqual(marker)
    expect(buildFilesystemGrantBlockMetadata({
      blockedAt: new Date('2026-07-18T00:00:00.000Z'),
      hold: validStates[5],
      requirementKeys: ['r1', 'r2'],
      requestedCapabilities: ['filesystem.project.list', 'filesystem.project.read'],
      rootBindingRevision: '7',
    }).blockFingerprint).toBe(marker.blockFingerprint)
    expect(parseFilesystemGrantBlockMetadata({ ...marker, reason: 'not canonical' })).toBeNull()
  })

  it.each(['0', '00', '01', '-1', '1.0', ' 1', 1, null])('rejects non-canonical revision %j', (value) => {
    expect(canonicalPositiveDecisionRevision(value)).toBeNull()
  })
})
