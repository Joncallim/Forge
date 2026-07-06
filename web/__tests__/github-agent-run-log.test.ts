import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentRunRecordSchema } from '@/scripts/github-agent-workflow/contracts/agent-run-record'
import { runIdSchema } from '@/scripts/github-agent-workflow/contracts/common'
import { runAgentCommand } from '@/scripts/github-agent-workflow/core/agent-command'
import {
  appendRunEvent,
  FileAgentRunRecorder,
  findLatestRunForIssue,
  linkPullRequest,
  recordBlockedReason,
  recordRequested,
  updateRunStatus,
} from '@/scripts/github-agent-workflow/io/agent-run-log'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'

const READY_ISSUE: GitHubIssue = {
  number: 146,
  title: '[FEATURE] Add durable agent run log for GitHub issue workflow',
  body: 'Issue body',
  labels: ['ready-for-agent'],
  state: 'open',
  htmlUrl: 'https://github.com/Joncallim/Forge/issues/146',
  authorLogin: 'Joncallim',
  isPullRequest: false,
}

const tempRoots: string[] = []

async function tempRepositoryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-run-log-'))
  tempRoots.push(root)
  return root
}

function runPath(root: string, issueNumber = 146, runId = 'issue-146-1234567890-1'): string {
  return path.join(root, '.forge', 'runs', String(issueNumber), `${runId}.json`)
}

async function readRun(root: string, issueNumber = 146, runId = 'issue-146-1234567890-1') {
  return agentRunRecordSchema.parse(JSON.parse(await readFile(runPath(root, issueNumber, runId), 'utf8')))
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('agent run log contracts', () => {
  it('round-trips strict records and fills the checkpoint default', () => {
    const parsed = agentRunRecordSchema.parse({
      runId: 'issue-141-1234567890-1',
      issueNumber: 141,
      issueTitle: '[EPIC] GitHub-native agent workflow',
      runtime: 'dry-run',
      action: 'implement',
      requestedBy: 'Joncallim',
      status: 'requested',
      branchName: 'agent/issue-141-foundation',
      blockedReason: null,
      handoffArtifacts: null,
      source: {
        type: 'issue_comment',
        commentId: 99887766,
      },
      prNumber: null,
      validationSummary: {
        issueType: 'epic',
        valid: true,
        missingSections: [],
      },
      createdAt: '2026-07-05T10:00:00.000Z',
      updatedAt: '2026-07-05T10:00:00.000Z',
      events: [
        {
          at: '2026-07-05T10:00:00.000Z',
          status: 'requested',
          message: 'Run record created from an accepted issue command.',
        },
      ],
    })

    const roundTrip = agentRunRecordSchema.parse(JSON.parse(JSON.stringify(parsed)))

    expect(parsed.checkpointIssueRef).toBe(32)
    expect(roundTrip).toEqual(parsed)
  })

  it('rejects date-based run ids that do not match the GitHub/local pattern', () => {
    expect(runIdSchema.safeParse('issue-141-20260703-001').success).toBe(false)
    expect(runIdSchema.safeParse('issue-141-local-deadbee').success).toBe(true)
  })

  it('rejects secret-shaped or transcript-shaped extra fields', () => {
    const withTokenUsage = agentRunRecordSchema.safeParse({
      runId: 'issue-141-1234567890-2',
      issueNumber: 141,
      issueTitle: '[EPIC] GitHub-native agent workflow',
      runtime: 'codex',
      action: 'handoff',
      requestedBy: 'Joncallim',
      status: 'handed-off',
      branchName: null,
      blockedReason: null,
      handoffArtifacts: {
        handoffPath: '.forge/runs/141/issue-141-1234567890-2/handoff.md',
        promptPath: '.forge/runs/141/issue-141-1234567890-2/prompt.md',
        metadataPath: '.forge/runs/141/issue-141-1234567890-2/metadata.json',
      },
      source: {
        type: 'manual',
        commentId: null,
      },
      prNumber: null,
      validationSummary: null,
      createdAt: '2026-07-05T10:05:00.000Z',
      updatedAt: '2026-07-05T10:06:00.000Z',
      events: [
        {
          at: '2026-07-05T10:06:00.000Z',
          status: 'handed-off',
          message: 'Generated runtime handoff artifacts.',
          transcriptPath: '.forge/runs/141/transcript.md',
        },
      ],
      tokenUsage: 1234,
    })

    expect(withTokenUsage.success).toBe(false)
  })
})

describe('agent run log storage', () => {
  it('creates a durable run record from an accepted command before applying agent-requested', async () => {
    const root = await tempRepositoryRoot()
    const client = new FakeGitHubClient({ issues: [READY_ISSUE], collaboratorPermissions: { Joncallim: 'write' } })

    const result = await runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 99887766, body: 'codex implement', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      recorder: new FileAgentRunRecorder({
        repositoryRoot: root,
        now: new Date('2026-07-06T01:02:03.000Z'),
      }),
      githubRunId: 1234567890,
      githubRunAttempt: 1,
    })

    expect(result.command.accepted).toBe(true)
    expect((await client.getIssue(146)).labels).toContain('agent-requested')

    const record = await readRun(root)
    expect(record).toMatchObject({
      runId: 'issue-146-1234567890-1',
      issueNumber: 146,
      issueTitle: READY_ISSUE.title,
      runtime: 'codex',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 99887766 },
      status: 'requested',
      branchName: null,
      prNumber: null,
      blockedReason: null,
      validationSummary: null,
      createdAt: '2026-07-06T01:02:03.000Z',
      updatedAt: '2026-07-06T01:02:03.000Z',
    })
    expect(record.events).toEqual([{
      at: '2026-07-06T01:02:03.000Z',
      status: 'requested',
      message: 'Run record created from an accepted issue command.',
    }])
  })

  it('updates run status and appends event history', async () => {
    const root = await tempRepositoryRoot()
    await recordRequested({
      runId: 'issue-146-1234567890-1',
      issueNumber: 146,
      issueTitle: READY_ISSUE.title,
      runtime: 'claude-code',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 101 },
    }, {
      repositoryRoot: root,
      now: new Date('2026-07-06T01:00:00.000Z'),
    })

    await appendRunEvent({
      issueNumber: 146,
      runId: 'issue-146-1234567890-1',
      message: 'Dispatch inspected the request.',
    }, {
      repositoryRoot: root,
      now: new Date('2026-07-06T01:05:00.000Z'),
    })
    const updated = await updateRunStatus({
      issueNumber: 146,
      runId: 'issue-146-1234567890-1',
      status: 'running',
      message: 'Dispatcher started the runtime.',
    }, {
      repositoryRoot: root,
      now: new Date('2026-07-06T01:06:00.000Z'),
    })

    expect(updated.status).toBe('running')
    expect(updated.updatedAt).toBe('2026-07-06T01:06:00.000Z')
    expect(updated.events.map((event) => event.message)).toEqual([
      'Run record created from an accepted issue command.',
      'Dispatch inspected the request.',
      'Dispatcher started the runtime.',
    ])
    expect(updated.events.at(-1)).toMatchObject({ status: 'running' })
  })

  it('adds branch name and pull request number later', async () => {
    const root = await tempRepositoryRoot()
    await recordRequested({
      runId: 'issue-146-1234567890-1',
      issueNumber: 146,
      issueTitle: READY_ISSUE.title,
      runtime: 'codex',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 102 },
    }, { repositoryRoot: root, now: new Date('2026-07-06T01:00:00.000Z') })

    const updated = await linkPullRequest({
      issueNumber: 146,
      runId: 'issue-146-1234567890-1',
      branchName: 'issue-146-durable-agent-run-log',
      prNumber: 162,
    }, { repositoryRoot: root, now: new Date('2026-07-06T02:00:00.000Z') })

    expect(updated).toMatchObject({
      status: 'pr-opened',
      branchName: 'issue-146-durable-agent-run-log',
      prNumber: 162,
      updatedAt: '2026-07-06T02:00:00.000Z',
    })
  })

  it('records blocked runs with a blocked reason', async () => {
    const root = await tempRepositoryRoot()
    await recordRequested({
      runId: 'issue-146-1234567890-1',
      issueNumber: 146,
      issueTitle: READY_ISSUE.title,
      runtime: 'codex',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 103 },
    }, { repositoryRoot: root, now: new Date('2026-07-06T01:00:00.000Z') })

    const blocked = await recordBlockedReason({
      issueNumber: 146,
      runId: 'issue-146-1234567890-1',
      blockedReason: 'No eligible runtime is configured.',
    }, { repositoryRoot: root, now: new Date('2026-07-06T03:00:00.000Z') })

    expect(blocked.status).toBe('blocked')
    expect(blocked.blockedReason).toBe('No eligible runtime is configured.')
    expect(blocked.events.at(-1)).toMatchObject({
      status: 'blocked',
      message: 'No eligible runtime is configured.',
    })
  })

  it('prevents agent-requested and accepted comments when persistence fails', async () => {
    const root = await tempRepositoryRoot()
    await writeFile(path.join(root, '.forge'), 'not a directory', 'utf8')
    const client = new FakeGitHubClient({ issues: [READY_ISSUE], collaboratorPermissions: { Joncallim: 'write' } })

    await expect(runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 104, body: 'codex implement', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      recorder: new FileAgentRunRecorder({ repositoryRoot: root }),
      githubRunId: 1234567891,
      githubRunAttempt: 1,
    })).rejects.toThrow()

    expect((await client.getIssue(146)).labels).not.toContain('agent-requested')
    expect(await client.listComments(146)).toEqual([])
  })

  it('prevents agent-requested and accepted comments when durable git persistence fails', async () => {
    const root = await tempRepositoryRoot()
    const client = new FakeGitHubClient({ issues: [READY_ISSUE], collaboratorPermissions: { Joncallim: 'write' } })
    const persistedPaths: string[] = []

    await expect(runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 105, body: 'codex implement', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      recorder: new FileAgentRunRecorder({
        repositoryRoot: root,
        persistRecord: async ({ filePath }) => {
          persistedPaths.push(filePath)
          throw new Error('run record git persist failed')
        },
      }),
      githubRunId: 1234567892,
      githubRunAttempt: 1,
    })).rejects.toThrow('run record git persist failed')

    expect(persistedPaths).toEqual([runPath(root, 146, 'issue-146-1234567892-1')])
    expect(await readRun(root, 146, 'issue-146-1234567892-1')).toMatchObject({
      runId: 'issue-146-1234567892-1',
      status: 'requested',
    })
    expect((await client.getIssue(146)).labels).not.toContain('agent-requested')
    expect(await client.listComments(146)).toEqual([])
  })

  it('redacts secret-shaped values and truncates transcript-shaped event messages', async () => {
    const root = await tempRepositoryRoot()
    await recordRequested({
      runId: 'issue-146-1234567890-1',
      issueNumber: 146,
      issueTitle: READY_ISSUE.title,
      runtime: 'codex',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 105 },
    }, { repositoryRoot: root, now: new Date('2026-07-06T01:00:00.000Z') })

    await appendRunEvent({
      issueNumber: 146,
      runId: 'issue-146-1234567890-1',
      message: `token=ghp_${'a'.repeat(40)} ${'model transcript line '.repeat(80)}`,
    }, { repositoryRoot: root, now: new Date('2026-07-06T01:01:00.000Z') })

    const raw = await readFile(runPath(root), 'utf8')
    const record = agentRunRecordSchema.parse(JSON.parse(raw))
    expect(raw).not.toContain('ghp_')
    expect(raw).not.toContain('model transcript line '.repeat(40))
    expect(record.events.at(-1)?.message).toContain('[redacted]')
    expect(record.events.at(-1)?.message).toContain('[truncated]')
    expect(record.events.at(-1)?.message.length).toBeLessThanOrEqual(500)
  })

  it('finds the latest run for an issue by updated timestamp', async () => {
    const root = await tempRepositoryRoot()
    await recordRequested({
      runId: 'issue-146-1234567890-1',
      issueNumber: 146,
      issueTitle: READY_ISSUE.title,
      runtime: 'codex',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 106 },
    }, { repositoryRoot: root, now: new Date('2026-07-06T01:00:00.000Z') })
    await recordRequested({
      runId: 'issue-146-1234567890-2',
      issueNumber: 146,
      issueTitle: READY_ISSUE.title,
      runtime: 'claude-code',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 107 },
    }, { repositoryRoot: root, now: new Date('2026-07-06T01:01:00.000Z') })
    await updateRunStatus({
      issueNumber: 146,
      runId: 'issue-146-1234567890-1',
      status: 'running',
    }, { repositoryRoot: root, now: new Date('2026-07-06T01:02:00.000Z') })

    const latest = await findLatestRunForIssue(146, { repositoryRoot: root })

    expect(latest?.runId).toBe('issue-146-1234567890-1')
    expect(await findLatestRunForIssue(999, { repositoryRoot: root })).toBeNull()
  })
})
