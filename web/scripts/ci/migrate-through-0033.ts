import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const PREDECESSOR_MIGRATION = '0032_verification_goal_snapshots'
const TARGET_MIGRATION = '0033_verification_goal_registry_revisions'

type MigrationJournal = Readonly<{
  version: string
  dialect: string
  entries: ReadonlyArray<Readonly<{
    idx: number
    version: string
    when: number
    tag: string
    breakpoints: boolean
  }>>
}>

async function main(): Promise<void> {
  const sourceDirectory = resolve('db/migrations')
  const journal = JSON.parse(
    await readFile(join(sourceDirectory, 'meta/_journal.json'), 'utf8'),
  ) as MigrationJournal
  const predecessor = journal.entries.find((entry) => entry.tag === PREDECESSOR_MIGRATION)
  const target = journal.entries.find((entry) => entry.tag === TARGET_MIGRATION)
  if (!predecessor || !target || target.idx !== predecessor.idx + 1 || target.when <= predecessor.when) {
    throw new Error('0033 must immediately and chronologically follow 0032 in the migration journal.')
  }

  const prefix = journal.entries.filter((entry) => entry.idx <= target.idx)
  if (prefix.length !== target.idx + 1 || prefix.at(-1)?.tag !== TARGET_MIGRATION) {
    throw new Error('The exact migration journal prefix through 0033 is incomplete.')
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'forge-migration-0033-'))
  const temporaryMigrations = join(temporaryRoot, 'migrations')
  const temporaryMeta = join(temporaryMigrations, 'meta')
  await mkdir(temporaryMeta, { recursive: true })
  try {
    await Promise.all(prefix.map((entry) => copyFile(
      join(sourceDirectory, `${entry.tag}.sql`),
      join(temporaryMigrations, `${entry.tag}.sql`),
    )))
    await writeFile(join(temporaryMeta, '_journal.json'), `${JSON.stringify({
      ...journal,
      entries: prefix,
    }, null, 2)}\n`, 'utf8')

    const client = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
    try {
      await migrate(drizzle(client), { migrationsFolder: temporaryMigrations })
    } finally {
      await client.end({ timeout: 5 })
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  console.log('✓ Disposable upgrade database is at 0033.')
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
