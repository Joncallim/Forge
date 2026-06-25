import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { computeLineDiff, PlanDiffView } from '@/components/PlanDiffView'

describe('computeLineDiff', () => {
  it('marks everything unchanged for identical input', () => {
    const lines = ['a', 'b', 'c']
    expect(computeLineDiff(lines, lines)).toEqual([
      { type: 'unchanged', text: 'a' },
      { type: 'unchanged', text: 'b' },
      { type: 'unchanged', text: 'c' },
    ])
  })

  it('detects a pure addition', () => {
    expect(computeLineDiff(['a', 'b'], ['a', 'b', 'c'])).toEqual([
      { type: 'unchanged', text: 'a' },
      { type: 'unchanged', text: 'b' },
      { type: 'added', text: 'c' },
    ])
  })

  it('detects a pure removal', () => {
    expect(computeLineDiff(['a', 'b', 'c'], ['a', 'c'])).toEqual([
      { type: 'unchanged', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'unchanged', text: 'c' },
    ])
  })

  it('detects a replacement as removed+added', () => {
    expect(computeLineDiff(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { type: 'unchanged', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'x' },
      { type: 'unchanged', text: 'c' },
    ])
  })

  it('handles an empty old side (all added)', () => {
    expect(computeLineDiff([], ['a', 'b'])).toEqual([
      { type: 'added', text: 'a' },
      { type: 'added', text: 'b' },
    ])
  })

  it('handles an empty new side (all removed)', () => {
    expect(computeLineDiff(['a', 'b'], [])).toEqual([
      { type: 'removed', text: 'a' },
      { type: 'removed', text: 'b' },
    ])
  })

  it('renders normalized markdown arrow artifacts in plan diffs', () => {
    const html = renderToStaticMarkup(createElement(PlanDiffView, {
      oldContent: 'Frontend $\\rightarrow$ QA',
      newContent: 'QA $\\rightarrow$ Reviewer',
    }))

    expect(html).toContain('Frontend → QA')
    expect(html).toContain('QA → Reviewer')
    expect(html).not.toContain('$\\rightarrow$')
  })
})
