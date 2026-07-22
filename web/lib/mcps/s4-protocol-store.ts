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
  authoritativeMode?: 'legacy' | 'protected',
): ArchitectPlanStorageConfiguration {
  if (authoritativeMode === 'legacy') return { mode: 'legacy' }
  const configured = ARCHITECT_PLAN_PROTECTION_ENV.filter((name) => Boolean(environment[name]?.trim()))
  if (configured.length === 0 && authoritativeMode !== 'protected') return { mode: 'legacy' }
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
}): Promise<{ artifactId: string; entries: ArchitectPlanEntryEnvelope[]; entrySetDigest: string; structuralSetDigest: string }> {
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
        ${materialized.structuralSetDigest}::text,
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
  referenceId: string
} & (
  | {
      expectedPurpose?: 'package_specialist'
      reference: ArchitectPlanEntryReference
      taskId: string
    }
  | {
      expectedPurpose: 'architect_replan'
      reference?: never
      taskId?: never
    }
)): Promise<ArchitectPlanEntryInput> {
  const suppliedReference = input.expectedPurpose === 'architect_replan'
    ? null
    : parseArchitectPlanEntryReference(input.reference)
  if (input.expectedPurpose !== 'architect_replan' && !suppliedReference) {
    throw new S4ProtocolStoreError('invalid_evidence', 'The Architect plan reference is malformed.')
  }
  return withDedicatedClient('FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL', async (sql) => {
    const rows = await sql<{
      agent: string | null
      bindingFingerprint: string | null
      content: string
      contentDigest: string
      digestKeyId: string
      entryId: string
      entryKind: ArchitectPlanEntryEnvelope['entryKind']
      planArtifactId: string
      planVersion: string
      projectionEligible: boolean
      purpose: 'package_specialist' | 'architect_replan'
      requirementKey: string | null
      taskId: string
    }[]>`
      select
        purpose,
        task_id as "taskId",
        plan_artifact_id as "planArtifactId",
        plan_version::text as "planVersion",
        entry_id as "entryId",
        entry_kind as "entryKind",
        agent,
        requirement_key as "requirementKey",
        binding_fingerprint as "bindingFingerprint",
        content,
        content_digest as "contentDigest",
        digest_key_id as "digestKeyId",
        projection_eligible as "projectionEligible"
      from forge.resolve_architect_plan_entry_v1(${input.referenceId}::uuid)
    `
    if (rows.length !== 1) throw new S4ProtocolStoreError('invalid_evidence', 'The Architect plan reference was stale or unavailable.')
    const row = rows[0]
    const expectedPurpose = input.expectedPurpose ?? 'package_specialist'
    if (row.purpose !== expectedPurpose) {
      throw new S4ProtocolStoreError('invalid_evidence', 'The Architect plan reference purpose did not match its consumer.')
    }
    const returnedReference = parseArchitectPlanEntryReference({
      schemaVersion: 1,
      planArtifactId: row.planArtifactId,
      planVersion: row.planVersion,
      entryId: row.entryId,
      digestKeyId: row.digestKeyId,
      contentDigest: row.contentDigest,
      requirementKey: row.requirementKey,
      bindingFingerprint: row.bindingFingerprint,
    })
    if (!returnedReference) {
      throw new S4ProtocolStoreError('invalid_evidence', 'The resolved Architect plan identity was malformed.')
    }
    const envelope: ArchitectPlanEntryEnvelope = {
      schemaVersion: 1,
      taskId: row.taskId,
      planArtifactId: returnedReference.planArtifactId,
      planVersion: returnedReference.planVersion,
      entryId: row.entryId,
      entryKind: row.entryKind,
      agent: row.agent,
      requirementKey: row.requirementKey,
      bindingFingerprint: row.bindingFingerprint,
      content: row.content,
      contentDigest: row.contentDigest,
      digestKeyId: returnedReference.digestKeyId,
      projectionEligible: row.projectionEligible,
    }
    if (
      (suppliedReference !== null && (
        row.taskId !== input.taskId
        || JSON.stringify(returnedReference) !== JSON.stringify(suppliedReference)
      )) ||
      (expectedPurpose === 'package_specialist' && !row.projectionEligible) ||
      (expectedPurpose === 'architect_replan' && row.entryKind === 'legacy_full_plan') ||
      !verifyArchitectPlanEntry({ digestKey: input.digestKey, entry: envelope })
    ) {
      throw new S4ProtocolStoreError('invalid_evidence', 'The resolved Architect plan entry did not match its protected digest.')
    }
    return {
      agent: row.agent,
      bindingFingerprint: row.bindingFingerprint,
      content: row.content,
      entryId: row.entryId,
      entryKind: row.entryKind,
      projectionEligible: row.projectionEligible,
      requirementKey: row.requirementKey,
    }
  })
}

export function executableReferenceForEntry(entry: ArchitectPlanEntryEnvelope): ArchitectPlanEntryReference {
  return architectPlanEntryReference(entry)
}

export async function bindArchitectReplanEntry(input: {
  agentRunId: string
  taskId: string
}): Promise<string> {
  return withDedicatedClient('FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL', async (sql) => {
    const rows = await sql<{ referenceId: string }[]>`
      select forge.bind_architect_replan_entry_v1(
        ${input.taskId}::uuid,
        ${input.agentRunId}::uuid
      ) as "referenceId"
    `
    if (rows.length !== 1) {
      throw new S4ProtocolStoreError('conflict', 'Architect replan binding failed closed.')
    }
    return rows[0].referenceId
  })
}

export type ArchitectReplanContextReference = {
  referenceId: string
  entryId: string
  entryKind: Exclude<ArchitectPlanEntryEnvelope['entryKind'], 'legacy_full_plan'>
}

export async function bindArchitectReplanContext(input: {
  agentRunId: string
  priorPlanArtifactId: string
}): Promise<ArchitectReplanContextReference[]> {
  return withDedicatedClient('FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL', async (sql) => {
    const rows = await sql<{ referenceId: string; entryId: string; entryKind: string }[]>`
      select reference_id as "referenceId", entry_id as "entryId", entry_kind as "entryKind"
      from forge.bind_architect_replan_context_v2(
        ${input.agentRunId}::uuid,
        ${input.priorPlanArtifactId}::uuid
      )
    `
    const sorted = [...rows].sort((left, right) => left.entryId.localeCompare(right.entryId, 'en'))
    const ids = new Set<string>()
    let planBodies = 0
    for (const row of sorted) {
      const valid = row.entryKind === 'plan_body'
        ? row.entryId === 'plan_body:000000'
        : row.entryKind === 'requirement'
          ? row.entryId.startsWith('requirement:')
          : row.entryKind === 'routing'
            ? row.entryId.startsWith('routing:')
            : row.entryKind === 'overlay'
              ? row.entryId.startsWith('overlay:')
              : row.entryKind === 'subtask'
                ? row.entryId.startsWith('subtask:')
                : row.entryKind === 'clarification_question'
                  ? /^clarification_question:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.entryId)
                  : row.entryKind === 'clarification_answer'
                    && /^clarification_answer:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.entryId)
      if (!valid || ids.has(row.entryId)) {
        throw new S4ProtocolStoreError('invalid_evidence', 'Architect replan context binding returned an invalid entry set.')
      }
      ids.add(row.entryId)
      if (row.entryKind === 'plan_body') planBodies += 1
    }
    if (planBodies !== 1) {
      throw new S4ProtocolStoreError('conflict', 'Architect replan context binding did not return one plan body.')
    }
    return sorted as ArchitectReplanContextReference[]
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

export type ProtectedPackageEntryRegistrationInput = {
  workPackageId: string
  entryId: string
  bindingSetDigest: string
  capabilities: readonly {
    capability: string
    requirementKey: string
    routingFingerprint: string
  }[]
}

export async function registerPackagePlanEntries(input: {
  taskId: string
  sourceArtifactId: string
  sourcePlanVersion: string
  registrations: readonly ProtectedPackageEntryRegistrationInput[]
}): Promise<string[]> {
  if (input.registrations.length === 0) return []
  const capabilities = input.registrations.flatMap((registration) => registration.capabilities)
  const offsets = [0]
  for (const registration of input.registrations) {
    offsets.push(offsets.at(-1)! + registration.capabilities.length)
  }
  return withDedicatedClient('FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL', async (sql) => {
    const [row] = await sql<{ registrationIds: string[] }[]>`
      select forge.register_package_plan_entries_v1(
        ${input.taskId}::uuid, ${input.sourceArtifactId}::uuid,
        ${input.sourcePlanVersion}::bigint,
        ${sql.array(input.registrations.map((entry) => entry.workPackageId), 2950)}::uuid[],
        ${sql.array(input.registrations.map((entry) => entry.entryId), 1009)}::text[],
        ${sql.array(input.registrations.map((entry) => entry.bindingSetDigest), 1009)}::text[],
        ${sql.array(offsets, 1007)}::integer[],
        ${sql.array(capabilities.map((binding) => binding.capability), 1009)}::text[],
        ${sql.array(capabilities.map((binding) => binding.requirementKey), 1009)}::text[],
        ${sql.array(capabilities.map((binding) => binding.routingFingerprint), 1009)}::text[]
      ) as "registrationIds"
    `
    if (!row || row.registrationIds.length !== input.registrations.length) {
      throw new S4ProtocolStoreError('conflict', 'Protected package entry registration was incomplete.')
    }
    return row.registrationIds
  })
}

export async function bindRegisteredArchitectPlanEntry(input: {
  registrationId: string
  agentRunId: string
}): Promise<string> {
  return withDedicatedClient('FORGE_PACKET_ISSUER_DATABASE_URL', async (sql) => {
    const [row] = await sql<{ referenceId: string }[]>`
      select forge.bind_architect_plan_entry_v2(
        ${input.registrationId}::uuid, ${input.agentRunId}::uuid
      ) as "referenceId"
    `
    if (!row?.referenceId) {
      throw new S4ProtocolStoreError('conflict', 'Registered Architect entry binding failed closed.')
    }
    return row.referenceId
  })
}

export async function resolveRegisteredArchitectPlanEntry(input: {
  digestKey: Buffer
  referenceId: string
  taskId: string
}): Promise<ArchitectPlanEntryInput> {
  return withDedicatedClient('FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL', async (sql) => {
    const [row] = await sql<{
      agent: string | null
      bindingFingerprint: string | null
      content: string
      contentDigest: string
      digestKeyId: string
      entryId: string
      entryKind: ArchitectPlanEntryEnvelope['entryKind']
      planArtifactId: string
      planVersion: string
      projectionEligible: boolean
      purpose: string
      requirementKey: string | null
      taskId: string
    }[]>`
      select purpose, task_id as "taskId", plan_artifact_id as "planArtifactId",
        plan_version::text as "planVersion", entry_id as "entryId",
        entry_kind as "entryKind", agent, requirement_key as "requirementKey",
        binding_fingerprint as "bindingFingerprint", content,
        content_digest as "contentDigest", digest_key_id as "digestKeyId",
        projection_eligible as "projectionEligible"
      from forge.resolve_architect_plan_entry_v1(${input.referenceId}::uuid)
    `
    if (!row || row.purpose !== 'package_specialist' || row.taskId !== input.taskId
      || !row.projectionEligible || !['overlay', 'subtask'].includes(row.entryKind)) {
      throw new S4ProtocolStoreError('invalid_evidence', 'Registered Architect plan content was unavailable or ineligible.')
    }
    const envelope: ArchitectPlanEntryEnvelope = {
      schemaVersion: 1,
      taskId: row.taskId,
      planArtifactId: row.planArtifactId,
      planVersion: row.planVersion,
      entryId: row.entryId,
      entryKind: row.entryKind,
      agent: row.agent,
      requirementKey: row.requirementKey,
      bindingFingerprint: row.bindingFingerprint,
      content: row.content,
      contentDigest: row.contentDigest,
      digestKeyId: row.digestKeyId,
      projectionEligible: row.projectionEligible,
    }
    if (!verifyArchitectPlanEntry({ digestKey: input.digestKey, entry: envelope })) {
      throw new S4ProtocolStoreError('invalid_evidence', 'Registered Architect plan content failed its protected digest.')
    }
    return {
      agent: row.agent,
      bindingFingerprint: row.bindingFingerprint,
      content: row.content,
      entryId: row.entryId,
      entryKind: row.entryKind,
      projectionEligible: row.projectionEligible,
      requirementKey: row.requirementKey,
    }
  })
}

export async function claimPacketAuthorization(input: {
  agentRunId: string
  decisionId: string
  leaseSeconds?: number
  localLeaseSeconds?: number
  packetLeaseSeconds?: number
  requiredCapabilities: readonly string[]
}): Promise<{
  auditId: string
  localClaimToken: string
  localRunEvidenceId: string
  packetClaimToken: string
}> {
  const localClaimToken = randomUUID()
  let packetClaimToken = randomUUID()
  while (packetClaimToken === localClaimToken) packetClaimToken = randomUUID()
  const localLeaseSeconds = input.localLeaseSeconds ?? input.leaseSeconds ?? 45
  const packetLeaseSeconds = input.packetLeaseSeconds ?? input.leaseSeconds ?? 45
  return withDedicatedClient('FORGE_PACKET_ISSUER_DATABASE_URL', async (sql) => {
    const rows = await sql<{ localRunEvidenceId: string; auditId: string }[]>`
      select local_run_evidence_id as "localRunEvidenceId",
        runtime_audit_id as "auditId"
      from forge.claim_packet_lifecycle_v2(
        ${input.agentRunId}::uuid,
        ${input.decisionId}::uuid,
        ${localClaimToken}::uuid,
        ${packetClaimToken}::uuid,
        ${localLeaseSeconds}::integer,
        ${packetLeaseSeconds}::integer,
        ${sql.array([...input.requiredCapabilities], 1009)}::text[]
      )
    `
    if (rows.length !== 1) {
      throw new S4ProtocolStoreError('conflict', 'Packet lifecycle could not be claimed.')
    }
    return {
      auditId: rows[0].auditId,
      localClaimToken,
      localRunEvidenceId: rows[0].localRunEvidenceId,
      packetClaimToken,
    }
  })
}
