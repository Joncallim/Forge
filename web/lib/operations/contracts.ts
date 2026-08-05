import { createHash } from 'node:crypto'

import type { ExecutionOutcome } from '@/lib/execution-outcomes'

export const OPERATION_DEFINITION_SCHEMA_VERSION = 1 as const
export const OPERATION_REQUEST_KEYS = [
  'inputs',
  'operationId',
  'operationVersion',
  'reason',
  'requestedCapability',
  'schemaVersion',
] as const

export const OPERATION_PHASES = [
  'request_validation',
  'policy',
  'preflight',
  'execution',
  'verification',
  'outcome',
] as const

export type OperationPhase = typeof OPERATION_PHASES[number]
export type OperationRunStatus = 'running' | 'completed' | 'blocked' | 'failed'
export type OperationVerificationStatus = 'not_started' | 'passed' | 'failed'
export type OperationAdapterKind =
  | 'repository_status_read_v1'
  | 'repository_diff_summary_v1'
  | 'repository_branch_read_v1'
export type OperationPolicyCeiling = 'repository_read'

export type OperationRequest = {
  schemaVersion: 1
  operationId: string
  operationVersion: number
  inputs: Record<string, unknown>
  reason: string
  requestedCapability: string
}

export type OperationDefinition = {
  schemaVersion: 1
  id: string
  version: number
  description: string
  capability: string
  risk: 'read_only'
  inputKeys: readonly string[]
  scope: 'trusted_project'
  requiredPolicyCeiling: OperationPolicyCeiling
  adapter: OperationAdapterKind
  timeoutMs: number
  verification: 'deterministic_adapter'
  recovery: 'none_read_only'
  approvalRequired: false
  independentVerificationRequired: false
  audit: {
    persistInputs: false
    fingerprint: 'sha256'
    reasonUse: 'audit_only'
  }
  enabled: boolean
  deprecated: boolean
}

export type OperationPolicyDecision = {
  schemaVersion: 1
  allowed: boolean
  code:
    | 'allowed'
    | 'capability_mismatch'
    | 'missing_capability'
    | 'scope_mismatch'
    | 'policy_ceiling_denied'
    | 'operation_disabled'
    | 'operation_deprecated'
  capability: string
  projectId: string
  policyVersion: string
}

export type OperationExecutionResult = {
  runId: string
  operationId: string
  operationVersion: number
  definitionDigest: string
  scopeFingerprint: string
  status: OperationRunStatus
  verificationStatus: OperationVerificationStatus
  replayed: boolean
  output: unknown | null
  outcome: ExecutionOutcome | null
}

export function isSha256Fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export class OperationContractError extends Error {
  readonly code: 'invalid_request' | 'unknown_operation' | 'unsupported_version'

  constructor(
    code: OperationContractError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'OperationContractError'
    this.code = code
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  return actual.length === required.length && actual.every((key, index) => key === required[index])
}

export function parseOperationRequest(value: unknown): OperationRequest {
  if (!isPlainRecord(value) || !hasExactKeys(value, OPERATION_REQUEST_KEYS)) {
    throw new OperationContractError('invalid_request', 'Operation request must contain exactly the v1 request keys.')
  }
  if (value.schemaVersion !== 1) {
    throw new OperationContractError('invalid_request', 'Operation request schema version must be 1.')
  }
  if (typeof value.operationId !== 'string' || value.operationId.length > 200 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(value.operationId)) {
    throw new OperationContractError('invalid_request', 'Operation id is invalid.')
  }
  if (!Number.isSafeInteger(value.operationVersion) || (value.operationVersion as number) < 1) {
    throw new OperationContractError('invalid_request', 'Operation version must be a positive integer.')
  }
  if (!isPlainRecord(value.inputs)) {
    throw new OperationContractError('invalid_request', 'Operation inputs must be a plain object.')
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length < 1 || value.reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.reason)) {
    throw new OperationContractError('invalid_request', 'Operation reason must be printable text between 1 and 500 characters.')
  }
  if (typeof value.requestedCapability !== 'string' || value.requestedCapability.length > 200 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(value.requestedCapability)) {
    throw new OperationContractError('invalid_request', 'Requested capability is invalid.')
  }

  return {
    schemaVersion: 1,
    operationId: value.operationId,
    operationVersion: value.operationVersion as number,
    inputs: value.inputs,
    reason: value.reason,
    requestedCapability: value.requestedCapability,
  }
}

/** Canonical JSON for hashes only. Values are never reconstructed from it. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite values cannot be fingerprinted.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new Error('Only JSON values can be fingerprinted.')
}

export function operationFingerprint(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`forge:operation:${domain}:v1\0`, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex')
}
