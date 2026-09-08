import { describe, expect, it } from 'vitest'

import type { IssueReadinessResult } from '@/scripts/github-agent-workflow/contracts/issue-readiness-result'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'
import { syncReadinessLabels } from '@/scripts/github-agent-workflow/shared/readiness-projection'

const READY_BODY = [
  '## Bug Summary', 'Test bug',
  '## Current Behaviour', 'Current',
  '## Expected Behaviour', 'Expected',
  '## Reproduction Steps', '1. Reproduce',
  '## Impact', 'Low',
  '## Severity', 'Minor',
  '## Acceptance Criteria', '- [ ] Complete',
  '',
  'Execution mode: implementation',
  'Depends on: none',
].join('\n')

const ISSUE: GitHubIssue = {
  number: 1,
  title: '[BUG] Projection compensation',
  body: READY_BODY,
  labels: [],
  state: 'open',
  stateReason: null,
  htmlUrl: 'https://example.test/issues/1',
  authorLogin: 'test',
  isPullRequest: false,
  updatedAt: null,
}

const READY: IssueReadinessResult = {
  issueNumber: 1,
  state: 'ready',
  dispatchable: true,
  executionMode: 'implementation',
  dependencies: [],
  reasonCodes: [],
  blockers: [],
  desiredReadinessLabels: ['ready-for-agent'],
  partial: false,
}

class ConcurrentBlockerClient extends FakeGitHubClient {
  override async addLabel(issueNumber: number, label: string): Promise<void> {
    await super.addLabel(issueNumber, label)
    if (label === 'ready-for-agent') {
      // Model a concurrent projection writer racing immediately after the ready
      // add and before this invocation's final exact-set verification.
      await super.addLabel(issueNumber, 'dependency-blocked')
    }
  }
}

class FinalVerificationFailureClient extends FakeGitHubClient {
  private failNextGet = false

  override async addLabel(issueNumber: number, label: string): Promise<void> {
    await super.addLabel(issueNumber, label)
    if (label === 'ready-for-agent') this.failNextGet = true
  }

  override async getIssue(issueNumber: number): Promise<GitHubIssue> {
    if (this.failNextGet) {
      this.failNextGet = false
      throw new TypeError('simulated post-promotion verification failure')
    }
    return await super.getIssue(issueNumber)
  }
}

describe('ready projection compensation', () => {
  it('retracts a ready promotion when a concurrent blocker makes the final projection inconsistent', async () => {
    const client = new ConcurrentBlockerClient({ issues: [ISSUE] })
    const order: string[] = []

    const result = await syncReadinessLabels(client, ISSUE, READY, {
      confirmReady: async () => {
        order.push('confirm-ready')
        return READY
      },
    })

    const finalIssue = await client.getIssue(1)
    expect(result.success).toBe(false)
    expect(result.error).toContain('did not converge')
    expect(finalIssue.labels).not.toContain('ready-for-agent')
    expect(finalIssue.labels).toContain('dependency-blocked')
    expect(client.removeLabelCalls).toContainEqual({ issueNumber: 1, label: 'ready-for-agent' })
    expect(order).toEqual(['confirm-ready'])
  })

  it('retracts a ready promotion when final verification cannot read GitHub state', async () => {
    const client = new FinalVerificationFailureClient({ issues: [ISSUE] })

    const result = await syncReadinessLabels(client, ISSUE, READY, {
      confirmReady: async () => READY,
    })

    const finalIssue = await client.getIssue(1)
    expect(result.success).toBe(false)
    expect(result.error).toContain('final readiness projection verification')
    expect(finalIssue.labels).not.toContain('ready-for-agent')
    expect(client.removeLabelCalls).toContainEqual({ issueNumber: 1, label: 'ready-for-agent' })
  })
})
