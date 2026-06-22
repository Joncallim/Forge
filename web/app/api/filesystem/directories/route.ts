import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getSession } from '@/lib/session'

export const runtime = 'nodejs'

type DirectoryEntry = {
  name: string
  path: string
}

function defaultStartPath(): string {
  return process.env.FORGE_WORKSPACE_ROOT?.trim() || os.homedir() || process.cwd()
}

function resolveDirectoryPath(rawPath: string | null): string {
  const start = defaultStartPath()
  if (!rawPath || rawPath.trim() === '') return path.resolve(/*turbopackIgnore: true*/ start)
  return path.isAbsolute(rawPath)
    ? path.resolve(/*turbopackIgnore: true*/ rawPath)
    : path.resolve(/*turbopackIgnore: true*/ start, rawPath)
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const requestedPath = request.nextUrl.searchParams.get('path')
    const currentPath = resolveDirectoryPath(requestedPath)
    const stat = await fs.stat(currentPath)
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 })
    }

    const dirents = await fs.readdir(currentPath, { withFileTypes: true })
    const directories: DirectoryEntry[] = []

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue
      if (dirent.name === 'node_modules' || dirent.name === '.git') continue
      directories.push({
        name: dirent.name,
        path: path.join(/*turbopackIgnore: true*/ currentPath, dirent.name),
      })
    }

    directories.sort((a, b) => a.name.localeCompare(b.name))

    const parsed = path.parse(currentPath)
    const parentPath = currentPath === parsed.root ? null : path.dirname(currentPath)

    return NextResponse.json({
      path: currentPath,
      parentPath,
      directories: directories.slice(0, 200),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to read directory'
    console.error('[GET /api/filesystem/directories] Unexpected error', err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
