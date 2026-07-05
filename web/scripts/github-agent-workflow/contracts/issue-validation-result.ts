import { z } from 'zod'
import {
  freezeSchema,
  githubAgentWorkflowLabelNameSchema,
  issueTypeSchema,
  nonEmptyTrimmedStringSchema,
  positiveIntSchema,
} from './common'

export const issueValidationResultSchema = freezeSchema(z.object({
  issueNumber: positiveIntSchema,
  issueTitle: nonEmptyTrimmedStringSchema,
  issueType: issueTypeSchema,
  valid: z.boolean(),
  missingSections: z.array(nonEmptyTrimmedStringSchema),
  detectedSections: z.array(nonEmptyTrimmedStringSchema),
  recommendedLabels: z.array(githubAgentWorkflowLabelNameSchema),
  markerPrefix: nonEmptyTrimmedStringSchema,
  commentBody: z.string().min(1).nullable(),
}).strict())

export type IssueValidationResult = z.infer<typeof issueValidationResultSchema>
