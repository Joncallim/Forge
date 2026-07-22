export type TaskQuestionSummary = Readonly<{
  id: string
  status: string
  createdAt: string
  answeredAt: string | null
}>

export type DisplayClarification = TaskQuestionSummary & Readonly<{
  question: string
  suggestions: string[]
  answer: string | null
}>

type QuestionRow = Readonly<{
  id: string
  status: string
  createdAt: Date | string
  answeredAt: Date | string | null
}>

type ProtectedHistoryEntry = Readonly<{
  entryId: string
  entryKind: string
  content: string
}>

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function taskQuestionSummary(row: QuestionRow): TaskQuestionSummary {
  return {
    id: row.id,
    status: row.status,
    createdAt: timestamp(row.createdAt) ?? new Date(0).toISOString(),
    answeredAt: timestamp(row.answeredAt),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function clarificationContent(entry: ProtectedHistoryEntry): Record<string, unknown> | null {
  if (!['clarification_question', 'clarification_answer'].includes(entry.entryKind)) return null
  try {
    const parsed = record(JSON.parse(entry.content))
    return parsed?.schemaVersion === 1 && typeof parsed.questionId === 'string' && typeof parsed.question === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Builds the question UI only from credential-bound protected history text.
 * Generic task-question rows contribute opaque IDs, status, and timestamps so
 * open answers can still target the current database row.
 */
export function clarificationQuestionsFromHistory(
  entries: readonly ProtectedHistoryEntry[],
  current: readonly TaskQuestionSummary[],
): DisplayClarification[] {
  const questions = entries.flatMap((entry) => {
    if (entry.entryKind !== 'clarification_question') return []
    const content = clarificationContent(entry)
    if (!content) return []
    const suggestions = Array.isArray(content.suggestions)
      ? content.suggestions.filter((value): value is string => typeof value === 'string').slice(0, 4)
      : []
    return [{ entry, question: content.question as string, suggestions }]
  })
  const answers = new Map<string, string>()
  for (const entry of entries) {
    if (entry.entryKind !== 'clarification_answer') continue
    const content = clarificationContent(entry)
    if (!content || typeof content.answer !== 'string' || typeof content.questionId !== 'string') continue
    if (answers.has(content.questionId)) throw new Error('Duplicate protected clarification answer.')
    answers.set(content.questionId, content.answer)
  }

  const summaries = new Map(current.map((summary) => [summary.id, summary]))
  return questions.flatMap(({ entry, question, suggestions }) => {
    const content = clarificationContent(entry)!
    const questionId = content.questionId as string
    const summary = summaries.get(questionId)
    const answer = answers.get(questionId) ?? null
    if (!summary && answer === null) return []
    return [{
      id: summary?.id ?? entry.entryId,
      status: summary?.status ?? 'answered',
      createdAt: summary?.createdAt ?? new Date(0).toISOString(),
      answeredAt: summary?.answeredAt ?? null,
      question,
      suggestions,
      answer,
    }]
  })
}
