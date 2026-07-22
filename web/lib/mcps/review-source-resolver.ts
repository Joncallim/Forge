import postgres from 'postgres'
import { fixedDatabaseRoleUrl } from './fixed-database-url'

export class ReviewSourceResolverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewSourceResolverError'
  }
}

export type ProtectedReviewSource = {
  sourceArtifactId: string
  sourceAgentRunId: string
  content: string
  metadata: Record<string, unknown> | null
  contentFingerprint: string
}

function resolverUrl(): string {
  try {
    return fixedDatabaseRoleUrl({
      environmentName: 'FORGE_REVIEW_SOURCE_RESOLVER_DATABASE_URL',
      expectedUsername: 'forge_review_source_resolver',
      value: process.env.FORGE_REVIEW_SOURCE_RESOLVER_DATABASE_URL,
    })
  } catch {
    throw new ReviewSourceResolverError('The protected review-source resolver is not configured safely.')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolves one pending QA, Reviewer, or Security gate through its fixed
 * database principal. Callers must keep content transient and must never put it
 * into public API responses, task events, logs, or ordinary artifacts.
 */
export async function resolveS4ReviewSourceV1(input: {
  approvalGateId: string
}): Promise<ProtectedReviewSource> {
  const sql = postgres(resolverUrl(), {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    const rows = await sql<{
      sourceArtifactId: string
      sourceAgentRunId: string
      content: string
      metadata: unknown
      contentFingerprint: string
    }[]>`
      select source_artifact_id as "sourceArtifactId",
        source_agent_run_id as "sourceAgentRunId", content, metadata,
        content_fingerprint as "contentFingerprint"
      from forge.resolve_s4_review_source_v1(${input.approvalGateId}::uuid)
    `
    const row = rows.length === 1 ? rows[0] : null
    if (
      !row
      || typeof row.content !== 'string'
      || Buffer.byteLength(row.content, 'utf8') > 1024 * 1024
      || (row.metadata !== null && !isRecord(row.metadata))
      || !/^sha256:[0-9a-f]{64}$/.test(row.contentFingerprint)
    ) {
      throw new ReviewSourceResolverError('The protected review source was unavailable or malformed.')
    }
    return { ...row, metadata: row.metadata }
  } catch (error) {
    if (error instanceof ReviewSourceResolverError) throw error
    throw new ReviewSourceResolverError('The protected review source failed closed.')
  } finally {
    await sql.end({ timeout: 5 })
  }
}
