import path from 'node:path'

import type { ExecutionOutcome, ExecutionStopReasonCode } from '@/lib/execution-outcomes'
import {
  OPERATION_PHASES,
  isPlainRecord,
  isSha256Fingerprint,
  operationFingerprint,
  parseOperationRequest,
  type OperationAdapterKind,
  type OperationExecutionResult,
  type OperationPhase,
  type OperationPolicyDecision,
  type OperationRequest,
  type OperationRunStatus,
  type OperationVerificationStatus,
} from '@/lib/operations/contracts'
import {
  OPERATION_CATALOG,
  resolveOperationDefinition,
  validateOperationInputs,
} from '@/lib/operations/catalog'
import {
  evaluateOperationPolicy,
  type TrustedOperationPolicyContext,
} from '@/lib/operations/policy'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_ATTEMPT_KEY_LENGTH = 200
const MAX_PROJECT_ROOT_LENGTH = 4_096
const ADAPTER_ABORT_SETTLEMENT_GRACE_MS = 250

export type TrustedOperationContext = {
  taskId: string
  projectId: string
  attemptKey: string
  projectRoot: string | null
  rootBindingRevision: string
  projectRevision: string
  workPackageId?: string | null
  agentRunId?: string | null
  taskAttemptId?: string | null
  policy: TrustedOperationPolicyContext
}

export type OperationAdapterResult = {
  output: unknown
  evidenceRefs: string[]
}

export type OperationAdapterExecution = {
  signal: AbortSignal
  deadline: Date
}

export type FixedOperationAdapters = {
  repositoryStatusRead: (context: TrustedOperationContext, execution: OperationAdapterExecution) => Promise<OperationAdapterResult>
  repositoryDiffSummary: (context: TrustedOperationContext, execution: OperationAdapterExecution) => Promise<OperationAdapterResult>
  repositoryBranchRead: (context: TrustedOperationContext, execution: OperationAdapterExecution) => Promise<OperationAdapterResult>
}

export type OperationRunStart = {
  taskId: string
  projectId: string
  workPackageId: string | null
  agentRunId: string | null
  taskAttemptId: string | null
  definitionSchemaVersion: 1
  operationId: string
  operationVersion: number
  capability: string
  idempotencyKey: string
  definitionDigest: string
  scopeFingerprint: string
  requestFingerprint: string
  inputsFingerprint: string
  reasonFingerprint: string
  policyDecision: OperationPolicyDecision
}

export type OperationRunEventWrite = {
  runId: string
  sequence: number
  phase: OperationPhase
  status: 'passed' | 'blocked' | 'failed'
  detailCode: string
  detailFingerprint: string
  evidenceRefs: string[]
}

export type OperationRunFinalization = {
  runId: string
  taskId: string
  workPackageId: string | null
  agentRunId: string | null
  taskAttemptId: string | null
  attemptKey: string
  status: Exclude<OperationRunStatus, 'running'>
  verificationStatus: OperationVerificationStatus
  outputFingerprint: string | null
  policyDecision: OperationPolicyDecision
  outcome: ExecutionOutcome
  outcomeEvent: OperationRunEventWrite
}

export type OperationLedger = {
  begin(input: OperationRunStart): Promise<
    | { kind: 'started'; runId: string }
    | {
      kind: 'replayed'
      requestFingerprint: string
      definitionDigest: string
      scopeFingerprint: string
      result: OperationExecutionResult
    }
  >
  appendEvent(event: OperationRunEventWrite): Promise<void>
  /** Atomically stores the canonical outcome, its phase event, and run linkage. */
  finalize(input: OperationRunFinalization): Promise<{ executionOutcomeId: string }>
}

export type OperationExecutorDependencies = {
  adapters: FixedOperationAdapters
  ledger: OperationLedger
  catalog?: Parameters<typeof resolveOperationDefinition>[1]
}

export class OperationAdapterExecutionError extends Error {
  readonly code: 'adapter_failed' | 'cancelled' | 'timeout' | 'authority_changed'
  readonly evidenceRefs: string[]

  constructor(code: OperationAdapterExecutionError['code'], evidenceRefs: string[] = []) {
    super(code === 'timeout'
      ? 'The deterministic operation timed out.'
      : code === 'cancelled'
        ? 'The deterministic operation was cancelled.'
        : code === 'authority_changed'
          ? 'The authoritative task, package, grant, or repository scope changed before execution.'
          : 'The deterministic operation adapter failed.')
    this.name = 'OperationAdapterExecutionError'
    this.code = code
    this.evidenceRefs = normalizedEvidenceRefs(evidenceRefs)
  }
}

class OperationTimeoutError extends OperationAdapterExecutionError {
  constructor(evidenceRefs: string[] = []) {
    super('timeout', evidenceRefs)
    this.name = 'OperationTimeoutError'
  }
}

class MissingRepositoryContextError extends Error {
  constructor() {
    super('The trusted project has no valid approved repository root.')
    this.name = 'MissingRepositoryContextError'
  }
}

class OperationAdapterSettlementError extends Error {
  constructor() {
    super('Operation adapter did not settle after cancellation; the run requires recovery and was not terminalized.')
    this.name = 'OperationAdapterSettlementError'
  }
}

function assertUuid(value: string | null | undefined, label: string, optional = false): void {
  if (optional && value == null) return
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID.`)
}

function assertTrustedContext(context: TrustedOperationContext): void {
  assertUuid(context.taskId, 'Task id')
  assertUuid(context.projectId, 'Project id')
  assertUuid(context.workPackageId, 'Work package id', true)
  assertUuid(context.agentRunId, 'Agent run id', true)
  assertUuid(context.taskAttemptId, 'Task attempt id', true)
  assertUuid(context.policy.projectId, 'Policy project id')
  assertUuid(context.policy.scopedProjectId, 'Policy scoped project id')
  if (context.policy.projectId !== context.projectId) throw new Error('Policy context is not bound to the trusted project.')
  if (!context.attemptKey || context.attemptKey.length > MAX_ATTEMPT_KEY_LENGTH || /[\u0000-\u001f\u007f]/u.test(context.attemptKey)) {
    throw new Error('Attempt key must be bounded printable text.')
  }
  if (!/^\d{1,20}$/.test(context.rootBindingRevision)) {
    throw new Error('Root binding revision must be a bounded decimal string.')
  }
  if (!context.projectRevision || context.projectRevision.length > 200 || /[\u0000-\u001f\u007f]/u.test(context.projectRevision)) {
    throw new Error('Project revision must be bounded printable text.')
  }
  if (!context.policy.policyVersion || context.policy.policyVersion.length > 200 || /[\u0000-\u001f\u007f]/u.test(context.policy.policyVersion)) {
    throw new Error('Policy version must be bounded printable text.')
  }
  if (context.policy.allowedCapabilities.some((capability) => typeof capability !== 'string' || capability.length < 1 || capability.length > 200)) {
    throw new Error('Trusted capabilities must be non-empty bounded strings.')
  }
  if (
    typeof context.policy.policyCeilings.repository_read !== 'boolean'
  ) {
    throw new Error('Trusted operation policy ceilings must be explicit booleans.')
  }
}

function assertEvidenceRefs(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((ref) => typeof ref !== 'string' || !UUID_PATTERN.test(ref))) {
    throw new Error('Operation evidence references must be a bounded array of UUIDs.')
  }
}

function normalizedEvidenceRefs(refs: string[]): string[] {
  assertEvidenceRefs(refs)
  return [...new Set(refs.map((ref) => ref.toLowerCase()))].sort()
}

function adapterFor(kind: OperationAdapterKind, adapters: FixedOperationAdapters): FixedOperationAdapters[keyof FixedOperationAdapters] {
  switch (kind) {
    case 'repository_status_read_v1': return adapters.repositoryStatusRead
    case 'repository_diff_summary_v1': return adapters.repositoryDiffSummary
    case 'repository_branch_read_v1': return adapters.repositoryBranchRead
  }
}

function validatePreflight(kind: OperationAdapterKind, context: TrustedOperationContext): void {
  if (
    context.projectRoot === null
    || !context.projectRoot
    || context.projectRoot.length > MAX_PROJECT_ROOT_LENGTH
    || context.projectRoot.includes('\0')
    || !path.isAbsolute(context.projectRoot)
  ) {
    throw new MissingRepositoryContextError()
  }
}

function verifyAdapterOutput(kind: OperationAdapterKind, output: unknown, evidenceRefs: string[]): boolean {
  if (!isPlainRecord(output)) return false
  if (
    kind === 'repository_status_read_v1'
    || kind === 'repository_diff_summary_v1'
    || kind === 'repository_branch_read_v1'
  ) {
    return output.exitCode === 0 && typeof output.summary === 'string' && evidenceRefs.length > 0
  }
  return false
}

async function runAdapterWithTimeout(
  adapter: FixedOperationAdapters[keyof FixedOperationAdapters],
  context: TrustedOperationContext,
  timeoutMs: number,
): Promise<OperationAdapterResult> {
  const controller = new AbortController()
  const deadline = new Date(Date.now() + timeoutMs)
  type AdapterSettlement =
    | { kind: 'completed'; value: OperationAdapterResult }
    | { kind: 'failed'; error: unknown }
  const settlement: Promise<AdapterSettlement> = adapter(context, {
    signal: controller.signal,
    deadline,
  }).then(
    (value) => ({ kind: 'completed' as const, value }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const first = await Promise.race([
      settlement,
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve({ kind: 'timeout' })
        }, timeoutMs)
      }),
    ])
    if (first.kind === 'timeout') {
      // Built-in adapters are cancellation-aware. Do not terminalize the run
      // until the adapter has stopped, including its audit/evidence work.
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      const stopped = await Promise.race([
        settlement,
        new Promise<{ kind: 'pending' }>((resolve) => {
          graceTimer = setTimeout(() => resolve({ kind: 'pending' }), ADAPTER_ABORT_SETTLEMENT_GRACE_MS)
        }),
      ])
      if (graceTimer) clearTimeout(graceTimer)
      if (stopped.kind === 'pending') throw new OperationAdapterSettlementError()
      const evidenceRefs = stopped.kind === 'completed'
        ? stopped.value.evidenceRefs
        : stopped.error instanceof OperationAdapterExecutionError
          ? stopped.error.evidenceRefs
          : []
      throw new OperationTimeoutError(evidenceRefs)
    }
    if (first.kind === 'failed') throw first.error
    return first.value
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function phaseEvent(input: Omit<OperationRunEventWrite, 'sequence' | 'detailFingerprint'> & { detail: unknown }): OperationRunEventWrite {
  const sequence = OPERATION_PHASES.indexOf(input.phase)
  if (sequence < 0) throw new Error('Unknown operation phase.')
  const detailFingerprint = operationFingerprint(`event:${input.phase}`, input.detail)
  if (!isSha256Fingerprint(detailFingerprint)) throw new Error('Invalid operation event fingerprint.')
  return {
    runId: input.runId,
    sequence,
    phase: input.phase,
    status: input.status,
    detailCode: input.detailCode,
    detailFingerprint,
    evidenceRefs: normalizedEvidenceRefs(input.evidenceRefs),
  }
}

function canonicalOutcome(input: {
  result: 'completed' | 'blocked' | 'failed'
  code: ExecutionStopReasonCode | null
  summary: string | null
  evidenceRefs?: string[]
}): ExecutionOutcome {
  return {
    schemaVersion: 1,
    transportStatus: 'ok',
    result: input.result,
    stopReasonCode: input.code,
    stopReasonSummary: input.summary,
    retryable: false,
    evidenceRefs: normalizedEvidenceRefs(input.evidenceRefs ?? []),
    verifierRequired: false,
    verificationStatus: 'not_required',
  }
}

function policyOutcome(decision: OperationPolicyDecision): ExecutionOutcome {
  const missingCapability = decision.code === 'missing_capability' || decision.code === 'capability_mismatch'
  return canonicalOutcome({
    result: 'blocked',
    code: missingCapability ? 'missing_capability' : 'policy_blocked',
    summary: `Operation policy denied the request (${decision.code}).`,
  })
}

async function terminalize(input: {
  ledger: OperationLedger
  runId: string
  context: TrustedOperationContext
  definitionDigest: string
  scopeFingerprint: string
  request: OperationRequest
  status: Exclude<OperationRunStatus, 'running'>
  verificationStatus: OperationVerificationStatus
  output: unknown | null
  policyDecision: OperationPolicyDecision
  outcome: ExecutionOutcome
}): Promise<OperationExecutionResult> {
  const outputFingerprint = input.output === null ? null : operationFingerprint('output', input.output)
  const outcomeEvent = phaseEvent({
    runId: input.runId,
    phase: 'outcome',
    status: input.status === 'completed' ? 'passed' : input.status,
    detailCode: input.outcome.stopReasonCode ?? 'completed',
    detail: input.outcome,
    evidenceRefs: input.outcome.evidenceRefs,
  })
  await input.ledger.finalize({
    runId: input.runId,
    taskId: input.context.taskId,
    workPackageId: input.context.workPackageId ?? null,
    agentRunId: input.context.agentRunId ?? null,
    taskAttemptId: input.context.taskAttemptId ?? null,
    attemptKey: `operation:${operationFingerprint('outcome-attempt', {
      taskId: input.context.taskId,
      attemptKey: input.context.attemptKey,
      operationId: input.request.operationId,
      operationVersion: input.request.operationVersion,
    })}`,
    status: input.status,
    verificationStatus: input.verificationStatus,
    outputFingerprint,
    policyDecision: input.policyDecision,
    outcome: input.outcome,
    outcomeEvent,
  })
  return {
    runId: input.runId,
    operationId: input.request.operationId,
    operationVersion: input.request.operationVersion,
    definitionDigest: input.definitionDigest,
    scopeFingerprint: input.scopeFingerprint,
    status: input.status,
    verificationStatus: input.verificationStatus,
    replayed: false,
    output: input.output,
    outcome: input.outcome,
  }
}

export async function executeOperation(input: {
  request: unknown
  context: TrustedOperationContext
  dependencies: OperationExecutorDependencies
}): Promise<OperationExecutionResult> {
  assertTrustedContext(input.context)
  const request = parseOperationRequest(input.request)
  const definition = resolveOperationDefinition(request, input.dependencies.catalog ?? OPERATION_CATALOG)
  validateOperationInputs(definition, request.inputs)

  const definitionDigest = operationFingerprint('definition', definition)
  const scopeFingerprint = operationFingerprint('scope', {
    projectId: input.context.projectId,
    scopedProjectId: input.context.policy.scopedProjectId,
    projectRoot: input.context.projectRoot,
    rootBindingRevision: input.context.rootBindingRevision,
    projectRevision: input.context.projectRevision,
    policyVersion: input.context.policy.policyVersion,
    allowedCapabilities: [...new Set(input.context.policy.allowedCapabilities)].sort(),
    policyCeilings: {
      repository_read: input.context.policy.policyCeilings.repository_read,
    },
  })
  // `reason` is audit-only: it is fingerprinted separately and cannot affect
  // idempotency, adapter selection, execution, verification, or replay.
  const requestFingerprint = operationFingerprint('request', {
    schemaVersion: request.schemaVersion,
    operationId: request.operationId,
    operationVersion: request.operationVersion,
    inputs: request.inputs,
    requestedCapability: request.requestedCapability,
  })
  const policyDecision = evaluateOperationPolicy({
    definition,
    requestedCapability: request.requestedCapability,
    context: input.context.policy,
  })
  const run = await input.dependencies.ledger.begin({
    taskId: input.context.taskId,
    projectId: input.context.projectId,
    workPackageId: input.context.workPackageId ?? null,
    agentRunId: input.context.agentRunId ?? null,
    taskAttemptId: input.context.taskAttemptId ?? null,
    definitionSchemaVersion: 1,
    operationId: definition.id,
    operationVersion: definition.version,
    capability: definition.capability,
    idempotencyKey: operationFingerprint('idempotency', {
      taskId: input.context.taskId,
      attemptKey: input.context.attemptKey,
      operationId: request.operationId,
      operationVersion: request.operationVersion,
    }),
    definitionDigest,
    scopeFingerprint,
    requestFingerprint,
    inputsFingerprint: operationFingerprint('inputs', request.inputs),
    reasonFingerprint: operationFingerprint('reason', request.reason),
    policyDecision,
  })

  if (run.kind === 'replayed') {
    if (run.requestFingerprint !== requestFingerprint || run.definitionDigest !== definitionDigest || run.scopeFingerprint !== scopeFingerprint) {
      throw new Error('Idempotency key is already bound to a different operation request or scope.')
    }
    if (run.result.status === 'running') {
      throw new Error('Operation attempt is still in progress or requires recovery; use a new attempt key after auditing the incomplete run.')
    }
    return { ...run.result, replayed: true, output: null }
  }

  await input.dependencies.ledger.appendEvent(phaseEvent({
    runId: run.runId,
    phase: 'request_validation',
    status: 'passed',
    detailCode: 'request_valid',
    detail: { requestFingerprint },
    evidenceRefs: [],
  }))

  await input.dependencies.ledger.appendEvent(phaseEvent({
    runId: run.runId,
    phase: 'policy',
    status: policyDecision.allowed ? 'passed' : 'blocked',
    detailCode: policyDecision.code,
    detail: policyDecision,
    evidenceRefs: [],
  }))
  if (!policyDecision.allowed) {
    return terminalize({
      ledger: input.dependencies.ledger,
      runId: run.runId,
      context: input.context,
      definitionDigest,
      scopeFingerprint,
      request,
      status: 'blocked',
      verificationStatus: 'not_started',
      output: null,
      policyDecision,
      outcome: policyOutcome(policyDecision),
    })
  }

  const failPhase = async (
    phase: 'preflight' | 'execution',
    error: unknown,
  ): Promise<OperationExecutionResult> => {
    const timeout = error instanceof OperationTimeoutError
    const missingRepositoryContext = error instanceof MissingRepositoryContextError
    const authorityChanged = error instanceof OperationAdapterExecutionError && error.code === 'authority_changed'
    const failureEvidenceRefs = error instanceof OperationAdapterExecutionError
      ? error.evidenceRefs
      : []
    await input.dependencies.ledger.appendEvent(phaseEvent({
      runId: run.runId,
      phase,
      status: 'failed',
      detailCode: timeout ? 'timeout' : authorityChanged ? 'authority_changed' : phase === 'preflight' ? 'preflight_failed' : 'adapter_failed',
      detail: {
        code: timeout
          ? 'timeout'
          : authorityChanged
            ? 'authority_changed'
            : missingRepositoryContext
              ? 'missing_repository_context'
              : phase === 'preflight'
                ? 'preflight_failed'
                : 'adapter_failed',
      },
      evidenceRefs: failureEvidenceRefs,
    }))
    return terminalize({
      ledger: input.dependencies.ledger,
      runId: run.runId,
      context: input.context,
      definitionDigest,
      scopeFingerprint,
      request,
      status: 'failed',
      verificationStatus: 'not_started',
      output: null,
      policyDecision,
      outcome: canonicalOutcome({
        result: authorityChanged ? 'blocked' : 'failed',
        code: timeout
          ? 'timeout'
          : authorityChanged
            ? 'policy_blocked'
            : missingRepositoryContext
              ? 'missing_repository_context'
              : 'unknown',
        evidenceRefs: failureEvidenceRefs,
        summary: timeout
          ? 'The deterministic operation timed out.'
          : authorityChanged
            ? 'The authoritative task, package, grant, or repository scope changed before execution; the operation failed closed.'
            : missingRepositoryContext
              ? 'The trusted project has no valid approved repository root.'
              : `The deterministic operation ${phase} failed.`,
      }),
    })
  }

  try {
    validatePreflight(definition.adapter, input.context)
  } catch (error) {
    return failPhase('preflight', error)
  }
  await input.dependencies.ledger.appendEvent(phaseEvent({
    runId: run.runId,
    phase: 'preflight',
    status: 'passed',
    detailCode: 'scope_ready',
    detail: { scopeFingerprint },
    evidenceRefs: [],
  }))

  let adapterResult: OperationAdapterResult
  let evidenceRefs: string[]
  let outputFingerprint: string
  try {
    adapterResult = await runAdapterWithTimeout(
      adapterFor(definition.adapter, input.dependencies.adapters),
      input.context,
      definition.timeoutMs,
    )
    assertEvidenceRefs(adapterResult.evidenceRefs)
    evidenceRefs = normalizedEvidenceRefs(adapterResult.evidenceRefs)
    outputFingerprint = operationFingerprint('output', adapterResult.output)
  } catch (error) {
    if (error instanceof OperationAdapterSettlementError) throw error
    return failPhase('execution', error)
  }
  await input.dependencies.ledger.appendEvent(phaseEvent({
    runId: run.runId,
    phase: 'execution',
    status: 'passed',
    detailCode: 'adapter_completed',
    detail: { outputFingerprint },
    evidenceRefs,
  }))

  const verified = verifyAdapterOutput(definition.adapter, adapterResult.output, evidenceRefs)
  await input.dependencies.ledger.appendEvent(phaseEvent({
    runId: run.runId,
    phase: 'verification',
    status: verified ? 'passed' : 'failed',
    detailCode: verified ? 'deterministic_verification_passed' : 'deterministic_verification_failed',
    detail: { adapter: definition.adapter, outputFingerprint },
    evidenceRefs,
  }))
  if (!verified) {
    return terminalize({
      ledger: input.dependencies.ledger,
      runId: run.runId,
      context: input.context,
      definitionDigest,
      scopeFingerprint,
      request,
      status: 'failed',
      verificationStatus: 'failed',
      output: adapterResult.output,
      policyDecision,
      outcome: canonicalOutcome({
        result: 'failed',
        code: 'validation_failed',
        summary: 'Deterministic operation verification failed.',
        evidenceRefs,
      }),
    })
  }

  return terminalize({
    ledger: input.dependencies.ledger,
    runId: run.runId,
    context: input.context,
    definitionDigest,
    scopeFingerprint,
    request,
    status: 'completed',
    verificationStatus: 'passed',
    output: adapterResult.output,
    policyDecision,
    outcome: canonicalOutcome({ result: 'completed', code: null, summary: null, evidenceRefs }),
  })
}
