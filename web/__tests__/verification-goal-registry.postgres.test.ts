import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  parseVerificationGoalDefinition,
  verificationGoalDefinitionDigest,
} from '@/lib/verification-goals/contracts'
import { VERIFICATION_GOAL_REGISTRY_PATH } from '@/lib/verification-goals/registry'
import type { LoadedVerificationGoal } from '@/lib/verification-goals/registry'
import { verificationGoalRegistryManifest } from '@/lib/verification-goals/manifest'
import { db } from '@/db'
import {
  createDatabaseVerificationGoalRegistryStore,
  type VerificationGoalRegistryStore,
} from '@/worker/verification-goals/registry-store'

const required = process.env.FORGE_VERIFICATION_GOAL_REGISTRY_REQUIRE_POSTGRES_TEST === '1'
const adminUrl = process.env.FORGE_VERIFICATION_GOAL_REGISTRY_POSTGRES_ADMIN_TEST_URL?.trim()
const appUrl = process.env.FORGE_VERIFICATION_GOAL_REGISTRY_POSTGRES_APP_TEST_URL?.trim()
const enabled = required && Boolean(appUrl && adminUrl)

if (required && (!appUrl || !adminUrl)) {
  throw new Error(
    'FORGE_VERIFICATION_GOAL_REGISTRY_REQUIRE_POSTGRES_TEST=1 requires FORGE_VERIFICATION_GOAL_REGISTRY_POSTGRES_APP_TEST_URL and FORGE_VERIFICATION_GOAL_REGISTRY_POSTGRES_ADMIN_TEST_URL for the disposable PostgreSQL verification-goal-registry proof; the mandatory suite may not skip.',
  )
}

describe.skipIf(!enabled)('verification goal registry PostgreSQL behavior', () => {
  const ids = { user: randomUUID(), project: randomUUID() }
  let root: string
  let directory: string
  let sql: ReturnType<typeof postgres>
  let adminSql: ReturnType<typeof postgres>
  let registryStore: VerificationGoalRegistryStore

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

  function loadedGoal(fileName: string, value: ReturnType<typeof goal>): LoadedVerificationGoal {
    const definition = parseVerificationGoalDefinition(value)
    return {
      definition,
      definitionDigest: verificationGoalDefinitionDigest(definition),
      sourcePath: `${VERIFICATION_GOAL_REGISTRY_PATH}/${fileName}`,
    }
  }

  async function bindProjectRoot() {
    const canonicalRoot = await realpath(root)
    const identity = await stat(canonicalRoot, { bigint: true })
    return { path: canonicalRoot, dev: identity.dev, ino: identity.ino }
  }

  async function loadProjectAuthority() {
    const [project] = await sql<{
      id: string
      submittedBy: string | null
      archivedAt: Date | null
      localPath: string | null
      rootRef: string | null
      rootBindingRevision: string
      grantDecisionRevision: string
      updatedAt: string
      priorHeadRevisionId: string | null
    }[]>`
      select
        p.id::text as id,
        p.submitted_by::text as "submittedBy",
        p.archived_at as "archivedAt",
        p.local_path as "localPath",
        p.root_ref::text as "rootRef",
        p.root_binding_revision::text as "rootBindingRevision",
        p.grant_decision_revision::text as "grantDecisionRevision",
        to_char(
          p.updated_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as "updatedAt",
        h.registry_revision_id::text as "priorHeadRevisionId"
      from projects p
      left join verification_goal_registry_heads h on h.project_id = p.id
      where p.id = ${ids.project}::uuid
    `
    if (!project) return null
    return {
      ...project,
      rootBindingRevision: BigInt(project.rootBindingRevision),
      grantDecisionRevision: BigInt(project.grantDecisionRevision),
    }
  }

  async function expectSqlState(
    operation: Promise<unknown>,
    code: string,
    label?: string,
  ): Promise<void> {
    let failure: unknown
    try {
      await operation
    } catch (error) {
      failure = error
    }
    expect(failure, label).toMatchObject({ code })
  }

  async function callCommitRoutine(input: {
    authority?: Awaited<ReturnType<typeof loadProjectAuthority>>
    actorUserId?: string
    expectedArchivedAt?: Date | string | null
    manifestDigest?: string
    entries?: readonly Record<string, unknown>[]
    expectedPriorRevisionId?: string | null
  } = {}) {
    const authority = input.authority ?? await loadProjectAuthority()
    if (!authority?.submittedBy || !authority.localPath || !authority.rootRef) {
      throw new Error('PostgreSQL verification goal authority fixture is incomplete.')
    }
    const manifest = verificationGoalRegistryManifest([])
    return sql`
      select *
      from public.forge_commit_verification_goal_registry_revision_v1(
        ${authority.id}::uuid,
        ${input.actorUserId ?? ids.user}::uuid,
        ${input.expectedPriorRevisionId === undefined
          ? authority.priorHeadRevisionId
          : input.expectedPriorRevisionId}::uuid,
        ${authority.submittedBy}::uuid,
        ${input.expectedArchivedAt === undefined
          ? authority.archivedAt
          : input.expectedArchivedAt}::timestamptz,
        ${authority.localPath}::text,
        ${authority.rootRef}::uuid,
        ${authority.rootBindingRevision.toString()}::bigint,
        ${authority.grantDecisionRevision.toString()}::bigint,
        ${authority.updatedAt}::timestamptz,
        ${input.manifestDigest ?? manifest.digest}::text,
        ${JSON.stringify(input.entries ?? [])}::jsonb
      )
    `
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'forge-verification-goals-postgres-'))
    directory = path.join(root, ...VERIFICATION_GOAL_REGISTRY_PATH.split('/'))
    await mkdir(directory, { recursive: true })
    sql = postgres(appUrl!, { max: 4, onnotice: () => {} })
    adminSql = postgres(adminUrl!, { max: 1, onnotice: () => {} })
    registryStore = createDatabaseVerificationGoalRegistryStore(
      drizzle(sql) as unknown as typeof db,
    )
    await adminSql`
      insert into users (id, display_name)
      values (${ids.user}::uuid, ${`Verification goal proof ${ids.user}`})
    `
    await adminSql`
      insert into projects (
        id, name, submitted_by, local_path, grant_decision_revision, root_binding_revision
      ) values (
        ${ids.project}::uuid, 'Verification goal PostgreSQL proof', ${ids.user}::uuid,
        ${root}, 1, 1
      )
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
    const dependencies = {
      loadProject: loadProjectAuthority,
      bindProjectRoot,
      store: registryStore,
    }
    await writeGoal('z-proof.json', goal('z-proof', 1))
    const results = await Promise.all([
      importVerificationGoalRegistryForTest({ projectId: ids.project, actorUserId: ids.user }, dependencies),
      importVerificationGoalRegistryForTest({ projectId: ids.project, actorUserId: ids.user }, dependencies),
    ])
    expect(results.map((result) => result.headState).sort()).toEqual(['advanced', 'existing'])
    expect(results.flatMap((result) => result.snapshots).map((result) => result.kind).sort())
      .toEqual(['existing', 'inserted'])

    await writeGoal('z-proof.json', goal('z-proof', 1, 'Divergent definition'))
    await expect(importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, dependencies))
      .rejects.toThrow(/different content/i)
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from verification_goal_snapshots
      where project_id = ${ids.project}::uuid
    `
    expect(count).toBe(1)
  })

  it('rolls back newly inserted snapshots when a later goal conflicts', async () => {
    const { importVerificationGoalRegistryForTest } = await import('@/worker/verification-goals/importer')
    await writeGoal('a-new.json', goal('a-new', 1))
    await expect(importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, {
      loadProject: loadProjectAuthority,
      bindProjectRoot,
      store: registryStore,
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
    const dependencies = {
      loadProject: loadProjectAuthority,
      bindProjectRoot,
      store: registryStore,
    }
    await unlink(path.join(directory, 'a-new.json'))
    await writeGoal('z-proof.json', goal('z-proof', 2, 'Replacement current definition'))
    await expect(importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, dependencies)).resolves.toMatchObject({
      headState: 'advanced',
      snapshots: [{ definitionVersion: 2, kind: 'inserted' }],
    })
    await unlink(path.join(directory, 'z-proof.json'))
    await expect(importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, dependencies)).resolves.toMatchObject({
      headState: 'advanced',
      snapshots: [],
    })

    const rows = await sql<{ version: number }[]>`
      select definition_version as version from verification_goal_snapshots
      where project_id = ${ids.project}::uuid order by definition_version
    `
    expect(rows.map((row) => row.version)).toEqual([1, 2])
    const [headMembership] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from verification_goal_registry_entries e
      join verification_goal_registry_heads h
        on h.registry_revision_id = e.registry_revision_id
      where h.project_id = ${ids.project}::uuid
    `
    expect(headMembership?.count).toBe(0)
  })

  it('records A to B to A as three transitions with strictly increasing sequences', async () => {
    const { importVerificationGoalRegistryForTest } = await import('@/worker/verification-goals/importer')
    const dependencies = {
      loadProject: loadProjectAuthority,
      bindProjectRoot,
      store: registryStore,
    }
    const definitionA = goal('cycle-goal', 1, 'Cycle definition A')
    const definitionB = goal('cycle-goal', 2, 'Cycle definition B')

    await writeGoal('cycle.json', definitionA)
    const firstA = await importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, dependencies)
    await writeGoal('cycle.json', definitionB)
    const resultB = await importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, dependencies)
    await writeGoal('cycle.json', definitionA)
    const secondA = await importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, dependencies)

    expect(firstA.manifestDigest).toBe(secondA.manifestDigest)
    expect(new Set([
      firstA.registryRevisionId,
      resultB.registryRevisionId,
      secondA.registryRevisionId,
    ]).size).toBe(3)
    const transitions = await sql<{
      id: string
      sequence: string
      predecessorId: string | null
    }[]>`
      select
        id::text as id,
        revision_sequence::text as sequence,
        predecessor_revision_id::text as "predecessorId"
      from verification_goal_registry_revisions
      where id in (
        ${firstA.registryRevisionId}::uuid,
        ${resultB.registryRevisionId}::uuid,
        ${secondA.registryRevisionId}::uuid
      )
      order by revision_sequence
    `
    expect(transitions.map((row) => row.id)).toEqual([
      firstA.registryRevisionId,
      resultB.registryRevisionId,
      secondA.registryRevisionId,
    ])
    expect(transitions[1]?.predecessorId).toBe(firstA.registryRevisionId)
    expect(transitions[2]?.predecessorId).toBe(resultB.registryRevisionId)
    expect(BigInt(transitions[1]!.sequence)).toBe(BigInt(transitions[0]!.sequence) + BigInt(1))
    expect(BigInt(transitions[2]!.sequence)).toBe(BigInt(transitions[1]!.sequence) + BigInt(1))
  })

  it('serializes divergent stale readers so exactly one transition commits', async () => {
    const { importVerificationGoalRegistryForTest } = await import('@/worker/verification-goals/importer')
    const capturedAuthority = await loadProjectAuthority()
    expect(capturedAuthority).not.toBeNull()
    const [before] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from verification_goal_registry_revisions
      where project_id = ${ids.project}::uuid
    `
    const attempt = (loaded: LoadedVerificationGoal) => importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, {
      loadProject: async () => capturedAuthority,
      bindProjectRoot,
      loadRegistry: async () => [loaded],
      store: registryStore,
    })

    const results = await Promise.allSettled([
      attempt(loadedGoal('race-a.json', goal('race-a', 1))),
      attempt(loadedGoal('race-b.json', goal('race-b', 1))),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(fulfilled[0]).toMatchObject({ value: { headState: 'advanced' } })
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: { code: 'registry_head_changed' } })
    const [after] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from verification_goal_registry_revisions
      where project_id = ${ids.project}::uuid
    `
    expect(after!.count).toBe(before!.count + 1)
  })

  it('records a fresh authority epoch as a new child even when the manifest is unchanged', async () => {
    const { importVerificationGoalRegistryForTest } = await import('@/worker/verification-goals/importer')
    const dependencies = {
      loadProject: loadProjectAuthority,
      bindProjectRoot,
      store: registryStore,
    }
    const first = await importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, dependencies)
    await adminSql`
      update projects
      set root_binding_revision = root_binding_revision + 1,
          updated_at = clock_timestamp()
      where id = ${ids.project}::uuid
    `
    const second = await importVerificationGoalRegistryForTest({
      projectId: ids.project,
      actorUserId: ids.user,
    }, dependencies)

    expect(second.manifestDigest).toBe(first.manifestDigest)
    expect(second.registryRevisionId).not.toBe(first.registryRevisionId)
    expect(second.headState).toBe('advanced')
    const transitions = await sql<{ id: string; sequence: string; predecessorId: string | null }[]>`
      select id::text as id, revision_sequence::text as sequence,
        predecessor_revision_id::text as "predecessorId"
      from verification_goal_registry_revisions
      where id in (${first.registryRevisionId}::uuid, ${second.registryRevisionId}::uuid)
      order by revision_sequence
    `
    expect(transitions.map((row) => row.id)).toEqual([
      first.registryRevisionId,
      second.registryRevisionId,
    ])
    expect(transitions[1]?.predecessorId).toBe(first.registryRevisionId)
    expect(BigInt(transitions[1]!.sequence)).toBe(BigInt(transitions[0]!.sequence) + BigInt(1))
  })

  it('rejects every captured authority mismatch before registry writes', async () => {
    const authority = await loadProjectAuthority()
    expect(authority).not.toBeNull()
    const [before] = await sql<{ revisions: number; entries: number }[]>`
      select
        (select count(*)::int from verification_goal_registry_revisions
          where project_id = ${ids.project}::uuid) as revisions,
        (select count(*)::int from verification_goal_registry_entries
          where project_id = ${ids.project}::uuid) as entries
    `
    const mismatches: Array<{
      label: string
      authority?: NonNullable<typeof authority>
      actorUserId?: string
      expectedArchivedAt?: Date | string | null
    }> = [
      { label: 'project id', authority: { ...authority!, id: randomUUID() } },
      { label: 'actor user id', actorUserId: randomUUID() },
      { label: 'submitted by', authority: { ...authority!, submittedBy: randomUUID() } },
      {
        label: 'archived at',
        expectedArchivedAt: '2026-08-15T00:00:00.000000Z',
      },
      { label: 'local path', authority: { ...authority!, localPath: `${authority!.localPath}-moved` } },
      { label: 'root ref', authority: { ...authority!, rootRef: randomUUID() } },
      {
        label: 'root binding revision',
        authority: {
          ...authority!,
          rootBindingRevision: authority!.rootBindingRevision + BigInt(1),
        },
      },
      {
        label: 'grant decision revision',
        authority: {
          ...authority!,
          grantDecisionRevision: authority!.grantDecisionRevision + BigInt(1),
        },
      },
      {
        label: 'project revision',
        authority: { ...authority!, updatedAt: '2000-01-01T00:00:00.000000Z' },
      },
    ]
    for (const mismatch of mismatches) {
      await expectSqlState(callCommitRoutine({
        authority: mismatch.authority ?? authority,
        actorUserId: mismatch.actorUserId,
        expectedArchivedAt: mismatch.expectedArchivedAt,
      }), 'P1871', mismatch.label)
    }
    const [after] = await sql<{ revisions: number; entries: number }[]>`
      select
        (select count(*)::int from verification_goal_registry_revisions
          where project_id = ${ids.project}::uuid) as revisions,
        (select count(*)::int from verification_goal_registry_entries
          where project_id = ${ids.project}::uuid) as entries
    `
    expect(after).toEqual(before)
  })

  it('rejects routine payload and authority attacks with stable SQLSTATEs', async () => {
    const authority = await loadProjectAuthority()
    expect(authority).not.toBeNull()

    await expectSqlState(callCommitRoutine({
      entries: [{ unexpected: true }],
    }), '22023')
    await expectSqlState(callCommitRoutine({
      manifestDigest: '0'.repeat(64),
    }), '22023')
    await expectSqlState(callCommitRoutine({
      entries: [{
        snapshotId: randomUUID(),
        goalId: 'missing-snapshot',
        definitionVersion: 1,
        definitionDigest: '1'.repeat(64),
        sourcePath: '.forge/verification-goals/missing-snapshot.json',
      }],
    }), '22023')
    await expectSqlState(callCommitRoutine({
      authority: {
        ...authority!,
        rootBindingRevision: authority!.rootBindingRevision + BigInt(1),
      },
    }), 'P1871')
    await expectSqlState(callCommitRoutine({
      expectedPriorRevisionId: randomUUID(),
    }), 'P1872')

    await expectSqlState(adminSql`
      select *
      from public.forge_commit_verification_goal_registry_revision_v1(
        ${authority!.id}::uuid,
        ${ids.user}::uuid,
        ${authority!.priorHeadRevisionId}::uuid,
        ${authority!.submittedBy}::uuid,
        ${authority!.archivedAt}::timestamptz,
        ${authority!.localPath}::text,
        ${authority!.rootRef}::uuid,
        ${authority!.rootBindingRevision.toString()}::bigint,
        ${authority!.grantDecisionRevision.toString()}::bigint,
        ${authority!.updatedAt}::timestamptz,
        ${verificationGoalRegistryManifest([]).digest}::text,
        ${JSON.stringify([])}::jsonb
      )
    `, '42501')
  })

  it('pins the protected routine to pg_catalog when public contains a shadow helper', async () => {
    const existing = await adminSql<{ count: number }[]>`
      select count(*)::int as count
      from pg_catalog.pg_proc procedure
      where procedure.pronamespace = 'public'::pg_catalog.regnamespace
        and procedure.proname = 'sha256'
        and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = 'bytea'
    `
    expect(existing).toEqual([{ count: 0 }])
    try {
      await adminSql.unsafe(`
        create function public.sha256(value bytea) returns bytea
        language plpgsql as $shadow$
        begin
          raise exception 'public shadow sha256 was invoked';
        end;
        $shadow$
      `)
      await expect(callCommitRoutine()).resolves.toHaveLength(1)
    } finally {
      await adminSql.unsafe('drop function if exists public.sha256(bytea)')
    }
  })

  it('allows ordinary Forge code to read protected history but construct it only through the routine', async () => {
    const privileges = await sql<{
      tableName: string
      canSelect: boolean
      canInsert: boolean
      canUpdate: boolean
      canDelete: boolean
      canTruncate: boolean
      canReferences: boolean
      canTrigger: boolean
    }[]>`
      select
        table_name as "tableName",
        has_table_privilege(current_user, 'public.' || table_name, 'SELECT') as "canSelect",
        has_table_privilege(current_user, 'public.' || table_name, 'INSERT') as "canInsert",
        has_table_privilege(current_user, 'public.' || table_name, 'UPDATE') as "canUpdate",
        has_table_privilege(current_user, 'public.' || table_name, 'DELETE') as "canDelete",
        has_table_privilege(current_user, 'public.' || table_name, 'TRUNCATE') as "canTruncate",
        has_table_privilege(current_user, 'public.' || table_name, 'REFERENCES') as "canReferences",
        has_table_privilege(current_user, 'public.' || table_name, 'TRIGGER') as "canTrigger"
      from unnest(array[
        'verification_goal_snapshots',
        'verification_goal_registry_revisions',
        'verification_goal_registry_entries',
        'verification_goal_registry_heads'
      ]::text[]) as table_name
      order by table_name
    `
    expect(privileges).toEqual([
      {
        tableName: 'verification_goal_registry_entries',
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
        canReferences: false,
        canTrigger: false,
      },
      {
        tableName: 'verification_goal_registry_heads',
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
        canReferences: false,
        canTrigger: false,
      },
      {
        tableName: 'verification_goal_registry_revisions',
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
        canReferences: false,
        canTrigger: false,
      },
      {
        tableName: 'verification_goal_snapshots',
        canSelect: true,
        canInsert: true,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
        canReferences: false,
        canTrigger: false,
      },
    ])

    const protectedColumnPrivileges = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.column_privileges privilege
      where privilege.grantee = current_user
        and privilege.table_schema = 'public'
        and privilege.table_name = any(array[
          'verification_goal_registry_revisions',
          'verification_goal_registry_entries',
          'verification_goal_registry_heads'
        ]::text[])
        and privilege.privilege_type = any(array[
          'INSERT', 'UPDATE', 'REFERENCES'
        ]::text[])
    `
    expect(protectedColumnPrivileges).toEqual([{ count: 0 }])

    const routine = await adminSql<{
      owner: string
      securityDefiner: boolean
      config: string[] | null
      forgeCanExecute: boolean
      publicCanExecute: boolean
    }[]>`
      select
        owner.rolname as owner,
        procedure.prosecdef as "securityDefiner",
        procedure.proconfig as config,
        has_function_privilege(
          'forge', procedure.oid, 'EXECUTE'
        ) as "forgeCanExecute",
        has_function_privilege(
          'public', procedure.oid, 'EXECUTE'
        ) as "publicCanExecute"
      from pg_proc procedure
      join pg_roles owner on owner.oid = procedure.proowner
      where procedure.oid = (
        'public.forge_commit_verification_goal_registry_revision_v1('
        || 'uuid,uuid,uuid,uuid,timestamp with time zone,text,uuid,'
        || 'bigint,bigint,timestamp with time zone,text,jsonb)'
      )::regprocedure
    `
    expect(routine).toEqual([{
      owner: 'forge_s4_routines_owner',
      securityDefiner: true,
      config: ['search_path=pg_catalog'],
      forgeCanExecute: true,
      publicCanExecute: false,
    }])

    const owners = await adminSql<{ tableName: string; owner: string }[]>`
      select class.relname as "tableName", owner.rolname as owner
      from pg_class class
      join pg_roles owner on owner.oid = class.relowner
      where class.relname = any(array[
        'verification_goal_registry_revisions',
        'verification_goal_registry_entries',
        'verification_goal_registry_heads'
      ]::text[])
      order by class.relname
    `
    expect(owners).toEqual([
      { tableName: 'verification_goal_registry_entries', owner: 'forge_s4_routines_owner' },
      { tableName: 'verification_goal_registry_heads', owner: 'forge_s4_routines_owner' },
      { tableName: 'verification_goal_registry_revisions', owner: 'forge_s4_routines_owner' },
    ])

    const ownerReferencePrivileges = await adminSql<{ tableName: string; canReference: boolean }[]>`
      select table_name as "tableName",
        has_table_privilege(
          'forge_s4_routines_owner', 'public.' || table_name, 'REFERENCES'
        ) as "canReference"
      from unnest(array[
        'projects', 'users', 'verification_goal_snapshots'
      ]::text[]) table_name
      order by table_name
    `
    expect(ownerReferencePrivileges).toEqual([
      { tableName: 'projects', canReference: false },
      { tableName: 'users', canReference: false },
      { tableName: 'verification_goal_snapshots', canReference: false },
    ])

    await expectSqlState(sql`
      update verification_goal_snapshots set source_path = source_path
      where project_id = ${ids.project}::uuid
    `, '42501')
    await expectSqlState(sql`
      update verification_goal_registry_revisions set manifest_digest = manifest_digest
      where project_id = ${ids.project}::uuid
    `, '42501')
    await expectSqlState(sql`
      update verification_goal_registry_entries set source_path = source_path
      where project_id = ${ids.project}::uuid
    `, '42501')
    await expectSqlState(sql`
      update verification_goal_registry_heads set updated_at = updated_at
      where project_id = ${ids.project}::uuid
    `, '42501')
    await expectSqlState(sql`
      insert into verification_goal_registry_revisions (project_id)
      values (${ids.project}::uuid)
    `, '42501')
    await expectSqlState(sql`
      insert into verification_goal_registry_entries (project_id)
      values (${ids.project}::uuid)
    `, '42501')
    await expectSqlState(sql`
      insert into verification_goal_registry_heads (project_id)
      values (${ids.project}::uuid)
    `, '42501')
    await expectSqlState(sql`
      delete from verification_goal_registry_revisions
      where project_id = ${ids.project}::uuid
    `, '42501')
    await expectSqlState(sql`
      delete from verification_goal_registry_entries
      where project_id = ${ids.project}::uuid
    `, '42501')
    await expectSqlState(sql`
      truncate table verification_goal_registry_revisions
    `, '42501')
    await expectSqlState(adminSql`
      update verification_goal_snapshots set source_path = source_path
      where project_id = ${ids.project}::uuid
    `, 'P0001')
    await expectSqlState(adminSql`
      delete from verification_goal_snapshots where project_id = ${ids.project}::uuid
    `, 'P0001')
    await expectSqlState(adminSql`
      update verification_goal_registry_revisions set manifest_digest = manifest_digest
      where project_id = ${ids.project}::uuid
    `, 'P1873')
    await expectSqlState(adminSql`
      delete from verification_goal_registry_entries where project_id = ${ids.project}::uuid
    `, 'P1873')

    const [head] = await sql<{ revisionId: string; sequence: string }[]>`
      select registry_revision_id::text as "revisionId", revision_sequence::text as sequence
      from verification_goal_registry_heads where project_id = ${ids.project}::uuid
    `
    const [oldest] = await sql<{ revisionId: string; sequence: string }[]>`
      select id::text as "revisionId", revision_sequence::text as sequence
      from verification_goal_registry_revisions
      where project_id = ${ids.project}::uuid
      order by revision_sequence asc limit 1
    `
    expect(BigInt(head!.sequence)).toBeGreaterThan(BigInt(oldest!.sequence))
    await expectSqlState(adminSql`
      update verification_goal_registry_heads
      set revision_sequence = revision_sequence + 2
      where project_id = ${ids.project}::uuid
    `, '42501')
    await expectSqlState(adminSql`
      insert into verification_goal_registry_entries (
        registry_revision_id, project_id, ordinal, snapshot_id, goal_id,
        definition_version, definition_digest, source_path
      )
      select registry_revision_id, project_id, 10000, snapshot_id, goal_id,
        definition_version, definition_digest, source_path
      from verification_goal_registry_entries
      where project_id = ${ids.project}::uuid
      limit 1
    `, '42501')
    await expectSqlState(sql`
      delete from verification_goal_registry_heads where project_id = ${ids.project}::uuid
    `, '42501')
    await expectSqlState(adminSql`
      delete from verification_goal_registry_heads where project_id = ${ids.project}::uuid
    `, 'P1873')
  })
})
