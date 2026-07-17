import '../lib/load-env'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const ROLE_NAMES = [
  'forge_release_evidence_writer',
  'forge_release_evidence_consumer',
  'forge_release_transition',
] as const
const ROUTINES_OWNER = 'forge_release_routines_owner'

async function main(): Promise<void> {
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) {
    throw new Error(
      'FORGE_DATABASE_ADMIN_URL is required. Use a short-lived PostgreSQL administrator connection; the ordinary Forge application role must not create release principals.',
    )
  }

  const migrationClient = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
  const [{ migrationRole }] = await migrationClient<{ migrationRole: string }[]>`
    select current_user as "migrationRole"
  `
  await migrationClient.end({ timeout: 5 })

  const client = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    const [authority] = await client<{
      currentUser: string
      canCreateRole: boolean
      isSuperuser: boolean
    }[]>`
      select
        current_user as "currentUser",
        rolcreaterole as "canCreateRole",
        rolsuper as "isSuperuser"
      from pg_roles
      where rolname = current_user
    `
    if (!authority || (!authority.canCreateRole && !authority.isSuperuser)) {
      throw new Error('The supplied PostgreSQL administrator cannot create the dedicated release roles.')
    }

    await client.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'forge_release_evidence_writer') then
          create role forge_release_evidence_writer login noinherit nosuperuser nocreatedb nocreaterole noreplication;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'forge_release_evidence_consumer') then
          create role forge_release_evidence_consumer login noinherit nosuperuser nocreatedb nocreaterole noreplication;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'forge_release_transition') then
          create role forge_release_transition login noinherit nosuperuser nocreatedb nocreaterole noreplication;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'forge_release_routines_owner') then
          create role forge_release_routines_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication;
        end if;
      end;
      $$;
    `)

    await client`grant create on schema public to forge_release_routines_owner`
    const [{ ownedReleaseTables }] = await client<{ ownedReleaseTables: number }[]>`
      select count(*)::integer as "ownedReleaseTables"
      from pg_catalog.pg_tables
      where schemaname = 'public'
        and tableowner = 'forge_release_routines_owner'
        and tablename = any(array[
          'forge_release_signer_keys',
          'forge_release_signer_key_lifecycle_audits',
          'forge_epic_172_release_evidence',
          'forge_epic_172_transition_authorizations',
          'forge_epic_172_release_evidence_consumptions',
          'forge_epic_172_enablement_state',
          'forge_epic_172_enablement_transition_audits'
        ])
    `
    const transferComplete = ownedReleaseTables === 7
    if (transferComplete) {
      // Re-running bootstrap after migration must not silently restore owner
      // authority to the ordinary application login.
      await client`revoke forge_release_routines_owner from ${client(migrationRole)}`
    } else {
      await client`revoke forge_release_routines_owner from ${client(migrationRole)}`
      await client`grant forge_release_routines_owner to ${client(migrationRole)}`
      const [membership] = await client<{ adminOption: boolean; membershipCount: number }[]>`
        select
          coalesce(pg_catalog.bool_or(admin_option), false) as "adminOption",
          pg_catalog.count(*)::integer as "membershipCount"
        from pg_catalog.pg_auth_members
        where roleid = 'forge_release_routines_owner'::regrole
          and member = ${migrationRole}::regrole
      `
      if (!membership || membership.membershipCount !== 1 || membership.adminOption) {
        throw new Error('Temporary release-owner membership must exist without delegation authority.')
      }
      const migrationRoleLiteral = `'${migrationRole.replaceAll("'", "''")}'`
      await client.unsafe(`
        create or replace function public.forge_finalize_epic_172_release_owner_bootstrap_v1()
        returns void
        language plpgsql
        security definer
        set search_path = pg_catalog
        as $$
        begin
          if session_user <> ${migrationRoleLiteral} then
            raise exception 'Only the bootstrapped migration login may finalize Epic 172 release ownership'
              using errcode = '42501';
          end if;
          if exists (
            select 1
            from pg_catalog.pg_tables
            where schemaname = 'public'
              and tablename = any(array[
                'forge_release_signer_keys',
                'forge_release_signer_key_lifecycle_audits',
                'forge_epic_172_release_evidence',
                'forge_epic_172_transition_authorizations',
                'forge_epic_172_release_evidence_consumptions',
                'forge_epic_172_enablement_state',
                'forge_epic_172_enablement_transition_audits'
              ])
              and tableowner <> 'forge_release_routines_owner'
          ) then
            raise exception 'Epic 172 release ownership transfer is incomplete'
              using errcode = '42501';
          end if;
          execute pg_catalog.format(
            'revoke forge_release_routines_owner from %I',
            session_user
          );
          execute pg_catalog.format(
            'revoke execute on function public.forge_finalize_epic_172_release_owner_bootstrap_v1() from %I',
            session_user
          );
        end;
        $$;
      `)
      await client`revoke all on function public.forge_finalize_epic_172_release_owner_bootstrap_v1() from public`
      await client`grant execute on function public.forge_finalize_epic_172_release_owner_bootstrap_v1() to ${client(migrationRole)}`
    }

    const roles = await client<{
      canLogin: boolean
      inherits: boolean
      roleName: string
    }[]>`
      select
        rolname as "roleName",
        rolcanlogin as "canLogin",
        rolinherit as "inherits"
      from pg_roles
      where rolname in (
        'forge_release_evidence_writer',
        'forge_release_evidence_consumer',
        'forge_release_transition'
      )
      order by rolname
    `
    if (
      roles.length !== ROLE_NAMES.length ||
      roles.some((role) => !role.canLogin || role.inherits)
    ) {
      throw new Error('Dedicated release-role verification failed; no database migration was attempted.')
    }

    const [owner] = await client<{
      canLogin: boolean
      inherits: boolean
      roleName: string
    }[]>`
      select
        rolname as "roleName",
        rolcanlogin as "canLogin",
        rolinherit as "inherits"
      from pg_roles
      where rolname = ${ROUTINES_OWNER}
    `
    if (!owner || owner.canLogin || owner.inherits) {
      throw new Error('The release-routines owner must be a NOLOGIN NOINHERIT role.')
    }

    console.log(`✓ Verified ${roles.length} dedicated NOINHERIT release roles as ${authority.currentUser}.`)
    if (transferComplete) {
      console.log(`✓ Release objects already belong to ${ROUTINES_OWNER}; migration role ${migrationRole} remains unprivileged.`)
    } else {
      console.log(`✓ Temporarily authorized migration role ${migrationRole} to transfer release objects to ${ROUTINES_OWNER}.`)
      console.log('  The release-routines migration revokes that temporary membership before it commits.')
    }
    console.log('  Configure certificate authentication and role-specific connection URLs outside Forge before recording evidence.')
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
