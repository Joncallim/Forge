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
  htmlUrl: string
  authorLogin: string
  isPullRequest: boolean
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

type FakeGitHubClientSeed = {
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

export class FakeGitHubClient implements GitHubClient {
  private readonly issues = new Map<number, MutableGitHubIssue>()
  private readonly commentsByIssue = new Map<number, MutableGitHubComment[]>()
  private readonly pullRequests = new Map<number, MutableGitHubPullRequest>()
  private readonly collaboratorPermissions = new Map<string, GitHubCollaboratorPermission>()
  private nextCommentId: number

  constructor(seed: FakeGitHubClientSeed = {}) {
    for (const issue of seed.issues ?? []) this.issues.set(issue.number, cloneIssue(issue))
    for (const [issueNumber, comments] of Object.entries(seed.commentsByIssue ?? {})) {
      this.commentsByIssue.set(Number(issueNumber), comments.map(cloneComment))
    }
    for (const pullRequest of seed.pullRequests ?? []) this.pullRequests.set(pullRequest.number, clonePullRequest(pullRequest))
    for (const [login, permission] of Object.entries(seed.collaboratorPermissions ?? {})) {
      this.collaboratorPermissions.set(login.trim().toLowerCase(), permission)
    }
    this.nextCommentId = seed.nextCommentId ?? 1
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const issue = this.issues.get(issueNumber)
    if (!issue) throw new GitHubApiError(`Issue #${issueNumber} not found.`, 404, `/issues/${issueNumber}`)
    return cloneIssue(issue)
  }

  async listComments(issueNumber: number): Promise<GitHubComment[]> {
    return (this.commentsByIssue.get(issueNumber) ?? []).map(cloneComment)
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    const issue = this.mustGetIssue(issueNumber)
    if (!issue.labels.includes(label)) issue.labels.push(label)
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const issue = this.mustGetIssue(issueNumber)
    const nextLabels = issue.labels.filter((existing) => existing !== label)
    issue.labels.splice(0, issue.labels.length, ...nextLabels)
  }

  async upsertComment(
    issueNumber: number,
    input: { markerPrefix: string; botLogin: string; body: string },
  ): Promise<GitHubComment> {
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

  private mustGetIssue(issueNumber: number): MutableGitHubIssue {
    const issue = this.issues.get(issueNumber)
    if (!issue) throw new GitHubApiError(`Issue #${issueNumber} not found.`, 404, `/issues/${issueNumber}`)
    return issue
  }
}
