import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const LAST_BASELINE_MIGRATION = '0026_epic_172_s3_grant_lifecycle'
const NEXT_MIGRATION = '0027_epic_172_s4_packet_context'

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
  const baselineEntry = journal.entries.find((entry) => entry.tag === LAST_BASELINE_MIGRATION)
  const nextEntry = journal.entries.find((entry) => entry.tag === NEXT_MIGRATION)
  if (
    !baselineEntry
    || !nextEntry
    || nextEntry.idx !== baselineEntry.idx + 1
    || nextEntry.when <= baselineEntry.when
  ) {
    throw new Error('0027 must immediately and chronologically follow 0026 in the migration journal.')
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'forge-migration-0026-'))
  const temporaryMigrations = join(temporaryRoot, 'migrations')
  const temporaryMeta = join(temporaryMigrations, 'meta')
  await mkdir(temporaryMeta, { recursive: true })
  try {
    const sqlFiles = (await readdir(sourceDirectory))
      .filter((fileName) => /^\d{4}_.+\.sql$/.test(fileName))
      .filter((fileName) => Number.parseInt(fileName.slice(0, 4), 10) <= baselineEntry.idx)
    if (sqlFiles.length !== baselineEntry.idx + 1) {
      throw new Error(`Expected ${baselineEntry.idx + 1} migration files through 0026; found ${sqlFiles.length}.`)
    }
    await Promise.all(sqlFiles.map((fileName) => (
      copyFile(join(sourceDirectory, fileName), join(temporaryMigrations, fileName))
    )))
    await writeFile(join(temporaryMeta, '_journal.json'), `${JSON.stringify({
      ...journal,
      entries: journal.entries.filter((entry) => entry.idx <= baselineEntry.idx),
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
  console.log('✓ Disposable upgrade database is at 0026.')
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
