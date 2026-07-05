import { z } from 'zod'
import {
  freezeSchema,
  isoTimestampSchema,
  nonEmptyTrimmedStringSchema,
  positiveIntSchema,
  prCriterionStatusSchema,
} from './common'

export const prContractCriterionSchema = freezeSchema(z.object({
  text: nonEmptyTrimmedStringSchema,
  status: prCriterionStatusSchema,
  evidence: nonEmptyTrimmedStringSchema.nullable(),
}).strict())

export const prContractReportSchema = freezeSchema(z.object({
  pullRequestNumber: positiveIntSchema,
  pullRequestTitle: nonEmptyTrimmedStringSchema,
  linkedIssueNumber: positiveIntSchema.nullable(),
  linkedIssueTitle: nonEmptyTrimmedStringSchema.nullable(),
  criteria: z.array(prContractCriterionSchema),
  summary: z.object({
    claimed: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
  }).strict(),
  commentBody: nonEmptyTrimmedStringSchema,
  generatedAt: isoTimestampSchema,
}).strict())

export type PrContractCriterion = z.infer<typeof prContractCriterionSchema>
export type PRContractReport = z.infer<typeof prContractReportSchema>
