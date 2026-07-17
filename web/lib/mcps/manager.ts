import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  DEFAULT_PROJECT_MCP_CONFIG,
  mcpInstallations,
  projects,
  projectMcpStatusChecks,
  type Project,
  type ProjectMcpConfig,
} from '@/db/schema'
import { writeWorkspaceFileAtomically } from '@/lib/agent-prompts'
import { getGitHubStatus } from '@/lib/github'
import { assertProjectLocalPathForExecution } from '@/lib/projects/local-path'
import {
  assertWorkspaceManagedPath,
  displayPathForWorkspacePath,
  getWorkspaceSettings,
  isWithinPath,
} from '@/lib/workspace'
import { MCP_CATALOG, RECOMMENDED_MCP_IDS, isKnownMcpId } from './catalog'
import { projectFilesystemGrantFromConfig } from './filesystem-grants'
import type {
  McpCatalogEntry,
  McpHealthStatus,
  McpId,
  McpInstallState,
  McpManifest,
  ProjectMcpOverview,
  ProjectMcpStatus,
} from './types'

type McpInstallationRow = typeof mcpInstallations.$inferSelect
type CachedProjectMcpStatusRow = typeof projectMcpStatusChecks.$inferSelect

function defaultInstallPath(mcpsRoot: string, mcpId: string): string {
  return path.join(/*turbopackIgnore: true*/ mcpsRoot, mcpId)
}

function manifestPath(installPath: string): string {
  return path.join(/*turbopackIgnore: true*/ installPath, 'forge.mcp.json')
}

export function normalizeProjectMcpConfig(rawConfig: Project['mcpConfig'] | null | undefined): ProjectMcpConfig {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : DEFAULT_PROJECT_MCP_CONFIG
  const requiredMcps = Array.isArray(raw.requiredMcps)
    ? Array.from(new Set(raw.requiredMcps.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)))
    : DEFAULT_PROJECT_MCP_CONFIG.requiredMcps
  const filesystemGrant = projectFilesystemGrantFromConfig(raw)
  const grants = filesystemGrant ? { filesystem: filesystemGrant } : undefined

  return {
    profile: raw.profile === 'custom' ? 'custom' : 'default',
    requiredMcps,
    overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
    ...(grants ? { grants } : {}),
  }
}

function catalogEntries(): McpCatalogEntry[] {
  return Object.values(MCP_CATALOG)
}

function remediationForStatus(
  entry: McpCatalogEntry | null,
  installState: McpInstallState,
  status: McpHealthStatus,
): ProjectMcpStatus['remediation'] {
  if (!entry) return undefined
  let action: string | undefined
  if (status === 'disabled') {
    action = entry.remediation.disabled
  } else if (status === 'auth_required') {
    action = entry.remediation.authRequired
  } else if (status === 'configuration_required') {
    action = entry.remediation.configurationRequired
  } else if (status === 'unhealthy') {
    action = entry.remediation.unhealthy
  } else if (installState === 'missing') {
    action = entry.remediation.install
  }
  return action
    ? {
      action,
      agentType: entry.installerAgentType,
      detail: `Use ${entry.installerAgentType} for ${entry.displayName} MCP remediation.`,
    }
    : undefined
}

async function readWorkspaceFileIfRegular(
  filePath: string,
  workspaceRoot: string,
): Promise<string | null> {
  const workspace = path.resolve(/*turbopackIgnore: true*/ workspaceRoot)
  const candidate = path.resolve(/*turbopackIgnore: true*/ filePath)
  if (!isWithinPath(workspace, candidate)) return null

  let realWorkspace: string
  try {
    realWorkspace = await fs.realpath(workspace)
  } catch {
    return null
  }

  let current = workspace
  const relative = path.relative(workspace, candidate)
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.') continue
    current = path.join(/*turbopackIgnore: true*/ current, segment)
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }

    if (stat.isSymbolicLink()) return null
    if (current === candidate) {
      if (!stat.isFile()) return null
      // Open with O_NOFOLLOW and read via the handle so the terminal component
      // cannot be swapped for a symlink (pointing outside the workspace) in the
      // window between the lstat above and the read.
      const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
      let handle: Awaited<ReturnType<typeof fs.open>>
      try {
        handle = await fs.open(candidate, fsConstants.O_RDONLY | noFollow)
      } catch {
        return null
      }
      try {
        const opened = await handle.stat()
        if (!opened.isFile()) return null
        return await handle.readFile('utf-8')
      } finally {
        await handle.close()
      }
    }
    if (!stat.isDirectory()) return null

    const realCurrent = await fs.realpath(current)
    if (!isWithinPath(realWorkspace, realCurrent)) return null
  }

  return null
}

export async function readManifest(installPath: string, workspaceRoot: string): Promise<McpManifest | null> {
  try {
    const raw = await readWorkspaceFileIfRegular(manifestPath(installPath), workspaceRoot)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<McpManifest>
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.id === 'string' &&
      isKnownMcpId(parsed.id) &&
      parsed.source === 'forge-catalog'
    ) {
      return parsed as McpManifest
    }
    return null
  } catch {
    return null
  }
}

async function writeManifest(
  mcpId: keyof typeof MCP_CATALOG,
  installPath: string,
  workspaceRoot: string,
): Promise<void> {
  const entry = MCP_CATALOG[mcpId]
  const manifest: McpManifest = {
    schemaVersion: 1,
    id: entry.id,
    displayName: entry.displayName,
    source: 'forge-catalog',
    createdAt: new Date().toISOString(),
  }
  await assertWorkspaceManagedPath(workspaceRoot, installPath, 'MCP install path')
  await writeWorkspaceFileAtomically(
    manifestPath(installPath),
    `${JSON.stringify(manifest, null, 2)}\n`,
    workspaceRoot,
  )
}

async function listInstallationRows(): Promise<Map<string, McpInstallationRow>> {
  const rows = await db.select().from(mcpInstallations)
  return new Map(rows.map((row) => [row.mcpId, row]))
}

async function upsertInstallation(mcpId: keyof typeof MCP_CATALOG, installPath: string): Promise<void> {
  await db
    .insert(mcpInstallations)
    .values({
      mcpId,
      installPath,
      enabled: true,
      source: 'catalog',
      metadata: { manifest: 'forge.mcp.json' },
    })
    .onConflictDoUpdate({
      target: mcpInstallations.mcpId,
      set: {
        installPath,
        enabled: true,
        source: 'catalog',
        metadata: { manifest: 'forge.mcp.json' },
        updatedAt: new Date(),
      },
    })
}

export async function installMcps(mcpIds: McpId[] = RECOMMENDED_MCP_IDS): Promise<ProjectMcpStatus[]> {
  const workspace = await getWorkspaceSettings()
  const uniqueMcpIds = Array.from(new Set(mcpIds))

  for (const mcpId of uniqueMcpIds) {
    const installPath = defaultInstallPath(workspace.mcpsRoot, mcpId)
    await writeManifest(mcpId, installPath, workspace.workspaceRoot)
    await upsertInstallation(mcpId, installPath)
  }

  const rows = await listInstallationRows()
  return Promise.all(uniqueMcpIds.map((mcpId) => buildStandaloneStatus(mcpId, rows.get(mcpId))))
}

export async function installRecommendedMcps(): Promise<ProjectMcpStatus[]> {
  return installMcps(RECOMMENDED_MCP_IDS)
}

async function buildStandaloneStatus(
  mcpId: string,
  installation: McpInstallationRow | undefined,
): Promise<ProjectMcpStatus> {
  const workspace = await getWorkspaceSettings()
  const entry = isKnownMcpId(mcpId) ? MCP_CATALOG[mcpId] : null
  const installPath = installation?.installPath ?? defaultInstallPath(workspace.mcpsRoot, mcpId)
  const manifest = isWithinPath(workspace.workspaceRoot, installPath)
    ? await readManifest(installPath, workspace.workspaceRoot)
    : null
  const installed = installation !== undefined || manifest?.id === mcpId
  return {
    mcpId,
    displayName: entry?.displayName ?? mcpId,
    description: entry?.description ?? 'Unknown MCP',
    installPath,
    displayInstallPath: displayPathForWorkspacePath(workspace, installPath),
    installState: installed ? 'installed' : 'missing',
    status: installed ? 'unknown' : 'unknown',
    enabled: installation?.enabled ?? true,
    error: installed ? null : 'MCP is not installed.',
    installerAgentType: entry?.installerAgentType,
    remediation: remediationForStatus(entry, installed ? 'installed' : 'missing', 'unknown'),
    checkedAt: new Date().toISOString(),
  }
}

async function classifyProjectMcp(
  project: Project,
  mcpId: string,
  installation: McpInstallationRow | undefined,
  workspace: Awaited<ReturnType<typeof getWorkspaceSettings>>,
): Promise<ProjectMcpStatus> {
  const config = normalizeProjectMcpConfig(project.mcpConfig)
  const override = config.overrides[mcpId]
  const entry = isKnownMcpId(mcpId) ? MCP_CATALOG[mcpId] : null
  const installPath = override?.installPath
    ? path.resolve(/*turbopackIgnore: true*/ override.installPath)
    : installation?.installPath ?? defaultInstallPath(workspace.mcpsRoot, mcpId)
  const enabled = override?.enabled ?? installation?.enabled ?? true
  const checkedAt = new Date().toISOString()

  let installState: McpInstallState = 'missing'
  let status: McpHealthStatus = 'unknown'
  let error: string | null = null

  if (!entry) {
    return {
      mcpId,
      displayName: mcpId,
      description: 'Unknown MCP',
      installPath,
      displayInstallPath: displayPathForWorkspacePath(workspace, installPath),
      installState: 'missing',
      status: 'unhealthy',
      enabled,
      error: 'Unknown MCP id.',
      checkedAt,
    }
  }

  if (!isWithinPath(workspace.workspaceRoot, installPath)) {
    return {
      mcpId,
      displayName: entry.displayName,
      description: entry.description,
      installPath,
      displayInstallPath: displayPathForWorkspacePath(workspace, installPath),
      installState: 'missing',
      status: 'unhealthy',
      enabled,
      error: 'MCP install path must stay inside the active workspace root.',
      installerAgentType: entry.installerAgentType,
      remediation: remediationForStatus(entry, 'missing', 'unhealthy'),
      checkedAt,
    }
  }

  const manifest = await readManifest(installPath, workspace.workspaceRoot)
  installState = installation || manifest ? 'installed' : 'missing'
  if (installState === 'missing') {
    status = 'unknown'
    error = 'MCP is not installed.'
  } else if (!manifest || manifest.id !== mcpId) {
    status = 'unhealthy'
    error = 'MCP manifest is missing, invalid, or belongs to a different MCP.'
  } else if (!enabled) {
    status = 'disabled'
    error = 'MCP is disabled.'
  } else if (mcpId === 'filesystem') {
    if (!project.localPath) {
      status = 'configuration_required'
      error = 'Project has no local path for filesystem access.'
    } else {
      try {
        await assertProjectLocalPathForExecution(project)
        status = 'healthy'
        error = null
      } catch (err) {
        status = 'configuration_required'
        error = err instanceof Error ? err.message : 'Project local path is not available.'
      }
    }
  } else if (mcpId === 'github') {
    const github = await getGitHubStatus()
    status = github.connected ? 'healthy' : 'auth_required'
    error = github.connected ? null : 'Connect GitHub in Settings before using this MCP.'
  } else {
    status = 'unknown'
    error = null
  }

  return {
    mcpId,
    displayName: entry.displayName,
    description: entry.description,
    installPath,
    displayInstallPath: displayPathForWorkspacePath(workspace, installPath),
    installState,
    status,
    enabled,
    error,
    installerAgentType: entry.installerAgentType,
    remediation: remediationForStatus(entry, installState, status),
    checkedAt,
  }
}

async function cacheProjectStatus(projectId: string, status: ProjectMcpStatus): Promise<void> {
  await db
    .insert(projectMcpStatusChecks)
    .values({
      projectId,
      mcpId: status.mcpId,
      status: status.status,
      installState: status.installState,
      error: status.error,
      details: {
        displayName: status.displayName,
        installPath: status.installPath,
        enabled: status.enabled,
        installerAgentType: status.installerAgentType,
        remediation: status.remediation,
      },
      checkedAt: new Date(status.checkedAt),
    })
    .onConflictDoUpdate({
      target: [projectMcpStatusChecks.projectId, projectMcpStatusChecks.mcpId],
      set: {
        status: status.status,
        installState: status.installState,
        error: status.error,
        details: {
          displayName: status.displayName,
          installPath: status.installPath,
          enabled: status.enabled,
          installerAgentType: status.installerAgentType,
          remediation: status.remediation,
        },
        checkedAt: new Date(status.checkedAt),
      },
    })
}

function summarizeStatuses(statuses: ProjectMcpStatus[]): ProjectMcpOverview['summary'] {
  if (statuses.length === 0) {
    return { label: 'MCPs: None selected', status: 'disabled', missing: 0, authRequired: 0, unhealthy: 0, disabled: 0 }
  }

  const missing = statuses.filter((s) => s.installState === 'missing').length
  const authRequired = statuses.filter((s) => s.status === 'auth_required').length
  const unhealthy = statuses.filter((s) => s.status === 'unhealthy' || s.status === 'configuration_required').length
  const disabled = statuses.filter((s) => s.status === 'disabled').length

  if (missing > 0) return { label: `MCPs: ${missing} missing`, status: 'missing', missing, authRequired, unhealthy, disabled }
  if (authRequired > 0) return { label: 'MCPs: GitHub auth required', status: 'auth_required', missing, authRequired, unhealthy, disabled }
  if (unhealthy > 0) return { label: `MCPs: ${unhealthy} need attention`, status: 'configuration_required', missing, authRequired, unhealthy, disabled }
  if (disabled > 0) return { label: `MCPs: ${disabled} disabled`, status: 'disabled', missing, authRequired, unhealthy, disabled }
  return { label: 'MCPs: Healthy', status: 'healthy', missing, authRequired, unhealthy, disabled }
}

function summarizeCachedStatuses(statuses: CachedProjectMcpStatusRow[]): ProjectMcpOverview['summary'] | null {
  if (statuses.length === 0) return null

  return summarizeStatuses(
    statuses.map((status) => ({
      mcpId: status.mcpId,
      displayName: status.mcpId,
      description: '',
      installPath: '',
      installState: status.installState as ProjectMcpStatus['installState'],
      status: status.status as ProjectMcpStatus['status'],
      enabled: true,
      error: status.error,
      checkedAt: status.checkedAt.toISOString(),
    })),
  )
}

export async function getCachedProjectMcpSummaries(
  projectIds: string[],
): Promise<Map<string, ProjectMcpOverview['summary']>> {
  if (projectIds.length === 0) return new Map()

  const rows = await db
    .select()
    .from(projectMcpStatusChecks)
    .where(inArray(projectMcpStatusChecks.projectId, projectIds))

  const byProject = new Map<string, CachedProjectMcpStatusRow[]>()
  for (const row of rows) {
    const statuses = byProject.get(row.projectId) ?? []
    statuses.push(row)
    byProject.set(row.projectId, statuses)
  }

  const summaries = new Map<string, ProjectMcpOverview['summary']>()
  for (const [projectId, statuses] of byProject) {
    const summary = summarizeCachedStatuses(statuses)
    if (summary) summaries.set(projectId, summary)
  }

  return summaries
}

export async function getProjectMcpOverview(
  project: Project,
  options: { cache?: boolean; ensureWorkspace?: boolean } = {},
): Promise<ProjectMcpOverview> {
  const workspace = await getWorkspaceSettings({ ensure: options.ensureWorkspace ?? true })
  const config = normalizeProjectMcpConfig(project.mcpConfig)
  const installations = await listInstallationRows()
  const statuses = await Promise.all(
    config.requiredMcps.map((mcpId) => classifyProjectMcp(project, mcpId, installations.get(mcpId), workspace)),
  )

  if (options.cache ?? true) {
    await Promise.all(statuses.map((status) => cacheProjectStatus(project.id, status)))
  }

  return {
    projectId: project.id,
    config,
    catalog: catalogEntries(),
    mcpsRoot: workspace.mcpsRoot,
    displayMcpsRoot: displayPathForWorkspacePath(workspace, workspace.mcpsRoot),
    statuses,
    summary: summarizeStatuses(statuses),
  }
}

export async function setProjectMcpConfig(project: Project, config: ProjectMcpConfig): Promise<ProjectMcpConfig> {
  const normalized = normalizeProjectMcpConfig(config)
  await db
    .update(projects)
    .set({ mcpConfig: normalized, updatedAt: new Date() })
    .where(eq(projects.id, project.id))

  return normalized
}
