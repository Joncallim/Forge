import fs from 'node:fs/promises'
import path from 'node:path'
import { getWorkspaceSettings } from '@/lib/workspace'

/**
 * Lightweight on-disk registry of local project folders Forge has created.
 *
 * The uninstall script (scripts/uninstall.sh) reads this file when the operator
 * asks to delete all project files, so it works even when the database is no
 * longer reachable. By default, the registry lives under the active Forge
 * workspace instead of the app repository. Each line is one absolute path. Writes are best-effort:
 * failing to record a path must never block project creation or deletion.
 */

async function registryFile(): Promise<string> {
  const stateDir = process.env.FORGE_INSTALL_STATE_DIR?.trim()
  if (stateDir) {
    return path.join(path.resolve(/*turbopackIgnore: true*/ stateDir), 'project-paths')
  }

  const workspace = await getWorkspaceSettings()
  const stateRoot = path.join(/*turbopackIgnore: true*/ workspace.workspaceRoot, 'runtime')
  await fs.mkdir(stateRoot, { recursive: true })
  return path.join(stateRoot, 'project-paths')
}

async function readPaths(): Promise<string[]> {
  try {
    const raw = await fs.readFile(await registryFile(), 'utf-8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

async function writePaths(paths: string[]): Promise<void> {
  const file = await registryFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const unique = Array.from(new Set(paths))
  await fs.writeFile(file, unique.length ? `${unique.join('\n')}\n` : '', { mode: 0o600 })
}

export async function registerProjectPath(projectPath: string | null | undefined): Promise<void> {
  if (!projectPath || process.env.NODE_ENV === 'test') return
  try {
    const paths = await readPaths()
    if (!paths.includes(projectPath)) {
      paths.push(projectPath)
      await writePaths(paths)
    }
  } catch {
    // Best-effort only.
  }
}

export async function unregisterProjectPath(projectPath: string | null | undefined): Promise<void> {
  if (!projectPath || process.env.NODE_ENV === 'test') return
  try {
    const paths = await readPaths()
    const next = paths.filter((p) => p !== projectPath)
    if (next.length !== paths.length) {
      await writePaths(next)
    }
  } catch {
    // Best-effort only.
  }
}
