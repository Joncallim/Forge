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
  'security_review',
])

function featureFlagDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '0' || normalized === 'false'
}

export function isHostRepositoryWritesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !featureFlagDisabled(env.FORGE_HOST_REPOSITORY_WRITES ?? env.FORGE_REPOSITORY_EDITS)
}

export function isRepositoryWritePackage(workPackage: RepositoryWritePolicyWorkPackage): boolean {
  const assignedRole = workPackage.assignedRole.trim().toLowerCase()
  if (HOST_REPOSITORY_WRITE_EXEMPT_ROLES.has(assignedRole)) return false
  if (workPackage.metadata.repositoryWrites === false) return false
  if (workPackage.metadata.repositoryAffecting === false) return false
  if (workPackage.requiredCapabilities.repository === false) return false
  return true
}

export function shouldApplyHostRepositoryWrites(
  workPackage: RepositoryWritePolicyWorkPackage,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isHostRepositoryWritesEnabled(env) && isRepositoryWritePackage(workPackage)
}
