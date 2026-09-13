/** Managed-Docker protected migration lifecycle. This controller owns the
 * complete fence: application quiescence through verified cleanup. */
import '../lib/load-env'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'
import { assertProtectedMigrationLiveAttestation } from './ci/protected-migration-state'
import { protectedMigrationForTag } from './ci/protected-migration-registry'

const LOCK = 334001
const RUNTIME_MIGRATION_TAG = '0034_vnext_phase0_a1_runtime_foundation'
const execFileAsync = promisify(execFile)
const safe = (value: string) => { if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Unsafe PostgreSQL identifier.'); return `"${value}"` }

function migrationUrl(adminUrl: string, migrationRole: string, migrationPassword: string): string {
  const result = new URL(adminUrl)
  result.username = migrationRole
  result.password = migrationPassword
  return result.toString()
}

async function closeLifecycleCas(sql: ReturnType<typeof postgres>, migrationRole: string): Promise<void> {
  const [state] = await sql<{ generation: string }[]>`
    select generation::text as generation from public.forge_protected_migration_handoffs
    where migration_tag=${RUNTIME_MIGRATION_TAG} and migration_role=${migrationRole}::name
      and cleanup_completed_at is not null
    for update
  `
  if (!state) throw new Error('Managed Docker protected migration did not close its durable cleanup state.')
  const [closed] = await sql`
    update public.forge_protected_migration_handoffs set generation=generation+1
    where migration_tag=${RUNTIME_MIGRATION_TAG} and migration_role=${migrationRole}::name
      and cleanup_completed_at is not null and generation=${state.generation}::bigint
    returning generation
  `
  if (!closed) throw new Error('Managed Docker protected migration cleanup state changed before its CAS close.')
}

/** Runs the only valid managed-Docker path. There is intentionally no public
 * prepare phase: releasing the fence before the child has finished is unsafe. */
export async function runManagedDockerMigration(): Promise<void> {
  const adminUrl = getRequiredEnv('FORGE_DATABASE_ADMIN_URL')
  const appPassword = getRequiredEnv('FORGE_APP_DATABASE_PASSWORD')
  const database = safe(new URL(adminUrl).pathname.slice(1))
  const migratorPassword = randomUUID()
  const migrator = `forge_migrator_${randomUUID().replaceAll('-', '')}`
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} })
  let locked = false
  let fenced = false
  try {
    await sql`select pg_advisory_lock(${LOCK})`
    locked = true
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
      if not exists(select 1 from pg_roles where rolname='forge_schema_owner') then create role forge_schema_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='forge') then create role forge login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='forge_runtime_api_login') then create role forge_runtime_api_login login noinherit connection limit 5 nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      alter role forge password '${appPassword.replaceAll("'", "''")}';
      create role ${safe(migrator)} login noinherit connection limit 1 password '${migratorPassword}' valid until (clock_timestamp() + interval '10 minutes') nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    end $$; grant forge_schema_owner to ${safe(migrator)} with inherit true; grant connect on database ${database} to ${safe(migrator)};`)
    // Legacy application objects never remain application-owned. The temporary
    // login only inherits the non-login schema role and is dropped in finally.
    await sql.unsafe(`reassign owned by forge to forge_schema_owner; alter role forge nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit;`)
    const [authority] = await sql<{ appSuper: boolean; appOwnsObjects: boolean }[]>`
      select (select rolsuper from pg_roles where rolname='forge') as "appSuper",
        exists(select 1 from pg_class where relnamespace='public'::regnamespace and relowner='forge'::regrole) as "appOwnsObjects"
    `
    if (authority?.appSuper || authority?.appOwnsObjects) throw new Error('Managed Docker app ownership reconciliation did not reach the required boundary.')

    await execFileAsync('bash', ['scripts/ci/apply-vnext-phase0-a1-runtime-foundation.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: migrationUrl(adminUrl, migrator, migratorPassword),
        FORGE_DATABASE_ADMIN_URL: adminUrl,
        FORGE_MANAGED_DOCKER_MIGRATIONS: '0',
      },
    })

    // The reconciler is mandatory, not a best-effort repair after reconnect.
    await sql.unsafe(await readFile('../scripts/reconcile-forge-app-privileges.sql', 'utf8'))
    const protectedMigration = protectedMigrationForTag(RUNTIME_MIGRATION_TAG)
    if (!protectedMigration) throw new Error('The managed Docker protected migration is absent from the checked-in registry.')
    await assertProtectedMigrationLiveAttestation(sql, protectedMigration, migrator)
    await closeLifecycleCas(sql, migrator)
  } finally {
    // Success and every failure path remove the ephemeral login before app
    // reconnect authority is restored; no process receives its credential.
    await sql.unsafe(`drop role if exists ${safe(migrator)}`).catch(() => {})
    if (fenced) await sql.unsafe(`grant connect on database ${database} to forge, forge_runtime_api_login;`).catch(() => {})
    if (locked) await sql`select pg_advisory_unlock(${LOCK})`.catch(() => {})
    await sql.end({ timeout: 5 })
  }
}

if (process.argv.includes('--run')) runManagedDockerMigration().then(() => console.log('✓ Managed Docker migration completed under the serialized controller.')).catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
