import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { fixedDatabaseRoleUrl } from '../lib/mcps/fixed-database-url'
import {
  inspectLocalProjectionOverlimit,
  parseInspectLocalProjectionOverlimitArgs,
  type LocalProjectionArchiveDatabase,
} from '../lib/mcps/local-projection-overlimit-archive'

export function inspectLocalProjectionOverlimitUsage(): string {
  return `Inspect a task's fixed local-projection archive state

Read-only:
  npm run protocol:inspect-local-projection-overlimit -- --task <legacy-task-id>

Environment:
  FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL
    PostgreSQL URL for the dedicated forge_local_projection_archiver login.
    The ordinary Forge application or administrator URL is not accepted.
  PGPASSWORD, PGPASSFILE, PGSERVICE, PGSERVICEFILE, PGSSLPASSWORD
    Must be unset. This command permits certificate or peer authentication only.`
}

export function requiredLocalProjectionArchiverDatabaseUrl(): string {
  const forbiddenInheritedCredentials = [
    'PGPASSWORD',
    'PGPASSFILE',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGSSLPASSWORD',
  ] as const
  const inherited = forbiddenInheritedCredentials.find((name) => process.env[name] !== undefined)
  if (inherited) {
    throw new Error(
      `${inherited} must be unset for the local-projection archiver; use only certificate or peer authentication.`,
    )
  }
  const value = fixedDatabaseRoleUrl({
    environmentName: 'FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL',
    expectedUsername: 'forge_local_projection_archiver',
    value: process.env.FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL,
  })
  const parsed = new URL(value)
  if ([...parsed.searchParams.keys()].some((key) => key.toLowerCase() === 'sslpassword')) {
    throw new Error(
      'FORGE_LOCAL_PROJECTION_ARCHIVER_DATABASE_URL must not include sslpassword; use certificate or peer authentication.',
    )
  }
  return value
}

type Sql = ReturnType<typeof postgres>

function routineResult(row: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!row) throw new Error('The fixed-principal archive routine returned no result.')
  return row
}

export function createLocalProjectionArchiverPostgresAdapter(sql: Sql): LocalProjectionArchiveDatabase {
  return {
    async inspect(taskId) {
      const [row] = await sql<{ snapshot: unknown }[]>`
        select snapshot
        from forge.inspect_local_projection_overlimit_v2(${taskId}::uuid)
      `
      if (!row) throw new Error('The fixed-principal inspect routine returned no result.')
      return row.snapshot
    },

    async apply(input) {
      const [row] = await sql<Record<string, unknown>[]>`
        select
          operation_id as "operationId",
          state,
          operation_fingerprint as "operationFingerprint",
          snapshot
        from forge.apply_local_projection_overlimit_archive_v2(
          ${input.sourceTaskId}::uuid,
          ${input.replacementTaskId}::uuid,
          ${input.actorId}::uuid,
          ${input.expectedSourceFingerprint}::text,
          ${input.expectedReplacementFingerprint}::text
        )
      `
      return routineResult(row)
    },

    async resume(input) {
      const [row] = await sql<Record<string, unknown>[]>`
        select
          operation_id as "operationId",
          state,
          operation_fingerprint as "operationFingerprint",
          snapshot
        from forge.resume_local_projection_overlimit_archive_v2(
          ${input.operationId}::uuid,
          ${input.actorId}::uuid,
          ${input.expectedOperationFingerprint}::text
        )
      `
      return routineResult(row)
    },

    async rollback(input) {
      const [row] = await sql<Record<string, unknown>[]>`
        select
          operation_id as "operationId",
          state,
          operation_fingerprint as "operationFingerprint",
          snapshot
        from forge.rollback_local_projection_overlimit_archive_v2(
          ${input.operationId}::uuid,
          ${input.actorId}::uuid,
          ${input.expectedOperationFingerprint}::text
        )
      `
      return routineResult(row)
    },

    async cancel(input) {
      const [row] = await sql<Record<string, unknown>[]>`
        select
          operation_id as "operationId",
          state,
          operation_fingerprint as "operationFingerprint",
          snapshot
        from forge.cancel_local_projection_overlimit_archive_v2(
          ${input.operationId}::uuid,
          ${input.actorId}::uuid,
          ${input.expectedOperationFingerprint}::text
        )
      `
      return routineResult(row)
    },
  }
}

export async function runInspectLocalProjectionOverlimitCli(argv: readonly string[]): Promise<number> {
  const cli = parseInspectLocalProjectionOverlimitArgs(argv)
  const sql = postgres(requiredLocalProjectionArchiverDatabaseUrl(), { max: 1 })
  try {
    const result = await inspectLocalProjectionOverlimit(cli, createLocalProjectionArchiverPostgresAdapter(sql))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2)
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(`${inspectLocalProjectionOverlimitUsage()}\n`)
      return
    }
    process.exitCode = await runInspectLocalProjectionOverlimitCli(argv)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: error instanceof Error ? error.message : 'Local-projection over-limit inspection failed.',
    })}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
