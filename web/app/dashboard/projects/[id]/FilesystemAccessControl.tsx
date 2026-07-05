'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

type GrantState = {
  enabled: boolean
  capabilities: string[]
  approvedAt: string | null
  approvedBy: string | null
  reason: string
}

/**
 * Project-level "always allow read-only filesystem access" control. This is the
 * one-time counterpart to approving filesystem context per work package on the
 * task page: turning it on covers every package in the project that needs bounded
 * read-only project context, so agents stop blocking on a per-package grant.
 * Self-contained — it loads and mutates its own state via
 * /api/projects/:id/filesystem-grant.
 */
export function FilesystemAccessControl({ projectId }: { projectId: string }) {
  const [grant, setGrant] = useState<GrantState | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/filesystem-grant`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Failed to load filesystem access')
      setGrant(body.grant ?? null)
      setHealthError(body.healthError ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function setEnabled(enabled: boolean) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/filesystem-grant`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Failed to update filesystem access')
      setGrant(body.grant ?? null)
      setHealthError(body.healthError ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSaving(false)
    }
  }

  const enabled = grant?.enabled ?? false

  return (
    <div className="mt-4 rounded-lg border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Filesystem access for agents</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Allow work packages in this project to receive bounded, read-only filesystem
            context without approving each one. No files are written and no live filesystem
            tools are exposed.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!loading && (
            <span className={enabled ? 'text-xs font-medium text-emerald-600 dark:text-emerald-400' : 'text-xs text-muted-foreground'}>
              {enabled ? 'Always allowed' : 'Off'}
            </span>
          )}
          <Button
            size="sm"
            variant={enabled ? 'outline' : 'default'}
            disabled={loading || saving || (!enabled && healthError !== null)}
            onClick={() => void setEnabled(!enabled)}
            aria-busy={saving}
            title={!enabled && healthError ? healthError : undefined}
          >
            {saving ? 'Saving…' : enabled ? 'Turn off' : 'Always allow'}
          </Button>
        </div>
      </div>
      {!enabled && healthError && (
        <p className="mt-2 text-xs text-muted-foreground">{healthError}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>
      )}
    </div>
  )
}
