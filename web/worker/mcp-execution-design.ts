import { MCP_EXECUTION_DESIGN_FENCE, findFence, isMcpExecutionDesignShape } from '@/lib/plan-fences'
import { isKnownMcpId } from '@/lib/mcps/catalog'
import type { ProjectMcpOverview, ProjectMcpStatus } from '@/lib/mcps/types'

const KNOWN_AGENTS = new Set(['architect', 'backend', 'frontend', 'qa', 'reviewer', 'devops'])
const ASSIGNMENT_TYPES = new Set(['agent', 'multiple_agents', 'workforce', 'architect_only', 'reviewer_only'])
const FALLBACK_ACTIONS = new Set(['block', 'continue_without_mcp', 'ask_user'])

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

function cleanAgent(value: unknown): string | null {
  const agent = cleanText(value, 40).toLowerCase()
  return KNOWN_AGENTS.has(agent) ? agent : null
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

      const status = healthFor(mcpOverview, requirement.mcpId)
      if (!status) {
        const message = `MCP '${requirement.mcpId}' is not configured for this project.`
        if (requirement.requirement === 'required') blocked.push(message)
        else warnings.push(message)
        continue
      }

      const healthy = status.installState === 'installed' && status.enabled && status.status === 'healthy'
      if (!healthy) {
        const message = `MCP '${requirement.mcpId}' is ${status.installState}/${status.status}${status.error ? `: ${status.error}` : ''}`
        if (requirement.requirement === 'required') blocked.push(message)
        else warnings.push(message)
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
