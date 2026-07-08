import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runMain } from './cli/entrypoint'
import { runtimeHandoffSchema, type RuntimeHandoff } from './contracts/runtime-handoff'
import { extractAcceptanceCriteria } from './core/acceptance-criteria'
import { buildAgentBranchName } from './core/branch-names'
import { buildHandoffArtifacts } from './core/handoff'
import { renderPrContractTemplate } from './core/pr-contract'
import { redactSecretLikeText } from './core/redaction'
import { buildDispatchWorkOrder } from './dispatch'
import { renderWorkOrder } from './core/work-order'
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
import { agentBranchNameSchema } from './contracts/branch-name'
import type { AgentRunRecord } from './contracts/agent-run-record'
import type { HandoffArtifacts, RunId } from './contracts/common'

export const HANDOFF_MARKER_PREFIX = '<!-- forge-agent-handoff -->'

type HandoffGitHubEvent = {
  issue?: {
    number?: unknown
    pull_request?: unknown
  }
  inputs?: {
    issue_number?: unknown
  }
}

export type HandoffResult = Readonly<{
  status: 'generated' | 'blocked' | 'ignored'
  issueNumber: number | null
  runId: RunId | null
  runtime: string | null
  branchName: string | null
  artifacts: HandoffArtifacts | null
  artifactName: string | null
  metadata: RuntimeHandoff | null
  blockedReason: string | null
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

function issueNumberFromEventOrEnv(event: HandoffGitHubEvent, env: NodeJS.ProcessEnv): number {
  const candidates = [
    env.ISSUE_NUMBER,
    event.inputs?.issue_number,
    event.issue?.number,
  ]
  for (const candidate of candidates) {
    const parsed = parsePositiveIssueNumber(candidate)
    if (parsed !== null) return parsed
  }
  throw new Error('Agent handoff requires a positive issue number from ISSUE_NUMBER, workflow_dispatch input, or GITHUB_EVENT_PATH.')
}

function botLoginFromEnv(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_BOT_LOGIN?.trim() || 'github-actions[bot]'
}

async function readOptionalEvent(env: NodeJS.ProcessEnv): Promise<HandoffGitHubEvent> {
  if (!env.GITHUB_EVENT_PATH?.trim()) return {}
  return await readGitHubEvent<HandoffGitHubEvent>(env)
}

function relativeArtifactDirectory(artifacts: HandoffArtifacts): string {
  return path.posix.dirname(artifacts.handoffPath)
}

function localArtifactPath(repositoryRoot: string, artifactPath: string): string {
  return path.join(repositoryRoot, ...artifactPath.split('/'))
}

function artifactNameFor(issueNumber: number, runId: RunId, env: NodeJS.ProcessEnv = process.env): string {
  return env.FORGE_HANDOFF_ARTIFACT_NAME?.trim() || `forge-agent-handoff-issue-${issueNumber}-${runId}`
}

function ignoredResult(reason: string): HandoffResult {
  return {
    status: 'ignored',
    issueNumber: null,
    runId: null,
    runtime: null,
    branchName: null,
    artifacts: null,
    artifactName: null,
    metadata: null,
    blockedReason: reason,
    commentBody: null,
  }
}

function eligibilityFailure(issue: GitHubIssue, run: AgentRunRecord | null): string | null {
  if (issue.state !== 'open') return 'Source issue is not open.'
  if (!hasLabel(issue, 'ready-for-agent')) return 'Source issue does not have `ready-for-agent`.'
  if (hasLabel(issue, 'needs-clarification')) return 'Source issue has `needs-clarification`.'
  if (run === null) return 'No run record exists for this issue.'
  if (!['requested', 'handed-off'].includes(run.status)) {
    return `Latest run status is \`${run.status}\`, not \`requested\` or \`handed-off\`.`
  }
  if (!['claude-code', 'codex', 'dry-run'].includes(run.runtime)) return `Runtime \`${run.runtime}\` is not supported by handoff.`
  if (run.action !== 'implement') return `Action \`${run.action}\` is not supported by handoff.`
  if (run.branchName !== null && !agentBranchNameSchema.safeParse(run.branchName).success) {
    return `Run branch name \`${run.branchName}\` does not match the agent branch-name contract.`
  }
  return null
}

function runtimeInstructions(runtime: string, promptPath: string): string {
  switch (runtime) {
    case 'claude-code':
      return [
        'Use the user\'s installed Claude Code command with the generated prompt file.',
        `Prompt file: \`${promptPath}\``,
        'Do not paste secrets into the prompt. Stop if the local environment asks for credentials you do not already have permission to use.',
      ].join('\n')
    case 'codex':
      return [
        'Use the user\'s installed Codex command with the generated prompt file.',
        'Use your strongest available Codex model/profile with highest reasoning.',
        `Prompt file: \`${promptPath}\``,
        'Do not hardcode a model name in shared documentation or workflow output.',
      ].join('\n')
    default:
      return [
        'Dry run only. Inspect the generated work order and prompt, but do not start Claude Code or Codex.',
        `Prompt file: \`${promptPath}\``,
      ].join('\n')
  }
}

function renderHandoffMarkdown(input: {
  issue: GitHubIssue
  run: AgentRunRecord
  branchName: string
  artifacts: HandoffArtifacts
  prContract: string
}): string {
  return [
    '# Forge Agent Handoff',
    '',
    '## Source Issue',
    '',
    `Issue: #${input.issue.number}`,
    `Title: ${redactSecretLikeText(input.issue.title)}`,
    `URL: ${input.issue.htmlUrl}`,
    '',
    '## Runtime',
    '',
    `Runtime: ${input.run.runtime}`,
    `Run ID: ${input.run.runId}`,
    `Branch: ${input.branchName}`,
    '',
    '## Local Execution Instructions',
    '',
    runtimeInstructions(input.run.runtime, input.artifacts.promptPath),
    '',
    '## Stop Conditions',
    '',
    '- Stop if the issue is closed, loses ready-for-agent, or gains needs-clarification.',
    '- Stop if the implementation requires secrets, credentials, unrestricted filesystem access, or executing untrusted pull request code.',
    '- Stop if tests fail in a way that cannot be fixed without weakening existing safety guarantees.',
    '- Stop rather than claiming validation that was not run.',
    '',
    '## Expected PR Contract',
    '',
    input.prContract,
    '',
    '## Validation Expectations',
    '',
    '- Run the relevant tests before claiming a criterion is satisfied.',
    '- Put skipped or unavailable checks in `Tests / Verification`.',
    '- Treat the PR contract checker as review support, not proof of correctness.',
  ].join('\n')
}

function renderPromptMarkdown(input: {
  issue: GitHubIssue
  run: AgentRunRecord
  branchName: string
  workOrderMarkdown: string
  acceptanceCriteria: readonly string[]
  prContract: string
}): string {
  const body = redactSecretLikeText(input.issue.body ?? '').slice(0, 3000).trim()
  const criteria = input.acceptanceCriteria.length === 0
    ? 'No explicit acceptance criteria were found. Ask for clarification before broadening scope.'
    : input.acceptanceCriteria.map((criterion) => `- ${redactSecretLikeText(criterion)}`).join('\n')

  return [
    '# Bounded Implementation Prompt',
    '',
    'You are implementing a Forge GitHub issue from a bounded handoff package.',
    '',
    'Do not execute code from pull requests or comments in GitHub Actions. Do not store secrets, credentials, model transcripts, or local auth material in the durable run log.',
    '',
    '## Source Issue Summary',
    '',
    `Issue: #${input.issue.number}`,
    `Title: ${redactSecretLikeText(input.issue.title)}`,
    `URL: ${input.issue.htmlUrl}`,
    '',
    body ? 'Issue body excerpt:' : 'Issue body excerpt: n/a',
    body,
    '',
    '## Acceptance Criteria',
    '',
    criteria,
    '',
    '## Repo Constraints',
    '',
    '- Follow AGENTS.md and repository documentation standards.',
    `- Work on branch \`${input.branchName}\`.`,
    `- Open or update a pull request with \`Closes #${input.issue.number}\` unless a maintainer explicitly asks for a non-closing \`Issue: #${input.issue.number}\` link.`,
    '- Do not claim validation that was not run.',
    '- Do not commit handoff.md, prompt.md, metadata.json, credentials, transcripts, or raw prompts.',
    '',
    '## Required PR Body Contract',
    '',
    input.prContract,
    '',
    '## Work Order',
    '',
    input.workOrderMarkdown.trimEnd(),
  ].join('\n')
}

function renderMetadata(input: {
  issue: GitHubIssue
  run: AgentRunRecord
  branchName: string
  generatedAt: string
  artifacts: HandoffArtifacts
}): RuntimeHandoff & {
  artifactPaths: HandoffArtifacts
  sourceIssue: { type: 'github-issue'; number: number; url: string }
  safety: { containsSecrets: false; containsTranscripts: false }
} {
  const manifest = runtimeHandoffSchema.parse({
    runId: input.run.runId,
    issueNumber: input.issue.number,
    runtime: input.run.runtime,
    branchName: input.branchName,
    handoffPath: input.artifacts.handoffPath,
    promptPath: input.artifacts.promptPath,
    metadataPath: input.artifacts.metadataPath,
    generatedAt: input.generatedAt,
  })

  return {
    ...manifest,
    artifactPaths: input.artifacts,
    sourceIssue: {
      type: 'github-issue',
      number: input.issue.number,
      url: input.issue.htmlUrl,
    },
    safety: {
      containsSecrets: false,
      containsTranscripts: false,
    },
  }
}

async function writeHandoffPackage(input: {
  repositoryRoot: string
  artifacts: HandoffArtifacts
  handoffMarkdown: string
  promptMarkdown: string
  metadata: object
}): Promise<void> {
  await mkdir(localArtifactPath(input.repositoryRoot, relativeArtifactDirectory(input.artifacts)), { recursive: true })
  await writeFile(localArtifactPath(input.repositoryRoot, input.artifacts.handoffPath), `${input.handoffMarkdown.trimEnd()}\n`, 'utf8')
  await writeFile(localArtifactPath(input.repositoryRoot, input.artifacts.promptPath), `${input.promptMarkdown.trimEnd()}\n`, 'utf8')
  await writeFile(localArtifactPath(input.repositoryRoot, input.artifacts.metadataPath), `${JSON.stringify(input.metadata, null, 2)}\n`, 'utf8')
}

function blockedComment(input: { issueNumber: number; runId: RunId | null; reason: string }): string {
  return [
    HANDOFF_MARKER_PREFIX,
    '',
    'Agent handoff blocked.',
    '',
    `- Issue: #${input.issueNumber}`,
    `- Run ID: ${input.runId ? `\`${input.runId}\`` : 'n/a'}`,
    `- Reason: ${input.reason}`,
    '- Next step: fix the issue or run record state, then generate handoff again.',
    '- Note: no Claude Code or Codex execution has started.',
  ].join('\n')
}

function successComment(input: {
  issueNumber: number
  runId: RunId
  runtime: string
  branchName: string
  artifactName: string
  artifacts: HandoffArtifacts
  inGitHubActions: boolean
}): string {
  return [
    HANDOFF_MARKER_PREFIX,
    '',
    'Agent handoff package generated.',
    '',
    `- Issue: #${input.issueNumber}`,
    `- Run ID: \`${input.runId}\``,
    `- Runtime: \`${input.runtime}\``,
    `- Branch: \`${input.branchName}\``,
    `- Artifact: \`${input.artifactName}\`${input.inGitHubActions ? ' (uploaded by this workflow run)' : ''}`,
    `- Local paths: \`${relativeArtifactDirectory(input.artifacts)}/\``,
    '- Next step: download or open the handoff package, then run the selected runtime manually or in a controlled environment with `prompt.md`.',
    '- Note: no Claude Code or Codex execution has started.',
  ].join('\n')
}

export async function runHandoff(input: {
  client: GitHubClient
  issueNumber: number
  runLogRepositoryRoot: string
  artifactRepositoryRoot: string
  botLogin: string
  now?: Date
  persistRunLog?: boolean
  targetBranch?: string | null
  env?: NodeJS.ProcessEnv
}): Promise<HandoffResult> {
  const issue = await input.client.getIssue(input.issueNumber)
  const latestRun = await findLatestRunForIssue(input.issueNumber, { repositoryRoot: input.runLogRepositoryRoot })
  const failure = eligibilityFailure(issue, latestRun)
  const runLogOptions = {
    repositoryRoot: input.runLogRepositoryRoot,
    now: input.now,
    persistRecord: input.persistRunLog ? persistRunRecordToGit : undefined,
    targetBranch: input.targetBranch,
  }

  if (failure !== null) {
    if (latestRun !== null) {
      await recordBlockedReason({
        issueNumber: issue.number,
        runId: latestRun.runId,
        blockedReason: failure,
      }, runLogOptions)
    }
    await input.client.addLabel(issue.number, 'agent-blocked')
    const commentBody = blockedComment({ issueNumber: issue.number, runId: latestRun?.runId ?? null, reason: failure })
    await input.client.upsertComment(issue.number, {
      markerPrefix: HANDOFF_MARKER_PREFIX,
      botLogin: input.botLogin,
      body: commentBody,
    })
    return {
      status: 'blocked',
      issueNumber: issue.number,
      runId: latestRun?.runId ?? null,
      runtime: latestRun?.runtime ?? null,
      branchName: latestRun?.branchName ?? null,
      artifacts: null,
      artifactName: null,
      metadata: null,
      blockedReason: failure,
      commentBody,
    }
  }

  const run = latestRun
  if (run === null) throw new Error('Handoff eligibility passed without a run record.')
  const branchName = run.branchName ?? buildAgentBranchName({ issueNumber: issue.number, issueTitle: issue.title })
  const generatedAt = (input.now ?? new Date()).toISOString()
  const artifacts = buildHandoffArtifacts({ issueNumber: issue.number, runId: run.runId })
  const criteria = extractAcceptanceCriteria(issue.body)
  const redactedCriteria = criteria.map(redactSecretLikeText)
  const prContract = renderPrContractTemplate({
    issueNumber: issue.number,
    runtime: run.runtime,
    runId: run.runId,
    acceptanceCriteria: redactedCriteria,
  }).trim()
  const workOrder = buildDispatchWorkOrder({
    issue,
    branchName,
    runId: run.runId,
    runtime: run.runtime,
    acceptanceCriteria: redactedCriteria,
  })
  const workOrderMarkdown = renderWorkOrder(workOrder)
  const metadata = renderMetadata({ issue, run, branchName, generatedAt, artifacts })
  const handoffMarkdown = renderHandoffMarkdown({ issue, run, branchName, artifacts, prContract })
  const promptMarkdown = renderPromptMarkdown({ issue, run, branchName, workOrderMarkdown, acceptanceCriteria: redactedCriteria, prContract })

  await writeHandoffPackage({
    repositoryRoot: input.artifactRepositoryRoot,
    artifacts,
    handoffMarkdown,
    promptMarkdown,
    metadata,
  })

  await updateRunStatus({
    issueNumber: issue.number,
    runId: run.runId,
    status: 'handed-off',
    branchName,
    blockedReason: null,
    handoffArtifacts: artifacts,
    message: 'Generated handoff artifacts and kept the run handed off.',
  }, runLogOptions)
  await appendRunEvent({
    issueNumber: issue.number,
    runId: run.runId,
    status: 'handed-off',
    message: 'Handoff package generated. No runtime execution was started.',
  }, runLogOptions)
  await input.client.removeLabel(issue.number, 'agent-blocked')

  const artifactName = artifactNameFor(issue.number, run.runId, input.env)
  const commentBody = successComment({
    issueNumber: issue.number,
    runId: run.runId,
    runtime: run.runtime,
    branchName,
    artifactName,
    artifacts,
    inGitHubActions: input.env?.GITHUB_ACTIONS === 'true',
  })
  await input.client.upsertComment(issue.number, {
    markerPrefix: HANDOFF_MARKER_PREFIX,
    botLogin: input.botLogin,
    body: commentBody,
  })

  return {
    status: 'generated',
    issueNumber: issue.number,
    runId: run.runId,
    runtime: run.runtime,
    branchName,
    artifacts,
    artifactName,
    metadata,
    blockedReason: null,
    commentBody,
  }
}

export async function runHandoffForEvent(input: {
  client: GitHubClient
  event: HandoffGitHubEvent
  env: NodeJS.ProcessEnv
  runLogRepositoryRoot: string
  artifactRepositoryRoot: string
  botLogin: string
  persistRunLog?: boolean
  targetBranch?: string | null
  now?: Date
}): Promise<HandoffResult> {
  if (input.event.issue?.pull_request !== undefined) {
    return ignoredResult('Skipping agent handoff for a pull request event.')
  }

  return await runHandoff({
    client: input.client,
    issueNumber: issueNumberFromEventOrEnv(input.event, input.env),
    runLogRepositoryRoot: input.runLogRepositoryRoot,
    artifactRepositoryRoot: input.artifactRepositoryRoot,
    botLogin: input.botLogin,
    now: input.now,
    persistRunLog: input.persistRunLog,
    targetBranch: input.targetBranch,
    env: input.env,
  })
}

async function writeOutputs(env: NodeJS.ProcessEnv, result: HandoffResult): Promise<void> {
  if (!env.GITHUB_OUTPUT || result.artifacts === null || result.artifactName === null) return
  const lines = [
    `artifact_name=${result.artifactName}`,
    `artifact_directory=${relativeArtifactDirectory(result.artifacts)}`,
    `handoff_path=${result.artifacts.handoffPath}`,
    `prompt_path=${result.artifacts.promptPath}`,
    `metadata_path=${result.artifacts.metadataPath}`,
  ]
  await appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8')
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const event = await readOptionalEvent(env)
  const client = RestGitHubClient.fromEnv(env)
  const trustedRoot = await resolveRepositoryRoot(env.GITHUB_WORKSPACE)
  const targetBranch = env.FORGE_AGENT_RUN_LOG_BRANCH?.trim() || undefined

  const result = await withRunLogBranchWorktree({
    repositoryRoot: trustedRoot,
    targetBranch,
    requireExistingBranch: true,
  }, async (runLogRepositoryRoot) => await runHandoffForEvent({
    client,
    event,
    env,
    runLogRepositoryRoot,
    artifactRepositoryRoot: trustedRoot,
    botLogin: botLoginFromEnv(env),
    persistRunLog: env.FORGE_AGENT_RUN_LOG_GIT_COMMIT === '1',
    targetBranch,
  }))

  await writeOutputs(env, result)
  console.info(JSON.stringify(result, null, 2))
}

runMain(import.meta.url, () => main())
