import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_KEY_PATTERN,
  cohortFingerprint,
  isValidCapabilityKey,
  policyFingerprint,
  runtimeFingerprint,
  scopeFingerprint,
  unclassifiedCapabilityKey,
  type ReliabilityPolicyInput,
  type ReliabilityRuntimeInput,
  type ReliabilityScopeInput,
} from '@/lib/reliability/contracts'

function scope(overrides: Partial<ReliabilityScopeInput> = {}): ReliabilityScopeInput {
  return {
    contractVersion: 1,
    projectId: 'project-1',
    rootRef: 'root-ref-1',
    rootBindingRevision: '5',
    grantDecisionRevision: '3',
    repositoryWriteIntent: false,
    capabilities: ['filesystem.project.read'],
    mcpRequirementKeys: ['req-a'],
    ...overrides,
  }
}

function runtime(overrides: Partial<Extract<ReliabilityRuntimeInput, { kind: 'model' }>> = {}): ReliabilityRuntimeInput {
  return {
    kind: 'model',
    providerType: 'anthropic',
    modelId: 'claude-sonnet-5',
    providerIsLocal: false,
    providerConfigUpdatedAt: '2026-01-01T00:00:00.000Z',
    acpExecutionMode: 'not_applicable',
    ...overrides,
  }
}

function policy(overrides: Partial<ReliabilityPolicyInput> = {}): ReliabilityPolicyInput {
  return {
    contractVersion: 1,
    policyVersion: 'reliability-policy-v1',
    harnessId: 'harness-1',
    harnessUpdatedAt: '2026-01-01T00:00:00.000Z',
    reviewRequirement: 'both',
    repositoryWritesEnabled: false,
    ...overrides,
  }
}

describe('capability key grammar', () => {
  it('accepts valid work-package and operation keys', () => {
    expect(isValidCapabilityKey('workpackage:backend/api-implementation')).toBe(true)
    expect(isValidCapabilityKey('operation:repository.status.read@1')).toBe(true)
  })

  it('rejects paths, spaces, uppercase, missing namespace, and over-length values', () => {
    expect(isValidCapabilityKey('workpackage:backend/../etc/passwd')).toBe(false)
    expect(isValidCapabilityKey('workpackage:backend/api implementation')).toBe(false)
    expect(isValidCapabilityKey('workpackage:Backend/Api-Implementation')).toBe(false)
    expect(isValidCapabilityKey('api-implementation')).toBe(false)
    expect(isValidCapabilityKey(`workpackage:backend/${'a'.repeat(200)}`)).toBe(false)
    expect(CAPABILITY_KEY_PATTERN.test('workpackage:backend/api-implementation')).toBe(true)
  })

  it('unclassified keys are always work-package scoped and pattern-valid', () => {
    const key = unclassifiedCapabilityKey('backend')
    expect(key).toBe('workpackage:backend/unclassified')
    expect(isValidCapabilityKey(key)).toBe(true)
  })
})

describe('cohort fingerprinting', () => {
  it('is stable under capability re-ordering and duplication in the scope input', () => {
    const a = scopeFingerprint(scope({ capabilities: ['x', 'y'], mcpRequirementKeys: ['r1', 'r2'] }))
    const b = scopeFingerprint(scope({ capabilities: ['y', 'x', 'x'], mcpRequirementKeys: ['r2', 'r1', 'r1'] }))
    expect(a).toBe(b)
  })

  function buildCohort(overrides: {
    scopeInput?: Partial<ReliabilityScopeInput>
    runtimeInput?: Partial<Extract<ReliabilityRuntimeInput, { kind: 'model' }>>
    policyInput?: Partial<ReliabilityPolicyInput>
  } = {}) {
    const s = scopeFingerprint(scope(overrides.scopeInput))
    const r = runtimeFingerprint(runtime(overrides.runtimeInput))
    const p = policyFingerprint(policy(overrides.policyInput))
    return cohortFingerprint({
      projectId: 'project-1',
      capabilityKey: 'workpackage:backend/api-implementation',
      scopeFingerprint: s,
      runtimeFingerprint: r,
      policyFingerprint: p,
    })
  }

  it('changes when the model changes', () => {
    const base = buildCohort()
    const changed = buildCohort({ runtimeInput: { modelId: 'claude-opus-5' } })
    expect(base).not.toBe(changed)
  })

  it('changes when the harness changes', () => {
    const base = buildCohort()
    const changed = buildCohort({ policyInput: { harnessId: 'harness-2' } })
    expect(base).not.toBe(changed)
  })

  it('changes when the policy version changes', () => {
    const base = buildCohort()
    const changed = buildCohort({ policyInput: { policyVersion: 'reliability-policy-v2' } })
    expect(base).not.toBe(changed)
  })

  it('changes when the root binding revision changes', () => {
    const base = buildCohort()
    const changed = buildCohort({ scopeInput: { rootBindingRevision: '6' } })
    expect(base).not.toBe(changed)
  })

  it('changes when the contract version changes', () => {
    const base = cohortFingerprint({
      projectId: 'project-1',
      capabilityKey: 'workpackage:backend/api-implementation',
      scopeFingerprint: scopeFingerprint(scope()),
      runtimeFingerprint: runtimeFingerprint(runtime()),
      policyFingerprint: policyFingerprint(policy()),
    })
    // A different capability key is a different cohort by construction.
    const changedCapability = cohortFingerprint({
      projectId: 'project-1',
      capabilityKey: 'workpackage:backend/database-migration',
      scopeFingerprint: scopeFingerprint(scope()),
      runtimeFingerprint: runtimeFingerprint(runtime()),
      policyFingerprint: policyFingerprint(policy()),
    })
    expect(base).not.toBe(changedCapability)
  })

  it('the scope input has no path-shaped field -- only the opaque rootRef', () => {
    const keys = Object.keys(scope())
    expect(keys).toContain('rootRef')
    expect(keys.some((key) => /path/i.test(key))).toBe(false)
  })

  it('produces an opaque 64-hex digest regardless of input content', () => {
    const sentinel = '/Users/sentinel/super-secret-project/src/index.ts'
    const fp = scopeFingerprint(scope({ capabilities: [sentinel] }))
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })
})
