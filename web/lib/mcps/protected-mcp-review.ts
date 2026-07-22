import { createHmac } from 'node:crypto'
import { canonicalArchitectPlanJson } from './architect-plan-entries'
import type { McpOperatorReviewRecord, McpPlanReviewItemInput } from '@/worker/mcp-plan-review'

const REVIEW_ENTRY_DOMAIN_V1 = Buffer.from('forge:mcp-operator-review-entry:v1\0', 'utf8')
const REVIEW_SET_DOMAIN_V1 = Buffer.from('forge:mcp-operator-review-set:v1\0', 'utf8')

export type ProtectedMcpReviewEntryInput = {
  entryId: string
  entryKind: 'decision' | 'overlay'
  agent: string
  requirementKey: string
  content: string
  contentDigest: string
  digestKeyId: string
  projectionEligible: boolean
}

export type ProtectedMcpReviewHead = {
  schemaVersion: 2
  sourceArtifactId: string
  sourcePlanVersion: string
  revision: number
  reviewSetDigest: string
  itemCount: number
  approvedCount: number
  deniedCount: number
  blockerCodes: string[]
}

function hmac(key: Buffer, domain: Buffer, value: unknown): string {
  return `hmac-sha256:${createHmac('sha256', key)
    .update(domain)
    .update(canonicalArchitectPlanJson(value), 'utf8')
    .digest('hex')}`
}

function decisionAgent(item: McpPlanReviewItemInput): string {
  return item.assignment.targetAgents[0] ?? 'architect'
}

function blockerCodes(review: McpOperatorReviewRecord): string[] {
  return review.blockers.length > 0 ? ['mcp_review.required_requirement_denied'] : []
}

export function materializeProtectedMcpReview(input: {
  approvalGateId: string
  digestKey: Buffer
  digestKeyId: string
  review: McpOperatorReviewRecord
  sourcePlanVersion: string
  taskId: string
}): { entries: ProtectedMcpReviewEntryInput[]; head: ProtectedMcpReviewHead; previousReviewSetDigest: string | null } {
  const entries = input.review.items.map((item) => {
    const agent = decisionAgent(item)
    const content = canonicalArchitectPlanJson({
      schemaVersion: 2,
      requirementKey: item.requirementKey,
      decision: item.decision,
      assignment: item.assignment,
      agentPermissions: item.agentPermissions,
      promptOverlays: item.promptOverlays,
    })
    const identity = {
      taskId: input.taskId,
      approvalGateId: input.approvalGateId,
      sourceArtifactId: input.review.sourceArtifactId,
      sourcePlanVersion: input.sourcePlanVersion,
      revision: String(input.review.revision),
      entryId: `decision:${item.requirementKey}`,
      entryKind: 'decision',
      agent,
      requirementKey: item.requirementKey,
      content,
    }
    return {
      entryId: identity.entryId,
      entryKind: 'decision' as const,
      agent,
      requirementKey: item.requirementKey,
      content,
      contentDigest: hmac(input.digestKey, REVIEW_ENTRY_DOMAIN_V1, identity),
      digestKeyId: input.digestKeyId,
      projectionEligible: true,
    }
  }).sort((left, right) => left.entryId.localeCompare(right.entryId, 'en'))
  const approvedCount = input.review.items.filter((item) => item.decision === 'approved').length
  const deniedCount = input.review.items.length - approvedCount
  const codes = blockerCodes(input.review)
  const reviewSetDigest = hmac(input.digestKey, REVIEW_SET_DOMAIN_V1, {
    taskId: input.taskId,
    approvalGateId: input.approvalGateId,
    sourceArtifactId: input.review.sourceArtifactId,
    sourcePlanVersion: input.sourcePlanVersion,
    revision: String(input.review.revision),
    previousReviewSetDigest: input.review.previousDigest,
    entries: entries.map(({ entryId, contentDigest }) => ({ entryId, contentDigest })),
    blockerCodes: codes,
  })
  return {
    entries,
    previousReviewSetDigest: input.review.previousDigest,
    head: {
      schemaVersion: 2,
      sourceArtifactId: input.review.sourceArtifactId,
      sourcePlanVersion: input.sourcePlanVersion,
      revision: input.review.revision,
      reviewSetDigest,
      itemCount: input.review.items.length,
      approvedCount,
      deniedCount,
      blockerCodes: codes,
    },
  }
}

export function parseProtectedMcpReviewHead(
  value: unknown,
  expectedSourceArtifactId?: string | null,
): ProtectedMcpReviewHead | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const head = value as Record<string, unknown>
  if (head.schemaVersion !== 2 || typeof head.sourceArtifactId !== 'string'
    || (expectedSourceArtifactId && head.sourceArtifactId !== expectedSourceArtifactId)
    || typeof head.sourcePlanVersion !== 'string' || !/^[1-9][0-9]{0,18}$/.test(head.sourcePlanVersion)
    || !Number.isSafeInteger(head.revision) || Number(head.revision) < 1
    || typeof head.reviewSetDigest !== 'string' || !/^hmac-sha256:[0-9a-f]{64}$/.test(head.reviewSetDigest)
    || !Number.isSafeInteger(head.itemCount)
    || !Number.isSafeInteger(head.approvedCount) || !Number.isSafeInteger(head.deniedCount)
    || Number(head.approvedCount) + Number(head.deniedCount) !== Number(head.itemCount)
    || !Array.isArray(head.blockerCodes)
    || !head.blockerCodes.every((code) => typeof code === 'string' && /^[a-z0-9._:-]{1,100}$/.test(code))) return null
  return head as unknown as ProtectedMcpReviewHead
}

export function protectedReviewDecisions(entries: readonly ProtectedMcpReviewEntryInput[]): Map<string, 'approved' | 'denied'> | null {
  const decisions = new Map<string, 'approved' | 'denied'>()
  try {
    for (const entry of entries) {
      if (entry.entryKind !== 'decision') continue
      const value = JSON.parse(entry.content) as Record<string, unknown>
      if (value.schemaVersion !== 2 || value.requirementKey !== entry.requirementKey
        || (value.decision !== 'approved' && value.decision !== 'denied')
        || decisions.has(entry.requirementKey)) return null
      decisions.set(entry.requirementKey, value.decision)
    }
    return decisions
  } catch {
    return null
  }
}
