import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { db } from '@/db'
import { appSettings } from '@/db/schema'

export const WORKSPACE_ROOT_SETTING_KEY = 'workspaceRoot'
export const MCPS_ROOT_SETTING_KEY = 'mcpsRoot'
export const DEFAULT_WORKSPACE_ROOT = '~/Documents/Forge'
export const WORKSPACE_DISPLAY_ROOT_ENV_VAR = 'FORGE_WORKSPACE_DISPLAY_ROOT'

export type WorkspaceSettings = {
  workspaceRoot: string
  configRoot: string
  projectsRoot: string
  mcpsRoot: string
  templatesRoot: string
  localMemoryRoot: string
  checkpointsRoot: string
  promptsRoot: string
  agentPromptsRoot: string
  workforcesRoot: string
  runtimeRoot: string
  logsRoot: string
  backupsRoot: string
  forgeEnvPath: string
  globalSettingsPath: string
  source: 'env' | 'setting' | 'default'
  envLocked: boolean
}

export type WorkspaceDisplayPaths = {
  workspaceRoot: string
  configRoot: string
  projectsRoot: string
  mcpsRoot: string
  templatesRoot: string
  localMemoryRoot: string
  checkpointsRoot: string
  promptsRoot: string
  agentPromptsRoot: string
  workforcesRoot: string
  runtimeRoot: string
  logsRoot: string
  backupsRoot: string
  forgeEnvPath: string
  globalSettingsPath: string
}

export type WorkspaceSettingsDto = WorkspaceSettings & {
  displayPaths: WorkspaceDisplayPaths
}

const WORKSPACE_PATH_KEYS = [
  'workspaceRoot',
  'configRoot',
  'projectsRoot',
  'mcpsRoot',
  'templatesRoot',
  'localMemoryRoot',
  'checkpointsRoot',
  'promptsRoot',
  'agentPromptsRoot',
  'workforcesRoot',
  'runtimeRoot',
  'logsRoot',
  'backupsRoot',
  'forgeEnvPath',
  'globalSettingsPath',
] as const

function homeDir(): string {
  return os.homedir() || '/'
}

export function expandHomePath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (trimmed === '~') return homeDir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(/*turbopackIgnore: true*/ homeDir(), trimmed.slice(2))
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

function normalizeDisplayRoot(rawPath: string): string {
  const normalized = rawPath.trim().replace(/\\/g, '/')
  if (normalized === '/') return normalized
  return normalized.replace(/\/+$/g, '') || normalized
}

function configuredWorkspaceDisplayRoot(): string | null {
  const rawRoot = process.env[WORKSPACE_DISPLAY_ROOT_ENV_VAR]?.trim()
  return rawRoot ? normalizeDisplayRoot(rawRoot) : null
}

function defaultWorkspaceDisplayRoot(settings: Pick<WorkspaceSettings, 'workspaceRoot'>): string | null {
  const workspaceRoot = path.resolve(/*turbopackIgnore: true*/ settings.workspaceRoot)
  if (workspaceRoot === defaultWorkspaceRootAbsolute()) return DEFAULT_WORKSPACE_ROOT

  const temporaryRoot = path.resolve(/*turbopackIgnore: true*/ '/var/folders')
  const relativeToTemporaryRoot = path.relative(temporaryRoot, workspaceRoot)
  if (
    relativeToTemporaryRoot !== '' &&
    !relativeToTemporaryRoot.startsWith('..') &&
    !path.isAbsolute(relativeToTemporaryRoot)
  ) {
    return DEFAULT_WORKSPACE_ROOT
  }

  return null
}

function joinDisplayPath(displayRoot: string, relativePath: string): string {
  if (!relativePath) return displayRoot
  const normalizedRelative = relativePath.split(path.sep).join('/')
  if (displayRoot === '/') return `/${normalizedRelative}`
  return `${displayRoot}/${normalizedRelative}`
}

function relativeDisplayPath(displayRoot: string, rawPath: string): string | null {
  const root = normalizeDisplayRoot(displayRoot)
  const candidate = normalizeDisplayRoot(rawPath)
  if (candidate === root) return ''
  if (root === '/') {
    return candidate.startsWith('/') ? candidate.slice(1) : null
  }
  return candidate.startsWith(`${root}/`) ? candidate.slice(root.length + 1) : null
}

function displayRelativeToWorkspace(workspaceRoot: string, candidatePath: string): string | null {
  const workspace = path.resolve(/*turbopackIgnore: true*/ workspaceRoot)
  const candidate = path.resolve(/*turbopackIgnore: true*/ candidatePath)
  const relative = path.relative(workspace, candidate)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return relative
  }
  return null
}

export function displayPathForWorkspacePath(
  settings: Pick<WorkspaceSettings, 'workspaceRoot'>,
  resolvedPath: string,
): string {
  const displayRoot = configuredWorkspaceDisplayRoot() ?? defaultWorkspaceDisplayRoot(settings)
  if (displayRoot) {
    const relative = displayRelativeToWorkspace(settings.workspaceRoot, resolvedPath)
    if (relative !== null) return joinDisplayPath(displayRoot, relative)
  }
  return collapseHomePath(resolvedPath)
}

export function getWorkspaceDisplayPaths(settings: WorkspaceSettings): WorkspaceDisplayPaths {
  return WORKSPACE_PATH_KEYS.reduce((displayPaths, key) => {
    displayPaths[key] = displayPathForWorkspacePath(settings, settings[key])
    return displayPaths
  }, {} as WorkspaceDisplayPaths)
}

export function serializeWorkspaceSettings(settings: WorkspaceSettings): WorkspaceSettingsDto {
  return {
    ...settings,
    displayPaths: getWorkspaceDisplayPaths(settings),
  }
}

function mapDisplayPathToWorkspacePath(
  rawPath: string,
  workspace: Pick<WorkspaceSettings, 'workspaceRoot'>,
): string {
  const trimmed = rawPath.trim()
  const displayRoots = [
    configuredWorkspaceDisplayRoot(),
    defaultWorkspaceDisplayRoot(workspace),
    collapseHomePath(workspace.workspaceRoot),
  ].filter((root): root is string => Boolean(root))

  for (const displayRoot of displayRoots) {
    const relative = relativeDisplayPath(displayRoot, trimmed)
    if (relative === null) continue
    return relative
      ? path.join(/*turbopackIgnore: true*/ workspace.workspaceRoot, ...relative.split('/'))
      : workspace.workspaceRoot
  }

  return trimmed
}

export function resolveWorkspaceInputPath(
  rawPath: string,
  workspace: Pick<WorkspaceSettings, 'workspaceRoot'>,
  basePath: string,
): string {
  const mappedPath = mapDisplayPathToWorkspacePath(rawPath, workspace)
  const expanded = expandHomePath(mappedPath)
  return path.isAbsolute(expanded)
    ? path.resolve(/*turbopackIgnore: true*/ expanded)
    : path.resolve(/*turbopackIgnore: true*/ basePath, expanded)
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
    configRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'config'),
    projectsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'projects'),
    mcpsRoot,
    templatesRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'templates'),
    localMemoryRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'local-memory'),
    checkpointsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'local-memory', 'checkpoints'),
    promptsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'prompts'),
    agentPromptsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'prompts', 'agents'),
    workforcesRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'workforces'),
    runtimeRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'runtime'),
    logsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'logs'),
    backupsRoot: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'backups'),
    forgeEnvPath: path.join(/*turbopackIgnore: true*/ workspaceRoot, 'config', 'forge.env'),
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
    fs.mkdir(settings.configRoot, { recursive: true }),
    fs.mkdir(settings.projectsRoot, { recursive: true }),
    fs.mkdir(settings.mcpsRoot, { recursive: true }),
    fs.mkdir(settings.templatesRoot, { recursive: true }),
    fs.mkdir(settings.localMemoryRoot, { recursive: true }),
    fs.mkdir(settings.checkpointsRoot, { recursive: true }),
    fs.mkdir(settings.promptsRoot, { recursive: true }),
    fs.mkdir(settings.agentPromptsRoot, { recursive: true }),
    fs.mkdir(settings.workforcesRoot, { recursive: true }),
    fs.mkdir(settings.runtimeRoot, { recursive: true }),
    fs.mkdir(settings.logsRoot, { recursive: true }),
    fs.mkdir(settings.backupsRoot, { recursive: true }),
  ])

  const payload = {
    workspaceRoot: collapseHomePath(settings.workspaceRoot),
    configRoot: collapseHomePath(settings.configRoot),
    projectsRoot: collapseHomePath(settings.projectsRoot),
    mcpsRoot: collapseHomePath(settings.mcpsRoot),
    templatesRoot: collapseHomePath(settings.templatesRoot),
    localMemoryRoot: collapseHomePath(settings.localMemoryRoot),
    checkpointsRoot: collapseHomePath(settings.checkpointsRoot),
    promptsRoot: collapseHomePath(settings.promptsRoot),
    agentPromptsRoot: collapseHomePath(settings.agentPromptsRoot),
    workforcesRoot: collapseHomePath(settings.workforcesRoot),
    runtimeRoot: collapseHomePath(settings.runtimeRoot),
    logsRoot: collapseHomePath(settings.logsRoot),
    backupsRoot: collapseHomePath(settings.backupsRoot),
    forgeEnvPath: collapseHomePath(settings.forgeEnvPath),
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

export async function assertWorkspaceManagedPath(
  workspaceRoot: string,
  candidatePath: string,
  label = 'Workspace path',
): Promise<void> {
  const workspace = path.resolve(/*turbopackIgnore: true*/ workspaceRoot)
  const candidate = path.resolve(/*turbopackIgnore: true*/ candidatePath)
  if (!isWithinPath(workspace, candidate)) {
    throw new Error(`${label} must stay inside the active workspace root.`)
  }

  await fs.mkdir(workspace, { recursive: true })
  const realWorkspace = await fs.realpath(workspace)
  const relative = path.relative(workspace, candidate)
  if (relative === '') return

  let current = workspace
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.') continue
    current = path.join(/*turbopackIgnore: true*/ current, segment)
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break
      throw err
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not pass through a symlink.`)
    }

    if (stat.isDirectory()) {
      const realCurrent = await fs.realpath(current)
      if (!isWithinPath(realWorkspace, realCurrent)) {
        throw new Error(`${label} must stay inside the active workspace root.`)
      }
    }
  }
}

async function writeDefaultWorkspacePointer(settings: WorkspaceSettings): Promise<void> {
  if (process.env.NODE_ENV === 'test') return

  const defaultRoot = defaultWorkspaceRootAbsolute()
  if (settings.workspaceRoot === defaultRoot) return

  await fs.mkdir(defaultRoot, { recursive: true })
  const pointerPath = path.join(/*turbopackIgnore: true*/ defaultRoot, 'global-settings.json')
  const payload = {
    workspaceRoot: collapseHomePath(settings.workspaceRoot),
    configRoot: collapseHomePath(settings.configRoot),
    projectsRoot: collapseHomePath(settings.projectsRoot),
    mcpsRoot: collapseHomePath(settings.mcpsRoot),
    templatesRoot: collapseHomePath(settings.templatesRoot),
    localMemoryRoot: collapseHomePath(settings.localMemoryRoot),
    checkpointsRoot: collapseHomePath(settings.checkpointsRoot),
    promptsRoot: collapseHomePath(settings.promptsRoot),
    agentPromptsRoot: collapseHomePath(settings.agentPromptsRoot),
    workforcesRoot: collapseHomePath(settings.workforcesRoot),
    runtimeRoot: collapseHomePath(settings.runtimeRoot),
    logsRoot: collapseHomePath(settings.logsRoot),
    backupsRoot: collapseHomePath(settings.backupsRoot),
    forgeEnvPath: collapseHomePath(settings.forgeEnvPath),
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
    await assertWorkspaceManagedPath(workspaceRoot, mcpsRoot, 'MCP root')
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
  await assertWorkspaceManagedPath(workspaceRoot, mcpsRoot, 'MCP root')
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
