/**
 * Shared fence tags for the architect's machine-parseable JSON blocks.
 * ------------------------------------------------------------------------
 * The architect prompt (see `buildArchitectPrompt` in worker/orchestrator.ts)
 * asks the model to follow its Markdown plan with several fenced JSON code
 * blocks, including `agent_breakdown_json`, `capability_classification_json`,
 * `mcp_execution_design_json`, and `open_questions_json`. Worker parsers each
 * parse one block out of the raw text; this module centralizes the fence tag
 * constants so they stay in sync, and provides a defensive helper that strips
 * known blocks even if a caller never ran the real parsers (e.g. a consumer
 * that only wants clean display text).
 *
 * Many models don't follow the exact custom tag and instead emit a generic
 * ```json fence (or no language tag at all), since that's the overwhelmingly
 * common pattern in training data. `findFence()` below handles both: it
 * prefers the exact tag, and falls back to scanning generic json/untagged
 * fences for one whose parsed JSON shape matches `isMatch`, so an unrelated
 * generic JSON block elsewhere in the plan (e.g. an example API response)
 * isn't mistaken for the structured block.
 */

export const AGENT_BREAKDOWN_FENCE = 'agent_breakdown_json'
export const CAPABILITY_CLASSIFICATION_FENCE = 'capability_classification_json'
export const MCP_EXECUTION_DESIGN_FENCE = 'mcp_execution_design_json'
export const OPEN_QUESTIONS_FENCE = 'open_questions_json'

// Case-insensitive tag match, tolerant of trailing whitespace before the
// closing fence and not anchored to end-of-string, so a drifted model
// output (extra spaces, no trailing newline, fence mid-string) still strips.
function fenceRegex(tag: string): RegExp {
  return new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)[ \\t]*\\n?[ \\t]*```', 'gi')
}

// Matches a generic ```json fence or a bare ``` fence with no language tag.
// Deliberately excludes the exact custom tags above (those are matched by
// fenceRegex first); this only catches the common fallback shape.
const GENERIC_JSON_FENCE_REGEX = /```(?:json)?[ \t]*\n([\s\S]*?)[ \t]*\n?[ \t]*```/gi

const AGENT_BREAKDOWN_REGEX = fenceRegex(AGENT_BREAKDOWN_FENCE)
const CAPABILITY_CLASSIFICATION_REGEX = fenceRegex(CAPABILITY_CLASSIFICATION_FENCE)
const MCP_EXECUTION_DESIGN_REGEX = fenceRegex(MCP_EXECUTION_DESIGN_FENCE)
const OPEN_QUESTIONS_REGEX = fenceRegex(OPEN_QUESTIONS_FENCE)

export interface FenceMatch {
  /** Full matched text, including the fence delimiters. */
  fullMatch: string
  /** JSON content between the fences. */
  jsonBlock: string
}

/**
 * Finds the fenced JSON block for a known tag within `text`. Tries the exact
 * tag first (most reliable when the model complies); if absent, scans
 * generic ```json / bare ``` fences for the first whose parsed content
 * satisfies `isMatch`, so we only claim a generic fence that actually looks
 * like the expected shape.
 */
export function findFence(
  text: string,
  exactRegex: RegExp,
  isMatch: (parsed: unknown) => boolean,
): FenceMatch | null {
  const exact = new RegExp(exactRegex.source, exactRegex.flags.replace('g', ''))
  const exactMatch = exact.exec(text)
  if (exactMatch) {
    return { fullMatch: exactMatch[0], jsonBlock: exactMatch[1] }
  }

  const generic = new RegExp(GENERIC_JSON_FENCE_REGEX.source, GENERIC_JSON_FENCE_REGEX.flags)
  let match: RegExpExecArray | null
  while ((match = generic.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (isMatch(parsed)) {
        return { fullMatch: match[0], jsonBlock: match[1] }
      }
    } catch {
      continue
    }
  }

  return null
}

// Beyond an array under the right key, require elements shaped like the real
// thing (an object with the field the parser actually reads) so an unrelated
// generic JSON example elsewhere in the plan — e.g. a sample API response
// that happens to have a top-level "agents" or "questions" array of strings —
// isn't mistaken for the structured block. An empty array is accepted since
// "no agents"/"no open questions" is a valid, expected real shape.
export function isAgentBreakdownShape(parsed: unknown): boolean {
  const agents = (parsed as { agents?: unknown } | null)?.agents
  if (!Array.isArray(agents)) return false
  return agents.every(
    (a) => typeof a === 'object' && a !== null && typeof (a as { role?: unknown }).role === 'string',
  )
}

export function isOpenQuestionsShape(parsed: unknown): boolean {
  const questions = (parsed as { questions?: unknown } | null)?.questions
  if (!Array.isArray(questions)) return false
  // normalizeQuestions() (worker/open-questions.ts) accepts both a bare
  // string and an object with a `question` field — mirror that here.
  return questions.every(
    (q) =>
      typeof q === 'string' ||
      (typeof q === 'object' && q !== null && typeof (q as { question?: unknown }).question === 'string'),
  )
}

export function isMcpExecutionDesignShape(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false
  const value = parsed as { schemaVersion?: unknown; requirements?: unknown; promptOverlays?: unknown; requirementContexts?: unknown; mcpAwareSubtasks?: unknown }
  return (
    value.schemaVersion === 1 &&
    Array.isArray(value.requirements) &&
    typeof value.promptOverlays === 'object' &&
    value.promptOverlays !== null &&
    !Array.isArray(value.promptOverlays) &&
    (value.requirementContexts === undefined || Array.isArray(value.requirementContexts)) &&
    Array.isArray(value.mcpAwareSubtasks)
  )
}

export function isCapabilityClassificationShape(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false
  const value = parsed as { schemaVersion?: unknown; required?: unknown; optional?: unknown; excluded?: unknown }
  return (
    value.schemaVersion === 1 &&
    Array.isArray(value.required) &&
    Array.isArray(value.optional) &&
    Array.isArray(value.excluded)
  )
}

// True for fence content that parses as JSON and carries no information a
// reader would care about — `{}`, `[]`, or whitespace.
function isTrivialJsonFenceContent(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed === '') return true
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return false
  }
  if (Array.isArray(parsed)) return parsed.length === 0
  if (typeof parsed === 'object' && parsed !== null) return Object.keys(parsed).length === 0
  return false
}

// Some models emit a stray empty JSON block (most often trailing one of the
// structured fences above) that isn't shaped like any known block, so
// stripKnownFences's exact and shape-matched passes leave it behind; it then
// renders as a bare `{}` code block at the bottom of the Implementation
// Plan. Only the trailing fence is considered, and only repeatedly peeled
// while it's both trivial AND at the very end of the text — an empty-object
// or empty-array example placed deliberately mid-document (e.g. "an empty
// request body looks like ```json\n{}\n```") is real user-facing content and
// must not be touched, even though its content is just as "trivial" by the
// same JSON.parse check.
// Scans by string index rather than regex backtracking on purpose: a lazy
// `[\s\S]*?` fence-body pattern anchored with `$` doesn't stop at the
// nearest closing ``` when more fences follow — it backtracks past them,
// swallowing earlier fences into the "content" of a single match. Walking
// from the end and matching one fence at a time avoids that.
function stripTrailingTrivialJsonFences(text: string): string {
  let result = text
  for (;;) {
    const trimmedEnd = result.replace(/[ \t\r\n]+$/, '')
    if (!trimmedEnd.endsWith('```')) break

    const closeIdx = trimmedEnd.length - 3
    const openIdx = trimmedEnd.lastIndexOf('```', closeIdx - 1)
    if (openIdx === -1) break

    const tagLineEnd = trimmedEnd.indexOf('\n', openIdx)
    if (tagLineEnd === -1 || tagLineEnd >= closeIdx) break

    const content = trimmedEnd.slice(tagLineEnd + 1, closeIdx)
    if (!isTrivialJsonFenceContent(content)) break

    result = trimmedEnd.slice(0, openIdx)
  }
  return result
}

/**
 * Removes known machine-readable fenced code blocks from `text`, regardless
 * of order or whether every block is present.
 * Falls back to shape-matched generic json fences when the exact tag is
 * absent, mirroring the parsers in worker/agent-breakdown.ts and
 * worker/open-questions.ts. Also peels off any trailing fenced block (any
 * tag) that parses as an empty/trivial JSON value — but only at the very end
 * of the text, so an intentional empty-object/array example placed earlier
 * in the plan's prose is left untouched. Pure function, no DB/IO — safe to
 * call from both server and client code.
 */
export function stripKnownFences(text: string): string {
  let result = text
    .replace(AGENT_BREAKDOWN_REGEX, '')
    .replace(CAPABILITY_CLASSIFICATION_REGEX, '')
    .replace(MCP_EXECUTION_DESIGN_REGEX, '')
    .replace(OPEN_QUESTIONS_REGEX, '')

  const agentBreakdownFallback = findFence(result, AGENT_BREAKDOWN_REGEX, isAgentBreakdownShape)
  if (agentBreakdownFallback) {
    result = result.replace(agentBreakdownFallback.fullMatch, '')
  }

  const capabilityClassificationFallback = findFence(result, CAPABILITY_CLASSIFICATION_REGEX, isCapabilityClassificationShape)
  if (capabilityClassificationFallback) {
    result = result.replace(capabilityClassificationFallback.fullMatch, '')
  }

  const mcpExecutionDesignFallback = findFence(result, MCP_EXECUTION_DESIGN_REGEX, isMcpExecutionDesignShape)
  if (mcpExecutionDesignFallback) {
    result = result.replace(mcpExecutionDesignFallback.fullMatch, '')
  }

  const openQuestionsFallback = findFence(result, OPEN_QUESTIONS_REGEX, isOpenQuestionsShape)
  if (openQuestionsFallback) {
    result = result.replace(openQuestionsFallback.fullMatch, '')
  }

  result = stripTrailingTrivialJsonFences(result)

  return result.trim()
}
