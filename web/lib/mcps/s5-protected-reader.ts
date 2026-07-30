import 'server-only'

import postgres from 'postgres'
import { fixedDatabaseRoleUrl } from '@/lib/mcps/fixed-database-url'

// ---------------------------------------------------------------------------
// S5 reads protected local evidence and its terminal runtime audit together for
// terminal/recovery validation, but the ordinary Forge application login is
// intentionally not the authority for those rows (see the S4 boundary proof
// in .github/workflows/web-ci.yml). Selecting the protected evidence through
// `@/db` therefore fails with 42501 in any correctly provisioned deployment.
//
// This module is the only S5 boundary that touches either table. It uses one
// dedicated fixed-principal statement and an explicit safe column list: never
// `claim_token`, grant nonces, authorization snapshots, or any other live
// authority field. When the principal is unavailable, the caller receives
// `null` and every evidence-dependent fact degrades to the truthful
// non-actionable `unavailable`/`invalid` presentation rather than falling back
// to an unauthorized connection.
// ---------------------------------------------------------------------------

export const S5_LOCAL_EVIDENCE_READER_URL_ENV = 'FORGE_LOCAL_RUN_EVIDENCE_READER_DATABASE_URL'
// PostgreSQL exports `XXXXXXXX-XXXXXXXX-X` snapshot IDs. Keep every segment
// hexadecimal and bounded before embedding it as a transaction snapshot literal.
const POSTGRES_SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{1,8}$/i

export type S5ProtectedLocalRunEvidenceRow = Readonly<{
  id: string
  workPackageId: string
  agentRunId: string
  state: string
  leaseExpiresAt: Date
  terminalAt: Date | null
}>

export type S5ProtectedRuntimeAuditRow = Readonly<{
  id: string
  workPackageId: string | null
  agentRunId: string | null
  localRunEvidenceId: string | null
  assembly: Record<string, unknown> | null
  delivery: Record<string, unknown> | null
  terminal: Record<string, unknown> | null
  terminalAt: Date | null
  updatedAt: Date
}>

export type S5ProtectedTerminalSnapshot = Readonly<{
  evidenceRows: readonly S5ProtectedLocalRunEvidenceRow[]
  auditRows: readonly S5ProtectedRuntimeAuditRow[]
}>

function readerUrl(): string | null {
  try {
    return fixedDatabaseRoleUrl({
      environmentName: S5_LOCAL_EVIDENCE_READER_URL_ENV,
      expectedUsername: 'forge_local_evidence_reader',
      value: process.env[S5_LOCAL_EVIDENCE_READER_URL_ENV],
    })
  } catch {
    return null
  }
}

function sameDatabase(left: string, right: string): boolean {
  try {
    const [a, b] = [new URL(left), new URL(right)]
    return ['postgres:', 'postgresql:'].includes(a.protocol)
      && ['postgres:', 'postgresql:'].includes(b.protocol)
      && a.hostname === b.hostname
      && (a.port || '5432') === (b.port || '5432')
      && a.pathname === b.pathname
  } catch {
    return false
  }
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
export async function readS5ProtectedTerminalSnapshot(
  taskId: string,
  observation?: Readonly<{ snapshotId: string, databaseUrl: string }>,
): Promise<S5ProtectedTerminalSnapshot | null> {
  const url = readerUrl()
  if (!url) return null
  if (observation && (!POSTGRES_SNAPSHOT_ID.test(observation.snapshotId) || !sameDatabase(url, observation.databaseUrl))) {
    return null
  }
  const sql = postgres(url, {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    const snapshot = await sql.begin('isolation level repeatable read read only', async (tx) => {
      if (observation) {
        // postgres.js cannot parameterize a transaction snapshot literal. The
        // exporter generated it locally and this strict validator permits only
        // PostgreSQL's hexadecimal snapshot grammar before interpolation.
        await tx.unsafe(`set transaction snapshot '${observation.snapshotId}'`)
      }
      const [result] = await tx<{
      evidenceRows: Array<{
        id: string
        workPackageId: string
        agentRunId: string
        state: string
        leaseExpiresAt: string
        terminalAt: string | null
      }>
      auditRows: Array<{
        id: string
        workPackageId: string | null
        agentRunId: string | null
        localRunEvidenceId: string | null
        assembly: Record<string, unknown> | null
        delivery: Record<string, unknown> | null
        terminal: Record<string, unknown> | null
        terminalAt: string | null
        updatedAt: string
      }>
      }[]>`
      select
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', evidence.id,
            'workPackageId', evidence.work_package_id,
            'agentRunId', evidence.agent_run_id,
            'state', evidence.state,
            'leaseExpiresAt', evidence.lease_expires_at,
            'terminalAt', evidence.terminal_at
          ) order by evidence.created_at, evidence.id)
          from public.work_package_local_run_evidence evidence
          where evidence.task_id = ${taskId}::uuid
        ), '[]'::jsonb) as "evidenceRows",
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', audit.id,
            'workPackageId', audit.work_package_id,
            'agentRunId', audit.agent_run_id,
            'localRunEvidenceId', audit.local_run_evidence_id,
            'assembly', audit.assembly,
            'delivery', audit.delivery,
            'terminal', audit.terminal,
            'terminalAt', audit.terminal_at,
            'updatedAt', audit.created_at
          ) order by audit.created_at, audit.id)
          from public.filesystem_mcp_runtime_audits audit
          where audit.task_id = ${taskId}::uuid
        ), '[]'::jsonb) as "auditRows"
      `
      return result
    })
    if (!snapshot || !Array.isArray(snapshot.evidenceRows) || !Array.isArray(snapshot.auditRows)) return null
    return {
      evidenceRows: snapshot.evidenceRows.map((row) => ({
        id: row.id,
        workPackageId: row.workPackageId,
        agentRunId: row.agentRunId,
        state: row.state,
        leaseExpiresAt: new Date(row.leaseExpiresAt),
        terminalAt: row.terminalAt === null ? null : new Date(row.terminalAt),
      })),
      auditRows: snapshot.auditRows.map((row) => ({
        id: row.id,
        workPackageId: row.workPackageId,
        agentRunId: row.agentRunId,
        localRunEvidenceId: row.localRunEvidenceId,
        assembly: row.assembly,
        delivery: row.delivery,
        terminal: row.terminal,
        terminalAt: row.terminalAt === null ? null : new Date(row.terminalAt),
        updatedAt: new Date(row.updatedAt),
      })),
    }
  } catch {
    console.error('[s5-protected-reader] Protected local-evidence read unavailable')
    return null
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}

export async function readS5ProtectedLocalRunEvidence(
  taskId: string,
): Promise<readonly S5ProtectedLocalRunEvidenceRow[] | null> {
  return (await readS5ProtectedTerminalSnapshot(taskId))?.evidenceRows ?? null
}
