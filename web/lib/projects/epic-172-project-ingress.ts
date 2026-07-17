import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import type { ForgeEpic172EnablementState } from '@/db/schema'

const PROVISIONAL_WINDOW_MS = 1_560_000
const MAX_CONTROLLER_LEASE_MS = 45_000
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

type EnablementState = Pick<
  ForgeEpic172EnablementState,
  | 'state'
  | 'ownerOperationId'
  | 'exactBuilds'
  | 'reviewedSha'
  | 'epoch'
  | 'startedAt'
  | 'expiresAt'
  | 'enablementReceiptId'
  | 'finalReadinessReceiptId'
  | 'openingAuthorizationId'
  | 'controllerLoginId'
  | 'controllerRunId'
  | 'controllerTokenDigest'
  | 'leaseGeneration'
  | 'lastHeartbeatAt'
  | 'leaseExpiresAt'
  | 'stateFingerprint'
>

export type Epic172ProjectIngressBlockReason =
  | 'missing_state'
  | 'disabled'
  | 'invalid_state'
  | 'incomplete_identity'
  | 'invalid_timeline'
  | 'expired_provisional_window'
  | 'expired_controller_lease'
  | 'database_unavailable'

export type Epic172ProjectIngressDecision =
  | { allowed: true; state: 'active' | 'provisional' }
  | { allowed: false; reason: Epic172ProjectIngressBlockReason }

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isExactBuildSet(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false
  if (!value.every(isNonEmptyText)) return false
  return new Set(value).size === value.length
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function isDigestBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === 32
}

function hasCoreIdentity(state: EnablementState): boolean {
  return isNonEmptyText(state.ownerOperationId)
    && isExactBuildSet(state.exactBuilds)
    && typeof state.reviewedSha === 'string'
    && SHA_PATTERN.test(state.reviewedSha)
    && Number.isSafeInteger(state.epoch)
    && (state.epoch ?? 0) > 0
    && isNonEmptyText(state.enablementReceiptId)
    && isNonEmptyText(state.openingAuthorizationId)
    && isNonEmptyText(state.controllerLoginId)
    && isNonEmptyText(state.controllerRunId)
    && DIGEST_PATTERN.test(state.stateFingerprint)
}

export function decideEpic172ProjectManagementIngress(
  state: EnablementState | null,
  databaseNow: Date,
): Epic172ProjectIngressDecision {
  if (!state) return { allowed: false, reason: 'missing_state' }
  if (!isDate(databaseNow)) return { allowed: false, reason: 'invalid_timeline' }
  if (state.state === 'disabled') return { allowed: false, reason: 'disabled' }
  if (state.state !== 'provisional' && state.state !== 'active') {
    return { allowed: false, reason: 'invalid_state' }
  }
  if (!hasCoreIdentity(state)) return { allowed: false, reason: 'incomplete_identity' }

  if (state.state === 'active') {
    const exactActive = isNonEmptyText(state.finalReadinessReceiptId)
      && isDate(state.startedAt)
      && state.expiresAt === null
      && state.controllerTokenDigest === null
      && state.leaseGeneration === null
      && state.lastHeartbeatAt === null
      && state.leaseExpiresAt === null
    return exactActive
      ? { allowed: true, state: 'active' }
      : { allowed: false, reason: 'incomplete_identity' }
  }

  if (
    state.finalReadinessReceiptId !== null
    || !isDate(state.startedAt)
    || !isDate(state.expiresAt)
    || !isDigestBytes(state.controllerTokenDigest)
    || !Number.isSafeInteger(state.leaseGeneration)
    || (state.leaseGeneration ?? 0) <= 0
    || !isDate(state.lastHeartbeatAt)
    || !isDate(state.leaseExpiresAt)
  ) {
    return { allowed: false, reason: 'incomplete_identity' }
  }

  const nowMs = databaseNow.getTime()
  const startedMs = state.startedAt.getTime()
  const expiresMs = state.expiresAt.getTime()
  const heartbeatMs = state.lastHeartbeatAt.getTime()
  const leaseExpiresMs = state.leaseExpiresAt.getTime()
  if (
    expiresMs !== startedMs + PROVISIONAL_WINDOW_MS
    || startedMs > nowMs
    || heartbeatMs < startedMs
    || heartbeatMs > nowMs
    || leaseExpiresMs <= heartbeatMs
    || leaseExpiresMs > Math.min(heartbeatMs + MAX_CONTROLLER_LEASE_MS, expiresMs)
  ) {
    return { allowed: false, reason: 'invalid_timeline' }
  }
  if (nowMs >= expiresMs) return { allowed: false, reason: 'expired_provisional_window' }
  if (nowMs >= leaseExpiresMs) return { allowed: false, reason: 'expired_controller_lease' }
  return { allowed: true, state: 'provisional' }
}

export async function readEpic172ProjectManagementIngress(): Promise<Epic172ProjectIngressDecision> {
  try {
    const rows = await db.execute<EnablementState & { databaseNow: Date }>(sql`
      select
        state,
        owner_operation_id as "ownerOperationId",
        exact_builds as "exactBuilds",
        reviewed_sha as "reviewedSha",
        epoch,
        started_at as "startedAt",
        expires_at as "expiresAt",
        enablement_receipt_id::text as "enablementReceiptId",
        final_readiness_receipt_id::text as "finalReadinessReceiptId",
        opening_authorization_id::text as "openingAuthorizationId",
        controller_login_id as "controllerLoginId",
        controller_run_id as "controllerRunId",
        controller_token_digest as "controllerTokenDigest",
        lease_generation as "leaseGeneration",
        last_heartbeat_at as "lastHeartbeatAt",
        lease_expires_at as "leaseExpiresAt",
        state_fingerprint as "stateFingerprint",
        database_now as "databaseNow"
      from forge.read_epic_172_enablement_state_v1()
    `)

    if (rows.length !== 1) return { allowed: false, reason: 'missing_state' }
    const { databaseNow, ...state } = rows[0]
    return decideEpic172ProjectManagementIngress(state, databaseNow)
  } catch {
    return { allowed: false, reason: 'database_unavailable' }
  }
}

export async function guardEpic172ProjectManagementIngress(): Promise<NextResponse | null> {
  const decision = await readEpic172ProjectManagementIngress()
  if (decision.allowed) return null
  return NextResponse.json(
    {
      error: 'Project management is temporarily disabled while release safety checks are incomplete.',
      code: 'epic_172_project_management_ingress_closed',
      reason: decision.reason,
    },
    { status: 503 },
  )
}
