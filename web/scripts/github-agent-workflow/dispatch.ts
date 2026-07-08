import { runMain } from './cli/entrypoint'
import { dispatchRequestSchema, type DispatchRequest } from './contracts/dispatch-request'
import { DISPATCH_STATE_TO_RUN_STATUS, type RunId } from './contracts/common'
import type { AgentRunRecord } from './contracts/agent-run-record'
import type { WorkOrder } from './contracts/work-order'
import { extractAcceptanceCriteria } from './core/acceptance-criteria'
import { buildAgentBranchName } from './core/branch-names'
import { renderPrContractTemplate } from './core/pr-contract'
import { redactSecretLikeText } from './core/redaction'
import { buildWorkOrder, renderWorkOrder } from './core/work-order'
import { readGitHubEvent } from './io/event'
import {
  appendRunEvent,
  findLatestRunForIssue,
  persistRunRecordToGit,
  recordBlockedReason,
  resolveRepositoryRoot,
  updateRunStatus,
  withRunLogBranchWorktree,
} from './io/agent-run-log'
import { RestGitHubClient, type GitHubClient, type GitHubIssue } from './io/github-client'

export const DISPATCH_MARKER_PREFIX = '<!-- forge-agent-dispatch -->'

type DispatchGitHubEvent = {
  action?: unknown
  label?: {
    name?: unknown
  }
  issue?: {
    number?: unknown
    pull_request?: unknown
  }
  inputs?: {
    issue_number?: unknown
    dry_run?: unknown
  }
}

type DispatchStatus = 'dispatched' | 'blocked' | 'dry-run' | 'ignored'

export type DispatchResult = Readonly<{
  status: DispatchStatus
  issueNumber: number | null
  runId: RunId | null
  branchName: string | null
  blockedReason: string | null
  workOrder: WorkOrder | null
  request: DispatchRequest | null
  commentBody: string | null
}>

function hasLabel(issue: GitHubIssue, label: string): boolean {
  const normalized = label.trim().toLowerCase()
  return issue.labels.some((issueLabel) => issueLabel.trim().toLowerCase() === normalized)
}

function parsePositiveIssueNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase())
}

function issueNumberFromEventOrEnv(event: DispatchGitHubEvent, env: NodeJS.ProcessEnv): number {
  const candidates = [
    env.ISSUE_NUMBER,
    event.inputs?.issue_number,
    event.issue?.number,
  ]
  for (const candidate of candidates) {
    const parsed = parsePositiveIssueNumber(candidate)
    if (parsed !== null) return parsed
  }
  throw new Error('Agent dispatch requires a positive issue number from ISSUE_NUMBER, workflow_dispatch input, or GITHUB_EVENT_PATH.')
}

function dryRunFromEventOrEnv(event: DispatchGitHubEvent, env: NodeJS.ProcessEnv): boolean {
  return parseBoolean(env.DRY_RUN ?? env.FORGE_DISPATCH_DRY_RUN ?? event.inputs?.dry_run)
}

function botLoginFromEnv(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_BOT_LOGIN?.trim() || 'github-actions[bot]'
}

async function readOptionalEvent(env: NodeJS.ProcessEnv): Promise<DispatchGitHubEvent> {
  if (!env.GITHUB_EVENT_PATH?.trim()) return {}
  return await readGitHubEvent<DispatchGitHubEvent>(env)
}

function ignoredResult(reason: string): DispatchResult {
  return {
    status: 'ignored',
    issueNumber: null,
    runId: null,
    branchName: null,
    blockedReason: reason,
    workOrder: null,
    request: null,
    commentBody: null,
  }
}

function dispatchBlockedComment(input: {
  issueNumber: number
  runId: RunId | null
  reason: string
}): string {
  return [
    DISPATCH_MARKER_PREFIX,
    '',
    'Agent dispatch blocked.',
    '',
    `- Issue: #${input.issueNumber}`,
    `- Run ID: ${input.runId ? `\`${input.runId}\`` : 'n/a'}`,
    `- Reason: ${input.reason}`,
    '- Next step: fix the issue labels or create a fresh accepted agent request, then rerun dispatch.',
    '- Note: no Claude Code or Codex execution has started.',
  ].join('\n')
}

function dispatchSuccessComment(input: {
  issueNumber: number
  runId: RunId
  branchName: string
  status: string
  dryRun: boolean
}): string {
  return [
    DISPATCH_MARKER_PREFIX,
    '',
    input.dryRun ? 'Agent dispatch dry run succeeded.' : 'Agent dispatch prepared a bounded work order.',
    '',
    `- Issue: #${input.issueNumber}`,
    `- Run ID: \`${input.runId}\``,
    `- Branch: \`${input.branchName}\``,
    `- Status: \`${input.dryRun ? 'dry-run' : input.status}\``,
    '- Next step: generate the handoff package and run the selected runtime manually or in a controlled environment.',
    '- Note: no Claude Code or Codex execution has started.',
  ].join('\n')
}

function dispatchAlreadyHandedOffComment(input: {
  issueNumber: number
  runId: RunId
  branchName: string | null
}): string {
  return [
    DISPATCH_MARKER_PREFIX,
    '',
    'Agent dispatch already prepared a bounded work order.',
    '',
    `- Issue: #${input.issueNumber}`,
    `- Run ID: \`${input.runId}\``,
    `- Branch: ${input.branchName ? `\`${input.branchName}\`` : 'not recorded'}`,
    '- Status: `handed-off`',
    '- Next step: generate or inspect the handoff package.',
    '- Note: this was an idempotent re-dispatch check. No Claude Code or Codex execution has started.',
  ].join('\n')
}

function renderCriteria(criteria: readonly string[]): string {
  return criteria.length === 0
    ? 'No explicit acceptance criteria were found on the source issue. Stop and ask for clarification before broadening scope.'
    : criteria.map((criterion) => `- ${redactSecretLikeText(criterion)}`).join('\n')
}

export function buildDispatchWorkOrder(input: {
  issue: GitHubIssue
  branchName: string
  runId: RunId
  runtime: string
  acceptanceCriteria?: readonly string[]
}): WorkOrder {
  const criteria = input.acceptanceCriteria ?? extractAcceptanceCriteria(input.issue.body)
  const redactedCriteria = criteria.map(redactSecretLikeText)
  const prContract = renderPrContractTemplate({
    issueNumber: input.issue.number,
    runtime: input.runtime,
    runId: input.runId,
  }).trim()

  return buildWorkOrder({
    issueNumber: input.issue.number,
    issueTitle: redactSecretLikeText(input.issue.title),
    branchName: input.branchName,
    sections: {
      'Source Issue': [
        `Issue: #${input.issue.number}`,
        `Title: ${redactSecretLikeText(input.issue.title)}`,
        `URL: ${input.issue.htmlUrl}`,
      ].join('\n'),
      Objective: 'Implement only the ready source issue. Keep the change bounded to the issue text and acceptance criteria.',
      'Acceptance Criteria': renderCriteria(redactedCriteria),
      'Required Constraints': [
        'Do not run Claude Code or Codex automatically from dispatch.',
        'Do not execute issue, comment, or pull request supplied code in GitHub Actions.',
        'Do not store secrets, credentials, model transcripts, local auth material, or raw prompts in the durable run log.',
        'Use the pull request contract below when opening or updating the PR. Copy the criteria from the work-order acceptance-criteria section into the PR validation checklist with evidence.',
        '',
        prContract,
      ].join('\n'),
      'Relevant Repo Rules': [
        'Follow AGENTS.md and the repository documentation style.',
        'Generated PRs must link the source issue with Closes, Fixes, Resolves, or Issue.',
        'Generated PRs must not claim validation that was not run.',
      ].join('\n'),
      'Expected Output': [
        `Work on branch \`${input.branchName}\`.`,
        `Open or update a pull request that links \`Closes #${input.issue.number}\` unless a maintainer asks for a non-closing \`Issue: #${input.issue.number}\` link.`,
        'Fill every pull request contract section, including acceptance-criteria evidence and tests.',
      ].join('\n'),
      'Stop Conditions': [
        'Stop if the issue is closed, loses ready-for-agent, gains needs-clarification, or the run record is no longer eligible.',
        'Stop if satisfying the issue would require secrets, credentials, unrestricted filesystem access, or executing untrusted PR code.',
        'Stop and report if required tests fail in a way that cannot be fixed without weakening existing safety guarantees.',
      ].join('\n'),
    },
  })
}

function eligibilityFailure(issue: GitHubIssue, run: Awaited<ReturnType<typeof findLatestRunForIssue>>): string | null {
  if (issue.state !== 'open') return 'Source issue is not open.'
  if (!hasLabel(issue, 'ready-for-agent')) return 'Source issue does not have `ready-for-agent`.'
  if (hasLabel(issue, 'needs-clarification')) return 'Source issue has `needs-clarification`.'
  if (run === null) return 'No run record exists for this issue.'
  if (run.status !== 'requested') return `Latest run status is \`${run.status}\`, not \`requested\`.`
  if (!['claude-code', 'codex', 'dry-run'].includes(run.runtime)) return `Runtime \`${run.runtime}\` is not supported by dispatch.`
  if (run.action !== 'implement') return `Action \`${run.action}\` is not supported by dispatch.`
  return null
}

function isIdempotentHandedOffRun(
  issue: GitHubIssue,
  run: Awaited<ReturnType<typeof findLatestRunForIssue>>,
): run is AgentRunRecord & { status: 'handed-off' } {
  return issue.state === 'open'
    && hasLabel(issue, 'ready-for-agent')
    && !hasLabel(issue, 'needs-clarification')
    && run !== null
    && run.status === 'handed-off'
    && ['claude-code', 'codex', 'dry-run'].includes(run.runtime)
    && run.action === 'implement'
}

export async function runDispatch(input: {
  client: GitHubClient
  issueNumber: number
  runLogRepositoryRoot: string
  botLogin: string
  dryRun?: boolean
  now?: Date
  persistRunLog?: boolean
  targetBranch?: string | null
}): Promise<DispatchResult> {
  const issue = await input.client.getIssue(input.issueNumber)
  const latestRun = await findLatestRunForIssue(input.issueNumber, { repositoryRoot: input.runLogRepositoryRoot })

  if (isIdempotentHandedOffRun(issue, latestRun)) {
    const commentBody = dispatchAlreadyHandedOffComment({
      issueNumber: input.issueNumber,
      runId: latestRun.runId,
      branchName: latestRun.branchName,
    })
    if (!input.dryRun) {
      await input.client.removeLabel(issue.number, 'agent-blocked')
      await input.client.upsertComment(issue.number, {
        markerPrefix: DISPATCH_MARKER_PREFIX,
        botLogin: input.botLogin,
        body: commentBody,
      })
    }
    return {
      status: 'ignored',
      issueNumber: input.issueNumber,
      runId: latestRun.runId,
      branchName: latestRun.branchName,
      blockedReason: null,
      workOrder: null,
      request: null,
      commentBody,
    }
  }

  const blockedReason = eligibilityFailure(issue, latestRun)

  if (blockedReason !== null) {
    if (!input.dryRun && latestRun !== null) {
      await recordBlockedReason({
        issueNumber: input.issueNumber,
        runId: latestRun.runId,
        blockedReason,
      }, {
        repositoryRoot: input.runLogRepositoryRoot,
        now: input.now,
        persistRecord: input.persistRunLog ? persistRunRecordToGit : undefined,
        targetBranch: input.targetBranch,
      })
    }
    if (!input.dryRun) {
      await input.client.addLabel(input.issueNumber, 'agent-blocked')
    }
    const commentBody = dispatchBlockedComment({ issueNumber: input.issueNumber, runId: latestRun?.runId ?? null, reason: blockedReason })
    if (!input.dryRun) {
      await input.client.upsertComment(input.issueNumber, {
        markerPrefix: DISPATCH_MARKER_PREFIX,
        botLogin: input.botLogin,
        body: commentBody,
      })
    }
    return {
      status: 'blocked',
      issueNumber: input.issueNumber,
      runId: latestRun?.runId ?? null,
      branchName: null,
      blockedReason,
      workOrder: null,
      request: null,
      commentBody,
    }
  }

  const run = latestRun
  if (run === null) throw new Error('Dispatch eligibility passed without a run record.')
  const branchName = buildAgentBranchName({ issueNumber: issue.number, issueTitle: issue.title })
  const requestedAt = (input.now ?? new Date()).toISOString()
  const request = dispatchRequestSchema.parse({
    runId: run.runId,
    issueNumber: issue.number,
    issueTitle: issue.title,
    runtime: run.runtime,
    action: run.action,
    requestedBy: run.requestedBy,
    branchName,
    dryRun: input.dryRun === true,
    source: run.source,
    requestedAt,
  })
  const workOrder = buildDispatchWorkOrder({
    issue,
    branchName,
    runId: run.runId,
    runtime: run.runtime,
  })
  const rendered = renderWorkOrder(workOrder)

  if (!input.dryRun) {
    const runLogOptions = {
      repositoryRoot: input.runLogRepositoryRoot,
      now: input.now,
      persistRecord: input.persistRunLog ? persistRunRecordToGit : undefined,
      targetBranch: input.targetBranch,
    }
    await updateRunStatus({
      issueNumber: issue.number,
      runId: run.runId,
      status: DISPATCH_STATE_TO_RUN_STATUS.accepted,
      branchName,
      blockedReason: null,
      message: 'Dispatch accepted the requested run and assigned a deterministic branch.',
    }, runLogOptions)
    await appendRunEvent({
      issueNumber: issue.number,
      runId: run.runId,
      status: DISPATCH_STATE_TO_RUN_STATUS.accepted,
      message: `Dispatch generated a bounded work order (${rendered.length} bytes) and did not start a runtime.`,
    }, runLogOptions)
    await input.client.removeLabel(issue.number, 'agent-blocked')
  }

  const commentBody = dispatchSuccessComment({
    issueNumber: issue.number,
    runId: run.runId,
    branchName,
    status: DISPATCH_STATE_TO_RUN_STATUS.accepted,
    dryRun: input.dryRun === true,
  })
  if (!input.dryRun) {
    await input.client.upsertComment(issue.number, {
      markerPrefix: DISPATCH_MARKER_PREFIX,
      botLogin: input.botLogin,
      body: commentBody,
    })
  }

  return {
    status: input.dryRun ? 'dry-run' : 'dispatched',
    issueNumber: issue.number,
    runId: run.runId,
    branchName,
    blockedReason: null,
    workOrder,
    request,
    commentBody,
  }
}

export async function runDispatchForEvent(input: {
  client: GitHubClient
  event: DispatchGitHubEvent
  env: NodeJS.ProcessEnv
  runLogRepositoryRoot: string
  botLogin: string
  persistRunLog?: boolean
  targetBranch?: string | null
  now?: Date
}): Promise<DispatchResult> {
  if (input.event.issue?.pull_request !== undefined) {
    return ignoredResult('Skipping agent dispatch for a pull request event.')
  }

  if (input.event.action === 'labeled' && input.event.label?.name !== 'agent-requested') {
    return ignoredResult('Skipping agent dispatch because the labeled event was not `agent-requested`.')
  }

  return await runDispatch({
    client: input.client,
    issueNumber: issueNumberFromEventOrEnv(input.event, input.env),
    runLogRepositoryRoot: input.runLogRepositoryRoot,
    botLogin: input.botLogin,
    dryRun: dryRunFromEventOrEnv(input.event, input.env),
    now: input.now,
    persistRunLog: input.persistRunLog,
    targetBranch: input.targetBranch,
  })
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const event = await readOptionalEvent(env)
  const client = RestGitHubClient.fromEnv(env)
  const trustedRoot = await resolveRepositoryRoot(env.GITHUB_WORKSPACE)
  const targetBranch = env.FORGE_AGENT_RUN_LOG_BRANCH?.trim() || undefined

  const result = await withRunLogBranchWorktree({
    repositoryRoot: trustedRoot,
    targetBranch,
  }, async (runLogRepositoryRoot) => await runDispatchForEvent({
    client,
    event,
    env,
    runLogRepositoryRoot,
    botLogin: botLoginFromEnv(env),
    persistRunLog: env.FORGE_AGENT_RUN_LOG_GIT_COMMIT === '1',
    targetBranch,
  }))

  console.info(JSON.stringify({
    ...result,
    workOrder: result.workOrder ? renderWorkOrder(result.workOrder) : null,
  }, null, 2))
}

runMain(import.meta.url, () => main())
