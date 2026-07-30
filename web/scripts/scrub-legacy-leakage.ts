import { pathToFileURL } from 'node:url'
import Redis from 'ioredis'
import postgres from 'postgres'
import { getRequiredEnv } from '../lib/env'
import { scanJsonObjectKeys } from '../lib/json-object-key-scan'
import { ARCHITECT_PLAN_HEADER } from '../lib/mcps/architect-plan-entries'
import {
  LEGACY_TASK_EVENT_STORAGE_PATTERN,
  TASK_EVENT_V2_STORAGE_PATTERN,
  parseLegacyTaskEventStorageKey,
  parseV2TaskEventStorageKey,
  taskEventRedisKeys,
} from '../lib/task-event-redis'
import {
  LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX,
  containsForbiddenV2EventData,
  legacyLeakageRowFingerprint,
  runLegacyLeakageScrub,
  type LegacyLeakageScrubCheckpoint,
  type LegacyLeakageScrubDatabase,
  type LegacyLeakageScrubMode,
  type LegacyLeakageScrubRedis,
  type LegacyLeakageScrubRow,
  type RedisScanEvidence,
} from '../lib/mcps/legacy-leakage-scrub'

const MAX_REDIS_SCAN_ITERATIONS = 10_000

export type LegacyLeakageScrubCli = Readonly<{
  actor: string
  authorizationReceiptId: string
  batchSize: number
  maxBatches: number
  mode: LegacyLeakageScrubMode
  operationId?: string
  sentinels: readonly string[]
}>

function requiredFingerprintKey(): Buffer {
  const encoded = process.env.FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY?.trim()
  if (!encoded) throw new Error('FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY is required.')
  const key = /^[0-9a-f]{64}$/iu.test(encoded)
    ? Buffer.from(encoded, 'hex')
    : Buffer.from(encoded, 'base64')
  if (key.length !== 32) {
    throw new Error('FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY must encode exactly 32 bytes.')
  }
  return key
}

function requiredFingerprintKeyId(): string {
  const keyId = process.env.FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY_ID?.trim()
  if (!keyId) throw new Error('FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY_ID is required.')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(keyId)) {
    throw new Error('FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY_ID must be a bounded non-secret key identifier.')
  }
  return keyId
}

export function legacyLeakageScrubUsage(): string {
  return `Legacy task-log, artifact, and Redis leakage scrub

Dry-run (read-only):
  npm run protocol:scrub-legacy-leakage -- --actor OPERATOR \\
    --authorization-receipt RECEIPT_ID

First apply (requires the signed S4 producers-disabled receipt):
  npm run protocol:scrub-legacy-leakage -- --actor OPERATOR --apply \\
    --operation OPERATION_ID --authorization-receipt RECEIPT_ID

Resume the same bounded operation:
  npm run protocol:scrub-legacy-leakage -- --actor OPERATOR --resume \\
    --operation OPERATION_ID --authorization-receipt RECEIPT_ID

Options:
  --batch-size N       Rows read per database phase (default 100, maximum 1000)
  --max-batches N      Phase batches processed per invocation (default 10, maximum 1000)
  --sentinel TEXT      Fail the v2 Redis scan if TEXT appears; may be repeated

Database mutation inventory: task_logs; eligible, unversioned legacy Architect
artifacts; work_packages; approval_gates; and the operation-scoped app_settings
checkpoint key (${LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX}<operation-id>).
Redis is separate: apply/resume purge only legacy forge:task:*:history and
forge:task:*:seq keys and exhaustively validate (but never delete) stored v2
forge:task-events:v2:* keys. Protected Architect plan entries are
never selected or updated.

Environment:
  FORGE_DATABASE_ADMIN_URL  privileged PostgreSQL connection for the scrub
  REDIS_URL                 Redis connection whose legacy task history is purged
  FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY
                            dedicated 32-byte server-private HMAC key
  FORGE_LEGACY_LEAKAGE_SCRUB_FINGERPRINT_KEY_ID
                            bounded non-secret key identifier`
}

function positiveInteger(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`)
  return parsed
}

export function parseLegacyLeakageScrubArgs(argv: readonly string[]): LegacyLeakageScrubCli {
  if (argv.includes('--help') || argv.includes('-h')) throw new Error(legacyLeakageScrubUsage())
  let mode: LegacyLeakageScrubMode = 'dry-run'
  let actor = ''
  let authorizationReceiptId: string | undefined
  let operationId: string | undefined
  let batchSizeValue: string | undefined
  let maxBatchesValue: string | undefined
  const sentinels: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--apply' || flag === '--resume') {
      if (mode !== 'dry-run') throw new Error('Choose only one of --apply or --resume.')
      mode = flag === '--apply' ? 'apply' : 'resume'
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`)
    index += 1
    if (flag === '--actor') actor = value
    else if (flag === '--authorization-receipt') authorizationReceiptId = value
    else if (flag === '--operation') operationId = value
    else if (flag === '--batch-size') batchSizeValue = value
    else if (flag === '--max-batches') maxBatchesValue = value
    else if (flag === '--sentinel') sentinels.push(value)
    else throw new Error(`Unknown option: ${flag}`)
  }

  if (actor.trim() === '') throw new Error(`--actor is required.\n\n${legacyLeakageScrubUsage()}`)
  if (!authorizationReceiptId) {
    throw new Error('--authorization-receipt is required for dry-run, apply, and resume.')
  }
  if (mode !== 'dry-run' && !operationId) {
    throw new Error('--operation is required for apply and resume.')
  }

  return {
    actor,
    authorizationReceiptId,
    batchSize: positiveInteger('--batch-size', batchSizeValue, 100),
    maxBatches: positiveInteger('--max-batches', maxBatchesValue, 10),
    mode,
    operationId,
    sentinels,
  }
}

function checkpointKey(operationId: string): string {
  return `${LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX}${operationId}`
}

function requiredAdminDatabaseUrl(): string {
  const value = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!value) {
    throw new Error(
      'FORGE_DATABASE_ADMIN_URL is required; the ordinary Forge application database role must not run the leakage scrub.',
    )
  }
  return value
}

export function parseLegacyLeakageScrubCheckpoint(value: string): LegacyLeakageScrubCheckpoint {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Stored leakage scrub checkpoint is malformed; start a new --apply operation.')
  }
  if (!isCheckpointRecord(parsed)) {
    throw new Error('Stored leakage scrub checkpoint is malformed; start a new --apply operation.')
  }
  if (parsed.schemaVersion === 1) {
    throw new Error('Stored leakage scrub checkpoint uses an unsafe legacy format; start a new --apply operation.')
  }
  if (parsed.schemaVersion !== 2 || !isClosedCheckpointRecord(parsed)) {
    throw new Error('Stored leakage scrub checkpoint is malformed; start a new --apply operation.')
  }
  if (!isValidCheckpointV2(parsed)) {
    throw new Error('Stored leakage scrub checkpoint is malformed; start a new --apply operation.')
  }
  return parsed
}

const CHECKPOINT_V2_KEYS = [
  'schemaVersion', 'operationId', 'actor', 'authorizationReceiptId', 'fingerprintKeyId', 'sentinelSetFingerprint',
  'phase', 'state', 'lastKey', 'rowsExamined', 'rowsChanged', 'conflicts', 'redisKeysExamined', 'redisKeysDeleted',
  'redisV2ValuesExamined', 'lastPreFingerprint', 'lastPostFingerprint', 'databaseTime',
] as const
const CHECKPOINT_PHASES = new Set(['task_logs', 'artifacts', 'work_packages', 'approval_gates', 'redis_legacy', 'redis_v2_verify', 'complete'])
const CHECKPOINT_STATES = new Set(['running', 'paused_conflict', 'complete'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const HEX_FINGERPRINT = /^[0-9a-f]{64}$/iu

function isCheckpointRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
}

function isClosedCheckpointRecord(value: unknown): value is Record<string, unknown> {
  return isCheckpointRecord(value)
    && Object.keys(value).length === CHECKPOINT_V2_KEYS.length
    && Object.keys(value).every((key) => (CHECKPOINT_V2_KEYS as readonly string[]).includes(key))
}

function isBoundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && value.trim() === value
}

function isNullableFingerprint(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && HEX_FINGERPRINT.test(value))
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isValidCheckpointV2(value: Record<string, unknown>): value is LegacyLeakageScrubCheckpoint {
  const phase = value.phase
  const state = value.state
  const timestamp = value.databaseTime
  const counters = ['rowsExamined', 'rowsChanged', 'conflicts', 'redisKeysExamined', 'redisKeysDeleted', 'redisV2ValuesExamined']
  return value.schemaVersion === 2
    && isBoundedIdentity(value.operationId)
    && isBoundedIdentity(value.actor)
    && typeof value.authorizationReceiptId === 'string' && UUID.test(value.authorizationReceiptId)
    && typeof value.fingerprintKeyId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.fingerprintKeyId)
    && typeof value.sentinelSetFingerprint === 'string' && HEX_FINGERPRINT.test(value.sentinelSetFingerprint)
    && typeof phase === 'string' && CHECKPOINT_PHASES.has(phase)
    && typeof state === 'string' && CHECKPOINT_STATES.has(state)
    && ((phase === 'complete') === (state === 'complete'))
    && (value.lastKey === null || (typeof value.lastKey === 'string' && UUID.test(value.lastKey)))
    && isNullableFingerprint(value.lastPreFingerprint)
    && isNullableFingerprint(value.lastPostFingerprint)
    && counters.every((counter) => isNonNegativeSafeInteger(value[counter]))
    && (value.rowsChanged as number) <= (value.rowsExamined as number)
    && (value.redisKeysDeleted as number) <= (value.redisKeysExamined as number)
    && (phase !== 'complete' || value.lastKey === null)
    && typeof timestamp === 'string'
    && timestamp.length >= 1
    && timestamp.length <= 128
    && timestamp.trim() === timestamp
    && Number.isFinite(Date.parse(timestamp))
}

function taskLogRow(row: Record<string, unknown>): LegacyLeakageScrubRow {
  return {
    id: String(row.id),
    kind: 'task_log',
    message: String(row.message),
    frontMatter: row.frontMatter as Record<string, unknown>,
    metadata: row.metadata as Record<string, unknown>,
  }
}

function artifactRow(row: Record<string, unknown>): LegacyLeakageScrubRow {
  return {
    id: String(row.id),
    kind: 'artifact',
    content: String(row.content),
    metadata: row.metadata as Record<string, unknown> | null,
    replaceContent: row.replaceContent === true,
  }
}

function workPackageRow(row: Record<string, unknown>): LegacyLeakageScrubRow {
  return {
    id: String(row.id),
    kind: 'work_package',
    metadata: row.metadata as Record<string, unknown>,
  }
}

function approvalGateRow(row: Record<string, unknown>): LegacyLeakageScrubRow {
  return {
    id: String(row.id),
    kind: 'approval_gate',
    metadata: row.metadata as Record<string, unknown>,
  }
}

export function createLegacyLeakagePostgresAdapter(
  sql: ReturnType<typeof postgres>,
  fingerprintKey: Buffer,
): LegacyLeakageScrubDatabase {
  return {
    async databaseTime() {
      const [row] = await sql<{ databaseTime: string }[]>`
        select clock_timestamp()::text as "databaseTime"
      `
      return row.databaseTime
    },

    async verifyDrainAuthorization(receiptId) {
      const rows = await sql`
        select receipt.id
        from forge_epic_172_release_evidence receipt
        join forge_epic_172_release_evidence predecessor
          on receipt.predecessor_receipt_ids = jsonb_build_array(predecessor.id::text)
        join forge_epic_172_enablement_state enablement
          on enablement.singleton_id = 'epic-172'
        where receipt.id::text = ${receiptId}
          and receipt.manifest_version = 1
          and receipt.evidence_kind = 's4_producers_disabled'
          and receipt.owner_issue = 179
          and receipt.owner_slice = 's4'
          and jsonb_typeof(receipt.exact_builds) = 'array'
          and jsonb_array_length(receipt.exact_builds) > 0
          and receipt.reviewed_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
          and receipt.epoch is null
          and receipt.signature_domain = 'forge:epic-172-release-evidence:v1'
          and receipt.envelope_version = 1
          and receipt.envelope_digest ~ '^[0-9a-f]{64}$'
          and octet_length(receipt.detached_signature) = 64
          and predecessor.evidence_kind = 's4_expand'
          and predecessor.owner_issue = 179
          and predecessor.owner_slice = 's4'
          and predecessor.exact_builds = receipt.exact_builds
          and predecessor.reviewed_sha = receipt.reviewed_sha
          and predecessor.epoch is not distinct from receipt.epoch
          and enablement.state = 'disabled'
          and (
            select array_agg(claim.value ->> 'name' order by claim.ordinal)
            from jsonb_array_elements(receipt.required_evidence)
              with ordinality as claim(value, ordinal)
          ) = array[
            's4_expand_receipt',
            'legacy_credentials_publishers_and_sessions_drained',
            'expansion_journal_reconciled_through_watermark',
            'project_root_bindings_complete',
            'legacy_prompt_and_event_data_zero_scan_green',
            'all_v2_producers_disabled'
          ]::text[]
        limit 1
      `
      return rows.length === 1
    },

    async loadCheckpoint(operationId) {
      const [row] = await sql<{ value: string }[]>`
        select value
        from app_settings
        where key = ${checkpointKey(operationId)}
      `
      return row ? { checkpoint: parseLegacyLeakageScrubCheckpoint(row.value), token: row.value } : null
    },

    async createCheckpoint(checkpoint) {
      const value = JSON.stringify(checkpoint)
      const rows = await sql`
        insert into app_settings (key, value, updated_at)
        values (${checkpointKey(checkpoint.operationId)}, ${value}, now())
        on conflict (key) do nothing
        returning value
      `
      return rows.length === 1 ? { checkpoint, token: value } : null
    },

    async scanRows(phase, afterId, limit) {
      if (phase === 'task_logs') {
        const rows = afterId === null
          ? await sql<Record<string, unknown>[]>`
              select id::text as id, message, front_matter as "frontMatter", metadata
              from task_logs order by id limit ${limit}
            `
          : await sql<Record<string, unknown>[]>`
              select id::text as id, message, front_matter as "frontMatter", metadata
              from task_logs where id > ${afterId}::uuid order by id limit ${limit}
            `
        return rows.map(taskLogRow)
      }
      if (phase === 'work_packages') {
        const rows = afterId === null
          ? await sql<Record<string, unknown>[]>`
              select id::text as id, metadata
              from work_packages order by id limit ${limit}
            `
          : await sql<Record<string, unknown>[]>`
              select id::text as id, metadata
              from work_packages where id > ${afterId}::uuid order by id limit ${limit}
            `
        return rows.map(workPackageRow)
      }
      if (phase === 'approval_gates') {
        const rows = afterId === null
          ? await sql<Record<string, unknown>[]>`
              select id::text as id, metadata
              from approval_gates order by id limit ${limit}
            `
          : await sql<Record<string, unknown>[]>`
              select id::text as id, metadata
              from approval_gates where id > ${afterId}::uuid order by id limit ${limit}
            `
        return rows.map(approvalGateRow)
      }
      const rows = afterId === null
        ? await sql<Record<string, unknown>[]>`
            select a.id::text as id, a.content, a.metadata,
              (
                a.artifact_type = 'adr_text'
                and r.agent_type = 'architect'
                and a.content <> ${ARCHITECT_PLAN_HEADER}
                and version.plan_artifact_id is null
              ) as "replaceContent"
            from artifacts a
            join agent_runs r on r.id = a.agent_run_id
            left join (
              select distinct plan_artifact_id from architect_plan_versions
            ) version on version.plan_artifact_id = a.id
            where version.plan_artifact_id is null
            order by a.id limit ${limit}
          `
        : await sql<Record<string, unknown>[]>`
            select a.id::text as id, a.content, a.metadata,
              (
                a.artifact_type = 'adr_text'
                and r.agent_type = 'architect'
                and a.content <> ${ARCHITECT_PLAN_HEADER}
                and version.plan_artifact_id is null
              ) as "replaceContent"
            from artifacts a
            join agent_runs r on r.id = a.agent_run_id
            left join (
              select distinct plan_artifact_id from architect_plan_versions
            ) version on version.plan_artifact_id = a.id
            where a.id > ${afterId}::uuid
              and version.plan_artifact_id is null
            order by a.id limit ${limit}
          `
      return rows.map(artifactRow)
    },

    async commitRow(input) {
      return sql.begin(async (transaction) => {
        const checkpointRows = await transaction<{ value: string }[]>`
          select value from app_settings
          where key = ${checkpointKey(input.current.checkpoint.operationId)}
          for update
        `
        if (checkpointRows[0]?.value !== input.current.token) return 'checkpoint_conflict' as const

        if (input.row.kind === 'artifact') {
          // Lock identity without projecting protected bytes. A subsequent READ COMMITTED
          // statement observes a plan-version link that committed while this lock waited.
          const artifactIdentityRows = await transaction<{ id: string }[]>`
            select a.id::text as id
            from artifacts a
            where a.id = ${input.row.id}::uuid
            for update
          `
          if (artifactIdentityRows.length !== 1) return 'row_conflict' as const
        }

        const sourceRows = input.row.kind === 'task_log'
          ? await transaction<Record<string, unknown>[]>`
              select id::text as id, message, front_matter as "frontMatter", metadata
              from task_logs where id = ${input.row.id}::uuid for update
            `
          : input.row.kind === 'work_package'
            ? await transaction<Record<string, unknown>[]>`
                select id::text as id, metadata
                from work_packages where id = ${input.row.id}::uuid for update
              `
            : input.row.kind === 'approval_gate'
              ? await transaction<Record<string, unknown>[]>`
                  select id::text as id, metadata
                  from approval_gates where id = ${input.row.id}::uuid for update
                `
          : await transaction<Record<string, unknown>[]>`
              select a.id::text as id, a.content, a.metadata,
                (
                  a.artifact_type = 'adr_text'
                  and r.agent_type = 'architect'
                  and a.content <> ${ARCHITECT_PLAN_HEADER}
                ) as "replaceContent"
              from artifacts a
              join agent_runs r on r.id = a.agent_run_id
              where a.id = ${input.row.id}::uuid
                and not exists (
                  select 1
                  from architect_plan_versions version
                  where version.plan_artifact_id = a.id
                )
            `
        if (sourceRows.length !== 1) return 'row_conflict' as const
        const source = input.row.kind === 'task_log'
          ? taskLogRow(sourceRows[0])
          : input.row.kind === 'work_package'
            ? workPackageRow(sourceRows[0])
            : input.row.kind === 'approval_gate'
              ? approvalGateRow(sourceRows[0])
              : artifactRow(sourceRows[0])
        if (legacyLeakageRowFingerprint(source, fingerprintKey) !== input.expectedRowFingerprint) return 'row_conflict' as const

        if (input.row.kind === 'task_log') {
          await transaction`
            update task_logs
            set message = ${input.row.message},
                front_matter = ${transaction.json(input.row.frontMatter as never)},
                metadata = ${transaction.json(input.row.metadata as never)}
            where id = ${input.row.id}::uuid
          `
        } else if (input.row.kind === 'artifact') {
          await transaction`
            update artifacts
            set content = ${input.row.content},
                metadata = ${input.row.metadata === null ? null : transaction.json(input.row.metadata as never)}
            where id = ${input.row.id}::uuid
          `
        } else if (input.row.kind === 'work_package') {
          await transaction`
            update work_packages
            set metadata = ${transaction.json(input.row.metadata as never)},
                updated_at = now()
            where id = ${input.row.id}::uuid
          `
        } else {
          await transaction`
            update approval_gates
            set metadata = ${transaction.json(input.row.metadata as never)},
                updated_at = now()
            where id = ${input.row.id}::uuid
          `
        }

        const nextValue = JSON.stringify(input.nextCheckpoint)
        const updated = await transaction`
          update app_settings
          set value = ${nextValue}, updated_at = now()
          where key = ${checkpointKey(input.current.checkpoint.operationId)}
            and value = ${input.current.token}
          returning key
        `
        if (updated.length !== 1) throw new Error('checkpoint_conflict')
        return 'committed' as const
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'checkpoint_conflict') return 'checkpoint_conflict' as const
        throw error
      })
    },

    async compareAndSetCheckpoint(current, next) {
      const value = JSON.stringify(next)
      const rows = await sql`
        update app_settings
        set value = ${value}, updated_at = now()
        where key = ${checkpointKey(current.checkpoint.operationId)}
          and value = ${current.token}
        returning value
      `
      return rows.length === 1 ? { checkpoint: next, token: value } : null
    },
  }
}

async function scanKeys(
  redis: Redis,
  pattern: string,
  visit: (keys: readonly string[]) => Promise<void>,
): Promise<{ complete: boolean; keysExamined: number }> {
  let cursor = '0'
  let iterations = 0
  let keysExamined = 0
  const seenNonterminalCursors = new Set<string>()
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 250)
    iterations += 1
    keysExamined += keys.length
    if (keys.length > 0) await visit(keys)
    if (next !== '0' && (next === cursor || seenNonterminalCursors.has(next))) {
      return { complete: false, keysExamined }
    }
    if (next !== '0') seenNonterminalCursors.add(next)
    cursor = next
    if (iterations >= MAX_REDIS_SCAN_ITERATIONS && cursor !== '0') {
      return { complete: false, keysExamined }
    }
  } while (cursor !== '0')
  return { complete: true, keysExamined }
}

function emptyRedisEvidence(): RedisScanEvidence {
  return {
    complete: true,
    keysExamined: 0,
    keysDeleted: 0,
    remainingKeys: 0,
    valuesExamined: 0,
    violations: 0,
  }
}

function addRedisEvidence(left: RedisScanEvidence, right: RedisScanEvidence): RedisScanEvidence {
  return {
    complete: left.complete && right.complete,
    keysExamined: left.keysExamined + right.keysExamined,
    keysDeleted: left.keysDeleted + right.keysDeleted,
    remainingKeys: right.remainingKeys,
    valuesExamined: left.valuesExamined + right.valuesExamined,
    violations: left.violations + right.violations,
  }
}

function canonicalSequence(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateStoredV2Envelope(
  raw: string,
  score: string,
  taskId: string,
  sentinels: readonly string[],
): boolean {
  const parsedScore = Number(score)
  if (!Number.isSafeInteger(parsedScore) || parsedScore < 1) return false
  if (scanJsonObjectKeys(raw) !== 'valid') return false
  try {
    const envelope: unknown = JSON.parse(raw)
    if (!isRecord(envelope)
      || Object.keys(envelope).length !== 4
      || envelope.schemaVersion !== 2
      || !Number.isSafeInteger(envelope.id)
      || envelope.id !== parsedScore
      || typeof envelope.type !== 'string'
      || !isRecord(envelope.data)) return false
    // Current production envelopes do not carry taskId. If a future closed
    // schema adds it, it must agree with the task identity encoded by the key.
    if (Object.hasOwn(envelope.data, 'taskId') && envelope.data.taskId !== taskId) return false
    return !containsForbiddenV2EventData({ type: envelope.type, data: envelope.data }, sentinels)
  } catch {
    return false
  }
}

async function scanSortedSetValues(
  redis: Redis,
  key: string,
  taskId: string,
  sentinels: readonly string[],
): Promise<{ complete: boolean; valuesExamined: number; violations: number; maxSequence: number }> {
  let cursor = '0'
  let iterations = 0
  let valuesExamined = 0
  let violations = 0
  let maxSequence = 0
  const seenNonterminalCursors = new Set<string>()
  do {
    const [next, entries] = await redis.zscan(key, cursor, 'COUNT', 250)
    iterations += 1
    if (entries.length % 2 !== 0) violations += 1
    for (let index = 0; index < entries.length; index += 2) {
      if (index + 1 >= entries.length) break
      valuesExamined += 1
      const parsedScore = Number(entries[index + 1])
      if (Number.isSafeInteger(parsedScore) && parsedScore > maxSequence) maxSequence = parsedScore
      if (!validateStoredV2Envelope(entries[index], entries[index + 1], taskId, sentinels)) violations += 1
    }
    if (next !== '0' && (next === cursor || seenNonterminalCursors.has(next))) {
      return { complete: false, valuesExamined, violations, maxSequence }
    }
    if (next !== '0') seenNonterminalCursors.add(next)
    cursor = next
    if (iterations >= MAX_REDIS_SCAN_ITERATIONS && cursor !== '0') {
      return { complete: false, valuesExamined, violations, maxSequence }
    }
  } while (cursor !== '0')
  return { complete: true, valuesExamined, violations, maxSequence }
}

async function scanLegacyStorage(redis: Redis, apply: boolean): Promise<RedisScanEvidence> {
  let evidence = emptyRedisEvidence()
  let remainingKeys = 0
  const scan = await scanKeys(redis, LEGACY_TASK_EVENT_STORAGE_PATTERN, async (keys) => {
    const exactKeys: string[] = []
    for (const key of keys) {
      if (parseLegacyTaskEventStorageKey(key) === null) {
        evidence = addRedisEvidence(evidence, { ...emptyRedisEvidence(), violations: 1 })
      } else {
        exactKeys.push(key)
        if (!apply) remainingKeys += 1
      }
    }
    if (apply && exactKeys.length > 0) {
      const deleted = await redis.del(...exactKeys)
      evidence = addRedisEvidence(evidence, { ...emptyRedisEvidence(), keysDeleted: deleted })
    }
  })
  return {
    ...evidence,
    complete: evidence.complete && scan.complete,
    keysExamined: evidence.keysExamined + scan.keysExamined,
    remainingKeys,
  }
}

async function scanV2Storage(redis: Redis, sentinels: readonly string[]): Promise<RedisScanEvidence> {
  let evidence = emptyRedisEvidence()
  // Validate each discovered key against its direct companion. This avoids an
  // unbounded task-id map while still proving both sides of every pair.
  const scan = await scanKeys(redis, TASK_EVENT_V2_STORAGE_PATTERN, async (keys) => {
    for (const key of keys) {
      const parsed = parseV2TaskEventStorageKey(key)
      if (!parsed) {
        evidence = addRedisEvidence(evidence, { ...emptyRedisEvidence(), violations: 1 })
        continue
      }
      const type = await redis.type(key)
      if ((parsed.kind === 'history' && type !== 'zset') || (parsed.kind === 'seq' && type !== 'string')) {
        evidence = addRedisEvidence(evidence, { ...emptyRedisEvidence(), violations: 1 })
        continue
      }
      const pair = taskEventRedisKeys(parsed.taskId)
      if (parsed.kind === 'history') {
        const values = await scanSortedSetValues(redis, key, parsed.taskId, sentinels)
        const pairType = await redis.type(pair.sequence)
        const sequence = pairType === 'string'
          ? canonicalSequence(await redis.get(pair.sequence))
          : null
        evidence = addRedisEvidence(evidence, {
          ...emptyRedisEvidence(),
          complete: values.complete,
          valuesExamined: values.valuesExamined,
          violations: values.violations
            + (pairType === 'string' && sequence !== null && sequence >= values.maxSequence ? 0 : 1),
        })
      } else {
        const sequence = canonicalSequence(await redis.get(key))
        const pairType = await redis.type(pair.history)
        evidence = addRedisEvidence(evidence, {
          ...emptyRedisEvidence(),
          violations: sequence === null || pairType !== 'zset' ? 1 : 0,
        })
      }
    }
  })
  return {
    ...evidence,
    complete: evidence.complete && scan.complete,
    keysExamined: evidence.keysExamined + scan.keysExamined,
  }
}

export function createLegacyLeakageRedisAdapter(redis: Redis): LegacyLeakageScrubRedis {
  return {
    async purgeLegacyTaskEventKeys({ apply, sentinels = [] }): Promise<RedisScanEvidence> {
      const preflight = await scanLegacyStorage(redis, false)
      if (!apply || !preflight.complete || preflight.violations > 0) {
        return preflight
      }
      const v2Preflight = await scanV2Storage(redis, sentinels)
      if (!v2Preflight.complete || v2Preflight.violations > 0) {
        return addRedisEvidence(preflight, { ...v2Preflight, remainingKeys: preflight.remainingKeys })
      }
      const deleted = await scanLegacyStorage(redis, true)
      const postLegacy = await scanLegacyStorage(redis, false)
      const postV2 = await scanV2Storage(redis, sentinels)
      return {
        ...addRedisEvidence(addRedisEvidence(deleted, postLegacy), postV2),
        remainingKeys: postLegacy.remainingKeys,
      }
    },

    async scanV2TaskEventHistory(sentinels): Promise<RedisScanEvidence> {
      return scanV2Storage(redis, sentinels)
    },
  }
}

export async function runLegacyLeakageScrubCli(cli: LegacyLeakageScrubCli): Promise<number> {
  const sql = postgres(requiredAdminDatabaseUrl(), { max: 1 })
  const redis = new Redis(getRequiredEnv('REDIS_URL'), { lazyConnect: true, maxRetriesPerRequest: 3 })
  try {
    const fingerprintKey = requiredFingerprintKey()
    const result = await runLegacyLeakageScrub({
      ...cli,
      fingerprintKey,
      fingerprintKeyId: requiredFingerprintKeyId(),
    }, {
      database: createLegacyLeakagePostgresAdapter(sql, fingerprintKey),
      redis: createLegacyLeakageRedisAdapter(redis),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result.checkpoint?.state === 'paused_conflict' ? 2 : 0
  } finally {
    redis.disconnect()
    await sql.end({ timeout: 5 })
  }
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2)
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(`${legacyLeakageScrubUsage()}\n`)
      return
    }
    process.exitCode = await runLegacyLeakageScrubCli(parseLegacyLeakageScrubArgs(argv))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Legacy leakage scrub failed.'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
