import { z } from 'zod'
import {
  agentActionSchema,
  agentCommandNameSchema,
  agentRuntimeSchema,
  freezeSchema,
  nonEmptyTrimmedStringSchema,
  positiveIntSchema,
} from './common'

export const agentCommandSchema = freezeSchema(z.object({
  issueNumber: positiveIntSchema,
  commentId: positiveIntSchema,
  rawText: z.string(),
  normalizedText: z.string(),
  command: agentCommandNameSchema,
  runtime: agentRuntimeSchema.nullable(),
  action: agentActionSchema.nullable(),
  requestedBy: nonEmptyTrimmedStringSchema,
  recognized: z.boolean(),
  accepted: z.boolean(),
  rejectionReason: nonEmptyTrimmedStringSchema.nullable(),
}).strict())

export type AgentCommand = z.infer<typeof agentCommandSchema>
