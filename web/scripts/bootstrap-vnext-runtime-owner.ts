import '../lib/load-env'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'
import { protectedMigrationForTag } from './ci/protected-migration-registry'
import { recordProtectedMigrationCleanup, recordProtectedMigrationHandoff } from './ci/protected-migration-state'

const OWNER = 'forge_runtime_routines_owner'
// This is a non-login capability group. The server login is separately
// provisioned as its member; `forge` never receives that membership.
const API = 'forge_runtime_api'
const runtimeFoundationMigration = (() => {
  const migration = protectedMigrationForTag('0034_vnext_phase0_a1_runtime_foundation')
  if (!migration) throw new Error('The VNext runtime protected migration is missing from the checked-in registry.')
  return migration
})()

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('The migration login is not a safe PostgreSQL role identifier.')
  return `"${value}"`
}

async function main(): Promise<void> {
  // Docker and ordinary self-hosted installations commonly run migrations with
  // the database owner itself. Use that documented normal path first; hosted
  // PostgreSQL may provide a short-lived administrator URL for the one-time
  // protected-owner handoff.
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim() || getRequiredEnv('DATABASE_URL')
  const migration = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
  const [{ migrationRole }] = await migration<{ migrationRole: string }[]>`select current_user as "migrationRole"`
  await migration.end({ timeout: 5 })
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`do $$ begin
      if not exists (select 1 from pg_catalog.pg_roles where rolname = '${OWNER}') then
        create role ${OWNER} noinherit nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      end if;
      if not exists (select 1 from pg_catalog.pg_roles where rolname = '${API}') then
        create role ${API} noinherit nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      end if;
    end $$;`)
    if (process.argv.includes('--cleanup')) {
      // Test-only fault injection covers the process-restart window after the
      // Drizzle ledger committed but before this cleanup could run.
      if (process.env.FORGE_VNEXT_RUNTIME_FORCE_CLEANUP_FAILURE === '1') {
        throw new Error('Forced VNext runtime protected-owner cleanup failure.')
      }
      await admin.unsafe(`revoke ${OWNER} from ${identifier(migrationRole)};`)
      // PostgreSQL requires table SELECT and UPDATE to lock a live session
      // row. That is the sole table-wide source authority; Task and Project
      // stay scoped to the columns that derive compatibility bindings.
      await admin.unsafe(`revoke create on schema public, forge from ${OWNER}; revoke grant option for usage on schema public, forge from ${OWNER}; revoke select, update, references on table public.users, public.sessions, public.tasks, public.projects from ${OWNER}; grant usage on schema forge to ${OWNER}; grant select, update on table public.sessions to ${OWNER}; grant select (id, project_id, submitted_by) on table public.tasks to ${OWNER}; grant select (id, submitted_by, root_ref, root_binding_revision, archived_at) on table public.projects to ${OWNER};`)
      const [boundary] = await admin<{ membership: boolean; publicCreate: boolean; forgeCreate: boolean; userSelect: boolean; userReferences: boolean; sessionTableSelect: boolean; sessionTableUpdate: boolean; sessionUserSelect: boolean; sessionCredentialSelect: boolean; sessionRevokedSelect: boolean; sessionExpiresSelect: boolean; sessionIpSelect: boolean; taskTableSelect: boolean; taskIdSelect: boolean; taskProjectIdSelect: boolean; taskSubmittedBySelect: boolean; taskTitleSelect: boolean; taskReferences: boolean; projectTableSelect: boolean; projectIdSelect: boolean; projectSubmittedBySelect: boolean; projectRootRefSelect: boolean; projectRootRevisionSelect: boolean; projectArchivedAtSelect: boolean; projectNameSelect: boolean; forgeUsage: boolean }[]>`
        select
          pg_catalog.pg_has_role(${migrationRole}::name, ${OWNER}::name, 'member') as membership,
          pg_catalog.has_schema_privilege(${OWNER}, 'public', 'create') as "publicCreate",
          pg_catalog.has_schema_privilege(${OWNER}, 'forge', 'create') as "forgeCreate",
          pg_catalog.has_table_privilege(${OWNER}, 'public.users', 'select') as "userSelect",
          pg_catalog.has_table_privilege(${OWNER}, 'public.users', 'references') as "userReferences",
          pg_catalog.has_table_privilege(${OWNER}, 'public.sessions', 'select') as "sessionTableSelect",
          pg_catalog.has_table_privilege(${OWNER}, 'public.sessions', 'update') as "sessionTableUpdate",
          pg_catalog.has_column_privilege(${OWNER}, 'public.sessions', 'user_id', 'select') as "sessionUserSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.sessions', 'credential_digest_v1', 'select') as "sessionCredentialSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.sessions', 'revoked_at', 'select') as "sessionRevokedSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.sessions', 'expires_at', 'select') as "sessionExpiresSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.sessions', 'ip_address', 'select') as "sessionIpSelect",
          pg_catalog.has_table_privilege(${OWNER}, 'public.tasks', 'select') as "taskTableSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.tasks', 'id', 'select') as "taskIdSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.tasks', 'project_id', 'select') as "taskProjectIdSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.tasks', 'submitted_by', 'select') as "taskSubmittedBySelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.tasks', 'title', 'select') as "taskTitleSelect",
          pg_catalog.has_table_privilege(${OWNER}, 'public.tasks', 'references') as "taskReferences",
          pg_catalog.has_table_privilege(${OWNER}, 'public.projects', 'select') as "projectTableSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.projects', 'id', 'select') as "projectIdSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.projects', 'submitted_by', 'select') as "projectSubmittedBySelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.projects', 'root_ref', 'select') as "projectRootRefSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.projects', 'root_binding_revision', 'select') as "projectRootRevisionSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.projects', 'archived_at', 'select') as "projectArchivedAtSelect",
          pg_catalog.has_column_privilege(${OWNER}, 'public.projects', 'name', 'select') as "projectNameSelect",
          pg_catalog.has_schema_privilege(${OWNER}, 'forge', 'usage') as "forgeUsage"
      `
      if (boundary.membership || boundary.publicCreate || boundary.forgeCreate || boundary.userSelect || boundary.userReferences || !boundary.sessionTableSelect || !boundary.sessionTableUpdate || !boundary.sessionUserSelect || !boundary.sessionCredentialSelect || !boundary.sessionRevokedSelect || !boundary.sessionExpiresSelect || !boundary.sessionIpSelect || boundary.taskTableSelect || !boundary.taskIdSelect || !boundary.taskProjectIdSelect || !boundary.taskSubmittedBySelect || boundary.taskTitleSelect || boundary.taskReferences || boundary.projectTableSelect || !boundary.projectIdSelect || !boundary.projectSubmittedBySelect || !boundary.projectRootRefSelect || !boundary.projectRootRevisionSelect || !boundary.projectArchivedAtSelect || boundary.projectNameSelect || !boundary.forgeUsage) {
        throw new Error('The VNext runtime protected-owner cleanup did not restore the authority boundary.')
      }
      await recordProtectedMigrationCleanup(admin, runtimeFoundationMigration, migrationRole)
      console.log('✓ Removed and verified the temporary VNext runtime owner handoff.')
      return
    }
    const [safeRole] = await admin<{ safe: boolean }[]>`
      select (not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole
        and not rolreplication and not rolbypassrls and rolpassword is null and rolvaliduntil is null) as safe
      from pg_catalog.pg_authid where rolname = ${OWNER}
    `
    if (!safeRole?.safe) throw new Error('The VNext runtime owner role is outside its exact non-login boundary.')
    const [safeApi] = await admin<{ safe: boolean }[]>`
      select (not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole
        and not rolreplication and not rolbypassrls and rolpassword is null and rolvaliduntil is null) as safe
      from pg_catalog.pg_authid where rolname = ${API}
    `
    if (!safeApi?.safe) throw new Error('The VNext runtime API boundary role is outside its exact non-login boundary.')
    // PostgreSQL 16 membership inheritance is recorded per membership edge.
    // Make the one fixed server login inherit the non-login API capability if
    // it has already been provisioned; the disposable migration proof need
    // not create an application login merely to apply the migration.
    const [runtimeLogin] = await admin<{ exists: boolean }[]>`select exists(select 1 from pg_catalog.pg_roles where rolname = 'forge_runtime_api_login') as exists`
    if (runtimeLogin?.exists) await admin.unsafe(`grant ${API} to forge_runtime_api_login with inherit true;`)
    // The migration needs schema creation and the source tables it reads.
    // Broad temporary grants are removed in the EXIT cleanup above.
    await admin.unsafe(`grant ${OWNER} to ${identifier(migrationRole)}; grant usage, create on schema public, forge to ${OWNER} with grant option; grant usage on schema forge to ${API}; grant select, references on table public.users, public.sessions, public.tasks, public.projects to ${OWNER};`)
    await recordProtectedMigrationHandoff(admin, runtimeFoundationMigration, migrationRole)
  } finally {
    await admin.end({ timeout: 5 })
  }
  console.log('✓ Granted the migration login the bounded VNext runtime owner handoff.')
}

main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
