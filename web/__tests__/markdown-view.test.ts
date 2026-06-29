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
})
