import 'server-only'

import { createHash } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  filesystemMcpCurrentDecisionPointers,
  filesystemMcpGrantApprovals,
  filesystemMcpRuntimeAudits,
  projectFilesystemCurrentDecisionPointers,
  projectFilesystemGrantDecisions,
  tasks,
  workPackageLocalRunEvidence,
  workPackages,
} from '@/db/schema'
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
  cacheBypassId: string
  taskId: string
  packages: readonly S5PackagePresenter[]
  projectGrant: S5ProjectGrantPresenter | null
}>

export type S5RecoveryPresenter = Readonly<{
  computedAt: string
  freshnessFingerprint: string
  taskId: string
  blockedPackages: readonly S5PackagePresenter[]
  recoveryMarkers: readonly S5RecoveryMarkerPresenter[]
}>

export type S5TerminalPresenter = Readonly<{
  computedAt: string
  freshnessFingerprint: string
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

export function computeCasRecheckToken(input: {
  fingerprint: string
  taskId: string
  userId: string
}): string {
  return computeFreshnessFingerprint({
    protocol: 'forge:s5:task-state:v2',
    fingerprint: input.fingerprint,
    taskId: input.taskId,
    userId: input.userId,
  })
}

export function assertCasRecheckValid(input: {
  fingerprint: string
  taskId: string
  token: string
  userId: string
}): boolean {
  return SHA256.test(input.token) && computeCasRecheckToken(input) === input.token
}

function parseDelivery(value: unknown): TerminalPacketDeliveryOutcome | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null
  return ['not_exposed', 'submission_failed', 'submission_uncertain', 'submitted'].includes(value.state as string)
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
      ? { workPackageId: pkg.id, kind: 'local_effect_integrity_hold', state: 'current', action: null, evidenceId: marker.localRunEvidenceId, evidenceFingerprint: marker.evidenceFingerprint }
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
      ? { workPackageId: pkg.id, kind: 'local_effect_recovery', state: 'current', action: marker.disposition, evidenceId: marker.localRunEvidenceId, evidenceFingerprint: marker.evidenceFingerprint }
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
      ? { workPackageId: pkg.id, kind: 'packet_integrity_hold', state: 'current', action: null, evidenceId: marker.priorRuntimeAuditId, evidenceFingerprint: marker.markerFingerprint }
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
      ? { workPackageId: pkg.id, kind: 'packet_issuance', state: 'current', action: marker.disposition, evidenceId: marker.priorRuntimeAuditId, evidenceFingerprint: marker.markerFingerprint }
      : invalid())
  }
  const grant = parseFilesystemGrantBlockMetadata(metadata)
  if (grant) {
    result.push({ workPackageId: pkg.id, kind: 'filesystem_grant', state: 'current', action: null, evidenceId: null, evidenceFingerprint: grant.blockFingerprint })
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
): Promise<S5AuthoritativeTaskState> {
  const [task] = await db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      status: tasks.status,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.submittedBy, userId)))
    .limit(1)
  if (!task) throw new S5TaskNotFoundError()

  const [packageRows, decisions, pointers, projectPointers, projectDecisions, evidenceRows, auditRows] = await Promise.all([
    db.select({
      id: workPackages.id,
      title: workPackages.title,
      assignedRole: workPackages.assignedRole,
      status: workPackages.status,
      sequence: workPackages.sequence,
      mcpRequirements: workPackages.mcpRequirements,
      metadata: workPackages.metadata,
      updatedAt: workPackages.updatedAt,
    }).from(workPackages).where(eq(workPackages.taskId, taskId)).orderBy(asc(workPackages.sequence), asc(workPackages.id)),
    db.select({
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
    db.select({
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
    db.select().from(projectFilesystemCurrentDecisionPointers).where(eq(projectFilesystemCurrentDecisionPointers.projectId, task.projectId)).limit(1),
    db.select().from(projectFilesystemGrantDecisions).where(eq(projectFilesystemGrantDecisions.projectId, task.projectId)).orderBy(asc(projectFilesystemGrantDecisions.decisionGeneration)),
    db.select({
      id: workPackageLocalRunEvidence.id,
      workPackageId: workPackageLocalRunEvidence.workPackageId,
      agentRunId: workPackageLocalRunEvidence.agentRunId,
      state: workPackageLocalRunEvidence.state,
      leaseExpiresAt: workPackageLocalRunEvidence.leaseExpiresAt,
      terminalAt: workPackageLocalRunEvidence.terminalAt,
    }).from(workPackageLocalRunEvidence).where(eq(workPackageLocalRunEvidence.taskId, taskId)).orderBy(asc(workPackageLocalRunEvidence.createdAt), asc(workPackageLocalRunEvidence.id)),
    db.select({
      id: filesystemMcpRuntimeAudits.id,
      workPackageId: filesystemMcpRuntimeAudits.workPackageId,
      agentRunId: filesystemMcpRuntimeAudits.agentRunId,
      localRunEvidenceId: filesystemMcpRuntimeAudits.localRunEvidenceId,
      assembly: filesystemMcpRuntimeAudits.assembly,
      delivery: filesystemMcpRuntimeAudits.delivery,
      terminal: filesystemMcpRuntimeAudits.terminal,
      terminalAt: filesystemMcpRuntimeAudits.terminalAt,
      updatedAt: filesystemMcpRuntimeAudits.createdAt,
    }).from(filesystemMcpRuntimeAudits).where(eq(filesystemMcpRuntimeAudits.taskId, taskId)).orderBy(asc(filesystemMcpRuntimeAudits.createdAt), asc(filesystemMcpRuntimeAudits.id)),
  ])

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

  const packages = packageRows.map((pkg): S5PackagePresenter => {
    const summary = summarizeFilesystemCapabilities({ mcpRequirements: pkg.mcpRequirements, metadata: pkg.metadata })
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
    }
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
  const projectGrant = exactProjectDecision ? {
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

  const terminalPackages = auditRows.map((audit) => normalizeS5TerminalAudit(audit, evidenceRows))

  const evidenceRecords = evidenceRows.map((evidence): S5LocalEvidencePresenter => ({
    id: evidence.id,
    workPackageId: evidence.workPackageId,
    agentRunId: evidence.agentRunId,
    state: evidence.state,
    leaseExpiresAt: evidence.leaseExpiresAt.toISOString(),
    terminalAt: evidence.terminalAt?.toISOString() ?? null,
  }))

  const mutableState = {
    task: { id: task.id, projectId: task.projectId, status: task.status, updatedAt: task.updatedAt },
    packages: packageRows.map((pkg) => ({ id: pkg.id, status: pkg.status, metadata: pkg.metadata, updatedAt: pkg.updatedAt })),
    decisions,
    pointers,
    projectPointers,
    projectDecisions,
    evidenceRows,
    auditRows,
  }
  const observedFingerprint = computeFreshnessFingerprint(mutableState)
  const freshnessFingerprint = computeCasRecheckToken({ fingerprint: observedFingerprint, taskId, userId })

  return {
    computedAt: new Date().toISOString(),
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
}

export function admissionProjection(state: S5AuthoritativeTaskState): S5AdmissionPresenter {
  return {
    computedAt: state.computedAt,
    freshnessFingerprint: state.freshnessFingerprint,
    cacheBypassId: state.freshnessFingerprint,
    taskId: state.taskId,
    packages: state.packages,
    projectGrant: state.projectGrant,
  }
}

export function recoveryProjection(state: S5AuthoritativeTaskState): S5RecoveryPresenter {
  return {
    computedAt: state.computedAt,
    freshnessFingerprint: state.freshnessFingerprint,
    taskId: state.taskId,
    blockedPackages: state.packages.filter((pkg) => pkg.status === 'blocked'),
    recoveryMarkers: state.recoveryMarkers,
  }
}

export function terminalProjection(state: S5AuthoritativeTaskState): S5TerminalPresenter {
  return {
    computedAt: state.computedAt,
    freshnessFingerprint: state.freshnessFingerprint,
    taskId: state.taskId,
    terminalPackages: state.terminalPackages,
  }
}
