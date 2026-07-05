import { runMain } from './cli/entrypoint'
import { readGitHubEvent } from './io/event'
import { RestGitHubClient } from './io/github-client'
import { runIssueValidation } from './shared/issue-validation-runner'

type GitHubIssuesEvent = {
  issue?: {
    number?: unknown
    pull_request?: unknown
  }
}

function issueNumberFromEvent(event: GitHubIssuesEvent, env: NodeJS.ProcessEnv): number {
  const eventNumber = event.issue?.number
  if (typeof eventNumber === 'number' && Number.isInteger(eventNumber) && eventNumber > 0) return eventNumber

  const envNumber = env.ISSUE_NUMBER?.trim()
  if (envNumber && /^\d+$/.test(envNumber)) return Number(envNumber)

  throw new Error('Issue validation requires an issue number from GITHUB_EVENT_PATH or ISSUE_NUMBER.')
}

function botLoginFromEnv(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_BOT_LOGIN?.trim() || 'github-actions[bot]'
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const event = await readGitHubEvent<GitHubIssuesEvent>(env)
  if (event.issue?.pull_request !== undefined) {
    console.info('Skipping issue-intake validation for a pull request event.')
    return
  }

  const client = RestGitHubClient.fromEnv(env)
  const issue = await client.getIssue(issueNumberFromEvent(event, env))
  const { result } = await runIssueValidation(client, issue, { botLogin: botLoginFromEnv(env) })
  console.info(JSON.stringify(result, null, 2))
}

runMain(import.meta.url, () => main())
