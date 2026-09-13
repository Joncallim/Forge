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
import { promisify } from 'node:util'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const MIGRATIONS_FOLDER = './db/migrations'
const RUNTIME_FOUNDATION_MIGRATION_AT = 1786838400000
const execFileAsync = promisify(execFile)

async function runtimeFoundationIsPending(client: ReturnType<typeof postgres>): Promise<boolean> {
  try {
    const [row] = await client<{ pending: boolean }[]>`
      select coalesce(max(created_at) < ${RUNTIME_FOUNDATION_MIGRATION_AT}, true) as pending
      from drizzle.__drizzle_migrations
    `
    return row?.pending === true
  } catch (error) {
    // New installs have not created Drizzle's ledger yet. Earlier protected
    // migrations retain their own bootstrap path; this handoff starts at 0034.
    if ((error as { code?: string }).code === '42P01') return false
    throw error
  }
}

async function withRuntimeOwnerHandoff(): Promise<void> {
  // This is intentionally part of the ordinary migrator, not a separate
  // operator-only command. Local Docker/custom owner installs use DATABASE_URL;
  // hosted PostgreSQL may provide the documented short-lived admin URL.
  await execFileAsync('npx', ['tsx', 'scripts/bootstrap-vnext-runtime-owner.ts'], { cwd: process.cwd() })
}

async function cleanupRuntimeOwnerHandoff(): Promise<void> {
  await execFileAsync('npx', ['tsx', 'scripts/bootstrap-vnext-runtime-owner.ts', '--cleanup'], { cwd: process.cwd() })
}

async function main(): Promise<void> {
  const databaseUrl = getRequiredEnv('DATABASE_URL')

  // `onnotice` swallows the informational NOTICE messages PostgreSQL emits for
  // idempotent statements ("... already exists, skipping"). `max: 1` keeps the
  // migrator on a single connection, which is all it needs.
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  let runtimeHandoff = false

  console.log('• Checking the database for pending migrations…')

  try {
    runtimeHandoff = await runtimeFoundationIsPending(client)
    if (runtimeHandoff) await withRuntimeOwnerHandoff()
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
    if (runtimeHandoff) {
      try {
        await cleanupRuntimeOwnerHandoff()
      } catch (cleanupError) {
        console.error(`✗ Could not restore the protected runtime migration boundary: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
        process.exitCode = 1
      }
    }
    await client.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('✗ Unexpected error while migrating:', err)
  process.exit(1)
})
