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
  // Use an own-property check rather than `in` so inherited Object.prototype
  // members (constructor, __proto__, toString, …) are never treated as known
  // MCP ids. The `in` operator walks the prototype chain, which would let a
  // capability id like `constructor.read` slip past as a "known" MCP.
  return Object.prototype.hasOwnProperty.call(MCP_CATALOG, value)
}
