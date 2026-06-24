import fs from 'node:fs/promises'
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
import { getGitHubStatus } from '@/lib/github'
import { getWorkspaceSettings, isWithinPath } from '@/lib/workspace'
import { MCP_CATALOG, RECOMMENDED_MCP_IDS, isKnownMcpId } from './catalog'
import type { McpHealthStatus, McpInstallState, McpManifest, ProjectMcpOverview, ProjectMcpStatus } from './types'

type McpInstallationRow = typeof mcpInstallations.$inferSelect
type CachedProjectMcpStatusRow = typeof projectMcpStatusChecks.$inferSelect

function defaultInstallPath(mcpsRoot: string, mcpId: string): string {
  return path.join(/*turbopackIgnore: true*/ mcpsRoot, mcpId)
}

function manifestPath(installPath: string): string {
  return path.join(/*turbopackIgnore: true*/ installPath, 'forge.mcp.json')
}

function normalizeProjectMcpConfig(rawConfig: Project['mcpConfig'] | null | undefined): ProjectMcpConfig {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : DEFAULT_PROJECT_MCP_CONFIG
  const requiredMcps = Array.isArray(raw.requiredMcps) && raw.requiredMcps.length > 0
    ? raw.requiredMcps.filter((id): id is string => typeof id === 'string')
    : DEFAULT_PROJECT_MCP_CONFIG.requiredMcps

  return {
    profile: raw.profile === 'custom' ? 'custom' : 'default',
    requiredMcps,
    overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
  }
}

async function readManifest(installPath: string): Promise<McpManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(installPath), 'utf-8')
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

async function writeManifest(mcpId: keyof typeof MCP_CATALOG, installPath: string): Promise<void> {
  const entry = MCP_CATALOG[mcpId]
  const manifest: McpManifest = {
    schemaVersion: 1,
    id: entry.id,
    displayName: entry.displayName,
    source: 'forge-catalog',
    createdAt: new Date().toISOString(),
  }
  await fs.mkdir(installPath, { recursive: true })
  await fs.writeFile(manifestPath(installPath), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
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

export async function installRecommendedMcps(): Promise<ProjectMcpStatus[]> {
  const workspace = await getWorkspaceSettings()

  for (const mcpId of RECOMMENDED_MCP_IDS) {
    const installPath = defaultInstallPath(workspace.mcpsRoot, mcpId)
    await writeManifest(mcpId, installPath)
    await upsertInstallation(mcpId, installPath)
  }

  const rows = await listInstallationRows()
  return Promise.all(RECOMMENDED_MCP_IDS.map((mcpId) => buildStandaloneStatus(mcpId, rows.get(mcpId))))
}

async function buildStandaloneStatus(
  mcpId: string,
  installation: McpInstallationRow | undefined,
): Promise<ProjectMcpStatus> {
  const workspace = await getWorkspaceSettings()
  const entry = isKnownMcpId(mcpId) ? MCP_CATALOG[mcpId] : null
  const installPath = installation?.installPath ?? defaultInstallPath(workspace.mcpsRoot, mcpId)
  const manifest = await readManifest(installPath)
  const installed = installation !== undefined || manifest?.id === mcpId
  return {
    mcpId,
    displayName: entry?.displayName ?? mcpId,
    description: entry?.description ?? 'Unknown MCP',
    installPath,
    installState: installed ? 'installed' : 'missing',
    status: installed ? 'unknown' : 'unknown',
    enabled: installation?.enabled ?? true,
    error: installed ? null : 'MCP is not installed.',
    checkedAt: new Date().toISOString(),
  }
}

async function classifyProjectMcp(
  project: Project,
  mcpId: string,
  installation: McpInstallationRow | undefined,
): Promise<ProjectMcpStatus> {
  const workspace = await getWorkspaceSettings()
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
      installState: 'missing',
      status: 'unhealthy',
      enabled,
      error: 'MCP install path must stay inside the active workspace root.',
      checkedAt,
    }
  }

  const manifest = await readManifest(installPath)
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
        const stat = await fs.stat(project.localPath)
        status = stat.isDirectory() ? 'healthy' : 'configuration_required'
        error = stat.isDirectory() ? null : 'Project local path is not a directory.'
      } catch {
        status = 'configuration_required'
        error = 'Project local path is missing.'
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
    installState,
    status,
    enabled,
    error,
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
        },
        checkedAt: new Date(status.checkedAt),
      },
    })
}

function summarizeStatuses(statuses: ProjectMcpStatus[]): ProjectMcpOverview['summary'] {
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

export async function getProjectMcpOverview(project: Project): Promise<ProjectMcpOverview> {
  const workspace = await getWorkspaceSettings()
  const config = normalizeProjectMcpConfig(project.mcpConfig)
  const installations = await listInstallationRows()
  const statuses = await Promise.all(
    config.requiredMcps.map((mcpId) => classifyProjectMcp(project, mcpId, installations.get(mcpId))),
  )

  await Promise.all(statuses.map((status) => cacheProjectStatus(project.id, status)))

  return {
    projectId: project.id,
    config,
    mcpsRoot: workspace.mcpsRoot,
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
