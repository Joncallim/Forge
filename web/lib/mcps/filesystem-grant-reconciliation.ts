import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  filesystemMcpCurrentDecisionPointers,
  filesystemMcpGrantApprovals,
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
  isFilesystemGrantBlockedPackageMetadata,
  isRecord,
  projectFilesystemEffectivePhase,
  projectFilesystemGrantFromConfig,
  requiresFilesystemGrantApproval,
  summarizeFilesystemCapabilities,
  type FilesystemProjectCapability,
} from './filesystem-grants'
import { assertMcpAdmissionLockSequence } from './mcp-admission-lock-order'
import { readEffectiveGrantState } from './admission'

type GrantTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type LockedProject = typeof projects.$inferSelect
type LockedTask = typeof tasks.$inferSelect
type LockedPackage = typeof workPackages.$inferSelect

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
  approvals: Array<typeof filesystemMcpGrantApprovals.$inferSelect>
  recoveredTaskIds: string[]
  states: Array<{
    approvalId: string
    decision: string
    grantDecisionRevision: string
    workPackageId: string | null
  }>
}

const TASK_EDITABLE = new Set(['awaiting_approval', 'approved', 'running', 'failed'])
const PACKAGE_EDITABLE = new Set(['pending', 'ready', 'blocked', 'needs_rework', 'failed'])

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

function isLiveExecutionLease(pkg: LockedPackage): boolean {
  if (pkg.status !== 'running' || !isRecord(pkg.metadata)) return false
  const lease = isRecord(pkg.metadata.executionLease) ? pkg.metadata.executionLease : null
  return Boolean(
    lease &&
    typeof lease.runId === 'string' &&
    lease.runId.length > 0 &&
    typeof lease.heartbeatAt === 'string',
  )
}

function isRecognizedOperatorHold(pkg: LockedPackage): boolean {
  if (!isRecord(pkg.metadata)) return false
  if (parseFilesystemGrantBlockMetadata(pkg.metadata[FILESYSTEM_GRANT_BLOCK_METADATA_KEY])) return true
  for (const key of ['mcpPacketBlock', 'operatorHold']) {
    const marker = isRecord(pkg.metadata[key]) ? pkg.metadata[key] : null
    if (
      marker?.schemaVersion === 2 &&
      (marker.kind === 'packet_issuance' || marker.kind === 'integrity') &&
      marker.taskDisposition === 'operator_hold'
    ) return true
  }
  return false
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
  if (siblings.some((pkg) => pkg.status === 'awaiting_review' || isLiveExecutionLease(pkg))) return false
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
    isLiveExecutionLease(pkg)
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
      return convergeOperatorHeldTask(tx, task, siblings)
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
    return convergeOperatorHeldTask(tx, task, siblings)
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
      projectRootBindingRevision: input.lockedProject.rootBindingRevision,
    })
    const existingMarker = isRecord(pkg.metadata)
      ? pkg.metadata[FILESYSTEM_GRANT_BLOCK_METADATA_KEY]
      : undefined
    const parsedMarker = parseFilesystemGrantBlockMetadata(existingMarker)
    const exactV1Marker = isRecord(existingMarker) &&
      existingMarker.source === 'filesystem-grant-approval' &&
      existingMarker.status === 'failed' &&
      existingMarker.schemaVersion !== 2
    const forcePersist = input.forcePackageIds?.has(pkg.id) === true
    const currentPhases = isRecord(pkg.metadata) && isRecord(pkg.metadata.mcpGrantPhases)
      ? pkg.metadata.mcpGrantPhases
      : undefined

    if (!check.blocked) {
      if (!parsedMarker && !exactV1Marker && !forcePersist) continue
      const grant = projectFilesystemGrantFromConfig(input.lockedProject.mcpConfig)
      const effective = grant
        ? phasesWithEffective(pkg.metadata, projectFilesystemEffectivePhase(grant))
        : forcePersist ? currentPhases : undefined
      const recovering = Boolean(parsedMarker || exactV1Marker)
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
        .where(parsedMarker || exactV1Marker
          ? and(
              eq(workPackages.id, pkg.id),
              parsedMarker
                ? sql`${workPackages.metadata}->'mcpGrantBlock'->>'blockFingerprint' = ${parsedMarker.blockFingerprint}`
                : sql`${workPackages.metadata}->'mcpGrantBlock'->>'source' = 'filesystem-grant-approval'`,
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
      !exactV1Marker &&
      pkg.status !== 'pending' &&
      pkg.status !== 'ready'
    ) continue
    const requestedCapabilities = canonicalFilesystemProjectCapabilities(check.missingCapabilities)
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
            grantApprovalId: typeof previousGrant.grantApprovalId === 'string'
              ? previousGrant.grantApprovalId
              : null,
            grantDecisionRevision: input.grantDecisionRevision.toString(),
            rootBindingRevision: input.rootBindingRevision.toString(),
            revocationReason: 'project_root_repoint',
          },
        }
      : withoutFilesystem,
  }
}

function packageEffectivePhase(pkg: LockedPackage): Record<string, unknown> | null {
  const metadata = isRecord(pkg.metadata) ? pkg.metadata : {}
  const phases = isRecord(metadata.mcpGrantPhases) ? metadata.mcpGrantPhases : {}
  return isRecord(phases.effective) ? phases.effective : null
}

function projectReconciliationCandidateIds(input: {
  packages: readonly LockedPackage[]
  rootBindingRevision: bigint
  trigger: FilesystemGrantProjectReconciliationTrigger
}): string[] {
  if (input.trigger === 'task_always_allow' || input.trigger === 'project_always_allow') {
    return input.packages.map((pkg) => pkg.id)
  }
  if (input.trigger === 'project_grant_revocation') {
    return input.packages
      .filter((pkg) => packageEffectivePhase(pkg)?.source === 'project-filesystem-approval')
      .map((pkg) => pkg.id)
  }
  return input.packages
    .filter((pkg) => {
      const effective = packageEffectivePhase(pkg)
      if (effective?.schemaVersion !== 2) return false
      const decisionRevision = typeof effective.grantDecisionRevision === 'string'
        ? effective.grantDecisionRevision
        : ''
      const rootRevision = typeof effective.rootBindingRevision === 'string'
        ? effective.rootBindingRevision
        : ''
      return /^[1-9][0-9]*$/.test(decisionRevision) &&
        /^[1-9][0-9]*$/.test(rootRevision) &&
        BigInt(rootRevision) !== input.rootBindingRevision
    })
    .map((pkg) => pkg.id)
}

async function reconcileLockedProjectRows(input: {
  lockedProject: LockedProject
  nextMcpConfig: ProjectMcpConfig
  packages: Map<string, LockedPackage>
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
  if (input.trigger === 'project_root_repoint') {
    const grants = isRecord(input.nextMcpConfig.grants) ? input.nextMcpConfig.grants : {}
    const revocation = isRecord(grants.filesystemRevocation) ? grants.filesystemRevocation : null
    if (Object.hasOwn(grants, 'filesystem')) {
      throw new Error('Root repoint must remove active filesystem authority before reconciliation.')
    }
    if (
      input.grantDecisionRevision !== '0' &&
      (
        revocation?.revocationReason !== 'project_root_repoint' ||
        revocation.grantDecisionRevision !== input.grantDecisionRevision ||
        revocation.rootBindingRevision !== input.lockedProject.rootBindingRevision.toString()
      )
    ) {
      throw new Error('Root repoint must carry the current decision and new root-binding revisions.')
    }
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
  await tx.select({ id: filesystemMcpGrantApprovals.id })
    .from(filesystemMcpGrantApprovals)
    .where(eq(filesystemMcpGrantApprovals.projectId, input.lockedProject.id))
    .orderBy(filesystemMcpGrantApprovals.id)
    .for('update')
  const pointerRows = packageRows.length === 0
    ? []
    : await tx.select({ id: filesystemMcpCurrentDecisionPointers.id })
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
  return reconcileLockedProjectRows({
    lockedProject: input.lockedProject,
    nextMcpConfig: input.nextMcpConfig,
    now: new Date(),
    packages: new Map(packageRows.map((pkg) => [pkg.id, pkg])),
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

  if (input.targetPackageIds.length > 0 || input.projectWide) {
    const decisionScope = input.projectWide
      ? eq(filesystemMcpGrantApprovals.projectId, project.id)
      : or(
          inArray(filesystemMcpGrantApprovals.workPackageId, [...input.targetPackageIds]),
          eq(filesystemMcpGrantApprovals.decisionScope, 'project'),
        )
    await input.tx
      .select({ id: filesystemMcpGrantApprovals.id })
      .from(filesystemMcpGrantApprovals)
      .where(and(
        eq(filesystemMcpGrantApprovals.projectId, project.id),
        decisionScope,
      ))
      .orderBy(filesystemMcpGrantApprovals.id)
      .for('update')
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
  return {
    packageById,
    pointerByPackageId: new Map(pointerRows.map((pointer) => [pointer.workPackageId, pointer])),
    project,
    taskRows,
  }
}

function validatePackageMutation(pkg: LockedPackage, mutation: FilesystemGrantMutation) {
  if (!PACKAGE_EDITABLE.has(pkg.status)) {
    throw httpError(`Cannot edit filesystem grants for package '${pkg.title}' after execution starts.`, 409)
  }
  if (pkg.status === 'failed' && !isFilesystemGrantBlockedPackageMetadata(pkg.metadata)) {
    throw httpError(`Cannot edit filesystem grants for package '${pkg.title}' because its failure is not a filesystem grant hold.`, 409)
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
  const now = new Date()
  return db.transaction(async (tx) => {
    const locked = await lockMutationRows({
      projectId: input.projectId,
      targetPackageIds: [...new Set(input.mutations.map((mutation) => mutation.workPackageId))],
      taskId: input.taskId,
      projectWide,
      tx,
    })
    const targetTask = locked.taskRows.find((task) => task.id === input.taskId)
    if (!targetTask || !TASK_EDITABLE.has(targetTask.status)) {
      throw httpError(`Cannot edit filesystem grants while task status is '${targetTask?.status ?? 'missing'}'.`, 409)
    }
    if (locked.project.rootBindingRevision <= BigInt(0)) {
      throw httpError('The project root is not bound to protocol v2. Filesystem decisions remain disabled.', 409)
    }

    let revision = locked.project.grantDecisionRevision
    let nextConfig = locked.project.mcpConfig
    const approvals: Array<typeof filesystemMcpGrantApprovals.$inferSelect> = []
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
        const current = isRecord(grants.filesystem) ? grants.filesystem : {}
        const merged = canonicalFilesystemProjectCapabilities([
          ...canonicalFilesystemProjectCapabilities(current.capabilities),
          ...capabilities,
        ])
        const effectiveGrant = {
          schemaVersion: 2,
          phase: 'effective',
          source: 'project-filesystem-approval',
          grantApprovalId: approvalId,
          grantDecisionRevision: revisionText,
          rootBindingRevision: locked.project.rootBindingRevision.toString(),
          status: 'approved',
          capabilities: merged,
        }
        const [approval] = await tx.insert(filesystemMcpGrantApprovals).values({
          id: approvalId,
          projectId: locked.project.id,
          taskId: null,
          workPackageId: null,
          decisionScope: 'project',
          decidedBy: input.actorId,
          decision: 'approved',
          capabilities: merged,
          reason: mutation.reason,
          effectiveGrant,
          grantDecisionRevision: revision,
          rootBindingRevision: locked.project.rootBindingRevision,
          pointerFingerprint: null,
          updatedAt: now,
        }).returning()
        approvals.push(approval)
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
              grantApprovalId: approval.id,
              grantDecisionRevision: revisionText,
              rootBindingRevision: locked.project.rootBindingRevision.toString(),
              approvedAt: now.toISOString(),
              approvedBy: input.actorId,
              reason: mutation.reason,
            },
          },
        }
        states.push({ approvalId, decision: 'approved', grantDecisionRevision: revisionText, workPackageId: pkg.id })
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
          currentDecisionRevision: revision,
          pointerFingerprint: nextFingerprint,
          pointerVersion: pointer.pointerVersion + BigInt(1),
          updatedAt: now,
        })
        .where(and(
          eq(filesystemMcpCurrentDecisionPointers.id, pointer.id),
          pointer.currentDecisionId
            ? eq(filesystemMcpCurrentDecisionPointers.currentDecisionId, pointer.currentDecisionId)
            : isNull(filesystemMcpCurrentDecisionPointers.currentDecisionId),
          pointer.currentDecisionRevision === null
            ? isNull(filesystemMcpCurrentDecisionPointers.currentDecisionRevision)
            : eq(filesystemMcpCurrentDecisionPointers.currentDecisionRevision, pointer.currentDecisionRevision),
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
      approvals.push(approval)
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
  grant: ReturnType<typeof projectFilesystemGrantFromConfig>
  mcpConfig: ProjectMcpConfig
  recoveredTaskIds: string[]
}> {
  const now = new Date()
  return db.transaction(async (tx) => {
    const locked = await lockMutationRows({
      projectId: input.projectId,
      targetPackageIds: [],
      projectWide: true,
      tx,
    })
    if (locked.project.rootBindingRevision <= BigInt(0)) {
      throw httpError('The project root is not bound to protocol v2. Filesystem decisions remain disabled.', 409)
    }
    const revision = locked.project.grantDecisionRevision + BigInt(1)
    const revisionText = revision.toString()
    const approvalId = randomUUID()
    const capabilities = canonicalFilesystemProjectCapabilities(input.capabilities)
    const existingGrants = isRecord(locked.project.mcpConfig.grants)
      ? locked.project.mcpConfig.grants
      : {}
    const [approval] = await tx.insert(filesystemMcpGrantApprovals).values({
      id: approvalId,
      projectId: locked.project.id,
      taskId: null,
      workPackageId: null,
      decisionScope: 'project',
      decidedBy: input.actorId,
      decision: input.enabled ? 'approved' : 'denied',
      capabilities: input.enabled ? capabilities : [],
      reason: input.reason,
      effectiveGrant: {
        schemaVersion: 2,
        source: 'project-filesystem-approval',
        status: input.enabled ? 'approved' : 'revoked',
        grantDecisionRevision: revisionText,
        rootBindingRevision: locked.project.rootBindingRevision.toString(),
      },
      grantDecisionRevision: revision,
      rootBindingRevision: locked.project.rootBindingRevision,
      updatedAt: now,
    }).returning()
    const nextGrants = input.enabled
      ? {
          ...existingGrants,
          filesystem: {
            schemaVersion: 2,
            mcpId: FILESYSTEM_MCP_ID,
            status: 'approved',
            grantMode: 'always_allow',
            capabilities,
            grantApprovalId: approval.id,
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
            grantApprovalId: approval.id,
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
      taskRows: locked.taskRows,
      trigger: input.enabled ? 'project_always_allow' : 'project_grant_revocation',
      tx,
    })
    return {
      grant: projectFilesystemGrantFromConfig(updatedProject.mcpConfig),
      mcpConfig: updatedProject.mcpConfig,
      recoveredTaskIds: reconciled.recoveredTaskIds,
    }
  })
}
