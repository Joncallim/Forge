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
  'work_package_local_run_evidence',
  'filesystem_mcp_decision_nonce_claims',
  'project_root_ref_reconciliation',
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
    const [{ canCreateRole, isSuperuser, serverVersion }] = await admin<{
      canCreateRole: boolean
      isSuperuser: boolean
      serverVersion: number
    }[]>`
      select rolcreaterole as "canCreateRole", rolsuper as "isSuperuser",
        current_setting('server_version_num')::integer as "serverVersion"
      from pg_catalog.pg_roles where rolname = current_user
    `
    if (!canCreateRole && !isSuperuser) throw new Error('The supplied database administrator cannot create S4 roles.')
    if (serverVersion < 160000) throw new Error('The S4 ownership bootstrap requires PostgreSQL 16 or newer.')

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
    await admin`grant usage on schema forge to ${admin(OWNER)}`
    await admin.unsafe(`
      grant usage on schema forge to
        forge_architect_plan_writer,
        forge_architect_plan_resolver,
        forge_architect_plan_history_reader,
        forge_packet_issuer
    `)
    await admin`revoke create on schema forge from ${admin(OWNER)}`
    await admin`revoke create on schema public from ${admin(OWNER)}`
    await admin`grant execute on function forge.read_epic_172_enablement_state_v1() to ${admin(OWNER)}`

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
      const migrationLiteral = literal(migrationRole)
      const tableList = OWNED_TABLES.map(literal).join(',')
      await admin.unsafe(`
        create or replace function public.forge_begin_epic_172_s4_owner_bootstrap_v1()
        returns void
        language plpgsql
        security definer
        set search_path = pg_catalog
        as $$
        begin
          if session_user <> ${migrationLiteral} then
            raise exception 'Only the bootstrapped migration login may begin S4 ownership'
              using errcode = '42501';
          end if;
          perform pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('forge:epic-172:s4-owner-bootstrap:v1', 0)
          );
          execute pg_catalog.format(
            'grant ${OWNER} to %I with admin false, inherit false, set true',
            session_user
          );
          if (select nspowner <> 'forge_release_routines_owner'::regrole
              from pg_catalog.pg_namespace where nspname = 'forge') is not false then
            raise exception 'The Step 0 forge schema owner is missing or incorrect'
              using errcode = '42501';
          end if;
          if not pg_catalog.pg_has_role(session_user, '${OWNER}', 'MEMBER') then
            raise exception 'The transaction-scoped S4 owner membership could not be installed'
              using errcode = '42501';
          end if;
          if (
            select pg_catalog.count(*)
            from pg_catalog.pg_auth_members membership
            where membership.roleid = '${OWNER}'::regrole
              and membership.member = session_user::regrole
              and not membership.admin_option
              and not membership.inherit_option
              and membership.set_option
          ) <> 1 then
            raise exception 'The transaction-scoped S4 owner membership is not exact'
              using errcode = '42501';
          end if;
          execute pg_catalog.format(
            'grant usage, create on schema forge to %I',
            session_user
          );
          if not pg_catalog.has_schema_privilege(session_user, 'forge', 'usage')
             or not pg_catalog.has_schema_privilege(session_user, 'forge', 'create') then
            raise exception 'The migration-scoped S4 schema ACL is incomplete'
              using errcode = '42501';
          end if;
        end;
        $$;

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
          if (
            select pg_catalog.count(*)
            from pg_catalog.pg_class table_row
            join pg_catalog.pg_namespace namespace_row
              on namespace_row.oid = table_row.relnamespace
            where namespace_row.nspname = 'public'
              and table_row.relkind = 'r'
              and table_row.relname = any(array[${tableList}])
              and table_row.relowner = '${OWNER}'::regrole
              and not exists (
                select 1
                from pg_catalog.aclexplode(
                  coalesce(
                    table_row.relacl,
                    pg_catalog.acldefault('r', table_row.relowner)
                  )
                ) acl
                where acl.grantee <> table_row.relowner
              )
          ) <> ${OWNED_TABLES.length} then
            raise exception 'The S4 protected table owner or direct ACL is incomplete: %', (
              select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'table', table_row.relname,
                'owner', table_row.relowner::pg_catalog.regrole::text,
                'acl', coalesce(table_row.relacl::text, '<default>')
              ) order by table_row.relname), '[]'::pg_catalog.jsonb)
              from pg_catalog.pg_class table_row
              join pg_catalog.pg_namespace namespace_row
                on namespace_row.oid = table_row.relnamespace
              where namespace_row.nspname = 'public'
                and table_row.relname = any(array[${tableList}])
            ) using errcode = '42501';
          end if;
          if (
            select pg_catalog.count(*)
            from pg_catalog.pg_proc routine
            join pg_catalog.pg_namespace namespace_row
              on namespace_row.oid = routine.pronamespace
            where namespace_row.nspname = 'forge'
              and routine.proname = any(array[
                'reject_s4_retained_mutation_v1',
                'guard_architect_plan_public_artifact_v1',
                'read_architect_plan_history_v1',
                'resolve_architect_plan_entry_v1',
                'validate_packet_authorization_snapshot_v2',
                'guard_packet_authorization_v2',
                'create_local_run_evidence_v1',
                'insert_packet_authorization_snapshot_v2',
                'insert_architect_plan_version_v1',
                'bind_architect_plan_entry_v1'
                ,'fill_project_root_ref_on_insert_v1'
                ,'guard_project_root_ref_renull_v1'
                ,'reconcile_project_root_refs_v1'
                ,'s4_protected_paths_enabled_v1'
                ,'bind_architect_replan_entry_v1'
              ])
              and routine.proowner = '${OWNER}'::regrole
              and not exists (
                select 1
                from pg_catalog.aclexplode(
                  coalesce(
                    routine.proacl,
                    pg_catalog.acldefault('f', routine.proowner)
                  )
                ) acl
                where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
              )
          ) <> 15 then
            raise exception 'The S4 routine owner or PUBLIC boundary is incomplete'
              using errcode = '42501';
          end if;
          if not pg_catalog.has_function_privilege(
               '${OWNER}', 'forge.read_epic_172_enablement_state_v1()', 'execute'
             ) or exists (
               select 1
               from pg_catalog.pg_proc routine
               join pg_catalog.pg_namespace namespace_row on namespace_row.oid = routine.pronamespace
               cross join lateral pg_catalog.aclexplode(
                 coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
               ) acl
               where namespace_row.nspname = 'forge'
                 and routine.proname = 'read_epic_172_enablement_state_v1'
                 and acl.grantee = 0
                 and acl.privilege_type = 'EXECUTE'
             ) then
            raise exception 'The Step 0 enablement reader grant to the S4 owner is not exact'
              using errcode = '42501';
          end if;
          if not pg_catalog.has_schema_privilege('${OWNER}', 'forge', 'usage')
             or pg_catalog.has_schema_privilege('${OWNER}', 'forge', 'create')
             or pg_catalog.has_schema_privilege('${OWNER}', 'public', 'create') then
            raise exception 'The S4 owner schema ACL is expanded before finalization'
              using errcode = '42501';
          end if;
          if exists (
            select 1
            from pg_catalog.unnest(array[
              'forge_architect_plan_writer',
              'forge_architect_plan_resolver',
              'forge_architect_plan_history_reader',
              'forge_packet_issuer'
            ]) role_name
            where not pg_catalog.has_schema_privilege(role_name, 'forge', 'usage')
               or pg_catalog.has_schema_privilege(role_name, 'forge', 'create')
          ) then
            raise exception 'A dedicated S4 login has an incorrect forge schema ACL'
              using errcode = '42501';
          end if;
          execute pg_catalog.format(
            'revoke usage, create on schema forge from %I',
            session_user
          );
          execute 'revoke create on schema forge from ${OWNER}';
          execute 'revoke create on schema public from ${OWNER}';
          execute pg_catalog.format('revoke ${OWNER} from %I', session_user);
          execute pg_catalog.format(
            'revoke execute on function public.forge_begin_epic_172_s4_owner_bootstrap_v1() from %I',
            session_user
          );
          execute pg_catalog.format(
            'revoke execute on function public.forge_finalize_epic_172_s4_owner_bootstrap_v1() from %I',
            session_user
          );
          if pg_catalog.has_schema_privilege(session_user, 'forge', 'usage')
             or pg_catalog.has_schema_privilege(session_user, 'forge', 'create')
             or pg_catalog.pg_has_role(session_user, '${OWNER}', 'MEMBER')
             or pg_catalog.has_function_privilege(
               session_user,
               'public.forge_begin_epic_172_s4_owner_bootstrap_v1()',
               'execute'
             )
             or pg_catalog.has_function_privilege(
               session_user,
               'public.forge_finalize_epic_172_s4_owner_bootstrap_v1()',
               'execute'
             ) then
            raise exception 'The migration-scoped S4 authority was not fully revoked'
              using errcode = '42501';
          end if;
          if not pg_catalog.has_schema_privilege('${OWNER}', 'forge', 'usage')
             or pg_catalog.has_schema_privilege('${OWNER}', 'forge', 'create')
             or pg_catalog.has_schema_privilege('${OWNER}', 'public', 'create') then
            raise exception 'The finalized S4 owner schema ACL is not exact'
              using errcode = '42501';
          end if;
        end;
        $$;
      `)
      await admin`revoke all on function public.forge_begin_epic_172_s4_owner_bootstrap_v1() from public`
      await admin`revoke all on function public.forge_finalize_epic_172_s4_owner_bootstrap_v1() from public`
      await admin`grant execute on function public.forge_begin_epic_172_s4_owner_bootstrap_v1() to ${admin(migrationRole)}`
      await admin`grant execute on function public.forge_finalize_epic_172_s4_owner_bootstrap_v1() to ${admin(migrationRole)}`
    }
    if (transferComplete) {
      await admin`revoke create on schema forge from ${admin(OWNER)}`
      await admin`revoke create on schema public from ${admin(OWNER)}`
      await admin`revoke usage, create on schema forge from ${admin(migrationRole)}`
      await admin.unsafe(`
        do $cleanup$
        begin
          if pg_catalog.to_regprocedure('public.forge_begin_epic_172_s4_owner_bootstrap_v1()') is not null then
            execute pg_catalog.format(
              'revoke execute on function public.forge_begin_epic_172_s4_owner_bootstrap_v1() from %I',
              ${literal(migrationRole)}
            );
          end if;
          if pg_catalog.to_regprocedure('public.forge_finalize_epic_172_s4_owner_bootstrap_v1()') is not null then
            execute pg_catalog.format(
              'revoke execute on function public.forge_finalize_epic_172_s4_owner_bootstrap_v1() from %I',
              ${literal(migrationRole)}
            );
          end if;
        end;
        $cleanup$;
      `)
    }

    const roles = await admin<{
      bypassRls: boolean
      canCreateDb: boolean
      canCreateRole: boolean
      canLogin: boolean
      inherits: boolean
      isReplication: boolean
      isSuperuser: boolean
      roleName: string
    }[]>`
      select rolname as "roleName", rolcanlogin as "canLogin", rolinherit as "inherits",
        rolsuper as "isSuperuser", rolcreatedb as "canCreateDb",
        rolcreaterole as "canCreateRole", rolreplication as "isReplication",
        rolbypassrls as "bypassRls"
      from pg_catalog.pg_roles
      where rolname = any(${LOGIN_ROLES})
      order by rolname
    `
    if (roles.length !== LOGIN_ROLES.length || roles.some((role) => (
      !role.canLogin || role.inherits || role.isSuperuser || role.canCreateDb
      || role.canCreateRole || role.isReplication || role.bypassRls
    ))) {
      throw new Error('Dedicated S4 login verification failed.')
    }
    const [owner] = await admin<{
      bypassRls: boolean
      canCreateDb: boolean
      canCreateRole: boolean
      canLogin: boolean
      inherits: boolean
      isReplication: boolean
      isSuperuser: boolean
    }[]>`
      select rolcanlogin as "canLogin", rolinherit as "inherits",
        rolsuper as "isSuperuser", rolcreatedb as "canCreateDb",
        rolcreaterole as "canCreateRole", rolreplication as "isReplication",
        rolbypassrls as "bypassRls"
      from pg_catalog.pg_roles where rolname = ${OWNER}
    `
    if (!owner || owner.canLogin || owner.inherits || owner.isSuperuser
        || owner.canCreateDb || owner.canCreateRole || owner.isReplication || owner.bypassRls) {
      throw new Error('The S4 routines owner must remain an unprivileged NOLOGIN NOINHERIT role.')
    }

    const [{ membershipCount }] = await admin<{ membershipCount: number }[]>`
      select count(*)::integer as "membershipCount"
      from pg_catalog.pg_auth_members membership
      where membership.roleid = any(${[OWNER, ...LOGIN_ROLES]}::regrole[])
         or membership.member = any(${[OWNER, ...LOGIN_ROLES]}::regrole[])
    `
    if (membershipCount !== 0 && transferComplete) {
      throw new Error('A finalized S4 principal has an unexpected role membership.')
    }
    const [enablementReaderGrant] = await admin<{
      canExecute: boolean
      publicCanExecute: boolean
    }[]>`
      select
        pg_catalog.has_function_privilege(
          ${OWNER}, 'forge.read_epic_172_enablement_state_v1()', 'execute'
        ) as "canExecute",
        exists (
          select 1
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace_row on namespace_row.oid = routine.pronamespace
          cross join lateral pg_catalog.aclexplode(
            coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
          ) acl
          where namespace_row.nspname = 'forge'
            and routine.proname = 'read_epic_172_enablement_state_v1'
            and acl.grantee = 0
            and acl.privilege_type = 'EXECUTE'
        ) as "publicCanExecute"
    `
    if (!enablementReaderGrant?.canExecute || enablementReaderGrant.publicCanExecute) {
      throw new Error('The S4 owner must use the non-PUBLIC Step 0 enablement reader boundary.')
    }

    console.log(`✓ Verified ${roles.length} dedicated S4 logins and ${OWNER}.`)
    console.log(transferComplete
      ? `✓ S4 objects already belong to ${OWNER}; ${migrationRole} remains unprivileged.`
      : `✓ Installed the migration-0027-only S4 ownership fence for ${migrationRole}; migration 0027 revokes it.`)
    console.log('  Configure certificate authentication and role-specific connection URLs before enabling S4 producers.')
  } finally {
    await admin.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
