/** Managed-Docker protected migration lifecycle. This controller owns the
 * complete fence: application quiescence through verified cleanup. */
import '../lib/load-env'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'
import { assertProtectedMigrationLiveAttestation, ensureProtectedMigrationState, recordProtectedMigrationCleanup, recordProtectedMigrationHandoff } from './ci/protected-migration-state'
import { assertProtectedMigrationMarkers, protectedMigrationForTag } from './ci/protected-migration-registry'
import { runEpic172ReleaseRoleBootstrap } from './bootstrap-epic-172-release-roles'
import { runEpic172S3OwnerBootstrap } from './bootstrap-epic-172-s3-release-owner'
import { runEpic172S4RoleBootstrap } from './bootstrap-epic-172-s4-roles'
import { runEpic172LegacyReleaseRepair } from './repair-epic-172-legacy-release'
import { runEpic172S5OwnerBootstrap } from './bootstrap-epic-172-s5-recovery-owner'

const LOCK = 334001
const RUNTIME_MIGRATION_TAG = '0034_vnext_phase0_a1_runtime_foundation'
const OWNER = 'forge_runtime_routines_owner'
const API = 'forge_runtime_api'
const execFileAsync = promisify(execFile)
const safe = (value: string) => { if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Unsafe PostgreSQL identifier.'); return `"${value}"` }

function migrationUrl(adminUrl: string, migrationRole: string, migrationPassword: string): string {
  const result = new URL(adminUrl)
  result.username = migrationRole
  result.password = migrationPassword
  return result.toString()
}

/** The trusted historical bootstrap modules keep their own exact catalog
 * verification.  Calling them here keeps the administrator secret in the
 * one-shot controller process; no migration child inherits it. */
async function withControllerMigrationIdentity<T>(url: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = url
  try { return await run() } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
}

async function closeLifecycleCas(sql: ReturnType<typeof postgres>, migrationRole: string, attestedGeneration: bigint): Promise<void> {
  const [closed] = await sql`
    update public.forge_protected_migration_handoffs set generation=generation+1
    where migration_tag=${RUNTIME_MIGRATION_TAG} and migration_role=${migrationRole}::name
      and cleanup_completed_at is not null and generation=${attestedGeneration.toString()}::bigint
    returning generation
  `
  if (!closed) throw new Error('Managed Docker protected migration cleanup state changed before its CAS close.')
}

async function openRuntimeHandoff(sql: ReturnType<typeof postgres>, migrationRole: string, runtimePassword: string): Promise<void> {
  const protectedMigration = protectedMigrationForTag(RUNTIME_MIGRATION_TAG)
  if (!protectedMigration) throw new Error('The managed Docker protected migration is absent from the checked-in registry.')
  await sql.unsafe(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='${OWNER}') then create role ${OWNER} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
    if not exists(select 1 from pg_roles where rolname='${API}') then create role ${API} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
    alter role forge_runtime_api_login password '${runtimePassword.replaceAll("'", "''")}';
  end $$;
  grant ${API} to forge_runtime_api_login with inherit true;
  grant ${OWNER} to ${safe(migrationRole)};
  grant usage, create on schema public, forge to ${OWNER} with grant option;
  grant usage on schema forge to ${API};
  grant select, references on table public.users, public.sessions, public.tasks, public.projects to ${OWNER};`)
  await recordProtectedMigrationHandoff(sql, protectedMigration, migrationRole)
}

async function closeRuntimeHandoff(sql: ReturnType<typeof postgres>, migrationRole: string): Promise<void> {
  const protectedMigration = protectedMigrationForTag(RUNTIME_MIGRATION_TAG)
  if (!protectedMigration) throw new Error('The managed Docker protected migration is absent from the checked-in registry.')
  await sql.unsafe(`revoke ${OWNER} from ${safe(migrationRole)};
    revoke create on schema public, forge from ${OWNER};
    -- 0034 re-grants forge usage to the API group while the owner handoff is
    -- open.  Remove that dependent grant along with the temporary grant
    -- option, then re-issue the exact API usage below as controller/admin.
    revoke grant option for usage on schema public, forge from ${OWNER} cascade;
    revoke select, update, references on table public.users, public.sessions, public.tasks, public.projects from ${OWNER};
    grant usage on schema forge to ${OWNER};
    grant usage on schema forge to ${API};
    grant select, update on table public.sessions to ${OWNER};
    grant select (id, project_id, submitted_by) on table public.tasks to ${OWNER};
    grant select (id, submitted_by, root_ref, root_binding_revision, archived_at) on table public.projects to ${OWNER};`)
  await recordProtectedMigrationCleanup(sql, protectedMigration, migrationRole)
}

/** Runs the only valid managed-Docker path. There is intentionally no public
 * prepare phase: releasing the fence before the child has finished is unsafe. */
export async function runManagedDockerMigration(): Promise<void> {
  const adminUrl = getRequiredEnv('FORGE_DATABASE_ADMIN_URL')
  const appPassword = getRequiredEnv('FORGE_APP_DATABASE_PASSWORD')
  const runtimePassword = getRequiredEnv('FORGE_RUNTIME_API_DATABASE_PASSWORD')
  const database = safe(new URL(adminUrl).pathname.slice(1))
  const migratorPassword = randomUUID()
  const migrator = `forge_migrator_${randomUUID().replaceAll('-', '')}`
  const migratorExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} })
  let locked = false
  let fenced = false
  let handoffOpened = false
  let s5HandoffOpened = false
  try {
    const journal = JSON.parse(await readFile(resolve(process.cwd(), 'db/migrations/meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> }
    await assertProtectedMigrationMarkers(resolve(process.cwd(), 'db/migrations'), journal.entries.map((entry) => entry.tag))
    await sql`select pg_advisory_lock(${LOCK})`
    locked = true
    // A blank PostgreSQL cluster has no application roles yet.  Provision the
    // non-privileged identities before the fence references them; PostgreSQL
    // otherwise rejects REVOKE CONNECT for a role that does not exist.
    await sql.unsafe(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='forge_schema_owner') then create role forge_schema_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='forge') then create role forge login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='forge_runtime_api_login') then create role forge_runtime_api_login login noinherit connection limit 5 nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      alter role forge password '${appPassword.replaceAll("'", "''")}';
    end $$;`)
    // Fence only Forge runtime connections. The admin connection holding the
    // lock remains alive throughout child execution and final verification.
    await sql.unsafe(`revoke connect on database ${database} from forge, forge_runtime_api_login;`)
    fenced = true
    await sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname=current_database() and usename=any(array['forge','forge_runtime_api_login'])
        and pid <> pg_backend_pid()
    `
    await sql.unsafe(`do $$ begin
      create role ${safe(migrator)} login noinherit connection limit 1 password '${migratorPassword}' valid until '${migratorExpiresAt}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    end $$; grant forge_schema_owner to ${safe(migrator)} with inherit true; grant connect, create on database ${database} to forge_schema_owner; grant usage, create on schema public to forge_schema_owner; grant connect on database ${database} to ${safe(migrator)};`)
    // Legacy application objects never remain application-owned. The temporary
    // login only inherits the non-login schema role and is dropped in finally.
    await sql.unsafe(`reassign owned by forge to forge_schema_owner; alter role forge nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit;`)
    const [authority] = await sql<{ appSuper: boolean; appOwnsObjects: boolean }[]>`
      select (select rolsuper from pg_roles where rolname='forge') as "appSuper",
        exists(select 1 from pg_class where relnamespace='public'::regnamespace and relowner='forge'::regrole) as "appOwnsObjects"
    `
    if (authority?.appSuper || authority?.appOwnsObjects) throw new Error('Managed Docker app ownership reconciliation did not reach the required boundary.')

    // A normal managed-service restart must not reopen a completed protected
    // handoff under a new disposable login.  Its durable row identifies the
    // original login for the same catalog attestation instead.
    const targetEntry = journal.entries.find((entry) => entry.tag === RUNTIME_MIGRATION_TAG)
    let completedMigrationRole: string | undefined
    if (targetEntry) {
      try {
        const [completed] = await sql<{ migrationRole: string }[]>`
          select handoff.migration_role::text as "migrationRole"
          from public.forge_protected_migration_handoffs handoff
          where handoff.migration_tag=${RUNTIME_MIGRATION_TAG}
            and handoff.cleanup_completed_at is not null
            and exists(select 1 from drizzle.__drizzle_migrations where created_at=${targetEntry.when})
        `
        completedMigrationRole = completed?.migrationRole
      } catch (error) {
        if ((error as { code?: string }).code !== '42P01') throw error
      }
    }
    if (completedMigrationRole) {
      await sql.unsafe(`alter role forge password '${appPassword.replaceAll("'", "''")}'; alter role forge_runtime_api_login password '${runtimePassword.replaceAll("'", "''")}'; grant ${API} to forge_runtime_api_login with inherit true;`)
      await sql.unsafe(await readFile('../scripts/reconcile-forge-app-privileges.sql', 'utf8'))
      await ensureProtectedMigrationState(sql)
      const protectedMigration = protectedMigrationForTag(RUNTIME_MIGRATION_TAG)
      if (!protectedMigration) throw new Error('The managed Docker protected migration is absent from the checked-in registry.')
      await assertProtectedMigrationLiveAttestation(sql, protectedMigration, completedMigrationRole)
      return
    }

    const childEnv = {
      PATH: process.env.PATH ?? '',
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      DATABASE_URL: migrationUrl(adminUrl, migrator, migratorPassword),
      FORGE_MANAGED_DOCKER_MIGRATIONS: '0',
    }
    const runChild = (script: string) => execFileAsync('npx', ['tsx', script], { cwd: process.cwd(), env: childEnv })
    const runControllerBootstrap = <T>(bootstrap: () => Promise<T>) => withControllerMigrationIdentity(childEnv.DATABASE_URL, bootstrap)

    // Preserve the historical order and bootstrap invariants.  These calls
    // run in this locked controller, not as children carrying admin secrets.
    await runControllerBootstrap(runEpic172ReleaseRoleBootstrap)
    await runChild('scripts/ci/migrate-through-0025.ts')
    await runControllerBootstrap(runEpic172S3OwnerBootstrap)
    await runChild('scripts/ci/migrate-through-0026.ts')
    await runControllerBootstrap(runEpic172LegacyReleaseRepair)
    await runControllerBootstrap(runEpic172S4RoleBootstrap)
    await runChild('scripts/ci/migrate-through-0027.ts')
    await runControllerBootstrap(runEpic172S5OwnerBootstrap)
    s5HandoffOpened = true
    await runChild('scripts/ci/migrate-through-0028.ts')
    await runControllerBootstrap(() => runEpic172S5OwnerBootstrap(true))
    s5HandoffOpened = false
    await runControllerBootstrap(runEpic172S5OwnerBootstrap)
    s5HandoffOpened = true
    await runChild('scripts/ci/migrate-through-0033.ts')
    await runControllerBootstrap(() => runEpic172S5OwnerBootstrap(true))
    s5HandoffOpened = false

    // The protected 0034 owner is not granted until all source objects exist.
    // It also makes the ordinary Drizzle ledger/schema available to the
    // schema-owner context used by the final child without retaining the
    // disposable login as an owner.
    await sql.unsafe(`reassign owned by ${safe(migrator)} to forge_schema_owner;`)
    await openRuntimeHandoff(sql, migrator, runtimePassword)
    handoffOpened = true
    // This second child applies only 0034 (the ledger has the prefix).  It
    // receives neither administrator authority nor the application passwords.
    await execFileAsync('npx', ['tsx', 'scripts/ci/migrate-through-0034.ts'], {
      cwd: process.cwd(),
      env: childEnv,
    })
    await closeRuntimeHandoff(sql, migrator)
    handoffOpened = false
    // Historical ordinary migrations execute as the disposable session so
    // their exact `current_user` bootstrap guards remain valid.  Transfer any
    // residual ordinary objects before the login is destroyed; protected
    // migration objects have already moved to their dedicated owner roles.
    await sql.unsafe(`reassign owned by ${safe(migrator)} to forge_schema_owner;`)
    // The reconciler is mandatory, not a best-effort repair after reconnect.
    await sql.unsafe(await readFile('../scripts/reconcile-forge-app-privileges.sql', 'utf8'))
    // The shared reconciler grants legacy app access to ordinary public
    // tables.  Reapply the controller-only state ACL after that broad pass.
    await ensureProtectedMigrationState(sql)
    const protectedMigration = protectedMigrationForTag(RUNTIME_MIGRATION_TAG)
    if (!protectedMigration) throw new Error('The managed Docker protected migration is absent from the checked-in registry.')
    const attestedGeneration = await assertProtectedMigrationLiveAttestation(sql, protectedMigration, migrator)
    await closeLifecycleCas(sql, migrator, attestedGeneration)
  } finally {
    // Success and every failure path remove the ephemeral login before app
    // reconnect authority is restored; no process receives its credential.
    if (handoffOpened) await closeRuntimeHandoff(sql, migrator).catch(() => {})
    if (s5HandoffOpened) await withControllerMigrationIdentity(migrationUrl(adminUrl, migrator, migratorPassword), () => runEpic172S5OwnerBootstrap(true)).catch(() => {})
    await sql.unsafe(`revoke forge_schema_owner from ${safe(migrator)}`).catch(() => {})
    // REASSIGN above moved relations; DROP OWNED now removes only residual
    // grants/dependencies that would otherwise keep this expiring login alive.
    await sql.unsafe(`drop owned by ${safe(migrator)}`).catch(() => {})
    await sql.unsafe(`drop role if exists ${safe(migrator)}`).catch(() => {})
    if (fenced) await sql.unsafe(`grant connect on database ${database} to forge, forge_runtime_api_login;`).catch(() => {})
    if (locked) await sql`select pg_advisory_unlock(${LOCK})`.catch(() => {})
    await sql.end({ timeout: 5 })
  }
}

if (process.argv.includes('--run')) runManagedDockerMigration().then(() => console.log('✓ Managed Docker migration completed under the serialized controller.')).catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
