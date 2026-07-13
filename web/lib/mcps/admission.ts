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
  revocationReason?: string
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
  retryable: boolean
  primaryMode?: McpAdmissionMode
  primaryRecoveryAction?: McpRecoveryAction
}

export type McpBrokerAdmissionCheck = WorkPackageMcpBrokerCheck & {
  retryable: boolean
  primaryMode?: McpAdmissionMode
  primaryRecoveryAction?: McpRecoveryAction
  evaluations: McpAdmissionEvaluation[]
  subtaskDecisions: McpWorkPackageAdmission['subtaskDecisions']
}

const NO_GRANT: EffectiveGrantState = {
  phase: 'none',
  source: 'none',
  status: 'not_issued',
  coveredCapabilities: [],
}

function noGrant(phase: EffectiveGrantState['phase'] = 'none'): EffectiveGrantState {
  return { ...NO_GRANT, phase, coveredCapabilities: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? Object.fromEntries(Object.entries(value)) : null
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(ownRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    : []
}

function text(value: unknown, maxLength = 240): string {
  return sanitizeMcpError(value, maxLength)
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

function grantCapabilities(value: unknown): string[] {
  const result = new Set<string>()
  for (const grant of records(value)) {
    if (grant.mcpId !== 'filesystem' || grant.status !== 'approved') continue
    for (const capability of strings(grant.capabilities)) {
      if (classifyCapability('filesystem', capability) === 'bounded_read_only') {
        result.add(canonicalCapabilityForMcp('filesystem', capability))
      }
    }
  }
  return [...result].sort()
}

function covers(covered: readonly string[], required: readonly string[]): boolean {
  const keys = new Set(covered.flatMap(coverageKeysForGrant))
  return required.every((capability) => coverageKeysForGrant(capability).some((key) => keys.has(key)))
}

export function readEffectiveGrantState(
  pkg: { metadata: unknown },
  project: { mcpConfig: unknown },
  requiredCapabilities: string[],
): EffectiveGrantState {
  const required = requiredCapabilities
    .filter((capability) => classifyCapability('filesystem', capability) === 'bounded_read_only')
    .map((capability) => canonicalCapabilityForMcp('filesystem', capability))
  const metadata = ownRecord(pkg.metadata) ?? {}
  const phases = ownRecord(metadata.mcpGrantPhases) ?? {}
  const effective = ownRecord(phases.effective)
  const config = ownRecord(project.mcpConfig) ?? {}
  const grants = ownRecord(config.grants) ?? {}
  const projectGrant = ownRecord(grants.filesystem)
  const validProjectGrant = projectGrant?.schemaVersion === 1 &&
    projectGrant.mcpId === 'filesystem' &&
    projectGrant.status === 'approved' &&
    projectGrant.grantMode === 'always_allow'
  const projectCovered = validProjectGrant
    ? strings(projectGrant.capabilities)
        .filter((capability) => classifyCapability('filesystem', capability) === 'bounded_read_only')
        .map((capability) => canonicalCapabilityForMcp('filesystem', capability))
    : []

  const validEffective = effective?.schemaVersion === 1 &&
    effective.phase === 'effective' &&
    effective.runtimeEnforcement === 'bounded_context_packet'

  if (validEffective && effective.status === 'denied') {
    const deniedAt = Date.parse(text(effective.deniedAt, 80))
    const projectApprovedAt = Date.parse(text(projectGrant?.approvedAt, 80))
    const laterProjectGrantCovers = validProjectGrant &&
      covers(projectCovered, required) &&
      Number.isFinite(deniedAt) &&
      Number.isFinite(projectApprovedAt) &&
      projectApprovedAt > deniedAt
    if (!laterProjectGrantCovers) {
      return {
        phase: 'denied',
        source: 'package-local',
        status: 'denied',
        coveredCapabilities: [],
        grantApprovalId: text(effective.grantApprovalId) || undefined,
      }
    }
    return {
      phase: 'approved',
      source: 'project-level',
      status: 'approved',
      grantMode: 'always_allow',
      coveredCapabilities: projectCovered,
      grantApprovalId: text(projectGrant?.grantApprovalId) || undefined,
    }
  }

  if (validEffective && effective.source === 'project-filesystem-approval' && effective.status === 'approved') {
    if (!validProjectGrant || !covers(projectCovered, required)) {
      return {
        phase: 'revoked',
        source: 'project-level',
        status: 'not_issued',
        coveredCapabilities: projectCovered,
        grantApprovalId: text(effective.grantApprovalId) || undefined,
        revocationReason: 'The project filesystem grant was removed or no longer covers this package.',
      }
    }
    return {
      phase: 'approved',
      source: 'project-level',
      status: 'approved',
      grantMode: 'always_allow',
      coveredCapabilities: projectCovered,
      grantApprovalId: text(projectGrant.grantApprovalId) || text(effective.grantApprovalId) || undefined,
    }
  }

  if (
    validEffective &&
    effective.status === 'approved' &&
    effective.source === 'explicit-grant-approval' &&
    (effective.grantMode === 'allow_once' || effective.grantMode === 'always_allow')
  ) {
    // The persisted phase records what was approved, even when its capability set is
    // narrower than this requirement. Admission rechecks exact coverage and fails
    // closed; it must not invent a new phase or grant mode to describe that mismatch.
    const coveredCapabilities = grantCapabilities(effective.grants)
    const grantMode = effective.grantMode
    const consumed = grantMode === 'allow_once' && effective.runtimeIssued === true
    return {
      phase: 'approved',
      source: 'package-local',
      status: 'approved',
      grantMode,
      consumed,
      coveredCapabilities,
      grantApprovalId: text(effective.grantApprovalId) || undefined,
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
    const coveredCapabilities = grantCapabilities(effective.grants)
    if (coveredCapabilities.length > 0) {
      return {
        phase: 'approved',
        source: 'package-local',
        status: 'approved',
        grantMode: 'allow_once',
        consumed: true,
        coveredCapabilities,
        grantApprovalId: text(effective.grantApprovalId) || undefined,
      }
    }
  }

  if (validProjectGrant && covers(projectCovered, required)) {
    return {
      phase: 'approved',
      source: 'project-level',
      status: 'approved',
      grantMode: 'always_allow',
      coveredCapabilities: projectCovered,
      grantApprovalId: text(projectGrant.grantApprovalId) || undefined,
    }
  }

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
    const items = [...value as Iterable<unknown>]
    if (items.some((item) => !isSafeCapabilityText(item))) {
      return { keys: new Set(), malformed: true }
    }
    return { keys: new Set(items as string[]), malformed: false }
  } catch {
    return { keys: new Set(), malformed: true }
  }
}

export function admitMcpRequirement(input: {
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
}): McpAdmissionDecision {
  const requestedCapabilities = Array.isArray(input.requestedCapabilities)
    ? input.requestedCapabilities.filter(isSafeCapabilityText)
    : []
  const malformedRequestedCapabilities = !Array.isArray(input.requestedCapabilities) ||
    input.requestedCapabilities.some((capability) => !isSafeCapabilityText(capability))
  const evidenceRefs = input.evidenceRefs
  const malformedEvidenceRefs = evidenceRefs !== undefined &&
    (!Array.isArray(evidenceRefs) || evidenceRefs.some((ref) => typeof ref !== 'string'))
  const fallback = ownRecord(input.fallback)
  const fallbackAction = fallback?.action
  const malformedFallback = fallback === null ||
    (fallbackAction !== 'block' && fallbackAction !== 'continue_without_mcp' && fallbackAction !== 'ask_user')
  const prohibited = readProhibitedCapabilityKeys(input.packageProhibitedKeys)
  const grant = ownRecord(input.effectiveGrant)
  const grantCoveredCapabilities = grant?.coveredCapabilities
  const validGrantPhases: EffectiveGrantState['phase'][] = ['none', 'proposed', 'approved', 'denied', 'revoked', 'not_issued']
  const validGrantSources: EffectiveGrantState['source'][] = ['none', 'package-local', 'project-level']
  const validGrantStatuses: EffectiveGrantState['status'][] = ['not_issued', 'approved', 'denied']
  const malformedGrantCoverage = grant === null ||
    !Array.isArray(grantCoveredCapabilities) ||
    grantCoveredCapabilities.some((capability) => !isSafeCapabilityText(capability)) ||
    !validGrantPhases.includes(grant.phase as EffectiveGrantState['phase']) ||
    !validGrantSources.includes(grant.source as EffectiveGrantState['source']) ||
    !validGrantStatuses.includes(grant.status as EffectiveGrantState['status']) ||
    (Object.hasOwn(grant, 'grantMode') && grant.grantMode !== 'allow_once' && grant.grantMode !== 'always_allow') ||
    (Object.hasOwn(grant, 'consumed') && typeof grant.consumed !== 'boolean')
  const effectiveGrant: EffectiveGrantState = malformedGrantCoverage
    ? noGrant()
    : {
        phase: grant.phase as EffectiveGrantState['phase'],
        source: grant.source as EffectiveGrantState['source'],
        status: grant.status as EffectiveGrantState['status'],
        coveredCapabilities: [...grantCoveredCapabilities as string[]],
        ...(grant.grantMode === 'allow_once' || grant.grantMode === 'always_allow'
          ? { grantMode: grant.grantMode }
          : {}),
        ...(typeof grant.consumed === 'boolean' ? { consumed: grant.consumed } : {}),
        ...(typeof grant.grantApprovalId === 'string' ? { grantApprovalId: text(grant.grantApprovalId) } : {}),
        ...(typeof grant.revocationReason === 'string' ? { revocationReason: text(grant.revocationReason, 300) } : {}),
      }
  const normalizedCapabilities = requestedCapabilities.map((capability) =>
    canonicalCapabilityForMcp(input.mcpId, capability),
  )
  const capabilityClasses = normalizedCapabilities.map((capability) => ({
    capability,
    class: classifyCapability(input.mcpId, capability),
    deliveryKind: mcpDeliveryKind(input.mcpId),
  }))
  const base = {
    schemaVersion: 1 as const,
    mcpId: input.mcpId,
    agent: input.agent,
    requirement: input.requirement,
    requestedCapabilities: [...requestedCapabilities],
    normalizedCapabilities,
    capabilityClasses,
    evidenceRefs: (Array.isArray(evidenceRefs) ? evidenceRefs : [])
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
  const canProceed = canProceedWithoutMcp(input.requirement, {
    action: malformedFallback ? 'block' : fallbackAction,
  })

  const malformedDirectInputs = [
    ...(malformedRequestedCapabilities ? ['requested capabilities'] : []),
    ...(malformedEvidenceRefs ? ['evidence references'] : []),
    ...(malformedFallback ? ['fallback'] : []),
    ...(prohibited.malformed ? ['prohibition set'] : []),
    ...(malformedGrantCoverage ? ['grant coverage'] : []),
  ]
  if (malformedDirectInputs.length > 0) {
    return result(
      'blocked',
      'blocked',
      `Malformed MCP admission input: ${malformedDirectInputs.join(', ')}.`,
      'revise_plan',
    )
  }
  if (!isKnownMcpId(input.mcpId)) {
    return result(
      'blocked',
      'blocked',
      `Unknown MCP '${input.mcpId}' for capabilities: ${capabilityReasonList(normalizedCapabilities)}.`,
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
      `MCP '${input.mcpId}' includes unknown capabilities: ${capabilityReasonList(unknownCapabilities)}.`,
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
      `MCP '${input.mcpId}' includes package-prohibited capabilities: ${capabilityReasonList(prohibitedCapabilities)}.`,
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
    if (!isMcpHealthy(input.mcpId, input.status)) {
      return result(
        'bounded_context_approved',
        canProceed ? 'warning' : 'blocked',
        `${mcpHealthReason(input.mcpId, input.status)} Required capabilities: ${capabilityReasonList(boundedPacketCapabilities)}.`,
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
    if (input.hasPromptOnlyContext) {
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

  if (normalizedCapabilities.length === 0 && !input.hasPromptOnlyContext && !canProceed) {
    return result('blocked', 'blocked', 'The MCP requirement has no capabilities or materialized planning context.', 'revise_plan')
  }
  return result(
    'planning_only',
    'warning',
    `This requirement is planning-only for: ${capabilityReasonList(normalizedCapabilities)}. It grants no live MCP capability.`,
    'continue_as_prompt_context',
  )
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

function entryAgent(entry: Record<string, unknown>): string {
  return (Object.hasOwn(entry, 'agent') ? text(entry.agent, 80) : '') ||
    (Object.hasOwn(entry, 'assignedRole') ? text(entry.assignedRole, 80) : '') ||
    'unknown'
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
  if (!status || status.mcpId !== mcpId) {
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
    installState: status.installState,
    status: status.status,
    enabled: status.enabled,
    error: status.error === null ? null : sanitizeMcpError(status.error, 240) || null,
    checkedAt: status.checkedAt,
  }
}

function assignmentOf(entry: Record<string, unknown>): { type: McpAssignmentType; targetId: string | null } {
  const assignment = Object.hasOwn(entry, 'assignment') ? ownRecord(entry.assignment) ?? {} : {}
  const allowed = new Set(['agent', 'multiple_agents', 'workforce', 'architect_only', 'reviewer_only'])
  const type = typeof assignment.type === 'string' && allowed.has(assignment.type)
    ? assignment.type as McpAssignmentType
    : 'agent'
  return { type, targetId: typeof assignment.targetId === 'string' ? assignment.targetId : null }
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

export function admitWorkPackageMcp(input: {
  entries: Array<Record<string, unknown>>
  subtasks: Array<Record<string, unknown>>
  label: string
  statusFor: (mcpId: string) => ProjectMcpStatus | null
  effectiveGrantFor: (entry: { requirementKey: string; mcpId: string; requiredCapabilities: string[] }) => EffectiveGrantState
  hasPromptOnlyContextFor: (entry: { requirementKey: string; agent: string; mcpId: string }) => boolean
}): McpWorkPackageAdmission {
  const entries = Array.isArray(input.entries)
    ? input.entries.map((entry) => ownRecord(entry) ?? {})
    : []
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
    const mcpId = text((policy ?? envelope).mcpId, 80)
    const agent = entryAgent(policy ?? envelope)
    const fallback = fallbackOf(policy ?? envelope)
    const status = input.statusFor(mcpId)
    const health = snapshot(mcpId, status)
    const requestedCapabilities = policy ? mergeCapabilityFields(policy) : []
    const persistedPromptOnlyContext = item.grant?.promptOverlayPresent === true
    const callbackPromptOnlyContext = input.hasPromptOnlyContextFor({ requirementKey: item.requirementKey, agent, mcpId })
    const hasPromptOnlyContext = persistedPromptOnlyContext || callbackPromptOnlyContext
    const requiredCapabilities = requestedCapabilities.filter((capability) =>
      classifyCapability(mcpId, capability) === 'bounded_read_only' && mcpDeliveryKind(mcpId) === 'bounded_context_packet',
    )
    const effectiveGrant = input.effectiveGrantFor({ requirementKey: item.requirementKey, mcpId, requiredCapabilities })
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
      const invalid = invalidProhibitions.get(item.requirementKey)
      const policyErrors = capabilityFieldValidationErrors(policy)
      const failClosedErrors = [
        ...(item.joinError ? [item.joinError] : []),
        ...policyErrors,
        ...(invalid ?? []),
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
  for (const { subtask, structuralErrors } of subtasks) {
    const subtaskId = text(subtask.id, 160) || 'unknown-subtask'
    const agent = entryAgent(subtask)
    const declarationErrors: string[] = [...structuralErrors]
    const declaredCapabilities: string[] = []
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
            declaredCapabilities.push(normalizeCapability(capability))
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

    for (const rawCapability of declaredCapabilities) {
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
    })),
    ...subtaskDecisions.filter((item) => item.status === 'blocked').map((item) => ({
      mode: item.class === 'deferred_live_mcp' ? 'deferred_live_mcp' as const : 'blocked' as const,
      action: item.recoveryAction,
      stableKey: `subtask\u0000${item.subtaskId}\u0000${item.agent}\u0000${item.capability}\u0000${item.requirementKey}`,
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
      retryable: blockingItems.length > 0 && blockingItems.every((item) => item.action === 'install_or_fix_mcp'),
      ...(primary ? { primaryMode: primary.mode, primaryRecoveryAction: primary.action } : {}),
    },
  }
}

function cloneHealthSnapshot(health: McpHealthSnapshot): McpHealthSnapshot {
  return { ...health }
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
    retryable: admission.aggregate.retryable,
    ...(admission.aggregate.primaryMode ? { primaryMode: admission.aggregate.primaryMode } : {}),
    ...(admission.aggregate.primaryRecoveryAction
      ? { primaryRecoveryAction: admission.aggregate.primaryRecoveryAction }
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
    ...(admission.aggregate.primaryMode ? { primaryMode: admission.aggregate.primaryMode } : {}),
    ...(admission.aggregate.primaryRecoveryAction
      ? { primaryRecoveryAction: admission.aggregate.primaryRecoveryAction }
      : {}),
  }
}
