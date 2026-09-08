import { describe, expect, it } from 'vitest'

import { MAX_ISSUE_BODY_BYTES } from '@/scripts/github-agent-workflow/contracts/issue-control-metadata'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'
import { IssueReadinessResolver } from '@/scripts/github-agent-workflow/shared/issue-readiness-resolver'

describe('terminal target readiness', () => {
  it('keeps a closed target terminal even when its historical body exceeds parser limits', async () => {
    const issue: GitHubIssue = {
      number: 1,
      title: '[BUG] Closed historical issue',
      body: 'x'.repeat(MAX_ISSUE_BODY_BYTES + 1),
      labels: ['ready-for-agent'],
      state: 'closed',
      stateReason: 'completed',
      htmlUrl: 'https://example.test/issues/1',
      authorLogin: 'test',
      isPullRequest: false,
      updatedAt: null,
    }

    const result = await new IssueReadinessResolver(new FakeGitHubClient({ issues: [issue] })).resolveFromIssue(issue)

    expect(result).toMatchObject({
      state: 'closed',
      dispatchable: false,
      partial: false,
      desiredReadinessLabels: [],
      reasonCodes: ['queue.issue_closed'],
    })
  })
})
