import { defaultOnFeatureFlagEnabled } from './feature-flags'

export type RepositoryWritePolicyWorkPackage = {
  assignedRole: string
  metadata: Record<string, unknown>
  requiredCapabilities: Record<string, unknown>
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
  return defaultOnFeatureFlagEnabled(env.FORGE_HOST_REPOSITORY_WRITES ?? env.FORGE_REPOSITORY_EDITS)
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
  return isHostRepositoryWritesEnabled(env) && isRepositoryWritePackage(workPackage)
}
