import { describe, expect, it } from 'vitest'

import {
  BUILT_IN_OPERATIONS,
  createOperationCatalog,
  resolveOperationDefinition,
  validateOperationInputs,
} from '@/lib/operations/catalog'
import { OperationContractError, parseOperationRequest } from '@/lib/operations/contracts'

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    operationId: 'repository.status.read',
    operationVersion: 1,
    inputs: {},
    reason: 'Inspect repository state.',
    requestedCapability: 'filesystem.project.read',
    ...overrides,
  }
}

describe('operation catalog v1', () => {
  it('requires schemaVersion 1 and exact request keys', () => {
    expect(() => parseOperationRequest(request({ schemaVersion: 2 }))).toThrow(OperationContractError)
    expect(() => parseOperationRequest(request({ cwd: '/tmp/escape' }))).toThrow('exactly the v1 request keys')
  })

  it('preserves an exact empty input object and rejects command or path injection', () => {
    const parsed = parseOperationRequest(request())
    expect(parsed.inputs).toEqual({})
    const definition = resolveOperationDefinition(parsed)
    expect(() => validateOperationInputs(definition, parsed.inputs)).not.toThrow()
    expect(() => validateOperationInputs(definition, { argv: ['sh', '-c', 'rm -rf /'] })).toThrow(OperationContractError)
    expect(() => validateOperationInputs(definition, { projectPath: '../../outside' })).toThrow(OperationContractError)
  })

  it('rejects duplicate ids and unsupported versions', () => {
    expect(() => createOperationCatalog([BUILT_IN_OPERATIONS[0], BUILT_IN_OPERATIONS[0]])).toThrow('Duplicate')
    expect(() => resolveOperationDefinition({ operationId: 'repository.status.read', operationVersion: 2 })).toThrow('version')
  })
})
