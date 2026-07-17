import '../lib/load-env'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const LOGIN_ROLES = [
  'forge_architect_plan_writer',
  'forge_architect_plan_resolver',
  'forge_architect_plan_history_reader',
  'forge_packet_issuer',
] as const
const OWNER = 'forge_s4_routines_owner'
const OWNED_TABLES = [
  'architect_plan_versions',
  'architect_plan_entries',
  'architect_plan_execution_references',
  'architect_plan_history_reads',
  'epic_172_s4_protocol_state',
  'work_package_local_run_evidence',
  'filesystem_mcp_decision_nonce_claims',
] as const

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function main(): Promise<void> {
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) {
    throw new Error('FORGE_DATABASE_ADMIN_URL is required; the ordinary Forge login must not create S4 principals.')
  }

  const migration = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
  const [{ migrationRole }] = await migration<{ migrationRole: string }[]>`select current_user as "migrationRole"`
  await migration.end({ timeout: 5 })

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    const [{ canCreateRole, isSuperuser }] = await admin<{ canCreateRole: boolean; isSuperuser: boolean }[]>`
      select rolcreaterole as "canCreateRole", rolsuper as "isSuperuser"
      from pg_catalog.pg_roles where rolname = current_user
    `
    if (!canCreateRole && !isSuperuser) throw new Error('The supplied database administrator cannot create S4 roles.')

    await admin.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_catalog.pg_roles where rolname = '${OWNER}') then
          create role ${OWNER} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication;
        end if;
        ${LOGIN_ROLES.map((role) => `
        if not exists (select 1 from pg_catalog.pg_roles where rolname = '${role}') then
          create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication;
        end if;`).join('')}
      end;
      $$;
    `)
    await admin`create schema if not exists forge authorization ${admin(migrationRole)}`
    await admin`grant usage, create on schema forge to ${admin(OWNER)}`
    await admin`grant create on schema public to ${admin(OWNER)}`

    const [{ ownedTables }] = await admin<{ ownedTables: number }[]>`
      select count(*)::integer as "ownedTables"
      from pg_catalog.pg_tables
      where schemaname = 'public'
        and tableowner = ${OWNER}
        and tablename = any(${OWNED_TABLES})
    `
    const transferComplete = ownedTables === OWNED_TABLES.length
    await admin`revoke ${admin(OWNER)} from ${admin(migrationRole)}`
    if (!transferComplete) {
      await admin`grant ${admin(OWNER)} to ${admin(migrationRole)}`
      const migrationLiteral = literal(migrationRole)
      const tableList = OWNED_TABLES.map(literal).join(',')
      await admin.unsafe(`
        create or replace function public.forge_finalize_epic_172_s4_owner_bootstrap_v1()
        returns void
        language plpgsql
        security definer
        set search_path = pg_catalog
        as $$
        begin
          if session_user <> ${migrationLiteral} then
            raise exception 'Only the bootstrapped migration login may finalize S4 ownership'
              using errcode = '42501';
          end if;
          if exists (
            select 1 from pg_catalog.pg_tables
            where schemaname = 'public'
              and tablename = any(array[${tableList}])
              and tableowner <> '${OWNER}'
          ) then
            raise exception 'S4 ownership transfer is incomplete' using errcode = '42501';
          end if;
          execute pg_catalog.format('revoke ${OWNER} from %I', session_user);
          execute pg_catalog.format(
            'revoke execute on function public.forge_finalize_epic_172_s4_owner_bootstrap_v1() from %I',
            session_user
          );
        end;
        $$;
      `)
      await admin`revoke all on function public.forge_finalize_epic_172_s4_owner_bootstrap_v1() from public`
      await admin`grant execute on function public.forge_finalize_epic_172_s4_owner_bootstrap_v1() to ${admin(migrationRole)}`
    }

    const roles = await admin<{ canLogin: boolean; inherits: boolean; roleName: string }[]>`
      select rolname as "roleName", rolcanlogin as "canLogin", rolinherit as "inherits"
      from pg_catalog.pg_roles
      where rolname = any(${LOGIN_ROLES})
      order by rolname
    `
    if (roles.length !== LOGIN_ROLES.length || roles.some((role) => !role.canLogin || role.inherits)) {
      throw new Error('Dedicated S4 login verification failed.')
    }
    const [owner] = await admin<{ canLogin: boolean; inherits: boolean }[]>`
      select rolcanlogin as "canLogin", rolinherit as "inherits"
      from pg_catalog.pg_roles where rolname = ${OWNER}
    `
    if (!owner || owner.canLogin || owner.inherits) throw new Error('The S4 routines owner must remain NOLOGIN NOINHERIT.')

    console.log(`✓ Verified ${roles.length} dedicated S4 logins and ${OWNER}.`)
    console.log(transferComplete
      ? `✓ S4 objects already belong to ${OWNER}; ${migrationRole} remains unprivileged.`
      : `✓ Temporarily authorized ${migrationRole} to transfer S4 ownership; migration 0027 revokes it.`)
    console.log('  Configure certificate authentication and role-specific connection URLs before enabling S4 producers.')
  } finally {
    await admin.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
