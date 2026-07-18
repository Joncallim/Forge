import postgres from 'postgres'

export class HistoryReaderError extends Error {
  readonly code: 'configuration' | 'invalid_evidence'

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
  entryKind: 'plan_body' | 'requirement' | 'overlay' | 'subtask' | 'legacy_full_plan'
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
