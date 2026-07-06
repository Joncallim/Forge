// ---------------------------------------------------------------------------
// Default discipline workforces (issue #124)
//
// Broad Forge roles assembled into reusable teams. `roles` are agent types or
// agent entries with workforce-local labels/metadata; a role absent from the
// seeded catalogue is skipped so a customised install never fails to seed a
// workforce. Kept in its own module (no DB imports) so the shape and resolver
// are unit-testable.
// ---------------------------------------------------------------------------

export const WORKFORCE_SUPERVISOR_AGENT_TYPE = 'architect'
export const WORKFORCE_SUPERVISOR_ROLE_LABEL = 'Workforce supervisor'

export const WORKFORCE_SUPERVISOR_METADATA: Record<string, unknown> = {
  workforceSupervisor: true,
  responsibility: 'Manage workflow inside this workforce.',
}

export type DefaultWorkforceRole = string | {
  agentType: string
  roleLabel?: string
  isRequired?: boolean
  metadata?: Record<string, unknown>
}

export type DefaultWorkforceDefinition = {
  slug: string
  displayName: string
  description: string
  isDefault: boolean
  roles: DefaultWorkforceRole[]
}

function workforceSupervisorRole(): DefaultWorkforceRole {
  return {
    agentType: WORKFORCE_SUPERVISOR_AGENT_TYPE,
    roleLabel: WORKFORCE_SUPERVISOR_ROLE_LABEL,
    metadata: WORKFORCE_SUPERVISOR_METADATA,
  }
}

function supervisedRoles(agentTypes: string[]): DefaultWorkforceRole[] {
  return [
    workforceSupervisorRole(),
    ...agentTypes,
  ]
}

export const DEFAULT_WORKFORCES: DefaultWorkforceDefinition[] = [
  {
    slug: 'core-delivery',
    displayName: 'Core delivery',
    description: 'End-to-end team: architect, product, UX, implementation, QA, review, security, and docs.',
    isDefault: true,
    roles: supervisedRoles(['product', 'ux', 'frontend', 'backend', 'qa', 'reviewer', 'security', 'devops', 'documentation']),
  },
  {
    slug: 'product-discovery',
    displayName: 'Product discovery',
    description: 'Shape the problem and scope before building.',
    isDefault: false,
    roles: supervisedRoles(['product', 'ux', 'documentation', 'reviewer']),
  },
  {
    slug: 'ux-ui-delivery',
    displayName: 'UX/UI delivery',
    description: 'User-facing frontend work with product, UX, QA, and review.',
    isDefault: false,
    roles: supervisedRoles(['product', 'ux', 'frontend', 'qa', 'reviewer']),
  },
  {
    slug: 'backend-api-delivery',
    displayName: 'Backend/API delivery',
    description: 'Services and data work with QA, security, and review.',
    isDefault: false,
    roles: supervisedRoles(['backend', 'qa', 'security', 'reviewer']),
  },
  {
    slug: 'release-deployment',
    displayName: 'Release/deployment',
    description: 'Ship and operate: DevOps, QA, security, release, and docs.',
    isDefault: false,
    roles: supervisedRoles(['devops', 'qa', 'security', 'release', 'documentation']),
  },
  {
    slug: 'mcp-setup',
    displayName: 'MCP setup/tooling',
    description: 'Stand up MCP tooling with DevOps, security, and docs.',
    isDefault: false,
    roles: supervisedRoles(['mcp-installer', 'devops', 'security', 'documentation']),
  },
]

export type ResolvedWorkforceMember = {
  agentConfigId: string
  roleLabel: string | null
  sequence: number
  isRequired: boolean
  metadata: Record<string, unknown>
}

function roleAgentType(role: DefaultWorkforceRole): string {
  return typeof role === 'string' ? role : role.agentType
}

function roleLabel(role: DefaultWorkforceRole): string | null {
  return typeof role === 'string' ? null : role.roleLabel ?? null
}

function roleRequired(role: DefaultWorkforceRole): boolean {
  return typeof role === 'string' ? true : role.isRequired ?? true
}

function roleMetadata(role: DefaultWorkforceRole): Record<string, unknown> {
  return typeof role === 'string' ? {} : role.metadata ?? {}
}

/**
 * Resolve a workforce definition's roles to seeded agent-config ids, preserving
 * declared order and skipping roles that were not seeded on this install.
 */
export function resolveWorkforceMembers(
  roles: DefaultWorkforceRole[],
  seededIdByType: Map<string, string>,
): ResolvedWorkforceMember[] {
  const members: ResolvedWorkforceMember[] = []
  for (const role of roles) {
    const agentConfigId = seededIdByType.get(roleAgentType(role))
    if (!agentConfigId) continue
    members.push({
      agentConfigId,
      roleLabel: roleLabel(role),
      sequence: members.length + 1,
      isRequired: roleRequired(role),
      metadata: roleMetadata(role),
    })
  }
  return members
}
