'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { PlusIcon, ExternalLinkIcon, FolderOpenIcon, GitBranchIcon, HardDriveIcon, CloudDownloadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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
  mcpSummary: McpSummary | null
}

type ProjectSource = 'github' | 'local' | 'clone'

type McpSummary = {
  label: string
  status: 'healthy' | 'unhealthy' | 'disabled' | 'auth_required' | 'configuration_required' | 'unknown' | 'missing'
  missing: number
  authRequired: number
  unhealthy: number
  disabled: number
}

type DirectoryEntry = {
  name: string
  path: string
  displayPath?: string
  isGitRepo: boolean
}

type DirectoryListing = {
  path: string
  displayPath?: string
  parentPath: string | null
  parentDisplayPath?: string | null
  directories: DirectoryEntry[]
  currentPathIsGitRepo: boolean
}

type GithubRepo = {
  nameWithOwner: string
  description: string | null
}

function repoShortName(nameWithOwner: string): string {
  const idx = nameWithOwner.lastIndexOf('/')
  return idx === -1 ? nameWithOwner : nameWithOwner.slice(idx + 1)
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso))
}

function mcpSummaryClassName(summary: McpSummary | null): string {
  const base = 'mt-3 inline-flex h-6 max-w-full items-center rounded-full px-2.5 text-xs font-medium'
  if (!summary) {
    return `${base} bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300`
  }
  if (summary.status === 'healthy') {
    return `${base} bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300`
  }
  if (summary.status === 'missing' || summary.status === 'auth_required') {
    return `${base} bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300`
  }
  return `${base} bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300`
}

function folderNameFromProjectName(name: string): string {
  if (!name.trim()) return ''
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'forge-project'
}

function joinPathPreview(parentPath: string, folderName: string): string {
  const parent = parentPath.trim()
  const folder = folderName.trim()
  if (!parent || !folder) return ''
  if (parent.endsWith('/') || parent.endsWith('\\')) return `${parent}${folder}`
  return `${parent}${parent.includes('\\') && !parent.includes('/') ? '\\' : '/'}${folder}`
}

function projectLocationLabel(project: Project): string {
  return project.githubRepo ?? project.displayLocalPath ?? project.localPath ?? 'Local project'
}

function directoryListingPathLabel(listing: DirectoryListing | null): string {
  return listing?.displayPath ?? listing?.path ?? 'Loading folders…'
}

function parentPathInputValue(listing: DirectoryListing | null, parentPath: string): string {
  return listing?.path === parentPath ? listing.displayPath ?? parentPath : parentPath
}

export default function ProjectsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Form state
  const [formSource, setFormSource] = useState<ProjectSource>('github')
  const [formName, setFormName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [formRepo, setFormRepo] = useState('')
  const [formLocalParentPath, setFormLocalParentPath] = useState('')
  const [formLocalFolderName, setFormLocalFolderName] = useState('')
  const [folderNameEdited, setFolderNameEdited] = useState(false)
  const [formBranch, setFormBranch] = useState('main')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [folderListing, setFolderListing] = useState<DirectoryListing | null>(null)
  const [folderLoading, setFolderLoading] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [showHiddenFolders, setShowHiddenFolders] = useState(false)

  // Clone-source state
  const [cloneRepo, setCloneRepo] = useState('')
  const [cloneRepos, setCloneRepos] = useState<GithubRepo[] | null>(null)
  const [cloneReposLoading, setCloneReposLoading] = useState(false)
  const [cloneReposError, setCloneReposError] = useState<string | null>(null)
  const [cloneRepoFilter, setCloneRepoFilter] = useState('')

  const loadProjects = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load projects')
      }
      const data = await res.json()
      setProjects(data.projects ?? [])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  const loadFolders = useCallback(async (path?: string, showHidden?: boolean) => {
    setFolderLoading(true)
    setFolderError(null)
    try {
      const params = new URLSearchParams()
      if (path) params.set('path', path)
      if (showHidden ?? showHiddenFolders) params.set('showHidden', '1')
      const query = params.toString()
      const res = await fetch(`/api/filesystem/directories${query ? `?${query}` : ''}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load folders')
      }
      const data: DirectoryListing = await res.json()
      setFolderListing(data)
      // Wherever the user has browsed to is the folder the project will be
      // created in. Keep the parent-path input in sync with the listing.
      setFormLocalParentPath(data.path)
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : 'Unable to load folders')
    } finally {
      setFolderLoading(false)
    }
  }, [showHiddenFolders])

  useEffect(() => {
    if (dialogOpen && (formSource === 'local' || formSource === 'clone') && folderListing === null && !folderLoading) {
      void loadFolders()
    }
  }, [dialogOpen, folderListing, folderLoading, formSource, loadFolders])

  useEffect(() => {
    if (!folderNameEdited) {
      setFormLocalFolderName(folderNameFromProjectName(formName))
    }
  }, [folderNameEdited, formName])

  const loadCloneRepos = useCallback(async () => {
    setCloneReposLoading(true)
    setCloneReposError(null)
    try {
      const res = await fetch('/api/github/repos')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? 'Failed to load GitHub repositories')
      }
      const data = await res.json()
      setCloneRepos(data.repos ?? [])
    } catch (err) {
      setCloneReposError(err instanceof Error ? err.message : 'Unable to load GitHub repositories')
    } finally {
      setCloneReposLoading(false)
    }
  }, [])

  useEffect(() => {
    if (dialogOpen && formSource === 'clone' && cloneRepos === null && !cloneReposLoading) {
      void loadCloneRepos()
    }
  }, [dialogOpen, formSource, cloneRepos, cloneReposLoading, loadCloneRepos])

  // F2/F3: auto-fill the project Name from the chosen GitHub repo's short name,
  // for both the 'github' and 'clone' sources, unless the user has manually
  // edited the Name field.
  useEffect(() => {
    if (!nameEdited && (formSource === 'github' || formSource === 'clone')) {
      const repo = formSource === 'github' ? formRepo : cloneRepo
      if (repo.trim()) {
        setFormName(repoShortName(repo.trim()))
      }
    }
  }, [nameEdited, formSource, formRepo, cloneRepo])

  async function createLocalProjectFolder(): Promise<string | undefined> {
    if (formSource !== 'local') return undefined

    // F1: if the folder currently being browsed is already a Git repo, use it
    // as-is — Forge should not require (or create) a new subfolder.
    if (folderListing?.currentPathIsGitRepo) {
      return folderListing.path
    }

    const parentPath = formLocalParentPath.trim()
    const folderName = formLocalFolderName.trim()
    if (!parentPath) {
      throw new Error('Choose a parent folder for this local project')
    }
    if (!folderName) {
      throw new Error('Enter a folder name for this local project')
    }

    // We POST up to a few times: the first call may report that the parent
    // folder is missing or that the target already exists. In those cases we
    // ask the user with a pop-up and retry with the matching flag set.
    let createParents = false
    let allowExisting = false

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch('/api/filesystem/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPath, name: folderName, createParents, allowExisting }),
      })

      if (res.ok) {
        const body = await res.json()
        if (typeof body.path !== 'string' || body.path.length === 0) {
          throw new Error('Project folder was ready, but the path was not returned')
        }
        return body.path
      }

      const body = await res.json().catch(() => ({}))

      if (res.status === 409 && body.code === 'PARENT_MISSING' && !createParents) {
        const ok = window.confirm(
          `The folder "${parentPath}" does not exist yet.\n\nCreate it now?`,
        )
        if (!ok) {
          throw new Error('Cancelled: the parent folder was not created.')
        }
        createParents = true
        continue
      }

      if (res.status === 409 && body.code === 'DIR_EXISTS' && !allowExisting) {
        const detail = body.empty === false ? ' It already contains files.' : ''
        const ok = window.confirm(
          `A folder named "${folderName}" already exists here.${detail}\n\nUse the existing folder for this project?`,
        )
        if (!ok) {
          throw new Error('Cancelled: choose a different folder name.')
        }
        allowExisting = true
        continue
      }

      throw new Error(body.error ?? 'Failed to create project folder')
    }

    throw new Error('Could not prepare the project folder. Please try again.')
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    setSubmitting(true)
    try {
      let localPath: string | undefined
      let githubRepo: string | undefined

      if (formSource === 'github') {
        githubRepo = formRepo.trim()
      } else if (formSource === 'clone') {
        if (!cloneRepo.trim()) {
          throw new Error('Choose a GitHub repository to clone')
        }
        const parentPath = formLocalParentPath.trim()
        const folderName = formLocalFolderName.trim()
        if (!parentPath) {
          throw new Error('Choose a destination parent folder')
        }
        if (!folderName) {
          throw new Error('Enter a folder name for the cloned project')
        }
        githubRepo = cloneRepo.trim()
        localPath = joinPathPreview(parentPath, folderName)
      } else {
        localPath = await createLocalProjectFolder()
      }

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          source: formSource,
          githubRepo,
          localPath,
          defaultBranch: formBranch.trim() || 'main',
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        if (res.status === 409) {
          throw new Error(body.error ?? 'That destination folder already exists and is not empty')
        }
        throw new Error(body.error ?? 'Failed to create project')
      }
      setDialogOpen(false)
      setFormSource('github')
      setFormName('')
      setNameEdited(false)
      setFormRepo('')
      setFormLocalParentPath('')
      setFormLocalFolderName('')
      setFolderNameEdited(false)
      setFormBranch('main')
      setFolderListing(null)
      setCloneRepo('')
      setCloneRepos(null)
      setCloneRepoFilter('')
      await loadProjects()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  const formLocalParentDisplayPath = parentPathInputValue(folderListing, formLocalParentPath)
  const localPathPreview = joinPathPreview(formLocalParentDisplayPath, formLocalFolderName)
  const currentFolderIsGitRepo = formSource === 'local' && folderListing?.currentPathIsGitRepo === true
  const filteredCloneRepos = (cloneRepos ?? []).filter((r) =>
    cloneRepoFilter.trim() === '' || r.nameWithOwner.toLowerCase().includes(cloneRepoFilter.trim().toLowerCase()),
  )

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      {/* Page header */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-foreground">Projects</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger
            render={
              <Button size="sm" aria-label="Create new project">
                <PlusIcon aria-hidden="true" />
                New Project
              </Button>
            }
          />
          <DialogContent aria-labelledby="new-project-title">
            <DialogHeader>
              <DialogTitle id="new-project-title">New Project</DialogTitle>
            </DialogHeader>

            <form onSubmit={handleCreateProject} className="flex min-w-0 flex-col gap-4" autoComplete="off">
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Project source">
                <button
                  type="button"
                  role="radio"
                  aria-checked={formSource === 'github'}
                  onClick={() => setFormSource('github')}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                    formSource === 'github'
                      ? 'border-ring bg-muted text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <GitBranchIcon className="size-4" aria-hidden="true" />
                  GitHub
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={formSource === 'local'}
                  onClick={() => setFormSource('local')}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                    formSource === 'local'
                      ? 'border-ring bg-muted text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <HardDriveIcon className="size-4" aria-hidden="true" />
                  Local
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={formSource === 'clone'}
                  onClick={() => setFormSource('clone')}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                    formSource === 'clone'
                      ? 'border-ring bg-muted text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <CloudDownloadIcon className="size-4" aria-hidden="true" />
                  Clone
                </button>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="project-name" className="text-sm font-medium text-foreground">
                  Name <span aria-hidden="true" className="text-destructive">*</span>
                </label>
                <input
                  id="project-name"
                  name="forge-project-name"
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => {
                    setNameEdited(true)
                    setFormName(e.target.value)
                  }}
                  placeholder="My Project"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-required="true"
                />
              </div>

              {formSource === 'github' && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="github-repository" className="text-sm font-medium text-foreground">
                    GitHub repository <span aria-hidden="true" className="text-destructive">*</span>
                  </label>
                  <input
                    id="github-repository"
                    name="github-repository"
                    type="text"
                    required
                    inputMode="text"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    value={formRepo}
                    onChange={(e) => setFormRepo(e.target.value)}
                    placeholder="owner/repo"
                    className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    aria-describedby="github-repository-help"
                    aria-required="true"
                  />
                  <div
                    id="github-repository-help"
                    className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                  >
                    Need repository access? Run <code className="font-mono text-foreground">gh auth login --scopes repo,workflow</code>.
                  </div>
                </div>
              )}

              {formSource === 'local' && (
                <div className="flex min-w-0 flex-col gap-2">
                  <label htmlFor="project-local-parent-path" className="text-sm font-medium text-foreground">
                    Parent folder <span aria-hidden="true" className="text-destructive">*</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="project-local-parent-path"
                      name="forge-local-parent-path"
                      type="text"
                      required
                      value={formLocalParentDisplayPath}
                      onChange={(e) => setFormLocalParentPath(e.target.value)}
                      placeholder="~/Documents/Forge/projects"
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      data-form-type="other"
                      className="min-w-0 flex-1 rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      aria-describedby="project-local-parent-path-help"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void loadFolders(formLocalParentPath || undefined)}
                      disabled={folderLoading}
                      aria-label="Browse local folders"
                    >
                      <FolderOpenIcon aria-hidden="true" />
                      Browse
                    </Button>
                  </div>
                  <p id="project-local-parent-path-help" className="text-xs text-muted-foreground">
                    Type a path and press Browse, or click folders below to open them. The folder
                    shown below is where Forge will create the new project folder.
                  </p>

                  {currentFolderIsGitRepo && (
                    <div
                      role="status"
                      className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                    >
                      <GitBranchIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      This folder is already a Git repository — Forge will use it as-is.
                    </div>
                  )}

                  {!currentFolderIsGitRepo && (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="project-local-folder-name" className="text-sm font-medium text-foreground">
                        New Folder Name <span aria-hidden="true" className="text-destructive">*</span>
                      </label>
                      <input
                        id="project-local-folder-name"
                        name="forge-local-folder-name"
                        type="text"
                        required
                        value={formLocalFolderName}
                        onChange={(e) => {
                          setFolderNameEdited(true)
                          setFormLocalFolderName(e.target.value)
                        }}
                        placeholder="my-project"
                        autoComplete="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        data-form-type="other"
                        className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                        aria-describedby="project-local-folder-name-help"
                      />
                      <p id="project-local-folder-name-help" className="text-xs text-muted-foreground">
                        Forge will create this folder before saving the project.
                      </p>
                    </div>
                  )}

                  <div className="min-w-0 rounded-lg border border-border bg-muted/30">
                    <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
                      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                        {directoryListingPathLabel(folderListing)}
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={showHiddenFolders}
                            onChange={(e) => {
                              const next = e.target.checked
                              setShowHiddenFolders(next)
                              void loadFolders(folderListing?.path, next)
                            }}
                            className="size-3.5 rounded border-input"
                            aria-label="Show hidden folders"
                          />
                          Show hidden
                        </label>
                        {folderListing?.parentPath && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void loadFolders(folderListing.parentPath ?? undefined)}
                            disabled={folderLoading}
                            aria-label="Go up one folder"
                          >
                            Up
                          </Button>
                        )}
                      </div>
                    </div>

                    {folderError !== null && (
                      <p role="alert" className="px-3 py-2 text-xs text-destructive">
                        {folderError}
                      </p>
                    )}

                    {folderLoading ? (
                      <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                        Loading…
                      </p>
                    ) : folderListing !== null && folderListing.directories.length > 0 ? (
                      <div className="max-h-52 overflow-x-hidden overflow-y-auto p-1">
                        {folderListing.directories.map((directory) => (
                          <button
                            type="button"
                            key={directory.path}
                            onClick={() => void loadFolders(directory.path)}
                            disabled={folderLoading}
                            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Open folder ${directory.name}${directory.isGitRepo ? ' (Git repository)' : ''}`}
                          >
                            <FolderOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 truncate">{directory.name}</span>
                            {directory.isGitRepo && (
                              <GitBranchIcon
                                className="ml-auto size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                        No folders inside this folder.
                      </p>
                    )}
                  </div>

                  {!currentFolderIsGitRepo && localPathPreview !== '' && (
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      New project folder:{' '}
                      <code className="break-all font-mono text-foreground">{localPathPreview}</code>
                    </div>
                  )}
                </div>
              )}

              {formSource === 'clone' && (
                <div className="flex min-w-0 flex-col gap-2">
                  <label htmlFor="clone-repository" className="text-sm font-medium text-foreground">
                    GitHub repository <span aria-hidden="true" className="text-destructive">*</span>
                  </label>

                  {cloneReposLoading && (
                    <p className="px-1 py-1 text-xs text-muted-foreground">Loading your repositories…</p>
                  )}

                  {cloneReposError !== null && (
                    <div
                      role="alert"
                      className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                    >
                      {cloneReposError}
                      <div className="mt-1 text-muted-foreground">
                        Need repository access? Run <code className="font-mono text-foreground">gh auth login --scopes repo,workflow</code>.
                      </div>
                      <button
                        type="button"
                        onClick={() => void loadCloneRepos()}
                        className="mt-1 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Retry
                      </button>
                    </div>
                  )}

                  {!cloneReposLoading && cloneReposError === null && cloneRepos !== null && (
                    <>
                      {cloneRepos.length > 15 && (
                        <input
                          type="text"
                          name="forge-clone-repo-filter"
                          value={cloneRepoFilter}
                          onChange={(e) => setCloneRepoFilter(e.target.value)}
                          placeholder="Filter repositories…"
                          autoComplete="off"
                          data-1p-ignore="true"
                          data-lpignore="true"
                          data-form-type="other"
                          className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                          aria-label="Filter repositories"
                        />
                      )}
                      <Select value={cloneRepo || undefined} onValueChange={(v) => v && setCloneRepo(v)}>
                        <SelectTrigger id="clone-repository" className="w-full" aria-required="true">
                          <SelectValue placeholder={cloneRepos.length > 0 ? 'Choose a repository' : 'No repositories found'} />
                        </SelectTrigger>
                        <SelectContent>
                          {filteredCloneRepos.map((repo) => (
                            <SelectItem key={repo.nameWithOwner} value={repo.nameWithOwner}>
                              {repo.nameWithOwner}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  )}

                  <label htmlFor="clone-local-parent-path" className="mt-2 text-sm font-medium text-foreground">
                    Destination folder <span aria-hidden="true" className="text-destructive">*</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="clone-local-parent-path"
                      name="forge-clone-local-parent-path"
                      type="text"
                      required
                      value={formLocalParentDisplayPath}
                      onChange={(e) => setFormLocalParentPath(e.target.value)}
                      placeholder="~/Documents/Forge/projects"
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      data-form-type="other"
                      className="min-w-0 flex-1 rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      aria-describedby="clone-local-parent-path-help"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void loadFolders(formLocalParentPath || undefined)}
                      disabled={folderLoading}
                      aria-label="Browse local folders"
                    >
                      <FolderOpenIcon aria-hidden="true" />
                      Browse
                    </Button>
                  </div>
                  <p id="clone-local-parent-path-help" className="text-xs text-muted-foreground">
                    Type a path and press Browse, or click folders below to open them. Forge will
                    clone the repository into a new folder inside the folder shown below.
                  </p>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="clone-local-folder-name" className="text-sm font-medium text-foreground">
                      New Folder Name <span aria-hidden="true" className="text-destructive">*</span>
                    </label>
                    <input
                      id="clone-local-folder-name"
                      name="forge-clone-local-folder-name"
                      type="text"
                      required
                      value={formLocalFolderName}
                      onChange={(e) => {
                        setFolderNameEdited(true)
                        setFormLocalFolderName(e.target.value)
                      }}
                      placeholder="my-project"
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      data-form-type="other"
                      className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      aria-describedby="clone-local-folder-name-help"
                    />
                    <p id="clone-local-folder-name-help" className="text-xs text-muted-foreground">
                      Forge will clone the repository into this new folder.
                    </p>
                  </div>

                  <div className="min-w-0 rounded-lg border border-border bg-muted/30">
                    <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
                      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                        {directoryListingPathLabel(folderListing)}
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={showHiddenFolders}
                            onChange={(e) => {
                              const next = e.target.checked
                              setShowHiddenFolders(next)
                              void loadFolders(folderListing?.path, next)
                            }}
                            className="size-3.5 rounded border-input"
                            aria-label="Show hidden folders"
                          />
                          Show hidden
                        </label>
                        {folderListing?.parentPath && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void loadFolders(folderListing.parentPath ?? undefined)}
                            disabled={folderLoading}
                            aria-label="Go up one folder"
                          >
                            Up
                          </Button>
                        )}
                      </div>
                    </div>

                    {folderError !== null && (
                      <p role="alert" className="px-3 py-2 text-xs text-destructive">
                        {folderError}
                      </p>
                    )}

                    {folderLoading ? (
                      <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                        Loading…
                      </p>
                    ) : folderListing !== null && folderListing.directories.length > 0 ? (
                      <div className="max-h-52 overflow-x-hidden overflow-y-auto p-1">
                        {folderListing.directories.map((directory) => (
                          <button
                            type="button"
                            key={directory.path}
                            onClick={() => void loadFolders(directory.path)}
                            disabled={folderLoading}
                            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Open folder ${directory.name}${directory.isGitRepo ? ' (Git repository)' : ''}`}
                          >
                            <FolderOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 truncate">{directory.name}</span>
                            {directory.isGitRepo && (
                              <GitBranchIcon
                                className="ml-auto size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                        No folders inside this folder.
                      </p>
                    )}
                  </div>

                  {localPathPreview !== '' && (
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      Clone destination:{' '}
                      <code className="break-all font-mono text-foreground">{localPathPreview}</code>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label htmlFor="project-branch" className="text-sm font-medium text-foreground">
                  {formSource === 'local' ? 'Initial branch' : 'Default branch'}
                </label>
                <input
                  id="project-branch"
                  name="forge-project-branch"
                  type="text"
                  value={formBranch}
                  onChange={(e) => setFormBranch(e.target.value)}
                  placeholder="main"
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </div>

              {formError !== null && (
                <p role="alert" aria-live="assertive" className="text-sm text-destructive">
                  {formError}
                </p>
              )}

              <DialogFooter>
                <Button type="submit" disabled={submitting} aria-busy={submitting}>
                  {submitting ? (formSource === 'clone' ? 'Cloning…' : 'Creating…') : 'Create project'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
          <span className="text-sm text-muted-foreground">Loading projects…</span>
        </div>
      )}

      {/* Error state */}
      {!loading && fetchError !== null && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {fetchError}
          <button
            onClick={loadProjects}
            className="ml-2 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && fetchError === null && projects.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <FolderOpenIcon className="size-10 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No projects yet. Create your first project to get started.</p>
        </div>
      )}

      {/* Projects grid */}
      {!loading && projects.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="list">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                onClick={() => router.push(`/dashboard/projects/${project.id}`)}
                className="w-full rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-ring/40 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                aria-label={`Open project ${project.name}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-foreground">{project.name}</span>
                  {project.githubRepo !== null && (
                    <a
                      href={`https://github.com/${project.githubRepo}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Open ${project.githubRepo} on GitHub`}
                      className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ExternalLinkIcon className="size-4" aria-hidden="true" />
                    </a>
                  )}
                </div>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {projectLocationLabel(project)}
                </p>
                <span className={mcpSummaryClassName(project.mcpSummary)}>
                  <span className="truncate">{project.mcpSummary?.label ?? 'MCP tools not checked'}</span>
                </span>
                <p className="mt-3 text-xs text-muted-foreground">
                  Created {formatDate(project.createdAt)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
