import { z } from 'zod'
import { freezeSchema, positiveIntSchema, nonEmptyTrimmedStringSchema } from './common'
import { executionModeSchema } from './issue-control-metadata'

/**
 * Stable readiness reason codes following SPEC-0007 queue.* namespace.
 */
export const READINESS_REASON_CODES = Object.freeze([
  'queue.issue_template_invalid',
  'queue.issue_control_missing',
  'queue.issue_control_duplicate',
  'queue.issue_execution_mode_invalid',
  'queue.issue_tracking_only',
  'queue.issue_closed',
  'queue.issue_dependency_syntax_invalid',
  'queue.issue_dependency_self',
  'queue.issue_dependency_duplicate',
  'queue.issue_dependency_is_pull_request',
  'queue.issue_dependency_tracking',
  'queue.issue_dependency_not_found',
  'queue.issue_dependency_open',
  'queue.issue_dependency_terminal_unsatisfied',
  'queue.issue_dependency_state_unknown',
  'queue.issue_dependency_inaccessible',
  'queue.issue_dependency_lookup_failed',
  'queue.issue_dependency_cycle',
  'queue.issue_dependency_graph_limit_exceeded',
  'queue.issue_body_too_large',
  'queue.issue_projection_update_failed',
] as const)

export const readinessReasonCodeSchema = freezeSchema(z.enum(READINESS_REASON_CODES))
export type ReadinessReasonCode = z.infer<typeof readinessReasonCodeSchema>

/**
 * A single blocker record with stable reason code and optional detail.
 */
export const blockerRecordSchema = freezeSchema(z.object({
  reasonCode: readinessReasonCodeSchema,
  detail: nonEmptyTrimmedStringSchema,
  dependencyIssueNumber: positiveIntSchema.nullable(),
}).strict())

export type BlockerRecord = z.infer<typeof blockerRecordSchema>

/**
 * Readiness label values that are mutually exclusive projections.
 */
export const READINESS_LABEL_VALUES = Object.freeze([
  'ready-for-agent',
  'needs-clarification',
  'dependency-blocked',
  'tracking-only',
] as const)

export const readinessLabelSchema = freezeSchema(z.enum(READINESS_LABEL_VALUES))
export type ReadinessLabel = z.infer<typeof readinessLabelSchema>

/**
 * Canonical semantic readiness state for an issue.
 */
export const SEMANTIC_READINESS_STATE_VALUES = Object.freeze([
  'ready',
  'needs-clarification',
  'dependency-blocked',
  'tracking-only',
  'closed',
] as const)

export const semanticReadinessStateSchema = freezeSchema(z.enum(SEMANTIC_READINESS_STATE_VALUES))
export type SemanticReadinessState = z.infer<typeof semanticReadinessStateSchema>

/**
 * Mapping from semantic state to the required readiness projection label.
 */
export const STATE_TO_LABEL: Readonly<Record<SemanticReadinessState, ReadinessLabel | null>> = Object.freeze({
  ready: 'ready-for-agent',
  'needs-clarification': 'needs-clarification',
  'dependency-blocked': 'dependency-blocked',
  'tracking-only': 'tracking-only',
  closed: null,
})

/**
 * The canonical readiness result contract.
 *
 * One shared result type used by intake projection, agent-command admission,
 * dispatch admission, handoff admission, and pre-runtime readiness check.
 */
export const issueReadinessResultSchema = freezeSchema(z.object({
  issueNumber: positiveIntSchema,
  state: semanticReadinessStateSchema,
  dispatchable: z.boolean(),
  executionMode: executionModeSchema.nullable(),
  dependencies: z.array(positiveIntSchema),
  reasonCodes: z.array(readinessReasonCodeSchema),
  blockers: z.array(blockerRecordSchema),
  desiredReadinessLabels: z.array(readinessLabelSchema),
  /**
   * Whether the readiness result could not be fully computed (e.g. API error,
   * graph limit exceeded). A partial result still fails closed.
   */
  partial: z.boolean(),
}).strict())

export type IssueReadinessResult = z.infer<typeof issueReadinessResultSchema>
