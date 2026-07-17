import { createHash } from 'node:crypto'
import { canonicalAgentPackageIdentity } from '@/lib/mcps/agent-package-identity'
import { mcpCapabilityCeilingForAgent } from '@/lib/mcps/plan-review-metadata'
import type { ProjectMcpOverview } from '@/lib/mcps/types'
import {
  deriveMcpGrantDecisions,
  MCP_PLANNING_ACCESS_MODE,
  parseMcpExecutionDesign,
  type McpAssignmentType,
  type McpExecutionDesign,
  type McpExecutionRequirement,
} from '@/worker/mcp-execution-design'

export type McpPlanReviewItemInput = {
  requirementKey: string
  decision: 'approved' | 'denied'
  assignment: {
    type: McpAssignmentType
    targetAgents: string[]
    targetId: string | null
  }
  agentPermissions: Record<string, string[]>
  promptOverlays: Record<string, string>
}

export type McpPlanReviewInput = {
  sourceArtifactId: string
  baseRevision: number
  baseDigest: string | null
  items: McpPlanReviewItemInput[]
}

export type McpOperatorReviewRecord = {
  schemaVersion: 1
  sourceArtifactId: string
  revision: number
  previousDigest: string | null
  digest: string
  createdAt: string
  createdBy: string
  accessMode: typeof MCP_PLANNING_ACCESS_MODE
  items: McpPlanReviewItemInput[]
  reviewedDesign: McpExecutionDesign
  blockers: string[]
}

export type McpReviewedPackageProjection = {
  id: string
  assignedRole: string
  title: string
  mcpRequirements: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
}

export const MAX_MCP_OPERATOR_REVIEW_REVISIONS = 32

export type McpOperatorReviewHistoryValidation =
  | { valid: true; history: McpOperatorReviewRecord[]; head: McpOperatorReviewRecord | null }
  | { valid: false; error: string; history: []; head: null }

type ReviewBuildInput = {
  proposedDesign: McpExecutionDesign
  plannedAgents: string[]
  review: McpPlanReviewInput
  previous: McpOperatorReviewRecord | null
  createdBy: string
  createdAt?: Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  )
}

function digestRecord(value: Omit<McpOperatorReviewRecord, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function requirementKey(requirement: McpExecutionRequirement, index: number): string {
  return requirement.requirementKey ?? `legacy-source-${requirement.sourceRequirementIndex ?? index}-${requirement.mcpId}`
}

function requirementAgents(requirement: McpExecutionRequirement): string[] {
  const agents = new Set([...requirement.assignment.targetAgents, ...Object.keys(requirement.agentPermissions)])
  if (requirement.assignment.type === 'architect_only') agents.add('architect')
  if (requirement.assignment.type === 'reviewer_only') agents.add('reviewer')
  return [...agents].map(canonicalAgentPackageIdentity).sort()
}

function normalizeAgent(value: string): string {
  return canonicalAgentPackageIdentity(value.trim().toLowerCase())
}

function normalizedReviewItems(items: McpPlanReviewItemInput[]): McpPlanReviewItemInput[] {
  return items.map((item) => {
    if (item.decision === 'denied') {
      return {
        requirementKey: item.requirementKey,
        decision: 'denied',
        assignment: { type: 'agent', targetAgents: [], targetId: null },
        agentPermissions: {},
        promptOverlays: {},
      }
    }
    return {
      requirementKey: item.requirementKey,
      decision: item.decision,
      assignment: {
        type: item.assignment.type,
        targetAgents: [...new Set(item.assignment.targetAgents.map(normalizeAgent).filter(Boolean))].sort(),
        targetId: item.assignment.targetId?.trim() || null,
      },
      agentPermissions: Object.fromEntries(Object.entries(item.agentPermissions)
        .map(([agent, capabilities]) => [normalizeAgent(agent), [...new Set(capabilities.map((capability) => capability.trim()).filter(Boolean))].sort()] as const)
        .filter(([agent, capabilities]) => agent !== '' && capabilities.length > 0)
        .sort(([left], [right]) => left.localeCompare(right))),
      promptOverlays: Object.fromEntries(Object.entries(item.promptOverlays)
        .map(([agent, overlay]) => [normalizeAgent(agent), overlay.trim().replace(/\s+/g, ' ')] as const)
        .filter(([agent, overlay]) => agent !== '' && overlay !== '')
        .sort(([left], [right]) => left.localeCompare(right))),
    }
  })
}

function validateAssignment(item: McpPlanReviewItemInput, plannedAgents: Set<string>, label: string): string[] {
  if (item.decision === 'denied') return []
  const errors: string[] = []
  const targets = item.assignment.type === 'architect_only'
    ? ['architect']
    : item.assignment.type === 'reviewer_only'
      ? ['reviewer']
      : item.assignment.targetAgents
  if (item.assignment.type === 'agent' && targets.length !== 1) {
    errors.push(`${label} must assign exactly one agent.`)
  }
  if (item.assignment.type === 'multiple_agents' && targets.length < 2) {
    errors.push(`${label} must assign at least two agents.`)
  }
  if (item.assignment.type === 'workforce' && (!item.assignment.targetId || targets.length === 0)) {
    errors.push(`${label} workforce assignment needs a target id and at least one package agent.`)
  }
  if (targets.length === 0) errors.push(`${label} must target at least one package agent.`)
  for (const agent of targets) {
    if (!plannedAgents.has(agent)) errors.push(`${label} targets unknown package agent '${agent}'.`)
    if (!item.agentPermissions[agent]?.length) errors.push(`${label} must specify reduced capabilities for '${agent}'.`)
  }
  for (const agent of Object.keys(item.agentPermissions)) {
    if (!targets.includes(agent)) errors.push(`${label} specifies capabilities for unassigned agent '${agent}'.`)
  }
  for (const [agent, overlay] of Object.entries(item.promptOverlays)) {
    if (!targets.includes(agent)) errors.push(`${label} specifies an overlay for unassigned agent '${agent}'.`)
    if (overlay.length > 1000) errors.push(`${label} overlay for '${agent}' exceeds 1000 characters.`)
  }
  return errors
}

function rawReviewedDesign(
  proposed: McpExecutionDesign,
  reviewedItems: McpPlanReviewItemInput[],
): { raw: Record<string, unknown>; blockers: string[] } {
  const originalByKey = new Map(proposed.requirements.map((requirement, index) => [requirementKey(requirement, index), requirement]))
  const blockers: string[] = []
  const included: Array<{ sourceKey: string; requirement: McpExecutionRequirement; item: McpPlanReviewItemInput }> = []

  reviewedItems.forEach((item) => {
    const requirement = originalByKey.get(item.requirementKey)
    if (!requirement) return
    if (item.decision === 'denied') {
      if (requirement.requirement === 'required' || requirement.fallback.action !== 'continue_without_mcp') {
        blockers.push(`${requirement.mcpId} requirement '${item.requirementKey}' was denied and requires plan revision.`)
      }
      return
    }
    included.push({ sourceKey: item.requirementKey, requirement, item })
  })

  const includedIndex = new Map(included.map((entry, index) => [entry.sourceKey, index]))
  const requirements = included.map(({ requirement, item }) => ({
    mcpId: requirement.mcpId,
    requirement: requirement.requirement,
    reason: requirement.reason,
    confidence: requirement.confidence ?? 'medium',
    scope: { kind: 'project' },
    accessMode: MCP_PLANNING_ACCESS_MODE,
    assignment: item.assignment,
    agentPermissions: item.agentPermissions,
    prohibitedCapabilities: requirement.prohibitedCapabilities,
    fallback: requirement.fallback,
  }))
  const requirementContexts = included.flatMap(({ sourceKey, requirement, item }) => {
    const sourceRequirementIndex = includedIndex.get(sourceKey)
    if (sourceRequirementIndex === undefined) return []
    return Object.entries(item.promptOverlays).map(([agent, promptOverlay]) => ({
      sourceRequirementIndex,
      agent,
      mcpId: requirement.mcpId,
      promptOverlay,
    }))
  })

  const retainedSubtasks = proposed.mcpAwareSubtasks.flatMap((subtask) => {
    const bindings = subtask.capabilityBindings ?? []
    const capabilityRequirements = bindings.flatMap((binding) => {
      const sourceRequirementIndex = includedIndex.get(binding.requirementKey)
      const reviewedItem = reviewedItems.find((item) => item.requirementKey === binding.requirementKey && item.decision === 'approved')
      const capabilities = reviewedItem?.agentPermissions[normalizeAgent(subtask.agent)] ?? []
      return sourceRequirementIndex !== undefined && capabilities.includes(binding.capability)
        ? [{ capability: binding.capability, sourceRequirementIndex }]
        : []
    })
    if (capabilityRequirements.length !== subtask.mcpCapabilities.length) return []
    return [{
      id: subtask.id,
      agent: subtask.agent,
      scope: { kind: 'project' },
      accessMode: MCP_PLANNING_ACCESS_MODE,
      dependsOn: subtask.dependsOn,
      mcpCapabilities: subtask.mcpCapabilities,
      capabilityRequirements,
      inputs: subtask.inputs,
      outputs: subtask.outputs,
      verification: subtask.verification,
      stoppingCondition: subtask.stoppingCondition,
      fallback: subtask.fallback,
    }]
  })
  const retainedIds = new Set(retainedSubtasks.map((subtask) => subtask.id))
  for (const subtask of retainedSubtasks) {
    const missingDependencies = subtask.dependsOn.filter((dependency) => !retainedIds.has(dependency))
    if (missingDependencies.length > 0) {
      blockers.push(
        `MCP-aware subtask '${subtask.id}' depends on unavailable subtask${missingDependencies.length === 1 ? '' : 's'} ${missingDependencies.map((id) => `'${id}'`).join(', ')}. Revise the plan or restore the required capabilities.`,
      )
    }
  }

  return {
    raw: { schemaVersion: 1, requirements, promptOverlays: {}, requirementContexts, mcpAwareSubtasks: retainedSubtasks },
    blockers,
  }
}

export function buildMcpOperatorReview(input: ReviewBuildInput): McpOperatorReviewRecord {
  if (input.review.sourceArtifactId.trim() === '') throw new Error('A source artifact id is required.')
  if ((input.proposedDesign.normalizationErrors?.length ?? 0) > 0) {
    throw new Error('The Architect MCP plan has unresolved normalization blockers. Replan before recording an operator review.')
  }
  const previousRevision = input.previous?.revision ?? 0
  const previousDigest = input.previous?.digest ?? null
  if (input.review.baseRevision !== previousRevision || input.review.baseDigest !== previousDigest) {
    throw new Error('MCP plan review revision conflict. Reload the task and try again.')
  }
  if (previousRevision >= MAX_MCP_OPERATOR_REVIEW_REVISIONS) {
    throw new Error(`MCP plan review reached its ${MAX_MCP_OPERATOR_REVIEW_REVISIONS}-revision limit. Replan before recording another review.`)
  }

  const proposedByKey = new Map(input.proposedDesign.requirements.map((requirement, index) => [requirementKey(requirement, index), requirement]))
  const items = normalizedReviewItems(input.review.items)
  if (items.length !== proposedByKey.size || new Set(items.map((item) => item.requirementKey)).size !== proposedByKey.size) {
    throw new Error('Every proposed MCP requirement must be reviewed exactly once.')
  }
  const plannedAgents = new Set(input.plannedAgents.map(normalizeAgent))
  plannedAgents.add('architect')
  plannedAgents.add('reviewer')
  for (const [index, item] of items.entries()) {
    const original = proposedByKey.get(item.requirementKey)
    if (!original) throw new Error(`Review item ${index + 1} does not match a proposed MCP requirement.`)
    for (const [agent, capabilities] of Object.entries(item.agentPermissions)) {
      const allowedCapabilities = new Set(mcpCapabilityCeilingForAgent(original, agent))
      for (const capability of capabilities) {
        if (!allowedCapabilities.has(capability)) {
          throw new Error(`Review item ${index + 1} widens the Architect proposal for '${agent}' with capability '${capability}'.`)
        }
      }
    }
    const errors = validateAssignment(item, plannedAgents, `Review item ${index + 1}`)
    if (errors.length > 0) throw new Error(errors.join(' '))
  }

  const reconstructed = rawReviewedDesign(input.proposedDesign, items)
  const parsed = parseMcpExecutionDesign(`\`\`\`mcp_execution_design_json\n${JSON.stringify(reconstructed.raw)}\n\`\`\``).design
  if (!parsed || (parsed.normalizationErrors?.length ?? 0) > 0) {
    throw new Error(`Reviewed MCP plan is invalid: ${parsed?.normalizationErrors?.join(' ') ?? 'normalization failed.'}`)
  }
  const unsigned: Omit<McpOperatorReviewRecord, 'digest'> = {
    schemaVersion: 1,
    sourceArtifactId: input.review.sourceArtifactId,
    revision: previousRevision + 1,
    previousDigest,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    createdBy: input.createdBy,
    accessMode: MCP_PLANNING_ACCESS_MODE,
    items,
    reviewedDesign: parsed,
    blockers: reconstructed.blockers,
  }
  return { ...unsigned, digest: digestRecord(unsigned) }
}

export function isValidMcpOperatorReview(value: unknown): value is McpOperatorReviewRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.digest !== 'string') return false
  const { digest, ...unsigned } = value
  return digestRecord(unsigned as Omit<McpOperatorReviewRecord, 'digest'>) === digest
}

export function mcpOperatorReviewHistory(metadata: unknown): McpOperatorReviewRecord[] {
  const validation = validateMcpOperatorReviewHistory(metadata)
  return validation.valid ? validation.history : []
}

export function latestMcpOperatorReview(metadata: unknown): McpOperatorReviewRecord | null {
  const validation = validateMcpOperatorReviewHistory(metadata)
  return validation.valid ? validation.head : null
}

function reviewSummary(review: McpOperatorReviewRecord): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceArtifactId: review.sourceArtifactId,
    revision: review.revision,
    digest: review.digest,
    blockers: review.blockers,
  }
}

export function mcpOperatorReviewSummary(review: McpOperatorReviewRecord): Record<string, unknown> {
  return reviewSummary(review)
}

export function validateMcpOperatorReviewHistory(
  metadata: unknown,
  expectedSourceArtifactId?: string | null,
): McpOperatorReviewHistoryValidation {
  if (!isRecord(metadata)) {
    return { valid: true, history: [], head: null }
  }
  const rawHistory = metadata.mcpOperatorReviews
  const rawSummary = metadata.mcpOperatorReview
  if (rawHistory === undefined && rawSummary === undefined) {
    return { valid: true, history: [], head: null }
  }
  if (!Array.isArray(rawHistory) || rawHistory.length === 0 || rawHistory.length > MAX_MCP_OPERATOR_REVIEW_REVISIONS) {
    return { valid: false, error: 'MCP operator review history is missing, empty, or exceeds its revision limit.', history: [], head: null }
  }
  const history: McpOperatorReviewRecord[] = []
  let previousDigest: string | null = null
  let sourceArtifactId: string | null = null
  for (let index = 0; index < rawHistory.length; index += 1) {
    const raw = rawHistory[index]
    if (!isValidMcpOperatorReview(raw)) {
      return { valid: false, error: `MCP operator review revision ${index + 1} failed its digest check.`, history: [], head: null }
    }
    if (raw.revision !== index + 1 || raw.previousDigest !== previousDigest) {
      return { valid: false, error: `MCP operator review history is not a contiguous revision chain at revision ${index + 1}.`, history: [], head: null }
    }
    sourceArtifactId ??= raw.sourceArtifactId
    if (
      raw.sourceArtifactId !== sourceArtifactId ||
      (expectedSourceArtifactId !== undefined && raw.sourceArtifactId !== expectedSourceArtifactId)
    ) {
      return { valid: false, error: 'MCP operator review history does not belong to the current Architect artifact.', history: [], head: null }
    }
    history.push(raw)
    previousDigest = raw.digest
  }
  const head = history.at(-1)!
  if (!isRecord(rawSummary) || JSON.stringify(stableValue(rawSummary)) !== JSON.stringify(stableValue(reviewSummary(head)))) {
    return { valid: false, error: 'MCP operator review summary does not exactly match the validated history head.', history: [], head: null }
  }
  return { valid: true, history, head }
}

function roleMatches(left: string, right: string): boolean {
  return canonicalAgentPackageIdentity(left) === canonicalAgentPackageIdentity(right)
}

export function projectReviewedMcpPlanToPackages(input: {
  review: McpOperatorReviewRecord
  overview: ProjectMcpOverview
  packages: Array<{ id: string; assignedRole: string; title: string; metadata: unknown }>
}): McpReviewedPackageProjection[] {
  if (!isValidMcpOperatorReview(input.review)) throw new Error('The saved MCP operator review failed its digest check.')
  const decisions = deriveMcpGrantDecisions(input.review.reviewedDesign, input.overview).decisions
  return input.packages.map((pkg) => {
    const requirements = input.review.reviewedDesign.requirements
      .filter((requirement) => requirementAgents(requirement).some((agent) => roleMatches(agent, pkg.assignedRole)))
      .map((requirement, index) => ({
        requirementKey: requirement.requirementKey,
        sourceRequirementIndex: requirement.sourceRequirementIndex ?? index,
        agent: pkg.assignedRole,
        mcpId: requirement.mcpId,
        requirement: requirement.requirement,
        reason: requirement.reason,
        confidence: requirement.confidence ?? 'medium',
        scope: requirement.scope ?? { kind: 'project' },
        accessMode: requirement.accessMode ?? MCP_PLANNING_ACCESS_MODE,
        assignment: requirement.assignment,
        permissions: Object.entries(requirement.agentPermissions)
          .filter(([agent]) => roleMatches(agent, pkg.assignedRole))
          .flatMap(([, capabilities]) => capabilities),
        prohibitedCapabilities: requirement.prohibitedCapabilities,
        fallback: requirement.fallback,
      }))
    const grants = decisions.filter((decision) => roleMatches(decision.agent, pkg.assignedRole)).map((decision) => ({
      ...decision,
      agent: pkg.assignedRole,
      normalizedCapabilities: decision.normalizedCapabilities ?? decision.capabilities,
      capabilityClasses: decision.capabilityClasses ?? [],
      admissionStatus: decision.admissionStatus ?? (decision.status === 'proposed' ? 'allowed' : decision.status),
      mode: decision.mode ?? 'unknown_legacy',
      grantState: decision.grantState ?? { phase: 'not_issued' },
      evidenceRefs: decision.evidenceRefs ?? [],
    }))
    const requirementContexts = (input.review.reviewedDesign.requirementContexts ?? [])
      .filter((context) => roleMatches(context.agent, pkg.assignedRole))
      .map((context) => ({ ...context, agent: pkg.assignedRole }))
    const mcpAwareSubtasks = input.review.reviewedDesign.mcpAwareSubtasks
      .filter((subtask) => roleMatches(subtask.agent, pkg.assignedRole))
      .map((subtask) => ({ ...subtask, agent: pkg.assignedRole }))
    const metadata = isRecord(pkg.metadata) ? pkg.metadata : {}
    return {
      ...pkg,
      mcpRequirements: requirements,
      metadata: {
        ...metadata,
        mcpGrantsSchemaVersion: 2,
        mcpGrants: grants,
        mcpNormalizationErrors: metadata.mcpNormalizationErrors ?? [],
        mcpNormalizationEvidence: metadata.mcpNormalizationEvidence ?? [],
        requirementContexts,
        promptOverlay: requirementContexts.map((context) => context.promptOverlay).join('\n\n') || null,
        mcpAwareSubtasks,
        mcpOperatorReview: {
          sourceArtifactId: input.review.sourceArtifactId,
          revision: input.review.revision,
          digest: input.review.digest,
        },
      },
    }
  })
}
