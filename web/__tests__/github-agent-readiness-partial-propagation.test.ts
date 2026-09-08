import { describe, expect, it } from 'vitest'

import { IssueReadinessResolver } from '@/scripts/github-agent-workflow/shared/issue-readiness-resolver'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'

function body(dependsOn: string): string {
  return [
    '## Bug Summary', 'Test bug',
    '## Current Behaviour', 'Current',
    '## Expected Behaviour', 'Expected',
    '## Reproduction Steps', '1. Reproduce',
    '## Impact', 'Low',
    '## Severity', 'Minor',
    '## Acceptance Criteria', '- [ ] Complete',
    '',
    'Execution mode: implementation',
    `Depends on: ${dependsOn}`,
  ].join('\n')
}

function issue(number: number, dependsOn: string, state: 'open' | 'closed' = 'open'): GitHubIssue {
  return {
    number,
    title: `[BUG] ${number}`,
    body: body(dependsOn),
    labels: [],
    state,
    stateReason: state === 'closed' ? 'completed' : null,
    htmlUrl: `https://example.test/issues/${number}`,
    authorLogin: 'test',
    isPullRequest: false,
    updatedAt: null,
  }
}

describe('partial readiness propagation', () => {
  it('marks the target partial when a reachable dependency exceeds its declaration cap', async () => {
    const downstreamDependencies = Array.from({ length: 65 }, (_, index) => `#${index + 3}`).join(', ')
    const issues: GitHubIssue[] = [
      issue(1, '#2'),
      issue(2, downstreamDependencies),
      ...Array.from({ length: 64 }, (_, index) => issue(index + 3, 'none', 'closed')),
    ]

    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues })).resolveFromIssue(issues[0])

    expect(result).toMatchObject({
      dispatchable: false,
      state: 'needs-clarification',
      partial: true,
    })
    expect(result.reasonCodes).toContain('queue.issue_dependency_graph_limit_exceeded')
  })
})
