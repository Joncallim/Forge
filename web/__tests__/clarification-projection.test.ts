import { describe, expect, it } from 'vitest'
import { clarificationQuestionsFromHistory } from '@/lib/mcps/clarification-projection'

describe('audited clarification history projection', () => {
  it('uses protected history text while preserving the current opaque submission id', () => {
    const result = clarificationQuestionsFromHistory([{
      entryId: 'clarification_question:11111111-1111-4111-8111-111111111111',
      entryKind: 'clarification_question',
      content: JSON.stringify({
        schemaVersion: 1,
        question: 'Which branch?',
        suggestions: ['main', 'release'],
      }),
    }, {
      entryId: 'clarification_answer:22222222-2222-4222-8222-222222222222',
      entryKind: 'clarification_answer',
      content: JSON.stringify({ schemaVersion: 1, question: 'Which branch?', answer: 'main' }),
    }, {
      entryId: 'clarification_question:33333333-3333-4333-8333-333333333333',
      entryKind: 'clarification_question',
      content: JSON.stringify({
        schemaVersion: 1,
        question: 'Which environment?',
        suggestions: ['staging', 'production'],
      }),
    }], [{
      id: '44444444-4444-4444-8444-444444444444',
      status: 'open',
      createdAt: '2026-07-22T00:00:00.000Z',
      answeredAt: null,
    }])

    expect(result).toEqual([{
      id: 'clarification_question:11111111-1111-4111-8111-111111111111',
      status: 'answered',
      createdAt: '1970-01-01T00:00:00.000Z',
      answeredAt: null,
      question: 'Which branch?',
      suggestions: ['main', 'release'],
      answer: 'main',
    }, {
      id: '44444444-4444-4444-8444-444444444444',
      status: 'open',
      createdAt: '2026-07-22T00:00:00.000Z',
      answeredAt: null,
      question: 'Which environment?',
      suggestions: ['staging', 'production'],
      answer: null,
    }])
  })

  it('does not display malformed or unaudited generic question text', () => {
    expect(clarificationQuestionsFromHistory([{
      entryId: 'clarification_question:bad',
      entryKind: 'clarification_question',
      content: '{not-json',
    }], [{
      id: '55555555-5555-4555-8555-555555555555',
      status: 'open',
      createdAt: '2026-07-22T00:00:00.000Z',
      answeredAt: null,
    }])).toEqual([])
  })
})
