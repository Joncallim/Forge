import { isKnownMcpId } from './catalog'
import {
  canProceedWithoutMcp,
  canonicalCapabilityForMcp,
  capabilityMcpId,
  classifyCapability,
  coverageKeysForGrant,
  coverageKeysForProhibition,
  isSafeCapabilityText,
  isMcpHealthy,
  mcpDeliveryKind,
  mcpHealthReason,
  mergeCapabilityFields,
  normalizeCapability,
  REQUIREMENT_CAPABILITY_FIELDS,
  sanitizeMcpError,
  type McpCapabilityClass,
  type McpDeliveryKind,
} from './capability-normalization'
import { parseProjectFilesystemDecisionAuthority } from './filesystem-project-authority'
import type { ProjectMcpStatus } from './types'
import type {
  McpAssignmentType,
  McpExecutionValidation,
  McpFallbackAction,
  McpGrantDecisionStatus,
  McpGrantDecisions,
  WorkPackageMcpBrokerCheck,
} from '@/worker/mcp-execution-design'

export type { McpCapabilityClass, McpDeliveryKind }

export type McpAdmissionMode =
  | 'planning_only'
  | 'bounded_context_required'
  | 'bounded_context_approved'
  | 'blocked'
  | 'deferred_live_mcp'
  | 'unknown_legacy'

export type McpAdmissionStatus = 'allowed' | 'warning' | 'blocked'

export type McpRecoveryAction =
  | 'continue_as_prompt_context'
  | 'approve_project_filesystem_context'
  | 'install_or_fix_mcp'
  | 'revise_plan'
  | 'defer_live_mcp_feature'

export type McpHealthSnapshot =
  | {
      schemaVersion: 1
      observed: true
      mcpId: string
      installState: ProjectMcpStatus['installState']
      status: ProjectMcpStatus['status']
      enabled: boolean
      error: string | null
      checkedAt: string
    }
  | {
      schemaVersion: 1
      observed: false
      mcpId: string
      installState: 'unknown'
      status: 'unknown'
      enabled: false
      error: null
      checkedAt: null
    }

export type EffectiveGrantState = {
  phase: 'none' | 'proposed' | 'approved' | 'denied' | 'revoked' | 'not_issued'
  source: 'none' | 'package-local' | 'project-level'
  status: 'not_issued' | 'approved' | 'denied'
  grantMode?: 'allow_once' | 'always_allow'
  consumed?: boolean
  coveredCapabilities: string[]
  grantApprovalId?: string
  grantDecisionRevision?: string
  rootBindingRevision?: string
  revocationReason?:
    | 'project_grant_removed'
    | 'project_grant_narrowed'
    | 'project_root_repoint'
}

export type McpAdmissionDecision = {
  schemaVersion: 1
  mcpId: 'filesystem' | 'github' | string
  agent: string
  requirement: 'required' | 'optional'
  requestedCapabilities: string[]
  normalizedCapabilities: string[]
  capabilityClasses: Array<{
    capability: string
    class: McpCapabilityClass
    deliveryKind: McpDeliveryKind | null
  }>
  mode: McpAdmissionMode
  status: McpAdmissionStatus
  reason: string
  recoveryAction?: McpRecoveryAction
  grantState?: {
    phase: EffectiveGrantState['phase']
    consumed?: boolean
    revocationReason?: string
  }
  evidenceRefs: string[]
}

export type McpAdmissionEvaluation = {
  decision: McpAdmissionDecision
  source: {
    requirementKey: string
    decisionId: string
    sourceRequirementIndex: number
    assignment: { type: McpAssignmentType; targetId: string | null }
    fallback: { action: McpFallbackAction; message: string }
    promptOverlayPresent: boolean
  }
  health: McpHealthSnapshot
}

export type McpPrimaryBlockingDecision = {
  kind: 'requirement' | 'subtask'
  mode: McpAdmissionMode
  recoveryAction: McpRecoveryAction
  retryableContribution: boolean
  reason: string
  evidenceRefs: string[]
  requirementKey: string
  agent: string
  mcpId: string
  decisionId?: string
  sourceRequirementIndex?: number
  subtaskId?: string
  capability?: string
}

export type McpWorkPackageAdmission = {
  schemaVersion: 2
  evaluations: McpAdmissionEvaluation[]
  subtaskDecisions: Array<{
    subtaskId: string
    agent: string
    requirementKey: string
    mcpId: string
    capability: string
    class: McpCapabilityClass
    deliveryKind: McpDeliveryKind | null
    status: McpAdmissionStatus
    reason: string
    recoveryAction?: McpRecoveryAction
  }>
  referencedHealth: McpExecutionValidation['health']
  aggregate: {
    status: 'allowed' | 'warning' | 'blocked'
    blocked: string[]
    warnings: string[]
    blockedReason: string | null
    retryable: boolean
    primaryMode?: McpAdmissionMode
    primaryRecoveryAction?: McpRecoveryAction
    primaryDecision?: McpPrimaryBlockingDecision
  }
}

export type McpGrantPreviewDecision = Omit<McpGrantDecisions['decisions'][number], 'health'> & {
  requirementKey: string
  health: McpHealthSnapshot
  mode: McpAdmissionMode
  recoveryAction?: McpRecoveryAction
  grantState?: McpAdmissionDecision['grantState']
  normalizedCapabilities: string[]
  capabilityClasses: McpAdmissionDecision['capabilityClasses']
  evidenceRefs: string[]
  admissionStatus: McpAdmissionStatus
}

export type McpGrantPreview = Omit<McpGrantDecisions, 'decisions'> & {
  decisions: McpGrantPreviewDecision[]
  admissionStatus: McpWorkPackageAdmission['aggregate']['status']
  blocked: string[]
  warnings: string[]
  blockedReason: string | null
  retryable: boolean
  primaryMode?: McpAdmissionMode
  primaryRecoveryAction?: McpRecoveryAction
  primaryDecision?: McpPrimaryBlockingDecision
  evaluations: McpAdmissionEvaluation[]
  subtaskDecisions: McpWorkPackageAdmission['subtaskDecisions']
}

export type McpBrokerAdmissionCheck = WorkPackageMcpBrokerCheck & {
  retryable: boolean
  primaryMode?: McpAdmissionMode
  primaryRecoveryAction?: McpRecoveryAction
  primaryDecision?: McpPrimaryBlockingDecision
  evaluations: McpAdmissionEvaluation[]
  subtaskDecisions: McpWorkPackageAdmission['subtaskDecisions']
}

const NO_GRANT: EffectiveGrantState = {
  phase: 'none',
  source: 'none',
  status: 'not_issued',
  coveredCapabilities: [],
}

const MAX_ADMISSION_ENTRIES = 80
const MAX_ADMISSION_SUBTASKS = 40
const MAX_ADMISSION_NESTED_ITEMS = 30

function noGrant(phase: EffectiveGrantState['phase'] = 'none'): EffectiveGrantState {
  return { ...NO_GRANT, phase, coveredCapabilities: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? Object.fromEntries(Object.entries(value)) : null
}

function text(value: unknown, maxLength = 240): string {
  return sanitizeMcpError(value, maxLength)
}

function projectedIdentity(
  value: unknown,
  maxLength: number,
): { value: string; valid: boolean } {
  const projected = text(value, maxLength)
  return {
    value: projected,
    valid: typeof value === 'string' &&
      value.length <= maxLength &&
      value.trim() === value &&
      isSafeCapabilityText(value) &&
      projected === value &&
      projected.length > 0,
  }
}

function validMcpIdText(value: unknown): boolean {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 80 &&
    value.trim() === value &&
    isSafeCapabilityText(value) &&
    /^[a-z0-9][a-z0-9_-]*$/.test(value)
}

const MCP_INSTALL_STATES = new Set<ProjectMcpStatus['installState']>(['installed', 'missing'])
const MCP_HEALTH_STATUSES = new Set<ProjectMcpStatus['status']>([
  'healthy',
  'unhealthy',
  'disabled',
  'auth_required',
  'configuration_required',
  'unknown',
])

function validatedProjectMcpStatus(mcpId: string, value: unknown): ProjectMcpStatus | null {
  const status = ownRecord(value)
  if (
    !status ||
    status.mcpId !== mcpId ||
    !MCP_INSTALL_STATES.has(status.installState as ProjectMcpStatus['installState']) ||
    !MCP_HEALTH_STATUSES.has(status.status as ProjectMcpStatus['status']) ||
    typeof status.enabled !== 'boolean' ||
    (status.error !== null && typeof status.error !== 'string') ||
    typeof status.checkedAt !== 'string' ||
    status.checkedAt.length === 0 ||
    status.checkedAt.length > 80 ||
    status.checkedAt.trim() !== status.checkedAt ||
    !Number.isFinite(Date.parse(status.checkedAt))
  ) {
    return null
  }
  return {
    mcpId,
    displayName: '',
    description: '',
    installPath: '',
    installState: status.installState as ProjectMcpStatus['installState'],
    status: status.status as ProjectMcpStatus['status'],
    enabled: status.enabled,
    error: status.error,
    checkedAt: status.checkedAt,
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(isSafeCapabilityText).map(normalizeCapability).filter(Boolean)
    : []
}

function capabilityFieldValidationErrors(entry: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const field of REQUIREMENT_CAPABILITY_FIELDS) {
    if (!Object.hasOwn(entry, field)) continue
    const values = entry[field]
    if (!Array.isArray(values)) {
      errors.push(`Capability field '${field}' must be an array of non-empty strings.`)
      continue
    }
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]
      if (!isSafeCapabilityText(value)) {
        errors.push(`Capability field '${field}' item ${index} must be a non-empty string.`)
      }
    }
  }
  if (Object.hasOwn(entry, 'prohibitedCapabilities')) {
    const prohibited = entry.prohibitedCapabilities
    if (!Array.isArray(prohibited)) {
      errors.push("Capability field 'prohibitedCapabilities' must be an array of non-empty strings.")
    } else {
      for (let index = 0; index < prohibited.length; index += 1) {
        const value = prohibited[index]
        if (!isSafeCapabilityText(value)) {
          errors.push(`Capability field 'prohibitedCapabilities' item ${index} must be a non-empty string.`)
        }
      }
    }
  }
  return errors
}

function boundedTexts(value: unknown, maxLength = 300): string[] {
  return Array.isArray(value)
    ? value.map((item) => text(item, maxLength)).filter(Boolean)
    : []
}

function boundedFilesystemCapabilities(
  value: unknown,
  options: { allowEmpty: boolean },
): { valid: boolean; capabilities: string[] } {
  if (!Array.isArray(value) || value.length > MAX_ADMISSION_NESTED_ITEMS) {
    return { valid: false, capabilities: [] }
  }
  const result = new Set<string>()
  for (const capability of value) {
    if (
      !isSafeCapabilityText(capability) ||
      classifyCapability('filesystem', capability) !== 'bounded_read_only'
    ) {
      return { valid: false, capabilities: [] }
    }
    result.add(canonicalCapabilityForMcp('filesystem', capability))
  }
  const capabilities = [...result].sort()
  return {
    valid: options.allowEmpty || capabilities.length > 0,
    capabilities,
  }
}

function grantCapabilities(value: unknown): { valid: boolean; capabilities: string[] } {
  if (!Array.isArray(value) || value.length > MAX_ADMISSION_NESTED_ITEMS) {
    return { valid: false, capabilities: [] }
  }
  const result = new Set<string>()
  for (const valueItem of value) {
    const grant = ownRecord(valueItem)
    if (!grant) return { valid: false, capabilities: [] }
    if (grant.mcpId !== 'filesystem') continue
    if (grant.status !== 'approved') return { valid: false, capabilities: [] }
    const parsed = boundedFilesystemCapabilities(grant.capabilities, { allowEmpty: true })
    if (!parsed.valid) return { valid: false, capabilities: [] }
    for (const capability of parsed.capabilities) result.add(capability)
  }
  return { valid: true, capabilities: [...result].sort() }
}

function covers(covered: readonly string[], required: readonly string[]): boolean {
  const keys = new Set(covered.flatMap(coverageKeysForGrant))
  return required.every((capability) => coverageKeysForGrant(capability).some((key) => keys.has(key)))
}

export function readEffectiveGrantState(
  pkg: { metadata: unknown },
  project: {
    mcpConfig?: unknown
    filesystemGrantDecision?: unknown
    rootBindingRevision?: unknown
  },
  requiredCapabilities: string[],
): EffectiveGrantState {
  const parsedRequired = boundedFilesystemCapabilities(requiredCapabilities, { allowEmpty: false })
  if (!parsedRequired.valid) return noGrant()
  const required = parsedRequired.capabilities
  const metadata = ownRecord(pkg.metadata) ?? {}
  const phases = ownRecord(metadata.mcpGrantPhases) ?? {}
  const effective = ownRecord(phases.effective)
  const config = ownRecord(project.mcpConfig) ?? {}
  const canonicalRevision = (value: unknown): string | null => {
    if (typeof value === 'bigint') return value > BigInt(0) ? value.toString() : null
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? String(value) : null
    }
    return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : null
  }
  const currentRootRevision = canonicalRevision(
    project.rootBindingRevision ?? config.rootBindingRevision,
  )
  const projectDecision = parseProjectFilesystemDecisionAuthority(project.filesystemGrantDecision)
  const parsedProjectCapabilities = boundedFilesystemCapabilities(projectDecision?.capabilities, { allowEmpty: false })
  const projectDecisionRevision = canonicalRevision(projectDecision?.grantDecisionRevision)
  const projectRootRevision = canonicalRevision(projectDecision?.rootBindingRevision)
  const validProjectGrant = projectDecision?.decision === 'approved' &&
    parsedProjectCapabilities.valid &&
    projectDecisionRevision !== null &&
    projectRootRevision !== null &&
    projectRootRevision === currentRootRevision
  const projectCovered = validProjectGrant ? parsedProjectCapabilities.capabilities : []
  const revocationDecisionRevision = projectDecision?.decision === 'revoked'
    ? canonicalRevision(projectDecision.grantDecisionRevision)
    : null
  const revocationRootRevision = projectDecision?.decision === 'revoked'
    ? canonicalRevision(projectDecision.rootBindingRevision)
    : null
  const validProjectRevocation = projectDecision?.decision === 'revoked' &&
    revocationDecisionRevision !== null &&
    revocationRootRevision !== null &&
    revocationRootRevision === currentRootRevision

  const validEffective = effective?.schemaVersion === 2 &&
    effective.phase === 'effective' &&
    effective.runtimeEnforcement === 'bounded_context_packet'
  const localDecisionRevision = canonicalRevision(effective?.grantDecisionRevision)
  const localRootRevision = canonicalRevision(effective?.rootBindingRevision)

  const projectResult = (): EffectiveGrantState => ({
    phase: 'approved',
    source: 'project-level',
    status: 'approved',
    grantMode: 'always_allow',
    coveredCapabilities: projectCovered,
    grantApprovalId: projectDecision?.decisionId,
    grantDecisionRevision: projectDecisionRevision ?? undefined,
    rootBindingRevision: projectRootRevision ?? undefined,
  })

  if (validEffective && effective.status === 'denied') {
    if (localDecisionRevision === null || localRootRevision === null) {
      return {
        phase: 'denied',
        source: 'package-local',
        status: 'denied',
        coveredCapabilities: [],
        grantApprovalId: text(effective.grantApprovalId) || undefined,
      }
    }
    if (localRootRevision !== currentRootRevision) {
      return {
        phase: 'revoked',
        source: 'package-local',
        status: 'not_issued',
        coveredCapabilities: [],
        grantApprovalId: validProjectRevocation ? projectDecision.decisionId : text(effective.grantApprovalId) || undefined,
        grantDecisionRevision: validProjectRevocation ? revocationDecisionRevision! : localDecisionRevision,
        rootBindingRevision: validProjectRevocation ? revocationRootRevision! : localRootRevision,
        revocationReason: 'project_root_repoint',
      }
    }
    const laterProjectGrantCovers = validProjectGrant &&
      covers(projectCovered, required) &&
      BigInt(projectDecisionRevision!) > BigInt(localDecisionRevision)
    if (!laterProjectGrantCovers) {
      return {
        phase: 'denied',
        source: 'package-local',
        status: 'denied',
        coveredCapabilities: [],
        grantApprovalId: text(effective.grantApprovalId) || undefined,
        grantDecisionRevision: localDecisionRevision,
        rootBindingRevision: localRootRevision,
      }
    }
    return projectResult()
  }

  if (validEffective && effective.source === 'project-filesystem-approval' && effective.status === 'approved') {
    const historicalRevision = localDecisionRevision
    const historicalRootRevision = localRootRevision
    if (historicalRootRevision !== null && historicalRootRevision !== currentRootRevision) {
      return {
        phase: 'revoked',
        source: 'project-level',
        status: 'not_issued',
        coveredCapabilities: [],
        grantApprovalId: validProjectRevocation ? projectDecision.decisionId : text(effective.grantApprovalId) || undefined,
        grantDecisionRevision: validProjectRevocation ? revocationDecisionRevision! : historicalRevision ?? undefined,
        rootBindingRevision: validProjectRevocation ? revocationRootRevision! : historicalRootRevision,
        revocationReason: 'project_root_repoint',
      }
    }
    if (!validProjectGrant || !covers(projectCovered, required)) {
      const removalReason = projectDecision?.revocationReason === 'project_root_repoint'
        ? 'project_root_repoint'
        : validProjectGrant ? 'project_grant_narrowed' : 'project_grant_removed'
      const effectiveRevision = removalReason === 'project_grant_narrowed'
        ? projectDecisionRevision ?? historicalRevision
        : revocationDecisionRevision ?? historicalRevision ?? projectDecisionRevision
      return {
        phase: 'revoked',
        source: 'project-level',
        status: 'not_issued',
        coveredCapabilities: validProjectGrant ? projectCovered : [],
        grantApprovalId: text(effective.grantApprovalId) || undefined,
        grantDecisionRevision: effectiveRevision ?? undefined,
        rootBindingRevision: revocationRootRevision ?? historicalRootRevision ?? undefined,
        revocationReason: removalReason,
      }
    }
    return projectResult()
  }

  if (
    validEffective &&
    effective.status === 'approved' &&
    effective.source === 'explicit-grant-approval' &&
    effective.grantMode === 'allow_once' &&
    typeof effective.runtimeIssued === 'boolean'
  ) {
    // The persisted phase records what was approved, even when its capability set is
    // narrower than this requirement. Admission rechecks exact coverage and fails
    // closed; it must not invent a new phase or grant mode to describe that mismatch.
    const parsedGrantCapabilities = grantCapabilities(effective.grants)
    if (!parsedGrantCapabilities.valid) return noGrant()
    const coveredCapabilities = parsedGrantCapabilities.capabilities
    if (localDecisionRevision === null || localRootRevision === null) return noGrant('not_issued')
    if (localRootRevision !== currentRootRevision) {
      return {
        phase: 'revoked',
        source: 'package-local',
        status: 'not_issued',
        coveredCapabilities: [],
        grantApprovalId: validProjectRevocation ? projectDecision.decisionId : text(effective.grantApprovalId) || undefined,
        grantDecisionRevision: validProjectRevocation ? revocationDecisionRevision! : localDecisionRevision,
        rootBindingRevision: validProjectRevocation ? revocationRootRevision! : localRootRevision,
        revocationReason: 'project_root_repoint',
      }
    }
    if (
      validProjectGrant &&
      covers(projectCovered, required) &&
      BigInt(projectDecisionRevision!) > BigInt(localDecisionRevision)
    ) return projectResult()
    const consumed = effective.runtimeIssued === true
    return {
      phase: 'approved',
      source: 'package-local',
      status: 'approved',
      grantMode: 'allow_once',
      consumed,
      coveredCapabilities,
      grantApprovalId: text(effective.grantApprovalId) || undefined,
      grantDecisionRevision: localDecisionRevision,
      rootBindingRevision: localRootRevision,
    }
  }

  if (
    validEffective &&
    effective.status === 'consumed' &&
    effective.source === 'explicit-grant-approval' &&
    effective.grantMode === 'allow_once' &&
    effective.runtimeIssued === true &&
    Array.isArray(effective.grants)
  ) {
    if (localDecisionRevision === null || localRootRevision === null) return noGrant('not_issued')
    if (localRootRevision !== currentRootRevision) {
      return {
        phase: 'revoked',
        source: 'package-local',
        status: 'not_issued',
        coveredCapabilities: [],
        grantApprovalId: validProjectRevocation ? projectDecision.decisionId : text(effective.grantApprovalId) || undefined,
        grantDecisionRevision: validProjectRevocation ? revocationDecisionRevision! : localDecisionRevision,
        rootBindingRevision: validProjectRevocation ? revocationRootRevision! : localRootRevision,
        revocationReason: 'project_root_repoint',
      }
    }
    const parsedGrantCapabilities = grantCapabilities(effective.grants)
    if (!parsedGrantCapabilities.valid) return noGrant()
    const coveredCapabilities = parsedGrantCapabilities.capabilities
    if (coveredCapabilities.length > 0) {
      return {
        phase: 'approved',
        source: 'package-local',
        status: 'approved',
        grantMode: 'allow_once',
        consumed: true,
        coveredCapabilities,
        grantApprovalId: text(effective.grantApprovalId) || undefined,
        grantDecisionRevision: localDecisionRevision,
        rootBindingRevision: localRootRevision,
      }
    }
  }

  if (validProjectGrant && covers(projectCovered, required)) {
    return projectResult()
  }

  if (validProjectRevocation) {
    return {
      phase: 'revoked',
      source: 'project-level',
      status: 'not_issued',
      coveredCapabilities: [],
      grantApprovalId: projectDecision.decisionId,
      grantDecisionRevision: revocationDecisionRevision!,
      rootBindingRevision: revocationRootRevision!,
      revocationReason: projectDecision.revocationReason!,
    }
  }
  if (validProjectGrant && projectDecision.revocationReason === 'project_grant_narrowed') {
    return {
      phase: 'revoked',
      source: 'project-level',
      status: 'not_issued',
      coveredCapabilities: projectCovered,
      grantApprovalId: projectDecision.decisionId,
      grantDecisionRevision: projectDecisionRevision!,
      rootBindingRevision: projectRootRevision!,
      revocationReason: 'project_grant_narrowed',
    }
  }

  // Exact bounded v1 adapter. A legacy denial remains a denial, but missing
  // revision/root authority is never upgraded from timestamps or today's path.
  const legacyEffective = effective?.schemaVersion === 1 &&
    effective.phase === 'effective' &&
    effective.runtimeEnforcement === 'bounded_context_packet'
  if (legacyEffective && effective.status === 'denied') {
    return {
      phase: 'denied',
      source: 'package-local',
      status: 'denied',
      coveredCapabilities: [],
      grantApprovalId: text(effective.grantApprovalId) || undefined,
    }
  }
  if (legacyEffective && effective.status === 'approved') return noGrant('not_issued')
  if (effective?.schemaVersion === 1 && effective.phase === 'effective' && effective.status === 'not_issued') {
    return noGrant('not_issued')
  }
  if (Array.isArray(phases.proposed)) return noGrant('proposed')
  return noGrant()
}

function grantStateForDecision(grant: EffectiveGrantState): McpAdmissionDecision['grantState'] {
  return {
    phase: grant.phase,
    ...(grant.consumed === undefined ? {} : { consumed: grant.consumed }),
    ...(grant.revocationReason ? { revocationReason: grant.revocationReason } : {}),
  }
}

function decisionReason(value: string): string {
  return text(value, 500)
}

function capabilityReasonList(capabilities: readonly string[]): string {
  return capabilities.length > 0 ? capabilities.join(', ') : '(none)'
}

function readProhibitedCapabilityKeys(value: unknown): { keys: Set<string>; malformed: boolean } {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return { keys: new Set(), malformed: true }
  }
  try {
    const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator]
    const has = (value as { has?: unknown }).has
    if (typeof iterator !== 'function' || typeof has !== 'function') {
      return { keys: new Set(), malformed: true }
    }
    const keys = new Set<string>()
    let itemCount = 0
    for (const item of value as Iterable<unknown>) {
      itemCount += 1
      if (itemCount > MAX_ADMISSION_NESTED_ITEMS) {
        return { keys: new Set(), malformed: true }
      }
      if (!isSafeCapabilityText(item) || normalizeCapability(item) !== item) {
        return { keys: new Set(), malformed: true }
      }
      const mcpId = capabilityMcpId(item)
      if (!mcpId || classifyCapability(mcpId, item) === 'unknown') {
        return { keys: new Set(), malformed: true }
      }
      for (const key of coverageKeysForProhibition(item)) keys.add(key)
    }
    return { keys, malformed: false }
  } catch {
    return { keys: new Set(), malformed: true }
  }
}

function coherentEffectiveGrantState(grant: Record<string, unknown>): boolean {
  const covered = boundedFilesystemCapabilities(grant.coveredCapabilities, { allowEmpty: true })
  if (!covered.valid) return false
  if (
    Object.hasOwn(grant, 'grantApprovalId') &&
    grant.grantApprovalId !== undefined &&
    typeof grant.grantApprovalId !== 'string'
  ) return false
  if (Object.hasOwn(grant, 'revocationReason') && grant.revocationReason !== undefined && ![
    'project_grant_removed',
    'project_grant_narrowed',
    'project_root_repoint',
  ].includes(String(grant.revocationReason))) return false
  if (Object.hasOwn(grant, 'consumed') && typeof grant.consumed !== 'boolean') return false
  if (Object.hasOwn(grant, 'grantMode') && grant.grantMode !== 'allow_once' && grant.grantMode !== 'always_allow') {
    return false
  }
  if (grant.phase !== 'revoked' && grant.revocationReason !== undefined) return false

  if (grant.phase === 'none' || grant.phase === 'proposed' || grant.phase === 'not_issued') {
    return grant.source === 'none' &&
      grant.status === 'not_issued' &&
      covered.capabilities.length === 0 &&
      !Object.hasOwn(grant, 'grantMode') &&
      !Object.hasOwn(grant, 'consumed')
  }
  if (grant.phase === 'denied') {
    return grant.source === 'package-local' &&
      grant.status === 'denied' &&
      covered.capabilities.length === 0 &&
      !Object.hasOwn(grant, 'grantMode') &&
      !Object.hasOwn(grant, 'consumed')
  }
  if (grant.phase === 'revoked') {
    return (grant.source === 'project-level' || grant.source === 'package-local') &&
      grant.status === 'not_issued' &&
      typeof grant.revocationReason === 'string' &&
      text(grant.revocationReason, 300).length > 0 &&
      !Object.hasOwn(grant, 'grantMode') &&
      !Object.hasOwn(grant, 'consumed')
  }
  if (grant.phase !== 'approved' || grant.status !== 'approved') return false
  if (grant.source === 'project-level') {
    return grant.grantMode === 'always_allow' &&
      (!Object.hasOwn(grant, 'consumed') || grant.consumed === false)
  }
  if (grant.source !== 'package-local') return false
  if (grant.grantMode !== 'allow_once' && grant.grantMode !== 'always_allow') return false
  return grant.grantMode === 'allow_once' || !Object.hasOwn(grant, 'consumed') || grant.consumed === false
}

type McpRequirementAdmissionInput = {
  mcpId: string
  agent: string
  requirement: 'required' | 'optional'
  requestedCapabilities: string[]
  packageProhibitedKeys: ReadonlySet<string>
  status: ProjectMcpStatus | null
  hasPromptOnlyContext: boolean
  effectiveGrant: EffectiveGrantState
  fallback: { action: McpFallbackAction }
  evidenceRefs?: string[]
}

function admitMcpRequirementUnchecked(input: McpRequirementAdmissionInput): McpAdmissionDecision {
  const mcpIdentity = projectedIdentity(input.mcpId, 80)
  const agentIdentity = projectedIdentity(input.agent, 80)
  const mcpId = mcpIdentity.value
  const agent = agentIdentity.value
  const requirement = input.requirement === 'optional' || input.requirement === 'required'
    ? input.requirement
    : 'required'
  const malformedMcpId = !mcpIdentity.valid || !validMcpIdText(input.mcpId)
  const malformedAgent = !agentIdentity.valid || agentIdentity.value === 'unknown'
  const malformedRequirement = input.requirement !== 'required' && input.requirement !== 'optional'
  const malformedPromptContext = typeof input.hasPromptOnlyContext !== 'boolean'
  const hasPromptOnlyContext = input.hasPromptOnlyContext === true
  const observedStatus = validatedProjectMcpStatus(mcpId, input.status)
  const requestedCapabilities = Array.isArray(input.requestedCapabilities) &&
    input.requestedCapabilities.length <= MAX_ADMISSION_NESTED_ITEMS
    ? input.requestedCapabilities.filter(isSafeCapabilityText)
    : []
  const malformedRequestedCapabilities = !Array.isArray(input.requestedCapabilities) ||
    input.requestedCapabilities.length > MAX_ADMISSION_NESTED_ITEMS ||
    input.requestedCapabilities.some((capability) => !isSafeCapabilityText(capability))
  const evidenceRefs = input.evidenceRefs
  const malformedEvidenceRefs = evidenceRefs !== undefined &&
    (!Array.isArray(evidenceRefs) ||
      evidenceRefs.length > MAX_ADMISSION_NESTED_ITEMS ||
      evidenceRefs.some((ref) => typeof ref !== 'string'))
  const fallback = ownRecord(input.fallback)
  const fallbackAction = fallback?.action
  const malformedFallback = fallback === null ||
    (fallbackAction !== 'block' && fallbackAction !== 'continue_without_mcp' && fallbackAction !== 'ask_user')
  const prohibited = readProhibitedCapabilityKeys(input.packageProhibitedKeys)
  const grant = ownRecord(input.effectiveGrant)
  const grantCoveredCapabilities = grant?.coveredCapabilities
  const parsedGrantCoverage = boundedFilesystemCapabilities(grantCoveredCapabilities, { allowEmpty: true })
  const malformedGrant = grant === null || !coherentEffectiveGrantState(grant)
  const effectiveGrant: EffectiveGrantState = malformedGrant
    ? noGrant()
    : {
        phase: grant.phase as EffectiveGrantState['phase'],
        source: grant.source as EffectiveGrantState['source'],
        status: grant.status as EffectiveGrantState['status'],
        coveredCapabilities: [...parsedGrantCoverage.capabilities],
        ...(grant.grantMode === 'allow_once' || grant.grantMode === 'always_allow'
          ? { grantMode: grant.grantMode }
          : {}),
        ...(typeof grant.consumed === 'boolean' ? { consumed: grant.consumed } : {}),
        ...(typeof grant.grantApprovalId === 'string' ? { grantApprovalId: text(grant.grantApprovalId) } : {}),
        ...(grant.revocationReason === 'project_grant_removed' ||
          grant.revocationReason === 'project_grant_narrowed' ||
          grant.revocationReason === 'project_root_repoint'
          ? { revocationReason: grant.revocationReason }
          : {}),
        ...(typeof grant.grantDecisionRevision === 'string'
          ? { grantDecisionRevision: grant.grantDecisionRevision }
          : {}),
        ...(typeof grant.rootBindingRevision === 'string'
          ? { rootBindingRevision: grant.rootBindingRevision }
          : {}),
      }
  const normalizedCapabilities = requestedCapabilities.map((capability) =>
    canonicalCapabilityForMcp(mcpId, capability),
  )
  const capabilityClasses = normalizedCapabilities.map((capability) => ({
    capability,
    class: classifyCapability(mcpId, capability),
    deliveryKind: mcpDeliveryKind(mcpId),
  }))
  const base = {
    schemaVersion: 1 as const,
    mcpId,
    agent,
    requirement,
    requestedCapabilities: [...requestedCapabilities],
    normalizedCapabilities,
    capabilityClasses,
    evidenceRefs: (Array.isArray(evidenceRefs) && evidenceRefs.length <= MAX_ADMISSION_NESTED_ITEMS ? evidenceRefs : [])
      .filter((ref): ref is string => typeof ref === 'string')
      .map((ref) => text(ref, 300))
      .filter(Boolean),
  }
  const result = (
    mode: McpAdmissionMode,
    status: McpAdmissionStatus,
    reason: string,
    recoveryAction?: McpRecoveryAction,
    grantState?: McpAdmissionDecision['grantState'],
  ): McpAdmissionDecision => ({
    ...base,
    mode,
    status,
    reason: decisionReason(reason),
    ...(recoveryAction ? { recoveryAction } : {}),
    ...(grantState ? { grantState } : {}),
  })
  const canProceed = canProceedWithoutMcp(requirement, {
    action: malformedFallback ? 'block' : fallbackAction,
  })

  const malformedDirectInputs = [
    ...(malformedMcpId ? ['MCP id'] : []),
    ...(malformedAgent ? ['agent'] : []),
    ...(malformedRequirement ? ['requirement'] : []),
    ...(malformedRequestedCapabilities ? ['requested capabilities'] : []),
    ...(malformedEvidenceRefs ? ['evidence references'] : []),
    ...(malformedFallback ? ['fallback'] : []),
    ...(malformedPromptContext ? ['prompt context evidence'] : []),
    ...(prohibited.malformed ? ['prohibition set'] : []),
    ...(malformedGrant ? ['grant coverage/state'] : []),
  ]
  if (malformedDirectInputs.length > 0) {
    return result(
      'blocked',
      'blocked',
      `Malformed MCP admission input: ${malformedDirectInputs.join(', ')}.`,
      'revise_plan',
    )
  }
  if (!isKnownMcpId(mcpId)) {
    return result(
      'blocked',
      'blocked',
      `Unknown MCP '${mcpId}' for capabilities: ${capabilityReasonList(normalizedCapabilities)}.`,
      'revise_plan',
    )
  }
  const unknownCapabilities = capabilityClasses
    .filter((item) => item.class === 'unknown')
    .map((item) => item.capability)
  if (unknownCapabilities.length > 0) {
    return result(
      'blocked',
      'blocked',
      `MCP '${mcpId}' includes unknown capabilities: ${capabilityReasonList(unknownCapabilities)}.`,
      'revise_plan',
    )
  }
  const prohibitedCapabilities = normalizedCapabilities.filter((capability) =>
    coverageKeysForProhibition(capability).some((key) => prohibited.keys.has(key)),
  )
  if (prohibitedCapabilities.length > 0) {
    return result(
      'blocked',
      'blocked',
      `MCP '${mcpId}' includes package-prohibited capabilities: ${capabilityReasonList(prohibitedCapabilities)}.`,
      'revise_plan',
    )
  }
  const deferredCapabilities = capabilityClasses
    .filter((item) => item.class === 'deferred_live_mcp')
    .map((item) => item.capability)
  if (deferredCapabilities.length > 0) {
    return canProceed
      ? result(
          'deferred_live_mcp',
          'warning',
          `Live MCP delivery is deferred for: ${capabilityReasonList(deferredCapabilities)}.`,
          'defer_live_mcp_feature',
        )
      : result(
          'deferred_live_mcp',
          'blocked',
          `This requirement depends on deferred live MCP capabilities: ${capabilityReasonList(deferredCapabilities)}.`,
          'revise_plan',
        )
  }

  const boundedPacketCapabilities = capabilityClasses
    .filter((item) => item.class === 'bounded_read_only' && item.deliveryKind === 'bounded_context_packet')
    .map((item) => item.capability)
  if (boundedPacketCapabilities.length > 0) {
    const covered = effectiveGrant.phase === 'approved' &&
      !effectiveGrant.consumed &&
      covers(effectiveGrant.coveredCapabilities, boundedPacketCapabilities)
    if (!covered) {
      const missingCapabilities = boundedPacketCapabilities.filter((capability) =>
        !covers(effectiveGrant.coveredCapabilities, [capability]),
      )
      return result(
        'bounded_context_required',
        canProceed ? 'warning' : 'blocked',
        effectiveGrant.phase === 'revoked'
          ? `${effectiveGrant.revocationReason ?? 'The project filesystem context grant was removed.'} Required capabilities: ${capabilityReasonList(missingCapabilities)}.`
          : effectiveGrant.phase === 'denied'
            ? `Filesystem context was denied for: ${capabilityReasonList(missingCapabilities)}. Approve it before this requirement can run.`
            : `Filesystem context approval is required for: ${capabilityReasonList(missingCapabilities)}.`,
        'approve_project_filesystem_context',
        grantStateForDecision(effectiveGrant),
      )
    }
    if (!isMcpHealthy(mcpId, observedStatus)) {
      return result(
        'bounded_context_approved',
        canProceed ? 'warning' : 'blocked',
        `${mcpHealthReason(mcpId, observedStatus)} Required capabilities: ${capabilityReasonList(boundedPacketCapabilities)}.`,
        'install_or_fix_mcp',
        grantStateForDecision(effectiveGrant),
      )
    }
    return result(
      'bounded_context_approved',
      'allowed',
      'Approved bounded read-only context is available.',
      undefined,
      grantStateForDecision(effectiveGrant),
    )
  }

  const planningContextReads = capabilityClasses.some(
    (item) => item.class === 'bounded_read_only' && item.deliveryKind === 'planning_context_only',
  )
  if (planningContextReads) {
    if (hasPromptOnlyContext) {
      return result(
        'planning_only',
        'allowed',
        `MCP reads are available as planning context for: ${capabilityReasonList(normalizedCapabilities)}.`,
        'continue_as_prompt_context',
      )
    }
    return canProceed
      ? result(
          'planning_only',
          'warning',
          `Planning context was not materialized for: ${capabilityReasonList(normalizedCapabilities)}. This optional requirement may continue without it.`,
          'continue_as_prompt_context',
        )
      : result(
          'blocked',
          'blocked',
          `Required MCP planning context was not materialized for: ${capabilityReasonList(normalizedCapabilities)}.`,
          'revise_plan',
        )
  }

  if (normalizedCapabilities.length === 0 && !hasPromptOnlyContext && !canProceed) {
    return result('blocked', 'blocked', 'The MCP requirement has no capabilities or materialized planning context.', 'revise_plan')
  }
  return result(
    'planning_only',
    'warning',
    `This requirement is planning-only for: ${capabilityReasonList(normalizedCapabilities)}. It grants no live MCP capability.`,
    'continue_as_prompt_context',
  )
}

function unsafeRequirementInspectionBlock(): McpAdmissionDecision {
  return {
    schemaVersion: 1,
    mcpId: 'invalid',
    agent: 'unknown',
    requirement: 'required',
    requestedCapabilities: [],
    normalizedCapabilities: [],
    capabilityClasses: [],
    mode: 'blocked',
    status: 'blocked',
    reason: 'MCP admission input could not be safely inspected.',
    recoveryAction: 'revise_plan',
    evidenceRefs: [],
  }
}

export function admitMcpRequirement(input: McpRequirementAdmissionInput): McpAdmissionDecision {
  try {
    const packageProhibitedKeys = input.packageProhibitedKeys
    return admitMcpRequirementUnchecked({
      mcpId: structuredClone(input.mcpId),
      agent: structuredClone(input.agent),
      requirement: structuredClone(input.requirement),
      requestedCapabilities: structuredClone(input.requestedCapabilities),
      packageProhibitedKeys: packageProhibitedKeys instanceof Set
        ? structuredClone(packageProhibitedKeys)
        : [] as unknown as ReadonlySet<string>,
      status: structuredClone(input.status),
      hasPromptOnlyContext: structuredClone(input.hasPromptOnlyContext),
      effectiveGrant: structuredClone(input.effectiveGrant),
      fallback: structuredClone(input.fallback),
      ...(input.evidenceRefs === undefined ? {} : { evidenceRefs: structuredClone(input.evidenceRefs) }),
    })
  } catch {
    return unsafeRequirementInspectionBlock()
  }
}

type JoinedEntry = {
  raw: Record<string, unknown> | null
  grant: Record<string, unknown> | null
  requirementKey: string
  rawIndex: number
  compatibilityWarning?: string
  joinError?: string
}

function requirementLevel(entry: Record<string, unknown>): 'required' | 'optional' {
  return Object.hasOwn(entry, 'requirement') && entry.requirement === 'optional' ? 'optional' : 'required'
}

function fallbackOf(entry: Record<string, unknown>): { action: McpFallbackAction; message: string } {
  const fallback = Object.hasOwn(entry, 'fallback') ? ownRecord(entry.fallback) ?? {} : {}
  const action = fallback.action === 'continue_without_mcp' || fallback.action === 'ask_user'
    ? fallback.action
    : 'block'
  return { action, message: text(fallback.message, 500) }
}

function policyShapeValidationErrors(entry: Record<string, unknown>): string[] {
  const errors: string[] = []
  const keyed = explicitRequirementKey(entry).present
  if (!validMcpIdText(entry.mcpId)) {
    errors.push('MCP policy mcpId must be an exact bounded identifier.')
  } else if (!isKnownMcpId(entry.mcpId as string)) {
    errors.push('MCP policy mcpId must identify a known MCP.')
  }
  if (entry.requirement !== 'required' && entry.requirement !== 'optional') {
    errors.push("MCP policy requirement must be 'required' or 'optional'.")
  }
  const agentError = entryAgentValidationError(entry, { allowLegacyFallback: !keyed })
  if (agentError) errors.push(agentError)
  const assignmentError = assignmentValidationError(entry, { required: keyed })
  if (assignmentError) errors.push(assignmentError)
  if (keyed && !sourceRequirementIndex(entry).present) {
    errors.push('A keyed MCP policy must persist sourceRequirementIndex.')
  }
  const fallback = Object.hasOwn(entry, 'fallback') ? ownRecord(entry.fallback) : null
  if (
    !fallback ||
    (fallback.action !== 'block' && fallback.action !== 'continue_without_mcp' && fallback.action !== 'ask_user')
  ) {
    errors.push('MCP policy fallback must contain one exact supported action.')
  }
  return errors
}

function promptEvidenceValidationError(entry: Record<string, unknown> | null): string | null {
  if (!entry) return null
  if (!Object.hasOwn(entry, 'promptOverlayPresent')) {
    return explicitRequirementKey(entry).present
      ? 'A keyed derived MCP envelope must persist boolean promptOverlayPresent evidence.'
      : null
  }
  return typeof entry.promptOverlayPresent === 'boolean'
    ? null
    : 'Derived promptOverlayPresent evidence must be boolean when present.'
}

function entryAgent(entry: Record<string, unknown>): string {
  return (Object.hasOwn(entry, 'agent') ? text(entry.agent, 80) : '') ||
    (Object.hasOwn(entry, 'assignedRole') ? text(entry.assignedRole, 80) : '') ||
    legacyAssignmentAgent(entry) ||
    'unknown'
}

function legacyAssignmentAgent(entry: Record<string, unknown>): string | null {
  const assignment = ownRecord(entry.assignment)
  if (!assignment || !Array.isArray(assignment.targetAgents) || assignment.targetAgents.length !== 1) return null
  const projected = projectedIdentity(assignment.targetAgents[0], 80)
  return projected.valid && projected.value !== 'unknown' ? projected.value : null
}

function entryAgentValidationError(
  entry: Record<string, unknown>,
  options: { allowLegacyFallback: boolean },
): string | null {
  const hasAgent = Object.hasOwn(entry, 'agent')
  const hasAssignedRole = Object.hasOwn(entry, 'assignedRole')
  if (!hasAgent && !options.allowLegacyFallback) {
    return 'MCP policy must persist an explicit agent identity.'
  }
  if (!hasAgent && !hasAssignedRole) {
    return legacyAssignmentAgent(entry) ? null : 'MCP policy agent identity is required.'
  }

  const agent = hasAgent ? projectedIdentity(entry.agent, 80) : null
  const assignedRole = hasAssignedRole ? projectedIdentity(entry.assignedRole, 80) : null
  if (agent && (!agent.valid || agent.value === 'unknown')) {
    return 'MCP policy agent identity must be an exact safe value.'
  }
  if (assignedRole && (!assignedRole.valid || assignedRole.value === 'unknown')) {
    return 'MCP policy assignedRole identity must be an exact safe value.'
  }
  if (agent && assignedRole && agent.value !== assignedRole.value) {
    return 'MCP policy agent and assignedRole identities must agree.'
  }
  return null
}

function namedAgent(entry: Record<string, unknown>): string | null {
  const agent = entryAgent(entry)
  return agent === 'unknown' ? null : agent
}

function legacyFingerprint(entry: Record<string, unknown>): string {
  return JSON.stringify([
    text(entry.mcpId, 80),
    requirementLevel(entry),
    [...mergeCapabilityFields(entry)].sort(),
    fallbackOf(entry).action,
  ])
}

function sameEnvelopeIdentity(raw: Record<string, unknown>, grant: Record<string, unknown>): boolean {
  if (text(raw.mcpId, 80) !== text(grant.mcpId, 80)) return false
  if (entryAgent(raw) !== entryAgent(grant)) return false
  const rawIndex = sourceRequirementIndex(raw)
  const grantIndex = sourceRequirementIndex(grant)
  return rawIndex.valid && grantIndex.valid && rawIndex.value === grantIndex.value
}

type ExplicitRequirementKey =
  | { present: false; valid: false; value: '' }
  | { present: true; valid: false; value: '' }
  | { present: true; valid: true; value: string }

function explicitRequirementKey(entry: Record<string, unknown>): ExplicitRequirementKey {
  if (!Object.hasOwn(entry, 'requirementKey')) return { present: false, valid: false, value: '' }
  const value = entry.requirementKey
  if (
    typeof value !== 'string' ||
    !isSafeCapabilityText(value) ||
    value.length === 0 ||
    value.length > 160 ||
    value.trim() !== value ||
    /\s|[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    return { present: true, valid: false, value: '' }
  }
  return { present: true, valid: true, value }
}

function validDecisionId(entry: Record<string, unknown>): boolean {
  return Object.hasOwn(entry, 'decisionId') &&
    typeof entry.decisionId === 'string' &&
    isSafeCapabilityText(entry.decisionId) &&
    entry.decisionId.length > 0 &&
    entry.decisionId.length <= 160 &&
    entry.decisionId.trim() === entry.decisionId &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(entry.decisionId)
}

type SourceRequirementIndexState =
  | { present: false; valid: false; value: null }
  | { present: true; valid: false; value: null }
  | { present: true; valid: true; value: number }

function sourceRequirementIndex(entry: Record<string, unknown>): SourceRequirementIndexState {
  if (!Object.hasOwn(entry, 'sourceRequirementIndex')) return { present: false, valid: false, value: null }
  const value = entry.sourceRequirementIndex
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { present: true, valid: true, value }
    : { present: true, valid: false, value: null }
}

function sourceIndexForEvaluation(
  envelope: Record<string, unknown>,
  policy: Record<string, unknown> | null,
  rawIndex: number,
): number {
  const envelopeIndex = sourceRequirementIndex(envelope)
  if (envelopeIndex.valid) return envelopeIndex.value
  const policyIndex = policy ? sourceRequirementIndex(policy) : null
  if (policyIndex?.valid) return policyIndex.value
  return Number.isSafeInteger(rawIndex) && rawIndex >= 0 ? rawIndex : 0
}

function sourceIndexError(entry: Record<string, unknown>, label: string): string | null {
  const state = sourceRequirementIndex(entry)
  return state.present && !state.valid
    ? `${label} sourceRequirementIndex must be a nonnegative safe integer.`
    : null
}

function hasMatchingSourceIndex(entry: Record<string, unknown>, expected: number): boolean {
  const state = sourceRequirementIndex(entry)
  return state.valid && state.value === expected
}

function hasValidOrAbsentSourceIndex(entry: Record<string, unknown>): boolean {
  const state = sourceRequirementIndex(entry)
  return !state.present || state.valid
}

function agentsCompatibleForLegacyFingerprint(raw: Record<string, unknown>, grant: Record<string, unknown>): boolean {
  const rawAgent = namedAgent(raw)
  const grantAgent = namedAgent(grant)
  return rawAgent === null || grantAgent === null || rawAgent === grantAgent
}

function joinEntries(entries: Array<Record<string, unknown>>): JoinedEntry[] {
  const indexed = entries.map((entry, index) => ({ entry, index, key: explicitRequirementKey(entry) }))
  const raws = indexed.filter(({ entry }) => !Object.hasOwn(entry, 'decisionId'))
  const grants = indexed.filter(({ entry }) => Object.hasOwn(entry, 'decisionId'))
  const usedRaws = new Set<number>()
  const usedGrants = new Set<Record<string, unknown>>()
  const joined: JoinedEntry[] = []

  const explicitRawKeys = [...new Set(raws.filter(({ key }) => key.valid).map(({ key }) => key.value))].sort()
  for (const requirementKey of explicitRawKeys) {
    const rawGroup = raws.filter(({ key }) => key.valid && key.value === requirementKey)
    const grantGroup = grants.filter(({ key }) => key.valid && key.value === requirementKey)
    rawGroup.forEach(({ index }) => usedRaws.add(index))
    grantGroup.forEach(({ entry }) => usedGrants.add(entry))
    const rawCollision = rawGroup.length !== 1
    const raw = rawCollision ? { requirementKey } : rawGroup[0].entry
    const uniqueGrant = grantGroup.length === 1 ? grantGroup[0].entry : null
    const collision = rawCollision || grantGroup.length > 1
    const mismatch = uniqueGrant !== null && !sameEnvelopeIdentity(raw, uniqueGrant)
    const rawSourceError = rawCollision ? null : sourceIndexError(raw, 'Raw policy')
    const grantSourceError = uniqueGrant ? sourceIndexError(uniqueGrant, 'Derived envelope') : null
    const invalidDecisionId = uniqueGrant !== null && !validDecisionId(uniqueGrant)
    const joinErrors = [
      ...(collision ? [`MCP requirement key '${requirementKey}' has duplicate policy/envelope representations.`] : []),
      ...(invalidDecisionId ? ['The derived MCP envelope decisionId must be a non-empty, bounded, unpadded string.'] : []),
      ...(rawSourceError ? [rawSourceError] : []),
      ...(grantSourceError ? [grantSourceError] : []),
      ...(mismatch && !rawSourceError && !grantSourceError
        ? [`MCP requirement key '${requirementKey}' has mismatched policy/envelope identity.`]
        : []),
    ]
    joined.push({
      raw,
      grant: joinErrors.length > 0 ? null : uniqueGrant,
      requirementKey,
      rawIndex: rawCollision ? 0 : rawGroup[0].index,
      ...(joinErrors.length > 0 ? { joinError: joinErrors.join(' ') } : {}),
    })
  }

  for (const { entry: raw, index, key } of raws) {
    if (usedRaws.has(index)) continue
    usedRaws.add(index)
    if (key.present && !key.valid) {
      joined.push({
        raw,
        grant: null,
        requirementKey: `invalid-requirement-key-${index}`,
        rawIndex: index,
        joinError: 'MCP requirementKey must be a non-empty, bounded, whitespace-free string.',
      })
      continue
    }

    const rawSourceError = sourceIndexError(raw, 'Legacy raw policy')
    if (rawSourceError) {
      joined.push({
        raw,
        grant: null,
        requirementKey: `legacy-${index}-${text(raw.mcpId, 40) || 'unknown'}-${entryAgent(raw)}`,
        rawIndex: index,
        joinError: rawSourceError,
      })
      continue
    }

    let grant: Record<string, unknown> | null = null
    const rawSource = sourceRequirementIndex(raw)
    if (rawSource.valid) {
      grant = grants.find(({ entry: candidate, key: candidateKey }) =>
        !usedGrants.has(candidate) &&
        !candidateKey.present &&
        validDecisionId(candidate) &&
        hasMatchingSourceIndex(candidate, rawSource.value) &&
        entryAgent(candidate) === entryAgent(raw) &&
        candidate.mcpId === raw.mcpId,
      )?.entry ?? null
    }
    if (!grant) {
      const fingerprint = legacyFingerprint(raw)
      grant = grants.find(({ entry: candidate, key: candidateKey }) =>
        !usedGrants.has(candidate) &&
        !candidateKey.present &&
        validDecisionId(candidate) &&
        hasValidOrAbsentSourceIndex(candidate) &&
        (!rawSource.present || !sourceRequirementIndex(candidate).present) &&
        agentsCompatibleForLegacyFingerprint(raw, candidate) &&
        legacyFingerprint(candidate) === fingerprint,
      )?.entry ?? null
    }
    if (grant) usedGrants.add(grant)
    joined.push({
      raw,
      grant,
      requirementKey: `legacy-${index}-${text(raw.mcpId, 40) || 'unknown'}-${entryAgent(raw)}`,
      rawIndex: index,
    })
  }

  const remainingExplicitGrantKeys = [...new Set(grants
    .filter(({ entry, key }) => !usedGrants.has(entry) && key.valid)
    .map(({ key }) => key.value))].sort()
  for (const requirementKey of remainingExplicitGrantKeys) {
    const grantGroup = grants.filter(({ entry, key }) =>
      !usedGrants.has(entry) && key.valid && key.value === requirementKey,
    )
    grantGroup.forEach(({ entry }) => usedGrants.add(entry))
    const grant = grantGroup.length > 1
      ? { requirementKey, decisionId: 'invalid-duplicate-derived-envelope' }
      : grantGroup[0].entry
    const grantErrors = [
      ...(grantGroup.length > 1 ? [`MCP requirement key '${requirementKey}' has duplicate derived grant envelopes.`] : []),
      ...(!validDecisionId(grant) ? ['A present decisionId field must contain a non-empty bounded string.'] : []),
      ...(sourceIndexError(grant, 'Derived envelope') ? [sourceIndexError(grant, 'Derived envelope') as string] : []),
    ]
    joined.push({
      raw: null,
      grant,
      requirementKey,
      rawIndex: -1,
      compatibilityWarning: 'A derived MCP grant had no authoritative requirement policy and must be recomputed.',
      ...(grantErrors.length > 0 ? { joinError: grantErrors.join(' ') } : {}),
    })
  }

  for (const { entry: grant, index, key } of grants) {
    if (usedGrants.has(grant)) continue
    usedGrants.add(grant)
    joined.push({
      raw: null,
      grant,
      requirementKey: `legacy-grant-only-${index}`,
      rawIndex: -1,
      compatibilityWarning: 'A derived MCP grant had no authoritative requirement policy and must be recomputed.',
      ...(!validDecisionId(grant)
        ? { joinError: 'A present decisionId field must contain a non-empty bounded string.' }
        : sourceIndexError(grant, 'Derived envelope')
          ? { joinError: sourceIndexError(grant, 'Derived envelope') as string }
        : key.present && !key.valid
          ? { joinError: 'MCP requirementKey must be a non-empty, bounded, whitespace-free string.' }
          : {}),
    })
  }
  return joined
}

function snapshot(mcpId: string, status: ProjectMcpStatus | null): McpHealthSnapshot {
  const observed = validatedProjectMcpStatus(mcpId, status)
  if (!observed) {
    return {
      schemaVersion: 1,
      observed: false,
      mcpId,
      installState: 'unknown',
      status: 'unknown',
      enabled: false,
      error: null,
      checkedAt: null,
    }
  }
  return {
    schemaVersion: 1,
    observed: true,
    mcpId,
    installState: observed.installState,
    status: observed.status,
    enabled: observed.enabled,
    error: observed.error === null ? null : sanitizeMcpError(observed.error, 240) || null,
    checkedAt: observed.checkedAt,
  }
}

const MCP_ASSIGNMENT_TYPES = new Set<McpAssignmentType>([
  'agent',
  'multiple_agents',
  'workforce',
  'architect_only',
  'reviewer_only',
])

function assignmentValidationError(
  entry: Record<string, unknown>,
  options: { required?: boolean } = {},
): string | null {
  if (!Object.hasOwn(entry, 'assignment')) {
    return options.required ? 'A keyed MCP record must persist assignment evidence.' : null
  }
  const assignment = ownRecord(entry.assignment)
  if (!assignment) return 'MCP source assignment must be a record when present.'
  if (!MCP_ASSIGNMENT_TYPES.has(assignment.type as McpAssignmentType)) {
    return 'MCP source assignment type is unsupported.'
  }
  if (!Object.hasOwn(assignment, 'targetId') || (assignment.targetId !== null && typeof assignment.targetId !== 'string')) {
    return 'MCP source assignment targetId must be a string or null.'
  }
  if (typeof assignment.targetId === 'string') {
    const target = projectedIdentity(assignment.targetId, 160)
    if (!target.valid) return 'MCP source assignment targetId must be an exact safe value.'
  }
  return null
}

function assignmentOf(entry: Record<string, unknown>): { type: McpAssignmentType; targetId: string | null } {
  const assignment = Object.hasOwn(entry, 'assignment') ? ownRecord(entry.assignment) ?? {} : {}
  const type = typeof assignment.type === 'string' && MCP_ASSIGNMENT_TYPES.has(assignment.type as McpAssignmentType)
    ? assignment.type as McpAssignmentType
    : 'agent'
  return { type, targetId: typeof assignment.targetId === 'string' ? text(assignment.targetId, 160) || null : null }
}

function planningCoverageKey(requirementKey: string, agent: string, capability: string): string {
  return `${requirementKey}\u0000${agent}\u0000${canonicalCapabilityForMcp('github', capability)}`
}

function boundedCoverageKey(requirementKey: string, agent: string, capability: string): string {
  return `${requirementKey}\u0000${agent}\u0000${canonicalCapabilityForMcp('filesystem', capability)}`
}

function intersects(left: readonly string[], right: ReadonlySet<string>): boolean {
  return left.some((item) => right.has(item))
}

function structuralAdmissionBlock(label: unknown, reasonText: string): McpWorkPackageAdmission {
  const reason = decisionReason(reasonText)
  const health = snapshot('invalid', null)
  return {
    schemaVersion: 2,
    evaluations: [{
      decision: {
        schemaVersion: 1,
        mcpId: 'invalid',
        agent: 'unknown',
        requirement: 'required',
        requestedCapabilities: [],
        normalizedCapabilities: [],
        capabilityClasses: [],
        mode: 'blocked',
        status: 'blocked',
        reason,
        recoveryAction: 'revise_plan',
        evidenceRefs: [],
      },
      source: {
        requirementKey: 'invalid-admission-shape',
        decisionId: 'req-invalid-admission-shape',
        sourceRequirementIndex: 0,
        assignment: { type: 'agent', targetId: null },
        fallback: { action: 'block', message: '' },
        promptOverlayPresent: false,
      },
      health,
    }],
    subtaskDecisions: [],
    referencedHealth: [{
      mcpId: 'invalid',
      installState: 'unknown',
      status: 'unknown',
      enabled: false,
      error: null,
    }],
    aggregate: {
      status: 'blocked',
      blocked: [reason],
      warnings: [],
      blockedReason: `MCP/capability broker blocked "${text(label, 160) || 'work package'}": ${reason}`,
      retryable: false,
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
    },
  }
}

function malformedSubtasksContainerBlock(label: unknown): McpWorkPackageAdmission {
  const reason = decisionReason('Malformed subtask MCP declaration: subtasks must be an array of subtask records.')
  const decision: McpWorkPackageAdmission['subtaskDecisions'][number] = {
    subtaskId: 'invalid-subtasks-container',
    agent: 'unknown',
    requirementKey: '',
    mcpId: '',
    capability: 'invalid.subtask.mcp-declaration',
    class: 'unknown',
    deliveryKind: null,
    status: 'blocked',
    reason,
    recoveryAction: 'revise_plan',
  }
  return {
    schemaVersion: 2,
    evaluations: [],
    subtaskDecisions: [decision],
    referencedHealth: [],
    aggregate: {
      status: 'blocked',
      blocked: [reason],
      warnings: [],
      blockedReason: `MCP/capability broker blocked "${text(label, 160) || 'work package'}": ${reason}`,
      retryable: false,
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
      primaryDecision: {
        kind: 'subtask',
        mode: 'blocked',
        recoveryAction: 'revise_plan',
        retryableContribution: false,
        reason,
        evidenceRefs: [],
        requirementKey: '',
        agent: 'unknown',
        mcpId: '',
        subtaskId: decision.subtaskId,
        capability: decision.capability,
      },
    },
  }
}

function admissionBoundError(
  entries: unknown,
  subtasks: unknown,
): string | null {
  if (!Array.isArray(entries)) return 'MCP requirement entries must be an array of policy records.'
  if (!Array.isArray(subtasks)) return 'MCP-aware subtasks must be an array of subtask records.'
  if (entries.length > MAX_ADMISSION_ENTRIES) {
    return `MCP requirement entries exceed the maximum raw count of ${MAX_ADMISSION_ENTRIES}.`
  }
  if (subtasks.length > MAX_ADMISSION_SUBTASKS) {
    return `MCP-aware subtasks exceed the maximum raw count of ${MAX_ADMISSION_SUBTASKS}.`
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!isRecord(entry)) continue
    for (const field of [...REQUIREMENT_CAPABILITY_FIELDS, 'prohibitedCapabilities', 'evidenceRefs', 'capabilityClasses']) {
      const value = entry[field]
      if (Array.isArray(value) && value.length > MAX_ADMISSION_NESTED_ITEMS) {
        return `MCP requirement entry ${index} field '${field}' exceeds the maximum raw count of ${MAX_ADMISSION_NESTED_ITEMS}.`
      }
    }
  }

  for (let index = 0; index < subtasks.length; index += 1) {
    const subtask = subtasks[index]
    if (!isRecord(subtask)) continue
    for (const field of ['mcpCapabilities', 'capabilityBindings']) {
      const value = subtask[field]
      if (Array.isArray(value) && value.length > MAX_ADMISSION_NESTED_ITEMS) {
        return `MCP-aware subtask ${index} field '${field}' exceeds the maximum raw count of ${MAX_ADMISSION_NESTED_ITEMS}.`
      }
    }
  }
  return null
}

type WorkPackageMcpAdmissionInput = {
  entries: Array<Record<string, unknown>>
  subtasks: Array<Record<string, unknown>>
  label: string
  statusFor: (mcpId: string) => ProjectMcpStatus | null
  effectiveGrantFor: (entry: { requirementKey: string; mcpId: string; requiredCapabilities: string[] }) => EffectiveGrantState
  hasPromptOnlyContextFor: (entry: { requirementKey: string; agent: string; mcpId: string }) => boolean
}

function admitWorkPackageMcpUnchecked(input: WorkPackageMcpAdmissionInput): McpWorkPackageAdmission {
  if (!Array.isArray(input.subtasks)) return malformedSubtasksContainerBlock(input.label)
  const boundError = admissionBoundError(input.entries, input.subtasks)
  if (boundError) return structuralAdmissionBlock(input.label, boundError)
  const entries = input.entries.map((entry) => ownRecord(entry) ?? {})
  const joined = joinEntries(entries)
  const packageProhibitedKeys = new Set<string>()
  const invalidProhibitions = new Map<string, string[]>()

  for (const item of joined) {
    if (!item.raw) continue
    const mcpId = text(item.raw.mcpId, 80)
    for (const prohibited of strings(item.raw.prohibitedCapabilities)) {
      if (classifyCapability(mcpId, prohibited) === 'unknown') {
        const messages = invalidProhibitions.get(item.requirementKey) ?? []
        messages.push(`MCP '${mcpId}' prohibition '${prohibited}' is malformed, unknown, or cross-MCP.`)
        invalidProhibitions.set(item.requirementKey, messages)
      } else {
        for (const key of coverageKeysForProhibition(prohibited)) packageProhibitedKeys.add(key)
      }
    }
  }

  const evaluations: McpAdmissionEvaluation[] = []
  const boundedCoverageKeys = new Set<string>()
  const planningContextCoverageKeys = new Set<string>()
  const compatibilityWarnings: string[] = []

  for (const item of joined) {
    const envelope = item.grant ?? item.raw ?? {}
    const policy = item.raw
    const mcpId = projectedIdentity((policy ?? envelope).mcpId, 80).value
    const agent = entryAgent(policy ?? envelope)
    const fallback = fallbackOf(policy ?? envelope)
    const requestedCapabilities = policy ? mergeCapabilityFields(policy) : []
    const persistedPromptOnlyContext = item.grant?.promptOverlayPresent === true
    const promptEvidenceError = promptEvidenceValidationError(item.grant)
    const envelopeAgentError = item.grant && explicitRequirementKey(item.grant).present
      ? entryAgentValidationError(item.grant, { allowLegacyFallback: false })
      : null
    const envelopeAssignmentError = item.grant
      ? assignmentValidationError(item.grant, { required: explicitRequirementKey(item.grant).present })
      : null
    const invalid = invalidProhibitions.get(item.requirementKey)
    const preflightErrors = policy
      ? [
          ...(item.joinError ? [item.joinError] : []),
          ...capabilityFieldValidationErrors(policy),
          ...policyShapeValidationErrors(policy),
          ...(promptEvidenceError ? [promptEvidenceError] : []),
          ...(envelopeAgentError ? [envelopeAgentError] : []),
          ...(envelopeAssignmentError ? [envelopeAssignmentError] : []),
          ...(invalid ?? []),
        ]
      : []
    const consultCallbacks = policy !== null && preflightErrors.length === 0
    const callbackErrors: string[] = []
    let status: ProjectMcpStatus | null = null
    if (consultCallbacks) {
      try {
        status = validatedProjectMcpStatus(mcpId, input.statusFor(mcpId))
      } catch {
        callbackErrors.push('MCP status resolution failed closed; recompute the work-package plan.')
      }
    }
    const health = snapshot(mcpId, status)
    let callbackPromptOnlyContextValue: unknown = false
    if (consultCallbacks && callbackErrors.length === 0) {
      try {
        callbackPromptOnlyContextValue = input.hasPromptOnlyContextFor({ requirementKey: item.requirementKey, agent, mcpId })
      } catch {
        callbackErrors.push('Prompt-context evidence resolution failed closed; recompute the work-package plan.')
      }
    }
    const callbackPromptOnlyContext = callbackPromptOnlyContextValue === true
    const callbackPromptEvidenceError = typeof callbackPromptOnlyContextValue === 'boolean'
      ? null
      : 'Prompt-context materialization callback must return boolean evidence.'
    const hasPromptOnlyContext = persistedPromptOnlyContext || callbackPromptOnlyContext
    const requiredCapabilities = requestedCapabilities.filter((capability) =>
      classifyCapability(mcpId, capability) === 'bounded_read_only' && mcpDeliveryKind(mcpId) === 'bounded_context_packet',
    )
    let effectiveGrant = noGrant()
    if (consultCallbacks && callbackErrors.length === 0) {
      try {
        effectiveGrant = input.effectiveGrantFor({ requirementKey: item.requirementKey, mcpId, requiredCapabilities })
      } catch {
        callbackErrors.push('Effective grant resolution failed closed; recompute the work-package plan.')
      }
    }
    let decision: McpAdmissionDecision
    if (!policy) {
      decision = {
        schemaVersion: 1,
        mcpId,
        agent,
        requirement: requirementLevel(envelope),
        requestedCapabilities: [],
        normalizedCapabilities: [],
        capabilityClasses: [],
        mode: 'unknown_legacy',
        status: 'blocked',
        reason: decisionReason(item.joinError ?? 'This legacy grant has no authoritative requirement policy and must be recomputed.'),
        recoveryAction: 'revise_plan',
        evidenceRefs: [],
      }
    } else {
      decision = admitMcpRequirement({
        mcpId,
        agent,
        requirement: requirementLevel(policy),
        requestedCapabilities,
        packageProhibitedKeys,
        status,
        hasPromptOnlyContext,
        effectiveGrant,
        fallback,
        evidenceRefs: boundedTexts(policy.evidenceRefs),
      })
      const failClosedErrors = [
        ...preflightErrors,
        ...callbackErrors,
        ...(callbackPromptEvidenceError ? [callbackPromptEvidenceError] : []),
      ]
      if (failClosedErrors.length > 0) {
        decision = {
          ...decision,
          mode: 'blocked',
          status: 'blocked',
          reason: decisionReason(failClosedErrors.join(' ')),
          recoveryAction: 'revise_plan',
        }
      }
    }
    if (item.compatibilityWarning) compatibilityWarnings.push(item.compatibilityWarning)
    const evaluation: McpAdmissionEvaluation = {
      decision,
      source: {
        requirementKey: item.requirementKey,
        decisionId: text(envelope.decisionId, 160) || `req-${item.requirementKey}`,
        sourceRequirementIndex: sourceIndexForEvaluation(envelope, policy, item.rawIndex),
        assignment: ownRecord(envelope.assignment) ? assignmentOf(envelope) : assignmentOf(policy ?? envelope),
        fallback,
        promptOverlayPresent: hasPromptOnlyContext,
      },
      health,
    }
    evaluations.push(evaluation)

    if (decision.mode === 'bounded_context_approved' && decision.status === 'allowed') {
      for (const capability of decision.normalizedCapabilities) {
        if (!intersects(coverageKeysForGrant(capability), packageProhibitedKeys)) {
          boundedCoverageKeys.add(boundedCoverageKey(item.requirementKey, agent, capability))
        }
      }
    }
    if (decision.mode === 'planning_only' && decision.status === 'allowed' && hasPromptOnlyContext) {
      for (const itemClass of decision.capabilityClasses) {
        if (itemClass.class === 'bounded_read_only' && itemClass.deliveryKind === 'planning_context_only') {
          planningContextCoverageKeys.add(planningCoverageKey(item.requirementKey, agent, itemClass.capability))
        }
      }
    }
  }

  const subtaskDecisions: McpWorkPackageAdmission['subtaskDecisions'] = []
  const malformedSubtaskDecision = (
    subtaskId: string,
    agent: string,
    errors: string[],
  ): McpWorkPackageAdmission['subtaskDecisions'][number] => ({
    subtaskId,
    agent,
    requirementKey: '',
    mcpId: '',
    capability: 'invalid.subtask.mcp-declaration',
    class: 'unknown',
    deliveryKind: null,
    status: 'blocked',
    reason: decisionReason(`Malformed subtask MCP declaration: ${errors.join(' ')}`),
    recoveryAction: 'revise_plan',
  })
  const subtasks: Array<{ subtask: Record<string, unknown>; structuralErrors: string[] }> = []
  if (!Array.isArray(input.subtasks)) {
    subtaskDecisions.push(malformedSubtaskDecision(
      'invalid-subtasks-container',
      'unknown',
      ['subtasks must be an array of subtask records.'],
    ))
  } else {
    input.subtasks.forEach((value, index) => {
      const subtask = ownRecord(value)
      subtasks.push(subtask
        ? { subtask, structuralErrors: [] }
        : {
            subtask: { id: `invalid-subtask-${index}` },
            structuralErrors: [`subtasks item ${index} must be a record.`],
      })
    })
  }
  const seenSubtaskIds = new Set<string>()
  for (const { subtask, structuralErrors } of subtasks) {
    const subtaskIdentity = projectedIdentity(subtask.id, 160)
    const subtaskId = subtaskIdentity.value || 'unknown-subtask'
    const agent = entryAgent(subtask)
    const declarationErrors: string[] = [...structuralErrors]
    const invalidSubtaskId = !subtaskIdentity.valid || subtaskIdentity.value === 'unknown-subtask'
    let duplicateSubtaskId = false
    if (invalidSubtaskId) {
      declarationErrors.push('Subtask id must be an exact safe value.')
    } else if (seenSubtaskIds.has(subtaskId)) {
      duplicateSubtaskId = true
      declarationErrors.push(`Subtask id '${subtaskId}' is duplicated.`)
    } else {
      seenSubtaskIds.add(subtaskId)
    }
    const agentError = entryAgentValidationError(subtask, { allowLegacyFallback: false })
    if (agentError) declarationErrors.push(agentError.replace(/^MCP policy /, 'Subtask '))
    const declaredCapabilities: string[] = []
    const seenDeclaredCapabilities = new Set<string>()
    if (!Object.hasOwn(subtask, 'mcpCapabilities')) {
      declarationErrors.push('mcpCapabilities must be present as an array of safe non-empty strings.')
    } else {
      if (!Array.isArray(subtask.mcpCapabilities)) {
        declarationErrors.push('mcpCapabilities must be an array of safe non-empty strings.')
      } else if (subtask.mcpCapabilities.length === 0) {
        declarationErrors.push('mcpCapabilities must contain at least one capability.')
      } else {
        for (let index = 0; index < subtask.mcpCapabilities.length; index += 1) {
          const capability = subtask.mcpCapabilities[index]
          if (!isSafeCapabilityText(capability)) {
            declarationErrors.push(`mcpCapabilities item ${index} must be a safe non-empty string.`)
          } else {
            const normalized = normalizeCapability(capability)
            if (seenDeclaredCapabilities.has(normalized)) {
              declarationErrors.push(`mcpCapabilities item ${index} duplicates '${normalized}'.`)
            } else {
              seenDeclaredCapabilities.add(normalized)
              declaredCapabilities.push(normalized)
            }
          }
        }
      }
    }
    const bindings: Record<string, unknown>[] = []
    if (Object.hasOwn(subtask, 'capabilityBindings')) {
      if (!Array.isArray(subtask.capabilityBindings)) {
        declarationErrors.push('capabilityBindings must be an array of binding records.')
      } else {
        for (let index = 0; index < subtask.capabilityBindings.length; index += 1) {
          const binding = ownRecord(subtask.capabilityBindings[index])
          if (!binding) {
            declarationErrors.push(`capabilityBindings item ${index} must be a record.`)
            continue
          }
          const capability = Object.hasOwn(binding, 'capability') ? binding.capability : undefined
          const requirementKey = explicitRequirementKey(binding)
          if (!isSafeCapabilityText(capability)) {
            declarationErrors.push(`capabilityBindings item ${index} capability must be a safe non-empty string.`)
            continue
          }
          if (!requirementKey.valid) {
            declarationErrors.push(`capabilityBindings item ${index} requirementKey must be an exact valid immutable key.`)
            continue
          }
          bindings.push({ capability: normalizeCapability(capability), requirementKey: requirementKey.value })
        }
      }
    }
    const declaredCapabilitySet = new Set(declaredCapabilities)
    bindings.forEach((binding, index) => {
      if (!declaredCapabilitySet.has(binding.capability as string)) {
        declarationErrors.push(`capabilityBindings item ${index} does not match a declared subtask capability.`)
      }
    })
    if (Object.hasOwn(subtask, 'capabilityBindings') && Array.isArray(subtask.capabilityBindings)) {
      for (const capability of declaredCapabilities) {
        const count = bindings.filter((binding) => binding.capability === capability).length
        if (count !== 1) {
          declarationErrors.push(`Subtask capability '${capability}' must have exactly one explicit requirement binding.`)
        }
      }
    }

    for (const rawCapability of agentError || invalidSubtaskId || duplicateSubtaskId
      ? []
      : declaredCapabilities) {
      const mcpId = capabilityMcpId(rawCapability)
      const capability = mcpId ? canonicalCapabilityForMcp(mcpId, rawCapability) : normalizeCapability(rawCapability)
      const capabilityClass = mcpId ? classifyCapability(mcpId, capability) : 'unknown'
      const deliveryKind = mcpId ? mcpDeliveryKind(mcpId) : null
      const matchingBindings = bindings.filter((binding) =>
        binding.capability === rawCapability,
      )
      const explicitBinding = matchingBindings.length === 1 ? matchingBindings[0] : undefined
      const candidates = evaluations.filter((evaluation) =>
        evaluation.decision.agent === agent &&
        evaluation.decision.mcpId === mcpId &&
        evaluation.decision.normalizedCapabilities.some((candidate) =>
          intersects(coverageKeysForGrant(candidate), new Set(coverageKeysForGrant(capability))),
        ),
      )
      const hasConflictingBindings = matchingBindings.length > 1
      const explicitRequirementKey = hasConflictingBindings
        ? ''
        : typeof explicitBinding?.requirementKey === 'string' ? explicitBinding.requirementKey : ''
      const explicitlyBoundEvaluation = explicitRequirementKey
        ? evaluations.find((evaluation) =>
            evaluation.source.requirementKey === explicitRequirementKey &&
            evaluation.decision.agent === agent &&
            evaluation.decision.mcpId === mcpId &&
            evaluation.decision.normalizedCapabilities.some((candidate) =>
              intersects(coverageKeysForGrant(candidate), new Set(coverageKeysForGrant(capability))),
            ),
          )
        : undefined
      const requirementKey = hasConflictingBindings
        ? ''
        : explicitRequirementKey
          ? explicitlyBoundEvaluation?.source.requirementKey ?? ''
          : candidates.length === 1 ? candidates[0].source.requirementKey : ''
      let status: McpAdmissionStatus = 'blocked'
      let reason = `The subtask capability '${capability}' is unknown or has no unambiguous requirement binding.`
      let recoveryAction: McpRecoveryAction | undefined = 'revise_plan'
      if (mcpId && intersects(coverageKeysForProhibition(capability), packageProhibitedKeys)) {
        reason = `The subtask capability '${capability}' is prohibited package-wide.`
      } else if (mcpId && capabilityClass === 'planning_only') {
        if (hasConflictingBindings) {
          reason = `The planning-only capability '${capability}' has duplicate or conflicting requirement bindings.`
        } else if (!requirementKey) {
          reason = explicitRequirementKey
            ? `The planning-only binding for '${capability}' does not identify a matching requirement for this agent and capability.`
            : candidates.length > 1
              ? `The planning-only capability '${capability}' matches multiple requirements and needs an explicit requirement binding.`
              : `The planning-only capability '${capability}' has no matching requirement binding.`
        } else {
          status = 'allowed'
          reason = `The subtask capability '${capability}' is a planning-only instruction bound to requirement '${requirementKey}'.`
          recoveryAction = undefined
        }
      } else if (mcpId && capabilityClass === 'deferred_live_mcp') {
        reason = `The subtask capability '${capability}' requires deferred live MCP delivery.`
      } else if (mcpId && capabilityClass === 'bounded_read_only' && deliveryKind === 'bounded_context_packet') {
        if (hasConflictingBindings) {
          reason = `The filesystem capability '${capability}' has duplicate or conflicting requirement bindings.`
          recoveryAction = 'revise_plan'
        } else if (requirementKey && boundedCoverageKeys.has(boundedCoverageKey(requirementKey, agent, capability))) {
          status = 'allowed'
          reason = `The subtask capability '${capability}' is covered by approved bounded context.`
          recoveryAction = undefined
        } else if (!requirementKey) {
          reason = explicitRequirementKey
            ? `The filesystem binding for '${capability}' does not identify a matching requirement for this agent and capability.`
            : candidates.length > 1
              ? `The filesystem capability '${capability}' matches multiple requirements and needs an explicit requirement binding.`
              : `The filesystem capability '${capability}' has no matching requirement binding.`
          recoveryAction = 'revise_plan'
        } else {
          reason = `The subtask capability '${capability}' is bound to a requirement without approved filesystem context.`
          recoveryAction = 'approve_project_filesystem_context'
        }
      } else if (mcpId && capabilityClass === 'bounded_read_only' && deliveryKind === 'planning_context_only') {
        if (hasConflictingBindings) {
          reason = `The planning-context capability '${capability}' has duplicate or conflicting requirement bindings.`
        } else if (requirementKey && planningContextCoverageKeys.has(planningCoverageKey(requirementKey, agent, capability))) {
          status = 'allowed'
          reason = `The subtask capability '${capability}' is covered by materialized planning context.`
          recoveryAction = undefined
        } else {
          reason = `The subtask capability '${capability}' has no matching materialized planning context.`
        }
      }
      subtaskDecisions.push({
        subtaskId,
        agent,
        requirementKey,
        mcpId: mcpId ?? '',
        capability,
        class: capabilityClass,
        deliveryKind,
        status,
        reason,
        ...(recoveryAction ? { recoveryAction } : {}),
      })
    }
    if (declarationErrors.length > 0) {
      subtaskDecisions.push(malformedSubtaskDecision(subtaskId, agent, declarationErrors))
    }
  }

  evaluations.sort((left, right) => [
    left.source.requirementKey,
    left.decision.agent,
    left.decision.mcpId,
    String(left.source.sourceRequirementIndex).padStart(12, '0'),
    left.source.decisionId,
  ].join('\u0000').localeCompare([
    right.source.requirementKey,
    right.decision.agent,
    right.decision.mcpId,
    String(right.source.sourceRequirementIndex).padStart(12, '0'),
    right.source.decisionId,
  ].join('\u0000')))
  subtaskDecisions.sort((left, right) => [
    left.subtaskId,
    left.agent,
    left.capability,
    left.requirementKey,
  ].join('\u0000').localeCompare([
    right.subtaskId,
    right.agent,
    right.capability,
    right.requirementKey,
  ].join('\u0000')))
  compatibilityWarnings.sort()

  const blocked = [
    ...evaluations.filter((item) => item.decision.status === 'blocked').map((item) => item.decision.reason),
    ...subtaskDecisions.filter((item) => item.status === 'blocked').map((item) => item.reason),
  ]
  const warnings = [
    ...evaluations.filter((item) => item.decision.status === 'warning').map((item) => item.decision.reason),
    ...subtaskDecisions.filter((item) => item.status === 'warning').map((item) => item.reason),
    ...compatibilityWarnings,
  ]
  const blockingItems = [
    ...evaluations.filter((item) => item.decision.status === 'blocked').map((item) => ({
      mode: item.decision.mode,
      action: item.decision.recoveryAction,
      stableKey: `requirement\u0000${item.source.requirementKey}\u0000${item.decision.agent}\u0000${item.decision.mcpId}`,
      decision: {
        kind: 'requirement' as const,
        mode: item.decision.mode,
        recoveryAction: item.decision.recoveryAction as McpRecoveryAction,
        retryableContribution: item.decision.recoveryAction === 'install_or_fix_mcp',
        reason: item.decision.reason,
        evidenceRefs: [...item.decision.evidenceRefs],
        requirementKey: item.source.requirementKey,
        agent: item.decision.agent,
        mcpId: item.decision.mcpId,
        decisionId: item.source.decisionId,
        sourceRequirementIndex: item.source.sourceRequirementIndex,
      },
    })),
    ...subtaskDecisions.filter((item) => item.status === 'blocked').map((item) => ({
      mode: item.class === 'deferred_live_mcp' ? 'deferred_live_mcp' as const : 'blocked' as const,
      action: item.recoveryAction,
      stableKey: `subtask\u0000${item.subtaskId}\u0000${item.agent}\u0000${item.capability}\u0000${item.requirementKey}`,
      decision: {
        kind: 'subtask' as const,
        mode: item.class === 'deferred_live_mcp' ? 'deferred_live_mcp' as const : 'blocked' as const,
        recoveryAction: item.recoveryAction as McpRecoveryAction,
        retryableContribution: item.recoveryAction === 'install_or_fix_mcp',
        reason: item.reason,
        evidenceRefs: [],
        requirementKey: item.requirementKey,
        agent: item.agent,
        mcpId: item.mcpId,
        subtaskId: item.subtaskId,
        capability: item.capability,
      },
    })),
  ]
  const precedence: McpRecoveryAction[] = [
    'revise_plan',
    'approve_project_filesystem_context',
    'install_or_fix_mcp',
    'defer_live_mcp_feature',
    'continue_as_prompt_context',
  ]
  const modePrecedence: McpAdmissionMode[] = [
    'blocked',
    'unknown_legacy',
    'deferred_live_mcp',
    'bounded_context_required',
    'bounded_context_approved',
    'planning_only',
  ]
  const primary = blockingItems.sort((left, right) => {
    const leftActionRank = precedence.indexOf(left.action as McpRecoveryAction)
    const rightActionRank = precedence.indexOf(right.action as McpRecoveryAction)
    const actionDifference = (leftActionRank < 0 ? precedence.length : leftActionRank) -
      (rightActionRank < 0 ? precedence.length : rightActionRank)
    if (actionDifference !== 0) return actionDifference
    const modeDifference = modePrecedence.indexOf(left.mode) - modePrecedence.indexOf(right.mode)
    return modeDifference !== 0 ? modeDifference : left.stableKey.localeCompare(right.stableKey)
  })[0]
  const label = text(input.label, 160) || 'work package'
  const referencedHealth = [...new Map(evaluations.map((evaluation) => [evaluation.health.mcpId, evaluation.health])).values()]
    .sort((left, right) => left.mcpId.localeCompare(right.mcpId))
    .map((health) => ({
      mcpId: health.mcpId,
      installState: health.installState as McpExecutionValidation['health'][number]['installState'],
      status: health.status as McpExecutionValidation['health'][number]['status'],
      enabled: health.enabled,
      error: health.error,
    }))

  return {
    schemaVersion: 2,
    evaluations,
    subtaskDecisions,
    referencedHealth,
    aggregate: {
      status: blocked.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'allowed',
      blocked,
      warnings,
      blockedReason: blocked.length > 0 ? `MCP/capability broker blocked "${label}": ${blocked.join('; ')}` : null,
      retryable: blockingItems.length > 0 && blockingItems.every((item) => item.decision.retryableContribution),
      ...(primary ? {
        primaryMode: primary.decision.mode,
        primaryRecoveryAction: primary.decision.recoveryAction,
        primaryDecision: primary.decision,
      } : {}),
    },
  }
}

export function admitWorkPackageMcp(input: WorkPackageMcpAdmissionInput): McpWorkPackageAdmission {
  try {
    const entries = input.entries
    const subtasks = input.subtasks
    const label = input.label
    const statusFor = input.statusFor
    const effectiveGrantFor = input.effectiveGrantFor
    const hasPromptOnlyContextFor = input.hasPromptOnlyContextFor
    if (!Array.isArray(subtasks)) return malformedSubtasksContainerBlock(label)
    const boundError = admissionBoundError(entries, subtasks)
    if (boundError) return structuralAdmissionBlock(label, boundError)
    return admitWorkPackageMcpUnchecked({
      entries: structuredClone(entries),
      subtasks: structuredClone(subtasks),
      label: structuredClone(label),
      statusFor,
      effectiveGrantFor,
      hasPromptOnlyContextFor,
    })
  } catch {
    return structuralAdmissionBlock('work package', 'MCP admission input could not be safely inspected.')
  }
}

function cloneHealthSnapshot(health: McpHealthSnapshot): McpHealthSnapshot {
  return { ...health }
}

function clonePrimaryDecision(
  decision: McpPrimaryBlockingDecision,
): McpPrimaryBlockingDecision {
  return { ...decision, evidenceRefs: [...decision.evidenceRefs] }
}

function cloneEvaluation(evaluation: McpAdmissionEvaluation): McpAdmissionEvaluation {
  return {
    decision: {
      ...evaluation.decision,
      requestedCapabilities: [...evaluation.decision.requestedCapabilities],
      normalizedCapabilities: [...evaluation.decision.normalizedCapabilities],
      capabilityClasses: evaluation.decision.capabilityClasses.map((item) => ({ ...item })),
      ...(evaluation.decision.grantState ? { grantState: { ...evaluation.decision.grantState } } : {}),
      evidenceRefs: [...evaluation.decision.evidenceRefs],
    },
    source: {
      ...evaluation.source,
      assignment: { ...evaluation.source.assignment },
      fallback: { ...evaluation.source.fallback },
    },
    health: cloneHealthSnapshot(evaluation.health),
  }
}

export function admissionToValidation(admission: McpWorkPackageAdmission): McpExecutionValidation {
  return {
    status: admission.aggregate.status === 'allowed'
      ? 'valid'
      : admission.aggregate.status === 'warning' ? 'warnings' : 'blocked',
    runtimeEnforcement: 'not_implemented',
    health: admission.referencedHealth.map((health) => ({ ...health })),
    blocked: [...admission.aggregate.blocked],
    warnings: [...admission.aggregate.warnings],
  }
}

export function admissionToGrantPreview(admission: McpWorkPackageAdmission): McpGrantPreview {
  const summary = { proposed: 0, warning: 0, blocked: 0 }
  const decisions = admission.evaluations.map((evaluation) => {
    const legacyStatus: McpGrantDecisionStatus = evaluation.decision.status === 'allowed'
      ? 'proposed'
      : evaluation.decision.status
    summary[legacyStatus] += 1
    return {
      requirementKey: evaluation.source.requirementKey,
      decisionId: evaluation.source.decisionId,
      sourceRequirementIndex: evaluation.source.sourceRequirementIndex,
      agent: evaluation.decision.agent,
      mcpId: evaluation.decision.mcpId,
      capabilities: [...evaluation.decision.requestedCapabilities],
      requirement: evaluation.decision.requirement,
      status: legacyStatus,
      reason: evaluation.decision.reason,
      assignment: { ...evaluation.source.assignment },
      fallback: { ...evaluation.source.fallback },
      health: cloneHealthSnapshot(evaluation.health),
      promptOverlayPresent: evaluation.source.promptOverlayPresent,
      mode: evaluation.decision.mode,
      recoveryAction: evaluation.decision.recoveryAction,
      ...(evaluation.decision.grantState ? { grantState: { ...evaluation.decision.grantState } } : {}),
      normalizedCapabilities: [...evaluation.decision.normalizedCapabilities],
      capabilityClasses: evaluation.decision.capabilityClasses.map((item) => ({ ...item })),
      evidenceRefs: [...evaluation.decision.evidenceRefs],
      admissionStatus: evaluation.decision.status,
    }
  })
  return {
    schemaVersion: 1,
    runtimeEnforcement: 'not_implemented',
    summary,
    decisions,
    admissionStatus: admission.aggregate.status,
    blocked: [...admission.aggregate.blocked],
    warnings: [...admission.aggregate.warnings],
    blockedReason: admission.aggregate.blockedReason,
    retryable: admission.aggregate.retryable,
    evaluations: admission.evaluations.map(cloneEvaluation),
    subtaskDecisions: admission.subtaskDecisions.map((decision) => ({ ...decision })),
    ...(admission.aggregate.primaryDecision?.mode
      ? { primaryMode: admission.aggregate.primaryDecision.mode }
      : admission.aggregate.primaryMode ? { primaryMode: admission.aggregate.primaryMode } : {}),
    ...(admission.aggregate.primaryDecision?.recoveryAction
      ? { primaryRecoveryAction: admission.aggregate.primaryDecision.recoveryAction }
      : admission.aggregate.primaryRecoveryAction
        ? { primaryRecoveryAction: admission.aggregate.primaryRecoveryAction }
      : {}),
    ...(admission.aggregate.primaryDecision
      ? { primaryDecision: clonePrimaryDecision(admission.aggregate.primaryDecision) }
      : {}),
  }
}

export function admissionToBrokerCheck(admission: McpWorkPackageAdmission): McpBrokerAdmissionCheck {
  return {
    status: admission.aggregate.status === 'warning' ? 'warnings' : admission.aggregate.status,
    blocked: [...admission.aggregate.blocked],
    warnings: [...admission.aggregate.warnings],
    blockedReason: admission.aggregate.blockedReason,
    retryable: admission.aggregate.retryable,
    evaluations: admission.evaluations.map(cloneEvaluation),
    subtaskDecisions: admission.subtaskDecisions.map((decision) => ({ ...decision })),
    ...(admission.aggregate.primaryDecision?.mode
      ? { primaryMode: admission.aggregate.primaryDecision.mode }
      : admission.aggregate.primaryMode ? { primaryMode: admission.aggregate.primaryMode } : {}),
    ...(admission.aggregate.primaryDecision?.recoveryAction
      ? { primaryRecoveryAction: admission.aggregate.primaryDecision.recoveryAction }
      : admission.aggregate.primaryRecoveryAction
        ? { primaryRecoveryAction: admission.aggregate.primaryRecoveryAction }
      : {}),
    ...(admission.aggregate.primaryDecision
      ? { primaryDecision: clonePrimaryDecision(admission.aggregate.primaryDecision) }
      : {}),
  }
}
