import { createHash } from 'crypto'
import { MCP_EXECUTION_DESIGN_FENCE, findFence, isMcpExecutionDesignShape } from '@/lib/plan-fences'
import { canonicalAgentPackageIdentity } from '@/lib/mcps/agent-package-identity'
import {
  capabilityMcpId,
  coverageKeysForGrant,
  mcpDeliveryKind,
  normalizeCapability,
  REQUIREMENT_CAPABILITY_FIELDS,
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
  type McpPrimaryBlockingDecision,
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
export type McpPlanningConfidence = 'low' | 'medium' | 'high'
export type McpPlanningScope = { kind: 'project' }
export const MCP_PLANNING_ACCESS_MODE = 'planning_instruction' as const

export type McpExecutionRequirement = {
  requirementKey?: string
  sourceRequirementIndex?: number
  mcpId: string
  requirement: McpRequirementLevel
  reason: string
  confidence?: McpPlanningConfidence
  scope?: McpPlanningScope
  accessMode?: typeof MCP_PLANNING_ACCESS_MODE
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
  scope?: McpPlanningScope
  accessMode?: typeof MCP_PLANNING_ACCESS_MODE
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
  normalizationEvidence?: McpNormalizationEvidence[]
}

export type McpNormalizationEvidence = {
  schemaVersion: 1
  category: 'parse' | 'shape' | 'normalization'
  code: string
  message: string
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
  primaryDecision?: McpPrimaryBlockingDecision
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
  primaryDecision?: McpPrimaryBlockingDecision
  evaluations?: McpAdmissionEvaluation[]
  subtaskDecisions?: McpWorkPackageAdmission['subtaskDecisions']
}

export type ParsedMcpExecutionDesign = { planText: string; design: McpExecutionDesign | null }

const FENCE_REGEX = new RegExp('```' + MCP_EXECUTION_DESIGN_FENCE + '\\s*\\n([\\s\\S]*?)[ \\t]*\\n?[ \\t]*```', 'i')

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MAX_AGENT_IDENTITY_LENGTH = 40
const MAX_REQUIREMENTS = 20
const MAX_REQUIREMENT_CONTEXTS = 120
const MAX_MCP_AWARE_SUBTASKS = 40
const MAX_CAPABILITY_REQUIREMENTS = 30
const MAX_PROMPT_OVERLAYS = 40
const MAX_AGENT_PERMISSIONS = 6
const MAX_BROKER_POLICIES = 40
const MAX_BROKER_GRANTS = 40
const MAX_BROKER_NORMALIZATION_ITEMS = 200
const MAX_BROKER_NESTED_ITEMS = 30
const MAX_EXECUTOR_PROMPT_OVERLAY_LENGTH = 2_000

function normalizeExecutorPromptOverlay(values: readonly unknown[]): string {
  return values
    .filter((value): value is string => typeof value === 'string')
    .join('\n\n')
    .trim()
    .replace(/\s+/g, ' ')
}

function strictText(
  value: unknown,
  maxLength: number,
  options: { allowEmpty?: boolean } = {},
): { valid: boolean; value: string } {
  if (typeof value !== 'string') return { valid: false, value: '' }
  const trimmed = value.trim()
  if ((!options.allowEmpty && trimmed === '') || value.length > maxLength || trimmed.length > maxLength) {
    return { valid: false, value: '' }
  }
  const normalized = trimmed.replace(/\s+/g, ' ')
  return normalized.length <= maxLength
    ? { valid: true, value: normalized }
    : { valid: false, value: '' }
}

function strictTextArray(
  raw: unknown,
  input: { errors: string[]; label: string; maxItems: number; maxLength: number },
): { valid: boolean; values: string[] } {
  if (!Array.isArray(raw)) {
    input.errors.push(`${input.label} must be an array of strings.`)
    return { valid: false, values: [] }
  }
  if (raw.length > input.maxItems) {
    input.errors.push(`${input.label} exceeds the maximum raw count of ${input.maxItems}; the entire field was rejected.`)
    return { valid: false, values: [] }
  }
  let valid = true
  const values = raw.map((value, index) => {
    const normalized = strictText(value, input.maxLength)
    if (!normalized.valid) {
      input.errors.push(`${input.label} item ${index} must be a bounded non-empty string.`)
      valid = false
    }
    return normalized.value
  })
  return { valid, values: valid ? values : [] }
}

function normalizedAgentText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const agent = value.trim().toLowerCase()
  return agent !== '' ? agent : null
}

function cleanAgent(value: unknown): string | null {
  const agent = normalizedAgentText(value)
  if (
    !agent ||
    agent.length > MAX_AGENT_IDENTITY_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(agent)
  ) return null
  return agent
}

function boundedAgentCollisionIdentity(value: unknown): string | null {
  const agent = normalizedAgentText(value)
  if (!agent) return null
  const bounded = agent.slice(0, MAX_AGENT_IDENTITY_LENGTH)
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(bounded)) return null
  return canonicalAgentPackageIdentity(bounded)
}

function normalizeAssignment(
  raw: unknown,
  errors: string[],
  requirementIndex: number,
): { assignment: McpExecutionRequirement['assignment']; valid: boolean } {
  const value = isRecord(raw) ? raw : {}
  let assignmentInvalid = false
  if (!isRecord(raw)) {
    errors.push(`MCP requirement ${requirementIndex} assignment must be a record.`)
    assignmentInvalid = true
  }
  const rawType = strictText(value.type, 40)
  if (!rawType.valid || !ASSIGNMENT_TYPES.has(rawType.value)) {
    errors.push(`MCP requirement ${requirementIndex} assignment type must be an exact supported enum value.`)
    assignmentInvalid = true
  }
  const type = ASSIGNMENT_TYPES.has(rawType.value) ? rawType.value as McpAssignmentType : 'agent'
  const rawTargetAgents = value.targetAgents
  if (!Array.isArray(rawTargetAgents)) {
    errors.push(`MCP requirement ${requirementIndex} assignment targetAgents must be an array of agent identities; the assignment was rejected.`)
    assignmentInvalid = true
  }
  const targetValues = Array.isArray(rawTargetAgents) && rawTargetAgents.length <= 6 ? rawTargetAgents : []
  if (Array.isArray(rawTargetAgents) && rawTargetAgents.length > 6) {
    errors.push(`MCP requirement ${requirementIndex} assignment targetAgents exceeds the maximum raw count of 6; the assignment was rejected.`)
    assignmentInvalid = true
  }

  const normalizedTargetAgents: string[] = []
  const collisionGroups = new Map<string, Set<string>>()
  targetValues.forEach((rawAgent, index) => {
    const normalized = normalizedAgentText(rawAgent)
    const agent = cleanAgent(rawAgent)
    if (!agent) {
      errors.push(`MCP requirement ${requirementIndex} assignment targetAgents item ${index} must be an exact agent identity no longer than ${MAX_AGENT_IDENTITY_LENGTH} characters; the assignment was rejected.`)
      assignmentInvalid = true
    } else {
      normalizedTargetAgents.push(agent)
    }
    const collisionIdentity = boundedAgentCollisionIdentity(rawAgent)
    if (collisionIdentity && normalized) {
      const candidates = collisionGroups.get(collisionIdentity) ?? new Set<string>()
      candidates.add(normalized)
      collisionGroups.set(collisionIdentity, candidates)
    }
  })
  for (const [, candidates] of [...collisionGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (candidates.size <= 1) continue
    errors.push(`MCP requirement ${requirementIndex} assignment targetAgents contains colliding normalized identities; the assignment was rejected.`)
    assignmentInvalid = true
  }
  const canonicalCount = new Set(normalizedTargetAgents.map(canonicalAgentPackageIdentity)).size
  if (canonicalCount > 6) {
    errors.push(`MCP requirement ${requirementIndex} assignment targetAgents exceeds the maximum of 6 canonical package identities; the assignment was rejected.`)
    assignmentInvalid = true
  }
  const targetAgents = assignmentInvalid ? [] : [...new Set(normalizedTargetAgents)].sort()
  const rawTargetId = value.targetId
  const targetId = rawTargetId === null || rawTargetId === undefined
    ? { valid: true, value: '' }
    : strictText(rawTargetId, 80)
  if (!targetId.valid) {
    errors.push(`MCP requirement ${requirementIndex} assignment targetId must be null or a bounded non-empty string.`)
    assignmentInvalid = true
  }
  return {
    assignment: { type, targetAgents: assignmentInvalid ? [] : targetAgents, targetId: targetId.value || null },
    valid: !assignmentInvalid,
  }
}

function normalizePolicyCapabilities(
  raw: unknown,
  input: { errors: string[]; label: string; maxItems: number; maxLength: number },
): { capabilities: string[]; valid: boolean } {
  if (raw === undefined) return { capabilities: [], valid: true }
  if (!Array.isArray(raw)) {
    input.errors.push(`${input.label} must be an array of capability strings.`)
    return { capabilities: [], valid: false }
  }
  let valid = true
  if (raw.length > input.maxItems) {
    input.errors.push(`${input.label} exceeds the maximum raw count of ${input.maxItems}; the entire capability policy was rejected.`)
    return { capabilities: [], valid: false }
  }
  const capabilities: string[] = []
  raw.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      input.errors.push(`${input.label} item ${index} must be a non-empty string.`)
      valid = false
      return
    }
    const normalizedText = item.trim().replace(/\s+/g, ' ')
    if (normalizedText.length > input.maxLength) {
      input.errors.push(`${input.label} item ${index} exceeds the maximum length of ${input.maxLength}.`)
      valid = false
      return
    }
    const capability = normalizeCapability(normalizedText)
    if (capability.length > input.maxLength) {
      input.errors.push(`${input.label} item ${index} exceeds the maximum normalized length of ${input.maxLength}.`)
      valid = false
      return
    }
    capabilities.push(capability)
  })
  const normalized = [...new Set(capabilities)].sort()
  if (normalized.length > input.maxItems) {
    input.errors.push(`${input.label} exceeds the maximum normalized count of ${input.maxItems}; the entire capability policy was rejected.`)
    valid = false
  }
  return { capabilities: valid ? normalized : [], valid }
}

function normalizePermissions(raw: unknown, errors: string[], requirementIndex: number): Record<string, string[]> {
  if (!isRecord(raw)) {
    errors.push(`MCP requirement ${requirementIndex} agentPermissions must be a record.`)
    return {}
  }
  if (Object.keys(raw).length > MAX_AGENT_PERMISSIONS) {
    errors.push(`MCP requirement ${requirementIndex} agentPermissions exceeds the maximum raw count of ${MAX_AGENT_PERMISSIONS}; no agent policy was materialized.`)
    return {}
  }
  const result: Record<string, string[]> = {}
  const groups = new Map<string, Array<{ agent: string | null; capabilities: string[]; valid: boolean }>>()
  for (const [rawAgent, rawCapabilities] of Object.entries(raw)) {
    const agent = cleanAgent(rawAgent)
    if (!agent) {
      errors.push(`MCP requirement ${requirementIndex} agentPermissions contains an invalid or overlong agent key.`)
    }
    const normalizedCapabilities = normalizePolicyCapabilities(rawCapabilities, {
      errors,
      label: `MCP requirement ${requirementIndex} agentPermissions capability list`,
      maxItems: 20,
      maxLength: 80,
    })
    const identity = boundedAgentCollisionIdentity(rawAgent) ?? `invalid-${groups.size}`
    const candidates = groups.get(identity) ?? []
    candidates.push({ agent, capabilities: normalizedCapabilities.capabilities, valid: normalizedCapabilities.valid })
    groups.set(identity, candidates)
  }
  for (const [, candidates] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (candidates.length > 1) {
      errors.push(`MCP requirement ${requirementIndex} agentPermissions contains colliding normalized keys; no policy was materialized for that package.`)
      continue
    }
    const candidate = candidates[0]
    if (!candidate.agent || !candidate.valid || candidate.capabilities.length === 0) continue
    result[candidate.agent] = candidate.capabilities
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeFallback(
  raw: unknown,
  errors: string[],
  requirementIndex: number,
): { fallback: McpExecutionRequirement['fallback']; valid: boolean } {
  const value = isRecord(raw) ? raw : {}
  let valid = isRecord(raw)
  if (!valid) errors.push(`MCP requirement ${requirementIndex} fallback must be a record.`)
  const rawAction = strictText(value.action, 40)
  if (!rawAction.valid || !FALLBACK_ACTIONS.has(rawAction.value)) {
    errors.push(`MCP requirement ${requirementIndex} fallback action must be an exact supported enum value.`)
    valid = false
  }
  const message = strictText(value.message, 240, { allowEmpty: true })
  if (!message.valid) {
    errors.push(`MCP requirement ${requirementIndex} fallback message must be a bounded string.`)
    valid = false
  }
  const action = FALLBACK_ACTIONS.has(rawAction.value) ? rawAction.value as McpFallbackAction : 'ask_user'
  return {
    fallback: {
      action,
      message: message.value || 'Ask the user how to proceed before issuing MCP-backed work.',
    },
    valid,
  }
}

function normalizeRequirement(raw: unknown, sourceRequirementIndex: number, errors: string[]): McpExecutionRequirement | null {
  if (!isRecord(raw)) return null
  const localErrors: string[] = []
  const mcpId = strictText(raw.mcpId, 80)
  if (!mcpId.valid || !/^[a-z0-9][a-z0-9_-]*$/i.test(mcpId.value)) {
    localErrors.push(`MCP requirement ${sourceRequirementIndex} mcpId must be a bounded identifier string.`)
  }
  if (raw.requirement !== 'required' && raw.requirement !== 'optional') {
    localErrors.push(`MCP requirement ${sourceRequirementIndex} requirement must be the exact 'required' or 'optional' enum value.`)
  }
  const requirement = raw.requirement === 'optional' ? 'optional' : 'required'
  const reason = strictText(raw.reason, 360, { allowEmpty: true })
  if (!reason.valid) localErrors.push(`MCP requirement ${sourceRequirementIndex} reason must be a bounded string.`)
  const confidence: McpPlanningConfidence = raw.confidence === 'low' || raw.confidence === 'high'
    ? raw.confidence
    : 'medium'
  if (raw.confidence !== undefined && !['low', 'medium', 'high'].includes(String(raw.confidence))) {
    localErrors.push(`MCP requirement ${sourceRequirementIndex} confidence must be low, medium, or high.`)
  }
  if (raw.scope !== undefined && (!isRecord(raw.scope) || raw.scope.kind !== 'project')) {
    localErrors.push(`MCP requirement ${sourceRequirementIndex} scope must be project-scoped.`)
  }
  if (raw.accessMode !== undefined && raw.accessMode !== MCP_PLANNING_ACCESS_MODE) {
    localErrors.push(`MCP requirement ${sourceRequirementIndex} accessMode must be planning_instruction.`)
  }
  const normalizedAssignment = normalizeAssignment(raw.assignment, localErrors, sourceRequirementIndex)
  const normalizedPermissions = normalizePermissions(raw.agentPermissions, localErrors, sourceRequirementIndex)
  const prohibitedCapabilities = normalizePolicyCapabilities(raw.prohibitedCapabilities, {
    errors: localErrors,
    label: `MCP requirement ${sourceRequirementIndex} prohibitedCapabilities`,
    maxItems: 30,
    maxLength: 100,
  })
  if (!Array.isArray(raw.prohibitedCapabilities)) {
    localErrors.push(`MCP requirement ${sourceRequirementIndex} prohibitedCapabilities must be present as an array.`)
  }
  const fallback = normalizeFallback(raw.fallback, localErrors, sourceRequirementIndex)
  errors.push(...localErrors)
  if (
    localErrors.length > 0 ||
    !mcpId.valid ||
    !normalizedAssignment.valid ||
    !prohibitedCapabilities.valid ||
    !fallback.valid
  ) return null
  return {
    requirementKey: '',
    sourceRequirementIndex,
    mcpId: mcpId.value.toLowerCase(),
    requirement,
    reason: reason.value,
    confidence,
    scope: { kind: 'project' },
    accessMode: MCP_PLANNING_ACCESS_MODE,
    assignment: normalizedAssignment.assignment,
    // An invalid assignment is one rejected policy unit. Do not salvage an
    // agentPermissions subset that could give a different package access.
    agentPermissions: normalizedPermissions,
    prohibitedCapabilities: prohibitedCapabilities.capabilities,
    fallback: fallback.fallback,
  }
}

function requirementAgents(requirement: McpExecutionRequirement): string[] {
  const agents = new Set([...requirement.assignment.targetAgents, ...Object.keys(requirement.agentPermissions)])
  if (requirement.assignment.type === 'architect_only') agents.add('architect')
  if (requirement.assignment.type === 'reviewer_only') agents.add('reviewer')
  return [...agents].sort()
}

function permissionsForAgentPackage(requirement: McpExecutionRequirement, agent: string): string[] {
  const packageIdentity = canonicalAgentPackageIdentity(agent)
  return [...new Set(Object.entries(requirement.agentPermissions)
    .filter(([candidate]) => canonicalAgentPackageIdentity(candidate) === packageIdentity)
    .flatMap(([, capabilities]) => capabilities))].sort()
}

function requirementKey(requirement: McpExecutionRequirement): string {
  return requirement.requirementKey ?? `legacy-source-${requirement.sourceRequirementIndex ?? 0}-${requirement.mcpId}`
}

function requirementSourceIndex(requirement: McpExecutionRequirement): number {
  return requirement.sourceRequirementIndex ?? 0
}

function canonicalRequirementPolicy(requirement: McpExecutionRequirement): string {
  const canonicalPermissions = new Map<string, string[]>()
  for (const [agent, capabilities] of Object.entries(requirement.agentPermissions)) {
    const identity = canonicalAgentPackageIdentity(agent)
    canonicalPermissions.set(identity, [...new Set([...(canonicalPermissions.get(identity) ?? []), ...capabilities])].sort())
  }
  return JSON.stringify({
    schemaVersion: 1,
    mcpId: requirement.mcpId,
    requirement: requirement.requirement,
    assignment: {
      type: requirement.assignment.type,
      targetAgents: [...new Set(requirement.assignment.targetAgents.map(canonicalAgentPackageIdentity))].sort(),
      targetId: requirement.assignment.targetId,
    },
    permissions: [...canonicalPermissions.entries()].sort(([left], [right]) => left.localeCompare(right)),
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

function normalizePromptOverlays(raw: unknown, errors: string[]): Record<string, string> {
  if (!isRecord(raw)) {
    errors.push('MCP promptOverlays must be a record.')
    return {}
  }
  if (Object.keys(raw).length > MAX_PROMPT_OVERLAYS) {
    errors.push(`MCP promptOverlays exceeds the maximum raw count of ${MAX_PROMPT_OVERLAYS}; no overlay was materialized.`)
    return {}
  }
  const groups = new Map<string, Array<{
    agent: string | null
    overlay: string | null
    rawOverlayIdentity: string | null
  }>>()
  for (const [rawAgent, rawOverlay] of Object.entries(raw)) {
    const cleanedAgent = cleanAgent(rawAgent)
    const agent = cleanedAgent ? canonicalAgentPackageIdentity(cleanedAgent) : null
    const rawOverlayIdentity = typeof rawOverlay === 'string' ? rawOverlay.trim() : ''
    const normalizedOverlay = rawOverlayIdentity.replace(/\s+/g, ' ')
    const overlay = rawOverlayIdentity !== '' && rawOverlayIdentity.length <= 1000 && normalizedOverlay.length <= 1000
      ? normalizedOverlay
      : null
    if (!agent) errors.push('Legacy MCP prompt overlays contain an invalid or overlong agent key.')
    if (!overlay) errors.push('Legacy MCP prompt overlays contain a non-string, empty, or overlong overlay value.')
    const identity = boundedAgentCollisionIdentity(rawAgent) ?? `invalid-${groups.size}`
    const candidates = groups.get(identity) ?? []
    candidates.push({
      agent,
      overlay,
      rawOverlayIdentity: overlay ? rawOverlayIdentity : null,
    })
    groups.set(identity, candidates)
  }
  const overlays = new Map<string, string>()
  for (const [, candidates] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (candidates.length > 1) {
      const values = new Set(candidates
        .map((candidate) => candidate.rawOverlayIdentity)
        .filter((value): value is string => value !== null))
      const identicalValidValues = candidates.every((candidate) => (
        candidate.agent !== null &&
        candidate.overlay !== null &&
        candidate.rawOverlayIdentity !== null
      )) && values.size === 1
      if (!identicalValidValues) {
        errors.push('Legacy MCP prompt overlays contain distinct colliding normalized keys or values; no context was materialized.')
        continue
      }
    }
    const candidate = candidates[0]
    if (candidate.agent && candidate.overlay) overlays.set(candidate.agent, candidate.overlay)
  }
  return Object.fromEntries([...overlays.entries()].sort(([left], [right]) => left.localeCompare(right)))
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
  if (rawContexts.length > MAX_REQUIREMENT_CONTEXTS) {
    return {
      contexts: [],
      errors: [`MCP requirementContexts exceeds the maximum raw count of ${MAX_REQUIREMENT_CONTEXTS}; no requirement context was materialized.`],
    }
  }
  for (let index = 0; index < rawContexts.length; index += 1) {
    const raw = isRecord(rawContexts[index]) ? rawContexts[index] : null
    const sourceIndex = raw?.sourceRequirementIndex
    const cleanedAgent = cleanAgent(raw?.agent)
    const agent = cleanedAgent ? canonicalAgentPackageIdentity(cleanedAgent) : null
    const promptOverlay = strictText(raw?.promptOverlay, 1000)
    const requirement = typeof sourceIndex === 'number' && Number.isSafeInteger(sourceIndex) && sourceIndex >= 0
      ? requirements.find((item) => item.sourceRequirementIndex === sourceIndex)
      : null
    if (!raw || !requirement || !agent || !promptOverlay.valid || !requirementAgents(requirement).some(
      (candidate) => canonicalAgentPackageIdentity(candidate) === agent,
    )) {
      errors.push(`MCP requirement context ${index} does not match a valid requirement assignment.`)
      continue
    }
    const identity = `${requirementKey(requirement)}\u0000${agent}`
    if (seen.has(identity)) {
      errors.push(`MCP requirement context ${index} duplicates an existing scoped context.`)
      continue
    }
    seen.add(identity)
    contexts.push({ requirementKey: requirementKey(requirement), sourceRequirementIndex: requirementSourceIndex(requirement), agent, mcpId: requirement.mcpId, promptOverlay: promptOverlay.value })
  }
  if (rawContexts.length === 0) {
    for (const [agent, promptOverlay] of Object.entries(promptOverlays)) {
      const candidates = requirements.filter((requirement) =>
        requirementAgents(requirement).some(
          (candidate) => canonicalAgentPackageIdentity(candidate) === agent,
        ) && mcpDeliveryKind(requirement.mcpId) === 'planning_context_only')
      if (candidates.length === 1) {
        const requirement = candidates[0]
        contexts.push({ requirementKey: requirementKey(requirement), sourceRequirementIndex: requirementSourceIndex(requirement), agent, mcpId: requirement.mcpId, promptOverlay })
      } else if (candidates.length > 1) {
        errors.push(`A legacy MCP prompt overlay is ambiguous across ${candidates.length} requirements; use requirementContexts.`)
      }
    }
  }
  const contextsByAgent = new Map<string, McpRequirementContext[]>()
  for (const context of contexts) {
    const agentContexts = contextsByAgent.get(context.agent) ?? []
    agentContexts.push(context)
    contextsByAgent.set(context.agent, agentContexts)
  }
  const overflowingAgents = new Set<string>()
  for (const [agent, agentContexts] of contextsByAgent) {
    const executorOverlay = normalizeExecutorPromptOverlay(agentContexts.map((context) => context.promptOverlay))
    if (executorOverlay.length <= MAX_EXECUTOR_PROMPT_OVERLAY_LENGTH) continue
    overflowingAgents.add(agent)
    errors.push(
      `MCP requirement contexts for canonical package agent '${agent}' exceed the executor overlay limit of ${MAX_EXECUTOR_PROMPT_OVERLAY_LENGTH} characters; no prompt context was materialized for that agent.`,
    )
  }
  return {
    contexts: contexts.filter((context) => !overflowingAgents.has(context.agent)),
    errors,
  }
}

function normalizeSubtask(
  raw: unknown,
  requirements: McpExecutionRequirement[],
  errors: string[],
  subtaskIndex: number,
): McpAwareSubtask | null {
  if (!isRecord(raw)) return null
  const localErrors: string[] = []
  const id = strictText(raw.id, 80)
  if (!id.valid) localErrors.push(`MCP-aware subtask ${subtaskIndex} id must be a bounded non-empty string.`)
  const agent = cleanAgent(raw.agent)
  if (!agent) localErrors.push(`MCP-aware subtask ${subtaskIndex} agent must be a bounded agent identity.`)
  if (raw.scope !== undefined && (!isRecord(raw.scope) || raw.scope.kind !== 'project')) {
    localErrors.push(`MCP-aware subtask ${subtaskIndex} scope must be project-scoped.`)
  }
  if (raw.accessMode !== undefined && raw.accessMode !== MCP_PLANNING_ACCESS_MODE) {
    localErrors.push(`MCP-aware subtask ${subtaskIndex} accessMode must be planning_instruction.`)
  }
  const normalizedCapabilities = normalizePolicyCapabilities(raw.mcpCapabilities, {
    errors: localErrors,
    label: `MCP-aware subtask ${subtaskIndex} mcpCapabilities`,
    maxItems: 30,
    maxLength: 100,
  })
  if (!Object.hasOwn(raw, 'mcpCapabilities') || normalizedCapabilities.capabilities.length === 0) {
    localErrors.push(`MCP-aware subtask ${subtaskIndex} mcpCapabilities must contain at least one capability.`)
  }
  const dependsOn = strictTextArray(raw.dependsOn, {
    errors: localErrors,
    label: `MCP-aware subtask ${subtaskIndex} dependsOn`,
    maxItems: 20,
    maxLength: 80,
  })
  const inputs = strictTextArray(raw.inputs, {
    errors: localErrors,
    label: `MCP-aware subtask ${subtaskIndex} inputs`,
    maxItems: 20,
    maxLength: 120,
  })
  const outputs = strictTextArray(raw.outputs, {
    errors: localErrors,
    label: `MCP-aware subtask ${subtaskIndex} outputs`,
    maxItems: 20,
    maxLength: 120,
  })
  const verification = strictTextArray(raw.verification, {
    errors: localErrors,
    label: `MCP-aware subtask ${subtaskIndex} verification`,
    maxItems: 20,
    maxLength: 160,
  })
  const stoppingCondition = strictText(raw.stoppingCondition, 240, { allowEmpty: true })
  if (!stoppingCondition.valid) localErrors.push(`MCP-aware subtask ${subtaskIndex} stoppingCondition must be a bounded string.`)
  const fallback = strictText(raw.fallback, 240, { allowEmpty: true })
  if (!fallback.valid) localErrors.push(`MCP-aware subtask ${subtaskIndex} fallback must be a bounded string.`)

  if (!id.valid || !agent || !normalizedCapabilities.valid) {
    errors.push(...localErrors)
    return null
  }
  const mcpCapabilities = normalizedCapabilities.capabilities
  const capabilityBindings: Array<{ capability: string; requirementKey: string }> = []
  const requirementCoversCapability = (requirement: McpExecutionRequirement, capability: string): boolean => {
    const capabilityKeys = new Set(coverageKeysForGrant(capability))
    const packageIdentity = canonicalAgentPackageIdentity(agent)
    return requirement.mcpId === capabilityMcpId(capability) &&
      requirementAgents(requirement).some(
        (candidate) => canonicalAgentPackageIdentity(candidate) === packageIdentity,
      ) &&
      permissionsForAgentPackage(requirement, packageIdentity).some((permission) =>
        coverageKeysForGrant(permission).some((key) => capabilityKeys.has(key)),
      )
  }
  if (Object.hasOwn(raw, 'capabilityRequirements')) {
    if (!Array.isArray(raw.capabilityRequirements)) {
      localErrors.push(`MCP-aware subtask ${subtaskIndex} capabilityRequirements must be an array when present.`)
    } else if (raw.capabilityRequirements.length > MAX_CAPABILITY_REQUIREMENTS) {
      localErrors.push(`MCP-aware subtask ${subtaskIndex} capabilityRequirements exceeds the maximum raw count of ${MAX_CAPABILITY_REQUIREMENTS}; no binding was materialized.`)
    } else for (let index = 0; index < raw.capabilityRequirements.length; index += 1) {
      const rawBinding = isRecord(raw.capabilityRequirements[index]) ? raw.capabilityRequirements[index] : null
      const rawCapability = strictText(rawBinding?.capability, 100)
      const capability = rawCapability.valid ? normalizeCapability(rawCapability.value) : ''
      const sourceIndex = rawBinding?.sourceRequirementIndex
      const requirement = typeof sourceIndex === 'number' && Number.isSafeInteger(sourceIndex) && sourceIndex >= 0
        ? requirements.find((item) => item.sourceRequirementIndex === sourceIndex)
        : null
      if (!rawBinding || !rawCapability.valid || !requirement || !mcpCapabilities.includes(capability) || !requirementCoversCapability(requirement, capability)) {
        localErrors.push(`MCP-aware subtask ${subtaskIndex} capability binding ${index} is invalid.`)
        continue
      }
      capabilityBindings.push({ capability, requirementKey: requirementKey(requirement) })
    }
    if (Array.isArray(raw.capabilityRequirements)) {
      for (const capability of mcpCapabilities) {
        const count = capabilityBindings.filter((binding) => binding.capability === capability).length
        if (count !== 1) {
          localErrors.push(`MCP-aware subtask ${subtaskIndex} has a declared capability without exactly one requirement binding.`)
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
  if (
    localErrors.length > 0 ||
    !dependsOn.valid ||
    !inputs.valid ||
    !outputs.valid ||
    !verification.valid ||
    !stoppingCondition.valid ||
    !fallback.valid
  ) {
    errors.push(...localErrors)
    return null
  }
  return {
    id: id.value,
    agent,
    scope: { kind: 'project' },
    accessMode: MCP_PLANNING_ACCESS_MODE,
    dependsOn: dependsOn.values,
    mcpCapabilities,
    capabilityBindings,
    inputs: inputs.values,
    outputs: outputs.values,
    verification: verification.values,
    stoppingCondition: stoppingCondition.value,
    fallback: fallback.value,
  }
}

function normalizeDesign(parsed: unknown): McpExecutionDesign | null {
  if (!isMcpExecutionDesignShape(parsed)) return null
  const value = parsed as Record<string, unknown>
  const normalizationErrors: string[] = []
  const rawRequirements = Array.isArray(value.requirements) ? value.requirements : []
  const requirements = rawRequirements.length > MAX_REQUIREMENTS
    ? (normalizationErrors.push(`MCP requirements exceeds the maximum raw count of ${MAX_REQUIREMENTS}; no requirement was materialized.`), [])
    : rawRequirements.map((raw, index) => {
        const requirement = normalizeRequirement(raw, index, normalizationErrors)
        if (!requirement) normalizationErrors.push(`MCP requirement ${index} is malformed and cannot be normalized.`)
        return requirement
      }).filter((item): item is McpExecutionRequirement => item !== null)
  assignRequirementKeys(requirements)
  const promptOverlays = normalizePromptOverlays(value.promptOverlays, normalizationErrors)
  const normalizedContexts = normalizeRequirementContexts(value, requirements, promptOverlays)
  normalizationErrors.push(
    ...normalizedContexts.errors,
    ...requirements
      .filter((requirement) => requirementAgents(requirement).length === 0)
      .map((requirement) => `MCP requirement ${requirement.sourceRequirementIndex ?? 0} does not target any valid agent.`),
  )
  const rawSubtasks = Array.isArray(value.mcpAwareSubtasks) ? value.mcpAwareSubtasks : []
  const mcpAwareSubtasks = rawSubtasks.length > MAX_MCP_AWARE_SUBTASKS
    ? (normalizationErrors.push(`MCP-aware subtasks exceeds the maximum raw count of ${MAX_MCP_AWARE_SUBTASKS}; no subtask was materialized.`), [])
    : rawSubtasks.map((subtask, index) => {
        const normalized = normalizeSubtask(subtask, requirements, normalizationErrors, index)
        if (!normalized) normalizationErrors.push(`MCP-aware subtask ${index} is malformed and cannot be normalized.`)
        return normalized
      }).filter((item): item is McpAwareSubtask => item !== null)
  const normalizedErrors = [...new Set(normalizationErrors)]
  return {
    schemaVersion: 1,
    requirements,
    promptOverlays,
    requirementContexts: normalizedContexts.contexts,
    mcpAwareSubtasks,
    normalizationErrors: normalizedErrors,
    ...(normalizedErrors.length > 0 ? {
      normalizationEvidence: [{
        schemaVersion: 1,
        category: 'normalization',
        code: 'mcp_design_nested_policy_invalid',
        message: `MCP execution design contains ${normalizedErrors.length} invalid nested policy declaration${normalizedErrors.length === 1 ? '' : 's'}.`,
      }],
    } : {}),
  }
}

function invalidMcpExecutionDesign(
  category: McpNormalizationEvidence['category'],
  code: string,
  message: string,
): McpExecutionDesign {
  return {
    schemaVersion: 1,
    requirements: [],
    promptOverlays: {},
    requirementContexts: [],
    mcpAwareSubtasks: [],
    normalizationErrors: [message],
    normalizationEvidence: [{ schemaVersion: 1, category, code, message }],
  }
}

type JsonObjectKeyScanResult = 'valid' | 'duplicate-key' | 'invalid'

/**
 * JSON.parse keeps only the last value when an object repeats a key. That is
 * unsafe for policy input because a later member can silently erase an earlier
 * deny. Scan the JSON grammar before parsing so every object retains its raw
 * member boundaries and duplicate decoded keys can be rejected.
 */
function scanJsonObjectKeys(json: string): JsonObjectKeyScanResult {
  const MAX_DEPTH = 128
  let index = 0
  let duplicateKey = false

  const skipWhitespace = (): void => {
    while (index < json.length && /[\u0020\u0009\u000a\u000d]/.test(json[index])) index += 1
  }

  const parseString = (): string | null => {
    if (json[index] !== '"') return null
    index += 1
    let decoded = ''
    while (index < json.length) {
      const character = json[index]
      if (character === '"') {
        index += 1
        return decoded
      }
      if (character.charCodeAt(0) <= 0x1f) return null
      if (character !== '\\') {
        decoded += character
        index += 1
        continue
      }

      index += 1
      if (index >= json.length) return null
      const escape = json[index]
      const simpleEscapes: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      }
      if (Object.hasOwn(simpleEscapes, escape)) {
        decoded += simpleEscapes[escape]
        index += 1
        continue
      }
      if (escape !== 'u') return null
      const hex = json.slice(index + 1, index + 5)
      if (hex.length !== 4 || !/^[0-9a-f]{4}$/i.test(hex)) return null
      decoded += String.fromCharCode(Number.parseInt(hex, 16))
      index += 5
    }
    return null
  }

  const parseNumber = (): boolean => {
    if (json[index] === '-') index += 1
    if (json[index] === '0') {
      index += 1
    } else {
      if (!/[1-9]/.test(json[index] ?? '')) return false
      while (/[0-9]/.test(json[index] ?? '')) index += 1
    }
    if (json[index] === '.') {
      index += 1
      if (!/[0-9]/.test(json[index] ?? '')) return false
      while (/[0-9]/.test(json[index] ?? '')) index += 1
    }
    if (json[index] === 'e' || json[index] === 'E') {
      index += 1
      if (json[index] === '+' || json[index] === '-') index += 1
      if (!/[0-9]/.test(json[index] ?? '')) return false
      while (/[0-9]/.test(json[index] ?? '')) index += 1
    }
    return true
  }

  const parseValue = (depth: number): boolean => {
    if (depth > MAX_DEPTH) return false
    skipWhitespace()
    const character = json[index]
    if (character === '"') return parseString() !== null
    if (character === '-' || /[0-9]/.test(character ?? '')) return parseNumber()
    if (json.startsWith('true', index)) {
      index += 4
      return true
    }
    if (json.startsWith('false', index)) {
      index += 5
      return true
    }
    if (json.startsWith('null', index)) {
      index += 4
      return true
    }
    if (character === '[') {
      index += 1
      skipWhitespace()
      if (json[index] === ']') {
        index += 1
        return true
      }
      while (index < json.length) {
        if (!parseValue(depth + 1)) return false
        skipWhitespace()
        if (json[index] === ']') {
          index += 1
          return true
        }
        if (json[index] !== ',') return false
        index += 1
        skipWhitespace()
      }
      return false
    }
    if (character === '{') {
      index += 1
      skipWhitespace()
      if (json[index] === '}') {
        index += 1
        return true
      }
      const keys = new Set<string>()
      while (index < json.length) {
        const key = parseString()
        if (key === null) return false
        if (keys.has(key)) duplicateKey = true
        keys.add(key)
        skipWhitespace()
        if (json[index] !== ':') return false
        index += 1
        if (!parseValue(depth + 1)) return false
        skipWhitespace()
        if (json[index] === '}') {
          index += 1
          return true
        }
        if (json[index] !== ',') return false
        index += 1
        skipWhitespace()
      }
      return false
    }
    return false
  }

  const valid = parseValue(0)
  skipWhitespace()
  if (!valid || index !== json.length) return 'invalid'
  return duplicateKey ? 'duplicate-key' : 'valid'
}

function normalizeMatchedMcpFence(jsonBlock: string): McpExecutionDesign {
  const keyScan = scanJsonObjectKeys(jsonBlock)
  if (keyScan === 'duplicate-key') {
    return invalidMcpExecutionDesign(
      'parse',
      'mcp_design_json_duplicate_object_key',
      'The supplied MCP execution design fence contains duplicate JSON object keys and must be regenerated.',
    )
  }
  if (keyScan === 'invalid') {
    return invalidMcpExecutionDesign(
      'parse',
      'mcp_design_json_parse_failed',
      'The supplied MCP execution design fence contains invalid JSON and must be regenerated.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonBlock)
  } catch {
    return invalidMcpExecutionDesign(
      'parse',
      'mcp_design_json_parse_failed',
      'The supplied MCP execution design fence contains invalid JSON and must be regenerated.',
    )
  }
  if (!isMcpExecutionDesignShape(parsed)) {
    return invalidMcpExecutionDesign(
      'shape',
      'mcp_design_schema_shape_invalid',
      'The supplied MCP execution design fence does not match schema version 1 and must be regenerated.',
    )
  }
  return normalizeDesign(parsed) as McpExecutionDesign
}

type ScannedExactMcpFence = {
  start: number
  end: number
  complete: boolean
  jsonBlock: string
}

function scanExactMcpFences(rawText: string): ScannedExactMcpFence[] {
  const tagPattern = new RegExp('```' + MCP_EXECUTION_DESIGN_FENCE + '(?=[\\s`]|$)', 'gi')
  const openings = [...rawText.matchAll(tagPattern)].map((match) => ({
    start: match.index,
    afterTag: (match.index ?? 0) + match[0].length,
  }))
  return openings.map((opening, index) => {
    const nextStart = openings[index + 1]?.start ?? rawText.length
    const lineEnd = rawText.indexOf('\n', opening.afterTag)
    if (lineEnd < 0 || lineEnd >= nextStart) {
      return { start: opening.start ?? 0, end: nextStart, complete: false, jsonBlock: '' }
    }
    const openingSuffix = rawText.slice(opening.afterTag, lineEnd).replace(/\r$/, '')
    const bodyStart = lineEnd + 1
    const closingPattern = /^[ \t]*```[ \t]*\r?$/gm
    closingPattern.lastIndex = bodyStart
    const closing = closingPattern.exec(rawText)
    const hasBoundedClosing = closing !== null && (closing.index ?? rawText.length) < nextStart
    if (!hasBoundedClosing || !closing) {
      return { start: opening.start ?? 0, end: nextStart, complete: false, jsonBlock: '' }
    }
    const closingLineEnd = rawText.indexOf('\n', closing.index + closing[0].length)
    return {
      start: opening.start ?? 0,
      end: closingLineEnd < 0 ? closing.index + closing[0].length : closingLineEnd + 1,
      complete: openingSuffix.trim() === '',
      jsonBlock: rawText.slice(bodyStart, closing.index),
    }
  })
}

function removeExactMcpFences(rawText: string, fences: ScannedExactMcpFence[]): string {
  let planText = rawText
  for (const fence of [...fences].sort((left, right) => right.start - left.start)) {
    planText = planText.slice(0, fence.start) + planText.slice(fence.end)
  }
  return planText.trim()
}

export function parseMcpExecutionDesign(rawText: string): ParsedMcpExecutionDesign {
  const exactFences = scanExactMcpFences(rawText)
  if (exactFences.length > 1) {
    return {
      planText: removeExactMcpFences(rawText, exactFences),
      design: invalidMcpExecutionDesign(
        'shape',
        'mcp_design_multiple_exact_fences',
        'Multiple exact MCP execution design fences were supplied; all policy declarations were rejected.',
      ),
    }
  }
  if (exactFences.length === 1) {
    const [exactFence] = exactFences
    return {
      planText: removeExactMcpFences(rawText, exactFences),
      design: exactFence.complete
        ? normalizeMatchedMcpFence(exactFence.jsonBlock)
        : invalidMcpExecutionDesign(
            'parse',
            'mcp_design_fence_incomplete',
            'The supplied MCP execution design fence is incomplete and must be regenerated.',
          ),
    }
  }

  const match = findFence(rawText, FENCE_REGEX, isMcpExecutionDesignShape)
  if (!match) {
    return { planText: rawText.trim(), design: null }
  }
  return {
    planText: rawText.replace(match.fullMatch, '').trim(),
    design: normalizeMatchedMcpFence(match.jsonBlock),
  }
}

function statusFor(overview: ProjectMcpOverview | null | undefined, mcpId: string): ProjectMcpStatus | null {
  return overview?.statuses.find((status) => status.mcpId === mcpId) ?? null
}

function requirementEntry(requirement: McpExecutionRequirement, packageIdentity: string): Record<string, unknown> {
  return {
    requirementKey: requirementKey(requirement),
    sourceRequirementIndex: requirementSourceIndex(requirement),
    agent: packageIdentity,
    mcpId: requirement.mcpId,
    requirement: requirement.requirement,
    reason: requirement.reason,
    assignment: { type: requirement.assignment.type, targetId: requirement.assignment.targetId },
    permissions: permissionsForAgentPackage(requirement, packageIdentity),
    prohibitedCapabilities: requirement.prohibitedCapabilities,
    fallback: requirement.fallback,
  }
}

function admissionForAgent(design: McpExecutionDesign, packageIdentity: string, overview: ProjectMcpOverview): McpWorkPackageAdmission {
  const requirements = design.requirements.filter((requirement) =>
    requirementAgents(requirement).some((agent) => canonicalAgentPackageIdentity(agent) === packageIdentity))
  const contexts = new Set((design.requirementContexts ?? [])
    .filter((context) => canonicalAgentPackageIdentity(context.agent) === packageIdentity)
    .map((context) => `${context.requirementKey}\u0000${context.mcpId}`))
  return admitWorkPackageMcp({
    entries: requirements.map((requirement) => requirementEntry(requirement, packageIdentity)),
    subtasks: design.mcpAwareSubtasks
      .filter((subtask) => canonicalAgentPackageIdentity(subtask.agent) === packageIdentity)
      .map((subtask) => ({ ...subtask, agent: packageIdentity })),
    label: `${packageIdentity} work package`,
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
  const agents = [...new Set(design.requirements.flatMap(requirementAgents)
    .concat(design.mcpAwareSubtasks.map((subtask) => subtask.agent))
    .map(canonicalAgentPackageIdentity)
    .filter(Boolean))].sort()
  const admissions = agents.map((agent) => admissionForAgent(design, agent, overview))
  const evaluations = admissions.flatMap((admission) => admission.evaluations)
  const subtaskDecisions = admissions.flatMap((admission) => admission.subtaskDecisions)
  const normalizationErrors = design.normalizationErrors ?? []
  const blocked = [...new Set(admissions.flatMap((admission) => admission.aggregate.blocked).concat(normalizationErrors))]
  const warnings = [...new Set(admissions.flatMap((admission) => admission.aggregate.warnings))]
  const blockingAdmissions = admissions.filter((admission) => admission.aggregate.blocked.length > 0)
  const primaryAdmission = blockingAdmissions
    .filter((admission) => admission.aggregate.primaryRecoveryAction)
    .sort((left, right) => RECOVERY_PRECEDENCE.indexOf(left.aggregate.primaryRecoveryAction as McpRecoveryAction) - RECOVERY_PRECEDENCE.indexOf(right.aggregate.primaryRecoveryAction as McpRecoveryAction))[0]
  const primaryDecision = primaryAdmission?.aggregate.primaryDecision
  const normalizationBlocked = normalizationErrors.length > 0
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
      ...(normalizationBlocked
        ? { primaryMode: 'blocked' as const, primaryRecoveryAction: 'revise_plan' as const }
        : primaryDecision
          ? { primaryMode: primaryDecision.mode, primaryRecoveryAction: primaryDecision.recoveryAction }
          : {}),
      ...(!normalizationBlocked && primaryDecision
        ? { primaryDecision: { ...primaryDecision, evidenceRefs: [...primaryDecision.evidenceRefs] } }
        : {}),
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
  return isRecord(metadata) ? boundedObjectArray(metadata.mcpGrants, MAX_BROKER_GRANTS) : []
}

function boundedObjectArray(value: unknown, maxItems: number): Record<string, unknown>[] {
  return Array.isArray(value) && value.length <= maxItems ? value.filter(isRecord) : []
}

function brokerEntries(input: { assignedRole?: string; mcpRequirements?: unknown; metadata?: unknown }): Record<string, unknown>[] {
  const fallbackAgent = cleanAgent(input.assignedRole) ?? 'unknown'
  const currentSchema = isRecord(input.metadata) && input.metadata.mcpGrantsSchemaVersion === 2
  return [...boundedObjectArray(input.mcpRequirements, MAX_BROKER_POLICIES), ...metadataGrants(input.metadata)].map((entry) =>
    currentSchema || Object.hasOwn(entry, 'agent') || Object.hasOwn(entry, 'requirementKey')
      ? entry
      : { ...entry, agent: fallbackAgent })
}

function brokerSubtasks(metadata: unknown, assignedRole?: string): Record<string, unknown>[] {
  const fallbackAgent = cleanAgent(assignedRole) ?? 'unknown'
  const currentSchema = isRecord(metadata) && metadata.mcpGrantsSchemaVersion === 2
  return (isRecord(metadata) ? boundedObjectArray(metadata.mcpAwareSubtasks, MAX_MCP_AWARE_SUBTASKS) : []).map((subtask) =>
    currentSchema || Object.hasOwn(subtask, 'agent') || Object.hasOwn(subtask, 'capabilityBindings')
      ? subtask
      : { ...subtask, agent: fallbackAgent })
}

function brokerNormalizationErrors(metadata: unknown): string[] {
  if (!isRecord(metadata)) return []
  const storedErrors = Array.isArray(metadata.mcpNormalizationErrors) &&
    metadata.mcpNormalizationErrors.length <= MAX_BROKER_NORMALIZATION_ITEMS
    ? metadata.mcpNormalizationErrors
    .map((error) => cleanText(error, 500))
    .filter((error) => error !== '')
    : []
  const evidenceErrors = Array.isArray(metadata.mcpNormalizationEvidence) &&
    metadata.mcpNormalizationEvidence.length <= MAX_BROKER_NORMALIZATION_ITEMS
    ? metadata.mcpNormalizationEvidence.flatMap((value) => {
        if (!isRecord(value)) return []
        const category = value.category
        const code = typeof value.code === 'string' && /^[a-z0-9_]{1,80}$/.test(value.code)
          ? value.code
          : ''
        if (value.schemaVersion !== 1 || !['parse', 'shape', 'normalization'].includes(String(category)) || !code) return []
        return [`MCP execution design ${category} evidence '${code}' requires plan revision.`]
      })
    : []
  return [...new Set([...storedErrors, ...evidenceErrors])]
}

function brokerSchemaErrors(input: { mcpRequirements?: unknown; metadata?: unknown }): string[] {
  const metadata = isRecord(input.metadata) ? input.metadata : null
  const currentSchema = metadata?.mcpGrantsSchemaVersion === 2
  const schemaLabel = currentSchema ? 'MCP schema v2' : 'Legacy MCP'
  const errors: string[] = []
  if (input.metadata !== undefined && input.metadata !== null && metadata === null) {
    errors.push('Legacy MCP metadata must be stored as a record.')
  }

  const persistedArray = (
    value: unknown,
    options: { label: string; maxItems: number; present: boolean },
  ): unknown[] => {
    if (!options.present) return []
    if (!Array.isArray(value)) {
      errors.push(`${schemaLabel} ${options.label} must be stored as an array.`)
      return []
    }
    if (value.length > options.maxItems) {
      errors.push(`${schemaLabel} ${options.label} exceeds the maximum raw count of ${options.maxItems}.`)
      return []
    }
    return value
  }

  const nestedBoundErrors = (value: Record<string, unknown>, index: number, label: string, fields: readonly string[]) => {
    for (const field of fields) {
      if (Array.isArray(value[field]) && value[field].length > MAX_BROKER_NESTED_ITEMS) {
        errors.push(`${schemaLabel} ${label} ${index} field '${field}' exceeds the maximum raw count of ${MAX_BROKER_NESTED_ITEMS}.`)
      }
    }
  }

  const normalizationErrors = persistedArray(metadata?.mcpNormalizationErrors, {
    label: 'normalization errors',
    maxItems: MAX_BROKER_NORMALIZATION_ITEMS,
    present: metadata !== null && Object.hasOwn(metadata, 'mcpNormalizationErrors'),
  })
  if (normalizationErrors.some((error) => cleanText(error, 500) === '')) {
    errors.push(`${schemaLabel} normalization errors must contain only non-empty strings.`)
  }

  const normalizationEvidence = persistedArray(metadata?.mcpNormalizationEvidence, {
    label: 'normalization evidence',
    maxItems: MAX_BROKER_NORMALIZATION_ITEMS,
    present: metadata !== null && Object.hasOwn(metadata, 'mcpNormalizationEvidence'),
  })
  normalizationEvidence.forEach((value, index) => {
        const evidence = isRecord(value) ? value : null
        if (
          !evidence ||
          evidence.schemaVersion !== 1 ||
          !['parse', 'shape', 'normalization'].includes(String(evidence.category)) ||
          typeof evidence.code !== 'string' ||
          !/^[a-z0-9_]{1,80}$/.test(evidence.code) ||
          typeof evidence.message !== 'string' ||
          evidence.message.length === 0 ||
          evidence.message.length > 300
        ) {
          errors.push(`${schemaLabel} normalization evidence ${index} is malformed.`)
        }
  })

  const policyEntries = persistedArray(input.mcpRequirements, {
    label: 'policies',
    maxItems: MAX_BROKER_POLICIES,
    present: input.mcpRequirements !== undefined,
  })
  policyEntries.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`${schemaLabel} policy ${index} must be a record.`)
      return
    }
    nestedBoundErrors(value, index, 'policy', [...REQUIREMENT_CAPABILITY_FIELDS, 'prohibitedCapabilities', 'evidenceRefs'])
    if (currentSchema && cleanText(value.requirementKey, 200) === '') {
      errors.push(`MCP schema v2 policy ${index} must persist a requirementKey.`)
    }
    if (currentSchema && cleanAgent(value.agent) === null) {
      errors.push(`MCP schema v2 policy ${index} must persist an explicit agent identity.`)
    }
  })

  const grants = persistedArray(metadata?.mcpGrants, {
    label: 'grant envelopes',
    maxItems: MAX_BROKER_GRANTS,
    present: metadata !== null && Object.hasOwn(metadata, 'mcpGrants'),
  })
  grants.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`${schemaLabel} grant envelope ${index} must be a record.`)
      return
    }
    nestedBoundErrors(value, index, 'grant envelope', [
      ...REQUIREMENT_CAPABILITY_FIELDS,
      'normalizedCapabilities',
      'capabilityClasses',
      'evidenceRefs',
    ])
    if (currentSchema && cleanText(value.requirementKey, 200) === '') {
      errors.push(`MCP schema v2 grant envelope ${index} must persist a requirementKey.`)
    }
    if (currentSchema && cleanAgent(value.agent) === null) {
      errors.push(`MCP schema v2 grant envelope ${index} must persist an explicit agent identity.`)
    }
  })

  const subtasks = persistedArray(metadata?.mcpAwareSubtasks, {
    label: 'subtasks',
    maxItems: MAX_MCP_AWARE_SUBTASKS,
    present: metadata !== null && Object.hasOwn(metadata, 'mcpAwareSubtasks'),
  })
  subtasks.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`${schemaLabel} subtask ${index} must be a record.`)
      return
    }
    nestedBoundErrors(value, index, 'subtask', ['mcpCapabilities', 'capabilityBindings'])
    if (currentSchema && cleanAgent(value.agent) === null) {
      errors.push(`MCP schema v2 subtask ${index} must persist an explicit agent identity.`)
    }
    if (currentSchema && !Array.isArray(value.capabilityBindings)) {
      errors.push(`MCP schema v2 subtask ${index} must persist explicit capabilityBindings.`)
    }
  })

  const contexts = persistedArray(metadata?.requirementContexts, {
    label: 'requirement contexts',
    maxItems: MAX_REQUIREMENT_CONTEXTS,
    present: metadata !== null && Object.hasOwn(metadata, 'requirementContexts'),
  })
  contexts.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`${schemaLabel} requirement context ${index} must be a record.`)
      return
    }
    const promptOverlay = typeof value.promptOverlay === 'string'
      ? value.promptOverlay.trim().replace(/\s+/g, ' ')
      : ''
    if (currentSchema && (
      cleanText(value.requirementKey, 200) === '' ||
      cleanAgent(value.agent) === null ||
      cleanText(value.mcpId, 80) === '' ||
      !Number.isSafeInteger(value.sourceRequirementIndex) ||
      (value.sourceRequirementIndex as number) < 0 ||
      promptOverlay === '' ||
      promptOverlay.length > 1_000
    )) {
      errors.push(`MCP schema v2 requirement context ${index} must persist complete scoped evidence.`)
    }
    if (currentSchema && !policyEntries.some((policy) =>
      isRecord(policy) &&
      policy.requirementKey === value.requirementKey &&
      policy.sourceRequirementIndex === value.sourceRequirementIndex &&
      policy.agent === value.agent &&
      policy.mcpId === value.mcpId,
    )) {
      errors.push(`MCP schema v2 requirement context ${index} does not match an exact persisted policy identity.`)
    }
  })

  if (currentSchema && metadata) {
    const validContexts = contexts.filter(isRecord)
    const expectedExecutorOverlay = normalizeExecutorPromptOverlay(validContexts.map((context) => context.promptOverlay))
    const actualExecutorOverlay = normalizeExecutorPromptOverlay([metadata.promptOverlay])
    if (
      expectedExecutorOverlay.length > MAX_EXECUTOR_PROMPT_OVERLAY_LENGTH ||
      actualExecutorOverlay.length > MAX_EXECUTOR_PROMPT_OVERLAY_LENGTH
    ) {
      errors.push(`MCP schema v2 scoped prompt context exceeds the executor overlay limit of ${MAX_EXECUTOR_PROMPT_OVERLAY_LENGTH} characters.`)
    }
    if (actualExecutorOverlay !== expectedExecutorOverlay) {
      errors.push('MCP schema v2 prompt context must be scoped by requirement identity and the executor overlay must exactly match those contexts.')
    }
    grants.filter(isRecord).forEach((grant, index) => {
      if (typeof grant.promptOverlayPresent !== 'boolean') return
      const hasMatchingContext = validContexts.some((context) =>
        context.requirementKey === grant.requirementKey &&
        context.sourceRequirementIndex === grant.sourceRequirementIndex &&
        context.agent === grant.agent &&
        context.mcpId === grant.mcpId &&
        cleanText(context.promptOverlay, 2_000) !== '',
      )
      if (grant.promptOverlayPresent !== hasMatchingContext) {
        errors.push(`MCP schema v2 grant envelope ${index} prompt evidence does not match its scoped requirement context.`)
      }
    })
  }
  return [...new Set(errors)]
}

function brokerHasPromptInstructions(metadata: unknown): boolean {
  return isRecord(metadata) && (
    cleanText(metadata.promptOverlay, 200) !== '' ||
    boundedObjectArray(metadata.requirementContexts, MAX_REQUIREMENT_CONTEXTS).length > 0 ||
    brokerSubtasks(metadata).length > 0 ||
    brokerNormalizationErrors(metadata).length > 0 ||
    (Array.isArray(metadata.mcpNormalizationEvidence) && metadata.mcpNormalizationEvidence.length > 0)
  )
}

type WorkPackageMcpRuntimeInput = { harnessToolPolicy?: unknown; mcpRequirements?: unknown; metadata?: unknown }

function hasWorkPackageMcpRuntimeInputsUnchecked(input: WorkPackageMcpRuntimeInput): boolean {
  return brokerSchemaErrors(input).length > 0 || brokerEntries(input).length > 0 || brokerHasPromptInstructions(input.metadata)
}

export function hasWorkPackageMcpRuntimeInputs(input: WorkPackageMcpRuntimeInput): boolean {
  try {
    if (brokerSchemaErrors(input).length > 0) return true
    return hasWorkPackageMcpRuntimeInputsUnchecked(structuredClone(input))
  } catch {
    return true
  }
}

function brokerHasPromptContext(metadata: unknown, entry: { requirementKey: string; agent: string; mcpId: string }, entries: Record<string, unknown>[]): boolean {
  const meta = isRecord(metadata) ? metadata : {}
  if (boundedObjectArray(meta.requirementContexts, MAX_REQUIREMENT_CONTEXTS).some((context) =>
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

function admitWorkPackageMcpBrokerUnchecked(input: WorkPackageMcpAdmissionInput): McpWorkPackageAdmission {
  const schemaErrors = brokerSchemaErrors(input)
  const entries = schemaErrors.length === 0 ? brokerEntries(input) : []
  const admission = admitWorkPackageMcp({
    entries,
    subtasks: schemaErrors.length === 0 ? brokerSubtasks(input.metadata, input.assignedRole) : [],
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
    ...schemaErrors,
  ]
  if (normalizationErrors.length === 0) return admission
  // A malformed persisted policy is the fail-closed primary block. Keep its
  // reason first and remove any canonical decision selected from policy we can
  // no longer trust, so downstream surfaces cannot pair that stale decision's
  // evidence with the normalization recovery action.
  const blocked = [...new Set([...normalizationErrors, ...admission.aggregate.blocked])]
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
      primaryDecision: undefined,
    },
  }
}

function unsafeBrokerInspectionBlock(): McpWorkPackageAdmission {
  return admitWorkPackageMcp({
    entries: null as unknown as Array<Record<string, unknown>>,
    subtasks: [],
    label: 'work package',
    statusFor: () => null,
    effectiveGrantFor: () => ({ phase: 'none', source: 'none', status: 'not_issued', coveredCapabilities: [] }),
    hasPromptOnlyContextFor: () => false,
  })
}

export function admitWorkPackageMcpBroker(input: WorkPackageMcpAdmissionInput): McpWorkPackageAdmission {
  try {
    if (brokerSchemaErrors(input).length > 0) return admitWorkPackageMcpBrokerUnchecked(input)
    return admitWorkPackageMcpBrokerUnchecked(structuredClone(input))
  } catch {
    return unsafeBrokerInspectionBlock()
  }
}

export function evaluateWorkPackageMcpBroker(input: WorkPackageMcpAdmissionInput): WorkPackageMcpBrokerCheck {
  const admission = admitWorkPackageMcpBroker(input)
  return admissionToBrokerCheck(admission)
}
