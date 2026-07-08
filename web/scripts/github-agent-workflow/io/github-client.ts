import { GITHUB_REPO_PATTERN, nonEmptyTrimmedStringSchema, positiveIntSchema } from '../contracts/common'

const GITHUB_TIMEOUT_MS = 8000
const DEFAULT_GITHUB_API_URL = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
const LIST_COMMENTS_PAGE_SIZE = 100

export type GitHubIssue = Readonly<{
  number: number
  title: string
  body: string | null
  labels: string[]
  state: string
  htmlUrl: string
  authorLogin: string
  isPullRequest: boolean
}>

export type GitHubComment = Readonly<{
  id: number
  body: string
  authorLogin: string
  authorType: string | null
  htmlUrl: string
}>

export type GitHubPullRequest = Readonly<{
  number: number
  title: string
  body: string | null
  state: string
  draft: boolean
  htmlUrl: string
  headRefName: string
  baseRefName: string
}>

export type GitHubCollaboratorPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'

export interface GitHubClient {
  getIssue(issueNumber: number): Promise<GitHubIssue>
  listComments(issueNumber: number): Promise<GitHubComment[]>
  addLabel(issueNumber: number, label: string): Promise<void>
  removeLabel(issueNumber: number, label: string): Promise<void>
  upsertComment(issueNumber: number, input: { markerPrefix: string; botLogin: string; body: string }): Promise<GitHubComment>
  getPullRequest(pullRequestNumber: number): Promise<GitHubPullRequest>
  getCollaboratorPermission(username: string): Promise<GitHubCollaboratorPermission>
}

type RestGitHubClientOptions = {
  token: string
  repo: string
  apiUrl?: string
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

function normalizeRepo(repo: string): string {
  const trimmed = repo.trim()
  if (!GITHUB_REPO_PATTERN.test(trimmed)) throw new Error(`Invalid GitHub repository reference: ${repo}`)
  return trimmed
}

function normalizeApiUrl(apiUrl: string | undefined): string {
  const resolved = (apiUrl ?? DEFAULT_GITHUB_API_URL).trim()
  if (resolved === '') throw new Error('GitHub API URL is required.')
  return resolved.replace(/\/+$/, '')
}

function normalizeIssueNumber(issueNumber: number): number {
  return positiveIntSchema.parse(issueNumber)
}

function normalizeCommentSearch(input: { markerPrefix: string; botLogin: string; body: string }): {
  markerPrefix: string
  botLogin: string
  body: string
} {
  const markerPrefix = nonEmptyTrimmedStringSchema.parse(input.markerPrefix)
  const botLogin = nonEmptyTrimmedStringSchema.parse(input.botLogin).toLowerCase()
  const body = input.body
  if (!body.startsWith(markerPrefix)) {
    throw new Error('Upsert comment body must begin with the supplied marker prefix.')
  }
  return { markerPrefix, botLogin, body }
}

function githubHeaders(token: string, initHeaders?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'forge',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    ...(initHeaders ?? {}),
  }
}

function mapIssue(raw: Record<string, unknown>): GitHubIssue {
  return {
    number: typeof raw.number === 'number' ? raw.number : 0,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : null,
    labels: Array.isArray(raw.labels)
      ? raw.labels
          .map((label) => {
            if (typeof label === 'string') return label
            if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') {
              return (label as { name: string }).name
            }
            return ''
          })
          .filter((label) => label !== '')
      : [],
    state: typeof raw.state === 'string' ? raw.state : '',
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
    authorLogin: raw.user && typeof raw.user === 'object' && typeof (raw.user as { login?: unknown }).login === 'string'
      ? (raw.user as { login: string }).login
      : '',
    isPullRequest: raw.pull_request !== undefined,
  }
}

function mapComment(raw: Record<string, unknown>): GitHubComment {
  return {
    id: typeof raw.id === 'number' ? raw.id : 0,
    body: typeof raw.body === 'string' ? raw.body : '',
    authorLogin: raw.user && typeof raw.user === 'object' && typeof (raw.user as { login?: unknown }).login === 'string'
      ? (raw.user as { login: string }).login
      : '',
    authorType: raw.user && typeof raw.user === 'object' && typeof (raw.user as { type?: unknown }).type === 'string'
      ? (raw.user as { type: string }).type
      : null,
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
  }
}

function mapPullRequest(raw: Record<string, unknown>): GitHubPullRequest {
  const head = raw.head && typeof raw.head === 'object' ? raw.head as { ref?: unknown } : null
  const base = raw.base && typeof raw.base === 'object' ? raw.base as { ref?: unknown } : null

  return {
    number: typeof raw.number === 'number' ? raw.number : 0,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : null,
    state: typeof raw.state === 'string' ? raw.state : '',
    draft: raw.draft === true,
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
    headRefName: typeof head?.ref === 'string' ? head.ref : '',
    baseRefName: typeof base?.ref === 'string' ? base.ref : '',
  }
}

export class RestGitHubClient implements GitHubClient {
  readonly token: string
  readonly repo: string
  readonly apiUrl: string

  constructor(options: RestGitHubClientOptions) {
    this.token = nonEmptyTrimmedStringSchema.parse(options.token)
    this.repo = normalizeRepo(options.repo)
    this.apiUrl = normalizeApiUrl(options.apiUrl)
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RestGitHubClient {
    return new RestGitHubClient({
      token: env.GITHUB_TOKEN ?? '',
      repo: env.GITHUB_REPOSITORY ?? '',
      apiUrl: env.GITHUB_API_URL,
    })
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const response = await this.request(`/repos/${this.repo}/issues/${normalizeIssueNumber(issueNumber)}`)
    return mapIssue(await this.readJson<Record<string, unknown>>(response))
  }

  async listComments(issueNumber: number): Promise<GitHubComment[]> {
    const comments: GitHubComment[] = []
    for (let page = 1; ; page += 1) {
      const pageComments = await this.listCommentsPage(issueNumber, page)
      comments.push(...pageComments)
      if (pageComments.length < LIST_COMMENTS_PAGE_SIZE) break
    }
    return comments
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    await this.request(`/repos/${this.repo}/issues/${normalizeIssueNumber(issueNumber)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: [nonEmptyTrimmedStringSchema.parse(label)] }),
    })
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const response = await this.request(
      `/repos/${this.repo}/issues/${normalizeIssueNumber(issueNumber)}/labels/${encodeURIComponent(nonEmptyTrimmedStringSchema.parse(label))}`,
      { method: 'DELETE', allow404: true },
    )
    if (response.status !== 404) await this.maybeDrainBody(response)
  }

  async upsertComment(
    issueNumber: number,
    input: { markerPrefix: string; botLogin: string; body: string },
  ): Promise<GitHubComment> {
    const normalized = normalizeCommentSearch(input)
    const existing = await this.findCommentByMarker(issueNumber, normalized)

    if (existing) {
      const response = await this.request(`/repos/${this.repo}/issues/comments/${existing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: normalized.body }),
      })
      return mapComment(await this.readJson<Record<string, unknown>>(response))
    }

    const response = await this.request(`/repos/${this.repo}/issues/${normalizeIssueNumber(issueNumber)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: normalized.body }),
    })
    return mapComment(await this.readJson<Record<string, unknown>>(response))
  }

  async getPullRequest(pullRequestNumber: number): Promise<GitHubPullRequest> {
    const response = await this.request(`/repos/${this.repo}/pulls/${normalizeIssueNumber(pullRequestNumber)}`)
    return mapPullRequest(await this.readJson<Record<string, unknown>>(response))
  }

  async getCollaboratorPermission(username: string): Promise<GitHubCollaboratorPermission> {
    const response = await this.request(
      `/repos/${this.repo}/collaborators/${encodeURIComponent(nonEmptyTrimmedStringSchema.parse(username))}/permission`,
      { allow404: true },
    )

    if (response.status === 404) return 'none'

    const body = await this.readJson<{ permission?: unknown }>(response)
    switch (body.permission) {
      case 'admin':
      case 'maintain':
      case 'write':
      case 'triage':
      case 'read':
        return body.permission
      default:
        throw new Error(`Unexpected collaborator permission response for ${username}.`)
    }
  }

  private async listCommentsPage(issueNumber: number, page: number): Promise<GitHubComment[]> {
    const response = await this.request(
      `/repos/${this.repo}/issues/${normalizeIssueNumber(issueNumber)}/comments?per_page=${LIST_COMMENTS_PAGE_SIZE}&page=${page}`,
    )
    const body = await this.readJson<Array<Record<string, unknown>>>(response)
    return body.map(mapComment)
  }

  private async findCommentByMarker(
    issueNumber: number,
    normalized: { markerPrefix: string; botLogin: string; body: string },
  ): Promise<GitHubComment | null> {
    for (let page = 1; ; page += 1) {
      const pageComments = await this.listCommentsPage(issueNumber, page)
      const existing = pageComments.find((comment) => (
        comment.authorLogin.trim().toLowerCase() === normalized.botLogin &&
        comment.body.startsWith(normalized.markerPrefix)
      ))
      if (existing) return existing
      if (pageComments.length < LIST_COMMENTS_PAGE_SIZE) return null
    }
  }

  private async request(
    path: string,
    init: (RequestInit & { allow404?: boolean }) | undefined = undefined,
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS)

    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: githubHeaders(this.token, init?.headers),
      })

      if (!response.ok && !(init?.allow404 && response.status === 404)) {
        throw new GitHubApiError(`GitHub API returned ${response.status} for ${path}.`, response.status, path)
      }

      return response
    } finally {
      clearTimeout(timer)
    }
  }

  private async readJson<T>(response: Response): Promise<T> {
    return await response.json() as T
  }

  private async maybeDrainBody(response: Response): Promise<void> {
    if (response.status === 204) return
    await response.text()
  }
}
