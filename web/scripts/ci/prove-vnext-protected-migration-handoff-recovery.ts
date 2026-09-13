/**
 * Disposable PostgreSQL proof for the only A1 recovery window: 0034 has
 * committed to Drizzle's ledger but the protected-owner cleanup did not.
 *
 * Set FORGE_VNEXT_RUNTIME_HANDOFF_RECOVERY_TEST_URL to an administrator URL.
 * The proof creates and drops one uniquely named database of its own.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import postgres from 'postgres'

const execFileAsync = promisify(execFile)
const target = process.env.FORGE_VNEXT_RUNTIME_HANDOFF_RECOVERY_TEST_URL?.trim()

if (!target) throw new Error('FORGE_VNEXT_RUNTIME_HANDOFF_RECOVERY_TEST_URL is required for the disposable protected-migration recovery proof.')

function withDatabase(connectionString: string, database: string): string {
  const parsed = new URL(connectionString)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

async function main(): Promise<void> {
  const uniqueDatabase = `forge_a1_handoff_${randomUUID().replaceAll('-', '')}`
  const admin = postgres(withDatabase(target!, 'postgres'), { max: 1, onnotice: () => {} })
  let proofUrl: string | undefined
  try {
    const [{ currentUser }] = await admin<{ currentUser: string }[]>`select current_user as "currentUser"`
    if (!/^[a-z_][a-z0-9_]*$/i.test(currentUser)) throw new Error('The disposable proof administrator role is not a safe PostgreSQL identifier.')
    await admin.unsafe(`create database "${uniqueDatabase}" owner "${currentUser}"`)
    proofUrl = withDatabase(target!, uniqueDatabase)
    const childEnv = {
      ...process.env,
      DATABASE_URL: proofUrl,
      FORGE_DATABASE_ADMIN_URL: proofUrl,
    }
    try {
      await execFileAsync('bash', ['scripts/ci/apply-vnext-phase0-a1-runtime-foundation.sh'], {
        cwd: process.cwd(),
        env: { ...childEnv, FORGE_VNEXT_RUNTIME_FORCE_CLEANUP_FAILURE: '1' },
      })
      throw new Error('The forced protected-owner cleanup failure unexpectedly succeeded.')
    } catch (error) {
      const stderr = typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr : ''
      if (!stderr.includes('Forced VNext runtime protected-owner cleanup failure.')) throw new Error(stderr || (error instanceof Error ? error.message : String(error)))
    }
    const proof = postgres(proofUrl, { max: 1, onnotice: () => {} })
    try {
      const journal = JSON.parse(await readFile('db/migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string; when: number }> }
      const migration = journal.entries.find((entry) => entry.tag === '0034_vnext_phase0_a1_runtime_foundation')
      if (!migration) throw new Error('0034 is missing from the migration journal.')
      const [before] = await proof<{ applied: boolean; cleanupPending: boolean }[]>`
        select
          exists(select 1 from drizzle.__drizzle_migrations where created_at = ${migration.when}) as applied,
          exists(select 1 from public.forge_protected_migration_handoffs where migration_tag = ${migration.tag} and cleanup_completed_at is null) as "cleanupPending"
      `
      if (!before?.applied || !before.cleanupPending) throw new Error('The forced failure did not leave the expected committed-ledger/open-cleanup recovery state.')
    } finally {
      await proof.end({ timeout: 5 })
    }
    await execFileAsync('npx', ['tsx', 'db/migrate.ts'], { cwd: process.cwd(), env: childEnv })
    await execFileAsync('npx', ['tsx', 'db/migrate.ts'], { cwd: process.cwd(), env: childEnv })
    const recovered = postgres(proofUrl, { max: 1, onnotice: () => {} })
    try {
      const [after] = await recovered<{ cleaned: boolean }[]>`
        select cleanup_completed_at is not null as cleaned
        from public.forge_protected_migration_handoffs
        where migration_tag = '0034_vnext_phase0_a1_runtime_foundation'
      `
      if (!after?.cleaned) throw new Error('Public db:migrate did not finish the durable protected-owner cleanup.')
    } finally {
      await recovered.end({ timeout: 5 })
    }
    console.log('✓ Protected migration cleanup failure, restart, and re-upgrade recovery proof passed.')
  } finally {
    if (proofUrl) {
      await admin.unsafe(`drop database if exists "${uniqueDatabase}" with (force)`).catch(() => {})
    }
    await admin.end({ timeout: 5 })
  }
}

main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
