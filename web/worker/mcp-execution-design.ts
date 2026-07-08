import { MCP_EXECUTION_DESIGN_FENCE, findFence, isMcpExecutionDesignShape } from '@/lib/plan-fences'
import { isKnownMcpId } from '@/lib/mcps/catalog'
import type { ProjectMcpOverview, ProjectMcpStatus } from '@/lib/mcps/types'

const ASSIGNMENT_TYPES = new Set(['agent', 'multiple_agents', 'workforce', 'architect_only', 'reviewer_only'])
const FALLBACK_ACTIONS = new Set(['block', 'continue_without_mcp', 'ask_user'])
const SAFE_BETA_CAPABILITY_PATTERNS: Record<string, RegExp[]> = {
  filesystem: [
    /^filesystem\.(?:project\.)?read$/,
    /^filesystem\.(?:project\.)?list$/,
    /^filesystem\.(?:project\.)?search$/,
  ],
  github: [
    /^github\.(?:issues|pull_requests|contents|repository|actions)\.read$/,
    /^github\.(?:repository|contents)\.list$/,
    /^github\.(?:repository|contents)\.search$/,
  ],
}
const NON_RETRYABLE_BROKER_BLOCK_PATTERN = /Unknown MCP|outside the allowed beta scope|no approved capabilities|does not name a known MCP|not covered by an explicit approved grant|Run-scoped MCP prompt overlays/i
const RETRYABLE_BROKER_BLOCK_PATTERN = /not configured|auth_required|missing|unhealthy|disabled|not installed|install_required/i

export const MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT = 'not_implemented' as const

export type McpRequirementLevel = 'required' | 'optional'
export type McpAssignmentType = 'agent' | 'multiple_agents' | 'workforce' | 'architect_only' | 'reviewer_only'
export type McpFallbackAction = 'block' | 'continue_without_mcp' | 'ask_user'
export type McpValidationStatus = 'valid' | 'blocked' | 'warnings'

export type McpExecutionRequirement = {
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
  fallback: {
    action: McpFallbackAction
    message: string
  }
}

export type McpAwareSubtask = {
  id: string
  agent: string
  dependsOn: string[]
  mcpCapabilities: string[]
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
  mcpAwareSubtasks: McpAwareSubtask[]
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

export type McpGrantDecisionStatus = 'proposed' | 'warning' | 'blocked'

export type WorkPackageMcpBrokerStatus = 'allowed' | 'blocked' | 'warnings'

export type WorkPackageMcpBrokerCheck = {
  status: WorkPackageMcpBrokerStatus
  blocked: string[]
  warnings: string[]
  blockedReason: string | null
}

export function isRetryableMcpBrokerBlock(blocked: string[]): boolean {
  if (blocked.some((message) => NON_RETRYABLE_BROKER_BLOCK_PATTERN.test(message))) return false
  return blocked.some((message) => RETRYABLE_BROKER_BLOCK_PATTERN.test(message))
}

export type McpGrantDecisions = {
  schemaVersion: 1
  runtimeEnforcement: typeof MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT
  summary: Record<McpGrantDecisionStatus, number>
  decisions: Array<{
    decisionId: string
    sourceRequirementIndex: number
    agent: string
    mcpId: string
    capabilities: string[]
    requirement: McpRequirementLevel
    status: McpGrantDecisionStatus
    reason: string
    assignment: {
      type: McpAssignmentType
      targetId: string | null
    }
    fallback: {
      action: McpFallbackAction
      message: string
    }
    health: {
      installState: ProjectMcpStatus['installState'] | 'unknown'
      status: ProjectMcpStatus['status'] | 'unknown'
      enabled: boolean
      error: string | null
    }
    promptOverlayPresent: boolean
  }>
}

export type ParsedMcpExecutionDesign = {
  planText: string
  design: McpExecutionDesign | null
}

const FENCE_REGEX = new RegExp(
  '```' + MCP_EXECUTION_DESIGN_FENCE + '\\s*\\n([\\s\\S]*?)[ \\t]*\\n?[ \\t]*```',
  'i',
)

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

function cleanTextArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    const text = cleanText(item, maxLength)
    if (text === '') continue
    result.push(text)
    if (result.length >= maxItems) break
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanAgent(value: unknown): string | null {
  const agent = cleanText(value, 40).toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/.test(agent) ? agent : null
}

function normalizeAssignment(raw: unknown): McpExecutionRequirement['assignment'] {
  const assignment = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const rawType = cleanText(assignment.type, 40)
  const type = ASSIGNMENT_TYPES.has(rawType) ? rawType as McpAssignmentType : 'agent'
  const targetAgents = Array.isArray(assignment.targetAgents)
    ? assignment.targetAgents.map(cleanAgent).filter((agent): agent is string => agent !== null).slice(0, 6)
    : []
  const targetId = cleanText(assignment.targetId, 80)

  return {
    type,
    targetAgents,
    targetId: targetId === '' ? null : targetId,
  }
}

function normalizePermissions(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null) return {}
  const result: Record<string, string[]> = {}
  for (const [agent, permissions] of Object.entries(raw)) {
    const normalizedAgent = cleanAgent(agent)
    if (!normalizedAgent) continue
    const items = cleanTextArray(permissions, 20, 80)
    if (items.length > 0) result[normalizedAgent] = items
  }
  return result
}

function normalizeFallback(raw: unknown): McpExecutionRequirement['fallback'] {
  const fallback = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const rawAction = cleanText(fallback.action, 40)
  const action = FALLBACK_ACTIONS.has(rawAction) ? rawAction as McpFallbackAction : 'ask_user'
  const message = cleanText(fallback.message, 240)
  return {
    action,
    message: message || 'Ask the user how to proceed before issuing MCP-backed work.',
  }
}

function fallbackAction(raw: unknown): McpFallbackAction {
  if (!isRecord(raw)) return 'ask_user'
  const action = cleanText(raw.action, 40)
  return FALLBACK_ACTIONS.has(action) ? action as McpFallbackAction : 'ask_user'
}

function canProceedWithoutMcp(requirement: McpExecutionRequirement | {
  requirement: McpRequirementLevel
  fallback: { action: McpFallbackAction }
}): boolean {
  return requirement.requirement === 'optional' && requirement.fallback.action === 'continue_without_mcp'
}

function normalizeRequirement(raw: unknown): McpExecutionRequirement | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const mcpId = cleanText(value.mcpId, 80)
  if (mcpId === '') return null
  const requirement = value.requirement === 'optional' ? 'optional' : 'required'
  return {
    mcpId,
    requirement,
    reason: cleanText(value.reason, 360),
    assignment: normalizeAssignment(value.assignment),
    agentPermissions: normalizePermissions(value.agentPermissions),
    prohibitedCapabilities: cleanTextArray(value.prohibitedCapabilities, 30, 100),
    fallback: normalizeFallback(value.fallback),
  }
}

function normalizePromptOverlays(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {}
  const result: Record<string, string> = {}
  for (const [agent, overlay] of Object.entries(raw)) {
    const normalizedAgent = cleanAgent(agent)
    const text = cleanText(overlay, 1000)
    if (normalizedAgent && text !== '') result[normalizedAgent] = text
  }
  return result
}

function normalizeSubtask(raw: unknown): McpAwareSubtask | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const id = cleanText(value.id, 80)
  const agent = cleanAgent(value.agent)
  if (id === '' || !agent) return null
  return {
    id,
    agent,
    dependsOn: cleanTextArray(value.dependsOn, 20, 80),
    mcpCapabilities: cleanTextArray(value.mcpCapabilities, 30, 100),
    inputs: cleanTextArray(value.inputs, 20, 120),
    outputs: cleanTextArray(value.outputs, 20, 120),
    verification: cleanTextArray(value.verification, 20, 160),
    stoppingCondition: cleanText(value.stoppingCondition, 240),
    fallback: cleanText(value.fallback, 240),
  }
}

function normalizeDesign(parsed: unknown): McpExecutionDesign | null {
  if (!isMcpExecutionDesignShape(parsed)) return null
  const value = parsed as Record<string, unknown>
  return {
    schemaVersion: 1,
    requirements: Array.isArray(value.requirements)
      ? value.requirements.map(normalizeRequirement).filter((item): item is McpExecutionRequirement => item !== null).slice(0, 20)
      : [],
    promptOverlays: normalizePromptOverlays(value.promptOverlays),
    mcpAwareSubtasks: Array.isArray(value.mcpAwareSubtasks)
      ? value.mcpAwareSubtasks.map(normalizeSubtask).filter((item): item is McpAwareSubtask => item !== null).slice(0, 40)
      : [],
  }
}

export function parseMcpExecutionDesign(rawText: string): ParsedMcpExecutionDesign {
  const match = findFence(rawText, FENCE_REGEX, isMcpExecutionDesignShape)
  if (!match) return { planText: rawText.trim(), design: null }

  let design: McpExecutionDesign | null = null
  try {
    design = normalizeDesign(JSON.parse(match.jsonBlock))
  } catch {
    design = null
  }

  return {
    planText: rawText.replace(match.fullMatch, '').trim(),
    design,
  }
}

function healthFor(mcpOverview: ProjectMcpOverview, mcpId: string) {
  return mcpOverview.statuses.find((status) => status.mcpId === mcpId) ?? null
}

function healthyStatus(status: ProjectMcpStatus | null): boolean {
  return status?.installState === 'installed' && status.enabled && status.status === 'healthy'
}

function statusMessage(mcpId: string, status: ProjectMcpStatus | null): string {
  if (!status) return `MCP '${mcpId}' is not configured for this project.`
  return `MCP '${mcpId}' is ${status.installState}/${status.status}${status.error ? `: ${status.error}` : ''}`
}

function unknownMcpMessage(mcpId: string): string {
  return `Unknown MCP '${mcpId}' was requested.`
}

function requirementCapabilities(requirement: McpExecutionRequirement): string[] {
  return [...new Set(Object.values(requirement.agentPermissions).flat())]
}

function requirementCapabilitiesForAgent(requirement: McpExecutionRequirement, agent: string): string[] {
  return requirement.agentPermissions[agent] ?? []
}

function isPlanningOnlyFilesystemWrite(mcpId: string, capability: string): boolean {
  return mcpId === 'filesystem' && normalizeCapability(capability) === 'filesystem.project.write'
}

function planningOnlyFilesystemWriteWarning(source: string): string {
  return `${source} requested filesystem.project.write; Forge ignores this as a live MCP capability because generated file writes are handled by the sandbox execution JSON path.`
}

export function validateMcpExecutionDesign(
  design: McpExecutionDesign | null,
  mcpOverview: ProjectMcpOverview,
): McpExecutionValidation {
  const blocked: string[] = []
  const warnings: string[] = []
  const referencedMcps = new Set<string>()

  if (!design) {
    warnings.push('Architect did not provide a machine-readable MCP execution design.')
  } else {
    for (const requirement of design.requirements) {
      referencedMcps.add(requirement.mcpId)
      if (!isKnownMcpId(requirement.mcpId)) {
        blocked.push(`Unknown MCP '${requirement.mcpId}' was requested.`)
        continue
      }

      for (const capability of requirementCapabilities(requirement)) {
        if (isPlanningOnlyFilesystemWrite(requirement.mcpId, capability)) {
          warnings.push(planningOnlyFilesystemWriteWarning(`MCP '${requirement.mcpId}'`))
          continue
        }
        const unsafe = unsafeCapability(requirement.mcpId, capability, requirement.prohibitedCapabilities)
        if (unsafe) {
          blocked.push(`MCP '${requirement.mcpId}' capability '${unsafe}' is outside the allowed beta scope.`)
        }
      }

      const status = healthFor(mcpOverview, requirement.mcpId)
      if (!status) {
        const message = statusMessage(requirement.mcpId, null)
        if (!canProceedWithoutMcp(requirement)) blocked.push(message)
        else warnings.push(message)
        continue
      }

      if (!healthyStatus(status)) {
        const message = statusMessage(requirement.mcpId, status)
        if (!canProceedWithoutMcp(requirement)) blocked.push(message)
        else warnings.push(message)
      }
    }

    const approvedCapabilitiesByAgent = new Map<string, Set<string>>()
    for (const requirement of design.requirements) {
      if (!isKnownMcpId(requirement.mcpId)) continue
      for (const agent of agentsForRequirement(requirement)) {
        const current = approvedCapabilitiesByAgent.get(agent) ?? new Set<string>()
        for (const capability of requirementCapabilitiesForAgent(requirement, agent)) {
          if (isPlanningOnlyFilesystemWrite(requirement.mcpId, capability)) continue
          if (unsafeCapability(requirement.mcpId, capability, requirement.prohibitedCapabilities) === null) {
            for (const key of approvedCoverageCapabilityKeys(capability)) current.add(key)
          }
        }
        approvedCapabilitiesByAgent.set(agent, current)
      }
    }
    const prohibitedCapabilities = new Set(
      design.requirements.flatMap((requirement) =>
        requirement.prohibitedCapabilities.flatMap(prohibitedCoverageCapabilityKeys),
      ),
    )

    for (const subtask of design.mcpAwareSubtasks) {
      const approvedCapabilities = approvedCapabilitiesByAgent.get(subtask.agent) ?? new Set<string>()
      for (const capability of subtask.mcpCapabilities) {
        const normalizedCapability = normalizeCapability(capability)
        const mcpId = capabilityMcpId(normalizedCapability)
        if (!mcpId) {
          blocked.push(`MCP-aware subtask capability '${normalizedCapability}' does not name a known MCP.`)
          continue
        }
        if (isPlanningOnlyFilesystemWrite(mcpId, normalizedCapability)) {
          warnings.push(planningOnlyFilesystemWriteWarning('MCP-aware subtask'))
          continue
        }
        const unsafe = unsafeCapability(mcpId, normalizedCapability, [...prohibitedCapabilities])
        if (unsafe) {
          blocked.push(`MCP-aware subtask capability '${unsafe}' is outside the allowed beta scope.`)
          continue
        }
        if (!approvedCapabilities.has(coverageCapabilityKey(normalizedCapability))) {
          const message = `MCP-aware subtask capability '${normalizedCapability}' is not covered by an explicit approved grant.`
          if (approvedCapabilities.size === 0) warnings.push(message)
          else blocked.push(message)
        }
      }
    }
  }

  const health: McpExecutionValidation['health'] = [...referencedMcps].map((mcpId) => {
    const status = healthFor(mcpOverview, mcpId)
    return {
      mcpId,
      installState: status?.installState ?? 'unknown',
      status: status?.status ?? 'unknown',
      enabled: status?.enabled ?? false,
      error: status?.error ?? null,
    }
  })

  return {
    status: blocked.length > 0 ? 'blocked' : warnings.length > 0 ? 'warnings' : 'valid',
    runtimeEnforcement: MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT,
    health,
    blocked,
    warnings,
  }
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function objectArrayFrom(value: unknown): Record<string, unknown>[] {
  return arrayFromUnknown(value).filter(isRecord)
}

function metadataMcpGrants(metadata: unknown): Record<string, unknown>[] {
  if (!isRecord(metadata)) return []
  return objectArrayFrom(metadata.mcpGrants)
}

function metadataHasRunScopedMcpInstructions(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  return cleanText(metadata.promptOverlay, 200) !== '' || objectArrayFrom(metadata.mcpAwareSubtasks).length > 0
}

function metadataMcpAwareSubtasks(metadata: unknown): Record<string, unknown>[] {
  if (!isRecord(metadata)) return []
  return objectArrayFrom(metadata.mcpAwareSubtasks)
}

function capabilityArray(entry: Record<string, unknown>): {
  capabilities: string[]
  present: boolean
} {
  // Read the union of both `capabilities` and `permissions` so the broker
  // validates exactly what the executor surfaces to the model. The executor's
  // mcpCapabilityList() and this helper historically read these two fields with
  // opposite precedence; merging both removes any chance the gate approves one
  // list while the run is instructed on the other.
  const present = Array.isArray(entry.capabilities) || Array.isArray(entry.permissions)
  const merged = [
    ...cleanTextArray(entry.capabilities, 40, 100),
    ...cleanTextArray(entry.permissions, 40, 100),
  ]
  return {
    capabilities: [...new Set(merged)],
    present,
  }
}

function brokerEntries(input: {
  harnessToolPolicy?: unknown
  mcpRequirements?: unknown
  metadata?: unknown
}): Record<string, unknown>[] {
  return [
    ...objectArrayFrom(input.mcpRequirements),
    ...metadataMcpGrants(input.metadata),
  ]
}

export function hasWorkPackageMcpRuntimeInputs(input: {
  harnessToolPolicy?: unknown
  mcpRequirements?: unknown
  metadata?: unknown
}): boolean {
  return brokerEntries(input).length > 0 || metadataHasRunScopedMcpInstructions(input.metadata)
}

function normalizeCapability(capability: string): string {
  return capability.trim().toLowerCase().replace(/\s+/g, '_')
}

function coverageCapabilityKey(capability: string): string {
  return normalizeCapability(capability)
}

function filesystemProjectAlias(capability: string): string | null {
  const normalized = normalizeCapability(capability)
  const filesystemAlias = normalized.match(/^filesystem\.(read|list|search)$/)
  return filesystemAlias ? `filesystem.project.${filesystemAlias[1]}` : null
}

function approvedCoverageCapabilityKeys(capability: string): string[] {
  const normalized = normalizeCapability(capability)
  const projectAlias = filesystemProjectAlias(normalized)
  // Unqualified filesystem read/list/search grants are project-root scoped in
  // this beta path, so they also satisfy the explicit filesystem.project.*
  // spelling. A filesystem.project.* grant does not widen back to unqualified
  // filesystem access.
  return projectAlias ? [normalized, projectAlias] : [normalized]
}

function filesystemUnqualifiedAlias(capability: string): string | null {
  const normalized = normalizeCapability(capability)
  const match = normalized.match(/^filesystem\.project\.(read|list|search)$/)
  return match ? `filesystem.${match[1]}` : null
}

function prohibitedCoverageCapabilityKeys(capability: string): string[] {
  const normalized = normalizeCapability(capability)
  const keys = new Set<string>([normalized])
  // A prohibition must strike every spelling that would satisfy it. Unqualified
  // filesystem read/list/search grants are project-root scoped and cover the
  // explicit filesystem.project.* spelling, so prohibiting either spelling has
  // to remove both — otherwise prohibiting `filesystem.project.list` leaves an
  // approved `filesystem.list` that still grants the prohibited capability.
  const projectAlias = filesystemProjectAlias(normalized)
  if (projectAlias) keys.add(projectAlias)
  const unqualifiedAlias = filesystemUnqualifiedAlias(normalized)
  if (unqualifiedAlias) keys.add(unqualifiedAlias)
  return [...keys]
}

function unsafeCapability(mcpId: string, capability: string, prohibitedCapabilities: string[]): string | null {
  const normalized = normalizeCapability(capability)
  const prohibited = new Set(prohibitedCapabilities.flatMap(prohibitedCoverageCapabilityKeys))
  if (prohibited.has(coverageCapabilityKey(normalized))) return normalized

  const safePatterns = Object.prototype.hasOwnProperty.call(SAFE_BETA_CAPABILITY_PATTERNS, mcpId)
    ? SAFE_BETA_CAPABILITY_PATTERNS[mcpId]
    : []
  return safePatterns.some((pattern) => pattern.test(normalized)) ? null : normalized
}

function capabilityMcpId(capability: string): string | null {
  const normalized = normalizeCapability(capability)
  const [mcpId] = normalized.split('.', 1)
  return mcpId && isKnownMcpId(mcpId) ? mcpId : null
}

export function evaluateWorkPackageMcpBroker(input: {
  assignedRole?: string
  harnessToolPolicy?: unknown
  mcpOverview?: ProjectMcpOverview | null
  mcpRequirements?: unknown
  metadata?: unknown
  title?: string
}): WorkPackageMcpBrokerCheck {
  const blocked: string[] = []
  const warnings: string[] = []
  const entries = brokerEntries(input)
  const hasRunScopedMcpInstructions = metadataHasRunScopedMcpInstructions(input.metadata)
  const approvedCapabilities = new Set<string>()
  // A capability prohibited by any grant entry is prohibited for the whole
  // package — collect them globally so it can't be "approved" by a different
  // entry and then satisfy a subtask coverage check.
  const prohibitedAll = new Set<string>()

  for (const entry of entries) {
    const mcpId = cleanText(entry.mcpId, 80)
    if (mcpId === '') continue

    const requirement = entry.requirement === 'optional' ? 'optional' : 'required'
    const fallback = fallbackAction(entry.fallback)
    const grantStatus = cleanText(entry.status, 40)
    const prohibitedCapabilities = cleanTextArray(entry.prohibitedCapabilities, 40, 120)
    for (const prohibited of prohibitedCapabilities) {
      for (const key of prohibitedCoverageCapabilityKeys(prohibited)) prohibitedAll.add(key)
    }
    const { capabilities, present: capabilitiesPresent } = capabilityArray(entry)

    const canContinueWithoutMcp = requirement === 'optional' && fallback === 'continue_without_mcp'
    const shouldBlock = (message: string) => {
      if (canContinueWithoutMcp) warnings.push(message)
      else blocked.push(message)
    }

    if (!isKnownMcpId(mcpId)) {
      blocked.push(unknownMcpMessage(mcpId))
      continue
    }

    if (grantStatus === 'blocked') {
      warnings.push(`MCP '${mcpId}' grant was previously blocked; current MCP health and capability policy will be re-evaluated.`)
    } else if (grantStatus === 'warning') {
      warnings.push(`MCP '${mcpId}' grant is warning-only.`)
    }

    if (requirement === 'required' && (!capabilitiesPresent || capabilities.length === 0)) {
      const message = `MCP '${mcpId}' has no approved capabilities for required access.`
      if (hasRunScopedMcpInstructions) warnings.push(message)
      else blocked.push(message)
    }

    let actionableCapabilityCount = 0
    for (const capability of capabilities) {
      const normalizedCapability = normalizeCapability(capability)
      if (isPlanningOnlyFilesystemWrite(mcpId, normalizedCapability)) {
        warnings.push(planningOnlyFilesystemWriteWarning(`MCP '${mcpId}'`))
        continue
      }
      actionableCapabilityCount += 1
      const unsafe = unsafeCapability(mcpId, capability, prohibitedCapabilities)
      if (unsafe) {
        blocked.push(`MCP '${mcpId}' capability '${unsafe}' is outside the allowed beta scope.`)
      } else {
        for (const key of approvedCoverageCapabilityKeys(normalizedCapability)) approvedCapabilities.add(key)
      }
    }

    if (input.mcpOverview) {
      const status = healthFor(input.mcpOverview, mcpId)
      if (!healthyStatus(status)) {
        const message = statusMessage(mcpId, status)
        shouldBlock(message)
      }
    }

    if (requirement === 'required' && capabilities.length > 0 && actionableCapabilityCount === 0) {
      warnings.push(`MCP '${mcpId}' has no live MCP capabilities to approve after planning-only capabilities were ignored.`)
    }

  }

  for (const prohibited of prohibitedAll) approvedCapabilities.delete(prohibited)

  for (const subtask of metadataMcpAwareSubtasks(input.metadata)) {
    for (const capability of cleanTextArray(subtask.mcpCapabilities, 40, 120)) {
      const normalizedCapability = normalizeCapability(capability)
      const mcpId = capabilityMcpId(normalizedCapability)
      if (!mcpId) {
        blocked.push(`MCP-aware subtask capability '${normalizedCapability}' does not name a known MCP.`)
        continue
      }
      if (isPlanningOnlyFilesystemWrite(mcpId, normalizedCapability)) {
        warnings.push(planningOnlyFilesystemWriteWarning('MCP-aware subtask'))
        continue
      }
      const unsafe = unsafeCapability(mcpId, normalizedCapability, [...prohibitedAll])
      if (unsafe) {
        blocked.push(`MCP-aware subtask capability '${unsafe}' is outside the allowed beta scope.`)
        continue
      }
      if (!approvedCapabilities.has(coverageCapabilityKey(normalizedCapability))) {
        const message = `MCP-aware subtask capability '${normalizedCapability}' is not covered by an explicit approved grant.`
        if (approvedCapabilities.size === 0) warnings.push(message)
        else blocked.push(message)
      }
    }
  }

  if (hasRunScopedMcpInstructions && approvedCapabilities.size === 0) {
    warnings.push('Run-scoped MCP prompt overlays or subtasks have no explicit non-blocked MCP grant decision; Forge will pass them as planning-only prompt context without live MCP tools.')
  }

  const packageLabel = cleanText(input.title, 120) || cleanText(input.assignedRole, 80) || 'work package'
  const blockedReason = blocked.length > 0
    ? `MCP/capability broker blocked "${packageLabel}": ${blocked.join('; ')}`
    : null

  return {
    status: blocked.length > 0 ? 'blocked' : warnings.length > 0 ? 'warnings' : 'allowed',
    blocked,
    warnings,
    blockedReason,
  }
}

function agentsForRequirement(requirement: McpExecutionRequirement): string[] {
  const agents = new Set<string>([
    ...requirement.assignment.targetAgents,
    ...Object.keys(requirement.agentPermissions),
  ])

  if (requirement.assignment.type === 'architect_only') agents.add('architect')
  if (requirement.assignment.type === 'reviewer_only') agents.add('reviewer')

  return [...agents].filter((agent) => /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/.test(agent)).sort()
}

function decisionStatus(
  requirement: McpExecutionRequirement,
  status: ProjectMcpStatus | null,
  capabilities: string[],
): McpGrantDecisionStatus {
  if (!isKnownMcpId(requirement.mcpId)) return 'blocked'
  if (capabilities.length === 0) return 'warning'
  // A capability outside the safe beta allowlist (or explicitly prohibited) is
  // blocked at handoff by evaluateWorkPackageMcpBroker. Apply the same allowlist
  // here so the grant-decision preview never advertises an unsafe capability as
  // "proposed" (i.e. ready to approve) while the broker would block it.
  const actionableCapabilities = capabilities.filter(
    (capability) => !isPlanningOnlyFilesystemWrite(requirement.mcpId, capability),
  )
  if (actionableCapabilities.length === 0) return 'warning'
  const hasUnsafeCapability = actionableCapabilities.some(
    (capability) => unsafeCapability(requirement.mcpId, capability, requirement.prohibitedCapabilities) !== null,
  )
  if (hasUnsafeCapability) return 'blocked'
  const healthy = status?.installState === 'installed' && status.enabled && status.status === 'healthy'
  if (healthy) return 'proposed'
  if (canProceedWithoutMcp(requirement)) return 'warning'
  return 'blocked'
}

export function deriveMcpGrantDecisions(
  design: McpExecutionDesign | null,
  mcpOverview: ProjectMcpOverview,
): McpGrantDecisions {
  const summary: Record<McpGrantDecisionStatus, number> = {
    proposed: 0,
    warning: 0,
    blocked: 0,
  }

  if (!design) {
    return {
      schemaVersion: 1,
      runtimeEnforcement: MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT,
      summary,
      decisions: [],
    }
  }

  const decisions: McpGrantDecisions['decisions'] = []
  design.requirements.forEach((requirement, index) => {
    const status = healthFor(mcpOverview, requirement.mcpId)
    const agents = agentsForRequirement(requirement)

    for (const agent of agents) {
      const capabilities = requirement.agentPermissions[agent] ?? []
      const grantStatus = decisionStatus(requirement, status, capabilities)
      summary[grantStatus] += 1
      decisions.push({
        decisionId: `req-${index}:${agent}:${requirement.mcpId}`,
        sourceRequirementIndex: index,
        agent,
        mcpId: requirement.mcpId,
        capabilities,
        requirement: requirement.requirement,
        status: grantStatus,
        reason: requirement.reason,
        assignment: {
          type: requirement.assignment.type,
          targetId: requirement.assignment.targetId,
        },
        fallback: requirement.fallback,
        health: {
          installState: status?.installState ?? 'unknown',
          status: status?.status ?? 'unknown',
          enabled: status?.enabled ?? false,
          error: status?.error ?? null,
        },
        promptOverlayPresent: typeof design.promptOverlays[agent] === 'string',
      })
    }
  })

  return {
    schemaVersion: 1,
    runtimeEnforcement: MCP_EXECUTION_DESIGN_RUNTIME_ENFORCEMENT,
    summary,
    decisions,
  }
}
