import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { appSettings } from '@/db/schema'

export const WORKSPACE_ROOT_SETTING_KEY = 'workspaceRoot'
export const DEFAULT_WORKSPACE_ROOT = '~/Documents/Forge'

export type WorkspaceSettings = {
  workspaceRoot: string
  projectsRoot: string
  mcpsRoot: string
  templatesRoot: string
  globalSettingsPath: string
  source: 'env' | 'setting' | 'default'
  envLocked: boolean
}

function homeDir(): string {
  return os.homedir() || '/'
}

export function expandHomePath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (trimmed === '~') return homeDir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homeDir(), trimmed.slice(2))
  }
  return trimmed
}

export function normalizeWorkspaceRoot(rawPath: string): string {
  const expanded = expandHomePath(rawPath)
  return path.resolve(/*turbopackIgnore: true*/ expanded)
}

export function collapseHomePath(resolvedPath: string): string {
  const home = path.resolve(/*turbopackIgnore: true*/ homeDir())
  const absolute = path.resolve(/*turbopackIgnore: true*/ resolvedPath)
  const relative = path.relative(home, absolute)
  if (relative === '') return '~'
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`
  }
  return absolute
}

function settingsForRoot(workspaceRoot: string, source: WorkspaceSettings['source']): WorkspaceSettings {
  return {
    workspaceRoot,
    projectsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'projects'),
    mcpsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'mcps'),
    templatesRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'templates'),
    globalSettingsPath: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'global-settings.json'),
    source,
    envLocked: source === 'env',
  }
}

function defaultWorkspaceRootAbsolute(): string {
  return normalizeWorkspaceRoot(DEFAULT_WORKSPACE_ROOT)
}

async function readWorkspaceRootFromGlobalSettings(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { workspaceRoot?: unknown }
    return typeof parsed.workspaceRoot === 'string' && parsed.workspaceRoot.trim()
      ? normalizeWorkspaceRoot(parsed.workspaceRoot)
      : null
  } catch {
    return null
  }
}

async function readStoredWorkspaceRoot(): Promise<string | null> {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, WORKSPACE_ROOT_SETTING_KEY))
      .limit(1)
    if (row?.value?.trim()) return row.value.trim()
  } catch {
    // Fall through to the DB-independent pointer below.
  }

  return readWorkspaceRootFromGlobalSettings(
    path.join(/*turbopackIgnore: true*/ defaultWorkspaceRootAbsolute(), 'global-settings.json'),
  )
}

async function writeStoredWorkspaceRoot(workspaceRoot: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: WORKSPACE_ROOT_SETTING_KEY, value: workspaceRoot })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: workspaceRoot, updatedAt: new Date() },
    })
}

export async function ensureWorkspace(settings: WorkspaceSettings): Promise<void> {
  await Promise.all([
    fs.mkdir(settings.projectsRoot, { recursive: true }),
    fs.mkdir(settings.mcpsRoot, { recursive: true }),
    fs.mkdir(settings.templatesRoot, { recursive: true }),
  ])

  const payload = {
    workspaceRoot: collapseHomePath(settings.workspaceRoot),
    projectsRoot: collapseHomePath(settings.projectsRoot),
    mcpsRoot: collapseHomePath(settings.mcpsRoot),
    templatesRoot: collapseHomePath(settings.templatesRoot),
  }

  await fs.writeFile(
    settings.globalSettingsPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 },
  )
}

async function writeDefaultWorkspacePointer(settings: WorkspaceSettings): Promise<void> {
  const defaultRoot = defaultWorkspaceRootAbsolute()
  if (settings.workspaceRoot === defaultRoot) return

  await fs.mkdir(defaultRoot, { recursive: true })
  const pointerPath = path.join(/*turbopackIgnore: true*/ defaultRoot, 'global-settings.json')
  const payload = {
    workspaceRoot: collapseHomePath(settings.workspaceRoot),
    projectsRoot: collapseHomePath(settings.projectsRoot),
    mcpsRoot: collapseHomePath(settings.mcpsRoot),
    templatesRoot: collapseHomePath(settings.templatesRoot),
  }
  await fs.writeFile(pointerPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
}

export async function getWorkspaceSettings(options: { ensure?: boolean } = {}): Promise<WorkspaceSettings> {
  const envRoot = process.env.FORGE_WORKSPACE_ROOT?.trim()
  const storedRoot = envRoot ? null : await readStoredWorkspaceRoot()
  const source: WorkspaceSettings['source'] =
    envRoot ? 'env' : storedRoot && normalizeWorkspaceRoot(storedRoot) !== defaultWorkspaceRootAbsolute() ? 'setting' : 'default'
  const rawRoot = envRoot || storedRoot || DEFAULT_WORKSPACE_ROOT
  const settings = settingsForRoot(normalizeWorkspaceRoot(rawRoot), source)

  if (options.ensure ?? true) {
    await ensureWorkspace(settings)
  }

  return settings
}

export async function saveWorkspaceRoot(rawRoot: string): Promise<WorkspaceSettings> {
  if (process.env.FORGE_WORKSPACE_ROOT?.trim()) {
    throw new Error('FORGE_WORKSPACE_ROOT is set, so the workspace root is controlled by the environment.')
  }
  if (rawRoot.includes('\0')) {
    throw new Error('Workspace root cannot contain null bytes.')
  }
  const workspaceRoot = normalizeWorkspaceRoot(rawRoot)
  const settings = settingsForRoot(workspaceRoot, 'setting')
  await ensureWorkspace(settings)
  await writeDefaultWorkspacePointer(settings)
  await writeStoredWorkspaceRoot(workspaceRoot)
  return settings
}

export function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const parent = path.resolve(/*turbopackIgnore: true*/ parentPath)
  const candidate = path.resolve(/*turbopackIgnore: true*/ candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
