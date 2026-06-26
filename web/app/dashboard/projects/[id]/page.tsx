'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { PlusIcon, ExternalLinkIcon, ArrowLeftIcon, Trash2Icon, RefreshCwIcon, DownloadIcon, SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'

interface Project {
  id: string
  name: string
  githubRepo: string | null
  localPath: string | null
  displayLocalPath?: string | null
  pmProviderConfigId: string | null
  defaultBranch: string
  createdAt: string
  archivedAt: string | null
}

type McpStatusName = 'healthy' | 'unhealthy' | 'disabled' | 'auth_required' | 'configuration_required' | 'unknown'

type ProjectMcpStatus = {
  mcpId: string
  displayName: string
  description: string
  installPath: string
  displayInstallPath?: string
  installState: 'installed' | 'missing'
  status: McpStatusName
  enabled: boolean
  error: string | null
  checkedAt: string
}

type ProjectMcpConfig = {
  profile: 'default' | 'custom'
  requiredMcps: string[]
  overrides: Record<string, { enabled?: boolean; installPath?: string }>
}

type McpCatalogEntry = {
  id: string
  displayName: string
  description: string
  recommended: boolean
  requiresAuth: boolean
}

type ProjectMcpOverview = {
  projectId: string
  config: ProjectMcpConfig
  catalog: McpCatalogEntry[]
  mcpsRoot: string
  displayMcpsRoot?: string
  statuses: ProjectMcpStatus[]
  summary: {
    label: string
    status: McpStatusName | 'missing'
    missing: number
    authRequired: number
    unhealthy: number
    disabled: number
  }
}

interface Task {
  id: string
  projectId: string
  title: string
  prompt: string
  status: string
  githubPrUrl: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

type StatusVariant = 'default' | 'secondary' | 'destructive' | 'outline'

function statusBadgeVariant(status: string): StatusVariant {
  switch (status) {
    case 'running': return 'default'
    case 'awaiting_approval': return 'outline'
    case 'approved':
    case 'completed': return 'secondary'
    case 'failed':
    case 'rejected':
    case 'cancelled': return 'destructive'
    default: return 'outline'
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    awaiting_answers: 'Needs answers',
    awaiting_approval: 'Needs approval',
    dead_lettered: 'Stopped after retries',
  }
  if (labels[status]) return labels[status]
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function mcpPillClass(status: McpStatusName | 'missing'): string {
  const base = 'inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium'
  if (status === 'healthy') {
    return `${base} bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300`
  }
  if (status === 'missing' || status === 'auth_required') {
    return `${base} bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300`
  }
  if (status === 'disabled' || status === 'unknown') {
    return `${base} bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300`
  }
  return `${base} bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300`
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((item) => rightSet.has(item))
}

function mcpErrorClass(status: ProjectMcpStatus): string {
  if (status.status === 'unhealthy') {
    return 'mt-1 text-xs font-medium text-destructive'
  }
  if (status.installState === 'missing' || status.status === 'auth_required' || status.status === 'configuration_required') {
    return 'mt-1 text-xs font-medium text-amber-700 dark:text-amber-300'
  }
  return 'mt-1 text-xs text-muted-foreground'
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso))
}

function projectLocalPathLabel(project: Project): string {
  return project.displayLocalPath ?? project.localPath ?? 'Local project'
}

function projectLocalPathInputValue(project: Project | null): string {
  return project?.displayLocalPath ?? project?.localPath ?? ''
}

function projectLocalPathSaveValue(input: string, project: Project | null): string | null {
  const trimmedPath = input.trim()
  if (!trimmedPath) return null
  if (project?.displayLocalPath && project.localPath && trimmedPath === project.displayLocalPath.trim()) {
    return project.localPath
  }
  return trimmedPath
}

function mcpRootLabel(overview: ProjectMcpOverview): string {
  return overview.displayMcpsRoot ?? overview.mcpsRoot
}

function mcpInstallPathLabel(
  status: ProjectMcpStatus | undefined,
  overview: ProjectMcpOverview,
  mcpId: string,
): string {
  return status?.displayInstallPath ?? status?.installPath ?? `${mcpRootLabel(overview)}/${mcpId}`
}

export default function ProjectDetailPage() {
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [project, setProject] = useState<Project | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [mcpOverview, setMcpOverview] = useState<ProjectMcpOverview | null>(null)
  const [selectedMcpIds, setSelectedMcpIds] = useState<string[]>([])
  const [mcpActionError, setMcpActionError] = useState<string | null>(null)
  const [savingMcpSelection, setSavingMcpSelection] = useState(false)
  const [refreshingMcps, setRefreshingMcps] = useState(false)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [projectPathDialogOpen, setProjectPathDialogOpen] = useState(false)
  const [projectPathInput, setProjectPathInput] = useState('')
  const [projectPathError, setProjectPathError] = useState<string | null>(null)
  const [savingProjectPath, setSavingProjectPath] = useState(false)

  // Task creation form state
  const [formTitle, setFormTitle] = useState('')
  const [formPrompt, setFormPrompt] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const applyMcpOverview = useCallback((overview: ProjectMcpOverview | null) => {
    setMcpOverview(overview)
    setSelectedMcpIds(overview?.config.requiredMcps ?? [])
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const [projectRes, tasksRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch(`/api/tasks?projectId=${projectId}`),
      ])

      if (!projectRes.ok) {
        const body = await projectRes.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load project')
      }
      if (!tasksRes.ok) {
        const body = await tasksRes.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load tasks')
      }

      const [projectData, tasksData] = await Promise.all([
        projectRes.json(),
        tasksRes.json(),
      ])

      setProject(projectData.project ?? null)
      setTasks(tasksData.tasks ?? [])

      const mcpRes = await fetch(`/api/projects/${projectId}/mcps`)
      if (mcpRes.ok) {
        const mcpData = await mcpRes.json()
        applyMcpOverview(mcpData.overview ?? null)
        setMcpActionError(null)
      } else {
        const body = await mcpRes.json().catch(() => ({}))
        applyMcpOverview(null)
        setMcpActionError(body.error ?? 'Failed to load MCP tool status')
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [applyMcpOverview, projectId])

  useEffect(() => {
    loadData()
  }, [loadData])

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          title: formTitle.trim(),
          prompt: formPrompt.trim(),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to create task')
      }
      const data = await res.json()
      const newTaskId = data.task?.id
      setDialogOpen(false)
      setFormTitle('')
      setFormPrompt('')
      if (newTaskId) {
        router.push(`/dashboard/tasks/${newTaskId}`)
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  async function refreshMcpStatus() {
    setRefreshingMcps(true)
    setMcpActionError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/mcps`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to refresh MCP tool status')
      }
      const data = await res.json()
      applyMcpOverview(data.overview ?? null)
    } catch (err) {
      setMcpActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setRefreshingMcps(false)
    }
  }

  function toggleMcpSelection(mcpId: string) {
    setSelectedMcpIds((current) => (
      current.includes(mcpId)
        ? current.filter((id) => id !== mcpId)
        : [...current, mcpId]
    ))
  }

  async function saveAndInstallSelectedMcps() {
    if (!mcpOverview) return
    const selectedIds = mcpOverview.catalog
      .map((entry) => entry.id)
      .filter((id) => selectedMcpIds.includes(id))
    const selectedSet = new Set(selectedIds)
    const overrides = Object.fromEntries(
      Object.entries(mcpOverview.config.overrides ?? {}).filter(([mcpId]) => selectedSet.has(mcpId)),
    )

    setSavingMcpSelection(true)
    setMcpActionError(null)
    try {
      const configRes = await fetch(`/api/projects/${projectId}/mcps`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: 'custom',
          requiredMcps: selectedIds,
          overrides,
        }),
      })
      if (!configRes.ok) {
        const body = await configRes.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to save MCP tool selection')
      }

      const configData = await configRes.json()
      const nextOverview = (configData.overview ?? null) as ProjectMcpOverview | null
      const missingSelected = nextOverview?.statuses
        .filter((status) => selectedSet.has(status.mcpId) && status.installState === 'missing')
        .map((status) => status.mcpId) ?? []

      if (missingSelected.length === 0) {
        applyMcpOverview(nextOverview)
        return
      }

      const res = await fetch(`/api/projects/${projectId}/mcps/install-recommended`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpIds: missingSelected }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to install selected MCP tools')
      }
      const data = await res.json()
      applyMcpOverview(data.overview ?? null)
    } catch (err) {
      setMcpActionError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSavingMcpSelection(false)
    }
  }

  function openProjectPathDialog() {
    setProjectPathInput(projectLocalPathInputValue(project))
    setProjectPathError(null)
    setProjectPathDialogOpen(true)
  }

  async function saveProjectPath(e: React.FormEvent) {
    e.preventDefault()
    if (!project) return
    setSavingProjectPath(true)
    setProjectPathError(null)
    try {
      const localPath = projectLocalPathSaveValue(projectPathInput, project)
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to save project path')
      }
      const data = await res.json()
      setProject(data.project ?? project)
      setProjectPathDialogOpen(false)
      await refreshMcpStatus()
    } catch (err) {
      setProjectPathError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSavingProjectPath(false)
    }
  }

  async function handleDeleteProject() {
    if (!project || deleting) return

    const confirmed = window.confirm(
      `Delete the project "${project.name}"?\n\nThis permanently removes the project and all of its tasks and history.`,
    )
    if (!confirmed) return

    let deleteFiles = false
    if (project.localPath) {
      const localPathLabel = projectLocalPathLabel(project)
      deleteFiles = window.confirm(
        `Also delete the project folder and everything inside it from disk?\n\n${localPathLabel}\n\nClick Cancel to keep the files on disk.`,
      )
    }

    setDeleting(true)
    try {
      const res = await fetch(
        `/api/projects/${projectId}${deleteFiles ? '?deleteFiles=true' : ''}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to delete project')
      }
      router.push('/dashboard/projects')
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center px-4 py-16" role="status" aria-live="polite">
        <span className="text-sm text-muted-foreground">Loading project…</span>
      </div>
    )
  }

  if (fetchError !== null) {
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {fetchError}
          <button
            onClick={loadData}
            className="ml-2 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (project === null) {
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">Project not found.</p>
      </div>
    )
  }

  const configuredMcpIds = mcpOverview?.config.requiredMcps ?? []
  const mcpSelectionChanged = mcpOverview ? !sameStringSet(selectedMcpIds, configuredMcpIds) : false
  const statusByMcpId = new Map(mcpOverview?.statuses.map((status) => [status.mcpId, status]) ?? [])
  const selectedMissingCount = mcpOverview?.statuses.filter((status) => (
    selectedMcpIds.includes(status.mcpId) && status.installState === 'missing'
  )).length ?? 0

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      {/* Back navigation */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push('/dashboard/projects')}
        className="mb-4 -ml-2"
        aria-label="Back to projects"
      >
        <ArrowLeftIcon aria-hidden="true" />
        Projects
      </Button>

      {/* Project heading */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{project.name}</h1>
          {project.githubRepo !== null && (
            <a
              href={`https://github.com/${project.githubRepo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Open ${project.githubRepo} on GitHub`}
            >
              {project.githubRepo}
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </a>
          )}
          {project.githubRepo === null && (
            <p className="mt-1 break-all font-mono text-sm text-muted-foreground">
              {projectLocalPathLabel(project)}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDeleteProject}
          disabled={deleting}
          aria-busy={deleting}
          aria-label={`Delete project ${project.name}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2Icon aria-hidden="true" />
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger
            render={
              <Button size="sm" aria-label="Create new task">
                <PlusIcon aria-hidden="true" />
                New Task
              </Button>
            }
          />
          <DialogContent className="sm:max-w-lg" aria-labelledby="new-task-title">
            <DialogHeader>
          <DialogTitle id="new-task-title">New task</DialogTitle>
            </DialogHeader>

            <form onSubmit={handleCreateTask} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="task-title" className="text-sm font-medium text-foreground">
                  Title <span className="text-muted-foreground">(optional)</span>
                </label>
                <input
                  id="task-title"
                  type="text"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  placeholder="Leave blank to auto-generate from the prompt"
                  className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="task-prompt" className="text-sm font-medium text-foreground">
                  Prompt <span aria-hidden="true" className="text-destructive">*</span>
                </label>
                <textarea
                  id="task-prompt"
                  required
                  rows={6}
                  value={formPrompt}
                  onChange={(e) => setFormPrompt(e.target.value)}
                  placeholder="Describe what you want the agents to build or change…"
                  className="resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-required="true"
                />
              </div>

              {formError !== null && (
                <p role="alert" aria-live="assertive" className="text-sm text-destructive">
                  {formError}
                </p>
              )}

              <DialogFooter>
                <Button type="submit" disabled={submitting} aria-busy={submitting}>
                  {submitting ? 'Creating…' : 'Create task'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Dialog open={projectPathDialogOpen} onOpenChange={setProjectPathDialogOpen}>
        <DialogContent className="sm:max-w-lg" aria-labelledby="project-path-title">
          <DialogHeader>
            <DialogTitle id="project-path-title">Project path</DialogTitle>
          </DialogHeader>

          <form onSubmit={saveProjectPath} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="project-local-path" className="text-sm font-medium text-foreground">
                Local folder
              </label>
              <input
                id="project-local-path"
                type="text"
                value={projectPathInput}
                onChange={(e) => setProjectPathInput(e.target.value)}
                autoComplete="off"
                placeholder="~/Documents/Forge/projects/example"
                className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <p className="text-xs text-muted-foreground">
                Forge checks project file access from this folder.
              </p>
            </div>

            {projectPathError !== null && (
              <p role="alert" className="text-sm text-destructive">
                {projectPathError}
              </p>
            )}

            <DialogFooter>
              <Button type="submit" disabled={savingProjectPath} aria-busy={savingProjectPath}>
                {savingProjectPath ? 'Saving…' : 'Save path'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <section aria-labelledby="project-mcps-heading" className="mb-6 rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="project-mcps-heading" className="text-sm font-medium text-foreground">
              MCP tools
            </h2>
            {mcpOverview && (
              <p className="mt-1 font-mono text-xs text-muted-foreground break-all">
                {mcpRootLabel(mcpOverview)}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mcpOverview && (
              <span className={mcpPillClass(mcpOverview.summary.status)}>
                {mcpOverview.summary.label}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={saveAndInstallSelectedMcps}
              disabled={!mcpOverview || savingMcpSelection || (!mcpSelectionChanged && selectedMissingCount === 0)}
              aria-busy={savingMcpSelection}
              aria-label="Save MCP tool selection and install selected tools"
            >
              <DownloadIcon aria-hidden="true" />
              {savingMcpSelection ? 'Saving…' : selectedMissingCount > 0 ? 'Save and install' : 'Save selection'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshMcpStatus}
              disabled={refreshingMcps}
              aria-busy={refreshingMcps}
              aria-label="Refresh MCP tool status"
            >
              <RefreshCwIcon aria-hidden="true" />
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/dashboard/settings#mcps')}
              aria-label="Open MCP tool settings"
            >
              <SettingsIcon aria-hidden="true" />
              Settings
            </Button>
          </div>
        </div>

        {mcpActionError !== null && (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {mcpActionError}
          </p>
        )}

        {mcpOverview === null ? (
          <p className="text-sm text-muted-foreground">MCP tool status has not been checked.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border" role="list">
            {mcpOverview.catalog.map((entry) => {
              const selected = selectedMcpIds.includes(entry.id)
              const status = statusByMcpId.get(entry.id)
              const statusText = !selected
                ? 'Not selected'
                : status
                  ? status.installState === 'missing' ? 'Missing' : statusLabel(status.status)
                  : 'Pending'
              const pillClass = selected && status
                ? mcpPillClass(status.installState === 'missing' ? 'missing' : status.status)
                : mcpPillClass('disabled')

              return (
                <li key={entry.id} className="flex flex-col gap-3 px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleMcpSelection(entry.id)}
                          className="size-4 rounded border-input accent-foreground"
                          aria-label={`${selected ? 'Remove' : 'Select'} ${entry.displayName} MCP tool`}
                        />
                        {entry.displayName}
                      </label>
                      <span className={pillClass}>{statusText}</span>
                      {entry.recommended && (
                        <span className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs font-medium text-muted-foreground">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{entry.description}</p>
                    {selected && status?.error && (
                      <p className={mcpErrorClass(status)}>{status.error}</p>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center lg:justify-end">
                    {selected && status?.mcpId === 'filesystem' && status.status === 'configuration_required' && (
                      <Button type="button" variant="outline" size="sm" onClick={openProjectPathDialog}>
                        <SettingsIcon aria-hidden="true" />
                        Configure
                      </Button>
                    )}
                    {selected && status?.mcpId === 'github' && status.status === 'auth_required' && (
                      <Button type="button" variant="outline" size="sm" onClick={() => router.push('/dashboard/settings#github')}>
                        <SettingsIcon aria-hidden="true" />
                        Connect
                      </Button>
                    )}
                    <code className="max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground sm:max-w-xs">
                      {mcpInstallPathLabel(status, mcpOverview, entry.id)}
                    </code>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Tasks section */}
      <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Tasks
      </h2>

      {tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12 text-center">
          <p className="text-sm text-muted-foreground">No tasks yet. Create a task to get started.</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border" role="list">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => router.push(`/dashboard/tasks/${task.id}`)}
                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 first:rounded-t-xl last:rounded-b-xl"
                aria-label={`Open task: ${task.title}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(task.createdAt)}</p>
                </div>
                <Badge variant={statusBadgeVariant(task.status)}>
                  {statusLabel(task.status)}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
