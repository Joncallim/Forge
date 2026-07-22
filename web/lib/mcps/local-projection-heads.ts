import { createHash, randomUUID } from 'node:crypto'

export const CURRENT_LOCAL_PROJECTION_HEAD_KINDS = [
  'local_run',
  'local_recovery',
  'packet_recovery',
  'repository_review',
  'host_apply_review',
  'operator_hold',
  'integrity',
  'terminal_disposition',
] as const

export type LocalProjectionHeadKind =
  (typeof CURRENT_LOCAL_PROJECTION_HEAD_KINDS)[number]

export const CURRENT_LOCAL_PROJECTION_HEAD_KINDS_SET: ReadonlySet<LocalProjectionHeadKind> =
  new Set(CURRENT_LOCAL_PROJECTION_HEAD_KINDS)

export const CURRENT_LOCAL_PROJECTION_HEAD_KIND_COUNT =
  CURRENT_LOCAL_PROJECTION_HEAD_KINDS.length

export function isLocalProjectionHeadKind(
  value: unknown,
): value is LocalProjectionHeadKind {
  return typeof value === 'string' &&
    (CURRENT_LOCAL_PROJECTION_HEAD_KINDS_SET as ReadonlySet<string>).has(value)
}

export function assertLocalProjectionHeadKind(
  value: unknown,
): asserts value is LocalProjectionHeadKind {
  if (!isLocalProjectionHeadKind(value)) {
    throw new Error(
      `Invalid projection head kind: ${String(value)}. ` +
      `Expected one of: ${CURRENT_LOCAL_PROJECTION_HEAD_KINDS.join(', ')}`,
    )
  }
}

export const MAX_LOCAL_PROJECTION_HEAD_PACKAGES = 256

export const MAX_LOCAL_PROJECTION_HEADS =
  CURRENT_LOCAL_PROJECTION_HEAD_KIND_COUNT * MAX_LOCAL_PROJECTION_HEAD_PACKAGES

export const LOCAL_PROJECTION_SCOPE_STATES = [
  'active',
  'archive_pending',
  'legacy_archived',
] as const

export type LocalProjectionScopeState =
  (typeof LOCAL_PROJECTION_SCOPE_STATES)[number]

export type LocalProjectionHeadIdentity = Readonly<{
  headId: string
  taskId: string
  workPackageId: string
  kind: LocalProjectionHeadKind
  index: number
}>

export type LocalProjectionHeadRecord = LocalProjectionHeadIdentity & {
  headFingerprint: string
  headRevision: bigint
  compareAndSetFingerprint: string
  currentSourceId: string | null
  currentSourceFingerprint: string | null
  contribution: Readonly<Record<string, unknown>>
  createdAt: Date
  updatedAt: Date
}

export function projectionHeadFingerprint(identity: LocalProjectionHeadIdentity): string {
  return `head:v1:${identity.taskId}:${identity.workPackageId}:${identity.kind}:${identity.index}`
}

export function projectionSourceFingerprint(input: Readonly<{
  contribution: Readonly<Record<string, unknown>>
  kind: LocalProjectionHeadKind
  revision: bigint
  sourceId: string
  taskId: string
  workPackageId: string
}>): string {
  const canonicalContribution = JSON.stringify(
    Object.fromEntries(Object.entries(input.contribution).sort(([left], [right]) => left.localeCompare(right))),
  )
  return `sha256:${createHash('sha256').update([
    'projection-source:v1',
    input.taskId,
    input.workPackageId,
    input.kind,
    input.revision.toString(),
    input.sourceId,
    canonicalContribution,
  ].join(':')).digest('hex')}`
}

export function projectionHeadCompareAndSetFingerprint(input: Readonly<{
  headFingerprint: string
  sourceFingerprint: string
  revision: bigint
}>): string {
  return `sha256:${createHash('sha256').update([
    'projection-head-cas:v1',
    input.headFingerprint,
    input.revision.toString(),
    input.sourceFingerprint,
  ].join(':')).digest('hex')}`
}

export function assertProjectionHeadReassignment(
  current: { headId: string; kind: LocalProjectionHeadKind; headFingerprint: string },
  identity: LocalProjectionHeadIdentity,
): void {
  if (current.kind !== identity.kind) {
    throw new Error(
      `Projection head kind mismatch: expected ${current.kind}, got ${identity.kind}`,
    )
  }
  if (current.headFingerprint !== projectionHeadFingerprint(identity)) {
    throw new Error(
      `Projection head fingerprint mismatch for ${identity.kind} on ${identity.workPackageId}`,
    )
  }
}

export function assertProjectionHeadNotMissing(
  head: { headId: string; kind: LocalProjectionHeadKind } | null | undefined,
  identity: LocalProjectionHeadIdentity,
): asserts head is NonNullable<typeof head> {
  if (!head) {
    throw new Error(
      `Missing projection head: ${identity.kind} for package ${identity.workPackageId}`,
    )
  }
}

export function buildProjectionHeadIdentity(
  taskId: string,
  workPackageId: string,
  kind: LocalProjectionHeadKind,
  index: number,
): LocalProjectionHeadIdentity {
  return { headId: randomUUID(), taskId, workPackageId, kind, index }
}
