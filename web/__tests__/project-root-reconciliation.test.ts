import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseProjectRootReconciliationCommand,
  PROJECT_ROOT_RECONCILIATION_STATES,
} from '@/lib/mcps/project-root-reconciliation'

const migration = readFileSync(fileURLToPath(new URL('../db/migrations/0027_epic_172_s4_packet_context.sql', import.meta.url)), 'utf8')
const s3Migration = readFileSync(fileURLToPath(new URL('../db/migrations/0026_epic_172_s3_grant_lifecycle.sql', import.meta.url)), 'utf8')
const schema = readFileSync(fileURLToPath(new URL('../db/schema.ts', import.meta.url)), 'utf8')
const bootstrap = readFileSync(fileURLToPath(new URL('../scripts/bootstrap-epic-172-s4-roles.ts', import.meta.url)), 'utf8')
const reconcileScript = readFileSync(fileURLToPath(new URL('../scripts/reconcile-project-root-expansion.ts', import.meta.url)), 'utf8')
const reconciliation = readFileSync(fileURLToPath(new URL('../lib/mcps/filesystem-grant-reconciliation.ts', import.meta.url)), 'utf8')
const indexScript = readFileSync(fileURLToPath(new URL('../scripts/build-project-root-ref-index.ts', import.meta.url)), 'utf8')
const upgradeProof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-migration-0027-upgrade.sh', import.meta.url)), 'utf8')
const indexLifecycleProof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-migration-0027-root-index-lifecycle.sh', import.meta.url)), 'utf8')
const rootAuthorityProjectFixture = readFileSync(fileURLToPath(new URL('../scripts/ci/sql/migration-0027-root-authority-project-fixture.sql', import.meta.url)), 'utf8')
const rootAuthorityPackageFixture = readFileSync(fileURLToPath(new URL('../scripts/ci/sql/migration-0027-root-authority-package-fixture.sql', import.meta.url)), 'utf8')
const rootAuthorityProof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-migration-0027-root-authority-reconciliation.sh', import.meta.url)), 'utf8')
const rootAuthorityAssertions = readFileSync(fileURLToPath(new URL('../scripts/ci/sql/migration-0027-root-authority-reconciliation-assertions.sql', import.meta.url)), 'utf8')
const negativeProof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-migration-0027-root-reconciliation-negative.sh', import.meta.url)), 'utf8')
const replayProof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-migration-0027-root-reconciliation-replay.sh', import.meta.url)), 'utf8')
const privilegeProof = readFileSync(fileURLToPath(new URL('../scripts/ci/sql/migration-0027-root-reconciler-privileges-assertions.sql', import.meta.url)), 'utf8')
const privilegeMutationProof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-migration-0027-root-reconciler-privilege-mutations.sh', import.meta.url)), 'utf8')
const ordinaryAppTriggerProof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-migration-0027-ordinary-app-trigger-writes.sh', import.meta.url)), 'utf8')
const staleContextProof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-migration-0027-root-stale-context.sh', import.meta.url)), 'utf8')
const negativeAssertions = readFileSync(fileURLToPath(new URL('../scripts/ci/sql/migration-0027-root-reconciliation-negative-assertions.sql', import.meta.url)), 'utf8')
const contentionProof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-migration-0027-root-contention.sh', import.meta.url)), 'utf8')
const cutoverScript = readFileSync(fileURLToPath(new URL('../scripts/ci/cutover-migration-0027-root-ref.sh', import.meta.url)), 'utf8')
const webCi = readFileSync(fileURLToPath(new URL('../../.github/workflows/web-ci.yml', import.meta.url)), 'utf8')

describe('project-root expansion reconciliation boundary', () => {
  it('defines the pure reusable canonical filesystem grant-block validator', () => {
    expect(s3Migration).toContain('CREATE FUNCTION forge_is_canonical_filesystem_grant_block_v2(p_block jsonb)')
    expect(s3Migration).toContain('RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE')
    expect(s3Migration).toContain("'project_grant_removed','project_grant_narrowed','project_root_repoint'")
    expect(s3Migration).toContain('public.forge_is_canonical_bounded_string_set(p_block->\'requirementKeys\',256,240)')
    expect(s3Migration).toContain('public.forge_is_canonical_filesystem_capability_set(p_block->\'requestedCapabilities\')')
    expect(s3Migration).toContain("public.forge_is_canonical_utc_timestamp(p_block->>'blockedAt')")
    expect(s3Migration).toContain('CHECK (public.forge_is_canonical_filesystem_capability_set("capabilities"))')
    expect(s3Migration).toContain('public.forge_is_canonical_filesystem_grant_block_v2("metadata"->\'mcpGrantBlock\')')
    expect(migration).toContain('public.forge_is_canonical_filesystem_grant_block_v2(v_new_marker)')
    expect(migration).toContain('public.forge_is_canonical_filesystem_grant_block_v2(v_old_marker)')
  })
  it('parses only the literal actor/watermark/apply command and keeps dry-run actionless', () => {
    const actor = '123e4567-e89b-42d3-a456-426614174000'
    expect(parseProjectRootReconciliationCommand(['--through', '0', '--actor', actor])).toEqual({
      actorId: actor, apply: false, throughGeneration: BigInt(0),
    })
    expect(() => parseProjectRootReconciliationCommand(['--through', '-1', '--actor', actor, '--apply'])).toThrow('non-negative')
    expect(() => parseProjectRootReconciliationCommand(['--through', '1', '--actor', actor, '--admin'])).toThrow('Unknown')
  })

  it('uses path-free append-only operation, checkpoint, and outcome contracts', () => {
    for (const table of [
      'project_root_reconciliation_operations',
      'project_root_reconciliation_checkpoints',
      'project_root_reconciliation_outcomes',
      'project_root_reconciliation_write_contexts',
    ]) expect(migration).toContain(`CREATE TABLE public.${table}`)
    expect(migration).toContain('generation bigint PRIMARY KEY REFERENCES public.project_root_change_journal(generation)')
    expect(migration).toContain('project_root_reconciliation_checkpoints_append_only_v1')
    expect(migration).toContain('project_root_reconciliation_outcomes_append_only_v1')
    expect(migration).toContain("state IN ('running','complete')")
    const reconciliationSchema = migration.slice(
      migration.indexOf('CREATE TABLE public.project_root_reconciliation_operations'),
      migration.indexOf('CREATE OR REPLACE FUNCTION forge.reject_project_root_reconciliation_history_mutation_v1()'),
    )
    expect(reconciliationSchema).not.toMatch(/(?:local_path|root_ref|reason|jsonb)/i)
    expect(schema).toContain("export const projectRootReconciliationOperations")
    expect(schema).toContain("export const projectRootReconciliationWriteContexts")
    expect(schema).toContain("project_root_reconciliation_write_context_generation_unique")
    expect(schema).toContain("project_root_reconciliation_one_live_idx")
    expect(PROJECT_ROOT_RECONCILIATION_STATES).toEqual(['running', 'complete'])
  })

  it('keeps protected write-context physical metadata aligned with Drizzle', () => {
    const writeContextDdl = migration.slice(
      migration.indexOf('CREATE TABLE public.project_root_reconciliation_write_contexts'),
      migration.indexOf('CREATE OR REPLACE FUNCTION forge.enter_project_root_reconciliation_generation_v1'),
    )
    const writeContextSchema = schema.slice(
      schema.indexOf("export const projectRootReconciliationWriteContexts"),
      schema.indexOf('export const s4ProtectedReviewSourceReads'),
    )
    expect(writeContextDdl).toContain('DEFAULT pg_catalog.clock_timestamp()')
    expect(writeContextSchema).toContain('default(sql`pg_catalog.clock_timestamp()`)')
    for (const constraint of [
      'project_root_reconciliation_write_contexts_pkey',
      'project_root_reconciliation_write_context_generation_unique',
      'project_root_reconciliation_write_context_backend_pid_chk',
      'project_root_reconciliation_write_context_transaction_id_chk',
      'project_root_reconciliation_write_context_shape_chk',
      'project_root_reconciliation_write_contexts_operation_id_fkey',
      'project_root_reconciliation_write_contexts_generation_fkey',
      'project_root_reconciliation_write_contexts_project_id_fkey',
    ]) {
      expect(writeContextDdl).toContain(constraint)
      expect(writeContextSchema).toContain(constraint)
    }
    expect(writeContextDdl).toContain('FOREIGN KEY (operation_id) REFERENCES public.project_root_reconciliation_operations(operation_id) ON DELETE RESTRICT')
    expect(writeContextDdl).toContain('FOREIGN KEY (generation) REFERENCES public.project_root_change_journal(generation) ON DELETE RESTRICT')
    expect(writeContextDdl).toContain('FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT')
    expect(writeContextSchema).toContain("foreignColumns: [projectRootReconciliationOperations.operationId]")
    expect(writeContextSchema).toContain('foreignColumns: [projectRootChangeJournal.generation]')
    expect(writeContextSchema).toContain('foreignColumns: [projects.id]')
  })

  it('fences operation creation and completion against gaps, later commits, and hijack', () => {
    expect(migration).toContain('forge.assert_project_root_journal_window_v1')
    expect(migration).toContain('v_counter <> p_through_generation OR v_max <> p_through_generation OR v_count <> p_through_generation')
    expect(migration).toContain('project-root operation identity cannot be hijacked')
    expect(migration).toContain('operation_row.actor_id = p_actor_id')
    expect(migration).toContain('operation_row.through_generation = p_through_generation')
    expect(migration).toContain('project-root completion compare-and-set failed')
    expect(migration).toContain('project-root generation already has an immutable outcome')
    const claimRoutine = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION forge.claim_project_root_reconciliation_batch_v1'),
      migration.indexOf('CREATE TABLE public.project_root_reconciliation_write_contexts'),
    )
    expect(claimRoutine).toContain('coalesce(max(journal_row.generation), 0)')
    expect(claimRoutine).toContain('FROM public.project_root_change_journal AS journal_row')
    expect(claimRoutine).not.toContain('coalesce(max(generation), 0)')
    expect(claimRoutine).toContain('SELECT journal_row.generation, journal_row.project_id, journal_row.outcome, journal_row.root_binding_revision, journal_row.grant_decision_revision')
    expect(migration).toContain('forge.materialize_project_root_ref_expansion_v1')
    expect(migration).toContain('CREATE TABLE public.project_root_reconciliation_write_contexts')
    expect(migration).toContain('backend_pid integer NOT NULL')
    expect(migration).toContain('transaction_id bigint NOT NULL')
    expect(migration).toContain('forge.enter_project_root_reconciliation_generation_v1')
    expect(migration).toContain('project-root write context is absent or stale')
    expect(migration).toContain('project_root_reconciliation_write_contexts_append_only_v1')
    expect(migration).toContain('project-root write context is immutable outside fixed completion')
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER project_root_reconciliation_write_contexts_commit_v1')
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(migration).toContain('project-root write context must complete before commit')
    expect(migration).toContain('forge.lock_project_root_reconciliation_authority_v1')
    expect(migration).toContain('approval_row.project_id=p_project_id ORDER BY approval_row.id FOR UPDATE')
    expect(migration).toContain('decision_row.project_id=p_project_id ORDER BY decision_row.id FOR UPDATE')
    expect(migration).toContain('project-root authority lock has no active write context')
    expect(migration).toContain('project_root_reconciler_task_update_guard_v1')
    expect(migration).toContain("OLD.status NOT IN ('running','failed') OR NEW.status <> 'approved'")
    expect(migration).toContain('project-root task update has no active write context')
    expect(migration).toContain('project_root_reconciler_package_update_guard_v1')
    expect(migration).toContain('forge_is_canonical_filesystem_grant_block_v2(v_new_marker)')
    expect(migration).toContain('project-root package marker removal is not canonical')
    expect(migration.indexOf('project_root_reconciliation_write_contexts_commit_v1')).toBeLessThan(migration.indexOf('ALTER TABLE public.project_root_reconciliation_write_contexts OWNER TO forge_s4_routines_owner'))
    expect(migration).toContain('ALTER FUNCTION forge.enter_project_root_reconciliation_generation_v1(uuid,uuid,bigint,uuid) OWNER TO forge_s4_routines_owner')
    expect(migration.indexOf('GRANT EXECUTE ON FUNCTION forge.enter_project_root_reconciliation_generation_v1')).toBeLessThan(migration.indexOf('ALTER FUNCTION forge.enter_project_root_reconciliation_generation_v1'))
  })

  it('uses the dedicated login with only canonical helper state columns and fixed routines', () => {
    expect(reconcileScript).toContain('FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL')
    expect(reconcileScript).toContain("forge_project_root_reconciler")
    expect(reconcileScript).toContain('reconcileFilesystemGrantsForProject')
    expect(reconcileScript).toContain('hasBoundFilesystemAuthority')
    expect(bootstrap).toContain("'forge_project_root_reconciler'")
    expect(migration).not.toContain('GRANT SELECT ON public.projects, public.tasks, public.work_packages')
    expect(migration).not.toContain('GRANT UPDATE (status, error_message, updated_at) ON public.tasks TO forge_project_root_reconciler')
    expect(bootstrap).toContain('grant select on table public.projects, public.tasks, public.work_packages')
    expect(bootstrap).toContain('grant update (status, error_message, updated_at) on table public.tasks to forge_project_root_reconciler')
    expect(bootstrap).toContain('grant update (status, blocked_reason, metadata, updated_at) on table public.work_packages to forge_project_root_reconciler')
    expect(bootstrap).not.toContain('grant update (id) on table public.work_package_local_projection_heads to forge_project_root_reconciler')
    expect(bootstrap).not.toContain('grant update (id) on table public.projects, public.filesystem_mcp_grant_approvals')
    expect(bootstrap).not.toContain('grant update (project_id) on table public.project_filesystem_current_decision_pointers')
    expect(bootstrap).not.toContain('grant update (work_package_id) on table public.filesystem_mcp_current_decision_pointers')
    expect(migration).not.toContain('GRANT EXECUTE ON FUNCTION forge.advance_local_projection_head_v1')
    expect(bootstrap).toContain('grant execute on function forge.advance_local_projection_head_v1(uuid,uuid,text,uuid,bigint,text,jsonb,bigint,text,text) to forge_project_root_reconciler')
    expect(migration).toContain('public.project_root_reconciliation_operations')
    expect(migration).toContain('REVOKE ALL ON FUNCTION forge.begin_project_root_reconciliation_v1')
    for (const table of [
      'project_root_reconciliation_operations',
      'project_root_reconciliation_checkpoints',
      'project_root_reconciliation_outcomes',
    ]) expect(webCi).toContain(`'${table}'`)
  })

  it('keeps the admin-only root-authority project fixture self-validating', () => {
    expect(rootAuthorityProjectFixture).toContain('root authority fixture must not run as the reconciler login')
    expect(rootAuthorityProjectFixture).toContain("'27000000-0000-4000-8000-000000000700'")
    expect(rootAuthorityProjectFixture).toContain("'27000000-0000-4000-8000-000000000702'")
    expect(rootAuthorityProjectFixture).toContain('"requiredMcps":["filesystem","github"]')
    expect(rootAuthorityProjectFixture).toContain('project_filesystem_current_decision_pointers')
    expect(rootAuthorityProjectFixture).toContain("'^sha256:[0-9a-f]{64}$'")
    expect(rootAuthorityProjectFixture).toContain('duplicate or ambiguous current authority')
    expect(rootAuthorityProjectFixture).not.toContain('reconcile-project-root-expansion.ts')
  })

  it('keeps the admin-only root-authority package fixture bounded to seed state', () => {
    expect(rootAuthorityPackageFixture).toContain('requires the exact R2A1a project authority')
    expect(rootAuthorityPackageFixture).toContain("'27000000-0000-4000-8000-000000000711'")
    expect(rootAuthorityPackageFixture).toContain("'27000000-0000-4000-8000-000000000712'")
    expect(rootAuthorityPackageFixture).toContain("'27000000-0000-4000-8000-000000000721'")
    expect(rootAuthorityPackageFixture).toContain('public.forge_is_canonical_filesystem_grant_block_v2')
    expect(rootAuthorityPackageFixture).toContain('mcpGrantPhases')
    expect(rootAuthorityPackageFixture).toContain("metadata - 'mcpGrantBlock'")
    expect(rootAuthorityPackageFixture).toContain('count(DISTINCT metadata->\'mcpGrantBlock\'->>\'blockFingerprint\')')
    expect(rootAuthorityPackageFixture).toContain("head_kind = 'operator_hold'")
    expect(rootAuthorityPackageFixture).toContain('invalid projection heads or sources')
    expect(rootAuthorityPackageFixture).not.toContain('reconcile-project-root-expansion.ts')
    expect(rootAuthorityPackageFixture).toContain('filesystem.project.search')
  })

  it('splits bound-authority fixture preparation from post-drain assertions', () => {
    expect(rootAuthorityProof).toContain('migration-0027-root-authority-project-fixture.sql')
    expect(rootAuthorityProof).toContain('migration-0027-root-authority-package-fixture.sql')
    expect(rootAuthorityProof).toContain("UPDATE public.projects SET root_ref")
    expect(rootAuthorityProof).toContain("outcome = 'root_update'")
    expect(rootAuthorityProof).toContain('--prepare|--assert')
    expect(rootAuthorityProof).toContain('case "$phase" in')
    expect(rootAuthorityProof).not.toContain('reconcile-migration-0027-root-refs.sh')
    expect(rootAuthorityProof).toContain('migration-0027-root-authority-reconciliation-assertions.sql')
    expect(upgradeProof).toContain('bash scripts/ci/prove-migration-0027-root-authority-reconciliation.sh --prepare')
    expect(upgradeProof).toContain('bash scripts/ci/prove-migration-0027-root-authority-reconciliation.sh --assert')
  })

  it('asserts canonical package/task/head effects without direct protected authority mutation', () => {
    expect(rootAuthorityAssertions).toContain('BEGIN;')
    expect(rootAuthorityAssertions).toContain('CREATE TEMP TABLE root_authority_assertion_inputs')
    expect(rootAuthorityAssertions).toContain("VALUES (:'actor_id'::uuid, :'operation_id'::uuid, :'authority_generation'::bigint, :'through_generation'::bigint)")
    expect(rootAuthorityAssertions).toContain('FROM root_authority_assertion_inputs')
    expect(rootAuthorityAssertions).toContain('COMMIT;')
    expect(rootAuthorityAssertions).not.toContain("v_actor uuid := :'actor_id'::uuid")
    expect(rootAuthorityAssertions).toContain('project_root_reconciliation_write_contexts')
    expect(rootAuthorityAssertions).toContain("source_row.contribution->>'transition'")
    expect(rootAuthorityAssertions).toContain("WHEN v_add THEN 'hold' WHEN v_refresh THEN 'refresh' WHEN v_recover THEN 'recovery'")
    expect(rootAuthorityAssertions).toContain('forge_is_canonical_filesystem_grant_block_v2')
    expect(rootAuthorityAssertions).toContain("metadata - 'mcpGrantBlock'")
    expect(rootAuthorityAssertions).toContain('mcpGrantPhases')
    expect(rootAuthorityAssertions).toContain('root authority reconciliation mutated protected decision or pointer authority directly')
    expect(rootAuthorityAssertions).toContain('root authority task convergence did not recover running and failed tasks')
    expect(rootAuthorityAssertions).toContain('the single root reconciliation operation does not cover every prepared journal generation')
    expect(rootAuthorityAssertions).toContain('root authority addition package convergence is not canonical')
    expect(rootAuthorityAssertions).toContain('root authority refresh package convergence is not canonical')
    expect(rootAuthorityAssertions).toContain('root authority recovery package convergence is not canonical')
    expect(rootAuthorityAssertions).toContain("'phases', package_row.metadata->'mcpGrantPhases'")
    expect(rootAuthorityAssertions).toContain("'requirements', package_row.mcp_requirements")
    expect(rootAuthorityAssertions).toContain("'errorMessage', task_row.error_message")
    expect(rootAuthorityPackageFixture).toContain("'[]'::jsonb")
    expect(rootAuthorityPackageFixture).toContain('"requirement":"required"')
    expect(rootAuthorityPackageFixture).toContain('"assignedRole":"backend"')
    expect(rootAuthorityPackageFixture).toContain('"fallback":{"action":"block","message":""}')
  })

  it('keeps the dedicated pre-reconciliation rollback proof bounded and resumable', () => {
    expect(negativeProof).toContain('forge.begin_project_root_reconciliation_v1')
    expect(negativeProof).toContain('forge.enter_project_root_reconciliation_generation_v1')
    expect(negativeProof).toContain('SELECT 1/0')
    expect(negativeProof).toContain('project-root operation identity cannot be hijacked')
    expect(negativeProof).toContain('project-root authority lock has no active write context')
    expect(negativeProof).toContain("'correct-next-generation wrong-project binding'")
    expect(negativeProof).toContain("'wrong-generation correct-journal-project binding'")
    expect(negativeProof).toContain("'valid-entry wrong-actor ownership'")
    expect(negativeProof).toContain("'composite completion wrong-actor context identity'")
    expect(negativeProof).toContain("actor_b='44444444-4444-4444-8444-444444444444'")
    expect(negativeProof).toContain('project-root write context is absent or stale')
    expect(negativeProof).toContain('leave a context row behind')
    expect(negativeProof).toContain("WHERE project_id <> '${project}'::uuid")
    expect(negativeProof).toContain('WHERE generation > ${generation} AND generation <= ${through}')
    expect(negativeProof).toContain('snapshot_reconciliation_state')
    expect(negativeProof).toContain("'runtime_audits'")
    expect(negativeProof).toContain("'projection_heads'")
    expect(negativeProof).toContain("'packages'")
    expect(negativeProof).toContain('migration-0027-root-reconciliation-negative-assertions.sql')
    expect(negativeProof).not.toContain('reconcile-migration-0027-root-refs.sh')
    expect(upgradeProof.indexOf('prove-migration-0027-root-reconciliation-negative.sh')).toBeLessThan(
      upgradeProof.indexOf('reconcile-migration-0027-root-refs.sh'),
    )
  })

  it('keeps completion context identity actor-bound before the non-disclosing operation CAS', () => {
    const completionRoutine = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION forge.complete_project_root_reconciliation_generation_v1'),
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION',
        migration.indexOf('CREATE OR REPLACE FUNCTION forge.complete_project_root_reconciliation_generation_v1') + 1,
      ),
    )
    // Actor is intentionally part of the active-context lookup. Moving it to a
    // later actor-specific check would disclose another actor's live context.
    expect(completionRoutine).toContain('context.operation_id=p_operation_id AND context.generation=p_generation AND context.actor_id=p_actor_id AND context.project_id=p_project_id AND context.backend_pid=pg_catalog.pg_backend_pid() AND context.transaction_id=pg_catalog.txid_current() AND context.completed_at IS NULL')
    expect(completionRoutine.indexOf('context.actor_id=p_actor_id')).toBeLessThan(
      completionRoutine.indexOf('v_operation.actor_id <> p_actor_id'),
    )
  })

  it('replays the completed reconciliation through the exact dedicated CLI without mutation', () => {
    expect(replayProof).toContain('"mode":"complete-replay"')
    expect(replayProof).toContain('FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL')
    expect(replayProof).toContain('project_root_reconciliation_write_contexts')
    expect(replayProof).toContain('work_package_local_projection_heads')
    expect(replayProof).toContain('Completed root reconciliation replay mutated protected state.')
    expect(upgradeProof.indexOf('prove-migration-0027-root-reconciliation-replay.sh')).toBeGreaterThan(
      upgradeProof.indexOf('reconcile-migration-0027-root-refs.sh'),
    )
  })

  it('keeps the dedicated reconciler privilege proof catalog-driven and mandatory', () => {
    expect(privilegeProof).toContain('root_reconciler_expected_privileges')
    expect(privilegeProof).toContain('root_reconciler_actual_privileges')
    expect(privilegeProof).toContain('has_table_privilege')
    expect(privilegeProof).toContain("unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[])")
    expect(privilegeProof).toContain("SELECT 'MAINTAIN'")
    expect(privilegeProof).toContain("current_setting('server_version_num')::integer >= 170000")
    expect(privilegeProof).toContain('has_column_privilege')
    expect(privilegeProof).toContain("VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')")
    expect(privilegeProof).toContain("'column_' || lower(privilege.privilege)")
    expect(privilegeProof).toContain("NOT pg_catalog.has_table_privilege('forge_project_root_reconciler', relation.oid, privilege.privilege)")
    expect(privilegeProof).toContain("('column_select')")
    expect(privilegeProof).toContain("('column_insert')")
    expect(privilegeProof).toContain("('column_update')")
    expect(privilegeProof).toContain("('column_references')")
    expect(privilegeProof).toContain("('grant_option_relation')")
    expect(privilegeProof).toContain("('grant_option_column')")
    expect(privilegeProof).toContain("('grant_option_routine')")
    expect(privilegeProof).toContain("('grant_option_schema')")
    expect(privilegeProof).toContain("('grant_option_database')")
    expect(privilegeProof).toContain("('grant_option_sequence')")
    expect(privilegeProof).toContain('pg_catalog.aclexplode')
    expect(privilegeProof).toContain("pg_catalog.acldefault('r', relation.relowner)")
    expect(privilegeProof).toContain("pg_catalog.acldefault('c', relation.relowner)")
    expect(privilegeProof).toContain("pg_catalog.acldefault('f', routine.proowner)")
    expect(privilegeProof).toContain("pg_catalog.acldefault('n', namespace_row.nspowner)")
    expect(privilegeProof).toContain("pg_catalog.acldefault('d', database_row.datdba)")
    expect(privilegeProof).toContain("pg_catalog.acldefault('s', sequence_row.relowner)")
    expect(privilegeProof).toContain('acl_row.is_grantable')
    expect(privilegeProof).toContain("CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC'")
    expect(privilegeProof).toContain('direct/PUBLIC ACL rows are the complete effective grant-option surface')
    expect(privilegeProof).toContain('has_function_privilege')
    expect(privilegeProof).toContain('has_sequence_privilege')
    expect(privilegeProof).toContain('has_schema_privilege')
    expect(privilegeProof).toContain('has_database_privilege')
    expect(privilegeProof).toContain('pg_auth_members')
    expect(privilegeProof).toContain('oidvectortypes(routine.proargtypes)')
    expect(privilegeProof).toContain('public.forge_epic_172_s3_release_state:SELECT')
    expect(privilegeProof).toContain('public.forge_is_canonical_bounded_string_set(jsonb,integer,integer)')
    expect(privilegeProof).toContain('public.forge_is_canonical_filesystem_capability_set(jsonb)')
    expect(privilegeProof).toContain('public.forge_is_canonical_filesystem_grant_block_v2(jsonb)')
    expect(privilegeProof).toContain('public.forge_is_canonical_utc_timestamp(text)')
    expect(privilegeProof).toContain('pure, immutable input validators')
    expect(bootstrap).toContain('public.forge_preallocate_filesystem_decision_pointer()')
    expect(bootstrap).toContain('public.forge_preallocate_project_filesystem_decision_pointer()')
    expect(bootstrap).toContain('public.forge_reject_filesystem_grant_history_mutation()')
    expect(bootstrap).toContain('public.forge_reject_project_filesystem_decision_mutation()')
    expect(bootstrap).toContain('These six routines are trigger-only')
    expect(bootstrap).toContain('publicTriggerExecuteCount')
    expect(bootstrap).toContain('Trigger-only S3 helpers retain an unsafe PUBLIC EXECUTE grant.')
    expect(ordinaryAppTriggerProof).toContain('postgresql://forge_app_test:forge_app_test@')
    expect(ordinaryAppTriggerProof).toContain("--set project_id=\"${project_id}\"")
    expect(ordinaryAppTriggerProof).toContain("--set package_id=\"${package_id}\" <<'SQL'")
    expect(ordinaryAppTriggerProof).toContain("WHERE project_id = :'project_id'::uuid")
    expect(ordinaryAppTriggerProof).toContain("WHERE work_package_id = :'package_id'::uuid")
    expect(ordinaryAppTriggerProof).not.toContain('--set package_id="${package_id}" --command')
    expect(ordinaryAppTriggerProof).toContain('public.project_filesystem_current_decision_pointers')
    expect(ordinaryAppTriggerProof).toContain('public.filesystem_mcp_current_decision_pointers')
    expect(ordinaryAppTriggerProof).toContain('work_package_local_projection_heads')
    expect(upgradeProof).toContain('prove-migration-0027-ordinary-app-trigger-writes.sh')
    expect(privilegeProof).toContain('root reconciler effective privilege allowlist mismatch')
    expect(privilegeProof).toContain('project_root_reconciliation_write_contexts')
    expect(upgradeProof).toContain('migration-0027-root-reconciler-privileges-assertions.sql')
  })

  it('proves the exact closed privilege allowlist rejects direct, column, and PUBLIC-effective mutations', () => {
    expect(privilegeMutationProof).toContain('GRANT INSERT ON TABLE public.projects TO forge_project_root_reconciler;')
    expect(privilegeMutationProof).toContain('GRANT UPDATE (title) ON TABLE public.tasks TO forge_project_root_reconciler;')
    expect(privilegeMutationProof).toContain('GRANT SELECT (actor_id) ON TABLE public.project_root_reconciliation_write_contexts TO forge_project_root_reconciler;')
    expect(privilegeMutationProof).toContain('GRANT SELECT ON TABLE public.projects TO forge_project_root_reconciler WITH GRANT OPTION;')
    expect(privilegeMutationProof).toContain('GRANT EXECUTE ON FUNCTION forge.read_epic_172_enablement_state_v1() TO PUBLIC;')
    expect(privilegeMutationProof).toContain('root reconciler effective privilege allowlist mismatch')
    expect(privilegeMutationProof).toContain('public.projects:INSERT')
    expect(privilegeMutationProof).toContain('public.tasks.title')
    expect(privilegeMutationProof).toContain('public.project_root_reconciliation_write_contexts.actor_id')
    expect(privilegeMutationProof).toContain('public.projects:SELECT:grantor=${grantor}:grantee=forge_project_root_reconciler')
    expect(privilegeMutationProof).toContain('forge.read_epic_172_enablement_state_v1()')
    expect(privilegeMutationProof).toContain('\\i ${assertion_file}')
    expect(privilegeMutationProof).not.toContain('has_table_privilege')
    expect(privilegeMutationProof).toContain('fresh clean allowlist assertion')
    expect(privilegeMutationProof).toContain('snapshot_application_acls')
    expect(upgradeProof).toContain('prove-migration-0027-root-reconciler-privilege-mutations.sh')
  })

  it('rejects stale and fabricated root reconciliation context reuse before the CLI resumes', () => {
    expect(staleContextProof).toContain('forge.enter_project_root_reconciliation_generation_v1')
    expect(staleContextProof).toContain('forge.complete_project_root_reconciliation_generation_v1')
    expect(staleContextProof).toContain("set_config('forge.project_root_context','forged',true)")
    expect(staleContextProof).toContain('project-root write context is absent or stale')
    expect(upgradeProof.indexOf('prove-migration-0027-root-stale-context.sh')).toBeLessThan(
      upgradeProof.indexOf('reconcile-migration-0027-root-refs.sh'),
    )
  })

  it('binds negative assertion inputs outside the dollar-quoted PL/pgSQL body', () => {
    expect(negativeAssertions).toContain('BEGIN;')
    expect(negativeAssertions).toContain('CREATE TEMP TABLE root_negative_assertion_inputs')
    expect(negativeAssertions).toContain("VALUES (:'operation_id'::uuid, :'task_id'::uuid, :'generation'::bigint)")
    expect(negativeAssertions).toContain('FROM root_negative_assertion_inputs')
    expect(negativeAssertions).toContain('COMMIT;')
    expect(negativeAssertions).not.toContain("id=:'task_id'")
  })

  it('uses two dedicated sessions and bounded lock-timeout contention before the CLI resumes', () => {
    expect(contentionProof).toContain('forge.claim_project_root_reconciliation_batch_v1')
    expect(contentionProof).toContain('forge.enter_project_root_reconciliation_generation_v1')
    expect(contentionProof).toContain("lock_timeout='250ms'")
    expect(contentionProof).toContain('canceling statement due to lock timeout')
    expect(contentionProof).toContain("[[ \"$loser_status\" == 1 ]]")
    expect(contentionProof).toContain("'${outcome}'")
    expect(contentionProof).not.toContain('FROM public.project_root_change_journal WHERE generation=1));')
    expect(upgradeProof.indexOf('prove-migration-0027-root-contention.sh')).toBeLessThan(upgradeProof.indexOf('reconcile-migration-0027-root-refs.sh'))
  })

  it('requires invocation-specific psql exit statuses for command and script rejections', () => {
    expect(negativeProof).toContain("expect_failure 1 'project-root operation identity cannot be hijacked'")
    expect(negativeProof).toContain("expect_failure 3 'division by zero'")
    expect(staleContextProof).toContain("expect_failure 1 'project-root task update has no active write context'")
    expect(staleContextProof).toContain("expect_failure 3 'division by zero'")
  })

  it('selects phase suppression only in the internal root-journal caller', () => {
    expect(reconcileScript).toContain('suppressPhasePersistence: true')
    expect(reconciliation).toContain('suppressPhasePersistence?: boolean')
    const normalizedReconciliation = reconciliation.replace(/\s+/g, ' ')
    expect(normalizedReconciliation).toMatch(
      /const effective = input\.suppressPhasePersistence \? undefined : grant \? phasesWithEffective\(pkg\.metadata, projectFilesystemEffectivePhase\(grant\)\) : forcePersist \? currentPhases : undefined/,
    )
    expect(reconcileScript).not.toContain('--suppress')
    expect(reconcileScript).toContain('forge.enter_project_root_reconciliation_generation_v1')
    expect(reconcileScript).toContain('rootReconciliationContext:')
    expect(reconciliation).toContain('forge.lock_project_root_reconciliation_authority_v1')
    expect(reconcileScript).toContain("completion.state === 'complete'")
    expect(reconcileScript).toContain('Project-root completion returned an invalid state.')
    expect(reconciliation).toContain('input.rootReconciliationContext ? packageDecisionQuery : packageDecisionQuery.for(\'update\')')
  })

  it('keeps concurrent index DDL separate and strict cutover watermark-fenced', () => {
    expect(indexScript).toContain('CREATE UNIQUE INDEX CONCURRENTLY')
    expect(indexScript).toContain('type IndexState =')
    expect(indexScript).toContain('let index: IndexState | undefined = (await inspect())[0]')
    expect(indexScript).toContain('FORGE_DATABASE_ADMIN_URL')
    expect(reconcileScript).not.toContain('FORGE_DATABASE_ADMIN_URL')
    expect(cutoverScript).toContain('--through <nonnegative-generation> --apply')
    expect(cutoverScript).toContain('DO \\$cutover\\$')
    expect(cutoverScript).toContain('\\$cutover\\$;')
    expect(cutoverScript).toContain('DECLARE v_through bigint := ${through}::bigint;')
    expect(cutoverScript).toContain('project_root_reconciliation_operations')
    expect(cutoverScript).toContain('projects_root_ref_idx')
    expect(cutoverScript).toContain("pg_catalog.to_regclass('public.projects_root_ref_idx')")
    expect(cutoverScript).toContain('strict root-reference cutover requires the exact canonical concurrent projects(root_ref) index')
    const advisoryLock = cutoverScript.indexOf("pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('forge:projects_root_ref_idx:v1'))")
    const indexGuard = cutoverScript.indexOf('strict root-reference cutover requires the exact canonical concurrent projects(root_ref) index')
    const coverageGuard = cutoverScript.indexOf('strict root-reference cutover requires exact completed watermark coverage')
    const proofConstraint = cutoverScript.indexOf('ALTER TABLE public.projects ADD CONSTRAINT projects_root_ref_not_null_proof')
    expect(advisoryLock).toBeGreaterThanOrEqual(0)
    expect(advisoryLock).toBeLessThan(indexGuard)
    expect(indexGuard).toBeLessThan(coverageGuard)
    expect(coverageGuard).toBeLessThan(proofConstraint)
    const authorityPrepare = upgradeProof.indexOf('bash scripts/ci/prove-migration-0027-root-authority-reconciliation.sh --prepare')
    const indexPrepare = upgradeProof.indexOf('bash scripts/ci/prove-migration-0027-root-index-lifecycle.sh --prepare')
    const reconcile = upgradeProof.indexOf('bash scripts/ci/reconcile-migration-0027-root-refs.sh')
    const authorityAssert = upgradeProof.indexOf('bash scripts/ci/prove-migration-0027-root-authority-reconciliation.sh --assert')
    const indexRecover = upgradeProof.indexOf('bash scripts/ci/prove-migration-0027-root-index-lifecycle.sh --recover')
    const cutover = upgradeProof.indexOf('bash scripts/ci/cutover-migration-0027-root-ref.sh --apply')
    expect(authorityPrepare).toBeGreaterThanOrEqual(0)
    expect(authorityPrepare).toBeLessThan(indexPrepare)
    expect(indexPrepare).toBeLessThan(reconcile)
    expect(reconcile).toBeLessThan(authorityAssert)
    expect(authorityAssert).toBeLessThan(indexRecover)
    expect(indexRecover).toBeLessThan(cutover)
    expect(upgradeProof.match(/bash scripts\/ci\/reconcile-migration-0027-root-refs\.sh/g)).toHaveLength(1)
    expect(upgradeProof).not.toContain('FORGE_ROOT_INDEX_LIFECYCLE_PROOF')
    expect(upgradeProof.match(/bash scripts\/ci\/prove-migration-0027-root-index-lifecycle\.sh/g)).toHaveLength(2)
    expect(indexLifecycleProof).toContain("expect_failure \"$canonical_index_refusal\"")
    expect(indexLifecycleProof).toContain('grep -F -- "$expected_message" "$output" >/dev/null')
    expect(indexLifecycleProof).not.toContain('rg --fixed-strings')
    expect(indexLifecycleProof).toContain('assert_cutover_not_started')
    expect(indexLifecycleProof).toContain('CREATE UNIQUE INDEX CONCURRENTLY projects_root_ref_idx ON public.projects(id) WHERE root_ref IS NOT NULL')
    expect(indexLifecycleProof).toContain('projects_root_ref_idx exists with a noncanonical definition.')
    expect(indexLifecycleProof).toContain('could not create unique index "projects_root_ref_idx"')
    expect(indexLifecycleProof).toContain('DROP INDEX CONCURRENTLY public.projects_root_ref_idx')
    expect(indexLifecycleProof).toContain('--prepare|--recover')
    expect(indexLifecycleProof).not.toContain('reconcile-migration-0027-root-refs.sh')
    const authorityAssertBody = rootAuthorityProof.slice(rootAuthorityProof.indexOf('  --assert)'))
    const indexRecoverBody = indexLifecycleProof.slice(indexLifecycleProof.indexOf('  --recover)'))
    expect(authorityAssertBody).not.toContain('UPDATE public.projects')
    expect(authorityAssertBody).not.toContain('INSERT INTO public.projects')
    expect(indexRecoverBody).not.toContain('UPDATE public.projects')
    expect(indexRecoverBody).not.toContain('INSERT INTO public.projects')
    expect(webCi).toContain('FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL')
    expect(webCi).toContain('Capture the post-drain root journal watermark')
  })
})
