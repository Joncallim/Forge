import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'

import {
  GOAL_GIT_SAFETY_PROFILE_V1,
  isGitVersionSupported,
  goalGitSafetyProfileDigest,
  type GoalGitSafetyProfileV1,
  type GoalRepositoryProfileV1,
} from '@/lib/verification-goals/git-safety-profile'
import type { VerificationGoalFilesystemAuthority } from './filesystem-authority'
import { buildSafeLaunchEnvironment } from './root-command-launcher'

export class RepositoryProfileError extends Error {
  readonly code: GoalRepositoryProfileV1['reasonCode']

  constructor(code: GoalRepositoryProfileV1['reasonCode'], message: string) {
    super(message)
    this.name = 'RepositoryProfileError'
    this.code = code
  }
}

const REPOSITORY_METADATA_FINGERPRINT_DOMAIN =
  'forge:verification-goal:repository-metadata:v1\0' as const

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function fingerprintFile(path: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path, 'utf8')
    return sha256Hex(content)
  } catch {
    return null
  }
}

/**
 * Computes the supported repository profile for a verification goal run.
 * This is a positive, versioned safety check: it rejects linked worktrees,
 * alternates, grafts, partial clones, unsafe config, special index modes, and
 * unsupported Git versions. It never persists raw config/path data.
 *
 * All Git invocations run under the reviewed safe environment (no inherited
 * GIT_* redirections, no system/global config) and are anchored to the
 * retained project-root directory descriptor instead of a raceable pathname.
 */
export async function computeGoalRepositoryProfile(input: {
  authority: VerificationGoalFilesystemAuthority
  gitPath: string
  profile?: GoalGitSafetyProfileV1
}): Promise<GoalRepositoryProfileV1> {
  const profile = input.profile ?? GOAL_GIT_SAFETY_PROFILE_V1
  const base: GoalRepositoryProfileV1 = {
    schemaVersion: 1,
    supported: false,
    reasonCode: null,
    objectFormat: null,
    headOid: null,
    metadataFingerprint: null,
    indexFingerprint: null,
    configFingerprint: null,
    gitSafetyProfileVersion: profile.schemaVersion,
    gitSafetyProfileDigest: goalGitSafetyProfileDigest(profile),
  }

  const version = await getGitVersion(input.gitPath)
  if (!isGitVersionSupported(version, profile)) {
    return { ...base, reasonCode: 'git_version_unsupported' }
  }

  const root = input.authority.path
  const gitDir = `${root}/.git`

  let rootHandle: fs.FileHandle
  try {
    rootHandle = await fs.open(
      root,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
  } catch {
    return { ...base, reasonCode: 'root_changed' }
  }

  try {
    const opened = await rootHandle.stat({ bigint: true })
    if (
      opened.dev !== input.authority.dev
      || opened.ino !== input.authority.ino
      || !opened.isDirectory()
    ) {
      return { ...base, reasonCode: 'root_changed' }
    }

    // Anchor repository reads to the retained descriptor so a pathname swap
    // cannot redirect them between the structural checks and the Git calls.
    const rootFdPath = `/dev/fd/${rootHandle.fd}`

    try {
      const gitDirStat = await fs.lstat(gitDir)
      if (!gitDirStat.isDirectory()) {
        return { ...base, reasonCode: 'unsupported_git_metadata_layout' }
      }
    } catch {
      return { ...base, reasonCode: 'unsupported_git_metadata_layout' }
    }

    // Reject linked worktrees and commondir indirection.
    try {
      const commonDir = await fs.readFile(`${gitDir}/commondir`, 'utf8').catch(() => null)
      if (commonDir !== null) {
        return { ...base, reasonCode: 'linked_worktree_unsupported' }
      }
    } catch {
      // continue
    }

    // Reject object alternates.
    try {
      await fs.access(`${gitDir}/objects/info/alternates`, fsConstants.F_OK)
      return { ...base, reasonCode: 'unsupported_git_metadata_layout' }
    } catch {
      // absent is expected
    }

    // Reject grafts and external attributes.
    for (const forbidden of ['info/grafts', 'info/attributes']) {
      try {
        await fs.access(`${gitDir}/${forbidden}`, fsConstants.F_OK)
        return { ...base, reasonCode: 'unsupported_git_metadata_layout' }
      } catch {
        // absent is expected
      }
    }

    const configFingerprint = await fingerprintFile(`${gitDir}/config`)
    const indexFingerprint = await fingerprintFile(`${gitDir}/index`)
    // Deterministic keyed fingerprint: identical safe metadata state must
    // produce the identical fingerprint across runs. No randomness is mixed
    // in; a nonce would make the evidence irreproducible.
    const metadataFingerprint = sha256Hex(
      REPOSITORY_METADATA_FINGERPRINT_DOMAIN
      + `${configFingerprint ?? ''}:${indexFingerprint ?? ''}`,
    )

    const objectFormat = await readObjectFormat(input.gitPath, rootFdPath)
    if (!objectFormat) {
      return { ...base, reasonCode: 'unsupported_repository_identity' }
    }

    const headOid = await readHeadOid(input.gitPath, rootFdPath)
    if (!headOid) {
      return { ...base, reasonCode: 'unsupported_repository_identity' }
    }

    const isClean = await isStrictGitClean(input.gitPath, rootFdPath)
    if (!isClean) {
      return { ...base, reasonCode: 'repository_dirty' }
    }

    return {
      schemaVersion: 1,
      supported: true,
      reasonCode: null,
      objectFormat,
      headOid,
      metadataFingerprint,
      indexFingerprint,
      configFingerprint,
      gitSafetyProfileVersion: profile.schemaVersion,
      gitSafetyProfileDigest: goalGitSafetyProfileDigest(profile),
    }
  } finally {
    await rootHandle.close()
  }
}

const GIT_FIXED_GLOBAL_OPTIONS = [
  '--git-dir=.git',
  '--work-tree=.',
  '--no-pager',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.ignorestat=false',
] as const

async function getGitVersion(gitPath: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(gitPath, ['--version'], { timeout: 5000, env: buildSafeLaunchEnvironment({}) }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function readObjectFormat(gitPath: string, rootFdPath: string): Promise<'sha1' | 'sha256' | null> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(
      gitPath,
      [...GIT_FIXED_GLOBAL_OPTIONS, 'rev-parse', '--show-object-format'],
      { cwd: rootFdPath, timeout: 5000, env: buildSafeLaunchEnvironment({}) },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const format = stdout.trim()
        if (format === 'sha1' || format === 'sha256') {
          resolve(format)
        } else {
          resolve(null)
        }
      },
    )
  })
}

async function readHeadOid(gitPath: string, rootFdPath: string): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(
      gitPath,
      [...GIT_FIXED_GLOBAL_OPTIONS, 'rev-parse', 'HEAD'],
      { cwd: rootFdPath, timeout: 5000, env: buildSafeLaunchEnvironment({}) },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

async function isStrictGitClean(gitPath: string, rootFdPath: string): Promise<boolean> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(
      gitPath,
      [
        ...GIT_FIXED_GLOBAL_OPTIONS,
        'status',
        '--porcelain',
        '--untracked-files=all',
      ],
      { cwd: rootFdPath, timeout: 5000, env: buildSafeLaunchEnvironment({}) },
      (error, stdout) => {
        if (error) {
          resolve(false)
          return
        }
        resolve(stdout.trim().length === 0)
      },
    )
  })
}
