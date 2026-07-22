import postgres from 'postgres'
import type { ProtectedMcpReviewEntryInput, ProtectedMcpReviewHead } from './protected-mcp-review'

export class HistoryReaderError extends Error {
  readonly code: 'configuration' | 'conflict' | 'invalid_evidence'

  constructor(code: HistoryReaderError['code'], message: string) {
    super(message)
    this.name = 'HistoryReaderError'
    this.code = code
  }
}

function historyReaderUrl(): string {
  const value = process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL?.trim()
  if (!value) {
    throw new HistoryReaderError(
      'configuration',
      'FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL is required.',
    )
  }
  return value
}

export type ArchitectPlanHistoryEntry = {
  entryId: string
  entryKind: 'plan_body' | 'requirement' | 'routing' | 'overlay' | 'subtask' | 'clarification_question' | 'clarification_answer' | 'legacy_full_plan'
  agent: string | null
  requirementKey: string | null
  bindingFingerprint: string | null
  content: string
  contentDigest: string
  digestKeyId: string
  projectionEligible: boolean
}

export async function readArchitectPlanHistory(input: {
  planVersion: string
  sessionCredential: string
  taskId: string
}): Promise<readonly ArchitectPlanHistoryEntry[]> {
  const credentialBytes = Buffer.from(input.sessionCredential, 'ascii')
  const sql = postgres(historyReaderUrl(), {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    return await sql<ArchitectPlanHistoryEntry[]>`
      select entry_id as "entryId", entry_kind as "entryKind", agent,
        requirement_key as "requirementKey",
        binding_fingerprint as "bindingFingerprint", content,
        content_digest as "contentDigest", digest_key_id as "digestKeyId",
        projection_eligible as "projectionEligible"
      from forge.read_architect_plan_history_v1(
        ${credentialBytes}::bytea,
        ${input.taskId}::uuid,
        ${input.planVersion}::bigint
      )
    `
  } catch {
    throw new HistoryReaderError(
      'invalid_evidence',
      'The protected history read failed closed.',
    )
  } finally {
    credentialBytes.fill(0)
    await sql.end({ timeout: 5 })
  }
}

export async function appendProtectedMcpOperatorReview(input: {
  sessionCredential: string
  approvalGateId: string
  sourcePlanVersion: string
  previousReviewSetDigest: string | null
  head: ProtectedMcpReviewHead
  entries: readonly ProtectedMcpReviewEntryInput[]
}): Promise<string> {
  const credentialBytes = Buffer.from(input.sessionCredential, 'ascii')
  const sql = postgres(historyReaderUrl(), {
    max: 1, prepare: true, onnotice: () => {}, transform: { undefined: null },
  })
  try {
    const [row] = await sql<{ reviewVersionId: string }[]>`
      select forge.append_mcp_operator_review_version_v1(
        ${credentialBytes}::bytea, ${input.approvalGateId}::uuid,
        ${input.sourcePlanVersion}::bigint, ${input.head.revision}::integer,
        ${input.previousReviewSetDigest}::text, ${input.head.reviewSetDigest}::text,
        ${input.head.itemCount}::integer, ${input.head.approvedCount}::integer,
        ${input.head.deniedCount}::integer, ${sql.array(input.head.blockerCodes, 1009)}::text[],
        ${sql.array(input.entries.map((entry) => entry.entryId), 1009)}::text[],
        ${sql.array(input.entries.map((entry) => entry.entryKind), 1009)}::text[],
        ${sql.array(input.entries.map((entry) => entry.agent), 1009)}::text[],
        ${sql.array(input.entries.map((entry) => entry.requirementKey), 1009)}::text[],
        ${sql.array(input.entries.map((entry) => entry.content), 1009)}::text[],
        ${sql.array(input.entries.map((entry) => entry.contentDigest), 1009)}::text[],
        ${sql.array(input.entries.map((entry) => entry.digestKeyId), 1009)}::text[],
        ${sql.array(input.entries.map((entry) => entry.projectionEligible), 1000)}::boolean[]
      ) as "reviewVersionId"
    `
    if (!row?.reviewVersionId) throw new Error('missing review version')
    return row.reviewVersionId
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    throw new HistoryReaderError(
      code === '40001' || code === '23505' ? 'conflict' : 'invalid_evidence',
      'The protected MCP review append failed closed.',
    )
  } finally {
    credentialBytes.fill(0)
    await sql.end({ timeout: 5 })
  }
}

export type ProtectedMcpReviewHistoryEntry = ProtectedMcpReviewEntryInput & {
  reviewVersionId: string
  reviewSetDigest: string
}

export async function readProtectedMcpOperatorReview(input: {
  sessionCredential: string
  taskId: string
  approvalGateId: string
  revision: number
}): Promise<readonly ProtectedMcpReviewHistoryEntry[]> {
  const credentialBytes = Buffer.from(input.sessionCredential, 'ascii')
  const sql = postgres(historyReaderUrl(), {
    max: 1, prepare: true, onnotice: () => {}, transform: { undefined: null },
  })
  try {
    return await sql<ProtectedMcpReviewHistoryEntry[]>`
      select review_version_id as "reviewVersionId", review_set_digest as "reviewSetDigest",
        entry_id as "entryId", entry_kind as "entryKind", agent,
        requirement_key as "requirementKey", content,
        content_digest as "contentDigest", digest_key_id as "digestKeyId",
        projection_eligible as "projectionEligible"
      from forge.read_mcp_operator_review_history_v1(
        ${credentialBytes}::bytea, ${input.taskId}::uuid,
        ${input.approvalGateId}::uuid, ${input.revision}::integer
      )
    `
  } catch {
    throw new HistoryReaderError('invalid_evidence', 'The protected MCP review read failed closed.')
  } finally {
    credentialBytes.fill(0)
    await sql.end({ timeout: 5 })
  }
}

export type ApprovedPackagePlanRegistration = {
  workPackageId: string
  registrationId: string
}

export async function listApprovedPackagePlanRegistrations(input: {
  sessionCredential: string
  approvalGateId: string
  sourcePlanVersion: string
  reviewRevision: number
  reviewSetDigest: string
}): Promise<readonly ApprovedPackagePlanRegistration[]> {
  const credentialBytes = Buffer.from(input.sessionCredential, 'ascii')
  const sql = postgres(historyReaderUrl(), {
    max: 1, prepare: true, onnotice: () => {}, transform: { undefined: null },
  })
  try {
    return await sql<ApprovedPackagePlanRegistration[]>`
      select work_package_id as "workPackageId", registration_id as "registrationId"
      from forge.list_approved_package_plan_registrations_v1(
        ${credentialBytes}::bytea, ${input.approvalGateId}::uuid,
        ${input.sourcePlanVersion}::bigint, ${input.reviewRevision}::integer,
        ${input.reviewSetDigest}::text
      )
    `
  } catch {
    throw new HistoryReaderError('invalid_evidence', 'The approved protected package registrations were unavailable.')
  } finally {
    credentialBytes.fill(0)
    await sql.end({ timeout: 5 })
  }
}
