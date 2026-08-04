/** Versioned, provider-neutral evidence contract for one attempted execution. */
export const EXECUTION_OUTCOME_SCHEMA_VERSION = 1 as const

export const EXECUTION_OUTCOME_RESULTS = [
  'completed', 'partial', 'refused', 'blocked', 'needs_attention', 'failed', 'cancelled',
] as const
export type ExecutionOutcomeResult = typeof EXECUTION_OUTCOME_RESULTS[number]

export const EXECUTION_STOP_REASON_CODES = [
  'provider_transport_failure',
  'model_refusal',
  'invalid_output',
  'validation_failed',
  'missing_capability',
  'admission_denied',
  'policy_blocked',
  'security_blocked',
  'missing_repository_context',
  'timeout',
  'context_limit',
  'output_limit',
  'retry_exhausted',
  'human_cancelled',
  'unknown',
] as const
export type ExecutionStopReasonCode = typeof EXECUTION_STOP_REASON_CODES[number]

export type ExecutionOutcome = {
  schemaVersion: 1
  transportStatus: 'ok' | 'error'
  result: ExecutionOutcomeResult
  stopReasonCode: ExecutionStopReasonCode | null
  stopReasonSummary: string | null
  retryable: boolean
  evidenceRefs: string[]
  verifierRequired: boolean
  verificationStatus: 'not_required' | 'pending' | 'passed' | 'failed' | 'inconclusive'
}

const MAX_STOP_REASON_SUMMARY_LENGTH = 1_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isExecutionOutcome(value: unknown): value is ExecutionOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const outcome = value as Partial<ExecutionOutcome>
  return outcome.schemaVersion === EXECUTION_OUTCOME_SCHEMA_VERSION
    && (outcome.transportStatus === 'ok' || outcome.transportStatus === 'error')
    && EXECUTION_OUTCOME_RESULTS.includes(outcome.result as ExecutionOutcomeResult)
    && (outcome.stopReasonCode === null || EXECUTION_STOP_REASON_CODES.includes(outcome.stopReasonCode as ExecutionStopReasonCode))
    && (outcome.stopReasonSummary === null || typeof outcome.stopReasonSummary === 'string')
    && typeof outcome.retryable === 'boolean'
    && Array.isArray(outcome.evidenceRefs) && outcome.evidenceRefs.every((ref) => typeof ref === 'string' && UUID_PATTERN.test(ref))
    && typeof outcome.verifierRequired === 'boolean'
    && ['not_required', 'pending', 'passed', 'failed', 'inconclusive'].includes(outcome.verificationStatus ?? '')
}

/**
 * Converts raw boundary evidence to the storage-safe form. Evidence refs are
 * UUIDs only; technical content remains in its existing artifact/log record.
 */
export function normalizeExecutionOutcome(
  outcome: ExecutionOutcome,
  sanitize: (value: unknown) => string,
): ExecutionOutcome {
  if (!isExecutionOutcome(outcome)) throw new Error('Execution outcome does not match schema v1.')
  const summary = outcome.stopReasonSummary === null
    ? null
    : sanitize(outcome.stopReasonSummary).slice(0, MAX_STOP_REASON_SUMMARY_LENGTH)
  return {
    ...outcome,
    evidenceRefs: [...new Set(outcome.evidenceRefs)].sort(),
    stopReasonSummary: summary || null,
  }
}

export function executionFailureOutcome(input: {
  message: string
  retryable: boolean
  validationFailed?: boolean
  repositoryContextMissing?: boolean
  refused?: boolean
}): ExecutionOutcome {
  const message = input.message.toLowerCase()
  const inferredCode: ExecutionStopReasonCode = message.includes('refus')
    ? 'model_refusal'
    : message.includes('unparseable') || message.includes('invalid output') || message.includes('valid JSON')
      ? 'invalid_output'
      : message.includes('timeout') || message.includes('timed out')
        ? 'timeout'
        : message.includes('context') && message.includes('limit')
          ? 'context_limit'
          : message.includes('output') && message.includes('limit')
            ? 'output_limit'
            : 'unknown'
  const code: ExecutionStopReasonCode = input.refused
    ? 'model_refusal'
    : input.validationFailed
      ? 'validation_failed'
      : input.repositoryContextMissing
        ? 'missing_repository_context'
        : inferredCode
  const semanticResult = code === 'model_refusal' ? 'refused' : input.repositoryContextMissing ? 'blocked' : 'failed'
  const transportStatus = code === 'model_refusal'
    || code === 'invalid_output'
    || code === 'validation_failed'
    || code === 'timeout'
    || code === 'context_limit'
    || code === 'output_limit'
    || input.repositoryContextMissing
    ? 'ok'
    : 'error'
  return {
    schemaVersion: 1,
    transportStatus,
    result: semanticResult,
    stopReasonCode: code,
    stopReasonSummary: input.message,
    retryable: input.retryable,
    evidenceRefs: [],
    verifierRequired: false,
    verificationStatus: 'not_required',
  }
}

export function admissionBlockedOutcome(message: string, code: 'admission_denied' | 'policy_blocked' | 'security_blocked' = 'admission_denied'): ExecutionOutcome {
  return {
    schemaVersion: 1,
    transportStatus: 'ok',
    result: 'blocked',
    stopReasonCode: code,
    stopReasonSummary: message,
    retryable: code === 'admission_denied',
    evidenceRefs: [],
    verifierRequired: false,
    verificationStatus: 'not_required',
  }
}

/** A missing artifact must never suppress an outcome write. */
export function outcomeEvidenceRefsFromArtifact(artifact: { id: string } | null | undefined): string[] {
  return artifact ? [artifact.id] : []
}
