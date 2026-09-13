import type postgres from 'postgres'
import type { ProtectedMigration } from './protected-migration-registry'

export const protectedMigrationStateTable = 'public.forge_protected_migration_handoffs'

type SqlClient = ReturnType<typeof postgres>

export type ProtectedMigrationCleanupState = Readonly<{
  stateTags: Set<string>
  pendingTags: Set<string>
}>

export async function ensureProtectedMigrationState(client: SqlClient): Promise<void> {
  await client.unsafe(`
    create table if not exists ${protectedMigrationStateTable} (
      migration_tag text primary key,
      protected_owner name not null,
      migration_role name not null,
      handoff_opened_at timestamptz not null default pg_catalog.clock_timestamp(),
      cleanup_completed_at timestamptz,
      check (length(btrim(migration_tag)) > 0)
    );
    revoke all on table ${protectedMigrationStateTable} from public;
    grant select on table ${protectedMigrationStateTable} to public;
  `)
}

export async function recordProtectedMigrationHandoff(
  client: SqlClient,
  migration: ProtectedMigration,
  migrationRole: string,
): Promise<void> {
  await ensureProtectedMigrationState(client)
  const [row] = await client<{ migrationTag: string }[]>`
    insert into public.forge_protected_migration_handoffs (
      migration_tag, protected_owner, migration_role, handoff_opened_at, cleanup_completed_at
    ) values (
      ${migration.migrationTag}, ${migration.protectedOwner}::name, ${migrationRole}::name,
      pg_catalog.clock_timestamp(), null
    )
    on conflict (migration_tag) do update
      set handoff_opened_at = excluded.handoff_opened_at,
          cleanup_completed_at = null
      where public.forge_protected_migration_handoffs.protected_owner = excluded.protected_owner
        and public.forge_protected_migration_handoffs.migration_role = excluded.migration_role
    returning migration_tag as "migrationTag"
  `
  if (!row) throw new Error(`Protected migration '${migration.migrationTag}' was previously handed off to a different owner or migration login.`)
}

export async function recordProtectedMigrationCleanup(
  client: SqlClient,
  migration: ProtectedMigration,
  migrationRole: string,
): Promise<void> {
  await ensureProtectedMigrationState(client)
  const [row] = await client<{ migrationTag: string }[]>`
    update public.forge_protected_migration_handoffs
    set cleanup_completed_at = pg_catalog.clock_timestamp()
    where migration_tag = ${migration.migrationTag}
      and protected_owner = ${migration.protectedOwner}::name
      and migration_role = ${migrationRole}::name
    returning migration_tag as "migrationTag"
  `
  if (!row) throw new Error(`Protected migration '${migration.migrationTag}' has no matching durable handoff state to close.`)
}

export async function protectedMigrationCleanupState(
  client: SqlClient,
  migrationTags: readonly string[],
): Promise<ProtectedMigrationCleanupState> {
  if (migrationTags.length === 0) return { stateTags: new Set(), pendingTags: new Set() }
  try {
    const rows = await client<{ migrationTag: string; cleanupPending: boolean }[]>`
      select migration_tag as "migrationTag", cleanup_completed_at is null as "cleanupPending"
      from public.forge_protected_migration_handoffs
      where migration_tag = any(${client.array([...migrationTags])}::text[])
    `
    return {
      stateTags: new Set(rows.map((row) => row.migrationTag)),
      pendingTags: new Set(rows.filter((row) => row.cleanupPending).map((row) => row.migrationTag)),
    }
  } catch (error) {
    // An older database legitimately has no handoff table before its first
    // protected migration. The recovery planner rejects this same empty state
    // if its ledger says a protected migration already committed.
    if ((error as { code?: string }).code === '42P01') return { stateTags: new Set(), pendingTags: new Set() }
    throw error
  }
}
