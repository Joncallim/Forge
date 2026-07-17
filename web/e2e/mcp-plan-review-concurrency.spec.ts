import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test'
import postgres from 'postgres'
import { createSession } from '../lib/session'
import { redis } from '../lib/redis'
import { parseMcpExecutionDesign } from '../worker/mcp-execution-design'
import { validateMcpOperatorReviewHistory } from '../worker/mcp-plan-review'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'

const databaseUrl = process.env.DATABASE_URL ?? ''
const redisUrl = process.env.REDIS_URL ?? ''

type Sql = ReturnType<typeof postgres>

const proposedDesign = parseMcpExecutionDesign(`\`\`\`mcp_execution_design_json
${JSON.stringify({
  schemaVersion: 1,
  requirements: [{
    mcpId: 'github',
    requirement: 'optional',
    reason: 'Read the issue that defines this package.',
    assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
    agentPermissions: { backend: ['github.issues.read'] },
    prohibitedCapabilities: ['github.pull_requests.merge'],
    fallback: { action: 'continue_without_mcp', message: 'Continue from the saved issue context.' },
  }],
  promptOverlays: {},
  requirementContexts: [],
  mcpAwareSubtasks: [],
})}
\`\`\``).design!

type SeededReviewTask = {
  artifactId: string
  gateId: string
  packageId: string
  projectId: string
  sessionId: string
  taskId: string
  userId: string
}

function desktopOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Database concurrency coverage runs once.')
  test.skip(!databaseUrl || !redisUrl, 'DATABASE_URL and REDIS_URL are required for PostgreSQL concurrency coverage.')
}

function reviewBody(seed: SeededReviewTask) {
  const requirement = proposedDesign.requirements[0]
  return {
    sourceArtifactId: seed.artifactId,
    baseRevision: 0,
    baseDigest: null,
    items: [{
      requirementKey: requirement.requirementKey,
      decision: 'approved',
      assignment: { type: 'agent', targetAgents: ['backend'], targetId: null },
      agentPermissions: { backend: ['github.issues.read'] },
      promptOverlays: { backend: 'Use only the approved issue context.' },
    }],
  }
}

async function seedReviewTask(sql: Sql): Promise<SeededReviewTask> {
  const userId = crypto.randomUUID()
  const projectId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  const packageId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const artifactId = crypto.randomUUID()
  const gateId = crypto.randomUUID()

  await sql`insert into users (id, display_name) values (${userId}, ${`Plan review ${taskId}`})`
  await sql`
    insert into projects (id, name, submitted_by, mcp_config)
    values (
      ${projectId}, ${`Plan review ${taskId}`}, ${userId},
      ${sql.json({ profile: 'custom', requiredMcps: [], overrides: {} })}
    )
  `
  await sql`
    insert into tasks (id, project_id, title, prompt, status, submitted_by)
    values (${taskId}, ${projectId}, 'Review an MCP plan', 'Review an MCP plan', 'awaiting_approval', ${userId})
  `
  await sql`
    insert into work_packages (
      id, task_id, assigned_role, title, summary, status, sequence, steps,
      required_capabilities, acceptance_criteria, mcp_requirements,
      review_requirement, metadata
    ) values (
      ${packageId}, ${taskId}, 'backend', 'Backend package', 'Backend package', 'pending', 1,
      ${sql.json(['Implement the package.'])}, ${sql.json({})}, ${sql.json(['Review is projected.'])},
      ${sql.json([])}, 'none', ${sql.json({ fixture: 'mcp-plan-review-concurrency' })}
    )
  `
  await sql`
    insert into agent_runs (id, task_id, agent_type, model_id_used, status)
    values (${runId}, ${taskId}, 'architect', 'e2e-fixture', 'completed')
  `
  await sql`
    insert into artifacts (id, agent_run_id, artifact_type, content, metadata)
    values (
      ${artifactId}, ${runId}, 'adr_text', 'Architect plan',
      ${sql.json({ mcpExecutionDesign: { proposed: proposedDesign } })}
    )
  `
  await sql`
    insert into approval_gates (
      id, task_id, gate_type, status, source_agent_run_id, source_artifact_id,
      title, instructions, metadata
    ) values (
      ${gateId}, ${taskId}, 'plan_approval', 'pending', ${runId}, ${artifactId},
      'Approve the plan', 'Review MCP access first.',
      ${sql.json({ mcpOperatorReviewRequired: true })}
    )
  `

  const sessionId = await createSession(userId, null, {
    ip: '127.0.0.1',
    userAgent: 'MCP plan review concurrency regression',
  })
  return { artifactId, gateId, packageId, projectId, sessionId, taskId, userId }
}

async function waitForLockWaiters(sql: Sql, blockingPid: number, expected: number): Promise<number[]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = await sql`
      select activity.pid::int as pid
      from pg_stat_activity activity
      where activity.datname = current_database()
        and activity.wait_event_type = 'Lock'
        and ${blockingPid} = any(pg_blocking_pids(activity.pid))
    `
    if (rows.length >= expected) return rows.map((row) => row.pid)
    await delay(10)
  }
  throw new Error(`Expected ${expected} transaction(s) to wait on PostgreSQL backend ${blockingPid}.`)
}

function postReview(request: APIRequestContext, seed: SeededReviewTask) {
  return request.post(`/api/tasks/${seed.taskId}/mcp-plan-review`, {
    headers: { Cookie: `forge_session=${seed.sessionId}` },
    data: reviewBody(seed),
  })
}

test.describe('MCP plan review PostgreSQL concurrency', () => {
  test.describe.configure({ mode: 'serial' })
  let sql: Sql
  let locker: Sql
  const projectsToArchive: string[] = []
  const sessionsToDelete: string[] = []
  const approvalTasksToRemove: string[] = []

  test.beforeEach(async ({}, testInfo) => {
    applyEpic172Step0E2EBridge(testInfo, 'mcp-plan-review-concurrency.spec.ts')
    desktopOnly(testInfo)
    sql = postgres(databaseUrl, { max: 1 })
    locker = postgres(databaseUrl, { max: 1 })
  })

  test.afterEach(async () => {
    if (!sql || !locker) return
    await Promise.all(sessionsToDelete.splice(0).map((sessionId) => redis.del(`session:${sessionId}`)))
    for (const taskId of approvalTasksToRemove.splice(0)) {
      await redis.lrem('forge:approvals', 0, JSON.stringify({ taskId, action: 'approve' }))
    }
    for (const projectId of projectsToArchive.splice(0)) {
      await sql`
        update projects
        set archived_at = coalesce(archived_at, now()), updated_at = now()
        where id = ${projectId}
      `
    }
    await Promise.all([sql.end(), locker.end()])
  })

  test('serializes concurrent review saves to one contiguous history revision', async ({ request }) => {
    const seed = await seedReviewTask(sql)
    projectsToArchive.push(seed.projectId)
    sessionsToDelete.push(seed.sessionId)

    const responses = await Promise.all([postReview(request, seed), postReview(request, seed)])
    expect(responses.map((response) => response.status()).sort()).toEqual([200, 409])

    const [gate] = await sql`select status, source_artifact_id, metadata from approval_gates where id = ${seed.gateId}`
    const validation = validateMcpOperatorReviewHistory(gate.metadata, gate.source_artifact_id)
    expect(validation.valid).toBe(true)
    if (!validation.valid) throw new Error(validation.error)
    expect(validation.history).toHaveLength(1)
    expect(validation.head).toMatchObject({ revision: 1, sourceArtifactId: seed.artifactId })
    expect(gate.status).toBe('pending')
  })

  test('review and approval cannot produce a stale approval or an unprojected approved package', async ({ request }) => {
    const seed = await seedReviewTask(sql)
    projectsToArchive.push(seed.projectId)
    sessionsToDelete.push(seed.sessionId)
    approvalTasksToRemove.push(seed.taskId)

    const [reviewResponse, approvalResponse] = await Promise.all([
      postReview(request, seed),
      request.post(`/api/tasks/${seed.taskId}/approve`, {
        headers: { Cookie: `forge_session=${seed.sessionId}` },
      }),
    ])
    expect(reviewResponse.status(), await reviewResponse.text()).toBe(200)
    expect([200, 409]).toContain(approvalResponse.status())

    const [task] = await sql`select status from tasks where id = ${seed.taskId}`
    const [gate] = await sql`select status, source_artifact_id, metadata from approval_gates where id = ${seed.gateId}`
    const [pkg] = await sql`select mcp_requirements, metadata from work_packages where id = ${seed.packageId}`
    const validation = validateMcpOperatorReviewHistory(gate.metadata, gate.source_artifact_id)
    expect(validation.valid).toBe(true)
    if (!validation.valid || !validation.head) throw new Error(validation.valid ? 'Missing review head.' : validation.error)
    expect(validation.history).toHaveLength(1)

    if (approvalResponse.status() === 200) {
      expect(task.status).toBe('approved')
      expect(gate.status).toBe('approved')
      expect(pkg.mcp_requirements).toHaveLength(1)
      expect(pkg.mcp_requirements[0]).toMatchObject({
        mcpId: 'github',
        permissions: ['github.issues.read'],
      })
      expect(pkg.metadata).toMatchObject({
        promptOverlay: 'Use only the approved issue context.',
        mcpOperatorReview: {
          sourceArtifactId: seed.artifactId,
          revision: 1,
          digest: validation.head.digest,
        },
      })
    } else {
      expect(task.status).toBe('awaiting_approval')
      expect(gate.status).toBe('pending')
      expect(pkg.mcp_requirements).toEqual([])
      expect(pkg.metadata.mcpOperatorReview).toBeUndefined()
    }
  })

  test('rejects an old review after a locked plan replacement commits', async ({ request }) => {
    const seed = await seedReviewTask(sql)
    projectsToArchive.push(seed.projectId)
    sessionsToDelete.push(seed.sessionId)
    const replacementArtifactId = crypto.randomUUID()
    const [run] = await sql`select source_agent_run_id from approval_gates where id = ${seed.gateId}`
    await sql`
      insert into artifacts (id, agent_run_id, artifact_type, content, metadata)
      values (
        ${replacementArtifactId}, ${run.source_agent_run_id}, 'adr_text', 'Replacement Architect plan',
        ${sql.json({ mcpExecutionDesign: { proposed: proposedDesign } })}
      )
    `

    let reviewResponsePromise: ReturnType<typeof postReview> | undefined
    await locker.begin(async (tx) => {
      const [backend] = await tx`select pg_backend_pid()::int as pid`
      await tx`select id from tasks where id = ${seed.taskId} for update`
      reviewResponsePromise = postReview(request, seed)
      await Promise.race([
        waitForLockWaiters(sql, backend.pid, 1),
        reviewResponsePromise.then(async (response) => {
          throw new Error(`Review returned before the task lock barrier (${response.status()}): ${await response.text()}`)
        }),
      ])
      await tx`
        update approval_gates
        set source_artifact_id = ${replacementArtifactId},
            metadata = ${tx.json({ mcpOperatorReviewRequired: true })},
            updated_at = now()
        where id = ${seed.gateId}
      `
    })
    if (!reviewResponsePromise) throw new Error('Review request did not start.')
    const reviewResponse = await reviewResponsePromise
    expect(reviewResponse.status(), await reviewResponse.text()).toBe(409)

    const [task] = await sql`select status from tasks where id = ${seed.taskId}`
    const [gate] = await sql`select status, source_artifact_id, metadata from approval_gates where id = ${seed.gateId}`
    const [pkg] = await sql`select mcp_requirements, metadata from work_packages where id = ${seed.packageId}`
    expect(task.status).toBe('awaiting_approval')
    expect(gate).toMatchObject({ status: 'pending', source_artifact_id: replacementArtifactId })
    expect(validateMcpOperatorReviewHistory(gate.metadata, replacementArtifactId)).toMatchObject({
      valid: true,
      history: [],
      head: null,
    })
    expect(pkg.mcp_requirements).toEqual([])
    expect(pkg.metadata.mcpOperatorReview).toBeUndefined()
  })
})
