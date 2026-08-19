import { createHash } from 'node:crypto'

export const GOAL_GIT_SAFETY_PROFILE_VERSION = 1 as const

export type GoalGitSafetyProfileV1 = {
  schemaVersion: typeof GOAL_GIT_SAFETY_PROFILE_VERSION
  supportedGitVersions: readonly GitVersionRange[]
  fixedGlobalOptionsDigest: string
  safeEnvironmentDigest: string
  localConfigPolicyDigest: string
  metadataLayoutPolicyDigest: string
  indexPolicyDigest: string
  objectStorePolicyDigest: string
}

export type GitVersionRange = {
  min: string
  max: string
}

export type GoalRepositoryProfileReasonCode =
  | 'git_version_unsupported'
  | 'unsupported_git_metadata_layout'
  | 'linked_worktree_unsupported'
  | 'unsupported_git_config'
  | 'partial_clone_unsupported'
  | 'incomplete_object_store'
  | 'sparse_checkout_unsupported'
  | 'split_index_unsupported'
  | 'grafts_unsupported'
  | 'goal_definition_untracked'
  | 'git_executable_untrusted'
  | 'submodule_repository_unsupported'
  | 'unsupported_repository_identity'
  | 'repository_dirty'
  | 'repository_changed'
  | 'root_changed'
  | 'missing_required_evidence'

export type GoalRepositoryProfileV1 = {
  schemaVersion: 1
  supported: boolean
  reasonCode: GoalRepositoryProfileReasonCode | null
  objectFormat: 'sha1' | 'sha256' | null
  headOid: string | null
  metadataFingerprint: string | null
  indexFingerprint: string | null
  configFingerprint: string | null
  gitSafetyProfileVersion: number
  gitSafetyProfileDigest: string
}

const GOAL_GIT_SAFETY_PROFILE_DOMAIN =
  'forge:verification-goal:git-safety-profile:v1\0' as const

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Code-owned Git safety profile for read-only deterministic proofs.
 *
 * This is a positive allowlist, not "read-only Git" intuition. Repository
 * configuration can request or restrict work; it cannot widen permissions.
 */
export const GOAL_GIT_SAFETY_PROFILE_V1: GoalGitSafetyProfileV1 = {
  schemaVersion: GOAL_GIT_SAFETY_PROFILE_VERSION,
  supportedGitVersions: [
    { min: '2.35.0', max: '9.9.9' },
  ],
  fixedGlobalOptionsDigest: sha256Hex(
    [
      '--git-dir=.git',
      '--work-tree=.',
      '--no-pager',
      '-c core.fsmonitor=false',
      '-c core.untrackedCache=false',
      '-c core.ignorestat=false',
    ].join('\0'),
  ),
  safeEnvironmentDigest: sha256Hex(
    [
      'GIT_CONFIG_NOSYSTEM=1',
      'GIT_CONFIG_GLOBAL=/dev/null',
      'GIT_DIR unset',
      'GIT_WORK_TREE unset',
      'GIT_COMMON_DIR unset',
      'GIT_OBJECT_DIRECTORY unset',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES unset',
      'GIT_INDEX_FILE unset',
      'GIT_NO_LAZY_FETCH=1',
      'GIT_NO_REPLACE_OBJECTS=1',
      'GIT_OPTIONAL_LOCKS=0',
      'GIT_TERMINAL_PROMPT=0',
      'core.fsmonitor=false',
      'core.untrackedCache=false',
      'core.ignorestat=false',
    ].join('\0'),
  ),
  localConfigPolicyDigest: sha256Hex(
    [
      'reject include',
      'reject includeIf',
      'reject filter',
      'reject external diff/helper/process',
      'reject core.attributesFile',
      'reject core.excludesFile',
      'reject partial/promisor',
      'reject sparse-worktree',
    ].join('\0'),
  ),
  metadataLayoutPolicyDigest: sha256Hex(
    [
      '.git is real directory',
      'no linked-worktree gitdir',
      'no commondir',
      'objects/refs contained',
      'config/HEAD/index are real regular files',
      'no alternates',
      'no grafts',
      'no info/attributes',
    ].join('\0'),
  ),
  indexPolicyDigest: sha256Hex(
    [
      'reject assume-unchanged',
      'reject skip-worktree',
      'reject sparse checkout',
      'reject split index',
      'core.ignorestat=false',
    ].join('\0'),
  ),
  objectStorePolicyDigest: sha256Hex(
    [
      'partial/promisor unsupported',
      'GIT_NO_LAZY_FETCH=1',
      'no alternates',
      'GIT_NO_REPLACE_OBJECTS=1',
      'no grafts',
      'no fetch/network/credential fallback',
    ].join('\0'),
  ),
}

export function goalGitSafetyProfileDigest(profile: GoalGitSafetyProfileV1): string {
  return sha256Hex(
    [
      GOAL_GIT_SAFETY_PROFILE_DOMAIN,
      String(profile.schemaVersion),
      profile.supportedGitVersions.map((r) => `${r.min}..${r.max}`).join(','),
      profile.fixedGlobalOptionsDigest,
      profile.safeEnvironmentDigest,
      profile.localConfigPolicyDigest,
      profile.metadataLayoutPolicyDigest,
      profile.indexPolicyDigest,
      profile.objectStorePolicyDigest,
    ].join('\n'),
  )
}

/**
 * Parses a Git version string into a comparable tuple. Returns null for
 * unexpected formats so the profile check fails closed.
 */
export function parseGitVersion(version: string): [number, number, number] | null {
  const match = version.trim().match(/^git version (\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  const major = Number.parseInt(match[1]!, 10)
  const minor = Number.parseInt(match[2]!, 10)
  const patch = Number.parseInt(match[3]!, 10)
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null
  return [major, minor, patch]
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i]! - right[i]!
  }
  return 0
}

export function isGitVersionSupported(
  version: string,
  profile: GoalGitSafetyProfileV1 = GOAL_GIT_SAFETY_PROFILE_V1,
): boolean {
  const parsed = parseGitVersion(version)
  if (!parsed) return false
  return profile.supportedGitVersions.some((range) => {
    const min = parseGitVersion(range.min)
    const max = parseGitVersion(range.max)
    if (!min || !max) return false
    return compareVersions(parsed, min) >= 0 && compareVersions(parsed, max) <= 0
  })
}
