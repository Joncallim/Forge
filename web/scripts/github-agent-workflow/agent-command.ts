import { runMain } from './cli/entrypoint'
import {
  type AgentCommandResult,
  type AgentCommandRunRecorder,
  runAgentCommand,
} from './core/agent-command'
import { readGitHubEvent } from './io/event'
import {
  FileAgentRunRecorder,
  persistRunRecordToGit,
  resolveRepositoryRoot,
  withRunLogBranchWorktree,
  type PersistRunRecordInput,
} from './io/agent-run-log'
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

function runLogPersisterFromEnv(env: NodeJS.ProcessEnv): ((input: PersistRunRecordInput) => Promise<void>) | undefined {
  return env.FORGE_AGENT_RUN_LOG_GIT_COMMIT === '1' ? persistRunRecordToGit : undefined
}

function runLogTargetBranchFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.FORGE_AGENT_RUN_LOG_BRANCH?.trim() || undefined
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
  const persistRecord = runLogPersisterFromEnv(env)
  const targetBranch = runLogTargetBranchFromEnv(env)
  const run = async (repositoryRoot?: string) => await runAgentCommandForEvent({
    client,
    event,
    botLogin: botLoginFromEnv(env),
    recorder: new FileAgentRunRecorder({
      repositoryRoot,
      persistRecord,
      targetBranch,
    }),
    githubRunId: env.GITHUB_RUN_ID,
    githubRunAttempt: env.GITHUB_RUN_ATTEMPT,
    shortSha: shortShaFromEnv(env),
  })
  const result = persistRecord
    ? await withRunLogBranchWorktree({
        repositoryRoot: await resolveRepositoryRoot(env.GITHUB_WORKSPACE),
        targetBranch,
      }, async (runLogRepositoryRoot) => await run(runLogRepositoryRoot))
    : await run()

  console.info(JSON.stringify(result, null, 2))
}

runMain(import.meta.url, () => main())
