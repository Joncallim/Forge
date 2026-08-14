import { constants as fsConstants } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { getWorkspaceSettings, isWithinPath, type WorkspaceSettings } from '@/lib/workspace'

type ProjectLocalPath = {
  id: string
  localPath: string | null
}

export type ProjectExecutionRootBinding = Readonly<{
  path: string
  dev: bigint
  ino: bigint
}>

export type ProjectRootBindingErrorCode =
  | 'missing_local_path'
  | 'unsafe_project_root'
  | 'project_root_unavailable'
  | 'project_root_changed'

export class ProjectRootBindingError extends Error {
  readonly code: ProjectRootBindingErrorCode

  constructor(code: ProjectRootBindingErrorCode, message: string) {
    super(message)
    this.name = 'ProjectRootBindingError'
    this.code = code
  }
}

const EXPECTED_PROJECT_ROOT_FILESYSTEM_CODES = new Set([
  'EACCES',
  'ELOOP',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
])

function rootError(code: ProjectRootBindingErrorCode, message: string): ProjectRootBindingError {
  return new ProjectRootBindingError(code, message)
}

function isExpectedProjectRootFilesystemError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && EXPECTED_PROJECT_ROOT_FILESYSTEM_CODES.has(code)
}

function pathsOverlap(a: string, b: string): boolean {
  return isWithinPath(a, b) || isWithinPath(b, a)
}

function samePath(a: string, b: string): boolean {
  return path.relative(
    path.resolve(/*turbopackIgnore: true*/ a),
    path.resolve(/*turbopackIgnore: true*/ b),
  ) === ''
}

function protectedWorkspaceDirectories(workspace: WorkspaceSettings): Array<{ label: string; path: string }> {
  return [
    { label: 'workspace config directory', path: workspace.configRoot },
    { label: 'workspace MCP directory', path: workspace.mcpsRoot },
    { label: 'workspace templates directory', path: workspace.templatesRoot },
    { label: 'workspace local-memory directory', path: workspace.localMemoryRoot },
    { label: 'workspace prompts directory', path: workspace.promptsRoot },
    { label: 'workspace workforces directory', path: workspace.workforcesRoot },
    { label: 'workspace runtime directory', path: workspace.runtimeRoot },
    { label: 'workspace logs directory', path: workspace.logsRoot },
    { label: 'workspace backups directory', path: workspace.backupsRoot },
  ].filter((entry) => typeof entry.path === 'string' && entry.path.trim() !== '')
}

export function assertProjectPathNotProtected(
  localPath: string,
  workspace: WorkspaceSettings,
): void {
  const candidate = path.resolve(/*turbopackIgnore: true*/ localPath)
  if (samePath(candidate, workspace.workspaceRoot)) {
    throw rootError('unsafe_project_root', 'Project localPath cannot be the active Forge workspace root.')
  }
  // Reject the projects root itself and any ancestor that would enclose it: a
  // project rooted above the projects root could reach every other project's
  // files. Children under the projects root remain allowed.
  if (typeof workspace.projectsRoot === 'string' && isWithinPath(candidate, workspace.projectsRoot)) {
    throw rootError('unsafe_project_root', 'Project localPath must be a child directory under the workspace projects root, not the projects root itself or an ancestor of it.')
  }

  for (const protectedDirectory of protectedWorkspaceDirectories(workspace)) {
    if (pathsOverlap(candidate, protectedDirectory.path)) {
      throw rootError('unsafe_project_root', `Project localPath cannot overlap the ${protectedDirectory.label}.`)
    }
  }
}

async function realDirectory(rawPath: string): Promise<string> {
  const realPath = await fs.realpath(path.resolve(/*turbopackIgnore: true*/ rawPath))
  const stat = await fs.stat(realPath)
  if (!stat.isDirectory()) {
    throw rootError('unsafe_project_root', 'Project localPath is not a directory.')
  }
  return realPath
}

async function realProjectPathCandidate(rawPath: string): Promise<string> {
  const resolved = path.resolve(/*turbopackIgnore: true*/ rawPath)
  try {
    return await realDirectory(resolved)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  let current = resolved
  while (true) {
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
    try {
      const stat = await fs.stat(current)
      if (!stat.isDirectory()) {
        throw rootError('unsafe_project_root', 'Project localPath ancestor is not a directory.')
      }
      const realAncestor = await fs.realpath(current)
      return path.resolve(/*turbopackIgnore: true*/ realAncestor, path.relative(current, resolved))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  throw rootError('project_root_unavailable', 'Project localPath must have an existing directory ancestor.')
}

async function canonicalizeExistingPath(rawPath: string): Promise<string> {
  const resolved = path.resolve(/*turbopackIgnore: true*/ rawPath)
  try {
    return await fs.realpath(resolved)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolved
    throw err
  }
}

// Workspace path fields the protected-directory guard compares against.
const WORKSPACE_PROTECTED_PATH_KEYS = [
  'workspaceRoot',
  'projectsRoot',
  'configRoot',
  'mcpsRoot',
  'templatesRoot',
  'localMemoryRoot',
  'promptsRoot',
  'workforcesRoot',
  'runtimeRoot',
  'logsRoot',
  'backupsRoot',
] as const

// Resolve symlinks on every workspace root before the protected-directory check
// so the comparison is consistent with the realpath-canonicalized project
// candidate. Without this, a symlinked workspace root (e.g. macOS temp dirs where
// /var -> /private/var) lets protected workspace directories slip past the guard,
// because one side is realpath-resolved and the other is not. Non-existent roots
// fall back to a plain resolve.
async function canonicalizeWorkspacePaths(workspace: WorkspaceSettings): Promise<WorkspaceSettings> {
  const overrides: Record<string, string> = {}
  for (const key of WORKSPACE_PROTECTED_PATH_KEYS) {
    const value = (workspace as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim() !== '') {
      overrides[key] = await canonicalizeExistingPath(value)
    }
  }
  return { ...workspace, ...overrides }
}

export async function assertProjectLocalPathPreflightAllowed(input: {
  localPath: string
  projectId?: string | null
  workspace?: WorkspaceSettings
}): Promise<string> {
  const workspace = input.workspace ?? await getWorkspaceSettings({ ensure: false })
  const [workspaceRoot, projectRoot] = await Promise.all([
    fs.realpath(path.resolve(/*turbopackIgnore: true*/ workspace.workspaceRoot)),
    realProjectPathCandidate(input.localPath),
  ])

  if (!isWithinPath(workspaceRoot, projectRoot)) {
    throw rootError('unsafe_project_root', 'Project localPath resolved outside the active Forge workspace.')
  }
  assertProjectPathNotProtected(projectRoot, await canonicalizeWorkspacePaths(workspace))

  const rows = await db
    .select({ id: projects.id, localPath: projects.localPath })
    .from(projects)

  for (const row of rows) {
    if (row.id === input.projectId || !row.localPath?.trim()) continue
    let otherRoot: string
    try {
      otherRoot = await realDirectory(row.localPath)
    } catch {
      continue
    }
    if (pathsOverlap(projectRoot, otherRoot)) {
      throw rootError('unsafe_project_root', 'Project localPath overlaps another registered Forge project.')
    }
  }

  return projectRoot
}

export async function assertProjectLocalPathAllowed(input: {
  localPath: string
  projectId?: string | null
  workspace?: WorkspaceSettings
}): Promise<string> {
  const projectRoot = await assertProjectLocalPathPreflightAllowed(input)
  const stat = await fs.stat(projectRoot)
  if (!stat.isDirectory()) {
    throw rootError('unsafe_project_root', 'Project localPath is not a directory.')
  }
  return projectRoot
}

async function bindProjectExecutionRoot(projectRoot: string): Promise<ProjectExecutionRootBinding> {
  const before = await fs.lstat(projectRoot, { bigint: true })
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw rootError('unsafe_project_root', 'Project localPath is not a real directory.')
  }

  let handle: FileHandle
  try {
    handle = await fs.open(
      projectRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
  } catch (error) {
    if (!isExpectedProjectRootFilesystemError(error)) throw error
    throw rootError('project_root_unavailable', 'Project localPath could not be opened safely for execution.')
  }

  try {
    const opened = await handle.stat({ bigint: true })
    const [current, currentRealPath] = await Promise.all([
      fs.lstat(projectRoot, { bigint: true }),
      fs.realpath(projectRoot),
    ])
    if (
      !opened.isDirectory()
      || current.isSymbolicLink()
      || !current.isDirectory()
      || before.dev !== opened.dev
      || before.ino !== opened.ino
      || current.dev !== opened.dev
      || current.ino !== opened.ino
      || currentRealPath !== projectRoot
    ) {
      throw rootError('project_root_changed', 'Project localPath moved or was replaced while it was being bound for execution.')
    }
    return { path: projectRoot, dev: opened.dev, ino: opened.ino }
  } finally {
    await handle.close()
  }
}

export async function assertProjectLocalPathForExecutionBinding(
  project: ProjectLocalPath,
): Promise<ProjectExecutionRootBinding> {
  if (!project.localPath?.trim()) {
    throw rootError('missing_local_path', 'Project localPath is required before Forge can execute this task.')
  }

  try {
    const projectRoot = await assertProjectLocalPathAllowed({
      localPath: project.localPath,
      projectId: project.id,
    })
    return await bindProjectExecutionRoot(projectRoot)
  } catch (error) {
    if (error instanceof ProjectRootBindingError) throw error
    if (isExpectedProjectRootFilesystemError(error)) {
      throw rootError('project_root_unavailable', 'Project localPath is unavailable for execution.')
    }
    throw error
  }
}

export async function assertProjectLocalPathForExecution(project: ProjectLocalPath): Promise<string> {
  return (await assertProjectLocalPathForExecutionBinding(project)).path
}
