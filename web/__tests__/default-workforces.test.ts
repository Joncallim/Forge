import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKFORCES,
  WORKFORCE_SUPERVISOR_AGENT_TYPE,
  WORKFORCE_SUPERVISOR_ROLE_LABEL,
  resolveWorkforceMembers,
} from '@/db/default-workforces'

// Agent types shipped as .codex/agents/*.toml seed defaults.
const KNOWN_ROLES = new Set([
  'architect', 'product', 'ux', 'frontend', 'backend', 'qa',
  'reviewer', 'security', 'devops', 'documentation', 'release', 'mcp-installer',
])

describe('DEFAULT_WORKFORCES', () => {
  it('declares exactly one default workforce', () => {
    expect(DEFAULT_WORKFORCES.filter((w) => w.isDefault)).toHaveLength(1)
    expect(DEFAULT_WORKFORCES.find((w) => w.isDefault)?.slug).toBe('core-delivery')
  })

  it('has unique slugs and multiple discipline teams', () => {
    const slugs = DEFAULT_WORKFORCES.map((w) => w.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(slugs.length).toBeGreaterThanOrEqual(5)
  })

  it('only references known seed roles and never leaves a workforce empty', () => {
    for (const workforce of DEFAULT_WORKFORCES) {
      expect(workforce.roles.length).toBeGreaterThan(0)
      for (const role of workforce.roles) {
        const agentType = typeof role === 'string' ? role : role.agentType
        expect(KNOWN_ROLES.has(agentType)).toBe(true)
      }
    }
  })

  it('assigns an architect supervisor to every default workforce', () => {
    for (const workforce of DEFAULT_WORKFORCES) {
      const [supervisor] = workforce.roles
      expect(supervisor).toMatchObject({
        agentType: WORKFORCE_SUPERVISOR_AGENT_TYPE,
        roleLabel: WORKFORCE_SUPERVISOR_ROLE_LABEL,
        metadata: { workforceSupervisor: true },
      })
    }
  })
})

describe('resolveWorkforceMembers', () => {
  it('resolves roles to ids in declared order with 1-based sequences', () => {
    const byType = new Map([
      ['architect', 'a1'],
      ['backend', 'b1'],
      ['qa', 'q1'],
    ])
    expect(resolveWorkforceMembers(['architect', 'backend', 'qa'], byType)).toEqual([
      { agentConfigId: 'a1', roleLabel: null, sequence: 1, isRequired: true, metadata: {} },
      { agentConfigId: 'b1', roleLabel: null, sequence: 2, isRequired: true, metadata: {} },
      { agentConfigId: 'q1', roleLabel: null, sequence: 3, isRequired: true, metadata: {} },
    ])
  })

  it('preserves workforce role labels and metadata', () => {
    const byType = new Map([
      ['architect', 'a1'],
      ['backend', 'b1'],
    ])
    expect(resolveWorkforceMembers([
      {
        agentType: 'architect',
        roleLabel: WORKFORCE_SUPERVISOR_ROLE_LABEL,
        metadata: { workforceSupervisor: true },
      },
      'backend',
    ], byType)).toEqual([
      {
        agentConfigId: 'a1',
        roleLabel: WORKFORCE_SUPERVISOR_ROLE_LABEL,
        sequence: 1,
        isRequired: true,
        metadata: { workforceSupervisor: true },
      },
      { agentConfigId: 'b1', roleLabel: null, sequence: 2, isRequired: true, metadata: {} },
    ])
  })

  it('skips roles that were not seeded and keeps sequences contiguous', () => {
    const byType = new Map([
      ['product', 'p1'],
      ['reviewer', 'r1'],
    ])
    // 'ux' and 'documentation' absent -> skipped; sequence stays 1..n.
    expect(resolveWorkforceMembers(['product', 'ux', 'documentation', 'reviewer'], byType)).toEqual([
      { agentConfigId: 'p1', roleLabel: null, sequence: 1, isRequired: true, metadata: {} },
      { agentConfigId: 'r1', roleLabel: null, sequence: 2, isRequired: true, metadata: {} },
    ])
  })

  it('returns an empty list when no role is seeded', () => {
    expect(resolveWorkforceMembers(['product', 'ux'], new Map())).toEqual([])
  })
})
