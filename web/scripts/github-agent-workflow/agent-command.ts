import { runMain } from './cli/entrypoint'
import {
  type AgentCommandResult,
  type AgentCommandRunRecordInput,
  type AgentCommandRunRecorder,
  runAgentCommand,
} from './core/agent-command'
import { readGitHubEvent } from './io/event'
import { RestGitHubClient, type GitHubClient } from './io/github-client'

type GitHubIssueCommentEvent = {
  issue?: {
    number?: unknown
    pull_request?: unknown
  }
  comment?: {
    id?: unknown
    body?: unknown
    user?: {
      login?: unknown
    }
  }
}

type AgentCommandEventResult =
  | { ignored: true; reason: string }
  | ({ ignored: false } & AgentCommandResult)

class BoundaryAgentRunRecorder implements AgentCommandRunRecorder {
  async recordRequested(input: AgentCommandRunRecordInput): Promise<void> {
    console.info(JSON.stringify({
      boundary: '#146',
      message: 'Agent run persistence is not implemented yet; request was recorded through the #146 boundary stub.',
      request: input,
    }, null, 2))
  }
}

function issueNumberFromEvent(event: GitHubIssueCommentEvent): number {
  const issueNumber = event.issue?.number
  if (typeof issueNumber === 'number' && Number.isInteger(issueNumber) && issueNumber > 0) return issueNumber
  throw new Error('Agent command routing requires a positive issue number from GITHUB_EVENT_PATH.')
}

function commentFromEvent(event: GitHubIssueCommentEvent): { id: number; body: string; authorLogin: string } {
  const id = event.comment?.id
  const body = event.comment?.body
  const authorLogin = event.comment?.user?.login

  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new Error('Agent command routing requires a positive issue comment id from GITHUB_EVENT_PATH.')
  }
  if (typeof body !== 'string') {
    throw new Error('Agent command routing requires an issue comment body from GITHUB_EVENT_PATH.')
  }
  if (typeof authorLogin !== 'string' || authorLogin.trim() === '') {
    throw new Error('Agent command routing requires an issue comment author from GITHUB_EVENT_PATH.')
  }

  return { id, body, authorLogin }
}

function botLoginFromEnv(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_BOT_LOGIN?.trim() || 'github-actions[bot]'
}

function sameLogin(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

function shortShaFromEnv(env: NodeJS.ProcessEnv): string | null {
  const sha = env.GITHUB_SHA?.trim() ?? ''
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 12).toLowerCase() : null
}

export async function runAgentCommandForEvent(input: {
  client: GitHubClient
  event: GitHubIssueCommentEvent
  botLogin: string
  recorder?: AgentCommandRunRecorder
  githubRunId?: number | string | null
  githubRunAttempt?: number | string | null
  shortSha?: string | null
}): Promise<AgentCommandEventResult> {
  if (input.event.issue?.pull_request !== undefined) {
    return {
      ignored: true,
      reason: 'Skipping agent-command routing for a pull request comment.',
    }
  }

  const issueNumber = issueNumberFromEvent(input.event)
  const comment = commentFromEvent(input.event)
  if (sameLogin(comment.authorLogin, input.botLogin)) {
    return {
      ignored: true,
      reason: 'Skipping self-authored agent command comment.',
    }
  }

  const issue = await input.client.getIssue(issueNumber)

  return await runAgentCommand({
    client: input.client,
    issue,
    comment,
    botLogin: input.botLogin,
    recorder: input.recorder,
    githubRunId: input.githubRunId,
    githubRunAttempt: input.githubRunAttempt,
    shortSha: input.shortSha,
  })
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const event = await readGitHubEvent<GitHubIssueCommentEvent>(env)
  const client = RestGitHubClient.fromEnv(env)
  const result = await runAgentCommandForEvent({
    client,
    event,
    botLogin: botLoginFromEnv(env),
    recorder: new BoundaryAgentRunRecorder(),
    githubRunId: env.GITHUB_RUN_ID,
    githubRunAttempt: env.GITHUB_RUN_ATTEMPT,
    shortSha: shortShaFromEnv(env),
  })

  console.info(JSON.stringify(result, null, 2))
}

runMain(import.meta.url, () => main())
