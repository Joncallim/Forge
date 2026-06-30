import type { ProjectMcpOverview } from '@/lib/mcps/types'
import { parseAgentBreakdown, type PlannedAgent } from './agent-breakdown'
import { parseCapabilityClassification, type CapabilityClassificationMetadata } from './capability-classification'
import {
  deriveMcpGrantDecisions,
  parseMcpExecutionDesign,
  type McpExecutionDesign,
  type McpExecutionValidation,
  type McpGrantDecisions,
  validateMcpExecutionDesign,
} from './mcp-execution-design'
import { parseOpenQuestions, type OpenQuestion } from './open-questions'

export type PreparedArchitectArtifact = {
  planText: string
  questions: OpenQuestion[]
  agents: PlannedAgent[]
  capabilityClassification: CapabilityClassificationMetadata
  mcpExecutionDesign: {
    proposed: McpExecutionDesign | null
    validation: McpExecutionValidation
    grantDecisions: McpGrantDecisions
  }
}

/**
 * Raised when the architect stage produced output that is not a usable plan —
 * an empty response, an adapter/transport failure leaking into the message
 * stream (common with ACP runtimes whose backend timed out), or text with no
 * plan substance. The orchestrator turns this into a failed task instead of
 * asking the operator to approve garbage.
 */
export class UnusableArchitectPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnusableArchitectPlanError'
  }
}

// Signatures of an architect "answer" that is really a transport/runtime
// failure rather than a plan. Mirrors the ACP failure patterns so a codex/claude
// adapter that times out or falls back transports cannot be mistaken for a plan.
const ARCHITECT_FATAL_FAILURE_PATTERNS: RegExp[] = [
  /falling back from websockets to https transport/i,
  /\bconnection (?:refused|reset|closed|timed out)\b/i,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bstream (?:error|closed unexpectedly)\b/i,
]

const ARCHITECT_UNSTRUCTURED_FAILURE_PATTERNS: RegExp[] = [
  /\brequest timed out\b/i,
  /\b(?:usage|rate|token) limit (?:exceeded|reached|hit)\b/i,
  /\b(?:exceeded|reached|hit) (?:your |the )?(?:usage|rate|token) limit\b/i,
  /\b(?:error|failed|provider|runtime|request).*too many requests\b/i,
  /\binsufficient[_ -]?quota\b/i,
  /\bout of (?:tokens|credits)\b/i,
  /\b(?:error code|status code|request failed with|returned|reported)\s*:?\s*429\b/i,
  /\b429\b.{0,80}\b(?:rate limit|quota|try again|retry later)\b/i,
]

const MIN_PLAN_TEXT_LENGTH = 80

/**
 * Validates that the architect actually produced a plan. Throws
 * UnusableArchitectPlanError otherwise. Open questions count as a usable
 * outcome (the task moves to awaiting_answers), as does any non-trivial plan
 * body or a structured agent breakdown.
 */
export function assertUsableArchitectPlan(
  rawText: string,
  prepared: PreparedArchitectArtifact,
): void {
  const raw = rawText.trim()
  if (raw === '') {
    throw new UnusableArchitectPlanError('The architect runtime returned no output.')
  }

  if (ARCHITECT_FATAL_FAILURE_PATTERNS.some((pattern) => pattern.test(raw))) {
    throw new UnusableArchitectPlanError(
      `The architect runtime reported a transport failure instead of a plan: ${raw.slice(0, 240)}`,
    )
  }

  // A structured outcome (a real agent breakdown or open questions) is usable
  // even if the prose happens to mention "429" or rate limits. Broader quota
  // and timeout signatures only apply to unstructured output so we do not reject
  // a genuine structured plan that merely discusses those topics.
  const hasQuestions = prepared.questions.length > 0
  const hasAgents = prepared.agents.length > 0
  if (hasQuestions || hasAgents) return

  if (ARCHITECT_UNSTRUCTURED_FAILURE_PATTERNS.some((pattern) => pattern.test(raw))) {
    throw new UnusableArchitectPlanError(
      `The architect runtime reported a transport, timeout, or quota failure instead of a plan: ${raw.slice(0, 240)}`,
    )
  }

  if (prepared.planText.trim().length < MIN_PLAN_TEXT_LENGTH) {
    throw new UnusableArchitectPlanError(
      'The architect runtime did not produce a usable plan (no plan body, agent breakdown, or open questions).',
    )
  }
}

export function prepareArchitectArtifact(
  rawText: string,
  mcpOverview: ProjectMcpOverview,
): PreparedArchitectArtifact {
  const { planText: planWithoutQuestions, questions } = parseOpenQuestions(rawText)
  const { planText: planWithoutMcpDesign, design } = parseMcpExecutionDesign(planWithoutQuestions)
  const { planText: planWithoutCapabilities, capabilityClassification } = parseCapabilityClassification(planWithoutMcpDesign)
  const { planText, agents } = parseAgentBreakdown(planWithoutCapabilities)

  return {
    planText,
    questions,
    agents,
    capabilityClassification,
    mcpExecutionDesign: {
      proposed: design,
      validation: validateMcpExecutionDesign(design, mcpOverview),
      grantDecisions: deriveMcpGrantDecisions(design, mcpOverview),
    },
  }
}
