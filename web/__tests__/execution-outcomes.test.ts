import { describe, expect, it } from 'vitest'
import {
  admissionBlockedOutcome,
  executionFailureOutcome,
  isExecutionOutcome,
  normalizeExecutionOutcome,
  outcomeEvidenceRefsFromArtifact,
} from '@/lib/execution-outcomes'

const artifactId = '11111111-1111-4111-8111-111111111111'

describe('execution outcome v1', () => {
  it('keeps a semantic refusal separate from provider transport success', () => {
    const outcome = executionFailureOutcome({ message: 'I cannot do that.', refused: true, retryable: false })
    expect(outcome).toMatchObject({
      transportStatus: 'ok',
      result: 'refused',
      stopReasonCode: 'model_refusal',
      retryable: false,
    })
  })

  it('maps admission denial to a retryable semantic block', () => {
    expect(admissionBlockedOutcome('MCP capability missing')).toMatchObject({
      transportStatus: 'ok',
      result: 'blocked',
      stopReasonCode: 'admission_denied',
      retryable: true,
    })
  })

  it('maps validation failures independently from transport errors', () => {
    expect(executionFailureOutcome({ message: 'test failed', retryable: false, validationFailed: true }))
      .toMatchObject({ transportStatus: 'ok', result: 'failed', stopReasonCode: 'validation_failed' })
  })

  it('classifies an unparseable provider response as execution failure, not transport failure', () => {
    expect(executionFailureOutcome({ message: 'Provider returned invalid output JSON', retryable: true }))
      .toMatchObject({ transportStatus: 'ok', result: 'failed', stopReasonCode: 'invalid_output' })
  })

  it('redacts and bounds a persisted summary while retaining UUID evidence references', () => {
    const normalized = normalizeExecutionOutcome({
      schemaVersion: 1,
      transportStatus: 'error',
      result: 'failed',
      stopReasonCode: 'provider_transport_failure',
      stopReasonSummary: `token=secret ${'x'.repeat(1_500)}`,
      retryable: true,
      evidenceRefs: [artifactId, artifactId],
      verifierRequired: false,
      verificationStatus: 'not_required',
    }, (value) => String(value).replace('secret', '[REDACTED]'))

    expect(normalized.stopReasonSummary).toContain('[REDACTED]')
    expect(normalized.stopReasonSummary).toHaveLength(1_000)
    expect(normalized.evidenceRefs).toEqual([artifactId])
    expect(isExecutionOutcome(normalized)).toBe(true)
  })

  it('rejects non-UUID evidence references', () => {
    expect(isExecutionOutcome({
      schemaVersion: 1,
      transportStatus: 'ok',
      result: 'completed',
      stopReasonCode: null,
      stopReasonSummary: null,
      retryable: false,
      evidenceRefs: ['raw transcript'],
      verifierRequired: false,
      verificationStatus: 'not_required',
    })).toBe(false)
  })

  it('keeps a failure outcome writable when its artifact row is unavailable', () => {
    const outcome = {
      ...executionFailureOutcome({ message: 'provider disconnected', retryable: true }),
      evidenceRefs: outcomeEvidenceRefsFromArtifact(null),
    }
    expect(outcome.evidenceRefs).toEqual([])
    expect(isExecutionOutcome(outcome)).toBe(true)
  })
})
