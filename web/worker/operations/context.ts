import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { agentRuns, projects, taskAttempts, tasks, workPackages } from '@/db/schema'
import { operationFingerprint } from '@/lib/operations/contracts'
import { readEffectiveGrantState } from '@/lib/mcps/admission'
import { loadCurrentProjectFilesystemDecision } from '@/lib/mcps/filesystem-grant-reconciliation'
import { approvedEffectiveFilesystemCapabilities } from '@/lib/mcps/filesystem-grants'
import { assertProjectLocalPathForExecution } from '@/lib/projects/local-path'
import {
  executeOperation,
  type TrustedOperationContext,
} from './executor'
import { databaseOperationLedger } from './ledger'

type JoinedTaskProject = {
  taskId: string
  taskStatus: string
  taskUpdatedAt: Date
  projectId: string
  localPath: string | null
  grantDecisionRevision: bigint
  rootBindingRevision: bigint
  projectUpdatedAt: Date
  projectMcpConfig: unknown
}

export type TrustedOperationContextLoaderDependencies = {
  loadTaskProject: (taskId: string) => Promise<JoinedTaskProject | null>
  canonicalizeProjectRoot: (project: { id: string; localPath: string | null }) => Promise<string>
  loadProjectFilesystemDecision?: (projectId: string) => Promise<unknown>
  loadLinkedIds?: (input: {
    taskId: string
    workPackageId: string | null
    agentRunId: string | null
    taskAttemptId: string | null
  }) => Promise<{
    workPackageId: string | null
    workPackageMetadata: unknown | null
    workPackageUpdatedAt: Date | null
    agentRunId: string | null
    taskAttemptId: string | null
  } | null>
}

async function loadTaskProjectFromDatabase(taskId: string): Promise<JoinedTaskProject | null> {
  const [row] = await db
    .select({
      taskId: tasks.id,
      taskStatus: tasks.status,
      taskUpdatedAt: tasks.updatedAt,
      projectId: projects.id,
      localPath: projects.localPath,
      grantDecisionRevision: projects.grantDecisionRevision,
      rootBindingRevision: projects.rootBindingRevision,
      projectUpdatedAt: projects.updatedAt,
      projectMcpConfig: projects.mcpConfig,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.id, taskId))
    .limit(1)
  return row ?? null
}

async function loadLinkedIdsFromDatabase(input: {
  taskId: string
  workPackageId: string | null
  agentRunId: string | null
  taskAttemptId: string | null
}) {
  const [workPackageRows, agentRunRows, taskAttemptRows] = await Promise.all([
    input.workPackageId
      ? db.select({
        id: workPackages.id,
        taskId: workPackages.taskId,
        metadata: workPackages.metadata,
        updatedAt: workPackages.updatedAt,
      })
        .from(workPackages).where(eq(workPackages.id, input.workPackageId)).limit(1)
      : Promise.resolve([]),
    input.agentRunId
      ? db.select({ id: agentRuns.id, taskId: agentRuns.taskId, workPackageId: agentRuns.workPackageId })
        .from(agentRuns).where(eq(agentRuns.id, input.agentRunId)).limit(1)
      : Promise.resolve([]),
    input.taskAttemptId
      ? db.select({ id: taskAttempts.id, taskId: taskAttempts.taskId })
        .from(taskAttempts).where(eq(taskAttempts.id, input.taskAttemptId)).limit(1)
      : Promise.resolve([]),
  ])
  const workPackage = workPackageRows[0] ?? null
  const agentRun = agentRunRows[0] ?? null
  const taskAttempt = taskAttemptRows[0] ?? null
  if (
    (input.workPackageId && workPackage?.taskId !== input.taskId)
    || (input.agentRunId && agentRun?.taskId !== input.taskId)
    || (input.taskAttemptId && taskAttempt?.taskId !== input.taskId)
    || (input.workPackageId && input.agentRunId && agentRun?.workPackageId !== input.workPackageId)
  ) {
    return null
  }
  if (agentRun?.workPackageId && !input.workPackageId) {
    const [agentWorkPackage] = await db
      .select({
        taskId: workPackages.taskId,
        metadata: workPackages.metadata,
        updatedAt: workPackages.updatedAt,
      })
      .from(workPackages)
      .where(eq(workPackages.id, agentRun.workPackageId))
      .limit(1)
    if (agentWorkPackage?.taskId !== input.taskId) return null
    return {
      workPackageId: agentRun.workPackageId,
      workPackageMetadata: agentWorkPackage.metadata,
      workPackageUpdatedAt: agentWorkPackage.updatedAt,
      agentRunId: input.agentRunId,
      taskAttemptId: input.taskAttemptId,
    }
  }
  return {
    workPackageId: input.workPackageId ?? agentRun?.workPackageId ?? null,
    workPackageMetadata: workPackage?.metadata ?? null,
    workPackageUpdatedAt: workPackage?.updatedAt ?? null,
    agentRunId: input.agentRunId,
    taskAttemptId: input.taskAttemptId,
  }
}

const productionContextDependencies: TrustedOperationContextLoaderDependencies = {
  loadTaskProject: loadTaskProjectFromDatabase,
  canonicalizeProjectRoot: assertProjectLocalPathForExecution,
  loadProjectFilesystemDecision: loadCurrentProjectFilesystemDecision,
  loadLinkedIds: loadLinkedIdsFromDatabase,
}

/**
 * Loads task and project scope from PostgreSQL. Callers cannot supply or
 * override the project id, repository root, or project revisions.
 */
export type TrustedOperationContextInput = {
  taskId: string
  attemptKey: string
  workPackageId?: string | null
  agentRunId?: string | null
  taskAttemptId?: string | null
}

async function loadTrustedOperationContextWithDependencies(
  input: TrustedOperationContextInput,
  dependencies: TrustedOperationContextLoaderDependencies,
): Promise<TrustedOperationContext> {
  const joined = await dependencies.loadTaskProject(input.taskId)
  if (!joined || joined.taskId !== input.taskId) {
    throw new Error('Operation task and project context could not be resolved.')
  }
  if (joined.taskStatus !== 'approved' && joined.taskStatus !== 'running') {
    throw new Error('Deterministic operations require a current approved or running task.')
  }
  const projectRoot = joined.localPath?.trim()
    ? await dependencies.canonicalizeProjectRoot({ id: joined.projectId, localPath: joined.localPath })
    : null
  const requestedLinks = {
    taskId: input.taskId,
    workPackageId: input.workPackageId ?? null,
    agentRunId: input.agentRunId ?? null,
    taskAttemptId: input.taskAttemptId ?? null,
  }
  const hasLinkedId = Boolean(requestedLinks.workPackageId || requestedLinks.agentRunId || requestedLinks.taskAttemptId)
  const linked = hasLinkedId
    ? await dependencies.loadLinkedIds?.(requestedLinks) ?? null
    : {
      ...requestedLinks,
      workPackageMetadata: null,
      workPackageUpdatedAt: null,
    }
  if (!linked) throw new Error('Operation run links do not belong to the authoritative task context.')
  const projectFilesystemDecision = await dependencies.loadProjectFilesystemDecision?.(joined.projectId) ?? null
  const filesystemCapabilities = approvedEffectiveFilesystemCapabilities(linked.workPackageMetadata)
  const effectiveFilesystemGrant = readEffectiveGrantState(
    { metadata: linked.workPackageMetadata },
    {
      mcpConfig: joined.projectMcpConfig,
      filesystemGrantDecision: projectFilesystemDecision,
      rootBindingRevision: joined.rootBindingRevision,
    },
    ['filesystem.project.read'],
  )
  const repositoryReadAllowed = Boolean(
    linked.workPackageId
    && filesystemCapabilities.includes('filesystem.project.read')
    && effectiveFilesystemGrant.status === 'approved'
    && effectiveFilesystemGrant.grantMode === 'always_allow'
    && effectiveFilesystemGrant.coveredCapabilities.includes('filesystem.project.read'),
  )
  const policyVersion = operationFingerprint('authoritative-policy', {
    taskStatus: joined.taskStatus,
    taskRevision: joined.taskUpdatedAt.toISOString(),
    projectRevision: joined.projectUpdatedAt.toISOString(),
    grantDecisionRevision: joined.grantDecisionRevision.toString(),
    rootBindingRevision: joined.rootBindingRevision.toString(),
    projectMcpConfig: joined.projectMcpConfig,
    projectFilesystemDecision,
    workPackageId: linked.workPackageId,
    workPackageRevision: linked.workPackageUpdatedAt?.toISOString() ?? null,
    filesystemCapabilities,
  })

  return {
    taskId: joined.taskId,
    projectId: joined.projectId,
    attemptKey: input.attemptKey,
    projectRoot,
    rootBindingRevision: joined.rootBindingRevision.toString(),
    projectRevision: joined.projectUpdatedAt.toISOString(),
    workPackageId: linked.workPackageId,
    agentRunId: linked.agentRunId,
    taskAttemptId: linked.taskAttemptId,
    policy: {
      projectId: joined.projectId,
      scopedProjectId: joined.projectId,
      policyVersion,
      allowedCapabilities: [
        ...(repositoryReadAllowed ? ['filesystem.project.read'] : []),
      ],
      policyCeilings: {
        repository_read: repositoryReadAllowed,
      },
    },
  }
}

export function loadTrustedOperationContext(
  input: TrustedOperationContextInput,
): Promise<TrustedOperationContext> {
  return loadTrustedOperationContextWithDependencies(input, productionContextDependencies)
}

/** Dependency injection is exposed only for deterministic unit tests. */
export function loadTrustedOperationContextForTest(
  input: TrustedOperationContextInput,
  dependencies: TrustedOperationContextLoaderDependencies,
): Promise<TrustedOperationContext> {
  return loadTrustedOperationContextWithDependencies(input, dependencies)
}

/** Production entry point: authoritative context load followed by execution. */
export async function executeTrustedOperation(input: {
  request: unknown
  taskId: string
  attemptKey: string
  workPackageId?: string | null
  agentRunId?: string | null
  taskAttemptId?: string | null
}) {
  const { productionOperationAdapters } = await import('./production-adapters')
  const context = await loadTrustedOperationContext({
    taskId: input.taskId,
    attemptKey: input.attemptKey,
    workPackageId: input.workPackageId,
    agentRunId: input.agentRunId,
    taskAttemptId: input.taskAttemptId,
  })
  return executeOperation({
    request: input.request,
    context,
    dependencies: {
      adapters: productionOperationAdapters,
      ledger: databaseOperationLedger,
    },
  })
}
