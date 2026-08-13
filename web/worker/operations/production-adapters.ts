import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { projects, type Project } from '@/db/schema'
import { assertProjectLocalPathForExecution } from '@/lib/projects/local-path'
import {
  recordScopedCommandAudit,
  runScopedRepositoryCommand,
} from '@/worker/repository-evidence'
import {
  OperationAdapterExecutionError,
  type FixedOperationAdapters,
  type OperationAdapterExecution,
  type OperationAdapterResult,
  type TrustedOperationContext,
} from './executor'
import { loadTrustedOperationContext } from './context'

function assertNotAborted(execution: OperationAdapterExecution): void {
  if (execution.signal.aborted || Date.now() >= execution.deadline.getTime()) {
    throw new Error('Deterministic operation was aborted.')
  }
}

async function currentProject(context: TrustedOperationContext): Promise<Project> {
  const [project] = await db.select().from(projects).where(eq(projects.id, context.projectId)).limit(1)
  if (!project) throw new OperationAdapterExecutionError('authority_changed')
  if (
    project.rootBindingRevision.toString() !== context.rootBindingRevision
    || project.updatedAt.toISOString() !== context.projectRevision
  ) {
    throw new OperationAdapterExecutionError('authority_changed')
  }
  return project
}

async function assertCurrentAuthority(context: TrustedOperationContext): Promise<void> {
  const fresh = await loadTrustedOperationContext({
    taskId: context.taskId,
    attemptKey: context.attemptKey,
    workPackageId: context.workPackageId,
    agentRunId: context.agentRunId,
    taskAttemptId: context.taskAttemptId,
  })
  if (
    fresh.projectId !== context.projectId
    || fresh.projectRoot !== context.projectRoot
    || fresh.rootBindingRevision !== context.rootBindingRevision
    || fresh.projectRevision !== context.projectRevision
    || fresh.policy.policyVersion !== context.policy.policyVersion
    || fresh.policy.policyCeilings.repository_read !== true
    || !fresh.policy.allowedCapabilities.includes('filesystem.project.read')
  ) {
    throw new OperationAdapterExecutionError('authority_changed')
  }
}

async function repositoryRead(
  context: TrustedOperationContext,
  execution: OperationAdapterExecution,
  argv: string[],
): Promise<OperationAdapterResult> {
  assertNotAborted(execution)
  await assertCurrentAuthority(context)
  assertNotAborted(execution)
  const project = await currentProject(context)
  assertNotAborted(execution)
  if (!context.projectRoot) throw new OperationAdapterExecutionError('authority_changed')
  const currentRoot = await assertProjectLocalPathForExecution(project)
  assertNotAborted(execution)
  if (currentRoot !== context.projectRoot) {
    throw new OperationAdapterExecutionError('authority_changed')
  }
  const result = await runScopedRepositoryCommand({
    cwd: context.projectRoot,
    command: 'git',
    argv,
    signal: execution.signal,
  })
  const audit = await recordScopedCommandAudit({
    result,
    taskId: context.taskId,
    workPackageId: context.workPackageId,
    agentRunId: context.agentRunId,
  })
  if (execution.signal.aborted || Date.now() >= execution.deadline.getTime()) {
    throw new OperationAdapterExecutionError('cancelled', [audit.id])
  }
  if (result.exitCode !== 0) throw new OperationAdapterExecutionError('adapter_failed', [audit.id])
  return {
    output: { exitCode: result.exitCode, summary: result.outputSummary },
    evidenceRefs: [audit.id],
  }
}

export const productionOperationAdapters: FixedOperationAdapters = {
  repositoryStatusRead: (context, execution) => repositoryRead(
    context,
    execution,
    ['status', '--short'],
  ),
  repositoryDiffSummary: (context, execution) => repositoryRead(
    context,
    execution,
    ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--'],
  ),
  repositoryBranchRead: (context, execution) => repositoryRead(
    context,
    execution,
    ['branch', '--show-current'],
  ),
}
