import { describe, expect, it } from 'vitest'
import type { ProjectMcpStatus } from '@/lib/mcps/types'
import {
  admissionToBrokerCheck,
  admissionToGrantPreview,
  admissionToValidation,
  admitMcpRequirement,
  admitWorkPackageMcp,
  readEffectiveGrantState,
  type EffectiveGrantState,
} from '@/lib/mcps/admission'

const checkedAt = '2026-07-13T03:04:05.000Z'

function status(mcpId: string, overrides: Partial<ProjectMcpStatus> = {}): ProjectMcpStatus {
  return {
    mcpId,
    displayName: mcpId,
    description: `${mcpId} MCP`,
    installPath: `/tmp/${mcpId}`,
    installState: 'installed',
    status: 'healthy',
    enabled: true,
    error: null,
    checkedAt,
    ...overrides,
  }
}

const noGrant: EffectiveGrantState = {
  phase: 'none',
  source: 'none',
  status: 'not_issued',
  coveredCapabilities: [],
}

const approvedRead: EffectiveGrantState = {
  phase: 'approved',
  source: 'package-local',
  status: 'approved',
  grantMode: 'allow_once',
  consumed: false,
  coveredCapabilities: ['filesystem.project.read'],
  grantApprovalId: 'grant-read',
}

function requirement(overrides: Record<string, unknown> = {}) {
  return {
    mcpId: 'filesystem',
    agent: 'backend',
    requirement: 'required' as const,
    requestedCapabilities: ['filesystem.project.read'],
    packageProhibitedKeys: new Set<string>(),
    status: status('filesystem'),
    hasPromptOnlyContext: false,
    effectiveGrant: approvedRead,
    fallback: { action: 'block' as const },
    ...overrides,
  }
}

function rawEntry(overrides: Record<string, unknown> = {}) {
  return {
    requirementKey: 'requirement-1',
    sourceRequirementIndex: 0,
    agent: 'backend',
    mcpId: 'filesystem',
    requirement: 'required',
    capabilities: ['filesystem.project.read'],
    prohibitedCapabilities: [],
    assignment: { type: 'agent', targetId: null },
    fallback: { action: 'block', message: 'Context is required.' },
    promptOverlayPresent: false,
    ...overrides,
  }
}

function admitPackage(input: {
  entries?: Array<Record<string, unknown>>
  subtasks?: Array<Record<string, unknown>>
  label?: string
  statusFor?: (mcpId: string) => ProjectMcpStatus | null
  effectiveGrantFor?: (entry: { requirementKey: string; mcpId: string; requiredCapabilities: string[] }) => EffectiveGrantState
  hasPromptOnlyContextFor?: (entry: { requirementKey: string; agent: string; mcpId: string }) => boolean
} = {}) {
  return admitWorkPackageMcp({
    entries: input.entries ?? [rawEntry()],
    subtasks: input.subtasks ?? [],
    label: input.label ?? 'Backend package',
    statusFor: input.statusFor ?? ((mcpId) => status(mcpId)),
    effectiveGrantFor: input.effectiveGrantFor ?? (() => approvedRead),
    hasPromptOnlyContextFor: input.hasPromptOnlyContextFor ?? (() => false),
  })
}

describe('admitMcpRequirement', () => {
  it.each([
    ['required', 'continue_without_mcp', 'blocked', 'blocked'],
    ['required', 'ask_user', 'blocked', 'blocked'],
    ['required', 'block', 'blocked', 'blocked'],
    ['optional', 'continue_without_mcp', 'planning_only', 'warning'],
    ['optional', 'ask_user', 'blocked', 'blocked'],
    ['optional', 'block', 'blocked', 'blocked'],
  ] as const)('covers zero-capability fallback %s / %s', (level, action, mode, admissionStatus) => {
    const decision = admitMcpRequirement(requirement({
      requirement: level,
      requestedCapabilities: [],
      fallback: { action },
      effectiveGrant: noGrant,
    }))
    expect(decision).toMatchObject({ mode, status: admissionStatus })
  })

  it.each(['ask_user', 'block'] as const)('keeps %s blocking for deferred, missing, and unhealthy context', (action) => {
    const deferred = admitMcpRequirement(requirement({
      mcpId: 'github',
      requestedCapabilities: ['github.pull_requests.merge'],
      effectiveGrant: noGrant,
      fallback: { action },
    }))
    const missing = admitMcpRequirement(requirement({ effectiveGrant: noGrant, fallback: { action } }))
    const unhealthy = admitMcpRequirement(requirement({
      status: status('filesystem', { status: 'unhealthy', error: 'probe failed' }),
      fallback: { action },
    }))
    expect([deferred.status, missing.status, unhealthy.status]).toEqual(['blocked', 'blocked', 'blocked'])
  })

  it('warns only for optional continue_without_mcp across deferred, missing, and unhealthy context', () => {
    const common = { requirement: 'optional', fallback: { action: 'continue_without_mcp' as const } }
    const deferred = admitMcpRequirement(requirement({
      ...common,
      mcpId: 'github',
      requestedCapabilities: ['github.pull_requests.merge'],
      effectiveGrant: noGrant,
    }))
    const missing = admitMcpRequirement(requirement({ ...common, effectiveGrant: noGrant }))
    const unhealthy = admitMcpRequirement(requirement({
      ...common,
      status: status('filesystem', { status: 'unhealthy', error: 'probe failed' }),
    }))
    expect([deferred.status, missing.status, unhealthy.status]).toEqual(['warning', 'warning', 'warning'])
  })

  it.each([
    ['filesystem', 'filesystem.project.read', approvedRead],
    ['filesystem', 'filesystem.project.write', noGrant],
    ['github', 'github.issues.read', noGrant],
    ['github', 'github.pull_requests.merge', noGrant],
  ] as const)('applies package prohibition before the %s / %s class branch', (mcpId, capability, grant) => {
    const decision = admitMcpRequirement(requirement({
      mcpId,
      requestedCapabilities: [capability],
      packageProhibitedKeys: new Set([capability]),
      effectiveGrant: grant,
      hasPromptOnlyContext: true,
      requirement: 'optional',
      fallback: { action: 'continue_without_mcp' },
    }))
    expect(decision).toMatchObject({ status: 'blocked', mode: 'blocked', recoveryAction: 'revise_plan' })
  })

  it('blocks unknown MCP ids before fallback', () => {
    expect(admitMcpRequirement(requirement({
      mcpId: 'slack',
      requestedCapabilities: [],
      requirement: 'optional',
      fallback: { action: 'continue_without_mcp' },
    }))).toMatchObject({ status: 'blocked', mode: 'blocked', recoveryAction: 'revise_plan' })
  })

  it('applies package-wide deny before optional fallback handling', () => {
    const decision = admitMcpRequirement(requirement({
      requirement: 'optional',
      requestedCapabilities: ['filesystem.read'],
      packageProhibitedKeys: new Set(['filesystem.project.read']),
      fallback: { action: 'continue_without_mcp' },
    }))
    expect(decision).toMatchObject({ status: 'blocked', mode: 'blocked', recoveryAction: 'revise_plan' })
  })

  it.each([
    ['github.issues.reed'],
    ['filesystem.project. read'],
    ['filesystem.project.read'],
  ])('blocks an invalid or prohibited capability %s with revise_plan', (capability) => {
    const crossMcp = capability === 'filesystem.project.read'
    const decision = admitMcpRequirement(requirement({
      mcpId: 'github',
      requestedCapabilities: [capability],
      packageProhibitedKeys: crossMcp ? new Set() : new Set([capability]),
      effectiveGrant: noGrant,
      requirement: 'optional',
      fallback: { action: 'continue_without_mcp' },
    }))
    expect(decision).toMatchObject({ status: 'blocked', recoveryAction: 'revise_plan' })
  })

  it('does not health-gate materialized GitHub planning context', () => {
    const decision = admitMcpRequirement(requirement({
      mcpId: 'github',
      requestedCapabilities: ['github.issues.read'],
      status: status('github', { status: 'auth_required', error: 'login needed' }),
      hasPromptOnlyContext: true,
      effectiveGrant: noGrant,
    }))
    expect(decision).toMatchObject({ mode: 'planning_only', status: 'allowed', recoveryAction: 'continue_as_prompt_context' })
  })
})

describe('admitWorkPackageMcp', () => {
  it.each(['permissions', 'capabilities', 'requiredCapabilities', 'mcpCapabilities'])('reads the %s requirement field', (field) => {
    const admission = admitPackage({ entries: [rawEntry({ capabilities: undefined, [field]: ['filesystem.project.read'] })] })
    expect(admission.evaluations[0].decision).toMatchObject({
      normalizedCapabilities: ['filesystem.project.read'],
      mode: 'bounded_context_approved',
      status: 'allowed',
    })
  })

  it('narrows filesystem grants per requirement and does not let an optional miss revoke a covered required capability', () => {
    const admission = admitPackage({
      entries: [
        rawEntry({ requirementKey: 'read', capabilities: ['filesystem.project.read'] }),
        rawEntry({
          requirementKey: 'list',
          sourceRequirementIndex: 1,
          requirement: 'optional',
          capabilities: ['filesystem.project.list'],
          fallback: { action: 'continue_without_mcp', message: 'Continue without listing.' },
        }),
      ],
      effectiveGrantFor: ({ requirementKey }) => requirementKey === 'read' ? approvedRead : noGrant,
    })
    expect(admission.evaluations).toHaveLength(2)
    expect(admission.evaluations.map(({ decision }) => [decision.status, decision.mode])).toEqual([
      ['allowed', 'bounded_context_approved'],
      ['warning', 'bounded_context_required'],
    ])
    expect(admission.aggregate.status).toBe('warning')
  })

  it('keeps two same-agent same-MCP requirements distinct by requirementKey', () => {
    const admission = admitPackage({
      entries: [
        rawEntry({ requirementKey: 'allow-read', capabilities: ['filesystem.project.read'] }),
        rawEntry({
          requirementKey: 'deny-search',
          sourceRequirementIndex: 1,
          capabilities: ['filesystem.project.search'],
          prohibitedCapabilities: ['filesystem.project.search'],
          fallback: { action: 'ask_user', message: 'Ask about search.' },
        }),
        {
          requirementKey: 'allow-read',
          decisionId: 'grant-read',
          sourceRequirementIndex: 0,
          agent: 'backend',
          mcpId: 'filesystem',
          requirement: 'required',
          capabilities: ['filesystem.project.read'],
          fallback: { action: 'block', message: 'Context is required.' },
          promptOverlayPresent: false,
        },
        {
          requirementKey: 'deny-search',
          decisionId: 'grant-search',
          sourceRequirementIndex: 1,
          agent: 'backend',
          mcpId: 'filesystem',
          requirement: 'required',
          capabilities: ['filesystem.project.search'],
          fallback: { action: 'ask_user', message: 'Ask about search.' },
          promptOverlayPresent: false,
        },
      ],
      effectiveGrantFor: ({ requiredCapabilities }) => ({
        ...approvedRead,
        coveredCapabilities: requiredCapabilities,
      }),
    })
    expect(admission.evaluations.map((evaluation) => evaluation.source.requirementKey)).toEqual(['allow-read', 'deny-search'])
    expect(admission.evaluations.map(({ decision }) => decision.status)).toEqual(['allowed', 'blocked'])
  })

  it('joins the current raw and derived legacy pair once', () => {
    const admission = admitPackage({
      entries: [
        {
          mcpId: 'filesystem',
          requirement: 'required',
          permissions: ['filesystem.project.read'],
          prohibitedCapabilities: [],
          fallback: { action: 'block', message: 'Required.' },
        },
        {
          decisionId: 'req-0:backend:filesystem',
          sourceRequirementIndex: 0,
          agent: 'backend',
          mcpId: 'filesystem',
          capabilities: ['filesystem.project.read'],
          requirement: 'required',
          status: 'proposed',
          fallback: { action: 'block', message: 'Required.' },
          health: { installState: 'installed', status: 'healthy', enabled: true, error: null },
          promptOverlayPresent: false,
        },
      ],
    })
    expect(admission.evaluations).toHaveLength(1)
    expect(admission.aggregate.warnings).toHaveLength(0)
  })

  it('blocks a grant-only legacy artifact as unknown_legacy', () => {
    const admission = admitPackage({
      entries: [{
        decisionId: 'stale-grant',
        mcpId: 'filesystem',
        capabilities: ['filesystem.project.read'],
        requirement: 'required',
        status: 'blocked',
        fallback: { action: 'block', message: 'Required.' },
      }],
    })
    expect(admission.evaluations).toHaveLength(1)
    expect(admission.evaluations[0].decision).toMatchObject({
      mode: 'unknown_legacy',
      status: 'blocked',
      recoveryAction: 'revise_plan',
    })
  })

  it.each([
    ['github.issues.reed'],
    ['filesystem.project.read'],
    ['github.constructor.write'],
  ])('fails the package closed for invalid prohibition %s', (prohibition) => {
    const admission = admitPackage({
      entries: [rawEntry({
        mcpId: 'github',
        capabilities: ['github.issues.read'],
        prohibitedCapabilities: [prohibition],
      })],
      hasPromptOnlyContextFor: () => true,
    })
    expect(admission.aggregate).toMatchObject({ status: 'blocked', primaryRecoveryAction: 'revise_plan' })
  })

  it('supports planning-only and multi-MCP subtask capabilities', () => {
    const admission = admitPackage({
      entries: [
        rawEntry({ requirementKey: 'fs', capabilities: ['filesystem.project.read'] }),
        rawEntry({
          requirementKey: 'gh',
          sourceRequirementIndex: 1,
          mcpId: 'github',
          capabilities: ['github.issues.read'],
          promptOverlayPresent: true,
        }),
      ],
      subtasks: [{
        id: 'mixed-context',
        agent: 'backend',
        mcpCapabilities: ['filesystem.project.write', 'filesystem.project.read', 'github.issues.read'],
        capabilityBindings: [
          { capability: 'filesystem.project.write', requirementKey: 'fs' },
          { capability: 'filesystem.project.read', requirementKey: 'fs' },
          { capability: 'github.issues.read', requirementKey: 'gh' },
        ],
      }],
      hasPromptOnlyContextFor: ({ requirementKey }) => requirementKey === 'gh',
    })
    expect(admission.subtaskDecisions).toHaveLength(3)
    expect(admission.subtaskDecisions.map((decision) => decision.status)).toEqual(['allowed', 'allowed', 'allowed'])
    expect(new Set(admission.subtaskDecisions.map((decision) => decision.mcpId))).toEqual(new Set(['filesystem', 'github']))
  })

  it('blocks a package-prohibited planning-only subtask', () => {
    const admission = admitPackage({
      entries: [rawEntry({
        capabilities: ['filesystem.project.write'],
        prohibitedCapabilities: ['filesystem.project.write'],
      })],
      subtasks: [{
        id: 'write-plan',
        agent: 'backend',
        mcpCapabilities: ['filesystem.project.write'],
        capabilityBindings: [{ capability: 'filesystem.project.write', requirementKey: 'requirement-1' }],
      }],
      effectiveGrantFor: () => noGrant,
    })
    expect(admission.subtaskDecisions[0]).toMatchObject({ status: 'blocked', recoveryAction: 'revise_plan' })
  })

  it.each([
    {
      name: 'missing requirement',
      entries: [] as Array<Record<string, unknown>>,
      binding: undefined,
      expectedReason: /no matching requirement binding/i,
    },
    {
      name: 'nonexistent requirementKey',
      entries: [rawEntry()],
      binding: { capability: 'filesystem.project.read', requirementKey: 'does-not-exist' },
      expectedReason: /does not identify a matching requirement/i,
    },
    {
      name: 'denied requirement',
      entries: [rawEntry()],
      binding: { capability: 'filesystem.project.read', requirementKey: 'requirement-1' },
      expectedReason: /without approved filesystem context/i,
    },
    {
      name: 'multiple matching requirements',
      entries: [
        rawEntry({ requirementKey: 'first' }),
        rawEntry({ requirementKey: 'second', sourceRequirementIndex: 1 }),
      ],
      binding: undefined,
      expectedReason: /matches multiple requirements/i,
    },
    {
      name: 'cross-agent requirementKey',
      entries: [rawEntry({ agent: 'frontend' })],
      binding: { capability: 'filesystem.project.read', requirementKey: 'requirement-1' },
      expectedReason: /does not identify a matching requirement/i,
    },
  ])('fails closed for requirement-scoped filesystem subtask binding: $name', ({ entries, binding, expectedReason }) => {
    const admission = admitPackage({
      entries,
      subtasks: [{
        id: 'read-files',
        agent: 'backend',
        mcpCapabilities: ['filesystem.project.read'],
        ...(binding ? { capabilityBindings: [binding] } : {}),
      }],
      effectiveGrantFor: ({ requirementKey }) => requirementKey === 'requirement-1' && binding?.requirementKey !== 'requirement-1'
        ? approvedRead
        : noGrant,
    })
    expect(admission.subtaskDecisions[0]).toMatchObject({
      status: 'blocked',
      recoveryAction: expect.stringMatching(/revise_plan|approve_project_filesystem_context/),
    })
    expect(admission.subtaskDecisions[0].reason).toMatch(expectedReason)
  })

  it.each([
    {
      name: 'duplicate bindings',
      bindings: [
        { capability: 'filesystem.project.read', requirementKey: 'requirement-1' },
        { capability: 'filesystem.project.read', requirementKey: 'requirement-1' },
      ],
    },
    {
      name: 'conflicting bindings',
      bindings: [
        { capability: 'filesystem.project.read', requirementKey: 'requirement-1' },
        { capability: 'filesystem.project.read', requirementKey: 'other' },
      ],
    },
  ])('rejects $name for one subtask capability', ({ bindings }) => {
    const admission = admitPackage({
      entries: [rawEntry()],
      subtasks: [{
        id: 'read-files',
        agent: 'backend',
        mcpCapabilities: ['filesystem.project.read'],
        capabilityBindings: bindings,
      }],
    })
    expect(admission.subtaskDecisions[0]).toMatchObject({
      requirementKey: '',
      status: 'blocked',
      recoveryAction: 'revise_plan',
    })
    expect(admission.subtaskDecisions[0].reason).toMatch(/duplicate or conflicting/i)
  })

  it.each([
    ['MCP id', { mcpId: 'filesystem' }],
    ['agent', { agent: 'frontend' }],
    ['source index', { sourceRequirementIndex: 99 }],
  ])('ignores an explicit requirementKey envelope with mismatched %s without leaking prompt context', (_name, mismatch) => {
    const admission = admitPackage({
      entries: [
        rawEntry({
          requirementKey: 'raw-policy',
          mcpId: 'github',
          capabilities: ['github.issues.read'],
          sourceRequirementIndex: 3,
          assignment: { type: 'workforce', targetId: 'raw-workforce' },
        }),
        {
          requirementKey: 'raw-policy',
          decisionId: 'mismatched-envelope',
          sourceRequirementIndex: 3,
          agent: 'backend',
          mcpId: 'github',
          capabilities: ['github.issues.read'],
          requirement: 'required',
          fallback: { action: 'block', message: 'Required.' },
          assignment: { type: 'reviewer_only', targetId: 'wrong-envelope' },
          promptOverlayPresent: true,
          ...mismatch,
        },
      ],
      effectiveGrantFor: () => noGrant,
      hasPromptOnlyContextFor: () => false,
    })

    const rawEvaluation = admission.evaluations.find(({ source }) => source.requirementKey === 'raw-policy')
    expect(rawEvaluation).toBeDefined()
    expect(rawEvaluation?.decision).toMatchObject({ mode: 'blocked', status: 'blocked', recoveryAction: 'revise_plan' })
    expect(rawEvaluation?.source).toMatchObject({
      decisionId: 'req-raw-policy',
      sourceRequirementIndex: 3,
      assignment: { type: 'workforce', targetId: 'raw-workforce' },
      promptOverlayPresent: false,
    })
    expect(admission.evaluations.some(({ decision }) => decision.mode === 'unknown_legacy')).toBe(true)
    expect(admission.aggregate.status).toBe('blocked')
  })

  it('never joins different nonempty requirement keys through legacy fallbacks', () => {
    const admission = admitPackage({
      entries: [
        rawEntry({
          requirementKey: 'raw-a',
          sourceRequirementIndex: 7,
          assignment: { type: 'workforce', targetId: 'raw-team' },
        }),
        {
          requirementKey: 'grant-b',
          decisionId: 'derived-b',
          sourceRequirementIndex: 7,
          agent: 'backend',
          mcpId: 'filesystem',
          capabilities: ['filesystem.project.read'],
          requirement: 'required',
          fallback: { action: 'block', message: 'Context is required.' },
          assignment: { type: 'reviewer_only', targetId: 'grant-reviewer' },
          promptOverlayPresent: true,
        },
      ],
    })

    expect(admission.evaluations).toHaveLength(2)
    expect(admission.evaluations.find(({ source }) => source.requirementKey === 'raw-a')).toMatchObject({
      decision: { mode: 'bounded_context_approved', status: 'allowed' },
      source: {
        decisionId: 'req-raw-a',
        sourceRequirementIndex: 7,
        assignment: { type: 'workforce', targetId: 'raw-team' },
        promptOverlayPresent: false,
      },
    })
    expect(admission.evaluations.find(({ source }) => source.requirementKey === 'grant-b')).toMatchObject({
      decision: { mode: 'unknown_legacy', status: 'blocked', recoveryAction: 'revise_plan' },
      source: { decisionId: 'derived-b' },
    })
    expect(admission.aggregate.status).toBe('blocked')
  })

  it('joins the exact current materializer raw and derived shapes once and preserves raw assignment', () => {
    const admission = admitPackage({
      entries: [
        {
          mcpId: 'filesystem',
          requirement: 'required',
          reason: 'Inspect project files.',
          assignment: { type: 'workforce', targetAgents: ['backend'], targetId: 'delivery-team' },
          permissions: ['filesystem.project.read'],
          prohibitedCapabilities: [],
          fallback: { action: 'block', message: 'Filesystem context is required.' },
        },
        {
          decisionId: 'req-0:backend:filesystem',
          mcpId: 'filesystem',
          capabilities: ['filesystem.project.read'],
          requirement: 'required',
          status: 'proposed',
          reason: 'Inspect project files.',
          fallback: { action: 'block', message: 'Filesystem context is required.' },
          health: { installState: 'installed', status: 'healthy', enabled: true, error: null },
        },
      ],
    })

    expect(admission.evaluations).toHaveLength(1)
    expect(admission.evaluations[0]).toMatchObject({
      decision: { status: 'allowed', mode: 'bounded_context_approved' },
      source: {
        decisionId: 'req-0:backend:filesystem',
        sourceRequirementIndex: 0,
        assignment: { type: 'workforce', targetId: 'delivery-team' },
      },
    })
  })

  it('preserves evidence reference case and meaningful spaces while bounding outer whitespace', () => {
    const admission = admitPackage({
      entries: [rawEntry({
        evidenceRefs: ['  Proof /Repo/My File.ts:17  ', 'Build Log  #ABC'],
      })],
    })
    expect(admission.evaluations[0].decision.evidenceRefs).toEqual([
      'Proof /Repo/My File.ts:17',
      'Build Log #ABC',
    ])
  })

  it('sanitizes controls, bidi, ANSI escapes, and common secret tokens from operator-facing reasons', () => {
    const admission = admitPackage({
      entries: [rawEntry({
        mcpId: 'github',
        capabilities: ['github.issues.read'],
        prohibitedCapabilities: ['github.\u202esecret=TOPSECRET.write'],
      })],
      label: 'Package\u202e\u001b[31m secret=LABELSECRET',
      effectiveGrantFor: () => noGrant,
      statusFor: () => status('github', {
        status: 'unhealthy',
        error: '\u001b[31mprobe failed\u001b[0m \u202e bearer sk-abcdefghijk',
      }),
    })
    const output = JSON.stringify({
      reasons: admission.evaluations.map(({ decision }) => decision.reason),
      blockedReason: admission.aggregate.blockedReason,
    })
    expect(output).not.toMatch(/[\u001b\u202a-\u202e\u2066-\u2069]/u)
    expect(output).not.toMatch(/TOPSECRET|LABELSECRET|sk-abcdefghijk/i)
    expect(output).toContain('[redacted]')
  })

  it('does not turn warning-only missing prompt or unhealthy bounded context into subtask coverage', () => {
    const admission = admitPackage({
      entries: [
        rawEntry({
          requirementKey: 'gh',
          mcpId: 'github',
          requirement: 'optional',
          capabilities: ['github.issues.read'],
          fallback: { action: 'continue_without_mcp', message: 'Continue.' },
        }),
        rawEntry({
          requirementKey: 'fs',
          sourceRequirementIndex: 1,
          requirement: 'optional',
          fallback: { action: 'continue_without_mcp', message: 'Continue.' },
        }),
      ],
      subtasks: [
        { id: 'gh-read', agent: 'backend', mcpCapabilities: ['github.issues.read'], capabilityBindings: [{ capability: 'github.issues.read', requirementKey: 'gh' }] },
        { id: 'fs-read', agent: 'backend', mcpCapabilities: ['filesystem.project.read'], capabilityBindings: [{ capability: 'filesystem.project.read', requirementKey: 'fs' }] },
      ],
      statusFor: (mcpId) => mcpId === 'filesystem'
        ? status('filesystem', { status: 'unhealthy', error: 'probe failed' })
        : status('github'),
      effectiveGrantFor: () => approvedRead,
      hasPromptOnlyContextFor: () => false,
    })
    expect(admission.evaluations.map(({ decision }) => decision.status)).toEqual(['warning', 'warning'])
    expect(admission.subtaskDecisions.map((decision) => decision.status)).toEqual(['blocked', 'blocked'])
  })

  it('preserves observed and absent health snapshots exactly', () => {
    const observed = admitPackage()
    expect(observed.evaluations[0].health).toMatchObject({ observed: true, checkedAt })

    const absent = admitPackage({ statusFor: () => null })
    expect(absent.evaluations[0].health).toEqual({
      schemaVersion: 1,
      observed: false,
      mcpId: 'filesystem',
      installState: 'unknown',
      status: 'unknown',
      enabled: false,
      error: null,
      checkedAt: null,
    })
  })

  it('rejects a healthy status from another MCP without relabelling the snapshot', () => {
    const foreignCheckedAt = '2026-07-13T04:05:06.000Z'
    const foreignError = 'github-only-health-error'
    const admission = admitPackage({
      statusFor: () => status('github', { checkedAt: foreignCheckedAt, error: foreignError }),
    })

    expect(admission.evaluations[0].decision).toMatchObject({
      status: 'blocked',
      recoveryAction: 'install_or_fix_mcp',
    })
    expect(admission.evaluations[0].health).toEqual({
      schemaVersion: 1,
      observed: false,
      mcpId: 'filesystem',
      installState: 'unknown',
      status: 'unknown',
      enabled: false,
      error: null,
      checkedAt: null,
    })
    expect(JSON.stringify(admission)).not.toContain(foreignCheckedAt)
    expect(JSON.stringify(admission)).not.toContain(foreignError)
  })

  it('redacts credential and control text from the admission and every adapter', () => {
    const credential = 'sk-healthsecret123'
    const rawError = `\u001b[31mprobe failed\u001b[0m \u202e bearer ${credential}`
    const admission = admitPackage({
      statusFor: () => status('filesystem', { status: 'unhealthy', error: rawError }),
    })
    const serialized = JSON.stringify({
      admission,
      validation: admissionToValidation(admission),
      preview: admissionToGrantPreview(admission),
      broker: admissionToBrokerCheck(admission),
    })

    expect(serialized).not.toContain(rawError)
    expect(serialized).not.toContain(credential)
    expect(serialized).not.toMatch(/[\u001b\u202a-\u202e\u2066-\u2069]/u)
    expect(serialized).toContain('[redacted]')
  })

  it('exposes deterministic aggregate recovery and shape-preserving adapters', () => {
    const admission = admitPackage({
      entries: [rawEntry({ capabilities: ['filesystem.project.read'] })],
      statusFor: () => status('filesystem', { status: 'unhealthy', error: 'probe failed' }),
    })
    expect(admission.aggregate).toMatchObject({
      status: 'blocked',
      retryable: true,
      primaryMode: 'bounded_context_approved',
      primaryRecoveryAction: 'install_or_fix_mcp',
    })

    const validation = admissionToValidation(admission)
    expect(validation).toMatchObject({ status: 'blocked', health: [expect.objectContaining({ mcpId: 'filesystem' })] })

    const preview = admissionToGrantPreview(admission)
    expect(preview.decisions[0]).toMatchObject({
      status: 'blocked',
      admissionStatus: 'blocked',
      health: expect.objectContaining({ observed: true, checkedAt }),
    })
    expect(preview).toMatchObject({ retryable: true, primaryMode: 'bounded_context_approved', primaryRecoveryAction: 'install_or_fix_mcp' })

    const broker = admissionToBrokerCheck(admission)
    expect(broker).toMatchObject({
      status: 'blocked',
      retryable: true,
      primaryMode: 'bounded_context_approved',
      primaryRecoveryAction: 'install_or_fix_mcp',
    })
  })

  it('maps canonical warning to legacy warnings and allowed preview to proposed', () => {
    const warning = admitPackage({
      entries: [rawEntry({
        capabilities: [],
        requirement: 'optional',
        fallback: { action: 'continue_without_mcp', message: 'Continue.' },
      })],
      effectiveGrantFor: () => noGrant,
    })
    expect(admissionToBrokerCheck(warning).status).toBe('warnings')

    const allowed = admitPackage()
    expect(admissionToGrantPreview(allowed).decisions[0]).toMatchObject({
      status: 'proposed',
      admissionStatus: 'allowed',
      mode: 'bounded_context_approved',
    })
  })
})

describe('readEffectiveGrantState', () => {
  it('distinguishes denied, consumed allow-once, and proposed package phases', () => {
    expect(readEffectiveGrantState({
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'explicit-grant-approval',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'denied',
            grantApprovalId: 'denied-1',
          },
        },
      },
    }, { mcpConfig: {} }, ['filesystem.project.read'])).toMatchObject({
      phase: 'denied',
      source: 'package-local',
      status: 'denied',
    })

    expect(readEffectiveGrantState({
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'explicit-grant-approval',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'approved',
            grantMode: 'allow_once',
            runtimeIssued: true,
            grants: [{ mcpId: 'filesystem', status: 'approved', capabilities: ['filesystem.project.read'] }],
          },
        },
      },
    }, { mcpConfig: {} }, ['filesystem.project.read'])).toMatchObject({
      phase: 'approved',
      source: 'package-local',
      consumed: true,
    })

    expect(readEffectiveGrantState({
      metadata: { mcpGrantPhases: { proposed: [{ mcpId: 'filesystem' }] } },
    }, { mcpConfig: {} }, ['filesystem.project.read'])).toMatchObject({
      phase: 'proposed',
      status: 'not_issued',
    })
  })

  it('accepts only exact explicit grant modes and fails closed for missing or unknown modes', () => {
    const packageForMode = (grantMode: unknown, includeGrantMode = true) => ({
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'explicit-grant-approval',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'approved',
            ...(includeGrantMode ? { grantMode } : {}),
            grants: [{
              mcpId: 'filesystem',
              status: 'approved',
              capabilities: ['filesystem.project.read'],
            }],
          },
        },
      },
    })

    for (const grantMode of ['allow_once', 'always_allow'] as const) {
      expect(readEffectiveGrantState(
        packageForMode(grantMode),
        { mcpConfig: {} },
        ['filesystem.project.read'],
      ), grantMode).toMatchObject({
        phase: 'approved',
        status: 'approved',
        grantMode,
        coveredCapabilities: ['filesystem.project.read'],
      })
    }

    for (const [label, pkg] of [
      ['missing', packageForMode(undefined, false)],
      ['unknown', packageForMode('allow_forever')],
      ['wrong case', packageForMode('ALLOW_ONCE')],
      ['non-string', packageForMode(1)],
    ] as const) {
      expect(readEffectiveGrantState(
        pkg,
        { mcpConfig: {} },
        ['filesystem.project.read'],
      ), label).toMatchObject({ phase: 'none', status: 'not_issued' })
    }
  })

  it('keeps a narrowed project grant approved when it still covers this requirement', () => {
    const pkg = {
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'project-filesystem-approval',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'approved',
            grantApprovalId: 'project-grant',
            grants: [{ mcpId: 'filesystem', status: 'approved', capabilities: ['filesystem.project.read', 'filesystem.project.list'] }],
          },
        },
      },
    }
    const project = {
      mcpConfig: {
        grants: {
          filesystem: {
            schemaVersion: 1,
            mcpId: 'filesystem',
            status: 'approved',
            grantMode: 'always_allow',
            capabilities: ['filesystem.project.read'],
            grantApprovalId: 'project-grant-2',
          },
        },
      },
    }
    expect(readEffectiveGrantState(pkg, project, ['filesystem.project.read'])).toMatchObject({ phase: 'approved' })
    expect(readEffectiveGrantState(pkg, project, ['filesystem.project.read', 'filesystem.project.list'])).toMatchObject({
      phase: 'revoked',
      source: 'project-level',
      revocationReason: expect.any(String),
    })
  })

  it('allows only a later covering project grant to supersede a package denial', () => {
    const deniedPackage = {
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'explicit-grant-approval',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'denied',
            deniedAt: '2026-07-13T09:00:00.000Z',
            grantApprovalId: 'denied-package',
          },
        },
      },
    }
    const projectWithApprovedAt = (approvedAt: unknown) => ({
      mcpConfig: {
        grants: {
          filesystem: {
            schemaVersion: 1,
            mcpId: 'filesystem',
            status: 'approved',
            grantMode: 'always_allow',
            capabilities: ['filesystem.project.read'],
            approvedAt,
            grantApprovalId: 'project-grant',
          },
        },
      },
    })

    expect(readEffectiveGrantState(
      deniedPackage,
      projectWithApprovedAt('2026-07-13T09:00:00.001Z'),
      ['filesystem.project.read'],
    )).toMatchObject({ phase: 'approved', source: 'project-level' })

    for (const approvedAt of [
      '2026-07-13T08:59:59.999Z',
      '2026-07-13T09:00:00.000Z',
      'not-a-timestamp',
      null,
    ]) {
      expect(readEffectiveGrantState(
        deniedPackage,
        projectWithApprovedAt(approvedAt),
        ['filesystem.project.read'],
      ), String(approvedAt)).toMatchObject({ phase: 'denied', source: 'package-local' })
    }
  })

  it('does not let malformed denial timestamps or non-covering later grants override denial', () => {
    const deniedPackage = (deniedAt: unknown) => ({
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'explicit-grant-approval',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'denied',
            deniedAt,
          },
        },
      },
    })
    const project = {
      mcpConfig: {
        grants: {
          filesystem: {
            schemaVersion: 1,
            mcpId: 'filesystem',
            status: 'approved',
            grantMode: 'always_allow',
            capabilities: ['filesystem.project.list'],
            approvedAt: '2026-07-13T10:00:00.000Z',
          },
        },
      },
    }

    expect(readEffectiveGrantState(
      deniedPackage('2026-07-13T09:00:00.000Z'),
      project,
      ['filesystem.project.read'],
    )).toMatchObject({ phase: 'denied', source: 'package-local' })
    expect(readEffectiveGrantState(
      deniedPackage('not-a-timestamp'),
      {
        mcpConfig: {
          grants: {
            filesystem: { ...project.mcpConfig.grants.filesystem, capabilities: ['filesystem.project.read'] },
          },
        },
      },
      ['filesystem.project.read'],
    )).toMatchObject({ phase: 'denied', source: 'package-local' })
  })

  it.each([
    {
      name: 'malformed effective record',
      pkg: {
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              source: 'explicit-grant-approval',
              runtimeEnforcement: 'live_mcp',
              status: 'approved',
              grants: [{ mcpId: 'filesystem', status: 'approved', capabilities: ['filesystem.project.read'] }],
            },
          },
        },
      },
      project: { mcpConfig: {} },
    },
    {
      name: 'malformed project grant',
      pkg: { metadata: {} },
      project: {
        mcpConfig: {
          grants: {
            filesystem: {
              schemaVersion: 1,
              mcpId: 'github',
              status: 'approved',
              grantMode: 'always_allow',
              capabilities: ['filesystem.project.read'],
            },
          },
        },
      },
    },
    {
      name: 'malformed nested grant',
      pkg: {
        metadata: {
          mcpGrantPhases: {
            effective: {
              schemaVersion: 1,
              phase: 'effective',
              source: 'explicit-grant-approval',
              runtimeEnforcement: 'bounded_context_packet',
              status: 'approved',
              grantMode: 'allow_once',
              grants: [{ mcpId: 'filesystem', status: 'approved', capabilities: 'filesystem.project.read' }],
            },
          },
        },
      },
      project: { mcpConfig: {} },
    },
  ])('fails closed for $name', ({ pkg, project }) => {
    const grant = readEffectiveGrantState(pkg, project, ['filesystem.project.read'])
    const decision = admitMcpRequirement(requirement({ effectiveGrant: grant }))

    expect(decision).toMatchObject({
      status: 'blocked',
      mode: 'bounded_context_required',
      recoveryAction: 'approve_project_filesystem_context',
    })
  })

  it('reads the executor persisted consumed phase as an approved consumed grant', () => {
    const result = readEffectiveGrantState({
      metadata: {
        mcpGrantPhases: {
          effective: {
            schemaVersion: 1,
            phase: 'effective',
            source: 'explicit-grant-approval',
            runtimeEnforcement: 'bounded_context_packet',
            status: 'consumed',
            grantMode: 'allow_once',
            runtimeIssued: true,
            consumedAt: '2026-07-13T09:00:00.000Z',
            consumedByAgentRunId: 'run-1',
            consumedOnAttempt: 2,
            grants: [{
              mcpId: 'filesystem',
              status: 'approved',
              capabilities: ['filesystem.project.read'],
            }],
          },
        },
      },
    }, { mcpConfig: {} }, ['filesystem.project.read'])

    expect(result).toMatchObject({
      phase: 'approved',
      source: 'package-local',
      status: 'approved',
      grantMode: 'allow_once',
      consumed: true,
      coveredCapabilities: ['filesystem.project.read'],
    })
  })
})
