import { describe, it, expect } from 'vitest'
import { parseOpenQuestions, OPEN_QUESTIONS_FENCE } from '@/worker/open-questions'

function withFence(json: string): string {
  return ['# Plan', '', 'Do the thing.', '', '```' + OPEN_QUESTIONS_FENCE, json, '```'].join('\n')
}

describe('parseOpenQuestions', () => {
  it('returns the trimmed plan and no questions when the fence is absent', () => {
    const { planText, questions } = parseOpenQuestions('  # Plan\nbody\n  ')
    expect(planText).toBe('# Plan\nbody')
    expect(questions).toEqual([])
  })

  it('extracts questions and strips the fenced block from the plan', () => {
    const { planText, questions } = parseOpenQuestions(
      withFence('{"questions": ["Which DB?", "Auth method?"]}'),
    )
    expect(questions).toEqual([
      { question: 'Which DB?', suggestions: [] },
      { question: 'Auth method?', suggestions: [] },
    ])
    expect(planText).not.toContain(OPEN_QUESTIONS_FENCE)
    expect(planText).toContain('Do the thing.')
  })

  it('dedupes and trims, dropping empty/non-string entries', () => {
    const { questions } = parseOpenQuestions(
      withFence('{"questions": ["  A  ", "A", "", 5, "B"]}'),
    )
    expect(questions).toEqual([
      { question: 'A', suggestions: [] },
      { question: 'B', suggestions: [] },
    ])
  })

  it('extracts structured questions with up to four suggestions', () => {
    const { questions } = parseOpenQuestions(
      withFence('{"questions":[{"question":"Pick a DB","suggestions":["Postgres","SQLite","Postgres","MySQL","DuckDB"]}]}'),
    )
    expect(questions).toEqual([
      { question: 'Pick a DB', suggestions: ['Postgres', 'SQLite', 'MySQL', 'DuckDB'] },
    ])
  })

  it('treats an empty array as no questions', () => {
    expect(parseOpenQuestions(withFence('{"questions": []}')).questions).toEqual([])
  })

  it('tolerates malformed JSON without throwing (returns no questions)', () => {
    const { questions } = parseOpenQuestions(withFence('{ not valid json'))
    expect(questions).toEqual([])
  })
})
