import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { approvalGates, artifacts } from '@/db/schema'
import { ARCHITECT_PLAN_HEADER } from './architect-plan-entries'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type ProtectedReviewPreflight = {
  gate: typeof approvalGates.$inferSelect
  sourcePlanVersion: string
}

async function load(input: {
  taskId: string
  sourceArtifactId?: string
}): Promise<ProtectedReviewPreflight | null> {
  const [gate] = await db.select().from(approvalGates).where(and(
    eq(approvalGates.taskId, input.taskId),
    eq(approvalGates.gateType, 'plan_approval'),
    eq(approvalGates.status, 'pending'),
    ...(input.sourceArtifactId ? [eq(approvalGates.sourceArtifactId, input.sourceArtifactId)] : []),
  )).limit(1)
  if (!gate?.sourceArtifactId) return null
  const [artifact] = await db.select().from(artifacts)
    .where(eq(artifacts.id, gate.sourceArtifactId)).limit(1)
  const artifactMetadata = artifact && isRecord(artifact.metadata) ? artifact.metadata : null
  const protectedArtifact = artifact?.content === ARCHITECT_PLAN_HEADER
    || artifactMetadata?.historyAvailable === true
  if (!protectedArtifact) return null
  const gateMetadata = isRecord(gate.metadata) ? gate.metadata : {}
  const sourcePlanVersion = typeof gateMetadata.planVersion === 'string'
    && /^[1-9][0-9]{0,18}$/.test(gateMetadata.planVersion)
    ? gateMetadata.planVersion
    : null
  return sourcePlanVersion ? { gate, sourcePlanVersion } : null
}

export async function loadProtectedReviewPreflight(input: {
  taskId: string
  sourceArtifactId: string
}): Promise<ProtectedReviewPreflight | null> {
  return load(input)
}

export async function loadProtectedApprovalReviewPreflight(input: {
  taskId: string
}): Promise<ProtectedReviewPreflight | null> {
  return load(input)
}
