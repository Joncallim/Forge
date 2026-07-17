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
  installerAgentType: 'mcp-installer'
  remediation: {
    install: string
    unhealthy: string
    disabled: string
    authRequired?: string
    configurationRequired?: string
  }
  runtime: {
    capabilities: string[]
    mode: 'bounded_context_packet' | 'external_service'
    liveTools: boolean
  }
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
  displayInstallPath?: string
  installState: McpInstallState
  status: McpHealthStatus
  enabled: boolean
  error: string | null
  installerAgentType?: string
  remediation?: {
    action: string
    agentType: string
    detail: string
  }
  checkedAt: string
}

export type ProjectMcpOverview = {
  projectId: string
  /** Internal authority binding; absent legacy/test fixtures fail closed. */
  rootBindingRevision?: string
  config: ProjectMcpConfig
  catalog: McpCatalogEntry[]
  mcpsRoot: string
  displayMcpsRoot?: string
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
