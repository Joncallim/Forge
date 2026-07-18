import {
  admitWorkPackageMcp,
  readEffectiveGrantState,
  type McpWorkPackageAdmission,
} from './admission'
import {
  canonicalCapabilityForMcp,
  classifyCapability,
  coverageKeysForGrant,
  isMcpHealthy,
  mcpDeliveryKind,
  mcpHealthReason,
} from './capability-normalization'
import type { ProjectMcpStatus } from './types'
import {
  canonicalPositiveDecisionRevision,
  parseFilesystemGrantBlockMetadata,
  type FilesystemGrantBlockMetadata,
  type FilesystemGrantHoldState,
  type FilesystemGrantRevocationReason,
} from './filesystem-grant-lifecycle'
import {
  parseProjectFilesystemDecisionAuthority,
} from './filesystem-project-authority'

export const FILESYSTEM_MCP_ID = 'filesystem'

export const FILESYSTEM_PROJECT_CAPABILITIES = [
  'filesystem.project.read',
  'filesystem.project.list',
  'filesystem.project.search',
] as const

export type FilesystemProjectCapability = typeof FILESYSTEM_PROJECT_CAPABILITIES[number]
export type FilesystemProjectRequestCapability =
  | FilesystemProjectCapability
  | 'filesystem.project.write'

const FILESYSTEM_PROJECT_CAPABILITY_SET = new Set<string>(FILESYSTEM_PROJECT_CAPABILITIES)

export type FilesystemCapabilitySummary = {
  blockingCapabilities: FilesystemProjectCapability[]
  /** Capabilities kept in the plan/operator projection, including write. */
  planningVisibleCapabilities: FilesystemProjectRequestCapability[]
  /** Capabilities that may activate a bounded read-only runtime packet. */
  boundedRuntimeRequestedCapabilities: FilesystemProjectCapability[]
  /** Compatibility alias for the planning-visible capability projection. */
  requestedCapabilities: FilesystemProjectRequestCapability[]
}

export type ProjectFilesystemGrant = {
  schemaVersion: 2
  mcpId: typeof FILESYSTEM_MCP_ID
  status: 'approved'
  grantMode: 'always_allow'
  capabilities: FilesystemProjectCapability[]
  grantApprovalId: string
  approvedAt: string
  approvedBy: string
  reason: string
  grantDecisionRevision: string
  rootBindingRevision: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function canonicalFilesystemProjectCapability(value: unknown): FilesystemProjectCapability | null {
  if (typeof value !== 'string') return null
  const capability = canonicalCapabilityForMcp(FILESYSTEM_MCP_ID, value) as FilesystemProjectCapability
  if (
    classifyCapability(FILESYSTEM_MCP_ID, capability) !== 'bounded_read_only' ||
    mcpDeliveryKind(FILESYSTEM_MCP_ID) !== 'bounded_context_packet'
  ) return null
  return FILESYSTEM_PROJECT_CAPABILITY_SET.has(capability) ? capability : null
}

export function canonicalFilesystemProjectCapabilities(values: unknown): FilesystemProjectCapability[] {
  const capabilities = new Set<FilesystemProjectCapability>()
  if (!Array.isArray(values)) return []
  for (const value of values) {
    const capability = canonicalFilesystemProjectCapability(value)
    if (capability) capabilities.add(capability)
  }
  return [...capabilities].sort()
}

export function hasUnsafeFilesystemCapability(values: unknown): boolean {
  if (!Array.isArray(values)) return false
  return values.some((value) => (
    typeof value === 'string' &&
    canonicalCapabilityForMcp(FILESYSTEM_MCP_ID, value).startsWith('filesystem.') &&
    canonicalFilesystemProjectCapability(value) === null
  ))
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : []
}

function filesystemProjectionPolicy(entry: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(entry, 'decisionId') || Object.hasOwn(entry, 'requirementKey')) return entry
  const assignment = isRecord(entry.assignment) ? entry.assignment : {}
  const hasLegacyAgent = typeof entry.agent === 'string' ||
    typeof entry.assignedRole === 'string' ||
    (Array.isArray(assignment.targetAgents) && assignment.targetAgents.length === 1)
  return {
    ...entry,
    ...(!hasLegacyAgent ? { assignedRole: 'filesystem-projection' } : {}),
    ...(!isRecord(entry.fallback) ? { fallback: { action: 'block', message: '' } } : {}),
  }
}

function filesystemProjectionAdmission(input: {
  mcpRequirements: unknown
  metadata: unknown
  projectMcpConfig?: unknown
  projectFilesystemDecision?: unknown
  projectRootBindingRevision?: unknown
}): McpWorkPackageAdmission {
  const metadata = isRecord(input.metadata) ? input.metadata : {}
  const project = {
    mcpConfig: input.projectMcpConfig ?? {},
    filesystemGrantDecision: input.projectFilesystemDecision,
    rootBindingRevision: input.projectRootBindingRevision,
  }
  const entries = recordArray(input.mcpRequirements).map(filesystemProjectionPolicy)
  const fallbackAgents = [...new Set(entries.flatMap((entry) => {
    if (typeof entry.agent === 'string' && entry.agent.trim()) return [entry.agent]
    if (typeof entry.assignedRole === 'string' && entry.assignedRole.trim()) return [entry.assignedRole]
    const assignment = isRecord(entry.assignment) ? entry.assignment : {}
    return Array.isArray(assignment.targetAgents) && assignment.targetAgents.length === 1 &&
      typeof assignment.targetAgents[0] === 'string'
      ? [assignment.targetAgents[0]]
      : []
  }))]
  const legacySubtaskAgent = fallbackAgents.length === 1 ? fallbackAgents[0] : 'filesystem-projection'
  return admitWorkPackageMcp({
    entries: [
      ...entries,
      ...recordArray(metadata.mcpGrants),
    ],
    subtasks: recordArray(metadata.mcpAwareSubtasks).map((subtask) => {
      const assignment = isRecord(subtask.assignment) ? subtask.assignment : {}
      const hasAgent = typeof subtask.agent === 'string' ||
        typeof subtask.assignedRole === 'string' ||
        (Array.isArray(assignment.targetAgents) && assignment.targetAgents.length === 1)
      return hasAgent ? subtask : { ...subtask, agent: legacySubtaskAgent }
    }),
    label: 'filesystem grant projection',
    statusFor: () => null,
    effectiveGrantFor: ({ requiredCapabilities }) => readEffectiveGrantState(
      { metadata },
      project,
      requiredCapabilities,
    ),
    hasPromptOnlyContextFor: () => false,
  })
}

function filesystemRequestedCapability(value: string): FilesystemProjectRequestCapability | null {
  const capability = canonicalCapabilityForMcp(FILESYSTEM_MCP_ID, value)
  const capabilityClass = classifyCapability(FILESYSTEM_MCP_ID, capability)
  if (capability === 'filesystem.project.write' && capabilityClass === 'planning_only') {
    return capability
  }
  return canonicalFilesystemProjectCapability(capability)
}

export function summarizeFilesystemCapabilities(input: {
  mcpRequirements: unknown
  metadata: unknown
  projectMcpConfig?: unknown
  projectFilesystemDecision?: unknown
  projectRootBindingRevision?: unknown
}): FilesystemCapabilitySummary {
  const admission = filesystemProjectionAdmission(input)
  const planningVisible = new Set<FilesystemProjectRequestCapability>()
  const boundedRuntimeRequested = new Set<FilesystemProjectCapability>()
  const blocking = new Set<FilesystemProjectCapability>()

  for (const evaluation of admission.evaluations) {
    if (evaluation.decision.mcpId !== FILESYSTEM_MCP_ID) continue
    for (const value of evaluation.decision.normalizedCapabilities) {
      const capability = filesystemRequestedCapability(value)
      if (!capability) continue
      planningVisible.add(capability)
      if (capability !== 'filesystem.project.write') boundedRuntimeRequested.add(capability)
      if (
        capability !== 'filesystem.project.write' &&
        evaluation.decision.status === 'blocked' &&
        evaluation.decision.recoveryAction === 'approve_project_filesystem_context'
      ) blocking.add(capability)
    }
  }
  for (const decision of admission.subtaskDecisions) {
    if (decision.mcpId !== FILESYSTEM_MCP_ID) continue
    const capability = filesystemRequestedCapability(decision.capability)
    if (!capability) continue
    planningVisible.add(capability)
    if (capability !== 'filesystem.project.write') boundedRuntimeRequested.add(capability)
    if (
      capability !== 'filesystem.project.write' &&
      decision.status === 'blocked' &&
      decision.recoveryAction === 'approve_project_filesystem_context'
    ) blocking.add(capability)
  }

  // A bounded filesystem packet contains file contents even when the Architect
  // only asked to list or search paths. Preserve that runtime dependency in
  // the projection so approval, execution, and audit evidence all require the
  // read capability explicitly.
  if (boundedRuntimeRequested.size > 0) {
    planningVisible.add('filesystem.project.read')
    boundedRuntimeRequested.add('filesystem.project.read')
  }
  if (blocking.size > 0) blocking.add('filesystem.project.read')

  return {
    blockingCapabilities: [...blocking].sort(),
    planningVisibleCapabilities: [...planningVisible].sort(),
    boundedRuntimeRequestedCapabilities: [...boundedRuntimeRequested].sort(),
    requestedCapabilities: [...planningVisible].sort(),
  }
}

export type FilesystemMcpStatusLike = {
  mcpId: string
  enabled?: boolean
  installState?: string
  status?: string
  error?: string | null
}

/**
 * Returns a human-readable reason the project's filesystem MCP cannot back a
 * filesystem grant yet (not configured / disabled / not installed / unhealthy),
 * or null when it is installed and healthy. Shared by the per-task grant route
 * and the project-level always-allow control so both gate on the same checks.
 */
export function filesystemGrantHealthError(
  statuses: ReadonlyArray<FilesystemMcpStatusLike>,
): string | null {
  const filesystem = statuses.find((status) => status.mcpId === FILESYSTEM_MCP_ID)
  const status = filesystem as ProjectMcpStatus | undefined
  return isMcpHealthy(FILESYSTEM_MCP_ID, status ?? null)
    ? null
    : mcpHealthReason(FILESYSTEM_MCP_ID, status ?? null)
}

export function projectFilesystemGrantFromConfig(mcpConfig: unknown): ProjectFilesystemGrant | null {
  const config = isRecord(mcpConfig) ? mcpConfig : {}
  const grants = isRecord(config.grants) ? config.grants : {}
  const filesystem = isRecord(grants.filesystem) ? grants.filesystem : null
  if (!filesystem) return null
  if (
    filesystem.schemaVersion !== 2 ||
    filesystem.mcpId !== FILESYSTEM_MCP_ID ||
    filesystem.status !== 'approved' ||
    filesystem.grantMode !== 'always_allow'
  ) {
    return null
  }
  const capabilities = canonicalFilesystemProjectCapabilities(filesystem.capabilities)
  const grantDecisionRevision = canonicalPositiveDecisionRevision(filesystem.grantDecisionRevision)
  const rootBindingRevision = canonicalPositiveDecisionRevision(filesystem.rootBindingRevision)
  if (
    capabilities.length === 0 ||
    !capabilities.includes('filesystem.project.read') ||
    !grantDecisionRevision ||
    !rootBindingRevision
  ) return null
  return {
    schemaVersion: 2,
    mcpId: FILESYSTEM_MCP_ID,
    status: 'approved',
    grantMode: 'always_allow',
    capabilities,
    grantApprovalId: typeof filesystem.grantApprovalId === 'string' ? filesystem.grantApprovalId : '',
    approvedAt: typeof filesystem.approvedAt === 'string' ? filesystem.approvedAt : '',
    approvedBy: typeof filesystem.approvedBy === 'string' ? filesystem.approvedBy : '',
    reason: typeof filesystem.reason === 'string' ? filesystem.reason : '',
    grantDecisionRevision,
    rootBindingRevision,
  }
}

export function projectFilesystemGrantFromAuthority(value: unknown): ProjectFilesystemGrant | null {
  const authority = parseProjectFilesystemDecisionAuthority(value)
  if (!authority || authority.decision !== 'approved') return null
  return {
    schemaVersion: 2,
    mcpId: FILESYSTEM_MCP_ID,
    status: 'approved',
    grantMode: 'always_allow',
    capabilities: authority.capabilities as FilesystemProjectCapability[],
    grantApprovalId: authority.decisionId,
    approvedAt: authority.decidedAt,
    approvedBy: authority.decidedBy,
    reason: authority.reason,
    grantDecisionRevision: authority.grantDecisionRevision as ProjectFilesystemGrant['grantDecisionRevision'],
    rootBindingRevision: authority.rootBindingRevision as ProjectFilesystemGrant['rootBindingRevision'],
  }
}

export function projectFilesystemGrantCovers(input: {
  mcpConfig: unknown
  mcpRequirements: unknown
  metadata: unknown
  projectFilesystemDecision?: unknown
  projectRootBindingRevision?: unknown
}): ProjectFilesystemGrant | null {
  const grant = projectFilesystemGrantFromAuthority(input.projectFilesystemDecision)
  if (!grant) return null
  const rootBindingRevision = canonicalPositiveDecisionRevision(
    typeof input.projectRootBindingRevision === 'bigint'
      ? input.projectRootBindingRevision.toString()
      : input.projectRootBindingRevision,
  )
  if (!rootBindingRevision || grant.rootBindingRevision !== rootBindingRevision) return null
  const summary = summarizeFilesystemCapabilities({
    mcpRequirements: input.mcpRequirements,
    metadata: input.metadata,
  })
  if (summary.blockingCapabilities.length === 0 && summary.boundedRuntimeRequestedCapabilities.length === 0) return null
  const required = summary.blockingCapabilities.length > 0
    ? summary.blockingCapabilities
    : summary.boundedRuntimeRequestedCapabilities
  if (required.length === 0) return null
  return required.every((capability) => grant.capabilities.includes(capability)) ? grant : null
}

export function projectFilesystemEffectivePhase(grant: ProjectFilesystemGrant): Record<string, unknown> {
  return {
    schemaVersion: 2,
    phase: 'effective',
    source: 'project-filesystem-approval',
    grantApprovalId: grant.grantApprovalId,
    grantMode: 'always_allow',
    scope: 'project',
    mcpId: FILESYSTEM_MCP_ID,
    approvedAt: grant.approvedAt,
    approvedBy: grant.approvedBy,
    grants: [{
      mcpId: FILESYSTEM_MCP_ID,
      status: 'approved',
      capabilities: grant.capabilities,
      grantApprovalId: grant.grantApprovalId,
      grantMode: 'always_allow',
      reason: grant.reason,
    }],
    reason: grant.reason,
    runtimeIssued: false,
    runtimeEnforcement: 'bounded_context_packet',
    status: 'approved',
    grantDecisionRevision: grant.grantDecisionRevision,
    rootBindingRevision: grant.rootBindingRevision,
    note: 'Project-level filesystem approval allows bounded read-only context packets for this project until changed. Live MCP filesystem tool handles and filesystem writes are not issued.',
  }
}

export function isProjectFilesystemEffectivePhase(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    value.phase === 'effective' &&
    value.source === 'project-filesystem-approval' &&
    value.runtimeEnforcement === 'bounded_context_packet' &&
    value.status === 'approved'
  )
}

export function isExplicitFilesystemEffectivePhase(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  return (
    (value.schemaVersion === 1 || value.schemaVersion === 2) &&
    value.phase === 'effective' &&
    (value.source === 'explicit-grant-approval' || value.source === 'project-filesystem-approval') &&
    value.runtimeEnforcement === 'bounded_context_packet' &&
    (value.status === 'approved' || value.status === 'denied')
  )
}

export function filesystemEffectiveGrantApprovalId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.grantApprovalId === 'string' && value.grantApprovalId.length > 0) {
    return value.grantApprovalId
  }
  for (const grant of recordArray(value.grants)) {
    if (typeof grant.grantApprovalId === 'string' && grant.grantApprovalId.length > 0) {
      return grant.grantApprovalId
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Handoff gate: does a package still need explicit filesystem grant approval?
//
// Plan approval does NOT convert Architect-proposed filesystem requirements into
// runtime-effective grants (it records a `not_issued` effective phase). Only the
// explicit grant-approval endpoint issues an approved effective phase. These
// helpers let the handoff gate hold such a package for explicit approval instead
// of running it and burning execution attempts on a guaranteed context block.
// ---------------------------------------------------------------------------

/** Filesystem capabilities carried by an *approved* effective grant phase. */
export function approvedEffectiveFilesystemCapabilities(metadata: unknown): FilesystemProjectCapability[] {
  const meta = isRecord(metadata) ? metadata : {}
  const phases = isRecord(meta.mcpGrantPhases) ? meta.mcpGrantPhases : {}
  const effective = isRecord(phases.effective) ? phases.effective : {}
  if (
    (effective.schemaVersion !== 1 && effective.schemaVersion !== 2) ||
    effective.phase !== 'effective' ||
    effective.runtimeEnforcement !== 'bounded_context_packet' ||
    effective.status !== 'approved'
  ) {
    return []
  }
  const capabilities = new Set<FilesystemProjectCapability>()
  for (const grant of recordArray(effective.grants)) {
    if (grant.mcpId !== FILESYSTEM_MCP_ID) continue
    if (grant.status !== 'approved') continue
    for (const capability of canonicalFilesystemProjectCapabilities(grant.capabilities)) {
      capabilities.add(capability)
    }
  }
  return [...capabilities].sort()
}

/**
 * A package requires explicit filesystem grant approval when it has *required*
 * (blocking) filesystem capabilities that an approved effective grant does not
 * yet cover. Optional `continue_without_mcp` requirements never block.
 */
export function requiresFilesystemGrantApproval(input: {
  mcpRequirements: unknown
  metadata: unknown
  projectMcpConfig?: unknown
  projectFilesystemDecision?: unknown
  projectRootBindingRevision?: unknown
}): {
  blocked: boolean
  holdState?: FilesystemGrantHoldState
  missingCapabilities: FilesystemProjectCapability[]
  requestedCapabilities: FilesystemProjectRequestCapability[]
  requirementKeys: string[]
} {
  const admission = filesystemProjectionAdmission(input)
  const { blockingCapabilities, requestedCapabilities } = summarizeFilesystemCapabilities(input)
  if (blockingCapabilities.length === 0) {
    return { blocked: false, missingCapabilities: [], requestedCapabilities, requirementKeys: [] }
  }
  const missing = new Set<FilesystemProjectCapability>()
  const metadata = isRecord(input.metadata) ? input.metadata : {}
  const project = {
    mcpConfig: input.projectMcpConfig ?? {},
    filesystemGrantDecision: input.projectFilesystemDecision,
    rootBindingRevision: input.projectRootBindingRevision,
  }
  const blockingStates: ReturnType<typeof readEffectiveGrantState>[] = []
  const requirementKeys = new Set<string>()
  for (const evaluation of admission.evaluations) {
    if (
      evaluation.decision.mcpId !== FILESYSTEM_MCP_ID ||
      evaluation.decision.status !== 'blocked' ||
      evaluation.decision.recoveryAction !== 'approve_project_filesystem_context'
    ) continue
    const grantState = readEffectiveGrantState(
      { metadata },
      project,
      evaluation.decision.normalizedCapabilities,
    )
    blockingStates.push(grantState)
    requirementKeys.add(evaluation.source.requirementKey)
    const coveredKeys = new Set(grantState.coveredCapabilities.flatMap(coverageKeysForGrant))
    for (const value of evaluation.decision.normalizedCapabilities) {
      const capability = canonicalFilesystemProjectCapability(value)
      if (
        capability &&
        (grantState.phase !== 'approved' || grantState.consumed === true ||
          !coverageKeysForGrant(capability).some((key) => coveredKeys.has(key)))
      ) missing.add(capability)
    }
  }
  for (const decision of admission.subtaskDecisions) {
    if (
      decision.mcpId !== FILESYSTEM_MCP_ID ||
      decision.status !== 'blocked' ||
      decision.recoveryAction !== 'approve_project_filesystem_context'
    ) continue
    const capability = canonicalFilesystemProjectCapability(decision.capability)
    const grantState = capability
      ? readEffectiveGrantState({ metadata }, project, [capability])
      : null
    if (capability && (grantState?.phase !== 'approved' || grantState.consumed === true)) {
      missing.add(capability)
      if (grantState) blockingStates.push(grantState)
      requirementKeys.add(decision.requirementKey)
    }
  }
  const missingCapabilities = [...missing].sort()
  if (missingCapabilities.length === 0) {
    return { blocked: false, missingCapabilities, requestedCapabilities, requirementKeys: [] }
  }
  const state = blockingStates[0]
  const revision = canonicalPositiveDecisionRevision(state?.grantDecisionRevision)
  let holdState: FilesystemGrantHoldState
  if (state?.phase === 'denied') {
    holdState = {
      holdKind: 'denied_required',
      grantPhase: 'denied',
      grantConsumed: false,
      grantDecisionRevision: revision,
      revocationReason: null,
    }
  } else if (state?.phase === 'revoked' && revision && state.revocationReason) {
    holdState = {
      holdKind: 'revoked_required',
      grantPhase: 'revoked',
      grantConsumed: false,
      grantDecisionRevision: revision,
      revocationReason: state.revocationReason as FilesystemGrantRevocationReason,
    }
  } else if (state?.phase === 'approved' && state.consumed === true && revision) {
    holdState = {
      holdKind: 'consumed_once',
      grantPhase: 'approved',
      grantConsumed: true,
      grantDecisionRevision: revision,
      revocationReason: null,
    }
  } else {
    holdState = {
      holdKind: 'approval_required',
      grantPhase: state?.phase === 'proposed' || state?.phase === 'not_issued'
        ? state.phase
        : 'none',
      grantConsumed: false,
      grantDecisionRevision: null,
      revocationReason: null,
    }
  }
  return {
    blocked: true,
    holdState,
    missingCapabilities,
    requestedCapabilities,
    requirementKeys: [...requirementKeys].sort(),
  }
}

/**
 * Marker written on a package that the handoff gate failed for missing
 * filesystem grants. It is the evidence the grant-recovery endpoint keys off to
 * distinguish a grant block from an unrelated execution/validation failure.
 */
export const FILESYSTEM_GRANT_BLOCK_METADATA_KEY = 'mcpGrantBlock'

/**
 * The single canonical reader for the operator-hold grant block. Every consumer
 * — the reconciliation service, the block predicate below, and the legacy
 * compatibility adapter — reads the block through here so the location
 * (`metadata.mcpGrantBlock`) and the strict canonical parse are defined once.
 */
export function readFilesystemGrantBlockFromMetadata(
  metadata: unknown,
): FilesystemGrantBlockMetadata | null {
  if (!isRecord(metadata)) return null
  return parseFilesystemGrantBlockMetadata(metadata[FILESYSTEM_GRANT_BLOCK_METADATA_KEY])
}

export function isFilesystemGrantBlockedPackageMetadata(metadata: unknown): boolean {
  return readFilesystemGrantBlockFromMetadata(metadata) !== null
}
