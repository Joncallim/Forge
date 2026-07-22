import { createHash } from 'node:crypto'
import {
  LEGACY_TASK_LOG_UNAVAILABLE,
  classifySensitivePayloadKey,
  isUnknownLegacyDigest,
  sanitizeSensitivePayload,
} from '@/lib/mcps/leakage-drain'

export const LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX = 'epic172:s4:legacy-leakage-scrub:v1:'
export const LEGACY_TASK_EVENT_PATTERNS = [
  'forge:task:*:history',
  'forge:task:*:seq',
] as const
export const V2_TASK_EVENT_HISTORY_PATTERN = 'forge:task-events:v2:*:history'

export type LegacyLeakageScrubPhase =
  | 'task_logs'
  | 'artifacts'
  | 'work_packages'
  | 'redis_legacy'
  | 'redis_v2_verify'
  | 'complete'
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

export type LegacyWorkPackageScrubRow = Readonly<{
  id: string
  kind: 'work_package'
  metadata: Record<string, unknown>
}>

export type LegacyLeakageScrubRow =
  | LegacyTaskLogScrubRow
  | LegacyArtifactScrubRow
  | LegacyWorkPackageScrubRow

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

export type DatabaseScanEvidence = Readonly<{
  complete: boolean
  rowsExamined: number
  violations: number
}>

export interface LegacyLeakageScrubDatabase {
  databaseTime(): Promise<string>
  verifyDrainAuthorization(receiptId: string): Promise<boolean>
  loadCheckpoint(operationId: string): Promise<LoadedLegacyLeakageCheckpoint | null>
  createCheckpoint(checkpoint: LegacyLeakageScrubCheckpoint): Promise<LoadedLegacyLeakageCheckpoint | null>
  scanRows(
    phase: 'task_logs' | 'artifacts' | 'work_packages',
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
  authorizationReceiptId: string
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
    workPackageRowsExamined: number
    workPackageRowsChanged: number
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

  if (row.kind === 'artifact') return {
    ...row,
    content: row.replaceContent ? LEGACY_TASK_LOG_UNAVAILABLE : row.content,
    metadata: row.metadata === null
      ? null
      : sanitizeSensitivePayload(row.metadata) as Record<string, unknown>,
  }

  return {
    ...row,
    metadata: sanitizeSensitivePayload(row.metadata) as Record<string, unknown>,
  }
}

export function legacyLeakageRowChanged(row: LegacyLeakageScrubRow): boolean {
  return legacyLeakageRowFingerprint(row) !== legacyLeakageRowFingerprint(sanitizeLegacyLeakageRow(row))
}

const V2_EVENT_TYPES = new Set([
  'artifact:created',
  'approval_gate:created',
  'approval_gate:decided',
  'questions:created',
  'run:completed',
  'run:failed',
  'run:progress',
  'run:started',
  'task:handoff',
  'task:log',
  'task:status',
  'work_package:handoff',
  'work_package:status',
])

const V2_EVENT_DATA_KEYS = new Set([
  'agentRunId', 'agentType', 'artifactId', 'artifactType', 'assignedRole', 'attemptNumber',
  'blocked', 'blockedReason', 'capability', 'capabilityClass', 'checkedAt', 'claimedPackageId',
  'completedAt', 'costUsd', 'createdAt', 'decision', 'enabled', 'error', 'errorMessage',
  'eventType', 'gateId', 'gateType', 'health', 'historyAvailable', 'hostRepositoryWrites', 'id', 'inputTokens',
  'installState', 'level', 'maxAttempts', 'mcpBroker', 'mcpGrantBlock', 'mcpId', 'metadata',
  'mode', 'modelIdUsed', 'nextAttemptNumber', 'occurredAt', 'outputBytes', 'outputTokens',
  'primaryMode', 'primaryRecoveryAction', 'progress', 'readyPackageIds', 'repositoryWrites',
  'reviewBlockReason', 'reviewStatus', 'runId', 'sandboxWrites', 'sequence', 'source', 'stage',
  'staleRunningRecovery', 'status', 'taskDisposition', 'terminalBlock', 'timestamp', 'title',
  'type', 'updatedAt', 'warnings', 'workPackageId',
])

function containsForbiddenV2DataNode(value: unknown, sentinels: readonly string[]): boolean {
  if (typeof value === 'string') {
    return sentinels.some((sentinel) => sentinel.length > 0 && value.includes(sentinel))
  }
  if (Array.isArray(value)) return value.some((item) => containsForbiddenV2DataNode(item, sentinels))
  if (value === null || typeof value !== 'object') return false

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!V2_EVENT_DATA_KEYS.has(key)) return true
    const sensitiveKind = classifySensitivePayloadKey(key)
    if (sensitiveKind === 'snapshot' && isUnknownLegacyDigest(item)) continue
    if (sensitiveKind !== null) return true
    if (containsForbiddenV2DataNode(item, sentinels)) return true
  }
  return false
}

/** A fixed structural allowlist for the persisted v2 Redis event envelope. */
export function containsForbiddenV2EventData(value: unknown, sentinels: readonly string[] = []): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).some((key) => key !== 'type' && key !== 'data')) return true
  if (typeof envelope.type !== 'string' || !V2_EVENT_TYPES.has(envelope.type)) return true
  if (envelope.data === null || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) return true
  return containsForbiddenV2DataNode(envelope.data, sentinels)
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
  const workPackageRows = await database.scanRows('work_packages', null, options.batchSize)
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
      workPackageRowsExamined: workPackageRows.length,
      workPackageRowsChanged: workPackageRows.filter(legacyLeakageRowChanged).length,
      redis: redisEvidence,
      redisV2: redisV2Evidence,
    },
  }
}

const MAX_FINAL_DATABASE_SCAN_BATCHES = 10_000

async function scanDatabaseForLeakage(
  database: LegacyLeakageScrubDatabase,
  batchSize: number,
): Promise<DatabaseScanEvidence> {
  let rowsExamined = 0
  let violations = 0
  let batches = 0
  for (const phase of ['task_logs', 'artifacts', 'work_packages'] as const) {
    let afterId: string | null = null
    while (batches < MAX_FINAL_DATABASE_SCAN_BATCHES) {
      const rows = await database.scanRows(phase, afterId, batchSize)
      batches += 1
      rowsExamined += rows.length
      violations += rows.filter(legacyLeakageRowChanged).length
      if (rows.length === 0) break
      afterId = rows.at(-1)?.id ?? null
    }
    if (batches >= MAX_FINAL_DATABASE_SCAN_BATCHES) {
      return { complete: false, rowsExamined, violations }
    }
  }
  return { complete: true, rowsExamined, violations }
}

async function finalZeroScan(
  database: LegacyLeakageScrubDatabase,
  redis: LegacyLeakageScrubRedis,
  batchSize: number,
  sentinels: readonly string[],
): Promise<Readonly<{ database: DatabaseScanEvidence; legacy: RedisScanEvidence; v2: RedisScanEvidence }>> {
  const databaseEvidence = await scanDatabaseForLeakage(database, batchSize)
  const legacy = await redis.purgeLegacyTaskEventKeys({ apply: false })
  const v2 = await redis.scanV2TaskEventHistory(sentinels)
  return { database: databaseEvidence, legacy, v2 }
}

function zeroScanPassed(evidence: Awaited<ReturnType<typeof finalZeroScan>>): boolean {
  return evidence.database.complete
    && evidence.database.violations === 0
    && evidence.legacy.complete
    && evidence.legacy.remainingKeys === 0
    && evidence.v2.complete
    && evidence.v2.violations === 0
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

  const authorizationReceiptId = validateIdentity('authorizationReceiptId', options.authorizationReceiptId)
  if (!await dependencies.database.verifyDrainAuthorization(authorizationReceiptId)) {
    throw new Error('The supplied authorization receipt does not satisfy the fixed S4 producers-disabled drain contract.')
  }

  if (options.mode === 'dry-run') {
    return dryRun({ batchSize, sentinels }, dependencies.database, dependencies.redis)
  }

  const operationId = validateIdentity('operationId', options.operationId)
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
    const final = await finalZeroScan(dependencies.database, dependencies.redis, batchSize, sentinels)
    if (!zeroScanPassed(final)) {
      throw new Error('Completed leakage scrub verification failed; database or Redis leakage reappeared.')
    }
    return { checkpoint: current.checkpoint, dryRun: false, preview: null }
  }

  if (current.checkpoint.state === 'paused_conflict') {
    current = await moveCheckpoint(dependencies.database, current, { state: 'running' })
  }

  let batches = 0
  while (batches < maxBatches && current.checkpoint.phase !== 'complete') {
    const phase = current.checkpoint.phase
    if (phase === 'task_logs' || phase === 'artifacts' || phase === 'work_packages') {
      const rows = await dependencies.database.scanRows(phase, current.checkpoint.lastKey, batchSize)
      batches += 1
      if (rows.length === 0) {
        current = await moveCheckpoint(dependencies.database, current, {
          phase: phase === 'task_logs'
            ? 'artifacts'
            : phase === 'artifacts'
              ? 'work_packages'
              : 'redis_legacy',
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
      const final = await finalZeroScan(dependencies.database, dependencies.redis, batchSize, sentinels)
      const passed = zeroScanPassed(final)
      const retryPhase: LegacyLeakageScrubPhase = !final.database.complete || final.database.violations > 0
        ? 'task_logs'
        : !final.legacy.complete || final.legacy.remainingKeys > 0
          ? 'redis_legacy'
          : 'redis_v2_verify'
      current = await moveCheckpoint(dependencies.database, current, {
        phase: passed ? 'complete' : retryPhase,
        state: passed ? 'complete' : 'paused_conflict',
        lastKey: null,
        redisKeysExamined: current.checkpoint.redisKeysExamined + final.legacy.keysExamined,
        redisV2ValuesExamined: current.checkpoint.redisV2ValuesExamined + final.v2.valuesExamined,
      })
      return { checkpoint: current.checkpoint, dryRun: false, preview: null }
    }
  }

  return { checkpoint: current.checkpoint, dryRun: false, preview: null }
}
