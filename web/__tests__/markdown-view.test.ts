import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownView } from '@/components/MarkdownView'

describe('MarkdownView', () => {
  it('renders normalized markdown arrow artifacts in live output text', () => {
    const html = renderToStaticMarkup(createElement(MarkdownView, {
      content: 'Frontend $\\rightarrow$ QA\nQA $\\rightarrow$ Reviewer',
    }))

    expect(html).toContain('Frontend → QA')
    expect(html).toContain('QA → Reviewer')
    expect(html).not.toContain('$\\rightarrow$')
  })

  it('renders unsafe markdown links as inert text', () => {
    const html = renderToStaticMarkup(createElement(MarkdownView, {
      content: '[review](javascript:alert(1)) [ok](https://example.com)',
    }))

    expect(html).toContain('review')
    expect(html).not.toContain('javascript:alert')
    expect(html).toContain('href="https://example.com"')
  })

  it('preserves nested ordered and unordered list structure', () => {
    const html = renderToStaticMarkup(createElement(MarkdownView, {
      content: [
        '1. First',
        '   1. Child one',
        '   1. Child two',
        '2. Second',
        '   - Sub bullet',
        '     - Deeper bullet',
      ].join('\n'),
    }))

    expect(html).toContain('<li>First<ol')
    expect(html).toContain('<li>Child one</li><li>Child two</li>')
    expect(html).toContain('<li>Second<ul')
    expect(html).toContain('<li>Sub bullet<ul')
    expect(html).not.toContain('1. Child one')
    expect(html).not.toContain('- Sub bullet')
  })
})
