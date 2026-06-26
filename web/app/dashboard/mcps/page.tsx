'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ExternalLinkIcon, HammerIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { MCP_CATALOG } from '@/lib/mcps/catalog'

type WorkspaceSettings = {
  workspaceRoot: string
  mcpsRoot: string
  displayPaths?: {
    mcpsRoot?: string
  }
  source: 'env' | 'setting' | 'default'
  envLocked: boolean
}

type Project = {
  id: string
  name: string
  githubRepo: string | null
  localPath: string | null
  displayLocalPath?: string | null
}

const catalogEntries = Object.values(MCP_CATALOG)

function sourceLabel(source: WorkspaceSettings['source']): string {
  if (source === 'env') return 'Environment'
  if (source === 'setting') return 'Custom'
  return 'Default'
}

function workspaceMcpRootLabel(workspace: WorkspaceSettings): string {
  return workspace.displayPaths?.mcpsRoot ?? workspace.mcpsRoot
}

function installerPrompt(source: string): string {
  return [
    'Act as the MCP Installer agent for this Forge project.',
    '',
    'MCP source or search request:',
    source,
    '',
    'Expected outcome:',
    '- Identify the MCP package, repository, or setup instructions from the supplied source.',
    '- Inspect the existing Forge MCP manager, catalog, workspace settings, and project MCP config before changing code.',
    '- Install or configure the MCP under the shared Forge MCP root when implementation is safe and in scope.',
    '- Keep project-specific overrides explicit and scoped to this project.',
    '- Do not execute unknown remote scripts, destructive commands, or credential-changing steps without explicit approval.',
    '- Add or update tests and documentation for any supported install path.',
  ].join('\n')
}

export default function McpsPage() {
  const router = useRouter()
  const [workspace, setWorkspace] = useState<WorkspaceSettings | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )

  const loadData = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const [workspaceRes, projectsRes] = await Promise.all([
        fetch('/api/settings/workspace'),
        fetch('/api/projects'),
      ])

      if (!workspaceRes.ok) {
        const body = await workspaceRes.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load workspace settings')
      }
      if (!projectsRes.ok) {
        const body = await projectsRes.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load projects')
      }

      const [workspaceData, projectsData] = await Promise.all([
        workspaceRes.json(),
        projectsRes.json(),
      ])
      const loadedProjects = (projectsData.projects ?? []) as Project[]
      setWorkspace(workspaceData.workspace ?? null)
      setProjects(loadedProjects)
      setSelectedProjectId((current) => (
        loadedProjects.some((project) => project.id === current)
          ? current
          : loadedProjects[0]?.id ?? ''
      ))
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  async function createInstallerTask(e: React.FormEvent) {
    e.preventDefault()
    const trimmedSource = source.trim()
    if (!selectedProjectId || !trimmedSource) return

    setSubmitting(true)
    setActionError(null)
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProjectId,
          title: 'Install MCP from source',
          prompt: installerPrompt(trimmedSource),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to create MCP installer task')
      }
      const body = await res.json()
      const taskId = body.task?.id
      if (taskId) {
        router.push(`/dashboard/tasks/${taskId}`)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">MCP tools</h1>
          {workspace && (
            <p className="mt-1 font-mono text-sm text-muted-foreground break-all">
              {workspaceMcpRootLabel(workspace)}
            </p>
          )}
        </div>
        {workspace && (
          <span className="inline-flex h-6 items-center rounded-full bg-gray-100 px-2.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            {sourceLabel(workspace.source)}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
          <span className="text-sm text-muted-foreground">Loading MCP tools…</span>
        </div>
      )}

      {!loading && fetchError !== null && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {fetchError}
          <button onClick={loadData} className="ml-2 underline underline-offset-2 hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {!loading && fetchError === null && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
          <section aria-labelledby="mcp-catalog-heading" className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="mcp-catalog-heading" className="text-sm font-medium text-foreground">
                Catalog
              </h2>
              <Button type="button" variant="ghost" size="sm" onClick={() => router.push('/dashboard/settings#mcps')}>
                Settings
              </Button>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border" role="list">
              {catalogEntries.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{entry.displayName}</p>
                      {entry.recommended && (
                        <span className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs font-medium text-muted-foreground">
                          Recommended
                        </span>
                      )}
                      {entry.requiresAuth && (
                        <span className="inline-flex h-6 items-center rounded-full bg-amber-100 px-2.5 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-300">
                          Auth
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{entry.description}</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => selectedProject && router.push(`/dashboard/projects/${selectedProject.id}`)}
                    disabled={!selectedProject}
                  >
                    <ExternalLinkIcon aria-hidden="true" />
                    Project tools
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="mcp-installer-heading" className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <HammerIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              <h2 id="mcp-installer-heading" className="text-sm font-medium text-foreground">
                Install from source
              </h2>
            </div>
            <form onSubmit={createInstallerTask} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="mcp-project" className="text-sm font-medium text-foreground">
                  Project
                </label>
                <Select
                  value={selectedProjectId}
                  onValueChange={(value) => setSelectedProjectId(value ?? '')}
                  disabled={projects.length === 0 || submitting}
                >
                  <SelectTrigger id="mcp-project" className="w-full">
                    <span
                      data-slot="select-value"
                      className={selectedProject ? 'text-foreground' : 'text-muted-foreground'}
                    >
                      {selectedProject?.name ?? 'Select project'}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="mcp-source" className="text-sm font-medium text-foreground">
                  Source
                </label>
                <textarea
                  id="mcp-source"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  rows={5}
                  placeholder="Repository URL, package name, docs link, or search request"
                  className="resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  disabled={submitting}
                />
              </div>

              {projects.length === 0 && (
                <p className="text-sm text-muted-foreground">Create a project before starting an installer task.</p>
              )}
              {actionError !== null && (
                <p role="alert" className="text-sm text-destructive">{actionError}</p>
              )}

              <Button type="submit" disabled={submitting || !selectedProjectId || source.trim().length === 0} aria-busy={submitting}>
                {submitting ? 'Creating…' : 'Create installer task'}
              </Button>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}
