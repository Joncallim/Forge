import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import {
  architectPlanEntryReference,
  materializeArchitectPlanEntries,
  parseArchitectPlanEntryReference,
  verifyArchitectPlanEntry,
  type ArchitectPlanEntryEnvelope,
  type ArchitectPlanEntryInput,
  type ArchitectPlanEntryReference,
} from './architect-plan-entries'

export class S4ProtocolStoreError extends Error {
  readonly code: 'configuration' | 'conflict' | 'invalid_evidence'

  constructor(code: S4ProtocolStoreError['code'], message: string) {
    super(message)
    this.name = 'S4ProtocolStoreError'
    this.code = code
  }
}

const ARCHITECT_PLAN_PROTECTION_ENV = [
  'FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID',
] as const

export type ArchitectPlanStorageConfiguration =
  | { mode: 'legacy' }
  | { mode: 'protected'; digestKey: Buffer; digestKeyId: string }

/**
 * Keeps ordinary planning compatible until protected Architect history is
 * provisioned. A partially provisioned boundary is never treated as legacy:
 * doing so could put plan text back into the public artifact after an operator
 * has started the protected-history cutover.
 */
export function architectPlanStorageConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ArchitectPlanStorageConfiguration {
  const configured = ARCHITECT_PLAN_PROTECTION_ENV.filter((name) => Boolean(environment[name]?.trim()))
  if (configured.length === 0) return { mode: 'legacy' }
  if (configured.length !== ARCHITECT_PLAN_PROTECTION_ENV.length) {
    const missing = ARCHITECT_PLAN_PROTECTION_ENV.filter((name) => !environment[name]?.trim())
    throw new S4ProtocolStoreError(
      'configuration',
      `Protected Architect history is partially configured; missing ${missing.join(', ')}.`,
    )
  }

  const keyHex = environment.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX!.trim()
  const digestKeyId = environment.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID!.trim()
  if (!/^[0-9a-f]{64,}$/.test(keyHex) || keyHex.length % 2 !== 0) {
    throw new S4ProtocolStoreError(
      'configuration',
      'FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX must be an even-length lowercase hex key of at least 32 bytes.',
    )
  }
  if (!/^[a-z0-9._-]{1,64}$/.test(digestKeyId)) {
    throw new S4ProtocolStoreError(
      'configuration',
      'FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID is invalid for protected Architect history.',
    )
  }

  return { mode: 'protected', digestKey: Buffer.from(keyHex, 'hex'), digestKeyId }
}

function dedicatedUrl(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new S4ProtocolStoreError('configuration', `${name} is required for the dedicated S4 database boundary`)
  return value
}

async function withDedicatedClient<T>(urlName: string, operation: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(dedicatedUrl(urlName), {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    return await operation(sql)
  } catch (error) {
    if (error instanceof S4ProtocolStoreError) throw error
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    throw new S4ProtocolStoreError(
      code === '40001' || code === '23505' ? 'conflict' : 'invalid_evidence',
      'The protected S4 database operation failed closed.',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function recordArchitectPlanVersion(input: {
  agentRunId: string
  digestKey: Buffer
  digestKeyId: string
  entries: readonly ArchitectPlanEntryInput[]
  planVersion: string
  taskId: string
}): Promise<{ artifactId: string; entries: ArchitectPlanEntryEnvelope[]; entrySetDigest: string }> {
  const artifactId = randomUUID()
  const materialized = materializeArchitectPlanEntries({
    digestKey: input.digestKey,
    digestKeyId: input.digestKeyId,
    entries: input.entries,
    planArtifactId: artifactId,
    planVersion: input.planVersion,
    taskId: input.taskId,
  })
  await withDedicatedClient('FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL', async (sql) => {
    await sql`
      select forge.insert_architect_plan_version_v1(
        ${input.agentRunId}::uuid,
        ${artifactId}::uuid,
        ${input.planVersion}::bigint,
        ${input.digestKeyId}::text,
        ${materialized.entrySetDigest}::text,
        ${sql.array(materialized.entries.map((entry) => entry.entryId), 1009)}::text[],
        ${sql.array(materialized.entries.map((entry) => entry.entryKind), 1009)}::text[],
        ${sql.array(materialized.entries.map((entry) => entry.agent), 1009)}::text[],
        ${sql.array(materialized.entries.map((entry) => entry.requirementKey), 1009)}::text[],
        ${sql.array(materialized.entries.map((entry) => entry.bindingFingerprint), 1009)}::text[],
        ${sql.array(materialized.entries.map((entry) => entry.content), 1009)}::text[],
        ${sql.array(materialized.entries.map((entry) => entry.contentDigest), 1009)}::text[],
        ${sql.array(materialized.entries.map((entry) => entry.projectionEligible ? 'true' : 'false'), 1009)}::text[]
      )
    `
  })
  return { artifactId, ...materialized }
}

export async function resolveArchitectPlanEntry(input: {
  digestKey: Buffer
  expectedPurpose?: 'package_specialist' | 'architect_replan'
  reference: ArchitectPlanEntryReference
  referenceId: string
  taskId: string
}): Promise<{ content: string; entryId: string }> {
  const reference = parseArchitectPlanEntryReference(input.reference)
  if (!reference) throw new S4ProtocolStoreError('invalid_evidence', 'The Architect plan reference is malformed.')
  return withDedicatedClient('FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL', async (sql) => {
    const rows = await sql<{
      agent: string | null
      bindingFingerprint: string | null
      content: string
      contentDigest: string
      entryId: string
      entryKind: ArchitectPlanEntryEnvelope['entryKind']
      projectionEligible: boolean
      purpose: 'package_specialist' | 'architect_replan'
      requirementKey: string | null
    }[]>`
      select
        purpose,
        entry_id as "entryId",
        entry_kind as "entryKind",
        agent,
        requirement_key as "requirementKey",
        binding_fingerprint as "bindingFingerprint",
        content,
        content_digest as "contentDigest",
        projection_eligible as "projectionEligible"
      from forge.resolve_architect_plan_entry_v1(${input.referenceId}::uuid)
    `
    if (rows.length !== 1) throw new S4ProtocolStoreError('invalid_evidence', 'The Architect plan reference was stale or unavailable.')
    const row = rows[0]
    const expectedPurpose = input.expectedPurpose ?? 'package_specialist'
    if (row.purpose !== expectedPurpose) {
      throw new S4ProtocolStoreError('invalid_evidence', 'The Architect plan reference purpose did not match its consumer.')
    }
    const envelope: ArchitectPlanEntryEnvelope = {
      schemaVersion: 1,
      taskId: input.taskId,
      planArtifactId: reference.planArtifactId,
      planVersion: reference.planVersion,
      entryId: row.entryId,
      entryKind: row.entryKind,
      agent: row.agent,
      requirementKey: row.requirementKey,
      bindingFingerprint: row.bindingFingerprint,
      content: row.content,
      contentDigest: row.contentDigest,
      digestKeyId: reference.digestKeyId,
      projectionEligible: row.projectionEligible,
    }
    if (
      row.entryId !== reference.entryId ||
      row.contentDigest !== reference.contentDigest ||
      (expectedPurpose === 'package_specialist' && !row.projectionEligible) ||
      (expectedPurpose === 'architect_replan' && (
        row.entryKind !== 'plan_body'
        || row.entryId !== 'plan_body:000000'
        || row.agent !== null
        || row.requirementKey !== null
        || row.bindingFingerprint !== null
        || row.projectionEligible
      )) ||
      !verifyArchitectPlanEntry({ digestKey: input.digestKey, entry: envelope })
    ) {
      throw new S4ProtocolStoreError('invalid_evidence', 'The resolved Architect plan entry did not match its protected digest.')
    }
    return { entryId: row.entryId, content: row.content }
  })
}

export function executableReferenceForEntry(entry: ArchitectPlanEntryEnvelope): ArchitectPlanEntryReference {
  return architectPlanEntryReference(entry)
}

export async function bindArchitectReplanEntry(input: {
  agentRunId: string
  reference: ArchitectPlanEntryReference
  taskId: string
}): Promise<string> {
  const reference = parseArchitectPlanEntryReference(input.reference)
  if (
    !reference
    || reference.entryId !== 'plan_body:000000'
    || reference.requirementKey !== null
    || reference.bindingFingerprint !== null
  ) {
    throw new S4ProtocolStoreError('invalid_evidence', 'The Architect replan source reference is malformed.')
  }
  return withDedicatedClient('FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL', async (sql) => {
    const rows = await sql<{ referenceId: string }[]>`
      select forge.bind_architect_replan_entry_v1(
        ${input.taskId}::uuid,
        ${input.agentRunId}::uuid,
        ${reference.planArtifactId}::uuid,
        ${reference.planVersion}::bigint,
        ${reference.entryId}::text,
        ${reference.contentDigest}::text,
        ${reference.digestKeyId}::text
      ) as "referenceId"
    `
    if (rows.length !== 1) {
      throw new S4ProtocolStoreError('conflict', 'Architect replan binding failed closed.')
    }
    return rows[0].referenceId
  })
}

export async function bindArchitectPlanEntry(input: {
  agentRunId: string
  bindingFingerprint: string
  contentDigest: string
  digestKeyId: string
  entryId: string
  planArtifactId: string
  planVersion: string
  requirementKey: string
  taskId: string
  workPackageId: string
}): Promise<string> {
  return withDedicatedClient('FORGE_PACKET_ISSUER_DATABASE_URL', async (sql) => {
    const rows = await sql<{ referenceId: string }[]>`
      select forge.bind_architect_plan_entry_v1(
        ${input.taskId}::uuid,
        ${input.workPackageId}::uuid,
        ${input.agentRunId}::uuid,
        ${input.planArtifactId}::uuid,
        ${input.planVersion}::bigint,
        ${input.entryId}::text,
        ${input.contentDigest}::text,
        ${input.digestKeyId}::text,
        ${input.requirementKey}::text,
        ${input.bindingFingerprint}::text
      ) as "referenceId"
    `
    if (rows.length !== 1) {
      throw new S4ProtocolStoreError('conflict', 'Claim binding failed: the entry reference could not be created.')
    }
    return rows[0].referenceId
  })
}

export async function claimPacketAuthorization(input: {
  agentRunId: string
  decisionId: string
  leaseSeconds?: number
  requiredCapabilities: readonly string[]
}): Promise<{ auditId: string; claimToken: string; localRunEvidenceId: string }> {
  const claimToken = randomUUID()
  const leaseSeconds = input.leaseSeconds ?? 45
  return withDedicatedClient('FORGE_PACKET_ISSUER_DATABASE_URL', async (sql) => sql.begin(async (tx) => {
    const evidenceRows = await tx<{ localRunEvidenceId: string }[]>`
      select forge.create_local_run_evidence_v1(
        ${input.agentRunId}::uuid,
        ${claimToken}::uuid,
        ${leaseSeconds}::integer
      ) as "localRunEvidenceId"
    `
    if (evidenceRows.length !== 1) {
      throw new S4ProtocolStoreError('conflict', 'Local run evidence could not be claimed.')
    }
    const localRunEvidenceId = evidenceRows[0].localRunEvidenceId
    const auditRows = await tx<{ auditId: string }[]>`
      select forge.insert_packet_authorization_snapshot_v2(
        ${input.agentRunId}::uuid,
        ${localRunEvidenceId}::uuid,
        ${input.decisionId}::uuid,
        ${claimToken}::uuid,
        ${leaseSeconds}::integer,
        ${tx.array([...input.requiredCapabilities], 1009)}::text[]
      ) as "auditId"
    `
    if (auditRows.length !== 1) {
      throw new S4ProtocolStoreError('conflict', 'Packet authorization could not be claimed.')
    }
    return { auditId: auditRows[0].auditId, claimToken, localRunEvidenceId }
  }))
}

export const bindClaim = claimPacketAuthorization
