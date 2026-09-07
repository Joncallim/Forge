import { GITHUB_REPO_PATTERN, nonEmptyTrimmedStringSchema, positiveIntSchema } from '../contracts/common'

const GITHUB_TIMEOUT_MS = 8000
const DEFAULT_GITHUB_API_URL = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
const LIST_COMMENTS_PAGE_SIZE = 100
const LIST_ISSUES_PAGE_SIZE = 100

export type GitHubIssue = Readonly<{
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
  /**
   * List open issues in the repository, paginated.
   * Filters out pull requests.
   */
  listOpenIssues(options?: { page?: number; perPage?: number; maxPages?: number }): Promise<{
    issues: GitHubIssue[]
    hasMore: boolean
    /** True when the unfiltered REST page filled the configured scan cap. */
    rawPageFullAtCap?: boolean
  }>
  /**
   * List closed issues in the repository, paginated.
   * Used by closed-issue cleanup lane during full reconciliation.
   */
  listClosedIssues(options?: { page?: number; perPage?: number; maxPages?: number; label?: string }): Promise<{
    issues: GitHubIssue[]
    hasMore: boolean
  }>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseError(message: string): Error {
  return new Error(`Invalid GitHub API response: ${message}`)
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw responseError(`${field} must be a positive integer.`)
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw responseError(`${field} must be a string.`)
  return value
}

function mapIssue(raw: Record<string, unknown>): GitHubIssue {
  if (!Array.isArray(raw.labels)) throw responseError('issue.labels must be an array.')
  return {
    number: requirePositiveNumber(raw.number, 'issue.number'),
    title: requireString(raw.title, 'issue.title'),
    body: typeof raw.body === 'string' ? raw.body : null,
    labels: raw.labels.map((label) => {
      if (typeof label === 'string' && label.trim() !== '') return label
      if (isRecord(label) && typeof label.name === 'string' && label.name.trim() !== '') return label.name
      throw responseError('issue.labels contains an invalid label.')
    }),
    state: requireString(raw.state, 'issue.state'),
    stateReason: typeof raw.state_reason === 'string' ? raw.state_reason : null,
    htmlUrl: requireString(raw.html_url, 'issue.html_url'),
    authorLogin: raw.user && typeof raw.user === 'object' && typeof (raw.user as { login?: unknown }).login === 'string'
      ? (raw.user as { login: string }).login
      : '',
    isPullRequest: raw.pull_request !== undefined,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  }
}

function mapComment(raw: Record<string, unknown>): GitHubComment {
  return {
    id: requirePositiveNumber(raw.id, 'comment.id'),
    body: requireString(raw.body, 'comment.body'),
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
    number: requirePositiveNumber(raw.number, 'pull_request.number'),
    title: requireString(raw.title, 'pull_request.title'),
    body: typeof raw.body === 'string' ? raw.body : null,
    state: requireString(raw.state, 'pull_request.state'),
    draft: raw.draft === true,
    htmlUrl: requireString(raw.html_url, 'pull_request.html_url'),
    headRefName: head && typeof head.ref === 'string' ? head.ref : '',
    baseRefName: base && typeof base.ref === 'string' ? base.ref : '',
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
    return mapIssue(await this.readObject(response, 'issue'))
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
      return mapComment(await this.readObject(response, 'comment'))
    }

    const response = await this.request(`/repos/${this.repo}/issues/${normalizeIssueNumber(issueNumber)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: normalized.body }),
    })
    return mapComment(await this.readObject(response, 'comment'))
  }

  async getPullRequest(pullRequestNumber: number): Promise<GitHubPullRequest> {
    const response = await this.request(`/repos/${this.repo}/pulls/${normalizeIssueNumber(pullRequestNumber)}`)
    return mapPullRequest(await this.readObject(response, 'pull request'))
  }

  async getCollaboratorPermission(username: string): Promise<GitHubCollaboratorPermission> {
    const response = await this.request(
      `/repos/${this.repo}/collaborators/${encodeURIComponent(nonEmptyTrimmedStringSchema.parse(username))}/permission`,
      { allow404: true },
    )

    if (response.status === 404) return 'none'

    const body = await this.readObject(response, 'collaborator permission')
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

  async listOpenIssues(options: { page?: number; perPage?: number; maxPages?: number } = {}): Promise<{
    issues: GitHubIssue[]
    hasMore: boolean
    rawPageFullAtCap?: boolean
  }> {
    const page = options.page ?? 1
    const perPage = options.perPage ?? LIST_ISSUES_PAGE_SIZE
    const maxPages = options.maxPages ?? 50 // Max 5000 issues

    if (page > maxPages) {
      return { issues: [], hasMore: false }
    }

    const response = await this.request(
      `/repos/${this.repo}/issues?state=open&per_page=${perPage}&page=${page}&filter=all`,
    )
    const raw = await this.readArray(response, 'issues')
    const issues = raw.filter((item) => item.pull_request === undefined).map(mapIssue)

    // A full final page at the page cap must mark the scan incomplete
    const atPageCap = page >= maxPages
    const pageFull = raw.length >= perPage
    return { issues, hasMore: !atPageCap && pageFull, rawPageFullAtCap: atPageCap && pageFull }
  }

  async listClosedIssues(options: { page?: number; perPage?: number; maxPages?: number; label?: string } = {}): Promise<{
    issues: GitHubIssue[]
    hasMore: boolean
  }> {
    const page = options.page ?? 1
    const perPage = options.perPage ?? LIST_ISSUES_PAGE_SIZE
    const maxPages = options.maxPages ?? 50

    if (page > maxPages) {
      return { issues: [], hasMore: false }
    }

    const label = options.label === undefined ? null : nonEmptyTrimmedStringSchema.parse(options.label)
    const labelQuery = label === null ? '' : `&labels=${encodeURIComponent(label)}`
    const response = await this.request(`/repos/${this.repo}/issues?state=closed&per_page=${perPage}&page=${page}&filter=all${labelQuery}`)
    const raw = await this.readArray(response, 'issues')
    const issues = raw.filter((item) => item.pull_request === undefined).map(mapIssue)

    const pageFull = raw.length >= perPage
    // Unlike open scans, closed reconciliation has no resolver-side cap
    // detector. Preserve this incompleteness signal for its caller.
    return { issues, hasMore: pageFull }
  }

  private async listCommentsPage(issueNumber: number, page: number): Promise<GitHubComment[]> {
    const response = await this.request(
      `/repos/${this.repo}/issues/${normalizeIssueNumber(issueNumber)}/comments?per_page=${LIST_COMMENTS_PAGE_SIZE}&page=${page}`,
    )
    const body = await this.readArray(response, 'comments')
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

  private async readObject(response: Response, name: string): Promise<Record<string, unknown>> {
    const json = await this.readJson(response)
    if (!isRecord(json)) throw responseError(`${name} must be an object.`)
    return json
  }

  private async readArray(response: Response, name: string): Promise<Array<Record<string, unknown>>> {
    const json = await this.readJson(response)
    if (!Array.isArray(json) || !json.every(isRecord)) throw responseError(`${name} must be an array of objects.`)
    return json
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw responseError('response body is not valid JSON.')
    }
  }

  private async maybeDrainBody(response: Response): Promise<void> {
    if (response.status === 204) return
    await response.text()
  }
}
