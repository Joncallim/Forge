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
      generation bigint not null default 0 check (generation >= 0),
      check (length(btrim(migration_tag)) > 0)
    );
    alter table ${protectedMigrationStateTable} add column if not exists generation bigint not null default 0;
    -- This is controller recovery state, not application state.  In
    -- particular, never let a login discover or alter an interrupted handoff
    -- merely because it can connect to the database.
    revoke all on table ${protectedMigrationStateTable} from public, forge, forge_runtime_api, forge_runtime_api_login;
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
      migration_tag, protected_owner, migration_role, handoff_opened_at, cleanup_completed_at, generation
    ) values (
      ${migration.migrationTag}, ${migration.protectedOwner}::name, ${migrationRole}::name,
      pg_catalog.clock_timestamp(), null, 1
    )
    on conflict (migration_tag) do update
      set handoff_opened_at = excluded.handoff_opened_at,
          cleanup_completed_at = null,
          generation = public.forge_protected_migration_handoffs.generation + 1
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

/** A durable row is only a recovery hint.  This deliberately repeats the
 * controller's catalog boundary instead of accepting “the migration role was
 * revoked” as proof that a restore or an administrator did not leave another
 * authority edge behind.  Its return value is the generation observed just
 * before the controller's compare-and-swap close. */
export async function assertProtectedMigrationLiveAttestation(client: SqlClient, migration: ProtectedMigration, migrationRole: string): Promise<bigint> {
  const protectedOwners = ['forge_release_routines_owner', 'forge_s4_routines_owner', 'forge_runtime_routines_owner']
  const expectedRelations = [
    ['forge_epic_172_enablement_state', 'forge_release_routines_owner'], ['forge_epic_172_enablement_transition_audits', 'forge_release_routines_owner'], ['forge_epic_172_release_evidence', 'forge_release_routines_owner'], ['forge_epic_172_release_evidence_consumptions', 'forge_release_routines_owner'], ['forge_epic_172_transition_authorizations', 'forge_release_routines_owner'], ['forge_release_signer_key_lifecycle_audits', 'forge_release_routines_owner'], ['forge_release_signer_keys', 'forge_release_routines_owner'], ['forge_epic_172_s3_release_state', 'forge_release_routines_owner'], ['work_package_local_projection_sources', 'forge_release_routines_owner'], ['work_package_local_projection_heads', 'forge_release_routines_owner'],
    ['verification_goal_registry_revisions', 'forge_s4_routines_owner'], ['verification_goal_registry_entries', 'forge_s4_routines_owner'], ['verification_goal_registry_heads', 'forge_s4_routines_owner'], ['architect_plan_versions', 'forge_s4_routines_owner'], ['architect_plan_entries', 'forge_s4_routines_owner'], ['architect_plan_execution_references', 'forge_s4_routines_owner'], ['architect_plan_history_reads', 'forge_s4_routines_owner'], ['architect_clarification_answers', 'forge_s4_routines_owner'], ['architect_clarification_answer_writes', 'forge_s4_routines_owner'], ['protected_package_entry_registrations', 'forge_s4_routines_owner'], ['protected_entry_capability_bindings', 'forge_s4_routines_owner'], ['mcp_operator_review_versions', 'forge_s4_routines_owner'], ['mcp_operator_review_entries', 'forge_s4_routines_owner'], ['work_package_local_run_evidence', 'forge_s4_routines_owner'], ['filesystem_mcp_decision_nonce_claims', 'forge_s4_routines_owner'], ['project_root_ref_reconciliation', 'forge_s4_routines_owner'], ['project_root_change_journal_counter', 'forge_s4_routines_owner'], ['project_root_change_journal', 'forge_s4_routines_owner'], ['project_root_reconciliation_operations', 'forge_s4_routines_owner'], ['project_root_reconciliation_checkpoints', 'forge_s4_routines_owner'], ['project_root_reconciliation_outcomes', 'forge_s4_routines_owner'], ['project_root_reconciliation_write_contexts', 'forge_s4_routines_owner'], ['s4_completion_handoffs', 'forge_s4_routines_owner'], ['s4_protected_review_sources', 'forge_s4_routines_owner'], ['s4_protected_review_source_reads', 'forge_s4_routines_owner'], ['s4_max_attempt_finalizations', 'forge_s4_routines_owner'], ['filesystem_mcp_issuance_recovery_actions', 'forge_s4_routines_owner'], ['local_effect_recovery_actions', 'forge_s4_routines_owner'], ['local_projection_archive_operations', 'forge_s4_routines_owner'], ['local_projection_archive_operation_checkpoints', 'forge_s4_routines_owner'],
    ['missions', 'forge_runtime_routines_owner'], ['executions', 'forge_runtime_routines_owner'], ['task_mission_bindings', 'forge_runtime_routines_owner'], ['runtime_transition_audits', 'forge_runtime_routines_owner'],
  ] as const
  const expectedRuntimeRoutines = [
    'forge.resolve_vnext_operator_session_v1(bytea)', 'forge.create_vnext_generic_zero_mission_v1(bytea,uuid,uuid,text,text)', 'forge.create_vnext_task_mission_v1(bytea,uuid,uuid,uuid,text,text)', 'forge.read_vnext_mission_v1(bytea,uuid)', 'forge.transition_vnext_mission_for_session_v1(bytea,uuid,bigint,text,text,text,text)', 'forge.transition_vnext_execution_for_session_v1(bytea,uuid,bigint,text,text,text,text,text)', 'forge.advance_task_execution_pointer_for_session_v1(bytea,uuid,bigint,uuid,text)',
  ]
  const [row] = await client<{ generation: string; valid: boolean }[]>`
    with expected_relation(name, owner) as (
      select * from unnest(${client.array(expectedRelations.map(([name]) => name))}::name[], ${client.array(expectedRelations.map(([, owner]) => owner))}::name[])
    ), expected_routine(signature) as (
      select * from unnest(${client.array(expectedRuntimeRoutines)}::text[])
    )
    select handoff.generation::text as generation,
      (
        exists(select 1 from pg_catalog.pg_roles where rolname=${migration.protectedOwner})
        and not pg_catalog.pg_has_role(${migrationRole}::name, ${migration.protectedOwner}::name, 'member')
        and not exists (
          select 1 from pg_catalog.pg_auth_members edge
          join pg_catalog.pg_roles owner_role on owner_role.oid=edge.roleid
          join pg_catalog.pg_roles member_role on member_role.oid=edge.member
          where owner_role.rolname = any(${client.array(protectedOwners)}::name[])
             or member_role.rolname = any(${client.array(protectedOwners)}::name[])
        )
        and not exists (
          select 1 from unnest(${client.array(protectedOwners)}::name[]) owner_name
          left join pg_catalog.pg_roles owner_role on owner_role.rolname=owner_name
          where owner_role.oid is null or owner_role.rolcanlogin or owner_role.rolinherit or owner_role.rolsuper
             or owner_role.rolcreatedb or owner_role.rolcreaterole or owner_role.rolreplication or owner_role.rolbypassrls
             or owner_role.rolpassword is not null or owner_role.rolvaliduntil is not null
        )
        and (select count(*) from expected_relation) = 44
        and not exists (
          select 1 from expected_relation expected
          left join pg_catalog.pg_class relation on relation.relnamespace='public'::pg_catalog.regnamespace and relation.relname=expected.name and relation.relkind in ('r','p')
          left join pg_catalog.pg_roles owner_role on owner_role.oid=relation.relowner
          where relation.oid is null or owner_role.rolname is distinct from expected.owner
        )
        and (select count(*) from pg_catalog.pg_class relation join pg_catalog.pg_roles owner_role on owner_role.oid=relation.relowner where relation.relnamespace='public'::pg_catalog.regnamespace and relation.relkind in ('r','p') and owner_role.rolname=any(${client.array(protectedOwners)}::name[])) = 44
        and not exists (
          select 1 from expected_routine expected
          left join pg_catalog.pg_proc routine on routine.oid=expected.signature::pg_catalog.regprocedure
          where routine.oid is null or routine.proowner <> 'forge_runtime_routines_owner'::pg_catalog.regrole
            or not routine.prosecdef or not ('search_path=pg_catalog' = any(coalesce(routine.proconfig, array[]::text[])))
            or exists(select 1 from pg_catalog.aclexplode(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE')
        )
        and not exists(select 1 from pg_catalog.pg_namespace namespace_row, pg_catalog.aclexplode(coalesce(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))) acl where namespace_row.nspname='forge' and acl.grantee=0 and acl.privilege_type='USAGE')
        and not exists(select 1 from pg_catalog.pg_class relation, pg_catalog.aclexplode(coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) acl where relation.oid=${protectedMigrationStateTable}::pg_catalog.regclass and acl.grantee=0 and acl.privilege_type='SELECT')
        and not pg_catalog.has_table_privilege('forge', ${protectedMigrationStateTable}, 'select')
        and not pg_catalog.has_table_privilege('forge_runtime_api', ${protectedMigrationStateTable}, 'select')
        and not pg_catalog.has_table_privilege('forge_runtime_api_login', ${protectedMigrationStateTable}, 'select')
        and not pg_catalog.has_table_privilege('forge_runtime_api', 'public.missions', 'select')
        and not pg_catalog.has_table_privilege('forge_runtime_api', 'public.executions', 'select')
        and not pg_catalog.has_table_privilege('forge_runtime_api', 'public.task_mission_bindings', 'select')
        and not pg_catalog.has_table_privilege('forge_runtime_api', 'public.runtime_transition_audits', 'select')
      ) as valid
    from public.forge_protected_migration_handoffs handoff
    where handoff.migration_tag=${migration.migrationTag}
      and handoff.protected_owner=${migration.protectedOwner}::name
      and handoff.migration_role=${migrationRole}::name
      and handoff.cleanup_completed_at is not null
  `
  if (!row?.valid) throw new Error(`Protected migration '${migration.migrationTag}' live authority attestation failed.`)
  return BigInt(row.generation)
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
