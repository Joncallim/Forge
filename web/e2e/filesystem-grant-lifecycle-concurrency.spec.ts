import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { db } from '../db'
import { projects } from '../db/schema'
import {
  convergeRecognizedOperatorHoldTask,
  filesystemMcpConfigAfterRootRepoint,
  mutateTaskFilesystemGrants,
  reconcileFilesystemGrantsForProject,
} from '../lib/mcps/filesystem-grant-reconciliation'

const RUN = process.env.RUN_FORGE_POSTGRES_TESTS === '1'
test.skip(!RUN, 'Set RUN_FORGE_POSTGRES_TESTS=1 against a migrated disposable PostgreSQL database.')

function sqlClient() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  return postgres(url, { max: 1 })
}

async function seed(input: { siblingStatus?: string; taskStatus?: string } = {}) {
  const sql = sqlClient()
  const userId = randomUUID()
  const projectId = randomUUID()
  const taskId = randomUUID()
  const [lowerPackageId, targetPackageId] = [randomUUID(), randomUUID()].sort()
  try {
    await sql`insert into users (id, display_name) values (${userId}, 'S3 test operator')`
    await sql`
      insert into projects (id, name, submitted_by, grant_decision_revision, root_binding_revision)
      values (${projectId}, 'S3 race fixture', ${userId}, 0, 1)
    `
    await sql`
      insert into tasks (id, project_id, submitted_by, title, prompt, status)
      values (${taskId}, ${projectId}, ${userId}, 'S3 task', 'test', ${input.taskStatus ?? 'approved'})
    `
    const requirements = [{
      mcpId: 'filesystem',
      agent: 'backend',
      requirement: 'required',
      capabilities: ['filesystem.project.read'],
      fallback: { action: 'block', message: '' },
    }]
    const siblingMetadata = input.siblingStatus === 'running' ? {
      executionLease: {
        acquiredAt: new Date().toISOString(),
        attemptNumber: 1,
        heartbeatAt: new Date().toISOString(),
        runId: randomUUID(),
        source: 'work-package-handoff',
        staleAfterSeconds: 900,
      },
    } : {}
    await sql`
      insert into work_packages (
        id, task_id, assigned_role, title, summary, status, sequence,
        mcp_requirements, metadata
      ) values
        (${lowerPackageId}, ${taskId}, 'backend', 'lower sibling', 'test', ${input.siblingStatus ?? 'pending'}, 1, ${sql.json([])}, ${sql.json(siblingMetadata)}),
        (${targetPackageId}, ${taskId}, 'backend', 'target', 'test', 'ready', 2, ${sql.json(requirements)}, ${sql.json({})})
    `
    const [pointer] = await sql<{
      current_decision_id: string | null
      current_decision_revision: string | null
      pointer_fingerprint: string
      pointer_version: string
    }[]>`
      select current_decision_id, current_decision_revision::text,
             pointer_fingerprint, pointer_version::text
      from filesystem_mcp_current_decision_pointers
      where work_package_id = ${targetPackageId}
    `
    return { lowerPackageId, pointer, projectId, targetPackageId, taskId, userId }
  } finally {
    await sql.end()
  }
}

function expectedPointer(pointer: Awaited<ReturnType<typeof seed>>['pointer']) {
  return {
    currentDecisionId: pointer.current_decision_id,
    currentDecisionRevision: pointer.current_decision_revision,
    pointerFingerprint: pointer.pointer_fingerprint,
    pointerVersion: pointer.pointer_version,
  }
}

test('mcp-admission.real-approval-route: concurrent reapproval has one CAS winner and immutable history', async () => {
  const fixture = await seed()
  const mutation = {
    capabilities: ['filesystem.project.read'],
    decision: 'approved' as const,
    grantMode: 'allow_once' as const,
    reason: 'explicit test intent',
    workPackageId: fixture.targetPackageId,
    expectedPointer: expectedPointer(fixture.pointer),
  }
  const outcomes = await Promise.allSettled([
    mutateTaskFilesystemGrants({
      actorId: fixture.userId,
      mutations: [mutation],
      projectId: fixture.projectId,
      taskId: fixture.taskId,
    }),
    mutateTaskFilesystemGrants({
      actorId: fixture.userId,
      mutations: [mutation],
      projectId: fixture.projectId,
      taskId: fixture.taskId,
    }),
  ])
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)

  const sql = sqlClient()
  try {
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from filesystem_mcp_grant_approvals
      where work_package_id = ${fixture.targetPackageId}
    `
    expect(count).toBe(1)
    const [pointer] = await sql<{
      current_decision_id: string
      current_decision_revision: string
      pointer_fingerprint: string
      pointer_version: string
    }[]>`
      select current_decision_id, current_decision_revision::text,
             pointer_fingerprint, pointer_version::text
      from filesystem_mcp_current_decision_pointers
      where work_package_id = ${fixture.targetPackageId}
    `
    expect(pointer.pointer_version).toBe('1')

    await expect(mutateTaskFilesystemGrants({
      actorId: fixture.userId,
      mutations: [{ ...mutation, expectedPointer: undefined }],
      projectId: fixture.projectId,
      taskId: fixture.taskId,
    })).rejects.toThrow(/explicit intent/)

    await mutateTaskFilesystemGrants({
      actorId: fixture.userId,
      mutations: [{ ...mutation, expectedPointer: expectedPointer(pointer) }],
      projectId: fixture.projectId,
      taskId: fixture.taskId,
    })
    const decisions = await sql<{ grant_nonce: string; grant_decision_revision: string }[]>`
      select grant_nonce::text, grant_decision_revision::text
      from filesystem_mcp_grant_approvals
      where work_package_id = ${fixture.targetPackageId}
      order by grant_decision_revision
    `
    expect(decisions.map((decision) => decision.grant_decision_revision)).toEqual(['1', '2'])
    expect(new Set(decisions.map((decision) => decision.grant_nonce)).size).toBe(2)

    await expect(sql`
      update filesystem_mcp_grant_approvals set reason = 'mutated'
      where work_package_id = ${fixture.targetPackageId}
    `).rejects.toMatchObject({ code: '55000' })
  } finally {
    await sql.end()
  }
})

test('mcp-admission.grant-reconciliation: operator hold preserves a running task until lease and review barriers clear', async () => {
  const fixture = await seed({ siblingStatus: 'running', taskStatus: 'running' })
  await mutateTaskFilesystemGrants({
    actorId: fixture.userId,
    mutations: [{
      capabilities: [],
      decision: 'denied',
      grantMode: 'allow_once',
      reason: 'deny required context',
      workPackageId: fixture.targetPackageId,
      expectedPointer: expectedPointer(fixture.pointer),
    }],
    projectId: fixture.projectId,
    taskId: fixture.taskId,
  })
  const sql = sqlClient()
  try {
    let [taskRow] = await sql<{ status: string }[]>`select status from tasks where id = ${fixture.taskId}`
    expect(taskRow.status).toBe('running')
    const [held] = await sql<{ marker: Record<string, unknown>; status: string }[]>`
      select metadata->'mcpGrantBlock' as marker, status
      from work_packages where id = ${fixture.targetPackageId}
    `
    expect(held.status).toBe('blocked')
    expect(held.marker).toMatchObject({
      schemaVersion: 2,
      holdKind: 'denied_required',
      taskDisposition: 'operator_hold',
      terminalFailure: false,
      autoRetryable: false,
    })

    await sql`
      update work_packages set status = 'awaiting_review', metadata = metadata - 'executionLease'
      where id = ${fixture.lowerPackageId}
    `
    await expect(convergeRecognizedOperatorHoldTask(fixture.taskId)).resolves.toBe(false)
    await sql`update work_packages set status = 'completed' where id = ${fixture.lowerPackageId}`
    await expect(convergeRecognizedOperatorHoldTask(fixture.taskId)).resolves.toBe(true)
    ;[taskRow] = await sql<{ status: string }[]>`select status from tasks where id = ${fixture.taskId}`
    expect(taskRow.status).toBe('approved')
    const [counts] = await sql<{ attempts: number; runs: number }[]>`
      select
        (select count(*)::int from task_attempts where task_id = ${fixture.taskId}) as attempts,
        (select count(*)::int from agent_runs where task_id = ${fixture.taskId}) as runs
    `
    expect(counts).toEqual({ attempts: 0, runs: 0 })
  } finally {
    await sql.end()
  }
})

test('root repoint revokes old-root authority without allocating a grant decision', async () => {
  const fixture = await seed()
  await mutateTaskFilesystemGrants({
    actorId: fixture.userId,
    mutations: [{
      capabilities: ['filesystem.project.read'],
      decision: 'approved',
      grantMode: 'allow_once',
      reason: 'old-root approval',
      workPackageId: fixture.targetPackageId,
      expectedPointer: expectedPointer(fixture.pointer),
    }],
    projectId: fixture.projectId,
    taskId: fixture.taskId,
  })

  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(projects)
      .where(eq(projects.id, fixture.projectId)).for('update')
    const nextRootBindingRevision = locked.rootBindingRevision + BigInt(1)
    const nextMcpConfig = filesystemMcpConfigAfterRootRepoint({
      grantDecisionRevision: locked.grantDecisionRevision,
      mcpConfig: locked.mcpConfig,
      rootBindingRevision: nextRootBindingRevision,
    })
    const [updated] = await tx.update(projects).set({
      mcpConfig: nextMcpConfig,
      rootBindingRevision: nextRootBindingRevision,
      updatedAt: new Date(),
    }).where(and(
      eq(projects.id, locked.id),
      eq(projects.rootBindingRevision, locked.rootBindingRevision),
    )).returning()
    await reconcileFilesystemGrantsForProject(tx, {
      actorId: fixture.userId,
      grantDecisionRevision: updated.grantDecisionRevision.toString(),
      lockedProject: updated,
      nextMcpConfig,
      trigger: 'project_root_repoint',
    })
  })

  const sql = sqlClient()
  try {
    const [project] = await sql<{
      grant_decision_revision: string
      root_binding_revision: string
    }[]>`
      select grant_decision_revision::text, root_binding_revision::text
      from projects where id = ${fixture.projectId}
    `
    expect(project).toEqual({ grant_decision_revision: '1', root_binding_revision: '2' })
    const [held] = await sql<{ marker: Record<string, unknown>; status: string }[]>`
      select metadata->'mcpGrantBlock' as marker, status
      from work_packages where id = ${fixture.targetPackageId}
    `
    expect(held.status).toBe('blocked')
    expect(held.marker).toMatchObject({
      grantDecisionRevision: '1',
      holdKind: 'revoked_required',
      revocationReason: 'project_root_repoint',
    })
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from filesystem_mcp_grant_approvals
      where project_id = ${fixture.projectId}
    `
    expect(count).toBe(1)

    const [pointer] = await sql<{
      current_decision_id: string
      current_decision_revision: string
      pointer_fingerprint: string
      pointer_version: string
    }[]>`
      select current_decision_id, current_decision_revision::text,
             pointer_fingerprint, pointer_version::text
      from filesystem_mcp_current_decision_pointers
      where work_package_id = ${fixture.targetPackageId}
    `
    await mutateTaskFilesystemGrants({
      actorId: fixture.userId,
      mutations: [{
        capabilities: ['filesystem.project.read'],
        decision: 'approved',
        grantMode: 'allow_once',
        reason: 'explicit new-root approval',
        workPackageId: fixture.targetPackageId,
        expectedPointer: expectedPointer(pointer),
      }],
      projectId: fixture.projectId,
      taskId: fixture.taskId,
    })
    const [recovered] = await sql<{ marker: unknown; status: string }[]>`
      select metadata->'mcpGrantBlock' as marker, status
      from work_packages where id = ${fixture.targetPackageId}
    `
    expect(recovered).toEqual({ marker: null, status: 'ready' })
  } finally {
    await sql.end()
  }
})

test('the database rejects an invalid version-2 hold tuple', async () => {
  const fixture = await seed()
  const sql = sqlClient()
  try {
    await expect(sql`
      update work_packages
      set metadata = jsonb_set(metadata, '{mcpGrantBlock}', ${sql.json({
        schemaVersion: 2,
        kind: 'filesystem_grant',
        source: 'filesystem-grant-approval',
        taskDisposition: 'operator_hold',
        autoRetryable: false,
        terminalFailure: false,
        requirementKeys: ['req-1'],
        requestedCapabilities: ['filesystem.project.read'],
        recoveryAction: 'approve_project_filesystem_context',
        blockFingerprint: `sha256:${'0'.repeat(64)}`,
        blockedAt: new Date().toISOString(),
        holdKind: 'revoked_required',
        grantPhase: 'revoked',
        grantConsumed: false,
        grantDecisionRevision: '1',
        revocationReason: null,
      })}, true)
      where id = ${fixture.targetPackageId}
    `).rejects.toMatchObject({ code: '23514' })
  } finally {
    await sql.end()
  }
})

test('the complete sibling lock waits on the lower ID before reaching the target', async () => {
  const fixture = await seed()
  const blocker = sqlClient()
  const contender = sqlClient()
  const observer = sqlClient()
  try {
    let contention: Promise<{ id: string }[]> | undefined
    await blocker.begin(async (tx) => {
      await tx`set local application_name = 'forge-s3-lower-sibling-blocker'`
      await tx`select id from work_packages where id = ${fixture.lowerPackageId} for update`

      contention = contender.begin(async (other) => {
        await other`set local application_name = 'forge-s3-lock-contender'`
        await other`select id from projects where id = ${fixture.projectId} for update`
        await other`select id from tasks where id = ${fixture.taskId} for update`
        return other<{ id: string }[]>`
          select id from work_packages
          where task_id = ${fixture.taskId}
          order by id
          for update
        `
      })

      let observed: { blockers: number[]; wait_event_type: string | null } | undefined
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await observer<{ blockers: number[]; wait_event_type: string | null }[]>`
          select pg_blocking_pids(pid) as blockers, wait_event_type
          from pg_stat_activity
          where application_name = 'forge-s3-lock-contender'
            and query like '%from work_packages%'
        `
        if (row?.blockers.length) {
          observed = row
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(observed?.wait_event_type).toBe('Lock')
      expect(observed?.blockers.length).toBeGreaterThan(0)

      // Returning commits the blocker. The contender can then acquire P1 and
      // only after that proceed to P2.
    })
    const rows = await contention!
    expect(rows.map((row) => row.id)).toEqual([
      fixture.lowerPackageId,
      fixture.targetPackageId,
    ])
  } finally {
    await Promise.all([blocker.end(), contender.end(), observer.end()])
  }
})
