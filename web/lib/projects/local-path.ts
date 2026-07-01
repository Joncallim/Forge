import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { getWorkspaceSettings, isWithinPath, type WorkspaceSettings } from '@/lib/workspace'

type ProjectLocalPath = {
  id: string
  localPath: string | null
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
    throw new Error('Project localPath cannot be the active Forge workspace root.')
  }
  // Reject the projects root itself and any ancestor that would enclose it: a
  // project rooted above the projects root could reach every other project's
  // files. Children under the projects root remain allowed.
  if (typeof workspace.projectsRoot === 'string' && isWithinPath(candidate, workspace.projectsRoot)) {
    throw new Error('Project localPath must be a child directory under the workspace projects root, not the projects root itself or an ancestor of it.')
  }

  for (const protectedDirectory of protectedWorkspaceDirectories(workspace)) {
    if (pathsOverlap(candidate, protectedDirectory.path)) {
      throw new Error(`Project localPath cannot overlap the ${protectedDirectory.label}.`)
    }
  }
}

async function realDirectory(rawPath: string): Promise<string> {
  const realPath = await fs.realpath(path.resolve(/*turbopackIgnore: true*/ rawPath))
  const stat = await fs.stat(realPath)
  if (!stat.isDirectory()) {
    throw new Error('Project localPath is not a directory.')
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
      if (!stat.isDirectory()) throw new Error('Project localPath ancestor is not a directory.')
      const realAncestor = await fs.realpath(current)
      return path.resolve(/*turbopackIgnore: true*/ realAncestor, path.relative(current, resolved))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  throw new Error('Project localPath must have an existing directory ancestor.')
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
    throw new Error('Project localPath resolved outside the active Forge workspace.')
  }
  assertProjectPathNotProtected(projectRoot, workspace)

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
      throw new Error('Project localPath overlaps another registered Forge project.')
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
    throw new Error('Project localPath is not a directory.')
  }
  return projectRoot
}

export async function assertProjectLocalPathForExecution(project: ProjectLocalPath): Promise<string> {
  if (!project.localPath?.trim()) {
    throw new Error('Project localPath is required before Forge can execute this task.')
  }

  return assertProjectLocalPathAllowed({
    localPath: project.localPath,
    projectId: project.id,
  })
}
