import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'

import type { TrustedExecutableIdentityV1 } from './trusted-executables'
import type { VerificationGoalFilesystemAuthority } from './filesystem-authority'

export const ROOT_COMMAND_LAUNCHER_VERSION = 1 as const

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
}

export class RootCommandLauncherError extends Error {
  readonly code:
    | 'root_changed'
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

    return new Promise((resolve, reject) => {
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
          const execError = error as { signal?: string | null; code?: number | string | null; killed?: boolean } | null
          if (execError?.signal === 'SIGTERM' || execError?.signal === 'SIGKILL') {
            resolve({ exitCode: null, signal: execError.signal ?? null, stdout, stderr, timedOut: false })
            return
          }
          if (execError?.killed) {
            resolve({ exitCode: null, signal: execError.signal ?? null, stdout, stderr, timedOut: true })
            return
          }
          const exitCode = execError?.code
          resolve({
            exitCode: typeof exitCode === 'number' ? exitCode : 0,
            signal: execError?.signal ?? null,
            stdout,
            stderr,
            timedOut: false,
          })
        },
      )

      input.abortSignal?.addEventListener('abort', () => {
        child.kill('SIGTERM')
        reject(new RootCommandLauncherError('cancelled', 'Launch was aborted.'))
      })
    })
  } finally {
    await handle.close()
  }
}

function buildSafeLaunchEnvironment(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp',
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
  return env
}
