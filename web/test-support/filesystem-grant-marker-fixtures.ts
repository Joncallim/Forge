export const VALID_S3_HOLD_STATES: ReadonlyArray<Record<string, unknown>> = [
  { holdKind: 'approval_required', grantPhase: 'none', grantConsumed: false, grantDecisionRevision: null, revocationReason: null },
  { holdKind: 'approval_required', grantPhase: 'proposed', grantConsumed: false, grantDecisionRevision: null, revocationReason: null },
  { holdKind: 'approval_required', grantPhase: 'not_issued', grantConsumed: false, grantDecisionRevision: null, revocationReason: null },
  { holdKind: 'denied_required', grantPhase: 'denied', grantConsumed: false, grantDecisionRevision: null, revocationReason: null },
  { holdKind: 'denied_required', grantPhase: 'denied', grantConsumed: false, grantDecisionRevision: '1', revocationReason: null },
  { holdKind: 'revoked_required', grantPhase: 'revoked', grantConsumed: false, grantDecisionRevision: '1', revocationReason: 'project_grant_removed' },
  { holdKind: 'revoked_required', grantPhase: 'revoked', grantConsumed: false, grantDecisionRevision: '1', revocationReason: 'project_grant_narrowed' },
  { holdKind: 'revoked_required', grantPhase: 'revoked', grantConsumed: false, grantDecisionRevision: '1', revocationReason: 'project_root_repoint' },
  { holdKind: 'consumed_once', grantPhase: 'approved', grantConsumed: true, grantDecisionRevision: '1', revocationReason: null },
]

export function canonicalS3Marker(
  hold: Record<string, unknown> = VALID_S3_HOLD_STATES[5],
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    kind: 'filesystem_grant',
    source: 'filesystem-grant-approval',
    taskDisposition: 'operator_hold',
    autoRetryable: false,
    terminalFailure: false,
    requirementKeys: ['requirement-1', 'requirement-2'],
    requestedCapabilities: ['filesystem.project.list', 'filesystem.project.read'],
    recoveryAction: 'approve_project_filesystem_context',
    blockFingerprint: `sha256:${'0'.repeat(64)}`,
    blockedAt: '2026-07-17T00:00:00.000Z',
    ...hold,
  }
}

const without = (key: string) => {
  const marker = canonicalS3Marker()
  delete marker[key]
  return marker
}

export const INVALID_S3_MARKERS: ReadonlyArray<{
  label: string
  marker: Record<string, unknown>
}> = [
  { label: 'missing required key', marker: without('source') },
  { label: 'unknown key', marker: { ...canonicalS3Marker(), placeholderS4State: true } },
  { label: 'duplicate requirement', marker: { ...canonicalS3Marker(), requirementKeys: ['requirement-1', 'requirement-1'] } },
  { label: 'unsorted requirements', marker: { ...canonicalS3Marker(), requirementKeys: ['requirement-2', 'requirement-1'] } },
  { label: 'too many requirements', marker: { ...canonicalS3Marker(), requirementKeys: Array.from({ length: 257 }, (_, index) => `r-${String(index).padStart(3, '0')}`) } },
  { label: 'oversized requirement', marker: { ...canonicalS3Marker(), requirementKeys: ['r'.repeat(241)] } },
  { label: 'duplicate capability', marker: { ...canonicalS3Marker(), requestedCapabilities: ['filesystem.project.read', 'filesystem.project.read'] } },
  { label: 'unsorted capabilities', marker: { ...canonicalS3Marker(), requestedCapabilities: ['filesystem.project.read', 'filesystem.project.list'] } },
  { label: 'unknown capability', marker: { ...canonicalS3Marker(), requestedCapabilities: ['filesystem.project.write'] } },
  { label: 'invalid timestamp', marker: { ...canonicalS3Marker(), blockedAt: 'not-a-time' } },
  { label: 'noncanonical timestamp', marker: { ...canonicalS3Marker(), blockedAt: '2026-07-17T00:00:00Z' } },
  { label: 'invalid fingerprint', marker: { ...canonicalS3Marker(), blockFingerprint: `sha256:${'A'.repeat(64)}` } },
  {
    label: 'invalid hold cross product',
    marker: {
      ...canonicalS3Marker(),
      holdKind: 'consumed_once',
      grantPhase: 'approved',
      grantConsumed: false,
      grantDecisionRevision: '1',
      revocationReason: null,
    },
  },
]
