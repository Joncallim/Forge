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

export type GitHubIssuesEvent = {
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
    default_branch?: string
  }
}

/**
 * The workflow-ref helper deliberately needs only string-valued environment
 * entries.  Using a string index signature keeps Node's ProcessEnv structurally
 * compatible while tests can pass a minimal, deterministic environment object.
 */
type WorkflowRefEnvironment = Readonly<Record<string, string | undefined>>

const GRAPH_CHANGING_EVENTS = new Set(['opened', 'edited', 'closed', 'reopened'])
const WRITE_LEVEL_PERMISSIONS = new Set(['admin', 'maintain', 'write'])

export function markerCommentPolicyForAction(action: string | undefined): 'always' | 'on-projection-change' {
  return GRAPH_CHANGING_EVENTS.has(action ?? '') ? 'always' : 'on-projection-change'
}

export function reconcileWorkflowRef(
  event: GitHubIssuesEvent,
  env: WorkflowRefEnvironment,
): string {
  const defaultBranch = event.repository?.default_branch?.trim()
  if (defaultBranch) return defaultBranch

  const envRef = env.GITHUB_REF_NAME?.trim()
  if (envRef) return envRef

  throw new Error('Cannot dispatch reconcile workflow: repository default branch is unavailable.')
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
async function dispatchReconcileWorkflow(env: NodeJS.ProcessEnv, event: GitHubIssuesEvent): Promise<void> {
  const token = env.GITHUB_TOKEN
  const repo = env.GITHUB_REPOSITORY
  if (!token || !repo) {
    throw new Error('Cannot dispatch reconcile workflow: missing GITHUB_TOKEN or GITHUB_REPOSITORY.')
  }

  const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
  const url = `${apiUrl}/repos/${repo}/actions/workflows/reconcile-readiness.yml/dispatches`
  const ref = reconcileWorkflowRef(event, env)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'forge',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref,
        inputs: { dry_run: 'false' },
      }),
    })
  } catch {
    throw new Error('Failed to dispatch reconcile workflow due to a network or transport error.')
  }
  if (!response.ok) throw new Error(`Failed to dispatch reconcile workflow: GitHub returned status ${response.status}.`)
  console.info('Dispatched reconcile-readiness workflow for full repository reconciliation.')
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
  const action = event.action ?? ''
  const { result, readinessResult } = await runIssueValidation(client, issue, {
    botLogin: botLoginFromEnv(env),
    markerCommentPolicy: markerCommentPolicyForAction(action),
  })

  console.info(JSON.stringify({
    structuralValidation: result,
    readinessResult,
  }, null, 2))

  // Graph-changing events from trusted actors trigger full reconciliation
  if (GRAPH_CHANGING_EVENTS.has(action)) {
    if (await canActorTriggerFullReconcile(client, event)) {
      console.info('Graph-changing event from trusted actor. Dispatching full reconciliation.')
      await dispatchReconcileWorkflow(env, event)
    } else {
      console.info('Graph-changing event from untrusted actor. Target-only reconciliation applied.')
    }
  } else {
    console.info(`Event type "${action}" triggers target-only readiness self-heal.`)
  }
}

runMain(import.meta.url, () => main())
