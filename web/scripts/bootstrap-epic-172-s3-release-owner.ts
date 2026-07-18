import '../lib/load-env'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const ROUTINES_OWNER = 'forge_release_routines_owner'
const RELEASE_ROLES = [
  'forge_release_evidence_writer',
  'forge_release_transition',
  ROUTINES_OWNER,
] as const

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function main(): Promise<void> {
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) {
    throw new Error(
      'FORGE_DATABASE_ADMIN_URL is required. Use a short-lived PostgreSQL administrator connection for the versioned S3 owner handoff.',
    )
  }

  const migrationClient = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
  const [{ migrationRole }] = await migrationClient<{ migrationRole: string }[]>`
    select session_user as "migrationRole"
  `
  await migrationClient.end({ timeout: 5 })
  if (!migrationRole || RELEASE_ROLES.includes(migrationRole as typeof RELEASE_ROLES[number])) {
    throw new Error('The S3 migration login must be an ordinary role distinct from every release principal.')
  }

  const client = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    const [authority] = await client<{
      currentUser: string
      canCreateRole: boolean
      isSuperuser: boolean
      serverVersion: number
    }[]>`
      select
        current_user as "currentUser",
        rolcreaterole as "canCreateRole",
        rolsuper as "isSuperuser",
        current_setting('server_version_num')::integer as "serverVersion"
      from pg_catalog.pg_roles
      where rolname = current_user
    `
    if (!authority || (!authority.canCreateRole && !authority.isSuperuser)) {
      throw new Error('The supplied PostgreSQL administrator cannot grant the temporary S3 owner membership.')
    }
    if (authority.serverVersion < 160000) {
      throw new Error('The S3 owner handoff requires PostgreSQL 16 or newer membership options.')
    }

    const roles = await client<{
      roleName: string
      canLogin: boolean
      inherits: boolean
      isSuperuser: boolean
      canCreateDatabase: boolean
      canCreateRole: boolean
      canReplicate: boolean
      bypassesRls: boolean
    }[]>`
      select
        rolname as "roleName",
        rolcanlogin as "canLogin",
        rolinherit as inherits,
        rolsuper as "isSuperuser",
        rolcreatedb as "canCreateDatabase",
        rolcreaterole as "canCreateRole",
        rolreplication as "canReplicate",
        rolbypassrls as "bypassesRls"
      from pg_catalog.pg_roles
      where rolname = any(${client.array([...RELEASE_ROLES])}::text[])
      order by rolname
    `
    if (
      roles.length !== RELEASE_ROLES.length
      || roles.some((role) => (
        role.canLogin !== (role.roleName !== ROUTINES_OWNER)
        || role.inherits
        || role.isSuperuser
        || role.canCreateDatabase
        || role.canCreateRole
        || role.canReplicate
        || role.bypassesRls
      ))
    ) {
      throw new Error('The Step 0 release roles are absent or no longer have their exact least-privilege attributes.')
    }

    const [installed] = await client<{ s3Complete: boolean }[]>`
      select exists (
        select 1
        from pg_catalog.pg_class table_row
        join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
        where namespace_row.nspname = 'public'
          and table_row.relname = 'forge_epic_172_s3_release_state'
          and table_row.relkind = 'r'
          and table_row.relowner = 'forge_release_routines_owner'::regrole
      ) as "s3Complete"
    `
    if (installed?.s3Complete) {
      await client`revoke forge_release_routines_owner from ${client(migrationRole)}`
      await client.unsafe(`
        do $cleanup$
        begin
          if pg_catalog.to_regprocedure('public.forge_begin_epic_172_s3_owner_bootstrap_v1()') is not null then
            execute pg_catalog.format(
              'revoke execute on function public.forge_begin_epic_172_s3_owner_bootstrap_v1() from %I',
              ${quotedLiteral(migrationRole)}
            );
          end if;
          if pg_catalog.to_regprocedure('public.forge_finalize_epic_172_s3_owner_bootstrap_v1()') is not null then
            execute pg_catalog.format(
              'revoke execute on function public.forge_finalize_epic_172_s3_owner_bootstrap_v1() from %I',
              ${quotedLiteral(migrationRole)}
            );
          end if;
        end;
        $cleanup$;
      `)
      console.log(`✓ S3 release ownership is already complete; ${migrationRole} remains unprivileged.`)
      return
    }

    const migrationRoleLiteral = quotedLiteral(migrationRole)
    await client.unsafe(`
      create or replace function public.forge_begin_epic_172_s3_owner_bootstrap_v1()
      returns void
      language plpgsql
      security definer
      set search_path = pg_catalog
      as $bootstrap$
      declare
        v_membership_count integer;
      begin
        if session_user <> ${migrationRoleLiteral} then
          raise exception 'Only the bootstrapped migration login may begin Epic 172 S3 ownership'
            using errcode = '42501';
        end if;
        if current_setting('server_version_num')::integer < 160000 then
          raise exception 'Epic 172 S3 ownership requires PostgreSQL 16 or newer'
            using errcode = '0A000';
        end if;
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('forge:epic-172:s3-owner-bootstrap:v1', 0)
        );
        if (select nspowner <> 'forge_release_routines_owner'::regrole
            from pg_catalog.pg_namespace where nspname = 'forge') is not false then
          raise exception 'The Step 0 forge schema owner is missing or incorrect'
            using errcode = '42501';
        end if;
        if (
          select pg_catalog.count(*)
          from pg_catalog.pg_class table_row
          join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
          where namespace_row.nspname = 'public'
            and table_row.relkind = 'r'
            and table_row.relname = any(array[
              'forge_release_signer_keys',
              'forge_release_signer_key_lifecycle_audits',
              'forge_epic_172_release_evidence',
              'forge_epic_172_transition_authorizations',
              'forge_epic_172_release_evidence_consumptions',
              'forge_epic_172_enablement_state',
              'forge_epic_172_enablement_transition_audits'
            ])
            and table_row.relowner = 'forge_release_routines_owner'::regrole
        ) <> 7 then
          raise exception 'The exact Step 0 release tables are not owned by the release-routines owner'
            using errcode = '42501';
        end if;
        if exists (
          select 1
          from pg_catalog.pg_auth_members membership
          join pg_catalog.pg_roles granted on granted.oid = membership.roleid
          join pg_catalog.pg_roles member on member.oid = membership.member
          where granted.rolname = any(array[${RELEASE_ROLES.map(quotedLiteral).join(',')}])
             or member.rolname = any(array[${RELEASE_ROLES.map(quotedLiteral).join(',')}])
        ) then
          raise exception 'A competing release-role membership exists before the S3 handoff'
            using errcode = '42501';
        end if;
        execute 'grant select (id, local_projection_scope_state), references (id) on table public.tasks to forge_release_routines_owner';
        execute 'grant select (id, task_id), references (id) on table public.work_packages to forge_release_routines_owner';
        execute 'grant trigger on table public.work_packages to forge_release_routines_owner';
        execute pg_catalog.format(
          'grant forge_release_routines_owner to %I with admin false, inherit false, set true',
          session_user
        );
        select pg_catalog.count(*)::integer
        into v_membership_count
        from pg_catalog.pg_auth_members membership
        where membership.roleid = 'forge_release_routines_owner'::regrole
          and membership.member = session_user::regrole
          and not membership.admin_option
          and not membership.inherit_option
          and membership.set_option;
        if v_membership_count <> 1 then
          raise exception 'The temporary S3 owner membership is not exact'
            using errcode = '42501';
        end if;
      end;
      $bootstrap$;

      create or replace function public.forge_finalize_epic_172_s3_owner_bootstrap_v1()
      returns void
      language plpgsql
      security definer
      set search_path = pg_catalog
      as $bootstrap$
      begin
        if session_user <> ${migrationRoleLiteral} then
          raise exception 'Only the bootstrapped migration login may finalize Epic 172 S3 ownership'
            using errcode = '42501';
        end if;
        if not exists (
          select 1
          from pg_catalog.pg_class table_row
          join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
          where namespace_row.nspname = 'public'
            and table_row.relname = 'forge_epic_172_s3_release_state'
            and table_row.relkind = 'r'
            and table_row.relowner = 'forge_release_routines_owner'::regrole
            and (
              select pg_catalog.count(*)
              from pg_catalog.aclexplode(table_row.relacl) acl
              where acl.grantee = 0
                and acl.privilege_type = 'SELECT'
            ) = 1
            and (
              select pg_catalog.count(*)
              from pg_catalog.aclexplode(table_row.relacl) acl
              where acl.grantee = 'forge_release_evidence_writer'::regrole
                and acl.privilege_type = any(array['SELECT', 'INSERT', 'UPDATE'])
            ) = 3
            and not exists (
              select 1
              from pg_catalog.aclexplode(table_row.relacl) acl
              where acl.grantee <> table_row.relowner
                and not (
                  (acl.grantee = 0 and acl.privilege_type = 'SELECT')
                  or (
                    acl.grantee = 'forge_release_evidence_writer'::regrole
                    and acl.privilege_type = any(array['SELECT', 'INSERT', 'UPDATE'])
                  )
                )
            )
        ) then
          raise exception 'The S3 release state owner or direct table ACL is incorrect'
            using errcode = '42501';
        end if;
        if (
          select pg_catalog.count(*)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace_row on namespace_row.oid = routine.pronamespace
          where namespace_row.nspname = 'forge'
            and routine.proname = any(array[
              'lock_epic_172_s3_completion_v1',
              'complete_epic_172_s3_release_v1'
            ])
            and routine.proowner = 'forge_release_routines_owner'::regrole
            and routine.prosecdef
            and routine.proconfig = array['search_path=pg_catalog, public']
            and not exists (
              select 1
              from pg_catalog.aclexplode(
                coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
              ) acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
            )
            and pg_catalog.has_function_privilege('forge_release_transition', routine.oid, 'execute')
        ) <> 2 then
          raise exception 'The exact fixed-path S3 completion routine boundary is incomplete'
            using errcode = '42501';
        end if;
        execute 'revoke references (id) on table public.tasks from forge_release_routines_owner';
        execute 'revoke references (id) on table public.work_packages from forge_release_routines_owner';
        execute 'revoke trigger on table public.work_packages from forge_release_routines_owner';
        if not pg_catalog.has_column_privilege(
          'forge_release_routines_owner', 'public.work_packages', 'id', 'select'
        ) or not pg_catalog.has_column_privilege(
          'forge_release_routines_owner', 'public.tasks', 'id', 'select'
        ) or not pg_catalog.has_column_privilege(
          'forge_release_routines_owner', 'public.work_packages', 'task_id', 'select'
        ) or not pg_catalog.has_column_privilege(
          'forge_release_routines_owner', 'public.tasks', 'local_projection_scope_state', 'select'
        ) or pg_catalog.has_table_privilege(
          'forge_release_routines_owner', 'public.work_packages', 'select'
        ) or pg_catalog.has_table_privilege(
          'forge_release_routines_owner', 'public.work_packages', 'references'
        ) or pg_catalog.has_table_privilege(
          'forge_release_routines_owner', 'public.work_packages', 'trigger'
        ) or pg_catalog.has_table_privilege(
          'forge_release_routines_owner', 'public.tasks', 'references'
        ) then
          raise exception 'The post-bootstrap S3 source-table ACL is not exact'
            using errcode = '42501';
        end if;
        if (
          select pg_catalog.count(*)
          from pg_catalog.pg_class table_row
          join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
          where namespace_row.nspname = 'public'
            and table_row.relname = any(array[
              'work_package_local_projection_heads',
              'work_package_local_projection_sources'
            ])
            and table_row.relkind = 'r'
            and table_row.relowner = 'forge_release_routines_owner'::regrole
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
        ) <> 2 then
          raise exception 'The projection source/head table owner or direct ACL is not exact'
            using errcode = '42501';
        end if;
        if not exists (
          select 1
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace_row on namespace_row.oid = routine.pronamespace
          where namespace_row.nspname = 'forge'
            and routine.proname = 'advance_local_projection_head_v1'
            and routine.proowner = 'forge_release_routines_owner'::regrole
            and routine.prosecdef
            and routine.proconfig = array['search_path=""']
            and not exists (
              select 1
              from pg_catalog.aclexplode(
                coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
              ) acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
            )
        ) then
          raise exception 'The projection-head advancement routine boundary is not exact'
            using errcode = '42501';
        end if;
        execute pg_catalog.format('revoke forge_release_routines_owner from %I', session_user);
        execute pg_catalog.format(
          'revoke execute on function public.forge_begin_epic_172_s3_owner_bootstrap_v1() from %I',
          session_user
        );
        execute pg_catalog.format(
          'revoke execute on function public.forge_finalize_epic_172_s3_owner_bootstrap_v1() from %I',
          session_user
        );
      end;
      $bootstrap$;
    `)
    await client`revoke all on function public.forge_begin_epic_172_s3_owner_bootstrap_v1() from public`
    await client`revoke all on function public.forge_finalize_epic_172_s3_owner_bootstrap_v1() from public`
    await client`grant execute on function public.forge_begin_epic_172_s3_owner_bootstrap_v1() to ${client(migrationRole)}`
    await client`grant execute on function public.forge_finalize_epic_172_s3_owner_bootstrap_v1() to ${client(migrationRole)}`

    console.log(`✓ Installed the migration-0026-only S3 owner handoff for ${migrationRole}.`)
    console.log(`  Migration 0026 will grant, use, and revoke ${ROUTINES_OWNER} in one transaction.`)
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
