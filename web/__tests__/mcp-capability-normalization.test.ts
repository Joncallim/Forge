import { describe, expect, it } from 'vitest'
import { MCP_CATALOG } from '@/lib/mcps/catalog'
import { SAFE_BETA_CAPABILITY_PATTERNS } from '@/worker/mcp-execution-design'
import {
  DEFERRED_CAPABILITY_FAMILIES,
  assertSafeCatalogCapabilities,
  canonicalCapabilityForMcp,
  capabilityAddress,
  capabilityMcpId,
  classifyCapability,
  coverageKeysForGrant,
  coverageKeysForProhibition,
  mcpDeliveryKind,
  mergeCapabilityFields,
  normalizeCapability,
} from '@/lib/mcps/capability-normalization'

describe('MCP capability normalization', () => {
  it('normalizes only outer/case/ordinary-whitespace differences', () => {
    expect(normalizeCapability('  GitHub.Issues.Read  ')).toBe('github.issues.read')
    expect(normalizeCapability('filesystem.project. read')).toBe('filesystem.project._read')
    expect(canonicalCapabilityForMcp('filesystem', ' FILESYSTEM.READ ')).toBe('filesystem.project.read')
    expect(canonicalCapabilityForMcp('filesystem', 'filesystem.write')).toBe('filesystem.write')
  })

  it.each([
    ['filesystem.project.read', 'filesystem', 'filesystem', { resource: 'project', operation: 'read' }],
    ['filesystem.read', 'filesystem', 'filesystem', { resource: 'root', operation: 'read' }],
    ['github.pull_requests.merge', 'github', 'github', { resource: 'pull_requests', operation: 'merge' }],
    ['filesystem..write', 'filesystem', 'filesystem', null],
    ['github.issues', 'github', 'github', null],
    ['github.issues.read.extra', 'github', 'github', null],
    ['slack.messages.read', 'slack', null, null],
  ])('parses the exact address shape for %s', (capability, mcpId, expectedMcpId, expected) => {
    expect(capabilityMcpId(capability)).toBe(expectedMcpId)
    expect(capabilityAddress(mcpId, normalizeCapability(capability))).toEqual(expected)
  })

  it.each([
    ['filesystem', 'filesystem.project.read', 'bounded_read_only'],
    ['filesystem', 'filesystem.project.list', 'bounded_read_only'],
    ['filesystem', 'filesystem.project.search', 'bounded_read_only'],
    ['filesystem', 'filesystem.read', 'bounded_read_only'],
    ['filesystem', 'filesystem.list', 'bounded_read_only'],
    ['filesystem', 'filesystem.search', 'bounded_read_only'],
    ['filesystem', 'filesystem.project.write', 'planning_only'],
    ['filesystem', 'filesystem.write', 'deferred_live_mcp'],
    ['filesystem', 'filesystem.project.delete', 'deferred_live_mcp'],
    ['filesystem', 'filesystem..write', 'unknown'],
    ['filesystem', 'filesystem.root.write', 'unknown'],
    ['github', 'github.issues.read', 'bounded_read_only'],
    ['github', 'github.pull_requests.read', 'bounded_read_only'],
    ['github', 'github.actions.read', 'bounded_read_only'],
    ['github', 'github.repository.read', 'bounded_read_only'],
    ['github', 'github.repository.list', 'bounded_read_only'],
    ['github', 'github.contents.list', 'bounded_read_only'],
    ['github', 'github.contents.search', 'bounded_read_only'],
    ['github', 'github.pull_requests.write', 'deferred_live_mcp'],
    ['github', 'github.branches.create', 'deferred_live_mcp'],
    ['github', 'github.secrets.read', 'deferred_live_mcp'],
    ['github', 'github.issues.reed', 'unknown'],
    ['github', 'github.pull_requests.reed', 'unknown'],
    ['github', 'github.secrets.banana', 'unknown'],
    ['github', 'github.workflows.frobnicate', 'unknown'],
    ['github', 'github.secerts.write', 'unknown'],
    ['github', 'github.actions.merge', 'unknown'],
    ['github', 'github.settings.approve', 'unknown'],
    ['github', 'filesystem.project.write', 'unknown'],
    ['slack', 'slack.messages.read', 'unknown'],
    ['github', 'github.issues. read', 'unknown'],
    ['github', '', 'unknown'],
  ] as const)('classifies %s / %s as %s', (mcpId, capability, expected) => {
    expect(classifyCapability(mcpId, capability)).toBe(expected)
  })

  it('classifies every explicit deferred resource and operation pair', () => {
    for (const [mcpId, families] of Object.entries(DEFERRED_CAPABILITY_FAMILIES)) {
      for (const [resource, operations] of Object.entries(families)) {
        for (const operation of operations) {
          const capability = mcpId === 'filesystem' && resource === 'root'
            ? `${mcpId}.${operation}`
            : `${mcpId}.${resource}.${operation}`
          const expected = capability === 'filesystem.project.write' ? 'planning_only' : 'deferred_live_mcp'
          expect(classifyCapability(mcpId, capability), capability).toBe(expected)
        }
      }
    }
  })

  it.each(['constructor', '__proto__', 'toString'])('fails closed for prototype resource %s without throwing', (resource) => {
    expect(() => classifyCapability('github', `github.${resource}.write`)).not.toThrow()
    expect(classifyCapability('github', `github.${resource}.write`)).toBe('unknown')
  })

  it('derives delivery from the catalog and returns null for unknown MCPs', () => {
    expect(mcpDeliveryKind('filesystem')).toBe('bounded_context_packet')
    expect(mcpDeliveryKind('github')).toBe('planning_context_only')
    expect(mcpDeliveryKind('slack')).toBeNull()
    expect(mcpDeliveryKind('constructor')).toBeNull()
  })

  it.each(['read', 'list', 'search'])('uses symmetric grant/prohibition aliases for filesystem.%s', (operation) => {
    const qualified = `filesystem.project.${operation}`
    const unqualified = `filesystem.${operation}`
    expect(coverageKeysForGrant(qualified)).toEqual(coverageKeysForProhibition(qualified))
    expect(coverageKeysForGrant(unqualified)).toEqual(coverageKeysForProhibition(unqualified))
    expect(new Set(coverageKeysForGrant(qualified))).toEqual(new Set([qualified, unqualified]))
    expect(new Set(coverageKeysForGrant(unqualified))).toEqual(new Set([qualified, unqualified]))
  })

  it('merges exactly the four requirement capability fields', () => {
    expect(mergeCapabilityFields({
      permissions: ['github.issues.read'],
      capabilities: ['github.contents.read'],
      requiredCapabilities: ['github.repository.read'],
      mcpCapabilities: ['github.actions.read'],
      prohibitedCapabilities: ['github.issues.read'],
      unrelated: ['github.secrets.read'],
    })).toEqual([
      'github.issues.read',
      'github.contents.read',
      'github.repository.read',
      'github.actions.read',
    ])
  })

  it('accepts the checked-in safe catalog', () => {
    expect(() => assertSafeCatalogCapabilities()).not.toThrow()
  })

  it('rejects unsafe catalog verbs and deferred overlap', () => {
    MCP_CATALOG.github.runtime.capabilities.push('github.issues.execute')
    try {
      expect(() => assertSafeCatalogCapabilities()).toThrow(/safe|operation|verb/i)
    } finally {
      MCP_CATALOG.github.runtime.capabilities.pop()
    }

    MCP_CATALOG.github.runtime.capabilities.push('github.pull_requests.write')
    try {
      expect(() => assertSafeCatalogCapabilities()).toThrow(/safe|deferred|overlap/i)
      expect(classifyCapability('github', 'github.pull_requests.write')).toBe('deferred_live_mcp')
    } finally {
      MCP_CATALOG.github.runtime.capabilities.pop()
    }
  })

  it.each([
    ['filesystem', 'filesystem.project.read'],
    ['filesystem', 'filesystem.read'],
    ['filesystem', 'filesystem.project.list'],
    ['filesystem', 'filesystem.list'],
    ['filesystem', 'filesystem.project.search'],
    ['filesystem', 'filesystem.search'],
    ['github', 'github.issues.read'],
    ['github', 'github.pull_requests.read'],
    ['github', 'github.contents.read'],
    ['github', 'github.repository.search'],
    ['github', 'github.actions.read'],
    ['github', 'github.repository.read'],
    ['github', 'github.repository.list'],
    ['github', 'github.contents.list'],
    ['github', 'github.contents.search'],
  ])('preserves SAFE_BETA compatibility for %s / %s', (mcpId, capability) => {
    expect(SAFE_BETA_CAPABILITY_PATTERNS[mcpId].some((pattern) => pattern.test(capability))).toBe(true)
  })
})
