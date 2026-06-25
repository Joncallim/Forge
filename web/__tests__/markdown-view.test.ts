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
})
