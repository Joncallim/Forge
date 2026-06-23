/**
 * Open Questions parsing
 * ------------------------------------------------------------------------
 * The architect prompt (see `buildArchitectPrompt` in orchestrator.ts) asks
 * the model to emit a machine-parseable Open Questions block in addition to
 * its Markdown plan, delimited by a fenced code block tagged
 * `open_questions_json`:
 *
 *   ```open_questions_json
 *   { "questions": [{ "question": "...", "suggestions": ["...", "..."] }] }
 *   ```
 *
 * If the architect has no open questions it should emit an empty array.
 * This module extracts that block, validates its shape, and strips it out
 * of the plan text so the Markdown artifact shown to the user only contains
 * the human-readable plan.
 */

export const OPEN_QUESTIONS_FENCE = 'open_questions_json'

export interface OpenQuestion {
  question: string
  suggestions: string[]
}

export interface ParsedArchitectPlan {
  /** Markdown plan with the open-questions fenced block removed. */
  planText: string
  /** Open questions extracted from the fenced block (deduped, trimmed). */
  questions: OpenQuestion[]
}

const FENCE_REGEX = new RegExp(
  '```' + OPEN_QUESTIONS_FENCE + '\\s*\\n([\\s\\S]*?)\\n?```',
  'i',
)

function normalizeSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []

  const seen = new Set<string>()
  const suggestions: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    suggestions.push(trimmed)
    if (suggestions.length === 4) break
  }
  return suggestions
}

function normalizeQuestions(raw: unknown): OpenQuestion[] {
  if (!Array.isArray(raw)) return []

  const seen = new Set<string>()
  const questions: OpenQuestion[] = []
  for (const item of raw) {
    const question =
      typeof item === 'string'
        ? item
        : typeof item === 'object' &&
            item !== null &&
            typeof (item as { question?: unknown }).question === 'string'
          ? (item as { question: string }).question
          : ''

    const trimmed = question.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    questions.push({
      question: trimmed,
      suggestions:
        typeof item === 'object' && item !== null
          ? normalizeSuggestions((item as { suggestions?: unknown }).suggestions)
          : [],
    })
  }
  return questions
}

/**
 * Parses the architect's raw output, extracting the Open Questions JSON
 * block (if present) and stripping it from the Markdown plan text.
 *
 * Tolerant of malformed/missing JSON: on parse failure, returns an empty
 * question list rather than throwing, since a malformed block should not
 * block the whole pipeline.
 */
export function parseOpenQuestions(rawText: string): ParsedArchitectPlan {
  const match = FENCE_REGEX.exec(rawText)
  if (!match) {
    return { planText: rawText.trim(), questions: [] }
  }

  const jsonBlock = match[1]
  let questions: OpenQuestion[] = []
  try {
    const parsed = JSON.parse(jsonBlock)
    questions = normalizeQuestions(parsed?.questions)
  } catch {
    questions = []
  }

  const planText = rawText.replace(match[0], '').trim()
  return { planText, questions }
}
