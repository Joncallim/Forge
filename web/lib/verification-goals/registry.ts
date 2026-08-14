import { constants as fsConstants, type Stats } from 'node:fs'
import {
  lstat,
  open,
  readdir,
  realpath,
} from 'node:fs/promises'
import path from 'node:path'

import type { OperationDefinition } from '@/lib/operations/contracts'
import { OPERATION_CATALOG } from '@/lib/operations/catalog'
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

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
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

async function readBoundedRegularFile(
  filePath: string,
  sourcePath: string,
  expectedStat: Stats,
): Promise<Buffer> {
  let handle
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    throw new VerificationGoalRegistryError(
      'invalid_file',
      `${sourcePath} could not be opened as a non-symlink registry file.`,
    )
  }
  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      throw new VerificationGoalRegistryError('invalid_file', `${sourcePath} must be a regular file.`)
    }
    if (
      expectedStat.dev !== before.dev
      || expectedStat.ino !== before.ino
      || expectedStat.size !== before.size
    ) {
      throw new VerificationGoalRegistryError('invalid_file', `${sourcePath} changed before it could be opened safely.`)
    }
    if (before.size > MAX_VERIFICATION_GOAL_FILE_BYTES) {
      throw new VerificationGoalRegistryError('registry_limit', `${sourcePath} exceeds the per-file byte limit.`)
    }

    const buffer = Buffer.alloc(MAX_VERIFICATION_GOAL_FILE_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_VERIFICATION_GOAL_FILE_BYTES) {
      throw new VerificationGoalRegistryError('registry_limit', `${sourcePath} grew beyond the per-file byte limit while being read.`)
    }
    const after = await handle.stat()
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || after.size !== offset
    ) {
      throw new VerificationGoalRegistryError('invalid_file', `${sourcePath} changed while the registry was being read.`)
    }
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/**
 * Reads the fixed, direct-child JSON registry. It returns no partial result:
 * every path and definition is validated before the sorted array is exposed.
 */
async function loadVerificationGoalRegistryInternal(
  projectRoot: string,
  catalog: ReadonlyMap<string, OperationDefinition> = OPERATION_CATALOG,
): Promise<LoadedVerificationGoal[]> {
  const trustedProjectRoot = await realpath(projectRoot)
  const registryPath = path.join(projectRoot, ...VERIFICATION_GOAL_REGISTRY_PATH.split('/'))

  let registryStat
  try {
    registryStat = await lstat(registryPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (registryStat.isSymbolicLink() || !registryStat.isDirectory()) {
    throw new VerificationGoalRegistryError('invalid_registry', 'The verification goal registry must be a real directory, not a symlink or special file.')
  }
  const trustedRegistryRoot = await realpath(registryPath)
  if (!isInside(trustedProjectRoot, trustedRegistryRoot)) {
    throw new VerificationGoalRegistryError('registry_escape', 'The verification goal registry resolves outside the trusted project root.')
  }

  const entries = await readdir(registryPath, { withFileTypes: true })
  if (entries.length > MAX_VERIFICATION_GOAL_REGISTRY_FILES) {
    throw new VerificationGoalRegistryError('registry_limit', 'The verification goal registry contains too many entries.')
  }

  const sortedEntries = entries.sort((left, right) => compareVerificationGoalStrings(left.name, right.name))
  const loaded: LoadedVerificationGoal[] = []
  const goalIds = new Set<string>()
  let totalBytes = 0

  for (const entry of sortedEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new VerificationGoalRegistryError('invalid_file', 'Verification goal registry entries must be direct-child regular JSON files.')
    }
    if (!SAFE_REGISTRY_FILE_NAME.test(entry.name)) {
      throw new VerificationGoalRegistryError('invalid_file', 'Verification goal registry filenames must be bounded safe direct-child .json names.')
    }

    const sourcePath = `${VERIFICATION_GOAL_REGISTRY_PATH}/${entry.name}`
    if (sourcePath.length > MAX_VERIFICATION_GOAL_SOURCE_PATH_LENGTH) {
      throw new VerificationGoalRegistryError('registry_limit', 'Verification goal source path exceeds the storage limit.')
    }
    const absoluteFilePath = path.join(registryPath, entry.name)
    const fileStat = await lstat(absoluteFilePath)
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new VerificationGoalRegistryError('invalid_file', `${sourcePath} must be a regular file and may not be a symlink.`)
    }
    const trustedFilePath = await realpath(absoluteFilePath)
    if (path.dirname(trustedFilePath) !== trustedRegistryRoot || !isInside(trustedRegistryRoot, trustedFilePath)) {
      throw new VerificationGoalRegistryError('registry_escape', `${sourcePath} resolves outside the fixed registry root.`)
    }

    const bytes = await readBoundedRegularFile(absoluteFilePath, sourcePath, fileStat)
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

export async function loadVerificationGoalRegistry(
  projectRoot: string,
  catalog: ReadonlyMap<string, OperationDefinition> = OPERATION_CATALOG,
): Promise<LoadedVerificationGoal[]> {
  try {
    return await loadVerificationGoalRegistryInternal(projectRoot, catalog)
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
