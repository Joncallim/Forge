import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('verification goal execution schema migration', () => {
  it('adds protected policy, run, evidence, and schedule surfaces for issue #187 Slice B', async () => {
    const migration = await readFile(
      path.join(process.cwd(), 'db/migrations/0035_verification_goal_execution_schema.sql'),
      'utf8',
    )

    expect(migration).toContain('CREATE TABLE "verification_goal_policy_revisions"')
    expect(migration).toContain('CREATE TABLE "verification_goal_policy_heads"')
    expect(migration).toContain('CREATE TABLE "verification_goal_runs"')
    expect(migration).toContain('CREATE TABLE "verification_goal_events"')
    expect(migration).toContain('CREATE TABLE "verification_goal_repository_snapshots"')
    expect(migration).toContain('CREATE TABLE "verification_goal_environment_snapshots"')
    expect(migration).toContain('CREATE TABLE "verification_goal_schedule_bindings"')
    expect(migration).toContain('CREATE TABLE "verification_goal_schedule_heads"')
    expect(migration).toContain('CREATE TABLE "verification_goal_schedule_slots"')

    expect(migration).toContain('verification_goal_runs_active_project_goal_idx')
    expect(migration).toContain('verification_goal_runs_manual_idempotency_idx')
    expect(migration).toContain('verification_goal_events_run_sequence_idx')
    expect(migration).toContain('verification_goal_schedule_slots_binding_sequence_idx')

    expect(migration).toContain('forge_commit_verification_goal_policy_revision_v1(')
    expect(migration).toContain('forge_claim_verification_goal_run_lease_v1(')
    expect(migration).toContain('forge_begin_verification_goal_child_operation_v1(')
    expect(migration).toContain('forge_terminalize_verification_goal_run_v1(')

    expect(migration).toContain('verification_goal_policy_heads_protected_write')
    expect(migration).toContain('verification_goal_runs_protected_write')
    expect(migration).toContain('verification_goal_events_append_only')
    expect(migration).toContain('verification_goal_repository_snapshots_append_only')

    expect(migration).toContain('ALTER TABLE "public"."execution_outcomes"')
    expect(migration).toContain('ADD COLUMN "verification_goal_run_id" uuid')
    expect(migration).toContain('execution_outcomes_subject_check')
    expect(migration).toContain('operation_runs_subject_check')
    expect(migration).toContain('capability_attempts_subject_check')
    expect(migration).toContain('repository_command_audits_subject_check')

    expect(migration).toContain('OWNER TO forge_s4_routines_owner')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.forge_commit_verification_goal_policy_revision_v1(')
  })

  it('keeps the ordinary app read-only on protected execution surfaces', async () => {
    const workflow = await readFile(path.join(process.cwd(), '../.github/workflows/web-ci.yml'), 'utf8')
    const reconciler = await readFile(
      path.join(process.cwd(), '../scripts/reconcile-forge-app-privileges.sql'),
      'utf8',
    )

    expect(workflow).toContain('verification_goal_policy_revisions')
    expect(workflow).toContain('verification_goal_runs')
    expect(workflow).toMatch(
      /GRANT SELECT ON TABLE public\.verification_goal_registry_revisions,[\s\S]*public\.verification_goal_schedule_slots TO forge_app_test/u,
    )

    expect(reconciler).toContain('verification_goal_policy_revisions')
    expect(reconciler).toContain('verification_goal_schedule_slots')
    expect(reconciler).toMatch(
      /GRANT SELECT ON TABLE[\s\S]*public\.verification_goal_schedule_slots[\s\S]*TO forge/u,
    )
    expect(reconciler).toContain(
      'verification goal policy commit routine owner or execute boundary is invalid',
    )
  })
})
