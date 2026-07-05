import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSections } from '@/scripts/github-agent-workflow/core/sections'

const FIXTURE_DIR = path.join(process.cwd(), '__tests__', '__fixtures__', 'github-agent-workflow')

async function readFixture(name: string): Promise<string> {
  return await readFile(path.join(FIXTURE_DIR, name), 'utf8')
}

describe('parseSections', () => {
  it('parses ## and ### headings using the same section rules', async () => {
    const epicMarkdown = await readFixture('epic-h2.md')
    const featureMarkdown = await readFixture('feature-h3-form.md')

    const epicSections = parseSections(epicMarkdown)
    const epicAsH3Sections = parseSections(epicMarkdown.replace(/^## /gm, '### '))
    const featureSections = parseSections(featureMarkdown)

    expect(epicAsH3Sections).toEqual(epicSections)
    expect(featureSections['problem statement']).toContain('structured GitHub Issues')
    expect(featureSections['acceptance criteria']).toContain('Tests or validation steps are included.')
  })

  it('treats GitHub form placeholders as empty section content', async () => {
    const markdown = await readFixture('feature-no-response.md')
    const sections = parseSections(markdown)

    expect(sections['desired outcome']).toBe('')
  })

  it('retains acceptance criteria content after a nested #### sub-heading', async () => {
    const markdown = await readFixture('nested-sub-heading-in-ac.md')
    const sections = parseSections(markdown)

    expect(sections['acceptance criteria']).toContain('#### Notes for reviewers')
    expect(sections['acceptance criteria']).toContain('Criteria after a nested sub-heading are still present.')
  })
})
