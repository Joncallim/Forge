// ---------------------------------------------------------------------------
// Default discipline workforces (issue #124)
//
// Broad Forge roles assembled into reusable teams. `roles` are agent types
// (matching the seed file names); a role absent from the seeded catalogue is
// skipped so a customised install never fails to seed a workforce. Kept in its
// own module (no DB imports) so the shape and resolver are unit-testable.
// ---------------------------------------------------------------------------

export type DefaultWorkforceDefinition = {
  slug: string
  displayName: string
  description: string
  isDefault: boolean
  roles: string[]
}

export const DEFAULT_WORKFORCES: DefaultWorkforceDefinition[] = [
  {
    slug: 'core-delivery',
    displayName: 'Core delivery',
    description: 'End-to-end team: architect, product, UX, implementation, QA, review, security, and docs.',
    isDefault: true,
    roles: ['architect', 'product', 'ux', 'frontend', 'backend', 'qa', 'reviewer', 'security', 'devops', 'documentation'],
  },
  {
    slug: 'product-discovery',
    displayName: 'Product discovery',
    description: 'Shape the problem and scope before building.',
    isDefault: false,
    roles: ['product', 'ux', 'documentation', 'reviewer'],
  },
  {
    slug: 'ux-ui-delivery',
    displayName: 'UX/UI delivery',
    description: 'User-facing frontend work with product, UX, QA, and review.',
    isDefault: false,
    roles: ['product', 'ux', 'frontend', 'qa', 'reviewer'],
  },
  {
    slug: 'backend-api-delivery',
    displayName: 'Backend/API delivery',
    description: 'Services and data work with QA, security, and review.',
    isDefault: false,
    roles: ['backend', 'qa', 'security', 'reviewer'],
  },
  {
    slug: 'release-deployment',
    displayName: 'Release/deployment',
    description: 'Ship and operate: DevOps, QA, security, release, and docs.',
    isDefault: false,
    roles: ['devops', 'qa', 'security', 'release', 'documentation'],
  },
  {
    slug: 'mcp-setup',
    displayName: 'MCP setup/tooling',
    description: 'Stand up MCP tooling with DevOps, security, and docs.',
    isDefault: false,
    roles: ['mcp-installer', 'devops', 'security', 'documentation'],
  },
]

export type ResolvedWorkforceMember = {
  agentConfigId: string
  sequence: number
  isRequired: boolean
}

/**
 * Resolve a workforce definition's roles to seeded agent-config ids, preserving
 * declared order and skipping roles that were not seeded on this install.
 */
export function resolveWorkforceMembers(
  roles: string[],
  seededIdByType: Map<string, string>,
): ResolvedWorkforceMember[] {
  const members: ResolvedWorkforceMember[] = []
  for (const role of roles) {
    const agentConfigId = seededIdByType.get(role)
    if (!agentConfigId) continue
    members.push({ agentConfigId, sequence: members.length + 1, isRequired: true })
  }
  return members
}
