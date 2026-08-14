import '../lib/load-env'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const BEGIN = 'public.forge_begin_epic_172_s4_owner_bootstrap_v1()'
const FINALIZE = 'public.forge_finalize_epic_172_s4_owner_bootstrap_v1()'

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('The migration login is not a safe PostgreSQL role identifier.')
  return `"${value}"`
}

async function main(): Promise<void> {
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) throw new Error('FORGE_DATABASE_ADMIN_URL is required for the one-shot protected-owner handoff.')
  const migration = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
  const [{ migrationRole }] = await migration<{ migrationRole: string }[]>`select current_user as "migrationRole"`
  await migration.end({ timeout: 5 })
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    if (process.argv.includes('--cleanup')) {
      // This is deliberately idempotent. A failed protected migration can
      // leave the migration login or owner holding authority opened by BEGIN;
      // every wrapper invokes this path unconditionally.
      await admin.unsafe(`revoke execute on function ${BEGIN}, ${FINALIZE} from ${identifier(migrationRole)};`)
      await admin.unsafe(`revoke forge_s4_routines_owner from ${identifier(migrationRole)};`)
      await admin.unsafe(`revoke create on schema forge from ${identifier(migrationRole)};`)
      await admin.unsafe('revoke create on schema public, forge from forge_s4_routines_owner;')
      await admin.unsafe('grant usage on schema forge to forge_s4_routines_owner;')
      const [{ executeGrants, ownerMembership, migrationSchemaCreate,
        ownerPublicCreate, ownerForgeCreate, ownerForgeUsage }] = await admin<{
        executeGrants: number
        ownerMembership: boolean
        migrationSchemaCreate: boolean
        ownerPublicCreate: boolean
        ownerForgeCreate: boolean
        ownerForgeUsage: boolean
      }[]>`
        select
          (select count(*)::integer
           from pg_catalog.pg_proc routine
           cross join lateral pg_catalog.aclexplode(coalesce(
             routine.proacl, pg_catalog.acldefault('f', routine.proowner)
           )) acl
           where routine.oid = any(array[${BEGIN}::regprocedure, ${FINALIZE}::regprocedure])
             and acl.grantee = ${migrationRole}::regrole
             and acl.privilege_type = 'EXECUTE') as "executeGrants",
          pg_catalog.pg_has_role(${migrationRole}::name, 'forge_s4_routines_owner', 'MEMBER') as "ownerMembership",
          pg_catalog.has_schema_privilege(${migrationRole}::name, 'forge', 'CREATE') as "migrationSchemaCreate",
          pg_catalog.has_schema_privilege('forge_s4_routines_owner', 'public', 'CREATE') as "ownerPublicCreate",
          pg_catalog.has_schema_privilege('forge_s4_routines_owner', 'forge', 'CREATE') as "ownerForgeCreate",
          pg_catalog.has_schema_privilege('forge_s4_routines_owner', 'forge', 'USAGE') as "ownerForgeUsage"
      `
      if (executeGrants !== 0 || ownerMembership || migrationSchemaCreate
        || ownerPublicCreate || ownerForgeCreate || !ownerForgeUsage) {
        throw new Error('The protected-owner cleanup did not restore the exact authority boundary.')
      }
      console.log('✓ Removed and verified every temporary protected-owner handoff edge.')
      return
    }
    await admin.unsafe(`grant execute on function ${BEGIN}, ${FINALIZE} to ${identifier(migrationRole)};`)
    const [{ grants }] = await admin<{ grants: number }[]>`
      select count(*)::integer as "grants"
      from pg_catalog.pg_proc routine
      cross join lateral pg_catalog.aclexplode(coalesce(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) acl
      where routine.oid = any(array[${BEGIN}::regprocedure, ${FINALIZE}::regprocedure])
        and acl.grantee = ${migrationRole}::regrole
        and acl.privilege_type = 'EXECUTE'
    `
    if (grants !== 2) throw new Error('The protected migration did not receive both exact handoff execute grants.')
  } finally {
    await admin.end({ timeout: 5 })
  }
  console.log('✓ Granted the migration login the bounded protected-owner handoff routines.')
}

main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
