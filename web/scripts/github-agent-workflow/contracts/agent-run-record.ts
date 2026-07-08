import { z } from 'zod'
import { agentBranchNameSchema } from './branch-name'
import {
  agentActionSchema,
  agentRuntimeSchema,
  freezeSchema,
  handoffArtifactsSchema,
  isoTimestampSchema,
  issueTypeSchema,
  nonEmptyTrimmedStringSchema,
  positiveIntSchema,
  runIdSchema,
  runStatusSchema,
  sourceRefSchema,
} from './common'

export const runValidationSummarySchema = freezeSchema(z.object({
  issueType: issueTypeSchema,
  valid: z.boolean(),
  missingSections: z.array(nonEmptyTrimmedStringSchema),
}).strict())

export const agentRunEventSchema = freezeSchema(z.object({
  at: isoTimestampSchema,
  status: runStatusSchema,
  message: nonEmptyTrimmedStringSchema,
}).strict())

export const agentRunRecordSchema = freezeSchema(z.object({
  runId: runIdSchema,
  issueNumber: positiveIntSchema,
  issueTitle: nonEmptyTrimmedStringSchema,
  runtime: agentRuntimeSchema,
  action: agentActionSchema,
  requestedBy: nonEmptyTrimmedStringSchema,
  status: runStatusSchema,
  branchName: agentBranchNameSchema.nullable(),
  blockedReason: nonEmptyTrimmedStringSchema.nullable(),
  handoffArtifacts: handoffArtifactsSchema.nullable(),
  checkpointIssueRef: positiveIntSchema.default(32),
  source: sourceRefSchema,
  prNumber: positiveIntSchema.nullable(),
  validationSummary: runValidationSummarySchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  events: z.array(agentRunEventSchema),
}).strict())

export type RunValidationSummary = z.infer<typeof runValidationSummarySchema>
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>
export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>
