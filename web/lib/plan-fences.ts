/**
 * Shared fence tags for the architect's machine-parseable JSON blocks.
 * ------------------------------------------------------------------------
 * The architect prompt (see `buildArchitectPrompt` in worker/orchestrator.ts)
 * asks the model to follow its Markdown plan with two fenced JSON code
 * blocks tagged `agent_breakdown_json` and `open_questions_json`. Both
 * worker/agent-breakdown.ts and worker/open-questions.ts parse one of these
 * blocks out of the raw text; this module centralizes the fence tag
 * constants so both stay in sync, and provides a defensive helper that
 * strips both blocks even if a caller never ran the real parsers (e.g. a
 * consumer that only wants clean display text).
 */

export const AGENT_BREAKDOWN_FENCE = 'agent_breakdown_json'
export const OPEN_QUESTIONS_FENCE = 'open_questions_json'

// Case-insensitive tag match, tolerant of trailing whitespace before the
// closing fence and not anchored to end-of-string, so a drifted model
// output (extra spaces, no trailing newline, fence mid-string) still strips.
function fenceRegex(tag: string): RegExp {
  return new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)[ \\t]*\\n?[ \\t]*```', 'gi')
}

const AGENT_BREAKDOWN_REGEX = fenceRegex(AGENT_BREAKDOWN_FENCE)
const OPEN_QUESTIONS_REGEX = fenceRegex(OPEN_QUESTIONS_FENCE)

/**
 * Removes any `agent_breakdown_json` and `open_questions_json` fenced code
 * blocks from `text`, regardless of order or whether either is present.
 * Pure function, no DB/IO — safe to call from both server and client code.
 */
export function stripKnownFences(text: string): string {
  return text
    .replace(AGENT_BREAKDOWN_REGEX, '')
    .replace(OPEN_QUESTIONS_REGEX, '')
    .trim()
}
