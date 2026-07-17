import { createHash, randomUUID } from 'node:crypto'
import { eq, and, lte, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { workPackageLocalRunEvidence as wplreTable } from '@/db/schema'

export type S4LeaseLeaseKind =
  | 'execution'
  | 'local_evidence'
  | 'issuance'

export const S4_LEASE_DEFAULTS: Record<S4LeaseLeaseKind, { ttlSeconds: number; maxExtensions: number }> = {
  execution: { ttlSeconds: 600, maxExtensions: 3 },
  local_evidence: { ttlSeconds: 900, maxExtensions: 5 },
  issuance: { ttlSeconds: 300, maxExtensions: 2 },
}

type WorkPackageLocalRunEvidence = typeof wplreTable.$inferSelect

export function claimS4LeaseToken(input: {
  kind: S4LeaseLeaseKind
  workPackageId: string
}): {
  claimToken: string
  digest: Buffer
} {
  const claimToken = randomUUID()
  const hmac = createHash('sha256')
  hmac.update(`forge:s4-lease:${input.kind}:v1\0`)
  hmac.update(`${input.workPackageId}\0${claimToken}`)
  return { claimToken, digest: hmac.digest() }
}

export function s4LeaseTtl(input: {
  kind: S4LeaseLeaseKind
}): number {
  return S4_LEASE_DEFAULTS[input.kind].ttlSeconds
}

export function s4MaxLeaseExtensions(input: {
  kind: S4LeaseLeaseKind
}): number {
  return S4_LEASE_DEFAULTS[input.kind].maxExtensions
}

export function computeS4LeaseExpiry(issuedAt: Date, kind: S4LeaseLeaseKind): Date {
  return new Date(issuedAt.getTime() + s4LeaseTtl({ kind }) * 1000)
}

export function isS4LeaseExpired(lease: {
  leaseExpiresAt: Date | null
}): boolean {
  if (!lease.leaseExpiresAt) return true
  return Date.now() > lease.leaseExpiresAt.getTime()
}

export async function advanceS4LeaseState(input: {
  claimToken: string
  state: 'terminal' | 'uncertain'
  workPackageId: string
}): Promise<WorkPackageLocalRunEvidence | null> {
  const now = new Date()
  const terminalAt = input.state === 'terminal' ? now : null
  const [updated] = await db
    .update(wplreTable)
    .set({
      state: input.state,
      terminalAt,
    })
    .where(
      and(
        eq(wplreTable.claimToken, input.claimToken),
        eq(wplreTable.workPackageId, input.workPackageId),
        eq(wplreTable.state, 'claimed'),
      ),
    )
    .returning()
  return updated ?? null
}

export async function retainS4LeaseHeartbeat(input: {
  claimToken: string
  workPackageId: string
}): Promise<WorkPackageLocalRunEvidence | null> {
  const now = new Date()
  const [updated] = await db
    .update(wplreTable)
    .set({
      leaseExpiresAt: new Date(now.getTime() + S4_LEASE_DEFAULTS.execution.ttlSeconds * 1000),
    })
    .where(
      and(
        eq(wplreTable.claimToken, input.claimToken),
        eq(wplreTable.workPackageId, input.workPackageId),
        eq(wplreTable.state, 'claimed'),
        lte(wplreTable.leaseExpiresAt, new Date()),
      ),
    )
    .returning()
  return updated ?? null
}

export async function drainExpiredS4Leases(): Promise<number> {
  const now = new Date()
  const result = await db
    .update(wplreTable)
    .set({
      state: 'uncertain',
    })
    .where(
      and(
        eq(wplreTable.state, 'claimed'),
        lte(wplreTable.leaseExpiresAt, now),
        isNull(wplreTable.terminalAt),
      ),
    )
    .returning({ state: wplreTable.state })
  return result.length
}

type S4LeaseInsert = typeof wplreTable.$inferInsert

export async function insertS4LeaseEvidence(input: {
  agentRunId: string
  claimToken: string
  leaseExpiresAt: Date
  taskId: string
  workPackageId: string
}): Promise<WorkPackageLocalRunEvidence> {
  const [inserted] = await db
    .insert(wplreTable)
    .values({
      agentRunId: input.agentRunId,
      claimToken: input.claimToken,
      leaseExpiresAt: input.leaseExpiresAt,
      taskId: input.taskId,
      workPackageId: input.workPackageId,
      state: 'claimed',
    } as S4LeaseInsert)
    .returning()
  if (!inserted) throw new Error('Failed to insert S4 lease evidence')
  return inserted
}
