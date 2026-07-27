import 'server-only'

import postgres from 'postgres'

// ---------------------------------------------------------------------------
// S5 reads `work_package_local_run_evidence` for terminal/recovery validation,
// but that table is owned by `forge_s4_routines_owner` and the ordinary Forge
// application login is denied every privilege on it (see the S4 boundary proof
// in .github/workflows/web-ci.yml). Selecting it through `@/db` therefore fails
// with 42501 in any correctly provisioned deployment.
//
// This module is the only place S5 touches that table. It uses a dedicated
// fixed-principal connection, selects an explicit safe column list (never
// `claim_token`, never a lease digest), and fails closed: when the principal is
// not configured, is denied, or errors for any reason, the caller receives
// `null` and every evidence-dependent fact degrades to the truthful
// non-actionable `unavailable`/`invalid` presentation rather than throwing or
// falling back to an unauthorized connection.
// ---------------------------------------------------------------------------

export const S5_LOCAL_EVIDENCE_READER_URL_ENV = 'FORGE_LOCAL_RUN_EVIDENCE_READER_DATABASE_URL'

export type S5ProtectedLocalRunEvidenceRow = Readonly<{
  id: string
  workPackageId: string
  agentRunId: string
  state: string
  leaseExpiresAt: Date
  terminalAt: Date | null
}>

function readerUrl(): string | null {
  const value = process.env[S5_LOCAL_EVIDENCE_READER_URL_ENV]?.trim()
  return value && value.length > 0 ? value : null
}

export function s5LocalEvidenceReaderConfigured(): boolean {
  return readerUrl() !== null
}

/**
 * Returns the safe presentation columns of the task's local run evidence, or
 * `null` when the protected read is unavailable. `null` is not an error state
 * for the caller: it means "this slice of evidence cannot be proven right now",
 * and S5 must present the corresponding facts as unavailable.
 */
export async function readS5ProtectedLocalRunEvidence(
  taskId: string,
): Promise<readonly S5ProtectedLocalRunEvidenceRow[] | null> {
  const url = readerUrl()
  if (!url) return null
  const sql = postgres(url, {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    const rows = await sql<S5ProtectedLocalRunEvidenceRow[]>`
      select
        evidence.id as "id",
        evidence.work_package_id as "workPackageId",
        evidence.agent_run_id as "agentRunId",
        evidence.state as "state",
        evidence.lease_expires_at as "leaseExpiresAt",
        evidence.terminal_at as "terminalAt"
      from public.work_package_local_run_evidence evidence
      where evidence.task_id = ${taskId}::uuid
      order by evidence.created_at asc, evidence.id asc
    `
    return rows.map((row) => ({
      id: row.id,
      workPackageId: row.workPackageId,
      agentRunId: row.agentRunId,
      state: row.state,
      leaseExpiresAt: row.leaseExpiresAt,
      terminalAt: row.terminalAt,
    }))
  } catch (error) {
    console.error('[s5-protected-reader] Local run evidence read failed closed', {
      code: typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : 'unknown',
    })
    return null
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}
