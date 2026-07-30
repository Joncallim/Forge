import '../lib/load-env'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const BEGIN = 'public.forge_begin_epic_172_s4_owner_bootstrap_v1()'
const FINALIZE = 'public.forge_finalize_epic_172_s4_owner_bootstrap_v1()'

async function main(): Promise<void> {
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) throw new Error('FORGE_DATABASE_ADMIN_URL is required for the one-shot S5 owner handoff.')
  const migration = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
  const [{ migrationRole }] = await migration<{ migrationRole: string }[]>`select current_user as "migrationRole"`
  await migration.end({ timeout: 5 })
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`
      grant execute on function ${BEGIN}, ${FINALIZE} to ${admin(migrationRole)};
    `)
    const [{ grants }] = await admin<{ grants: number }[]>`
      select count(*)::integer as "grants"
      from pg_catalog.aclexplode(coalesce(
        (select proacl from pg_catalog.pg_proc where oid = ${BEGIN}::regprocedure),
        pg_catalog.acldefault('f', (select proowner from pg_catalog.pg_proc where oid = ${BEGIN}::regprocedure))
      )) acl
      where acl.grantee = ${migrationRole}::regrole and acl.privilege_type = 'EXECUTE'
    `
    if (grants !== 1) throw new Error('The S5 recovery migration did not receive one exact bootstrap execute grant.')
  } finally {
    await admin.end({ timeout: 5 })
  }
  console.log('✓ Granted the migration login one transaction-scoped S5 recovery owner handoff.')
}

main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
