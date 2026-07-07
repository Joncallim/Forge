import {
  ISSUE_LINK_KEYWORDS,
  PR_CONTRACT_SECTION_TITLES,
  type PrContractSectionTitle,
  type IssueLinkKeyword,
} from '../contracts/pr-contract-sections'
import { sourceIssueReferenceSchema, type SourceIssueReference } from '../contracts/source-issue-reference'
import { normalizeSectionHeading, parseSections } from './sections'

// One regex, built from the shared keyword list, so #145 (PR checker) and #152
// (PR template) recognise exactly the same link phrases. Rebuilt per call so the
// global-flag `lastIndex` never leaks between callers.
const ISSUE_LINK_REGEX_SOURCE = `\\b(${ISSUE_LINK_KEYWORDS.join('|')})\\b\\s*:?\\s+#(\\d+)`

export function issueLinkPattern(): RegExp {
  return new RegExp(ISSUE_LINK_REGEX_SOURCE, 'gi')
}

// Extract the first source-issue reference from a PR body, e.g. `Closes #123`,
// `Fixes #45`, `Resolves #7`, or `Issue: #99`. Returns null when the PR body
// links no issue (which #145 treats as "ask the author for a linked issue").
export function extractSourceIssueReference(prBody: string | null): SourceIssueReference | null {
  if (!prBody) return null
  const match = issueLinkPattern().exec(prBody)
  if (!match) return null

  const issueNumber = Number(match[2])
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null

  return sourceIssueReferenceSchema.parse({
    issueNumber,
    keyword: match[1].toLowerCase() as IssueLinkKeyword,
    raw: match[0].trim(),
  })
}

export function extractPrContractSection(prBody: string | null, title: PrContractSectionTitle): string {
  return parseSections(prBody ?? '')[normalizeSectionHeading(title)] ?? ''
}

export function renderAcceptanceCriteriaValidation(criteria: readonly string[] = []): string {
  if (criteria.length === 0) return '- [ ] <criterion> — evidence / notes'
  return criteria.map((criterion) => `- [ ] ${criterion} — evidence / notes`).join('\n')
}

export function renderPrContractTemplate(input: {
  issueNumber?: number | null
  runtime?: string | null
  runId?: string | null
  acceptanceCriteria?: readonly string[]
} = {}): string {
  const issueReference = input.issueNumber ? `Closes #${input.issueNumber}` : 'Closes #<issue-number>'
  const runtime = input.runtime?.trim() || 'claude-code | codex | dry-run | manual'
  const runId = input.runId?.trim() || '<run-id or n/a>'
  const validation = renderAcceptanceCriteriaValidation(input.acceptanceCriteria ?? [])

  return [
    `## ${PR_CONTRACT_SECTION_TITLES[0]}`,
    '',
    issueReference,
    '',
    `## ${PR_CONTRACT_SECTION_TITLES[1]}`,
    '',
    `Runtime: ${runtime}`,
    `Run ID: ${runId}`,
    '',
    `## ${PR_CONTRACT_SECTION_TITLES[2]}`,
    '',
    `## ${PR_CONTRACT_SECTION_TITLES[3]}`,
    '',
    validation,
    '',
    `## ${PR_CONTRACT_SECTION_TITLES[4]}`,
    '',
    `## ${PR_CONTRACT_SECTION_TITLES[5]}`,
    '',
  ].join('\n')
}

export { PR_CONTRACT_SECTION_TITLES }
