import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import {
  displayPathForWorkspacePath,
  getWorkspaceSettings,
  isWithinPath,
  resolveWorkspaceInputPath,
  type WorkspaceSettings,
} from '@/lib/workspace'

export const runtime = 'nodejs'

const createDirectorySchema = z.object({
  parentPath: z.string().trim().min(1).max(1000).optional(),
  name: z.string().trim().min(1).max(120),
  // When the parent folder does not exist yet, create it (and any missing
  // ancestors) instead of failing. The UI sets this after the user confirms.
  createParents: z.boolean().optional(),
  // When the target folder already exists, reuse it instead of failing. The UI
  // sets this after the user confirms.
  allowExisting: z.boolean().optional(),
})

async function isDirectoryEmpty(dirPath: string): Promise<boolean> {
  const entries = await fs.readdir(dirPath)
  return entries.length === 0
}

async function hasGitSubdirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(/*turbopackIgnore: true*/ dirPath, '.git'))
    return stat.isDirectory()
  } catch {
    return false
  }
}

function resolveDirectoryPath(rawPath: string | null, workspace: WorkspaceSettings): string {
  const start = workspace.projectsRoot
  const resolvedPath = !rawPath || rawPath.trim() === ''
    ? path.resolve(/*turbopackIgnore: true*/ start)
    : resolveWorkspaceInputPath(rawPath, workspace, start)

  if (!isWithinPath(workspace.workspaceRoot, resolvedPath)) {
    throw new Error('Path must stay inside the active workspace root')
  }

  return resolvedPath
}

async function assertRealPathWithinWorkspace(
  candidatePath: string,
  workspace: WorkspaceSettings,
): Promise<void> {
  const [realWorkspaceRoot, realCandidate] = await Promise.all([
    fs.realpath(workspace.workspaceRoot),
    fs.realpath(candidatePath),
  ])

  if (!isWithinPath(realWorkspaceRoot, realCandidate)) {
    throw new Error('Path must stay inside the active workspace root')
  }
}

async function assertNearestExistingAncestorWithinWorkspace(
  candidatePath: string,
  workspace: WorkspaceSettings,
): Promise<void> {
  let currentPath = path.resolve(/*turbopackIgnore: true*/ candidatePath)
  const workspaceRoot = path.resolve(/*turbopackIgnore: true*/ workspace.workspaceRoot)

  while (isWithinPath(workspaceRoot, currentPath)) {
    try {
      await assertRealPathWithinWorkspace(currentPath, workspace)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parentPath = path.dirname(currentPath)
      if (parentPath === currentPath) break
      currentPath = parentPath
    }
  }

  throw new Error('Path must stay inside the active workspace root')
}

function isSafeDirectoryName(name: string): boolean {
  return (
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  )
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const requestedPath = request.nextUrl.searchParams.get('path')
    const showHidden = request.nextUrl.searchParams.get('showHidden') === '1'
    const workspace = await getWorkspaceSettings()
    const currentPath = resolveDirectoryPath(requestedPath, workspace)
    await assertRealPathWithinWorkspace(currentPath, workspace)
    const stat = await fs.stat(currentPath)
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 })
    }

    const dirents = await fs.readdir(currentPath, { withFileTypes: true })
    const candidates: { name: string; path: string }[] = []

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue
      if (dirent.name === 'node_modules' || dirent.name === '.git') continue
      if (!showHidden && dirent.name.startsWith('.')) continue
      candidates.push({
        name: dirent.name,
        path: path.join(/*turbopackIgnore: true*/ currentPath, dirent.name),
      })
    }

    candidates.sort((a, b) => a.name.localeCompare(b.name))
    const bounded = candidates.slice(0, 200)

    const [directories, currentPathIsGitRepo] = await Promise.all([
      Promise.all(
        bounded.map(async (entry) => ({
          ...entry,
          isGitRepo: await hasGitSubdirectory(entry.path),
        })),
      ),
      hasGitSubdirectory(currentPath),
    ])

    const parentCandidate = path.dirname(currentPath)
    const parentPath = currentPath === workspace.workspaceRoot ||
      !isWithinPath(workspace.workspaceRoot, parentCandidate)
      ? null
      : parentCandidate

    return NextResponse.json({
      path: currentPath,
      displayPath: displayPathForWorkspacePath(workspace, currentPath),
      parentPath,
      parentDisplayPath: parentPath ? displayPathForWorkspacePath(workspace, parentPath) : null,
      currentPathIsGitRepo,
      directories: directories.map((directory) => ({
        ...directory,
        displayPath: displayPathForWorkspacePath(workspace, directory.path),
      })),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to read directory'
    console.error('[GET /api/filesystem/directories] Unexpected error', err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createDirectorySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      )
    }

    const directoryName = parsed.data.name.trim()
    if (!isSafeDirectoryName(directoryName)) {
      return NextResponse.json(
        { error: 'Folder name cannot contain path separators or traversal segments' },
        { status: 400 },
      )
    }

    const workspace = await getWorkspaceSettings()
    const parentPath = resolveDirectoryPath(parsed.data.parentPath ?? null, workspace)
    const directoryPath = path.join(/*turbopackIgnore: true*/ parentPath, directoryName)

    // Check the parent folder first so we can ask the user before creating it.
    let parentExists = true
    try {
      const parentStat = await fs.stat(parentPath)
      if (!parentStat.isDirectory()) {
        return NextResponse.json({ error: 'Parent path is not a directory' }, { status: 400 })
      }
      await assertRealPathWithinWorkspace(parentPath, workspace)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        parentExists = false
      } else {
        throw err
      }
    }

    if (!parentExists) {
      if (!parsed.data.createParents) {
        return NextResponse.json(
          {
            error: `Folder does not exist: ${parentPath}`,
            code: 'PARENT_MISSING',
            parentPath,
            parentDisplayPath: displayPathForWorkspacePath(workspace, parentPath),
            path: directoryPath,
            displayPath: displayPathForWorkspacePath(workspace, directoryPath),
          },
          { status: 409 },
        )
      }
      await assertNearestExistingAncestorWithinWorkspace(parentPath, workspace)
      await fs.mkdir(parentPath, { recursive: true })
      await assertRealPathWithinWorkspace(parentPath, workspace)
    }

    try {
      await fs.mkdir(directoryPath)
      await assertRealPathWithinWorkspace(directoryPath, workspace)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        if (!parsed.data.allowExisting) {
          const empty = await isDirectoryEmpty(directoryPath).catch(() => true)
          return NextResponse.json(
            {
              error: 'Folder already exists',
              code: 'DIR_EXISTS',
              path: directoryPath,
              displayPath: displayPathForWorkspacePath(workspace, directoryPath),
              parentPath,
              parentDisplayPath: displayPathForWorkspacePath(workspace, parentPath),
              empty,
            },
            { status: 409 },
          )
        }
        // Reuse the existing folder — confirm it is actually a directory.
        const existingStat = await fs.stat(directoryPath)
        if (!existingStat.isDirectory()) {
          return NextResponse.json(
            { error: 'A file already exists at that path' },
            { status: 409 },
          )
        }
        await assertRealPathWithinWorkspace(directoryPath, workspace)
        return NextResponse.json({
          path: directoryPath,
          displayPath: displayPathForWorkspacePath(workspace, directoryPath),
          parentPath,
          parentDisplayPath: displayPathForWorkspacePath(workspace, parentPath),
          existed: true,
        }, { status: 200 })
      }
      throw err
    }

    return NextResponse.json(
      {
        path: directoryPath,
        displayPath: displayPathForWorkspacePath(workspace, directoryPath),
        parentPath,
        parentDisplayPath: displayPathForWorkspacePath(workspace, parentPath),
        existed: false,
      },
      { status: 201 },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to create directory'
    console.error('[POST /api/filesystem/directories] Unexpected error', err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
