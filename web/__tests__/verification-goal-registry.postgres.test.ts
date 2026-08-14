import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { VERIFICATION_GOAL_REGISTRY_PATH } from '@/lib/verification-goals/registry'

const required = process.env.FORGE_VERIFICATION_GOAL_REGISTRY_REQUIRE_POSTGRES_TEST === '1'
const databaseUrl = process.env.DATABASE_URL?.trim()
const adminUrl = process.env.FORGE_VERIFICATION_GOAL_REGISTRY_POSTGRES_ADMIN_TEST_URL?.trim()
const enabled = required && Boolean(databaseUrl && adminUrl)

if (required && (!databaseUrl || !adminUrl)) {
  throw new Error(
    'FORGE_VERIFICATION_GOAL_REGISTRY_REQUIRE_POSTGRES_TEST=1 requires DATABASE_URL and FORGE_VERIFICATION_GOAL_REGISTRY_POSTGRES_ADMIN_TEST_URL for the disposable PostgreSQL verification-goal-registry proof; the mandatory suite may not skip.',
  )
}

describe.skipIf(!enabled)('verification goal registry PostgreSQL behavior', () => {
  const ids = { user: randomUUID(), project: randomUUID() }
  let root: string
  let directory: string
  let sql: ReturnType<typeof postgres>
  let adminSql: ReturnType<typeof postgres>

  function goal(goalId: string, definitionVersion: number, description = 'Original definition') {
    return {
      schemaVersion: 1,
      goalId,
      definitionVersion,
      title: `${goalId} proof`,
      description,
      capability: 'filesystem.project.read',
      severity: 'critical',
      enabled: true,
      operations: [{ operationId: 'repository.status.read', operationVersion: 1 }],
    }
  }

  async function writeGoal(fileName: string, value: ReturnType<typeof goal>): Promise<void> {
    await writeFile(path.join(directory, fileName), JSON.stringify(value))
  }

  async function bindProjectRoot() {
    const canonicalRoot = await realpath(root)
    const identity = await stat(canonicalRoot, { bigint: true })
    return { path: canonicalRoot, dev: identity.dev, ino: identity.ino }
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'forge-verification-goals-postgres-'))
    directory = path.join(root, ...VERIFICATION_GOAL_REGISTRY_PATH.split('/'))
    await mkdir(directory, { recursive: true })
    sql = postgres(databaseUrl!, { max: 4, onnotice: () => {} })
    adminSql = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    await sql`
      insert into users (id, display_name)
      values (${ids.user}::uuid, ${`Verification goal proof ${ids.user}`})
    `
    await sql`
      insert into projects (id, name, submitted_by, grant_decision_revision, root_binding_revision)
      values (${ids.project}::uuid, 'Verification goal PostgreSQL proof', ${ids.user}::uuid, 1, 1)
    `
  })

  afterAll(async () => {
    const databaseModule = await import('@/db')
    await databaseModule.closeDb()
    await Promise.all([
      sql?.end({ timeout: 5 }),
      adminSql?.end({ timeout: 5 }),
      root ? rm(root, { recursive: true, force: true }) : Promise.resolve(),
    ])
  })

  it('is idempotent under concurrent imports and hard-conflicts on divergent content', async () => {
    const { importVerificationGoalRegistryForTest } = await import('@/worker/verification-goals/importer')
    const { databaseVerificationGoalSnapshotStore } = await import('@/worker/verification-goals/snapshots')
    const dependencies = {
      loadProject: async () => ({ id: ids.project, localPath: root }),
      bindProjectRoot,
      store: databaseVerificationGoalSnapshotStore,
    }
    await writeGoal('z-proof.json', goal('z-proof', 1))
    const results = await Promise.all([
      importVerificationGoalRegistryForTest({ projectId: ids.project }, dependencies),
      importVerificationGoalRegistryForTest({ projectId: ids.project }, dependencies),
    ])
    expect(results.flat().map((result) => result.kind).sort()).toEqual(['existing', 'inserted'])

    await writeGoal('z-proof.json', goal('z-proof', 1, 'Divergent definition'))
    await expect(importVerificationGoalRegistryForTest({ projectId: ids.project }, dependencies))
      .rejects.toThrow(/different content/i)
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from verification_goal_snapshots
      where project_id = ${ids.project}::uuid
    `
    expect(count).toBe(1)
  })

  it('rolls back newly inserted snapshots when a later goal conflicts', async () => {
    const { importVerificationGoalRegistryForTest } = await import('@/worker/verification-goals/importer')
    const { databaseVerificationGoalSnapshotStore } = await import('@/worker/verification-goals/snapshots')
    await writeGoal('a-new.json', goal('a-new', 1))
    await expect(importVerificationGoalRegistryForTest({ projectId: ids.project }, {
      loadProject: async () => ({ id: ids.project, localPath: root }),
      bindProjectRoot,
      store: databaseVerificationGoalSnapshotStore,
    }))
      .rejects.toThrow(/different content/i)
    const rows = await sql<{ goalId: string }[]>`
      select goal_id as "goalId" from verification_goal_snapshots
      where project_id = ${ids.project}::uuid order by goal_id
    `
    expect(rows.map((row) => row.goalId)).toEqual(['z-proof'])
  })

  it('appends a version bump and keeps history after repository source removal', async () => {
    const { importVerificationGoalRegistryForTest } = await import('@/worker/verification-goals/importer')
    const { databaseVerificationGoalSnapshotStore } = await import('@/worker/verification-goals/snapshots')
    const dependencies = {
      loadProject: async () => ({ id: ids.project, localPath: root }),
      bindProjectRoot,
      store: databaseVerificationGoalSnapshotStore,
    }
    await unlink(path.join(directory, 'a-new.json'))
    await writeGoal('z-proof.json', goal('z-proof', 2, 'Replacement current definition'))
    await expect(importVerificationGoalRegistryForTest({ projectId: ids.project }, dependencies))
      .resolves.toMatchObject([{ definitionVersion: 2, kind: 'inserted' }])
    await unlink(path.join(directory, 'z-proof.json'))
    await expect(importVerificationGoalRegistryForTest({ projectId: ids.project }, dependencies))
      .resolves.toEqual([])

    const rows = await sql<{ version: number }[]>`
      select definition_version as version from verification_goal_snapshots
      where project_id = ${ids.project}::uuid order by definition_version
    `
    expect(rows.map((row) => row.version)).toEqual([1, 2])
  })

  it('denies ordinary mutation and retains the append-only trigger for privileged writers', async () => {
    const [privileges] = await sql<{ canSelect: boolean; canInsert: boolean; canUpdate: boolean; canDelete: boolean }[]>`
      select
        has_table_privilege(current_user, 'public.verification_goal_snapshots', 'SELECT') as "canSelect",
        has_table_privilege(current_user, 'public.verification_goal_snapshots', 'INSERT') as "canInsert",
        has_table_privilege(current_user, 'public.verification_goal_snapshots', 'UPDATE') as "canUpdate",
        has_table_privilege(current_user, 'public.verification_goal_snapshots', 'DELETE') as "canDelete"
    `
    expect(privileges).toEqual({ canSelect: true, canInsert: true, canUpdate: false, canDelete: false })
    await expect(sql`
      update verification_goal_snapshots set source_path = source_path
      where project_id = ${ids.project}::uuid
    `).rejects.toThrow(/permission denied/i)
    await expect(adminSql`
      update verification_goal_snapshots set source_path = source_path
      where project_id = ${ids.project}::uuid
    `).rejects.toThrow(/append-only/i)
    await expect(adminSql`
      delete from verification_goal_snapshots where project_id = ${ids.project}::uuid
    `).rejects.toThrow(/append-only/i)
  })
})
