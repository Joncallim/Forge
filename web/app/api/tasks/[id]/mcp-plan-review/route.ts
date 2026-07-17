import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { approvalGates, artifacts, tasks, workPackages } from '@/db/schema'
import { getSession } from '@/lib/session'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'
import type { McpExecutionDesign } from '@/worker/mcp-execution-design'
import {
  buildMcpOperatorReview,
  latestMcpOperatorReview,
  mcpOperatorReviewHistory,
  type McpPlanReviewInput,
} from '@/worker/mcp-plan-review'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReviewInput(value: unknown): McpPlanReviewInput | null {
  if (!isRecord(value) || typeof value.sourceArtifactId !== 'string' || !Number.isSafeInteger(value.baseRevision)) return null
  if (value.baseDigest !== null && typeof value.baseDigest !== 'string') return null
  if (!Array.isArray(value.items) || value.items.length > 20) return null
  const items = value.items.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.requirementKey !== 'string' || !['approved', 'denied'].includes(String(raw.decision))) return []
    if (!isRecord(raw.assignment) || typeof raw.assignment.type !== 'string' || !Array.isArray(raw.assignment.targetAgents)) return []
    if (raw.assignment.targetId !== null && typeof raw.assignment.targetId !== 'string') return []
    if (!isRecord(raw.agentPermissions) || !isRecord(raw.promptOverlays)) return []
    const targetAgents = raw.assignment.targetAgents.filter((agent): agent is string => typeof agent === 'string')
    const agentPermissions = Object.fromEntries(Object.entries(raw.agentPermissions).flatMap(([agent, capabilities]) => (
      Array.isArray(capabilities) && capabilities.every((capability) => typeof capability === 'string')
        ? [[agent, capabilities as string[]]]
        : []
    )))
    const promptOverlays = Object.fromEntries(Object.entries(raw.promptOverlays).flatMap(([agent, overlay]) => (
      typeof overlay === 'string' ? [[agent, overlay]] : []
    )))
    return [{
      requirementKey: raw.requirementKey,
      decision: raw.decision as 'approved' | 'denied',
      assignment: {
        type: raw.assignment.type as McpPlanReviewInput['items'][number]['assignment']['type'],
        targetAgents,
        targetId: raw.assignment.targetId,
      },
      agentPermissions,
      promptOverlays,
    }]
  })
  return items.length === value.items.length
    ? {
        sourceArtifactId: value.sourceArtifactId,
        baseRevision: value.baseRevision as number,
        baseDigest: value.baseDigest,
        items,
      }
    : null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id: taskId } = await params
    const existing = await getAccessibleTask(taskId, session.userId)
    if (!existing) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    if (existing.status !== 'awaiting_approval') {
      return NextResponse.json({ error: 'MCP plan review is only available while the task awaits approval.' }, { status: 409 })
    }
    const body = parseReviewInput(await request.json().catch(() => null))
    if (!body) return NextResponse.json({ error: 'Invalid MCP plan review payload.' }, { status: 400 })

    const result = await db.transaction(async (tx) => {
      const [lockedTask] = await tx.select().from(tasks)
        .where(and(accessibleTaskCondition(taskId, session.userId), eq(tasks.status, 'awaiting_approval')))
        .for('update')
      if (!lockedTask) return { status: 409 as const, error: 'Task is no longer awaiting approval.' }
      const [gate] = await tx.select().from(approvalGates).where(and(
        eq(approvalGates.taskId, taskId),
        eq(approvalGates.gateType, 'plan_approval'),
        eq(approvalGates.status, 'pending'),
      )).for('update')
      if (!gate || !gate.sourceArtifactId) return { status: 409 as const, error: 'The pending plan gate has no source Architect artifact.' }
      if (gate.sourceArtifactId !== body.sourceArtifactId) {
        return { status: 409 as const, error: 'The Architect plan changed. Reload before reviewing MCP access.' }
      }
      const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, gate.sourceArtifactId)).limit(1)
      const artifactMetadata = artifact && isRecord(artifact.metadata) ? artifact.metadata : null
      const mcpExecutionDesign = artifactMetadata && isRecord(artifactMetadata.mcpExecutionDesign)
        ? artifactMetadata.mcpExecutionDesign
        : null
      const proposed = mcpExecutionDesign && isRecord(mcpExecutionDesign.proposed)
        ? mcpExecutionDesign.proposed as McpExecutionDesign
        : null
      if (!proposed || !Array.isArray(proposed.requirements)) {
        return { status: 409 as const, error: 'The Architect artifact has no reviewable MCP execution design.' }
      }
      const packages = await tx.select({ assignedRole: workPackages.assignedRole })
        .from(workPackages).where(eq(workPackages.taskId, taskId))
      const history = mcpOperatorReviewHistory(gate.metadata)
      const previous = latestMcpOperatorReview(gate.metadata)
      const gateMetadata = isRecord(gate.metadata) ? gate.metadata : {}
      if (
        (Array.isArray(gateMetadata.mcpOperatorReviews) && gateMetadata.mcpOperatorReviews.length !== history.length) ||
        (isRecord(gateMetadata.mcpOperatorReview) && !previous)
      ) {
        return { status: 409 as const, error: 'The saved MCP review history failed its integrity check. Revise the plan before continuing.' }
      }
      let review
      try {
        review = buildMcpOperatorReview({
          proposedDesign: proposed,
          plannedAgents: packages.map((pkg) => pkg.assignedRole),
          review: body,
          previous,
          createdBy: session.userId,
        })
      } catch (error) {
        return { status: 409 as const, error: error instanceof Error ? error.message : 'MCP plan review failed.' }
      }
      await tx.update(approvalGates).set({
        metadata: {
          ...gateMetadata,
          mcpOperatorReviews: [...history, review],
          mcpOperatorReview: {
            schemaVersion: 1,
            sourceArtifactId: review.sourceArtifactId,
            revision: review.revision,
            digest: review.digest,
            blockers: review.blockers,
          },
        },
        updatedAt: new Date(review.createdAt),
      }).where(and(eq(approvalGates.id, gate.id), eq(approvalGates.status, 'pending')))
      return { status: 200 as const, review }
    })
    return result.status === 200
      ? NextResponse.json({ review: result.review })
      : NextResponse.json({ error: result.error }, { status: result.status })
  } catch (error) {
    console.error('[POST /api/tasks/:id/mcp-plan-review] Unexpected error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
