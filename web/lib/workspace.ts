import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { db } from '@/db'
import { appSettings } from '@/db/schema'

export const WORKSPACE_ROOT_SETTING_KEY = 'workspaceRoot'
export const MCPS_ROOT_SETTING_KEY = 'mcpsRoot'
export const DEFAULT_WORKSPACE_ROOT = '~/Documents/Forge'

export type WorkspaceSettings = {
  workspaceRoot: string
  projectsRoot: string
  mcpsRoot: string
  templatesRoot: string
  localMemoryRoot: string
  checkpointsRoot: string
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

function defaultMcpsRootForWorkspace(workspaceRoot: string): string {
  return path.join(/*turbopackIgnore: true*/ workspaceRoot, 'mcps')
}

function settingsForRoot(
  workspaceRoot: string,
  source: WorkspaceSettings['source'],
  mcpsRoot = defaultMcpsRootForWorkspace(workspaceRoot),
): WorkspaceSettings {
  return {
    workspaceRoot,
    projectsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'projects'),
    mcpsRoot,
    templatesRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'templates'),
    localMemoryRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'local-memory'),
    checkpointsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'local-memory', 'checkpoints'),
    globalSettingsPath: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'global-settings.json'),
    source,
    envLocked: source === 'env',
  }
}

function defaultWorkspaceRootAbsolute(): string {
  return normalizeWorkspaceRoot(DEFAULT_WORKSPACE_ROOT)
}

async function readWorkspaceConfigFromGlobalSettings(filePath: string): Promise<{
  workspaceRoot: string | null
  mcpsRoot: string | null
}> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { workspaceRoot?: unknown; mcpsRoot?: unknown }
    const workspaceRoot = typeof parsed.workspaceRoot === 'string' && parsed.workspaceRoot.trim()
      ? normalizeWorkspaceRoot(parsed.workspaceRoot)
      : null
    const mcpsRoot = typeof parsed.mcpsRoot === 'string' && parsed.mcpsRoot.trim()
      ? normalizeWorkspaceRoot(parsed.mcpsRoot)
      : null
    return { workspaceRoot, mcpsRoot }
  } catch {
    return { workspaceRoot: null, mcpsRoot: null }
  }
}

async function readStoredWorkspaceConfig(): Promise<{ workspaceRoot: string | null; mcpsRoot: string | null }> {
  let workspaceRoot: string | null = null
  let mcpsRoot: string | null = null

  try {
    const rows = await db
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(inArray(appSettings.key, [WORKSPACE_ROOT_SETTING_KEY, MCPS_ROOT_SETTING_KEY]))
    for (const row of rows) {
      if (!row.value?.trim()) continue
      if (row.key === WORKSPACE_ROOT_SETTING_KEY) workspaceRoot = row.value.trim()
      if (row.key === MCPS_ROOT_SETTING_KEY) mcpsRoot = row.value.trim()
    }
  } catch {
    // Fall through to the DB-independent pointer below.
  }

  if (workspaceRoot && mcpsRoot) return { workspaceRoot, mcpsRoot }

  const globalConfig = await readWorkspaceConfigFromGlobalSettings(
    path.join(/*turbopackIgnore: true*/ defaultWorkspaceRootAbsolute(), 'global-settings.json'),
  )

  return {
    workspaceRoot: workspaceRoot ?? globalConfig.workspaceRoot,
    mcpsRoot: mcpsRoot ?? globalConfig.mcpsRoot,
  }
}

async function writeStoredSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    })
}

export async function ensureWorkspace(settings: WorkspaceSettings): Promise<void> {
  await Promise.all([
    fs.mkdir(settings.projectsRoot, { recursive: true }),
    fs.mkdir(settings.mcpsRoot, { recursive: true }),
    fs.mkdir(settings.templatesRoot, { recursive: true }),
    fs.mkdir(settings.localMemoryRoot, { recursive: true }),
    fs.mkdir(settings.checkpointsRoot, { recursive: true }),
  ])

  const payload = {
    workspaceRoot: collapseHomePath(settings.workspaceRoot),
    projectsRoot: collapseHomePath(settings.projectsRoot),
    mcpsRoot: collapseHomePath(settings.mcpsRoot),
    templatesRoot: collapseHomePath(settings.templatesRoot),
    localMemoryRoot: collapseHomePath(settings.localMemoryRoot),
    checkpointsRoot: collapseHomePath(settings.checkpointsRoot),
  }

  await fs.writeFile(
    path.join(/*turbopackIgnore: true*/ settings.localMemoryRoot, '.gitignore'),
    '*\n!.gitignore\n',
    { mode: 0o600 },
  )

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
    localMemoryRoot: collapseHomePath(settings.localMemoryRoot),
    checkpointsRoot: collapseHomePath(settings.checkpointsRoot),
  }
  await fs.writeFile(pointerPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
}

export async function getWorkspaceSettings(options: { ensure?: boolean } = {}): Promise<WorkspaceSettings> {
  const envRoot = process.env.FORGE_WORKSPACE_ROOT?.trim()
  const envMcpsRoot = process.env.FORGE_MCPS_ROOT?.trim()
  const storedConfig = envRoot || envMcpsRoot ? { workspaceRoot: null, mcpsRoot: null } : await readStoredWorkspaceConfig()
  const source: WorkspaceSettings['source'] =
    envRoot || envMcpsRoot
      ? 'env'
      : storedConfig.workspaceRoot && normalizeWorkspaceRoot(storedConfig.workspaceRoot) !== defaultWorkspaceRootAbsolute()
        ? 'setting'
        : storedConfig.mcpsRoot
          ? 'setting'
          : 'default'
  const rawRoot = envRoot || storedConfig.workspaceRoot || DEFAULT_WORKSPACE_ROOT
  const workspaceRoot = normalizeWorkspaceRoot(rawRoot)
  const mcpsRoot = normalizeWorkspaceRoot(envMcpsRoot || storedConfig.mcpsRoot || defaultMcpsRootForWorkspace(workspaceRoot))
  if (!isWithinPath(workspaceRoot, mcpsRoot)) {
    throw new Error('MCP root must stay inside the active workspace root.')
  }
  const settings = settingsForRoot(workspaceRoot, source, mcpsRoot)

  if (options.ensure ?? true) {
    await ensureWorkspace(settings)
  }

  return settings
}

export async function saveWorkspaceRoot(rawRoot: string): Promise<WorkspaceSettings> {
  return saveWorkspaceSettings({ workspaceRoot: rawRoot })
}

export async function saveWorkspaceSettings(input: {
  workspaceRoot: string
  mcpsRoot?: string
}): Promise<WorkspaceSettings> {
  if (process.env.FORGE_WORKSPACE_ROOT?.trim() || process.env.FORGE_MCPS_ROOT?.trim()) {
    throw new Error('FORGE_WORKSPACE_ROOT or FORGE_MCPS_ROOT is set, so workspace paths are controlled by the environment.')
  }
  if (input.workspaceRoot.includes('\0') || input.mcpsRoot?.includes('\0')) {
    throw new Error('Workspace root cannot contain null bytes.')
  }
  const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot)
  const mcpsRoot = normalizeWorkspaceRoot(input.mcpsRoot || defaultMcpsRootForWorkspace(workspaceRoot))
  if (!isWithinPath(workspaceRoot, mcpsRoot)) {
    throw new Error('MCP root must stay inside the active workspace root.')
  }
  const settings = settingsForRoot(workspaceRoot, 'setting', mcpsRoot)
  await ensureWorkspace(settings)
  await writeDefaultWorkspacePointer(settings)
  await writeStoredSetting(WORKSPACE_ROOT_SETTING_KEY, workspaceRoot)
  await writeStoredSetting(MCPS_ROOT_SETTING_KEY, mcpsRoot)
  return settings
}

export function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const parent = path.resolve(/*turbopackIgnore: true*/ parentPath)
  const candidate = path.resolve(/*turbopackIgnore: true*/ candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
