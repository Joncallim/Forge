import { describe, expect, it } from 'vitest'
import {
  capabilityRequestSchema,
  executionContextSchema,
  executionRefSchema,
  grantEnvelopeSchema,
  isValidExecutionState,
  isValidMissionState,
  missionSpecSchema,
  missionRefSchema,
  reasonCodeSchema,
} from '@/lib/runtime/v1'

const id = '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f'
const digest = 'a'.repeat(64)
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', activeAt: null, waitingAt: null, pausedAt: null, terminalAt: null, updatedAt: '2026-01-01T00:00:00.000Z' }
const executionTimestamps = { createdAt: '2026-01-01T00:00:00.000Z', admittedAt: null, queuedAt: null, leasedAt: null, runningAt: null, waitingAt: null, terminalAt: null, updatedAt: '2026-01-01T00:00:00.000Z' }

describe('VNext runtime v1 contracts', () => {
  it('keeps a project-less Mission pure and zero-capability', () => {
    expect(missionSpecSchema.parse({
      version: 'v1', desiredOutcomeDigest: digest, constraintsDigest: digest,
      resourceBindings: [], parentMissionId: null,
      compatibilityPins: { version: 'v1', workflowRevision: 'zero-capability-v1', policyRevision: 'zero-capability-v1', budgetEnvelopeRevision: 'zero-capability-v1', compatibilityMode: 'software_engineering_legacy_v1' },
    }).resourceBindings).toEqual([])
  })

  it('rejects unknown authority-bearing values and excess fields', () => {
    expect(() => capabilityRequestSchema.parse({ version: 'v1', capability: { version: 'v1', actionClass: 'repository.write' }, resource: { version: 'v1', id, type: 'unknown', revision: '1', classification: 'unknown' }, requestedConstraintsDigest: digest, grant: true })).toThrow()
    expect(() => grantEnvelopeSchema.parse({ version: 'v1', id, principal: { version: 'v1', type: 'model', id }, capability: { version: 'v1', actionClass: 'repository.write' }, resourceScope: { version: 'v1', id, type: 'repository', revision: '1', classification: 'unknown' }, constraintsDigest: digest, policyRevision: '1', parentGrantId: null, evidenceDigest: digest, expiresAt: null, revokedAt: null })).toThrow()
  })

  it('keeps lifecycle and terminal outcome separate', () => {
    expect(isValidMissionState('active', null)).toBe(true)
    expect(isValidMissionState('terminal', null)).toBe(false)
    expect(isValidExecutionState('waiting', null)).toBe(true)
    expect(isValidExecutionState('terminal', 'succeeded')).toBe(true)
    expect(isValidExecutionState('terminal', null)).toBe(false)
    expect(() => missionRefSchema.parse({ version: 'v1', id, owner: { version: 'v1', type: 'user', id }, lifecycle: 'active', outcome: 'failed', revision: '0', ...timestamps })).toThrow()
    expect(() => executionRefSchema.parse({ version: 'v1', id, missionId: id, lifecycle: 'queued', outcome: 'succeeded', revision: '0', ...executionTimestamps })).toThrow()
  })

  it('does not make a principal type an authority grant', () => {
    expect(() => executionContextSchema.parse({
      version: 'v1', execution: { version: 'v1', id, missionId: id, lifecycle: 'created', outcome: null, revision: '0', ...executionTimestamps },
      principal: { version: 'v1', type: 'user', id }, workflowRevision: 'zero-capability-v1', resourceBindings: [], blockerReasonCode: null,
      implicitGrant: { capability: 'repository.write' },
    })).toThrow()
  })

  it('uses the closed SPEC-0007 registry and exact accepted lifecycle values', () => {
    expect(reasonCodeSchema.parse('execution.indeterminate')).toBe('execution.indeterminate')
    expect(() => reasonCodeSchema.parse('vnext.execution.running')).toThrow()
    expect(missionRefSchema.parse({ version: 'v1', id, owner: { version: 'v1', type: 'user', id }, lifecycle: 'draft', outcome: null, revision: '9007199254740993', ...timestamps }).revision).toBe('9007199254740993')
    expect(() => missionRefSchema.parse({ version: 'v1', id, owner: { version: 'v1', type: 'user', id }, lifecycle: 'waiting', outcome: null, revision: '01', ...timestamps })).toThrow()
    expect(() => executionRefSchema.parse({ version: 'v1', id, missionId: id, lifecycle: 'terminal', outcome: 'rejected', revision: '1', ...executionTimestamps })).toThrow()
  })

  it('requires the DB-authored timestamp for each durable non-initial lifecycle', () => {
    expect(() => missionRefSchema.parse({ version: 'v1', id, owner: { version: 'v1', type: 'user', id }, lifecycle: 'waiting', outcome: null, revision: '1', ...timestamps })).toThrow('authoritative transition timestamp')
    expect(() => executionRefSchema.parse({ version: 'v1', id, missionId: id, lifecycle: 'leased', outcome: null, revision: '1', ...executionTimestamps })).toThrow('authoritative transition timestamp')
    expect(executionRefSchema.parse({
      version: 'v1', id, missionId: id, lifecycle: 'waiting', outcome: null, revision: '1',
      ...executionTimestamps, waitingAt: '2026-01-01T00:00:01.000Z',
    }).waitingAt).toBe('2026-01-01T00:00:01.000Z')
  })
})
