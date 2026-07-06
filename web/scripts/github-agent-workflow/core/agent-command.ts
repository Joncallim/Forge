import { agentCommandSchema, type AgentCommand } from '../contracts/agent-command'
import { buildRunId, type AgentAction, type AgentRuntime, type RunId } from '../contracts/common'
import type { GitHubClient, GitHubIssue } from '../io/github-client'

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

function commandLookupText(normalizedText: string): string {
  return normalizedText
    .replace(/^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[[A-Za-z]+\])?\s+/, '')
    .replace(/^\//, '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]$/, '')
    .trim()
}

function hasLabel(issue: GitHubIssue, label: string): boolean {
  const normalized = label.trim().toLowerCase()
  return issue.labels.some((issueLabel) => issueLabel.trim().toLowerCase() === normalized)
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

async function rejectionFor(command: AgentCommand, issue: GitHubIssue, client: GitHubClient): Promise<string | null> {
  if (!command.recognized) {
    return 'Unknown request phrase. Put one supported command on the first non-empty line: `claude implement`, `codex implement`, `review`, `checkpoint`, or `handoff`. A leading `/` or `@bot` mention is allowed.'
  }

  if (!isImplementationRequest(command)) {
    return `The \`${command.command}\` command is recognized, but #143 only records implementation requests. This command will be wired by a later workflow issue.`
  }

  if (hasLabel(issue, 'agent-requested') || hasLabel(issue, 'agent-running')) {
    return 'An agent request is already pending or running for this issue, so this router did not create another run record.'
  }

  if (hasLabel(issue, 'needs-clarification')) {
    return 'Implementation requests are blocked while `needs-clarification` is present. Please clarify the issue and rerun intake validation first.'
  }

  if (!hasLabel(issue, 'ready-for-agent')) {
    return 'Implementation requests require the `ready-for-agent` label. Complete issue intake validation before asking an agent to implement.'
  }

  let permission: Awaited<ReturnType<GitHubClient['getCollaboratorPermission']>>
  try {
    permission = await client.getCollaboratorPermission(command.requestedBy)
  } catch {
    return 'Implementation requests require repository write access, but Forge could not verify this commenter\'s repository permission. Ask a maintainer to check the workflow token permissions or request agent work.'
  }

  if (!WRITE_LEVEL_PERMISSIONS.has(permission)) {
    return 'Implementation requests require repository write access. Ask a maintainer with write, maintain, or admin permission to request agent work.'
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
    '- Next step: the dispatcher can pick up this recorded request when #144 lands. No agent implementation was started by this router.',
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
}): AgentCommand {
  const { rawLine, normalizedText } = firstNonEmptyLine(input.commentBody)
  const lookupText = commandLookupText(normalizedText)
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
}): Promise<AgentCommandResult> {
  const parsed = parseAgentCommand({
    issueNumber: input.issue.number,
    commentId: input.comment.id,
    commentBody: input.comment.body,
    requestedBy: input.comment.authorLogin,
  })
  const lookupText = commandLookupText(parsed.normalizedText)
  if (!isPlausibleCommandAttempt(lookupText, parsed.recognized)) {
    return {
      command: parsed,
      ignored: true,
      reason: 'Skipping issue comment because it is not addressed to the agent command router.',
      commentBody: null,
      runId: null,
    }
  }

  const rejectionReason = await rejectionFor(parsed, input.issue, input.client)
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
    await input.client.addLabel(input.issue.number, 'agent-requested')
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
