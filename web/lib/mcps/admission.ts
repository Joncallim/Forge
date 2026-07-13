import { isKnownMcpId } from './catalog'
import {
  canProceedWithoutMcp,
  canonicalCapabilityForMcp,
  capabilityMcpId,
  classifyCapability,
  coverageKeysForGrant,
  coverageKeysForProhibition,
  isMcpHealthy,
  mcpDeliveryKind,
  mcpHealthReason,
  mergeCapabilityFields,
  normalizeCapability,
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

const NO_GRANT: EffectiveGrantState = {
  phase: 'none',
  source: 'none',
  status: 'not_issued',
  coveredCapabilities: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function text(value: unknown, maxLength = 240): string {
  return sanitizeMcpError(value, maxLength)
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(normalizeCapability).filter(Boolean)
    : []
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
  const metadata = isRecord(pkg.metadata) ? pkg.metadata : {}
  const phases = isRecord(metadata.mcpGrantPhases) ? metadata.mcpGrantPhases : {}
  const effective = isRecord(phases.effective) ? phases.effective : null
  const config = isRecord(project.mcpConfig) ? project.mcpConfig : {}
  const grants = isRecord(config.grants) ? config.grants : {}
  const projectGrant = isRecord(grants.filesystem) ? grants.filesystem : null
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
    return { ...NO_GRANT, phase: 'not_issued' }
  }
  if (Array.isArray(phases.proposed)) return { ...NO_GRANT, phase: 'proposed' }
  return { ...NO_GRANT }
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
  const normalizedCapabilities = input.requestedCapabilities.map((capability) =>
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
    requestedCapabilities: [...input.requestedCapabilities],
    normalizedCapabilities,
    capabilityClasses,
    evidenceRefs: (input.evidenceRefs ?? []).map((ref) => text(ref, 300)).filter(Boolean),
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
  const canProceed = canProceedWithoutMcp(input.requirement, input.fallback)

  if (!isKnownMcpId(input.mcpId)) {
    return result('blocked', 'blocked', `Unknown MCP '${input.mcpId}'.`, 'revise_plan')
  }
  if (capabilityClasses.some((item) => item.class === 'unknown')) {
    return result('blocked', 'blocked', `MCP '${input.mcpId}' includes an unknown capability.`, 'revise_plan')
  }
  if (normalizedCapabilities.some((capability) =>
    coverageKeysForProhibition(capability).some((key) => input.packageProhibitedKeys.has(key)),
  )) {
    return result('blocked', 'blocked', `MCP '${input.mcpId}' includes a package-prohibited capability.`, 'revise_plan')
  }
  if (capabilityClasses.some((item) => item.class === 'deferred_live_mcp')) {
    return canProceed
      ? result('deferred_live_mcp', 'warning', 'Live MCP capability delivery is deferred in this beta.', 'defer_live_mcp_feature')
      : result('deferred_live_mcp', 'blocked', 'This requirement depends on deferred live MCP capability delivery.', 'revise_plan')
  }

  const boundedPacketCapabilities = capabilityClasses
    .filter((item) => item.class === 'bounded_read_only' && item.deliveryKind === 'bounded_context_packet')
    .map((item) => item.capability)
  if (boundedPacketCapabilities.length > 0) {
    const grant = input.effectiveGrant
    const covered = grant.phase === 'approved' && !grant.consumed && covers(grant.coveredCapabilities, boundedPacketCapabilities)
    if (!covered) {
      return result(
        'bounded_context_required',
        canProceed ? 'warning' : 'blocked',
        grant.phase === 'revoked'
          ? grant.revocationReason ?? 'The project filesystem context grant was removed.'
          : grant.phase === 'denied'
            ? 'Filesystem context was denied and must be approved before this requirement can run.'
            : 'Filesystem context approval is required.',
        'approve_project_filesystem_context',
        grantStateForDecision(grant),
      )
    }
    if (!isMcpHealthy(input.mcpId, input.status)) {
      return result(
        'bounded_context_approved',
        canProceed ? 'warning' : 'blocked',
        mcpHealthReason(input.mcpId, input.status),
        'install_or_fix_mcp',
        grantStateForDecision(grant),
      )
    }
    return result(
      'bounded_context_approved',
      'allowed',
      'Approved bounded read-only context is available.',
      undefined,
      grantStateForDecision(grant),
    )
  }

  const planningContextReads = capabilityClasses.some(
    (item) => item.class === 'bounded_read_only' && item.deliveryKind === 'planning_context_only',
  )
  if (planningContextReads) {
    if (input.hasPromptOnlyContext) {
      return result('planning_only', 'allowed', 'The MCP read is available as planning context.', 'continue_as_prompt_context')
    }
    return canProceed
      ? result('planning_only', 'warning', 'Planning context was not materialized; this optional requirement may continue without it.', 'continue_as_prompt_context')
      : result('blocked', 'blocked', 'Required MCP planning context was not materialized.', 'revise_plan')
  }

  if (normalizedCapabilities.length === 0 && !input.hasPromptOnlyContext && !canProceed) {
    return result('blocked', 'blocked', 'The MCP requirement has no capabilities or materialized planning context.', 'revise_plan')
  }
  return result(
    'planning_only',
    'warning',
    'This requirement is planning-only and grants no live MCP capability.',
    'continue_as_prompt_context',
  )
}

type JoinedEntry = {
  raw: Record<string, unknown> | null
  grant: Record<string, unknown> | null
  requirementKey: string
  rawIndex: number
  compatibilityWarning?: string
}

function requirementLevel(entry: Record<string, unknown>): 'required' | 'optional' {
  return entry.requirement === 'optional' ? 'optional' : 'required'
}

function fallbackOf(entry: Record<string, unknown>): { action: McpFallbackAction; message: string } {
  const fallback = isRecord(entry.fallback) ? entry.fallback : {}
  const action = fallback.action === 'continue_without_mcp' || fallback.action === 'ask_user'
    ? fallback.action
    : 'block'
  return { action, message: text(fallback.message, 500) }
}

function entryAgent(entry: Record<string, unknown>): string {
  return text(entry.agent, 80) || text(entry.assignedRole, 80) || 'unknown'
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
  if (
    typeof raw.sourceRequirementIndex === 'number' &&
    typeof grant.sourceRequirementIndex === 'number' &&
    raw.sourceRequirementIndex !== grant.sourceRequirementIndex
  ) {
    return false
  }
  return true
}

function joinEntries(entries: Array<Record<string, unknown>>): JoinedEntry[] {
  const raws = entries.filter((entry) => typeof entry.decisionId !== 'string')
  const grants = entries.filter((entry) => typeof entry.decisionId === 'string')
  const usedGrants = new Set<Record<string, unknown>>()
  const joined: JoinedEntry[] = []

  raws.forEach((raw, rawIndex) => {
    const explicitKey = text(raw.requirementKey, 160)
    const hasExplicitKey = explicitKey !== ''
    const explicitCandidates = !hasExplicitKey
      ? []
      : grants.filter((candidate) => !usedGrants.has(candidate) && candidate.requirementKey === explicitKey)
    const validExplicitCandidates = explicitCandidates.filter((candidate) => sameEnvelopeIdentity(raw, candidate))
    let grant = explicitCandidates.length === 1 && validExplicitCandidates.length === 1 ? validExplicitCandidates[0] : null
    const explicitJoinRejected = hasExplicitKey &&
      (explicitCandidates.length !== 1 || validExplicitCandidates.length !== 1)
    if (!grant && !hasExplicitKey && Number.isInteger(raw.sourceRequirementIndex)) {
      grant = grants.find((candidate) =>
        !usedGrants.has(candidate) &&
        candidate.sourceRequirementIndex === raw.sourceRequirementIndex &&
        entryAgent(candidate) === entryAgent(raw) &&
        candidate.mcpId === raw.mcpId,
      ) ?? null
    }
    if (!grant && !hasExplicitKey) {
      const fingerprint = legacyFingerprint(raw)
      grant = grants.find((candidate) => !usedGrants.has(candidate) && legacyFingerprint(candidate) === fingerprint) ?? null
    }
    if (grant) usedGrants.add(grant)
    joined.push({
      raw,
      grant,
      requirementKey: explicitKey || text(grant?.requirementKey, 160) || `legacy-${rawIndex}-${text(raw.mcpId, 40) || 'unknown'}-${entryAgent(raw)}`,
      rawIndex,
      ...(explicitJoinRejected
        ? { compatibilityWarning: `MCP requirement '${explicitKey}' had no unique matching persisted grant envelope; legacy matching was disabled.` }
        : {}),
    })
  })

  grants.forEach((grant, index) => {
    if (usedGrants.has(grant)) return
    joined.push({
      raw: null,
      grant,
      requirementKey: text(grant.requirementKey, 160) || `legacy-grant-only-${index}`,
      rawIndex: -1,
      compatibilityWarning: 'A derived MCP grant had no authoritative requirement policy and must be recomputed.',
    })
  })
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
  const assignment = isRecord(entry.assignment) ? entry.assignment : {}
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
  const joined = joinEntries(input.entries)
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
    const hasPromptOnlyContext = input.hasPromptOnlyContextFor({ requirementKey: item.requirementKey, agent, mcpId })
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
        reason: 'This legacy grant has no authoritative requirement policy and must be recomputed.',
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
      if (invalid?.length) {
        decision = {
          ...decision,
          mode: 'blocked',
          status: 'blocked',
          reason: decisionReason(invalid.join(' ')),
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
        sourceRequirementIndex: typeof envelope.sourceRequirementIndex === 'number'
          ? envelope.sourceRequirementIndex
          : typeof policy?.sourceRequirementIndex === 'number' ? policy.sourceRequirementIndex : item.rawIndex,
        assignment: isRecord(envelope.assignment) ? assignmentOf(envelope) : assignmentOf(policy ?? envelope),
        fallback,
        promptOverlayPresent: envelope.promptOverlayPresent === true || hasPromptOnlyContext,
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
  for (const subtask of input.subtasks) {
    const subtaskId = text(subtask.id, 160) || 'unknown-subtask'
    const agent = entryAgent(subtask)
    const bindings = records(subtask.capabilityBindings)
    for (const rawCapability of strings(subtask.mcpCapabilities)) {
      const mcpId = capabilityMcpId(rawCapability)
      const capability = mcpId ? canonicalCapabilityForMcp(mcpId, rawCapability) : normalizeCapability(rawCapability)
      const capabilityClass = mcpId ? classifyCapability(mcpId, capability) : 'unknown'
      const deliveryKind = mcpId ? mcpDeliveryKind(mcpId) : null
      const matchingBindings = bindings.filter((binding) =>
        normalizeCapability(text(binding.capability)) === normalizeCapability(rawCapability),
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
      const explicitRequirementKey = hasConflictingBindings ? '' : text(explicitBinding?.requirementKey, 160)
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
      let reason = 'The subtask capability is unknown or has no unambiguous requirement binding.'
      let recoveryAction: McpRecoveryAction | undefined = 'revise_plan'
      if (mcpId && intersects(coverageKeysForProhibition(capability), packageProhibitedKeys)) {
        reason = 'The subtask capability is prohibited package-wide.'
      } else if (mcpId && capabilityClass === 'planning_only') {
        status = 'allowed'
        reason = 'The subtask capability is a planning-only instruction.'
        recoveryAction = undefined
      } else if (mcpId && capabilityClass === 'deferred_live_mcp') {
        reason = 'The subtask requires deferred live MCP delivery.'
      } else if (mcpId && capabilityClass === 'bounded_read_only' && deliveryKind === 'bounded_context_packet') {
        if (hasConflictingBindings) {
          reason = 'The subtask filesystem capability has duplicate or conflicting requirement bindings.'
          recoveryAction = 'revise_plan'
        } else if (requirementKey && boundedCoverageKeys.has(boundedCoverageKey(requirementKey, agent, capability))) {
          status = 'allowed'
          reason = 'The subtask capability is covered by approved bounded context.'
          recoveryAction = undefined
        } else if (!requirementKey) {
          reason = explicitRequirementKey
            ? 'The subtask filesystem binding does not identify a matching requirement for this agent and capability.'
            : candidates.length > 1
              ? 'The subtask filesystem capability matches multiple requirements and needs an explicit requirement binding.'
              : 'The subtask filesystem capability has no matching requirement binding.'
          recoveryAction = 'revise_plan'
        } else {
          reason = 'The subtask capability is bound to a requirement without approved filesystem context.'
          recoveryAction = 'approve_project_filesystem_context'
        }
      } else if (mcpId && capabilityClass === 'bounded_read_only' && deliveryKind === 'planning_context_only') {
        if (hasConflictingBindings) {
          reason = 'The subtask planning-context capability has duplicate or conflicting requirement bindings.'
        } else if (requirementKey && planningContextCoverageKeys.has(planningCoverageKey(requirementKey, agent, capability))) {
          status = 'allowed'
          reason = 'The subtask capability is covered by materialized planning context.'
          recoveryAction = undefined
        } else {
          reason = 'The subtask capability has no matching materialized planning context.'
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
  }

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
    })),
    ...subtaskDecisions.filter((item) => item.status === 'blocked').map((item) => ({
      mode: item.class === 'deferred_live_mcp' ? 'deferred_live_mcp' as const : 'blocked' as const,
      action: item.recoveryAction,
    })),
  ]
  const precedence: McpRecoveryAction[] = [
    'revise_plan',
    'approve_project_filesystem_context',
    'install_or_fix_mcp',
    'defer_live_mcp_feature',
    'continue_as_prompt_context',
  ]
  const primary = precedence
    .map((action) => blockingItems.find((item) => item.action === action))
    .find((item) => item !== undefined)
  const label = text(input.label, 160) || 'work package'
  const referencedHealth = [...new Map(evaluations.map((evaluation) => [evaluation.health.mcpId, evaluation.health])).values()]
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

export function admissionToValidation(admission: McpWorkPackageAdmission): McpExecutionValidation {
  return {
    status: admission.aggregate.status === 'allowed'
      ? 'valid'
      : admission.aggregate.status === 'warning' ? 'warnings' : 'blocked',
    runtimeEnforcement: 'not_implemented',
    health: admission.referencedHealth,
    blocked: admission.aggregate.blocked,
    warnings: admission.aggregate.warnings,
  }
}

export function admissionToGrantPreview(admission: McpWorkPackageAdmission): McpGrantDecisions & {
  decisions: Array<McpGrantDecisions['decisions'][number] & Record<string, unknown>>
  retryable: boolean
  primaryMode?: McpAdmissionMode
  primaryRecoveryAction?: McpRecoveryAction
} {
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
      capabilities: evaluation.decision.requestedCapabilities,
      requirement: evaluation.decision.requirement,
      status: legacyStatus,
      reason: evaluation.decision.reason,
      assignment: evaluation.source.assignment,
      fallback: evaluation.source.fallback,
      health: evaluation.health,
      promptOverlayPresent: evaluation.source.promptOverlayPresent,
      mode: evaluation.decision.mode,
      recoveryAction: evaluation.decision.recoveryAction,
      grantState: evaluation.decision.grantState,
      normalizedCapabilities: evaluation.decision.normalizedCapabilities,
      capabilityClasses: evaluation.decision.capabilityClasses,
      evidenceRefs: evaluation.decision.evidenceRefs,
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

export function admissionToBrokerCheck(admission: McpWorkPackageAdmission): WorkPackageMcpBrokerCheck & {
  retryable: boolean
  primaryMode?: McpAdmissionMode
  primaryRecoveryAction?: McpRecoveryAction
} {
  return {
    status: admission.aggregate.status === 'warning' ? 'warnings' : admission.aggregate.status,
    blocked: admission.aggregate.blocked,
    warnings: admission.aggregate.warnings,
    blockedReason: admission.aggregate.blockedReason,
    retryable: admission.aggregate.retryable,
    ...(admission.aggregate.primaryMode ? { primaryMode: admission.aggregate.primaryMode } : {}),
    ...(admission.aggregate.primaryRecoveryAction
      ? { primaryRecoveryAction: admission.aggregate.primaryRecoveryAction }
      : {}),
  }
}
