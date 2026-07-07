import { agentBranchNameSchema, type AgentBranchName } from '../contracts/branch-name'
import { positiveIntSchema } from '../contracts/common'

// Slugs are bounded so long issue titles cannot produce unwieldy branch names.
const MAX_SLUG_LENGTH = 40
// Drop a leading issue-type marker such as `[FEATURE]` before slugifying.
const ISSUE_TYPE_PREFIX = /^\s*\[[a-z]+\]\s*/i

export function slugifyIssueTitle(title: string): string {
  return title
    .replace(ISSUE_TYPE_PREFIX, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
}

// Deterministic, git-ref-safe branch name for agent work on an issue.
// Same issue number + title always yields the same branch; an empty or
// symbol-only title degrades cleanly to `agent/issue-<number>`.
export function buildAgentBranchName(input: { issueNumber: number; issueTitle: string }): AgentBranchName {
  const issueNumber = positiveIntSchema.parse(input.issueNumber)
  const slug = slugifyIssueTitle(input.issueTitle)
  const branch = slug === '' ? `agent/issue-${issueNumber}` : `agent/issue-${issueNumber}-${slug}`
  return agentBranchNameSchema.parse(branch)
}
