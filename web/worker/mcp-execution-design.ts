import { createHash } from 'crypto'
import { MCP_EXECUTION_DESIGN_FENCE, findFence, isMcpExecutionDesignShape } from '@/lib/plan-fences'
import {
  capabilityMcpId,
  coverageKeysForGrant,
  mcpDeliveryKind,
  normalizeCapability,
} from '@/lib/mcps/capability-normalization'
import {
  admissionToBrokerCheck,
  admissionToGrantPreview,
  admissionToValidation,
  admitWorkPackageMcp,
  readEffectiveGrantState,
  type EffectiveGrantState,
  type McpAdmissionEvaluation,
  type McpAdmissionMode,
  type McpAdmissionStatus,
  type McpRecoveryAction,
  type McpWorkPackageAdmission,
} from '@/lib/mcps/admission'
import type { ProjectMcpOverview, ProjectMcpStatus } from '@/lib/mcps/types'

const ASSIGNMENT_TYPES = new Set(['agent', 'multiple_agents', 'workforce', 'architect_only', 'reviewer_only'])
const FALLBACK_ACTIONS = new Set(['block', 'continue_without_mcp', 'ask_user'])

export const MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT = 'not_implemented' as const
export type McpRequirementLevel = 'required' | 'optional'
export type McpAssignmentType = 'agent' | 'multiple_agents' | 'workforce' | 'architect_only' | 'reviewer_only'
export type McpFallbackAction = 'block' | 'continue_without_mcp' | 'ask_user'
export type McpValidationStatus = 'valid' | 'blocked' | 'warnings'
export type McpGrantDecisionStatus = 'proposed' | 'warning' | 'blocked'
export type WorkPackageMcpBrokerStatus = 'allowed' | 'blocked' | 'warnings'

export type McpExecutionRequirement = {
  requirementKey?: string
  sourceRequirementIndex?: number
  mcpId: string
  requirement: McpRequirementLevel
  reason: string
  assignment: {
    type: McpAssignmentType
    targetAgents: string[]
    targetId: string | null
  }
  agentPermissions: Record<string, string[]>
  prohibitedCapabilities: string[]
  fallback: { action: McpFallbackAction; message: string }
}

export type McpRequirementContext = {
  requirementKey: string
  sourceRequirementIndex: number
  agent: string
  mcpId: string
  promptOverlay: string
}

export type McpAwareSubtask = {
  id: string
  agent: string
  dependsOn: string[]
  mcpCapabilities: string[]
  capabilityBindings?: Array<{ capability: string; requirementKey: string }>
  inputs: string[]
  outputs: string[]
  verification: string[]
  stoppingCondition: string
  fallback: string
}

export type McpExecutionDesign = {
  schemaVersion: 1
  requirements: McpExecutionRequirement[]
  promptOverlays: Record<string, string>
  requirementContexts?: McpRequirementContext[]
  mcpAwareSubtasks: McpAwareSubtask[]
  normalizationErrors?: string[]
}

export type McpExecutionValidation = {
  status: McpValidationStatus
  runtimeEnforcement: typeof MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT
  health: Array<{
    mcpId: string
    installState: ProjectMcpStatus['installState'] | 'unknown'
    status: ProjectMcpStatus['status'] | 'unknown'
    enabled: boolean
    error: string | null
  }>
  blocked: string[]
  warnings: string[]
}

export type WorkPackageMcpBrokerCheck = {
  status: WorkPackageMcpBrokerStatus
  blocked: string[]
  warnings: string[]
  blockedReason: string | null
  retryable: boolean
  primaryMode?: McpAdmissionMode
  primaryRecoveryAction?: McpRecoveryAction
  evaluations: McpAdmissionEvaluation[]
  subtaskDecisions: McpWorkPackageAdmission['subtaskDecisions']
}

export type McpGrantDecisions = {
  schemaVersion: 1
  runtimeEnforcement: typeof MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT
  summary: Record<McpGrantDecisionStatus, number>
  decisions: Array<{
    requirementKey?: string
    decisionId: string
    sourceRequirementIndex: number
    agent: string
    mcpId: string
    capabilities: string[]
    requirement: McpRequirementLevel
    status: McpGrantDecisionStatus
    reason: string
    assignment: { type: McpAssignmentType; targetId: string | null }
    fallback: { action: McpFallbackAction; message: string }
    health: {
      schemaVersion?: 1
      observed?: boolean
      mcpId?: string
      installState: ProjectMcpStatus['installState'] | 'unknown'
      status: ProjectMcpStatus['status'] | 'unknown'
      enabled: boolean
      error: string | null
      checkedAt?: string | null
    }
    promptOverlayPresent: boolean
    admissionStatus?: McpAdmissionStatus
    mode?: McpAdmissionMode
    recoveryAction?: McpRecoveryAction
    grantState?: { phase: EffectiveGrantState['phase']; consumed?: boolean; revocationReason?: string }
    normalizedCapabilities?: string[]
    capabilityClasses?: Array<{ capability: string; class: string; deliveryKind: string | null }>
    evidenceRefs?: string[]
  }>
  admissionStatus?: McpWorkPackageAdmission['aggregate']['status']
  blocked?: string[]
  warnings?: string[]
  blockedReason?: string | null
  retryable?: boolean
  primaryMode?: McpAdmissionMode
  primaryRecoveryAction?: McpRecoveryAction
  evaluations?: McpAdmissionEvaluation[]
  subtaskDecisions?: McpWorkPackageAdmission['subtaskDecisions']
}

export type ParsedMcpExecutionDesign = { planText: string; design: McpExecutionDesign | null }

const FENCE_REGEX = new RegExp('```' + MCP_EXECUTION_DESIGN_FENCE + '\\s*\\n([\\s\\S]*?)[ \\t]*\\n?[ \\t]*```', 'i')

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : ''
}

function cleanTextArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => cleanText(item, maxLength)).filter(Boolean).slice(0, maxItems)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function cleanAgent(value: unknown): string | null {
  const agent = cleanText(value, 40).toLowerCase()
  return /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(agent) ? agent : null
}

function normalizeAssignment(raw: unknown): McpExecutionRequirement['assignment'] {
  const value = isRecord(raw) ? raw : {}
  const rawType = cleanText(value.type, 40)
  const type = ASSIGNMENT_TYPES.has(rawType) ? rawType as McpAssignmentType : 'agent'
  const targetAgents = [...new Set(cleanTextArray(value.targetAgents, 6, 40)
    .map(cleanAgent).filter((agent): agent is string => agent !== null))].sort()
  const targetId = cleanText(value.targetId, 80)
  return { type, targetAgents, targetId: targetId || null }
}

function normalizePolicyCapabilities(
  raw: unknown,
  input: { errors: string[]; label: string; maxItems: number; maxLength: number },
): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    input.errors.push(`${input.label} must be an array of capability strings.`)
    return []
  }
  if (raw.length > input.maxItems) {
    input.errors.push(`${input.label} exceeds the maximum of ${input.maxItems} entries and was truncated.`)
  }
  const capabilities: string[] = []
  raw.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      input.errors.push(`${input.label} item ${index} must be a non-empty string.`)
      return
    }
    const normalizedText = item.trim().replace(/\s+/g, ' ')
    if (normalizedText.length > input.maxLength) {
      input.errors.push(`${input.label} item ${index} exceeds the maximum length of ${input.maxLength}.`)
      return
    }
    capabilities.push(normalizeCapability(normalizedText))
  })
  return [...new Set(capabilities)].sort().slice(0, input.maxItems)
}

function normalizePermissions(raw: unknown, errors: string[], requirementIndex: number): Record<string, string[]> {
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    errors.push(`MCP requirement ${requirementIndex} agentPermissions must be a record.`)
    return {}
  }
  const result: Record<string, string[]> = {}
  for (const [rawAgent, rawCapabilities] of Object.entries(raw)) {
    const agent = cleanAgent(rawAgent)
    if (!agent) {
      errors.push(`MCP requirement ${requirementIndex} agentPermissions key '${rawAgent}' is invalid.`)
      continue
    }
    const capabilities = normalizePolicyCapabilities(rawCapabilities, {
      errors,
      label: `MCP requirement ${requirementIndex} permissions for '${agent}'`,
      maxItems: 20,
      maxLength: 80,
    })
    if (capabilities.length > 0) result[agent] = capabilities
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeFallback(raw: unknown): McpExecutionRequirement['fallback'] {
  const value = isRecord(raw) ? raw : {}
  const rawAction = cleanText(value.action, 40)
  const action = FALLBACK_ACTIONS.has(rawAction) ? rawAction as McpFallbackAction : 'ask_user'
  return {
    action,
    message: cleanText(value.message, 240) || 'Ask the user how to proceed before issuing MCP-backed work.',
  }
}

function normalizeRequirement(raw: unknown, sourceRequirementIndex: number, errors: string[]): McpExecutionRequirement | null {
  if (!isRecord(raw)) return null
  const mcpId = cleanText(raw.mcpId, 80).toLowerCase()
  if (!mcpId) return null
  return {
    requirementKey: '',
    sourceRequirementIndex,
    mcpId,
    requirement: raw.requirement === 'optional' ? 'optional' : 'required',
    reason: cleanText(raw.reason, 360),
    assignment: normalizeAssignment(raw.assignment),
    agentPermissions: normalizePermissions(raw.agentPermissions, errors, sourceRequirementIndex),
    prohibitedCapabilities: normalizePolicyCapabilities(raw.prohibitedCapabilities, {
      errors,
      label: `MCP requirement ${sourceRequirementIndex} prohibitedCapabilities`,
      maxItems: 30,
      maxLength: 100,
    }),
    fallback: normalizeFallback(raw.fallback),
  }
}

function requirementAgents(requirement: McpExecutionRequirement): string[] {
  const agents = new Set([...requirement.assignment.targetAgents, ...Object.keys(requirement.agentPermissions)])
  if (requirement.assignment.type === 'architect_only') agents.add('architect')
  if (requirement.assignment.type === 'reviewer_only') agents.add('reviewer')
  return [...agents].sort()
}

function requirementKey(requirement: McpExecutionRequirement): string {
  return requirement.requirementKey ?? `legacy-source-${requirement.sourceRequirementIndex ?? 0}-${requirement.mcpId}`
}

function requirementSourceIndex(requirement: McpExecutionRequirement): number {
  return requirement.sourceRequirementIndex ?? 0
}

function canonicalRequirementPolicy(requirement: McpExecutionRequirement): string {
  return JSON.stringify({
    schemaVersion: 1,
    mcpId: requirement.mcpId,
    requirement: requirement.requirement,
    assignment: {
      type: requirement.assignment.type,
      targetAgents: [...requirement.assignment.targetAgents].sort(),
      targetId: requirement.assignment.targetId,
    },
    permissions: Object.entries(requirement.agentPermissions).sort(([left], [right]) => left.localeCompare(right)),
    prohibitedCapabilities: [...requirement.prohibitedCapabilities].sort(),
    fallbackAction: requirement.fallback.action,
  })
}

function assignRequirementKeys(requirements: McpExecutionRequirement[]): void {
  const occurrences = new Map<string, number>()
  for (const requirement of requirements) {
    const canonical = canonicalRequirementPolicy(requirement)
    const occurrence = (occurrences.get(canonical) ?? 0) + 1
    occurrences.set(canonical, occurrence)
    const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 32)
    requirement.requirementKey = `mcp-requirement-v1-${digest}-${occurrence}`
  }
}

function normalizePromptOverlays(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const entries: Array<[string, string]> = []
  for (const [rawAgent, rawOverlay] of Object.entries(raw)) {
    const agent = cleanAgent(rawAgent)
    const overlay = cleanText(rawOverlay, 1000)
    if (agent && overlay) entries.push([agent, overlay])
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeRequirementContexts(
  value: Record<string, unknown>,
  requirements: McpExecutionRequirement[],
  promptOverlays: Record<string, string>,
): { contexts: McpRequirementContext[]; errors: string[] } {
  const contexts: McpRequirementContext[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  const rawContexts = Array.isArray(value.requirementContexts) ? value.requirementContexts : []
  for (let index = 0; index < rawContexts.length; index += 1) {
    const raw = isRecord(rawContexts[index]) ? rawContexts[index] : null
    const sourceIndex = raw?.sourceRequirementIndex
    const agent = cleanAgent(raw?.agent)
    const promptOverlay = cleanText(raw?.promptOverlay, 1000)
    const requirement = typeof sourceIndex === 'number' && Number.isSafeInteger(sourceIndex) && sourceIndex >= 0
      ? requirements.find((item) => item.sourceRequirementIndex === sourceIndex)
      : null
    if (!requirement || !agent || !requirementAgents(requirement).includes(agent) || !promptOverlay) {
      errors.push(`MCP requirement context ${index} does not match a valid requirement assignment.`)
      continue
    }
    const identity = `${requirementKey(requirement)}\u0000${agent}`
    if (seen.has(identity)) {
      errors.push(`MCP requirement '${requirementKey(requirement)}' has duplicate prompt context for '${agent}'.`)
      continue
    }
    seen.add(identity)
    contexts.push({ requirementKey: requirementKey(requirement), sourceRequirementIndex: requirementSourceIndex(requirement), agent, mcpId: requirement.mcpId, promptOverlay })
  }
  if (rawContexts.length === 0) {
    for (const [agent, promptOverlay] of Object.entries(promptOverlays)) {
      const candidates = requirements.filter((requirement) =>
        requirementAgents(requirement).includes(agent) && mcpDeliveryKind(requirement.mcpId) === 'planning_context_only')
      if (candidates.length === 1) {
        const requirement = candidates[0]
        contexts.push({ requirementKey: requirementKey(requirement), sourceRequirementIndex: requirementSourceIndex(requirement), agent, mcpId: requirement.mcpId, promptOverlay })
      } else if (candidates.length > 1) {
        errors.push(`Legacy MCP prompt overlay for '${agent}' is ambiguous across ${candidates.length} requirements; use requirementContexts.`)
      }
    }
  }
  return { contexts, errors }
}

function normalizeSubtask(raw: unknown, requirements: McpExecutionRequirement[], errors: string[]): McpAwareSubtask | null {
  if (!isRecord(raw)) return null
  const id = cleanText(raw.id, 80)
  const agent = cleanAgent(raw.agent)
  if (!id || !agent) return null
  const mcpCapabilities = [...new Set(cleanTextArray(raw.mcpCapabilities, 30, 100).map(normalizeCapability))]
  const capabilityBindings: Array<{ capability: string; requirementKey: string }> = []
  const requirementCoversCapability = (requirement: McpExecutionRequirement, capability: string): boolean => {
    const capabilityKeys = new Set(coverageKeysForGrant(capability))
    return requirement.mcpId === capabilityMcpId(capability) &&
      requirementAgents(requirement).includes(agent) &&
      (requirement.agentPermissions[agent] ?? []).some((permission) =>
        coverageKeysForGrant(permission).some((key) => capabilityKeys.has(key)),
      )
  }
  if (Object.hasOwn(raw, 'capabilityRequirements')) {
    if (!Array.isArray(raw.capabilityRequirements)) {
      errors.push(`MCP-aware subtask '${id}' capabilityRequirements must be an array when present.`)
    } else for (let index = 0; index < raw.capabilityRequirements.length; index += 1) {
      const rawBinding = isRecord(raw.capabilityRequirements[index]) ? raw.capabilityRequirements[index] : null
      const capability = normalizeCapability(cleanText(rawBinding?.capability, 100))
      const sourceIndex = rawBinding?.sourceRequirementIndex
      const requirement = typeof sourceIndex === 'number' && Number.isSafeInteger(sourceIndex) && sourceIndex >= 0
        ? requirements.find((item) => item.sourceRequirementIndex === sourceIndex)
        : null
      if (!requirement || !mcpCapabilities.includes(capability) || !requirementCoversCapability(requirement, capability)) {
        errors.push(`MCP-aware subtask '${id}' capability binding ${index} is invalid.`)
        continue
      }
      capabilityBindings.push({ capability, requirementKey: requirementKey(requirement) })
    }
    if (Array.isArray(raw.capabilityRequirements)) {
      for (const capability of mcpCapabilities) {
        const count = capabilityBindings.filter((binding) => binding.capability === capability).length
        if (count !== 1) {
          errors.push(`MCP-aware subtask '${id}' capability '${capability}' must have exactly one requirement binding.`)
        }
      }
    }
  } else {
    for (const capability of mcpCapabilities) {
      const candidates = requirements.filter((requirement) =>
        requirementCoversCapability(requirement, capability),
      )
      if (candidates.length === 1) capabilityBindings.push({ capability, requirementKey: requirementKey(candidates[0]) })
    }
  }
  return {
    id,
    agent,
    dependsOn: cleanTextArray(raw.dependsOn, 20, 80),
    mcpCapabilities,
    capabilityBindings,
    inputs: cleanTextArray(raw.inputs, 20, 120),
    outputs: cleanTextArray(raw.outputs, 20, 120),
    verification: cleanTextArray(raw.verification, 20, 160),
    stoppingCondition: cleanText(raw.stoppingCondition, 240),
    fallback: cleanText(raw.fallback, 240),
  }
}

function normalizeDesign(parsed: unknown): McpExecutionDesign | null {
  if (!isMcpExecutionDesignShape(parsed)) return null
  const value = parsed as Record<string, unknown>
  const normalizationErrors: string[] = []
  const requirements = Array.isArray(value.requirements)
    ? value.requirements.map((raw, index) => {
        const requirement = normalizeRequirement(raw, index, normalizationErrors)
        if (!requirement) normalizationErrors.push(`MCP requirement ${index} is malformed and cannot be normalized.`)
        return requirement
      }).filter((item): item is McpExecutionRequirement => item !== null).slice(0, 20)
    : (normalizationErrors.push('MCP requirements must be an array.'), [])
  if (Array.isArray(value.requirements) && value.requirements.length > 20) {
    normalizationErrors.push('MCP requirements exceed the maximum of 20 entries and were truncated.')
  }
  assignRequirementKeys(requirements)
  const promptOverlays = normalizePromptOverlays(value.promptOverlays)
  const normalizedContexts = normalizeRequirementContexts(value, requirements, promptOverlays)
  normalizationErrors.push(
    ...normalizedContexts.errors,
    ...requirements
      .filter((requirement) => requirementAgents(requirement).length === 0)
      .map((requirement) => `MCP '${requirement.mcpId}' requirement does not target any valid agent.`),
  )
  const mcpAwareSubtasks = Array.isArray(value.mcpAwareSubtasks)
    ? value.mcpAwareSubtasks.map((subtask, index) => {
        const normalized = normalizeSubtask(subtask, requirements, normalizationErrors)
        if (!normalized) normalizationErrors.push(`MCP-aware subtask ${index} is malformed and cannot be normalized.`)
        return normalized
      }).filter((item): item is McpAwareSubtask => item !== null).slice(0, 40)
    : (normalizationErrors.push('MCP-aware subtasks must be an array.'), [])
  if (Array.isArray(value.mcpAwareSubtasks) && value.mcpAwareSubtasks.length > 40) {
    normalizationErrors.push('MCP-aware subtasks exceed the maximum of 40 entries and were truncated.')
  }
  return { schemaVersion: 1, requirements, promptOverlays, requirementContexts: normalizedContexts.contexts, mcpAwareSubtasks, normalizationErrors }
}

export function parseMcpExecutionDesign(rawText: string): ParsedMcpExecutionDesign {
  const match = findFence(rawText, FENCE_REGEX, isMcpExecutionDesignShape)
  if (!match) return { planText: rawText.trim(), design: null }
  let design: McpExecutionDesign | null = null
  try { design = normalizeDesign(JSON.parse(match.jsonBlock)) } catch { design = null }
  return { planText: rawText.replace(match.fullMatch, '').trim(), design }
}

function statusFor(overview: ProjectMcpOverview | null | undefined, mcpId: string): ProjectMcpStatus | null {
  return overview?.statuses.find((status) => status.mcpId === mcpId) ?? null
}

function requirementEntry(requirement: McpExecutionRequirement, agent: string): Record<string, unknown> {
  return {
    requirementKey: requirementKey(requirement),
    sourceRequirementIndex: requirementSourceIndex(requirement),
    agent,
    mcpId: requirement.mcpId,
    requirement: requirement.requirement,
    reason: requirement.reason,
    assignment: { type: requirement.assignment.type, targetId: requirement.assignment.targetId },
    permissions: requirement.agentPermissions[agent] ?? [],
    prohibitedCapabilities: requirement.prohibitedCapabilities,
    fallback: requirement.fallback,
  }
}

function admissionForAgent(design: McpExecutionDesign, agent: string, overview: ProjectMcpOverview): McpWorkPackageAdmission {
  const requirements = design.requirements.filter((requirement) => requirementAgents(requirement).includes(agent))
  const contexts = new Set((design.requirementContexts ?? []).filter((context) => context.agent === agent).map((context) => `${context.requirementKey}\u0000${context.mcpId}`))
  return admitWorkPackageMcp({
    entries: requirements.map((requirement) => requirementEntry(requirement, agent)),
    subtasks: design.mcpAwareSubtasks.filter((subtask) => subtask.agent === agent),
    label: `${agent} work package`,
    statusFor: (mcpId) => statusFor(overview, mcpId),
    effectiveGrantFor: ({ requiredCapabilities }) => readEffectiveGrantState(
      { metadata: {} },
      { mcpConfig: overview.config },
      requiredCapabilities,
    ),
    hasPromptOnlyContextFor: ({ requirementKey, mcpId }) => contexts.has(`${requirementKey}\u0000${mcpId}`),
  })
}

const RECOVERY_PRECEDENCE: McpRecoveryAction[] = ['revise_plan', 'approve_project_filesystem_context', 'install_or_fix_mcp', 'defer_live_mcp_feature', 'continue_as_prompt_context']

function combinedDesignAdmission(design: McpExecutionDesign, overview: ProjectMcpOverview): McpWorkPackageAdmission {
  const agents = [...new Set(design.requirements.flatMap(requirementAgents).concat(design.mcpAwareSubtasks.map((subtask) => subtask.agent)))].sort()
  const admissions = agents.map((agent) => admissionForAgent(design, agent, overview))
  const evaluations = admissions.flatMap((admission) => admission.evaluations)
  const subtaskDecisions = admissions.flatMap((admission) => admission.subtaskDecisions)
  const normalizationErrors = design.normalizationErrors ?? []
  const blocked = [...new Set(admissions.flatMap((admission) => admission.aggregate.blocked).concat(normalizationErrors))]
  const warnings = [...new Set(admissions.flatMap((admission) => admission.aggregate.warnings))]
  const blockingAdmissions = admissions.filter((admission) => admission.aggregate.blocked.length > 0)
  const primary = blockingAdmissions
    .filter((admission) => admission.aggregate.primaryRecoveryAction)
    .sort((left, right) => RECOVERY_PRECEDENCE.indexOf(left.aggregate.primaryRecoveryAction as McpRecoveryAction) - RECOVERY_PRECEDENCE.indexOf(right.aggregate.primaryRecoveryAction as McpRecoveryAction))[0]
  return {
    schemaVersion: 2,
    evaluations,
    subtaskDecisions,
    referencedHealth: [...new Map(admissions.flatMap((admission) => admission.referencedHealth).map((health) => [health.mcpId, health])).values()].sort((left, right) => left.mcpId.localeCompare(right.mcpId)),
    aggregate: {
      status: blocked.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'allowed',
      blocked,
      warnings,
      blockedReason: blocked.length > 0 ? `MCP/capability broker blocked "MCP execution design": ${blocked.join('; ')}` : null,
      retryable: blocked.length > 0 && normalizationErrors.length === 0 && blockingAdmissions.every((admission) => admission.aggregate.retryable),
      ...(primary?.aggregate.primaryMode ? { primaryMode: primary.aggregate.primaryMode } : {}),
      ...(primary?.aggregate.primaryRecoveryAction ? { primaryRecoveryAction: primary.aggregate.primaryRecoveryAction } : {}),
    },
  }
}

export function validateMcpExecutionDesign(design: McpExecutionDesign | null, overview: ProjectMcpOverview): McpExecutionValidation {
  if (!design) return { status: 'warnings', runtimeEnforcement: MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT, health: [], blocked: [], warnings: ['Architect did not provide a machine-readable MCP execution design.'] }
  return admissionToValidation(combinedDesignAdmission(design, overview))
}

export function deriveMcpGrantDecisions(design: McpExecutionDesign | null, overview: ProjectMcpOverview): McpGrantDecisions {
  if (!design) return { schemaVersion: 1, runtimeEnforcement: MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT, summary: { proposed: 0, warning: 0, blocked: 0 }, decisions: [] }
  const admission = combinedDesignAdmission(design, overview)
  for (const evaluation of admission.evaluations) {
    evaluation.decision.grantState ??= { phase: 'not_issued' }
  }
  return admissionToGrantPreview(admission)
}

function metadataGrants(metadata: unknown): Record<string, unknown>[] {
  return isRecord(metadata) ? objectArray(metadata.mcpGrants) : []
}

function brokerEntries(input: { assignedRole?: string; mcpRequirements?: unknown; metadata?: unknown }): Record<string, unknown>[] {
  const fallbackAgent = cleanAgent(input.assignedRole) ?? 'unknown'
  const currentSchema = isRecord(input.metadata) && input.metadata.mcpGrantsSchemaVersion === 2
  return [...objectArray(input.mcpRequirements), ...metadataGrants(input.metadata)].map((entry) =>
    currentSchema || Object.hasOwn(entry, 'agent') || Object.hasOwn(entry, 'requirementKey')
      ? entry
      : { ...entry, agent: fallbackAgent })
}

function brokerSubtasks(metadata: unknown, assignedRole?: string): Record<string, unknown>[] {
  const fallbackAgent = cleanAgent(assignedRole) ?? 'unknown'
  const currentSchema = isRecord(metadata) && metadata.mcpGrantsSchemaVersion === 2
  return (isRecord(metadata) ? objectArray(metadata.mcpAwareSubtasks) : []).map((subtask) =>
    currentSchema || Object.hasOwn(subtask, 'agent') || Object.hasOwn(subtask, 'capabilityBindings')
      ? subtask
      : { ...subtask, agent: fallbackAgent })
}

function brokerNormalizationErrors(metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.mcpNormalizationErrors)) return []
  return [...new Set(metadata.mcpNormalizationErrors
    .map((error) => cleanText(error, 500))
    .filter((error) => error !== ''))]
}

function brokerSchemaErrors(input: { mcpRequirements?: unknown; metadata?: unknown }): string[] {
  if (!isRecord(input.metadata) || input.metadata.mcpGrantsSchemaVersion !== 2) return []
  const errors: string[] = []
  if (Object.hasOwn(input.metadata, 'mcpNormalizationErrors')) {
    if (!Array.isArray(input.metadata.mcpNormalizationErrors)) {
      errors.push('MCP schema v2 normalization errors must be stored as an array.')
    } else if (input.metadata.mcpNormalizationErrors.some((error) => cleanText(error, 500) === '')) {
      errors.push('MCP schema v2 normalization errors must contain only non-empty strings.')
    }
  }
  const policyEntries = Array.isArray(input.mcpRequirements) ? input.mcpRequirements : []
  if (input.mcpRequirements !== undefined && !Array.isArray(input.mcpRequirements)) {
    errors.push('MCP schema v2 policies must be stored as an array.')
  }
  policyEntries.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`MCP schema v2 policy ${index} must be a record.`)
      return
    }
    if (cleanText(value.requirementKey, 200) === '') {
      errors.push(`MCP schema v2 policy ${index} must persist a requirementKey.`)
    }
    if (cleanAgent(value.agent) === null) {
      errors.push(`MCP schema v2 policy ${index} must persist an explicit agent identity.`)
    }
  })
  const grants = Array.isArray(input.metadata.mcpGrants) ? input.metadata.mcpGrants : []
  if (Object.hasOwn(input.metadata, 'mcpGrants') && !Array.isArray(input.metadata.mcpGrants)) {
    errors.push('MCP schema v2 grant envelopes must be stored as an array.')
  }
  grants.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`MCP schema v2 grant envelope ${index} must be a record.`)
      return
    }
    if (cleanText(value.requirementKey, 200) === '') {
      errors.push(`MCP schema v2 grant envelope ${index} must persist a requirementKey.`)
    }
    if (cleanAgent(value.agent) === null) {
      errors.push(`MCP schema v2 grant envelope ${index} must persist an explicit agent identity.`)
    }
  })
  const subtasks = Array.isArray(input.metadata.mcpAwareSubtasks) ? input.metadata.mcpAwareSubtasks : []
  if (Object.hasOwn(input.metadata, 'mcpAwareSubtasks') && !Array.isArray(input.metadata.mcpAwareSubtasks)) {
    errors.push('MCP schema v2 subtasks must be stored as an array.')
  }
  subtasks.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`MCP schema v2 subtask ${index} must be a record.`)
      return
    }
    if (cleanAgent(value.agent) === null) {
      errors.push(`MCP schema v2 subtask ${index} must persist an explicit agent identity.`)
    }
    if (!Array.isArray(value.capabilityBindings)) {
      errors.push(`MCP schema v2 subtask ${index} must persist explicit capabilityBindings.`)
    }
  })
  const contexts = Array.isArray(input.metadata.requirementContexts) ? input.metadata.requirementContexts : []
  if (Object.hasOwn(input.metadata, 'requirementContexts') && !Array.isArray(input.metadata.requirementContexts)) {
    errors.push('MCP schema v2 requirement contexts must be stored as an array.')
  }
  contexts.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`MCP schema v2 requirement context ${index} must be a record.`)
      return
    }
    if (
      cleanText(value.requirementKey, 200) === '' ||
      cleanAgent(value.agent) === null ||
      cleanText(value.mcpId, 80) === '' ||
      cleanText(value.promptOverlay, 2_000) === ''
    ) {
      errors.push(`MCP schema v2 requirement context ${index} must persist complete scoped evidence.`)
    }
  })
  if (
    cleanText(input.metadata.promptOverlay, 2_000) !== '' &&
    contexts.length === 0
  ) {
    errors.push('MCP schema v2 prompt context must be scoped by requirement identity.')
  }
  return [...new Set(errors)]
}

function brokerHasPromptInstructions(metadata: unknown): boolean {
  return isRecord(metadata) && (
    cleanText(metadata.promptOverlay, 200) !== '' ||
    objectArray(metadata.requirementContexts).length > 0 ||
    brokerSubtasks(metadata).length > 0 ||
    brokerNormalizationErrors(metadata).length > 0
  )
}

export function hasWorkPackageMcpRuntimeInputs(input: { harnessToolPolicy?: unknown; mcpRequirements?: unknown; metadata?: unknown }): boolean {
  return brokerEntries(input).length > 0 || brokerHasPromptInstructions(input.metadata) || brokerSchemaErrors(input).length > 0
}

function brokerHasPromptContext(metadata: unknown, entry: { requirementKey: string; agent: string; mcpId: string }, entries: Record<string, unknown>[]): boolean {
  const meta = isRecord(metadata) ? metadata : {}
  if (objectArray(meta.requirementContexts).some((context) =>
    context.requirementKey === entry.requirementKey &&
    context.agent === entry.agent &&
    context.mcpId === entry.mcpId &&
    cleanText(context.promptOverlay, 2_000) !== '',
  )) return true
  const rawPolicies = entries.filter((candidate) => !Object.hasOwn(candidate, 'decisionId'))
  const legacyCandidates = rawPolicies.filter((candidate) => cleanText(candidate.mcpId, 80) === entry.mcpId && mcpDeliveryKind(entry.mcpId) === 'planning_context_only')
  return !Object.hasOwn(rawPolicies.find((candidate) => candidate.requirementKey === entry.requirementKey) ?? {}, 'requirementKey') && legacyCandidates.length === 1 && cleanText(meta.promptOverlay, 2_000) !== ''
}

export type WorkPackageMcpAdmissionInput = {
  assignedRole?: string
  harnessToolPolicy?: unknown
  mcpOverview?: ProjectMcpOverview | null
  mcpRequirements?: unknown
  metadata?: unknown
  projectMcpConfig?: unknown
  title?: string
}

export function admitWorkPackageMcpBroker(input: WorkPackageMcpAdmissionInput): McpWorkPackageAdmission {
  const entries = brokerEntries(input)
  const admission = admitWorkPackageMcp({
    entries,
    subtasks: brokerSubtasks(input.metadata, input.assignedRole),
    label: cleanText(input.title, 120) || cleanText(input.assignedRole, 80) || 'work package',
    statusFor: (mcpId) => statusFor(input.mcpOverview, mcpId),
    effectiveGrantFor: ({ requiredCapabilities }) => readEffectiveGrantState(
      { metadata: input.metadata },
      { mcpConfig: input.projectMcpConfig ?? {} },
      requiredCapabilities,
    ),
    hasPromptOnlyContextFor: (entry) => brokerHasPromptContext(input.metadata, entry, entries),
  })
  const normalizationErrors = [
    ...brokerNormalizationErrors(input.metadata),
    ...brokerSchemaErrors(input),
  ]
  if (normalizationErrors.length === 0) return admission
  const blocked = [...new Set([...admission.aggregate.blocked, ...normalizationErrors])]
  return {
    ...admission,
    aggregate: {
      ...admission.aggregate,
      status: 'blocked',
      blocked,
      blockedReason: `MCP/capability broker blocked "${cleanText(input.title, 120) || cleanText(input.assignedRole, 80) || 'work package'}": ${blocked.join('; ')}`,
      retryable: false,
      primaryMode: 'blocked',
      primaryRecoveryAction: 'revise_plan',
    },
  }
}

export function evaluateWorkPackageMcpBroker(input: WorkPackageMcpAdmissionInput): WorkPackageMcpBrokerCheck {
  const admission = admitWorkPackageMcpBroker(input)
  return admissionToBrokerCheck(admission)
}
