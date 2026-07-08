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

export const prContractLinkedIssueStatusSchema = freezeSchema(z.enum(['found', 'missing', 'not-found']))

export const prContractReportSchema = freezeSchema(z.object({
  pullRequestNumber: positiveIntSchema,
  pullRequestTitle: nonEmptyTrimmedStringSchema,
  draft: z.boolean(),
  linkedIssueStatus: prContractLinkedIssueStatusSchema,
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
export type PrContractLinkedIssueStatus = z.infer<typeof prContractLinkedIssueStatusSchema>
export type PRContractReport = z.infer<typeof prContractReportSchema>
