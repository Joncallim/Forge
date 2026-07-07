import { ACCEPTANCE_CRITERIA_SECTION_KEY } from '../contracts/pr-contract-sections'
import { parseSections } from './sections'

// Checklist items: `- [ ] text`, `- [x] text`, or `* [X] text`.
const CHECKLIST_ITEM_PATTERN = /^\s*[-*]\s*\[[ xX]\]\s+(.*\S)\s*$/
// Plain bullet fallback for issues that list criteria without checkboxes.
const BULLET_ITEM_PATTERN = /^\s*[-*]\s+(.*\S)\s*$/

// Shared acceptance-criteria extractor. #144 uses it to fill the work-order
// `Acceptance Criteria` section; #145 uses it to build the PR contract report.
// Reuses the heading-depth-agnostic section parser so criteria that sit under a
// nested sub-heading are still captured.
export function extractAcceptanceCriteria(issueBody: string | null): string[] {
  const sections = parseSections(issueBody ?? '')
  const body = sections[ACCEPTANCE_CRITERIA_SECTION_KEY]
  if (!body) return []

  const lines = body.split('\n')
  const checklist: string[] = []
  const bullets: string[] = []
  for (const line of lines) {
    const checklistMatch = CHECKLIST_ITEM_PATTERN.exec(line)
    if (checklistMatch) {
      checklist.push(checklistMatch[1].trim())
      continue
    }
    const bulletMatch = BULLET_ITEM_PATTERN.exec(line)
    if (bulletMatch) bullets.push(bulletMatch[1].trim())
  }

  // Prefer explicit checklist items; fall back to plain bullets only when the
  // section uses no checkboxes at all.
  return checklist.length > 0 ? checklist : bullets
}
