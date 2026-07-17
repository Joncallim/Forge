import { randomUUID } from 'node:crypto'

export const CURRENT_LOCAL_PROJECTION_HEAD_KINDS = [
  'filesystem_grant_decision',
  'execution_evidence',
  'claim_token',
  'lease_expiry',
  'recovery_marker',
  'integrity_hold',
  'terminal_state',
  'artifact_reference',
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

export type ProjectionHeadState =
  | 'preallocated'
  | 'claimed'
  | 'active'
  | 'terminal'
  | 'uncertain'

export const PROJECTION_HEAD_STATES: ReadonlySet<ProjectionHeadState> = new Set([
  'preallocated',
  'claimed',
  'active',
  'terminal',
  'uncertain',
])

export type LocalProjectionHeadIdentity = Readonly<{
  headId: string
  workPackageId: string
  kind: LocalProjectionHeadKind
  index: number
}>

export type LocalProjectionHeadRecord = LocalProjectionHeadIdentity & {
  state: ProjectionHeadState
  headFingerprint: string
  headVersion: bigint
  leaseToken: string | null
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export function projectionHeadFingerprint(identity: LocalProjectionHeadIdentity): string {
  return `head:v1:${identity.workPackageId}:${identity.kind}:${identity.index}`
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

export function assertProjectionHeadNotDeleted(record: { state: string }): void {
  if (record.state === 'deleted') {
    throw new Error('Cannot operate on a deleted projection head')
  }
}

export function buildProjectionHeadIdentity(
  workPackageId: string,
  kind: LocalProjectionHeadKind,
  index: number,
): LocalProjectionHeadIdentity {
  return { headId: randomUUID(), workPackageId, kind, index }
}
