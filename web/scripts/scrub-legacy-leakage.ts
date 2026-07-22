import { pathToFileURL } from 'node:url'
import Redis from 'ioredis'
import postgres from 'postgres'
import { getRequiredEnv } from '../lib/env'
import { ARCHITECT_PLAN_HEADER } from '../lib/mcps/architect-plan-entries'
import {
  LEGACY_LEAKAGE_SCRUB_CHECKPOINT_PREFIX,
  LEGACY_TASK_EVENT_PATTERNS,
  V2_TASK_EVENT_HISTORY_PATTERN,
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

Apply and resume mutate only task_logs, artifacts, work_packages, the operation
checkpoint in app_settings, and legacy forge:task:{taskId}:history/:seq Redis
keys. Protected Architect plan entries are never selected or updated.

Environment:
  FORGE_DATABASE_ADMIN_URL  privileged PostgreSQL connection for the scrub
  REDIS_URL                 Redis connection whose legacy task history is purged`
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

function parseCheckpoint(value: string): LegacyLeakageScrubCheckpoint {
  const parsed = JSON.parse(value) as Partial<LegacyLeakageScrubCheckpoint>
  if (parsed.schemaVersion !== 1 || typeof parsed.operationId !== 'string' || typeof parsed.phase !== 'string') {
    throw new Error('Stored leakage scrub checkpoint is malformed.')
  }
  return parsed as LegacyLeakageScrubCheckpoint
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
          and receipt.epoch > 0
          and receipt.signature_domain = 'forge:epic-172-release-evidence:v1'
          and receipt.envelope_version = 1
          and receipt.envelope_digest ~ '^[0-9a-f]{64}$'
          and octet_length(receipt.detached_signature) = 64
          and predecessor.evidence_kind = 's4_expand'
          and predecessor.owner_issue = 179
          and predecessor.owner_slice = 's4'
          and predecessor.exact_builds = receipt.exact_builds
          and predecessor.reviewed_sha = receipt.reviewed_sha
          and predecessor.epoch = receipt.epoch
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
      return row ? { checkpoint: parseCheckpoint(row.value), token: row.value } : null
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
            where a.id > ${afterId}::uuid order by a.id limit ${limit}
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
                  and version.plan_artifact_id is null
                ) as "replaceContent"
              from artifacts a
              join agent_runs r on r.id = a.agent_run_id
              left join (
                select distinct plan_artifact_id from architect_plan_versions
              ) version on version.plan_artifact_id = a.id
              where a.id = ${input.row.id}::uuid
              for update of a
            `
        if (sourceRows.length !== 1) return 'row_conflict' as const
        const source = input.row.kind === 'task_log'
          ? taskLogRow(sourceRows[0])
          : input.row.kind === 'work_package'
            ? workPackageRow(sourceRows[0])
            : input.row.kind === 'approval_gate'
              ? approvalGateRow(sourceRows[0])
              : artifactRow(sourceRows[0])
        if (legacyLeakageRowFingerprint(source) !== input.expectedRowFingerprint) return 'row_conflict' as const

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
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 250)
    cursor = next
    iterations += 1
    keysExamined += keys.length
    if (keys.length > 0) await visit(keys)
    if (iterations >= MAX_REDIS_SCAN_ITERATIONS && cursor !== '0') {
      return { complete: false, keysExamined }
    }
  } while (cursor !== '0')
  return { complete: true, keysExamined }
}

async function countLegacyKeys(redis: Redis): Promise<{ complete: boolean; keysExamined: number }> {
  let complete = true
  let keysExamined = 0
  for (const pattern of LEGACY_TASK_EVENT_PATTERNS) {
    const evidence = await scanKeys(redis, pattern, async () => undefined)
    complete &&= evidence.complete
    keysExamined += evidence.keysExamined
  }
  return { complete, keysExamined }
}

async function scanSortedSetValues(
  redis: Redis,
  key: string,
  sentinels: readonly string[],
): Promise<{ complete: boolean; valuesExamined: number; violations: number }> {
  let cursor = '0'
  let iterations = 0
  let valuesExamined = 0
  let violations = 0
  do {
    const [next, entries] = await redis.zscan(key, cursor, 'COUNT', 250)
    cursor = next
    iterations += 1
    for (let index = 0; index < entries.length; index += 2) {
      valuesExamined += 1
      try {
        if (containsForbiddenV2EventData(JSON.parse(entries[index]), sentinels)) violations += 1
      } catch {
        violations += 1
      }
    }
    if (iterations >= MAX_REDIS_SCAN_ITERATIONS && cursor !== '0') {
      return { complete: false, valuesExamined, violations }
    }
  } while (cursor !== '0')
  return { complete: true, valuesExamined, violations }
}

export function createLegacyLeakageRedisAdapter(redis: Redis): LegacyLeakageScrubRedis {
  return {
    async purgeLegacyTaskEventKeys({ apply }): Promise<RedisScanEvidence> {
      let complete = true
      let keysExamined = 0
      let keysDeleted = 0
      for (const pattern of LEGACY_TASK_EVENT_PATTERNS) {
        const evidence = await scanKeys(redis, pattern, async (keys) => {
          if (!apply) return
          keysDeleted += await redis.del(...keys)
        })
        complete &&= evidence.complete
        keysExamined += evidence.keysExamined
      }
      const remaining = await countLegacyKeys(redis)
      return {
        complete: complete && remaining.complete,
        keysExamined,
        keysDeleted,
        remainingKeys: remaining.keysExamined,
        valuesExamined: 0,
        violations: 0,
      }
    },

    async scanV2TaskEventHistory(sentinels): Promise<RedisScanEvidence> {
      let valuesExamined = 0
      let violations = 0
      const keyScan = await scanKeys(redis, V2_TASK_EVENT_HISTORY_PATTERN, async (keys) => {
        for (const key of keys) {
          const evidence = await scanSortedSetValues(redis, key, sentinels)
          valuesExamined += evidence.valuesExamined
          violations += evidence.violations
          if (!evidence.complete) violations += 1
        }
      })
      return {
        complete: keyScan.complete,
        keysExamined: keyScan.keysExamined,
        keysDeleted: 0,
        remainingKeys: 0,
        valuesExamined,
        violations,
      }
    },
  }
}

export async function runLegacyLeakageScrubCli(cli: LegacyLeakageScrubCli): Promise<number> {
  const sql = postgres(requiredAdminDatabaseUrl(), { max: 1 })
  const redis = new Redis(getRequiredEnv('REDIS_URL'), { lazyConnect: true, maxRetriesPerRequest: 3 })
  try {
    const result = await runLegacyLeakageScrub(cli, {
      database: createLegacyLeakagePostgresAdapter(sql),
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
