import crypto from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test, expect, type TestInfo } from '@playwright/test'
import postgres from 'postgres'
import { handoffApprovedWorkPackages } from '../worker/work-package-handoff'
import { createSession } from '../lib/session'
import { redis } from '../lib/redis'
import {
  mutateProjectFilesystemGrant,
  mutateTaskFilesystemGrants,
} from '../lib/mcps/filesystem-grant-reconciliation'
import { applyEpic172Step0E2EBridge } from './epic-172-step0-bridge'
import { computeCredentialDigest } from '../lib/session-credential-digest'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for MCP handoff concurrency tests.')

type Sql = ReturnType<typeof postgres>
type JsonObject = { [key: string]: postgres.JSONValue }

const filesystemRequirement = [{
  requirementKey: 'mcp-requirement-v1-filesystem-backend',
  sourceRequirementIndex: 0,
  agent: 'backend',
  mcpId: 'filesystem',
  requirement: 'required',
  permissions: ['filesystem.project.read'],
  prohibitedCapabilities: [],
  assignment: { type: 'agent', targetId: null },
  fallback: { action: 'block', message: 'Approve bounded filesystem context.' },
}]

const optionalGitHubRequirement = [{
  requirementKey: 'mcp-requirement-v1-github-backend',
  sourceRequirementIndex: 0,
  agent: 'backend',
  mcpId: 'github',
  requirement: 'optional',
  permissions: ['github.issues.read'],
  prohibitedCapabilities: [],
  assignment: { type: 'agent', targetId: null },
  fallback: { action: 'continue_without_mcp', message: 'Continue from local context.' },
}]

const unknownMcpRequirement = [{
  requirementKey: 'mcp-requirement-v1-unknown-backend',
  sourceRequirementIndex: 0,
  agent: 'backend',
  mcpId: 'unknown-review-mcp',
  requirement: 'required',
  permissions: ['unknown-review-mcp.read'],
  prohibitedCapabilities: [],
  assignment: { type: 'agent', targetId: null },
  fallback: { action: 'block', message: 'Revise the invalid MCP policy.' },
}]

function explicitFilesystemGrant(grantApprovalId = crypto.randomUUID()) {
  return {
    schemaVersion: 1,
    phase: 'effective',
    source: 'explicit-grant-approval',
    grantApprovalId,
    grantMode: 'allow_once',
    scope: 'work_package',
    mcpId: 'filesystem',
    approvedAt: new Date().toISOString(),
    approvedBy: crypto.randomUUID(),
    grants: [{
      mcpId: 'filesystem',
      status: 'approved',
      capabilities: ['filesystem.project.read'],
      grantApprovalId,
      grantMode: 'allow_once',
      reason: 'Concurrency integration fixture.',
    }],
    reason: 'Concurrency integration fixture.',
    runtimeIssued: false,
    runtimeEnforcement: 'bounded_context_packet',
    status: 'approved',
  }
}

async function seedPackage(sql: Sql, input: {
  metadata: JsonObject
  mcpConfig?: JsonObject
  mcpRequirements: JsonObject[]
  title: string
}) {
  const userId = crypto.randomUUID()
  const projectId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  const packageId = crypto.randomUUID()
  const projectPath = path.join(process.env.FORGE_WORKSPACE_ROOT!, 'projects', projectId)
  await mkdir(projectPath, { recursive: true })
  await sql`insert into users (id, display_name) values (${userId}, ${`Concurrency ${packageId}`})`
  await sql`
    insert into projects (
      id, name, local_path, mcp_config, submitted_by, root_binding_revision
    )
    values (
      ${projectId}, ${`Concurrency ${packageId}`}, ${projectPath},
      ${sql.json(input.mcpConfig ?? { profile: 'custom', requiredMcps: ['filesystem'], overrides: {} })},
      ${userId}, 1
    )
  `
  await sql`
    insert into tasks (id, project_id, title, prompt, status, submitted_by)
    values (${taskId}, ${projectId}, ${input.title}, ${input.title}, 'approved', ${userId})
  `
  await sql`
    insert into work_packages (
      id, task_id, assigned_role, title, summary, status, sequence, steps,
      required_capabilities, acceptance_criteria, mcp_requirements,
      review_requirement, metadata
    ) values (
      ${packageId}, ${taskId}, 'backend', ${input.title}, ${input.title}, 'pending', 1,
      ${sql.json(['Implement the package.'])}, ${sql.json({})}, ${sql.json(['It is safe.'])},
      ${sql.json(input.mcpRequirements)}, 'none', ${sql.json(input.metadata)}
    )
  `
  return { packageId, projectId, taskId, userId }
}

async function packagePointer(sql: Sql, packageId: string) {
  const [pointer] = await sql<{
    current_decision_id: string | null
    current_decision_revision: string | null
    pointer_fingerprint: string
    pointer_version: string
  }[]>`
    select current_decision_id, current_decision_revision::text,
           pointer_fingerprint, pointer_version::text
    from filesystem_mcp_current_decision_pointers
    where work_package_id = ${packageId}
  `
  if (!pointer) throw new Error(`Missing filesystem decision pointer for ${packageId}.`)
  return {
    currentDecisionId: pointer.current_decision_id,
    currentDecisionRevision: pointer.current_decision_revision,
    pointerFingerprint: pointer.pointer_fingerprint,
    pointerVersion: pointer.pointer_version,
  }
}

async function mutatePackageGrant(sql: Sql, input: {
  actorId: string
  decision: 'approved' | 'denied'
  packageId: string
  projectId: string
  reason: string
  taskId: string
}) {
  return mutateTaskFilesystemGrants({
    actorId: input.actorId,
    mutations: [{
      capabilities: ['filesystem.project.read'],
      decision: input.decision,
      grantMode: 'allow_once',
      reason: input.reason,
      workPackageId: input.packageId,
      expectedPointer: await packagePointer(sql, input.packageId),
    }],
    projectId: input.projectId,
    taskId: input.taskId,
  })
}

async function seedSiblingPackage(sql: Sql, input: {
  metadata: JsonObject
  mcpRequirements: JsonObject[]
  taskId: string
  title: string
}) {
  const packageId = crypto.randomUUID()
  await sql`
    insert into work_packages (
      id, task_id, assigned_role, title, summary, status, sequence, steps,
      required_capabilities, acceptance_criteria, mcp_requirements,
      review_requirement, metadata
    ) values (
      ${packageId}, ${input.taskId}, 'backend', ${input.title}, ${input.title}, 'pending', 2,
      ${sql.json(['Implement the sibling package.'])}, ${sql.json({})}, ${sql.json(['It is safe.'])},
      ${sql.json(input.mcpRequirements)}, 'none', ${sql.json(input.metadata)}
    )
  `
  await sql`
    insert into work_package_dependencies (work_package_id, depends_on_work_package_id)
    values (${packageId}, ${packageId})
  `
  return packageId
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

function desktopOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Database concurrency coverage runs once.')
}

test.describe('MCP handoff optimistic concurrency', () => {
  test.describe.configure({ mode: 'serial' })
  let sql: Sql
  let writer: Sql
  let workspaceRoot: string
  let previousExecutionFlag: string | undefined
  let previousWorkspaceRoot: string | undefined
  let previousMcpsRoot: string | undefined
  let previousWorkspaceSettings: Array<{ key: string; value: string }> = []
  const usersToDelete: string[] = []
  const projectsToDelete: string[] = []
  const sessionsToDelete: string[] = []

  test.beforeEach(async ({}, testInfo) => {
    applyEpic172Step0E2EBridge(testInfo, 'mcp-handoff-concurrency.spec.ts')
    desktopOnly(testInfo)
    sql = postgres(databaseUrl, { max: 1 })
    writer = postgres(databaseUrl, { max: 1 })
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-handoff-cas-'))
    previousExecutionFlag = process.env.FORGE_WORK_PACKAGE_EXECUTION
    previousWorkspaceRoot = process.env.FORGE_WORKSPACE_ROOT
    previousMcpsRoot = process.env.FORGE_MCPS_ROOT
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '0'
    process.env.FORGE_WORKSPACE_ROOT = workspaceRoot
    process.env.FORGE_MCPS_ROOT = path.join(workspaceRoot, 'mcps')

    previousWorkspaceSettings = await sql`
      select key, value from app_settings where key in ('workspaceRoot', 'mcpsRoot')
    `
    await sql`
      insert into app_settings (key, value) values
        ('workspaceRoot', ${workspaceRoot}),
        ('mcpsRoot', ${path.join(workspaceRoot, 'mcps')})
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `

    const installPath = path.join(workspaceRoot, 'mcps', 'filesystem')
    await mkdir(installPath, { recursive: true })
    await writeFile(path.join(installPath, 'forge.mcp.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'filesystem',
      displayName: 'Filesystem',
      source: 'forge-catalog',
      createdAt: new Date().toISOString(),
    }))
    await sql`delete from mcp_installations where mcp_id = 'filesystem'`
    await sql`
      insert into mcp_installations (mcp_id, install_path, enabled, source, metadata)
      values ('filesystem', ${installPath}, true, 'catalog', ${sql.json({ manifest: 'forge.mcp.json' })})
    `
  })

  test.afterEach(async () => {
    if (!sql || !writer) return
    await Promise.all(sessionsToDelete.splice(0).map((sessionId) => (
      redis.del(`session:v2:${computeCredentialDigest(sessionId).digest.toString('hex')}`)
    )))
    // Grant decisions and runtime audits are retained evidence. The fixtures
    // use random identities, so archive their projects instead of requiring the
    // ordinary application role to truncate protected history.
    usersToDelete.splice(0)
    for (const projectId of projectsToDelete.splice(0)) {
      await sql`
        update projects
        set archived_at = coalesce(archived_at, now()), updated_at = now()
        where id = ${projectId}
      `
    }
    await sql`delete from mcp_installations where mcp_id = 'filesystem'`
    await sql`delete from app_settings where key in ('workspaceRoot', 'mcpsRoot')`
    for (const setting of previousWorkspaceSettings.splice(0)) {
      await sql`
        insert into app_settings (key, value) values (${setting.key}, ${setting.value})
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `
    }
    await Promise.all([sql.end(), writer.end()])
    await rm(workspaceRoot, { recursive: true, force: true })
    if (previousExecutionFlag === undefined) delete process.env.FORGE_WORK_PACKAGE_EXECUTION
    else process.env.FORGE_WORK_PACKAGE_EXECUTION = previousExecutionFlag
    if (previousWorkspaceRoot === undefined) delete process.env.FORGE_WORKSPACE_ROOT
    else process.env.FORGE_WORKSPACE_ROOT = previousWorkspaceRoot
    if (previousMcpsRoot === undefined) delete process.env.FORGE_MCPS_ROOT
    else process.env.FORGE_MCPS_ROOT = previousMcpsRoot
  })

  test('A: a grant arriving after health capture wins and unrelated metadata survives', async () => {
    const seeded = await seedPackage(sql, {
      metadata: { ownerNote: 'original' },
      mcpRequirements: filesystemRequirement,
      title: 'Grant arrival race',
    })
    usersToDelete.push(seeded.userId)
    projectsToDelete.push(seeded.projectId)
    let approvalId = ''

    const result = await handoffApprovedWorkPackages(seeded.taskId, {
      afterMcpHealthCaptured: async ({ attempt }) => {
        if (attempt !== 1) return
        const mutation = await mutatePackageGrant(writer, {
          actorId: seeded.userId,
          decision: 'approved',
          packageId: seeded.packageId,
          projectId: seeded.projectId,
          reason: 'Grant writer approved bounded context.',
          taskId: seeded.taskId,
        })
        approvalId = mutation.approvals[0]?.id ?? ''
        await writer`
          update work_packages
          set metadata = jsonb_set(metadata, '{concurrentNote}', ${writer.json('grant-writer')}, true),
              updated_at = now()
          where id = ${seeded.packageId}
        `
      },
    })

    expect(result.status, JSON.stringify(result)).toBe('handed_off')
    const [pkg] = await sql`select status, metadata from work_packages where id = ${seeded.packageId}`
    expect(pkg.metadata.concurrentNote).toBe('grant-writer')
    expect(pkg.metadata.ownerNote).toBe('original')
    expect(pkg.metadata.mcpGrantPhases.effective.grantApprovalId).toBe(approvalId)
    expect(pkg.metadata.mcpGrantBlock).toBeUndefined()
    const [{ count }] = await sql`select count(*)::int as count from agent_runs where work_package_id = ${seeded.packageId}`
    expect(count).toBe(1)
  })

  test('B: a denial after health capture creates an operator hold without a run', async () => {
    const seeded = await seedPackage(sql, {
      metadata: { ownerNote: 'keep' },
      mcpRequirements: filesystemRequirement,
      title: 'Grant revocation race',
    })
    usersToDelete.push(seeded.userId)
    projectsToDelete.push(seeded.projectId)
    await mutatePackageGrant(sql, {
      actorId: seeded.userId,
      decision: 'approved',
      packageId: seeded.packageId,
      projectId: seeded.projectId,
      reason: 'Initial bounded approval.',
      taskId: seeded.taskId,
    })

    const result = await handoffApprovedWorkPackages(seeded.taskId, {
      afterMcpHealthCaptured: async ({ attempt }) => {
        if (attempt !== 1) return
        await mutatePackageGrant(writer, {
          actorId: seeded.userId,
          decision: 'denied',
          packageId: seeded.packageId,
          projectId: seeded.projectId,
          reason: 'Operator revoked approval during handoff.',
          taskId: seeded.taskId,
        })
        await writer`
          update work_packages
          set metadata = jsonb_set(metadata, '{revokedBy}', ${writer.json('operator')}, true),
              updated_at = now()
          where id = ${seeded.packageId}
        `
      },
    })

    expect(result).toMatchObject({ status: 'blocked', taskDisposition: 'operator_hold' })
    const [pkg] = await sql`select status, metadata from work_packages where id = ${seeded.packageId}`
    expect(pkg.status).toBe('blocked')
    expect(pkg.metadata.revokedBy).toBe('operator')
    expect(pkg.metadata.ownerNote).toBe('keep')
    expect(pkg.metadata.mcpGrantBlock).toMatchObject({
      kind: 'filesystem_grant',
      holdKind: 'denied_required',
      taskDisposition: 'operator_hold',
    })
    const [{ count }] = await sql`select count(*)::int as count from agent_runs where work_package_id = ${seeded.packageId}`
    expect(count).toBe(0)
    const [{ count: contextPacketAudits }] = await sql`
      select count(*)::int as count
      from filesystem_mcp_runtime_audits
      where work_package_id = ${seeded.packageId}
        and operation = 'context_packet'
    `
    expect(contextPacketAudits).toBe(0)
  })

  test('B2: a canonical project revocation before claim wins with zero runs', async () => {
    const seeded = await seedPackage(sql, {
      metadata: { ownerNote: 'keep-project-race' },
      mcpRequirements: filesystemRequirement,
      title: 'Project grant claim race',
    })
    usersToDelete.push(seeded.userId)
    projectsToDelete.push(seeded.projectId)
    await mutateProjectFilesystemGrant({
      actorId: seeded.userId,
      capabilities: ['filesystem.project.read'],
      enabled: true,
      projectId: seeded.projectId,
      reason: 'Initial project context approval.',
    })

    const result = await handoffApprovedWorkPackages(seeded.taskId, {
      beforeWorkPackageClaimPersisted: async ({ attempt, packageId, projectId }) => {
        if (attempt !== 1) return
        expect(packageId).toBe(seeded.packageId)
        expect(projectId).toBe(seeded.projectId)
        await mutateProjectFilesystemGrant({
          actorId: seeded.userId,
          capabilities: [],
          enabled: false,
          projectId: seeded.projectId,
          reason: 'Operator revoked project context before claim.',
        })
      },
    })

    expect(result).toMatchObject({
      status: 'blocked',
      claimedPackageId: null,
      taskDisposition: 'operator_hold',
    })
    const [project] = await sql`select mcp_config from projects where id = ${seeded.projectId}`
    expect(project.mcp_config.grants.filesystem).toBeUndefined()
    expect(project.mcp_config.grants.filesystemRevocation).toMatchObject({
      revocationReason: 'project_grant_removed',
    })
    const [pkg] = await sql`select status, metadata from work_packages where id = ${seeded.packageId}`
    expect(pkg.status).toBe('blocked')
    expect(pkg.metadata.ownerNote).toBe('keep-project-race')
    expect(pkg.metadata.mcpGrantBlock).toMatchObject({
      holdKind: 'revoked_required',
      revocationReason: 'project_grant_removed',
      taskDisposition: 'operator_hold',
    })
    const [{ count: runs }] = await sql`
      select count(*)::int as count from agent_runs where work_package_id = ${seeded.packageId}
    `
    expect(runs).toBe(0)
    const [{ count: contextPacketAudits }] = await sql`
      select count(*)::int as count
      from filesystem_mcp_runtime_audits
      where work_package_id = ${seeded.packageId}
        and operation = 'context_packet'
    `
    expect(contextPacketAudits).toBe(0)
  })

  test('F: mixed task grants and handoff recovery share project-to-package lock order without deadlock', {
    tag: '@epic172-disabled-ingress',
  }, async () => {
    const seeded = await seedPackage(sql, {
      metadata: { ownerNote: 'mixed-grant-owner' },
      mcpRequirements: filesystemRequirement,
      title: 'Mixed grant handoff target',
    })
    usersToDelete.push(seeded.userId)
    projectsToDelete.push(seeded.projectId)
    await mutatePackageGrant(sql, {
      actorId: seeded.userId,
      decision: 'approved',
      packageId: seeded.packageId,
      projectId: seeded.projectId,
      reason: 'Initial bounded approval for the handoff target.',
      taskId: seeded.taskId,
    })
    const routeExpectedPointer = await packagePointer(sql, seeded.packageId)
    const siblingPackageId = await seedSiblingPackage(sql, {
      metadata: { ownerNote: 'always-allow-sibling' },
      mcpRequirements: filesystemRequirement,
      taskId: seeded.taskId,
      title: 'Project-wide grant sibling',
    })
    const sessionId = await createSession(seeded.userId, null, {
      ip: '127.0.0.1',
      userAgent: 'MCP concurrency regression',
    })
    sessionsToDelete.push(sessionId)

    let resolveBlockerStarted!: () => void
    const blockerStarted = new Promise<void>((resolve) => { resolveBlockerStarted = resolve })
    let resolveTaskLock!: () => void
    const releaseTaskLock = new Promise<void>((resolve) => { resolveTaskLock = resolve })
    let resolveRaceStarted!: () => void
    const raceStarted = new Promise<void>((resolve) => { resolveRaceStarted = resolve })
    let blockingPid = 0
    let blocker: Promise<unknown> | undefined
    let releaseWatcher: Promise<void> | undefined
    let grantMutation: ReturnType<typeof mutateTaskFilesystemGrants> | undefined
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'
    const admissionAttempts: number[] = []

    const [beforeProject] = await sql`select mcp_config from projects where id = ${seeded.projectId}`
    const [beforeTarget] = await sql`select metadata from work_packages where id = ${seeded.packageId}`
    const [{ count: beforeApprovals }] = await sql`
      select count(*)::int as count
      from filesystem_mcp_grant_approvals
      where task_id = ${seeded.taskId}
    `
    const closedResponse = await fetch(`${baseUrl}/api/tasks/${seeded.taskId}/filesystem-grants`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `forge_session=${sessionId}`,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        grants: [{
          workPackageId: siblingPackageId,
          decision: 'approved',
          capabilities: ['filesystem.project.read'],
          grantMode: 'always_allow',
          reason: 'This HTTP request must remain closed while release ingress is disabled.',
        }],
      }),
    })
    expect(closedResponse.status, await closedResponse.text()).toBe(503)
    const [afterClosedProject] = await sql`select mcp_config from projects where id = ${seeded.projectId}`
    const [afterClosedTarget] = await sql`select metadata from work_packages where id = ${seeded.packageId}`
    const [{ count: afterClosedApprovals }] = await sql`
      select count(*)::int as count
      from filesystem_mcp_grant_approvals
      where task_id = ${seeded.taskId}
    `
    expect(afterClosedProject.mcp_config).toEqual(beforeProject.mcp_config)
    expect(afterClosedTarget.metadata).toEqual(beforeTarget.metadata)
    expect(afterClosedApprovals).toBe(beforeApprovals)

    const handoff = handoffApprovedWorkPackages(seeded.taskId, {
      afterMcpAdmissionEvaluated: async ({ attempt, packageId }) => {
        if (packageId === seeded.packageId) admissionAttempts.push(attempt)
      },
      beforeWorkPackageClaimPersisted: async ({ attempt, packageId }) => {
        if (attempt !== 1 || packageId !== seeded.packageId) return
        blocker = writer.begin(async (tx) => {
          const [backend] = await tx`select pg_backend_pid()::int as pid`
          blockingPid = backend.pid
          await tx`select id from tasks where id = ${seeded.taskId} for update`
          resolveBlockerStarted()
          await releaseTaskLock
        })
        await blockerStarted
        grantMutation = mutateTaskFilesystemGrants({
          actorId: seeded.userId,
          projectId: seeded.projectId,
          taskId: seeded.taskId,
          mutations: [{
            workPackageId: seeded.packageId,
            decision: 'approved',
            capabilities: ['filesystem.project.read'],
            grantMode: 'allow_once',
            reason: 'One bounded context issue for the target.',
            expectedPointer: routeExpectedPointer,
          }, {
            workPackageId: siblingPackageId,
            decision: 'approved',
            capabilities: ['filesystem.project.read'],
            grantMode: 'always_allow',
            reason: 'Project-wide bounded context for siblings.',
          }],
        })
        const [grantPid] = await Promise.race([
          waitForLockWaiters(sql, blockingPid, 1),
          grantMutation.then(() => {
            throw new Error('Shared S3 grant mutation returned before the task lock barrier.')
          }),
        ])
        releaseWatcher = waitForLockWaiters(sql, grantPid, 1)
          .then(() => resolveTaskLock())
        resolveRaceStarted()
      },
    })

    try {
      await Promise.race([
        raceStarted,
        delay(10_000).then(() => {
          throw new Error('Mixed grant race did not reach the pre-claim lock-order barrier.')
        }),
      ])
      if (!grantMutation) throw new Error('Shared S3 grant mutation did not start.')

      const [mutationResult, handoffResult] = await Promise.race([
        Promise.all([grantMutation, handoff] as const),
        delay(10_000).then(() => {
          throw new Error('Mixed grant update and handoff did not complete; possible lock-order deadlock.')
        }),
      ])
      expect(mutationResult.approvals).toHaveLength(2)
      expect(handoffResult).toMatchObject({ status: 'handed_off', claimedPackageId: seeded.packageId })
      expect(admissionAttempts).toEqual([1, 2])
    } finally {
      resolveTaskLock()
      await Promise.race([
        Promise.allSettled([
          blocker,
          releaseWatcher,
          grantMutation,
          handoff,
        ].filter((pending): pending is Promise<unknown> => pending !== undefined)),
        delay(5_000),
      ])
    }

    const [project] = await sql`select mcp_config from projects where id = ${seeded.projectId}`
    expect(project.mcp_config.grants.filesystem).toMatchObject({
      grantMode: 'always_allow',
      capabilities: ['filesystem.project.read'],
      status: 'approved',
    })
    const [target] = await sql`select metadata from work_packages where id = ${seeded.packageId}`
    expect(target.metadata.ownerNote).toBe('mixed-grant-owner')
    // The immutable package projection remains local history; admission uses
    // the newer project decision without rewriting that retained evidence.
    expect(target.metadata.mcpGrantPhases.effective.source).toBe('explicit-grant-approval')
    const [{ count: approvals }] = await sql`
      select count(*)::int as count
      from filesystem_mcp_grant_approvals
      where task_id = ${seeded.taskId}
    `
    expect(approvals).toBe(2)
    const [{ count: runs }] = await sql`
      select count(*)::int as count
      from agent_runs
      where work_package_id = ${seeded.packageId}
    `
    expect(runs).toBe(1)
  })

  test('C-D: broker blocks patch owned metadata and policy mutation is reevaluated', async () => {
    const brokerSeed = await seedPackage(sql, {
      metadata: { ownerNote: 'broker-owner' },
      mcpRequirements: unknownMcpRequirement,
      title: 'Broker metadata race',
    })
    usersToDelete.push(brokerSeed.userId)
    projectsToDelete.push(brokerSeed.projectId)
    await handoffApprovedWorkPackages(brokerSeed.taskId, {
      afterMcpHealthCaptured: async () => {
        await writer`
          update work_packages
          set metadata = jsonb_set(metadata, '{concurrentNote}', ${writer.json('broker-writer')}, true),
              updated_at = now()
          where id = ${brokerSeed.packageId}
        `
      },
    })
    const [brokerPkg] = await sql`select metadata from work_packages where id = ${brokerSeed.packageId}`
    expect(brokerPkg.metadata.ownerNote).toBe('broker-owner')
    expect(brokerPkg.metadata.concurrentNote).toBe('broker-writer')
    expect(brokerPkg.metadata.mcpBroker.status).toBe('blocked')

    const policySeed = await seedPackage(sql, {
      metadata: { ownerNote: 'policy-owner' },
      mcpRequirements: optionalGitHubRequirement,
      title: 'Policy mutation race',
    })
    usersToDelete.push(policySeed.userId)
    projectsToDelete.push(policySeed.projectId)
    const result = await handoffApprovedWorkPackages(policySeed.taskId, {
      afterMcpHealthCaptured: async ({ attempt }) => {
        if (attempt !== 1) return
        await writer`
          update work_packages
          set mcp_requirements = ${writer.json(filesystemRequirement)},
              metadata = jsonb_set(metadata, '{policyWriter}', ${writer.json(true)}, true),
              updated_at = now()
          where id = ${policySeed.packageId}
        `
      },
    })
    expect(result).toMatchObject({ status: 'blocked', taskDisposition: 'operator_hold' })
    const [policyPkg] = await sql`select metadata, mcp_requirements from work_packages where id = ${policySeed.packageId}`
    expect(policyPkg.mcp_requirements[0].mcpId).toBe('filesystem')
    expect(policyPkg.metadata.policyWriter).toBe(true)
    expect(policyPkg.metadata.mcpGrantBlock).toMatchObject({
      holdKind: 'approval_required',
      taskDisposition: 'operator_hold',
    })
    const [{ count }] = await sql`select count(*)::int as count from agent_runs where work_package_id = ${policySeed.packageId}`
    expect(count).toBe(0)
  })

  test('E: compare-and-set retries once successfully and repeated conflicts fail closed', async () => {
    const retrySeed = await seedPackage(sql, {
      metadata: { ownerNote: 'retry-owner' },
      mcpRequirements: optionalGitHubRequirement,
      title: 'Successful CAS retry',
    })
    usersToDelete.push(retrySeed.userId)
    projectsToDelete.push(retrySeed.projectId)
    const retryAttempts: number[] = []
    const retryResult = await handoffApprovedWorkPackages(retrySeed.taskId, {
      afterMcpAdmissionEvaluated: async ({ attempt }) => {
        retryAttempts.push(attempt)
        if (attempt !== 1) return
        await writer`
          update work_packages
          set metadata = jsonb_set(metadata, '{casWriter}', ${writer.json('first-conflict')}, true),
              updated_at = now()
          where id = ${retrySeed.packageId}
        `
      },
    })
    expect(retryResult.status).toBe('handed_off')
    expect(retryAttempts).toEqual([1, 2])
    const [retried] = await sql`select metadata from work_packages where id = ${retrySeed.packageId}`
    expect(retried.metadata.casWriter).toBe('first-conflict')
    const [{ count: retryRuns }] = await sql`select count(*)::int as count from agent_runs where work_package_id = ${retrySeed.packageId}`
    expect(retryRuns).toBe(1)

    const conflictSeed = await seedPackage(sql, {
      metadata: { ownerNote: 'terminal-owner' },
      mcpRequirements: unknownMcpRequirement,
      title: 'Terminal CAS conflict',
    })
    usersToDelete.push(conflictSeed.userId)
    projectsToDelete.push(conflictSeed.projectId)
    const conflictAttempts: number[] = []
    const conflictResult = await handoffApprovedWorkPackages(conflictSeed.taskId, {
      afterMcpAdmissionEvaluated: async ({ attempt }) => {
        conflictAttempts.push(attempt)
        await writer`
          update work_packages
          set metadata = jsonb_set(metadata, '{casConflictCount}', ${writer.json(attempt)}, true),
              updated_at = now()
          where id = ${conflictSeed.packageId}
        `
      },
    })
    expect(conflictResult).toMatchObject({ status: 'blocked', claimedPackageId: null })
    expect(conflictAttempts).toEqual([1, 2, 3])
    const [conflicted] = await sql`select status, metadata from work_packages where id = ${conflictSeed.packageId}`
    expect(conflicted.status).toBe('blocked')
    expect(conflicted.metadata.ownerNote).toBe('terminal-owner')
    expect(conflicted.metadata.casConflictCount).toBe(3)
    expect(conflicted.metadata.handoffFreshnessBlock.status).toBe('blocked')
    expect(conflicted.metadata.mcpBroker).toBeUndefined()
    const [{ count: conflictRuns }] = await sql`select count(*)::int as count from agent_runs where work_package_id = ${conflictSeed.packageId}`
    expect(conflictRuns).toBe(0)
  })

  test('post-claim context failure removes only the owned lease from current metadata', async () => {
    process.env.FORGE_WORK_PACKAGE_EXECUTION = '1'
    const seeded = await seedPackage(sql, {
      metadata: { ownerNote: 'before-claim' },
      mcpRequirements: optionalGitHubRequirement,
      title: 'Post-claim metadata race',
    })
    usersToDelete.push(seeded.userId)
    projectsToDelete.push(seeded.projectId)
    const effective = explicitFilesystemGrant()

    await expect(handoffApprovedWorkPackages(seeded.taskId, {
      afterWorkPackageClaimed: async ({ attempt, packageId }) => {
        expect(attempt).toBe(1)
        expect(packageId).toBe(seeded.packageId)
        // This is a separate connection committing after the claim transaction.
        // Nulling localPath makes the subsequent real context load fail before
        // executor/context-packet issuance, exercising lease-owned cleanup.
        await writer`
          update work_packages
          set metadata = jsonb_set(
            jsonb_set(metadata, '{mcpGrantPhases}', ${writer.json({ effective })}, true),
            '{postClaimWriter}', ${writer.json('survives-failure')}, true
          ), updated_at = now()
          where id = ${seeded.packageId}
        `
        await writer`update projects set local_path = null, updated_at = now() where id = ${seeded.projectId}`
      },
    })).rejects.toThrow('Project localPath is required')

    const [pkg] = await sql`select status, metadata from work_packages where id = ${seeded.packageId}`
    expect(pkg.status).toBe('failed')
    expect(pkg.metadata.ownerNote).toBe('before-claim')
    expect(pkg.metadata.postClaimWriter).toBe('survives-failure')
    expect(pkg.metadata.mcpGrantPhases.effective.grantApprovalId).toBe(effective.grantApprovalId)
    expect(pkg.metadata.executionLease).toBeUndefined()
    const [run] = await sql`
      select id, status, error_message
      from agent_runs
      where work_package_id = ${seeded.packageId}
    `
    expect(run.status).toBe('failed')
    expect(run.error_message).toContain('Project localPath is required')
    const [{ count: contextArtifacts }] = await sql`
      select count(*)::int as count
      from artifacts
      where agent_run_id = ${run.id}
    `
    expect(contextArtifacts).toBe(0)
  })
})
