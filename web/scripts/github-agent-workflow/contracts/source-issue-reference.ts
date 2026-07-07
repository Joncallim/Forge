import { z } from 'zod'
import { freezeSchema, nonEmptyTrimmedStringSchema, positiveIntSchema } from './common'
import { ISSUE_LINK_KEYWORDS } from './pr-contract-sections'

// The originating issue a pull request links back to. #145 extracts this from a
// PR body; #152's template guarantees it is present. Shared here so both sides
// agree on the shape rather than each re-deriving `{ issue, keyword }`.
export const issueLinkKeywordSchema = freezeSchema(z.enum(ISSUE_LINK_KEYWORDS))

export const sourceIssueReferenceSchema = freezeSchema(z.object({
  issueNumber: positiveIntSchema,
  keyword: issueLinkKeywordSchema,
  raw: nonEmptyTrimmedStringSchema,
}).strict())

export type SourceIssueReference = z.infer<typeof sourceIssueReferenceSchema>
