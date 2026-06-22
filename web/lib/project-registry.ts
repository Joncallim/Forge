import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Lightweight on-disk registry of local project folders Forge has created.
 *
 * The uninstall script (scripts/uninstall.sh) reads this file when the operator
 * asks to delete all project files, so it works even when the database is no
 * longer reachable. Each line is one absolute path. Writes are best-effort:
 * failing to record a path must never block project creation or deletion.
 */

function registryFile(): string {
  // Forge npm scripts run from web/, so the repo root is one level up and the
  // install state lives in <repo>/.forge — the same place the installer uses.
  const stateDir =
    process.env.FORGE_INSTALL_STATE_DIR?.trim() ||
    path.resolve(process.cwd(), '..', '.forge')
  return path.join(stateDir, 'project-paths')
}

async function readPaths(): Promise<string[]> {
  try {
    const raw = await fs.readFile(registryFile(), 'utf-8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

async function writePaths(paths: string[]): Promise<void> {
  const file = registryFile()
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
