import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { db } from '@/db'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { encryptSecret, decryptSecret } from '@/lib/crypto'

const execFile = promisify(execFileCallback)

export const GITHUB_PAT_SETTING_KEY = 'github_pat'

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

// ---------------------------------------------------------------------------
// gh CLI
// ---------------------------------------------------------------------------

/** Whether the `gh` CLI is installed and authenticated (`gh auth status`). */
export async function isCliAuthenticated(): Promise<boolean> {
  try {
    await execFile('gh', ['auth', 'status'])
    return true
  } catch {
    return false
  }
}

/** The token the `gh` CLI would use, or null when unavailable. */
export async function getCliToken(): Promise<string | null> {
  try {
    const { stdout } = await execFile('gh', ['auth', 'token'])
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
  try {
    const res = await fetch('https://api.github.com/user', {
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
  }
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
    const pat = await getStoredPat()
    const validated = pat ? await validatePat(pat) : null
    return {
      connected: true,
      source: 'pat',
      cliAuthenticated,
      patStored,
      login: validated?.login ?? null,
    }
  }
  return { connected: false, source: 'none', cliAuthenticated, patStored, login: null }
}
