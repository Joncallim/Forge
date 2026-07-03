'use client'

import { useState, useEffect, useCallback } from 'react'
import { InfoIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTheme, THEME_MODES, THEME_ACCENTS } from '@/hooks/useTheme'

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

type WorkspacePathKey =
  | 'workspaceRoot'
  | 'configRoot'
  | 'projectsRoot'
  | 'mcpsRoot'
  | 'templatesRoot'
  | 'promptsRoot'
  | 'agentPromptsRoot'
  | 'workforcesRoot'
  | 'runtimeRoot'
  | 'logsRoot'
  | 'backupsRoot'
  | 'forgeEnvPath'
  | 'globalSettingsPath'

type WorkspaceSettings = {
  workspaceRoot: string
  configRoot: string
  projectsRoot: string
  mcpsRoot: string
  templatesRoot: string
  promptsRoot: string
  agentPromptsRoot: string
  workforcesRoot: string
  runtimeRoot: string
  logsRoot: string
  backupsRoot: string
  forgeEnvPath: string
  globalSettingsPath: string
  source: 'env' | 'setting' | 'default'
  envLocked: boolean
  displayPaths?: Partial<Record<WorkspacePathKey, string>>
}

const PAT_CREATE_URL = 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Forge'
const DERIVED_WORKSPACE_PATH_KEYS: Array<[WorkspacePathKey, string]> = [
  ['projectsRoot', 'Projects'],
  ['mcpsRoot', 'MCP tools'],
  ['templatesRoot', 'Templates'],
  ['agentPromptsRoot', 'Agent prompts'],
  ['workforcesRoot', 'Workforces'],
  ['runtimeRoot', 'Runtime'],
  ['forgeEnvPath', 'Environment'],
  ['globalSettingsPath', 'Global settings'],
]

function workspaceDisplayPath(workspace: WorkspaceSettings, key: WorkspacePathKey): string {
  return workspace.displayPaths?.[key] ?? workspace[key]
}

// ---------------------------------------------------------------------------
// Workspace card
// ---------------------------------------------------------------------------

function WorkspaceCard() {
  const [workspace, setWorkspace] = useState<WorkspaceSettings | null>(null)
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  const loadWorkspace = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch('/api/settings/workspace')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to load workspace settings')
      }
      const body = (await res.json()) as { workspace: WorkspaceSettings }
      setWorkspace(body.workspace)
      setWorkspaceRoot(workspaceDisplayPath(body.workspace, 'workspaceRoot'))
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadWorkspace()
  }, [loadWorkspace])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setActionError(null)
    setSavedMsg(null)
    try {
      const res = await fetch('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot, mcpsRoot: workspace?.mcpsRoot }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to save workspace settings')
      }
      const body = (await res.json()) as { workspace: WorkspaceSettings }
      setWorkspace(body.workspace)
      setWorkspaceRoot(workspaceDisplayPath(body.workspace, 'workspaceRoot'))
      setSavedMsg('Workspace saved.')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="workspace-heading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="workspace-heading" className="text-lg font-semibold text-foreground">
          Workspace
        </h2>
        {workspace && (
          <span className="inline-flex h-6 items-center rounded-full bg-gray-100 px-2.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            {workspace.source === 'env' ? 'Environment' : workspace.source === 'setting' ? 'Custom' : 'Default'}
          </span>
        )}
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          Loading workspace…
        </p>
      )}

      {!loading && fetchError !== null && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {fetchError}
          <button onClick={loadWorkspace} className="ml-2 underline underline-offset-2 hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {!loading && workspace && (
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="workspace-root" className="text-sm font-medium text-foreground">
              Workspace folder
            </label>
            <input
              id="workspace-root"
              type="text"
              value={workspaceRoot}
              onChange={(e) => setWorkspaceRoot(e.target.value)}
              disabled={workspace.envLocked || saving}
              autoComplete="off"
              className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              aria-label="Derived workspace paths"
              title={DERIVED_WORKSPACE_PATH_KEYS
                .map(([key, label]) => `${label}: ${workspaceDisplayPath(workspace, key)}`)
                .join('\n')}
            >
              <InfoIcon className="size-3.5" aria-hidden="true" />
            </span>
            <span>Projects, MCP tools, templates, prompts, workforces, runtime files, and settings are stored under the workspace folder.</span>
          </div>

          {workspace.envLocked && (
            <p className="text-xs text-muted-foreground">
              Workspace location is locked by <code className="font-mono">FORGE_WORKSPACE_ROOT</code>.
            </p>
          )}

          {actionError !== null && (
            <p role="alert" className="text-sm text-destructive">{actionError}</p>
          )}
          {savedMsg !== null && (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{savedMsg}</p>
          )}

          <div>
            <Button type="submit" size="sm" disabled={saving || workspace.envLocked} aria-busy={saving}>
              {saving ? 'Saving…' : 'Save workspace'}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// MCP card
// ---------------------------------------------------------------------------

function McpSettingsCard() {
  const [workspace, setWorkspace] = useState<WorkspaceSettings | null>(null)
  const [mcpsRoot, setMcpsRoot] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  const loadWorkspace = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch('/api/settings/workspace')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to load MCP settings')
      }
      const body = (await res.json()) as { workspace: WorkspaceSettings }
      setWorkspace(body.workspace)
      setMcpsRoot(workspaceDisplayPath(body.workspace, 'mcpsRoot'))
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadWorkspace()
  }, [loadWorkspace])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!workspace) return
    setSaving(true)
    setActionError(null)
    setSavedMsg(null)
    try {
      const res = await fetch('/api/settings/workspace', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceRoot: workspace.workspaceRoot,
          mcpsRoot,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to save MCP settings')
      }
      const body = (await res.json()) as { workspace: WorkspaceSettings }
      setWorkspace(body.workspace)
      setMcpsRoot(workspaceDisplayPath(body.workspace, 'mcpsRoot'))
      setSavedMsg('MCP settings saved.')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section id="mcps" aria-labelledby="mcps-heading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="mcps-heading" className="text-lg font-semibold text-foreground">
          MCP tools
        </h2>
        <span className="inline-flex h-6 items-center rounded-full bg-gray-100 px-2.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
          Shared
        </span>
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          Loading MCP settings…
        </p>
      )}

      {!loading && fetchError !== null && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {fetchError}
          <button onClick={loadWorkspace} className="ml-2 underline underline-offset-2 hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {!loading && workspace && (
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mcps-root" className="text-sm font-medium text-foreground">
              MCP tools folder
            </label>
            <input
              id="mcps-root"
              type="text"
              value={mcpsRoot}
              onChange={(e) => setMcpsRoot(e.target.value)}
              disabled={workspace.envLocked || saving}
              autoComplete="off"
              className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
          <dl className="grid gap-2 text-xs text-muted-foreground">
            <div>
              <dt className="font-medium text-foreground">Managed tools</dt>
              <dd>Filesystem, GitHub</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Recommended MCP tools are installed under this shared folder. Forge checks each project against that saved setup.
          </p>

          {workspace.envLocked && (
            <p className="text-xs text-muted-foreground">
              MCP tool location is locked by <code className="font-mono">FORGE_WORKSPACE_ROOT</code> or{' '}
              <code className="font-mono">FORGE_MCPS_ROOT</code>.
            </p>
          )}

          {actionError !== null && (
            <p role="alert" className="text-sm text-destructive">{actionError}</p>
          )}
          {savedMsg !== null && (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{savedMsg}</p>
          )}

          <div>
            <Button type="submit" size="sm" disabled={saving || workspace.envLocked} aria-busy={saving}>
              {saving ? 'Saving…' : 'Save MCP tools'}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

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
    <section id="github" aria-labelledby="github-heading" className="rounded-xl border border-border bg-card p-5">
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
// Security card — manage passkeys
// ---------------------------------------------------------------------------

type CredentialSummary = {
  id: string
  friendlyName: string | null
  deviceType: string
  backedUp: boolean
  createdAt: string
  lastUsedAt: string | null
}

function SecurityCard() {
  const [credentialList, setCredentialList] = useState<CredentialSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const loadCredentials = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch('/api/auth/credentials')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to load passkeys')
      }
      const body = (await res.json()) as { credentials: CredentialSummary[] }
      setCredentialList(body.credentials)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadCredentials()
  }, [loadCredentials])

  async function handleRemove(id: string) {
    setRemovingId(id)
    setActionError(null)
    try {
      const res = await fetch(`/api/auth/credentials/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? 'Failed to remove passkey')
      }
      await loadCredentials()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <section aria-labelledby="security-heading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="security-heading" className="text-lg font-semibold text-foreground">
          Security
        </h2>
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          Loading passkeys…
        </p>
      )}

      {!loading && fetchError !== null && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {fetchError}
          <button onClick={loadCredentials} className="ml-2 underline underline-offset-2 hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {!loading && credentialList !== null && (
        <div className="flex flex-col gap-4">
          {credentialList.length === 0 ? (
            <p className="text-sm text-muted-foreground">No passkeys are registered. You can sign in with your password.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {credentialList.map((cred) => (
                <li
                  key={cred.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {cred.friendlyName ?? 'Passkey'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(cred.createdAt).toLocaleDateString()}
                      {cred.lastUsedAt
                        ? ` · last used ${new Date(cred.lastUsedAt).toLocaleDateString()}`
                        : ' · never used'}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleRemove(cred.id)}
                    disabled={removingId === cred.id}
                    aria-busy={removingId === cred.id}
                  >
                    {removingId === cred.id ? 'Removing…' : 'Remove'}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {actionError !== null && (
            <p role="alert" className="text-sm text-destructive">{actionError}</p>
          )}

          <p className="text-xs text-muted-foreground">
            Removing a passkey here deletes it permanently — Forge will no longer accept it for
            sign-in. If you ever lose access to both your passkey and your password, an operator
            with shell access to this install can run{' '}
            <code className="font-mono">forge reset-credentials</code> to set a new password.
          </p>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Appearance card
// ---------------------------------------------------------------------------

function AppearanceCard() {
  const { mode, accent, setMode, setAccent } = useTheme()

  return (
    <section aria-labelledby="appearance-heading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4">
        <h2 id="appearance-heading" className="text-lg font-semibold text-foreground">
          Appearance
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how Forge looks. This preference is saved in this browser and does not affect
          project data, provider config, or task execution.
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <div>
          <span className="text-sm font-medium text-foreground">Theme mode</span>
          <div
            role="radiogroup"
            aria-label="Theme mode"
            className="mt-2 inline-flex rounded-lg border border-border bg-muted/40 p-0.5"
          >
            {THEME_MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                onClick={() => setMode(option.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  mode === option.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            System follows your operating system or browser light/dark preference.
          </p>
        </div>

        <div>
          <span className="text-sm font-medium text-foreground">Accent color</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {THEME_ACCENTS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={accent === option.value}
                onClick={() => setAccent(option.value)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  accent === option.value
                    ? 'border-foreground/40 bg-muted text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <span
                  data-accent={option.value}
                  aria-hidden="true"
                  className="size-4 rounded-full border border-border"
                  style={{ backgroundColor: 'var(--primary)' }}
                />
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
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
          Manage appearance, workspace folders, MCP tools, GitHub, and sign-in security.
        </p>
      </div>

      <div className="grid max-w-6xl gap-6 md:grid-cols-2 xl:grid-cols-3 [&>section]:w-full [&>section]:max-w-2xl">
        <AppearanceCard />
        <WorkspaceCard />
        <McpSettingsCard />
        <GitHubCard />
        <SecurityCard />
      </div>
    </div>
  )
}
