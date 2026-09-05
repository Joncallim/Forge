/**
 * Issue intake validation entry point.
 *
 * Event routing:
 *   labeled / unlabeled   → target-only semantic self-heal (always)
 *   opened / edited / closed / reopened (trusted actor) → target-only + full reconcile dispatch
 *   opened / edited / closed / reopened (untrusted actor) → target-only only
 *
 * Full reconciliation is dispatched via the GitHub API to the reconcile workflow.
 * Correctness does not depend on secondary label events emitted by GITHUB_TOKEN.
 */

import { runMain } from './cli/entrypoint'
import { readGitHubEvent } from './io/event'
import { RestGitHubClient, type GitHubClient } from './io/github-client'
import { runIssueValidation } from './shared/issue-validation-runner'

type GitHubIssuesEvent = {
  issue?: {
    number?: unknown
    pull_request?: unknown
  }
  action?: string
  sender?: {
    login?: string
  }
  repository?: {
    full_name?: string
  }
}

const GRAPH_CHANGING_EVENTS = new Set(['opened', 'edited', 'closed', 'reopened'])
const WRITE_LEVEL_PERMISSIONS = new Set(['admin', 'maintain', 'write'])

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

async function canActorTriggerFullReconcile(
  client: GitHubClient,
  event: GitHubIssuesEvent,
): Promise<boolean> {
  const actor = event.sender?.login
  if (!actor) return false

  try {
    const permission = await client.getCollaboratorPermission(actor)
    return WRITE_LEVEL_PERMISSIONS.has(permission)
  } catch {
    return false
  }
}

/**
 * Dispatch the reconcile-readiness workflow via GitHub API.
 * Uses the same GITHUB_TOKEN for authentication.
 */
async function dispatchReconcileWorkflow(env: NodeJS.ProcessEnv): Promise<void> {
  const token = env.GITHUB_TOKEN
  const repo = env.GITHUB_REPOSITORY
  if (!token || !repo) {
    console.warn('Cannot dispatch reconcile workflow: missing GITHUB_TOKEN or GITHUB_REPOSITORY.')
    return
  }

  const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
  const url = `${apiUrl}/repos/${repo}/actions/workflows/reconcile-readiness.yml/dispatches`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'forge',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: env.GITHUB_REF_NAME || 'main',
        inputs: { dry_run: 'false' },
      }),
    })

    if (!response.ok) {
      console.warn(`Failed to dispatch reconcile workflow: ${response.status}`)
    } else {
      console.info('Dispatched reconcile-readiness workflow for full repository reconciliation.')
    }
  } catch (error) {
    console.warn(`Failed to dispatch reconcile workflow: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const event = await readGitHubEvent<GitHubIssuesEvent>(env)
  if (event.issue?.pull_request !== undefined) {
    console.info('Skipping issue-intake validation for a pull request event.')
    return
  }

  const client = RestGitHubClient.fromEnv(env)
  const issueNumber = issueNumberFromEvent(event, env)
  const issue = await client.getIssue(issueNumber)
  const { result, readinessResult } = await runIssueValidation(client, issue, { botLogin: botLoginFromEnv(env) })

  console.info(JSON.stringify({
    structuralValidation: result,
    readinessResult,
  }, null, 2))

  // Graph-changing events from trusted actors trigger full reconciliation
  const action = event.action ?? ''
  if (GRAPH_CHANGING_EVENTS.has(action)) {
    if (await canActorTriggerFullReconcile(client, event)) {
      console.info('Graph-changing event from trusted actor. Dispatching full reconciliation.')
      await dispatchReconcileWorkflow(env)
    } else {
      console.info('Graph-changing event from untrusted actor. Target-only reconciliation applied.')
    }
  } else {
    console.info(`Event type "${action}" triggers target-only readiness self-heal.`)
  }
}

runMain(import.meta.url, () => main())
