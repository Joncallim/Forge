// ---------------------------------------------------------------------------
// Project-scoped GitHub helpers (issue #109)
//
// Roadmap discovery + issue list/create for a project's configured
// `owner/repo`. Uses the same auth header + timeout conventions as
// lib/github.ts. Every function throws on transport/HTTP failure so callers can
// distinguish "no data" from "the call failed".
// ---------------------------------------------------------------------------

const GITHUB_API_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'forge',
  'X-GitHub-Api-Version': '2022-11-28',
})

const GITHUB_TIMEOUT_MS = 8000

/** `owner/repo` — owner and repo use GitHub's allowed name characters. */
export const GITHUB_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/

export function isValidGitHubRepo(repo: string | null | undefined): repo is string {
  return typeof repo === 'string' && GITHUB_REPO_PATTERN.test(repo.trim())
}

async function githubFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...GITHUB_API_HEADERS(token), ...(init?.headers ?? {}) },
    })
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Roadmap discovery
// ---------------------------------------------------------------------------

export type RoadmapFormat = 'markdown' | 'json'

export type ProjectRoadmap = {
  path: string
  format: RoadmapFormat
  content: string
}

/** Discovery order per issue #109: prefer docs/ over root, Markdown over JSON. */
export const ROADMAP_FILE_CANDIDATES: ReadonlyArray<{ path: string; format: RoadmapFormat }> = [
  { path: 'docs/roadmap.md', format: 'markdown' },
  { path: 'ROADMAP.md', format: 'markdown' },
  { path: 'docs/roadmap.json', format: 'json' },
  { path: 'roadmap.json', format: 'json' },
]

/**
 * Return the highest-priority roadmap file that exists in the repo, or null if
 * none of the candidates exist. Throws only on non-404 transport/HTTP errors so
 * a missing file is not conflated with a failed lookup.
 */
export async function fetchProjectRoadmap(token: string, repo: string): Promise<ProjectRoadmap | null> {
  if (!isValidGitHubRepo(repo)) throw new Error('Invalid GitHub repository reference')

  for (const candidate of ROADMAP_FILE_CANDIDATES) {
    const url = `https://api.github.com/repos/${repo}/contents/${candidate.path}`
    const res = await githubFetch(url, token)
    if (res.status === 404) continue
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status} while reading ${candidate.path}`)
    }
    const body = (await res.json()) as { content?: string; encoding?: string }
    if (body.encoding !== 'base64' || typeof body.content !== 'string') continue
    const content = Buffer.from(body.content, 'base64').toString('utf8')
    return { path: candidate.path, format: candidate.format, content }
  }
  return null
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export type ProjectIssueLabel = { name: string; color: string | null }

export type ProjectIssue = {
  number: number
  title: string
  state: string
  labels: ProjectIssueLabel[]
  updatedAt: string
  htmlUrl: string
  body: string | null
}

const LIST_ISSUES_PAGE_SIZE = 30

export class GitHubRepoUnavailableError extends Error {
  readonly status: number

  constructor(repo: string, status: number) {
    super(`GitHub repository "${repo}" is not available (HTTP ${status}).`)
    this.name = 'GitHubRepoUnavailableError'
    this.status = status
  }
}

/**
 * List issues for `repo`, newest-updated first, excluding pull requests (the
 * REST issues endpoint returns PRs too; they carry a `pull_request` field).
 */
export async function listProjectIssues(
  token: string,
  repo: string,
  options: { state?: 'open' | 'closed' | 'all' } = {},
): Promise<ProjectIssue[]> {
  if (!isValidGitHubRepo(repo)) throw new Error('Invalid GitHub repository reference')

  const state = options.state ?? 'open'
  const url = `https://api.github.com/repos/${repo}/issues?state=${state}&per_page=${LIST_ISSUES_PAGE_SIZE}&sort=updated&direction=desc`
  const res = await githubFetch(url, token)
  if (res.status === 404) {
    throw new GitHubRepoUnavailableError(repo, res.status)
  }
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} while listing issues`)
  }

  const body = (await res.json()) as Array<Record<string, unknown>>
  return body
    .filter((raw) => raw.pull_request === undefined && typeof raw.number === 'number')
    .map((raw) => ({
      number: raw.number as number,
      title: typeof raw.title === 'string' ? raw.title : '',
      state: typeof raw.state === 'string' ? raw.state : 'open',
      labels: Array.isArray(raw.labels)
        ? (raw.labels as Array<Record<string, unknown>>)
            .map((label) => ({
              name: typeof label.name === 'string' ? label.name : '',
              color: typeof label.color === 'string' ? label.color : null,
            }))
            .filter((label) => label.name !== '')
        : [],
      updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
      htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
      body: typeof raw.body === 'string' ? raw.body : null,
    }))
}

/** Create a new GitHub issue and return its normalized shape. */
export async function createProjectIssue(
  token: string,
  repo: string,
  input: { title: string; body?: string },
): Promise<ProjectIssue> {
  if (!isValidGitHubRepo(repo)) throw new Error('Invalid GitHub repository reference')
  const title = input.title.trim()
  if (title === '') throw new Error('Issue title is required')

  const res = await githubFetch(`https://api.github.com/repos/${repo}/issues`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body: input.body?.trim() || undefined }),
  })
  if (res.status === 404) {
    throw new GitHubRepoUnavailableError(repo, res.status)
  }
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} while creating an issue`)
  }

  const raw = (await res.json()) as Record<string, unknown>
  return {
    number: typeof raw.number === 'number' ? raw.number : 0,
    title: typeof raw.title === 'string' ? raw.title : title,
    state: typeof raw.state === 'string' ? raw.state : 'open',
    labels: [],
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
    body: typeof raw.body === 'string' ? raw.body : (input.body ?? null),
  }
}
