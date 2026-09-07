import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import {
  ISSUE_VALIDATION_MARKER_PREFIX,
  validateIssue,
} from '@/scripts/github-agent-workflow/core/issue-validation'
import { runIssueValidation } from '@/scripts/github-agent-workflow/shared/issue-validation-runner'
import { markerCommentPolicyForAction } from '@/scripts/github-agent-workflow/validate-issue'

class CommentCountingClient extends FakeGitHubClient {
  listCommentCalls = 0

  override async listComments(issueNumber: number) {
    this.listCommentCalls += 1
    return await super.listComments(issueNumber)
  }
}

const FIXTURE_DIR = path.join(process.cwd(), '__tests__', '__fixtures__', 'github-agent-workflow')

const READY_BODY = [
  '## Bug Summary',
  'Fresh issue state',
  '## Current Behaviour',
  'Broken',
  '## Expected Behaviour',
  'Fixed',
  '## Reproduction Steps',
  '1. Reproduce',
  '## Impact',
  'Low',
  '## Severity',
  'Low',
  '## Acceptance Criteria',
  '- [ ] Fixed',
  '',
  'Execution mode: implementation',
  'Depends on: none',
].join('\n')

async function readFixture(name: string): Promise<string> {
  return await readFile(path.join(FIXTURE_DIR, name), 'utf8')
}

describe('GitHub issue validation', () => {
  it.each([
    ['opened', 'always'],
    ['edited', 'always'],
    ['closed', 'always'],
    ['reopened', 'always'],
    ['labeled', 'on-projection-change'],
    ['unlabeled', 'on-projection-change'],
    [undefined, 'on-projection-change'],
  ] as const)('uses the expected marker policy for the %s intake action', (action, expected) => {
    expect(markerCommentPolicyForAction(action)).toBe(expected)
  })

  it('validates complete Feature, Bug, Other, and Epic issues', async () => {
    const cases = [
      { file: 'feature-h3-form.md', issueType: 'feature' as const },
      { file: 'bug-valid.md', issueType: 'bug' as const },
      { file: 'other-valid.md', issueType: 'other' as const },
      { file: 'epic-h2.md', issueType: 'epic' as const },
    ]

    for (const testCase of cases) {
      const body = await readFixture(testCase.file)
      const result = validateIssue({
        number: 1,
        title: body.split('\n')[0].replace(/^#\s+/, ''),
        body,
      })

      expect(result.issueType).toBe(testCase.issueType)
      expect(result.valid).toBe(true)
      expect(result.missingSections).toEqual([])
      // Structural validation no longer recommends ready-for-agent
      expect(result.recommendedLabels).toEqual([])
      expect(result.commentBody).toBeNull()
    }
  })

  it('flags incomplete Feature, Bug, Other, and Epic issues deterministically', async () => {
    const cases = [
      { file: 'feature-no-response.md', missing: ['desired outcome', 'requirements', 'acceptance criteria', 'implementation scope'], issueType: 'feature' as const },
      { file: 'bug-invalid.md', missing: ['expected behaviour', 'acceptance criteria'], issueType: 'bug' as const },
      { file: 'other-invalid.md', missing: ['desired outcome', 'acceptance criteria'], issueType: 'other' as const },
      { file: 'epic-invalid.md', missing: ['tasks', 'acceptance criteria'], issueType: 'epic' as const },
    ]

    for (const testCase of cases) {
      const body = await readFixture(testCase.file)
      const result = validateIssue({
        number: 1,
        title: body.split('\n')[0].replace(/^#\s+/, ''),
        body,
      })

      expect(result.issueType).toBe(testCase.issueType)
      expect(result.valid).toBe(false)
      expect(result.missingSections).toEqual(testCase.missing)
      expect(result.recommendedLabels).toEqual(['needs-clarification'])
      expect(result.commentBody).toContain(ISSUE_VALIDATION_MARKER_PREFIX)
    }
  })

  it('updates labels and reuses a single marker comment without spam on repeated invalid runs', async () => {
    const body = await readFixture('bug-invalid.md')
    const client = new FakeGitHubClient({
      issues: [{
        number: 142,
        title: '[BUG] Dashboard refresh issue',
        body,
        labels: ['enhancement', 'ready-for-agent'],
        state: 'open',
        htmlUrl: 'https://github.com/Joncallim/Forge/issues/142',
        authorLogin: 'Joncallim',
        isPullRequest: false,
        stateReason: null,
        updatedAt: null,
      }],
    })

    const issue = await client.getIssue(142)
    const firstRun = await runIssueValidation(client, issue, { botLogin: 'github-actions[bot]' })
    expect(firstRun.result.valid).toBe(false)
    // Structural validation removes ready-for-agent and adds needs-clarification
    const labelsAfter = (await client.getIssue(142)).labels
    expect(labelsAfter).toContain('enhancement')
    expect(labelsAfter).toContain('needs-clarification')
    // ready-for-agent may have been removed by the readiness projection
    expect(await client.listComments(142)).toHaveLength(1)

    const secondRun = await runIssueValidation(client, await client.getIssue(142), { botLogin: 'github-actions[bot]' })
    expect(secondRun.result.valid).toBe(false)
    expect(await client.listComments(142)).toHaveLength(1)
  })

  it('skips comment history for unchanged label self-heal projections', async () => {
    const body = await readFixture('bug-invalid.md')
    const client = new CommentCountingClient({
      issues: [{
        number: 143,
        title: '[BUG] Already projected validation issue',
        body,
        labels: ['needs-clarification'],
        state: 'open',
        htmlUrl: 'https://github.com/Joncallim/Forge/issues/143',
        authorLogin: 'Joncallim',
        isPullRequest: false,
        stateReason: null,
        updatedAt: null,
      }],
    })

    const result = await runIssueValidation(client, await client.getIssue(143), {
      botLogin: 'github-actions[bot]',
      markerCommentPolicy: 'on-projection-change',
    })

    expect(result.existingMarkerComment).toBeNull()
    expect(client.listCommentCalls).toBe(0)
  })

  it('refreshes the marker for normal validation events even when labels are unchanged', async () => {
    const body = await readFixture('bug-invalid.md')
    const client = new CommentCountingClient({
      issues: [{
        number: 144,
        title: '[BUG] Normal validation issue',
        body,
        labels: ['needs-clarification'],
        state: 'open',
        htmlUrl: 'https://github.com/Joncallim/Forge/issues/144',
        authorLogin: 'Joncallim',
        isPullRequest: false,
        stateReason: null,
        updatedAt: null,
      }],
    })

    await runIssueValidation(client, await client.getIssue(144), { botLogin: 'github-actions[bot]' })

    expect(client.listCommentCalls).toBe(1)
    expect(await client.listComments(144)).toHaveLength(1)
  })

  it('projects a current ready state when the supplied issue was stale and blocked', async () => {
    const client = new FakeGitHubClient({
      issues: [{
        number: 145,
        title: '[BUG] Current ready issue',
        body: READY_BODY,
        labels: ['needs-clarification'],
        state: 'open',
        htmlUrl: 'https://github.com/Joncallim/Forge/issues/145',
        authorLogin: 'Joncallim',
        isPullRequest: false,
        stateReason: null,
        updatedAt: null,
      }],
    })
    const staleIssue = {
      ...(await client.getIssue(145)),
      body: 'incomplete stale event payload',
      labels: ['needs-clarification'],
    }

    const result = await runIssueValidation(client, staleIssue, { botLogin: 'github-actions[bot]' })

    expect(result.readinessResult?.dispatchable).toBe(true)
    expect((await client.getIssue(145)).labels).toContain('ready-for-agent')
    expect((await client.getIssue(145)).labels).not.toContain('needs-clarification')
  })
})
