import { describe, expect, it } from 'vitest'

import { extractAcceptanceCriteria } from '@/scripts/github-agent-workflow/core/acceptance-criteria'
import { extractSourceIssueReference } from '@/scripts/github-agent-workflow/core/pr-contract'
import {
  PR_CONTRACT_MARKER_PREFIX,
  buildPrContractReport,
  renderPrContractReport,
  runPrContractCheck,
} from '@/scripts/github-agent-workflow/pr-contract'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import { GitHubApiError, type GitHubIssue, type GitHubPullRequest } from '@/scripts/github-agent-workflow/io/github-client'

const SOURCE_ISSUE: GitHubIssue = {
  number: 145,
  title: '[FEATURE] PR acceptance-criteria contract checker',
  body: [
    '## Acceptance Criteria',
    '',
    '- [ ] Linked issue extraction works.',
    '- [ ] Missing criteria are reported.',
    '- [ ] Weak evidence needs review.',
  ].join('\n'),
  labels: ['ready-for-agent'],
  state: 'open',
  htmlUrl: 'https://github.com/Joncallim/Forge/issues/145',
  authorLogin: 'Joncallim',
  isPullRequest: false,
}

const PR_AS_ISSUE: GitHubIssue = {
  number: 166,
  title: 'Complete GitHub-native agent workflow',
  body: null,
  labels: [],
  state: 'open',
  htmlUrl: 'https://github.com/Joncallim/Forge/pull/166',
  authorLogin: 'Joncallim',
  isPullRequest: true,
}

function pullRequest(body: string | null, draft = false): GitHubPullRequest {
  return {
    number: 166,
    title: 'Complete GitHub-native agent workflow',
    body,
    state: 'open',
    draft,
    htmlUrl: 'https://github.com/Joncallim/Forge/pull/166',
    headRefName: 'claude/forge-agent-workflow-arch-t3tgy1',
    baseRefName: 'main',
  }
}

describe('PR contract checker', () => {
  it.each([
    ['Closes #123', 123, 'closes'],
    ['Fixes #123', 123, 'fixes'],
    ['Resolves #123', 123, 'resolves'],
    ['Issue: #123', 123, 'issue'],
  ])('extracts linked issue phrases from %s', (body, issueNumber, keyword) => {
    expect(extractSourceIssueReference(body)).toMatchObject({ issueNumber, keyword })
  })

  it('detects missing linked issues without failing the report', async () => {
    const client = new FakeGitHubClient({
      issues: [PR_AS_ISSUE],
      pullRequests: [pullRequest('## Summary\n\nNo issue link.')],
    })

    const report = await runPrContractCheck({
      client,
      pullRequestNumber: 166,
      botLogin: 'github-actions[bot]',
      now: new Date('2026-07-06T01:00:00.000Z'),
    })

    expect(report.linkedIssueNumber).toBeNull()
    expect(report.linkedIssueStatus).toBe('missing')
    expect(report.criteria).toEqual([])
    expect(report.commentBody).toContain('Add a `Source Issue` section')
    expect((await client.listComments(166))[0]?.body.startsWith(PR_CONTRACT_MARKER_PREFIX)).toBe(true)
  })

  it('reports a linked source issue that cannot be loaded without throwing', async () => {
    const client = new FakeGitHubClient({
      issues: [PR_AS_ISSUE],
      pullRequests: [pullRequest([
        '## Source Issue',
        '',
        'Closes #999',
      ].join('\n'))],
    })

    const report = await runPrContractCheck({
      client,
      pullRequestNumber: 166,
      botLogin: 'github-actions[bot]',
      now: new Date('2026-07-06T01:00:00.000Z'),
    })

    expect(report.linkedIssueStatus).toBe('not-found')
    expect(report.linkedIssueNumber).toBe(999)
    expect(report.criteria).toEqual([])
    expect(report.commentBody).toContain('could not be loaded')
  })

  it('does not swallow non-404 linked issue lookup failures', async () => {
    const client = new FakeGitHubClient({
      issues: [PR_AS_ISSUE],
      pullRequests: [pullRequest('## Source Issue\n\nCloses #145')],
    })
    client.getIssue = async (issueNumber: number) => {
      if (issueNumber === 145) throw new GitHubApiError('rate limited', 403, '/repos/Joncallim/Forge/issues/145')
      return PR_AS_ISSUE
    }

    await expect(runPrContractCheck({
      client,
      pullRequestNumber: 166,
      botLogin: 'github-actions[bot]',
    })).rejects.toThrow('rate limited')
  })

  it('can build the report without writing a marker comment', async () => {
    const client = new FakeGitHubClient({
      issues: [PR_AS_ISSUE, SOURCE_ISSUE],
      pullRequests: [pullRequest('## Source Issue\n\nCloses #145')],
    })

    const report = await runPrContractCheck({
      client,
      pullRequestNumber: 166,
      botLogin: 'github-actions[bot]',
      writeComment: false,
    })

    expect(report.linkedIssueStatus).toBe('found')
    expect(await client.listComments(166)).toEqual([])
  })

  it('only extracts the source issue from the Source Issue section', async () => {
    const client = new FakeGitHubClient({
      issues: [PR_AS_ISSUE, SOURCE_ISSUE],
      pullRequests: [pullRequest([
        '## Summary',
        '',
        'Related to the issue #999 thread, but this is not the source issue.',
        '',
        '## Source Issue',
        '',
        'Closes #145',
      ].join('\n'))],
    })

    const report = await runPrContractCheck({
      client,
      pullRequestNumber: 166,
      botLogin: 'github-actions[bot]',
    })

    expect(report.linkedIssueStatus).toBe('found')
    expect(report.linkedIssueNumber).toBe(145)
    expect(report.linkedIssueTitle).toBe(SOURCE_ISSUE.title)
  })

  it('extracts acceptance criteria from linked issues', () => {
    expect(extractAcceptanceCriteria(SOURCE_ISSUE.body)).toEqual([
      'Linked issue extraction works.',
      'Missing criteria are reported.',
      'Weak evidence needs review.',
    ])
  })

  it('classifies claimed, missing, and needs-review criteria', () => {
    const report = buildPrContractReport({
      pullRequest: pullRequest([
        '## Source Issue',
        '',
        'Closes #145',
        '',
        '## Acceptance Criteria Validation',
        '',
        '- [x] Linked issue extraction works. — covered by github-agent-pr-contract.test.ts.',
        '- [x] Weak evidence needs review. — done.',
      ].join('\n')),
      linkedIssue: SOURCE_ISSUE,
      linkedIssueStatus: 'found',
      now: new Date('2026-07-06T01:00:00.000Z'),
    })

    expect(report.summary).toEqual({ claimed: 1, missing: 1, needsReview: 1 })
    expect(report.criteria).toEqual([
      expect.objectContaining({ text: 'Linked issue extraction works.', status: 'claimed' }),
      expect.objectContaining({ text: 'Missing criteria are reported.', status: 'missing' }),
      expect.objectContaining({ text: 'Weak evidence needs review.', status: 'needs-review' }),
    ])
  })

  it('renders a deterministic marker comment report', () => {
    const report = buildPrContractReport({
      pullRequest: pullRequest('## Source Issue\n\nIssue: #145'),
      linkedIssue: SOURCE_ISSUE,
      linkedIssueStatus: 'found',
      now: new Date('2026-07-06T01:00:00.000Z'),
    })

    const rendered = renderPrContractReport(report)
    expect(rendered.startsWith(PR_CONTRACT_MARKER_PREFIX)).toBe(true)
    expect(rendered).toContain('| Criterion | Status | Evidence / notes |')
    expect(rendered).toContain('This is review support, not proof of correctness.')
  })

  it('uses positional matching for same-length validation lists and avoids short substring overmatching', () => {
    const issue = {
      ...SOURCE_ISSUE,
      body: [
        '## Acceptance Criteria',
        '',
        '- [ ] Alpha export creates the expected file.',
        '- [ ] Alpha import reads the expected file.',
      ].join('\n'),
    }
    const report = buildPrContractReport({
      pullRequest: pullRequest([
        '## Source Issue',
        '',
        'Closes #145',
        '',
        '## Acceptance Criteria Validation',
        '',
        '- [x] Export creates expected file — covered by export.test.ts.',
        '- [x] Import reads expected file — covered by import.test.ts.',
      ].join('\n')),
      linkedIssue: issue,
      linkedIssueStatus: 'found',
      now: new Date('2026-07-06T01:00:00.000Z'),
    })

    expect(report.summary).toEqual({ claimed: 2, missing: 0, needsReview: 0 })
    expect(report.criteria).toEqual([
      expect.objectContaining({ text: 'Alpha export creates the expected file.', status: 'claimed' }),
      expect.objectContaining({ text: 'Alpha import reads the expected file.', status: 'claimed' }),
    ])
  })

  it('does not reuse one validation row for multiple acceptance criteria', () => {
    const issue = {
      ...SOURCE_ISSUE,
      body: [
        '## Acceptance Criteria',
        '',
        '- [ ] Alpha export creates the expected file.',
        '- [ ] Alpha import reads the expected file.',
      ].join('\n'),
    }
    const report = buildPrContractReport({
      pullRequest: pullRequest([
        '## Source Issue',
        '',
        'Closes #145',
        '',
        '## Acceptance Criteria Validation',
        '',
        '- [x] Alpha export creates expected file and Alpha import reads expected file — see workflow tests.',
      ].join('\n')),
      linkedIssue: issue,
      linkedIssueStatus: 'found',
      now: new Date('2026-07-06T01:00:00.000Z'),
    })

    expect(report.summary.claimed).toBe(1)
    expect(report.summary.missing).toBe(1)
  })

  it('updates one marker comment instead of creating duplicates', async () => {
    const body = [
      '## Source Issue',
      '',
      'Closes #145',
      '',
      '## Acceptance Criteria Validation',
      '',
      '- [x] Linked issue extraction works. — covered by github-agent-pr-contract.test.ts.',
    ].join('\n')
    const client = new FakeGitHubClient({
      issues: [PR_AS_ISSUE, SOURCE_ISSUE],
      pullRequests: [pullRequest(body)],
      commentsByIssue: {
        166: [{
          id: 99,
          body: `${PR_CONTRACT_MARKER_PREFIX}\n\nOld report`,
          authorLogin: 'github-actions[bot]',
          authorType: 'Bot',
          htmlUrl: '',
        }],
      },
    })

    await runPrContractCheck({
      client,
      pullRequestNumber: 166,
      botLogin: 'github-actions[bot]',
      now: new Date('2026-07-06T01:00:00.000Z'),
    })
    await runPrContractCheck({
      client,
      pullRequestNumber: 166,
      botLogin: 'github-actions[bot]',
      now: new Date('2026-07-06T01:01:00.000Z'),
    })

    const comments = await client.listComments(166)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.id).toBe(99)
    expect(comments[0]?.body).toContain('Linked issue: #145')
  })

  it('handles draft pull requests and still posts review support', async () => {
    const client = new FakeGitHubClient({
      issues: [PR_AS_ISSUE, SOURCE_ISSUE],
      pullRequests: [pullRequest('## Source Issue\n\nCloses #145', true)],
    })

    const report = await runPrContractCheck({
      client,
      pullRequestNumber: 166,
      botLogin: 'github-actions[bot]',
    })

    expect(report.draft).toBe(true)
    expect(report.commentBody).toContain('Draft: yes')
  })
})
