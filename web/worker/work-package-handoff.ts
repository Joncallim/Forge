import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { agentRuns, artifacts, workPackageDependencies, workPackages } from '../db/schema'
import { publishTaskEvent } from './events'
import { materializeReviewGatesForWorkPackageCompletion } from './review-gates'
import {
  executeWorkPackage,
  loadWorkPackageExecutionContext,
} from './work-package-executor'

type HandoffPackage = {
  id: string
  assignedRole: string
  harnessId: string | null
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
      status: 'handed_off' | 'already_handed_off' | 'no_ready_packages' | 'ready_only'
      readyPackageIds: string[]
      claimedPackageId: string | null
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
    .filter((pkg) => pkg.status === 'pending' || pkg.status === 'needs_rework')
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
      sequence: workPackages.sequence,
      status: workPackages.status,
      title: workPackages.title,
    })
    .from(workPackages)
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
      .set({ status: 'ready', updatedAt: now })
      .where(and(eq(workPackages.id, packageId), inArray(workPackages.status, ['pending', 'needs_rework'])))
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

  if (isWorkPackageExecutionEnabled()) {
    return executeReadyWorkPackage(taskId, nextPackage, state.readyPackageIds)
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

  try {
    const execution = await executeWorkPackage(context)
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

    return {
      status: 'handed_off',
      readyPackageIds,
      claimedPackageId: nextPackage.id,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failedAt = new Date()
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
