export const FILESYSTEM_MCP_ID = 'filesystem'

export const FILESYSTEM_PROJECT_CAPABILITIES = [
  'filesystem.project.read',
  'filesystem.project.list',
  'filesystem.project.search',
] as const

export type FilesystemProjectCapability = typeof FILESYSTEM_PROJECT_CAPABILITIES[number]

const FILESYSTEM_PROJECT_CAPABILITY_SET = new Set<string>(FILESYSTEM_PROJECT_CAPABILITIES)

export type FilesystemCapabilitySummary = {
  blockingCapabilities: FilesystemProjectCapability[]
  requestedCapabilities: FilesystemProjectCapability[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_')
}

export function canonicalFilesystemProjectCapability(value: unknown): FilesystemProjectCapability | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeCapability(value)
  const match = normalized.match(/^filesystem\.(?:project\.)?(read|list|search)$/)
  if (!match) return null
  const capability = `filesystem.project.${match[1]}` as FilesystemProjectCapability
  return FILESYSTEM_PROJECT_CAPABILITY_SET.has(capability) ? capability : null
}

export function canonicalFilesystemProjectCapabilities(values: unknown): FilesystemProjectCapability[] {
  const capabilities = new Set<FilesystemProjectCapability>()
  if (!Array.isArray(values)) return []
  for (const value of values) {
    const capability = canonicalFilesystemProjectCapability(value)
    if (capability) capabilities.add(capability)
  }
  return [...capabilities].sort()
}

export function hasUnsafeFilesystemCapability(values: unknown): boolean {
  if (!Array.isArray(values)) return false
  return values.some((value) => (
    typeof value === 'string' &&
    normalizeCapability(value).startsWith('filesystem.') &&
    canonicalFilesystemProjectCapability(value) === null
  ))
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : []
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function requirementCapabilities(requirement: Record<string, unknown>): FilesystemProjectCapability[] {
  return canonicalFilesystemProjectCapabilities([
    ...textArray(requirement.permissions),
    ...textArray(requirement.capabilities),
    ...textArray(requirement.requiredCapabilities),
    ...textArray(requirement.mcpCapabilities),
  ])
}

function fallbackAction(value: unknown): string {
  return isRecord(value) && typeof value.action === 'string' ? value.action.trim() : ''
}

export function summarizeFilesystemCapabilities(input: {
  mcpRequirements: unknown
  metadata: unknown
}): FilesystemCapabilitySummary {
  const requested = new Set<FilesystemProjectCapability>()
  const blocking = new Set<FilesystemProjectCapability>()

  for (const requirement of recordArray(input.mcpRequirements)) {
    if (requirement.mcpId !== FILESYSTEM_MCP_ID) continue
    const capabilities = requirementCapabilities(requirement)
    for (const capability of capabilities) requested.add(capability)
    if (requirement.requirement === 'optional' && fallbackAction(requirement.fallback) === 'continue_without_mcp') {
      continue
    }
    for (const capability of capabilities) blocking.add(capability)
  }

  const metadata = isRecord(input.metadata) ? input.metadata : {}
  for (const subtask of recordArray(metadata.mcpAwareSubtasks)) {
    for (const capability of textArray(subtask.mcpCapabilities)) {
      const canonical = canonicalFilesystemProjectCapability(capability)
      if (canonical) requested.add(canonical)
    }
  }
  if (requested.size > 0) requested.add('filesystem.project.read')
  if (blocking.size > 0) blocking.add('filesystem.project.read')

  return {
    blockingCapabilities: [...blocking].sort(),
    requestedCapabilities: [...requested].sort(),
  }
}

export function isExplicitFilesystemEffectivePhase(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 1 &&
    value.phase === 'effective' &&
    value.source === 'explicit-grant-approval' &&
    value.runtimeEnforcement === 'bounded_context_packet' &&
    (value.status === 'approved' || value.status === 'denied')
  )
}

export function filesystemEffectiveGrantApprovalId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.grantApprovalId === 'string' && value.grantApprovalId.length > 0) {
    return value.grantApprovalId
  }
  for (const grant of recordArray(value.grants)) {
    if (typeof grant.grantApprovalId === 'string' && grant.grantApprovalId.length > 0) {
      return grant.grantApprovalId
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Handoff gate: does a package still need explicit filesystem grant approval?
//
// Plan approval does NOT convert Architect-proposed filesystem requirements into
// runtime-effective grants (it records a `not_issued` effective phase). Only the
// explicit grant-approval endpoint issues an approved effective phase. These
// helpers let the handoff gate hold such a package for explicit approval instead
// of running it and burning execution attempts on a guaranteed context block.
// ---------------------------------------------------------------------------

/** Filesystem capabilities carried by an *approved* effective grant phase. */
export function approvedEffectiveFilesystemCapabilities(metadata: unknown): FilesystemProjectCapability[] {
  const meta = isRecord(metadata) ? metadata : {}
  const phases = isRecord(meta.mcpGrantPhases) ? meta.mcpGrantPhases : {}
  const effective = isRecord(phases.effective) ? phases.effective : {}
  if (
    effective.schemaVersion !== 1 ||
    effective.phase !== 'effective' ||
    effective.runtimeEnforcement !== 'bounded_context_packet' ||
    effective.status !== 'approved'
  ) {
    return []
  }
  const capabilities = new Set<FilesystemProjectCapability>()
  for (const grant of recordArray(effective.grants)) {
    if (grant.mcpId !== FILESYSTEM_MCP_ID) continue
    if (grant.status !== 'approved') continue
    for (const capability of canonicalFilesystemProjectCapabilities(grant.capabilities)) {
      capabilities.add(capability)
    }
  }
  return [...capabilities].sort()
}

/**
 * A package requires explicit filesystem grant approval when it has *required*
 * (blocking) filesystem capabilities that an approved effective grant does not
 * yet cover. Optional `continue_without_mcp` requirements never block.
 */
export function requiresFilesystemGrantApproval(input: {
  mcpRequirements: unknown
  metadata: unknown
}): { blocked: boolean; missingCapabilities: FilesystemProjectCapability[]; requestedCapabilities: FilesystemProjectCapability[] } {
  const { blockingCapabilities, requestedCapabilities } = summarizeFilesystemCapabilities(input)
  if (blockingCapabilities.length === 0) {
    return { blocked: false, missingCapabilities: [], requestedCapabilities }
  }
  const approved = approvedEffectiveFilesystemCapabilities(input.metadata)
  const missingCapabilities = blockingCapabilities.filter((capability) => !approved.includes(capability))
  return { blocked: missingCapabilities.length > 0, missingCapabilities, requestedCapabilities }
}

/**
 * Marker written on a package that the handoff gate failed for missing
 * filesystem grants. It is the evidence the grant-recovery endpoint keys off to
 * distinguish a grant block from an unrelated execution/validation failure.
 */
export const FILESYSTEM_GRANT_BLOCK_METADATA_KEY = 'mcpGrantBlock'

export function isFilesystemGrantBlockedPackageMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false
  const marker = metadata[FILESYSTEM_GRANT_BLOCK_METADATA_KEY]
  return isRecord(marker) && marker.source === 'filesystem-grant-approval'
}
