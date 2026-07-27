import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseProjectRootReconciliationCommand,
  PROJECT_ROOT_RECONCILIATION_STATES,
} from '@/lib/mcps/project-root-reconciliation'

const migration = readFileSync(fileURLToPath(new URL('../db/migrations/0027_epic_172_s4_packet_context.sql', import.meta.url)), 'utf8')
const schema = readFileSync(fileURLToPath(new URL('../db/schema.ts', import.meta.url)), 'utf8')
const bootstrap = readFileSync(fileURLToPath(new URL('../scripts/bootstrap-epic-172-s4-roles.ts', import.meta.url)), 'utf8')
const reconcileScript = readFileSync(fileURLToPath(new URL('../scripts/reconcile-project-root-expansion.ts', import.meta.url)), 'utf8')
const reconciliation = readFileSync(fileURLToPath(new URL('../lib/mcps/filesystem-grant-reconciliation.ts', import.meta.url)), 'utf8')
const indexScript = readFileSync(fileURLToPath(new URL('../scripts/build-project-root-ref-index.ts', import.meta.url)), 'utf8')
const cutoverScript = readFileSync(fileURLToPath(new URL('../scripts/ci/cutover-migration-0027-root-ref.sh', import.meta.url)), 'utf8')
const webCi = readFileSync(fileURLToPath(new URL('../../.github/workflows/web-ci.yml', import.meta.url)), 'utf8')

describe('project-root expansion reconciliation boundary', () => {
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
    expect(schema).toContain("project_root_reconciliation_one_live_idx")
    expect(PROJECT_ROOT_RECONCILIATION_STATES).toEqual(['running', 'complete'])
  })

  it('fences operation creation and completion against gaps, later commits, and hijack', () => {
    expect(migration).toContain('forge.assert_project_root_journal_window_v1')
    expect(migration).toContain('v_counter <> p_through_generation OR v_max <> p_through_generation OR v_count <> p_through_generation')
    expect(migration).toContain('project-root operation identity cannot be hijacked')
    expect(migration).toContain('operation_row.actor_id = p_actor_id')
    expect(migration).toContain('operation_row.through_generation = p_through_generation')
    expect(migration).toContain('project-root completion compare-and-set failed')
    expect(migration).toContain('project-root generation already has an immutable outcome')
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

  it('selects phase suppression only in the internal root-journal caller', () => {
    expect(reconcileScript).toContain('suppressPhasePersistence: true')
    expect(reconciliation).toContain('suppressPhasePersistence?: boolean')
    expect(reconciliation).toContain('input.suppressPhasePersistence ? undefined : grant')
    expect(reconcileScript).not.toContain('--suppress')
  })

  it('keeps concurrent index DDL separate and strict cutover watermark-fenced', () => {
    expect(indexScript).toContain('CREATE UNIQUE INDEX CONCURRENTLY')
    expect(indexScript).toContain('FORGE_DATABASE_ADMIN_URL')
    expect(reconcileScript).not.toContain('FORGE_DATABASE_ADMIN_URL')
    expect(cutoverScript).toContain('--through <nonnegative-generation> --apply')
    expect(cutoverScript).toContain('project_root_reconciliation_operations')
    expect(cutoverScript).toContain('projects_root_ref_idx')
    expect(webCi).toContain('FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL')
    expect(webCi).toContain('Capture the post-drain root journal watermark')
  })
})
