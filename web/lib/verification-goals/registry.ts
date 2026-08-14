import {
  constants as fsConstants,
  type BigIntStats,
} from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import {
  lstat,
  open,
  realpath,
  type FileHandle,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { OperationDefinition } from '@/lib/operations/contracts'
import { OPERATION_CATALOG } from '@/lib/operations/catalog'
import type { ProjectExecutionRootBinding } from '@/lib/projects/local-path'
import {
  compareVerificationGoalStrings,
  parseVerificationGoalDefinition,
  verificationGoalDefinitionDigest,
  VerificationGoalContractError,
  type VerificationGoalDefinition,
} from './contracts'

export const VERIFICATION_GOAL_REGISTRY_PATH = '.forge/verification-goals' as const
export const MAX_VERIFICATION_GOAL_REGISTRY_FILES = 64
export const MAX_VERIFICATION_GOAL_FILE_BYTES = 32 * 1024
export const MAX_VERIFICATION_GOAL_REGISTRY_BYTES = 512 * 1024
export const MAX_VERIFICATION_GOAL_JSON_DEPTH = 4
export const MAX_VERIFICATION_GOAL_SOURCE_PATH_LENGTH = 256

const SAFE_REGISTRY_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/
const SUPPORTED_DIRECTORY_ANCHOR_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux'])
const execFileAsync = promisify(execFile)

export type LoadedVerificationGoal = {
  definition: VerificationGoalDefinition
  definitionDigest: string
  sourcePath: string
}

export class VerificationGoalRegistryError extends Error {
  readonly code:
    | 'invalid_registry'
    | 'registry_escape'
    | 'registry_limit'
    | 'invalid_file'
    | 'duplicate_goal'

  constructor(code: VerificationGoalRegistryError['code'], message: string) {
    super(message)
    this.name = 'VerificationGoalRegistryError'
    this.code = code
  }
}

type DirectoryLease = {
  handle: FileHandle
  path: string
  realPath: string
  stat: BigIntStats
}

type RegistrySnapshotEntry = {
  name: string
  bytesBase64: string
}

type RegistrySnapshot = {
  ok: true
  entries: RegistrySnapshotEntry[]
} | {
  ok: false
  reason: string
}

export type VerificationGoalRegistryTestHooks = {
  /** Runs after directory handles are pinned and before the anchored reader starts. */
  afterRegistryDirectoryAnchored?: () => Promise<void>
  /** Read-only child pauses after its initial sorted enumeration. */
  afterAnchoredEnumeration?: () => Promise<void>
  /** Read-only child pauses after the first captured file has been read. */
  afterFirstAnchoredEntryRead?: () => Promise<void>
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function assertJsonDepth(source: string, sourcePath: string): void {
  let depth = 0
  let inString = false
  let escaped = false
  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === '{' || character === '[') {
      depth += 1
      if (depth > MAX_VERIFICATION_GOAL_JSON_DEPTH) {
        throw new VerificationGoalRegistryError('registry_limit', `${sourcePath} exceeds the JSON nesting limit.`)
      }
    } else if (character === '}' || character === ']') {
      depth -= 1
      if (depth < 0) return
    }
  }
}

async function openDirectoryLease(
  directoryPath: string,
  expectedRealPath: string,
  expectedIdentity?: Pick<ProjectExecutionRootBinding, 'dev' | 'ino'>,
): Promise<DirectoryLease> {
  const before = await lstat(directoryPath, { bigint: true })
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new VerificationGoalRegistryError(
      'invalid_registry',
      'Verification goal registry path components must be real directories, not symlinks or special files.',
    )
  }
  let handle: FileHandle
  try {
    handle = await open(
      directoryPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
  } catch {
    throw new VerificationGoalRegistryError(
      'invalid_registry',
      'A verification goal registry path component could not be opened safely.',
    )
  }
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isDirectory()
      || !sameDirectorySnapshot(before, opened)
      || (expectedIdentity !== undefined
        && (opened.dev !== expectedIdentity.dev || opened.ino !== expectedIdentity.ino))
    ) {
      throw new VerificationGoalRegistryError(
        'invalid_registry',
        'A verification goal registry directory changed while it was being anchored.',
      )
    }
    const observedRealPath = await realpath(directoryPath)
    if (observedRealPath !== expectedRealPath) {
      throw new VerificationGoalRegistryError(
        'registry_escape',
        'A verification goal registry path component resolves outside its fixed location.',
      )
    }
    return { handle, path: directoryPath, realPath: observedRealPath, stat: opened }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function assertDirectoryLeaseStillFixed(lease: DirectoryLease): Promise<void> {
  const [opened, current, currentRealPath] = await Promise.all([
    lease.handle.stat({ bigint: true }),
    lstat(lease.path, { bigint: true }),
    realpath(lease.path),
  ])
  if (
    !opened.isDirectory()
    || current.isSymbolicLink()
    || !current.isDirectory()
    || !sameIdentity(lease.stat, opened)
    || !sameIdentity(lease.stat, current)
    || currentRealPath !== lease.realPath
  ) {
    throw new VerificationGoalRegistryError(
      'registry_escape',
      'The verification goal registry moved or was replaced while it was being read.',
    )
  }
}

async function assertRegistryLeaseStillFixed(lease: DirectoryLease): Promise<void> {
  await assertDirectoryLeaseStillFixed(lease)
  const opened = await lease.handle.stat({ bigint: true })
  if (!sameDirectorySnapshot(lease.stat, opened)) {
    throw new VerificationGoalRegistryError(
      'invalid_registry',
      'Verification goal registry membership changed while it was being read.',
    )
  }
}

// Node does not expose openat(2), and Darwin's /dev/fd directory descriptors
// cannot be traversed. This helper uses a child process whose cwd is a kernel
// reference after spawn resolves lease.path. The child verifies that cwd's
// dev/ino against the parent-held directory handle before any relative lookup,
// then opens only direct children with O_NOFOLLOW. Renaming or replacing the
// pathname cannot redirect those relative opens after the child has anchored.
const ANCHORED_REGISTRY_READER = String.raw`
const fs = require('node:fs')
const fsp = require('node:fs/promises')

const [
  expectedDev,
  expectedIno,
  maxFilesRaw,
  maxFileBytesRaw,
  maxTotalBytesRaw,
  checkpointPhase,
] = process.argv.slice(1)
const maxFiles = Number(maxFilesRaw)
const maxFileBytes = Number(maxFileBytesRaw)
const maxTotalBytes = Number(maxTotalBytesRaw)
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/

function fail(reason) {
  process.stdout.write(JSON.stringify({ ok: false, reason }))
}

function sameIdentity(stat) {
  return stat.dev.toString() === expectedDev && stat.ino.toString() === expectedIno
}

function sameDirectorySnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

async function checkpoint(phase) {
  if (checkpointPhase !== phase) return
  process.stderr.write('FORGE_REGISTRY_CHECKPOINT:' + phase + '\n')
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('checkpoint_timeout')), 10000)
    process.stdin.once('data', () => {
      clearTimeout(timeout)
      resolve()
    })
    process.stdin.once('end', () => {
      clearTimeout(timeout)
      reject(new Error('checkpoint_closed'))
    })
  })
}

async function captureEntry(name) {
  const beforePath = await fsp.lstat(name, { bigint: true })
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw new Error('invalid_entry')
  let handle
  try {
    handle = await fsp.open(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    throw new Error('invalid_entry')
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || !sameFileSnapshot(beforePath, before)) {
      throw new Error('entry_changed')
    }
    if (before.size > BigInt(maxFileBytes)) throw new Error('file_limit')
    const buffer = Buffer.alloc(maxFileBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > maxFileBytes) throw new Error('file_limit')
    const after = await handle.stat({ bigint: true })
    if (!sameFileSnapshot(before, after) || after.size !== BigInt(offset)) {
      throw new Error('entry_changed')
    }
    return { before, bytes: buffer.subarray(0, offset), handle, name }
  } catch (error) {
    await handle.close()
    throw error
  }
}

function entrySet(entries) {
  return entries.map((entry) => {
    const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other'
    return kind + ':' + entry.name
  })
}

async function main() {
  const directory = await fsp.stat('.', { bigint: true })
  if (!directory.isDirectory() || !sameIdentity(directory)) return fail('directory_identity')
  const entries = await fsp.readdir('.', { withFileTypes: true })
  if (entries.length > maxFiles) return fail('registry_limit')
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const initialEntrySet = entrySet(entries)
  await checkpoint('after_enumeration')

  let totalBytes = 0
  const captured = []
  try {
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !safeName.test(entry.name)) return fail('invalid_entry')
      const capture = await captureEntry(entry.name)
      captured.push(capture)
      totalBytes += capture.bytes.length
      if (totalBytes > maxTotalBytes) return fail('registry_limit')
      if (captured.length === 1) await checkpoint('after_first_read')
    }

    const entriesAfter = await fsp.readdir('.', { withFileTypes: true })
    entriesAfter.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    if (JSON.stringify(entrySet(entriesAfter)) !== JSON.stringify(initialEntrySet)) return fail('membership_changed')
    const directoryAfter = await fsp.stat('.', { bigint: true })
    if (!sameDirectorySnapshot(directory, directoryAfter)) return fail('membership_changed')

    for (const capture of captured) {
      const [openedAfter, pathAfter] = await Promise.all([
        capture.handle.stat({ bigint: true }),
        fsp.lstat(capture.name, { bigint: true }),
      ])
      if (!sameFileSnapshot(capture.before, openedAfter) || !sameFileSnapshot(capture.before, pathAfter)) {
        return fail('entry_changed')
      }
    }
    const snapshot = captured.map((capture) => ({
      name: capture.name,
      bytesBase64: capture.bytes.toString('base64'),
    }))
    process.stdout.write(JSON.stringify({ ok: true, entries: snapshot }))
  } finally {
    await Promise.allSettled(captured.map((capture) => capture.handle.close()))
  }
}

main().catch((error) => fail(error && typeof error.message === 'string' ? error.message : 'filesystem_error'))
`

function anchoredReaderArguments(lease: DirectoryLease, checkpointPhase = ''): string[] {
  return [
    '-e',
    ANCHORED_REGISTRY_READER,
    lease.stat.dev.toString(),
    lease.stat.ino.toString(),
    MAX_VERIFICATION_GOAL_REGISTRY_FILES.toString(),
    MAX_VERIFICATION_GOAL_FILE_BYTES.toString(),
    MAX_VERIFICATION_GOAL_REGISTRY_BYTES.toString(),
    checkpointPhase,
  ]
}

async function readWithCheckpoint(
  lease: DirectoryLease,
  phase: 'after_enumeration' | 'after_first_read',
  hook: () => Promise<void>,
): Promise<string> {
  const child = spawn(process.execPath, anchoredReaderArguments(lease, phase), {
    cwd: lease.path,
    env: { NODE_ENV: 'production' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout: Buffer[] = []
  let stdoutBytes = 0
  let stderr = ''
  let checkpointSeen = false
  let hookError: unknown
  let hookPromise: Promise<void> = Promise.resolve()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, 30_000)

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > 2 * 1024 * 1024) child.kill('SIGKILL')
    else stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
    if (stderr.length > 1_024) {
      child.kill('SIGKILL')
      return
    }
    if (!checkpointSeen && stderr.includes(`FORGE_REGISTRY_CHECKPOINT:${phase}\n`)) {
      checkpointSeen = true
      hookPromise = hook()
        .then(() => { child.stdin.end('continue\n') })
        .catch((error: unknown) => {
          hookError = error
          child.kill('SIGKILL')
        })
    }
  })

  let code: number | null
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    await hookPromise
  } finally {
    clearTimeout(timeout)
  }
  if (hookError) throw hookError
  if (timedOut || code !== 0 || !checkpointSeen || stdoutBytes > 2 * 1024 * 1024) {
    throw new Error('Anchored registry checkpoint reader failed.')
  }
  return Buffer.concat(stdout).toString('utf8')
}

async function readAnchoredRegistrySnapshot(
  lease: DirectoryLease,
  hooks: VerificationGoalRegistryTestHooks,
): Promise<RegistrySnapshotEntry[]> {
  let stdout: string | Buffer
  try {
    if (hooks.afterAnchoredEnumeration && hooks.afterFirstAnchoredEntryRead) {
      throw new Error('Only one anchored registry checkpoint may be used per test read.')
    }
    if (hooks.afterAnchoredEnumeration) {
      stdout = await readWithCheckpoint(lease, 'after_enumeration', hooks.afterAnchoredEnumeration)
    } else if (hooks.afterFirstAnchoredEntryRead) {
      stdout = await readWithCheckpoint(lease, 'after_first_read', hooks.afterFirstAnchoredEntryRead)
    } else {
      const result = await execFileAsync(process.execPath, anchoredReaderArguments(lease), {
        cwd: lease.path,
        encoding: 'utf8',
        env: { NODE_ENV: 'production' },
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      })
      stdout = result.stdout
    }
  } catch {
    throw new VerificationGoalRegistryError(
      'invalid_registry',
      'The verification goal registry could not be read through its directory anchor.',
    )
  }

  let payload: RegistrySnapshot
  try {
    payload = JSON.parse(stdout.toString()) as RegistrySnapshot
  } catch {
    throw new VerificationGoalRegistryError('invalid_registry', 'The anchored registry reader returned an invalid result.')
  }
  if (!payload.ok) {
    throw new VerificationGoalRegistryError(
      payload.reason === 'registry_limit' || payload.reason === 'file_limit'
        ? 'registry_limit'
        : 'invalid_file',
      payload.reason === 'directory_identity'
        ? 'The verification goal registry moved or was replaced before its anchored read.'
        : 'The verification goal registry contains an unsafe or changed entry.',
    )
  }
  if (!Array.isArray(payload.entries) || payload.entries.length > MAX_VERIFICATION_GOAL_REGISTRY_FILES) {
    throw new VerificationGoalRegistryError('invalid_registry', 'The anchored registry reader returned invalid entries.')
  }
  return payload.entries
}

async function parseRegistrySnapshot(
  snapshot: readonly RegistrySnapshotEntry[],
  catalog: ReadonlyMap<string, OperationDefinition>,
): Promise<LoadedVerificationGoal[]> {
  const loaded: LoadedVerificationGoal[] = []
  const goalIds = new Set<string>()
  let totalBytes = 0

  for (const entry of snapshot) {
    if (
      typeof entry.name !== 'string'
      || !SAFE_REGISTRY_FILE_NAME.test(entry.name)
      || typeof entry.bytesBase64 !== 'string'
    ) {
      throw new VerificationGoalRegistryError('invalid_registry', 'The anchored registry reader returned an invalid entry.')
    }
    const sourcePath = `${VERIFICATION_GOAL_REGISTRY_PATH}/${entry.name}`
    if (sourcePath.length > MAX_VERIFICATION_GOAL_SOURCE_PATH_LENGTH) {
      throw new VerificationGoalRegistryError('registry_limit', 'Verification goal source path exceeds the storage limit.')
    }
    const bytes = Buffer.from(entry.bytesBase64, 'base64')
    if (bytes.toString('base64') !== entry.bytesBase64 || bytes.length > MAX_VERIFICATION_GOAL_FILE_BYTES) {
      throw new VerificationGoalRegistryError('invalid_registry', 'The anchored registry reader returned invalid bytes.')
    }
    totalBytes += bytes.length
    if (totalBytes > MAX_VERIFICATION_GOAL_REGISTRY_BYTES) {
      throw new VerificationGoalRegistryError('registry_limit', 'The verification goal registry exceeds the total byte limit.')
    }
    const source = bytes.toString('utf8')
    if (!Buffer.from(source, 'utf8').equals(bytes)) {
      throw new VerificationGoalRegistryError('invalid_file', `${sourcePath} must contain valid UTF-8 JSON.`)
    }
    assertJsonDepth(source, sourcePath)

    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      throw new VerificationGoalRegistryError('invalid_file', `${sourcePath} contains malformed JSON.`)
    }
    const definition = parseVerificationGoalDefinition(parsed, catalog)
    if (goalIds.has(definition.goalId)) {
      throw new VerificationGoalRegistryError('duplicate_goal', `Verification goal ${definition.goalId} appears more than once in the registry.`)
    }
    goalIds.add(definition.goalId)
    loaded.push({
      definition,
      definitionDigest: verificationGoalDefinitionDigest(definition),
      sourcePath,
    })
  }

  return loaded.sort((left, right) => compareVerificationGoalStrings(
    left.definition.goalId,
    right.definition.goalId,
  ))
}

async function loadVerificationGoalRegistryInternal(
  projectRoot: ProjectExecutionRootBinding,
  catalog: ReadonlyMap<string, OperationDefinition>,
  hooks: VerificationGoalRegistryTestHooks = {},
): Promise<LoadedVerificationGoal[]> {
  if (!SUPPORTED_DIRECTORY_ANCHOR_PLATFORMS.has(process.platform)) {
    throw new VerificationGoalRegistryError(
      'invalid_registry',
      'Verification goal registry loading is unavailable on this platform because a safe directory anchor is not supported.',
    )
  }

  // The importer already returned a canonical, workspace-contained root and
  // the directory identity observed by that guard. Resolve syntax only:
  // re-running realpath here would follow a replacement during the handoff.
  const trustedProjectRoot = path.resolve(projectRoot.path)
  const projectLease = await openDirectoryLease(
    trustedProjectRoot,
    trustedProjectRoot,
    projectRoot,
  )
  let forgeLease: DirectoryLease | null = null
  let registryLease: DirectoryLease | null = null
  try {
    const forgePath = path.join(trustedProjectRoot, '.forge')
    try {
      forgeLease = await openDirectoryLease(forgePath, forgePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await assertDirectoryLeaseStillFixed(projectLease)
        return []
      }
      throw error
    }

    const registryPath = path.join(forgePath, 'verification-goals')
    try {
      registryLease = await openDirectoryLease(registryPath, registryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await Promise.all([
          assertDirectoryLeaseStillFixed(projectLease),
          assertDirectoryLeaseStillFixed(forgeLease),
        ])
        return []
      }
      throw error
    }

    await hooks.afterRegistryDirectoryAnchored?.()
    const snapshot = await readAnchoredRegistrySnapshot(registryLease, hooks)
    const loaded = await parseRegistrySnapshot(snapshot, catalog)
    await Promise.all([
      assertDirectoryLeaseStillFixed(projectLease),
      assertDirectoryLeaseStillFixed(forgeLease),
      assertRegistryLeaseStillFixed(registryLease),
    ])
    return loaded
  } finally {
    await Promise.allSettled([
      registryLease?.handle.close(),
      forgeLease?.handle.close(),
      projectLease.handle.close(),
    ])
  }
}

async function loadWithSafeErrorBoundary(
  projectRoot: ProjectExecutionRootBinding,
  catalog: ReadonlyMap<string, OperationDefinition>,
  hooks?: VerificationGoalRegistryTestHooks,
): Promise<LoadedVerificationGoal[]> {
  try {
    return await loadVerificationGoalRegistryInternal(projectRoot, catalog, hooks)
  } catch (error) {
    if (
      error instanceof VerificationGoalRegistryError
      || error instanceof VerificationGoalContractError
    ) {
      throw error
    }
    const code = typeof (error as NodeJS.ErrnoException)?.code === 'string'
      ? ` (${(error as NodeJS.ErrnoException).code})`
      : ''
    throw new VerificationGoalRegistryError(
      'invalid_registry',
      `The verification goal registry could not be read safely${code}.`,
    )
  }
}

export function loadVerificationGoalRegistry(
  projectRoot: ProjectExecutionRootBinding,
  catalog: ReadonlyMap<string, OperationDefinition> = OPERATION_CATALOG,
): Promise<LoadedVerificationGoal[]> {
  return loadWithSafeErrorBoundary(projectRoot, catalog)
}

/** Test-only seam for deterministic directory replacement races. */
export function loadVerificationGoalRegistryForTest(
  projectRoot: ProjectExecutionRootBinding,
  catalog: ReadonlyMap<string, OperationDefinition>,
  hooks: VerificationGoalRegistryTestHooks,
): Promise<LoadedVerificationGoal[]> {
  return loadWithSafeErrorBoundary(projectRoot, catalog, hooks)
}
