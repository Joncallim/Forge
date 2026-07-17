import { createHash } from 'node:crypto'
import type { FilesystemProjectCapability } from './filesystem-grants'

export type CanonicalPositiveDecisionRevision = string & {
  readonly __canonicalPositiveDecisionRevision: unique symbol
}

export type FilesystemGrantRevocationReason =
  | 'project_grant_removed'
  | 'project_grant_narrowed'
  | 'project_root_repoint'

export type FilesystemGrantHoldState =
  | {
      holdKind: 'approval_required'
      grantPhase: 'none' | 'proposed' | 'not_issued'
      grantConsumed: false
      grantDecisionRevision: null
      revocationReason: null
    }
  | {
      holdKind: 'denied_required'
      grantPhase: 'denied'
      grantConsumed: false
      grantDecisionRevision: CanonicalPositiveDecisionRevision | null
      revocationReason: null
    }
  | {
      holdKind: 'revoked_required'
      grantPhase: 'revoked'
      grantConsumed: false
      grantDecisionRevision: CanonicalPositiveDecisionRevision
      revocationReason: FilesystemGrantRevocationReason
    }
  | {
      holdKind: 'consumed_once'
      grantPhase: 'approved'
      grantConsumed: true
      grantDecisionRevision: CanonicalPositiveDecisionRevision
      revocationReason: null
    }

export type FilesystemGrantBlockMetadata = {
  schemaVersion: 2
  kind: 'filesystem_grant'
  source: 'filesystem-grant-approval'
  taskDisposition: 'operator_hold'
  autoRetryable: false
  terminalFailure: false
  requirementKeys: string[]
  requestedCapabilities: FilesystemProjectCapability[]
  recoveryAction: 'approve_project_filesystem_context'
  blockFingerprint: string
  blockedAt: string
} & FilesystemGrantHoldState

const MARKER_KEYS = new Set([
  'schemaVersion',
  'kind',
  'source',
  'taskDisposition',
  'autoRetryable',
  'terminalFailure',
  'requirementKeys',
  'requestedCapabilities',
  'recoveryAction',
  'blockFingerprint',
  'blockedAt',
  'holdKind',
  'grantPhase',
  'grantConsumed',
  'grantDecisionRevision',
  'revocationReason',
])

const CAPABILITIES = new Set<FilesystemProjectCapability>([
  'filesystem.project.read',
  'filesystem.project.list',
  'filesystem.project.search',
])

const REVOCATION_REASONS = new Set<FilesystemGrantRevocationReason>([
  'project_grant_removed',
  'project_grant_narrowed',
  'project_root_repoint',
])

export function canonicalPositiveDecisionRevision(
  value: unknown,
): CanonicalPositiveDecisionRevision | null {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    ? value as CanonicalPositiveDecisionRevision
    : null
}

function boundedSortedStrings(value: unknown, maxItems: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null
  const output = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 240) return null
    output.add(item)
  }
  const result = [...output].sort()
  return result.length === value.length ? result : null
}

export function parseFilesystemGrantHoldState(value: unknown): FilesystemGrantHoldState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const revision = row.grantDecisionRevision === null
    ? null
    : canonicalPositiveDecisionRevision(row.grantDecisionRevision)
  if (row.grantDecisionRevision !== null && revision === null) return null

  if (
    row.holdKind === 'approval_required' &&
    (row.grantPhase === 'none' || row.grantPhase === 'proposed' || row.grantPhase === 'not_issued') &&
    row.grantConsumed === false &&
    row.grantDecisionRevision === null &&
    row.revocationReason === null
  ) {
    return {
      holdKind: row.holdKind,
      grantPhase: row.grantPhase,
      grantConsumed: false,
      grantDecisionRevision: null,
      revocationReason: null,
    }
  }
  if (
    row.holdKind === 'denied_required' &&
    row.grantPhase === 'denied' &&
    row.grantConsumed === false &&
    (row.grantDecisionRevision === null || revision !== null) &&
    row.revocationReason === null
  ) {
    return {
      holdKind: row.holdKind,
      grantPhase: 'denied',
      grantConsumed: false,
      grantDecisionRevision: revision,
      revocationReason: null,
    }
  }
  if (
    row.holdKind === 'revoked_required' &&
    row.grantPhase === 'revoked' &&
    row.grantConsumed === false &&
    revision !== null &&
    REVOCATION_REASONS.has(row.revocationReason as FilesystemGrantRevocationReason)
  ) {
    return {
      holdKind: row.holdKind,
      grantPhase: 'revoked',
      grantConsumed: false,
      grantDecisionRevision: revision,
      revocationReason: row.revocationReason as FilesystemGrantRevocationReason,
    }
  }
  if (
    row.holdKind === 'consumed_once' &&
    row.grantPhase === 'approved' &&
    row.grantConsumed === true &&
    revision !== null &&
    row.revocationReason === null
  ) {
    return {
      holdKind: row.holdKind,
      grantPhase: 'approved',
      grantConsumed: true,
      grantDecisionRevision: revision,
      revocationReason: null,
    }
  }
  return null
}

export function parseFilesystemGrantBlockMetadata(
  value: unknown,
): FilesystemGrantBlockMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((key) => !MARKER_KEYS.has(key))) return null
  if (
    row.schemaVersion !== 2 ||
    row.kind !== 'filesystem_grant' ||
    row.source !== 'filesystem-grant-approval' ||
    row.taskDisposition !== 'operator_hold' ||
    row.autoRetryable !== false ||
    row.terminalFailure !== false ||
    row.recoveryAction !== 'approve_project_filesystem_context' ||
    typeof row.blockedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.blockedAt)) ||
    typeof row.blockFingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(row.blockFingerprint)
  ) return null

  const requirementKeys = boundedSortedStrings(row.requirementKeys, 256)
  const requestedCapabilities = boundedSortedStrings(row.requestedCapabilities, 3)
  if (
    !requirementKeys ||
    !requestedCapabilities ||
    requestedCapabilities.some((capability) => !CAPABILITIES.has(capability as FilesystemProjectCapability))
  ) return null
  const hold = parseFilesystemGrantHoldState(row)
  if (!hold) return null
  return {
    schemaVersion: 2,
    kind: 'filesystem_grant',
    source: 'filesystem-grant-approval',
    taskDisposition: 'operator_hold',
    autoRetryable: false,
    terminalFailure: false,
    requirementKeys,
    requestedCapabilities: requestedCapabilities as FilesystemProjectCapability[],
    recoveryAction: 'approve_project_filesystem_context',
    blockFingerprint: row.blockFingerprint,
    blockedAt: row.blockedAt,
    ...hold,
  }
}

export function filesystemGrantBlockFingerprint(input: {
  hold: FilesystemGrantHoldState
  requirementKeys: readonly string[]
  requestedCapabilities: readonly FilesystemProjectCapability[]
  rootBindingRevision: string
}): string {
  const canonical = JSON.stringify({
    schemaVersion: 1,
    requirementKeys: [...new Set(input.requirementKeys)].sort(),
    requestedCapabilities: [...new Set(input.requestedCapabilities)].sort(),
    hold: input.hold,
    rootBindingRevision: input.rootBindingRevision,
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export function buildFilesystemGrantBlockMetadata(input: {
  blockedAt: Date
  hold: FilesystemGrantHoldState
  requirementKeys: readonly string[]
  requestedCapabilities: readonly FilesystemProjectCapability[]
  rootBindingRevision: string
}): FilesystemGrantBlockMetadata {
  const requirementKeys = [...new Set(input.requirementKeys)].sort()
  const requestedCapabilities = [...new Set(input.requestedCapabilities)].sort()
  return {
    schemaVersion: 2,
    kind: 'filesystem_grant',
    source: 'filesystem-grant-approval',
    taskDisposition: 'operator_hold',
    autoRetryable: false,
    terminalFailure: false,
    requirementKeys,
    requestedCapabilities,
    recoveryAction: 'approve_project_filesystem_context',
    blockFingerprint: filesystemGrantBlockFingerprint({
      hold: input.hold,
      requirementKeys,
      requestedCapabilities,
      rootBindingRevision: input.rootBindingRevision,
    }),
    blockedAt: input.blockedAt.toISOString(),
    ...input.hold,
  }
}
