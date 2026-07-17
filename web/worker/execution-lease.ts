const DEFAULT_STALE_RUNNING_PACKAGE_SECONDS = 15 * 60

export type ExecutionLease = {
  acquiredAt: string
  attemptNumber: number
  heartbeatAt: string
  runId: string
  source: 'work-package-handoff'
  staleAfterSeconds: number
}

export type ExecutionLeaseParseResult =
  | { state: 'absent' }
  | { state: 'malformed' }
  | { state: 'valid'; lease: ExecutionLease }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
}

export function staleRunningPackageSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FORGE_RUNNING_WORK_PACKAGE_STALE_SECONDS?.trim()
  if (!raw) return DEFAULT_STALE_RUNNING_PACKAGE_SECONDS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STALE_RUNNING_PACKAGE_SECONDS
}

/**
 * The single parser for an execution lease persisted on a work package.
 * Malformed lease-shaped values are distinct from an absent legacy lease so
 * callers can fail closed instead of treating damaged ownership as expired.
 */
export function parseExecutionLeaseMetadata(metadata: unknown): ExecutionLeaseParseResult {
  if (!isRecord(metadata) || !Object.hasOwn(metadata, 'executionLease')) return { state: 'absent' }
  const value = metadata.executionLease
  if (!isRecord(value)) return { state: 'malformed' }
  const expectedKeys = [
    'acquiredAt',
    'attemptNumber',
    'heartbeatAt',
    'runId',
    'source',
    'staleAfterSeconds',
  ]
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key)) ||
    !isCanonicalIsoTimestamp(value.acquiredAt) ||
    !isCanonicalIsoTimestamp(value.heartbeatAt) ||
    Date.parse(value.heartbeatAt) < Date.parse(value.acquiredAt) ||
    !Number.isSafeInteger(value.attemptNumber) ||
    (value.attemptNumber as number) <= 0 ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    value.source !== 'work-package-handoff' ||
    typeof value.staleAfterSeconds !== 'number' ||
    !Number.isFinite(value.staleAfterSeconds) ||
    value.staleAfterSeconds <= 0
  ) return { state: 'malformed' }
  return { state: 'valid', lease: value as ExecutionLease }
}

export function executionLeaseIsStale(lease: ExecutionLease, now: Date): boolean {
  return Date.parse(lease.heartbeatAt) <= now.getTime() - lease.staleAfterSeconds * 1000
}

/** Active and malformed leases both block grant-driven task convergence. */
export function executionLeaseBlocksConvergence(metadata: unknown, now: Date): boolean {
  const parsed = parseExecutionLeaseMetadata(metadata)
  return parsed.state === 'malformed' ||
    (parsed.state === 'valid' && !executionLeaseIsStale(parsed.lease, now))
}
