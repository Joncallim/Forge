import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '../db'
import {
  agentRuns,
  approvalGates,
  artifacts,
  projects,
  repositoryCommandAudits,
  taskLocalProjectionScopes,
  tasks,
  vcsChanges,
  workPackageDependencies,
  workPackages,
} from '../db/schema'
import { getProjectMcpOverview } from '../lib/mcps/manager'
import type { ProjectMcpOverview } from '../lib/mcps/types'
import { publishTaskEvent } from './events'
import {
  evaluateWorkPackageMcpBroker,
  hasWorkPackageMcpRuntimeInputs,
} from './mcp-execution-design'
import type { McpBrokerAdmissionCheck } from '../lib/mcps/admission'
import { buildMcpBrokerBlockMetadata, enqueueBlockedHandoffRetry } from './blocked-handoff-retry'
import {
  canonicalFilesystemProjectCapabilities,
  isProjectFilesystemEffectivePhase,
  readFilesystemGrantBlockFromMetadata,
  requiresFilesystemGrantApproval,
} from '../lib/mcps/filesystem-grants'
import {
  buildFilesystemGrantBlockMetadata,
  type FilesystemGrantHoldState,
} from '../lib/mcps/filesystem-grant-lifecycle'
import {
  advanceFilesystemGrantOperatorHoldProjection,
  convergeRecognizedOperatorHoldTask,
  convergeOperatorHeldTask,
  loadCurrentProjectFilesystemDecision,
} from '../lib/mcps/filesystem-grant-reconciliation'
import { resolveS4ReviewSourceV1 } from '../lib/mcps/review-source-resolver'
import type { ProjectFilesystemDecisionAuthority } from '../lib/mcps/filesystem-project-authority'
import { assertMcpAdmissionLockSequence } from '../lib/mcps/mcp-admission-lock-order'
import { updateTaskStatusIfCurrent } from './task-state'
import {
  completeTaskIfReviewGatesSatisfied,
  materializeReviewGatesForWorkPackageCompletion,
  requiredGateTypesForRequirement,
  REVIEW_GATE_TYPES,
} from './review-gates'
import {
  activateWorkPackageExecutionContext,
  executeWorkPackage,
  isArchitectReservedExecutionRole,
  loadWorkPackageExecutionContext,
  loadWorkPackageExecutionPreflight,
  resolveProtectedArchitectPlanContext,
  MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS,
  WorkPackageExecutionError,
  type WorkPackagePriorReviewContext,
  type WorkPackageExecutionPrePathContext,
  type WorkPackageS4Lifecycle,
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
import { packetCandidateGuard } from '../lib/mcps/packet-issuance-v2'
import { localEffectCandidateGuard } from '../lib/mcps/local-run-evidence-v2'
import {
  executionLeaseIsStale,
  parseExecutionLeaseMetadata,
  staleRunningPackageSeconds,
  type ExecutionLease,
} from './execution-lease'
import {
  claimWorkPackageLifecycleV2,
  claimPendingS4CompletionHandoffsV1,
  finalizeLocalFailureV2,
  finalizeLocalSuccessV2,
  finalizePacketFailureV2,
  finalizePacketSuccessV2,
  heartbeatLocalLifecycleV2,
  heartbeatPacketLifecycleV2,
  discoverS4CompletionHandoffV1,
  materializeS4CompletionHandoffV1,
  materializeClaimedS4CompletionHandoffV1,
  finalizeS4MaxAttemptsV1,
  readS4RuntimeModeV1,
  recoverLinkedS4LifecycleV2,
  S4LifecycleError,
  type S4CompletionArtifact,
  type WorkPackageLifecycleClaim,
} from '../lib/mcps/s4-lease'
import type { PacketTerminalOutcome } from '../lib/mcps/packet-issuance-v2'

type HandoffPackage = {
  id: string
  assignedRole: string
  blockedReason?: string | null
  harnessId: string | null
  mcpRequirements?: unknown
  metadata?: unknown
  sequence: number
  reviewRequirement?: string
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

type HandoffOptions = {
  /** Integration seam for a write racing the evaluated snapshot and its compare-and-set. */
  afterMcpAdmissionEvaluated?: (input: { attempt: number; packageId: string; status: 'allowed' | 'blocked' }) => Promise<void>
  /** Integration seam for deterministic races; runs after health I/O and before the fresh database read. */
  afterMcpHealthCaptured?: (input: { attempt: number; packageId: string; projectId: string }) => Promise<void>
  /** Integration seam for a concurrent write after the execution lease is committed. */
  afterWorkPackageClaimed?: (input: { attempt: number; packageId: string; runId: string }) => Promise<void>
  /** Integration seam for deterministic contention after the production claim owns canonical rows. */
  afterWorkPackageClaimRowsLocked?: (input: { backendPid: number; packageId: string }) => Promise<void>
  /** Integration seam for a policy writer that acquires its project lock immediately before claim persistence. */
  beforeWorkPackageClaimPersisted?: (input: { attempt: number; packageId: string; projectId: string }) => Promise<void>
  claimEnabled?: boolean
  finalAttempt?: boolean
  freshnessAttempt?: number
  priorBlockedContext?: { packageId: string; reason: string | null }
  staleRecoveryAttempted?: boolean
}

type McpProjectFreshnessSnapshot = {
  filesystemGrantDecision?: ProjectFilesystemDecisionAuthority | null
  grantDecisionRevision: bigint
  id: string
  localPath: string | null
  mcpConfig: unknown
  rootBindingRevision: bigint
}

type McpHealthCapture = {
  error: string | null
  overview: ProjectMcpOverview | null
  project: McpProjectFreshnessSnapshot
}

type HandoffBlockDecision =
  | {
      blocked: string[]
      blockedReason: string
      check: McpBrokerAdmissionCheck
      kind: 'broker'
      terminalBlock?: false
      warnings: string[]
    }
  | {
      blockedReason: string
      holdState: FilesystemGrantHoldState
      kind: 'filesystem_grant'
      missingCapabilities: string[]
      requirementKeys: string[]
      requestedCapabilities: string[]
      terminalBlock?: false
    }
  | {
      blockedReason: string
      kind: 'reserved_role'
      terminalBlock: true
    }

type HandoffAdmissionResult =
  | { pkg: HandoffPackage; project: McpProjectFreshnessSnapshot; status: 'allowed' }
  | {
      blockedReason: string
      status: 'blocked'
      taskDisposition?: 'operator_hold'
      terminalBlock?: boolean
    }
  | { pkg: HandoffPackage; status: 'conflict' }

const MAX_HANDOFF_FRESHNESS_ATTEMPTS = 3

function jsonbSnapshotEquals(column: unknown, value: unknown) {
  return sql`${column} IS NOT DISTINCT FROM ${JSON.stringify(value ?? null)}::jsonb`
}

function packageFreshnessConditions(pkg: HandoffPackage) {
  return [
    eq(workPackages.assignedRole, pkg.assignedRole),
    sql`${workPackages.blockedReason} IS NOT DISTINCT FROM ${pkg.blockedReason ?? null}`,
    sql`${workPackages.harnessId} IS NOT DISTINCT FROM ${pkg.harnessId}`,
    jsonbSnapshotEquals(workPackages.metadata, pkg.metadata),
    jsonbSnapshotEquals(workPackages.mcpRequirements, pkg.mcpRequirements),
    eq(workPackages.title, pkg.title),
  ]
}

function handoffFreshnessConditions(input: {
  pkg: HandoffPackage
}) {
  return [
    eq(workPackages.id, input.pkg.id),
    eq(workPackages.status, input.pkg.status),
    ...packageFreshnessConditions(input.pkg),
  ]
}

function sameJsonSnapshot(left: unknown, right: unknown): boolean {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!isRecord(value)) return value ?? null
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

async function rereadMcpHandoffInputs(taskId: string, packageId: string): Promise<{
  pkg: HandoffPackage
  project: McpProjectFreshnessSnapshot
} | null> {
  const [row] = await db
    .select({
      assignedRole: workPackages.assignedRole,
      blockedReason: workPackages.blockedReason,
      harnessId: workPackages.harnessId,
      id: workPackages.id,
      grantDecisionRevision: projects.grantDecisionRevision,
      localPath: projects.localPath,
      mcpConfig: projects.mcpConfig,
      mcpRequirements: workPackages.mcpRequirements,
      reviewRequirement: workPackages.reviewRequirement,
      metadata: workPackages.metadata,
      projectId: projects.id,
      rootBindingRevision: projects.rootBindingRevision,
      sequence: workPackages.sequence,
      status: workPackages.status,
      title: workPackages.title,
      updatedAt: workPackages.updatedAt,
    })
    .from(workPackages)
    .innerJoin(tasks, eq(workPackages.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(workPackages.id, packageId), eq(workPackages.taskId, taskId)))
    .limit(1)
  if (!row) return null
  const filesystemGrantDecision = await loadCurrentProjectFilesystemDecision(row.projectId)
  return {
    pkg: row,
    project: {
      filesystemGrantDecision,
      grantDecisionRevision: row.grantDecisionRevision ?? BigInt(0),
      id: row.projectId,
      localPath: row.localPath,
      mcpConfig: row.mcpConfig,
      rootBindingRevision: row.rootBindingRevision ?? BigInt(0),
    },
  }
}

function mcpProjectSnapshotsMatch(
  left: McpProjectFreshnessSnapshot,
  right: McpProjectFreshnessSnapshot,
): boolean {
  return left.id === right.id &&
    (left.grantDecisionRevision ?? BigInt(0)) === (right.grantDecisionRevision ?? BigInt(0)) &&
    left.localPath === right.localPath &&
    (left.rootBindingRevision ?? BigInt(0)) === (right.rootBindingRevision ?? BigInt(0)) &&
    sameJsonSnapshot(left.mcpConfig, right.mcpConfig)
}

function mcpPackageSnapshotsMatch(left: HandoffPackage, right: HandoffPackage): boolean {
  return left.id === right.id &&
    left.status === right.status &&
    left.assignedRole === right.assignedRole &&
    (left.blockedReason ?? null) === (right.blockedReason ?? null) &&
    left.harnessId === right.harnessId &&
    left.title === right.title &&
    sameJsonSnapshot(left.mcpRequirements, right.mcpRequirements) &&
    sameJsonSnapshot(left.metadata, right.metadata)
}

/**
 * Serialize every persistence boundary that consumes an evaluated MCP snapshot.
 * Project policy writers use the same project -> task -> package order, so a
 * grant/config change either commits before this check (and is rejected as
 * stale) or waits until the block/promotion/claim transaction has committed.
 */
async function lockFreshMcpHandoffInputs(
  tx: WorkPackageLeaseTransaction,
  taskId: string,
  pkgSnapshot: HandoffPackage,
  projectSnapshot?: McpProjectFreshnessSnapshot,
): Promise<boolean> {
  const projectId = projectSnapshot?.id ?? (await tx
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1))[0]?.projectId
  if (!projectId) return false
  const [lockedProject] = await tx
    .select({
      id: projects.id,
      grantDecisionRevision: projects.grantDecisionRevision,
      localPath: projects.localPath,
      mcpConfig: projects.mcpConfig,
      rootBindingRevision: projects.rootBindingRevision,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update')
  if (
    !lockedProject
    || (projectSnapshot && !mcpProjectSnapshotsMatch(projectSnapshot, lockedProject))
  ) return false

  const [lockedTask] = await tx
    .select({ id: tasks.id, projectId: tasks.projectId })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, lockedProject.id)))
    .for('update')
  if (!lockedTask) return false
  const [lockedScope] = await tx
    .select({ state: taskLocalProjectionScopes.localProjectionScopeState })
    .from(taskLocalProjectionScopes)
    .where(eq(taskLocalProjectionScopes.id, taskId))
  if (lockedScope?.state !== 'active') return false

  const lockedPackages = await tx
    .select({
      assignedRole: workPackages.assignedRole,
      blockedReason: workPackages.blockedReason,
      harnessId: workPackages.harnessId,
      id: workPackages.id,
      mcpRequirements: workPackages.mcpRequirements,
      metadata: workPackages.metadata,
      reviewRequirement: workPackages.reviewRequirement,
      sequence: workPackages.sequence,
      status: workPackages.status,
      title: workPackages.title,
      updatedAt: workPackages.updatedAt,
    })
    .from(workPackages)
    .where(eq(workPackages.taskId, taskId))
    .orderBy(workPackages.id)
    .for('update')
  const lockedPackage = lockedPackages.find((pkg) => pkg.id === pkgSnapshot.id)
  return Boolean(lockedPackage && mcpPackageSnapshotsMatch(pkgSnapshot, lockedPackage))
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
      taskDisposition?: 'operator_hold'
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
  const parsed = parseExecutionLeaseMetadata(metadata)
  return parsed.state === 'valid' ? parsed.lease : null
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
  const parsed = parseExecutionLeaseMetadata(pkg.metadata)
  if (parsed.state === 'malformed') return false
  if (parsed.state === 'valid') return executionLeaseIsStale(parsed.lease, now)
  const heartbeatAt = pkg.updatedAt
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
    .filter((pkg) => !packetCandidateGuard(pkg.metadata).blocked && !localEffectCandidateGuard(pkg.metadata).blocked)
    .filter((pkg) =>
      (dependenciesByPackageId.get(pkg.id) ?? []).every((dependencyId) =>
        completedPackageIds.has(dependencyId),
      ),
    )
    .sort((a, b) => a.sequence - b.sequence)
    .map((pkg) => pkg.id)
}

async function loadHandoffState(taskId: string): Promise<HandoffState> {
  const [taskScope] = await db
    .select({ localProjectionScopeState: taskLocalProjectionScopes.localProjectionScopeState })
    .from(taskLocalProjectionScopes)
    .where(eq(taskLocalProjectionScopes.id, taskId))
    .limit(1)
  const packageRows = await db
    .select({
      id: workPackages.id,
      assignedRole: workPackages.assignedRole,
      blockedReason: workPackages.blockedReason,
      harnessId: workPackages.harnessId,
      mcpRequirements: workPackages.mcpRequirements,
      metadata: workPackages.metadata,
      reviewRequirement: workPackages.reviewRequirement,
      sequence: workPackages.sequence,
      status: workPackages.status,
      title: workPackages.title,
      updatedAt: workPackages.updatedAt,
    })
    .from(workPackages)
    .where(eq(workPackages.taskId, taskId))
    .orderBy(asc(workPackages.sequence), asc(workPackages.createdAt))

  if (packageRows.length === 0 || taskScope?.localProjectionScopeState !== 'active') {
    return {
      alreadyRunningPackage: null,
      nextPackage: null,
      packages: packageRows,
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
    ...packageRows
      .filter((pkg) => pkg.status === 'ready' && !packetCandidateGuard(pkg.metadata).blocked && !localEffectCandidateGuard(pkg.metadata).blocked)
      .map((pkg) => pkg.id),
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

  if (await readS4RuntimeModeV1() === 'protected') {
    const pendingHandoff = await discoverS4CompletionHandoffV1({ workPackageId: pkg.id })
    if (pendingHandoff) {
      await materializeS4CompletionHandoffV1({
        agentRunId: pendingHandoff.agentRunId,
        requiredGateTypes: requiredGateTypesForRequirement(pkg.reviewRequirement ?? 'both'),
      })
      return true
    }
  }

  const recoveredAt = new Date()
  const cutoff = staleRunningPackageCutoff(recoveredAt)
  const blockedReason = `Recovered stale running work package "${pkg.title}" after the worker lost its execution lease. The next handoff retry will start a new attempt.`
  const staleRunningRecovery = {
    recoveredAt: recoveredAt.toISOString(),
    reason: blockedReason,
    source: 'work-package-handoff',
    staleAfterSeconds: staleRunningPackageSeconds(),
    status: 'blocked',
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

  if (run) {
    const s4Recovery = await recoverLinkedS4LifecycleV2({ agentRunId: run.id })
    if (s4Recovery.result === 'terminal_success_pending_handoff') {
      if (!s4Recovery.completionArtifactId) {
        throw new Error('Protected S4 success recovery is missing its completion artifact identity.')
      }
      const materialized = await materializeReviewGatesForWorkPackageCompletion({
        requireExecutionLease: true,
        sourceAgentRunId: run.id,
        sourceArtifactId: s4Recovery.completionArtifactId,
        taskId,
        workPackageId: pkg.id,
      })
      return materialized.status === 'materialized'
    }
    if (s4Recovery.result !== 'not_linked_v2') {
      // The S4 reconciler owns every protocol-v2 terminal transition. In
      // particular, do not overwrite its typed packet/local marker with the
      // legacy staleRunningRecovery blob or publish a second terminal event.
      return s4Recovery.result !== 'not_stale'
    }
  }

  const [recovered] = await db
    .update(workPackages)
    .set({
      blockedReason,
      metadata: sql`jsonb_set(
        coalesce(${workPackages.metadata}, '{}'::jsonb) - 'executionLease',
        '{staleRunningRecovery}',
        ${JSON.stringify(staleRunningRecovery)}::jsonb,
        true
      )`,
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
    staleRunningRecovery,
    status: 'blocked',
    updatedAt: recoveredAt.toISOString(),
    workPackageId: pkg.id,
  })

  return true
}

/**
 * Repairs the crash window between a protected success finalizer and review-
 * gate handoff. Discovery keys from the package, so it also finds an S4 run
 * whose agent_runs row is already completed and therefore invisible to the
 * legacy stale-running query.
 */
export async function reconcilePendingS4CompletionHandoffs(
  limit = 100,
  options: {
    drain?: boolean
    enqueue?: typeof enqueueBlockedHandoffRetry
    workerId?: string
  } = {},
): Promise<number> {
  if (await readS4RuntimeModeV1() !== 'protected') return 0
  const enqueue = options.enqueue ?? enqueueBlockedHandoffRetry
  const workerId = options.workerId ?? `manual-${process.pid}`
  const wokenTaskIds = new Set<string>()
  let reconciled = 0
  do {
    const claimToken = randomUUID()
    const claimed = await claimPendingS4CompletionHandoffsV1({
      claimToken,
      limit,
      workerId,
    })
    for (const handoff of claimed) {
      try {
        await materializeClaimedS4CompletionHandoffV1({
          agentRunId: handoff.agentRunId,
          claimGeneration: handoff.claimGeneration,
          claimToken,
          requiredGateTypes: requiredGateTypesForRequirement(handoff.reviewRequirement ?? 'both'),
          workerId,
        })
      } catch (error) {
        if (error instanceof S4LifecycleError && error.code === 'conflict') continue
        throw error
      }
      reconciled += 1
      await convergeRecognizedOperatorHoldTask(handoff.taskId)
      if (!wokenTaskIds.has(handoff.taskId)) {
        wokenTaskIds.add(handoff.taskId)
        await enqueue(handoff.taskId, { source: 's4-completion-handoff-recovery' })
      }
    }
    if (!options.drain || claimed.length < limit) break
  } while (true)
  return reconciled
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

function lifecycleString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function lifecycleStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}

function protectedClaimMode(
  context: WorkPackageExecutionPrePathContext,
):
  | { mode: 'local_only' }
  | { mode: 'packet'; decisionId: string; requiredCapabilities: string[] } {
  if (context.filesystemRuntime.status === 'blocked') {
    throw new Error(
      lifecycleString(context.filesystemRuntime.reason) ||
      `Filesystem context is blocked for "${context.workPackage.title}".`,
    )
  }

  if (context.filesystemRuntime.runtimeIssued === true) {
    const decisionId = context.filesystemRuntime.grantMode === 'always_allow'
      ? context.projectFilesystemDecision?.decisionId
      : lifecycleString(context.filesystemRuntime.grantApprovalId)
    if (!decisionId) {
      throw new Error('Bounded filesystem context requires a current immutable grant decision.')
    }
    if (!context.project.rootRef) {
      throw new Error('Bounded filesystem context requires the project root reference.')
    }
    return {
      mode: 'packet',
      decisionId,
      requiredCapabilities: lifecycleStringArray(context.filesystemRuntime.capabilities),
    }
  }

  return { mode: 'local_only' }
}

function lifecycleFromProtectedClaim(claim: WorkPackageLifecycleClaim): WorkPackageS4Lifecycle | null {
  if (claim.mode === 'root_free_handoff') return null
  if (!claim.localRunEvidenceId || !claim.localClaimToken || !claim.localClaimGeneration) {
    throw new Error('Protected local lifecycle claim returned incomplete ownership.')
  }
  if (claim.mode === 'packet') {
    if (!claim.runtimeAuditId || !claim.packetClaimToken || !claim.packetClaimGeneration) {
      throw new Error('Protected packet lifecycle claim returned incomplete ownership.')
    }
    return {
      kind: 'packet',
      localRunEvidenceId: claim.localRunEvidenceId,
      localClaimToken: claim.localClaimToken,
      localClaimGeneration: claim.localClaimGeneration,
      packet: {
        runtimeAuditId: claim.runtimeAuditId,
        localClaimToken: claim.localClaimToken,
        localClaimGeneration: claim.localClaimGeneration,
        packetClaimToken: claim.packetClaimToken,
        packetClaimGeneration: claim.packetClaimGeneration,
      },
    }
  }
  return {
    kind: 'local',
    localRunEvidenceId: claim.localRunEvidenceId,
    localClaimToken: claim.localClaimToken,
    localClaimGeneration: claim.localClaimGeneration,
  }
}

type S4LifecycleHeartbeat = {
  assertOwned: () => Promise<void>
  stop: () => Promise<void>
}

function startS4LifecycleHeartbeat(lifecycle: WorkPackageS4Lifecycle): S4LifecycleHeartbeat {
  let stopped = false
  let lost: Error | null = null
  let inFlight: Promise<void> = Promise.resolve()

  const heartbeat = async () => {
    if (lifecycle.kind === 'packet') {
      await heartbeatPacketLifecycleV2(lifecycle.packet)
    } else {
      await heartbeatLocalLifecycleV2(lifecycle)
    }
  }
  const assertOwned = async () => {
    if (lost) throw lost
    const next = inFlight.then(heartbeat)
    inFlight = next.catch((err) => {
      lost = err instanceof Error ? err : new Error(String(err))
    })
    await next
    if (lost) throw lost
  }
  const timer = setInterval(() => {
    if (stopped || lost) return
    void assertOwned().catch((err) => {
      const message = sanitizeWorkerMessage(err instanceof Error ? err.message : String(err))
      console.warn(`[work-package-handoff] S4 lifecycle heartbeat lost ownership: ${message}`)
    })
  }, 5_000)
  timer.unref?.()

  return {
    assertOwned,
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await inFlight.catch(() => undefined)
    },
  }
}

async function finalizeWorkPackageS4Success(
  lifecycle: WorkPackageS4Lifecycle,
  completionArtifact: S4CompletionArtifact,
): Promise<string> {
  if (lifecycle.kind === 'packet') {
    return (await finalizePacketSuccessV2({
      ...lifecycle.packet,
      completionArtifact,
    })).sourceArtifactId
  }
  return (await finalizeLocalSuccessV2({
    ...lifecycle,
    completionArtifact,
  })).sourceArtifactId
}

async function finalizeWorkPackageS4Failure(input: {
  agentRunId: string
  lifecycle: WorkPackageS4Lifecycle
  packetFailure?: Extract<PacketTerminalOutcome, { status: 'failed' }> | null
  localFailureCode?: 'local_execution_failed' | 'local_invocation_uncertain'
}): Promise<void> {
  try {
    if (input.lifecycle.kind === 'packet') {
      await finalizePacketFailureV2({
        ...input.lifecycle.packet,
        failure: input.packetFailure ?? { status: 'failed', failureCode: 'preflight_failed' },
      })
      return
    }
    await finalizeLocalFailureV2({
      ...input.lifecycle,
      failureCode: input.localFailureCode ?? 'local_execution_failed',
    })
  } catch (error) {
    // Ownership expiry or a concurrent finalizer is resolved only by the S4
    // reconciler. Never fall through into legacy package/run cleanup.
    const recovery = await recoverLinkedS4LifecycleV2({ agentRunId: input.agentRunId })
    if (recovery.result === 'not_stale' || recovery.result === 'not_linked_v2') throw error
  }
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
  check?: McpBrokerAdmissionCheck
  pkg: HandoffPackage
  project: McpProjectFreshnessSnapshot
  taskId: string
  warnings: string[]
}): Promise<{ blockedReason: string; status: 'blocked' } | { pkg: HandoffPackage; status: 'conflict' }> {
  const blockedAt = new Date()
  const check: McpBrokerAdmissionCheck = input.check ?? {
    status: 'blocked',
    blocked: input.blocked,
    warnings: input.warnings,
    blockedReason: input.blockedReason,
    retryable: false,
    primaryMode: 'blocked',
    primaryRecoveryAction: 'revise_plan',
    evaluations: [],
    subtaskDecisions: [],
  }
  const metadata = buildMcpBrokerBlockMetadata({
    blockedAt,
    check,
    existingMetadata: input.pkg.metadata,
  })
  const brokerMarker = metadata.mcpBroker
  const blockedRow = await db.transaction(async (tx) => {
    if (!await lockFreshMcpHandoffInputs(tx, input.taskId, input.pkg, input.project)) return null
    const [row] = await tx
      .update(workPackages)
      .set({
        blockedReason: input.blockedReason,
        // This path owns only metadata.mcpBroker. The exact package CAS proves
        // the broker evaluated this JSON document; jsonb_set preserves fields
        // owned by concurrent features.
        metadata: sql`jsonb_set(coalesce(${workPackages.metadata}, '{}'::jsonb), '{mcpBroker}', ${JSON.stringify(brokerMarker)}::jsonb, true)`,
        status: 'blocked',
        updatedAt: blockedAt,
      })
      .where(and(...handoffFreshnessConditions(input)))
      .returning({ id: workPackages.id })
    return row ?? null
  })

  if (!blockedRow) return { pkg: input.pkg, status: 'conflict' }

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
// budget for the corrected run after the operator approves the grant. Holding
// here creates no agent run and consumes no attempt, so the recovery run starts
// fresh at attempt 1 once the grant is approved.
async function failWorkPackageForFilesystemGrant(input: {
  blockedReason: string
  holdState: FilesystemGrantHoldState
  missingCapabilities: string[]
  pkg: HandoffPackage
  project: McpProjectFreshnessSnapshot
  requirementKeys: string[]
  requestedCapabilities: string[]
  taskId: string
}): Promise<
  | { blockedReason: string; status: 'blocked'; taskDisposition: 'operator_hold' }
  | { pkg: HandoffPackage; status: 'conflict' }
> {
  const requestedCapabilities = canonicalFilesystemProjectCapabilities(input.requestedCapabilities)
  const failedResult = await db.transaction(async (tx) => {
    assertMcpAdmissionLockSequence([
      'project',
      'tasks:id-ascending',
      'work-packages:id-ascending',
      'local-run-evidence-task-projection-heads:id-ascending',
    ])
    const [lockedProject] = await tx
      .select({
        id: projects.id,
        grantDecisionRevision: projects.grantDecisionRevision,
        localPath: projects.localPath,
        mcpConfig: projects.mcpConfig,
        rootBindingRevision: projects.rootBindingRevision,
      })
      .from(projects)
      .where(eq(projects.id, input.project.id))
      .for('update')
    if (!lockedProject || !mcpProjectSnapshotsMatch(input.project, lockedProject)) return null
    const [lockedTask] = await tx.select().from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.projectId, lockedProject.id)))
      .for('update')
    if (!lockedTask) return null
    const siblings = await tx.select().from(workPackages)
      .where(eq(workPackages.taskId, input.taskId))
      .orderBy(workPackages.id)
      .for('update')
    const lockedPackage = siblings.find((pkg) => pkg.id === input.pkg.id)
    if (!lockedPackage || !mcpPackageSnapshotsMatch(input.pkg, lockedPackage)) return null
    const [clock] = await tx.execute(sql<{ now: string }>`select transaction_timestamp()::text as now`)
    const clockValue = (clock as { now?: unknown } | undefined)?.now
    const failedAt = new Date(typeof clockValue === 'string' || clockValue instanceof Date ? clockValue : '')
    if (!Number.isFinite(failedAt.getTime())) throw new Error('Database transaction clock is unavailable.')
    const grantBlockMarker = buildFilesystemGrantBlockMetadata({
      blockedAt: failedAt,
      hold: input.holdState,
      requirementKeys: input.requirementKeys,
      requestedCapabilities,
      rootBindingRevision: input.project.rootBindingRevision.toString(),
    })
    const priorMarker = readFilesystemGrantBlockFromMetadata(lockedPackage.metadata)
    if (
      lockedPackage.status === 'blocked' &&
      priorMarker?.blockFingerprint === grantBlockMarker.blockFingerprint
    ) {
      return { failedAt, grantBlockMarker: priorMarker, row: lockedPackage, transitioned: false }
    }
    const [row] = await tx
      .update(workPackages)
      .set({
        blockedReason: input.blockedReason,
        metadata: sql`jsonb_set(coalesce(${workPackages.metadata}, '{}'::jsonb), '{mcpGrantBlock}', ${JSON.stringify(grantBlockMarker)}::jsonb, true)`,
        status: 'blocked',
        updatedAt: failedAt,
      })
      .where(and(...handoffFreshnessConditions(input)))
      .returning()
    if (!row) return null
    const metadata = isRecord(lockedPackage.metadata) ? lockedPackage.metadata : {}
    const phases = isRecord(metadata.mcpGrantPhases) ? metadata.mcpGrantPhases : {}
    const effective = isRecord(phases.effective) ? phases.effective : {}
    const packageAuthority = (
      grantBlockMarker.grantDecisionRevision !== null &&
      typeof effective.grantApprovalId === 'string' &&
      effective.grantDecisionRevision === grantBlockMarker.grantDecisionRevision
    ) ? {
        decisionId: effective.grantApprovalId,
        grantDecisionRevision: grantBlockMarker.grantDecisionRevision,
      }
      : null
    const projectAuthority = (
      input.project.filesystemGrantDecision &&
      input.project.filesystemGrantDecision.grantDecisionRevision === grantBlockMarker.grantDecisionRevision
    ) ? {
        decisionId: input.project.filesystemGrantDecision.decisionId,
        grantDecisionRevision: input.project.filesystemGrantDecision.grantDecisionRevision,
      }
      : null
    await advanceFilesystemGrantOperatorHoldProjection({
      authority: packageAuthority ?? projectAuthority,
      marker: grantBlockMarker,
      priorBlockFingerprint: priorMarker?.blockFingerprint ?? null,
      taskId: input.taskId,
      transition: priorMarker ? 'refresh' : 'hold',
      tx,
      workPackageId: row.id,
    })
    await convergeOperatorHeldTask(
      tx,
      lockedTask,
      siblings.map((pkg) => pkg.id === row.id ? row : pkg),
      failedAt,
    )
    return { failedAt, grantBlockMarker, row, transitioned: true }
  })

  if (!failedResult) return { pkg: input.pkg, status: 'conflict' }
  const { failedAt, grantBlockMarker, transitioned } = failedResult

  if (!transitioned) {
    return { blockedReason: input.blockedReason, status: 'blocked', taskDisposition: 'operator_hold' }
  }

  await publishTaskEvent(input.taskId, 'work_package:status', {
    blockedReason: input.blockedReason,
    mcpGrantBlock: grantBlockMarker,
    status: 'blocked',
    updatedAt: failedAt.toISOString(),
    workPackageId: input.pkg.id,
  })
  await recordTaskLogBestEffort({
    eventType: 'mcp.filesystem.grant_required',
    level: 'warning',
    message: `"${input.pkg.title}" needs filesystem grant approval before it can run: ${input.blockedReason}`,
    metadata: {
      mcpGrantBlock: grantBlockMarker,
      missingCapabilities: input.missingCapabilities,
      requestedCapabilities,
      workPackageId: input.pkg.id,
    },
    source: 'mcp',
    taskId: input.taskId,
    title: 'Filesystem grant required',
    workPackageId: input.pkg.id,
  })

  return { blockedReason: input.blockedReason, status: 'blocked', taskDisposition: 'operator_hold' }
}

function packageProjectFilesystemEffectivePhase(pkg: HandoffPackage): Record<string, unknown> | null {
  const metadata = isRecord(pkg.metadata) ? pkg.metadata : {}
  const phases = isRecord(metadata.mcpGrantPhases) ? metadata.mcpGrantPhases : {}
  const effective = isRecord(phases.effective) ? phases.effective : null
  return isProjectFilesystemEffectivePhase(effective) ? effective : null
}

function filesystemGrantHandoffBlock(
  pkg: HandoffPackage,
  project: McpProjectFreshnessSnapshot,
): {
  blockedReason: string
  holdState: FilesystemGrantHoldState
  missingCapabilities: string[]
  requirementKeys: string[]
  requestedCapabilities: string[]
} | null {
  if (packageProjectFilesystemEffectivePhase(pkg)) {
    const check = requiresFilesystemGrantApproval({
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      projectMcpConfig: project.mcpConfig,
      projectFilesystemDecision: project.filesystemGrantDecision,
      projectRootBindingRevision: project.rootBindingRevision,
    })
    if (!check.blocked) return null
    return {
      blockedReason: `Work package "${pkg.title}" was covered by a project-level filesystem grant, but that project grant was removed or no longer covers ${check.missingCapabilities.join(', ')}. Approve filesystem context again before execution.`,
      holdState: check.holdState!,
      missingCapabilities: check.missingCapabilities,
      requirementKeys: check.requirementKeys,
      requestedCapabilities: check.requestedCapabilities,
    }
  }

  const check = requiresFilesystemGrantApproval({
    mcpRequirements: pkg.mcpRequirements,
    metadata: pkg.metadata,
    projectMcpConfig: project.mcpConfig,
    projectFilesystemDecision: project.filesystemGrantDecision,
    projectRootBindingRevision: project.rootBindingRevision,
  })
  if (!check.blocked) return null
  return {
    blockedReason: `Work package "${pkg.title}" requires filesystem grant approval for ${check.missingCapabilities.join(', ')} before execution. Approve filesystem context for this package, then re-run the task.`,
    holdState: check.holdState!,
    missingCapabilities: check.missingCapabilities,
    requirementKeys: check.requirementKeys,
    requestedCapabilities: check.requestedCapabilities,
  }
}

async function failWorkPackageForReservedRole(input: {
  blockedReason: string
  pkg: HandoffPackage
  project: McpProjectFreshnessSnapshot
  taskId: string
}): Promise<
  | { blockedReason: string; status: 'blocked'; terminalBlock: true }
  | { pkg: HandoffPackage; status: 'conflict' }
> {
  const failedAt = new Date()
  const handoffSafetyMarker = {
    blockedAt: failedAt.toISOString(),
    reason: input.blockedReason,
    source: 'architect-reserved-role',
    status: 'failed',
  }
  const failedRow = await db.transaction(async (tx) => {
    if (!await lockFreshMcpHandoffInputs(tx, input.taskId, input.pkg, input.project)) return null
    const [row] = await tx
      .update(workPackages)
      .set({
        blockedReason: input.blockedReason,
        metadata: sql`jsonb_set(coalesce(${workPackages.metadata}, '{}'::jsonb), '{handoffSafety}', ${JSON.stringify(handoffSafetyMarker)}::jsonb, true)`,
        status: 'failed',
        updatedAt: failedAt,
      })
      .where(and(...handoffFreshnessConditions(input)))
      .returning({ id: workPackages.id })
    return row ?? null
  })

  if (!failedRow) return { pkg: input.pkg, status: 'conflict' }

  await publishTaskEvent(input.taskId, 'work_package:status', {
    blockedReason: input.blockedReason,
    handoffSafety: { source: 'architect-reserved-role', status: 'failed' },
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

export async function loadPriorReviewContext(
  taskId: string,
  pkg: Pick<HandoffPackage, 'id' | 'blockedReason'>,
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
        metadata: artifacts.metadata,
      })
      .from(artifacts)
      .where(inArray(artifacts.id, sourceArtifactIds))
  const sourceArtifactById = new Map(
    sourceArtifactRows.map((artifact) => [
      artifact.id,
      {
        content: cleanPriorReviewSourceArtifactContent(artifact.content),
        protected: artifact.content === 'Protected review source available through its approval gate.'
          || (isRecord(artifact.metadata) && artifact.metadata.protectedReviewSource === true),
      },
    ]),
  )

  const sourceArtifactContentByGateId = new Map<string, string>()
  for (const row of rows) {
    if (!row.sourceArtifactId) continue
    const sourceArtifact = sourceArtifactById.get(row.sourceArtifactId)
    if (!sourceArtifact) continue
    if (!sourceArtifact.protected) {
      sourceArtifactContentByGateId.set(row.id, sourceArtifact.content)
      continue
    }
    if (row.status !== 'needs_rework') continue
    const protectedSource = await resolveS4ReviewSourceV1({ approvalGateId: row.id })
    if (protectedSource.sourceArtifactId !== row.sourceArtifactId) {
      throw new Error('Protected review-source identity changed. Rework execution failed closed.')
    }
    sourceArtifactContentByGateId.set(
      row.id,
      cleanPriorReviewSourceArtifactContent(protectedSource.content),
    )
  }

  return {
    packageBlockedReason: pkg.blockedReason ?? null,
    notes: rows
      .map((row) => {
        const metadata = isRecord(row.metadata) ? row.metadata : {}
        const reason = cleanReviewReason(metadata.decisionReason ?? metadata.cancelledReason)
        const sourceArtifactContent = sourceArtifactContentByGateId.get(row.id) ?? ''
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

async function captureMcpHealth(taskId: string): Promise<McpHealthCapture | null> {
  const project = await loadTaskProjectForMcpBroker(taskId)
  if (!project) return null
  const filesystemGrantDecision = await loadCurrentProjectFilesystemDecision(project.id)
  const projectSnapshot = {
    filesystemGrantDecision,
    grantDecisionRevision: project.grantDecisionRevision ?? BigInt(0),
    id: project.id,
    localPath: project.localPath ?? null,
    mcpConfig: project.mcpConfig ?? null,
    rootBindingRevision: project.rootBindingRevision ?? BigInt(0),
  }
  try {
    return {
      error: null,
      overview: await getProjectMcpOverview(project, filesystemGrantDecision),
      project: projectSnapshot,
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      overview: null,
      project: projectSnapshot,
    }
  }
}

function brokerFailureDecision(pkg: HandoffPackage, message: string): HandoffBlockDecision {
  const blockedReason = `MCP/capability broker blocked "${pkg.title}": evaluation failed (${message}).`
  const blocked = [`Broker evaluation failed: ${message}`]
  return {
    blocked,
    blockedReason,
    check: {
      status: 'blocked',
      blocked,
      warnings: [],
      blockedReason,
      retryable: false,
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      evaluations: [],
      subtaskDecisions: [],
    },
    kind: 'broker',
    warnings: [],
  }
}

function evaluateWorkPackageHandoffAdmission(input: {
  health: McpHealthCapture
  pkg: HandoffPackage
  project: McpProjectFreshnessSnapshot
}): { status: 'allowed' } | HandoffBlockDecision {
  const { health, pkg, project } = input
  const reservedRoleBlock = architectReservedHandoffBlockedReason(pkg)
  if (reservedRoleBlock) {
    return { blockedReason: reservedRoleBlock, kind: 'reserved_role', terminalBlock: true }
  }

  const filesystemGrantBlock = filesystemGrantHandoffBlock(pkg, project)
  if (filesystemGrantBlock) {
    return { ...filesystemGrantBlock, kind: 'filesystem_grant' }
  }

  if (!hasWorkPackageMcpRuntimeInputs(pkg)) return { status: 'allowed' }
  if (health.error || !health.overview) {
    return brokerFailureDecision(pkg, health.error ?? 'project MCP overview could not be loaded')
  }

  try {
    const check = evaluateWorkPackageMcpBroker({
      assignedRole: pkg.assignedRole,
      mcpOverview: health.overview,
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      projectMcpConfig: project.mcpConfig,
      projectFilesystemDecision: project.filesystemGrantDecision,
      projectRootBindingRevision: project.rootBindingRevision,
      title: pkg.title,
    })
    if (check.status !== 'blocked') return { status: 'allowed' }
    return {
      blocked: check.blocked,
      blockedReason: check.blockedReason ?? 'MCP/capability broker blocked this work package.',
      check,
      kind: 'broker',
      warnings: check.warnings,
    }
  } catch (err) {
    return brokerFailureDecision(pkg, err instanceof Error ? err.message : String(err))
  }
}

async function persistWorkPackageHandoffBlock(input: {
  decision: HandoffBlockDecision
  pkg: HandoffPackage
  project: McpProjectFreshnessSnapshot
  taskId: string
}): Promise<HandoffAdmissionResult> {
  const common = { pkg: input.pkg, project: input.project, taskId: input.taskId }
  switch (input.decision.kind) {
    case 'broker':
      return failWorkPackageForMcpBroker({
        ...common,
        blocked: input.decision.blocked,
        blockedReason: input.decision.blockedReason,
        check: input.decision.check,
        warnings: input.decision.warnings,
      })
    case 'filesystem_grant':
      return failWorkPackageForFilesystemGrant({
        ...common,
        blockedReason: input.decision.blockedReason,
        holdState: input.decision.holdState,
        missingCapabilities: input.decision.missingCapabilities,
        requirementKeys: input.decision.requirementKeys,
        requestedCapabilities: input.decision.requestedCapabilities,
      })
    case 'reserved_role':
      return failWorkPackageForReservedRole({
        ...common,
        blockedReason: input.decision.blockedReason,
      })
  }
}

/**
 * Project-locked handoff invariant (no schema/version column required): live
 * MCP health is captured outside a transaction, then admission inputs are read
 * fresh and evaluated. Every persistence boundary locks project -> task ->
 * package, verifies the locked project snapshot, and applies an exact package
 * compare-and-set. A miss never executes; callers recapture health and retry.
 */
async function admitWorkPackageForHandoff(
  taskId: string,
  candidate: HandoffPackage,
  options: HandoffOptions,
): Promise<HandoffAdmissionResult> {
  const health = await captureMcpHealth(taskId)
  if (!health) return { pkg: candidate, status: 'conflict' }
  await options.afterMcpHealthCaptured?.({
    attempt: (options.freshnessAttempt ?? 0) + 1,
    packageId: candidate.id,
    projectId: health.project.id,
  })

  const fresh = await rereadMcpHandoffInputs(taskId, candidate.id)
  if (!fresh || !mcpProjectSnapshotsMatch(health.project, fresh.project)) {
    return { pkg: fresh?.pkg ?? candidate, status: 'conflict' }
  }
  if (!['pending', 'ready', 'needs_rework', 'blocked'].includes(fresh.pkg.status)) {
    return { pkg: fresh.pkg, status: 'conflict' }
  }

  const decision = evaluateWorkPackageHandoffAdmission({
    health,
    pkg: fresh.pkg,
    project: fresh.project,
  })
  await options.afterMcpAdmissionEvaluated?.({
    attempt: (options.freshnessAttempt ?? 0) + 1,
    packageId: candidate.id,
    status: 'status' in decision ? 'allowed' : 'blocked',
  })
  if ('status' in decision) {
    return { pkg: fresh.pkg, project: fresh.project, status: 'allowed' }
  }
  return persistWorkPackageHandoffBlock({
    decision,
    pkg: fresh.pkg,
    project: fresh.project,
    taskId,
  })
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
  const retainPromotedPackageContext = state.nextPackage?.status === 'ready' &&
    state.nextPackage.blockedReason === null &&
    options.priorBlockedContext?.packageId === state.nextPackage.id
  options = {
    ...options,
    priorBlockedContext: state.nextPackage
      ? retainPromotedPackageContext
        ? options.priorBlockedContext
        : { packageId: state.nextPackage.id, reason: state.nextPackage.blockedReason ?? null }
      : options.priorBlockedContext,
  }
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
    const freshnessPromotedPackageIds = new Set<string>()

    for (const readyPackage of readyOnlyCandidates) {
      if (!hasWorkPackageMcpRuntimeInputs(readyPackage) && !architectReservedHandoffBlockedReason(readyPackage)) {
        allowedReadyPackageIds.push(readyPackage.id)
        continue
      }
      const admission = await admitWorkPackageForHandoff(taskId, readyPackage, options)
      if (admission.status === 'conflict') {
        return retryAfterHandoffFreshnessConflict(taskId, admission.pkg, options)
      }
      if (admission.status === 'blocked') {
        return {
          status: 'blocked',
          readyPackageIds: allowedReadyPackageIds,
          claimedPackageId: null,
          blockedReason: admission.blockedReason,
          taskDisposition: admission.taskDisposition,
          terminalBlock: admission.terminalBlock,
        }
      }
      const promoted = await promotePackageWithFreshnessCas({
        pkg: admission.pkg,
        project: admission.project,
        taskId,
      })
      if (!promoted) {
        return retryAfterHandoffFreshnessConflict(taskId, admission.pkg, options)
      }
      freshnessPromotedPackageIds.add(admission.pkg.id)
      allowedReadyPackageIds.push(admission.pkg.id)
    }

    await promoteReadyPackages(
      taskId,
      allowedReadyPackageIds.filter((id) =>
        newlyReadyPackageIds.has(id) && !freshnessPromotedPackageIds.has(id)
      ),
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

  let nextPackage = state.nextPackage
  if (!nextPackage) {
    return { status: 'no_ready_packages', readyPackageIds: [], claimedPackageId: null }
  }

  const allowedReadyPackageIds = [nextPackage.id]
  let projectSnapshot: McpProjectFreshnessSnapshot | undefined
  if (hasWorkPackageMcpRuntimeInputs(nextPackage) || architectReservedHandoffBlockedReason(nextPackage)) {
    const admission = await admitWorkPackageForHandoff(taskId, nextPackage, options)
    if (admission.status === 'conflict') {
      return retryAfterHandoffFreshnessConflict(taskId, admission.pkg, options)
    }
    if (admission.status === 'blocked') {
      return {
        status: 'blocked',
        readyPackageIds: [],
        claimedPackageId: null,
        blockedReason: admission.blockedReason,
        taskDisposition: admission.taskDisposition,
        terminalBlock: admission.terminalBlock,
      }
    }
    nextPackage = admission.pkg
    projectSnapshot = admission.project
    const freshPackage = await promotePackageWithFreshnessCas({
      pkg: admission.pkg,
      project: admission.project,
      taskId,
    })
    if (!freshPackage) {
      return retryAfterHandoffFreshnessConflict(taskId, nextPackage, options)
    }
    nextPackage = freshPackage
  } else {
    const newlyPromotedPackageIds = allowedReadyPackageIds.filter((id) => newlyReadyPackageIds.has(id))
    await promoteReadyPackages(taskId, newlyPromotedPackageIds, now)
    if (newlyPromotedPackageIds.includes(nextPackage.id)) {
      nextPackage = {
        ...nextPackage,
        blockedReason: null,
        status: 'ready',
        updatedAt: now,
      }
    }
  }

  if (isWorkPackageExecutionEnabled()) {
    return executeReadyWorkPackage(taskId, nextPackage, allowedReadyPackageIds, {
      afterWorkPackageClaimed: options.afterWorkPackageClaimed,
      afterWorkPackageClaimRowsLocked: options.afterWorkPackageClaimRowsLocked,
      beforeWorkPackageClaimPersisted: options.beforeWorkPackageClaimPersisted,
      claimEnabled,
      finalAttempt: options.finalAttempt,
      freshnessAttempt: options.freshnessAttempt,
      priorBlockedContext: options.priorBlockedContext,
    }, projectSnapshot)
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
  if (projectSnapshot) {
    await options.beforeWorkPackageClaimPersisted?.({
      attempt: (options.freshnessAttempt ?? 0) + 1,
      packageId: nextPackage.id,
      projectId: projectSnapshot.id,
    })
  }
  const legacyHandoff = () => db.transaction(async (tx) => {
    if (!await lockFreshMcpHandoffInputs(
      tx,
      taskId,
      nextPackage,
      projectSnapshot,
    )) return null
    const [claimBackend] = await tx.execute(sql<{ pid: number }>`select pg_backend_pid()::integer as pid`)
    await options.afterWorkPackageClaimRowsLocked?.({
      backendPid: Number((claimBackend as { pid: number }).pid),
      packageId: nextPackage.id,
    })

    const [claimed] = await tx
      .update(workPackages)
      .set({
        status: 'running',
        blockedReason: null,
        metadata: metadataWithoutExecutionLease(nextPackage.metadata),
        updatedAt: handoffStartedAt,
      })
      .where(and(
        eq(workPackages.id, nextPackage.id),
        eq(workPackages.status, 'ready'),
        ...packageFreshnessConditions(nextPackage),
      ))
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

  let handoff: Awaited<ReturnType<typeof legacyHandoff>>
  if (await readS4RuntimeModeV1() === 'protected') {
    if (!nextPackage.updatedAt) {
      throw new Error('Protected root-free handoff requires the package freshness timestamp.')
    }
    try {
      const protectedClaim = await claimWorkPackageLifecycleV2({
        mode: 'root_free_handoff',
        taskId,
        workPackageId: nextPackage.id,
        expectedPackageUpdatedAt: nextPackage.updatedAt,
        agentRunId: randomUUID(),
        agentType: nextPackage.assignedRole,
        harnessId: nextPackage.harnessId,
        attemptNumber: 1,
        providerConfigId: null,
        providerConfigUpdatedAt: null,
        acpExecutionMode: 'not_applicable',
        modelIdUsed: 'forge-handoff/no-op',
        stage: 'handoff',
        executionStaleSeconds: staleRunningPackageSeconds(),
      })
      handoff = { run: { id: protectedClaim.agentRunId } as typeof agentRuns.$inferSelect }
    } catch (error) {
      if (error instanceof S4LifecycleError && error.code === 'conflict') {
        return retryAfterHandoffFreshnessConflict(taskId, nextPackage, options)
      }
      throw error
    }
  } else {
    handoff = await legacyHandoff()
  }

  if (!handoff) {
    return retryAfterHandoffFreshnessConflict(taskId, nextPackage, options)
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
      .where(and(
        eq(workPackages.id, packageId),
        inArray(workPackages.status, ['pending', 'needs_rework', 'blocked']),
        sql`NOT (coalesce(${workPackages.metadata}, '{}'::jsonb) ?| ARRAY['packet_issuance','packet_integrity_hold','local_effect_recovery','local_effect_integrity_hold'])`,
      ))
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

async function promotePackageWithFreshnessCas(input: {
  pkg: HandoffPackage
  project: McpProjectFreshnessSnapshot
  taskId: string
}): Promise<HandoffPackage | null> {
  if (packetCandidateGuard(input.pkg.metadata).blocked || localEffectCandidateGuard(input.pkg.metadata).blocked) return null
  const promotedAt = new Date()
  const updated = await db.transaction(async (tx) => {
    if (!await lockFreshMcpHandoffInputs(tx, input.taskId, input.pkg, input.project)) return null
    const [row] = await tx
      .update(workPackages)
      .set({ blockedReason: null, status: 'ready', updatedAt: promotedAt })
      .where(and(
        ...handoffFreshnessConditions(input),
        sql`NOT (coalesce(${workPackages.metadata}, '{}'::jsonb) ?| ARRAY['packet_issuance','packet_integrity_hold','local_effect_recovery','local_effect_integrity_hold'])`,
      ))
      .returning({ id: workPackages.id })
    return row ?? null
  })

  if (!updated) return null
  if (input.pkg.status !== 'ready') {
    await publishTaskEventBestEffort(input.taskId, 'work_package:status', {
      status: 'ready',
      updatedAt: promotedAt.toISOString(),
      workPackageId: input.pkg.id,
    })
  }
  return { ...input.pkg, blockedReason: null, status: 'ready', updatedAt: promotedAt }
}

async function blockHandoffFreshnessExhaustion(input: {
  pkg: HandoffPackage
  project: McpProjectFreshnessSnapshot
  taskId: string
}): Promise<string | null> {
  const blockedAt = new Date()
  const blockedReason = `Work package "${input.pkg.title}" changed repeatedly while MCP health was being checked. Handoff was paused before execution; retry after package and project configuration settle.`
  const marker = JSON.stringify({
    blockedAt: blockedAt.toISOString(),
    reason: blockedReason,
    source: 'work-package-handoff',
    status: 'blocked',
  })
  const blocked = await db.transaction(async (tx) => {
    if (!await lockFreshMcpHandoffInputs(tx, input.taskId, input.pkg, input.project)) return null
    const [row] = await tx
      .update(workPackages)
      .set({
        blockedReason,
        metadata: sql`jsonb_set(coalesce(${workPackages.metadata}, '{}'::jsonb), '{handoffFreshnessBlock}', ${marker}::jsonb, true)`,
        status: 'blocked',
        updatedAt: blockedAt,
      })
      .where(and(...handoffFreshnessConditions(input)))
      .returning({ id: workPackages.id })
    return row ?? null
  })

  if (!blocked) return null
  await publishTaskEventBestEffort(input.taskId, 'work_package:status', {
    blockedReason,
    handoffFreshnessBlock: { source: 'work-package-handoff', status: 'blocked' },
    status: 'blocked',
    updatedAt: blockedAt.toISOString(),
    workPackageId: input.pkg.id,
  })
  await recordTaskLogBestEffort({
    eventType: 'work_package.handoff_freshness_blocked',
    level: 'warning',
    message: blockedReason,
    metadata: { workPackageId: input.pkg.id },
    source: 'worker',
    taskId: input.taskId,
    title: 'Handoff paused after concurrent changes',
    workPackageId: input.pkg.id,
  })
  return blockedReason
}

async function retryAfterHandoffFreshnessConflict(
  taskId: string,
  pkg: HandoffPackage,
  options: HandoffOptions,
): Promise<WorkPackageHandoffResult> {
  const freshnessAttempt = (options.freshnessAttempt ?? 0) + 1
  if (freshnessAttempt < MAX_HANDOFF_FRESHNESS_ATTEMPTS) {
    return handoffApprovedWorkPackages(taskId, { ...options, freshnessAttempt })
  }
  const latest = await rereadMcpHandoffInputs(taskId, pkg.id)
  const blockedReason = latest && ['pending', 'ready', 'needs_rework', 'blocked'].includes(latest.pkg.status)
    ? await blockHandoffFreshnessExhaustion({ ...latest, taskId })
    : null
  return {
    status: 'blocked',
    readyPackageIds: [],
    claimedPackageId: null,
    blockedReason: blockedReason ?? 'Handoff freshness changed again before a safe block could be recorded. Retry the handoff.',
  }
}

async function executeReadyWorkPackage(
  taskId: string,
  nextPackage: HandoffPackage,
  readyPackageIds: string[],
  options: HandoffOptions = {},
  projectSnapshot?: McpProjectFreshnessSnapshot,
): Promise<WorkPackageHandoffResult> {
  const attemptNumber = await nextImplementationAttemptNumber(taskId, nextPackage.id)
  const claimedAt = new Date()
  if (projectSnapshot) {
    await options.beforeWorkPackageClaimPersisted?.({
      attempt: (options.freshnessAttempt ?? 0) + 1,
      packageId: nextPackage.id,
      projectId: projectSnapshot.id,
    })
  }
  const s4RuntimeMode = await readS4RuntimeModeV1()
  const protectedPreflight = s4RuntimeMode === 'protected'
    ? await loadWorkPackageExecutionPreflight(taskId, nextPackage.id)
    : null
  let protectedLifecycle: WorkPackageS4Lifecycle | null = null
  const legacyClaim = () => db.transaction(async (tx) => {
    if (!await lockFreshMcpHandoffInputs(
      tx,
      taskId,
      nextPackage,
      projectSnapshot,
    )) return { status: 'already_handed_off' as const }
    const [claimBackend] = await tx.execute(sql<{ pid: number }>`select pg_backend_pid()::integer as pid`)
    await options.afterWorkPackageClaimRowsLocked?.({
      backendPid: Number((claimBackend as { pid: number }).pid),
      packageId: nextPackage.id,
    })

    const [claimed] = await tx
      .update(workPackages)
      .set({
        status: 'running',
        blockedReason: null,
        metadata: metadataWithoutExecutionLease(nextPackage.metadata),
        updatedAt: claimedAt,
      })
      .where(and(
        eq(workPackages.id, nextPackage.id),
        eq(workPackages.status, 'ready'),
        ...packageFreshnessConditions(nextPackage),
      ))
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

  const protectedAttemptLimit = async () => {
    if (!nextPackage.updatedAt) {
      throw new Error('Protected max-attempt finalization requires the package freshness timestamp.')
    }
    const attemptLimit = attemptLimitFailureDetails({ attemptNumber, pkg: nextPackage })
    const finalized = await finalizeS4MaxAttemptsV1({
      expectedPackageUpdatedAt: nextPackage.updatedAt,
      maxAttempts: MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS,
      taskId,
      workPackageId: nextPackage.id,
    })
    if (!finalized) return null
    return {
      ...attemptLimit,
      failedPackageId: nextPackage.id,
      status: 'attempt_limit' as const,
    }
  }

  let claim: Awaited<ReturnType<typeof legacyClaim>>
  if (protectedPreflight && attemptNumber > MAX_WORK_PACKAGE_EXECUTION_ATTEMPTS) {
    const attemptLimitClaim = await protectedAttemptLimit()
    if (!attemptLimitClaim) {
      return retryAfterHandoffFreshnessConflict(taskId, nextPackage, options)
    }
    claim = attemptLimitClaim
  } else if (protectedPreflight) {
    if (!nextPackage.updatedAt) {
      throw new Error('Protected work-package claim requires the package freshness timestamp.')
    }
    const claimMode = protectedClaimMode({
      filesystemRuntime: protectedPreflight.filesystemRuntime,
      project: protectedPreflight.project,
      projectFilesystemDecision: protectedPreflight.projectFilesystemDecision,
      task: protectedPreflight.task,
      workPackage: protectedPreflight.workPackage,
    })
    try {
      const protectedClaim = await claimWorkPackageLifecycleV2({
        ...claimMode,
        taskId,
        workPackageId: nextPackage.id,
        expectedPackageUpdatedAt: nextPackage.updatedAt,
        agentRunId: randomUUID(),
        agentType: nextPackage.assignedRole,
        harnessId: nextPackage.harnessId,
        attemptNumber,
        providerConfigId: protectedPreflight.providerConfigId ?? null,
        providerConfigUpdatedAt: protectedPreflight.providerExecutionSnapshot?.updatedAt ?? null,
        acpExecutionMode: protectedPreflight.providerExecutionSnapshot?.acpExecutionMode ?? 'not_applicable',
        modelIdUsed: protectedPreflight.modelIdUsed,
        stage: 'implementation',
        executionStaleSeconds: staleRunningPackageSeconds(),
      })
      protectedLifecycle = lifecycleFromProtectedClaim(protectedClaim)
      claim = {
        run: { id: protectedClaim.agentRunId } as typeof agentRuns.$inferSelect,
        status: 'claimed',
      }
    } catch (error) {
      if (error instanceof S4LifecycleError && error.code === 'conflict') {
        return retryAfterHandoffFreshnessConflict(taskId, nextPackage, options)
      }
      throw error
    }
  } else {
    claim = await legacyClaim()
  }

  if (claim.status === 'already_handed_off') {
    return retryAfterHandoffFreshnessConflict(taskId, nextPackage, options)
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
  const s4Lifecycle = protectedLifecycle
  const s4Heartbeat: S4LifecycleHeartbeat | null = s4Lifecycle
    ? startS4LifecycleHeartbeat(s4Lifecycle)
    : null
  const currentS4Heartbeat = (): S4LifecycleHeartbeat | null => s4Heartbeat

  try {
  let context: Awaited<ReturnType<typeof loadWorkPackageExecutionContext>>
  try {
    if (protectedPreflight) {
      await currentS4Heartbeat()?.assertOwned()
      const resolvedPreflight = await resolveProtectedArchitectPlanContext(protectedPreflight, {
        agentRunId: run.id,
        assertS4LifecycleOwned: currentS4Heartbeat()?.assertOwned,
      })
      context = await activateWorkPackageExecutionContext(resolvedPreflight, {
        assertS4LifecycleOwned: currentS4Heartbeat()?.assertOwned,
        s4Lifecycle,
      })
    } else {
      context = await loadWorkPackageExecutionContext(taskId, nextPackage.id)
    }
    await options.afterWorkPackageClaimed?.({
      attempt: attemptNumber,
      packageId: nextPackage.id,
      runId: run.id,
    })
    await publishTaskEventBestEffort(taskId, 'work_package:status', {
      status: 'running',
      updatedAt: new Date().toISOString(),
      workPackageId: nextPackage.id,
    })
  } catch (err) {
    if (s4Lifecycle) {
      await finalizeWorkPackageS4Failure({
        agentRunId: run.id,
        lifecycle: s4Lifecycle,
        packetFailure: { status: 'failed', failureCode: 'preflight_failed' },
      })
      await currentS4Heartbeat()?.stop()
      heartbeat.stop()
      packageFailureHandled = true
      throw err
    }
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
        // The lease predicate fences this cleanup to our run. Remove only the
        // field this worker owns from the current JSONB document so grant or
        // unrelated metadata written after claim cannot be rolled back.
        metadata: sql`coalesce(${workPackages.metadata}, '{}'::jsonb) - 'executionLease'`,
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
  let executionCompleted = false
  let s4SuccessTerminalized = false
  let validationStatusForPackage: string | null = null
  const assertActiveExecutionLease = async () => {
    await assertExecutionLeaseOwned(nextPackage.id, run.id)
    await currentS4Heartbeat()?.assertOwned()
  }

  try {
    repositoryAffecting = isRepositoryAffectingWorkPackage(context.workPackage)
    if (repositoryAffecting) {
      await currentS4Heartbeat()?.assertOwned()
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

    const priorReviewContext = await loadPriorReviewContext(taskId, {
      ...nextPackage,
      blockedReason: options.priorBlockedContext?.packageId === nextPackage.id
        ? options.priorBlockedContext.reason
        : nextPackage.blockedReason,
    })
    const execution = await executeWorkPackage({
      ...context,
      agentRunId: run.id,
      attemptNumber,
      priorReviewContext,
    })
    executionCompleted = true
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

    if (
      repositoryAffecting &&
      repositoryContext?.projectLocalPath &&
      repositoryContext.isGitRepository &&
      execution.hostRepositoryWrites
    ) {
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
    const completionArtifact = {
      artifactType: 'log_output',
      content: execution.artifactContent,
      metadata: {
        ...execution.artifactMetadata,
        attemptNumber,
        source: 'work-package-executor',
        workPackageId: nextPackage.id,
      },
    } satisfies S4CompletionArtifact
    let protectedSourceArtifactId: string | null = null
    if (s4Lifecycle) {
      protectedSourceArtifactId = await finalizeWorkPackageS4Success(
        s4Lifecycle,
        completionArtifact,
      )
      s4SuccessTerminalized = true
      await currentS4Heartbeat()?.stop()
    }

    const reviewGates = s4Lifecycle
      ? await materializeS4CompletionHandoffV1({
          agentRunId: run.id,
          requiredGateTypes: requiredGateTypesForRequirement(nextPackage.reviewRequirement ?? 'both'),
        }).then((result) => ({
          status: 'materialized' as const,
          packageStatus: result.packageStatus,
          sourceArtifact: null,
        }))
      : await materializeReviewGatesForWorkPackageCompletion({
          completeSourceRun: { ...completionArtifact, completedAt },
          requireExecutionLease: true,
          sourceAgentRunId: run.id,
          sourceArtifactId: protectedSourceArtifactId,
          taskId,
          workPackageId: nextPackage.id,
        })

    if (reviewGates.status === 'not_owned') {
      if (s4Lifecycle) {
        throw new ExecutionLeaseLostError(
          `Protected S4 completion for run ${run.id} is pending handoff reconciliation.`,
        )
      }
      heartbeat.stop()
      return abandonLostExecutionLease({
        attemptNumber,
        readyPackageIds,
        runId: run.id,
        taskId,
        workPackageId: nextPackage.id,
      })
    }
    let artifact = reviewGates.sourceArtifact
    if (!artifact && protectedSourceArtifactId) {
      const [protectedArtifact] = await db
        .select()
        .from(artifacts)
        .where(and(
          eq(artifacts.id, protectedSourceArtifactId),
          eq(artifacts.agentRunId, run.id),
        ))
        .limit(1)
      artifact = protectedArtifact ?? null
    }
    if (!artifact) throw new Error('Work package completion did not create a source artifact.')
    const packageStatus = reviewGates.packageStatus === 'awaiting_review' || reviewGates.packageStatus === 'completed'
      ? reviewGates.packageStatus
      : null
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
    if (s4Lifecycle) {
      if (!s4SuccessTerminalized) {
        const packetFailure = err instanceof WorkPackageExecutionError && err.packetFailure
          ? err.packetFailure
          : executionCompleted
            ? {
                status: 'failed' as const,
                failureCode: 'post_submission_execution_failed' as const,
                failureStage: 'repository_evidence' as const,
              }
            : { status: 'failed' as const, failureCode: 'preflight_failed' as const }
        await finalizeWorkPackageS4Failure({
          agentRunId: run.id,
          lifecycle: s4Lifecycle,
          packetFailure,
          localFailureCode: err instanceof WorkPackageExecutionError
            ? 'local_invocation_uncertain'
            : 'local_execution_failed',
        })
      }
      await currentS4Heartbeat()?.stop()
      heartbeat.stop()
      packageFailureHandled = true
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
        metadata: sql`coalesce(${workPackages.metadata}, '{}'::jsonb) - 'executionLease'`,
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
