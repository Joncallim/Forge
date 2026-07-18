import {
  buildFilesystemGrantBlockMetadata,
  canonicalPositiveDecisionRevision,
  parseFilesystemGrantHoldState,
  type FilesystemGrantBlockMetadata,
} from './filesystem-grant-lifecycle'
import {
  canonicalFilesystemProjectCapabilities,
  projectFilesystemEffectivePhase,
  projectFilesystemGrantFromAuthority,
  readFilesystemGrantBlockFromMetadata,
  requiresFilesystemGrantApproval,
  summarizeFilesystemCapabilities,
  type FilesystemProjectCapability,
  type FilesystemProjectRequestCapability,
} from './filesystem-grants'
import {
  loadCurrentProjectFilesystemDecision,
  type FilesystemGrantMutation,
} from './filesystem-grant-reconciliation'
import type { ProjectMcpConfig } from '@/db/schema'

export const LEGACY_S3_ADAPTER_DEADLINE = new Date('2026-12-31T23:59:59.000Z')

export type LegacyPackageGrantState = {
  workPackageId: string
  isBlocked: boolean
  missingCapabilities: FilesystemProjectCapability[]
  requestedCapabilities: FilesystemProjectRequestCapability[]
  requirementKeys: string[]
  blockMetadata: FilesystemGrantBlockMetadata | null
  blockFingerprint: string | null
  fingerprintVerified: boolean
}

/**
 * Canonicalize a project root-binding revision (bigint/number/string) to the
 * exact decimal string form the S3 block fingerprint is computed against.
 */
function canonicalRootBindingRevision(value: unknown): string | null {
  if (typeof value === 'bigint' || typeof value === 'number') {
    const text = value.toString()
    return /^[1-9][0-9]*$/.test(text) ? text : null
  }
  if (typeof value === 'string') return /^[1-9][0-9]*$/.test(value) ? value : null
  return null
}

export function isLegacyAdapterExpired(now: Date = new Date()): boolean {
  return now > LEGACY_S3_ADAPTER_DEADLINE
}

export function assertLegacyAdapterNotExpired(now: Date = new Date()): void {
  if (isLegacyAdapterExpired(now)) {
    throw new Error(
      'The legacy filesystem grant adapter expired on ' +
      `${LEGACY_S3_ADAPTER_DEADLINE.toISOString()}. ` +
      'All consumers must use the canonical S3 projection-head API directly.',
    )
  }
}

export function legacyFilesystemGrantBlock(input: {
  workPackageId: string
  mcpRequirements?: unknown
  metadata: unknown
  projectMcpConfig: ProjectMcpConfig
  projectFilesystemDecision?: unknown
  projectRootBindingRevision?: unknown
  now?: Date
}): LegacyPackageGrantState {
  assertLegacyAdapterNotExpired(input.now)
  const summary = summarizeFilesystemCapabilities({
    mcpRequirements: input.mcpRequirements,
    metadata: input.metadata,
  })
  const requires = requiresFilesystemGrantApproval({
    mcpRequirements: input.mcpRequirements,
    metadata: input.metadata,
    projectMcpConfig: input.projectMcpConfig,
    projectFilesystemDecision: input.projectFilesystemDecision,
    projectRootBindingRevision: input.projectRootBindingRevision,
  })

  // Read the persisted block from its one canonical location and reconstruct the
  // compatibility record so the fingerprint is derived from — and verified
  // against — the canonical fields rather than trusted verbatim from storage.
  const storedBlock = readFilesystemGrantBlockFromMetadata(input.metadata)
  let blockMetadata: FilesystemGrantBlockMetadata | null = null
  let blockFingerprint: string | null = null
  let fingerprintVerified = false
  if (storedBlock) {
    const hold = parseFilesystemGrantHoldState(storedBlock)
    const rootBindingRevision = canonicalRootBindingRevision(input.projectRootBindingRevision)
    if (hold && rootBindingRevision !== null) {
      const reconstructed = buildFilesystemGrantBlockMetadata({
        blockedAt: new Date(storedBlock.blockedAt),
        hold,
        requirementKeys: storedBlock.requirementKeys,
        requestedCapabilities: storedBlock.requestedCapabilities,
        rootBindingRevision,
      })
      blockFingerprint = reconstructed.blockFingerprint
      fingerprintVerified = reconstructed.blockFingerprint === storedBlock.blockFingerprint
      blockMetadata = fingerprintVerified ? reconstructed : storedBlock
    } else {
      blockMetadata = storedBlock
      blockFingerprint = storedBlock.blockFingerprint
    }
  }

  return {
    workPackageId: input.workPackageId,
    isBlocked: requires.blocked,
    missingCapabilities: requires.missingCapabilities,
    requestedCapabilities: summary.requestedCapabilities,
    requirementKeys: requires.requirementKeys,
    blockMetadata,
    blockFingerprint,
    fingerprintVerified,
  }
}

export function legacyEffectiveFilesystemPhase(metadata: unknown): {
  phase: 'none' | 'proposed' | 'not_issued' | 'approved' | 'denied' | 'revoked'
  consumed: boolean
} {
  assertLegacyAdapterNotExpired()
  const grant = projectFilesystemGrantFromAuthority(metadata)
  if (!grant) return { phase: 'none', consumed: false }
  const result = projectFilesystemEffectivePhase(grant)
  const record = result as Record<string, unknown>
  return {
    phase: (record.phase ?? 'none') as 'none' | 'proposed' | 'not_issued' | 'approved' | 'denied' | 'revoked',
    consumed: Boolean(record.consumed),
  }
}

export function legacyProjectGrantFromAuthority(authority: unknown) {
  assertLegacyAdapterNotExpired()
  return projectFilesystemGrantFromAuthority(authority)
}

export function legacyCanonicalProjectCapabilities(value: unknown): FilesystemProjectCapability[] {
  assertLegacyAdapterNotExpired()
  return canonicalFilesystemProjectCapabilities(value)
}

export function legacyCanonicalDecisionRevision(value: unknown): string | null {
  assertLegacyAdapterNotExpired()
  return canonicalPositiveDecisionRevision(value)
}

export function legacyLoadProjectDecision(projectId: string) {
  assertLegacyAdapterNotExpired()
  return loadCurrentProjectFilesystemDecision(projectId)
}

export function adaptLegacyMutation(mutation: {
  workPackageId: string
  decision: 'approved' | 'denied'
  capabilities: string[]
  grantMode?: 'allow_once' | 'always_allow'
  reason?: string
}): FilesystemGrantMutation {
  assertLegacyAdapterNotExpired()
  return {
    workPackageId: mutation.workPackageId,
    decision: mutation.decision,
    capabilities: mutation.capabilities,
    grantMode: mutation.grantMode ?? 'allow_once',
    reason: mutation.reason ?? '',
  }
}
