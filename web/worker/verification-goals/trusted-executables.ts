import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'

export const TRUSTED_EXECUTABLE_REGISTRY_VERSION = 1 as const

export type TrustedExecutableKind = 'node' | 'git'

export type TrustedExecutableIdentityV1 = {
  schemaVersion: typeof TRUSTED_EXECUTABLE_REGISTRY_VERSION
  kind: TrustedExecutableKind
  absoluteRealPath: string
  device: bigint
  inode: bigint
  contentDigest: string
  normalizedVersion: string
}

export class TrustedExecutableError extends Error {
  readonly code:
    | 'untrusted_executable'
    | 'executable_unavailable'
    | 'executable_changed'
    | 'executable_inside_workspace'

  constructor(
    code: TrustedExecutableError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'TrustedExecutableError'
    this.code = code
  }
}

function sha256FileHex(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function statExecutable(path: string): Promise<{
  dev: bigint
  ino: bigint
  digest: string
}> {
  const stat = await fs.stat(path, { bigint: true })
  if (!stat.isFile()) {
    throw new TrustedExecutableError('executable_unavailable', `Trusted executable is not a file: ${path}`)
  }
  const digest = await sha256FileHex(path)
  return { dev: stat.dev, ino: stat.ino, digest }
}

/**
 * Resolves and pins the trusted Node and Git executables used by verification
 * goal proof runs. Project PATH cannot select these targets; the launcher uses
 * the pinned absolute identities.
 */
export type TrustedExecutableRegistryV1 = Readonly<{
  schemaVersion: typeof TRUSTED_EXECUTABLE_REGISTRY_VERSION
  node: TrustedExecutableIdentityV1
  git: TrustedExecutableIdentityV1
}>

export async function resolveTrustedExecutables(input: {
  nodePath: string
  gitPath: string
  workspaceRoots: readonly string[]
}): Promise<TrustedExecutableRegistryV1> {
  const [nodeStat, gitStat] = await Promise.all([
    statExecutable(input.nodePath),
    statExecutable(input.gitPath),
  ])

  for (const root of input.workspaceRoots) {
    const resolvedRoot = await fs.realpath(root)
    if (
      input.nodePath.startsWith(resolvedRoot + '/')
      || input.gitPath.startsWith(resolvedRoot + '/')
    ) {
      throw new TrustedExecutableError(
        'executable_inside_workspace',
        'Trusted executable must not reside inside a Forge workspace or project root.',
      )
    }
  }

  const nodeVersion = await getNodeVersion(input.nodePath)
  const gitVersion = await getGitVersion(input.gitPath)

  return {
    schemaVersion: TRUSTED_EXECUTABLE_REGISTRY_VERSION,
    node: {
      schemaVersion: TRUSTED_EXECUTABLE_REGISTRY_VERSION,
      kind: 'node',
      absoluteRealPath: input.nodePath,
      device: nodeStat.dev,
      inode: nodeStat.ino,
      contentDigest: nodeStat.digest,
      normalizedVersion: nodeVersion,
    },
    git: {
      schemaVersion: TRUSTED_EXECUTABLE_REGISTRY_VERSION,
      kind: 'git',
      absoluteRealPath: input.gitPath,
      device: gitStat.dev,
      inode: gitStat.ino,
      contentDigest: gitStat.digest,
      normalizedVersion: gitVersion,
    },
  }
}

async function getNodeVersion(nodePath: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(nodePath, ['--version'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        reject(new TrustedExecutableError('executable_unavailable', `Could not read Node version: ${error.message}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function getGitVersion(gitPath: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(gitPath, ['--version'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        reject(new TrustedExecutableError('executable_unavailable', `Could not read Git version: ${error.message}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

/**
 * Re-stat a previously pinned executable identity before launch. Mismatch
 * disables goal execution for the current process.
 */
export async function revalidateTrustedExecutable(
  identity: TrustedExecutableIdentityV1,
): Promise<void> {
  const current = await statExecutable(identity.absoluteRealPath)
  if (
    current.dev !== identity.device
    || current.ino !== identity.inode
    || current.digest !== identity.contentDigest
  ) {
    throw new TrustedExecutableError(
      'executable_changed',
      `Trusted executable ${identity.kind} identity changed since process startup.`,
    )
  }
}
