import { describe, expect, it } from 'vitest'

import { createOperationCatalog } from '@/lib/operations/catalog'
import { type OperationDefinition } from '@/lib/operations/contracts'
import { parseVerificationGoalDefinition } from '@/lib/verification-goals/contracts'
import {
  buildVerificationGoalExecutionBindingV1,
  executableVerificationGoalDefinitionDigest,
  parseExecutableVerificationGoalDefinition,
} from '@/lib/verification-goals/executable-contracts'
import {
  resolveVerificationGoalOperationBinding,
  verificationGoalEligibilityPolicyDigest,
} from '@/lib/verification-goals/eligibility'

function definition(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    goalId: 'repository-readable',
    definitionVersion: 2,
    title: 'Repository remains readable',
    description: 'Forge can inspect the trusted project through bounded deterministic reads.',
    capability: 'filesystem.project.read',
    severity: 'high',
    enabled: true,
    operations: [
      { operationId: 'repository.status.read', operationVersion: 1 },
      { operationId: 'repository.branch.read', operationVersion: 1 },
    ],
    execution: {
      manual: true,
      schedule: null,
      deadlineSeconds: 120,
      requiredEvidence: ['operation_evidence', 'repository_identity'],
    },
    ...overrides,
  }
}

describe('executable verification goal v2 contracts', () => {
  it('parses a strict v2 goal, canonicalizes ordering, and builds an execution binding', () => {
    const parsed = parseExecutableVerificationGoalDefinition(definition())

    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.operations).toEqual([
      { operationId: 'repository.branch.read', operationVersion: 1 },
      { operationId: 'repository.status.read', operationVersion: 1 },
    ])
    expect(parsed.execution.requiredEvidence).toEqual([
      'operation_evidence',
      'repository_identity',
    ])

    const binding = buildVerificationGoalExecutionBindingV1(parsed)
    expect(binding.schemaVersion).toBe(1)
    expect(binding.operations.map((operation) => operation.operationId)).toEqual([
      'repository.branch.read',
      'repository.status.read',
    ])
    expect(binding.operations.every((operation) => operation.eligibility === 'manual_and_scheduled')).toBe(true)
    expect(binding.operations.every((operation) => operation.executionProfile.failureClassifier === 'inconclusive_only')).toBe(true)
    expect(binding.executionBindingDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(binding.eligibilityPolicyDigest).toBe(verificationGoalEligibilityPolicyDigest())
  })

  it('keeps schema v1 definition semantics unchanged', () => {
    expect(() => parseVerificationGoalDefinition(definition())).toThrow(
      'Verification goal must contain exactly the v1 definition keys.',
    )
  })

  it('rejects arbitrary command or policy fields before execution binding', () => {
    const withCommand = definition({
      execution: {
        manual: true,
        schedule: null,
        deadlineSeconds: 120,
        requiredEvidence: [],
        command: 'npm test',
      },
    })

    expect(() => parseExecutableVerificationGoalDefinition(withCommand)).toThrow(
      'Verification goal execution must contain exactly manual, schedule, deadlineSeconds, and requiredEvidence.',
    )
  })

  it('rejects an enabled goal with no manual or scheduled trigger', () => {
    expect(() => parseExecutableVerificationGoalDefinition(definition({
      execution: {
        manual: false,
        schedule: null,
        deadlineSeconds: 120,
        requiredEvidence: [],
      },
    }))).toThrow(
      'An enabled executable verification goal must allow manual execution or declare a schedule.',
    )
  })

  it('rejects duplicate requested evidence', () => {
    expect(() => parseExecutableVerificationGoalDefinition(definition({
      execution: {
        manual: true,
        schedule: null,
        deadlineSeconds: 120,
        requiredEvidence: ['repository_identity', 'repository_identity'],
      },
    }))).toThrow('Verification goal requiredEvidence contains duplicate repository_identity.')
  })

  it('rejects operation capability mismatch', () => {
    expect(() => parseExecutableVerificationGoalDefinition(definition({
      capability: 'filesystem.project.write',
    }))).toThrow('does not match the goal capability')
  })

  it('does not make an unlisted Operation Catalog entry goal-executable', () => {
    const base = resolveVerificationGoalOperationBinding({
      operationId: 'repository.status.read',
      operationVersion: 1,
      goalCapability: 'filesystem.project.read',
      trigger: 'manual',
    })
    const unlisted: OperationDefinition = {
      schemaVersion: 1,
      id: 'repository.head.read',
      version: 1,
      description: 'Test-only deterministic repository read.',
      capability: 'filesystem.project.read',
      risk: 'read_only',
      inputKeys: [],
      scope: 'trusted_project',
      requiredPolicyCeiling: 'repository_read',
      adapter: 'repository_branch_read_v1',
      timeoutMs: 30_000,
      verification: 'deterministic_adapter',
      recovery: 'none_read_only',
      approvalRequired: false,
      independentVerificationRequired: false,
      audit: { persistInputs: false, fingerprint: 'sha256', reasonUse: 'audit_only' },
      enabled: true,
      deprecated: false,
    }
    const catalog = createOperationCatalog([unlisted])

    expect(base.executionProfileDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(() => resolveVerificationGoalOperationBinding({
      operationId: unlisted.id,
      operationVersion: unlisted.version,
      goalCapability: unlisted.capability,
      trigger: 'manual',
      catalog,
    })).toThrow('is not on the goal-execution allowlist')
  })

  it('produces stable definition and execution-binding digests', () => {
    const first = parseExecutableVerificationGoalDefinition(definition())
    const second = parseExecutableVerificationGoalDefinition(definition({
      operations: [
        { operationId: 'repository.branch.read', operationVersion: 1 },
        { operationId: 'repository.status.read', operationVersion: 1 },
      ],
      execution: {
        manual: true,
        schedule: null,
        deadlineSeconds: 120,
        requiredEvidence: ['repository_identity', 'operation_evidence'],
      },
    }))

    expect(executableVerificationGoalDefinitionDigest(first)).toBe(
      executableVerificationGoalDefinitionDigest(second),
    )
    expect(buildVerificationGoalExecutionBindingV1(first).executionBindingDigest).toBe(
      buildVerificationGoalExecutionBindingV1(second).executionBindingDigest,
    )
  })
})
