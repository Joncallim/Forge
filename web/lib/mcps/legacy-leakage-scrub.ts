import { createHash } from 'node:crypto'
import {
  LEGACY_TASK_LOG_UNAVAILABLE,
  classifySensitivePayloadKey,
  sanitizeSensitivePayload,
} from '@/lib/mcps/leakage-drain'

export const LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX = 'epic172:s4:legacy-leakage-scrub:v1:'
export const LEGACY_TASK_EVENT_PATTERNS = [
  'forge:task:*:history',
  'forge:task:*:seq',
] as const
export const V2_TASK_EVENT_HISTORY_PATTERN = 'forge:task-events:v2:*:history'

export type LegacyLeakageScrubPhase = 'task_logs' | 'artifacts' | 'redis_legacy' | 'redis_v2_verify' | 'complete'
export type LegacyLeakageScrubState = 'running' | 'paused_conflict' | 'complete'

export type LegacyTaskLogScrubRow = Readonly<{
  id: string
  kind: 'task_log'
  message: string
  frontMatter: Record<string, unknown>
  metadata: Record<string, unknown>
}>

export type LegacyArtifactScrubRow = Readonly<{
  id: string
  kind: 'artifact'
  content: string
  metadata: Record<string, unknown> | null
  replaceContent: boolean
}>

export type LegacyLeakageScrubRow = LegacyTaskLogScrubRow | LegacyArtifactScrubRow

export type LegacyLeakageScrubCheckpoint = Readonly<{
  schemaVersion: 1
  operationId: string
  actor: string
  authorizationReceiptId: string
  phase: LegacyLeakageScrubPhase
  state: LegacyLeakageScrubState
  lastKey: string | null
  rowsExamined: number
  rowsChanged: number
  conflicts: number
  redisKeysExamined: number
  redisKeysDeleted: number
  redisV2ValuesExamined: number
  lastPreFingerprint: string | null
  lastPostFingerprint: string | null
  databaseTime: string
}>

export type LoadedLegacyLeakageCheckpoint = Readonly<{
  checkpoint: LegacyLeakageScrubCheckpoint
  token: string
}>

export type RedisScanEvidence = Readonly<{
  complete: boolean
  keysExamined: number
  keysDeleted: number
  remainingKeys: number
  valuesExamined: number
  violations: number
}>

export interface LegacyLeakageScrubDatabase {
  databaseTime(): Promise<string>
  verifyDrainAuthorization(receiptId: string): Promise<boolean>
  loadCheckpoint(operationId: string): Promise<LoadedLegacyLeakageCheckpoint | null>
  createCheckpoint(checkpoint: LegacyLeakageScrubCheckpoint): Promise<LoadedLegacyLeakageCheckpoint | null>
  scanRows(
    phase: 'task_logs' | 'artifacts',
    afterId: string | null,
    limit: number,
  ): Promise<LegacyLeakageScrubRow[]>
  commitRow(input: Readonly<{
    current: LoadedLegacyLeakageCheckpoint
    expectedRowFingerprint: string
    nextCheckpoint: LegacyLeakageScrubCheckpoint
    row: LegacyLeakageScrubRow
  }>): Promise<'committed' | 'row_conflict' | 'checkpoint_conflict'>
  compareAndSetCheckpoint(
    current: LoadedLegacyLeakageCheckpoint,
    next: LegacyLeakageScrubCheckpoint,
  ): Promise<LoadedLegacyLeakageCheckpoint | null>
}

export interface LegacyLeakageScrubRedis {
  purgeLegacyTaskEventKeys(options: Readonly<{ apply: boolean }>): Promise<RedisScanEvidence>
  scanV2TaskEventHistory(sentinels: readonly string[]): Promise<RedisScanEvidence>
}

export type LegacyLeakageScrubMode = 'dry-run' | 'apply' | 'resume'

export type LegacyLeakageScrubOptions = Readonly<{
  actor: string
  authorizationReceiptId?: string
  batchSize?: number
  maxBatches?: number
  mode: LegacyLeakageScrubMode
  operationId?: string
  sentinels?: readonly string[]
}>

export type LegacyLeakageScrubResult = Readonly<{
  checkpoint: LegacyLeakageScrubCheckpoint | null
  dryRun: boolean
  preview: Readonly<{
    artifactRowsExamined: number
    artifactRowsChanged: number
    taskLogRowsExamined: number
    taskLogRowsChanged: number
    redis: RedisScanEvidence
    redisV2: RedisScanEvidence
  }> | null
}>

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function legacyLeakageRowFingerprint(row: LegacyLeakageScrubRow): string {
  const encoded = JSON.stringify(canonicalize(row))
  return createHash('sha256').update('forge:legacy-leakage-row:v1\0').update(encoded).digest('hex')
}

export function sanitizeLegacyLeakageRow(row: LegacyLeakageScrubRow): LegacyLeakageScrubRow {
  if (row.kind === 'task_log') {
    return {
      ...row,
      message: LEGACY_TASK_LOG_UNAVAILABLE,
      frontMatter: sanitizeSensitivePayload(row.frontMatter) as Record<string, unknown>,
      metadata: sanitizeSensitivePayload(row.metadata) as Record<string, unknown>,
    }
  }

  return {
    ...row,
    content: row.replaceContent ? LEGACY_TASK_LOG_UNAVAILABLE : row.content,
    metadata: row.metadata === null
      ? null
      : sanitizeSensitivePayload(row.metadata) as Record<string, unknown>,
  }
}

export function legacyLeakageRowChanged(row: LegacyLeakageScrubRow): boolean {
  return legacyLeakageRowFingerprint(row) !== legacyLeakageRowFingerprint(sanitizeLegacyLeakageRow(row))
}

export function containsForbiddenV2EventData(value: unknown, sentinels: readonly string[] = []): boolean {
  if (typeof value === 'string') {
    return sentinels.some((sentinel) => sentinel.length > 0 && value.includes(sentinel))
  }
  if (Array.isArray(value)) return value.some((item) => containsForbiddenV2EventData(item, sentinels))
  if (value === null || typeof value !== 'object') return false

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (classifySensitivePayloadKey(key) !== null) return true
    if (/^(?:path|paths|locator|storageLocator|selectedPath)$/i.test(key)) return true
    if (containsForbiddenV2EventData(item, sentinels)) return true
  }
  return false
}

function validateBoundedInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`)
  }
}

function validateIdentity(name: string, value: string | undefined): string {
  const normalized = value?.trim() ?? ''
  if (normalized.length < 1 || normalized.length > 200) {
    throw new Error(`${name} must be between 1 and 200 characters.`)
  }
  return normalized
}

function checkpointWith(
  checkpoint: LegacyLeakageScrubCheckpoint,
  changes: Partial<LegacyLeakageScrubCheckpoint>,
  databaseTime: string,
): LegacyLeakageScrubCheckpoint {
  return { ...checkpoint, ...changes, databaseTime }
}

async function moveCheckpoint(
  database: LegacyLeakageScrubDatabase,
  current: LoadedLegacyLeakageCheckpoint,
  changes: Partial<LegacyLeakageScrubCheckpoint>,
): Promise<LoadedLegacyLeakageCheckpoint> {
  const next = checkpointWith(current.checkpoint, changes, await database.databaseTime())
  const advanced = await database.compareAndSetCheckpoint(current, next)
  if (!advanced) throw new Error('Leakage scrub checkpoint changed concurrently; retry with --resume.')
  return advanced
}

async function dryRun(
  options: Required<Pick<LegacyLeakageScrubOptions, 'batchSize' | 'sentinels'>>,
  database: LegacyLeakageScrubDatabase,
  redis: LegacyLeakageScrubRedis,
): Promise<LegacyLeakageScrubResult> {
  const taskLogRows = await database.scanRows('task_logs', null, options.batchSize)
  const artifactRows = await database.scanRows('artifacts', null, options.batchSize)
  const redisEvidence = await redis.purgeLegacyTaskEventKeys({ apply: false })
  const redisV2Evidence = await redis.scanV2TaskEventHistory(options.sentinels)

  return {
    checkpoint: null,
    dryRun: true,
    preview: {
      artifactRowsExamined: artifactRows.length,
      artifactRowsChanged: artifactRows.filter(legacyLeakageRowChanged).length,
      taskLogRowsExamined: taskLogRows.length,
      taskLogRowsChanged: taskLogRows.filter(legacyLeakageRowChanged).length,
      redis: redisEvidence,
      redisV2: redisV2Evidence,
    },
  }
}

export async function runLegacyLeakageScrub(
  options: LegacyLeakageScrubOptions,
  dependencies: Readonly<{
    database: LegacyLeakageScrubDatabase
    redis: LegacyLeakageScrubRedis
  }>,
): Promise<LegacyLeakageScrubResult> {
  const actor = validateIdentity('actor', options.actor)
  const batchSize = options.batchSize ?? 100
  const maxBatches = options.maxBatches ?? 10
  const sentinels = options.sentinels ?? []
  validateBoundedInteger('batchSize', batchSize, 1_000)
  validateBoundedInteger('maxBatches', maxBatches, 1_000)

  if (options.mode === 'dry-run') {
    return dryRun({ batchSize, sentinels }, dependencies.database, dependencies.redis)
  }

  const operationId = validateIdentity('operationId', options.operationId)
  const authorizationReceiptId = validateIdentity('authorizationReceiptId', options.authorizationReceiptId)
  if (!await dependencies.database.verifyDrainAuthorization(authorizationReceiptId)) {
    throw new Error('The supplied authorization receipt is not an S4 producers-disabled receipt.')
  }

  let current = await dependencies.database.loadCheckpoint(operationId)
  if (options.mode === 'apply') {
    if (current) throw new Error('This operation already exists; use --resume.')
    const databaseTime = await dependencies.database.databaseTime()
    const initial: LegacyLeakageScrubCheckpoint = {
      schemaVersion: 1,
      operationId,
      actor,
      authorizationReceiptId,
      phase: 'task_logs',
      state: 'running',
      lastKey: null,
      rowsExamined: 0,
      rowsChanged: 0,
      conflicts: 0,
      redisKeysExamined: 0,
      redisKeysDeleted: 0,
      redisV2ValuesExamined: 0,
      lastPreFingerprint: null,
      lastPostFingerprint: null,
      databaseTime,
    }
    current = await dependencies.database.createCheckpoint(initial)
    if (!current) throw new Error('The leakage scrub operation was created concurrently; use --resume.')
  } else if (!current) {
    throw new Error('No checkpoint exists for this operation; start with --apply.')
  }

  if (current.checkpoint.actor !== actor || current.checkpoint.authorizationReceiptId !== authorizationReceiptId) {
    throw new Error('Actor and authorization receipt must match the original scrub operation.')
  }

  if (current.checkpoint.state === 'complete') {
    const legacy = await dependencies.redis.purgeLegacyTaskEventKeys({ apply: false })
    const v2 = await dependencies.redis.scanV2TaskEventHistory(sentinels)
    if (!legacy.complete || legacy.remainingKeys !== 0 || !v2.complete || v2.violations !== 0) {
      throw new Error('Completed leakage scrub verification failed; a legacy key or unsafe v2 value reappeared.')
    }
    return { checkpoint: current.checkpoint, dryRun: false, preview: null }
  }

  if (current.checkpoint.state === 'paused_conflict') {
    current = await moveCheckpoint(dependencies.database, current, { state: 'running' })
  }

  let batches = 0
  while (batches < maxBatches && current.checkpoint.phase !== 'complete') {
    const phase = current.checkpoint.phase
    if (phase === 'task_logs' || phase === 'artifacts') {
      const rows = await dependencies.database.scanRows(phase, current.checkpoint.lastKey, batchSize)
      batches += 1
      if (rows.length === 0) {
        current = await moveCheckpoint(dependencies.database, current, {
          phase: phase === 'task_logs' ? 'artifacts' : 'redis_legacy',
          lastKey: null,
          lastPreFingerprint: null,
          lastPostFingerprint: null,
        })
        continue
      }

      for (const row of rows) {
        const sanitized = sanitizeLegacyLeakageRow(row)
        const preFingerprint = legacyLeakageRowFingerprint(row)
        const postFingerprint = legacyLeakageRowFingerprint(sanitized)
        const changed = preFingerprint !== postFingerprint
        const nextCheckpoint = checkpointWith(current.checkpoint, {
          lastKey: row.id,
          rowsExamined: current.checkpoint.rowsExamined + 1,
          rowsChanged: current.checkpoint.rowsChanged + (changed ? 1 : 0),
          lastPreFingerprint: preFingerprint,
          lastPostFingerprint: postFingerprint,
        }, await dependencies.database.databaseTime())
        const outcome = await dependencies.database.commitRow({
          current,
          expectedRowFingerprint: preFingerprint,
          nextCheckpoint,
          row: sanitized,
        })
        if (outcome === 'checkpoint_conflict') {
          throw new Error('Leakage scrub checkpoint changed concurrently; retry with --resume.')
        }
        if (outcome === 'row_conflict') {
          const paused = await moveCheckpoint(dependencies.database, current, {
            conflicts: current.checkpoint.conflicts + 1,
            state: 'paused_conflict',
            lastPreFingerprint: preFingerprint,
            lastPostFingerprint: null,
          })
          return { checkpoint: paused.checkpoint, dryRun: false, preview: null }
        }
        current = { checkpoint: nextCheckpoint, token: JSON.stringify(nextCheckpoint) }
      }
      continue
    }

    if (phase === 'redis_legacy') {
      batches += 1
      const evidence = await dependencies.redis.purgeLegacyTaskEventKeys({ apply: true })
      if (!evidence.complete || evidence.remainingKeys !== 0) {
        current = await moveCheckpoint(dependencies.database, current, {
          state: 'paused_conflict',
          redisKeysExamined: current.checkpoint.redisKeysExamined + evidence.keysExamined,
          redisKeysDeleted: current.checkpoint.redisKeysDeleted + evidence.keysDeleted,
        })
        return { checkpoint: current.checkpoint, dryRun: false, preview: null }
      }
      current = await moveCheckpoint(dependencies.database, current, {
        phase: 'redis_v2_verify',
        redisKeysExamined: current.checkpoint.redisKeysExamined + evidence.keysExamined,
        redisKeysDeleted: current.checkpoint.redisKeysDeleted + evidence.keysDeleted,
      })
      continue
    }

    if (phase === 'redis_v2_verify') {
      batches += 1
      const evidence = await dependencies.redis.scanV2TaskEventHistory(sentinels)
      current = await moveCheckpoint(dependencies.database, current, {
        phase: evidence.complete && evidence.violations === 0 ? 'complete' : phase,
        state: evidence.complete && evidence.violations === 0 ? 'complete' : 'paused_conflict',
        redisV2ValuesExamined: current.checkpoint.redisV2ValuesExamined + evidence.valuesExamined,
      })
      return { checkpoint: current.checkpoint, dryRun: false, preview: null }
    }
  }

  return { checkpoint: current.checkpoint, dryRun: false, preview: null }
}
