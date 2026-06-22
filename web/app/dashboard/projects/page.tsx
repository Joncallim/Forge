'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { PlusIcon, ExternalLinkIcon, FolderOpenIcon, GitBranchIcon, HardDriveIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  pmProviderConfigId: string | null
  defaultBranch: string
  createdAt: string
  archivedAt: string | null
}

type ProjectSource = 'github' | 'local'

type DirectoryEntry = {
  name: string
  path: string
}

type DirectoryListing = {
  path: string
  parentPath: string | null
  directories: DirectoryEntry[]
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso))
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

export default function ProjectsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Form state
  const [formSource, setFormSource] = useState<ProjectSource>('github')
  const [formName, setFormName] = useState('')
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

  const loadFolders = useCallback(async (path?: string) => {
    setFolderLoading(true)
    setFolderError(null)
    try {
      const params = path ? `?path=${encodeURIComponent(path)}` : ''
      const res = await fetch(`/api/filesystem/directories${params}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to load folders')
      }
      const data = await res.json()
      setFolderListing(data)
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : 'Unable to load folders')
    } finally {
      setFolderLoading(false)
    }
  }, [])

  useEffect(() => {
    if (dialogOpen && formSource === 'local' && folderListing === null && !folderLoading) {
      void loadFolders()
    }
  }, [dialogOpen, folderListing, folderLoading, formSource, loadFolders])

  useEffect(() => {
    if (!folderNameEdited) {
      setFormLocalFolderName(folderNameFromProjectName(formName))
    }
  }, [folderNameEdited, formName])

  useEffect(() => {
    if (formSource === 'local' && folderListing !== null && formLocalParentPath.trim() === '') {
      setFormLocalParentPath(folderListing.path)
    }
  }, [folderListing, formLocalParentPath, formSource])

  async function createLocalProjectFolder(): Promise<string | undefined> {
    if (formSource !== 'local') return undefined

    const parentPath = formLocalParentPath.trim()
    const folderName = formLocalFolderName.trim()
    if (!parentPath) {
      throw new Error('Choose a parent folder for this local project')
    }
    if (!folderName) {
      throw new Error('Enter a folder name for this local project')
    }

    const res = await fetch('/api/filesystem/directories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath, name: folderName }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? 'Failed to create project folder')
    }

    const body = await res.json()
    if (typeof body.path !== 'string' || body.path.length === 0) {
      throw new Error('Project folder was created, but the path was not returned')
    }
    return body.path
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    setSubmitting(true)
    try {
      const localPath = await createLocalProjectFolder()
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          source: formSource,
          githubRepo: formSource === 'github' ? formRepo.trim() : undefined,
          localPath,
          defaultBranch: formBranch.trim() || 'main',
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to create project')
      }
      setDialogOpen(false)
      setFormSource('github')
      setFormName('')
      setFormRepo('')
      setFormLocalParentPath('')
      setFormLocalFolderName('')
      setFolderNameEdited(false)
      setFormBranch('main')
      setFolderListing(null)
      await loadProjects()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'An unexpected error occurred')
    } finally {
      setSubmitting(false)
    }
  }

  const localPathPreview = joinPathPreview(formLocalParentPath, formLocalFolderName)

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

            <form onSubmit={handleCreateProject} className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Project source">
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
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="project-name" className="text-sm font-medium text-foreground">
                  Name <span aria-hidden="true" className="text-destructive">*</span>
                </label>
                <input
                  id="project-name"
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="My Project"
                  className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-required="true"
                />
              </div>

              {formSource === 'github' && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="github-repository" className="text-sm font-medium text-foreground">
                    GitHub Repo <span aria-hidden="true" className="text-destructive">*</span>
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
                    Need repo permissions? Run <code className="font-mono text-foreground">gh auth login --scopes repo,workflow</code>.
                  </div>
                </div>
              )}

              {formSource === 'local' && (
                <div className="flex flex-col gap-2">
                  <label htmlFor="project-local-parent-path" className="text-sm font-medium text-foreground">
                    Parent Folder <span aria-hidden="true" className="text-destructive">*</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="project-local-parent-path"
                      type="text"
                      required
                      value={formLocalParentPath}
                      onChange={(e) => setFormLocalParentPath(e.target.value)}
                      placeholder="/Users/alex/Projects"
                      autoComplete="off"
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
                    Choose where Forge should create the new project folder.
                  </p>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="project-local-folder-name" className="text-sm font-medium text-foreground">
                      New Folder Name <span aria-hidden="true" className="text-destructive">*</span>
                    </label>
                    <input
                      id="project-local-folder-name"
                      type="text"
                      required
                      value={formLocalFolderName}
                      onChange={(e) => {
                        setFolderNameEdited(true)
                        setFormLocalFolderName(e.target.value)
                      }}
                      placeholder="my-project"
                      autoComplete="off"
                      className="rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      aria-describedby="project-local-folder-name-help"
                    />
                    <p id="project-local-folder-name-help" className="text-xs text-muted-foreground">
                      Forge will create this folder before saving the project.
                    </p>
                  </div>

                  <div className="rounded-lg border border-border bg-muted/30">
                    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                        {folderListing?.path ?? 'Loading folders...'}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        {folderListing !== null && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setFormLocalParentPath(folderListing.path)}
                            disabled={folderLoading}
                          >
                            Use
                          </Button>
                        )}
                        {folderListing?.parentPath && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void loadFolders(folderListing.parentPath ?? undefined)}
                            disabled={folderLoading}
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
                        Loading...
                      </p>
                    ) : folderListing !== null && folderListing.directories.length > 0 ? (
                      <div className="max-h-52 overflow-y-auto p-1">
                        {folderListing.directories.map((directory) => (
                          <button
                            type="button"
                            key={directory.path}
                            onDoubleClick={() => void loadFolders(directory.path)}
                            onClick={() => setFormLocalParentPath(directory.path)}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                              formLocalParentPath === directory.path ? 'bg-background text-foreground' : 'text-muted-foreground'
                            }`}
                          >
                            <FolderOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 truncate">{directory.name}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                        No child folders.
                      </p>
                    )}
                  </div>

                  {localPathPreview !== '' && (
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      New project path:{' '}
                      <code className="break-all font-mono text-foreground">{localPathPreview}</code>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label htmlFor="project-branch" className="text-sm font-medium text-foreground">
                  {formSource === 'github' ? 'Default Branch' : 'Initial Branch'}
                </label>
                <input
                  id="project-branch"
                  type="text"
                  value={formBranch}
                  onChange={(e) => setFormBranch(e.target.value)}
                  placeholder="main"
                  autoComplete="off"
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
                  {submitting ? 'Creating…' : 'Create Project'}
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
                <p className="mt-1 text-xs text-muted-foreground">
                  {project.githubRepo ?? project.localPath ?? 'Local project'}
                </p>
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
