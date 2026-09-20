import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const PREDECESSOR_MIGRATION = '0033_verification_goal_registry_revisions'
const TARGET_MIGRATION = '0034_vnext_phase0_a1_runtime_foundation'
const requestedTarget = process.argv.includes('--through-0033') ? PREDECESSOR_MIGRATION : TARGET_MIGRATION

async function main(): Promise<void> {
  const source = resolve('db/migrations')
  const journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> }
  const previous = journal.entries.find((entry) => entry.tag === PREDECESSOR_MIGRATION)
  const target = journal.entries.find((entry) => entry.tag === requestedTarget)
  if (!previous || !target || (requestedTarget === TARGET_MIGRATION && (target.idx !== previous.idx + 1 || target.when <= previous.when))) throw new Error('0034 must immediately and chronologically follow 0033 in the migration journal.')
  const prefix = journal.entries.filter((entry) => entry.idx <= target.idx)
  if (prefix.length !== target.idx + 1 || prefix.at(-1)?.tag !== requestedTarget) throw new Error(`The exact migration journal prefix through ${requestedTarget} is incomplete.`)
  const root = await mkdtemp(join(tmpdir(), 'forge-migration-0034-'))
  const migrations = join(root, 'migrations')
  try {
    await mkdir(join(migrations, 'meta'), { recursive: true })
    await Promise.all(prefix.map((entry) => copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`))))
    await writeFile(join(migrations, 'meta/_journal.json'), `${JSON.stringify({ ...journal, entries: prefix }, null, 2)}\n`)
    const client = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
    try {
      // The controller gives the disposable login membership in this
      // non-login schema owner.  Making it current keeps ordinary historical
      // objects out of the ephemeral login, which can then be dropped without
      // taking schema ownership with it.
      await client.unsafe('set role forge_schema_owner')
      await migrate(drizzle(client), { migrationsFolder: migrations })
    } finally { await client.end({ timeout: 5 }) }
  } finally { await rm(root, { recursive: true, force: true }) }
  console.log(`✓ Disposable upgrade database is at ${requestedTarget}.`)
}
main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
