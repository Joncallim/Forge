import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import {
  agentHarnesses,
  agentRuns,
  artifacts,
  projects,
  tasks,
  vcsChanges,
  workPackageDependencies,
  workPackages,
} from '../db/schema'
import { getProjectMcpOverview } from '../lib/mcps/manager'
import { publishTaskEvent } from './events'
import {
  evaluateWorkPackageMcpBroker,
  hasWorkPackageMcpRuntimeInputs,
} from './mcp-execution-design'
import {
  completeTaskIfReviewGatesSatisfied,
  materializeReviewGatesForWorkPackageCompletion,
} from './review-gates'
import {
  executeWorkPackage,
  loadWorkPackageExecutionContext,
} from './work-package-executor'
import {
  buildRepositoryExecutionContext,
  isRepositoryAffectingWorkPackage,
  recordScopedCommandAudit,
  runScopedRepositoryCommand,
  type RepositoryExecutionContext,
} from './repository-evidence'

type HandoffPackage = {
  id: string
  assignedRole: string
  harnessId: string | null
  harnessToolPolicy?: unknown
  mcpRequirements?: unknown
  metadata?: unknown
  sequence: number
  status: string
  title: string
}

type HandoffDependency = {
  workPackageId: string
  dependsOnWorkPackageId: string
}

type HandoffState = {
  alreadyRunningPackage: HandoffPackage | null
  nextPackage: HandoffPackage | null
  packages: HandoffPackage[]
  readyPackageIds: string[]
}

type CreatedArtifact = typeof artifacts.$inferSelect

function repositoryContextMetadata(
  context: RepositoryExecutionContext,
  validationStatus: string | null = null,
): Record<string, unknown> {
  return {
    baseBranch: context.baseBranch,
    blockedReason: context.blockedReason,
    branchCollision: context.branchCollision,
    currentBranch: context.currentBranch,
    evidenceStatus: context.status,
    hasRemote: context.hasRemote,
    intendedTaskBranch: context.intendedTaskBranch,
    isDirty: context.isDirty,
    isGitRepository: context.isGitRepository,
    pathExists: context.pathExists,
    projectLocalPath: context.projectLocalPath,
    validationStatus,
  }
}

function repositoryReadinessContent(context: RepositoryExecutionContext): string {
  return [
    `Repository evidence status: ${context.status}`,
    `Project path: ${context.projectLocalPath ?? 'missing'}`,
    `Git repository: ${context.isGitRepository ? 'yes' : 'no'}`,
    `Current branch: ${context.currentBranch ?? 'unknown'}`,
    `Base branch: ${context.baseBranch ?? 'unknown'}`,
    `Intended task branch: ${context.intendedTaskBranch ?? 'unknown'}`,
    `Working tree: ${context.isDirty === null ? 'unknown' : context.isDirty ? 'dirty' : 'clean'}`,
    `Remote: ${context.hasRemote === null ? 'unknown' : context.hasRemote ? 'configured' : 'missing'}`,
    `Branch collision: ${context.branchCollision === null ? 'unknown' : context.branchCollision ? 'yes' : 'no'}`,
    context.blockedReason ? `Blocked reason: ${context.blockedReason}` : null,
  ].filter((line): line is string => line !== null).join('\n')
}

function validationContent(commandResults: Array<{ command: string[]; exitCode: number; stdout: string; stderr: string }>): string {
  const lines = commandResults.length > 0
    ? commandResults.map((result) => [
        `Command: ${result.command.join(' ')}`,
        `Exit code: ${result.exitCode}`,
        result.stdout ? `stdout:\n${result.stdout}` : null,
        result.stderr ? `stderr:\n${result.stderr}` : null,
      ].filter((line): line is string => line !== null).join('\n'))
    : ['No package validation commands were run by the execution plan.']
  return lines.join('\n\n')
}

async function createPackageArtifact(input: {
  agentRunId: string
  artifactType: string
  content: string
  metadata: Record<string, unknown>
  taskId: string
  workPackageId: string
}): Promise<CreatedArtifact> {
  const [artifact] = await db
    .insert(artifacts)
    .values({
      agentRunId: input.agentRunId,
      artifactType: input.artifactType,
      content: input.content,
      metadata: input.metadata,
    })
    .returning()

  await publishTaskEvent(input.taskId, 'artifact:created', {
    id: artifact.id,
    artifactId: artifact.id,
    agentRunId: artifact.agentRunId,
    artifactType: artifact.artifactType,
    content: artifact.content,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt,
    workPackageId: input.workPackageId,
  })

  return artifact
}

async function upsertRepositoryEvidenceRecord(input: {
  agentRunId: string
  context: RepositoryExecutionContext
  diffSummary?: string | null
  status?: string
  taskId: string
  validationStatus?: string | null
  workPackageId: string
}): Promise<string> {
  const metadata = repositoryContextMetadata(input.context, input.validationStatus ?? null)
  const values = {
    agentRunId: input.agentRunId,
    baseBranch: input.context.baseBranch,
    branchName: input.context.intendedTaskBranch,
    changeType: 'repository_evidence',
    diffSummary: input.diffSummary ?? null,
    metadata,
    repository: input.context.projectLocalPath,
    status: input.status ?? input.context.status,
    taskId: input.taskId,
    updatedAt: new Date(),
    workPackageId: input.workPackageId,
  }

  const [existing] = await db
    .select({ id: vcsChanges.id })
    .from(vcsChanges)
    .where(and(eq(vcsChanges.taskId, input.taskId), eq(vcsChanges.workPackageId, input.workPackageId)))
    .limit(1)

  if (existing) {
    const [updated] = await db
      .update(vcsChanges)
      .set(values)
      .where(eq(vcsChanges.id, existing.id))
      .returning({ id: vcsChanges.id })
    return updated.id
  }

  const [created] = await db
    .insert(vcsChanges)
    .values(values)
    .returning({ id: vcsChanges.id })
  return created.id
}

export type WorkPackageHandoffPreview =
  | {
      status: 'no_work_packages' | 'no_ready_packages'
      readyPackageIds: string[]
      claimedPackageId: null
    }
  | {
      status: 'claimable' | 'already_handed_off'
      readyPackageIds: string[]
      claimedPackageId: string
    }

export type WorkPackageHandoffResult =
  | {
      status: 'no_work_packages'
      readyPackageIds: []
      claimedPackageId: null
    }
  | {
      status: 'blocked' | 'handed_off' | 'already_handed_off' | 'no_ready_packages' | 'ready_only'
      readyPackageIds: string[]
      claimedPackageId: string | null
      blockedReason?: string
    }

export function isWorkPackageHandoffEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.FORGE_WORK_PACKAGE_HANDOFF?.trim().toLowerCase()
  return raw !== '0' && raw !== 'false'
}

export function isWorkPackageExecutionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.FORGE_WORK_PACKAGE_EXECUTION?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

export function computeReadyWorkPackageIds(
  packages: HandoffPackage[],
  dependencies: HandoffDependency[],
): string[] {
  const completedPackageIds = new Set(
    packages
      .filter((pkg) => pkg.status === 'completed')
      .map((pkg) => pkg.id),
  )
  const dependenciesByPackageId = new Map<string, string[]>()

  for (const dependency of dependencies) {
    const current = dependenciesByPackageId.get(dependency.workPackageId) ?? []
    current.push(dependency.dependsOnWorkPackageId)
    dependenciesByPackageId.set(dependency.workPackageId, current)
  }

  return packages
    .filter((pkg) => pkg.status === 'pending' || pkg.status === 'needs_rework' || pkg.status === 'blocked')
    .filter((pkg) =>
      (dependenciesByPackageId.get(pkg.id) ?? []).every((dependencyId) =>
        completedPackageIds.has(dependencyId),
      ),
    )
    .sort((a, b) => a.sequence - b.sequence)
    .map((pkg) => pkg.id)
}

async function loadHandoffState(taskId: string): Promise<HandoffState> {
  const packageRows = await db
    .select({
      id: workPackages.id,
      assignedRole: workPackages.assignedRole,
      harnessId: workPackages.harnessId,
      harnessToolPolicy: agentHarnesses.toolPolicy,
      mcpRequirements: workPackages.mcpRequirements,
      metadata: workPackages.metadata,
      sequence: workPackages.sequence,
      status: workPackages.status,
      title: workPackages.title,
    })
    .from(workPackages)
    .leftJoin(agentHarnesses, eq(agentHarnesses.id, workPackages.harnessId))
    .where(eq(workPackages.taskId, taskId))
    .orderBy(asc(workPackages.sequence), asc(workPackages.createdAt))

  if (packageRows.length === 0) {
    return {
      alreadyRunningPackage: null,
      nextPackage: null,
      packages: [],
      readyPackageIds: [],
    }
  }

  const packageIds = packageRows.map((pkg) => pkg.id)
  const dependencyRows = await db
    .select({
      workPackageId: workPackageDependencies.workPackageId,
      dependsOnWorkPackageId: workPackageDependencies.dependsOnWorkPackageId,
    })
    .from(workPackageDependencies)
    .where(inArray(workPackageDependencies.workPackageId, packageIds))

  const readyPackageIds = computeReadyWorkPackageIds(packageRows, dependencyRows)
  const alreadyRunningPackage = packageRows.find((pkg) => pkg.status === 'running') ?? null
  const readyPackageIdSet = new Set([
    ...readyPackageIds,
    ...packageRows.filter((pkg) => pkg.status === 'ready').map((pkg) => pkg.id),
  ])
  const nextPackage = packageRows.find((pkg) => readyPackageIdSet.has(pkg.id)) ?? null

  return {
    alreadyRunningPackage,
    nextPackage,
    packages: packageRows,
    readyPackageIds,
  }
}

async function loadTaskProjectForMcpBroker(taskId: string) {
  const [row] = await db
    .select({ project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.id, taskId))
    .limit(1)

  return row?.project ?? null
}

async function failWorkPackageForMcpBroker(input: {
  blocked: string[]
  blockedReason: string
  pkg: HandoffPackage
  taskId: string
  warnings: string[]
}): Promise<{ blockedReason: string; status: 'blocked' }> {
  const blockedAt = new Date()
  await db
    .update(workPackages)
    .set({
      blockedReason: input.blockedReason,
      status: 'blocked',
      updatedAt: blockedAt,
    })
    .where(and(eq(workPackages.id, input.pkg.id), inArray(workPackages.status, ['pending', 'ready', 'needs_rework', 'blocked'])))

  await publishTaskEvent(input.taskId, 'work_package:status', {
    blockedReason: input.blockedReason,
    mcpBroker: {
      blocked: input.blocked,
      status: 'blocked',
      warnings: input.warnings,
    },
    status: 'blocked',
    updatedAt: blockedAt.toISOString(),
    workPackageId: input.pkg.id,
  })

  return { blockedReason: input.blockedReason, status: 'blocked' }
}

async function assertWorkPackageMcpBrokerAllowsHandoff(
  taskId: string,
  pkg: HandoffPackage,
): Promise<{ blockedReason: string; status: 'blocked' } | { status: 'allowed' }> {
  if (!hasWorkPackageMcpRuntimeInputs(pkg)) return { status: 'allowed' }

  const project = await loadTaskProjectForMcpBroker(taskId)
  if (!project) {
    const blockedReason = `MCP/capability broker blocked "${pkg.title}": project MCP overview could not be loaded.`
    return failWorkPackageForMcpBroker({
      blocked: ['Project MCP overview could not be loaded.'],
      blockedReason,
      pkg,
      taskId,
      warnings: [],
    })
  }

  const mcpOverview = await getProjectMcpOverview(project)
  const check = evaluateWorkPackageMcpBroker({
    assignedRole: pkg.assignedRole,
    harnessToolPolicy: pkg.harnessToolPolicy,
    mcpOverview,
    mcpRequirements: pkg.mcpRequirements,
    metadata: pkg.metadata,
    title: pkg.title,
  })

  if (check.status !== 'blocked') return { status: 'allowed' }

  const blockedReason = check.blockedReason ?? 'MCP/capability broker blocked this work package.'
  return failWorkPackageForMcpBroker({
    blocked: check.blocked,
    blockedReason,
    pkg,
    taskId,
    warnings: check.warnings,
  })
}

export async function progressWorkforce(
  taskId: string,
  options: { claimEnabled?: boolean } = {},
): Promise<WorkPackageHandoffResult> {
  const result = await handoffApprovedWorkPackages(taskId, options)
  if (result.status === 'no_ready_packages' || result.status === 'no_work_packages') {
    await completeTaskIfReviewGatesSatisfied(taskId)
  }
  return result
}

async function continueWorkforceAfterPackageCompletion(
  taskId: string,
  packageStatus: string | null | undefined,
  options: { claimEnabled?: boolean },
): Promise<void> {
  if (packageStatus !== 'completed') return
  await progressWorkforce(taskId, options)
}

export async function previewWorkPackageHandoff(taskId: string): Promise<WorkPackageHandoffPreview> {
  const state = await loadHandoffState(taskId)

  if (state.packages.length === 0) {
    return { status: 'no_work_packages', readyPackageIds: [], claimedPackageId: null }
  }

  if (state.alreadyRunningPackage) {
    return {
      status: 'already_handed_off',
      readyPackageIds: state.readyPackageIds,
      claimedPackageId: state.alreadyRunningPackage.id,
    }
  }

  if (!state.nextPackage) {
    return {
      status: 'no_ready_packages',
      readyPackageIds: state.readyPackageIds,
      claimedPackageId: null,
    }
  }

  return {
    status: 'claimable',
    readyPackageIds: state.readyPackageIds,
    claimedPackageId: state.nextPackage.id,
  }
}

export async function handoffApprovedWorkPackages(
  taskId: string,
  options: { claimEnabled?: boolean } = {},
): Promise<WorkPackageHandoffResult> {
  const state = await loadHandoffState(taskId)

  if (state.packages.length === 0) {
    return { status: 'no_work_packages', readyPackageIds: [], claimedPackageId: null }
  }

  const now = new Date()

  for (const packageId of state.readyPackageIds) {
    const [updated] = await db
      .update(workPackages)
      .set({ blockedReason: null, status: 'ready', updatedAt: now })
      .where(and(eq(workPackages.id, packageId), inArray(workPackages.status, ['pending', 'needs_rework', 'blocked'])))
      .returning({ id: workPackages.id })

    if (updated) {
      await publishTaskEvent(taskId, 'work_package:status', {
        status: 'ready',
        updatedAt: now.toISOString(),
        workPackageId: packageId,
      })
    }
  }

  if (state.alreadyRunningPackage) {
    return {
      status: 'already_handed_off',
      readyPackageIds: state.readyPackageIds,
      claimedPackageId: state.alreadyRunningPackage.id,
    }
  }

  const claimEnabled = options.claimEnabled ?? isWorkPackageHandoffEnabled()
  if (!claimEnabled) {
    return { status: 'ready_only', readyPackageIds: state.readyPackageIds, claimedPackageId: null }
  }

  const nextPackage = state.nextPackage
  if (!nextPackage) {
    return { status: 'no_ready_packages', readyPackageIds: state.readyPackageIds, claimedPackageId: null }
  }

  const broker = await assertWorkPackageMcpBrokerAllowsHandoff(taskId, nextPackage)
  if (broker.status === 'blocked') {
    return {
      status: 'blocked',
      readyPackageIds: state.readyPackageIds,
      claimedPackageId: null,
      blockedReason: broker.blockedReason,
    }
  }

  if (isWorkPackageExecutionEnabled()) {
    return executeReadyWorkPackage(taskId, nextPackage, state.readyPackageIds, { claimEnabled })
  }

  const handoffStartedAt = new Date()
  const handoffCompletedAt = new Date()
  const handoffArtifactContent = [
    `Forge handed off work package "${nextPackage.title}" to ${nextPackage.assignedRole}.`,
    '',
    'Repository writes and specialist model execution are disabled for this handoff slice.',
  ].join('\n')
  const handoffArtifactMetadata = {
    repositoryWrites: false,
    source: 'work-package-handoff',
    workPackageId: nextPackage.id,
  }
  const handoff = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(workPackages)
      .set({ status: 'running', blockedReason: null, updatedAt: new Date() })
      .where(and(eq(workPackages.id, nextPackage.id), eq(workPackages.status, 'ready')))
      .returning({ id: workPackages.id })

    if (!claimed) return null

    const [run] = await tx
      .insert(agentRuns)
      .values({
        taskId,
        workPackageId: nextPackage.id,
        harnessId: nextPackage.harnessId,
        agentType: 'handoff',
        stage: 'handoff',
        attemptNumber: 1,
        modelIdUsed: 'forge-handoff/no-op',
        status: 'completed',
        startedAt: handoffStartedAt,
        completedAt: handoffCompletedAt,
      })
      .returning()

    const [artifact] = await tx
      .insert(artifacts)
      .values({
        agentRunId: run.id,
        artifactType: 'log_output',
        content: handoffArtifactContent,
        metadata: handoffArtifactMetadata,
      })
      .returning()

    return { artifact, run }
  })

  if (!handoff) {
    return {
      status: 'already_handed_off',
      readyPackageIds: state.readyPackageIds,
      claimedPackageId: nextPackage.id,
    }
  }

  await publishTaskEvent(taskId, 'run:started', {
    agentType: 'handoff',
    runId: handoff.run.id,
    stage: 'handoff',
    workPackageId: nextPackage.id,
  })
  await publishTaskEvent(taskId, 'artifact:created', {
    id: handoff.artifact.id,
    artifactId: handoff.artifact.id,
    agentRunId: handoff.artifact.agentRunId,
    artifactType: handoff.artifact.artifactType,
    content: handoff.artifact.content,
    metadata: handoff.artifact.metadata,
    createdAt: handoff.artifact.createdAt,
    workPackageId: nextPackage.id,
  })
  const reviewGates = await materializeReviewGatesForWorkPackageCompletion({
    sourceAgentRunId: handoff.run.id,
    sourceArtifactId: handoff.artifact.id,
    taskId,
    workPackageId: nextPackage.id,
  })
  await publishTaskEvent(taskId, 'run:completed', {
    runId: handoff.run.id,
    stage: 'handoff',
    status: 'completed',
    workPackageId: nextPackage.id,
  })

  await publishTaskEvent(taskId, 'work_package:handoff', {
    assignedRole: nextPackage.assignedRole,
    harnessId: nextPackage.harnessId,
    repositoryWrites: false,
    runId: handoff.run.id,
    stage: 'handoff',
    status: reviewGates.packageStatus ?? 'running',
    title: nextPackage.title,
    updatedAt: new Date().toISOString(),
    workPackageId: nextPackage.id,
  })

  await continueWorkforceAfterPackageCompletion(taskId, reviewGates.packageStatus, {
    claimEnabled,
  })

  return {
    status: 'handed_off',
    readyPackageIds: state.readyPackageIds,
    claimedPackageId: nextPackage.id,
  }
}

async function executeReadyWorkPackage(
  taskId: string,
  nextPackage: HandoffPackage,
  readyPackageIds: string[],
  options: { claimEnabled?: boolean } = {},
): Promise<WorkPackageHandoffResult> {
  const [claimed] = await db
    .update(workPackages)
    .set({ status: 'running', blockedReason: null, updatedAt: new Date() })
    .where(and(eq(workPackages.id, nextPackage.id), eq(workPackages.status, 'ready')))
    .returning({ id: workPackages.id })

  if (!claimed) {
    return {
      status: 'already_handed_off',
      readyPackageIds,
      claimedPackageId: nextPackage.id,
    }
  }

  await publishTaskEvent(taskId, 'work_package:status', {
    status: 'running',
    updatedAt: new Date().toISOString(),
    workPackageId: nextPackage.id,
  })

  let context: Awaited<ReturnType<typeof loadWorkPackageExecutionContext>>
  try {
    context = await loadWorkPackageExecutionContext(taskId, nextPackage.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failedAt = new Date()
    await db
      .update(workPackages)
      .set({
        blockedReason: message,
        status: 'failed',
        updatedAt: failedAt,
      })
      .where(eq(workPackages.id, nextPackage.id))
    await publishTaskEvent(taskId, 'work_package:status', {
      blockedReason: message,
      status: 'failed',
      updatedAt: failedAt.toISOString(),
      workPackageId: nextPackage.id,
    })
    throw err
  }
  const startedAt = new Date()
  const [run] = await db
    .insert(agentRuns)
    .values({
      taskId,
      workPackageId: nextPackage.id,
      harnessId: nextPackage.harnessId,
      agentType: nextPackage.assignedRole,
      stage: 'implementation',
      attemptNumber: 1,
      modelIdUsed: context.modelIdUsed,
      status: 'running',
      startedAt,
    })
    .returning()

  await publishTaskEvent(taskId, 'run:started', {
    agentType: nextPackage.assignedRole,
    runId: run.id,
    stage: 'implementation',
    workPackageId: nextPackage.id,
  })

  let repositoryContext: RepositoryExecutionContext | null = null
  let repositoryAffecting = false
  let validationStatusForPackage: string | null = null

  try {
    repositoryAffecting = isRepositoryAffectingWorkPackage(context.workPackage)
    if (repositoryAffecting) {
      repositoryContext = await buildRepositoryExecutionContext({
        project: context.project,
        task: context.task,
        validatedProjectRoot: context.validatedProjectRoot,
        workPackage: context.workPackage,
      })

      await upsertRepositoryEvidenceRecord({
        agentRunId: run.id,
        context: repositoryContext,
        taskId,
        workPackageId: nextPackage.id,
      })

      await createPackageArtifact({
        agentRunId: run.id,
        artifactType: 'log_output',
        content: repositoryReadinessContent(repositoryContext),
        metadata: {
          ...repositoryContextMetadata(repositoryContext),
          artifactKind: 'repository_readiness_summary',
          source: 'repository-evidence',
          workPackageId: nextPackage.id,
        },
        taskId,
        workPackageId: nextPackage.id,
      })

      if (repositoryContext.status === 'blocked') {
        throw new Error(`Repository evidence blocked: ${repositoryContext.blockedReason}`)
      }
    }

    const execution = await executeWorkPackage(context)
    let diffSummary: string | null = null

    if (repositoryAffecting && repositoryContext?.projectLocalPath) {
      const diffResult = await runScopedRepositoryCommand({
        cwd: repositoryContext.projectLocalPath,
        command: 'git',
        argv: ['diff', '--stat', 'HEAD', '--'],
      })
      diffSummary = diffResult.outputSummary || 'No tracked-file diff detected.'
      const diffArtifact = await createPackageArtifact({
        agentRunId: run.id,
        artifactType: 'file_diff',
        content: diffSummary,
        metadata: {
          artifactKind: 'repository_diff_summary',
          command: ['git', 'diff', '--stat', 'HEAD', '--'],
          exitCode: diffResult.exitCode,
          riskClass: diffResult.riskClass,
          source: 'repository-evidence',
          workPackageId: nextPackage.id,
        },
        taskId,
        workPackageId: nextPackage.id,
      })
      await recordScopedCommandAudit({
        result: diffResult,
        taskId,
        workPackageId: nextPackage.id,
        agentRunId: run.id,
        artifactId: diffArtifact.id,
      })
    }

    if (repositoryAffecting && repositoryContext) {
      const validationStatus = execution.commandResults.length === 0
        ? 'skipped'
        : execution.commandResults.every((result) => result.exitCode === 0)
          ? 'passed'
          : 'failed'
      const repositoryEvidenceStatus = validationStatus === 'passed'
        ? 'complete'
        : validationStatus === 'skipped'
          ? 'validation_skipped'
          : 'failed'
      await createPackageArtifact({
        agentRunId: run.id,
        artifactType: 'test_report',
        content: validationContent(execution.commandResults),
        metadata: {
          artifactKind: 'validation_output_summary',
          source: 'work-package-executor',
          validationStatus,
          workPackageId: nextPackage.id,
        },
        taskId,
        workPackageId: nextPackage.id,
      })
      await createPackageArtifact({
        agentRunId: run.id,
        artifactType: 'log_output',
        content: `Final validation status: ${validationStatus}`,
        metadata: {
          artifactKind: 'final_validation_status',
          source: 'repository-evidence',
          validationStatus,
          workPackageId: nextPackage.id,
        },
        taskId,
        workPackageId: nextPackage.id,
      })
      validationStatusForPackage = validationStatus
      await upsertRepositoryEvidenceRecord({
        agentRunId: run.id,
        context: { ...repositoryContext, status: repositoryEvidenceStatus },
        diffSummary,
        status: repositoryEvidenceStatus,
        taskId,
        validationStatus,
        workPackageId: nextPackage.id,
      })
    }

    if (repositoryAffecting && validationStatusForPackage === 'skipped') {
      throw new Error('Repository-affecting package did not run validation commands; review or revise the execution plan before continuing.')
    }

    const completedAt = new Date()
    await db
      .update(agentRuns)
      .set({ completedAt, status: 'completed' })
      .where(eq(agentRuns.id, run.id))

    const [artifact] = await db
      .insert(artifacts)
      .values({
        agentRunId: run.id,
        artifactType: 'log_output',
        content: execution.artifactContent,
        metadata: {
          ...execution.artifactMetadata,
          source: 'work-package-executor',
          workPackageId: nextPackage.id,
        },
      })
      .returning()

    await publishTaskEvent(taskId, 'artifact:created', {
      id: artifact.id,
      artifactId: artifact.id,
      agentRunId: artifact.agentRunId,
      artifactType: artifact.artifactType,
      content: artifact.content,
      metadata: artifact.metadata,
      createdAt: artifact.createdAt,
      workPackageId: nextPackage.id,
    })

    const reviewGates = await materializeReviewGatesForWorkPackageCompletion({
      sourceAgentRunId: run.id,
      sourceArtifactId: artifact.id,
      taskId,
      workPackageId: nextPackage.id,
    })

    await publishTaskEvent(taskId, 'run:completed', {
      runId: run.id,
      stage: 'implementation',
      status: 'completed',
      workPackageId: nextPackage.id,
    })

    await publishTaskEvent(taskId, 'work_package:handoff', {
      assignedRole: nextPackage.assignedRole,
      harnessId: nextPackage.harnessId,
      repositoryWrites: true,
      runId: run.id,
      sandboxPath: execution.sandboxPath,
      stage: 'implementation',
      status: reviewGates.packageStatus ?? 'running',
      title: nextPackage.title,
      updatedAt: new Date().toISOString(),
      workPackageId: nextPackage.id,
    })

    await continueWorkforceAfterPackageCompletion(taskId, reviewGates.packageStatus, options)

    return {
      status: 'handed_off',
      readyPackageIds,
      claimedPackageId: nextPackage.id,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failedAt = new Date()
    if (repositoryAffecting && repositoryContext && validationStatusForPackage !== 'skipped') {
      const evidenceStatus = repositoryContext.status === 'blocked'
        ? 'blocked'
        : 'failed'
      const validationStatus = validationStatusForPackage ?? 'failed'
      await upsertRepositoryEvidenceRecord({
        agentRunId: run.id,
        context: { ...repositoryContext, blockedReason: message, status: evidenceStatus },
        status: evidenceStatus,
        taskId,
        validationStatus,
        workPackageId: nextPackage.id,
      })
      await createPackageArtifact({
        agentRunId: run.id,
        artifactType: 'log_output',
        content: `Repository evidence failed: ${message}`,
        metadata: {
          artifactKind: 'repository_evidence_failure',
          source: 'repository-evidence',
          validationStatus,
          workPackageId: nextPackage.id,
        },
        taskId,
        workPackageId: nextPackage.id,
      })
    }
    await db
      .update(agentRuns)
      .set({
        completedAt: failedAt,
        errorMessage: message,
        status: 'failed',
      })
      .where(eq(agentRuns.id, run.id))
    await db
      .update(workPackages)
      .set({
        blockedReason: message,
        status: 'failed',
        updatedAt: failedAt,
      })
      .where(eq(workPackages.id, nextPackage.id))

    const [artifact] = await db
      .insert(artifacts)
      .values({
        agentRunId: run.id,
        artifactType: 'log_output',
        content: `Work package execution failed.\n\n${message}`,
        metadata: {
          errorMessage: message,
          repositoryWrites: false,
          source: 'work-package-executor',
          workPackageId: nextPackage.id,
        },
      })
      .returning()

    await publishTaskEvent(taskId, 'run:failed', {
      errorMessage: message,
      runId: run.id,
      stage: 'implementation',
      workPackageId: nextPackage.id,
    })
    await publishTaskEvent(taskId, 'artifact:created', {
      id: artifact.id,
      artifactId: artifact.id,
      agentRunId: artifact.agentRunId,
      artifactType: artifact.artifactType,
      content: artifact.content,
      metadata: artifact.metadata,
      createdAt: artifact.createdAt,
      workPackageId: nextPackage.id,
    })
    await publishTaskEvent(taskId, 'work_package:status', {
      blockedReason: message,
      status: 'failed',
      updatedAt: failedAt.toISOString(),
      workPackageId: nextPackage.id,
    })
    throw err
  }
}
