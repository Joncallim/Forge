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
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const MIGRATIONS_FOLDER = './db/migrations'

async function main(): Promise<void> {
  const databaseUrl = getRequiredEnv('DATABASE_URL')

  // `onnotice` swallows the informational NOTICE messages PostgreSQL emits for
  // idempotent statements ("... already exists, skipping"). `max: 1` keeps the
  // migrator on a single connection, which is all it needs.
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} })

  console.log('• Checking the database for pending migrations…')

  try {
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
    await client.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('✗ Unexpected error while migrating:', err)
  process.exit(1)
})
