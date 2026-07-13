import { isKnownMcpId, MCP_CATALOG } from './catalog'
import type { ProjectMcpStatus } from './types'

export type McpCapabilityClass =
  | 'planning_only'
  | 'bounded_read_only'
  | 'deferred_live_mcp'
  | 'unknown'

export type McpDeliveryKind = 'bounded_context_packet' | 'planning_context_only'

export const SAFE_READ_SUPPLEMENT: Readonly<Record<'github' | 'filesystem', readonly RegExp[]>> = {
  filesystem: [],
  github: [
    /^github\.actions\.read$/,
    /^github\.repository\.(read|list)$/,
    /^github\.contents\.(list|search)$/,
  ],
}

export const DEFERRED_CAPABILITY_FAMILIES: Readonly<
  Record<'github' | 'filesystem', Readonly<Record<string, readonly string[]>>>
> = {
  github: {
    issues: ['write', 'create', 'update', 'delete', 'close'],
    pull_requests: ['write', 'create', 'update', 'delete', 'merge', 'close', 'approve', 'list', 'get'],
    contents: ['write', 'create', 'update', 'delete'],
    repository: ['write', 'update', 'delete'],
    actions: ['write', 'dispatch', 'cancel'],
    branches: ['read', 'list', 'get', 'create', 'update', 'delete', 'merge'],
    settings: ['read', 'list', 'get', 'write', 'update'],
    secrets: ['read', 'list', 'get', 'write', 'create', 'update', 'delete', 'rotate'],
    workflows: ['read', 'list', 'get', 'run', 'write', 'create', 'update', 'delete', 'dispatch', 'cancel'],
  },
  filesystem: {
    root: ['write', 'delete', 'admin', 'move', 'create'],
    project: ['write', 'delete', 'admin', 'move', 'create'],
  },
}

export const REQUIREMENT_CAPABILITY_FIELDS = [
  'permissions',
  'capabilities',
  'requiredCapabilities',
  'mcpCapabilities',
] as const

export function normalizeCapability(capability: string): string {
  return capability.trim().toLowerCase().replace(/\s+/g, '_')
}

export function canonicalCapabilityForMcp(mcpId: string, capability: string): string {
  const normalized = normalizeCapability(capability)
  if (mcpId === 'filesystem') {
    const match = normalized.match(/^filesystem\.(read|list|search)$/)
    if (match) return `filesystem.project.${match[1]}`
  }
  return normalized
}

export function capabilityMcpId(capability: string): string | null {
  const normalized = normalizeCapability(capability)
  const separator = normalized.indexOf('.')
  if (separator <= 0) return null
  const mcpId = normalized.slice(0, separator)
  return isKnownMcpId(mcpId) ? mcpId : null
}

export function capabilityAddress(
  mcpId: string,
  capability: string,
): { resource: string; operation: string } | null {
  const normalized = normalizeCapability(capability)
  const parts = normalized.split('.')
  if (mcpId === 'github' && parts.length === 3 && parts[0] === 'github' && parts[1] && parts[2]) {
    return { resource: parts[1], operation: parts[2] }
  }
  if (mcpId === 'filesystem' && parts[0] === 'filesystem') {
    if (parts.length === 2 && parts[1]) return { resource: 'root', operation: parts[1] }
    if (parts.length === 3 && parts[1] === 'project' && parts[2]) {
      return { resource: 'project', operation: parts[2] }
    }
  }
  return null
}

function isDeferredCapability(mcpId: string, capability: string): boolean {
  if (!isKnownMcpId(mcpId)) return false
  const address = capabilityAddress(mcpId, capability)
  if (!address) return false
  const families = DEFERRED_CAPABILITY_FAMILIES[mcpId]
  if (!Object.prototype.hasOwnProperty.call(families, address.resource)) return false
  return families[address.resource]?.includes(address.operation) ?? false
}

function isCatalogSafeRead(mcpId: string, capability: string): boolean {
  if (!isKnownMcpId(mcpId)) return false
  const catalogCapabilities = MCP_CATALOG[mcpId].runtime.capabilities
  if (catalogCapabilities.some((candidate) => canonicalCapabilityForMcp(mcpId, candidate) === capability)) return true
  return SAFE_READ_SUPPLEMENT[mcpId].some((pattern) => pattern.test(capability))
}

export function classifyCapability(mcpId: string, capability: string): McpCapabilityClass {
  if (!isKnownMcpId(mcpId)) return 'unknown'
  const canonical = canonicalCapabilityForMcp(mcpId, capability)
  if (!canonical.startsWith(`${mcpId}.`)) return 'unknown'
  if (mcpId === 'filesystem' && canonical === 'filesystem.project.write') return 'planning_only'
  if (isDeferredCapability(mcpId, canonical)) return 'deferred_live_mcp'
  if (isCatalogSafeRead(mcpId, canonical)) return 'bounded_read_only'
  return 'unknown'
}

export function assertSafeCatalogCapabilities(): void {
  const safeOperations = new Set(['read', 'list', 'search', 'get'])
  for (const [mcpId, entry] of Object.entries(MCP_CATALOG)) {
    for (const capability of entry.runtime.capabilities) {
      const canonical = canonicalCapabilityForMcp(mcpId, capability)
      const address = capabilityAddress(mcpId, canonical)
      if (!address || isDeferredCapability(mcpId, canonical) || !safeOperations.has(address.operation)) {
        throw new Error(`MCP catalog capability '${capability}' is not a safe read capability.`)
      }
    }
  }
}

export function mcpDeliveryKind(mcpId: string): McpDeliveryKind | null {
  if (!isKnownMcpId(mcpId)) return null
  return MCP_CATALOG[mcpId].runtime.mode === 'bounded_context_packet'
    ? 'bounded_context_packet'
    : 'planning_context_only'
}

function aliasCoverageKeys(capability: string): string[] {
  const normalized = normalizeCapability(capability)
  const canonical = canonicalCapabilityForMcp('filesystem', normalized)
  const match = canonical.match(/^filesystem\.project\.(read|list|search)$/)
  return match ? [canonical, `filesystem.${match[1]}`] : [normalized]
}

export function coverageKeysForGrant(capability: string): string[] {
  return aliasCoverageKeys(capability)
}

export function coverageKeysForProhibition(capability: string): string[] {
  return aliasCoverageKeys(capability)
}

export function mergeCapabilityFields(entry: Record<string, unknown>): string[] {
  const merged = new Set<string>()
  for (const field of REQUIREMENT_CAPABILITY_FIELDS) {
    const values = entry[field]
    if (!Array.isArray(values)) continue
    for (const value of values) {
      if (typeof value !== 'string') continue
      const normalized = normalizeCapability(value)
      if (normalized) merged.add(normalized)
    }
  }
  return [...merged]
}

export function isMcpHealthy(mcpId: string, status: ProjectMcpStatus | null): boolean {
  return status !== null &&
    status.mcpId === mcpId &&
    status.installState === 'installed' &&
    status.enabled &&
    status.status === 'healthy'
}

export function mcpHealthReason(mcpId: string, status: ProjectMcpStatus | null): string {
  if (!status) return `MCP '${mcpId}' is not configured.`
  if (status.mcpId !== mcpId) return `MCP '${mcpId}' has no matching health observation.`
  if (status.installState !== 'installed') return `MCP '${mcpId}' is not installed (${status.installState}).`
  if (!status.enabled) return `MCP '${mcpId}' is disabled.`
  if (status.status !== 'healthy') {
    const detail = sanitizeMcpError(status.error, 240)
    return detail ? `MCP '${mcpId}' is ${status.status}: ${detail}` : `MCP '${mcpId}' is ${status.status}.`
  }
  return `MCP '${mcpId}' is healthy.`
}

export function sanitizeMcpError(value: unknown, maxLength = 240): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(?:basic|bearer)\s+[^\s,;]+/gi, '[redacted]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(
      /\b(api[ _-]?key|access[ _-]?token|auth(?:entication|orization)?[ _-]?token|authorization|client[ _-]?secret|password|passwd|pwd|secret|private[ _-]?key)\b(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1$2[redacted]',
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|client[_-]?secret|password|passwd|pwd|secret|private[_-]?key)=)[^&#\s]*/gi,
      '$1[redacted]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function canProceedWithoutMcp(
  requirement: { requirement?: unknown } | 'required' | 'optional',
  fallback: { action?: unknown },
): boolean {
  const level = typeof requirement === 'string' ? requirement : requirement.requirement
  return level === 'optional' && fallback.action === 'continue_without_mcp'
}

assertSafeCatalogCapabilities()
