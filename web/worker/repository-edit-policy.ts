import { defaultOnFeatureFlagState } from './feature-flags'

export type RepositoryWritePolicyWorkPackage = {
  assignedRole: string
  metadata: Record<string, unknown>
  requiredCapabilities: Record<string, unknown>
}

export type HostRepositoryWritePolicyState = {
  available: false
  enabled: false
  rawValue: string | null
  recognized: boolean
  requested: boolean
  source: 'FORGE_HOST_REPOSITORY_WRITES' | 'FORGE_REPOSITORY_EDITS' | null
}

const HOST_REPOSITORY_WRITE_EXEMPT_ROLES = new Set([
  'architect',
  'handoff',
  'review',
  'reviewer',
  'security',
  'security-review',
  'security-reviewer',
  'code-reviewer',
])

function canonicalRoleSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

export function isHostRepositoryWritesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return hostRepositoryWritePolicyState(env).enabled
}

export function hostRepositoryWritePolicyState(
  env: Record<string, string | undefined> = process.env,
): HostRepositoryWritePolicyState {
  const source = env.FORGE_HOST_REPOSITORY_WRITES !== undefined
    ? 'FORGE_HOST_REPOSITORY_WRITES'
    : env.FORGE_REPOSITORY_EDITS !== undefined
      ? 'FORGE_REPOSITORY_EDITS'
      : null
  const rawValue = source === null ? undefined : env[source]
  if (rawValue === undefined || rawValue.trim() === '') {
    return {
      available: false,
      enabled: false,
      rawValue: rawValue ?? null,
      recognized: true,
      requested: false,
      source,
    }
  }

  const state = defaultOnFeatureFlagState(rawValue)
  return {
    available: false,
    enabled: false,
    rawValue,
    recognized: state.recognized,
    requested: state.recognized && state.enabled,
    source,
  }
}

export function isRepositoryWritePackage(workPackage: RepositoryWritePolicyWorkPackage): boolean {
  const assignedRole = canonicalRoleSlug(workPackage.assignedRole)
  if (HOST_REPOSITORY_WRITE_EXEMPT_ROLES.has(assignedRole)) return false
  if (workPackage.metadata.repositoryWrites === false) return false
  if (workPackage.metadata.repositoryAffecting === false) return false
  if (workPackage.requiredCapabilities.repository === false) return false
  // Delivery and user-defined roles write by default; review/security/planning
  // roles must be explicitly exempt above or opt out through package metadata.
  return true
}

export function shouldApplyHostRepositoryWrites(
  workPackage: RepositoryWritePolicyWorkPackage,
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Compatibility signal for the executor's typed fail-closed path. A true
  // result means the operator explicitly requested the unavailable feature;
  // it never authorizes host writes.
  return hostRepositoryWritePolicyState(env).requested && isRepositoryWritePackage(workPackage)
}
