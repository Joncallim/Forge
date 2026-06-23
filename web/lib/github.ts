import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { db } from '@/db'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { encryptSecret, decryptSecret } from '@/lib/crypto'

const execFile = promisify(execFileCallback)

export const GITHUB_PAT_SETTING_KEY = 'github_pat'
const GITHUB_CLI_TIMEOUT_MS = 3000
const GITHUB_STATUS_CACHE_MS = 30_000

export type GitHubTokenSource = 'cli' | 'pat' | 'env' | 'none'

export interface GitHubStatus {
  /** True when Forge can obtain a GitHub token from any source. */
  connected: boolean
  /** Where the active token comes from, in priority order. */
  source: GitHubTokenSource
  /** True when the `gh` CLI is installed and authenticated. */
  cliAuthenticated: boolean
  /** True when a PAT has been stored through the web UI. */
  patStored: boolean
  /** GitHub login associated with the active token, when known. */
  login: string | null
}

let cliAuthCache: { value: boolean; expiresAt: number } | null = null

// ---------------------------------------------------------------------------
// gh CLI
// ---------------------------------------------------------------------------

/** Whether the `gh` CLI is installed and authenticated (`gh auth status`). */
export async function isCliAuthenticated(): Promise<boolean> {
  const now = Date.now()
  if (cliAuthCache && cliAuthCache.expiresAt > now) {
    return cliAuthCache.value
  }

  let value = false
  try {
    await execFile('gh', ['auth', 'status'], { timeout: GITHUB_CLI_TIMEOUT_MS })
    value = true
  } catch {
    value = false
  }

  cliAuthCache = { value, expiresAt: now + GITHUB_STATUS_CACHE_MS }
  return value
}

/** The token the `gh` CLI would use, or null when unavailable. */
export async function getCliToken(): Promise<string | null> {
  try {
    const { stdout } = await execFile('gh', ['auth', 'token'], { timeout: GITHUB_CLI_TIMEOUT_MS })
    const token = stdout.trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Stored PAT (encrypted in app_settings)
// ---------------------------------------------------------------------------

export async function getStoredPat(): Promise<string | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, GITHUB_PAT_SETTING_KEY))
    .limit(1)

  if (!row) return null
  try {
    return decryptSecret(row.value)
  } catch (err) {
    console.error('[lib/github] failed to decrypt stored GitHub PAT:', err instanceof Error ? err.message : err)
    return null
  }
}

export async function isPatStored(): Promise<boolean> {
  const [row] = await db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, GITHUB_PAT_SETTING_KEY))
    .limit(1)
  return row !== undefined
}

export async function storePat(token: string): Promise<void> {
  const value = encryptSecret(token)
  await db
    .insert(appSettings)
    .values({ key: GITHUB_PAT_SETTING_KEY, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    })
}

export async function clearStoredPat(): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, GITHUB_PAT_SETTING_KEY))
}

// ---------------------------------------------------------------------------
// PAT validation
// ---------------------------------------------------------------------------

/** Validate a PAT against the GitHub API. Returns the login on success. */
export async function validatePat(token: string): Promise<{ login: string } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch('https://api.github.com/user', {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'forge',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { login?: string }
    return typeof body.login === 'string' ? { login: body.login } : { login: 'unknown' }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Repo listing
// ---------------------------------------------------------------------------

const GITHUB_API_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'forge',
  'X-GitHub-Api-Version': '2022-11-28',
})

const LIST_REPOS_PAGE_SIZE = 100
const LIST_REPOS_MAX_TOTAL = 500
const LIST_REPOS_TIMEOUT_MS = 5000

/** Parse the `rel="next"` URL out of a GitHub `Link` response header, if present. */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  const parts = linkHeader.split(',')
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return null
}

/**
 * List the authenticated user's GitHub repos, paginating via the `Link` header
 * up to a hard cap of 500 repos. Throws on any fetch/parse error so the caller
 * can distinguish "no repos" from "the call failed".
 */
export async function listRepos(
  token: string,
): Promise<{ nameWithOwner: string; description: string | null }[]> {
  const results: { nameWithOwner: string; description: string | null }[] = []
  let url: string | null = `https://api.github.com/user/repos?per_page=${LIST_REPOS_PAGE_SIZE}&sort=updated&page=1`

  while (url && results.length < LIST_REPOS_MAX_TOTAL) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LIST_REPOS_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: GITHUB_API_HEADERS(token),
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status} while listing repos`)
    }

    const body = (await res.json()) as Array<{
      full_name?: string
      description?: string | null
    }>

    for (const repo of body) {
      if (typeof repo.full_name !== 'string') continue
      results.push({ nameWithOwner: repo.full_name, description: repo.description ?? null })
      if (results.length >= LIST_REPOS_MAX_TOTAL) break
    }

    if (body.length < LIST_REPOS_PAGE_SIZE) {
      url = null
    } else {
      url = parseNextLink(res.headers.get('Link'))
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Token resolution + status
// ---------------------------------------------------------------------------

/**
 * Resolve a GitHub token for repo operations, in priority order:
 *   1. stored PAT (entered via the web UI),
 *   2. the `gh` CLI token,
 *   3. a legacy per-project environment variable (e.g. `GITHUB_TOKEN`).
 */
export async function resolveGitHubToken(
  opts: { envVar?: string | null } = {},
): Promise<{ token: string; source: GitHubTokenSource } | null> {
  const pat = await getStoredPat()
  if (pat) return { token: pat, source: 'pat' }

  const cliToken = await getCliToken()
  if (cliToken) return { token: cliToken, source: 'cli' }

  const envVar = opts.envVar?.trim()
  if (envVar) {
    const fromEnv = process.env[envVar]
    if (fromEnv && fromEnv.trim() !== '') return { token: fromEnv, source: 'env' }
  }

  return null
}

/**
 * Report the GitHub connection status for the UI. The `gh` CLI takes precedence
 * so an already-authenticated CLI never triggers a PAT prompt; a stored PAT is
 * reported when the CLI is not authenticated.
 */
export async function getGitHubStatus(): Promise<GitHubStatus> {
  const [cliAuthenticated, patStored] = await Promise.all([isCliAuthenticated(), isPatStored()])

  if (cliAuthenticated) {
    return { connected: true, source: 'cli', cliAuthenticated, patStored, login: null }
  }
  if (patStored) {
    return {
      connected: true,
      source: 'pat',
      cliAuthenticated,
      patStored,
      login: null,
    }
  }
  return { connected: false, source: 'none', cliAuthenticated, patStored, login: null }
}
