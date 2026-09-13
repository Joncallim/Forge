/** Managed-Docker authority controller.  It is deliberately the only place
 * that may create the short-lived migration login or transfer legacy owners. */
import '../lib/load-env'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const LOCK = 334001
const roles = ['forge_admin', 'forge_schema_owner', 'forge', 'forge_runtime_api_login'] as const
const safe = (value: string) => { if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Unsafe PostgreSQL identifier.'); return `"${value}"` }

export async function prepareManagedDockerMigration(): Promise<{ migrator: string }> {
  const adminUrl = getRequiredEnv('FORGE_DATABASE_ADMIN_URL')
  const appPassword = getRequiredEnv('FORGE_APP_DATABASE_PASSWORD')
  const database = safe(new URL(adminUrl).pathname.slice(1))
  const migratorPassword = randomUUID()
  const migrator = `forge_migrator_${randomUUID().replaceAll('-', '')}`
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    await sql`select pg_advisory_lock(${LOCK})`
    // Scope session fencing to Forge application logins only: never terminate
    // the administrator or unrelated database clients.
    await sql.unsafe(`revoke connect on database ${database} from forge, forge_runtime_api_login;`)
    await sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = current_database() and usename = any(array['forge','forge_runtime_api_login'])
        and pid <> pg_backend_pid()
    `
    await sql.unsafe(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='forge_schema_owner') then create role forge_schema_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='forge') then create role forge login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='forge_runtime_api_login') then create role forge_runtime_api_login login noinherit connection limit 5 nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      alter role forge password '${appPassword.replaceAll("'", "''")}';
      create role ${safe(migrator)} login noinherit connection limit 1 password '${migratorPassword}' valid until (clock_timestamp() + interval '10 minutes') nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    end $$;`)
    // One-time legacy demotion is idempotent. Ownership transfer is exact and
    // catalog-driven, avoiding broad ALTER DATABASE or unrelated objects.
    await sql.unsafe(`reassign owned by forge to forge_schema_owner; alter role forge nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit;`)
    const [live] = await sql<{ appSuper: boolean; schemaLogin: boolean }[]>`
      select (select rolsuper from pg_roles where rolname='forge') as "appSuper",
             (select rolcanlogin from pg_roles where rolname='forge_schema_owner') as "schemaLogin"
    `
    if (live?.appSuper || live?.schemaLogin) throw new Error('Managed Docker role reconciliation did not reach the required authority boundary.')
    return { migrator }
  } catch (error) {
    await sql.unsafe(`drop role if exists ${safe(migrator)}`).catch(() => {})
    throw error
  } finally {
    await sql.unsafe(`grant connect on database ${database} to forge, forge_runtime_api_login`).catch(() => {})
    await sql`select pg_advisory_unlock(${LOCK})`.catch(() => {})
    await sql.end({ timeout: 5 })
  }
}

if (process.argv.includes('--prepare')) prepareManagedDockerMigration().then(() => console.log('✓ Managed Docker migration authority is prepared.')).catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
