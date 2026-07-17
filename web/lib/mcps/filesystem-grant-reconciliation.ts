import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  filesystemMcpCurrentDecisionPointers,
  filesystemMcpGrantApprovals,
  projectFilesystemCurrentDecisionPointers,
  projectFilesystemGrantDecisions,
  projects,
  tasks,
  workPackages,
  type ProjectMcpConfig,
} from '@/db/schema'
import {
  buildFilesystemGrantBlockMetadata,
  parseFilesystemGrantBlockMetadata,
} from './filesystem-grant-lifecycle'
import {
  canonicalFilesystemProjectCapabilities,
  FILESYSTEM_GRANT_BLOCK_METADATA_KEY,
  FILESYSTEM_MCP_ID,
  isRecord,
  projectFilesystemEffectivePhase,
  projectFilesystemGrantFromAuthority,
  requiresFilesystemGrantApproval,
  summarizeFilesystemCapabilities,
  type FilesystemProjectCapability,
} from './filesystem-grants'
import { assertMcpAdmissionLockSequence } from './mcp-admission-lock-order'
import { readEffectiveGrantState } from './admission'
import {
  parseProjectFilesystemDecisionAuthority,
  type ProjectFilesystemDecisionAuthority,
  type ProjectFilesystemDecisionRevocationReason,
} from './filesystem-project-authority'
import { executionLeaseBlocksConvergence } from '@/worker/execution-lease'

type GrantTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type LockedProject = typeof projects.$inferSelect
type LockedTask = typeof tasks.$inferSelect
type LockedPackage = typeof workPackages.$inferSelect
type ProjectDecisionPointer = typeof projectFilesystemCurrentDecisionPointers.$inferSelect
type PackageDecisionPointer = typeof filesystemMcpCurrentDecisionPointers.$inferSelect
type PackageDecision = typeof filesystemMcpGrantApprovals.$inferSelect

function isEmptyProjectDecisionPointer(pointer: ProjectDecisionPointer): boolean {
  return pointer.currentDecisionId === null &&
    pointer.currentDecisionProjectId === null &&
    pointer.currentDecisionRevision === null &&
    pointer.currentRootBindingRevision === null &&
    pointer.currentDecisionFingerprint === null &&
    pointer.currentDecisionGeneration === null &&
    pointer.pointerGeneration === BigInt(0)
}

function projectDecisionPointerParent(
  pointer: ProjectDecisionPointer,
  decisions: readonly (typeof projectFilesystemGrantDecisions.$inferSelect)[],
) {
  if (isEmptyProjectDecisionPointer(pointer)) return null
  return decisions.find((decision) => (
    pointer.currentDecisionProjectId === pointer.projectId &&
    decision.id === pointer.currentDecisionId &&
    decision.projectId === pointer.currentDecisionProjectId &&
    decision.grantDecisionRevision === pointer.currentDecisionRevision &&
    decision.rootBindingRevision === pointer.currentRootBindingRevision &&
    decision.decisionFingerprint === pointer.currentDecisionFingerprint &&
    decision.decisionGeneration === pointer.currentDecisionGeneration &&
    pointer.pointerGeneration === pointer.currentDecisionGeneration
  )) ?? undefined
}

function packageDecisionPointerParent(
  pointer: PackageDecisionPointer,
  decisions: readonly PackageDecision[],
): PackageDecision | null | undefined {
  const emptyAdapter = pointer.currentDecisionId === null &&
    pointer.currentDecisionTaskId === null &&
    pointer.currentDecisionWorkPackageId === null &&
    pointer.currentDecisionRevision === null &&
    pointer.currentDecisionFingerprint === null &&
    (
      (pointer.pointerVersion === BigInt(0) && pointer.pointerFingerprint === `empty:${pointer.workPackageId}`) ||
      (pointer.pointerVersion === BigInt(1) && /^legacy:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pointer.pointerFingerprint))
    )
  if (emptyAdapter) return null
  return decisions.find((decision) => (
    decision.id === pointer.currentDecisionId &&
    decision.taskId === pointer.currentDecisionTaskId &&
    decision.workPackageId === pointer.currentDecisionWorkPackageId &&
    decision.grantDecisionRevision === pointer.currentDecisionRevision &&
    decision.pointerFingerprint === pointer.currentDecisionFingerprint &&
    pointer.currentDecisionTaskId === pointer.taskId &&
    pointer.currentDecisionWorkPackageId === pointer.workPackageId &&
    pointer.currentDecisionFingerprint === pointer.pointerFingerprint
  )) ?? undefined
}

export type FilesystemGrantMutation = {
  capabilities: string[]
  decision: 'approved' | 'denied'
  grantMode: 'allow_once' | 'always_allow'
  reason: string
  workPackageId: string
  expectedPointer?: {
    currentDecisionId: string | null
    currentDecisionRevision: string | null
    pointerFingerprint: string
    pointerVersion: string
  }
}

export type FilesystemGrantMutationResult = {
  approvals: Array<{
    id: string
    capabilities: string[]
    decision: string
    grantDecisionRevision: bigint | null
    workPackageId: string | null
  }>
  recoveredTaskIds: string[]
  states: Array<{
    approvalId: string
    decision: string
    grantDecisionRevision: string
    workPackageId: string | null
  }>
}

const TASK_EDITABLE = new Set(['awaiting_approval', 'approved', 'running', 'failed'])
const PACKAGE_EDITABLE = new Set(['pending', 'ready', 'blocked', 'needs_rework'])

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

async function lockedTransactionNow(tx: GrantTransaction): Promise<Date> {
  const [clock] = await tx.execute(sql<{ now: string }>`select transaction_timestamp()::text as now`)
  const clockValue = (clock as { now?: unknown } | undefined)?.now
  const now = new Date(typeof clockValue === 'string' || clockValue instanceof Date ? clockValue : '')
  if (!Number.isFinite(now.getTime())) throw new Error('Database transaction clock is unavailable.')
  return now
}

function isLiveExecutionLease(pkg: LockedPackage, now: Date): boolean {
  return pkg.status === 'running' && executionLeaseBlocksConvergence(pkg.metadata, now)
}

function isRecognizedOperatorHold(pkg: LockedPackage): boolean {
  if (!isRecord(pkg.metadata)) return false
  return parseFilesystemGrantBlockMetadata(pkg.metadata[FILESYSTEM_GRANT_BLOCK_METADATA_KEY]) !== null
}

/**
 * Shared S3/S4 task convergence predicate. The caller already holds project,
 * task, and the complete sibling package set in canonical order.
 */
export async function convergeOperatorHeldTask(
  tx: GrantTransaction,
  task: LockedTask,
  siblings: readonly LockedPackage[],
  now = new Date(),
): Promise<boolean> {
  if (task.status !== 'running') return false
  if (!siblings.some(isRecognizedOperatorHold)) return false
  if (siblings.some((pkg) => pkg.status === 'awaiting_review' || isLiveExecutionLease(pkg, now))) return false
  const [updated] = await tx
    .update(tasks)
    .set({ status: 'approved', errorMessage: null, updatedAt: now })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, 'running')))
    .returning({ id: tasks.id })
  return Boolean(updated)
}

async function recoverLegacyFailedGrantTask(
  tx: GrantTransaction,
  task: LockedTask,
  siblings: readonly LockedPackage[],
  recoveredTaskIds: ReadonlySet<string>,
  now: Date,
): Promise<boolean> {
  if (task.status !== 'failed' || !recoveredTaskIds.has(task.id)) return false
  if (siblings.some((pkg) => (
    pkg.status === 'failed' ||
    pkg.status === 'blocked' ||
    pkg.status === 'awaiting_review' ||
    isLiveExecutionLease(pkg, now)
  ))) return false
  const [updated] = await tx.update(tasks).set({
    errorMessage: null,
    status: 'approved',
    updatedAt: now,
  }).where(and(eq(tasks.id, task.id), eq(tasks.status, 'failed'))).returning({ id: tasks.id })
  return Boolean(updated)
}

/**
 * Loss-tolerant database fallback for a task that stayed running while a live
 * sibling lease or mandatory review barrier existed. It never clears the hold,
 * creates a run, increments an attempt, or emits a wake-up.
 */
export async function convergeRecognizedOperatorHolds(limit = 100): Promise<number> {
  const candidates = await db
    .select({ id: tasks.id, projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.status, 'running'))
    .orderBy(tasks.id)
    .limit(limit)
  let converged = 0
  for (const candidate of candidates) {
    const changed = await db.transaction(async (tx) => {
      assertMcpAdmissionLockSequence(['project', 'tasks:id-ascending', 'work-packages:id-ascending'])
      const [project] = await tx.select({ id: projects.id }).from(projects)
        .where(eq(projects.id, candidate.projectId)).for('update')
      if (!project) return false
      const [task] = await tx.select().from(tasks)
        .where(and(eq(tasks.id, candidate.id), eq(tasks.status, 'running')))
        .for('update')
      if (!task) return false
      const siblings = await tx.select().from(workPackages)
        .where(eq(workPackages.taskId, task.id))
        .orderBy(workPackages.id)
        .for('update')
      return convergeOperatorHeldTask(tx, task, siblings, await lockedTransactionNow(tx))
    })
    if (changed) converged += 1
  }
  return converged
}

export async function convergeRecognizedOperatorHoldTask(taskId: string): Promise<boolean> {
  const [candidate] = await db.select({ projectId: tasks.projectId }).from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running'))).limit(1)
  if (!candidate) return false
  return db.transaction(async (tx) => {
    assertMcpAdmissionLockSequence(['project', 'tasks:id-ascending', 'work-packages:id-ascending'])
    const [project] = await tx.select({ id: projects.id }).from(projects)
      .where(eq(projects.id, candidate.projectId)).for('update')
    if (!project) return false
    const [task] = await tx.select().from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running'))).for('update')
    if (!task) return false
    const siblings = await tx.select().from(workPackages)
      .where(eq(workPackages.taskId, task.id)).orderBy(workPackages.id).for('update')
    return convergeOperatorHeldTask(tx, task, siblings, await lockedTransactionNow(tx))
  })
}

function grantPointerFingerprint(input: {
  decisionId: string
  priorFingerprint: string
  priorVersion: bigint
  revision: bigint
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    decisionId: input.decisionId,
    priorFingerprint: input.priorFingerprint,
    priorVersion: input.priorVersion.toString(),
    revision: input.revision.toString(),
  })).digest('hex')}`
}

function projectDecisionAuthority(
  decision: typeof projectFilesystemGrantDecisions.$inferSelect,
): ProjectFilesystemDecisionAuthority {
  const authority = parseProjectFilesystemDecisionAuthority({
    schemaVersion: 2,
    decisionId: decision.id,
    projectId: decision.projectId,
    decision: decision.decision,
    capabilities: decision.capabilities,
    grantDecisionRevision: decision.grantDecisionRevision.toString(),
    rootBindingRevision: decision.rootBindingRevision.toString(),
    decisionFingerprint: decision.decisionFingerprint,
    decisionGeneration: decision.decisionGeneration.toString(),
    decidedAt: decision.decidedAt.toISOString(),
    decidedBy: decision.decidedBy,
    reason: decision.reason,
    revocationReason: decision.revocationReason,
  })
  if (!authority) throw httpError('The current project filesystem decision is malformed.', 409)
  return authority
}

export async function loadCurrentProjectFilesystemDecision(
  projectId: string,
): Promise<ProjectFilesystemDecisionAuthority | null> {
  const [row] = await db
    .select({ decision: projectFilesystemGrantDecisions })
    .from(projectFilesystemCurrentDecisionPointers)
    .innerJoin(projectFilesystemGrantDecisions, and(
      eq(projectFilesystemGrantDecisions.id, projectFilesystemCurrentDecisionPointers.currentDecisionId),
      eq(projectFilesystemGrantDecisions.projectId, projectFilesystemCurrentDecisionPointers.currentDecisionProjectId),
      eq(projectFilesystemCurrentDecisionPointers.currentDecisionProjectId, projectFilesystemCurrentDecisionPointers.projectId),
      eq(projectFilesystemGrantDecisions.grantDecisionRevision, projectFilesystemCurrentDecisionPointers.currentDecisionRevision),
      eq(projectFilesystemGrantDecisions.rootBindingRevision, projectFilesystemCurrentDecisionPointers.currentRootBindingRevision),
      eq(projectFilesystemGrantDecisions.decisionFingerprint, projectFilesystemCurrentDecisionPointers.currentDecisionFingerprint),
      eq(projectFilesystemGrantDecisions.decisionGeneration, projectFilesystemCurrentDecisionPointers.currentDecisionGeneration),
      eq(projectFilesystemCurrentDecisionPointers.pointerGeneration, projectFilesystemCurrentDecisionPointers.currentDecisionGeneration),
    ))
    .where(eq(projectFilesystemCurrentDecisionPointers.projectId, projectId))
    .limit(1)
  return row && isRecord(row.decision) && typeof row.decision.id === 'string'
    ? projectDecisionAuthority(row.decision as typeof projectFilesystemGrantDecisions.$inferSelect)
    : null
}

function projectDecisionFingerprint(input: {
  actorId: string
  capabilities: readonly string[]
  decidedAt: Date
  decision: 'approved' | 'revoked'
  decisionId: string
  generation: bigint
  prior: ProjectDecisionPointer
  projectId: string
  reason: string
  revision: bigint
  revocationReason: ProjectFilesystemDecisionRevocationReason | null
  rootBindingRevision: bigint
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    actorId: input.actorId,
    capabilities: input.capabilities,
    decidedAt: input.decidedAt.toISOString(),
    decision: input.decision,
    decisionId: input.decisionId,
    generation: input.generation.toString(),
    priorDecisionFingerprint: input.prior.currentDecisionFingerprint,
    priorDecisionId: input.prior.currentDecisionId,
    priorDecisionRevision: input.prior.currentDecisionRevision?.toString() ?? null,
    priorGeneration: input.prior.pointerGeneration.toString(),
    priorRootBindingRevision: input.prior.currentRootBindingRevision?.toString() ?? null,
    projectId: input.projectId,
    reason: input.reason,
    revision: input.revision.toString(),
    revocationReason: input.revocationReason,
    rootBindingRevision: input.rootBindingRevision.toString(),
  })).digest('hex')}`
}

async function appendProjectFilesystemDecision(input: {
  actorId: string
  capabilities: readonly string[]
  decision: 'approved' | 'revoked'
  lockedProject: LockedProject
  now: Date
  pointer: ProjectDecisionPointer
  reason: string
  revision: bigint
  revocationReason: ProjectFilesystemDecisionRevocationReason | null
  rootBindingRevision?: bigint
  tx: GrantTransaction
}): Promise<{
  authority: ProjectFilesystemDecisionAuthority
  decision: typeof projectFilesystemGrantDecisions.$inferSelect
  pointer: ProjectDecisionPointer
}> {
  const decisionId = randomUUID()
  const generation = input.pointer.pointerGeneration + BigInt(1)
  const rootBindingRevision = input.rootBindingRevision ?? input.lockedProject.rootBindingRevision
  const fingerprint = projectDecisionFingerprint({
    actorId: input.actorId,
    capabilities: input.capabilities,
    decidedAt: input.now,
    decision: input.decision,
    decisionId,
    generation,
    prior: input.pointer,
    projectId: input.lockedProject.id,
    reason: input.reason,
    revision: input.revision,
    revocationReason: input.revocationReason,
    rootBindingRevision,
  })
  const [decision] = await input.tx.insert(projectFilesystemGrantDecisions).values({
    id: decisionId,
    projectId: input.lockedProject.id,
    decision: input.decision,
    capabilities: [...input.capabilities],
    grantDecisionRevision: input.revision,
    rootBindingRevision,
    decisionFingerprint: fingerprint,
    decisionGeneration: generation,
    priorDecisionId: input.pointer.currentDecisionId,
    priorDecisionProjectId: input.pointer.currentDecisionProjectId,
    priorDecisionRevision: input.pointer.currentDecisionRevision,
    priorRootBindingRevision: input.pointer.currentRootBindingRevision,
    priorDecisionFingerprint: input.pointer.currentDecisionFingerprint,
    priorDecisionGeneration: input.pointer.pointerGeneration === BigInt(0)
      ? null
      : input.pointer.pointerGeneration,
    revocationReason: input.revocationReason,
    reason: input.reason,
    decidedBy: input.actorId,
    decidedAt: input.now,
  }).returning()
  const [pointer] = await input.tx.update(projectFilesystemCurrentDecisionPointers).set({
    currentDecisionId: decision.id,
    currentDecisionProjectId: decision.projectId,
    currentDecisionRevision: decision.grantDecisionRevision,
    currentRootBindingRevision: decision.rootBindingRevision,
    currentDecisionFingerprint: decision.decisionFingerprint,
    currentDecisionGeneration: decision.decisionGeneration,
    pointerGeneration: decision.decisionGeneration,
    updatedAt: input.now,
  }).where(and(
    eq(projectFilesystemCurrentDecisionPointers.projectId, input.pointer.projectId),
    input.pointer.currentDecisionId === null
      ? isNull(projectFilesystemCurrentDecisionPointers.currentDecisionId)
      : eq(projectFilesystemCurrentDecisionPointers.currentDecisionId, input.pointer.currentDecisionId),
    input.pointer.currentDecisionProjectId === null
      ? isNull(projectFilesystemCurrentDecisionPointers.currentDecisionProjectId)
      : eq(projectFilesystemCurrentDecisionPointers.currentDecisionProjectId, input.pointer.currentDecisionProjectId),
    input.pointer.currentDecisionRevision === null
      ? isNull(projectFilesystemCurrentDecisionPointers.currentDecisionRevision)
      : eq(projectFilesystemCurrentDecisionPointers.currentDecisionRevision, input.pointer.currentDecisionRevision),
    input.pointer.currentRootBindingRevision === null
      ? isNull(projectFilesystemCurrentDecisionPointers.currentRootBindingRevision)
      : eq(projectFilesystemCurrentDecisionPointers.currentRootBindingRevision, input.pointer.currentRootBindingRevision),
    input.pointer.currentDecisionFingerprint === null
      ? isNull(projectFilesystemCurrentDecisionPointers.currentDecisionFingerprint)
      : eq(projectFilesystemCurrentDecisionPointers.currentDecisionFingerprint, input.pointer.currentDecisionFingerprint),
    input.pointer.currentDecisionGeneration === null
      ? isNull(projectFilesystemCurrentDecisionPointers.currentDecisionGeneration)
      : eq(projectFilesystemCurrentDecisionPointers.currentDecisionGeneration, input.pointer.currentDecisionGeneration),
    eq(projectFilesystemCurrentDecisionPointers.pointerGeneration, input.pointer.pointerGeneration),
  )).returning()
  if (!pointer) {
    throw httpError('Project filesystem decision changed concurrently. Review the current authority before retrying.', 409)
  }
  return { authority: projectDecisionAuthority(decision), decision, pointer }
}

function buildEffectivePhase(input: {
  approvalId: string
  capabilities: FilesystemProjectCapability[]
  decision: 'approved' | 'denied'
  decidedAt: Date
  decidedBy: string
  grantDecisionRevision: string
  grantMode: 'allow_once'
  grantNonce: string | null
  reason: string
  requestedCapabilities: string[]
  rootBindingRevision: string
}): Record<string, unknown> {
  const common = {
    schemaVersion: 2,
    phase: 'effective',
    source: 'explicit-grant-approval',
    grantApprovalId: input.approvalId,
    grantDecisionRevision: input.grantDecisionRevision,
    rootBindingRevision: input.rootBindingRevision,
    runtimeIssued: false,
    runtimeEnforcement: 'bounded_context_packet',
  }
  if (input.decision === 'denied') {
    return {
      ...common,
      deniedAt: input.decidedAt.toISOString(),
      deniedBy: input.decidedBy,
      deniedCapabilities: input.requestedCapabilities,
      grants: [],
      reason: input.reason,
      status: 'denied',
    }
  }
  return {
    ...common,
    approvedAt: input.decidedAt.toISOString(),
    approvedBy: input.decidedBy,
    grantMode: input.grantMode,
    grantNonce: input.grantNonce,
    grants: [{
      grantApprovalId: input.approvalId,
      mcpId: FILESYSTEM_MCP_ID,
      status: 'approved',
      capabilities: input.capabilities,
      grantMode: input.grantMode,
      reason: input.reason,
    }],
    reason: input.reason,
    scope: 'next_context_issue',
    status: 'approved',
  }
}

function phasesWithEffective(metadata: unknown, effective: Record<string, unknown>): Record<string, unknown> {
  const record = isRecord(metadata) ? metadata : {}
  const phases = isRecord(record.mcpGrantPhases) ? record.mcpGrantPhases : {}
  return {
    ...phases,
    schemaVersion: 2,
    proposed: Array.isArray(phases.proposed)
      ? phases.proposed
      : Array.isArray(record.mcpGrants) ? record.mcpGrants : [],
    effective,
  }
}

function metadataPatchSql(input: {
  clearMarker: boolean
  effective?: Record<string, unknown>
  marker?: Record<string, unknown>
}) {
  let expression = sql`coalesce(${workPackages.metadata}, '{}'::jsonb)`
  if (input.effective) {
    expression = sql`jsonb_set(${expression}, '{mcpGrantPhases}', ${JSON.stringify(input.effective)}::jsonb, true)`
  }
  if (input.clearMarker) {
    expression = sql`${expression} - ${FILESYSTEM_GRANT_BLOCK_METADATA_KEY}`
  } else if (input.marker) {
    expression = sql`jsonb_set(${expression}, '{mcpGrantBlock}', ${JSON.stringify(input.marker)}::jsonb, true)`
  }
  return expression
}

async function applyCanonicalProjection(input: {
  lockedProject: LockedProject
  now: Date
  packages: Map<string, LockedPackage>
  packageIds: readonly string[]
  projectAuthority: ProjectFilesystemDecisionAuthority | null
  forcePackageIds?: ReadonlySet<string>
  tx: GrantTransaction
}): Promise<Set<string>> {
  const recoveredTaskIds = new Set<string>()
  for (const packageId of input.packageIds) {
    const pkg = input.packages.get(packageId)
    if (!pkg || !PACKAGE_EDITABLE.has(pkg.status)) continue
    const check = requiresFilesystemGrantApproval({
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      projectMcpConfig: input.lockedProject.mcpConfig,
      projectFilesystemDecision: input.projectAuthority,
      projectRootBindingRevision: input.lockedProject.rootBindingRevision,
    })
    const existingMarker = isRecord(pkg.metadata)
      ? pkg.metadata[FILESYSTEM_GRANT_BLOCK_METADATA_KEY]
      : undefined
    const parsedMarker = parseFilesystemGrantBlockMetadata(existingMarker)
    const forcePersist = input.forcePackageIds?.has(pkg.id) === true
    const currentPhases = isRecord(pkg.metadata) && isRecord(pkg.metadata.mcpGrantPhases)
      ? pkg.metadata.mcpGrantPhases
      : undefined

    if (!check.blocked) {
      if (!parsedMarker && !forcePersist) continue
      const grant = projectFilesystemGrantFromAuthority(input.projectAuthority)
      const effective = grant
        ? phasesWithEffective(pkg.metadata, projectFilesystemEffectivePhase(grant))
        : forcePersist ? currentPhases : undefined
      const recovering = Boolean(parsedMarker)
      const [updated] = await input.tx
        .update(workPackages)
        .set({
          blockedReason: recovering ? null : pkg.blockedReason,
          metadata: metadataPatchSql({ clearMarker: true, effective }),
          status: recovering && (pkg.status === 'blocked' || pkg.status === 'failed')
            ? 'ready'
            : pkg.status,
          updatedAt: input.now,
        })
        .where(parsedMarker
          ? and(
              eq(workPackages.id, pkg.id),
              sql`${workPackages.metadata}->'mcpGrantBlock'->>'blockFingerprint' = ${parsedMarker.blockFingerprint}`,
            )
          : eq(workPackages.id, pkg.id))
        .returning()
      if (!updated && forcePersist) throw httpError('Work package is no longer editable.', 409)
      if (updated) input.packages.set(updated.id, updated)
      if (updated && recovering && updated.status === 'ready') recoveredTaskIds.add(updated.taskId)
      continue
    }

    if (!check.holdState) throw new Error('Blocked filesystem projection has no canonical hold state')
    // Grant reconciliation owns only packages that are claim-eligible or
    // already carry its exact marker. An unrelated dependency, review,
    // security, or execution failure must remain intact.
    if (
      !parsedMarker &&
      pkg.status !== 'pending' &&
      pkg.status !== 'ready'
    ) continue
    const requestedCapabilities = canonicalFilesystemProjectCapabilities(check.requestedCapabilities)
    const marker = buildFilesystemGrantBlockMetadata({
      blockedAt: input.now,
      hold: check.holdState,
      requirementKeys: check.requirementKeys,
      requestedCapabilities,
      rootBindingRevision: input.lockedProject.rootBindingRevision.toString(),
    })
    const [updated] = await input.tx
      .update(workPackages)
      .set({
        blockedReason: 'Filesystem context requires an operator decision before execution.',
        metadata: metadataPatchSql({
          clearMarker: false,
          effective: forcePersist ? currentPhases : undefined,
          marker,
        }),
        status: ['pending', 'ready', 'needs_rework', 'failed'].includes(pkg.status)
          ? 'blocked'
          : pkg.status,
        updatedAt: input.now,
      })
      .where(eq(workPackages.id, pkg.id))
      .returning()
    if (!updated && forcePersist) throw httpError('Work package is no longer editable.', 409)
    if (updated) input.packages.set(updated.id, updated)
  }
  return recoveredTaskIds
}

export type FilesystemGrantProjectReconciliationTrigger =
  | 'task_always_allow'
  | 'project_always_allow'
  | 'project_grant_revocation'
  | 'project_root_repoint'

export type FilesystemGrantProjectReconciliationResult = {
  recoveredTaskIds: string[]
}

/** Build the grant-only config patch S4 uses after it atomically advances the root binding. */
export function filesystemMcpConfigAfterRootRepoint(input: {
  grantApprovalId?: string | null
  grantDecisionRevision: bigint
  mcpConfig: ProjectMcpConfig
  rootBindingRevision: bigint
}): ProjectMcpConfig {
  if (input.rootBindingRevision <= BigInt(0)) {
    throw new Error('Root repoint requires a positive root-binding revision.')
  }
  const grants = isRecord(input.mcpConfig.grants) ? input.mcpConfig.grants : {}
  const previousGrant = isRecord(grants.filesystem) ? grants.filesystem : {}
  const withoutFilesystem = Object.fromEntries(
    Object.entries(grants).filter(([key]) => key !== 'filesystem' && key !== 'filesystemRevocation'),
  )
  return {
    ...input.mcpConfig,
    grants: input.grantDecisionRevision > BigInt(0)
      ? {
          ...withoutFilesystem,
          filesystemRevocation: {
            schemaVersion: 2,
            grantApprovalId: input.grantApprovalId ?? (
              typeof previousGrant.grantApprovalId === 'string' ? previousGrant.grantApprovalId : null
            ),
            grantDecisionRevision: input.grantDecisionRevision.toString(),
            rootBindingRevision: input.rootBindingRevision.toString(),
            revocationReason: 'project_root_repoint',
          },
        }
      : withoutFilesystem,
  }
}

function projectReconciliationCandidateIds(input: {
  packages: readonly LockedPackage[]
  rootBindingRevision: bigint
  trigger: FilesystemGrantProjectReconciliationTrigger
}): string[] {
  // Immutable project authority, not per-package projection metadata, owns
  // narrowing/removal/repoint semantics. Reevaluate the complete locked set so
  // untouched pending/ready packages cannot retain authority by omission.
  return input.packages.map((pkg) => pkg.id)
}

async function reconcileLockedProjectRows(input: {
  lockedProject: LockedProject
  nextMcpConfig: ProjectMcpConfig
  packages: Map<string, LockedPackage>
  projectAuthority: ProjectFilesystemDecisionAuthority | null
  taskRows: readonly LockedTask[]
  trigger: FilesystemGrantProjectReconciliationTrigger
  tx: GrantTransaction
  now: Date
}): Promise<FilesystemGrantProjectReconciliationResult> {
  const packageIds = projectReconciliationCandidateIds({
    packages: [...input.packages.values()],
    rootBindingRevision: input.lockedProject.rootBindingRevision,
    trigger: input.trigger,
  })
  const evaluationProject: LockedProject = {
    ...input.lockedProject,
    mcpConfig: input.nextMcpConfig,
  }
  const recovered = await applyCanonicalProjection({
    lockedProject: evaluationProject,
    now: input.now,
    packages: input.packages,
    packageIds,
    projectAuthority: input.projectAuthority,
    tx: input.tx,
  })
  for (const task of input.taskRows) {
    const siblings = [...input.packages.values()].filter((pkg) => pkg.taskId === task.id)
    const converged = await convergeOperatorHeldTask(input.tx, task, siblings, input.now)
    if (converged) recovered.add(task.id)
    const legacyRecovered = await recoverLegacyFailedGrantTask(
      input.tx,
      task,
      siblings,
      recovered,
      input.now,
    )
    if (recovered.has(task.id) && task.status !== 'approved' && !converged && !legacyRecovered) {
      recovered.delete(task.id)
    }
  }
  return { recoveredTaskIds: [...recovered].sort() }
}

/**
 * Canonical project-wide grant reconciler. The caller owns and passes the
 * already locked project row. This service never reacquires or rereads that
 * row; it expands and locks the complete task/package/decision authority set
 * in the shared order before changing package projections.
 */
export async function reconcileFilesystemGrantsForProject(
  tx: GrantTransaction,
  input: {
    actorId: string
    grantDecisionRevision: string
    lockedProject: LockedProject
    nextMcpConfig: ProjectMcpConfig
    trigger: FilesystemGrantProjectReconciliationTrigger
  },
): Promise<FilesystemGrantProjectReconciliationResult> {
  if (!input.actorId.trim()) throw new Error('Grant reconciliation requires an actor.')
  if (!/^(0|[1-9][0-9]*)$/.test(input.grantDecisionRevision)) {
    throw new Error('Grant reconciliation requires a canonical decision revision.')
  }
  if (input.trigger !== 'project_root_repoint' && input.grantDecisionRevision === '0') {
    throw new Error('Grant reconciliation requires a positive decision revision.')
  }
  if (input.trigger !== 'project_root_repoint') {
    throw new Error('Direct project reconciliation is reserved for the root-repoint authority transition.')
  }
  if (BigInt(input.grantDecisionRevision) !== input.lockedProject.grantDecisionRevision) {
    throw httpError('Project filesystem decision changed before root reconciliation.', 409)
  }
  assertMcpAdmissionLockSequence([
    'project',
    'tasks:id-ascending',
    'work-packages:id-ascending',
    'grant-approval-decision-rows:id-ascending',
  ])
  const taskRows = await tx.select().from(tasks)
    .where(eq(tasks.projectId, input.lockedProject.id))
    .orderBy(tasks.id)
    .for('update')
  const packageRows = taskRows.length === 0
    ? []
    : await tx.select().from(workPackages)
      .where(inArray(workPackages.taskId, taskRows.map((task) => task.id)))
      .orderBy(workPackages.id)
      .for('update')
  const packageDecisionRows = await tx.select()
    .from(filesystemMcpGrantApprovals)
    .where(eq(filesystemMcpGrantApprovals.projectId, input.lockedProject.id))
    .orderBy(filesystemMcpGrantApprovals.id)
    .for('update')
  const projectDecisionRows = await tx.select().from(projectFilesystemGrantDecisions)
    .where(eq(projectFilesystemGrantDecisions.projectId, input.lockedProject.id))
    .orderBy(projectFilesystemGrantDecisions.id)
    .for('update')
  const [projectPointer] = await tx.select().from(projectFilesystemCurrentDecisionPointers)
    .where(eq(projectFilesystemCurrentDecisionPointers.projectId, input.lockedProject.id))
    .for('update')
  if (!projectPointer) throw httpError('Project filesystem decision authority is not initialized.', 409)
  const currentProjectDecision = projectDecisionPointerParent(projectPointer, projectDecisionRows)
  if (currentProjectDecision === undefined) {
    throw httpError('Project filesystem decision pointer does not match its immutable parent.', 409)
  }
  const pointerRows = packageRows.length === 0
    ? []
    : await tx.select()
      .from(filesystemMcpCurrentDecisionPointers)
      .where(inArray(
        filesystemMcpCurrentDecisionPointers.workPackageId,
        packageRows.map((pkg) => pkg.id),
      ))
      .orderBy(filesystemMcpCurrentDecisionPointers.workPackageId)
      .for('update')
  if (pointerRows.length !== packageRows.length) {
    throw httpError('Filesystem decision authority is not initialized for every package.', 409)
  }
  if (pointerRows.some((pointer) => packageDecisionPointerParent(pointer, packageDecisionRows) === undefined)) {
    throw httpError('Filesystem decision pointer does not match its immutable package decision.', 409)
  }
  const now = await lockedTransactionNow(tx)
  const revision = input.lockedProject.grantDecisionRevision
  const nextMcpConfig = filesystemMcpConfigAfterRootRepoint({
    grantApprovalId: currentProjectDecision?.id ?? null,
    grantDecisionRevision: revision,
    mcpConfig: input.nextMcpConfig,
    rootBindingRevision: input.lockedProject.rootBindingRevision,
  })
  return reconcileLockedProjectRows({
    lockedProject: input.lockedProject,
    nextMcpConfig,
    now,
    packages: new Map(packageRows.map((pkg) => [pkg.id, pkg])),
    projectAuthority: currentProjectDecision ? projectDecisionAuthority(currentProjectDecision) : null,
    taskRows,
    trigger: input.trigger,
    tx,
  })
}

async function lockMutationRows(input: {
  projectId: string
  targetPackageIds: readonly string[]
  taskId?: string
  projectWide: boolean
  tx: GrantTransaction
}) {
  assertMcpAdmissionLockSequence([
    'project',
    'tasks:id-ascending',
    'work-packages:id-ascending',
    'grant-approval-decision-rows:id-ascending',
  ])
  const [project] = await input.tx
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .for('update')
  if (!project) throw httpError('Project not found.', 404)

  const taskRows = await input.tx
    .select()
    .from(tasks)
    .where(input.projectWide
      ? eq(tasks.projectId, project.id)
      : and(eq(tasks.projectId, project.id), eq(tasks.id, input.taskId!)))
    .orderBy(tasks.id)
    .for('update')
  if (!input.projectWide && taskRows.length !== 1) throw httpError('Task not found.', 404)

  const packageRows = taskRows.length === 0
    ? []
    : await input.tx
      .select()
      .from(workPackages)
      .where(inArray(workPackages.taskId, taskRows.map((task) => task.id)))
      .orderBy(workPackages.id)
      .for('update')
  const packageById = new Map(packageRows.map((pkg) => [pkg.id, pkg]))
  if (input.targetPackageIds.some((id) => !packageById.has(id))) {
    throw httpError('One or more work packages do not belong to this task.', 404)
  }

  let packageDecisionRows: PackageDecision[] = []
  if (input.targetPackageIds.length > 0 || input.projectWide) {
    const decisionScope = input.projectWide
      ? eq(filesystemMcpGrantApprovals.projectId, project.id)
      : inArray(filesystemMcpGrantApprovals.workPackageId, [...input.targetPackageIds])
    packageDecisionRows = await input.tx
      .select()
      .from(filesystemMcpGrantApprovals)
      .where(and(
        eq(filesystemMcpGrantApprovals.projectId, project.id),
        decisionScope,
      ))
      .orderBy(filesystemMcpGrantApprovals.id)
      .for('update')
  }

  const projectDecisionRows = await input.tx
    .select()
    .from(projectFilesystemGrantDecisions)
    .where(eq(projectFilesystemGrantDecisions.projectId, project.id))
    .orderBy(projectFilesystemGrantDecisions.id)
    .for('update')

  const [projectPointer] = await input.tx
    .select()
    .from(projectFilesystemCurrentDecisionPointers)
    .where(eq(projectFilesystemCurrentDecisionPointers.projectId, project.id))
    .for('update')
  if (!projectPointer) {
    throw httpError('Project filesystem decision authority is not initialized.', 409)
  }
  const currentProjectDecision = projectDecisionPointerParent(projectPointer, projectDecisionRows)
  if (currentProjectDecision === undefined) {
    throw httpError('Project filesystem decision pointer does not match its immutable parent.', 409)
  }

  const pointerPackageIds = input.projectWide
    ? packageRows.map((pkg) => pkg.id)
    : [...input.targetPackageIds]
  const pointerRows = pointerPackageIds.length === 0
    ? []
    : await input.tx
      .select()
      .from(filesystemMcpCurrentDecisionPointers)
      .where(inArray(filesystemMcpCurrentDecisionPointers.workPackageId, pointerPackageIds))
      .orderBy(filesystemMcpCurrentDecisionPointers.workPackageId)
      .for('update')
  if (pointerRows.length !== pointerPackageIds.length) {
    throw httpError('Filesystem decision authority is not initialized for every package.', 409)
  }
  if (pointerRows.some((pointer) => packageDecisionPointerParent(pointer, packageDecisionRows) === undefined)) {
    throw httpError('Filesystem decision pointer does not match its immutable package decision.', 409)
  }
  return {
    packageById,
    pointerByPackageId: new Map(pointerRows.map((pointer) => [pointer.workPackageId, pointer])),
    project,
    projectAuthority: currentProjectDecision ? projectDecisionAuthority(currentProjectDecision) : null,
    projectPointer,
    taskRows,
  }
}

function validatePackageMutation(pkg: LockedPackage, mutation: FilesystemGrantMutation) {
  if (!PACKAGE_EDITABLE.has(pkg.status)) {
    throw httpError(`Cannot edit filesystem grants for package '${pkg.title}' after execution starts.`, 409)
  }
  const summary = summarizeFilesystemCapabilities({
    mcpRequirements: pkg.mcpRequirements,
    metadata: pkg.metadata,
  })
  const requested = new Set(summary.boundedRuntimeRequestedCapabilities)
  const capabilities = canonicalFilesystemProjectCapabilities(mutation.capabilities)
    .filter((capability) => requested.has(capability))
  if (mutation.decision === 'approved') {
    if (requested.size === 0) throw httpError('This package did not request filesystem context.', 400)
    if (capabilities.length === 0 || !capabilities.includes('filesystem.project.read')) {
      throw httpError('Approved bounded filesystem context must include filesystem.project.read.', 400)
    }
    const missing = summary.blockingCapabilities.filter((capability) => !capabilities.includes(capability))
    if (missing.length > 0) {
      throw httpError(`Approved filesystem grants must include required capabilities: ${missing.join(', ')}.`, 400)
    }
  }
  return { capabilities, summary }
}

export async function mutateTaskFilesystemGrants(input: {
  actorId: string
  mutations: readonly FilesystemGrantMutation[]
  projectId: string
  taskId: string
}): Promise<FilesystemGrantMutationResult> {
  const projectWide = input.mutations.some((mutation) => (
    mutation.decision === 'approved' && mutation.grantMode === 'always_allow'
  ))
  return db.transaction(async (tx) => {
    const locked = await lockMutationRows({
      projectId: input.projectId,
      targetPackageIds: [...new Set(input.mutations.map((mutation) => mutation.workPackageId))],
      taskId: input.taskId,
      projectWide,
      tx,
    })
    const now = await lockedTransactionNow(tx)
    const targetTask = locked.taskRows.find((task) => task.id === input.taskId)
    if (!targetTask || !TASK_EDITABLE.has(targetTask.status)) {
      throw httpError(`Cannot edit filesystem grants while task status is '${targetTask?.status ?? 'missing'}'.`, 409)
    }
    if (locked.project.rootBindingRevision <= BigInt(0)) {
      throw httpError('The project root is not bound to protocol v2. Filesystem decisions remain disabled.', 409)
    }

    let revision = locked.project.grantDecisionRevision
    let nextConfig = locked.project.mcpConfig
    let projectAuthority = locked.projectAuthority
    let projectPointer = locked.projectPointer
    const approvals: FilesystemGrantMutationResult['approvals'] = []
    const states: FilesystemGrantMutationResult['states'] = []
    const directlyAffected = new Set<string>()

    for (const mutation of input.mutations) {
      const pkg = locked.packageById.get(mutation.workPackageId)!
      const { capabilities, summary } = validatePackageMutation(pkg, mutation)
      if (mutation.decision === 'approved' && mutation.grantMode === 'allow_once') {
        const required = summary.blockingCapabilities.length > 0
          ? summary.blockingCapabilities
          : summary.boundedRuntimeRequestedCapabilities
        const inherited = readEffectiveGrantState(
          { metadata: pkg.metadata },
          {
            mcpConfig: nextConfig,
            filesystemGrantDecision: projectAuthority,
            rootBindingRevision: locked.project.rootBindingRevision,
          },
          required,
        )
        if (inherited.phase === 'approved' && inherited.source === 'project-level') {
          states.push({
            approvalId: inherited.grantApprovalId ?? '',
            decision: 'approved',
            grantDecisionRevision: inherited.grantDecisionRevision!,
            workPackageId: pkg.id,
          })
          continue
        }
      }
      revision += BigInt(1)
      const revisionText = revision.toString()
      const approvalId = randomUUID()

      if (mutation.decision === 'approved' && mutation.grantMode === 'always_allow') {
        const grants = isRecord(nextConfig.grants) ? nextConfig.grants : {}
        const merged = canonicalFilesystemProjectCapabilities([
          ...(projectAuthority?.decision === 'approved' ? projectAuthority.capabilities : []),
          ...capabilities,
        ])
        const appended = await appendProjectFilesystemDecision({
          actorId: input.actorId,
          capabilities: merged,
          decision: 'approved',
          lockedProject: locked.project,
          now,
          pointer: projectPointer,
          reason: mutation.reason,
          revision,
          revocationReason: null,
          tx,
        })
        projectAuthority = appended.authority
        projectPointer = appended.pointer
        approvals.push({
          id: appended.decision.id,
          capabilities: appended.decision.capabilities,
          decision: appended.decision.decision,
          grantDecisionRevision: appended.decision.grantDecisionRevision,
          workPackageId: null,
        })
        nextConfig = {
          ...nextConfig,
          grants: {
            ...grants,
            filesystem: {
              schemaVersion: 2,
              mcpId: FILESYSTEM_MCP_ID,
              status: 'approved',
              grantMode: 'always_allow',
              capabilities: merged,
              grantApprovalId: appended.decision.id,
              grantDecisionRevision: revisionText,
              rootBindingRevision: locked.project.rootBindingRevision.toString(),
              approvedAt: now.toISOString(),
              approvedBy: input.actorId,
              reason: mutation.reason,
            },
          },
        }
        states.push({
          approvalId: appended.decision.id,
          decision: 'approved',
          grantDecisionRevision: revisionText,
          workPackageId: pkg.id,
        })
        continue
      }

      const pointer = locked.pointerByPackageId.get(pkg.id)!
      const expected = mutation.expectedPointer
      const currentPointerSnapshot = {
        currentDecisionId: pointer.currentDecisionId,
        currentDecisionRevision: pointer.currentDecisionRevision?.toString() ?? null,
        pointerFingerprint: pointer.pointerFingerprint,
        pointerVersion: pointer.pointerVersion.toString(),
      }
      if (
        (pointer.currentDecisionId !== null && !expected) ||
        (expected && (
          expected.currentDecisionId !== currentPointerSnapshot.currentDecisionId ||
          expected.currentDecisionRevision !== currentPointerSnapshot.currentDecisionRevision ||
          expected.pointerFingerprint !== currentPointerSnapshot.pointerFingerprint ||
          expected.pointerVersion !== currentPointerSnapshot.pointerVersion
        ))
      ) {
        throw httpError('Filesystem decision changed. Review the current decision and submit explicit intent against its pointer.', 409)
      }
      const nonce = mutation.decision === 'approved' ? randomUUID() : null
      const nextFingerprint = grantPointerFingerprint({
        decisionId: approvalId,
        priorFingerprint: pointer.pointerFingerprint,
        priorVersion: pointer.pointerVersion,
        revision,
      })
      const effective = buildEffectivePhase({
        approvalId,
        capabilities,
        decision: mutation.decision,
        decidedAt: now,
        decidedBy: input.actorId,
        grantDecisionRevision: revisionText,
        grantMode: 'allow_once',
        grantNonce: nonce,
        reason: mutation.reason,
        requestedCapabilities: summary.requestedCapabilities,
        rootBindingRevision: locked.project.rootBindingRevision.toString(),
      })
      const [approval] = await tx.insert(filesystemMcpGrantApprovals).values({
        id: approvalId,
        projectId: locked.project.id,
        taskId: pkg.taskId,
        workPackageId: pkg.id,
        decisionScope: 'package',
        decidedBy: input.actorId,
        decision: mutation.decision,
        capabilities: mutation.decision === 'approved' ? capabilities : [],
        reason: mutation.reason,
        effectiveGrant: effective,
        grantDecisionRevision: revision,
        rootBindingRevision: locked.project.rootBindingRevision,
        grantNonce: nonce,
        pointerFingerprint: nextFingerprint,
        updatedAt: now,
      }).returning()
      const [advanced] = await tx
        .update(filesystemMcpCurrentDecisionPointers)
        .set({
          currentDecisionId: approval.id,
          currentDecisionTaskId: approval.taskId,
          currentDecisionWorkPackageId: approval.workPackageId,
          currentDecisionRevision: revision,
          currentDecisionFingerprint: nextFingerprint,
          pointerFingerprint: nextFingerprint,
          pointerVersion: pointer.pointerVersion + BigInt(1),
          updatedAt: now,
        })
        .where(and(
          eq(filesystemMcpCurrentDecisionPointers.id, pointer.id),
          pointer.currentDecisionId
            ? eq(filesystemMcpCurrentDecisionPointers.currentDecisionId, pointer.currentDecisionId)
            : isNull(filesystemMcpCurrentDecisionPointers.currentDecisionId),
          pointer.currentDecisionTaskId === null
            ? isNull(filesystemMcpCurrentDecisionPointers.currentDecisionTaskId)
            : eq(filesystemMcpCurrentDecisionPointers.currentDecisionTaskId, pointer.currentDecisionTaskId),
          pointer.currentDecisionWorkPackageId === null
            ? isNull(filesystemMcpCurrentDecisionPointers.currentDecisionWorkPackageId)
            : eq(filesystemMcpCurrentDecisionPointers.currentDecisionWorkPackageId, pointer.currentDecisionWorkPackageId),
          pointer.currentDecisionRevision === null
            ? isNull(filesystemMcpCurrentDecisionPointers.currentDecisionRevision)
            : eq(filesystemMcpCurrentDecisionPointers.currentDecisionRevision, pointer.currentDecisionRevision),
          pointer.currentDecisionFingerprint === null
            ? isNull(filesystemMcpCurrentDecisionPointers.currentDecisionFingerprint)
            : eq(filesystemMcpCurrentDecisionPointers.currentDecisionFingerprint, pointer.currentDecisionFingerprint),
          eq(filesystemMcpCurrentDecisionPointers.pointerFingerprint, pointer.pointerFingerprint),
          eq(filesystemMcpCurrentDecisionPointers.pointerVersion, pointer.pointerVersion),
        ))
        .returning()
      if (!advanced) throw httpError('Filesystem decision changed concurrently. Review the latest decision before retrying.', 409)
      locked.pointerByPackageId.set(pkg.id, advanced)
      const phases = phasesWithEffective(pkg.metadata, effective)
      const metadata = isRecord(pkg.metadata) ? pkg.metadata : {}
      locked.packageById.set(pkg.id, {
        ...pkg,
        metadata: { ...metadata, mcpGrantPhases: phases },
        updatedAt: now,
      })
      directlyAffected.add(pkg.id)
      approvals.push({
        id: approval.id,
        capabilities: approval.capabilities,
        decision: approval.decision,
        grantDecisionRevision: approval.grantDecisionRevision,
        workPackageId: approval.workPackageId,
      })
      states.push({ approvalId, decision: mutation.decision, grantDecisionRevision: revisionText, workPackageId: pkg.id })
    }

    const [updatedProject] = await tx.update(projects).set({
      grantDecisionRevision: revision,
      mcpConfig: nextConfig,
      updatedAt: now,
    }).where(and(
      eq(projects.id, locked.project.id),
      eq(projects.grantDecisionRevision, locked.project.grantDecisionRevision),
      sql`${projects.mcpConfig} IS NOT DISTINCT FROM ${JSON.stringify(locked.project.mcpConfig)}::jsonb`,
    )).returning()
    if (!updatedProject) throw httpError('Project filesystem policy changed concurrently. Retry from the current state.', 409)
    locked.project = updatedProject

    if (projectWide) {
      const reconciled = await reconcileLockedProjectRows({
        lockedProject: locked.project,
        nextMcpConfig: nextConfig,
        now,
        packages: locked.packageById,
        projectAuthority,
        taskRows: locked.taskRows,
        trigger: 'task_always_allow',
        tx,
      })
      return { approvals, recoveredTaskIds: reconciled.recoveredTaskIds, states }
    }
    const recoveredTaskIds = await applyCanonicalProjection({
      lockedProject: locked.project,
      now,
      packages: locked.packageById,
      packageIds: [...directlyAffected],
      projectAuthority,
      forcePackageIds: directlyAffected,
      tx,
    })
    for (const task of locked.taskRows) {
      const siblings = [...locked.packageById.values()].filter((pkg) => pkg.taskId === task.id)
      const converged = await convergeOperatorHeldTask(tx, task, siblings, now)
      if (converged) recoveredTaskIds.add(task.id)
      const legacyRecovered = await recoverLegacyFailedGrantTask(
        tx,
        task,
        siblings,
        recoveredTaskIds,
        now,
      )
      if (recoveredTaskIds.has(task.id) && task.status !== 'approved' && !converged && !legacyRecovered) {
        recoveredTaskIds.delete(task.id)
      }
    }
    return { approvals, recoveredTaskIds: [...recoveredTaskIds].sort(), states }
  })
}

export async function mutateProjectFilesystemGrant(input: {
  actorId: string
  capabilities: readonly string[]
  enabled: boolean
  projectId: string
  reason: string
}): Promise<{
  authority: ProjectFilesystemDecisionAuthority
  grant: ReturnType<typeof projectFilesystemGrantFromAuthority>
  mcpConfig: ProjectMcpConfig
  recoveredTaskIds: string[]
}> {
  return db.transaction(async (tx) => {
    const locked = await lockMutationRows({
      projectId: input.projectId,
      targetPackageIds: [],
      projectWide: true,
      tx,
    })
    const now = await lockedTransactionNow(tx)
    if (locked.project.rootBindingRevision <= BigInt(0)) {
      throw httpError('The project root is not bound to protocol v2. Filesystem decisions remain disabled.', 409)
    }
    const revision = locked.project.grantDecisionRevision + BigInt(1)
    const revisionText = revision.toString()
    const capabilities = canonicalFilesystemProjectCapabilities(input.capabilities)
    if (input.enabled && (capabilities.length === 0 || !capabilities.includes('filesystem.project.read'))) {
      throw httpError('Project filesystem authority must include filesystem.project.read.', 400)
    }
    const existingGrants = isRecord(locked.project.mcpConfig.grants)
      ? locked.project.mcpConfig.grants
      : {}
    const narrowed = input.enabled && locked.projectAuthority?.decision === 'approved' &&
      locked.projectAuthority.capabilities.some((capability) => !capabilities.includes(capability as FilesystemProjectCapability))
    const appended = await appendProjectFilesystemDecision({
      actorId: input.actorId,
      capabilities: input.enabled ? capabilities : [],
      decision: input.enabled ? 'approved' : 'revoked',
      lockedProject: locked.project,
      now,
      pointer: locked.projectPointer,
      reason: input.reason,
      revision,
      revocationReason: input.enabled
        ? narrowed ? 'project_grant_narrowed' : null
        : 'project_grant_removed',
      tx,
    })
    const nextGrants = input.enabled
      ? {
          ...existingGrants,
          filesystem: {
            schemaVersion: 2,
            mcpId: FILESYSTEM_MCP_ID,
            status: 'approved',
            grantMode: 'always_allow',
            capabilities,
            grantApprovalId: appended.decision.id,
            grantDecisionRevision: revisionText,
            rootBindingRevision: locked.project.rootBindingRevision.toString(),
            approvedAt: now.toISOString(),
            approvedBy: input.actorId,
            reason: input.reason,
          },
          filesystemRevocation: undefined,
        }
      : {
          ...Object.fromEntries(Object.entries(existingGrants).filter(([key]) => key !== 'filesystem')),
          filesystemRevocation: {
            schemaVersion: 2,
            grantApprovalId: appended.decision.id,
            grantDecisionRevision: revisionText,
            rootBindingRevision: locked.project.rootBindingRevision.toString(),
            revocationReason: 'project_grant_removed',
          },
        }
    const nextConfig: ProjectMcpConfig = { ...locked.project.mcpConfig, grants: nextGrants }
    const [updatedProject] = await tx.update(projects).set({
      grantDecisionRevision: revision,
      mcpConfig: nextConfig,
      updatedAt: now,
    }).where(and(
      eq(projects.id, locked.project.id),
      eq(projects.grantDecisionRevision, locked.project.grantDecisionRevision),
      sql`${projects.mcpConfig} IS NOT DISTINCT FROM ${JSON.stringify(locked.project.mcpConfig)}::jsonb`,
    )).returning()
    if (!updatedProject) throw httpError('Project filesystem policy changed concurrently. Retry from the current state.', 409)
    const reconciled = await reconcileLockedProjectRows({
      lockedProject: updatedProject,
      nextMcpConfig: nextConfig,
      now,
      packages: locked.packageById,
      projectAuthority: appended.authority,
      taskRows: locked.taskRows,
      trigger: input.enabled ? 'project_always_allow' : 'project_grant_revocation',
      tx,
    })
    return {
      authority: appended.authority,
      grant: projectFilesystemGrantFromAuthority(appended.authority),
      mcpConfig: updatedProject.mcpConfig,
      recoveredTaskIds: reconciled.recoveredTaskIds,
    }
  })
}
