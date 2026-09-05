import { agentCommandSchema, type AgentCommand } from '../contracts/agent-command'
import { buildRunId, type AgentAction, type AgentRuntime, type RunId } from '../contracts/common'
import type { GitHubClient, GitHubIssue } from '../io/github-client'
import { IssueReadinessResolver } from '../shared/issue-readiness-resolver'
import { findLatestRunForIssue } from '../io/agent-run-log'

export const AGENT_COMMAND_MARKER_PREFIX = '<!-- forge-agent-command -->'

type ParsedCommandShape = {
  command: AgentCommand['command']
  runtime: AgentRuntime | null
  action: AgentAction | null
}

type AgentCommandComment = Readonly<{
  id: number
  body: string
  authorLogin: string
}>

export type AgentCommandRunRecordInput = Readonly<{
  runId: RunId
  issueNumber: number
  issueTitle: string
  runtime: AgentRuntime
  action: AgentAction
  requestedBy: string
  source: {
    type: 'issue_comment'
    commentId: number
  }
}>

export interface AgentCommandRunRecorder {
  recordRequested(input: AgentCommandRunRecordInput): Promise<void>
}

export type AgentCommandResult = Readonly<{
  command: AgentCommand
  ignored: false
  commentBody: string | null
  runId: RunId | null
}> | Readonly<{
  command: AgentCommand
  ignored: true
  reason: string
  commentBody: null
  runId: null
}>

const RECOGNIZED_COMMANDS: Record<string, ParsedCommandShape> = Object.freeze({
  'claude implement': {
    command: 'claude implement',
    runtime: 'claude-code',
    action: 'implement',
  },
  'codex implement': {
    command: 'codex implement',
    runtime: 'codex',
    action: 'implement',
  },
  review: {
    command: 'review',
    runtime: null,
    action: 'review',
  },
  checkpoint: {
    command: 'checkpoint',
    runtime: null,
    action: 'checkpoint',
  },
  handoff: {
    command: 'handoff',
    runtime: null,
    action: 'handoff',
  },
})

const WRITE_LEVEL_PERMISSIONS = new Set(['admin', 'maintain', 'write'])
const PLAUSIBLE_COMMAND_PREFIXES = ['claude', 'codex', 'review', 'checkpoint', 'handoff']

function firstNonEmptyLine(text: string): { rawLine: string; normalizedText: string } {
  const rawLine = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
  return {
    rawLine,
    normalizedText: rawLine.trim(),
  }
}

function normalizedMentionAliases(login: string): Set<string> {
  const normalized = login.trim().toLowerCase()
  const aliases = new Set<string>()
  if (normalized !== '') aliases.add(normalized)
  const withoutBotSuffix = normalized.replace(/\[bot\]$/, '')
  if (withoutBotSuffix !== '') aliases.add(withoutBotSuffix)
  return aliases
}

function stripRouterMention(text: string, botLogin: string | undefined): string {
  if (!botLogin) return text
  const mention = text.match(/^@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[[A-Za-z]+\])?)\s+/)
  if (!mention) return text
  return normalizedMentionAliases(botLogin).has(mention[1].toLowerCase())
    ? text.slice(mention[0].length)
    : text
}

function commandLookupText(normalizedText: string, botLogin?: string): string {
  return stripRouterMention(normalizedText, botLogin)
    .replace(/^\//, '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]$/, '')
    .trim()
}


function isPlausibleCommandAttempt(commandText: string, recognized: boolean): boolean {
  if (recognized) return true
  const firstToken = commandText.split(/\s+/)[0] ?? ''
  return PLAUSIBLE_COMMAND_PREFIXES.includes(firstToken)
}

function isImplementationRequest(command: AgentCommand): boolean {
  return command.action === 'implement' && command.runtime !== null
}

function intendedAgent(command: AgentCommand): string {
  switch (command.runtime) {
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    default:
      return 'Forge'
  }
}

async function rejectionFor(command: AgentCommand, issue: GitHubIssue, client: GitHubClient, runLogRepositoryRoot?: string): Promise<string | null> {
  if (!command.recognized) {
    return 'Unknown request phrase. Put one supported command on the first non-empty line: `claude implement`, `codex implement`, `review`, `checkpoint`, or `handoff`. A leading `/` or `@bot` mention is allowed.'
  }

  if (!isImplementationRequest(command)) {
    return `The \`${command.command}\` command is recognized, but #143 only records implementation requests. This command will be wired by a later workflow issue.`
  }

  // Permission check first (before expensive semantic traversal)
  let permission: Awaited<ReturnType<GitHubClient['getCollaboratorPermission']>>
  try {
    permission = await client.getCollaboratorPermission(command.requestedBy)
  } catch {
    return 'Implementation requests require repository write access, but Forge could not verify this commenter\'s repository permission. Ask a maintainer to check the workflow token permissions or request agent work.'
  }

  if (!WRITE_LEVEL_PERMISSIONS.has(permission)) {
    return 'Implementation requests require repository write access. Ask a maintainer with write, maintain, or admin permission to request agent work.'
  }

  // Check durable run-log state first (authority, not labels)
  const latestRun = await findLatestRunForIssue(issue.number, { repositoryRoot: runLogRepositoryRoot })
  if (latestRun) {
    const activeStatuses = ['requested', 'handed-off', 'running', 'pr-opened']
    if (activeStatuses.includes(latestRun.status)) {
      return `An agent run is already ${latestRun.status} for this issue (run ID: ${latestRun.runId}). A new request cannot be created until that run completes, fails, or is cancelled.`
    }
  }

  // Use shared readiness resolver for semantic authority
  const resolver = new IssueReadinessResolver(client)
  let readiness
  try {
    readiness = await resolver.resolveFromIssue(issue)
  } catch {
    return 'Could not verify issue readiness due to an internal error. Please try again or contact a maintainer.'
  }

  if (!readiness.dispatchable) {
    const reasons = readiness.reasonCodes.join(', ')
    const blockers = readiness.blockers.map((b: { detail: string }) => b.detail).join('; ')
    return `Implementation request rejected because the issue is not semantically dispatchable. Reasons: ${reasons}${blockers ? `. Blockers: ${blockers}` : ''}`
  }

  return null
}

function acceptedComment(command: AgentCommand, issue: GitHubIssue, runId: RunId): string {
  return [
    AGENT_COMMAND_MARKER_PREFIX,
    '',
    'Agent request accepted.',
    '',
    `- Request: \`${command.command}\``,
    `- Issue: #${issue.number}`,
    `- Intended agent: ${intendedAgent(command)}`,
    `- Run record: \`${runId}\` through the #146 run-log boundary`,
    '- Next step: a maintainer should run the `Agent Dispatch` workflow manually with this issue number.',
    '- Note: no Claude Code or Codex execution was started by this router.',
  ].join('\n')
}

function rejectedComment(command: AgentCommand): string {
  return [
    AGENT_COMMAND_MARKER_PREFIX,
    '',
    'Agent request not accepted.',
    '',
    `- Request: \`${command.normalizedText || '(empty comment)'}\``,
    `- Reason: ${command.rejectionReason ?? 'Request was rejected.'}`,
    '- Next step: comment with an exact supported command when the issue is ready.',
  ].join('\n')
}

export function parseAgentCommand(input: {
  issueNumber: number
  commentId: number
  commentBody: string
  requestedBy: string
  botLogin?: string
}): AgentCommand {
  const { rawLine, normalizedText } = firstNonEmptyLine(input.commentBody)
  const lookupText = commandLookupText(normalizedText, input.botLogin)
  const recognized = RECOGNIZED_COMMANDS[lookupText] ?? null

  return agentCommandSchema.parse({
    issueNumber: input.issueNumber,
    commentId: input.commentId,
    rawText: rawLine,
    normalizedText,
    command: recognized?.command ?? 'unknown',
    runtime: recognized?.runtime ?? null,
    action: recognized?.action ?? null,
    requestedBy: input.requestedBy,
    recognized: recognized !== null,
    accepted: false,
    rejectionReason: null,
  })
}

export async function runAgentCommand(input: {
  client: GitHubClient
  issue: GitHubIssue
  comment: AgentCommandComment
  botLogin: string
  recorder?: AgentCommandRunRecorder
  githubRunId?: number | string | null
  githubRunAttempt?: number | string | null
  shortSha?: string | null
  runLogRepositoryRoot?: string
}): Promise<AgentCommandResult> {
  const parsed = parseAgentCommand({
    issueNumber: input.issue.number,
    commentId: input.comment.id,
    commentBody: input.comment.body,
    requestedBy: input.comment.authorLogin,
    botLogin: input.botLogin,
  })
  const lookupText = commandLookupText(parsed.normalizedText, input.botLogin)
  if (!isPlausibleCommandAttempt(lookupText, parsed.recognized)) {
    return {
      command: parsed,
      ignored: true,
      reason: 'Skipping issue comment because it is not addressed to the agent command router.',
      commentBody: null,
      runId: null,
    }
  }

  const rejectionReason = await rejectionFor(parsed, input.issue, input.client, input.runLogRepositoryRoot)
  const runId = rejectionReason === null
    ? buildRunId({
        issueNumber: input.issue.number,
        githubRunId: input.githubRunId,
        githubRunAttempt: input.githubRunAttempt,
        shortSha: input.shortSha,
      })
    : null
  const command = agentCommandSchema.parse({
    ...parsed,
    accepted: rejectionReason === null,
    rejectionReason,
  })
  const commentBody = command.accepted && runId !== null
    ? acceptedComment(command, input.issue, runId)
    : rejectedComment(command)

  if (command.accepted && command.runtime !== null && command.action !== null && runId !== null) {
    // Create run record BEFORE adding labels (durable first)
    await input.recorder?.recordRequested({
      runId,
      issueNumber: input.issue.number,
      issueTitle: input.issue.title,
      runtime: command.runtime,
      action: command.action,
      requestedBy: command.requestedBy,
      source: {
        type: 'issue_comment',
        commentId: command.commentId,
      },
    })
    await input.client.addLabel(input.issue.number, 'agent-requested')
  }

  await input.client.upsertComment(input.issue.number, {
    markerPrefix: AGENT_COMMAND_MARKER_PREFIX,
    botLogin: input.botLogin,
    body: commentBody,
  })

  return {
    command,
    ignored: false,
    commentBody,
    runId,
  }
}
