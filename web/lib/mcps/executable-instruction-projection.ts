import type { McpWorkPackageAdmission } from './admission'

const MAX_REQUIREMENTS = 20
const MAX_SUBTASKS = 40
const MAX_CONTENT_CHARS = 2_000
const SAFE_COMPONENT = /^[a-z0-9._:-]{1,256}$/

export type ResolvedArchitectInstructionSource = {
  agent: string
  content: string
  key: string
}

export type ExecutableMcpInstructionProjection = {
  schemaVersion: 1
  requirementInstructions: Array<{
    requirementKey: string
    agent: string
    mcpId: string
    mode: 'planning_only' | 'bounded_context_approved'
    content: string
  }>
  subtasks: Array<{
    subtaskId: string
    agent: string
    content: string
    bindings: Array<{ capability: string; requirementKey: string }>
  }>
  staticBoundaryWarnings: string[]
}

const STATIC_BOUNDARY_WARNING =
  'Forge omitted Architect-authored MCP text that is not currently admitted for this run.'

function admittedRequirement(
  evaluation: McpWorkPackageAdmission['evaluations'][number],
): evaluation is McpWorkPackageAdmission['evaluations'][number] & {
  decision: McpWorkPackageAdmission['evaluations'][number]['decision'] & {
    mode: 'planning_only' | 'bounded_context_approved'
  }
} {
  const decision = evaluation.decision
  if (decision.status === 'allowed') {
    return decision.mode === 'planning_only' || decision.mode === 'bounded_context_approved'
  }
  return decision.status === 'warning' &&
    decision.mode === 'planning_only' &&
    decision.capabilityClasses.length > 0 &&
    decision.capabilityClasses.every((entry) => entry.class === 'planning_only')
}

function safeSource(
  source: ResolvedArchitectInstructionSource | undefined,
  expectedAgent: string,
): ResolvedArchitectInstructionSource | null {
  if (
    !source ||
    source.agent !== expectedAgent ||
    !SAFE_COMPONENT.test(source.key) ||
    source.content.length === 0 ||
    source.content.length > MAX_CONTENT_CHARS
  ) return null
  return { ...source, content: source.content.normalize('NFC') }
}

/**
 * Projects only already-resolved, task-bound protected history. Rejected source
 * text is never accepted as an argument, echoed into a warning, or repaired
 * from work-package metadata.
 */
export function projectExecutableMcpInstructions(input: {
  admission: McpWorkPackageAdmission
  requirementSources: ReadonlyMap<string, ResolvedArchitectInstructionSource>
  subtaskSources: ReadonlyMap<string, ResolvedArchitectInstructionSource>
}): ExecutableMcpInstructionProjection {
  const requirementInstructions: ExecutableMcpInstructionProjection['requirementInstructions'] = []
  const staticBoundaryWarnings = new Set<string>()
  const admittedRequirements = new Set<string>()

  for (const evaluation of input.admission.evaluations) {
    const requirementKey = evaluation.source.requirementKey
    const source = safeSource(input.requirementSources.get(requirementKey), evaluation.decision.agent)
    if (!admittedRequirement(evaluation) || !source) {
      if (evaluation.source.promptOverlayPresent || source) staticBoundaryWarnings.add(STATIC_BOUNDARY_WARNING)
      continue
    }
    if (requirementInstructions.length >= MAX_REQUIREMENTS) {
      throw new Error(`Executable MCP requirements exceed the maximum count of ${MAX_REQUIREMENTS}`)
    }
    requirementInstructions.push({
      requirementKey,
      agent: evaluation.decision.agent,
      mcpId: evaluation.decision.mcpId,
      mode: evaluation.decision.mode,
      content: source.content,
    })
    admittedRequirements.add(`${requirementKey}\0${evaluation.decision.agent}`)
  }

  const decisionsBySubtask = new Map<string, McpWorkPackageAdmission['subtaskDecisions']>()
  for (const decision of input.admission.subtaskDecisions) {
    const existing = decisionsBySubtask.get(decision.subtaskId) ?? []
    existing.push(decision)
    decisionsBySubtask.set(decision.subtaskId, existing)
  }

  const subtasks: ExecutableMcpInstructionProjection['subtasks'] = []
  for (const [subtaskId, decisions] of [...decisionsBySubtask].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const agent = decisions[0]?.agent ?? ''
    const source = safeSource(input.subtaskSources.get(subtaskId), agent)
    const eligible = decisions.length > 0 && decisions.every((decision) => (
      decision.agent === agent &&
      decision.status === 'allowed' &&
      admittedRequirements.has(`${decision.requirementKey}\0${agent}`)
    ))
    if (!source || !eligible) {
      if (source) staticBoundaryWarnings.add(STATIC_BOUNDARY_WARNING)
      continue
    }
    if (subtasks.length >= MAX_SUBTASKS) {
      throw new Error(`Executable MCP subtasks exceed the maximum count of ${MAX_SUBTASKS}`)
    }
    const bindings = decisions
      .map((decision) => ({ capability: decision.capability, requirementKey: decision.requirementKey }))
      .sort((left, right) => (
        left.requirementKey.localeCompare(right.requirementKey, 'en') ||
        left.capability.localeCompare(right.capability, 'en')
      ))
    subtasks.push({ subtaskId, agent, content: source.content, bindings })
  }

  return {
    schemaVersion: 1,
    requirementInstructions,
    subtasks,
    staticBoundaryWarnings: [...staticBoundaryWarnings],
  }
}
