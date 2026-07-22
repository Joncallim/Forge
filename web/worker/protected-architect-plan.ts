import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalArchitectPlanJson,
  type ArchitectPlanEntryInput,
} from '@/lib/mcps/architect-plan-entries'
import { canonicalAgentPackageIdentity } from '@/lib/mcps/agent-package-identity'
import type { PreparedArchitectArtifact } from './architect-artifact'
import type { McpExecutionRequirement } from './mcp-execution-design'
import type { OpenQuestion } from './open-questions'

const BINDING_DOMAIN_V1 = Buffer.from('forge:architect-plan-binding:v1\0', 'utf8')
const ENTRY_COMPONENT = /^[a-z0-9._-]{1,64}$/

export type ArchitectRoutingEnvelope = {
  schemaVersion: 1
  sourceRequirementIndex: number
  requirementKey: string
  agent: string
  assignment: {
    type: McpExecutionRequirement['assignment']['type']
    targetId: string | null
  }
}

function requirementAgents(requirement: McpExecutionRequirement): string[] {
  const agents = new Set([
    ...requirement.assignment.targetAgents,
    ...Object.keys(requirement.agentPermissions),
  ])
  if (requirement.assignment.type === 'architect_only') agents.add('architect')
  if (requirement.assignment.type === 'reviewer_only') agents.add('reviewer')
  return [...new Set([...agents].map(canonicalAgentPackageIdentity))].sort()
}

function routingEnvelope(
  requirement: McpExecutionRequirement,
  agent: string,
): ArchitectRoutingEnvelope {
  const requirementKey = requirement.requirementKey
  const sourceRequirementIndex = requirement.sourceRequirementIndex
  if (
    !requirementKey
    || !ENTRY_COMPONENT.test(requirementKey)
    || !Number.isSafeInteger(sourceRequirementIndex)
    || (sourceRequirementIndex ?? -1) < 0
    || !ENTRY_COMPONENT.test(agent)
  ) {
    throw new Error('Protected Architect routing requires canonical requirement, source-index, and agent bindings.')
  }
  return {
    schemaVersion: 1,
    sourceRequirementIndex: sourceRequirementIndex!,
    requirementKey,
    agent,
    assignment: {
      type: requirement.assignment.type,
      targetId: requirement.assignment.targetId,
    },
  }
}

export function architectPlanBindingFingerprint(envelope: ArchitectRoutingEnvelope): string {
  return `sha256:${createHash('sha256')
    .update(BINDING_DOMAIN_V1)
    .update(canonicalArchitectPlanJson(envelope), 'utf8')
    .digest('hex')}`
}

function requirementByKey(
  prepared: PreparedArchitectArtifact,
  requirementKey: string,
): McpExecutionRequirement | null {
  return prepared.mcpExecutionDesign.proposed?.requirements.find(
    (requirement) => requirement.requirementKey === requirementKey,
  ) ?? null
}

/**
 * Splits one normalized Architect result into its sole protected text store.
 * Public artifacts and work-package metadata receive only safe headers and
 * content-free references derived from the returned envelopes.
 */
export function buildProtectedArchitectPlanEntries(input: {
  planText: string
  prepared: PreparedArchitectArtifact
}): ArchitectPlanEntryInput[] {
  const entries: ArchitectPlanEntryInput[] = [{
    agent: null,
    bindingFingerprint: null,
    content: input.planText,
    entryId: 'plan_body:000000',
    entryKind: 'plan_body',
    projectionEligible: false,
    requirementKey: null,
  }, {
    agent: null,
    bindingFingerprint: null,
    content: canonicalArchitectPlanJson({
      schemaVersion: 1,
      kind: 'plan_policy',
      agentBreakdown: input.prepared.agents,
      agentBreakdownSource: input.prepared.agentBreakdownSource,
      capabilityClassification: input.prepared.capabilityClassification.proposed,
    }),
    entryId: 'requirement:plan-policy',
    entryKind: 'requirement',
    projectionEligible: false,
    requirementKey: 'plan-policy',
  }]
  const design = input.prepared.mcpExecutionDesign.proposed
  if (!design) return entries

  const bindings = new Map<string, { envelope: ArchitectRoutingEnvelope; fingerprint: string }>()
  for (const requirement of design.requirements) {
    const requirementKey = requirement.requirementKey
    if (!requirementKey || !ENTRY_COMPONENT.test(requirementKey)) {
      throw new Error('Protected Architect requirement is missing its canonical requirement key.')
    }
    entries.push({
      agent: null,
      bindingFingerprint: null,
      content: canonicalArchitectPlanJson({ schemaVersion: 1, ...requirement }),
      entryId: `requirement:${requirementKey}`,
      entryKind: 'requirement',
      projectionEligible: false,
      requirementKey,
    })
    for (const agent of requirementAgents(requirement)) {
      const envelope = routingEnvelope(requirement, agent)
      const fingerprint = architectPlanBindingFingerprint(envelope)
      bindings.set(`${requirementKey}\0${agent}`, { envelope, fingerprint })
      entries.push({
        agent,
        bindingFingerprint: fingerprint,
        content: canonicalArchitectPlanJson(envelope),
        entryId: `routing:${requirementKey}:${agent}`,
        entryKind: 'routing',
        projectionEligible: false,
        requirementKey,
      })
    }
  }

  for (const context of design.requirementContexts ?? []) {
    const agent = canonicalAgentPackageIdentity(context.agent)
    const binding = bindings.get(`${context.requirementKey}\0${agent}`)
    if (!binding) throw new Error('Protected Architect overlay has no exact routing binding.')
    entries.push({
      agent,
      bindingFingerprint: binding.fingerprint,
      content: context.promptOverlay,
      entryId: `overlay:${context.requirementKey}:${agent}`,
      entryKind: 'overlay',
      projectionEligible: true,
      requirementKey: context.requirementKey,
    })
  }

  for (const subtask of design.mcpAwareSubtasks) {
    const agent = canonicalAgentPackageIdentity(subtask.agent)
    if (!ENTRY_COMPONENT.test(subtask.id) || !ENTRY_COMPONENT.test(agent)) {
      throw new Error('Protected Architect subtask ID or agent is not a canonical entry component.')
    }
    const capabilityBindings = subtask.capabilityBindings ?? []
    const requirementKeys = [...new Set(capabilityBindings.map((binding) => binding.requirementKey))].sort()
    const retainedBindings = capabilityBindings.map((capabilityBinding) => {
      if (!capabilityBinding.capability || !capabilityBinding.requirementKey
        || !requirementByKey(input.prepared, capabilityBinding.requirementKey)) {
        throw new Error('Protected Architect subtask references an unknown capability binding.')
      }
      const binding = bindings.get(`${capabilityBinding.requirementKey}\0${agent}`)
      if (!binding) {
        throw new Error(`Protected Architect subtask is missing routing for ${capabilityBinding.requirementKey}.`)
      }
      return binding
    })
    const requirementKey = requirementKeys[0] ?? null
    const bindingFingerprint = requirementKey
      ? bindings.get(`${requirementKey}\0${agent}`)?.fingerprint ?? null
      : null
    entries.push({
      agent,
      bindingFingerprint,
      content: canonicalArchitectPlanJson({ schemaVersion: 1, ...subtask }),
      entryId: `subtask:${subtask.id}:${agent}`,
      entryKind: 'subtask',
      projectionEligible: capabilityBindings.length > 0
        && retainedBindings.length === capabilityBindings.length,
      requirementKey,
    })
  }
  return entries
}

export type ProtectedClarificationAnswer = {
  question: string
  answer: string
}

/**
 * Appends immutable, self-contained clarification evidence to one complete
 * protected plan version. Prior clarification entries are supplied by the
 * caller and carried forward unchanged before this version's new evidence.
 */
export function appendProtectedArchitectClarifications(input: {
  entries: readonly ArchitectPlanEntryInput[]
  openQuestions: readonly OpenQuestion[]
  answeredQuestions: readonly ProtectedClarificationAnswer[]
}): ArchitectPlanEntryInput[] {
  const clarificationEntry = (
    entryKind: 'clarification_question' | 'clarification_answer',
    content: string,
  ): ArchitectPlanEntryInput => ({
    agent: null,
    bindingFingerprint: null,
    content,
    entryId: `${entryKind}:${randomUUID()}`,
    entryKind,
    projectionEligible: false,
    requirementKey: null,
  })
  return [
    ...input.entries,
    ...input.openQuestions.map((question) => clarificationEntry(
      'clarification_question',
      canonicalArchitectPlanJson({
        schemaVersion: 1,
        question: question.question,
        suggestions: question.suggestions,
      }),
    )),
    ...input.answeredQuestions.map((answer) => clarificationEntry(
      'clarification_answer',
      canonicalArchitectPlanJson({
        schemaVersion: 1,
        question: answer.question,
        answer: answer.answer,
      }),
    )),
  ]
}
