import { describe, expect, it } from 'vitest'

import { IssueReadinessResolver } from '@/scripts/github-agent-workflow/shared/issue-readiness-resolver'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'

function body(dependsOn: string, prefix = ''): string {
  return [
    '## Bug Summary', `${prefix} summary`,
    '## Current Behaviour', 'Current',
    '## Expected Behaviour', 'Expected',
    '## Reproduction Steps', '1. Reproduce',
    '## Impact', 'Low',
    '## Severity', 'Minor',
    '## Acceptance Criteria', '- [ ] Complete',
    '', 'Execution mode: implementation', `Depends on: ${dependsOn}`,
  ].join('\n')
}

function issue(number: number, dependsOn: string): GitHubIssue {
  return {
    number,
    title: `[BUG] ${number}`,
    body: body(dependsOn, String(number)),
    labels: [], state: 'open', stateReason: null,
    htmlUrl: `https://example.test/issues/${number}`,
    authorLogin: 'test', isPullRequest: false, updatedAt: null,
  }
}

describe('authority scanner and bounded resolver graph', () => {
  it('does not accept control lines in a lazy blockquote continuation', async () => {
    const lazyBody = [
      body('none').replace('Execution mode: implementation\nDepends on: none', ''),
      '> Example metadata follows as a quoted paragraph.',
      'Execution mode: implementation',
      'Depends on: none',
    ].join('\n')
    const target = { ...issue(1, 'none'), body: lazyBody }

    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result.dispatchable).toBe(false)
    expect(result.reasonCodes).toContain('queue.issue_control_missing')
  })

  it('reports a depth overflow instead of silently truncating expansion', async () => {
    const issues = Array.from({ length: 66 }, (_, index) => {
      const number = index + 1
      return issue(number, number === 66 ? 'none' : `#${number + 1}`)
    })

    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues })).resolveFromIssue(issues[0])

    expect(result.dispatchable).toBe(false)
    expect(result.partial).toBe(true)
    expect(result.reasonCodes).toContain('queue.issue_dependency_graph_limit_exceeded')
  })

  it('reports a node overflow instead of silently truncating expansion', async () => {
    const rootDependencies = Array.from({ length: 64 }, (_, index) => `#${index + 2}`).join(', ')
    const issues: GitHubIssue[] = [issue(1, rootDependencies)]
    for (let parent = 2; parent <= 65; parent++) {
      const firstChild = 66 + ((parent - 2) * 8)
      issues.push(issue(parent, Array.from({ length: 8 }, (_, index) => `#${firstChild + index}`).join(', ')))
    }
    for (let number = 66; number < 578; number++) issues.push(issue(number, 'none'))

    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues })).resolveFromIssue(issues[0])

    expect(result.dispatchable).toBe(false)
    expect(result.partial).toBe(true)
    expect(result.reasonCodes).toContain('queue.issue_dependency_graph_limit_exceeded')
  })
})
