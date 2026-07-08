import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WORK_ORDER_SECTION_MAX_LENGTH } from '@/scripts/github-agent-workflow/contracts/work-order'
import { buildAgentBranchName } from '@/scripts/github-agent-workflow/core/branch-names'
import { DISPATCH_MARKER_PREFIX, runDispatch } from '@/scripts/github-agent-workflow/dispatch'
import {
  findLatestRunForIssue,
  recordRequested,
  updateRunStatus,
} from '@/scripts/github-agent-workflow/io/agent-run-log'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'

const tempRoots: string[] = []

const READY_ISSUE: GitHubIssue = {
  number: 144,
  title: '[FEATURE] Safe agent dispatch / bounded work-order generation',
  body: [
    '## Acceptance Criteria',
    '',
    '- [ ] Ready issue dispatches successfully.',
    '- [ ] Bounded work order is generated.',
  ].join('\n'),
  labels: ['ready-for-agent', 'agent-requested'],
  state: 'open',
  htmlUrl: 'https://github.com/Joncallim/Forge/issues/144',
  authorLogin: 'Joncallim',
  isPullRequest: false,
}

async function tempRepositoryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-dispatch-'))
  tempRoots.push(root)
  return root
}

async function seedRequestedRun(root: string, issue: GitHubIssue = READY_ISSUE): Promise<void> {
  await recordRequested({
    runId: `issue-${issue.number}-1234567890-1`,
    issueNumber: issue.number,
    issueTitle: issue.title,
    runtime: 'codex',
    action: 'implement',
    requestedBy: 'Joncallim',
    source: { type: 'issue_comment', commentId: 14401 },
  }, {
    repositoryRoot: root,
    now: new Date('2026-07-06T01:00:00.000Z'),
  })
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('agent dispatch', () => {
  it('dispatches a ready issue with a requested run without starting a runtime', async () => {
    const root = await tempRepositoryRoot()
    await seedRequestedRun(root)
    const client = new FakeGitHubClient({ issues: [{ ...READY_ISSUE, labels: [...READY_ISSUE.labels, 'agent-blocked'] }] })

    const result = await runDispatch({
      client,
      issueNumber: READY_ISSUE.number,
      runLogRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
      now: new Date('2026-07-06T01:05:00.000Z'),
    })

    const expectedBranch = buildAgentBranchName({ issueNumber: READY_ISSUE.number, issueTitle: READY_ISSUE.title })
    expect(result.status).toBe('dispatched')
    expect(result.branchName).toBe(expectedBranch)
    expect(result.request).toMatchObject({
      runId: 'issue-144-1234567890-1',
      branchName: expectedBranch,
      dryRun: false,
    })
    expect(result.commentBody).toContain('no Claude Code or Codex execution has started')
    expect(result.workOrder?.branchName).toBe(expectedBranch)
    expect(result.workOrder?.sections.find((section) => section.title === 'Required Constraints')?.body).toContain('Closes #144')

    const issue = await client.getIssue(144)
    expect(issue.labels).not.toContain('agent-blocked')
    expect(issue.labels).not.toContain('agent-running')
    expect((await client.listComments(144))[0]?.body.startsWith(DISPATCH_MARKER_PREFIX)).toBe(true)

    const run = await findLatestRunForIssue(144, { repositoryRoot: root })
    expect(run).toMatchObject({
      status: 'handed-off',
      branchName: expectedBranch,
      blockedReason: null,
    })
    expect(run?.events.map((event) => event.message)).toContain('Dispatch accepted the requested run and assigned a deterministic branch.')
    expect(run?.events.at(-1)?.message).toContain('did not start a runtime')
  })

  it('blocks when no run record exists', async () => {
    const root = await tempRepositoryRoot()
    const client = new FakeGitHubClient({ issues: [READY_ISSUE] })

    const result = await runDispatch({
      client,
      issueNumber: READY_ISSUE.number,
      runLogRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    expect(result.status).toBe('blocked')
    expect(result.blockedReason).toContain('No run record')
    expect((await client.getIssue(144)).labels).toContain('agent-blocked')
    expect((await client.listComments(144))[0]?.body).toContain('No run record exists')
  })

  it('blocks closed issues and records the blocked run state', async () => {
    const root = await tempRepositoryRoot()
    const issue = { ...READY_ISSUE, state: 'closed' }
    await seedRequestedRun(root, issue)
    const client = new FakeGitHubClient({ issues: [issue] })

    const result = await runDispatch({
      client,
      issueNumber: issue.number,
      runLogRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    const run = await findLatestRunForIssue(issue.number, { repositoryRoot: root })
    expect(result.status).toBe('blocked')
    expect(result.blockedReason).toContain('not open')
    expect(run?.status).toBe('blocked')
  })

  it('blocks issues with needs-clarification', async () => {
    const root = await tempRepositoryRoot()
    const issue = { ...READY_ISSUE, labels: ['ready-for-agent', 'agent-requested', 'needs-clarification'] }
    await seedRequestedRun(root, issue)
    const client = new FakeGitHubClient({ issues: [issue] })

    const result = await runDispatch({
      client,
      issueNumber: issue.number,
      runLogRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    expect(result.status).toBe('blocked')
    expect(result.blockedReason).toContain('needs-clarification')
  })

  it('blocks non-requested runs', async () => {
    const root = await tempRepositoryRoot()
    await seedRequestedRun(root)
    await updateRunStatus({
      issueNumber: 144,
      runId: 'issue-144-1234567890-1',
      status: 'running',
    }, { repositoryRoot: root })
    const client = new FakeGitHubClient({ issues: [READY_ISSUE] })

    const result = await runDispatch({
      client,
      issueNumber: READY_ISSUE.number,
      runLogRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    expect(result.status).toBe('blocked')
    expect(result.blockedReason).toContain('not `requested`')
    expect((await findLatestRunForIssue(144, { repositoryRoot: root }))?.status).toBe('blocked')
  })

  it('treats already-handed-off runs as idempotent instead of blocked', async () => {
    const root = await tempRepositoryRoot()
    await seedRequestedRun(root)
    await updateRunStatus({
      issueNumber: 144,
      runId: 'issue-144-1234567890-1',
      status: 'handed-off',
      branchName: 'agent/issue-144-safe-agent-dispatch-bounded-work',
    }, { repositoryRoot: root })
    const client = new FakeGitHubClient({ issues: [{ ...READY_ISSUE, labels: [...READY_ISSUE.labels, 'agent-blocked'] }] })

    const result = await runDispatch({
      client,
      issueNumber: READY_ISSUE.number,
      runLogRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    expect(result.status).toBe('ignored')
    expect(result.blockedReason).toBeNull()
    expect(result.commentBody).toContain('already prepared')
    expect((await client.getIssue(144)).labels).not.toContain('agent-blocked')
    expect((await findLatestRunForIssue(144, { repositoryRoot: root }))?.status).toBe('handed-off')
  })

  it('keeps generated work-order sections bounded', async () => {
    const root = await tempRepositoryRoot()
    const issue = {
      ...READY_ISSUE,
      body: [
        '## Acceptance Criteria',
        '',
        `- [ ] ${'A very long criterion '.repeat(400)}`,
      ].join('\n'),
    }
    await seedRequestedRun(root, issue)
    const client = new FakeGitHubClient({ issues: [issue] })

    const result = await runDispatch({
      client,
      issueNumber: issue.number,
      runLogRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    expect(result.workOrder?.sections).toHaveLength(7)
    for (const section of result.workOrder?.sections ?? []) {
      expect(section.body.length).toBeLessThanOrEqual(WORK_ORDER_SECTION_MAX_LENGTH)
    }
    expect(result.workOrder?.sections.find((section) => section.title === 'Required Constraints')?.body).not.toContain('A very long criterion')
  })

  it('redacts secret-shaped criteria before rendering the embedded PR contract', async () => {
    const root = await tempRepositoryRoot()
    const secret = `ghp_${'a'.repeat(40)}`
    const issue = {
      ...READY_ISSUE,
      body: [
        '## Acceptance Criteria',
        '',
        `- [ ] Do not leak token=${secret}.`,
      ].join('\n'),
    }
    await seedRequestedRun(root, issue)
    const client = new FakeGitHubClient({ issues: [issue] })

    const result = await runDispatch({
      client,
      issueNumber: issue.number,
      runLogRepositoryRoot: root,
      botLogin: 'github-actions[bot]',
    })

    const rendered = result.workOrder?.sections.map((section) => section.body).join('\n') ?? ''
    expect(rendered).not.toContain(secret)
    expect(rendered).toContain('[redacted]')
  })
})
