import { z } from 'zod'
import {
  agentActionSchema,
  agentRuntimeSchema,
  freezeSchema,
  isoTimestampSchema,
  nonEmptyTrimmedStringSchema,
  positiveIntSchema,
  runIdSchema,
  sourceRefSchema,
} from './common'

export const dispatchRequestSchema = freezeSchema(z.object({
  runId: runIdSchema,
  issueNumber: positiveIntSchema,
  issueTitle: nonEmptyTrimmedStringSchema,
  runtime: agentRuntimeSchema,
  action: agentActionSchema,
  requestedBy: nonEmptyTrimmedStringSchema,
  branchName: nonEmptyTrimmedStringSchema,
  dryRun: z.boolean(),
  source: sourceRefSchema,
  requestedAt: isoTimestampSchema,
}).strict())

export type DispatchRequest = z.infer<typeof dispatchRequestSchema>
