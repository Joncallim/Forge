import {
  canonicalPositiveDecisionRevision,
  parseFilesystemGrantBlockMetadata,
  type FilesystemGrantBlockMetadata,
} from './filesystem-grant-lifecycle'
import {
  canonicalFilesystemProjectCapabilities,
  projectFilesystemEffectivePhase,
  projectFilesystemGrantFromAuthority,
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
  mcpRequirements?: unknown
  metadata: unknown
  projectMcpConfig: ProjectMcpConfig
  projectFilesystemDecision?: unknown
  projectRootBindingRevision?: unknown
}): LegacyPackageGrantState {
  assertLegacyAdapterNotExpired()
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
  let blockMetadata: FilesystemGrantBlockMetadata | null = null
  if (requires.blocked && requires.holdState) {
    const marker = input.metadata as Record<string, unknown> | null
    if (marker && typeof marker === 'object' && !Array.isArray(marker)) {
      const parsed = parseFilesystemGrantBlockMetadata(marker)
      if (parsed && parsed.kind === 'filesystem_grant') blockMetadata = parsed
    }
  }
  return {
    workPackageId: '',
    isBlocked: requires.blocked,
    missingCapabilities: requires.missingCapabilities,
    requestedCapabilities: summary.requestedCapabilities,
    requirementKeys: requires.requirementKeys,
    blockMetadata,
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
