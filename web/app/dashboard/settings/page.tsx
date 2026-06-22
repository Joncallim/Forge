'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GitHubStatus = {
  connected: boolean
  source: 'cli' | 'pat' | 'env' | 'none'
  cliAuthenticated: boolean
  patStored: boolean
  login: string | null
}

const PAT_CREATE_URL = 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Forge'

// ---------------------------------------------------------------------------
// GitHub connection card
// ---------------------------------------------------------------------------

function GitHubCard() {
  const [status, setStatus] = useState<GitHubStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch('/api/github/status')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to load GitHub status')
      }
      setStatus((await res.json()) as GitHubStatus)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) {
      setActionError('Paste a Personal Access Token first.')
      return
    }
    setSubmitting(true)
    setActionError(null)
    try {
      const res = await fetch('/api/github/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: trimmed }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to connect')
      }
      setToken('')
      await loadStatus()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true)
    setActionError(null)
    try {
      const res = await fetch('/api/github/token', { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to disconnect')
      }
      await loadStatus()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <section aria-labelledby="github-heading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="github-heading" className="text-lg font-semibold text-foreground">
          GitHub
        </h2>
        {status && (
          <span
            className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium ${
              status.connected
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
            }`}
          >
            {status.connected ? 'Connected' : 'Not connected'}
          </span>
        )}
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          Checking GitHub connection…
        </p>
      )}

      {!loading && fetchError !== null && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {fetchError}
          <button onClick={loadStatus} className="ml-2 underline underline-offset-2 hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {!loading && status && (
        <div className="flex flex-col gap-4">
          {/* Connected via CLI — no PAT needed */}
          {status.cliAuthenticated && (
            <p className="text-sm text-muted-foreground">
              Connected through the <span className="font-medium text-foreground">GitHub CLI</span>{' '}
              (<code className="font-mono text-xs">gh</code> is already authenticated), so no token is
              needed here. Forge uses the CLI token for repository operations.
            </p>
          )}

          {/* Connected via stored PAT */}
          {!status.cliAuthenticated && status.patStored && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Connected with a Personal Access Token
                {status.login ? <> for <span className="font-medium text-foreground">{status.login}</span></> : null}.
              </p>
              {actionError !== null && (
                <p role="alert" className="text-sm text-destructive">{actionError}</p>
              )}
              <div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  aria-busy={disconnecting}
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </div>
            </div>
          )}

          {/* Not connected — prompt for a PAT (only when the CLI is not authenticated) */}
          {!status.cliAuthenticated && !status.patStored && (
            <form onSubmit={handleConnect} className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                The GitHub CLI is not authenticated, so connect with a Personal Access Token.
                It is stored encrypted — you never paste it into <code className="font-mono text-xs">.env</code>.
              </p>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="gh-pat" className="text-sm font-medium text-foreground">
                  Personal Access Token
                </label>
                <input
                  id="gh-pat"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_…"
                  className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <p className="text-xs text-muted-foreground">
                  <a
                    href={PAT_CREATE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Create a token with repo + workflow scope →
                  </a>
                </p>
              </div>
              {actionError !== null && (
                <p role="alert" className="text-sm text-destructive">{actionError}</p>
              )}
              <div>
                <Button type="submit" size="sm" disabled={submitting} aria-busy={submitting}>
                  {submitting ? 'Connecting…' : 'Connect GitHub'}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect external services Forge uses.
        </p>
      </div>

      <div className="max-w-2xl">
        <GitHubCard />
      </div>
    </div>
  )
}
