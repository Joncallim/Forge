import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('verification goal snapshot migration', () => {
  it('stores only immutable, bounded, project-scoped definition snapshots', async () => {
    const migration = await readFile(
      path.join(process.cwd(), 'db/migrations/0032_verification_goal_snapshots.sql'),
      'utf8',
    )
    expect(migration).toContain('CREATE TABLE "verification_goal_snapshots"')
    expect(migration).toContain('verification_goal_snapshots_project_goal_version_idx')
    expect(migration).toContain('verification_goal_snapshots_canonical_definition_check')
    expect(migration).toContain('verification_goal_snapshots_definition_digest_check')
    expect(migration).toContain('verification_goal_snapshots_source_path_check')
    expect(migration).toContain('forge_reject_verification_goal_snapshot_mutation_v1')
    expect(migration).toContain('verification_goal_snapshots_append_only')
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.forge_reject_verification_goal_snapshot_mutation_v1() FROM PUBLIC')
    expect(migration).not.toMatch(/goal_runs|last_green|first_fail|schedule|outcome/i)
  })

  it('pins the ordinary application role to SELECT and INSERT only', async () => {
    const workflow = await readFile(path.join(process.cwd(), '../.github/workflows/web-ci.yml'), 'utf8')
    expect(workflow).toContain('verification_goal_snapshots')
    expect(workflow).toMatch(
      /GRANT SELECT, INSERT ON TABLE public\.verification_goal_snapshots TO forge_app_test/u,
    )
  })

  it('adds immutable registry revisions and entries with one monotonic same-project head', async () => {
    const migration = await readFile(
      path.join(process.cwd(), 'db/migrations/0033_verification_goal_registry_revisions.sql'),
      'utf8',
    )
    expect(migration).toContain('CREATE TABLE "verification_goal_registry_revisions"')
    expect(migration).toContain('CREATE TABLE "verification_goal_registry_entries"')
    expect(migration).toContain('CREATE TABLE "verification_goal_registry_heads"')
    expect(migration).toContain('"revision_sequence" bigint NOT NULL')
    expect(migration).toContain('"application_asserted_actor_user_id" uuid NOT NULL')
    expect(migration).not.toContain('"actor_user_id" uuid NOT NULL')
    expect(migration).toContain('verification_goal_registry_revisions_project_sequence_idx')
    expect(migration).toContain('"revision_sequence" > 0')
    expect(migration).toContain('"predecessor_revision_id" uuid')
    expect(migration).toMatch(/UNIQUE NULLS NOT DISTINCT \([\s\S]*"predecessor_revision_id"[\s\S]*"manifest_digest"/u)
    expect(migration).toContain('verification_goal_registry_revisions_protected_write')
    expect(migration).toContain('verification_goal_registry_entries_protected_write')
    expect(migration).toContain('verification_goal_registry_heads_protected_write')
    expect(migration).toContain('NEW.revision_sequence <> OLD.revision_sequence + 1')
    expect(migration).toContain('verification_goal_registry_heads_revision_project_sequence_fk')
    expect(migration).toContain('verification_goal_registry_entries_snapshot_project_fk')
    expect(migration).toContain('verification_goal_snapshots_registry_entry_identity_idx')
    expect(migration).toMatch(
      /forge_commit_verification_goal_registry_revision_v1\([\s\S]*SET search_path = pg_catalog\nAS/u,
    )
    expect(migration).toMatch(
      /FOREIGN KEY \([\s\S]*"snapshot_id", "project_id", "goal_id", "definition_version", "definition_digest"[\s\S]*REFERENCES "public"\."verification_goal_snapshots"/u,
    )
    expect(migration).not.toMatch(/goal_runs|last_green|first_fail|schedule|outcome/i)
  })

  it('expands registry activation for executable v2 definitions without changing v1 history', async () => {
    const migration = await readFile(
      path.join(process.cwd(), 'db/migrations/0034_verification_goal_executable_bindings.sql'),
      'utf8',
    )
    expect(migration).toContain('DROP CONSTRAINT verification_goal_snapshots_canonical_definition_check')
    expect(migration).toContain("'schemaVersion', 1")
    expect(migration).toContain("'schemaVersion', 2")
    expect(migration).toContain("'manual', 'schedule', 'deadlineSeconds', 'requiredEvidence'")
    expect(migration).toContain('ADD COLUMN manifest_schema_version integer NOT NULL DEFAULT 1')
    expect(migration).toContain('ADD COLUMN entry_schema_version integer NOT NULL DEFAULT 1')
    expect(migration).toContain('ADD COLUMN execution_binding jsonb')
    expect(migration).toContain('ADD COLUMN execution_binding_digest text')
    expect(migration).toContain('verification_goal_registry_entries_schema_binding_check')
    expect(migration).toContain('forge_commit_verification_goal_registry_revision_v2(')
    expect(migration).toContain("'forge:verification-goal:registry-manifest:v2'")
    expect(migration).toContain('FROM public.forge_commit_verification_goal_registry_revision_v1(')
    expect(migration).toContain('ALTER FUNCTION public.forge_commit_verification_goal_registry_revision_v2(')
    expect(migration).toContain('OWNER TO forge_s4_routines_owner')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.forge_commit_verification_goal_registry_revision_v2(')
    expect(migration).not.toMatch(/goal_runs|last_green|first_fail|outcome/i)
  })

  it('makes the ordinary app read-only on protected history and keeps the v1 commit routine available', async () => {
    const workflow = await readFile(path.join(process.cwd(), '../.github/workflows/web-ci.yml'), 'utf8')
    const reconciler = await readFile(
      path.join(process.cwd(), '../scripts/reconcile-forge-app-privileges.sql'),
      'utf8',
    )
    expect(workflow).toMatch(
      /GRANT SELECT, INSERT ON TABLE public\.verification_goal_snapshots TO forge_app_test/u,
    )
    expect(workflow).toMatch(
      /GRANT SELECT ON TABLE public\.verification_goal_registry_revisions,[\s\S]*public\.verification_goal_registry_heads TO forge_app_test/u,
    )
    expect(workflow).toContain("'verification_goal_registry_heads'")
    expect(reconciler).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*public\.verification_goal_snapshots,[\s\S]*public\.verification_goal_registry_heads[\s\S]*FROM forge/u,
    )
    expect(reconciler).toMatch(
      /GRANT SELECT ON TABLE[\s\S]*public\.verification_goal_registry_revisions,[\s\S]*public\.verification_goal_registry_entries,[\s\S]*public\.verification_goal_registry_heads[\s\S]*TO forge/u,
    )
    expect(reconciler).toContain(
      'GRANT EXECUTE ON FUNCTION public.forge_commit_verification_goal_registry_revision_v1(',
    )
    expect(reconciler).toContain(
      'forge verification goal registry privileges are outside the exact append-only matrix',
    )
  })

  it('records migration 0034 as the current journal tip immediately after 0033', async () => {
    const journal = JSON.parse(await readFile(
      path.join(process.cwd(), 'db/migrations/meta/_journal.json'),
      'utf8',
    )) as { entries: Array<{ idx: number; tag: string }> }
    expect(journal.entries.at(-2)).toEqual(expect.objectContaining({
      idx: 33,
      tag: '0033_verification_goal_registry_revisions',
    }))
    expect(journal.entries.at(-1)).toEqual(expect.objectContaining({
      idx: 34,
      tag: '0034_verification_goal_executable_bindings',
    }))
  })

  it('bounds concurrent unique-key waits inside the import transaction', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'worker/verification-goals/snapshots.ts'),
      'utf8',
    )
    expect(source).toContain("SET LOCAL lock_timeout = '5s'")
    expect(source.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(
      source.indexOf('insertOrResolveSnapshot(tx, projectId, goal)'),
    )
    const registryStore = await readFile(
      path.join(process.cwd(), 'worker/verification-goals/registry-store.ts'),
      'utf8',
    )
    expect(registryStore).toContain("SET LOCAL lock_timeout = '5s'")
    expect(registryStore.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(
      registryStore.indexOf('snapshots.push(await insertOrResolveVerificationGoalSnapshot'),
    )
  })
})
