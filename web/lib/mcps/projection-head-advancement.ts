import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { workPackageLocalProjectionHeads } from '@/db/schema'
import {
  isLocalProjectionHeadKind,
  assertProjectionHeadNotMissing,
  assertProjectionHeadNotDeleted,
  projectionHeadFingerprint,
  type LocalProjectionHeadKind,
  type ProjectionHeadState,
} from './local-projection-heads'

type HeadRow = typeof workPackageLocalProjectionHeads.$inferSelect

export type ProjectionHeadAdvancement = {
  workPackageId: string
  kind: LocalProjectionHeadKind
  expectedFingerprint: string
  expectedVersion: bigint
  newState: ProjectionHeadState
  leaseToken?: string | null
  expiresAt?: Date | null
}

export type ProjectionHeadAdvancementResult = {
  headId: string
  advanced: boolean
  newVersion: bigint
  newFingerprint: string
}

export async function advanceLocalProjectionHead(
  input: ProjectionHeadAdvancement,
): Promise<ProjectionHeadAdvancementResult> {
  if (!isLocalProjectionHeadKind(input.kind)) {
    throw new Error(`Invalid projection head kind: ${input.kind}`)
  }
  const now = new Date()
  const [head] = await db
    .select()
    .from(workPackageLocalProjectionHeads)
    .where(
      and(
        eq(workPackageLocalProjectionHeads.workPackageId, input.workPackageId),
        eq(workPackageLocalProjectionHeads.headKind, input.kind),
      ),
    )
    .limit(1)

  assertProjectionHeadNotMissing(head, {
    headId: head?.id ?? '',
    taskId: head?.taskId ?? '',
    workPackageId: input.workPackageId,
    kind: input.kind as LocalProjectionHeadKind,
    index: Number(head?.headIndex ?? 0),
  })
  assertProjectionHeadNotDeleted(head)

  if (
    head.headFingerprint !== input.expectedFingerprint ||
    head.headVersion !== input.expectedVersion
  ) {
    return { headId: head.id, advanced: false, newVersion: head.headVersion, newFingerprint: head.headFingerprint }
  }

  const newVersion = head.headVersion + BigInt(1)
  const newFingerprint = projectionHeadFingerprint({
    headId: head.id,
    taskId: head.taskId,
    workPackageId: head.workPackageId,
    kind: input.kind,
    index: Number(head.headIndex),
  })

  const [updated] = await db
    .update(workPackageLocalProjectionHeads)
    .set({
      state: input.newState,
      headVersion: newVersion,
      headFingerprint: newFingerprint,
      leaseToken: input.leaseToken ?? null,
      expiresAt: input.expiresAt ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workPackageLocalProjectionHeads.id, head.id),
        eq(workPackageLocalProjectionHeads.headFingerprint, input.expectedFingerprint),
        eq(workPackageLocalProjectionHeads.headVersion, input.expectedVersion),
      ),
    )
    .returning()

  if (!updated) {
    return { headId: head.id, advanced: false, newVersion: head.headVersion, newFingerprint: head.headFingerprint }
  }

  return { headId: updated.id, advanced: true, newVersion, newFingerprint }
}

export async function readProjectionHead(input: {
  kind: LocalProjectionHeadKind
  workPackageId: string
}): Promise<HeadRow | null> {
  const [head] = await db
    .select()
    .from(workPackageLocalProjectionHeads)
    .where(
      and(
        eq(workPackageLocalProjectionHeads.workPackageId, input.workPackageId),
        eq(workPackageLocalProjectionHeads.headKind, input.kind),
      ),
    )
    .limit(1)
  return head ?? null
}

export async function readTaskProjectionHeads(input: {
  kind: LocalProjectionHeadKind
  taskId: string
}): Promise<readonly HeadRow[]> {
  return db
    .select()
    .from(workPackageLocalProjectionHeads)
    .where(
      and(
        eq(workPackageLocalProjectionHeads.taskId, input.taskId),
        eq(workPackageLocalProjectionHeads.headKind, input.kind),
      ),
    )
    .orderBy(eq(workPackageLocalProjectionHeads.headIndex, workPackageLocalProjectionHeads.headIndex))
}
