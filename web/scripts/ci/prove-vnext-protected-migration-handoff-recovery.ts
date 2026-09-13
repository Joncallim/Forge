/**
 * Disposable PostgreSQL proof for the only A1 recovery window: 0034 has
 * committed to Drizzle's ledger but the protected-owner cleanup did not.
 *
 * Set FORGE_VNEXT_RUNTIME_HANDOFF_RECOVERY_TEST_URL to an administrator URL.
 * The proof creates and drops one uniquely named database and non-superuser
 * migration owner of its own. It also supplies the historical literal `forge`
 * login when that role is not already provisioned by the disposable cluster.
 */
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { protectedMigrationRecoveryPlan, syntheticFutureProtectedMigration } from './protected-migration-registry'

const execFileAsync = promisify(execFile)
const target = process.env.FORGE_VNEXT_RUNTIME_HANDOFF_RECOVERY_TEST_URL?.trim()

if (!target) throw new Error('FORGE_VNEXT_RUNTIME_HANDOFF_RECOVERY_TEST_URL is required for the disposable protected-migration recovery proof.')

function withDatabase(connectionString: string, database: string): string {
  const parsed = new URL(connectionString)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

function migrationDatabaseUrl(adminConnectionString: string, database: string, migrationRole: string, migrationPassword: string): string {
  const parsed = new URL(withDatabase(adminConnectionString, database))
  // Deliberately discard the administrator credential instead of putting it on
  // the normal migration connection. The fresh credential is process-local and
  // never printed or stored.
  parsed.username = migrationRole
  parsed.password = migrationPassword
  return parsed.toString()
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('The disposable PostgreSQL identifier is not safe.')
  return `"${value}"`
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function assertSyntheticFutureProtectedMigration(): void {
  const recoveryPlan = protectedMigrationRecoveryPlan({
    journalTags: [syntheticFutureProtectedMigration.migrationTag],
    appliedTags: new Set(),
    cleanupPendingTags: new Set(),
    cleanupStateTags: new Set(),
    registry: [syntheticFutureProtectedMigration],
  })
  if (recoveryPlan.length !== 1 || recoveryPlan[0] !== syntheticFutureProtectedMigration) {
    throw new Error('The protected migration registry did not route the synthetic future migration through its wrapper.')
  }
}

async function main(): Promise<void> {
  const uniqueDatabase = `forge_a1_handoff_${randomUUID().replaceAll('-', '')}`
  const migrationRole = `forge_a1_migration_${randomUUID().replaceAll('-', '')}`
  const migrationPassword = randomBytes(32).toString('base64url')
  const admin = postgres(withDatabase(target!, 'postgres'), { max: 1, onnotice: () => {} })
  let proofAdminUrl: string | undefined
  let migrationUrl: string | undefined
  let legacyForgeCreated = false
  try {
    await admin.unsafe(`create role ${identifier(migrationRole)} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${literal(migrationPassword)}`)
    const [legacyForge] = await admin<{ exists: boolean }[]>`
      select exists(select 1 from pg_catalog.pg_roles where rolname = 'forge') as exists
    `
    if (!legacyForge?.exists) {
      await admin.unsafe('create role forge login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password null')
      legacyForgeCreated = true
    }
    await admin.unsafe(`create database ${identifier(uniqueDatabase)} owner ${identifier(migrationRole)}`)
    proofAdminUrl = withDatabase(target!, uniqueDatabase)
    migrationUrl = migrationDatabaseUrl(target!, uniqueDatabase, migrationRole, migrationPassword)
    const migration = postgres(migrationUrl, { max: 1, onnotice: () => {} })
    try {
      const [identity] = await migration<{ currentUser: string; sessionUser: string; superuser: boolean; ownsDatabase: boolean }[]>`
        select
          current_user as "currentUser",
          session_user as "sessionUser",
          (select rolsuper from pg_catalog.pg_roles where rolname = current_user) as superuser,
          (select datdba = current_user::regrole from pg_catalog.pg_database where datname = current_database()) as "ownsDatabase"
      `
      if (!identity || identity.currentUser !== migrationRole || identity.sessionUser !== migrationRole || identity.superuser || !identity.ownsDatabase) {
        throw new Error('The disposable proof did not establish a direct non-superuser database-owner migration login.')
      }
    } finally {
      await migration.end({ timeout: 5 })
    }
    const childEnv = {
      ...process.env,
      DATABASE_URL: migrationUrl,
      FORGE_DATABASE_ADMIN_URL: proofAdminUrl,
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
    const proof = postgres(proofAdminUrl, { max: 1, onnotice: () => {} })
    try {
      const journal = JSON.parse(await readFile('db/migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string; when: number }> }
      const migration = journal.entries.find((entry) => entry.tag === '0034_vnext_phase0_a1_runtime_foundation')
      if (!migration) throw new Error('0034 is missing from the migration journal.')
      const [before] = await proof<{ applied: boolean; cleanupPending: boolean; matchingMigrationRole: boolean }[]>`
        select
          exists(select 1 from drizzle.__drizzle_migrations where created_at = ${migration.when}) as applied,
          exists(select 1 from public.forge_protected_migration_handoffs where migration_tag = ${migration.tag} and cleanup_completed_at is null) as "cleanupPending",
          exists(select 1 from public.forge_protected_migration_handoffs where migration_tag = ${migration.tag} and migration_role = ${migrationRole}::name) as "matchingMigrationRole"
      `
      if (!before?.applied || !before.cleanupPending || !before.matchingMigrationRole) throw new Error('The forced failure did not leave the expected committed-ledger/open-cleanup recovery state.')
      console.log('VNEXT_A1_PROTECTED_CLEANUP_FAILURE_PASSED')
    } finally {
      await proof.end({ timeout: 5 })
    }
    await execFileAsync('npx', ['tsx', 'db/migrate.ts'], { cwd: process.cwd(), env: childEnv })
    const recoveredOnce = postgres(proofAdminUrl, { max: 1, onnotice: () => {} })
    let firstRecovery: { ledgerCount: number; handoffOpenedAt: string; cleanupCompletedAt: string } | undefined
    try {
      const [after] = await recoveredOnce<{ ledgerCount: number; handoffOpenedAt: string | null; cleanupCompletedAt: string | null }[]>`
        select
          (select count(*)::integer from drizzle.__drizzle_migrations) as "ledgerCount",
          handoff_opened_at::text as "handoffOpenedAt",
          cleanup_completed_at::text as "cleanupCompletedAt"
        from public.forge_protected_migration_handoffs
        where migration_tag = '0034_vnext_phase0_a1_runtime_foundation'
      `
      if (!after?.cleanupCompletedAt || !after.handoffOpenedAt) throw new Error('Public db:migrate did not finish the durable protected-owner cleanup.')
      firstRecovery = { ledgerCount: after.ledgerCount, handoffOpenedAt: after.handoffOpenedAt, cleanupCompletedAt: after.cleanupCompletedAt }
      console.log('VNEXT_A1_PROTECTED_RESTART_PASSED')
    } finally {
      await recoveredOnce.end({ timeout: 5 })
    }
    await execFileAsync('npx', ['tsx', 'db/migrate.ts'], { cwd: process.cwd(), env: childEnv })
    const recovered = postgres(proofAdminUrl, { max: 1, onnotice: () => {} })
    try {
      const [after] = await recovered<{ ledgerCount: number; handoffOpenedAt: string | null; cleanupCompletedAt: string | null }[]>`
        select
          (select count(*)::integer from drizzle.__drizzle_migrations) as "ledgerCount",
          handoff_opened_at::text as "handoffOpenedAt",
          cleanup_completed_at::text as "cleanupCompletedAt"
        from public.forge_protected_migration_handoffs
        where migration_tag = '0034_vnext_phase0_a1_runtime_foundation'
      `
      if (!firstRecovery || !after?.cleanupCompletedAt || after.ledgerCount !== firstRecovery.ledgerCount
        || after.handoffOpenedAt !== firstRecovery.handoffOpenedAt || after.cleanupCompletedAt !== firstRecovery.cleanupCompletedAt) {
        throw new Error('The public db:migrate rerun was not idempotent after protected-owner cleanup recovery.')
      }
    } finally {
      await recovered.end({ timeout: 5 })
    }
    const expectFailClosedRestart = async (): Promise<void> => {
      try {
        await execFileAsync('npx', ['tsx', 'db/migrate.ts'], { cwd: process.cwd(), env: childEnv })
        throw new Error('A partial restore without durable protected-migration state unexpectedly restarted.')
      } catch (error) {
        const stderr = typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr : ''
        if (!stderr.includes("Applied protected migration '0034_vnext_phase0_a1_runtime_foundation' has no durable handoff state")) {
          throw new Error(stderr || (error instanceof Error ? error.message : String(error)))
        }
      }
    }
    const corruptState = postgres(proofAdminUrl, { max: 1, onnotice: () => {} })
    try {
      // A partially restored table without the committed handoff row must not
      // be mistaken for a completed cleanup.
      await corruptState`delete from public.forge_protected_migration_handoffs where migration_tag = '0034_vnext_phase0_a1_runtime_foundation'`
    } finally {
      await corruptState.end({ timeout: 5 })
    }
    await expectFailClosedRestart()
    const missingTable = postgres(proofAdminUrl, { max: 1, onnotice: () => {} })
    try {
      // Neither may a restored ledger with the state table entirely absent.
      await missingTable`drop table public.forge_protected_migration_handoffs`
    } finally {
      await missingTable.end({ timeout: 5 })
    }
    await expectFailClosedRestart()
    assertSyntheticFutureProtectedMigration()
    console.log('VNEXT_A1_PROTECTED_REUPGRADE_PASSED')
    console.log('✓ Protected migration cleanup failure, restart, re-upgrade, and future-registry recovery proof passed.')
  } finally {
    if (proofAdminUrl) {
      await admin.unsafe(`drop database if exists "${uniqueDatabase}" with (force)`).catch(() => {})
    }
    await admin.unsafe(`drop role if exists ${identifier(migrationRole)}`).catch(() => {})
    if (legacyForgeCreated) await admin.unsafe('drop role if exists forge').catch(() => {})
    await admin.end({ timeout: 5 })
  }
}

main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
