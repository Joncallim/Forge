import {
  canonicalCapabilityForMcp,
  classifyCapability,
} from './capability-normalization'

export const PROJECT_FILESYSTEM_DECISION_SCHEMA_VERSION = 2 as const

export type ProjectFilesystemDecisionRevocationReason =
  | 'project_grant_removed'
  | 'project_grant_narrowed'
  | 'project_root_repoint'

export type ProjectFilesystemDecisionAuthority = {
  schemaVersion: typeof PROJECT_FILESYSTEM_DECISION_SCHEMA_VERSION
  decisionId: string
  projectId: string
  decision: 'approved' | 'revoked'
  capabilities: string[]
  grantDecisionRevision: string
  rootBindingRevision: string
  decisionFingerprint: string
  decisionGeneration: string
  decidedAt: string
  decidedBy: string
  reason: string
  revocationReason: ProjectFilesystemDecisionRevocationReason | null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positiveDecimal(value: unknown): string | null {
  if (typeof value === 'bigint') return value > BigInt(0) ? value.toString() : null
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : null
}

export function canonicalProjectFilesystemCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 3) return null
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const capability = canonicalCapabilityForMcp('filesystem', item)
    if (
      classifyCapability('filesystem', capability) !== 'bounded_read_only' ||
      !['filesystem.project.list', 'filesystem.project.read', 'filesystem.project.search'].includes(capability)
    ) return null
    result.push(capability)
  }
  const canonical = [...new Set(result)].sort()
  return canonical.length === result.length && canonical.every((item, index) => item === result[index])
    ? canonical
    : null
}

export function parseProjectFilesystemDecisionAuthority(
  value: unknown,
): ProjectFilesystemDecisionAuthority | null {
  const input = record(value)
  if (!input || input.schemaVersion !== PROJECT_FILESYSTEM_DECISION_SCHEMA_VERSION) return null
  const capabilities = canonicalProjectFilesystemCapabilities(input.capabilities)
  const grantDecisionRevision = positiveDecimal(input.grantDecisionRevision)
  const rootBindingRevision = positiveDecimal(input.rootBindingRevision)
  const decisionGeneration = positiveDecimal(input.decisionGeneration)
  const revocationReason = input.revocationReason === null
    ? null
    : ['project_grant_removed', 'project_grant_narrowed', 'project_root_repoint'].includes(String(input.revocationReason))
      ? input.revocationReason as ProjectFilesystemDecisionRevocationReason
      : undefined
  if (
    !capabilities || !grantDecisionRevision || !rootBindingRevision || !decisionGeneration ||
    typeof input.decisionId !== 'string' || input.decisionId.length === 0 ||
    typeof input.projectId !== 'string' || input.projectId.length === 0 ||
    typeof input.decisionFingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.decisionFingerprint) ||
    typeof input.decidedAt !== 'string' || input.decidedAt.length === 0 ||
    typeof input.decidedBy !== 'string' || input.decidedBy.length === 0 ||
    typeof input.reason !== 'string' || revocationReason === undefined
  ) return null
  if (input.decision === 'approved') {
    if (capabilities.length === 0 || !capabilities.includes('filesystem.project.read')) return null
    if (revocationReason !== null && revocationReason !== 'project_grant_narrowed') return null
  } else if (input.decision === 'revoked') {
    if (capabilities.length !== 0 || (revocationReason !== 'project_grant_removed' && revocationReason !== 'project_root_repoint')) {
      return null
    }
  } else {
    return null
  }
  return {
    schemaVersion: PROJECT_FILESYSTEM_DECISION_SCHEMA_VERSION,
    decisionId: input.decisionId,
    projectId: input.projectId,
    decision: input.decision,
    capabilities,
    grantDecisionRevision,
    rootBindingRevision,
    decisionFingerprint: input.decisionFingerprint,
    decisionGeneration,
    decidedAt: input.decidedAt,
    decidedBy: input.decidedBy,
    reason: input.reason,
    revocationReason,
  }
}
