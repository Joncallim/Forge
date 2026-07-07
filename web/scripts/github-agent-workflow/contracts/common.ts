import { z } from 'zod'

export function freezeSchema<T extends z.ZodTypeAny>(schema: T): T {
  // Zod mutates internal cache fields during parsing, so the shared contract
  // surface must stay stable without freezing the schema instance itself.
  return schema
}

export const nonEmptyTrimmedStringSchema = freezeSchema(z.string().trim().min(1))
export const positiveIntSchema = freezeSchema(z.number().int().positive())
export const isoTimestampSchema = freezeSchema(z.string().datetime({ offset: true }))
export const shortShaSchema = freezeSchema(z.string().regex(/^[0-9a-f]{7,12}$/))
export const GITHUB_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/

export const GITHUB_AGENT_WORKFLOW_LABEL_NAMES = Object.freeze([
  'needs-triage',
  'ready-for-agent',
  'needs-clarification',
  'agent-requested',
  'agent-running',
  'agent-blocked',
  'agent-pr-opened',
] as const)

export const githubAgentWorkflowLabelNameSchema = freezeSchema(z.enum(GITHUB_AGENT_WORKFLOW_LABEL_NAMES))
export type GitHubAgentWorkflowLabelName = z.infer<typeof githubAgentWorkflowLabelNameSchema>

export const ISSUE_TYPE_VALUES = Object.freeze(['feature', 'bug', 'other', 'epic', 'unknown'] as const)
export const issueTypeSchema = freezeSchema(z.enum(ISSUE_TYPE_VALUES))
export type IssueType = z.infer<typeof issueTypeSchema>

export const AGENT_RUNTIME_VALUES = Object.freeze(['dry-run', 'claude-code', 'codex'] as const)
export const agentRuntimeSchema = freezeSchema(z.enum(AGENT_RUNTIME_VALUES))
export type AgentRuntime = z.infer<typeof agentRuntimeSchema>

export const AGENT_ACTION_VALUES = Object.freeze(['implement', 'review', 'checkpoint', 'handoff'] as const)
export const agentActionSchema = freezeSchema(z.enum(AGENT_ACTION_VALUES))
export type AgentAction = z.infer<typeof agentActionSchema>

export const AGENT_COMMAND_NAME_VALUES = Object.freeze([
  'claude implement',
  'codex implement',
  'review',
  'checkpoint',
  'handoff',
  'unknown',
] as const)
export const agentCommandNameSchema = freezeSchema(z.enum(AGENT_COMMAND_NAME_VALUES))
export type AgentCommandName = z.infer<typeof agentCommandNameSchema>

export const AGENT_REQUEST_SOURCE_VALUES = Object.freeze(['issue_comment', 'workflow_dispatch', 'manual'] as const)
export const agentRequestSourceSchema = freezeSchema(z.enum(AGENT_REQUEST_SOURCE_VALUES))
export type AgentRequestSource = z.infer<typeof agentRequestSourceSchema>

export const PR_CRITERION_STATUS_VALUES = Object.freeze(['claimed', 'missing', 'needs-review'] as const)
export const prCriterionStatusSchema = freezeSchema(z.enum(PR_CRITERION_STATUS_VALUES))
export type PrCriterionStatus = z.infer<typeof prCriterionStatusSchema>

// The durable run log (#146) is the single source of truth for workflow state.
// Every remaining feature (#144/#145/#152/#153) maps its own language onto these
// values instead of inventing a parallel status enum.
//
//   requested   command router accepted a request and wrote a run record.
//   handed-off  dispatcher produced a bounded work order / handoff package,
//               but no agent runtime has started (this is #144's `accepted`).
//   running     a real runtime adapter has started work.
//   blocked     the workflow refused to proceed (records a blockedReason).
//   pr-opened   a pull request was linked to the run.
//   completed   the work is done.
//   failed      the workflow failed.
//   cancelled   the workflow was explicitly stopped.
export const RUN_STATUS_VALUES = Object.freeze([
  'requested',
  'handed-off',
  'running',
  'blocked',
  'pr-opened',
  'completed',
  'failed',
  'cancelled',
] as const)
export const runStatusSchema = freezeSchema(z.enum(RUN_STATUS_VALUES))
export type RunStatus = z.infer<typeof runStatusSchema>

// #144's issue text describes the dispatch state machine with an `accepted`
// state where the run-log contract uses `handed-off`. Rather than adding a
// duplicate status, dispatch code maps its vocabulary onto RUN_STATUS_VALUES
// through this table so the run log stays the one status model.
export const DISPATCH_STATE_VALUES = Object.freeze([
  'requested',
  'accepted',
  'running',
  'blocked',
  'pr-opened',
  'completed',
  'failed',
] as const)
export const dispatchStateSchema = freezeSchema(z.enum(DISPATCH_STATE_VALUES))
export type DispatchState = z.infer<typeof dispatchStateSchema>

export const DISPATCH_STATE_TO_RUN_STATUS: Readonly<Record<DispatchState, RunStatus>> = Object.freeze({
  requested: 'requested',
  accepted: 'handed-off',
  running: 'running',
  blocked: 'blocked',
  'pr-opened': 'pr-opened',
  completed: 'completed',
  failed: 'failed',
})

export const RUN_ID_PATTERN = /^issue-\d+-(?:[1-9]\d{9,}-[1-9]\d*|local-[0-9a-f]{7,12})$/
export const runIdSchema = freezeSchema(
  z.string().regex(RUN_ID_PATTERN, 'Run ID must match issue-<n>-<github-run-id>-<attempt> or issue-<n>-local-<shortsha>.'),
)
export type RunId = z.infer<typeof runIdSchema>

export const sourceRefSchema = freezeSchema(z.object({
  type: agentRequestSourceSchema,
  commentId: positiveIntSchema.nullable(),
}).strict())
export type SourceRef = z.infer<typeof sourceRefSchema>

export const handoffArtifactsSchema = freezeSchema(z.object({
  handoffPath: nonEmptyTrimmedStringSchema,
  promptPath: nonEmptyTrimmedStringSchema,
  metadataPath: nonEmptyTrimmedStringSchema,
}).strict())
export type HandoffArtifacts = z.infer<typeof handoffArtifactsSchema>

export function buildRunId(input: {
  issueNumber: number
  githubRunId?: number | string | null
  githubRunAttempt?: number | string | null
  shortSha?: string | null
}): RunId {
  const issueNumber = positiveIntSchema.parse(input.issueNumber)
  const githubRunId = input.githubRunId === null || input.githubRunId === undefined ? null : String(input.githubRunId).trim()
  const githubRunAttempt = input.githubRunAttempt === null || input.githubRunAttempt === undefined
    ? null
    : String(input.githubRunAttempt).trim()

  if (githubRunId && githubRunAttempt) {
    return runIdSchema.parse(`issue-${issueNumber}-${githubRunId}-${githubRunAttempt}`)
  }

  const shortSha = shortShaSchema.parse(input.shortSha ?? '')
  return runIdSchema.parse(`issue-${issueNumber}-local-${shortSha}`)
}
