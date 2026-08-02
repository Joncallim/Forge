import 'server-only'

import { createHash } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { withExportedRepeatableReadSnapshot } from '@/db'
import {
  filesystemMcpCurrentDecisionPointers,
  filesystemMcpGrantApprovals,
  projectFilesystemCurrentDecisionPointers,
  projectFilesystemGrantDecisions,
  projects,
  tasks,
  workPackages,
} from '@/db/schema'
import { admitMcpRequirement, readEffectiveGrantState, type EffectiveGrantState } from '@/lib/mcps/admission'
import { parseProjectFilesystemDecisionAuthority } from '@/lib/mcps/filesystem-project-authority'
import { readS5ProtectedTerminalSnapshot } from '@/lib/mcps/s5-protected-reader'
import { summarizeFilesystemCapabilities } from '@/lib/mcps/filesystem-grants'
import { parseFilesystemGrantBlockMetadata } from '@/lib/mcps/filesystem-grant-lifecycle'
import {
  parseLocalEffectIntegrityHold,
  parseLocalEffectRecoveryMarker,
} from '@/lib/mcps/local-run-evidence-v2'
import {
  packetTerminalTupleIsValid,
  packetRecoveryMarkerFingerprint,
  parsePacketIntegrityHold,
  parsePacketIssuanceRecoveryMarker,
  parseTerminalPacketAssembly,
  type PacketTerminalOutcome,
  type TerminalPacketDeliveryOutcome,
} from '@/lib/mcps/packet-issuance-v2'
import {
  localEffectRecoveryActionsForDisposition,
  packetIssuanceRecoveryActionsForDisposition,
} from '@/lib/mcps/recovery-action-contract'
import type {
  CanonicalMcpOperatorAction,
  CanonicalMcpTaskPresentation,
} from '@/lib/mcps/admission-copy'

const SHA256 = /^sha256:[0-9a-f]{64}$/

export class S5TaskNotFoundError extends Error {
  constructor() {
    super('Task not found')
    this.name = 'S5TaskNotFoundError'
  }
}

export type S5DecisionPresenter = Readonly<{
  id: string
  decision: string
  capabilities: readonly string[]
  grantDecisionRevision: string | null
  rootBindingRevision: string | null
  decidedAt: string
}>

export type S5ProjectGrantPresenter = Readonly<{
  id: string
  enabled: boolean
  capabilities: readonly string[]
  grantDecisionRevision: string
  rootBindingRevision: string
  decisionFingerprint: string
  decisionGeneration: string
  decidedAt: string
  decidedBy: string
}>

export type S5PackagePresenter = Readonly<{
  workPackageId: string
  title: string
  assignedRole: string
  status: string
  requestedCapabilities: readonly string[]
  boundedRuntimeRequestedCapabilities: readonly string[]
  blockingCapabilities: readonly string[]
  currentDecision: S5DecisionPresenter | null
  decisionHistory: readonly S5DecisionPresenter[]
  blockMetadata: Record<string, unknown> | null
  pointerFingerprint: string
  pointerVersion: string
  effectiveAdmission?: Readonly<{
    phase: 'none' | 'proposed' | 'approved' | 'denied' | 'revoked' | 'not_issued'
    source: 'none' | 'package-local' | 'project-level'
    status: 'not_issued' | 'approved' | 'denied'
    grantMode: 'allow_once' | 'always_allow' | null
    consumed: boolean
    coveredCapabilities: readonly string[]
    revocationReason: string | null
  }>
}>

export type S5RecoveryMarkerPresenter = Readonly<{
  workPackageId: string
  kind:
    | 'filesystem_grant'
    | 'local_effect_recovery'
    | 'local_effect_integrity_hold'
    | 'packet_issuance'
    | 'packet_integrity_hold'
    | 'invalid'
  state: 'current' | 'invalid'
  action: string | null
  allowedActions: readonly string[]
  evidenceId: string | null
  evidenceFingerprint: string | null
}>

export type S5TerminalPackagePresenter = Readonly<{
  runtimeAuditId: string
  workPackageId: string
  state: 'terminal' | 'unavailable'
  assemblyState: 'assembled' | 'not_assembled' | 'assembly_unconfirmed' | null
  deliveryOutcome: 'not_exposed' | 'submission_failed' | 'submission_uncertain' | 'submitted' | null
  terminalOutcome: 'succeeded' | 'failed' | null
  terminalAt: string | null
}>

export type S5LocalEvidencePresenter = Readonly<{
  id: string
  workPackageId: string
  agentRunId: string
  state: string
  leaseExpiresAt: string
  terminalAt: string | null
}>

export type S5AuthoritativeTaskState = Readonly<{
  computedAt: string
  observedAtMs: number
  localEvidenceAvailable: boolean
  taskId: string
  projectId: string
  taskStatus: string
  freshnessFingerprint: string
  packages: readonly S5PackagePresenter[]
  projectGrant: S5ProjectGrantPresenter | null
  recoveryMarkers: readonly S5RecoveryMarkerPresenter[]
  terminalPackages: readonly S5TerminalPackagePresenter[]
  evidenceRecords: readonly S5LocalEvidencePresenter[]
}>

export type S5AdmissionPresenter = Readonly<{
  computedAt: string
  freshnessFingerprint: string
  localEvidenceAvailable: boolean
  cacheBypassId: string
  taskId: string
  packages: readonly S5PackagePresenter[]
  projectGrant: S5ProjectGrantPresenter | null
}>

export type S5RecoveryPresenter = Readonly<{
  computedAt: string
  freshnessFingerprint: string
  localEvidenceAvailable: boolean
  taskId: string
  blockedPackages: readonly S5PackagePresenter[]
  recoveryMarkers: readonly S5RecoveryMarkerPresenter[]
}>

export type S5TerminalPresenter = Readonly<{
  computedAt: string
  freshnessFingerprint: string
  localEvidenceAvailable: boolean
  taskId: string
  terminalPackages: readonly S5TerminalPackagePresenter[]
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function computeFreshnessFingerprint(input: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(stableJson(input)).digest('hex')}`
}

// The freshness fingerprint is a pure digest of the exact mutable rows S5
// presented. It carries no secret, no nonce, and no caller identity, so it is
// not an authorization token and cannot be replayed into one: an operator
// action echoes it back, and the server proves currency by re-reading the same
// rows under lock and recomputing this digest. Compare with `assertS5StateUnchanged`.
export function isS5FreshnessFingerprint(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

/**
 * Server-only compare-and-set check. Re-reads the authoritative task state and
 * reports whether it still matches the fingerprint the operator acted on. The
 * caller must run this inside the same locked transaction as the mutation.
 */
export async function assertS5StateUnchanged(input: {
  expectedFingerprint: string
  taskId: string
  userId: string
}): Promise<boolean> {
  if (!isS5FreshnessFingerprint(input.expectedFingerprint)) return false
  const current = await readS5AuthoritativeTaskState(input.taskId, input.userId)
  return current.freshnessFingerprint === input.expectedFingerprint
}

// `submitted` is the one delivery outcome that carries a persisted timestamp;
// every other outcome is exactly `{ state }`. Rejecting the second key made
// every successfully submitted packet normalize to `unavailable` and made
// recovery markers with `deliveryState: 'submitted'` fail validation.
function parseDelivery(value: unknown): TerminalPacketDeliveryOutcome | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (value.state === 'submitted') {
    return keys.length === 2 && Object.hasOwn(value, 'submittedAt')
      && typeof value.submittedAt === 'string'
      && !Number.isNaN(Date.parse(value.submittedAt))
      ? value as TerminalPacketDeliveryOutcome
      : null
  }
  if (keys.length !== 1) return null
  return ['not_exposed', 'submission_failed', 'submission_uncertain'].includes(value.state as string)
    ? value as TerminalPacketDeliveryOutcome
    : null
}

function parseTerminal(value: unknown): PacketTerminalOutcome | null {
  if (!isRecord(value)) return null
  if (value.status === 'succeeded' && Object.keys(value).length === 1) return value as PacketTerminalOutcome
  if (value.status !== 'failed' || typeof value.failureCode !== 'string') return null
  const ordinary = [
    'authorization_changed', 'execution_lease_expired', 'local_evidence_lease_expired',
    'issuance_lease_expired', 'worker_stopped', 'preflight_failed', 'assembly_failed',
    'submission_rejected', 'submission_uncertain', 'provider_response_invalid',
    'external_repository_change_requires_review',
  ]
  if (ordinary.includes(value.failureCode) && Object.keys(value).length === 2) return value as PacketTerminalOutcome
  if (
    value.failureCode === 'post_submission_execution_failed'
    && Object.keys(value).length === 3
    && ['sandbox_apply', 'validation', 'host_apply', 'repository_evidence', 'completion_preparation']
      .includes(value.failureStage as string)
  ) return value as PacketTerminalOutcome
  return null
}

export function normalizeS5RecoveryMarkers(pkg: {
  id: string
  metadata: Record<string, unknown>
}, evidenceRows: readonly {
  id: string
  workPackageId: string
  agentRunId: string
  state: string
}[], auditRows: readonly {
  id: string
  workPackageId: string | null
  agentRunId: string | null
  localRunEvidenceId: string | null
  delivery: Record<string, unknown> | null
  terminal: Record<string, unknown> | null
  terminalAt: Date | null
}[]): S5RecoveryMarkerPresenter[] {
  const metadata = pkg.metadata
  const result: S5RecoveryMarkerPresenter[] = []
  const invalid = (): S5RecoveryMarkerPresenter => ({
    workPackageId: pkg.id,
    kind: 'invalid',
    state: 'invalid',
    action: null,
    allowedActions: [],
    evidenceId: null,
    evidenceFingerprint: null,
  })
  if (Object.hasOwn(metadata, 'local_effect_integrity_hold')) {
    const marker = parseLocalEffectIntegrityHold(metadata.local_effect_integrity_hold)
    const evidenceMatches = marker?.localRunEvidenceId === null || evidenceRows.some((evidence) => (
      evidence.id === marker?.localRunEvidenceId
      && evidence.workPackageId === pkg.id
      && evidence.agentRunId === marker.priorAgentRunId
    ))
    result.push(marker && evidenceMatches
      ? { workPackageId: pkg.id, kind: 'local_effect_integrity_hold', state: 'current', action: null, allowedActions: [], evidenceId: marker.localRunEvidenceId, evidenceFingerprint: marker.evidenceFingerprint }
      : invalid())
  }
  if (Object.hasOwn(metadata, 'local_effect_recovery')) {
    const marker = parseLocalEffectRecoveryMarker(metadata.local_effect_recovery)
    const evidenceMatches = evidenceRows.some((evidence) => (
      evidence.id === marker?.localRunEvidenceId
      && evidence.workPackageId === pkg.id
      && evidence.agentRunId === marker?.priorAgentRunId
      && evidence.state !== 'claimed'
    ))
    result.push(marker && evidenceMatches
      ? { workPackageId: pkg.id, kind: 'local_effect_recovery', state: 'current', action: marker.disposition, allowedActions: localEffectRecoveryActionsForDisposition(marker.disposition), evidenceId: marker.localRunEvidenceId, evidenceFingerprint: marker.evidenceFingerprint }
      : invalid())
  }
  if (Object.hasOwn(metadata, 'packet_integrity_hold')) {
    const marker = parsePacketIntegrityHold(metadata.packet_integrity_hold)
    const auditMatches = auditRows.some((audit) => (
      audit.id === marker?.priorRuntimeAuditId
      && audit.workPackageId === pkg.id
      && audit.agentRunId === marker?.priorAgentRunId
    ))
    result.push(marker && auditMatches
      ? { workPackageId: pkg.id, kind: 'packet_integrity_hold', state: 'current', action: null, allowedActions: [], evidenceId: marker.priorRuntimeAuditId, evidenceFingerprint: marker.markerFingerprint }
      : invalid())
  }
  if (Object.hasOwn(metadata, 'packet_issuance')) {
    const marker = parsePacketIssuanceRecoveryMarker(metadata.packet_issuance)
    const audit = auditRows.find((candidate) => candidate.id === marker?.priorRuntimeAuditId)
    const evidence = evidenceRows.find((candidate) => candidate.id === audit?.localRunEvidenceId)
    const markerFingerprintMatches = marker
      ? packetRecoveryMarkerFingerprint(Object.fromEntries(
          Object.entries(marker).filter(([key]) => key !== 'markerFingerprint'),
        ) as Omit<typeof marker, 'markerFingerprint'>) === marker.markerFingerprint
      : false
    const auditMatches = marker && audit
      && audit.workPackageId === pkg.id
      && audit.agentRunId === marker.priorAgentRunId
      && audit.terminalAt !== null
      && parseDelivery(audit.delivery)?.state === marker.deliveryState
      && stableJson(audit.terminal) === stableJson(marker.recoveryFailure)
      && evidence?.workPackageId === pkg.id
      && evidence.agentRunId === marker.priorAgentRunId
      && evidence.state !== 'claimed'
    result.push(marker && markerFingerprintMatches && auditMatches
      ? { workPackageId: pkg.id, kind: 'packet_issuance', state: 'current', action: marker.disposition, allowedActions: packetIssuanceRecoveryActionsForDisposition(marker.disposition), evidenceId: marker.priorRuntimeAuditId, evidenceFingerprint: marker.markerFingerprint }
      : invalid())
  }
  const grant = parseFilesystemGrantBlockMetadata(metadata)
  if (grant) {
    result.push({ workPackageId: pkg.id, kind: 'filesystem_grant', state: 'current', action: null, allowedActions: [], evidenceId: null, evidenceFingerprint: grant.blockFingerprint })
  }
  return result
}

export function normalizeS5TerminalAudit(audit: {
  id: string
  workPackageId: string | null
  agentRunId: string | null
  localRunEvidenceId: string | null
  assembly: Record<string, unknown> | null
  delivery: Record<string, unknown> | null
  terminal: Record<string, unknown> | null
  terminalAt: Date | null
}, evidenceRows: readonly {
  id: string
  workPackageId: string
  agentRunId: string
  state: string
}[]): S5TerminalPackagePresenter {
  const assembly = parseTerminalPacketAssembly(audit.assembly)
  const delivery = parseDelivery(audit.delivery)
  const terminal = parseTerminal(audit.terminal)
  const evidence = evidenceRows.find((candidate) => candidate.id === audit.localRunEvidenceId)
  const valid = assembly && delivery && terminal && audit.terminalAt !== null
    && evidence?.workPackageId === audit.workPackageId
    && evidence.agentRunId === audit.agentRunId
    && evidence.state === 'terminal'
    && packetTerminalTupleIsValid({ assembly, delivery, terminal })
  return valid
    ? {
        runtimeAuditId: audit.id,
        workPackageId: audit.workPackageId ?? '',
        state: 'terminal',
        assemblyState: assembly.state,
        deliveryOutcome: delivery.state,
        terminalOutcome: terminal.status,
        terminalAt: audit.terminalAt?.toISOString() ?? null,
      }
    : {
        runtimeAuditId: audit.id,
        workPackageId: audit.workPackageId ?? '',
        state: 'unavailable',
        assemblyState: null,
        deliveryOutcome: null,
        terminalOutcome: null,
        terminalAt: null,
      }
}

export async function readS5AuthoritativeTaskState(
  taskId: string,
  userId: string,
  /** Fixture-only synchronization point; routes never supply this callback. */
  afterExporterSnapshotEstablished?: () => Promise<void>,
): Promise<S5AuthoritativeTaskState> {
  return withExportedRepeatableReadSnapshot({ run: async (tx, snapshotId, databaseUrl) => {
  // The real PostgreSQL fixture uses this bounded server-only seam to commit a
  // competing transition after export and before the protected import.
  if (afterExporterSnapshotEstablished) await afterExporterSnapshotEstablished()
  const [task] = await tx
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      status: tasks.status,
      updatedAt: tasks.updatedAt,
      projectMcpConfig: projects.mcpConfig,
      projectRootBindingRevision: projects.rootBindingRevision,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, taskId), eq(tasks.submittedBy, userId)))
    .limit(1)
  if (!task) throw new S5TaskNotFoundError()

  const [packageRows, decisions, pointers, projectPointers, projectDecisions, protectedSnapshot] = await Promise.all([
    tx.select({
      id: workPackages.id,
      title: workPackages.title,
      assignedRole: workPackages.assignedRole,
      status: workPackages.status,
      sequence: workPackages.sequence,
      mcpRequirements: workPackages.mcpRequirements,
      metadata: workPackages.metadata,
      updatedAt: workPackages.updatedAt,
    }).from(workPackages).where(eq(workPackages.taskId, taskId)).orderBy(asc(workPackages.sequence), asc(workPackages.id)),
    tx.select({
      id: filesystemMcpGrantApprovals.id,
      taskId: filesystemMcpGrantApprovals.taskId,
      workPackageId: filesystemMcpGrantApprovals.workPackageId,
      decision: filesystemMcpGrantApprovals.decision,
      capabilities: filesystemMcpGrantApprovals.capabilities,
      reason: filesystemMcpGrantApprovals.reason,
      grantDecisionRevision: filesystemMcpGrantApprovals.grantDecisionRevision,
      rootBindingRevision: filesystemMcpGrantApprovals.rootBindingRevision,
      pointerFingerprint: filesystemMcpGrantApprovals.pointerFingerprint,
      createdAt: filesystemMcpGrantApprovals.createdAt,
      updatedAt: filesystemMcpGrantApprovals.updatedAt,
    }).from(filesystemMcpGrantApprovals).where(eq(filesystemMcpGrantApprovals.taskId, taskId)).orderBy(asc(filesystemMcpGrantApprovals.createdAt), asc(filesystemMcpGrantApprovals.id)),
    tx.select({
      taskId: filesystemMcpCurrentDecisionPointers.taskId,
      workPackageId: filesystemMcpCurrentDecisionPointers.workPackageId,
      currentDecisionId: filesystemMcpCurrentDecisionPointers.currentDecisionId,
      currentDecisionTaskId: filesystemMcpCurrentDecisionPointers.currentDecisionTaskId,
      currentDecisionWorkPackageId: filesystemMcpCurrentDecisionPointers.currentDecisionWorkPackageId,
      currentDecisionRevision: filesystemMcpCurrentDecisionPointers.currentDecisionRevision,
      currentDecisionFingerprint: filesystemMcpCurrentDecisionPointers.currentDecisionFingerprint,
      pointerFingerprint: filesystemMcpCurrentDecisionPointers.pointerFingerprint,
      pointerVersion: filesystemMcpCurrentDecisionPointers.pointerVersion,
      updatedAt: filesystemMcpCurrentDecisionPointers.updatedAt,
    }).from(filesystemMcpCurrentDecisionPointers).where(eq(filesystemMcpCurrentDecisionPointers.taskId, taskId)),
    tx.select().from(projectFilesystemCurrentDecisionPointers).where(eq(projectFilesystemCurrentDecisionPointers.projectId, task.projectId)).limit(1),
    tx.select().from(projectFilesystemGrantDecisions).where(eq(projectFilesystemGrantDecisions.projectId, task.projectId)).orderBy(asc(projectFilesystemGrantDecisions.decisionGeneration)),
    readS5ProtectedTerminalSnapshot(taskId, { snapshotId, databaseUrl }),
  ])

  // A `null` protected read is "cannot be proven right now", not "no evidence".
  // Presenting it as an empty set is exactly right: every evidence-dependent
  // join then fails its exact-match check and degrades to the non-actionable
  // `unavailable`/`invalid` state instead of asserting an unproven fact.
  const localEvidenceAvailable = protectedSnapshot !== null
  const evidenceRows = protectedSnapshot?.evidenceRows ?? []
  const auditRows = protectedSnapshot?.auditRows ?? []

  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]))
  const pointerByPackage = new Map(pointers.map((pointer) => [pointer.workPackageId, pointer]))
  const safeDecision = (decision: typeof decisions[number]): S5DecisionPresenter => ({
    id: decision.id,
    decision: decision.decision,
    capabilities: decision.capabilities,
    grantDecisionRevision: decision.grantDecisionRevision?.toString() ?? null,
    rootBindingRevision: decision.rootBindingRevision?.toString() ?? null,
    decidedAt: decision.createdAt.toISOString(),
  })

  const projectPointer = projectPointers[0]
  const projectDecision = projectPointer?.currentDecisionId
    ? projectDecisions.find((decision) => decision.id === projectPointer.currentDecisionId)
    : undefined
  const exactProjectDecision = projectDecision
    && projectPointer.currentDecisionProjectId === task.projectId
    && projectDecision.projectId === task.projectId
    && projectDecision.grantDecisionRevision === projectPointer.currentDecisionRevision
    && projectDecision.rootBindingRevision === projectPointer.currentRootBindingRevision
    && projectDecision.decisionFingerprint === projectPointer.currentDecisionFingerprint
    && projectDecision.decisionGeneration === projectPointer.currentDecisionGeneration
      ? projectDecision
      : null

  const packages = packageRows.map((pkg): S5PackagePresenter => {
    const summary = summarizeFilesystemCapabilities({
      mcpRequirements: pkg.mcpRequirements,
      metadata: pkg.metadata,
      projectMcpConfig: task.projectMcpConfig,
      projectFilesystemDecision: exactProjectDecision ? {
        schemaVersion: 2,
        decisionId: exactProjectDecision.id,
        projectId: exactProjectDecision.projectId,
        decision: exactProjectDecision.decision,
        capabilities: exactProjectDecision.capabilities,
        grantDecisionRevision: exactProjectDecision.grantDecisionRevision.toString(),
        rootBindingRevision: exactProjectDecision.rootBindingRevision.toString(),
        decisionFingerprint: exactProjectDecision.decisionFingerprint,
        decisionGeneration: exactProjectDecision.decisionGeneration.toString(),
        decidedAt: exactProjectDecision.decidedAt.toISOString(),
        decidedBy: exactProjectDecision.decidedBy,
        reason: exactProjectDecision.reason,
        revocationReason: exactProjectDecision.revocationReason,
      } : undefined,
      projectRootBindingRevision: task.projectRootBindingRevision,
    })
    const pointer = pointerByPackage.get(pkg.id)
    const current = pointer?.currentDecisionId ? decisionById.get(pointer.currentDecisionId) : undefined
    const exactCurrent = current
      && pointer?.taskId === taskId
      && pointer.currentDecisionTaskId === taskId
      && pointer.currentDecisionWorkPackageId === pkg.id
      && current.taskId === taskId
      && current.workPackageId === pkg.id
      && current.grantDecisionRevision === pointer.currentDecisionRevision
      && current.pointerFingerprint === pointer.currentDecisionFingerprint
        ? current
        : null
    const authority = exactProjectDecision ? parseProjectFilesystemDecisionAuthority({
      schemaVersion: 2, decisionId: exactProjectDecision.id, projectId: exactProjectDecision.projectId,
      decision: exactProjectDecision.decision, capabilities: exactProjectDecision.capabilities,
      grantDecisionRevision: exactProjectDecision.grantDecisionRevision.toString(), rootBindingRevision: exactProjectDecision.rootBindingRevision.toString(),
      decisionFingerprint: exactProjectDecision.decisionFingerprint, decisionGeneration: exactProjectDecision.decisionGeneration.toString(),
      decidedAt: exactProjectDecision.decidedAt.toISOString(), decidedBy: exactProjectDecision.decidedBy,
      reason: exactProjectDecision.reason, revocationReason: exactProjectDecision.revocationReason,
    }) : null
    const effective = readEffectiveGrantState({ metadata: pkg.metadata }, {
      mcpConfig: task.projectMcpConfig,
      filesystemGrantDecision: authority,
      rootBindingRevision: task.projectRootBindingRevision,
    }, summary.boundedRuntimeRequestedCapabilities)
    return {
      workPackageId: pkg.id,
      title: pkg.title,
      assignedRole: pkg.assignedRole,
      status: pkg.status,
      requestedCapabilities: summary.requestedCapabilities,
      boundedRuntimeRequestedCapabilities: summary.boundedRuntimeRequestedCapabilities,
      blockingCapabilities: summary.blockingCapabilities,
      currentDecision: exactCurrent ? safeDecision(exactCurrent) : null,
      decisionHistory: decisions.filter((decision) => decision.workPackageId === pkg.id).map(safeDecision),
      blockMetadata: parseFilesystemGrantBlockMetadata(pkg.metadata),
      pointerFingerprint: pointer?.pointerFingerprint ?? '',
      pointerVersion: pointer?.pointerVersion.toString() ?? '0',
      effectiveAdmission: {
        phase: effective.phase,
        source: effective.source,
        status: effective.status,
        grantMode: effective.grantMode ?? null,
        consumed: effective.consumed === true,
        coveredCapabilities: effective.coveredCapabilities,
        revocationReason: effective.revocationReason ?? null,
      },
    }
  })

  const projectGrant = exactProjectDecision ? {
    id: exactProjectDecision.id,
    enabled: exactProjectDecision.decision === 'approved',
    capabilities: exactProjectDecision.capabilities,
    grantDecisionRevision: exactProjectDecision.grantDecisionRevision.toString(),
    rootBindingRevision: exactProjectDecision.rootBindingRevision.toString(),
    decisionFingerprint: exactProjectDecision.decisionFingerprint,
    decisionGeneration: exactProjectDecision.decisionGeneration.toString(),
    decidedAt: exactProjectDecision.decidedAt.toISOString(),
    decidedBy: exactProjectDecision.decidedBy,
  } satisfies S5ProjectGrantPresenter : null

  const recoveryMarkers = packageRows
    .filter((pkg) => pkg.status === 'blocked')
    .flatMap((pkg) => normalizeS5RecoveryMarkers(pkg, evidenceRows, auditRows))

  const terminalStatus = new Set(['completed', 'failed', 'cancelled', 'rejected'])
  const terminalPackages = packageRows.flatMap((pkg) => {
    if (!terminalStatus.has(pkg.status)) return []
    const audit = auditRows.filter((candidate) => candidate.workPackageId === pkg.id)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id)).at(-1)
    return audit ? [normalizeS5TerminalAudit(audit, evidenceRows)] : []
  })

  const evidenceRecords = evidenceRows.map((evidence): S5LocalEvidencePresenter => ({
    id: evidence.id,
    workPackageId: evidence.workPackageId,
    agentRunId: evidence.agentRunId,
    state: evidence.state,
    leaseExpiresAt: evidence.leaseExpiresAt.toISOString(),
    terminalAt: evidence.terminalAt?.toISOString() ?? null,
  }))

  const mutableState = {
    protocol: 'forge:s5:task-state:v2',
    taskId,
    task: { id: task.id, projectId: task.projectId, status: task.status, updatedAt: task.updatedAt },
    packages: packageRows.map((pkg) => ({ id: pkg.id, status: pkg.status, metadata: pkg.metadata, updatedAt: pkg.updatedAt })),
    decisions,
    pointers,
    projectPointers,
    projectDecisions,
    localEvidenceAvailable,
    evidenceRows,
    auditRows,
  }
  const freshnessFingerprint = computeFreshnessFingerprint(mutableState)
  const observedAt = new Date()

  return {
    computedAt: observedAt.toISOString(),
    observedAtMs: observedAt.getTime(),
    localEvidenceAvailable,
    taskId,
    projectId: task.projectId,
    taskStatus: task.status,
    freshnessFingerprint,
    packages,
    projectGrant,
    recoveryMarkers,
    terminalPackages,
    evidenceRecords,
  }
  }})
}

// Every projection re-materializes its rows through these explicit field
// lists. Constructing the presenters correctly upstream is not enough: passing
// an array by reference to `NextResponse.json` means any field that ever
// reaches the array reaches the wire. Enumerating here makes the redaction a
// property of the serialization boundary itself.
export function safeDecisionPresenter(decision: S5DecisionPresenter): S5DecisionPresenter {
  return {
    id: decision.id,
    decision: decision.decision,
    capabilities: [...decision.capabilities],
    grantDecisionRevision: decision.grantDecisionRevision,
    rootBindingRevision: decision.rootBindingRevision,
    decidedAt: decision.decidedAt,
  }
}

export function safePackagePresenter(pkg: S5PackagePresenter): S5PackagePresenter {
  return {
    workPackageId: pkg.workPackageId,
    title: pkg.title,
    assignedRole: pkg.assignedRole,
    status: pkg.status,
    requestedCapabilities: [...pkg.requestedCapabilities],
    boundedRuntimeRequestedCapabilities: [...pkg.boundedRuntimeRequestedCapabilities],
    blockingCapabilities: [...pkg.blockingCapabilities],
    currentDecision: pkg.currentDecision ? safeDecisionPresenter(pkg.currentDecision) : null,
    decisionHistory: pkg.decisionHistory.map(safeDecisionPresenter),
    blockMetadata: pkg.blockMetadata,
    pointerFingerprint: pkg.pointerFingerprint,
    pointerVersion: pkg.pointerVersion,
    ...(pkg.effectiveAdmission ? { effectiveAdmission: {
      ...pkg.effectiveAdmission,
      coveredCapabilities: [...pkg.effectiveAdmission.coveredCapabilities],
    } } : {}),
  }
}

export function safeRecoveryMarkerPresenter(marker: S5RecoveryMarkerPresenter): S5RecoveryMarkerPresenter {
  return {
    workPackageId: marker.workPackageId,
    kind: marker.kind,
    state: marker.state,
    action: marker.action,
    allowedActions: [...marker.allowedActions],
    evidenceId: marker.evidenceId,
    evidenceFingerprint: marker.evidenceFingerprint,
  }
}

export function safeTerminalPackagePresenter(terminal: S5TerminalPackagePresenter): S5TerminalPackagePresenter {
  return {
    runtimeAuditId: terminal.runtimeAuditId,
    workPackageId: terminal.workPackageId,
    state: terminal.state,
    assemblyState: terminal.assemblyState,
    deliveryOutcome: terminal.deliveryOutcome,
    terminalOutcome: terminal.terminalOutcome,
    terminalAt: terminal.terminalAt,
  }
}

export function safeLocalEvidencePresenter(evidence: S5LocalEvidencePresenter): S5LocalEvidencePresenter {
  return {
    id: evidence.id,
    workPackageId: evidence.workPackageId,
    agentRunId: evidence.agentRunId,
    state: evidence.state,
    leaseExpiresAt: evidence.leaseExpiresAt,
    terminalAt: evidence.terminalAt,
  }
}

export function safeProjectGrantPresenter(
  grant: S5ProjectGrantPresenter | null,
): S5ProjectGrantPresenter | null {
  return grant ? {
    id: grant.id,
    enabled: grant.enabled,
    capabilities: [...grant.capabilities],
    grantDecisionRevision: grant.grantDecisionRevision,
    rootBindingRevision: grant.rootBindingRevision,
    decisionFingerprint: grant.decisionFingerprint,
    decisionGeneration: grant.decisionGeneration,
    decidedAt: grant.decidedAt,
    decidedBy: grant.decidedBy,
  } : null
}

export function admissionProjection(state: S5AuthoritativeTaskState): S5AdmissionPresenter {
  return {
    computedAt: state.computedAt,
    freshnessFingerprint: state.freshnessFingerprint,
    localEvidenceAvailable: state.localEvidenceAvailable,
    cacheBypassId: state.freshnessFingerprint,
    taskId: state.taskId,
    packages: state.packages.map(safePackagePresenter),
    projectGrant: safeProjectGrantPresenter(state.projectGrant),
  }
}

export function recoveryProjection(state: S5AuthoritativeTaskState): S5RecoveryPresenter {
  return {
    computedAt: state.computedAt,
    freshnessFingerprint: state.freshnessFingerprint,
    localEvidenceAvailable: state.localEvidenceAvailable,
    taskId: state.taskId,
    blockedPackages: state.packages.filter((pkg) => pkg.status === 'blocked').map(safePackagePresenter),
    recoveryMarkers: state.recoveryMarkers.map(safeRecoveryMarkerPresenter),
  }
}

export function terminalProjection(state: S5AuthoritativeTaskState): S5TerminalPresenter {
  return {
    computedAt: state.computedAt,
    freshnessFingerprint: state.freshnessFingerprint,
    localEvidenceAvailable: state.localEvidenceAvailable,
    taskId: state.taskId,
    terminalPackages: state.terminalPackages.map(safeTerminalPackagePresenter),
  }
}

const CANONICAL_ACTION_LABELS: Record<CanonicalMcpOperatorAction['action'], string> = {
  review_local_changes: 'I reviewed the local changes',
  acknowledge_possible_local_invocation: 'I understand the prior local invocation may have happened',
  retry_local_execution: 'Start another local attempt',
  decline_local_retry: 'Do not retry — close this package',
  acknowledge_possible_submission: 'I understand the prior submission may have happened',
  retry_execution: 'Retry packet execution',
  decline_packet_recovery: 'Do not retry this package',
}

function canonicalRecoveryAction(marker: S5RecoveryMarkerPresenter, action: string): CanonicalMcpOperatorAction | null {
  if (!(action in CANONICAL_ACTION_LABELS) || marker.evidenceId === null || marker.evidenceFingerprint === null) return null
  const operatorAction = action as CanonicalMcpOperatorAction['action']
  if (marker.kind === 'local_effect_recovery' && [
    'review_local_changes', 'acknowledge_possible_local_invocation', 'retry_local_execution', 'decline_local_retry',
  ].includes(operatorAction)) {
    return {
      action: operatorAction,
      label: CANONICAL_ACTION_LABELS[operatorAction],
      identity: { schemaVersion: 1, localRunEvidenceId: marker.evidenceId, evidenceFingerprint: marker.evidenceFingerprint },
    }
  }
  if (marker.kind === 'packet_issuance' && [
    'acknowledge_possible_submission', 'retry_execution', 'decline_packet_recovery',
  ].includes(operatorAction)) {
    return {
      action: operatorAction,
      label: CANONICAL_ACTION_LABELS[operatorAction],
      identity: { schemaVersion: 2, priorRuntimeAuditId: marker.evidenceId, markerFingerprint: marker.evidenceFingerprint },
    }
  }
  return null
}

const S5_HEALTHY_FILESYSTEM_STATUS = {
  mcpId: 'filesystem', displayName: 'Filesystem', description: 'S5 admission projection',
  installPath: 'server-owned', installState: 'installed' as const, status: 'healthy' as const,
  enabled: true, error: null, checkedAt: '1970-01-01T00:00:00.000Z',
}

/** Reuse the admission contract so S5 cannot weaken its coverage semantics. */
export function s5EffectiveAdmissionDecision(pkg: S5PackagePresenter): 'approved' | 'denied' | 'unavailable' {
  if (!pkg.effectiveAdmission || pkg.boundedRuntimeRequestedCapabilities.length === 0) return 'unavailable'
  const effectiveGrant: EffectiveGrantState = {
    phase: pkg.effectiveAdmission.phase,
    source: pkg.effectiveAdmission.source,
    status: pkg.effectiveAdmission.status,
    coveredCapabilities: [...pkg.effectiveAdmission.coveredCapabilities],
    ...(pkg.effectiveAdmission.grantMode ? { grantMode: pkg.effectiveAdmission.grantMode } : {}),
    ...(pkg.effectiveAdmission.consumed ? { consumed: true } : {}),
    ...(pkg.effectiveAdmission.revocationReason ? { revocationReason: pkg.effectiveAdmission.revocationReason as EffectiveGrantState['revocationReason'] } : {}),
  }
  const decision = admitMcpRequirement({
    mcpId: 'filesystem', agent: pkg.assignedRole, requirement: 'required',
    requestedCapabilities: [...pkg.boundedRuntimeRequestedCapabilities],
    packageProhibitedKeys: new Set(), status: S5_HEALTHY_FILESYSTEM_STATUS,
    hasPromptOnlyContext: false, effectiveGrant, fallback: { action: 'block' },
  })
  if (decision.status === 'allowed' && decision.mode === 'bounded_context_approved') return 'approved'
  return pkg.effectiveAdmission.phase === 'denied' || pkg.effectiveAdmission.phase === 'revoked'
    ? 'denied'
    : 'unavailable'
}

/**
 * The task UI's single S5 DTO. Recovery availability and terminal status are
 * joined while the authoritative state is still in memory, preventing the
 * browser from combining unrelated admission, recovery, and terminal reads.
 */
export function canonicalTaskPresentationProjection(state: S5AuthoritativeTaskState): CanonicalMcpTaskPresentation {
  const packageById = new Map(state.packages.map((pkg) => [pkg.workPackageId, pkg]))
  const terminalByPackage = new Map(
    state.terminalPackages
      .filter((terminal) => packageById.has(terminal.workPackageId))
      .map((terminal) => [terminal.workPackageId, terminal]),
  )
  const terminalTask = ['completed', 'failed', 'cancelled', 'rejected'].includes(state.taskStatus)
  const recoveries = state.recoveryMarkers.flatMap((marker) => {
    const pkg = packageById.get(marker.workPackageId)
    if (!pkg) return []
    const terminal = terminalByPackage.get(marker.workPackageId)
    const terminalized = terminalTask || terminal?.state === 'terminal'
    const actions = !state.localEvidenceAvailable || terminalized || marker.state !== 'current'
      ? []
      : marker.allowedActions.map((action) => canonicalRecoveryAction(marker, action)).filter((action): action is CanonicalMcpOperatorAction => action !== null)
    const unavailable = marker.state !== 'current' || !state.localEvidenceAvailable
    return [{
      workPackageId: pkg.workPackageId,
      title: pkg.title,
      badgeText: terminalized ? 'Terminal' : unavailable ? 'Status unavailable' : actions.length > 0 ? 'Recovery available' : 'Recovery unavailable',
      headline: terminalized
        ? 'Package reached a terminal state'
        : unavailable
          ? 'Recovery state cannot be verified'
          : actions.length > 0
            ? 'Operator recovery is available'
            : 'Recovery is not available',
      body: terminalized
        ? 'This package has retained terminal evidence. Forge does not offer a recovery control from this observation.'
        : unavailable
          ? 'Forge cannot prove the required recovery evidence is current. No operator action is available.'
          : actions.length > 0
            ? 'Choose a server-authorized action. Forge will re-check this exact observation before changing the package.'
            : 'The current server observation does not authorize an operator recovery action.',
      tone: terminalized ? 'neutral' as const : unavailable ? 'danger' as const : actions.length > 0 ? 'warning' as const : 'neutral' as const,
      actions,
    }]
  })
  const terminals = state.terminalPackages.flatMap((terminal) => {
    const pkg = packageById.get(terminal.workPackageId)
    if (!pkg) return []
    return [{
      workPackageId: terminal.workPackageId,
      title: pkg.title,
      state: terminal.state,
      outcome: terminal.terminalOutcome,
      terminalAt: terminal.terminalAt,
    }]
  })
  return {
    schemaVersion: 1,
    computedAt: state.computedAt,
    freshnessFingerprint: state.freshnessFingerprint,
    taskId: state.taskId,
    localEvidenceAvailable: state.localEvidenceAvailable,
    admission: state.packages.map((pkg) => ({
      workPackageId: pkg.workPackageId,
      title: pkg.title,
      requiresMcp: pkg.boundedRuntimeRequestedCapabilities.length > 0,
      decision: s5EffectiveAdmissionDecision(pkg),
    })),
    recoveries,
    terminals,
  }
}
