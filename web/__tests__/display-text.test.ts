import { describe, expect, it } from 'vitest'
import { normalizeMarkdownDisplayText } from '@/lib/display-text'

describe('normalizeMarkdownDisplayText', () => {
  it('renders common LaTeX right-arrow artifacts outside code fences', () => {
    expect(normalizeMarkdownDisplayText('Frontend $\\rightarrow$ QA')).toBe('Frontend → QA')
    expect(normalizeMarkdownDisplayText('QA \\rightarrow Reviewer')).toBe('QA → Reviewer')
  })

  it('does not rewrite code fences', () => {
    const content = ['Before $\\rightarrow$ after', '```', 'literal $\\rightarrow$', '```'].join('\n')

    expect(normalizeMarkdownDisplayText(content)).toBe([
      'Before → after',
      '```',
      'literal $\\rightarrow$',
      '```',
    ].join('\n'))
  })
})
