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
  agentBreakdownSource: 'fence' | 'fallback'
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
const MIN_REVISION_LINES_FOR_GUARD = 6
const MIN_RETAINED_LINE_RATIO = 0.55
const MAX_LINE_COUNT_GROWTH = 2.4
const MIN_SHORT_PLAN_WORDS_FOR_GUARD = 20
const REFERENCE_APPENDIX_HEADING_PATTERN =
  /^\s{0,3}(?:#{1,6}\s+)?(?:(?:original|old|previous|prior)\s+(?:implementation\s+)?plan(?:\s+(?:excerpt|reference))?|(?:implementation\s+)?plan\s+(?:for\s+)?(?:reference|comparison))\b/i

function normalizePlanLine(line: string): string {
  return line
    .replace(/[`*_>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function meaningfulPlanLines(plan: string): string[] {
  return plan
    .split('\n')
    .map(normalizePlanLine)
    .filter((line) => line.length >= 8)
}

function uniqueLines(lines: string[]): string[] {
  return [...new Set(lines)]
}

function planWords(plan: string): string[] {
  return plan
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []
}

function retainedWordRatio(previousPlan: string, revisedPlan: string): number {
  const previousWords = uniqueLines(planWords(previousPlan))
  if (previousWords.length < MIN_SHORT_PLAN_WORDS_FOR_GUARD) return 0
  const revisedWords = new Set(planWords(revisedPlan))
  const retained = previousWords.filter((word) => revisedWords.has(word)).length
  return retained / previousWords.length
}

function hasReferenceAppendixHeading(plan: string): boolean {
  return plan
    .split('\n')
    .some((line, index) => index > 1 && REFERENCE_APPENDIX_HEADING_PATTERN.test(line))
}


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
    throw new UnusableArchitectPlanError(
      'The architect runtime returned no plan text. Retry the plan change with a shorter instruction or select another planning provider.',
    )
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

/**
 * Replans are operator edits to an existing approval artifact, not permission
 * to replace the whole plan. This catches provider/model outputs that ignore
 * the previous plan and generate a mostly-new document.
 */
export function assertTargetedPlanRevision(
  previousPlan: string,
  revisedPlan: string,
): void {
  const previousLines = uniqueLines(meaningfulPlanLines(previousPlan))
  const referenceAppendixHeading = hasReferenceAppendixHeading(revisedPlan)
  if (previousLines.length < MIN_REVISION_LINES_FOR_GUARD) {
    const previousWordCount = uniqueLines(planWords(previousPlan)).length
    const revisedWordCount = uniqueLines(planWords(revisedPlan)).length
    const wordGrowth = previousWordCount > 0 ? revisedWordCount / previousWordCount : Number.POSITIVE_INFINITY
    if (previousWordCount < MIN_SHORT_PLAN_WORDS_FOR_GUARD) {
      throw new UnusableArchitectPlanError(
        'The previous implementation plan is too short to verify targeted revisions. Restart the task instead of replacing this approval artifact.',
      )
    }
    if (referenceAppendixHeading || retainedWordRatio(previousPlan, revisedPlan) < MIN_RETAINED_LINE_RATIO || wordGrowth > MAX_LINE_COUNT_GROWTH) {
      throw new UnusableArchitectPlanError(
        'The revised plan replaced too much of the original implementation plan. Request smaller, targeted changes or restart the task for a new plan.',
      )
    }
    return
  }

  const revisedLines = uniqueLines(meaningfulPlanLines(revisedPlan))
  if (revisedLines.length === 0) {
    throw new UnusableArchitectPlanError('The revised plan removed the original implementation plan instead of making targeted changes.')
  }

  const revisedSet = new Set(revisedLines)
  const retained = previousLines.filter((line) => revisedSet.has(line)).length
  const retainedRatio = retained / previousLines.length
  const lineCountGrowth = revisedLines.length / previousLines.length
  const retainedIndices = previousLines
    .map((line) => revisedLines.findIndex((candidate) => candidate === line))
    .filter((index) => index >= 0)
  let orderedRetained = 0
  let searchFrom = 0
  for (const line of previousLines) {
    const index = revisedLines.findIndex((candidate, candidateIndex) => candidateIndex >= searchFrom && candidate === line)
    if (index === -1) continue
    orderedRetained += 1
    searchFrom = index + 1
  }
  const orderedRetainedRatio = orderedRetained / previousLines.length
  const firstRetainedIndex = retainedIndices.length > 0 ? Math.min(...retainedIndices) : -1
  const retainedIndicesByPosition = [...new Set(retainedIndices)].sort((a, b) => a - b)
  const retainedNeededForMajority = Math.ceil(previousLines.length * MIN_RETAINED_LINE_RATIO)
  const earlyRetainedGaps = retainedIndicesByPosition
    .slice(0, retainedNeededForMajority)
    .some((index, retainedIndex, indices) => retainedIndex > 0 && index - indices[retainedIndex - 1] > 3)
  const lateReferenceThreshold = Math.max(2, Math.floor(revisedLines.length * 0.25))
  const appendedReferenceLikely =
    referenceAppendixHeading ||
    firstRetainedIndex > lateReferenceThreshold ||
    orderedRetainedRatio < MIN_RETAINED_LINE_RATIO ||
    earlyRetainedGaps

  if (retainedRatio < MIN_RETAINED_LINE_RATIO || lineCountGrowth > MAX_LINE_COUNT_GROWTH || appendedReferenceLikely) {
    throw new UnusableArchitectPlanError(
      'The revised plan replaced too much of the original implementation plan. Request smaller, targeted changes or restart the task for a new plan.',
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
  const { planText, agents, source } = parseAgentBreakdown(planWithoutCapabilities)

  return {
    planText,
    questions,
    agents,
    agentBreakdownSource: source,
    capabilityClassification,
    mcpExecutionDesign: {
      proposed: design,
      validation: validateMcpExecutionDesign(design, mcpOverview),
      grantDecisions: deriveMcpGrantDecisions(design, mcpOverview),
    },
  }
}
