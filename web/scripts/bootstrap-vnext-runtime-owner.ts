import '../lib/load-env'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const OWNER = 'forge_runtime_routines_owner'

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('The migration login is not a safe PostgreSQL role identifier.')
  return `"${value}"`
}

async function main(): Promise<void> {
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) throw new Error('FORGE_DATABASE_ADMIN_URL is required for the VNext runtime owner handoff.')
  const migration = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
  const [{ migrationRole }] = await migration<{ migrationRole: string }[]>`select current_user as "migrationRole"`
  await migration.end({ timeout: 5 })
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`do $$ begin
      if not exists (select 1 from pg_catalog.pg_roles where rolname = '${OWNER}') then
        create role ${OWNER} noinherit nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      end if;
    end $$;`)
    if (process.argv.includes('--cleanup')) {
      await admin.unsafe(`revoke ${OWNER} from ${identifier(migrationRole)};`)
      // The protected creator validates Task compatibility ownership inside its
      // SECURITY DEFINER transaction. Retain exactly the two Task columns it
      // reads; every schema-expansion privilege is removed after migration.
      await admin.unsafe(`revoke create on schema public, forge from ${OWNER}; revoke select, references on table public.users, public.tasks from ${OWNER}; grant usage on schema forge to ${OWNER}; grant select (id, submitted_by) on table public.tasks to ${OWNER};`)
      const [boundary] = await admin<{ membership: boolean; publicCreate: boolean; forgeCreate: boolean; userSelect: boolean; userReferences: boolean; taskTableSelect: boolean; taskIdSelect: boolean; taskSubmittedBySelect: boolean; taskTitleSelect: boolean; taskReferences: boolean; forgeUsage: boolean }[]>`
        select
          pg_catalog.pg_has_role(${migrationRole}::name, ${OWNER}::name, 'member') as membership,
          pg_catalog.has_schema_privilege(${OWNER}, 'public', 'create') as "publicCreate",
          pg_catalog.has_schema_privilege(${OWNER}, 'forge', 'create') as "forgeCreate",
          pg_catalog.has_table_privilege(${OWNER}, 'public.users', 'select') as "userSelect",
          pg_catalog.has_table_privilege(${OWNER}, 'public.users', 'references') as "userReferences",
          pg_catalog.has_table_privilege(${OWNER}, 'public.tasks', 'select') as "taskTableSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.tasks', 'id', 'select') as "taskIdSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.tasks', 'submitted_by', 'select') as "taskSubmittedBySelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.tasks', 'title', 'select') as "taskTitleSelect",
          pg_catalog.has_table_privilege(${OWNER}, 'public.tasks', 'references') as "taskReferences",
          pg_catalog.has_schema_privilege(${OWNER}, 'forge', 'usage') as "forgeUsage"
      `
      if (boundary.membership || boundary.publicCreate || boundary.forgeCreate || boundary.userSelect || boundary.userReferences || boundary.taskTableSelect || !boundary.taskIdSelect || !boundary.taskSubmittedBySelect || boundary.taskTitleSelect || boundary.taskReferences || !boundary.forgeUsage) {
        throw new Error('The VNext runtime protected-owner cleanup did not restore the authority boundary.')
      }
      console.log('✓ Removed and verified the temporary VNext runtime owner handoff.')
      return
    }
    const [safeRole] = await admin<{ safe: boolean }[]>`
      select (not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole
        and not rolreplication and not rolbypassrls and rolpassword is null and rolvaliduntil is null) as safe
      from pg_catalog.pg_roles where rolname = ${OWNER}
    `
    if (!safeRole?.safe) throw new Error('The VNext runtime owner role is outside its exact non-login boundary.')
    // The migration needs only schema creation plus the exact users FK and
    // routine ownership read. Both grants are revoked in the EXIT cleanup.
    await admin.unsafe(`grant ${OWNER} to ${identifier(migrationRole)}; grant usage, create on schema public, forge to ${OWNER}; grant select, references on table public.users, public.tasks to ${OWNER};`)
  } finally {
    await admin.end({ timeout: 5 })
  }
  console.log('✓ Granted the migration login the bounded VNext runtime owner handoff.')
}

main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
