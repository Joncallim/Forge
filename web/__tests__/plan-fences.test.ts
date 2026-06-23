import { describe, expect, it } from 'vitest'
import { AGENT_BREAKDOWN_FENCE, OPEN_QUESTIONS_FENCE, stripKnownFences } from '@/lib/plan-fences'

describe('stripKnownFences', () => {
  it('removes both fenced blocks, in either order', () => {
    const text = [
      '# Plan',
      'Do the thing.',
      '',
      '```' + AGENT_BREAKDOWN_FENCE,
      '{"agents":[]}',
      '```',
      '',
      '```' + OPEN_QUESTIONS_FENCE,
      '{"questions":[]}',
      '```',
    ].join('\n')

    const stripped = stripKnownFences(text)
    expect(stripped).toBe('# Plan\nDo the thing.')
    expect(stripped).not.toContain(AGENT_BREAKDOWN_FENCE)
    expect(stripped).not.toContain(OPEN_QUESTIONS_FENCE)
  })

  it('is tolerant of casing and missing trailing newline before the closing fence', () => {
    const text = '# Plan\n```Agent_Breakdown_JSON\n{"agents":[]}```'
    expect(stripKnownFences(text)).toBe('# Plan')
  })

  it('leaves text unchanged when no fences are present', () => {
    expect(stripKnownFences('  # Plan\nbody  ')).toBe('# Plan\nbody')
  })

  it('returns the trimmed text when only one fence is present', () => {
    const text = '# Plan\n\n```' + AGENT_BREAKDOWN_FENCE + '\n{"agents":[]}\n```'
    expect(stripKnownFences(text)).toBe('# Plan')
  })
})
