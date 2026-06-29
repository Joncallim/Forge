import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { getWorkspaceSettings, isWithinPath } from '@/lib/workspace'

type ProjectLocalPath = {
  id: string
  localPath: string | null
}

function pathsOverlap(a: string, b: string): boolean {
  return isWithinPath(a, b) || isWithinPath(b, a)
}

async function realDirectory(rawPath: string): Promise<string> {
  const realPath = await fs.realpath(path.resolve(/*turbopackIgnore: true*/ rawPath))
  const stat = await fs.stat(realPath)
  if (!stat.isDirectory()) {
    throw new Error('Project localPath is not a directory.')
  }
  return realPath
}

export async function assertProjectLocalPathForExecution(project: ProjectLocalPath): Promise<string> {
  if (!project.localPath?.trim()) {
    throw new Error('Project localPath is required before Forge can execute this task.')
  }

  const workspace = await getWorkspaceSettings({ ensure: false })
  const [workspaceRoot, projectRoot] = await Promise.all([
    fs.realpath(path.resolve(/*turbopackIgnore: true*/ workspace.workspaceRoot)),
    realDirectory(project.localPath),
  ])

  if (!isWithinPath(workspaceRoot, projectRoot)) {
    throw new Error('Project localPath resolved outside the active Forge workspace.')
  }

  const rows = await db
    .select({ id: projects.id, localPath: projects.localPath })
    .from(projects)

  for (const row of rows) {
    if (row.id === project.id || !row.localPath?.trim()) continue
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
