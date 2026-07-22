import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { approvalGates, artifacts, tasks, workPackages } from '@/db/schema'
import { getSession, readSessionCredential } from '@/lib/session'
import { accessibleTaskCondition, getAccessibleTask } from '@/lib/task-access'
import type { McpExecutionDesign } from '@/worker/mcp-execution-design'
import { ARCHITECT_PLAN_HEADER } from '@/lib/mcps/architect-plan-entries'
import { appendProtectedMcpOperatorReview, readArchitectPlanHistory } from '@/lib/mcps/history-reader'
import type { ArchitectPlanHistoryEntry } from '@/lib/mcps/history-reader'
import {
  buildMcpOperatorReview,
  mcpOperatorReviewSummary,
  validateMcpOperatorReviewHistory,
  type McpPlanReviewInput,
} from '@/worker/mcp-plan-review'
import { guardEpic172ProjectManagementIngress } from '@/lib/projects/epic-172-project-ingress'
import {
  materializeProtectedMcpReview,
  parseProtectedMcpReviewHead,
} from '@/lib/mcps/protected-mcp-review'
import { loadProtectedReviewPreflight } from '@/lib/mcps/protected-review-preflight'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protectedMcpDesignFromHistory(entries: readonly ArchitectPlanHistoryEntry[]): McpExecutionDesign | null {
  try {
    const requirements = entries
      .filter((entry) => entry.entryKind === 'requirement' && entry.requirementKey !== 'plan-policy')
      .map((entry) => {
        const parsed = JSON.parse(entry.content) as unknown
        if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.requirementKey !== entry.requirementKey) throw new Error('invalid requirement')
        const requirement = { ...parsed }
        delete requirement.schemaVersion
        return requirement
      })
    const requirementByKey = new Map(requirements.flatMap((requirement) =>
      typeof requirement.requirementKey === 'string' ? [[requirement.requirementKey, requirement] as const] : [],
    ))
    const requirementContexts = entries
      .filter((entry) => entry.entryKind === 'overlay')
      .map((entry) => {
        const requirement = entry.requirementKey ? requirementByKey.get(entry.requirementKey) : null
        if (!requirement || !entry.agent || typeof requirement.sourceRequirementIndex !== 'number' || typeof requirement.mcpId !== 'string') {
          throw new Error('invalid overlay')
        }
        return {
          requirementKey: entry.requirementKey!,
          sourceRequirementIndex: requirement.sourceRequirementIndex,
          agent: entry.agent,
          mcpId: requirement.mcpId,
          promptOverlay: entry.content,
        }
      })
    const mcpAwareSubtasks = entries
      .filter((entry) => entry.entryKind === 'subtask')
      .map((entry) => {
        const parsed = JSON.parse(entry.content) as unknown
        if (!isRecord(parsed) || parsed.schemaVersion !== 1) throw new Error('invalid subtask')
        const subtask = { ...parsed }
        delete subtask.schemaVersion
        return subtask
      })
    return {
      schemaVersion: 1,
      requirements,
      promptOverlays: {},
      requirementContexts,
      mcpAwareSubtasks,
      normalizationErrors: [],
    } as unknown as McpExecutionDesign
  } catch {
    return null
  }
}

function proposedReviewItems(
  design: McpExecutionDesign,
  decisions: ReadonlyMap<string, 'approved' | 'denied'>,
): McpPlanReviewInput['items'] {
  return design.requirements.map((requirement) => {
    const requirementKey = requirement.requirementKey!
    const decision = decisions.get(requirementKey) ?? 'approved'
    if (decision === 'denied') {
      return {
        requirementKey, decision,
        assignment: { type: 'agent' as const, targetAgents: [], targetId: null },
        agentPermissions: {}, promptOverlays: {},
      }
    }
    const contexts = (design.requirementContexts ?? []).filter((context) => context.requirementKey === requirementKey)
    return {
      requirementKey, decision,
      assignment: requirement.assignment,
      agentPermissions: requirement.agentPermissions,
      promptOverlays: {
        ...Object.fromEntries(contexts.map((context) => [context.agent, context.promptOverlay])),
        ...Object.fromEntries(Object.entries(design.promptOverlays).filter(([agent]) =>
          requirement.assignment.targetAgents.includes(agent) || Object.hasOwn(requirement.agentPermissions, agent))),
      },
    }
  })
}

function parseReviewInput(value: unknown): McpPlanReviewInput | null {
  if (!isRecord(value) || typeof value.sourceArtifactId !== 'string' || value.sourceArtifactId.length > 100 || !Number.isSafeInteger(value.baseRevision)) return null
  if ((value.baseRevision as number) < 0 || (value.baseRevision as number) > 32) return null
  if (value.baseDigest !== null && (typeof value.baseDigest !== 'string'
    || !/^(?:[a-f0-9]{64}|hmac-sha256:[a-f0-9]{64})$/.test(value.baseDigest))) return null
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

    // Resolve protected content before opening the ordinary FOR UPDATE
    // transaction. Holding an application-row lock while the fixed history
    // principal appends its own locked version would invert the lock order.
    const protectedPreflight = await loadProtectedReviewPreflight({
      sourceArtifactId: body.sourceArtifactId,
      taskId,
    })
    if (protectedPreflight) {
        const { gate: preflightGate, sourcePlanVersion } = protectedPreflight
        const gateMetadata = isRecord(preflightGate.metadata) ? preflightGate.metadata : {}
        const sessionCredential = readSessionCredential(request)
        if (!sessionCredential) {
          return NextResponse.json({ error: 'The protected Architect plan is not available for review.' }, { status: 409 })
        }
        let proposed: McpExecutionDesign | null = null
        try {
          const history = await readArchitectPlanHistory({
            planVersion: sourcePlanVersion,
            sessionCredential,
            taskId,
          })
          const planBodies = history.filter((entry) => entry.entryKind === 'plan_body' && entry.entryId === 'plan_body:000000')
          if (planBodies.length === 1) proposed = protectedMcpDesignFromHistory(history)
        } catch {
          proposed = null
        }
        if (!proposed || !Array.isArray(proposed.requirements)) {
          return NextResponse.json({ error: 'The protected Architect plan is not available for review.' }, { status: 409 })
        }
        const packages = await db.select({ assignedRole: workPackages.assignedRole })
          .from(workPackages).where(eq(workPackages.taskId, taskId))
        const priorHead = gateMetadata.protectedMcpReview === undefined
          ? null
          : parseProtectedMcpReviewHead(gateMetadata.protectedMcpReview, body.sourceArtifactId)
        if (gateMetadata.protectedMcpReview !== undefined && !priorHead) {
          return NextResponse.json({ error: 'Protected MCP review history is invalid. Replan before reviewing.' }, { status: 409 })
        }
        const previous = priorHead
          ? { revision: priorHead.revision, digest: priorHead.reviewSetDigest } as Parameters<typeof buildMcpOperatorReview>[0]['previous']
          : null
        let review
        try {
          review = buildMcpOperatorReview({
            proposedDesign: proposed,
            plannedAgents: packages.map((pkg) => pkg.assignedRole),
            review: body,
            previous,
            createdBy: session.userId,
          })
          const expected = buildMcpOperatorReview({
            proposedDesign: proposed,
            plannedAgents: packages.map((pkg) => pkg.assignedRole),
            review: {
              sourceArtifactId: body.sourceArtifactId,
              baseRevision: body.baseRevision,
              baseDigest: body.baseDigest,
              items: proposedReviewItems(proposed, new Map(review.items.map((item) => [item.requirementKey, item.decision]))),
            },
            previous,
            createdBy: session.userId,
            createdAt: new Date(review.createdAt),
          })
          if (JSON.stringify(expected.items) !== JSON.stringify(review.items)) {
            return NextResponse.json({
              error: 'Protected MCP review may approve or deny requirements, but cannot rewrite protected routing or prompt context.',
            }, { status: 409 })
          }
        } catch (error) {
          return NextResponse.json({ error: error instanceof Error ? error.message : 'MCP plan review failed.' }, { status: 409 })
        }
        const digestHex = process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX?.trim() ?? ''
        const digestKeyId = process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID?.trim() ?? ''
        if (!/^[a-f0-9]{64,}$/.test(digestHex) || !/^[a-z0-9._-]{1,64}$/.test(digestKeyId)) {
          return NextResponse.json({ error: 'Protected MCP review storage is not configured.' }, { status: 409 })
        }
        const digestKey = Buffer.from(digestHex, 'hex')
        try {
          const materialized = materializeProtectedMcpReview({
            approvalGateId: preflightGate.id,
            digestKey,
            digestKeyId,
            review,
            sourcePlanVersion,
            taskId,
          })
          try {
            await appendProtectedMcpOperatorReview({
              approvalGateId: preflightGate.id,
              entries: materialized.entries,
              head: materialized.head,
              previousReviewSetDigest: materialized.previousReviewSetDigest,
              sessionCredential,
              sourcePlanVersion,
            })
          } catch (error) {
            if (isRecord(error) && error.code === 'conflict') {
              return NextResponse.json({
                error: 'The protected MCP review changed while it was saved. Reload and review again.',
              }, { status: 409 })
            }
            throw error
          }
          const postAppendValid = await db.transaction(async (tx) => {
            const [lockedTask] = await tx.select().from(tasks)
              .where(and(accessibleTaskCondition(taskId, session.userId), eq(tasks.status, 'awaiting_approval')))
              .for('update')
            if (!lockedTask) return false
            const [lockedGate] = await tx.select().from(approvalGates).where(and(
              eq(approvalGates.id, preflightGate.id),
              eq(approvalGates.status, 'pending'),
              eq(approvalGates.sourceArtifactId, body.sourceArtifactId),
            )).for('update')
            if (!lockedGate || !isRecord(lockedGate.metadata)) return false
            const lockedHead = parseProtectedMcpReviewHead(
              lockedGate.metadata.protectedMcpReview,
              body.sourceArtifactId,
            )
            return lockedHead?.sourcePlanVersion === sourcePlanVersion
              && lockedHead.revision === materialized.head.revision
              && lockedHead.reviewSetDigest === materialized.head.reviewSetDigest
          })
          if (!postAppendValid) {
            return NextResponse.json({ error: 'The Architect plan changed while the protected review was saved.' }, { status: 409 })
          }
          return NextResponse.json({ review: materialized.head })
        } finally {
          digestKey.fill(0)
        }
    }

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
      const gateMetadata = isRecord(gate.metadata) ? gate.metadata : {}
      const protectedArtifact = artifact?.content === ARCHITECT_PLAN_HEADER
        || artifactMetadata?.historyAvailable === true
      if (protectedArtifact) {
        return { status: 409 as const, error: 'The protected Architect plan changed. Reload before reviewing MCP access.' }
      }
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
      const historyValidation = validateMcpOperatorReviewHistory(gateMetadata, gate.sourceArtifactId)
      if (!historyValidation.valid) {
        return { status: 409 as const, error: historyValidation.error }
      }
      const previous = historyValidation.head
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
        mcpOperatorReviews: [...historyValidation.history, review],
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
