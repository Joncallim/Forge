import { describe, expect, it } from 'vitest'

import {
  BUILT_IN_OPERATIONS,
  createOperationCatalog,
} from '@/lib/operations/catalog'
import type { OperationDefinition } from '@/lib/operations/contracts'
import {
  parseVerificationGoalDefinition,
  verificationGoalDefinitionDigest,
} from '@/lib/verification-goals/contracts'

function validDefinition() {
  return {
    schemaVersion: 1,
    goalId: 'repository-readable',
    definitionVersion: 1,
    title: 'Repository remains readable',
    description: 'Forge can inspect the trusted project without executing repository code.',
    capability: 'filesystem.project.read',
    severity: 'high',
    enabled: true,
    operations: [
      { operationId: 'repository.status.read', operationVersion: 1 },
      { operationId: 'repository.branch.read', operationVersion: 1 },
    ],
  }
}

describe('verification goal v1 contract', () => {
  it('canonicalizes operation references and produces a stable domain-separated digest', () => {
    const parsed = parseVerificationGoalDefinition(validDefinition())
    const reversed = parseVerificationGoalDefinition({
      ...validDefinition(),
      operations: [...validDefinition().operations].reverse(),
    })

    expect(parsed.operations).toEqual([
      { operationId: 'repository.branch.read', operationVersion: 1 },
      { operationId: 'repository.status.read', operationVersion: 1 },
    ])
    expect(verificationGoalDefinitionDigest(parsed)).toEqual(
      verificationGoalDefinitionDigest(reversed),
    )
    expect(verificationGoalDefinitionDigest(parsed)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects unknown keys, versions, executable material, and duplicate operations', () => {
    for (const definition of [
      { ...validDefinition(), schemaVersion: 2 },
      { ...validDefinition(), command: 'npm test' },
      {
        ...validDefinition(),
        operations: [{
          operationId: 'repository.status.read',
          operationVersion: 1,
          inputs: { path: '/tmp' },
        }],
      },
      {
        ...validDefinition(),
        operations: [
          { operationId: 'repository.status.read', operationVersion: 1 },
          { operationId: 'repository.status.read', operationVersion: 1 },
        ],
      },
    ]) {
      expect(() => parseVerificationGoalDefinition(definition)).toThrow()
    }
  })

  it('rejects unknown, disabled, and deprecated catalog operations', () => {
    expect(() => parseVerificationGoalDefinition({
      ...validDefinition(),
      operations: [{ operationId: 'repository.unknown.read', operationVersion: 1 }],
    })).toThrow(/not registered/i)

    for (const state of [
      { enabled: false, deprecated: false },
      { enabled: true, deprecated: true },
    ]) {
      const definition: OperationDefinition = {
        ...BUILT_IN_OPERATIONS[0],
        id: 'repository.lifecycle.read',
        ...state,
      }
      const catalog = createOperationCatalog([definition])
      expect(() => parseVerificationGoalDefinition({
        ...validDefinition(),
        operations: [{ operationId: definition.id, operationVersion: 1 }],
      }, catalog)).toThrow(/disabled or deprecated/i)
    }
  })

  it('rejects operations for another capability or operations that require inputs', () => {
    const base = BUILT_IN_OPERATIONS[0]
    const mismatched: OperationDefinition = {
      ...base,
      id: 'repository.mismatched.read',
      capability: 'github.repository.read',
    }
    const inputRequired: OperationDefinition = {
      ...base,
      id: 'repository.input-required.read',
      inputKeys: ['path'],
    }
    for (const operation of [mismatched, inputRequired]) {
      const catalog = createOperationCatalog([operation])
      expect(() => parseVerificationGoalDefinition({
        ...validDefinition(),
        operations: [{ operationId: operation.id, operationVersion: operation.version }],
      }, catalog)).toThrow(operation === mismatched ? /does not match/i : /requires inputs/i)
    }
  })

  it('requires bounded identity, text, capability, severity, and operation fields', () => {
    for (const definition of [
      { ...validDefinition(), goalId: '../escape' },
      { ...validDefinition(), definitionVersion: 0 },
      { ...validDefinition(), title: 'line one\nline two' },
      { ...validDefinition(), description: '' },
      { ...validDefinition(), capability: 'filesystem' },
      { ...validDefinition(), severity: 'urgent' },
      { ...validDefinition(), enabled: 'yes' },
      { ...validDefinition(), operations: [] },
      {
        ...validDefinition(),
        operations: [{ operationId: 'repository.status.read', operationVersion: 0 }],
      },
    ]) {
      expect(() => parseVerificationGoalDefinition(definition)).toThrow()
    }
  })
})
