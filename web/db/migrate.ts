/**
 * Apply pending database migrations with friendly, layman-readable output.
 *
 * Run with: npx tsx db/migrate.ts
 * Or via:   npm run db:migrate
 *
 * We deliberately do NOT use `drizzle-kit migrate` directly here: drizzle-kit
 * surfaces raw PostgreSQL NOTICE objects (e.g. "schema drizzle already exists,
 * skipping") as scary-looking multi-line console dumps. Those are harmless, but
 * they read like errors to anyone running the installer. By driving the
 * migrator ourselves we can silence the notices and print plain progress lines
 * instead.
 */

import '../lib/load-env'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'
import { protectedMigrationRecoveryPlan } from '@/scripts/ci/protected-migration-registry'
import { protectedMigrationCleanupState } from '@/scripts/ci/protected-migration-state'
import { runManagedDockerMigration } from '@/scripts/managed-docker-migration-controller'

const MIGRATIONS_FOLDER = './db/migrations'
const execFileAsync = promisify(execFile)

type MigrationJournal = { entries: Array<{ tag: string; when: number }> }

async function pendingProtectedMigrations(client: ReturnType<typeof postgres>): Promise<ReturnType<typeof protectedMigrationRecoveryPlan>> {
  try {
    const journal = JSON.parse(await readFile(fileURLToPath(new URL('./migrations/meta/_journal.json', import.meta.url)), 'utf8')) as MigrationJournal
    const protectedTags = journal.entries.map((entry) => entry.tag)
    const rows = await client<{ createdAt: number }[]>`
      select created_at as "createdAt" from drizzle.__drizzle_migrations
    `
    const appliedAt = new Set(rows.map((row) => Number(row.createdAt)))
    const appliedTags = new Set(journal.entries.filter((entry) => appliedAt.has(entry.when)).map((entry) => entry.tag))
    const cleanupState = await protectedMigrationCleanupState(client, protectedTags)
    return protectedMigrationRecoveryPlan({
      journalTags: protectedTags,
      appliedTags,
      cleanupPendingTags: cleanupState.pendingTags,
      cleanupStateTags: cleanupState.stateTags,
    })
  } catch (error) {
    // A new database has neither the Drizzle ledger nor durable handoff rows.
    // The registry still routes its first protected migration through its
    // wrapper, which establishes both prerequisites and the handoff state.
    if ((error as { code?: string }).code === '42P01') {
      const journal = JSON.parse(await readFile(fileURLToPath(new URL('./migrations/meta/_journal.json', import.meta.url)), 'utf8')) as MigrationJournal
      return protectedMigrationRecoveryPlan({ journalTags: journal.entries.map((entry) => entry.tag), appliedTags: new Set(), cleanupPendingTags: new Set(), cleanupStateTags: new Set() })
    }
    throw error
  }
}

async function main(): Promise<void> {
  const databaseUrl = getRequiredEnv('DATABASE_URL')

  // `onnotice` swallows the informational NOTICE messages PostgreSQL emits for
  // idempotent statements ("... already exists, skipping"). `max: 1` keeps the
  // migrator on a single connection, which is all it needs.
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  let clientClosed = false

  console.log('• Checking the database for pending migrations…')

  try {
    const protectedMigrations = await pendingProtectedMigrations(client)
    if (protectedMigrations.length > 0) {
      await client.end({ timeout: 5 })
      clientClosed = true
      if (process.env.FORGE_MANAGED_DOCKER_MIGRATIONS === '1') await runManagedDockerMigration()
      else await execFileAsync('bash', [protectedMigrations[0].wrapper], { cwd: process.cwd(), env: process.env })
      return
    }
    const db = drizzle(client)
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    console.log('✓ Database schema is up to date.')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('✗ Could not apply database migrations.')
    console.error(`  ${message}`)
    console.error('  Check that PostgreSQL is running and DATABASE_URL is correct, then try again.')
    process.exitCode = 1
  } finally {
    if (!clientClosed) await client.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('✗ Unexpected error while migrating:', err)
  process.exit(1)
})
