import { describe, expect, it } from 'vitest'

import { scanVisibleMarkdownLines } from '@/scripts/github-agent-workflow/core/visible-markdown-scanner'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'
import { IssueReadinessResolver } from '@/scripts/github-agent-workflow/shared/issue-readiness-resolver'

function validBugBody(): string {
  return [
    '## Bug Summary',
    'Test bug',
    '## Current Behaviour',
    'Current',
    '## Expected Behaviour',
    'Expected',
    '## Reproduction Steps',
    '1. Reproduce',
    '## Impact',
    'Low',
    '## Severity',
    'Minor',
    '## Acceptance Criteria',
    '- [ ] Complete',
    '',
    'Execution mode: implementation',
    'Depends on: none',
  ].join('\n')
}

function issue(body: string): GitHubIssue {
  return {
    number: 1,
    title: '[BUG] Inline boundaries',
    body,
    labels: [],
    state: 'open',
    stateReason: null,
    htmlUrl: 'https://example.test/issues/1',
    authorLogin: 'test',
    isPullRequest: false,
    updatedAt: null,
  }
}

describe('inline-code block boundaries', () => {
  it('does not pair unmatched backticks across a blank-line paragraph boundary', () => {
    const visible = scanVisibleMarkdownLines([
      '`literal in one paragraph',
      '',
      'Execution mode: implementation',
      'Depends on: none',
      '',
      '`literal in another paragraph',
    ].join('\n')).lines.map((line) => line.text)

    expect(visible).toContain('Execution mode: implementation')
    expect(visible).toContain('Depends on: none')
  })

  it('does not pair unmatched backticks across an ATX heading block boundary', () => {
    const visible = scanVisibleMarkdownLines([
      '`literal before heading',
      '## Boundary',
      'Execution mode: implementation',
      'Depends on: none',
      '`literal after controls',
    ].join('\n')).lines.map((line) => line.text)

    expect(visible).toContain('## Boundary')
    expect(visible).toContain('Execution mode: implementation')
    expect(visible).toContain('Depends on: none')
  })

  it('keeps a structurally valid issue ready when unrelated literal backticks occur in separate blocks', async () => {
    const body = validBugBody()
      .replace('Test bug', '`literal\n\nTest bug')
      .concat('\n\n`another literal')
    const target = issue(body)

    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result).toMatchObject({
      state: 'ready',
      dispatchable: true,
      reasonCodes: [],
    })
  })
})
