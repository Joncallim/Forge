import postgres from 'postgres'

export class SessionUserResolverError extends Error {
  readonly code: 'configuration' | 'conflict' | 'invalid_evidence'

  constructor(code: SessionUserResolverError['code'], message: string) {
    super(message)
    this.name = 'SessionUserResolverError'
    this.code = code
  }
}

function resolverUrl(): string {
  const value = process.env.FORGE_PACKET_ISSUER_DATABASE_URL?.trim()
  if (!value) {
    throw new SessionUserResolverError(
      'configuration',
      'FORGE_PACKET_ISSUER_DATABASE_URL is required for session_user package resolution.',
    )
  }
  return value
}

export type ResolvedPackage = {
  workPackageId: string
  taskId: string
  assignedRole: string
  status: string
  mcpRequirements: unknown
  metadata: unknown
}

export async function resolveSessionUserPackages(input: {
  taskId: string
}): Promise<readonly ResolvedPackage[]> {
  const sql = postgres(resolverUrl(), {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    await sql`set local role forge_packet_issuer`
    return await sql<ResolvedPackage[]>`
      select id as "workPackageId",
             task_id as "taskId",
             assigned_role as "assignedRole",
             status,
             mcp_requirements as "mcpRequirements",
             metadata
      from work_packages
      where task_id = ${input.taskId}::uuid
      order by sequence asc
    `
  } catch {
    throw new SessionUserResolverError(
      'invalid_evidence',
      'The session_user package resolution failed closed.',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function resolvePackageGrantState(input: {
  workPackageId: string
}): Promise<{
  currentDecisionId: string | null
  currentDecisionRevision: string | null
  pointerFingerprint: string
  pointerVersion: string
} | null> {
  const sql = postgres(resolverUrl(), {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    await sql`set local role forge_packet_issuer`
    const rows = await sql<{
      currentDecisionId: string | null
      currentDecisionRevision: string | null
      pointerFingerprint: string
      pointerVersion: string
    }[]>`
      select current_decision_id as "currentDecisionId",
             current_decision_revision as "currentDecisionRevision",
             pointer_fingerprint as "pointerFingerprint",
             pointer_version::text as "pointerVersion"
      from filesystem_mcp_current_decision_pointers
      where work_package_id = ${input.workPackageId}::uuid
    `
    return rows.length > 0 ? rows[0] : null
  } catch {
    throw new SessionUserResolverError(
      'invalid_evidence',
      'The package grant state resolution failed closed.',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}
