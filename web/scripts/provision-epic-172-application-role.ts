import '../lib/load-env'
import postgres from 'postgres'

const RELEASE_ROLE_NAMES = [
  'forge_release_evidence_writer',
  'forge_release_transition',
  'forge_release_routines_owner',
] as const

const RELEASE_TABLES = [
  'public.forge_release_signer_keys',
  'public.forge_release_signer_key_lifecycle_audits',
  'public.forge_epic_172_release_evidence',
  'public.forge_epic_172_transition_authorizations',
  'public.forge_epic_172_release_evidence_consumptions',
  'public.forge_epic_172_enablement_state',
  'public.forge_epic_172_enablement_transition_audits',
  'public.forge_epic_172_s3_release_state',
] as const

const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const

type ApplicationRoleRow = Readonly<{
  roleName: string
  canLogin: boolean
  inherits: boolean
  isSuperuser: boolean
  canCreateDatabase: boolean
  canCreateRole: boolean
  canReplicate: boolean
  bypassesRls: boolean
}>

function requiredConnectionUrl(name: 'FORGE_DATABASE_ADMIN_URL' | 'FORGE_APPLICATION_DATABASE_URL'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function applicationRoleIsUnsafe(role: ApplicationRoleRow): boolean {
  return !role.canLogin
    || role.inherits
    || role.isSuperuser
    || role.canCreateDatabase
    || role.canCreateRole
    || role.canReplicate
    || role.bypassesRls
}

async function main(): Promise<void> {
  const applicationClient = postgres(requiredConnectionUrl('FORGE_APPLICATION_DATABASE_URL'), {
    max: 1,
    onnotice: () => {},
  })
  let applicationRole: string
  try {
    const [identity] = await applicationClient<{ currentUser: string; sessionUser: string }[]>`
      select current_user as "currentUser", session_user as "sessionUser"
    `
    if (!identity || identity.currentUser !== identity.sessionUser) {
      throw new Error('FORGE_APPLICATION_DATABASE_URL must connect directly as the ordinary Forge application role without SET ROLE.')
    }
    applicationRole = identity.currentUser
  } finally {
    await applicationClient.end({ timeout: 5 })
  }

  if (RELEASE_ROLE_NAMES.includes(applicationRole as typeof RELEASE_ROLE_NAMES[number])) {
    throw new Error('The ordinary Forge application role must not be an Epic 172 release principal.')
  }

  const adminClient = postgres(requiredConnectionUrl('FORGE_DATABASE_ADMIN_URL'), {
    max: 1,
    onnotice: () => {},
  })
  try {
    const [authority] = await adminClient<{ currentUser: string; isSuperuser: boolean }[]>`
      select current_user as "currentUser", rolsuper as "isSuperuser"
      from pg_catalog.pg_roles
      where rolname = current_user
    `
    if (!authority?.isSuperuser) {
      throw new Error('FORGE_DATABASE_ADMIN_URL must use a short-lived PostgreSQL superuser that can grant and verify the fixed release-reader boundary.')
    }

    await adminClient.begin(async (client) => {
      const [role] = await client<ApplicationRoleRow[]>`
        select
          rolname as "roleName",
          rolcanlogin as "canLogin",
          rolinherit as "inherits",
          rolsuper as "isSuperuser",
          rolcreatedb as "canCreateDatabase",
          rolcreaterole as "canCreateRole",
          rolreplication as "canReplicate",
          rolbypassrls as "bypassesRls"
        from pg_catalog.pg_roles
        where rolname = ${applicationRole}
      `
      if (!role || applicationRoleIsUnsafe(role)) {
        throw new Error('The ordinary Forge application role must be LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS.')
      }

      const [{ membershipCount }] = await client<{ membershipCount: number }[]>`
        select count(*)::integer as "membershipCount"
        from pg_catalog.pg_auth_members membership
        where membership.member = ${applicationRole}::regrole
           or membership.roleid = ${applicationRole}::regrole
      `
      if (membershipCount !== 0) {
        throw new Error('The ordinary Forge application role must not inherit, assume, or delegate another PostgreSQL role.')
      }

      await client`grant usage on schema forge to ${client(applicationRole)}`
      await client`grant execute on function forge.read_epic_172_enablement_state_v1() to ${client(applicationRole)}`

      const [schemaBoundary] = await client<{
        hasUsage: boolean
        hasCreate: boolean
        hasPublicCreate: boolean
      }[]>`
        select
          pg_catalog.has_schema_privilege(${applicationRole}, 'forge', 'USAGE') as "hasUsage",
          pg_catalog.has_schema_privilege(${applicationRole}, 'forge', 'CREATE') as "hasCreate",
          pg_catalog.has_schema_privilege(${applicationRole}, 'public', 'CREATE') as "hasPublicCreate"
      `
      if (!schemaBoundary?.hasUsage || schemaBoundary.hasCreate || schemaBoundary.hasPublicCreate) {
        throw new Error('The ordinary Forge application role must have forge USAGE without CREATE on forge or public.')
      }

      const unexpectedTablePrivileges = await client<{ tableName: string; privilege: string }[]>`
        select release_table as "tableName", privilege
        from unnest(${client.array([...RELEASE_TABLES])}::text[]) release_table
        cross join unnest(${client.array([...TABLE_PRIVILEGES])}::text[]) privilege
        where pg_catalog.has_table_privilege(${applicationRole}, release_table, privilege)
        order by release_table, privilege
      `
      if (unexpectedTablePrivileges.length !== 0) {
        throw new Error('The ordinary Forge application role has a forbidden release-table privilege.')
      }

      const executableForgeFunctions = await client<{ functionName: string }[]>`
        select p.proname as "functionName"
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'forge'
          and pg_catalog.has_function_privilege(${applicationRole}, p.oid, 'EXECUTE')
        order by p.proname
      `
      if (
        executableForgeFunctions.length !== 1
        || executableForgeFunctions[0].functionName !== 'read_epic_172_enablement_state_v1'
      ) {
        throw new Error('The ordinary Forge application role must execute only forge.read_epic_172_enablement_state_v1().')
      }

      const [{ ownedObjectCount }] = await client<{ ownedObjectCount: number }[]>`
        select count(*)::integer as "ownedObjectCount"
        from pg_catalog.pg_class object
        join pg_catalog.pg_namespace namespace on namespace.oid = object.relnamespace
        where namespace.nspname = any(array['public', 'forge'])
          and object.relowner = ${applicationRole}::regrole
      `
      if (ownedObjectCount !== 0) {
        throw new Error('The ordinary Forge application role must not own objects in the public or forge schemas.')
      }
    })

    console.log(`✓ Provisioned and verified the fixed Epic 172 release-reader boundary for ${applicationRole} as ${authority.currentUser}.`)
    console.log('  Granted only forge schema USAGE and execution of forge.read_epic_172_enablement_state_v1().')
  } finally {
    await adminClient.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
