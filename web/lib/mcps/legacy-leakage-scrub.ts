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

type V2EventFieldValidator = (value: unknown) => boolean
type V2EventSchema = Readonly<{
  required: readonly string[]
  fields: Readonly<Record<string, V2EventFieldValidator>>
}>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s"'(`])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+[\\/])/u
const UNIX_ABSOLUTE_PATH = /(?:^|[\s"'(`])\/(?!\/)(?:[A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~!$&'()+,;=:@%-]+/u
const RELATIVE_TRAVERSAL = /(?:^|[\s"'(`])\.\.?[\\/][A-Za-z0-9._-]+/u
const SECRET_TEXT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*\S+|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,})/iu
const LOCATOR_TEXT = /(?:\b(?:https?|file|s3|gs|redis|rediss|postgres|postgresql|ssh):\/\/|\barn:aws:|\b(?:storage|host[_-]?resource|root|artifact|plan)[_-]?(?:locator|ref)\s*[:=])/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringContainsForbiddenEvidence(value: string, sentinels: readonly string[]): boolean {
  return sentinels.some((sentinel) => sentinel.length > 0 && value.includes(sentinel))
    || WINDOWS_ABSOLUTE_PATH.test(value)
    || UNIX_ABSOLUTE_PATH.test(value)
    || RELATIVE_TRAVERSAL.test(value)
    || SECRET_TEXT.test(value)
    || LOCATOR_TEXT.test(value)
}

function containsUnconditionalForbiddenEvidence(value: unknown, sentinels: readonly string[]): boolean {
  if (typeof value === 'string') return stringContainsForbiddenEvidence(value, sentinels)
  if (Array.isArray(value)) return value.some((item) => containsUnconditionalForbiddenEvidence(item, sentinels))
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, item]) => {
    const sensitiveKind = classifySensitivePayloadKey(key)
    if (sensitiveKind !== null && (item === null || isUnknownLegacyDigest(item))) return false
    if (sensitiveKind !== null) return true
    return containsUnconditionalForbiddenEvidence(item, sentinels)
  })
}

const uuid: V2EventFieldValidator = (value) => typeof value === 'string' && UUID.test(value)
const nullableUuid: V2EventFieldValidator = (value) => value === null || uuid(value)
const token: V2EventFieldValidator = (value) => typeof value === 'string' && SAFE_TOKEN.test(value)
const timestamp: V2EventFieldValidator = (value) => (
  typeof value === 'string'
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
)
const nonNegativeInteger: V2EventFieldValidator = (value) => Number.isSafeInteger(value) && Number(value) >= 0
const nullableNumber: V2EventFieldValidator = (value) => value === null || (typeof value === 'number' && Number.isFinite(value))
const boolean: V2EventFieldValidator = (value) => typeof value === 'boolean'
const nullableBoundedDigest: V2EventFieldValidator = (value) => value === null || isUnknownLegacyDigest(value)
const uuidArray: V2EventFieldValidator = (value) => Array.isArray(value) && value.length <= 256 && value.every(uuid)
const emptyArray: V2EventFieldValidator = (value) => Array.isArray(value) && value.length === 0

const V2_ARTIFACT_EVENT_SCHEMAS: readonly V2EventSchema[] = [
  {
    required: ['historyAvailable'],
    fields: { agentRunId: uuid, historyAvailable: (value) => value === true },
  },
  {
    required: ['agentRunId', 'artifactId', 'artifactType', 'createdAt'],
    // Ordinary artifacts remain available from the authenticated task-detail
    // route. Durable event history retains only a content-free notification.
    fields: { agentRunId: uuid, artifactId: uuid, artifactType: token, createdAt: timestamp, workPackageId: uuid },
  },
]

const V2_EVENT_SCHEMAS: Readonly<Record<string, V2EventSchema>> = {
  'approval_gate:created': {
    required: ['gateId', 'status', 'updatedAt', 'workPackageId'],
    fields: { gateId: uuid, gateType: token, requiredRole: token, status: token, updatedAt: timestamp, workPackageId: uuid },
  },
  'approval_gate:decided': {
    required: ['gateId', 'status', 'updatedAt', 'workPackageId'],
    fields: { decision: token, gateId: uuid, gateType: token, requiredRole: token, status: token, updatedAt: timestamp, workPackageId: uuid },
  },
  'questions:created': {
    required: ['questions'],
    // Prompt/question text is not an allowed durable v2-history field. An empty
    // array is the only safe notification shape.
    fields: { questions: emptyArray },
  },
  'run:completed': {
    required: ['runId'],
    fields: {
      attemptNumber: nonNegativeInteger, completedAt: timestamp, costUsd: nullableNumber,
      inputTokens: nullableNumber, outputTokens: nullableNumber, runId: uuid, stage: token,
      status: token, workPackageId: uuid,
    },
  },
  'run:failed': {
    required: ['runId'],
    fields: {
      attemptNumber: nonNegativeInteger, completedAt: timestamp, errorMessage: nullableBoundedDigest,
      runId: uuid, stage: token, workPackageId: uuid,
    },
  },
  'run:progress': {
    required: ['runId', 'outputBytes'],
    fields: { outputBytes: nonNegativeInteger, runId: uuid },
  },
  'run:started': {
    required: ['runId'],
    fields: {
      agentType: token, attemptNumber: nonNegativeInteger, modelIdUsed: token,
      runId: uuid, stage: token, startedAt: timestamp, workPackageId: uuid,
    },
  },
  'task:handoff': {
    required: ['status'],
    fields: {
      blockedReason: nullableBoundedDigest, claimedPackageId: nullableUuid, readyPackageIds: uuidArray,
      reviewBlockReason: nullableBoundedDigest, reviewStatus: token, status: token,
      taskDisposition: token, terminalBlock: boolean,
    },
  },
  'task:log': {
    required: ['id', 'eventType', 'level', 'sequence'],
    fields: {
      createdAt: timestamp, eventType: token, id: uuid, level: token, occurredAt: timestamp,
      sequence: nonNegativeInteger, source: token,
    },
  },
  'task:status': {
    required: ['status', 'updatedAt'],
    fields: { errorMessage: nullableBoundedDigest, status: token, updatedAt: timestamp },
  },
  'work_package:handoff': {
    required: ['runId', 'status', 'workPackageId'],
    fields: {
      assignedRole: token, harnessId: nullableUuid, hostRepositoryWrites: boolean,
      repositoryWrites: boolean, runId: uuid, sandboxWrites: boolean, stage: token,
      status: token, updatedAt: timestamp, workPackageId: uuid,
    },
  },
  'work_package:status': {
    required: ['status', 'workPackageId'],
    fields: {
      blockedReason: nullableBoundedDigest, status: token, updatedAt: timestamp, workPackageId: uuid,
    },
  },
}

function normalizedEventField(value: unknown): unknown {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : value
}

/**
 * Closed projection used only for durable v2 Redis history. Live SSE may keep
 * its richer sanitized payload, while replay deliberately carries enough
 * identity for the UI to refetch current state and no free-form text.
 */
export function projectV2TaskEventData(type: string, value: unknown): Record<string, unknown> | null {
  const source = isRecord(value) ? value : {}
  if (type === 'questions:created') return { questions: [] }
  if (type === 'artifact:created') {
    if (source.historyAvailable === true) {
      const projected = {
        ...(uuid(source.agentRunId) ? { agentRunId: source.agentRunId } : {}),
        historyAvailable: true,
      }
      return matchesClosedV2EventSchema(type, projected) ? projected : null
    }
    const artifactId = source.artifactId ?? source.id
    const projected = {
      ...(uuid(source.agentRunId) ? { agentRunId: source.agentRunId } : {}),
      ...(uuid(artifactId) ? { artifactId } : {}),
      ...(token(source.artifactType) ? { artifactType: source.artifactType } : {}),
      ...(timestamp(normalizedEventField(source.createdAt))
        ? { createdAt: normalizedEventField(source.createdAt) }
        : {}),
      ...(uuid(source.workPackageId) ? { workPackageId: source.workPackageId } : {}),
    }
    return matchesClosedV2EventSchema(type, projected) ? projected : null
  }

  const schema = V2_EVENT_SCHEMAS[type]
  if (!schema) return null
  const projected = Object.fromEntries(Object.entries(schema.fields).flatMap(([key, validate]) => {
    const candidate = normalizedEventField(source[key])
    return validate(candidate) ? [[key, candidate]] : []
  }))
  return matchesClosedV2EventSchema(type, projected) ? projected : null
}

function matchesClosedV2EventSchema(type: string, data: Record<string, unknown>): boolean {
  const schemas = type === 'artifact:created'
    ? V2_ARTIFACT_EVENT_SCHEMAS
    : V2_EVENT_SCHEMAS[type] ? [V2_EVENT_SCHEMAS[type]] : []
  return schemas.some((schema) => {
    const keys = Object.keys(data)
    if (keys.some((key) => !Object.hasOwn(schema.fields, key))) return false
    if (schema.required.some((key) => !Object.hasOwn(data, key))) return false
    return keys.every((key) => schema.fields[key](data[key]))
  })
}

/** A fixed structural allowlist for the persisted v2 Redis event envelope. */
export function containsForbiddenV2EventData(value: unknown, sentinels: readonly string[] = []): boolean {
  if (!isRecord(value)) return true
  const envelope = value
  if (Object.keys(envelope).some((key) => key !== 'type' && key !== 'data')) return true
  if (typeof envelope.type !== 'string' || !isRecord(envelope.data)) return true
  if (containsUnconditionalForbiddenEvidence(envelope.data, sentinels)) return true
  return !matchesClosedV2EventSchema(envelope.type, envelope.data)
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
