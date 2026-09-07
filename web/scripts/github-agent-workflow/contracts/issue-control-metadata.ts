import { z } from 'zod'
import { freezeSchema, positiveIntSchema } from './common'
import type { ReadinessReasonCode } from './issue-readiness-result'

/**
 * Canonical execution modes for Forge issues.
 * Supported modes are exactly `implementation | tracking`.
 */
export const EXECUTION_MODE_VALUES = Object.freeze(['implementation', 'tracking'] as const)
export const executionModeSchema = freezeSchema(z.enum(EXECUTION_MODE_VALUES))
export type ExecutionMode = z.infer<typeof executionModeSchema>

/**
 * Parsed control metadata from an issue body.
 *
 * This represents the canonical "Execution mode: ..." and "Depends on: ..."
 * lines after parsing and validation.
 */
export const issueControlMetadataSchema = freezeSchema(z.object({
  executionMode: executionModeSchema.nullable(),
  dependencies: z.array(positiveIntSchema),
  /**
   * Whether the Depends on value was "none" (semantically empty).
   */
  dependsOnNone: z.boolean(),
  /**
   * Whether control metadata was explicitly present (vs. legacy default).
   */
  explicit: z.boolean(),
  /**
   * Whether this is a legacy [EPIC] that gets tracking defaults.
   */
  isLegacyTrackingEpic: z.boolean(),
}).strict())

export type IssueControlMetadata = z.infer<typeof issueControlMetadataSchema>

/**
 * A bounded, machine-readable parsing diagnostic.  These values are the
 * parser's semantic authority; rendered prose is deliberately kept separate.
 */
export type ControlDiagnostic = Readonly<{
  reasonCode: ReadinessReasonCode
  field: 'execution_mode' | 'depends_on' | 'body'
  dependencyIssueNumber?: number
}>

/**
 * Default empty metadata for issues without explicit control lines.
 */
export const EMPTY_CONTROL_METADATA: IssueControlMetadata = Object.freeze({
  executionMode: null,
  dependencies: [],
  dependsOnNone: true,
  explicit: false,
  isLegacyTrackingEpic: false,
})

/**
 * Maximum dependencies allowed per issue.
 */
export const MAX_DEPENDENCIES_PER_ISSUE = 64

/**
 * Maximum distinct parser diagnostics retained for one untrusted issue body.
 * Diagnostic prose follows the same bound so it cannot become an output-size
 * amplifier separate from the machine-readable contract.
 */
export const MAX_CONTROL_DIAGNOSTICS = 64

/**
 * Maximum visible body bytes we accept for parsing.
 */
export const MAX_ISSUE_BODY_BYTES = 256 * 1024 // 256 KiB
