import type { McpCatalogEntry, McpId } from './types'

export const MCP_CATALOG: Record<McpId, McpCatalogEntry> = {
  filesystem: {
    id: 'filesystem',
    displayName: 'Filesystem',
    description: 'Gives agents controlled access to project files in the active workspace.',
    recommended: true,
    requiresAuth: false,
  },
  github: {
    id: 'github',
    displayName: 'GitHub',
    description: 'Lets agents inspect repositories, issues, pull requests, and related GitHub state.',
    recommended: true,
    requiresAuth: true,
  },
}

export const RECOMMENDED_MCP_IDS = Object.values(MCP_CATALOG)
  .filter((entry) => entry.recommended)
  .map((entry) => entry.id)

export function isKnownMcpId(value: string): value is McpId {
  return value in MCP_CATALOG
}
