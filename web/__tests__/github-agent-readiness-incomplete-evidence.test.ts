import { describe, expect, it } from 'vitest'

import { main as reconcileReadiness } from '@/scripts/github-agent-workflow/cli/reconcile-readiness'
import { FakeGitHubClient, type FailureInjection } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'
import { IssueReadinessResolver } from '@/scripts/github-agent-workflow/shared/issue-readiness-resolver'

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

function issue(
  number: number,
  dependsOn: string,
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue {
  return {
    number,
    title: `[BUG] ${number}`,
    body: body(dependsOn),
    labels: [],
    state: 'open',
    stateReason: null,
    htmlUrl: `https://example.test/issues/${number}`,
    authorLogin: 'test',
    isPullRequest: false,
    updatedAt: null,
    ...overrides,
  }
}

type IncompleteScenario = Readonly<{
  name: string
  expectedReason: string
  build: () => { issues: GitHubIssue[]; failures: FailureInjection }
}>

const INCOMPLETE_SCENARIOS: readonly IncompleteScenario[] = [
  {
    name: '404 plus 5xx',
    expectedReason: 'queue.issue_dependency_not_found',
    build: () => ({
      issues: [issue(1, '#2, #3')],
      failures: { getIssueFailures: { 3: 'server_error' } },
    }),
  },
  {
    name: 'not-planned plus permission failure',
    expectedReason: 'queue.issue_dependency_terminal_unsatisfied',
    build: () => ({
      issues: [
        issue(1, '#2, #3'),
        issue(2, 'none', { state: 'closed', stateReason: 'not_planned' }),
      ],
      failures: { getIssueFailures: { 3: 'forbidden' } },
    }),
  },
  {
    name: 'malformed reachable dependency plus network failure',
    expectedReason: 'queue.issue_dependency_syntax_invalid',
    build: () => ({
      issues: [
        issue(1, '#2, #3'),
        issue(2, ','),
      ],
      failures: { getIssueFailures: { 3: 'network_error' } },
    }),
  },
  {
    name: 'pull-request dependency plus rate limit',
    expectedReason: 'queue.issue_dependency_is_pull_request',
    build: () => ({
      issues: [
        issue(1, '#2, #3'),
        issue(2, 'none', { isPullRequest: true }),
      ],
      failures: { getIssueFailures: { 3: 'rate_limited' } },
    }),
  },
  {
    name: 'cycle plus 5xx',
    expectedReason: 'queue.issue_dependency_cycle',
    build: () => ({
      issues: [
        issue(1, '#2, #3'),
        issue(2, '#1'),
      ],
      failures: { getIssueFailures: { 3: 'server_error' } },
    }),
  },
]

describe('orthogonal incomplete dependency evidence', () => {
  it.each(INCOMPLETE_SCENARIOS)('$name stays non-dispatchable and partial', async ({ build, expectedReason }) => {
    const { issues, failures } = build()
    const client = new FakeGitHubClient({ issues })
    client.setFailures(failures)

    const result = await new IssueReadinessResolver(client).resolveFromIssue(issues[0])

    expect(result.dispatchable).toBe(false)
    expect(result.partial).toBe(true)
    expect(result.reasonCodes).toContain(expectedReason)
  })

  it.each(INCOMPLETE_SCENARIOS)('$name aborts full reconcile before any label write', async ({ build }) => {
    const { issues, failures } = build()
    issues[0] = { ...issues[0], labels: ['ready-for-agent'] }
    const client = new FakeGitHubClient({ issues })
    client.setFailures(failures)

    await expect(reconcileReadiness([], { ...process.env, DRY_RUN: 'false' }, client))
      .rejects.toThrow('Readiness reconciliation validation failed; no labels were changed.')

    expect(client.addLabelCalls).toEqual([])
    expect(client.removeLabelCalls).toEqual([])
  })

  it('keeps a definitive 404-only graph non-partial and author-correctable', async () => {
    const target = issue(1, '#2')
    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [target] })).resolveFromIssue(target)

    expect(result).toMatchObject({
      state: 'needs-clarification',
      dispatchable: false,
      partial: false,
    })
    expect(result.reasonCodes).toContain('queue.issue_dependency_not_found')
  })
})
