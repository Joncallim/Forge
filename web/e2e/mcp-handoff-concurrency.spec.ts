import crypto from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type TestInfo } from '@playwright/test'
import postgres from 'postgres'
import { handoffApprovedWorkPackages } from '../worker/work-package-handoff'

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
    insert into projects (id, name, local_path, mcp_config)
    values (
      ${projectId}, ${`Concurrency ${packageId}`}, ${projectPath},
      ${sql.json({ profile: 'custom', requiredMcps: ['filesystem'], overrides: {} })}
    )
  `
  await sql`
    insert into tasks (id, project_id, title, prompt, status)
    values (${taskId}, ${projectId}, ${input.title}, ${input.title}, 'approved')
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
  const usersToDelete: string[] = []
  const projectsToDelete: string[] = []

  test.beforeEach(async ({}, testInfo) => {
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
    for (const userId of usersToDelete.splice(0)) {
      await sql`delete from users where id = ${userId}`
    }
    for (const projectId of projectsToDelete.splice(0)) {
      await sql`delete from projects where id = ${projectId}`
    }
    await sql`delete from mcp_installations where mcp_id = 'filesystem'`
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
    const effective = explicitFilesystemGrant()

    const result = await handoffApprovedWorkPackages(seeded.taskId, {
      afterMcpHealthCaptured: async ({ attempt }) => {
        if (attempt !== 1) return
        await writer`
          update work_packages
          set metadata = jsonb_set(
            jsonb_set(metadata, '{mcpGrantPhases}', ${writer.json({ effective })}, true),
            '{concurrentNote}', ${writer.json('grant-writer')}, true
          ), updated_at = now()
          where id = ${seeded.packageId}
        `
      },
    })

    expect(result.status, JSON.stringify(result)).toBe('handed_off')
    const [pkg] = await sql`select status, metadata from work_packages where id = ${seeded.packageId}`
    expect(pkg.metadata.concurrentNote).toBe('grant-writer')
    expect(pkg.metadata.ownerNote).toBe('original')
    expect(pkg.metadata.mcpGrantPhases.effective.grantApprovalId).toBe(effective.grantApprovalId)
    expect(pkg.metadata.mcpGrantBlock).toBeUndefined()
    const [{ count }] = await sql`select count(*)::int as count from agent_runs where work_package_id = ${seeded.packageId}`
    expect(count).toBe(1)
  })

  test('B: a revocation after health capture blocks without creating a run', async () => {
    const seeded = await seedPackage(sql, {
      metadata: { mcpGrantPhases: { effective: explicitFilesystemGrant() }, ownerNote: 'keep' },
      mcpRequirements: filesystemRequirement,
      title: 'Grant revocation race',
    })
    usersToDelete.push(seeded.userId)
    projectsToDelete.push(seeded.projectId)

    const result = await handoffApprovedWorkPackages(seeded.taskId, {
      afterMcpHealthCaptured: async ({ attempt }) => {
        if (attempt !== 1) return
        await writer`
          update work_packages
          set metadata = jsonb_set(
            metadata #- '{mcpGrantPhases,effective}',
            '{revokedBy}', ${writer.json('operator')}, true
          ), updated_at = now()
          where id = ${seeded.packageId}
        `
      },
    })

    expect(result).toMatchObject({ status: 'blocked', terminalBlock: true })
    const [pkg] = await sql`select status, metadata from work_packages where id = ${seeded.packageId}`
    expect(pkg.status).toBe('failed')
    expect(pkg.metadata.revokedBy).toBe('operator')
    expect(pkg.metadata.ownerNote).toBe('keep')
    expect(pkg.metadata.mcpGrantBlock.status).toBe('failed')
    const [{ count }] = await sql`select count(*)::int as count from agent_runs where work_package_id = ${seeded.packageId}`
    expect(count).toBe(0)
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
    expect(result).toMatchObject({ status: 'blocked', terminalBlock: true })
    const [policyPkg] = await sql`select metadata, mcp_requirements from work_packages where id = ${policySeed.packageId}`
    expect(policyPkg.mcp_requirements[0].mcpId).toBe('filesystem')
    expect(policyPkg.metadata.policyWriter).toBe(true)
    expect(policyPkg.metadata.mcpGrantBlock.status).toBe('failed')
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
