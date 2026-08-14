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
    expect(workflow).toMatch(/GRANT SELECT, INSERT ON TABLE public\.verification_goal_snapshots TO forge_app_test/)
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
  })
})
