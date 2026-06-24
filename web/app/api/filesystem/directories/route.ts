import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getSession } from '@/lib/session'
import { getWorkspaceSettings } from '@/lib/workspace'

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

async function defaultStartPath(): Promise<string> {
  const workspace = await getWorkspaceSettings()
  return workspace.projectsRoot
}

async function resolveDirectoryPath(rawPath: string | null): Promise<string> {
  const start = await defaultStartPath()
  if (!rawPath || rawPath.trim() === '') return path.resolve(/*turbopackIgnore: true*/ start)
  return path.isAbsolute(rawPath)
    ? path.resolve(/*turbopackIgnore: true*/ rawPath)
    : path.resolve(/*turbopackIgnore: true*/ start, rawPath)
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
    const currentPath = await resolveDirectoryPath(requestedPath)
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

    const parsed = path.parse(currentPath)
    const parentPath = currentPath === parsed.root ? null : path.dirname(currentPath)

    return NextResponse.json({
      path: currentPath,
      parentPath,
      currentPathIsGitRepo,
      directories,
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

    const parentPath = await resolveDirectoryPath(parsed.data.parentPath ?? null)
    const directoryPath = path.join(/*turbopackIgnore: true*/ parentPath, directoryName)

    // Check the parent folder first so we can ask the user before creating it.
    let parentExists = true
    try {
      const parentStat = await fs.stat(parentPath)
      if (!parentStat.isDirectory()) {
        return NextResponse.json({ error: 'Parent path is not a directory' }, { status: 400 })
      }
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
            path: directoryPath,
          },
          { status: 409 },
        )
      }
      await fs.mkdir(parentPath, { recursive: true })
    }

    try {
      await fs.mkdir(directoryPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        if (!parsed.data.allowExisting) {
          const empty = await isDirectoryEmpty(directoryPath).catch(() => true)
          return NextResponse.json(
            {
              error: 'Folder already exists',
              code: 'DIR_EXISTS',
              path: directoryPath,
              parentPath,
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
        return NextResponse.json({ path: directoryPath, parentPath, existed: true }, { status: 200 })
      }
      throw err
    }

    return NextResponse.json(
      {
        path: directoryPath,
        parentPath,
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
