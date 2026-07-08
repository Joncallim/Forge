import { positiveIntSchema } from '../contracts/common'
import {
  WORK_ORDER_SECTION_MAX_LENGTH,
  WORK_ORDER_SECTION_TITLES,
  WORK_ORDER_TITLE,
  workOrderSchema,
  type WorkOrder,
  type WorkOrderSectionTitle,
} from '../contracts/work-order'

export type WorkOrderInput = {
  issueNumber: number
  issueTitle: string
  branchName: string
  sections?: Partial<Record<WorkOrderSectionTitle, string>>
}

// Every canonical section is always present. #144 fills the ones it can derive
// from the issue and leaves the rest as this explicit placeholder rather than
// dropping sections, so the prompt shape stays stable.
const SECTION_PLACEHOLDER = '_To be filled by the dispatcher (#144) from the source issue._'
const TRUNCATION_MARKER = ' […]'

function boundSectionBody(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n').trim()
  if (normalized === '') return SECTION_PLACEHOLDER
  if (normalized.length <= WORK_ORDER_SECTION_MAX_LENGTH) return normalized
  return `${normalized.slice(0, WORK_ORDER_SECTION_MAX_LENGTH - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`
}

// Pure builder for the bounded work-order prompt. It assembles the canonical
// section list from caller-supplied content; it does NOT dispatch, write the run
// log, or touch GitHub. That control flow belongs to #144.
export function buildWorkOrder(input: WorkOrderInput): WorkOrder {
  const issueNumber = positiveIntSchema.parse(input.issueNumber)
  const provided = input.sections ?? {}
  const sections = WORK_ORDER_SECTION_TITLES.map((title) => ({
    title,
    body: boundSectionBody(provided[title] ?? ''),
  }))

  return workOrderSchema.parse({
    title: WORK_ORDER_TITLE,
    issueNumber,
    issueTitle: input.issueTitle.trim(),
    branchName: input.branchName,
    sections,
  })
}

export function renderWorkOrder(workOrder: WorkOrder): string {
  const lines = [
    `# ${workOrder.title}`,
    '',
    `Issue: #${workOrder.issueNumber} — ${workOrder.issueTitle}`,
    `Branch: \`${workOrder.branchName}\``,
    '',
  ]
  for (const section of workOrder.sections) {
    lines.push(`## ${section.title}`, '', section.body, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
