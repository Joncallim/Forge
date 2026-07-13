import { describe, expect, it, vi } from 'vitest'
import { MCP_CATALOG } from '@/lib/mcps/catalog'
import { SAFE_BETA_CAPABILITY_PATTERNS } from '@/worker/mcp-execution-design'
import {
  DEFERRED_CAPABILITY_FAMILIES,
  SAFE_READ_SUPPLEMENT,
  assertSafeCatalogCapabilities,
  canonicalCapabilityForMcp,
  capabilityAddress,
  capabilityMcpId,
  classifyCapability,
  coverageKeysForGrant,
  coverageKeysForProhibition,
  isDeferredCapability,
  isSafeCapabilityText,
  isMcpHealthy,
  mcpHealthReason,
  mcpDeliveryKind,
  mergeCapabilityFields,
  normalizeCapability,
  sanitizeMcpError,
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
    ['github', 'github..read', 'unknown'],
    ['github', 'github.pull_requests. read', 'unknown'],
    ['github', 'github.pull requests.read', 'bounded_read_only'],
    ['github', 'github.pull\nrequests.read', 'unknown'],
    ['github', 'github.pull\trequests.read', 'unknown'],
    ['github', 'github.prototype.write', 'unknown'],
    ['github', 'github.hasOwnProperty.write', 'unknown'],
    ['github', ' unknown.read ', 'unknown'],
    ['github', 'github.filesystem.read', 'unknown'],
    ['github', 'filesystem.project.read', 'unknown'],
    ['filesystem', ' FILESYSTEM.READ ', 'bounded_read_only'],
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

  it.each(['constructor', '__proto__', 'prototype', 'hasOwnProperty', 'toString'])('fails closed for prototype resource %s without throwing', (resource) => {
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

  it('does not merge inherited capability policy fields', () => {
    const inherited = Object.create({ capabilities: ['github.issues.read'] }) as Record<string, unknown>
    expect(mergeCapabilityFields(inherited)).toEqual([])
  })

  it('accepts the checked-in safe catalog', () => {
    expect(() => assertSafeCatalogCapabilities()).not.toThrow()
  })

  it('exports deferred classification and freezes policy-data containers at runtime', () => {
    expect(isDeferredCapability('github', 'github.pull_requests.merge')).toBe(true)
    expect(isDeferredCapability('github', 'github.issues.read')).toBe(false)
    expect(Object.isFrozen(DEFERRED_CAPABILITY_FAMILIES)).toBe(true)
    expect(Object.isFrozen(DEFERRED_CAPABILITY_FAMILIES.github)).toBe(true)
    expect(Object.isFrozen(DEFERRED_CAPABILITY_FAMILIES.github.issues)).toBe(true)
    expect(Object.isFrozen(SAFE_READ_SUPPLEMENT)).toBe(true)
    expect(Object.isFrozen(SAFE_READ_SUPPLEMENT.github)).toBe(true)
    expect(() => (DEFERRED_CAPABILITY_FAMILIES.github.issues as unknown as string[]).push('execute')).toThrow()
    expect(() => (SAFE_READ_SUPPLEMENT.github as unknown as RegExp[]).push(/^github\.issues\.write$/)).toThrow()
  })

  it('keeps mutable RegExp compatibility views isolated from classifier authority', () => {
    const supplementPattern = SAFE_READ_SUPPLEMENT.github[0]
    const originalSource = supplementPattern.source
    const originalFlags = supplementPattern.flags
    try {
      supplementPattern.compile('^filesystem\\.project\\.read$')
      expect(supplementPattern.test('filesystem.project.read')).toBe(true)
      expect(classifyCapability('github', 'filesystem.project.read')).toBe('unknown')
      expect(SAFE_BETA_CAPABILITY_PATTERNS.github.some((pattern) => pattern.test('filesystem.project.read'))).toBe(false)
    } finally {
      supplementPattern.compile(originalSource, originalFlags)
    }
  })

  it('keeps safe-read compatibility negative for deferred and malformed capabilities', () => {
    for (const capability of [
      'github.pull_requests.write',
      'github.pull_requests.merge',
      'github.issues.execute',
      'github.constructor.read',
      'github.pull requests.read',
    ]) {
      expect(SAFE_BETA_CAPABILITY_PATTERNS.github.some((pattern) => pattern.test(capability)), capability).toBe(false)
    }
  })

  it('redacts known GitHub token forms', () => {
    const sanitized = sanitizeMcpError(
      `probe ghp_${'a'.repeat(40)} github_pat_${'b'.repeat(82)} failed`,
      500,
    )
    expect(sanitized).not.toContain('ghp_')
    expect(sanitized).not.toContain('github_pat_')
    expect(sanitized.match(/\[redacted\]/g)).toHaveLength(2)
  })

  it('redacts every well-known token family supported by Forge', () => {
    const credentials = [
      `xoxb-${'a'.repeat(24)}`,
      `glpat-${'b'.repeat(24)}`,
      `AKIA${'C'.repeat(16)}`,
      `AIza${'d'.repeat(24)}`,
      `eyJ${'e'.repeat(12)}.${'f'.repeat(12)}.${'g'.repeat(12)}`,
      `sk_${'h'.repeat(24)}`,
      `sk-ant-${'i'.repeat(24)}`,
    ]
    const sanitized = sanitizeMcpError(`probe ${credentials.join(' ')} failed`, 1_000)
    for (const credential of credentials) expect(sanitized).not.toContain(credential)
    expect(sanitized.match(/\[redacted\]/g)).toHaveLength(credentials.length)
  })

  it('redacts broad secret assignments and structured credential formats', () => {
    const marker = ['fixture', 'super', 'secret', 'value'].join('')
    const secrets = [
      `credential=${marker}`,
      `refresh_token=${marker}`,
      `npm_token=${marker}`,
      `fooCredential: '${marker}'`,
      `redis://:${marker}@localhost:6379/0`,
      `password ${marker}`,
      `host:5432:db:user:${marker}`,
      `{"auth":"${marker}"}`,
      `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----`,
    ]
    for (const secret of secrets) {
      expect(sanitizeMcpError(secret, 1_000), secret).not.toContain(marker)
      expect(isSafeCapabilityText(secret), secret).toBe(false)
    }
  })

  it('requires an exact enabled boolean for MCP health', () => {
    const baseStatus = {
      mcpId: 'filesystem',
      displayName: 'Filesystem',
      description: '',
      installPath: '',
      installState: 'installed' as const,
      status: 'healthy' as const,
      enabled: true,
      error: null,
      checkedAt: '2026-07-13T00:00:00.000Z',
    }
    expect(isMcpHealthy('filesystem', baseStatus)).toBe(true)
    for (const enabled of ['false', 1, {}]) {
      const malformed = { ...baseStatus, enabled: enabled as unknown as boolean }
      expect(isMcpHealthy('filesystem', malformed)).toBe(false)
      expect(mcpHealthReason('filesystem', malformed)).toContain('disabled')
    }
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

  it('classifies an explicit deferred pair before an injected safe-read overlap', () => {
    const capability = 'github.pull_requests.write'
    const originalHas = Set.prototype.has
    const safeReadLookup = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
      this: Set<unknown>,
      value,
    ) {
      return value === capability || originalHas.call(this, value)
    })
    try {
      expect(classifyCapability('github', capability)).toBe('deferred_live_mcp')
      expect(safeReadLookup).not.toHaveBeenCalled()
    } finally {
      safeReadLookup.mockRestore()
    }
  })

  it('keeps classifier authority private from catalog and compatibility-regex mutation', () => {
    MCP_CATALOG.github.runtime.capabilities.push('github.widgets.read')
    try {
      expect(classifyCapability('github', 'github.widgets.read')).toBe('unknown')
    } finally {
      MCP_CATALOG.github.runtime.capabilities.pop()
    }

    const compatibilityPattern = SAFE_BETA_CAPABILITY_PATTERNS.github.find(
      (pattern) => pattern.source === '^github\\.actions\\.read$',
    )
    expect(compatibilityPattern).toBeDefined()
    const originalSource = compatibilityPattern?.source ?? ''
    const originalFlags = compatibilityPattern?.flags ?? ''
    try {
      compatibilityPattern?.compile('^github\\.widgets\\.read$')
      expect(SAFE_BETA_CAPABILITY_PATTERNS.github.some((pattern) => pattern.test('github.widgets.read'))).toBe(true)
      expect(classifyCapability('github', 'github.widgets.read')).toBe('unknown')
      expect(classifyCapability('github', 'github.pull_requests.read')).toBe('bounded_read_only')
      expect(isDeferredCapability('github', 'github.pull_requests.read')).toBe(false)
    } finally {
      compatibilityPattern?.compile(originalSource, originalFlags)
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
