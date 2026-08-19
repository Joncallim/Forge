import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildSafeLaunchEnvironment,
  launchRootAnchoredCommand,
  RootCommandLauncherError,
} from '@/worker/verification-goals/root-command-launcher'
import type {
  TrustedExecutableIdentityV1,
} from '@/worker/verification-goals/trusted-executables'
import type {
  VerificationGoalFilesystemAuthority,
} from '@/worker/verification-goals/filesystem-authority'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}))

vi.mock('node:child_process', async () => ({
  execFile: mocks.execFile,
}))

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const ARGV = ['status', '--short'] as const

let tempRoots: string[] = []

async function createTempRoot(): Promise<{
  rootPath: string
  executablePath: string
  authority: VerificationGoalFilesystemAuthority
  executable: TrustedExecutableIdentityV1
}> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-vg-launcher-'))
  tempRoots.push(rootPath)
  const executablePath = path.join(rootPath, 'pinned-git')
  const content = '#!/bin/sh\necho ok\n'
  await fs.writeFile(executablePath, content)
  const [rootStat, exeStat] = await Promise.all([
    fs.stat(rootPath, { bigint: true }),
    fs.stat(executablePath, { bigint: true }),
  ])
  const contentDigest = createHash('sha256').update(content, 'utf8').digest('hex')
  return {
    rootPath,
    executablePath,
    authority: {
      projectId: PROJECT_ID,
      path: rootPath,
      dev: rootStat.dev,
      ino: rootStat.ino,
      rootBindingRevision: BigInt(7),
      grantDecisionRevision: BigInt(9),
      projectRevision: new Date('2026-08-15T00:00:00.000Z'),
    },
    executable: {
      schemaVersion: 1,
      kind: 'git',
      absoluteRealPath: executablePath,
      device: exeStat.dev,
      inode: exeStat.ino,
      contentDigest,
      normalizedVersion: 'git version 2.45.0',
    },
  }
}

async function launch(
  fixture: Awaited<ReturnType<typeof createTempRoot>>,
  overrides: Partial<Parameters<typeof launchRootAnchoredCommand>[0]> = {},
) {
  return launchRootAnchoredCommand({
    rootLease: fixture.authority,
    executable: fixture.executable,
    argv: ARGV,
    timeoutMs: 30_000,
    safeEnvironment: {},
    ...overrides,
  })
}

function execOptions() {
  return mocks.execFile.mock.calls[0]![2] as {
    cwd: string
    env: NodeJS.ProcessEnv
    timeout: number
    maxBuffer: number
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  await Promise.all(
    tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })),
  )
  tempRoots = []
})

describe('launchRootAnchoredCommand', () => {
  it('executes the pinned executable under the retained root descriptor and classifies exit 0', async () => {
    const fixture = await createTempRoot()
    mocks.execFile.mockImplementation(
      (file: string, args: readonly string[], options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
        callback(null, 'clean', 'noise')
      },
    )

    const result = await launch(fixture)

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: 'clean',
      stderr: 'noise',
      timedOut: false,
      spawnError: null,
    })
    expect(mocks.execFile).toHaveBeenCalledOnce()
    expect(mocks.execFile.mock.calls[0]![0]).toBe(fixture.executable.absoluteRealPath)
    expect(mocks.execFile.mock.calls[0]![1]).toEqual([...ARGV])
    const options = execOptions()
    expect(options.cwd).toMatch(/^\/dev\/fd\/\d+$/u)
    expect(options.timeout).toBe(30_000)
    expect(options.maxBuffer).toBe(1024 * 1024)
    expect(options.env).not.toHaveProperty('NODE_OPTIONS')
    expect(options.env).not.toHaveProperty('GIT_DIR')
  })

  it('classifies a numeric exit code as a run outcome, not a spawn failure', async () => {
    const fixture = await createTempRoot()
    mocks.execFile.mockImplementation(
      (file: string, args: readonly string[], options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) => {
        callback(Object.assign(new Error('exited'), { code: 7 }), 'dirty', '')
      },
    )

    const result = await launch(fixture)

    expect(result).toMatchObject({
      exitCode: 7,
      signal: null,
      timedOut: false,
      spawnError: null,
    })
  })

  it('never classifies a spawn-level ENOENT as exit 0', async () => {
    const fixture = await createTempRoot()
    mocks.execFile.mockImplementation(
      (file: string, args: readonly string[], options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) => {
        callback(Object.assign(new Error('spawn pinned-git ENOENT'), { code: 'ENOENT' }), '', '')
      },
    )

    const result = await launch(fixture)

    expect(result.exitCode).toBeNull()
    expect(result.spawnError).toEqual({ code: 'ENOENT', message: 'spawn pinned-git ENOENT' })
  })

  it('never classifies a bounded-output overflow as exit 0', async () => {
    const fixture = await createTempRoot()
    mocks.execFile.mockImplementation(
      (file: string, args: readonly string[], options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) => {
        callback(
          Object.assign(new Error('stdout maxBuffer length exceeded'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          }),
          '',
          '',
        )
      },
    )

    const result = await launch(fixture)

    expect(result.exitCode).toBeNull()
    expect(result.spawnError).toEqual({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      message: 'stdout maxBuffer length exceeded',
    })
  })

  it('classifies a process killed by our own deadline handling as a timeout', async () => {
    const fixture = await createTempRoot()
    mocks.execFile.mockImplementation(
      (file: string, args: readonly string[], options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) => {
        callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), 'partial', '')
      },
    )

    const result = await launch(fixture)

    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      spawnError: null,
    })
  })

  it('reports an externally signalled process as a signal outcome', async () => {
    const fixture = await createTempRoot()
    mocks.execFile.mockImplementation(
      (file: string, args: readonly string[], options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) => {
        callback(Object.assign(new Error('killed by signal'), { signal: 'SIGKILL' }), '', '')
      },
    )

    const result = await launch(fixture)

    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: false,
      spawnError: null,
    })
  })

  it('refuses to launch a pinned executable whose identity changed since startup', async () => {
    const fixture = await createTempRoot()
    mocks.execFile.mockImplementation(
      (file: string, args: readonly string[], options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
        callback(null, 'clean', '')
      },
    )
    await expect(launch(fixture)).resolves.toMatchObject({ exitCode: 0 })

    await fs.appendFile(fixture.executablePath, 'changed\n')

    await expect(launch(fixture)).rejects.toMatchObject({
      name: 'RootCommandLauncherError',
      code: 'executable_changed',
    })
    expect(mocks.execFile).toHaveBeenCalledOnce()
  })

  it('refuses to launch when the project root dev/ino no longer matches the retained authority', async () => {
    const fixture = await createTempRoot()
    const mismatched = launch(fixture, {
      rootLease: { ...fixture.authority, ino: fixture.authority.ino + BigInt(1) },
    })

    await expect(mismatched).rejects.toMatchObject({
      name: 'RootCommandLauncherError',
      code: 'root_changed',
    })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('strips node and git injection surfaces from the launch environment even when overrides try to set them', async () => {
    const fixture = await createTempRoot()
    mocks.execFile.mockImplementation(
      (file: string, args: readonly string[], options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
        callback(null, '', '')
      },
    )

    await launch(fixture, {
      safeEnvironment: {
        NODE_OPTIONS: '--inspect',
        NODE_PATH: '/tmp/evil-node-path',
        GIT_DIR: '/tmp/evil-git-dir',
        GIT_WORK_TREE: '/tmp/evil-work-tree',
        ALLOWED_MARKER: 'kept',
      },
    })

    const env = execOptions().env
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.ALLOWED_MARKER).toBe('kept')
  })

  it('rejects the launch with a typed cancelled error when the caller aborts', async () => {
    const fixture = await createTempRoot()
    const controller = new AbortController()
    const childKill = vi.fn()
    let markExecFileCalled: () => void = () => undefined
    const execFileCalled = new Promise<void>((resolve) => {
      markExecFileCalled = resolve
    })
    mocks.execFile.mockImplementation(() => {
      markExecFileCalled()
      return { kill: childKill }
    })

    const pending = launch(fixture, { abortSignal: controller.signal })
    const captured = pending.catch((error: unknown) => error)
    await execFileCalled
    controller.abort()

    const error = await captured
    expect(error).toBeInstanceOf(RootCommandLauncherError)
    expect(error).toMatchObject({ code: 'cancelled' })
  })
})

describe('buildSafeLaunchEnvironment', () => {
  it('builds a fixed environment from scratch without inheriting ambient state', () => {
    const env = buildSafeLaunchEnvironment({})

    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/tmp')
    expect(env.NODE_ENV).toBe('production')
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.GIT_DIR).toBeUndefined()
  })

  it('applies caller overrides for non-sensitive keys', () => {
    const env = buildSafeLaunchEnvironment({ CUSTOM_KEY: 'custom-value' })

    expect(env.CUSTOM_KEY).toBe('custom-value')
  })

  it('removes a default key when the override value is undefined', () => {
    const env = buildSafeLaunchEnvironment({ HOME: undefined })

    expect(env.HOME).toBeUndefined()
  })

  it('strips node and git injection surfaces regardless of overrides', () => {
    const env = buildSafeLaunchEnvironment({
      NODE_OPTIONS: '--inspect',
      NODE_PATH: '/tmp/node-path',
      NODE_REPL_HISTORY: '/tmp/history',
      GIT_DIR: '/tmp/git-dir',
      GIT_WORK_TREE: '/tmp/work-tree',
      GIT_COMMON_DIR: '/tmp/common-dir',
      GIT_OBJECT_DIRECTORY: '/tmp/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/tmp/alternates',
      GIT_INDEX_FILE: '/tmp/index',
    })

    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.NODE_REPL_HISTORY).toBeUndefined()
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_COMMON_DIR).toBeUndefined()
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined()
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
  })
})
