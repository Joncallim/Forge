import {
  ISSUE_LINK_KEYWORDS,
  PR_CONTRACT_SECTION_TITLES,
  type IssueLinkKeyword,
} from '../contracts/pr-contract-sections'
import { sourceIssueReferenceSchema, type SourceIssueReference } from '../contracts/source-issue-reference'

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

export { PR_CONTRACT_SECTION_TITLES }
