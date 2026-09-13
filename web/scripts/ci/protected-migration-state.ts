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
      operation_id uuid,
      controller_phase text not null default 'handoff_open',
      database_name name not null default pg_catalog.current_database(),
      database_oid oid,
      database_owner_oid oid,
      database_acl jsonb,
      database_acl_digest text,
      migration_role_oid oid,
      generation bigint not null default 0 constraint forge_protected_migration_handoffs_generation_check check (generation >= 0),
      constraint forge_protected_migration_handoffs_phase_check check (controller_phase in ('prepared','fenced','handoff_open','cleanup_complete','restore_pending','complete')),
      constraint forge_protected_migration_handoffs_acl_digest_check check (database_acl_digest is null or database_acl_digest ~ '^[0-9a-f]{64}$'),
      check (length(btrim(migration_tag)) > 0)
    );
    alter table ${protectedMigrationStateTable} add column if not exists generation bigint not null default 0;
    alter table ${protectedMigrationStateTable} add column if not exists operation_id uuid;
    alter table ${protectedMigrationStateTable} add column if not exists controller_phase text not null default 'handoff_open';
    alter table ${protectedMigrationStateTable} add column if not exists database_name name not null default pg_catalog.current_database();
    alter table ${protectedMigrationStateTable} add column if not exists database_oid oid;
    alter table ${protectedMigrationStateTable} add column if not exists database_owner_oid oid;
    alter table ${protectedMigrationStateTable} add column if not exists database_acl jsonb;
    alter table ${protectedMigrationStateTable} add column if not exists database_acl_digest text;
    alter table ${protectedMigrationStateTable} add column if not exists migration_role_oid oid;
    do $forge_state_constraints$
    begin
      if not exists(select 1 from pg_catalog.pg_constraint where conrelid='${protectedMigrationStateTable}'::pg_catalog.regclass and conname='forge_protected_migration_handoffs_generation_check') then
        alter table ${protectedMigrationStateTable} add constraint forge_protected_migration_handoffs_generation_check check (generation >= 0);
      end if;
      if not exists(select 1 from pg_catalog.pg_constraint where conrelid='${protectedMigrationStateTable}'::pg_catalog.regclass and conname='forge_protected_migration_handoffs_phase_check') then
        alter table ${protectedMigrationStateTable} add constraint forge_protected_migration_handoffs_phase_check check (controller_phase in ('prepared','fenced','handoff_open','cleanup_complete','restore_pending','complete'));
      end if;
      if not exists(select 1 from pg_catalog.pg_constraint where conrelid='${protectedMigrationStateTable}'::pg_catalog.regclass and conname='forge_protected_migration_handoffs_acl_digest_check') then
        alter table ${protectedMigrationStateTable} add constraint forge_protected_migration_handoffs_acl_digest_check check (database_acl_digest is null or database_acl_digest ~ '^[0-9a-f]{64}$');
      end if;
    end
    $forge_state_constraints$;
    -- This is controller recovery state, not application state.  In
    -- particular, never let a login discover or alter an interrupted handoff
    -- merely because it can connect to the database.
    revoke all on table ${protectedMigrationStateTable} from public;
    do $forge_state_acl$
    declare role_name name;
    begin
      for role_name in select rolname from pg_catalog.pg_roles where rolname in ('forge','forge_runtime_api','forge_runtime_api_login') loop
        execute format('revoke all on table ${protectedMigrationStateTable} from %I', role_name);
      end loop;
    end
    $forge_state_acl$;
  `)
}

export type ProtectedMigrationControllerPreparation = Readonly<{
  mode: 'fresh' | 'adopted' | 'complete'
  databaseSnapshot: ProtectedMigrationDatabaseSnapshot
  generation: bigint
  ledgerApplied: boolean
  completedMigrationRole?: string
}>

export type ProtectedMigrationDatabaseSnapshot = Readonly<{
  databaseName: string
  databaseOid: number
  databaseOwnerOid: number
  acl: unknown
  aclDigest: string
}>

function safeRole(value: string): string {
  if (!/^forge_migrator_[0-9a-f]{32}$/.test(value)) throw new Error('Protected migration recovery found a non-canonical ephemeral role name.')
  return `"${value}"`
}

/** Establish the sole durable controller row before CONNECT is revoked. A
 * restart may adopt it only after the prior ephemeral login is demonstrably
 * absent and the observed ledger state still matches. */
export async function prepareProtectedMigrationController(
  client: SqlClient,
  migration: ProtectedMigration,
  migrationRole: string,
  migrationPassword: string,
  migrationExpiresAt: string,
  operationId: string,
  databaseSnapshot: ProtectedMigrationDatabaseSnapshot,
  ledgerApplied: boolean,
): Promise<ProtectedMigrationControllerPreparation> {
  await ensureProtectedMigrationState(client)
  // NOLOGIN must commit before backend termination. Keeping it inside the
  // adoption transaction would leave the old password able to reconnect until
  // the same transaction attempted DROP ROLE.
  const [pendingRole] = await client<{ migrationRole: string; migrationRoleOid: number; canLogin: boolean; safe: boolean; unexpectedMembership: boolean }[]>`
    select auth.rolname as "migrationRole", auth.oid::integer as "migrationRoleOid", auth.rolcanlogin as "canLogin",
      (auth.rolname=handoff.migration_role and auth.oid=handoff.migration_role_oid
        and auth.rolname ~ '^forge_migrator_[0-9a-f]{32}$' and not auth.rolinherit
        and not auth.rolsuper and not auth.rolcreatedb and not auth.rolcreaterole and not auth.rolreplication
        and not auth.rolbypassrls and auth.rolconnlimit=1 and auth.rolpassword is not null and auth.rolvaliduntil is not null) as safe,
      exists(select 1 from pg_catalog.pg_auth_members membership join pg_catalog.pg_roles parent on parent.oid=membership.roleid
        where (membership.member=auth.oid and (parent.rolname not in ('forge_schema_owner','forge_runtime_routines_owner')
          or membership.admin_option or not membership.inherit_option or not membership.set_option))
          or membership.roleid=auth.oid) as "unexpectedMembership"
    from public.forge_protected_migration_handoffs handoff
    join pg_catalog.pg_authid auth on auth.oid=handoff.migration_role_oid and auth.rolname=handoff.migration_role
    where handoff.migration_tag=${migration.migrationTag} and handoff.controller_phase<>'complete'
      and handoff.operation_id is not null and handoff.migration_role_oid is not null
  `
  if (pendingRole) {
    if (!pendingRole.safe || pendingRole.unexpectedMembership) throw new Error(`Protected migration '${migration.migrationTag}' cannot adopt an unverified prior controller login.`)
    if (pendingRole.canLogin) await client.unsafe(`alter role ${safeRole(pendingRole.migrationRole)} nologin`)
    await client`
      select pg_catalog.pg_terminate_backend(pid, 2000) from pg_catalog.pg_stat_activity
      where usename=${pendingRole.migrationRole} and pid<>pg_catalog.pg_backend_pid()
    `
    const [sessions] = await client<{ count: number }[]>`
      select count(*)::integer as count from pg_catalog.pg_stat_activity where usename=${pendingRole.migrationRole}
    `
    if (sessions.count !== 0) throw new Error(`Protected migration '${migration.migrationTag}' prior controller backend did not terminate.`)
  }
  return client.begin(async (transaction) => {
    const tx = transaction as unknown as SqlClient
    const createMigrationRole = async (): Promise<number> => {
      safeRole(migrationRole)
      const password = migrationPassword.replaceAll("'", "''")
      const expiresAt = migrationExpiresAt.replaceAll("'", "''")
      await tx.unsafe(`create role ${safeRole(migrationRole)} login noinherit connection limit 1 password '${password}' valid until '${expiresAt}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`)
      const [createdRole] = await tx<{ oid: number }[]>`select oid::integer as oid from pg_catalog.pg_roles where rolname=${migrationRole}`
      if (!createdRole) throw new Error('Protected migration ephemeral login was not created transactionally with its durable state.')
      return createdRole.oid
    }
    const [existing] = await tx<{ migrationRole: string; migrationRoleOid: number | null; operationId: string | null; phase: string; databaseName: string; databaseOid: number | null; databaseOwnerOid: number | null; databaseAcl: unknown; databaseAclDigest: string | null; generation: string; cleanupComplete: boolean; ledgerApplied: boolean }[]>`
      select handoff.migration_role::text as "migrationRole", handoff.operation_id::text as "operationId",
        handoff.controller_phase as phase, handoff.database_name::text as "databaseName",
        handoff.database_oid::integer as "databaseOid", handoff.database_owner_oid::integer as "databaseOwnerOid",
        handoff.database_acl as "databaseAcl", handoff.database_acl_digest as "databaseAclDigest",
        handoff.migration_role_oid::integer as "migrationRoleOid", handoff.generation,
        handoff.cleanup_completed_at is not null as "cleanupComplete",
        ${ledgerApplied}::boolean as "ledgerApplied"
      from public.forge_protected_migration_handoffs handoff
      where handoff.migration_tag=${migration.migrationTag}
      for update
    `
    if (existing) {
      const legacyCompleted = existing.phase === 'handoff_open' && existing.cleanupComplete && existing.ledgerApplied
        && existing.operationId == null && existing.databaseOid == null && existing.databaseOwnerOid == null
        && existing.databaseAcl == null && existing.databaseAclDigest == null && existing.migrationRoleOid == null
      if (legacyCompleted) {
        const [upgraded] = await tx<{ generation: string }[]>`
          update public.forge_protected_migration_handoffs
          set operation_id=${operationId}::uuid, controller_phase='complete', database_name=${databaseSnapshot.databaseName}::name,
            database_oid=${databaseSnapshot.databaseOid}::oid, database_owner_oid=${databaseSnapshot.databaseOwnerOid}::oid,
            database_acl=${tx.json(databaseSnapshot.acl as never)}, database_acl_digest=${databaseSnapshot.aclDigest},
            generation=generation+1
          where migration_tag=${migration.migrationTag} and generation=${existing.generation}::bigint
            and operation_id is null and controller_phase='handoff_open' and cleanup_completed_at is not null
          returning generation
        `
        if (!upgraded) throw new Error(`Protected migration '${migration.migrationTag}' legacy completion upgrade lost its generation fence.`)
        return { mode: 'complete', databaseSnapshot, generation: BigInt(upgraded.generation), ledgerApplied: true, completedMigrationRole: existing.migrationRole }
      }
      if (existing.phase === 'complete' && existing.cleanupComplete && existing.ledgerApplied) {
        if (existing.databaseName !== databaseSnapshot.databaseName || existing.databaseOid !== databaseSnapshot.databaseOid
          || existing.databaseOwnerOid !== databaseSnapshot.databaseOwnerOid || existing.databaseAclDigest !== databaseSnapshot.aclDigest) {
          throw new Error(`Protected migration '${migration.migrationTag}' completed state disagrees with the live database ACL identity.`)
        }
        return { mode: 'complete', databaseSnapshot: { databaseName: existing.databaseName, databaseOid: existing.databaseOid, databaseOwnerOid: existing.databaseOwnerOid, acl: existing.databaseAcl, aclDigest: existing.databaseAclDigest }, generation: BigInt(existing.generation), ledgerApplied: true, completedMigrationRole: existing.migrationRole }
      }
      if (existing.databaseName !== databaseSnapshot.databaseName || existing.databaseOid !== databaseSnapshot.databaseOid
        || existing.databaseOwnerOid !== databaseSnapshot.databaseOwnerOid || existing.databaseAcl == null
        || existing.databaseAclDigest == null || existing.ledgerApplied !== ['handoff_open','cleanup_complete','restore_pending'].includes(existing.phase)) {
        throw new Error(`Protected migration '${migration.migrationTag}' prepared state disagrees with its database or ledger phase.`)
      }
      const [oldRole] = await tx<{ safe: boolean; unexpectedMembership: boolean }[]>`
        select (auth.oid=${existing.migrationRoleOid}::oid and auth.rolname=${existing.migrationRole}
          and auth.rolname ~ '^forge_migrator_[0-9a-f]{32}$' and not auth.rolcanlogin and not auth.rolinherit
          and not auth.rolsuper and not auth.rolcreatedb and not auth.rolcreaterole and not auth.rolreplication
          and not auth.rolbypassrls and auth.rolconnlimit=1 and auth.rolpassword is not null and auth.rolvaliduntil is not null) as safe,
          exists(select 1 from pg_catalog.pg_auth_members membership join pg_catalog.pg_roles parent on parent.oid=membership.roleid
            where (membership.member=auth.oid and (parent.rolname not in ('forge_schema_owner','forge_runtime_routines_owner')
              or membership.admin_option or not membership.inherit_option or not membership.set_option))
              or membership.roleid=auth.oid) as "unexpectedMembership"
        from pg_catalog.pg_authid auth where auth.rolname=${existing.migrationRole}
      `
      if (oldRole) {
        if (!oldRole.safe || oldRole.unexpectedMembership) throw new Error(`Protected migration '${migration.migrationTag}' cannot adopt an unverified prior controller login.`)
        const oldRoleName = safeRole(existing.migrationRole)
        const memberships = await tx<{ parent: string }[]>`
          select parent.rolname as parent from pg_catalog.pg_auth_members membership
          join pg_catalog.pg_roles parent on parent.oid=membership.roleid
          where membership.member=${existing.migrationRole}::regrole
        `
        for (const membership of memberships) await tx.unsafe(`revoke ${safeRecoveryParent(membership.parent)} from ${oldRoleName}`)
        await tx.unsafe(`reassign owned by ${oldRoleName} to forge_schema_owner; drop owned by ${oldRoleName}; drop role ${oldRoleName}`)
      } else {
        const [collision] = await tx<{ collision: boolean }[]>`
          select exists(select 1 from pg_catalog.pg_roles where oid=${existing.migrationRoleOid}::oid or rolname=${existing.migrationRole}) as collision
        `
        if (collision.collision) throw new Error(`Protected migration '${migration.migrationTag}' prior controller role identity was reused.`)
      }
      const migrationRoleOid = await createMigrationRole()
      const [adopted] = await tx<{ generation: string }[]>`
        update public.forge_protected_migration_handoffs
        set migration_role=${migrationRole}::name, migration_role_oid=${migrationRoleOid}::oid, operation_id=${operationId}::uuid,
          handoff_opened_at=pg_catalog.clock_timestamp(), cleanup_completed_at=null,
          controller_phase='prepared', generation=generation+1
        where migration_tag=${migration.migrationTag} and generation=${existing.generation}::bigint
          and operation_id is not distinct from ${existing.operationId}::uuid
        returning generation
      `
      if (!adopted) throw new Error(`Protected migration '${migration.migrationTag}' controller adoption lost its operation/generation fence.`)
      return { mode: 'adopted', databaseSnapshot: { databaseName: existing.databaseName, databaseOid: existing.databaseOid, databaseOwnerOid: existing.databaseOwnerOid, acl: existing.databaseAcl, aclDigest: existing.databaseAclDigest }, generation: BigInt(adopted.generation), ledgerApplied: existing.ledgerApplied }
    }
    const migrationRoleOid = await createMigrationRole()
    const [created] = await tx<{ generation: string | bigint }[]>`
      insert into public.forge_protected_migration_handoffs(
        migration_tag, protected_owner, migration_role, operation_id, controller_phase,
        database_name, database_oid, database_owner_oid, database_acl, database_acl_digest,
        migration_role_oid, cleanup_completed_at, generation
      ) values (
        ${migration.migrationTag}, ${migration.protectedOwner}::name, ${migrationRole}::name,
        ${operationId}::uuid, 'prepared', ${databaseSnapshot.databaseName}::name,
        ${databaseSnapshot.databaseOid}::oid, ${databaseSnapshot.databaseOwnerOid}::oid,
        ${tx.json(databaseSnapshot.acl as never)}, ${databaseSnapshot.aclDigest},
        ${migrationRoleOid}::oid, null, 1
      ) returning generation
    `
    return { mode: 'fresh', databaseSnapshot, generation: BigInt(created.generation), ledgerApplied: false }
  }) as Promise<ProtectedMigrationControllerPreparation>
}

function safeRecoveryParent(value: string): string {
  if (value !== 'forge_schema_owner' && value !== 'forge_runtime_routines_owner') {
    throw new Error('Protected migration recovery found an unexpected ephemeral role membership.')
  }
  return `"${value}"`
}

export async function markProtectedMigrationControllerFenced(client: SqlClient, migration: ProtectedMigration, operationId: string, expectedGeneration: bigint): Promise<bigint> {
  const [row] = await client<{ generation: string | bigint }[]>`
    update public.forge_protected_migration_handoffs set controller_phase='fenced', generation=generation+1
    where migration_tag=${migration.migrationTag} and operation_id=${operationId}::uuid
      and generation=${expectedGeneration.toString()}::bigint and controller_phase='prepared'
    returning generation
  `
  if (!row) throw new Error(`Protected migration '${migration.migrationTag}' fencing lost its operation/generation fence.`)
  return BigInt(row.generation)
}

export async function recordProtectedMigrationHandoff(
  client: SqlClient,
  migration: ProtectedMigration,
  migrationRole: string,
  operationId?: string,
  expectedGeneration?: bigint,
): Promise<bigint> {
  await ensureProtectedMigrationState(client)
  const [row] = await client<{ migrationTag: string; generation: string | bigint }[]>`
    insert into public.forge_protected_migration_handoffs (
      migration_tag, protected_owner, migration_role, handoff_opened_at, cleanup_completed_at, operation_id, controller_phase, generation
    ) values (
      ${migration.migrationTag}, ${migration.protectedOwner}::name, ${migrationRole}::name,
      pg_catalog.clock_timestamp(), null, ${operationId ?? null}::uuid, 'handoff_open', 1
    )
    on conflict (migration_tag) do update
      set handoff_opened_at = excluded.handoff_opened_at,
          cleanup_completed_at = null,
          operation_id = excluded.operation_id,
          controller_phase = 'handoff_open',
          generation = public.forge_protected_migration_handoffs.generation + 1
      where public.forge_protected_migration_handoffs.protected_owner = excluded.protected_owner
        and public.forge_protected_migration_handoffs.migration_role = excluded.migration_role
        and public.forge_protected_migration_handoffs.operation_id is not distinct from excluded.operation_id
        and (${operationId ?? null}::uuid is null or (
          public.forge_protected_migration_handoffs.controller_phase='fenced'
          and public.forge_protected_migration_handoffs.generation=${expectedGeneration?.toString() ?? null}::bigint
        ))
    returning migration_tag as "migrationTag", generation
  `
  if (!row) throw new Error(`Protected migration '${migration.migrationTag}' was previously handed off to a different owner or migration login.`)
  return BigInt(row.generation)
}

export async function recordProtectedMigrationCleanup(
  client: SqlClient,
  migration: ProtectedMigration,
  migrationRole: string,
  operationId?: string,
  expectedGeneration?: bigint,
): Promise<bigint> {
  await ensureProtectedMigrationState(client)
  const [row] = await client<{ migrationTag: string; generation: string | bigint }[]>`
    update public.forge_protected_migration_handoffs
    set cleanup_completed_at = pg_catalog.clock_timestamp(), controller_phase='cleanup_complete', generation=generation+1
    where migration_tag = ${migration.migrationTag}
      and protected_owner = ${migration.protectedOwner}::name
      and migration_role = ${migrationRole}::name
      and operation_id is not distinct from ${operationId ?? null}::uuid
      and (${operationId ?? null}::uuid is null or (controller_phase='handoff_open' and generation=${expectedGeneration?.toString() ?? null}::bigint))
    returning migration_tag as "migrationTag", generation
  `
  if (!row) throw new Error(`Protected migration '${migration.migrationTag}' has no matching durable handoff state to close.`)
  return BigInt(row.generation)
}

/** Adopt only an open handoff whose disposable login is gone. The caller
 * supplies the exact observed generation and ledger state, making restart
 * recovery a compare-and-swap rather than an identity/name guess. */
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
        and case when exists(select 1 from pg_catalog.pg_roles where rolname=${migrationRole})
          then not pg_catalog.pg_has_role(${migrationRole}::name, ${migration.protectedOwner}::name, 'member')
          else true end
        and not exists (
          select 1 from pg_catalog.pg_auth_members edge
          join pg_catalog.pg_roles owner_role on owner_role.oid=edge.roleid
          join pg_catalog.pg_roles member_role on member_role.oid=edge.member
          where owner_role.rolname = any(${client.array(protectedOwners)}::name[])
             or member_role.rolname = any(${client.array(protectedOwners)}::name[])
        )
        and not exists (
          select 1 from unnest(${client.array(protectedOwners)}::name[]) owner_name
          left join pg_catalog.pg_authid owner_role on owner_role.rolname=owner_name
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
