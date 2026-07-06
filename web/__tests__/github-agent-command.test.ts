import { describe, expect, it } from 'vitest'
import {
  AGENT_COMMAND_MARKER_PREFIX,
  parseAgentCommand,
  runAgentCommand,
  type AgentCommandRunRecordInput,
  type AgentCommandRunRecorder,
} from '@/scripts/github-agent-workflow/core/agent-command'
import { runAgentCommandForEvent } from '@/scripts/github-agent-workflow/agent-command'
import { FakeGitHubClient } from '@/scripts/github-agent-workflow/io/fake-github-client'
import type { GitHubCollaboratorPermission, GitHubIssue } from '@/scripts/github-agent-workflow/io/github-client'

const READY_ISSUE: GitHubIssue = {
  number: 143,
  title: '[FEATURE] Add GitHub issue comment agent command router',
  body: 'Issue body',
  labels: ['ready-for-agent'],
  state: 'open',
  htmlUrl: 'https://github.com/Joncallim/Forge/issues/143',
  authorLogin: 'Joncallim',
  isPullRequest: false,
}

class CollectingRunRecorder implements AgentCommandRunRecorder {
  readonly records: AgentCommandRunRecordInput[] = []

  async recordRequested(input: AgentCommandRunRecordInput): Promise<void> {
    this.records.push(input)
  }
}

class PermissionFailureClient extends FakeGitHubClient {
  async getCollaboratorPermission(): Promise<GitHubCollaboratorPermission> {
    throw new Error('GitHub API returned 403 for collaborator permission.')
  }
}

function seedClient(
  issue: GitHubIssue,
  collaboratorPermissions: Record<string, GitHubCollaboratorPermission> = { Joncallim: 'write' },
): FakeGitHubClient {
  return new FakeGitHubClient({ issues: [issue], collaboratorPermissions })
}

describe('GitHub agent command routing', () => {
  it('accepts a Claude implementation request on a ready issue', async () => {
    const client = seedClient(READY_ISSUE)
    const recorder = new CollectingRunRecorder()

    const result = await runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 111, body: 'claude implement', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      recorder,
      githubRunId: 1234567890,
      githubRunAttempt: 1,
    })

    expect(result.command).toMatchObject({
      command: 'claude implement',
      runtime: 'claude-code',
      action: 'implement',
      recognized: true,
      accepted: true,
      rejectionReason: null,
    })
    expect((await client.getIssue(143)).labels).toContain('agent-requested')
    expect((await client.listComments(143))[0]?.body).toContain('Intended agent: Claude Code')
    expect(recorder.records).toEqual([expect.objectContaining({
      runId: 'issue-143-1234567890-1',
      runtime: 'claude-code',
      action: 'implement',
      requestedBy: 'Joncallim',
      source: { type: 'issue_comment', commentId: 111 },
    })])
  })

  it('accepts a Codex implementation request on a ready issue', async () => {
    const client = seedClient(READY_ISSUE)
    const recorder = new CollectingRunRecorder()

    const result = await runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 112, body: 'codex implement', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      recorder,
      githubRunId: 1234567891,
      githubRunAttempt: 2,
    })

    expect(result.command).toMatchObject({
      command: 'codex implement',
      runtime: 'codex',
      action: 'implement',
      recognized: true,
      accepted: true,
      rejectionReason: null,
    })
    expect((await client.getIssue(143)).labels).toContain('agent-requested')
    expect((await client.listComments(143))[0]?.body).toContain('Intended agent: Codex')
    expect(recorder.records[0]).toMatchObject({
      runId: 'issue-143-1234567891-2',
      runtime: 'codex',
      action: 'implement',
    })
  })

  it('rejects an implementation request without ready-for-agent', async () => {
    const issue = { ...READY_ISSUE, labels: [] }
    const client = seedClient(issue)
    const recorder = new CollectingRunRecorder()

    const result = await runAgentCommand({
      client,
      issue,
      comment: { id: 113, body: 'codex implement', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      recorder,
      githubRunId: 1234567892,
      githubRunAttempt: 1,
    })

    expect(result.command.accepted).toBe(false)
    expect(result.command.rejectionReason).toContain('ready-for-agent')
    expect((await client.getIssue(143)).labels).not.toContain('agent-requested')
    expect((await client.listComments(143))[0]?.body).toContain('Implementation requests require the `ready-for-agent` label')
    expect(recorder.records).toEqual([])
  })

  it('rejects an implementation request with needs-clarification', async () => {
    const issue = { ...READY_ISSUE, labels: ['ready-for-agent', 'needs-clarification'] }
    const client = seedClient(issue)
    const recorder = new CollectingRunRecorder()

    const result = await runAgentCommand({
      client,
      issue,
      comment: { id: 114, body: 'claude implement', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      recorder,
      githubRunId: 1234567893,
      githubRunAttempt: 1,
    })

    expect(result.command.accepted).toBe(false)
    expect(result.command.rejectionReason).toContain('needs-clarification')
    expect((await client.getIssue(143)).labels).not.toContain('agent-requested')
    expect((await client.listComments(143))[0]?.body).toContain('needs-clarification')
    expect(recorder.records).toEqual([])
  })

  it('rejects an implementation request from a commenter without write access', async () => {
    const client = seedClient(READY_ISSUE, { reader: 'read' })
    const recorder = new CollectingRunRecorder()

    const result = await runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 115, body: 'codex implement', authorLogin: 'reader' },
      botLogin: 'github-actions[bot]',
      recorder,
      githubRunId: 1234567894,
      githubRunAttempt: 1,
    })

    expect(result.command.accepted).toBe(false)
    expect(result.command.rejectionReason).toContain('write access')
    expect((await client.getIssue(143)).labels).not.toContain('agent-requested')
    expect((await client.listComments(143))[0]?.body).toContain('repository write access')
    expect(recorder.records).toEqual([])
  })

  it('rejects cleanly when repository permission lookup fails', async () => {
    const client = new PermissionFailureClient({ issues: [READY_ISSUE] })
    const recorder = new CollectingRunRecorder()

    const result = await runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 116, body: 'codex implement', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      recorder,
      githubRunId: 1234567895,
      githubRunAttempt: 1,
    })

    expect(result.command.accepted).toBe(false)
    expect(result.command.rejectionReason).toContain('could not verify')
    expect((await client.getIssue(143)).labels).not.toContain('agent-requested')
    expect((await client.listComments(143))[0]?.body).toContain('could not verify')
    expect(recorder.records).toEqual([])
  })

  it('ignores pull request comments using the GitHub event shape', async () => {
    const client = seedClient(READY_ISSUE)
    const recorder = new CollectingRunRecorder()

    const result = await runAgentCommandForEvent({
      client,
      event: {
        issue: { number: 143, pull_request: { url: 'https://api.github.com/repos/Joncallim/Forge/pulls/143' } },
        comment: { id: 117, body: 'codex implement', user: { login: 'Joncallim' } },
      },
      botLogin: 'github-actions[bot]',
      recorder,
      githubRunId: 1234567896,
      githubRunAttempt: 1,
    })

    expect(result).toEqual({
      ignored: true,
      reason: 'Skipping agent-command routing for a pull request comment.',
    })
    expect((await client.getIssue(143)).labels).not.toContain('agent-requested')
    expect(await client.listComments(143)).toEqual([])
    expect(recorder.records).toEqual([])
  })

  it('ignores comments authored by the bot before reading the issue', async () => {
    const client = seedClient(READY_ISSUE)
    const recorder = new CollectingRunRecorder()

    const result = await runAgentCommandForEvent({
      client,
      event: {
        issue: { number: 143 },
        comment: { id: 118, body: '<!-- forge-agent-command -->\n\nAgent request accepted.', user: { login: 'github-actions[bot]' } },
      },
      botLogin: 'github-actions[bot]',
      recorder,
      githubRunId: 1234567897,
      githubRunAttempt: 1,
    })

    expect(result).toEqual({
      ignored: true,
      reason: 'Skipping self-authored agent command comment.',
    })
    expect((await client.getIssue(143)).labels).not.toContain('agent-requested')
    expect(await client.listComments(143)).toEqual([])
    expect(recorder.records).toEqual([])
  })

  it('rejects an unknown request phrase', async () => {
    const client = seedClient(READY_ISSUE)

    const result = await runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 119, body: 'codex implement now', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      githubRunId: 1234567898,
      githubRunAttempt: 1,
    })

    expect(result.command).toMatchObject({
      command: 'unknown',
      recognized: false,
      accepted: false,
    })
    expect((await client.listComments(143))[0]?.body).toContain('Unknown request phrase')
  })

  it.each([
    ['claude implement', 'claude implement', 'claude-code', 'implement'],
    ['Claude implement', 'claude implement', 'claude-code', 'implement'],
    ['/codex implement.', 'codex implement', 'codex', 'implement'],
    ['@forge codex implement', 'codex implement', 'codex', 'implement'],
    ['codex implement', 'codex implement', 'codex', 'implement'],
    ['review', 'review', null, 'review'],
    ['checkpoint', 'checkpoint', null, 'checkpoint'],
    ['handoff', 'handoff', null, 'handoff'],
  ] as const)('recognizes the MVP command phrase "%s"', (body, commandName, runtime, action) => {
    const command = parseAgentCommand({
      issueNumber: 143,
      commentId: 120,
      commentBody: body,
      requestedBy: 'Joncallim',
    })

    expect(command).toMatchObject({
      command: commandName,
      runtime,
      action,
      recognized: true,
    })
  })

  it('parses only the first non-empty comment line', () => {
    const command = parseAgentCommand({
      issueNumber: 143,
      commentId: 117,
      commentBody: '\n\n  codex implement  \nplease also update docs',
      requestedBy: 'Joncallim',
    })

    expect(command.rawText).toBe('  codex implement  ')
    expect(command.normalizedText).toBe('codex implement')
    expect(command.command).toBe('codex implement')
    expect(command.recognized).toBe(true)
  })

  it('ignores ordinary issue comments without posting a router comment', async () => {
    const client = seedClient(READY_ISSUE)

    const result = await runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 121, body: 'not a command', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      githubRunId: 1234567899,
      githubRunAttempt: 1,
    })

    expect(result).toEqual({
      command: expect.objectContaining({
        normalizedText: 'not a command',
        command: 'unknown',
      }),
      ignored: true,
      reason: 'Skipping issue comment because it is not addressed to the agent command router.',
      commentBody: null,
      runId: null,
    })
    expect(await client.listComments(143)).toEqual([])
  })

  it.each([
    '@joncallim please review this',
    '/cc reviewers',
  ])('ignores mention or slash-prefixed prose without posting a router comment: %s', async (body) => {
    const client = seedClient(READY_ISSUE)

    const result = await runAgentCommand({
      client,
      issue: READY_ISSUE,
      comment: { id: 122, body, authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      githubRunId: 1234567900,
      githubRunAttempt: 1,
    })

    expect(result).toEqual({
      command: expect.objectContaining({
        normalizedText: body,
        command: 'unknown',
      }),
      ignored: true,
      reason: 'Skipping issue comment because it is not addressed to the agent command router.',
      commentBody: null,
      runId: null,
    })
    expect(await client.listComments(143)).toEqual([])
  })

  it('does not create a second run record when an agent request is already pending', async () => {
    const issue = { ...READY_ISSUE, labels: ['ready-for-agent', 'agent-requested'] }
    const client = seedClient(issue)
    const recorder = new CollectingRunRecorder()

    const result = await runAgentCommand({
      client,
      issue,
      comment: { id: 123, body: 'claude implement', authorLogin: 'Joncallim' },
      botLogin: 'github-actions[bot]',
      recorder,
      githubRunId: 1234567901,
      githubRunAttempt: 1,
    })

    expect(result.command.accepted).toBe(false)
    expect(result.command.rejectionReason).toContain('already pending or running')
    expect((await client.listComments(143))[0]?.body.startsWith(AGENT_COMMAND_MARKER_PREFIX)).toBe(true)
    expect(recorder.records).toEqual([])
  })
})
