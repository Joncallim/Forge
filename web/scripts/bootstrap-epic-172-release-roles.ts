import '../lib/load-env'
import postgres from 'postgres'

const ROLE_NAMES = [
  'forge_release_evidence_writer',
  'forge_release_evidence_consumer',
  'forge_release_transition',
] as const

async function main(): Promise<void> {
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) {
    throw new Error(
      'FORGE_DATABASE_ADMIN_URL is required. Use a short-lived PostgreSQL administrator connection; the ordinary Forge application role must not create release principals.',
    )
  }

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
      end;
      $$;
    `)

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

    console.log(`✓ Verified ${roles.length} dedicated NOINHERIT release roles as ${authority.currentUser}.`)
    console.log('  Configure certificate authentication and role-specific connection URLs outside Forge before recording evidence.')
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
