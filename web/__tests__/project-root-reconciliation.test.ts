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
    expect(migration).toContain('project-root completion compare-and-set failed')
    expect(migration).toContain('project-root generation already has an immutable outcome')
    expect(migration).toContain('forge.materialize_project_root_ref_expansion_v1')
  })

  it('uses the dedicated login with only canonical helper state columns and fixed routines', () => {
    expect(reconcileScript).toContain('FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL')
    expect(reconcileScript).toContain("forge_project_root_reconciler")
    expect(reconcileScript).toContain('reconcileFilesystemGrantsForProject')
    expect(reconcileScript).toContain('hasBoundFilesystemAuthority')
    expect(bootstrap).toContain("'forge_project_root_reconciler'")
    expect(migration).toContain('GRANT UPDATE (status, error_message, updated_at) ON public.tasks TO forge_project_root_reconciler')
    expect(migration).toContain('GRANT UPDATE (status, blocked_reason, metadata, updated_at) ON public.work_packages TO forge_project_root_reconciler')
    expect(migration).toContain('GRANT UPDATE (id) ON public.work_package_local_projection_heads TO forge_project_root_reconciler')
    expect(bootstrap).toContain('grant update (id) on table public.work_package_local_projection_heads to forge_project_root_reconciler')
    expect(migration).toContain('public.project_root_reconciliation_operations')
    expect(migration).toContain('REVOKE ALL ON FUNCTION forge.begin_project_root_reconciliation_v1')
    for (const table of [
      'project_root_reconciliation_operations',
      'project_root_reconciliation_checkpoints',
      'project_root_reconciliation_outcomes',
    ]) expect(webCi).toContain(`'${table}'`)
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
