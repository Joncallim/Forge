/**
 * Fake GitHub client for testing.
 *
 * Supports pagination, failure injection, and mutation logs so tests can
 * verify production abstraction boundaries without live API calls.
 */

import type {
  GitHubClient,
  GitHubCollaboratorPermission,
  GitHubComment,
  GitHubIssue,
  GitHubPullRequest,
} from './github-client'
import { GitHubApiError } from './github-client'

type MutableGitHubIssue = {
  number: number
  title: string
  body: string | null
  labels: string[]
  state: string
  stateReason: string | null
  htmlUrl: string
  authorLogin: string
  isPullRequest: boolean
  updatedAt: string | null
}

type MutableGitHubComment = {
  id: number
  body: string
  authorLogin: string
  authorType: string | null
  htmlUrl: string
}

type MutableGitHubPullRequest = {
  number: number
  title: string
  body: string | null
  state: string
  draft: boolean
  htmlUrl: string
  headRefName: string
  baseRefName: string
}

export type FakeGitHubClientSeed = {
  issues?: GitHubIssue[]
  commentsByIssue?: Record<number, GitHubComment[]>
  pullRequests?: GitHubPullRequest[]
  collaboratorPermissions?: Record<string, GitHubCollaboratorPermission>
  nextCommentId?: number
}

function cloneIssue(issue: MutableGitHubIssue): GitHubIssue {
  return { ...issue, labels: [...issue.labels] }
}

function cloneComment(comment: MutableGitHubComment): GitHubComment {
  return { ...comment }
}

function clonePullRequest(pullRequest: MutableGitHubPullRequest): GitHubPullRequest {
  return { ...pullRequest }
}

export type FailureInjection = {
  /**
   * If set, getIssue will throw for these issue numbers.
   * 'not_found' → 404, 'forbidden' → 403, 'rate_limited' → 429,
   * 'server_error' → 500, 'network_error' → TypeError
   */
  getIssueFailures?: Record<number, 'not_found' | 'forbidden' | 'rate_limited' | 'server_error' | 'network_error'>
  /**
   * If set, addLabel will throw for these label names.
   */
  addLabelFailures?: string[]
  /**
   * If set, removeLabel will throw for these label names.
   */
  removeLabelFailures?: string[]
}

export class FakeGitHubClient implements GitHubClient {
  private readonly issues = new Map<number, MutableGitHubIssue>()
  private readonly commentsByIssue = new Map<number, MutableGitHubComment[]>()
  private readonly pullRequests = new Map<number, MutableGitHubPullRequest>()
  private readonly collaboratorPermissions = new Map<string, GitHubCollaboratorPermission>()
  private nextCommentId: number
  private failures: FailureInjection = {}

  // Mutation counters for test verification
  addLabelCalls: Array<{ issueNumber: number; label: string }> = []
  removeLabelCalls: Array<{ issueNumber: number; label: string }> = []
  upsertCommentCalls: number = 0

  constructor(seed: FakeGitHubClientSeed = {}) {
    for (const issue of seed.issues ?? []) this.issues.set(issue.number, cloneIssue(issue as MutableGitHubIssue))
    for (const [issueNumber, comments] of Object.entries(seed.commentsByIssue ?? {})) {
      this.commentsByIssue.set(Number(issueNumber), comments.map(cloneComment))
    }
    for (const pullRequest of seed.pullRequests ?? []) this.pullRequests.set(pullRequest.number, clonePullRequest(pullRequest))
    for (const [login, permission] of Object.entries(seed.collaboratorPermissions ?? {})) {
      this.collaboratorPermissions.set(login.trim().toLowerCase(), permission)
    }
    this.nextCommentId = seed.nextCommentId ?? 1
  }

  /**
   * Inject failures for testing.
   */
  setFailures(failures: FailureInjection): void {
    this.failures = failures
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    // Check failure injection
    const failure = this.failures.getIssueFailures?.[issueNumber]
    if (failure) {
      switch (failure) {
        case 'not_found':
          throw new GitHubApiError(`Issue #${issueNumber} not found.`, 404, `/issues/${issueNumber}`)
        case 'forbidden':
          throw new GitHubApiError(`Forbidden: issue #${issueNumber}.`, 403, `/issues/${issueNumber}`)
        case 'rate_limited':
          throw new GitHubApiError(`Rate limited: issue #${issueNumber}.`, 429, `/issues/${issueNumber}`)
        case 'server_error':
          throw new GitHubApiError(`Server error: issue #${issueNumber}.`, 500, `/issues/${issueNumber}`)
        case 'network_error':
          throw new TypeError('Network error fetching issue.')
      }
    }

    const issue = this.issues.get(issueNumber)
    if (!issue) throw new GitHubApiError(`Issue #${issueNumber} not found.`, 404, `/issues/${issueNumber}`)
    return cloneIssue(issue)
  }

  async listComments(issueNumber: number): Promise<GitHubComment[]> {
    return (this.commentsByIssue.get(issueNumber) ?? []).map(cloneComment)
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    // Check failure injection
    if (this.failures.addLabelFailures?.includes(label)) {
      throw new GitHubApiError(`Failed to add label ${label}.`, 422, `/issues/${issueNumber}/labels`)
    }

    this.addLabelCalls.push({ issueNumber, label })
    const issue = this.mustGetIssue(issueNumber)
    if (!issue.labels.includes(label)) issue.labels.push(label)
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    // Check failure injection
    if (this.failures.removeLabelFailures?.includes(label)) {
      throw new GitHubApiError(`Failed to remove label ${label}.`, 422, `/issues/${issueNumber}/labels`)
    }

    this.removeLabelCalls.push({ issueNumber, label })
    const issue = this.mustGetIssue(issueNumber)
    const nextLabels = issue.labels.filter((existing) => existing !== label)
    issue.labels.splice(0, issue.labels.length, ...nextLabels)
  }

  async upsertComment(
    issueNumber: number,
    input: { markerPrefix: string; botLogin: string; body: string },
  ): Promise<GitHubComment> {
    this.upsertCommentCalls++
    this.mustGetIssue(issueNumber)
    const comments = this.commentsByIssue.get(issueNumber) ?? []
    const normalizedLogin = input.botLogin.trim().toLowerCase()
    const existing = comments.find((comment) => (
      comment.authorLogin.trim().toLowerCase() === normalizedLogin
      && comment.body.startsWith(input.markerPrefix)
    ))

    if (existing) {
      existing.body = input.body
      return cloneComment(existing)
    }

    const created: MutableGitHubComment = {
      id: this.nextCommentId++,
      body: input.body,
      authorLogin: input.botLogin,
      authorType: 'Bot',
      htmlUrl: '',
    }
    comments.push(created)
    this.commentsByIssue.set(issueNumber, comments)
    return cloneComment(created)
  }

  async getPullRequest(pullRequestNumber: number): Promise<GitHubPullRequest> {
    const pullRequest = this.pullRequests.get(pullRequestNumber)
    if (!pullRequest) throw new GitHubApiError(`Pull request #${pullRequestNumber} not found.`, 404, `/pulls/${pullRequestNumber}`)
    return clonePullRequest(pullRequest)
  }

  async getCollaboratorPermission(username: string): Promise<GitHubCollaboratorPermission> {
    return this.collaboratorPermissions.get(username.trim().toLowerCase()) ?? 'none'
  }

  async listOpenIssues(options: { page?: number; perPage?: number; maxPages?: number } = {}): Promise<{
    issues: GitHubIssue[]
    hasMore: boolean
    rawPageFullAtCap?: boolean
  }> {
    const page = options.page ?? 1
    const perPage = options.perPage ?? 100
    const maxPages = options.maxPages ?? 50
    const allIssues: GitHubIssue[] = []
    for (const issue of this.issues.values()) {
      if (issue.state === 'open' && !issue.isPullRequest) {
        allIssues.push(cloneIssue(issue))
      }
    }
    // Sort by number for deterministic ordering
    allIssues.sort((a, b) => a.number - b.number)

    // Paginate
    const start = (page - 1) * perPage
    const pageIssues = allIssues.slice(start, start + perPage)

    // A full final page at the page cap marks the scan as incomplete
    const atPageCap = page >= maxPages
    const pageFull = pageIssues.length >= perPage && start + perPage < allIssues.length

    return { issues: pageIssues, hasMore: !atPageCap && (pageFull || start + perPage < allIssues.length), rawPageFullAtCap: atPageCap && pageIssues.length >= perPage }
  }

  async listClosedIssues(options: { page?: number; perPage?: number; maxPages?: number; label?: string } = {}): Promise<{
    issues: GitHubIssue[]
    hasMore: boolean
  }> {
    const page = options.page ?? 1
    const perPage = options.perPage ?? 100

    const allIssues: GitHubIssue[] = []
    for (const issue of this.issues.values()) {
      if (issue.state === 'closed' && !issue.isPullRequest && (options.label === undefined || issue.labels.includes(options.label))) {
        allIssues.push(cloneIssue(issue))
      }
    }
    allIssues.sort((a, b) => a.number - b.number)

    const start = (page - 1) * perPage
    const pageIssues = allIssues.slice(start, start + perPage)

    const pageFull = pageIssues.length >= perPage

    return { issues: pageIssues, hasMore: pageFull || start + perPage < allIssues.length }
  }

  /**
   * Reset all mutation counters.
   */
  resetMutationCounters(): void {
    this.addLabelCalls = []
    this.removeLabelCalls = []
    this.upsertCommentCalls = 0
  }

  private mustGetIssue(issueNumber: number): MutableGitHubIssue {
    const issue = this.issues.get(issueNumber)
    if (!issue) throw new GitHubApiError(`Issue #${issueNumber} not found.`, 404, `/issues/${issueNumber}`)
    return issue
  }
}
