import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { workPackageLocalProjectionHeads } from '@/db/schema'
import {
  CURRENT_LOCAL_PROJECTION_HEAD_KINDS,
  isLocalProjectionHeadKind,
  projectionHeadCompareAndSetFingerprint,
  projectionSourceFingerprint,
  type LocalProjectionHeadKind,
} from './local-projection-heads'

type HeadRow = typeof workPackageLocalProjectionHeads.$inferSelect

export type ProjectionHeadAdvancement = Readonly<{
  contribution: Readonly<Record<string, unknown>>
  expectedFingerprint: string
  expectedRevision: bigint
  kind: LocalProjectionHeadKind
  sourceId: string
  taskId: string
  workPackageId: string
}>

export type ProjectionHeadAdvancementResult = Readonly<{
  advanced: boolean
  headId: string
  newFingerprint: string
  newRevision: bigint
}>

export async function advanceLocalProjectionHead(
  input: ProjectionHeadAdvancement,
): Promise<ProjectionHeadAdvancementResult> {
  if (!isLocalProjectionHeadKind(input.kind)) {
    throw new Error(`Invalid projection head kind: ${input.kind}`)
  }
  const sourceRevision = input.expectedRevision + BigInt(1)
  const sourceFingerprint = projectionSourceFingerprint({
    contribution: input.contribution,
    kind: input.kind,
    revision: sourceRevision,
    sourceId: input.sourceId,
    taskId: input.taskId,
    workPackageId: input.workPackageId,
  })
  const nextFingerprint = projectionHeadCompareAndSetFingerprint({
    headFingerprint: `head:v1:${input.taskId}:${input.workPackageId}:${input.kind}:${
      CURRENT_LOCAL_PROJECTION_HEAD_KINDS.indexOf(input.kind)
    }`,
    revision: sourceRevision,
    sourceFingerprint,
  })

  const rows = await db.execute<{
    advanced: boolean
    headId: string
    headRevision: bigint
    compareAndSetFingerprint: string
  }>(sql`
    select *
    from forge.advance_local_projection_head_v1(
      ${input.taskId}::uuid,
      ${input.workPackageId}::uuid,
      ${input.kind}::text,
      ${input.sourceId}::uuid,
      ${sourceRevision}::bigint,
      ${sourceFingerprint}::text,
      ${JSON.stringify(input.contribution)}::jsonb,
      ${input.expectedRevision}::bigint,
      ${input.expectedFingerprint}::text,
      ${nextFingerprint}::text
    )
  `)
  const [result] = rows
  if (!result) throw new Error('Projection-head advancement returned no result.')
  return {
    advanced: result.advanced,
    headId: result.headId,
    newFingerprint: result.compareAndSetFingerprint,
    newRevision: result.headRevision,
  }
}

export async function readProjectionHead(input: {
  kind: LocalProjectionHeadKind
  workPackageId: string
}): Promise<HeadRow | null> {
  const [head] = await db
    .select()
    .from(workPackageLocalProjectionHeads)
    .where(and(
      eq(workPackageLocalProjectionHeads.workPackageId, input.workPackageId),
      eq(workPackageLocalProjectionHeads.headKind, input.kind),
    ))
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
    .where(and(
      eq(workPackageLocalProjectionHeads.taskId, input.taskId),
      eq(workPackageLocalProjectionHeads.headKind, input.kind),
    ))
    .orderBy(
      asc(workPackageLocalProjectionHeads.workPackageId),
      asc(workPackageLocalProjectionHeads.headIndex),
    )
}
