import { z } from 'zod'
import { freezeSchema, nonEmptyTrimmedStringSchema, positiveIntSchema } from './common'

// The bounded implementation prompt #144 generates from a ready issue. The
// section titles and order are frozen here so #144 (dispatch) and #153 (handoff)
// emit the same prompt shape and #147 can document one stable structure.
export const WORK_ORDER_TITLE = 'FORGE Agent Work Order'

export const WORK_ORDER_SECTION_TITLES = Object.freeze([
  'Source Issue',
  'Objective',
  'Acceptance Criteria',
  'Required Constraints',
  'Relevant Repo Rules',
  'Expected Output',
  'Stop Conditions',
] as const)
export type WorkOrderSectionTitle = (typeof WORK_ORDER_SECTION_TITLES)[number]

// Work orders are handoff prompts, not transcripts. Each section is bounded so a
// dispatcher cannot smuggle an unbounded issue body or generated content into the
// run log or handoff artifacts.
export const WORK_ORDER_SECTION_MAX_LENGTH = 2000

export const workOrderSectionSchema = freezeSchema(z.object({
  title: z.enum(WORK_ORDER_SECTION_TITLES),
  body: z.string().max(WORK_ORDER_SECTION_MAX_LENGTH),
}).strict())

export const workOrderSchema = freezeSchema(z.object({
  title: z.literal(WORK_ORDER_TITLE),
  issueNumber: positiveIntSchema,
  issueTitle: nonEmptyTrimmedStringSchema,
  branchName: nonEmptyTrimmedStringSchema,
  sections: z.array(workOrderSectionSchema).length(WORK_ORDER_SECTION_TITLES.length),
}).strict())

export type WorkOrderSection = z.infer<typeof workOrderSectionSchema>
export type WorkOrder = z.infer<typeof workOrderSchema>
