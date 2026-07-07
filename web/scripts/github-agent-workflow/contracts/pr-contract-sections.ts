// Shared section vocabulary for the agent PR body contract (#152) and the PR
// acceptance-criteria checker (#145). #152 renders these sections into the agent
// PR template/handoff prompt; #145 parses the same section titles. Keeping the
// constants here stops the template and the parser from drifting apart.

// The issue section that carries the acceptance-criteria checklist. Matches the
// normalized heading produced by core/sections.ts (lowercased, single-spaced).
export const ACCEPTANCE_CRITERIA_SECTION_KEY = 'acceptance criteria'

export const PR_CONTRACT_SECTION_TITLES = Object.freeze([
  'Source Issue',
  'Agent Run',
  'Summary',
  'Acceptance Criteria Validation',
  'Tests / Verification',
  'Risks / Follow-up',
] as const)
export type PrContractSectionTitle = (typeof PR_CONTRACT_SECTION_TITLES)[number]

// GitHub's closing keywords plus FORGE's explicit `Issue: #123` form. A PR must
// link its source issue with one of these so #145 can find the originating
// acceptance criteria. Kept lowercase; matching is case-insensitive.
export const ISSUE_LINK_KEYWORDS = Object.freeze([
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
  'issue',
] as const)
export type IssueLinkKeyword = (typeof ISSUE_LINK_KEYWORDS)[number]
