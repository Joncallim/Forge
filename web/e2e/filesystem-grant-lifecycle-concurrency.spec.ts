import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { db } from '../db'
import { projects } from '../db/schema'
import { handoffApprovedWorkPackages } from '../worker/work-package-handoff'
import {
  convergeRecognizedOperatorHoldTask,
  filesystemMcpConfigAfterRootRepoint,
  loadCurrentProjectFilesystemDecision,
  mutateProjectFilesystemGrant,
  mutateTaskFilesystemGrants,
  reconcileFilesystemGrantsForProject,
} from '../lib/mcps/filesystem-grant-reconciliation'
import { requiresFilesystemGrantApproval } from '../lib/mcps/filesystem-grants'
import {
  buildFilesystemGrantBlockMetadata,
  canonicalPositiveDecisionRevision,
} from '../lib/mcps/filesystem-grant-lifecycle'
import {
  canonicalS3Marker,
  INVALID_S3_MARKERS,
  VALID_S3_HOLD_STATES,
} from '../test-support/filesystem-grant-marker-fixtures'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'
import { installSessionCookie, seedSession } from './helpers'

const RUN = process.env.RUN_FORGE_POSTGRES_TESTS === '1'
test.skip(!RUN, 'Set RUN_FORGE_POSTGRES_TESTS=1 against a migrated disposable PostgreSQL database.')
test.beforeEach(async ({}, testInfo) => {
  applyEpic172Step0E2EBridge(testInfo, 'filesystem-grant-lifecycle-concurrency.spec.ts')
})

function sqlClient() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  return postgres(url, { max: 1 })
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function seed(input: {
  siblingRequiresFilesystem?: boolean
  siblingStatus?: string
  taskStatus?: string
  userId?: string
} = {}) {
  const sql = sqlClient()
  const userId = input.userId ?? randomUUID()
  const projectId = randomUUID()
  const taskId = randomUUID()
  const [lowerPackageId, targetPackageId] = [randomUUID(), randomUUID()].sort()
  try {
    if (!input.userId) {
      await sql`insert into users (id, display_name) values (${userId}, 'S3 test operator')`
    }
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
        (${lowerPackageId}, ${taskId}, 'backend', 'lower sibling', 'test', ${input.siblingStatus ?? 'pending'}, 1, ${sql.json(input.siblingRequiresFilesystem ? requirements : [])}, ${sql.json(siblingMetadata)}),
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

test('mcp-admission.real-approval-route: authenticated route stays fail-closed and service CAS preserves immutable history', {
  tag: '@mcp-postgres',
  annotation: { type: 'scenarioId', description: 'mcp-admission.real-approval-route' },
}, async ({ context, page }) => {
  const session = await seedSession('S6 authenticated grant-route operator')
  await installSessionCookie(context, session)
  const fixture = await seed({ userId: session.userId })
  const mutation = {
    capabilities: ['filesystem.project.read'],
    decision: 'approved' as const,
    grantMode: 'allow_once' as const,
    reason: 'explicit test intent',
    workPackageId: fixture.targetPackageId,
    expectedPointer: expectedPointer(fixture.pointer),
  }

  const readResponse = await page.request.get(`/api/tasks/${fixture.taskId}/filesystem-grants`)
  expect(readResponse.status()).toBe(200)
  await expect(readResponse.json()).resolves.toMatchObject({
    schemaVersion: 2,
    grants: [expect.objectContaining({ workPackageId: fixture.targetPackageId })],
  })

  const guardedMutationResponse = await page.request.put(
    `/api/tasks/${fixture.taskId}/filesystem-grants`,
    { data: { schemaVersion: 2, grants: [mutation] } },
  )
  expect(guardedMutationResponse.status()).toBe(503)
  await expect(guardedMutationResponse.json()).resolves.toMatchObject({
    code: 'epic_172_project_management_ingress_closed',
  })

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

    const [current] = await sql<{
      current_decision_fingerprint: string
      current_decision_id: string
      current_decision_revision: string
      current_decision_task_id: string
      current_decision_work_package_id: string
      pointer_version: string
    }[]>`
      select current_decision_id, current_decision_task_id, current_decision_work_package_id,
             current_decision_revision::text, current_decision_fingerprint,
             pointer_version::text
      from filesystem_mcp_current_decision_pointers
      where work_package_id = ${fixture.targetPackageId}
    `
    expect(current).toMatchObject({
      current_decision_task_id: fixture.taskId,
      current_decision_work_package_id: fixture.targetPackageId,
      current_decision_revision: '2',
      pointer_version: '2',
    })
    await expect(sql`
      update filesystem_mcp_current_decision_pointers
      set current_decision_revision = current_decision_revision + 1
      where work_package_id = ${fixture.targetPackageId}
    `).rejects.toMatchObject({ code: '23503' })
    await expect(sql`
      update filesystem_mcp_current_decision_pointers
      set current_decision_fingerprint = ${`sha256:${'f'.repeat(64)}`},
          pointer_fingerprint = ${`sha256:${'f'.repeat(64)}`}
      where work_package_id = ${fixture.targetPackageId}
    `).rejects.toMatchObject({ code: '23503' })
    await expect(sql`
      update filesystem_mcp_current_decision_pointers
      set current_decision_id = ${randomUUID()}
      where work_package_id = ${fixture.targetPackageId}
    `).rejects.toMatchObject({ code: '23503' })
    await expect(sql`
      update filesystem_mcp_current_decision_pointers
      set current_decision_id = ${current.current_decision_id},
          current_decision_task_id = ${current.current_decision_task_id},
          current_decision_work_package_id = ${current.current_decision_work_package_id},
          current_decision_revision = ${current.current_decision_revision},
          current_decision_fingerprint = ${current.current_decision_fingerprint},
          pointer_fingerprint = ${current.current_decision_fingerprint},
          pointer_version = 1
      where work_package_id = ${fixture.lowerPackageId}
    `).rejects.toMatchObject({ code: '23514' })

    await expect(sql`
      update filesystem_mcp_grant_approvals set reason = 'mutated'
      where work_package_id = ${fixture.targetPackageId}
    `).rejects.toMatchObject({ code: '55000' })
  } finally {
    await sql.end()
  }
})

test('mcp-admission.grant-reconciliation: operator hold preserves a running task until lease and review barriers clear', {
  tag: '@mcp-postgres',
  annotation: { type: 'scenarioId', description: 'mcp-admission.grant-reconciliation' },
}, async () => {
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
    await expect(convergeRecognizedOperatorHoldTask(fixture.taskId)).resolves.toBe(false)

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

test('expired execution leases allow convergence while malformed leases fail closed', async () => {
  const expired = await seed({ siblingStatus: 'running', taskStatus: 'running' })
  const malformed = await seed({ siblingStatus: 'running', taskStatus: 'running' })
  for (const fixture of [expired, malformed]) {
    await mutateTaskFilesystemGrants({
      actorId: fixture.userId,
      mutations: [{
        capabilities: [],
        decision: 'denied',
        grantMode: 'allow_once',
        reason: 'create operator hold',
        workPackageId: fixture.targetPackageId,
        expectedPointer: expectedPointer(fixture.pointer),
      }],
      projectId: fixture.projectId,
      taskId: fixture.taskId,
    })
  }
  const sql = sqlClient()
  try {
    await sql`
      update work_packages
      set metadata = jsonb_set(metadata, '{executionLease}', ${sql.json({
        acquiredAt: '2026-01-01T00:00:00.000Z',
        attemptNumber: 1,
        heartbeatAt: '2026-01-01T00:00:00.000Z',
        runId: randomUUID(),
        source: 'work-package-handoff',
        staleAfterSeconds: 1,
      })}, true)
      where id = ${expired.lowerPackageId}
    `
    await expect(convergeRecognizedOperatorHoldTask(expired.taskId)).resolves.toBe(true)

    await sql`
      update work_packages
      set metadata = jsonb_set(metadata, '{executionLease,heartbeatAt}', '"not-a-time"'::jsonb, false)
      where id = ${malformed.lowerPackageId}
    `
    await expect(convergeRecognizedOperatorHoldTask(malformed.taskId)).resolves.toBe(false)
    const [malformedTask] = await sql<{ status: string }[]>`
      select status from tasks where id = ${malformed.taskId}
    `
    expect(malformedTask.status).toBe('running')
  } finally {
    await sql.end()
  }
})

test('simultaneous disjoint task always-allow decisions serialize and preserve their capability union', async () => {
  const fixture = await seed()
  const sql = sqlClient()
  const requirement = (capabilities: string[]) => [{
    mcpId: 'filesystem',
    agent: 'backend',
    requirement: 'required',
    capabilities,
    fallback: { action: 'block', message: '' },
  }]
  try {
    await sql`
      update projects
      set mcp_config = ${sql.json({ profile: 'strict', unrelated: { keep: true } })}
      where id = ${fixture.projectId}
    `
    await sql`
      update work_packages
      set mcp_requirements = case id
        when ${fixture.lowerPackageId} then ${sql.json(requirement(['filesystem.project.read', 'filesystem.project.list']))}
        else ${sql.json(requirement(['filesystem.project.read', 'filesystem.project.search']))}
      end
      where id in (${fixture.lowerPackageId}, ${fixture.targetPackageId})
    `

    const outcomes = await Promise.all([
      mutateTaskFilesystemGrants({
        actorId: fixture.userId,
        mutations: [{
          capabilities: ['filesystem.project.read', 'filesystem.project.list'],
          decision: 'approved',
          grantMode: 'always_allow',
          reason: 'list-capability approval',
          workPackageId: fixture.lowerPackageId,
        }],
        projectId: fixture.projectId,
        taskId: fixture.taskId,
      }),
      mutateTaskFilesystemGrants({
        actorId: fixture.userId,
        mutations: [{
          capabilities: ['filesystem.project.read', 'filesystem.project.search'],
          decision: 'approved',
          grantMode: 'always_allow',
          reason: 'search-capability approval',
          workPackageId: fixture.targetPackageId,
        }],
        projectId: fixture.projectId,
        taskId: fixture.taskId,
      }),
    ])
    expect(outcomes).toHaveLength(2)

    const authority = await loadCurrentProjectFilesystemDecision(fixture.projectId)
    expect(authority).toMatchObject({
      capabilities: [
        'filesystem.project.list',
        'filesystem.project.read',
        'filesystem.project.search',
      ],
      decision: 'approved',
      grantDecisionRevision: '2',
      decisionGeneration: '2',
    })
    const decisions = await sql<{ capabilities: string[]; grant_decision_revision: string }[]>`
      select capabilities, grant_decision_revision::text
      from project_filesystem_grant_decisions
      where project_id = ${fixture.projectId}
      order by grant_decision_revision
    `
    expect(decisions.map((decision) => decision.grant_decision_revision)).toEqual(['1', '2'])
    expect(decisions[1].capabilities).toEqual([
      'filesystem.project.list',
      'filesystem.project.read',
      'filesystem.project.search',
    ])
    const [project] = await sql<{ mcp_config: Record<string, unknown> }[]>`
      select mcp_config from projects where id = ${fixture.projectId}
    `
    expect(project.mcp_config).toMatchObject({ profile: 'strict', unrelated: { keep: true } })
  } finally {
    await sql.end()
  }
})

test('task and project always-allow mutations converge through the same immutable project authority', async () => {
  const fixture = await seed()
  const sql = sqlClient()
  try {
    await sql`
      update work_packages
      set mcp_requirements = ${sql.json([{
        mcpId: 'filesystem',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        fallback: { action: 'block', message: '' },
      }])}
      where id = ${fixture.lowerPackageId}
    `
    await mutateTaskFilesystemGrants({
      actorId: fixture.userId,
      mutations: [{
        capabilities: ['filesystem.project.read'],
        decision: 'approved',
        grantMode: 'always_allow',
        reason: 'task endpoint equivalent',
        workPackageId: fixture.targetPackageId,
      }],
      projectId: fixture.projectId,
      taskId: fixture.taskId,
    })
    let packageRows = await sql<{ id: string; status: string }[]>`
      select id, status from work_packages
      where id in (${fixture.lowerPackageId}, ${fixture.targetPackageId})
      order by id
    `
    expect(packageRows.find((pkg) => pkg.id === fixture.lowerPackageId)?.status).toBe('blocked')
    expect(packageRows.find((pkg) => pkg.id === fixture.targetPackageId)?.status).toBe('ready')

    await mutateProjectFilesystemGrant({
      actorId: fixture.userId,
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      enabled: true,
      projectId: fixture.projectId,
      reason: 'project endpoint equivalent',
    })
    packageRows = await sql<{ id: string; status: string }[]>`
      select id, status from work_packages
      where id in (${fixture.lowerPackageId}, ${fixture.targetPackageId})
      order by id
    `
    expect(packageRows.map((pkg) => pkg.status)).toEqual(['ready', 'ready'])
    const authority = await loadCurrentProjectFilesystemDecision(fixture.projectId)
    expect(authority).toMatchObject({
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      decision: 'approved',
      grantDecisionRevision: '2',
    })
  } finally {
    await sql.end()
  }
})

test('a newer covering project decision recovers a consumed package-local approval', async () => {
  const fixture = await seed()
  await mutateTaskFilesystemGrants({
    actorId: fixture.userId,
    mutations: [{
      capabilities: ['filesystem.project.read'],
      decision: 'approved',
      grantMode: 'allow_once',
      reason: 'single-use package approval',
      workPackageId: fixture.targetPackageId,
      expectedPointer: expectedPointer(fixture.pointer),
    }],
    projectId: fixture.projectId,
    taskId: fixture.taskId,
  })
  const marker = buildFilesystemGrantBlockMetadata({
    blockedAt: new Date('2026-07-17T00:00:00.000Z'),
    hold: {
      holdKind: 'consumed_once',
      grantPhase: 'approved',
      grantConsumed: true,
      grantDecisionRevision: canonicalPositiveDecisionRevision('1')!,
      revocationReason: null,
    },
    requirementKeys: ['filesystem:backend:required'],
    requestedCapabilities: ['filesystem.project.read'],
    rootBindingRevision: '1',
  })
  const sql = sqlClient()
  try {
    await sql`
      update work_packages
      set status = 'blocked',
          metadata = jsonb_set(
            jsonb_set(
              jsonb_set(metadata, '{mcpGrantPhases,effective,status}', '"consumed"'::jsonb, false),
              '{mcpGrantPhases,effective,runtimeIssued}', 'true'::jsonb, false
            ),
            '{mcpGrantBlock}', ${sql.json(marker)}, true
          )
      where id = ${fixture.targetPackageId}
    `
    await mutateProjectFilesystemGrant({
      actorId: fixture.userId,
      capabilities: ['filesystem.project.read'],
      enabled: true,
      projectId: fixture.projectId,
      reason: 'project recovery authority',
    })
    const [recovered] = await sql<{ marker: unknown; status: string }[]>`
      select metadata->'mcpGrantBlock' as marker, status
      from work_packages where id = ${fixture.targetPackageId}
    `
    expect(recovered).toEqual({ marker: null, status: 'ready' })
    const [pkg] = await sql<{ mcp_requirements: unknown; metadata: unknown }[]>`
      select mcp_requirements, metadata from work_packages where id = ${fixture.targetPackageId}
    `
    const authority = await loadCurrentProjectFilesystemDecision(fixture.projectId)
    expect(requiresFilesystemGrantApproval({
      mcpRequirements: pkg.mcp_requirements,
      metadata: pkg.metadata,
      projectFilesystemDecision: authority,
      projectRootBindingRevision: '1',
    }).blocked).toBe(false)
  } finally {
    await sql.end()
  }
})

test('config-only legacy project grants fail closed without an immutable current decision', async () => {
  const fixture = await seed()
  const sql = sqlClient()
  try {
    const compatibilityGrant = {
      schemaVersion: 2,
      mcpId: 'filesystem',
      status: 'approved',
      grantMode: 'always_allow',
      capabilities: ['filesystem.project.read'],
      grantApprovalId: randomUUID(),
      grantDecisionRevision: '1',
      rootBindingRevision: '1',
    }
    await sql`
      update projects set mcp_config = ${sql.json({ grants: { filesystem: compatibilityGrant } })}
      where id = ${fixture.projectId}
    `
    expect(await loadCurrentProjectFilesystemDecision(fixture.projectId)).toBeNull()
    expect(requiresFilesystemGrantApproval({
      mcpRequirements: [{
        mcpId: 'filesystem',
        requirement: 'required',
        capabilities: ['filesystem.project.read'],
      }],
      metadata: {},
      projectMcpConfig: { grants: { filesystem: compatibilityGrant } },
      projectFilesystemDecision: null,
      projectRootBindingRevision: '1',
    })).toMatchObject({ blocked: true })
  } finally {
    await sql.end()
  }
})

test('narrowing and removal append retained decisions and negatively reconcile future authority', async () => {
  const fixture = await seed()
  const sql = sqlClient()
  try {
    await sql`
      update work_packages
      set status = 'ready', mcp_requirements = ${sql.json([{
        mcpId: 'filesystem',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['filesystem.project.read'],
        fallback: { action: 'block', message: '' },
      }])}
      where id = ${fixture.lowerPackageId}
    `
    await sql`
      update work_packages
      set mcp_requirements = ${sql.json([{
        mcpId: 'filesystem',
        agent: 'backend',
        requirement: 'required',
        capabilities: ['filesystem.project.read', 'filesystem.project.search'],
        fallback: { action: 'block', message: '' },
      }])}
      where id = ${fixture.targetPackageId}
    `
    await mutateProjectFilesystemGrant({
      actorId: fixture.userId,
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      enabled: true,
      projectId: fixture.projectId,
      reason: 'broad project approval',
    })
    await mutateProjectFilesystemGrant({
      actorId: fixture.userId,
      capabilities: ['filesystem.project.read'],
      enabled: true,
      projectId: fixture.projectId,
      reason: 'narrow project approval',
    })
    let rows = await sql<{ id: string; marker: Record<string, unknown> | null; status: string }[]>`
      select id, status, metadata->'mcpGrantBlock' as marker
      from work_packages where id in (${fixture.lowerPackageId}, ${fixture.targetPackageId})
      order by id
    `
    expect(rows.find((pkg) => pkg.id === fixture.lowerPackageId)?.status).toBe('ready')
    expect(rows.find((pkg) => pkg.id === fixture.targetPackageId)).toMatchObject({
      status: 'blocked',
      marker: { revocationReason: 'project_grant_narrowed' },
    })

    await mutateProjectFilesystemGrant({
      actorId: fixture.userId,
      capabilities: [],
      enabled: false,
      projectId: fixture.projectId,
      reason: 'remove project approval',
    })
    rows = await sql<{ id: string; marker: Record<string, unknown> | null; status: string }[]>`
      select id, status, metadata->'mcpGrantBlock' as marker
      from work_packages where id in (${fixture.lowerPackageId}, ${fixture.targetPackageId})
      order by id
    `
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'blocked', marker: expect.objectContaining({ revocationReason: 'project_grant_removed' }) }),
      expect.objectContaining({ status: 'blocked', marker: expect.objectContaining({ revocationReason: 'project_grant_removed' }) }),
    ]))
    const decisions = await sql<{
      decision: string
      grant_decision_revision: string
      revocation_reason: string | null
    }[]>`
      select decision, grant_decision_revision::text, revocation_reason
      from project_filesystem_grant_decisions
      where project_id = ${fixture.projectId}
      order by grant_decision_revision
    `
    expect(decisions).toEqual([
      { decision: 'approved', grant_decision_revision: '1', revocation_reason: null },
      { decision: 'approved', grant_decision_revision: '2', revocation_reason: 'project_grant_narrowed' },
      { decision: 'revoked', grant_decision_revision: '3', revocation_reason: 'project_grant_removed' },
    ])
  } finally {
    await sql.end()
  }
})

test('project pointer retains an exact S4 parent, rejects mismatches, and rolls back a stale CAS append', async () => {
  const fixture = await seed()
  const other = await seed()
  const sql = sqlClient()
  try {
    await mutateProjectFilesystemGrant({
      actorId: fixture.userId,
      capabilities: ['filesystem.project.read'],
      enabled: true,
      projectId: fixture.projectId,
      reason: 'initial project approval',
    })
    const [first] = await sql<{
      current_decision_fingerprint: string
      current_decision_generation: string
      current_decision_id: string
      current_decision_project_id: string
      current_decision_revision: string
      current_root_binding_revision: string
      pointer_generation: string
    }[]>`
      select current_decision_id, current_decision_project_id,
             current_decision_revision::text, current_root_binding_revision::text,
             current_decision_fingerprint, current_decision_generation::text,
             pointer_generation::text
      from project_filesystem_current_decision_pointers
      where project_id = ${fixture.projectId}
    `
    expect(first).toMatchObject({
      current_decision_project_id: fixture.projectId,
      current_decision_revision: '1',
      current_decision_generation: '1',
      pointer_generation: '1',
    })
    const [s4Parent] = await sql<{ id: string }[]>`
      select id from project_filesystem_grant_decisions
      where project_id = ${fixture.projectId} and grant_decision_revision = 1
    `
    expect(s4Parent.id).toBe(first.current_decision_id)

    await expect(sql`
      update project_filesystem_current_decision_pointers
      set current_decision_revision = current_decision_revision + 1
      where project_id = ${fixture.projectId}
    `).rejects.toMatchObject({ code: '23503' })
    await expect(sql`
      update project_filesystem_current_decision_pointers
      set current_decision_fingerprint = ${`sha256:${'f'.repeat(64)}`}
      where project_id = ${fixture.projectId}
    `).rejects.toMatchObject({ code: '23503' })
    await expect(sql`
      update project_filesystem_current_decision_pointers
      set current_root_binding_revision = current_root_binding_revision + 1
      where project_id = ${fixture.projectId}
    `).rejects.toMatchObject({ code: '23503' })
    await expect(sql`
      update project_filesystem_current_decision_pointers
      set current_decision_project_id = ${other.projectId}
      where project_id = ${fixture.projectId}
    `).rejects.toMatchObject({ code: '23514' })
    await expect(sql`
      update project_filesystem_grant_decisions set reason = 'mutated'
      where id = ${first.current_decision_id}
    `).rejects.toMatchObject({ code: '55000' })
    await expect(sql`
      delete from project_filesystem_grant_decisions where id = ${first.current_decision_id}
    `).rejects.toMatchObject({ code: '55000' })

    await mutateProjectFilesystemGrant({
      actorId: fixture.userId,
      capabilities: ['filesystem.project.read', 'filesystem.project.search'],
      enabled: true,
      projectId: fixture.projectId,
      reason: 'advance current project approval',
    })
    const [current] = await sql<{
      current_decision_fingerprint: string
      current_decision_generation: string
      current_decision_id: string
      current_decision_revision: string
      current_root_binding_revision: string
      pointer_generation: string
    }[]>`
      select current_decision_id, current_decision_revision::text,
             current_root_binding_revision::text, current_decision_fingerprint,
             current_decision_generation::text, pointer_generation::text
      from project_filesystem_current_decision_pointers
      where project_id = ${fixture.projectId}
    `
    await expect(sql`
      insert into project_filesystem_grant_decisions (
        project_id, decision, capabilities, grant_decision_revision,
        root_binding_revision, decision_fingerprint, decision_generation,
        prior_decision_id, prior_decision_project_id, prior_decision_revision,
        prior_root_binding_revision, prior_decision_fingerprint, prior_decision_generation,
        revocation_reason, reason, decided_by
      ) values (
        ${fixture.projectId}, 'approved', ${sql.json(['filesystem.project.read'])}, 3,
        ${current.current_root_binding_revision}, ${`sha256:${'d'.repeat(64)}`}, 3,
        ${randomUUID()}, ${fixture.projectId}, ${current.current_decision_revision},
        ${current.current_root_binding_revision}, ${current.current_decision_fingerprint},
        ${current.current_decision_generation}, null, 'nonexistent parent', ${fixture.userId}
      )
    `).rejects.toMatchObject({ code: '23503' })
    await expect(sql`
      insert into project_filesystem_grant_decisions (
        project_id, decision, capabilities, grant_decision_revision,
        root_binding_revision, decision_fingerprint, decision_generation,
        prior_decision_id, prior_decision_project_id, prior_decision_revision,
        prior_root_binding_revision, prior_decision_fingerprint, prior_decision_generation,
        revocation_reason, reason, decided_by
      ) values (
        ${fixture.projectId}, 'approved', ${sql.json(['filesystem.project.read'])}, 3,
        ${first.current_root_binding_revision}, ${`sha256:${'c'.repeat(64)}`}, 2,
        ${first.current_decision_id}, ${fixture.projectId}, ${first.current_decision_revision},
        ${first.current_root_binding_revision}, ${first.current_decision_fingerprint},
        ${first.current_decision_generation}, null, 'fork existing parent', ${fixture.userId}
      )
    `).rejects.toMatchObject({ code: '23505' })
    const candidateId = randomUUID()
    await expect(sql.begin(async (tx) => {
      const candidateRevision = (BigInt(current.current_decision_revision) + BigInt(1)).toString()
      const candidateGeneration = (BigInt(current.current_decision_generation) + BigInt(1)).toString()
      const candidateFingerprint = `sha256:${'e'.repeat(64)}`
      await tx`
        insert into project_filesystem_grant_decisions (
          id, project_id, decision, capabilities, grant_decision_revision,
          root_binding_revision, decision_fingerprint, decision_generation,
          prior_decision_id, prior_decision_project_id, prior_decision_revision, prior_root_binding_revision,
          prior_decision_fingerprint, prior_decision_generation,
          revocation_reason, reason, decided_by
        ) values (
          ${candidateId}, ${fixture.projectId}, 'approved', ${tx.json(['filesystem.project.read'])},
          ${candidateRevision}, ${current.current_root_binding_revision}, ${candidateFingerprint}, ${candidateGeneration},
          ${current.current_decision_id}, ${fixture.projectId}, ${current.current_decision_revision}, ${current.current_root_binding_revision},
          ${current.current_decision_fingerprint}, ${current.current_decision_generation},
          null, 'stale CAS candidate', ${fixture.userId}
        )
      `
      const advanced = await tx<{ id: string }[]>`
        update project_filesystem_current_decision_pointers
        set current_decision_id = ${candidateId},
            current_decision_project_id = ${fixture.projectId},
            current_decision_revision = ${candidateRevision},
            current_root_binding_revision = ${current.current_root_binding_revision},
            current_decision_fingerprint = ${candidateFingerprint},
            current_decision_generation = ${candidateGeneration},
            pointer_generation = ${candidateGeneration}
        where project_id = ${fixture.projectId}
          and current_decision_id = ${first.current_decision_id}
          and current_decision_revision = ${first.current_decision_revision}
          and current_root_binding_revision = ${first.current_root_binding_revision}
          and current_decision_fingerprint = ${first.current_decision_fingerprint}
          and pointer_generation = ${first.pointer_generation}
        returning current_decision_id as id
      `
      if (advanced.length === 0) throw new Error('stale project pointer CAS')
    })).rejects.toThrow('stale project pointer CAS')
    const [{ count: rolledBack }] = await sql<{ count: number }[]>`
      select count(*)::int as count from project_filesystem_grant_decisions
      where id = ${candidateId}
    `
    expect(rolledBack).toBe(0)
    const history = await sql<{ grant_decision_revision: string }[]>`
      select grant_decision_revision::text from project_filesystem_grant_decisions
      where project_id = ${fixture.projectId}
      order by grant_decision_revision
    `
    expect(history.map((decision) => decision.grant_decision_revision)).toEqual(['1', '2'])
  } finally {
    await sql.end()
  }
})

test('root repoint keeps the retained project decision and pointer unchanged while revoking issuance', async () => {
  const fixture = await seed()
  await mutateProjectFilesystemGrant({
    actorId: fixture.userId,
    capabilities: ['filesystem.project.read'],
    enabled: true,
    projectId: fixture.projectId,
    reason: 'old-root project authority',
  })
  const sql = sqlClient()
  try {
    const [before] = await sql<{
      current_decision_id: string
      grant_decision_revision: string
      pointer_generation: string
    }[]>`
      select pointer.current_decision_id, pointer.pointer_generation::text,
             project.grant_decision_revision::text
      from projects project
      join project_filesystem_current_decision_pointers pointer
        on pointer.project_id = project.id
      where project.id = ${fixture.projectId}
    `
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(projects)
        .where(eq(projects.id, fixture.projectId)).for('update')
      const rootBindingRevision = locked.rootBindingRevision + BigInt(1)
      const nextMcpConfig = filesystemMcpConfigAfterRootRepoint({
        grantDecisionRevision: locked.grantDecisionRevision,
        mcpConfig: locked.mcpConfig,
        rootBindingRevision,
      })
      const [updated] = await tx.update(projects).set({
        mcpConfig: nextMcpConfig,
        rootBindingRevision,
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
    const [after] = await sql<{
      current_decision_id: string
      grant_decision_revision: string
      pointer_generation: string
      root_binding_revision: string
    }[]>`
      select pointer.current_decision_id, pointer.pointer_generation::text,
             project.grant_decision_revision::text, project.root_binding_revision::text
      from projects project
      join project_filesystem_current_decision_pointers pointer
        on pointer.project_id = project.id
      where project.id = ${fixture.projectId}
    `
    expect(after).toEqual({
      ...before,
      root_binding_revision: '2',
    })
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from project_filesystem_grant_decisions
      where project_id = ${fixture.projectId}
    `
    expect(count).toBe(1)
    const [held] = await sql<{ marker: Record<string, unknown>; status: string }[]>`
      select metadata->'mcpGrantBlock' as marker, status
      from work_packages where id = ${fixture.targetPackageId}
    `
    expect(held).toMatchObject({
      status: 'blocked',
      marker: {
        grantDecisionRevision: '1',
        holdKind: 'revoked_required',
        revocationReason: 'project_root_repoint',
      },
    })
  } finally {
    await sql.end()
  }
})

test('root repoint retains decision authority and requires explicit approval after every binding change', async () => {
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
    const [{ count: projectDecisionCount }] = await sql<{ count: number }[]>`
      select count(*)::int as count from project_filesystem_grant_decisions
      where project_id = ${fixture.projectId}
    `
    expect(projectDecisionCount).toBe(0)
    const [projectPointer] = await sql<{
      current_decision_id: string | null
      pointer_generation: string
    }[]>`
      select current_decision_id, pointer_generation::text
      from project_filesystem_current_decision_pointers
      where project_id = ${fixture.projectId}
    `
    expect(projectPointer).toEqual({ current_decision_id: null, pointer_generation: '0' })

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
    const [heldAgain] = await sql<{ marker: Record<string, unknown>; status: string }[]>`
      select metadata->'mcpGrantBlock' as marker, status
      from work_packages where id = ${fixture.targetPackageId}
    `
    expect(heldAgain).toMatchObject({
      status: 'blocked',
      marker: {
        grantDecisionRevision: '2',
        holdKind: 'revoked_required',
        revocationReason: 'project_root_repoint',
      },
    })
    const [repointedAgain] = await sql<{
      grant_decision_revision: string
      root_binding_revision: string
    }[]>`
      select grant_decision_revision::text, root_binding_revision::text
      from projects where id = ${fixture.projectId}
    `
    expect(repointedAgain).toEqual({ grant_decision_revision: '2', root_binding_revision: '3' })
  } finally {
    await sql.end()
  }
})

test('the database enforces the same exhaustive strict S3 marker fixtures as TypeScript', async () => {
  const fixture = await seed()
  const sql = sqlClient()
  try {
    for (const hold of VALID_S3_HOLD_STATES) {
      await sql`
        update work_packages
        set status = 'blocked',
            metadata = jsonb_set(metadata, '{mcpGrantBlock}', ${sql.json(canonicalS3Marker(hold) as never)}, true)
        where id = ${fixture.targetPackageId}
      `
    }
    for (const { label, marker } of INVALID_S3_MARKERS) {
      await expect(sql`
        update work_packages
        set status = 'blocked',
            metadata = jsonb_set(metadata, '{mcpGrantBlock}', ${sql.json(marker as never)}, true)
        where id = ${fixture.targetPackageId}
      `, label).rejects.toMatchObject({ code: '23514' })
    }
    await expect(sql`
      update work_packages set status = 'ready'
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

test('S3: mutation vs claim contention from lower sibling', async () => {
  const fixture = await seed({ siblingRequiresFilesystem: false, siblingStatus: 'pending' })
  const sql = sqlClient()
  const observer = sqlClient()
  const previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
  process.env.FORGE_WORK_PACKAGE_EXECUTION = '0'
  let resolveClaimRelease: () => void = () => {}
  let claimReleased = false
  const claimRelease = new Promise<void>((resolve) => { resolveClaimRelease = resolve })
  const releaseClaim = () => {
    if (claimReleased) return
    claimReleased = true
    resolveClaimRelease()
  }
  let claimPromise: ReturnType<typeof handoffApprovedWorkPackages> | undefined
  let mutationPromise: ReturnType<typeof mutateTaskFilesystemGrants> | undefined
  try {
    let signalClaimLocked!: (pid: number) => void
    const claimLocked = new Promise<number>((resolve) => { signalClaimLocked = resolve })
    claimPromise = handoffApprovedWorkPackages(fixture.taskId, {
      claimEnabled: true,
      afterWorkPackageClaimRowsLocked: async ({ backendPid, packageId }) => {
        expect(packageId).toBe(fixture.lowerPackageId)
        signalClaimLocked(backendPid)
        await claimRelease
      },
    })

    const claimPid = await claimLocked
    mutationPromise = mutateTaskFilesystemGrants({
      actorId: fixture.userId,
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      mutations: [{
        workPackageId: fixture.targetPackageId,
        decision: 'approved',
        capabilities: ['filesystem.project.read'],
        grantMode: 'allow_once',
        reason: 'Higher sibling mutation overlapping lower claim',
      }],
    })
    let mutationSettled = false
    void mutationPromise.then(
      () => { mutationSettled = true },
      () => { mutationSettled = true },
    )

    let observed: { blockers: number[]; wait_event_type: string | null } | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await observer<{ blockers: number[]; wait_event_type: string | null }[]>`
        select pg_blocking_pids(pid) as blockers, wait_event_type
        from pg_stat_activity
        where ${claimPid} = any(pg_blocking_pids(pid))
          and wait_event_type = 'Lock'
      `
      if (row) {
        observed = row
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(observed?.blockers).toContain(claimPid)
    expect(observed?.wait_event_type).toBe('Lock')
    expect(mutationSettled).toBe(false)

    releaseClaim()
    const [claim, mutation] = await bounded(
      Promise.all([claimPromise, mutationPromise]),
      5_000,
      'production claim and grant mutation contention',
    )

    expect(claim.claimedPackageId).toBe(fixture.lowerPackageId)
    expect(mutation.approvals).toHaveLength(1)
    expect(mutation.approvals[0].workPackageId).toBe(fixture.targetPackageId)

    const [claimed] = await sql<{ run_count: number; status: string }[]>`
      select package.status, count(run.id)::integer as run_count
      from work_packages package
      join agent_runs run on run.work_package_id = package.id
      where package.id = ${fixture.lowerPackageId}
      group by package.status
    `
    expect(['awaiting_review', 'completed']).toContain(claimed.status)
    expect(claimed.run_count).toBe(1)
  } finally {
    releaseClaim()
    const active: Promise<unknown>[] = []
    if (claimPromise) active.push(claimPromise)
    if (mutationPromise) active.push(mutationPromise)
    if (active.length > 0) {
      await bounded(Promise.allSettled(active), 5_000, 'contention cleanup')
    }
    if (previousExecutionFlag === undefined) delete process.env.FORGE_WORK_PACKAGE_EXECUTION
    else process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
    await Promise.all([sql.end(), observer.end()])
  }
})
