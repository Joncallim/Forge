import type { ProjectMcpConfig } from '@/db/schema'

export type McpId = 'filesystem' | 'github'

export type McpInstallState = 'installed' | 'missing'

export type McpHealthStatus =
  | 'healthy'
  | 'unhealthy'
  | 'disabled'
  | 'auth_required'
  | 'configuration_required'
  | 'unknown'

export type McpCatalogEntry = {
  id: McpId
  displayName: string
  description: string
  recommended: boolean
  requiresAuth: boolean
}

export type McpManifest = {
  schemaVersion: 1
  id: McpId
  displayName: string
  source: 'forge-catalog'
  createdAt: string
}

export type ProjectMcpStatus = {
  mcpId: string
  displayName: string
  description: string
  installPath: string
  installState: McpInstallState
  status: McpHealthStatus
  enabled: boolean
  error: string | null
  checkedAt: string
}

export type ProjectMcpOverview = {
  projectId: string
  config: ProjectMcpConfig
  mcpsRoot: string
  statuses: ProjectMcpStatus[]
  summary: {
    label: string
    status: McpHealthStatus | 'missing'
    missing: number
    authRequired: number
    unhealthy: number
    disabled: number
  }
}
