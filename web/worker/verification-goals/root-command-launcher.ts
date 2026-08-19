import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'

import type { TrustedExecutableIdentityV1 } from './trusted-executables'
import {
  revalidateTrustedExecutable,
  TrustedExecutableError,
} from './trusted-executables'
import type { VerificationGoalFilesystemAuthority } from './filesystem-authority'

export const ROOT_COMMAND_LAUNCHER_VERSION = 1 as const

/**
 * Immutable identity of the root-anchored launcher contract. Any change to the
 * root anchoring sequence, the revalidation requirement, the bounded output
 * handling, or the launch classification semantics must advance this digest;
 * it participates in run environment evidence.
 */
export const ROOT_COMMAND_LAUNCHER_CONTRACT_DIGEST = createHash('sha256')
  .update(
    'forge:verification-goal:root-command-launcher:v1\0'
    + 'open project root O_RDONLY|O_DIRECTORY|O_NOFOLLOW; verify expected dev/ino; '
    + 're-stat and re-digest the pinned executable before exec; '
    + 'execFile pinned absolute path only, no shell, no PATH lookup; '
    + 'cwd through the retained directory descriptor; bounded timeout; '
    + '1 MiB maxBuffer; spawn-level errors never classify as exit 0',
    'utf8',
  )
  .digest('hex')

export type RootCommandLaunchInput = {
  rootLease: VerificationGoalFilesystemAuthority
  executable: TrustedExecutableIdentityV1
  argv: readonly string[]
  timeoutMs: number
  abortSignal?: AbortSignal
  safeEnvironment: Record<string, string | undefined>
}

export type RootCommandLaunchResult = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  /**
   * Set when the child never ran to completion because of a spawn-level
   * failure (ENOENT, EACCES, STDIO_MAXBUFFER, ...). Such a failure must never
   * be mistaken for a successful exit.
   */
  spawnError: { code: string; message: string } | null
}

export class RootCommandLauncherError extends Error {
  readonly code:
    | 'root_changed'
    | 'executable_changed'
    | 'launch_failed'
    | 'timeout'
    | 'cancelled'

  constructor(code: RootCommandLauncherError['code'], message: string) {
    super(message)
    this.name = 'RootCommandLauncherError'
    this.code = code
  }
}

/**
 * Root-anchored command launcher for verification goal proof.
 *
 * Uses the trusted absolute executable identity and a retained directory handle.
 * Raw pathname `cwd` is forbidden; the launcher opens the project path with
 * O_RDONLY|O_DIRECTORY|O_NOFOLLOW, verifies the expected dev/ino, changes into
 * it, re-verifies, and only then starts the pinned executable.
 */
export async function launchRootAnchoredCommand(
  input: RootCommandLaunchInput,
): Promise<RootCommandLaunchResult> {
  const { execFile } = await import('node:child_process')
  const rootPath = input.rootLease.path
  const expectedDev = input.rootLease.dev
  const expectedIno = input.rootLease.ino

  // Re-verify the pinned executable identity (device, inode, content digest)
  // immediately before launch. The registry is captured at process startup; a
  // replacement since then must disable execution, never launch the new file.
  try {
    await revalidateTrustedExecutable(input.executable)
  } catch (error) {
    if (error instanceof TrustedExecutableError) {
      throw new RootCommandLauncherError(
        error.code === 'executable_changed' ? 'executable_changed' : 'launch_failed',
        error.message,
      )
    }
    throw new RootCommandLauncherError(
      'launch_failed',
      `Trusted executable could not be revalidated before launch: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let handle: fs.FileHandle
  try {
    handle = await fs.open(
      rootPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
  } catch (error) {
    throw new RootCommandLauncherError(
      'root_changed',
      `Could not open project root for execution: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    const opened = await handle.stat({ bigint: true })
    if (
      opened.dev !== expectedDev
      || opened.ino !== expectedIno
      || !opened.isDirectory()
    ) {
      throw new RootCommandLauncherError('root_changed', 'Project root dev/ino mismatch before launch.')
    }

    // Use the file descriptor path to avoid race-prone cwd strings.
    const fdPath = `/dev/fd/${handle.fd}`

    const launchPromise = new Promise<RootCommandLaunchResult>((resolve, reject) => {
      const child = execFile(
        input.executable.absoluteRealPath,
        [...input.argv],
        {
          cwd: fdPath,
          env: buildSafeLaunchEnvironment(input.safeEnvironment),
          timeout: input.timeoutMs,
          maxBuffer: 1024 * 1024,
        },
        (error: Error | null, stdout: string, stderr: string) => {
          const execError = error as (Error & {
            signal?: string | null
            code?: number | string | null
            killed?: boolean
          }) | null
          if (execError === null) {
            resolve({ exitCode: 0, signal: null, stdout, stderr, timedOut: false, spawnError: null })
            return
          }
          if (execError.killed === true) {
            // The child was killed by our own timeout/abort handling, not by an
            // external signal: a deadline outcome, never a launch failure.
            resolve({
              exitCode: null,
              signal: execError.signal ?? null,
              stdout,
              stderr,
              timedOut: true,
              spawnError: null,
            })
            return
          }
          if (typeof execError.code === 'number') {
            // The target ran and exited with a numeric status.
            resolve({
              exitCode: execError.code,
              signal: null,
              stdout,
              stderr,
              timedOut: false,
              spawnError: null,
            })
            return
          }
          if (typeof execError.signal === 'string') {
            // Externally signalled process: infrastructure failure.
            resolve({
              exitCode: null,
              signal: execError.signal,
              stdout,
              stderr,
              timedOut: false,
              spawnError: null,
            })
            return
          }
          // Spawn-level failure: ENOENT, EACCES, STDIO_MAXBUFFER, ... The
          // target never completed; classifying this as exit 0 would turn a
          // launch failure into a goal pass.
          resolve({
            exitCode: null,
            signal: null,
            stdout,
            stderr,
            timedOut: false,
            spawnError: {
              code: typeof execError.code === 'string' ? execError.code : 'UNKNOWN',
              message: execError.message,
            },
          })
        },
      )

      input.abortSignal?.addEventListener('abort', () => {
        child.kill('SIGTERM')
        reject(new RootCommandLauncherError('cancelled', 'Launch was aborted.'))
      })
    })
    // The outer `finally` closes the retained directory handle before this
    // function's own promise adopts the launch promise. If a caller aborts
    // during that tiny window, the launch rejection would briefly have no
    // observer and could trip a process-level unhandled-rejection policy.
    // This marker handler pins the launch promise as observed from creation;
    // callers still receive the rejection through their own await.
    void launchPromise.catch(() => undefined)
    return launchPromise
  } finally {
    await handle.close()
  }
}

export function buildSafeLaunchEnvironment(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  // Built from scratch: ambient GIT_* / Node injection surfaces never leak
  // into the launched child.
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp',
    XDG_CONFIG_HOME: '/tmp',
    NODE_ENV: 'production',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }
  // Strip Node injection surfaces regardless of overrides.
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.NODE_REPL_HISTORY
  // Git path redirections must never be inherited through overrides.
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_COMMON_DIR
  delete env.GIT_OBJECT_DIRECTORY
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  delete env.GIT_INDEX_FILE
  return env
}
