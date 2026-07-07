import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  agentRuns,
  approvalGates,
  artifacts,
  projects,
  repositoryCommandAudits,
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
  isRetryableMcpBrokerBlock,
} from './mcp-execution-design'
import { buildMcpBrokerBlockMetadata } from './blocked-handoff-retry'
import {
  FILESYSTEM_GRANT_BLOCK_METADATA_KEY,
  isProjectFilesystemEffectivePhase,
  requiresFilesystemGrantApproval,
} from '../lib/mcps/filesystem-grants'
import { updateTaskStatusIfCurrent } from './task-state'
import {
  completeTaskIfReviewGatesSatisfied,
  materializeReviewGatesForWorkPackageCompletion,
  REVIEW_GATE_TYPES,
} from './review-gates'
import {
  executeWorkPackage,
  isArchitectReservedExecutionRole,
  loadWorkPackageExecutionContext,
  MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS,
  WorkPackageExecutionError,
  type WorkPackagePriorReviewContext,
} from './work-package-executor'
import {
  buildRepositoryExecutionContext,
  isRepositoryAffectingWorkPackage,
  runScopedRepositoryCommand,
  type RepositoryExecutionContext,
  type ScopedCommandResult,
} from './repository-evidence'
import { defaultOnFeatureFlagEnabled } from './feature-flags'
import { sanitizeWorkerMessage } from './redaction'
import { recordTaskLogBestEffort } from './task-logs'

type HandoffPackage = {
  id: string
  assignedRole: string
  blockedReason?: string | null
  harnessId: string | null
  mcpRequirements?: unknown
  metadata?: unknown
  sequence: number
  status: string
  title: string
  updatedAt?: Date | null
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
type WorkPackageLeaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const MAX_PRIOR_REVIEW_SOURCE_ARTIFACTS = 10
const MAX_PRIOR_REVIEW_SOURCE_ARTIFACT_BYTES = 2 * 1024
const DEFAULT_STALE_RUNNING_PACKAGE_SECONDS = 15 * 60
const DEFAULT_EXECUTION_LEASE_HEARTBEAT_SECONDS = 60

class ExecutionLeaseLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionLeaseLostError'
  }
}

class RepositoryEvidenceBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryEvidenceBlockedError'
  }
}

type ExecutionLease = {
  acquiredAt: string
  attemptNumber: number
  heartbeatAt: string
  runId: string
  source: 'work-package-handoff'
  staleAfterSeconds: number
}

type HandoffOptions = {
  claimEnabled?: boolean
  finalAttempt?: boolean
  staleRecoveryAttempted?: boolean
}

async function publishTaskEventBestEffort(
  taskId: string,
  type: Parameters<typeof publishTaskEvent>[1],
  payload: Parameters<typeof publishTaskEvent>[2],
): Promise<void> {
  try {
    await publishTaskEvent(taskId, type, payload)
  } catch (err) {
    const message = sanitizeWorkerMessage(err instanceof Error ? err.message : String(err))
    console.warn(`Failed to publish task event ${type} for ${taskId}: ${message}`)
  }
}

async function continueWorkforceAfterPackageCompletionOrThrow(
  taskId: string,
  packageStatus: 'awaiting_review' | 'completed' | null,
  options: HandoffOptions,
): Promise<WorkPackageHandoffResult | null> {
  return continueWorkforceAfterPackageCompletion(taskId, packageStatus, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

async function withExecutionLease<T>(
  workPackageId: string,
  runId: string,
  write: (tx: WorkPackageLeaseTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .update(workPackages)
      .set({ updatedAt: new Date() })
      .where(and(
        eq(workPackages.id, workPackageId),
        eq(workPackages.status, 'running'),
        sql`${workPackages.metadata}->'executionLease'->>'runId' = ${runId}`,
      ))
      .returning({ id: workPackages.id })

    if (!owned) {
      throw new ExecutionLeaseLostError(`Work package execution lease for run ${runId} is no longer active.`)
    }

    return write(tx)
  })
}

async function createPackageArtifact(input: {
  agentRunId: string
  artifactType: string
  content: string
  executionLease?: { runId: string }
  metadata: Record<string, unknown>
  taskId: string
  workPackageId: string
}): Promise<CreatedArtifact> {
  const values = {
      agentRunId: input.agentRunId,
      artifactType: input.artifactType,
      content: input.content,
      metadata: input.metadata,
  }
  const insertArtifact = async (tx: Pick<WorkPackageLeaseTransaction, 'insert'>) => {
    const [artifact] = await tx
      .insert(artifacts)
      .values(values)
      .returning()
    return artifact
  }
  const artifact = input.executionLease
    ? await withExecutionLease(input.workPackageId, input.executionLease.runId, insertArtifact)
    : await insertArtifact(db)

  // Best-effort: the artifact is already committed (under the lease). A transient
  // event-bus failure here must not propagate and be misread as an execution
  // failure that fails/retries an otherwise successful package.
  await publishTaskEventBestEffort(input.taskId, 'artifact:created', {
    id: artifact.id,
    artifactId: artifact.id,
    agentRunId: artifact.agentRunId,
    artifactType: artifact.artifactType,
    content: artifact.content,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt,
    workPackageId: input.workPackageId,
  })

  await recordTaskLogBestEffort({
    agentRunId: input.agentRunId,
    artifactId: artifact.id,
    eventType: 'artifact.created',
    level: 'success',
    message: `Created ${artifact.artifactType} artifact ${artifact.id}.`,
    metadata: {
      artifactType: artifact.artifactType,
      metadata: artifact.metadata,
    },
    source: 'worker',
    taskId: input.taskId,
    title: 'Artifact created',
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
  executionLease?: { runId: string }
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

  const writeEvidence = async (tx: WorkPackageLeaseTransaction | typeof db) => {
    const [existing] = await tx
      .select({ id: vcsChanges.id })
      .from(vcsChanges)
      .where(and(eq(vcsChanges.taskId, input.taskId), eq(vcsChanges.workPackageId, input.workPackageId)))
      .limit(1)

    if (existing) {
      const [updated] = await tx
        .update(vcsChanges)
        .set(values)
        .where(eq(vcsChanges.id, existing.id))
        .returning({ id: vcsChanges.id })
      return updated.id
    }

    const [created] = await tx
      .insert(vcsChanges)
      .values(values)
      .returning({ id: vcsChanges.id })
    return created.id
  }

  return input.executionLease
    ? withExecutionLease(input.workPackageId, input.executionLease.runId, writeEvidence)
    : writeEvidence(db)
}

async function recordScopedCommandAuditWithLease(input: {
  agentRunId: string
  artifactId: string
  result: ScopedCommandResult
  runId: string
  taskId: string
  workPackageId: string
}): Promise<{ id: string }> {
  return withExecutionLease(input.workPackageId, input.runId, async (tx) => {
    const [row] = await tx
      .insert(repositoryCommandAudits)
      .values({
        agentRunId: input.agentRunId,
        artifactId: input.artifactId,
        argv: input.result.argv,
        command: input.result.command,
        cwd: input.result.cwd,
        exitCode: input.result.exitCode,
        finishedAt: input.result.finishedAt,
        outputSummary: input.result.outputSummary,
        riskClass: input.result.riskClass,
        startedAt: input.result.startedAt,
        taskId: input.taskId,
        workPackageId: input.workPackageId,
      })
      .returning({ id: repositoryCommandAudits.id })
    return row
  })
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
      terminalBlock?: boolean
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
  return defaultOnFeatureFlagEnabled(env.FORGE_WORK_PACKAGE_EXECUTION)
}

function staleRunningPackageSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FORGE_RUNNING_WORK_PACKAGE_STALE_SECONDS?.trim()
  if (!raw) return DEFAULT_STALE_RUNNING_PACKAGE_SECONDS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_RUNNING_PACKAGE_SECONDS
}

function executionLeaseHeartbeatSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FORGE_EXECUTION_LEASE_HEARTBEAT_SECONDS?.trim()
  if (!raw) return DEFAULT_EXECUTION_LEASE_HEARTBEAT_SECONDS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EXECUTION_LEASE_HEARTBEAT_SECONDS
}

function staleRunningPackageCutoff(now = new Date()): Date {
  return new Date(now.getTime() - staleRunningPackageSeconds() * 1000)
}

function executionLeaseFromMetadata(metadata: unknown): ExecutionLease | null {
  if (!isRecord(metadata) || !isRecord(metadata.executionLease)) return null
  const lease = metadata.executionLease
  if (
    typeof lease.runId !== 'string' ||
    typeof lease.attemptNumber !== 'number' ||
    typeof lease.acquiredAt !== 'string' ||
    typeof lease.heartbeatAt !== 'string'
  ) {
    return null
  }
  return {
    acquiredAt: lease.acquiredAt,
    attemptNumber: lease.attemptNumber,
    heartbeatAt: lease.heartbeatAt,
    runId: lease.runId,
    source: 'work-package-handoff',
    staleAfterSeconds: typeof lease.staleAfterSeconds === 'number'
      ? lease.staleAfterSeconds
      : staleRunningPackageSeconds(),
  }
}

function metadataWithoutExecutionLease(metadata: unknown): Record<string, unknown> {
  const clean = { ...(isRecord(metadata) ? metadata : {}) }
  delete clean.executionLease
  return clean
}

function executionLeaseMetadata(input: {
  attemptNumber: number
  metadata: unknown
  now: Date
  runId: string
}): Record<string, unknown> {
  return {
    ...metadataWithoutExecutionLease(input.metadata),
    executionLease: {
      acquiredAt: input.now.toISOString(),
      attemptNumber: input.attemptNumber,
      heartbeatAt: input.now.toISOString(),
      runId: input.runId,
      source: 'work-package-handoff',
      staleAfterSeconds: staleRunningPackageSeconds(),
    } satisfies ExecutionLease,
  }
}

function isStaleRunningPackage(pkg: HandoffPackage, now = new Date()): boolean {
  if (pkg.status !== 'running') return false
  const lease = executionLeaseFromMetadata(pkg.metadata)
  const heartbeatAt = lease ? new Date(lease.heartbeatAt) : pkg.updatedAt
  return heartbeatAt instanceof Date &&
    Number.isFinite(heartbeatAt.getTime()) &&
    heartbeatAt.getTime() <= staleRunningPackageCutoff(now).getTime()
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
      blockedReason: workPackages.blockedReason,
      harnessId: workPackages.harnessId,
      mcpRequirements: workPackages.mcpRequirements,
      metadata: workPackages.metadata,
      sequence: workPackages.sequence,
      status: workPackages.status,
      title: workPackages.title,
      updatedAt: workPackages.updatedAt,
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

async function loadTaskProjectForMcpBroker(taskId: string) {
  const [row] = await db
    .select({ project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.id, taskId))
    .limit(1)

  return row?.project ?? null
}

async function recoverStaleRunningPackage(taskId: string, pkg: HandoffPackage): Promise<boolean> {
  if (!isStaleRunningPackage(pkg)) return false

  const recoveredAt = new Date()
  const cutoff = staleRunningPackageCutoff(recoveredAt)
  const blockedReason = `Recovered stale running work package "${pkg.title}" after the worker lost its execution lease. The next handoff retry will start a new attempt.`
  const metadata = {
    ...metadataWithoutExecutionLease(pkg.metadata),
    staleRunningRecovery: {
      recoveredAt: recoveredAt.toISOString(),
      reason: blockedReason,
      source: 'work-package-handoff',
      staleAfterSeconds: staleRunningPackageSeconds(),
      status: 'blocked',
    },
  }
  const lease = executionLeaseFromMetadata(pkg.metadata)
  const [run] = await db
    .select({
      attemptNumber: agentRuns.attemptNumber,
      id: agentRuns.id,
      stage: agentRuns.stage,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.taskId, taskId),
        eq(agentRuns.workPackageId, pkg.id),
        eq(agentRuns.status, 'running'),
        ...(lease ? [eq(agentRuns.id, lease.runId)] : []),
      ),
    )
    .orderBy(desc(agentRuns.startedAt), desc(agentRuns.createdAt))
    .limit(1)

  const [recovered] = await db
    .update(workPackages)
    .set({
      blockedReason,
      metadata,
      status: 'blocked',
      updatedAt: recoveredAt,
    })
    .where(and(
      eq(workPackages.id, pkg.id),
      eq(workPackages.status, 'running'),
      lte(workPackages.updatedAt, cutoff),
      ...(lease ? [sql`${workPackages.metadata}->'executionLease'->>'runId' = ${lease.runId}`] : []),
    ))
    .returning({ id: workPackages.id })

  if (!recovered) return false

  if (run) {
    await db
      .update(agentRuns)
      .set({
        completedAt: recoveredAt,
        errorMessage: blockedReason,
        status: 'failed',
      })
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'running')))

    await publishTaskEvent(taskId, 'run:failed', {
      attemptNumber: run.attemptNumber,
      errorMessage: blockedReason,
      runId: run.id,
      stage: run.stage,
      workPackageId: pkg.id,
    })
  }

  await publishTaskEvent(taskId, 'work_package:status', {
    blockedReason,
    staleRunningRecovery: metadata.staleRunningRecovery,
    status: 'blocked',
    updatedAt: recoveredAt.toISOString(),
    workPackageId: pkg.id,
  })

  return true
}

async function executionLeaseOwned(workPackageId: string, runId: string): Promise<boolean> {
  const [pkg] = await db
    .select({
      metadata: workPackages.metadata,
      status: workPackages.status,
    })
    .from(workPackages)
    .where(eq(workPackages.id, workPackageId))
    .limit(1)

  return pkg?.status === 'running' && executionLeaseFromMetadata(pkg.metadata)?.runId === runId
}

async function assertExecutionLeaseOwned(workPackageId: string, runId: string): Promise<void> {
  if (await executionLeaseOwned(workPackageId, runId)) return
  throw new ExecutionLeaseLostError(`Work package execution lease for run ${runId} is no longer active.`)
}

function startExecutionLeaseHeartbeat(input: {
  attemptNumber: number
  runId: string
  taskId: string
  workPackageId: string
}): { stop: () => void } {
  const heartbeatMs = executionLeaseHeartbeatSeconds() * 1000
  const beat = async () => {
    const heartbeatAt = new Date()
    await db
      .update(workPackages)
      .set({
        metadata: sql`jsonb_set(${workPackages.metadata}, '{executionLease,heartbeatAt}', to_jsonb(${heartbeatAt.toISOString()}::text), true)`,
        updatedAt: heartbeatAt,
      })
      .where(and(
        eq(workPackages.id, input.workPackageId),
        eq(workPackages.status, 'running'),
        sql`${workPackages.metadata}->'executionLease'->>'runId' = ${input.runId}`,
      ))
  }
  const timer = setInterval(() => {
    beat().catch((err) => {
      const message = sanitizeWorkerMessage(err instanceof Error ? err.message : String(err))
      console.warn(`Failed to heartbeat work package lease ${input.workPackageId}: ${message}`)
    })
  }, heartbeatMs)
  timer.unref?.()
  return {
    stop: () => clearInterval(timer),
  }
}

async function abandonLostExecutionLease(input: {
  attemptNumber: number
  readyPackageIds: string[]
  runId: string
  taskId: string
  workPackageId: string
}): Promise<WorkPackageHandoffResult> {
  const failedAt = new Date()
  const message = `Work package execution lease for run ${input.runId} is no longer active; ignoring stale completion.`
  const [updatedRun] = await db
    .update(agentRuns)
    .set({
      completedAt: failedAt,
      errorMessage: message,
      status: 'failed',
    })
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.status, 'running')))
    .returning({ id: agentRuns.id })
  if (updatedRun) {
    await publishTaskEvent(input.taskId, 'run:failed', {
      attemptNumber: input.attemptNumber,
      errorMessage: message,
      runId: input.runId,
      stage: 'implementation',
      workPackageId: input.workPackageId,
    })
  }
  return {
    status: 'already_handed_off',
    readyPackageIds: input.readyPackageIds,
    claimedPackageId: input.workPackageId,
  }
}

async function failWorkPackageForMcpBroker(input: {
  blocked: string[]
  blockedReason: string
  pkg: HandoffPackage
  taskId: string
  warnings: string[]
}): Promise<{ blockedReason: string; status: 'blocked' } | { status: 'allowed' }> {
  const blockedAt = new Date()
  const retryable = isRetryableMcpBrokerBlock(input.blocked)
  const metadata = buildMcpBrokerBlockMetadata({
    blocked: input.blocked,
    blockedAt,
    blockedReason: input.blockedReason,
    existingMetadata: input.pkg.metadata,
    retryable,
    warnings: input.warnings,
  })
  const [blockedRow] = await db
    .update(workPackages)
    .set({
      blockedReason: input.blockedReason,
      metadata,
      status: 'blocked',
      updatedAt: blockedAt,
    })
    .where(and(eq(workPackages.id, input.pkg.id), inArray(workPackages.status, ['pending', 'ready', 'needs_rework', 'blocked'])))
    .returning({ id: workPackages.id })

  // A concurrent actor moved the package out of a blockable state (e.g. it was
  // already claimed and is running). Don't emit a spurious blocked event or
  // revert the task — the later ready→running claim guards correctness anyway.
  if (!blockedRow) return { status: 'allowed' }

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

  if (input.warnings.length > 0) {
    await recordTaskLogBestEffort({
      eventType: 'mcp.warning',
      level: 'warning',
      message: `MCP broker warnings for "${input.pkg.title}": ${input.warnings.join('; ')}`,
      metadata: {
        blocked: input.blocked,
        warnings: input.warnings,
      },
      source: 'mcp',
      taskId: input.taskId,
      title: 'MCP broker warning',
      workPackageId: input.pkg.id,
    })
  }

  return { blockedReason: input.blockedReason, status: 'blocked' }
}

function architectReservedHandoffBlockedReason(pkg: HandoffPackage): string | null {
  if (!isArchitectReservedExecutionRole(pkg.assignedRole)) return null
  if (!isRecord(pkg.metadata) || pkg.metadata.source !== 'architect-artifact') return null
  return `Architect-assigned "${pkg.assignedRole}" work packages are reserved for review gates and cannot execute.`
}

// Hold a package that still needs explicit filesystem grant approval BEFORE it is
// claimed for execution. Without this, plan approval (which never issues an
// effective filesystem grant) would let the package be claimed and run, and the
// executor would throw a guaranteed "context blocked" error on every attempt —
// burning the whole implementation attempt budget on failed runs and leaving no
// budget for the corrected run after the operator approves the grant. Failing
// here creates no agent run and consumes no attempt, so the recovery run starts
// fresh at attempt 1 once the grant is approved.
async function failWorkPackageForFilesystemGrant(input: {
  blockedReason: string
  missingCapabilities: string[]
  pkg: HandoffPackage
  requestedCapabilities: string[]
  taskId: string
}): Promise<{ blockedReason: string; status: 'blocked'; terminalBlock: true } | { status: 'allowed' }> {
  const failedAt = new Date()
  const metadata = {
    ...(isRecord(input.pkg.metadata) ? input.pkg.metadata : {}),
    [FILESYSTEM_GRANT_BLOCK_METADATA_KEY]: {
      blockedAt: failedAt.toISOString(),
      missingCapabilities: input.missingCapabilities,
      reason: input.blockedReason,
      requestedCapabilities: input.requestedCapabilities,
      source: 'filesystem-grant-approval',
      status: 'failed',
    },
  }
  const [failedRow] = await db
    .update(workPackages)
    .set({
      blockedReason: input.blockedReason,
      metadata,
      status: 'failed',
      updatedAt: failedAt,
    })
    .where(and(eq(workPackages.id, input.pkg.id), inArray(workPackages.status, ['pending', 'ready', 'needs_rework', 'blocked'])))
    .returning({ id: workPackages.id })

  if (!failedRow) return { status: 'allowed' }

  await publishTaskEvent(input.taskId, 'work_package:status', {
    blockedReason: input.blockedReason,
    mcpGrantBlock: {
      missingCapabilities: input.missingCapabilities,
      requestedCapabilities: input.requestedCapabilities,
      source: 'filesystem-grant-approval',
      status: 'failed',
    },
    status: 'failed',
    updatedAt: failedAt.toISOString(),
    workPackageId: input.pkg.id,
  })
  await recordTaskLogBestEffort({
    eventType: 'mcp.filesystem.grant_required',
    level: 'warning',
    message: `"${input.pkg.title}" needs filesystem grant approval before it can run: ${input.blockedReason}`,
    metadata: {
      missingCapabilities: input.missingCapabilities,
      requestedCapabilities: input.requestedCapabilities,
      workPackageId: input.pkg.id,
    },
    source: 'mcp',
    taskId: input.taskId,
    title: 'Filesystem grant required',
    workPackageId: input.pkg.id,
  })

  return { blockedReason: input.blockedReason, status: 'blocked', terminalBlock: true }
}

function packageProjectFilesystemEffectivePhase(pkg: HandoffPackage): Record<string, unknown> | null {
  const metadata = isRecord(pkg.metadata) ? pkg.metadata : {}
  const phases = isRecord(metadata.mcpGrantPhases) ? metadata.mcpGrantPhases : {}
  const effective = isRecord(phases.effective) ? phases.effective : null
  return isProjectFilesystemEffectivePhase(effective) ? effective : null
}

async function filesystemGrantHandoffBlock(taskId: string, pkg: HandoffPackage): Promise<{
  blockedReason: string
  missingCapabilities: string[]
  requestedCapabilities: string[]
} | null> {
  if (packageProjectFilesystemEffectivePhase(pkg)) {
    const project = await loadTaskProjectForMcpBroker(taskId)
    const check = requiresFilesystemGrantApproval({
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      projectMcpConfig: project?.mcpConfig ?? null,
    })
    if (!check.blocked) return null
    return {
      blockedReason: `Work package "${pkg.title}" was covered by a project-level filesystem grant, but that project grant was removed or no longer covers ${check.missingCapabilities.join(', ')}. Approve filesystem context again before execution.`,
      missingCapabilities: check.missingCapabilities,
      requestedCapabilities: check.requestedCapabilities,
    }
  }

  const check = requiresFilesystemGrantApproval({
    mcpRequirements: pkg.mcpRequirements,
    metadata: pkg.metadata,
  })
  if (!check.blocked) return null
  return {
    blockedReason: `Work package "${pkg.title}" requires filesystem grant approval for ${check.missingCapabilities.join(', ')} before execution. Approve filesystem context for this package, then re-run the task.`,
    missingCapabilities: check.missingCapabilities,
    requestedCapabilities: check.requestedCapabilities,
  }
}

async function failWorkPackageForReservedRole(input: {
  blockedReason: string
  pkg: HandoffPackage
  taskId: string
}): Promise<{ blockedReason: string; status: 'blocked'; terminalBlock: true } | { status: 'allowed' }> {
  const failedAt = new Date()
  const metadata = {
    ...(isRecord(input.pkg.metadata) ? input.pkg.metadata : {}),
    handoffSafety: {
      blockedAt: failedAt.toISOString(),
      reason: input.blockedReason,
      source: 'architect-reserved-role',
      status: 'failed',
    },
  }
  const [failedRow] = await db
    .update(workPackages)
    .set({
      blockedReason: input.blockedReason,
      metadata,
      status: 'failed',
      updatedAt: failedAt,
    })
    .where(and(eq(workPackages.id, input.pkg.id), inArray(workPackages.status, ['pending', 'ready', 'needs_rework', 'blocked'])))
    .returning({ id: workPackages.id })

  if (!failedRow) return { status: 'allowed' }

  await publishTaskEvent(input.taskId, 'work_package:status', {
    blockedReason: input.blockedReason,
    handoffSafety: {
      source: 'architect-reserved-role',
      status: 'failed',
    },
    status: 'failed',
    updatedAt: failedAt.toISOString(),
    workPackageId: input.pkg.id,
  })

  return { blockedReason: input.blockedReason, status: 'blocked', terminalBlock: true }
}

function numericAttemptNumber(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

async function nextImplementationAttemptNumber(taskId: string, workPackageId: string): Promise<number> {
  const priorRuns = await db
    .select({ attemptNumber: agentRuns.attemptNumber })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.taskId, taskId),
        eq(agentRuns.workPackageId, workPackageId),
        eq(agentRuns.stage, 'implementation'),
        isNotNull(agentRuns.attemptNumber),
      ),
    )
    .orderBy(desc(agentRuns.attemptNumber))

  const maxPriorAttempt = priorRuns.reduce(
    (max, run) => Math.max(max, numericAttemptNumber(run.attemptNumber)),
    0,
  )
  return maxPriorAttempt + 1
}

function attemptLimitFailureDetails(input: {
  attemptNumber: number
  pkg: HandoffPackage
}): {
  blockedReason: string
  failedAt: Date
  metadata: Record<string, unknown>
} {
  const failedAt = new Date()
  const blockedReason = `Work package "${input.pkg.title}" exceeded the maximum of ${MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS} implementation attempts.`
  const metadata = {
    ...(isRecord(input.pkg.metadata) ? input.pkg.metadata : {}),
    executionAttempts: {
      attemptedAt: failedAt.toISOString(),
      maxAttempts: MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS,
      nextAttemptNumber: input.attemptNumber,
      reason: blockedReason,
      source: 'work-package-handoff',
      status: 'failed',
    },
  }

  return { blockedReason, failedAt, metadata }
}

function cleanReviewReason(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, 1000)
}

function cleanPriorReviewSourceArtifactContent(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
  if (normalized === '') return ''
  return normalized.slice(0, MAX_PRIOR_REVIEW_SOURCE_ARTIFACT_BYTES)
}

async function loadPriorReviewContext(
  taskId: string,
  pkg: HandoffPackage,
): Promise<WorkPackagePriorReviewContext> {
  const rows = await db
    .select({
      id: approvalGates.id,
      gateType: approvalGates.gateType,
      metadata: approvalGates.metadata,
      sourceArtifactId: approvalGates.sourceArtifactId,
      status: approvalGates.status,
    })
    .from(approvalGates)
    .where(
      and(
        eq(approvalGates.taskId, taskId),
        eq(approvalGates.workPackageId, pkg.id),
        inArray(approvalGates.gateType, [...REVIEW_GATE_TYPES]),
      ),
    )
    .orderBy(desc(approvalGates.createdAt))
    .limit(10)

  const sourceArtifactIds = [...new Set(rows
    .map((row) => row.sourceArtifactId)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
  )].slice(0, MAX_PRIOR_REVIEW_SOURCE_ARTIFACTS)
  const sourceArtifactRows = sourceArtifactIds.length === 0
    ? []
    : await db
      .select({
        content: artifacts.content,
        id: artifacts.id,
      })
      .from(artifacts)
      .where(inArray(artifacts.id, sourceArtifactIds))
  const sourceArtifactContentById = new Map(
    sourceArtifactRows.map((artifact) => [
      artifact.id,
      cleanPriorReviewSourceArtifactContent(artifact.content),
    ]),
  )

  return {
    packageBlockedReason: pkg.blockedReason ?? null,
    notes: rows
      .map((row) => {
        const metadata = isRecord(row.metadata) ? row.metadata : {}
        const reason = cleanReviewReason(metadata.decisionReason ?? metadata.cancelledReason)
        const sourceArtifactContent = row.sourceArtifactId
          ? sourceArtifactContentById.get(row.sourceArtifactId) ?? ''
          : ''
        return {
          gateId: row.id,
          gateType: row.gateType,
          reason: [
            reason,
            sourceArtifactContent
              ? `Reviewed source artifact excerpt:\n${sourceArtifactContent}`
              : '',
          ].filter((line) => line !== '').join('\n'),
          sourceArtifactId: row.sourceArtifactId,
          status: row.status,
        }
      })
      .filter((note) => note.reason !== '' || note.status === 'needs_rework'),
  }
}

async function assertWorkPackageMcpBrokerAllowsHandoff(
  taskId: string,
  pkg: HandoffPackage,
): Promise<{ blockedReason: string; status: 'blocked'; terminalBlock?: boolean } | { status: 'allowed' }> {
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

  let check: ReturnType<typeof evaluateWorkPackageMcpBroker>
  try {
    const mcpOverview = await getProjectMcpOverview(project)
    check = evaluateWorkPackageMcpBroker({
      assignedRole: pkg.assignedRole,
      mcpOverview,
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      title: pkg.title,
    })
  } catch (err) {
    // The broker is the safety gate; an unexpected failure here must block the
    // package, never crash the handoff (which would terminally fail the task).
    const message = err instanceof Error ? err.message : String(err)
    const blockedReason = `MCP/capability broker blocked "${pkg.title}": evaluation failed (${message}).`
    return failWorkPackageForMcpBroker({
      blocked: [`Broker evaluation failed: ${message}`],
      blockedReason,
      pkg,
      taskId,
      warnings: [],
    })
  }

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

async function assertWorkPackageAllowsHandoff(
  taskId: string,
  pkg: HandoffPackage,
): Promise<{ blockedReason: string; status: 'blocked'; terminalBlock?: boolean } | { status: 'allowed' }> {
  const reservedRoleBlock = architectReservedHandoffBlockedReason(pkg)
  if (reservedRoleBlock) {
    return failWorkPackageForReservedRole({
      blockedReason: reservedRoleBlock,
      pkg,
      taskId,
    })
  }

  const filesystemGrantBlock = await filesystemGrantHandoffBlock(taskId, pkg)
  if (filesystemGrantBlock) {
    return failWorkPackageForFilesystemGrant({
      blockedReason: filesystemGrantBlock.blockedReason,
      missingCapabilities: filesystemGrantBlock.missingCapabilities,
      pkg,
      requestedCapabilities: filesystemGrantBlock.requestedCapabilities,
      taskId,
    })
  }

  return assertWorkPackageMcpBrokerAllowsHandoff(taskId, pkg)
}

export async function progressWorkforce(
  taskId: string,
  options: HandoffOptions = {},
): Promise<WorkPackageHandoffResult> {
  const result = await handoffApprovedWorkPackages(taskId, options)
  if (result.status === 'blocked' && result.terminalBlock) {
    const reason = result.blockedReason ?? 'Work package failed a terminal handoff safety check.'
    const failedRunning = await updateTaskStatusIfCurrent(taskId, 'running', 'failed', reason)
    if (!failedRunning) {
      await updateTaskStatusIfCurrent(taskId, 'approved', 'failed', reason)
    }
  }
  if (result.status === 'no_ready_packages' || result.status === 'no_work_packages') {
    await completeTaskIfReviewGatesSatisfied(taskId)
  }
  return result
}

async function continueWorkforceAfterPackageCompletion(
  taskId: string,
  packageStatus: string | null | undefined,
  options: HandoffOptions,
): Promise<WorkPackageHandoffResult | null> {
  if (packageStatus !== 'completed') return null
  const result = await progressWorkforce(taskId, options)
  return result.status === 'no_ready_packages' || result.status === 'no_work_packages'
    ? null
    : result
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
  options: HandoffOptions = {},
): Promise<WorkPackageHandoffResult> {
  const state = await loadHandoffState(taskId)
  if (state.alreadyRunningPackage && !options.staleRecoveryAttempted) {
    const recovered = await recoverStaleRunningPackage(taskId, state.alreadyRunningPackage)
    if (recovered) {
      return handoffApprovedWorkPackages(taskId, {
        ...options,
        staleRecoveryAttempted: true,
      })
    }
  }

  if (state.packages.length === 0) {
    return { status: 'no_work_packages', readyPackageIds: [], claimedPackageId: null }
  }

  const now = new Date()
  const newlyReadyPackageIds = new Set(state.readyPackageIds)
  const claimEnabled = options.claimEnabled ?? isWorkPackageHandoffEnabled()

  if (!claimEnabled) {
    const readyOnlyCandidates = state.packages.filter((pkg) =>
      newlyReadyPackageIds.has(pkg.id) || pkg.status === 'ready'
    )
    const allowedReadyPackageIds: string[] = []

    for (const readyPackage of readyOnlyCandidates) {
      const broker = await assertWorkPackageAllowsHandoff(taskId, readyPackage)
      if (broker.status === 'blocked') {
        await promoteReadyPackages(
          taskId,
          allowedReadyPackageIds.filter((id) => newlyReadyPackageIds.has(id)),
          now,
        )
        return {
          status: 'blocked',
          readyPackageIds: allowedReadyPackageIds,
          claimedPackageId: null,
          blockedReason: broker.blockedReason,
          terminalBlock: broker.terminalBlock,
        }
      }
      allowedReadyPackageIds.push(readyPackage.id)
    }

    await promoteReadyPackages(
      taskId,
      allowedReadyPackageIds.filter((id) => newlyReadyPackageIds.has(id)),
      now,
    )

    if (state.alreadyRunningPackage) {
      return {
        status: 'already_handed_off',
        readyPackageIds: allowedReadyPackageIds,
        claimedPackageId: state.alreadyRunningPackage.id,
      }
    }

    return { status: 'ready_only', readyPackageIds: allowedReadyPackageIds, claimedPackageId: null }
  }

  if (state.alreadyRunningPackage) {
    return {
      status: 'already_handed_off',
      readyPackageIds: state.readyPackageIds,
      claimedPackageId: state.alreadyRunningPackage.id,
    }
  }

  const nextPackage = state.nextPackage
  if (!nextPackage) {
    return { status: 'no_ready_packages', readyPackageIds: [], claimedPackageId: null }
  }

  const broker = await assertWorkPackageAllowsHandoff(taskId, nextPackage)
  if (broker.status === 'blocked') {
    return {
      status: 'blocked',
      readyPackageIds: [],
      claimedPackageId: null,
      blockedReason: broker.blockedReason,
      terminalBlock: broker.terminalBlock,
    }
  }

  const allowedReadyPackageIds = [nextPackage.id]
  await promoteReadyPackages(
    taskId,
    allowedReadyPackageIds.filter((id) => newlyReadyPackageIds.has(id)),
    now,
  )

  if (isWorkPackageExecutionEnabled()) {
    return executeReadyWorkPackage(taskId, nextPackage, allowedReadyPackageIds, {
      claimEnabled,
      finalAttempt: options.finalAttempt,
    })
  }

  const handoffStartedAt = new Date()
  const handoffCompletedAt = new Date()
  const handoffArtifactContent = [
    `Forge handed off work package "${nextPackage.title}" to ${nextPackage.assignedRole}.`,
    '',
    'Specialist model execution is disabled for this handoff slice.',
    'Unset FORGE_WORK_PACKAGE_EXECUTION=0 or set it to 1/true to run specialist package execution after approval.',
  ].join('\n')
  const handoffArtifactMetadata = {
    hostRepositoryWrites: false,
    repositoryWrites: false,
    sandboxWrites: false,
    source: 'work-package-handoff',
    workPackageId: nextPackage.id,
  }
  const handoff = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(workPackages)
      .set({
        status: 'running',
        blockedReason: null,
        metadata: metadataWithoutExecutionLease(nextPackage.metadata),
        updatedAt: handoffStartedAt,
      })
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
        status: 'running',
        startedAt: handoffStartedAt,
      })
      .returning()

    await tx
      .update(workPackages)
      .set({
        metadata: executionLeaseMetadata({
          attemptNumber: 1,
          metadata: nextPackage.metadata,
          now: handoffStartedAt,
          runId: run.id,
        }),
        updatedAt: handoffStartedAt,
      })
      .where(and(eq(workPackages.id, nextPackage.id), eq(workPackages.status, 'running')))

    return { run }
  })

  if (!handoff) {
    return {
      status: 'already_handed_off',
      readyPackageIds: allowedReadyPackageIds,
      claimedPackageId: nextPackage.id,
    }
  }

  await publishTaskEvent(taskId, 'run:started', {
    attemptNumber: 1,
    agentType: 'handoff',
    runId: handoff.run.id,
    stage: 'handoff',
    workPackageId: nextPackage.id,
  })
  await recordTaskLogBestEffort({
    agentRunId: handoff.run.id,
    eventType: 'run.started',
    frontMatter: {
      connector: 'forge-handoff/no-op',
      model: 'forge-handoff/no-op',
      prompt: `No-op handoff for ${nextPackage.assignedRole}: ${nextPackage.title}`,
    },
    level: 'info',
    message: `No-op handoff run started for "${nextPackage.title}".`,
    metadata: { attemptNumber: 1, assignedRole: nextPackage.assignedRole, stage: 'handoff' },
    source: 'worker',
    taskId,
    title: 'Handoff run started',
    workPackageId: nextPackage.id,
  })
  const reviewGates = await materializeReviewGatesForWorkPackageCompletion({
    completeSourceRun: {
      artifactType: 'log_output',
      completedAt: handoffCompletedAt,
      content: handoffArtifactContent,
      metadata: handoffArtifactMetadata,
    },
    requireExecutionLease: true,
    sourceAgentRunId: handoff.run.id,
    sourceArtifactId: null,
    taskId,
    workPackageId: nextPackage.id,
  })
  if (reviewGates.status === 'not_owned') {
    return abandonLostExecutionLease({
      attemptNumber: 1,
      readyPackageIds: allowedReadyPackageIds,
      runId: handoff.run.id,
      taskId,
      workPackageId: nextPackage.id,
    })
  }
  const handoffArtifact = reviewGates.sourceArtifact
  if (!handoffArtifact) throw new Error('No-op handoff completion did not create a source artifact.')
  const packageStatus = reviewGates.packageStatus
  await publishTaskEvent(taskId, 'artifact:created', {
    id: handoffArtifact.id,
    artifactId: handoffArtifact.id,
    agentRunId: handoffArtifact.agentRunId,
    artifactType: handoffArtifact.artifactType,
    content: handoffArtifact.content,
    metadata: handoffArtifact.metadata,
    createdAt: handoffArtifact.createdAt,
    workPackageId: nextPackage.id,
  })
  await publishTaskEvent(taskId, 'run:completed', {
    attemptNumber: 1,
    runId: handoff.run.id,
    stage: 'handoff',
    status: 'completed',
    workPackageId: nextPackage.id,
  })
  await recordTaskLogBestEffort({
    agentRunId: handoff.run.id,
    eventType: 'run.completed',
    frontMatter: {
      connector: 'forge-handoff/no-op',
      model: 'forge-handoff/no-op',
      prompt: `No-op handoff for ${nextPackage.assignedRole}: ${nextPackage.title}`,
    },
    level: 'success',
    message: `No-op handoff completed for "${nextPackage.title}".`,
    metadata: { attemptNumber: 1, stage: 'handoff' },
    source: 'worker',
    taskId,
    title: 'Handoff run completed',
    workPackageId: nextPackage.id,
  })

  await publishTaskEvent(taskId, 'work_package:handoff', {
    assignedRole: nextPackage.assignedRole,
    hostRepositoryWrites: false,
    harnessId: nextPackage.harnessId,
    repositoryWrites: false,
    runId: handoff.run.id,
    sandboxWrites: false,
    stage: 'handoff',
    status: packageStatus ?? 'running',
    title: nextPackage.title,
    updatedAt: new Date().toISOString(),
    workPackageId: nextPackage.id,
  })

  const continuation = await continueWorkforceAfterPackageCompletion(taskId, packageStatus, {
    claimEnabled,
    finalAttempt: options.finalAttempt,
  })
  if (continuation) return continuation

  return {
    status: 'handed_off',
    readyPackageIds: allowedReadyPackageIds,
    claimedPackageId: nextPackage.id,
  }
}

async function promoteReadyPackages(taskId: string, packageIds: string[], now: Date): Promise<void> {
  for (const packageId of packageIds) {
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
}

async function executeReadyWorkPackage(
  taskId: string,
  nextPackage: HandoffPackage,
  readyPackageIds: string[],
  options: HandoffOptions = {},
): Promise<WorkPackageHandoffResult> {
  const attemptNumber = await nextImplementationAttemptNumber(taskId, nextPackage.id)
  const claimedAt = new Date()
  const claim = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(workPackages)
      .set({
        status: 'running',
        blockedReason: null,
        metadata: metadataWithoutExecutionLease(nextPackage.metadata),
        updatedAt: claimedAt,
      })
      .where(and(eq(workPackages.id, nextPackage.id), eq(workPackages.status, 'ready')))
      .returning({ id: workPackages.id })

    if (!claimed) return { status: 'already_handed_off' as const }

    if (attemptNumber > MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS) {
      const attemptLimit = attemptLimitFailureDetails({ attemptNumber, pkg: nextPackage })
      const [failedPackage] = await tx
        .update(workPackages)
        .set({
          blockedReason: attemptLimit.blockedReason,
          metadata: attemptLimit.metadata,
          status: 'failed',
          updatedAt: attemptLimit.failedAt,
        })
        .where(and(eq(workPackages.id, nextPackage.id), eq(workPackages.status, 'running')))
        .returning({ id: workPackages.id })

      return {
        ...attemptLimit,
        failedPackageId: failedPackage?.id ?? null,
        status: 'attempt_limit' as const,
      }
    }

    const [run] = await tx
      .insert(agentRuns)
      .values({
        taskId,
        workPackageId: nextPackage.id,
        harnessId: nextPackage.harnessId,
        agentType: nextPackage.assignedRole,
        stage: 'implementation',
        attemptNumber,
        modelIdUsed: 'pending',
        status: 'running',
        startedAt: claimedAt,
      })
      .returning()

    await tx
      .update(workPackages)
      .set({
        metadata: executionLeaseMetadata({
          attemptNumber,
          metadata: nextPackage.metadata,
          now: claimedAt,
          runId: run.id,
        }),
        updatedAt: claimedAt,
      })
      .where(and(eq(workPackages.id, nextPackage.id), eq(workPackages.status, 'running')))

    return { run, status: 'claimed' as const }
  })

  if (claim.status === 'already_handed_off') {
    return {
      status: 'already_handed_off',
      readyPackageIds,
      claimedPackageId: nextPackage.id,
    }
  }

  if (claim.status === 'attempt_limit') {
    if (claim.failedPackageId) {
      await publishTaskEvent(taskId, 'work_package:status', {
        blockedReason: claim.blockedReason,
        executionAttempts: {
          maxAttempts: MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS,
          nextAttemptNumber: attemptNumber,
          status: 'failed',
        },
        status: 'failed',
        updatedAt: claim.failedAt.toISOString(),
        workPackageId: nextPackage.id,
      })
    }
    await updateTaskStatusIfCurrent(taskId, 'running', 'failed', claim.blockedReason)
    await updateTaskStatusIfCurrent(taskId, 'approved', 'failed', claim.blockedReason)
    return {
      blockedReason: claim.blockedReason,
      claimedPackageId: null,
      readyPackageIds: [],
      status: 'blocked',
      terminalBlock: true,
    }
  }

  const run = claim.run
  const heartbeat = startExecutionLeaseHeartbeat({
    attemptNumber,
    runId: run.id,
    taskId,
    workPackageId: nextPackage.id,
  })

  // Set when an inner catch has already recorded the package/run failure and is
  // re-throwing. The outer catch decides "lease lost" by re-reading the package
  // status, which the inner handler has already moved out of 'running'; without
  // this flag a genuine failure would be misclassified as a lost lease and
  // swallowed into a benign already_handed_off result.
  let packageFailureHandled = false

  try {
  await publishTaskEventBestEffort(taskId, 'work_package:status', {
    status: 'running',
    updatedAt: new Date().toISOString(),
    workPackageId: nextPackage.id,
  })

  let context: Awaited<ReturnType<typeof loadWorkPackageExecutionContext>>
  try {
    context = await loadWorkPackageExecutionContext(taskId, nextPackage.id)
  } catch (err) {
    if (!(await executionLeaseOwned(nextPackage.id, run.id))) {
      heartbeat.stop()
      return abandonLostExecutionLease({
        attemptNumber,
        readyPackageIds,
        runId: run.id,
        taskId,
        workPackageId: nextPackage.id,
      })
    }
    const message = sanitizeWorkerMessage(err instanceof Error ? err.message : String(err))
    const failedAt = new Date()
    const finalAttempt = options.finalAttempt ?? true
    const packageStatus = finalAttempt ? 'failed' : 'blocked'
    const blockedReason = finalAttempt
      ? message
      : `Retrying package execution after error: ${message}`
    const [failedPackage] = await db
      .update(workPackages)
      .set({
        blockedReason,
        metadata: metadataWithoutExecutionLease(nextPackage.metadata),
        status: packageStatus,
        updatedAt: failedAt,
      })
      .where(and(
        eq(workPackages.id, nextPackage.id),
        eq(workPackages.status, 'running'),
        sql`${workPackages.metadata}->'executionLease'->>'runId' = ${run.id}`,
      ))
      .returning({ id: workPackages.id })
    if (!failedPackage) {
      heartbeat.stop()
      return abandonLostExecutionLease({
        attemptNumber,
        readyPackageIds,
        runId: run.id,
        taskId,
        workPackageId: nextPackage.id,
      })
    }
    await publishTaskEventBestEffort(taskId, 'work_package:status', {
      blockedReason,
      status: packageStatus,
      updatedAt: failedAt.toISOString(),
      workPackageId: nextPackage.id,
    })
    await db
      .update(agentRuns)
      .set({
        completedAt: failedAt,
        errorMessage: message,
        status: 'failed',
      })
      .where(eq(agentRuns.id, run.id))
    await publishTaskEventBestEffort(taskId, 'run:failed', {
      attemptNumber,
      errorMessage: message,
      runId: run.id,
      stage: 'implementation',
      workPackageId: nextPackage.id,
    })
    heartbeat.stop()
    packageFailureHandled = true
    throw err
  }

  try {
    await db
      .update(agentRuns)
      .set({ modelIdUsed: context.modelIdUsed })
      .where(eq(agentRuns.id, run.id))
  } catch (err) {
    heartbeat.stop()
    throw err
  }

  await publishTaskEventBestEffort(taskId, 'run:started', {
    attemptNumber,
    agentType: nextPackage.assignedRole,
    runId: run.id,
    stage: 'implementation',
    workPackageId: nextPackage.id,
  })
  await recordTaskLogBestEffort({
    agentRunId: run.id,
    eventType: 'run.started',
    level: 'info',
    message: `Implementation run started for "${nextPackage.title}".`,
    metadata: { attemptNumber, assignedRole: nextPackage.assignedRole, stage: 'implementation' },
    source: 'worker',
    taskId,
    title: 'Implementation run started',
    workPackageId: nextPackage.id,
  })

  let repositoryContext: RepositoryExecutionContext | null = null
  let repositoryAffecting = false
  let executionLeaseReleased = false
  let validationStatusForPackage: string | null = null
  const assertActiveExecutionLease = () => assertExecutionLeaseOwned(nextPackage.id, run.id)

  try {
    repositoryAffecting = isRepositoryAffectingWorkPackage(context.workPackage)
    if (repositoryAffecting) {
      repositoryContext = await buildRepositoryExecutionContext({
        project: context.project,
        task: context.task,
        validatedProjectRoot: context.validatedProjectRoot,
        workPackage: context.workPackage,
      })

      await assertActiveExecutionLease()
      await upsertRepositoryEvidenceRecord({
        agentRunId: run.id,
        context: repositoryContext,
        executionLease: { runId: run.id },
        taskId,
        workPackageId: nextPackage.id,
      })

      await createPackageArtifact({
        agentRunId: run.id,
        artifactType: 'log_output',
        content: repositoryReadinessContent(repositoryContext),
        executionLease: { runId: run.id },
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
        throw new RepositoryEvidenceBlockedError(`Repository evidence blocked: ${repositoryContext.blockedReason}`)
      }
    }

    const priorReviewContext = await loadPriorReviewContext(taskId, nextPackage)
    const execution = await executeWorkPackage({
      ...context,
      agentRunId: run.id,
      attemptNumber,
      priorReviewContext,
    })
    let diffSummary: string | null = null

    await createPackageArtifact({
      agentRunId: run.id,
      artifactType: 'log_output',
      content: execution.executionContextArtifactContent,
      executionLease: { runId: run.id },
      metadata: {
        ...execution.executionContextArtifactMetadata,
        attemptNumber,
        source: 'execution-context-packet',
        workPackageId: nextPackage.id,
      },
      taskId,
      workPackageId: nextPackage.id,
    })

    if (repositoryAffecting && repositoryContext?.projectLocalPath && repositoryContext.isGitRepository) {
      await assertActiveExecutionLease()
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
        executionLease: { runId: run.id },
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
      await recordScopedCommandAuditWithLease({
        result: diffResult,
        taskId,
        workPackageId: nextPackage.id,
        agentRunId: run.id,
        artifactId: diffArtifact.id,
        runId: run.id,
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
        executionLease: { runId: run.id },
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
        executionLease: { runId: run.id },
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
        executionLease: { runId: run.id },
        status: repositoryEvidenceStatus,
        taskId,
        validationStatus,
        workPackageId: nextPackage.id,
      })
    }

    if (repositoryAffecting && validationStatusForPackage === 'skipped') {
      await recordTaskLogBestEffort({
        agentRunId: run.id,
        eventType: 'validation.warning',
        level: 'warning',
        message: 'Repository-affecting package did not run validation commands.',
        metadata: { validationStatus: 'skipped' },
        source: 'worker',
        taskId,
        title: 'Validation skipped',
        workPackageId: nextPackage.id,
      })
    }

    await assertActiveExecutionLease()

    const completedAt = new Date()
    const reviewGates = await materializeReviewGatesForWorkPackageCompletion({
      completeSourceRun: {
        artifactType: 'log_output',
        completedAt,
        content: execution.artifactContent,
        metadata: {
          ...execution.artifactMetadata,
          attemptNumber,
          source: 'work-package-executor',
          workPackageId: nextPackage.id,
        },
      },
      requireExecutionLease: true,
      sourceAgentRunId: run.id,
      sourceArtifactId: null,
      taskId,
      workPackageId: nextPackage.id,
    })

    if (reviewGates.status === 'not_owned') {
      heartbeat.stop()
      return abandonLostExecutionLease({
        attemptNumber,
        readyPackageIds,
        runId: run.id,
        taskId,
        workPackageId: nextPackage.id,
      })
    }
    const artifact = reviewGates.sourceArtifact
    if (!artifact) throw new Error('Work package completion did not create a source artifact.')
    const packageStatus = reviewGates.packageStatus
    executionLeaseReleased = true
    heartbeat.stop()

    await publishTaskEventBestEffort(taskId, 'artifact:created', {
      id: artifact.id,
      artifactId: artifact.id,
      agentRunId: artifact.agentRunId,
      artifactType: artifact.artifactType,
      content: artifact.content,
      metadata: artifact.metadata,
      createdAt: artifact.createdAt,
      workPackageId: nextPackage.id,
    })

    await publishTaskEventBestEffort(taskId, 'run:completed', {
      attemptNumber,
      runId: run.id,
      stage: 'implementation',
      status: 'completed',
      workPackageId: nextPackage.id,
    })
    await recordTaskLogBestEffort({
      agentRunId: run.id,
      eventType: 'run.completed',
      level: 'success',
      message: `Implementation run completed for "${nextPackage.title}".`,
      metadata: {
        attemptNumber,
        commandCount: execution.commandResults.length,
        fileCount: execution.fileCount,
        sandboxPath: execution.sandboxPath,
        validationStatus: validationStatusForPackage,
      },
      source: 'worker',
      taskId,
      title: 'Implementation run completed',
      workPackageId: nextPackage.id,
    })

    await publishTaskEventBestEffort(taskId, 'work_package:handoff', {
      assignedRole: nextPackage.assignedRole,
      hostRepositoryWrites: execution.hostRepositoryWrites,
      harnessId: nextPackage.harnessId,
      repositoryWrites: execution.repositoryWrites,
      runId: run.id,
      sandboxPath: execution.sandboxPath,
      sandboxWrites: execution.fileCount > 0,
      stage: 'implementation',
      status: packageStatus ?? 'running',
      title: nextPackage.title,
      updatedAt: new Date().toISOString(),
      workPackageId: nextPackage.id,
    })

    const continuation = await continueWorkforceAfterPackageCompletionOrThrow(taskId, packageStatus, options)
    if (continuation) return continuation

    return {
      status: 'handed_off',
      readyPackageIds,
      claimedPackageId: nextPackage.id,
    }
  } catch (err) {
    if (packageFailureHandled) {
      // An inner catch already recorded the failure and moved the package out of
      // 'running'; propagate the error instead of misreading the status change
      // as a lost lease.
      heartbeat.stop()
      throw err
    }
    if (!executionLeaseReleased && (err instanceof ExecutionLeaseLostError || !(await executionLeaseOwned(nextPackage.id, run.id)))) {
      heartbeat.stop()
      return abandonLostExecutionLease({
        attemptNumber,
        readyPackageIds,
        runId: run.id,
        taskId,
        workPackageId: nextPackage.id,
      })
    }
    if (executionLeaseReleased) {
      heartbeat.stop()
      throw err
    }
    const message = sanitizeWorkerMessage(err instanceof Error ? err.message : String(err))
    const executionFailureDetails = err instanceof WorkPackageExecutionError
      ? err.failureDetails
      : null
    const repositoryEvidenceBlocked = err instanceof RepositoryEvidenceBlockedError
    const failedAt = new Date()
    const finalAttempt = options.finalAttempt ?? true
    const packageStatus = repositoryEvidenceBlocked || !finalAttempt ? 'blocked' : 'failed'
    const blockedReason = repositoryEvidenceBlocked
      ? message
      : finalAttempt
        ? message
        : `Retrying package execution after error: ${message}`
    const [failedPackage] = await db
      .update(workPackages)
      .set({
        blockedReason,
        metadata: metadataWithoutExecutionLease(nextPackage.metadata),
        status: packageStatus,
        updatedAt: failedAt,
      })
      .where(and(
        eq(workPackages.id, nextPackage.id),
        eq(workPackages.status, 'running'),
        sql`${workPackages.metadata}->'executionLease'->>'runId' = ${run.id}`,
      ))
      .returning({ id: workPackages.id })
    if (!failedPackage) {
      heartbeat.stop()
      return abandonLostExecutionLease({
        attemptNumber,
        readyPackageIds,
        runId: run.id,
        taskId,
        workPackageId: nextPackage.id,
      })
    }
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

    const [artifact] = await db
      .insert(artifacts)
      .values({
        agentRunId: run.id,
        artifactType: 'log_output',
        content: executionFailureDetails
          ? `${executionFailureDetails.artifactContent}\n\nFailure:\n${message}`
          : `Work package execution failed.\n\n${message}`,
        metadata: {
          ...(executionFailureDetails?.artifactMetadata ?? {}),
          errorMessage: message,
          failure: true,
          repositoryWrites: false,
          source: 'work-package-executor',
          workPackageId: nextPackage.id,
        },
      })
      .returning()

    await publishTaskEventBestEffort(taskId, 'run:failed', {
      attemptNumber,
      errorMessage: message,
      runId: run.id,
      stage: 'implementation',
      workPackageId: nextPackage.id,
    })
    await publishTaskEventBestEffort(taskId, 'artifact:created', {
      id: artifact.id,
      artifactId: artifact.id,
      agentRunId: artifact.agentRunId,
      artifactType: artifact.artifactType,
      content: artifact.content,
      metadata: artifact.metadata,
      createdAt: artifact.createdAt,
      workPackageId: nextPackage.id,
    })
    await recordTaskLogBestEffort({
      agentRunId: run.id,
      artifactId: artifact.id,
      eventType: 'artifact.created',
      level: 'error',
      message: `Created failure artifact ${artifact.id}: ${message}`,
      metadata: {
        artifactType: artifact.artifactType,
        failure: true,
      },
      source: 'worker',
      taskId,
      title: 'Failure artifact created',
      workPackageId: nextPackage.id,
    })
    await recordTaskLogBestEffort({
      agentRunId: run.id,
      eventType: 'run.failed',
      level: finalAttempt && !repositoryEvidenceBlocked ? 'error' : 'warning',
      message: `Implementation run failed for "${nextPackage.title}": ${message}`,
      metadata: {
        attemptNumber,
        finalAttempt: repositoryEvidenceBlocked ? false : finalAttempt,
        packageStatus,
      },
      source: 'worker',
      taskId,
      title: 'Implementation run failed',
      workPackageId: nextPackage.id,
    })
    await publishTaskEventBestEffort(taskId, 'work_package:status', {
      blockedReason,
      status: packageStatus,
      updatedAt: failedAt.toISOString(),
      workPackageId: nextPackage.id,
    })
    heartbeat.stop()
    if (repositoryEvidenceBlocked) {
      return {
        blockedReason,
        claimedPackageId: null,
        readyPackageIds,
        status: 'blocked',
      }
    }
    throw err
  }
  } finally {
    heartbeat.stop()
  }
}
