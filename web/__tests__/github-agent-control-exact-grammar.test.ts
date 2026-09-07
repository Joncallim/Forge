import { describe, expect, it } from 'vitest'

import { IssueReadinessResolver } from '@/scripts/github-agent-workflow/shared/issue-readiness-resolver'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'

function validBugBody(dependsOn: string): string {
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
    `Depends on: ${dependsOn}`,
  ].join('\n')
}

function issue(dependsOn: string): GitHubIssue {
  return {
    number: 1,
    title: '[BUG] Exact control grammar',
    body: validBugBody(dependsOn),
    labels: [],
    state: 'open',
    stateReason: null,
    htmlUrl: 'https://example.test/issues/1',
    authorLogin: 'test',
    isPullRequest: false,
    updatedAt: null,
  }
}

function withoutControlBlock(body: string): string {
  return body.replace('\nExecution mode: implementation\nDepends on: none', '')
}

describe('exact control metadata grammar', () => {
  it.each(['NONE', 'None', 'nOnE'])('rejects non-canonical empty dependency sentinel %s at the resolver boundary', async (sentinel) => {
    const target = issue(sentinel)
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result).toMatchObject({
      dispatchable: false,
      state: 'needs-clarification',
      dependencies: [],
    })
    expect(result.reasonCodes).toContain('queue.issue_dependency_syntax_invalid')
  })

  it.each([
    ['same-line comment before fence', ['<!-- harmless -->```', 'Execution mode: implementation', 'Depends on: none', '```']],
    ['multiline comment close before fence', ['<!-- comment begins', '-->```', 'Execution mode: implementation', 'Depends on: none', '```']],
    ['multiline comment close before details', ['<!-- comment begins', '--><details>', 'Execution mode: implementation', 'Depends on: none', '</details>']],
  ])('does not authorize controls hidden by %s', async (_name, hiddenControls) => {
    const target = {
      ...issue('none'),
      body: [withoutControlBlock(validBugBody('none')), ...hiddenControls].join('\n'),
    }
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_control_missing')
  })

  it('keeps a comment-bearing physical control line non-authoritative', async () => {
    const target = {
      ...issue('none'),
      body: [
        withoutControlBlock(validBugBody('none')),
        '<!-- explanatory text -->Execution mode: implementation',
        'Depends on: none',
      ].join('\n'),
    }
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_control_missing')
  })
})
