import { z } from 'zod'
import { agentBranchNameSchema } from './branch-name'
import {
  agentRuntimeSchema,
  freezeSchema,
  isoTimestampSchema,
  nonEmptyTrimmedStringSchema,
  positiveIntSchema,
  runIdSchema,
} from './common'

export const runtimeHandoffSchema = freezeSchema(z.object({
  runId: runIdSchema,
  issueNumber: positiveIntSchema,
  runtime: agentRuntimeSchema,
  branchName: agentBranchNameSchema,
  handoffPath: nonEmptyTrimmedStringSchema,
  promptPath: nonEmptyTrimmedStringSchema,
  metadataPath: nonEmptyTrimmedStringSchema,
  generatedAt: isoTimestampSchema,
}).strict())

export type RuntimeHandoff = z.infer<typeof runtimeHandoffSchema>
