import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { approvalGates, artifacts, tasks, workPackages } from '@/db/schema'
import { getSession, readSessionCredential } from '@/lib/session'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'
import { readArchitectPlanHistory } from '@/lib/mcps/history-reader'
import type { McpExecutionDesign } from '@/worker/mcp-execution-design'
import {
  buildMcpOperatorReview,
  mcpOperatorReviewSummary,
  validateMcpOperatorReviewHistory,
  type McpPlanReviewInput,
} from '@/worker/mcp-plan-review'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReviewInput(value: unknown): McpPlanReviewInput | null {
  if (!isRecord(value) || typeof value.sourceArtifactId !== 'string' || value.sourceArtifactId.length > 100 || !Number.isSafeInteger(value.baseRevision)) return null
  if ((value.baseRevision as number) < 0 || (value.baseRevision as number) > 32) return null
  if (value.baseDigest !== null && (typeof value.baseDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.baseDigest))) return null
  if (!Array.isArray(value.items) || value.items.length > 20) return null
  const items = value.items.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.requirementKey !== 'string' || raw.requirementKey.length > 160 || !['approved', 'denied'].includes(String(raw.decision))) return []
    if (!isRecord(raw.assignment) || typeof raw.assignment.type !== 'string' || raw.assignment.type.length > 40 || !Array.isArray(raw.assignment.targetAgents)) return []
    if (raw.assignment.targetAgents.length > 6 || !raw.assignment.targetAgents.every((agent) => typeof agent === 'string' && agent.length <= 40)) return []
    if (raw.assignment.targetId !== null && (typeof raw.assignment.targetId !== 'string' || raw.assignment.targetId.length > 80)) return []
    if (!isRecord(raw.agentPermissions) || !isRecord(raw.promptOverlays)) return []
    if (Object.keys(raw.agentPermissions).length > 6 || Object.keys(raw.promptOverlays).length > 6) return []
    if (Object.keys(raw.agentPermissions).some((agent) => agent.length > 40) || Object.keys(raw.promptOverlays).some((agent) => agent.length > 40)) return []
    const permissionEntries = Object.entries(raw.agentPermissions)
    const overlayEntries = Object.entries(raw.promptOverlays)
    if (permissionEntries.some(([, capabilities]) => !Array.isArray(capabilities) || capabilities.length > 20 || !capabilities.every((capability) => typeof capability === 'string' && capability.length <= 100))) return []
    if (overlayEntries.some(([, overlay]) => typeof overlay !== 'string' || overlay.length > 1000)) return []
    const targetAgents = raw.assignment.targetAgents as string[]
    const agentPermissions = Object.fromEntries(permissionEntries.flatMap(([agent, capabilities]) => (
      Array.isArray(capabilities)
        ? [[agent, capabilities as string[]]]
        : []
    )))
    const promptOverlays = Object.fromEntries(overlayEntries.flatMap(([agent, overlay]) => (
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id: taskId } = await params
    const existing = await getAccessibleTask(taskId, session.userId)
    if (!existing) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

    const sessionCredential = readSessionCredential(request)
    if (!sessionCredential) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const requestedVersion = new URL(request.url).searchParams.get('planVersion') ?? '1'
    if (!/^[1-9][0-9]{0,18}$/.test(requestedVersion)) {
      return NextResponse.json({ error: 'Invalid Architect plan version.' }, { status: 400 })
    }
    const entries = await readArchitectPlanHistory({
      planVersion: requestedVersion,
      sessionCredential,
      taskId,
    })

    return NextResponse.json({ taskId, planVersion: requestedVersion, entries })
  } catch (err) {
    console.error('[mcp-plan-review GET] Unexpected error', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const ingressBlock = await guardEpic172ProjectManagementIngress()
    if (ingressBlock) return ingressBlock
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
      const gateMetadata = isRecord(gate.metadata) ? gate.metadata : {}
      const historyValidation = validateMcpOperatorReviewHistory(gateMetadata, gate.sourceArtifactId)
      if (!historyValidation.valid) {
        return { status: 409 as const, error: historyValidation.error }
      }
      const { head: previous, history } = historyValidation
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
      const updatedMetadata = {
        ...gateMetadata,
        mcpOperatorReviews: [...history, review],
        mcpOperatorReview: mcpOperatorReviewSummary(review),
      }
      const updatedValidation = validateMcpOperatorReviewHistory(updatedMetadata, gate.sourceArtifactId)
      if (!updatedValidation.valid) {
        return { status: 409 as const, error: updatedValidation.error }
      }
      await tx.update(approvalGates).set({
        metadata: updatedMetadata,
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
