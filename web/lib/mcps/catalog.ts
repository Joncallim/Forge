import type { McpCatalogEntry, McpId } from './types'

export const MCP_CATALOG: Record<McpId, McpCatalogEntry> = {
  filesystem: {
    id: 'filesystem',
    displayName: 'Filesystem',
    description: 'Gives agents controlled access to project files in the active workspace.',
    recommended: true,
    requiresAuth: false,
    installerAgentType: 'mcp-installer',
    remediation: {
      install: 'Ask the MCP Installer agent to install the filesystem catalog manifest under the shared Forge MCP root.',
      unhealthy: 'Ask the MCP Installer agent to verify the filesystem manifest and workspace-managed install path.',
      disabled: 'Enable the filesystem MCP in the project MCP settings before running filesystem-aware packages.',
      configurationRequired: 'Set a valid project local path inside the workspace before filesystem context can be issued.',
    },
    runtime: {
      capabilities: ['filesystem.project.read', 'filesystem.project.list', 'filesystem.project.search'],
      mode: 'bounded_context_packet',
      liveTools: false,
    },
  },
  github: {
    id: 'github',
    displayName: 'GitHub',
    description: 'Lets agents inspect repositories, issues, pull requests, and related GitHub state.',
    recommended: true,
    requiresAuth: true,
    installerAgentType: 'mcp-installer',
    remediation: {
      install: 'Ask the MCP Installer agent to install the GitHub catalog manifest under the shared Forge MCP root.',
      unhealthy: 'Ask the MCP Installer agent to verify the GitHub manifest and workspace-managed install path.',
      disabled: 'Enable the GitHub MCP in the project MCP settings before running GitHub-aware packages.',
      authRequired: 'Connect GitHub in Settings before using GitHub-aware packages.',
    },
    runtime: {
      capabilities: ['github.issues.read', 'github.pull_requests.read', 'github.contents.read', 'github.repository.search'],
      mode: 'external_service',
      liveTools: false,
    },
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
