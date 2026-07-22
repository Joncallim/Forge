import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import type {
  PacketRedactionSummary,
  PacketTerminalOutcome,
} from './packet-issuance-v2'

export type S4LeaseLeaseKind = 'execution' | 'local_evidence' | 'issuance'

export const S4_LEASE_DEFAULTS: Record<S4LeaseLeaseKind, {
  ttlSeconds: number
  maxExtensions: number
}> = {
  execution: { ttlSeconds: 30, maxExtensions: 3 },
  local_evidence: { ttlSeconds: 30, maxExtensions: 5 },
  issuance: { ttlSeconds: 20, maxExtensions: 2 },
}

export class S4LifecycleError extends Error {
  readonly code: 'configuration' | 'conflict' | 'invalid_evidence'

  constructor(code: S4LifecycleError['code'], message: string) {
    super(message)
    this.name = 'S4LifecycleError'
    this.code = code
  }
}

export type S4LifecycleOwnership = {
  runtimeAuditId: string
  localClaimToken: string
  localClaimGeneration: string
  packetClaimToken: string
  packetClaimGeneration: string
}

export type S4LocalLifecycleOwnership = {
  localRunEvidenceId: string
  localClaimToken: string
  localClaimGeneration: string
}

export type S4CompletionArtifact = {
  artifactType: string
  content: string
  metadata: Record<string, unknown> | null
}

export type S4LinkedRecoveryResult =
  | 'not_linked_v2'
  | 'not_stale'
  | 'recovered_stale_failure'
  | 'terminal_success_pending_handoff'
  | 'repaired_terminal_success'
  | 'repaired_terminal_failure'

export function claimS4LeaseToken(input: {
  kind: S4LeaseLeaseKind
  workPackageId: string
}): { claimToken: string; digest: Buffer } {
  const claimToken = randomUUID()
  const digest = createHash('sha256')
    .update(`forge:s4-lease:${input.kind}:v1\0`)
    .update(`${input.workPackageId}\0${claimToken}`)
    .digest()
  return { claimToken, digest }
}

export function s4LeaseTtl(input: { kind: S4LeaseLeaseKind }): number {
  return S4_LEASE_DEFAULTS[input.kind].ttlSeconds
}

export function s4MaxLeaseExtensions(input: { kind: S4LeaseLeaseKind }): number {
  return S4_LEASE_DEFAULTS[input.kind].maxExtensions
}

type WorkPackageClaimBase = {
  taskId: string
  workPackageId: string
  expectedPackageUpdatedAt: Date
  agentRunId: string
  agentType: string
  harnessId: string | null
  attemptNumber: number
  providerConfigId: string | null
  modelIdUsed: string
  stage: string | null
  executionStaleSeconds: number
}

export type WorkPackageLifecycleClaimInput = WorkPackageClaimBase & (
  | { mode: 'root_free_handoff' }
  | { mode: 'local_only'; localLeaseSeconds?: number }
  | {
      mode: 'packet'
      decisionId: string
      localLeaseSeconds?: number
      packetLeaseSeconds?: number
      requiredCapabilities: readonly string[]
    }
)

export type WorkPackageLifecycleClaim = {
  mode: WorkPackageLifecycleClaimInput['mode']
  agentRunId: string
  localRunEvidenceId: string | null
  runtimeAuditId: string | null
  localClaimToken: string | null
  packetClaimToken: string | null
  localClaimGeneration: string | null
  packetClaimGeneration: string | null
  localLeaseExpiresAt: Date | null
  packetLeaseExpiresAt: Date | null
}

function issuerUrl(): string {
  const value = process.env.FORGE_PACKET_ISSUER_DATABASE_URL?.trim()
  if (!value) {
    throw new S4LifecycleError(
      'configuration',
      'FORGE_PACKET_ISSUER_DATABASE_URL is required for the S4 lifecycle boundary.',
    )
  }
  return value
}

async function withIssuer<T>(operation: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(issuerUrl(), {
    max: 1,
    prepare: true,
    onnotice: () => {},
    transform: { undefined: null },
  })
  try {
    return await operation(sql)
  } catch (error) {
    if (error instanceof S4LifecycleError) throw error
    const databaseCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    throw new S4LifecycleError(
      databaseCode === '40001' || databaseCode === '23505' ? 'conflict' : 'invalid_evidence',
      'The protected S4 lifecycle operation failed closed.',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function readS4RuntimeModeV1(): Promise<'legacy' | 'protected'> {
  return withIssuer(async (sql) => {
    const [row] = await sql<{ mode: 'legacy' | 'protected' }[]>`
      select forge.s4_runtime_mode_v1() as mode
    `
    if (!row) throw new S4LifecycleError('invalid_evidence', 'The S4 runtime mode was unavailable.')
    return row.mode
  })
}

/**
 * The only issuer-executable claim boundary. The database creates the run,
 * execution lease, optional local evidence, optional packet audit, and nonce
 * claim in one transaction after repeating the package freshness check.
 */
export async function claimWorkPackageLifecycleV2(
  input: WorkPackageLifecycleClaimInput,
): Promise<WorkPackageLifecycleClaim> {
  const localClaimToken = input.mode === 'root_free_handoff' ? null : randomUUID()
  const packetClaimToken = input.mode === 'packet' ? randomUUID() : null
  const decisionId = input.mode === 'packet' ? input.decisionId : null
  const requiredCapabilities = input.mode === 'packet' ? [...input.requiredCapabilities] : []
  const localLeaseSeconds = input.mode === 'root_free_handoff'
    ? null
    : input.localLeaseSeconds ?? S4_LEASE_DEFAULTS.local_evidence.ttlSeconds
  const packetLeaseSeconds = input.mode === 'packet'
    ? input.packetLeaseSeconds ?? S4_LEASE_DEFAULTS.issuance.ttlSeconds
    : null
  return withIssuer(async (sql) => {
    const [row] = await sql<{
      agentRunId: string
      localRunEvidenceId: string | null
      runtimeAuditId: string | null
      localClaimGeneration: string | null
      packetClaimGeneration: string | null
      localLeaseExpiresAt: Date | null
      packetLeaseExpiresAt: Date | null
    }[]>`
      select
        agent_run_id as "agentRunId",
        local_run_evidence_id as "localRunEvidenceId",
        runtime_audit_id as "runtimeAuditId",
        local_claim_generation::text as "localClaimGeneration",
        packet_claim_generation::text as "packetClaimGeneration",
        local_lease_expires_at as "localLeaseExpiresAt",
        packet_lease_expires_at as "packetLeaseExpiresAt"
      from forge.claim_work_package_lifecycle_v2(
        ${input.mode}::text, ${input.taskId}::uuid, ${input.workPackageId}::uuid,
        ${input.expectedPackageUpdatedAt}::timestamptz, ${input.agentRunId}::uuid,
        ${input.agentType}::text, ${input.harnessId}::uuid, ${input.attemptNumber}::integer,
        ${input.providerConfigId}::uuid, ${input.modelIdUsed}::text, ${input.stage}::text,
        ${input.executionStaleSeconds}::integer, ${decisionId}::uuid,
        ${localClaimToken}::uuid, ${packetClaimToken}::uuid,
        ${localLeaseSeconds}::integer, ${packetLeaseSeconds}::integer,
        ${sql.array(requiredCapabilities, 1009)}::text[]
      )
    `
    if (!row) throw new S4LifecycleError('conflict', 'The work-package lifecycle claim had no winner.')
    return { ...row, mode: input.mode, localClaimToken, packetClaimToken }
  })
}

export async function heartbeatPacketLifecycleV2(input: S4LifecycleOwnership & {
  localLeaseSeconds?: number
  packetLeaseSeconds?: number
}): Promise<{ localLeaseExpiresAt: Date; packetLeaseExpiresAt: Date }> {
  return withIssuer(async (sql) => {
    const [row] = await sql<{
      localLeaseExpiresAt: Date
      packetLeaseExpiresAt: Date
    }[]>`
      select
        local_lease_expires_at as "localLeaseExpiresAt",
        packet_lease_expires_at as "packetLeaseExpiresAt"
      from forge.heartbeat_packet_lifecycle_v2(
        ${input.runtimeAuditId}::uuid,
        ${input.localClaimToken}::uuid,
        ${input.localClaimGeneration}::bigint,
        ${input.packetClaimToken}::uuid,
        ${input.packetClaimGeneration}::bigint,
        ${input.localLeaseSeconds ?? S4_LEASE_DEFAULTS.local_evidence.ttlSeconds}::integer,
        ${input.packetLeaseSeconds ?? S4_LEASE_DEFAULTS.issuance.ttlSeconds}::integer
      )
    `
    if (!row) throw new S4LifecycleError('conflict', 'The packet heartbeat lost ownership.')
    return row
  })
}

export async function heartbeatLocalLifecycleV2(input: S4LocalLifecycleOwnership & {
  localLeaseSeconds?: number
}): Promise<{ localLeaseExpiresAt: Date }> {
  return withIssuer(async (sql) => {
    const [row] = await sql<{ localLeaseExpiresAt: Date }[]>`
      select forge.heartbeat_local_lifecycle_v2(
        ${input.localRunEvidenceId}::uuid,
        ${input.localClaimToken}::uuid,
        ${input.localClaimGeneration}::bigint,
        ${input.localLeaseSeconds ?? S4_LEASE_DEFAULTS.local_evidence.ttlSeconds}::integer
      ) as "localLeaseExpiresAt"
    `
    if (!row) throw new S4LifecycleError('conflict', 'The local heartbeat lost ownership.')
    return row
  })
}

async function ownershipBoolean(
  input: S4LifecycleOwnership,
  statement: (sql: ReturnType<typeof postgres>) => Promise<{ ok: boolean }[]>,
): Promise<boolean> {
  return withIssuer(async (sql) => {
    const [row] = await statement(sql)
    if (!row?.ok) throw new S4LifecycleError('conflict', 'The packet lifecycle transition lost ownership.')
    return true
  })
}

export async function beginPacketAssemblyV2(
  input: S4LifecycleOwnership & { assemblyAttemptId: string },
): Promise<boolean> {
  return ownershipBoolean(input, (sql) => sql<{ ok: boolean }[]>`
    select forge.begin_packet_assembly_v2(
      ${input.runtimeAuditId}::uuid, ${input.localClaimToken}::uuid,
      ${input.localClaimGeneration}::bigint, ${input.packetClaimToken}::uuid,
      ${input.packetClaimGeneration}::bigint, ${input.assemblyAttemptId}::uuid
    ) as ok
  `)
}

export async function completePacketAssemblyV2(input: S4LifecycleOwnership & {
  assemblyAttemptId: string
  rootRef: string
  includedCount: number
  byteCount: number
  omittedCount: number
  redactionSummary: PacketRedactionSummary
}): Promise<boolean> {
  return ownershipBoolean(input, (sql) => sql<{ ok: boolean }[]>`
    select forge.complete_packet_assembly_v2(
      ${input.runtimeAuditId}::uuid, ${input.localClaimToken}::uuid,
      ${input.localClaimGeneration}::bigint, ${input.packetClaimToken}::uuid,
      ${input.packetClaimGeneration}::bigint, ${input.assemblyAttemptId}::uuid,
      ${input.rootRef}::text, ${input.includedCount}::integer, ${input.byteCount}::integer,
      ${input.omittedCount}::integer, ${JSON.stringify(input.redactionSummary)}::jsonb
    ) as ok
  `)
}

export async function beginPacketDeliveryV2(
  input: S4LifecycleOwnership & { submissionAttemptId: string },
): Promise<boolean> {
  return ownershipBoolean(input, (sql) => sql<{ ok: boolean }[]>`
    select forge.begin_packet_delivery_v2(
      ${input.runtimeAuditId}::uuid, ${input.localClaimToken}::uuid,
      ${input.localClaimGeneration}::bigint, ${input.packetClaimToken}::uuid,
      ${input.packetClaimGeneration}::bigint, ${input.submissionAttemptId}::uuid
    ) as ok
  `)
}

export async function completePacketDeliveryV2(input: S4LifecycleOwnership & {
  submissionAttemptId: string
  outcome: 'submission_failed' | 'submitted' | 'submission_uncertain'
}): Promise<boolean> {
  return ownershipBoolean(input, (sql) => sql<{ ok: boolean }[]>`
    select forge.complete_packet_delivery_v2(
      ${input.runtimeAuditId}::uuid, ${input.localClaimToken}::uuid,
      ${input.localClaimGeneration}::bigint, ${input.packetClaimToken}::uuid,
      ${input.packetClaimGeneration}::bigint, ${input.submissionAttemptId}::uuid,
      ${input.outcome}::text
    ) as ok
  `)
}

export async function finalizePacketSuccessV2(input: S4LifecycleOwnership & {
  completionArtifact: S4CompletionArtifact
}): Promise<{ sourceArtifactId: string }> {
  return withIssuer(async (sql) => {
    const [row] = await sql<{ sourceArtifactId: string }[]>`
      select forge.finalize_packet_success_v2(
        ${input.runtimeAuditId}::uuid, ${input.localClaimToken}::uuid,
        ${input.localClaimGeneration}::bigint, ${input.packetClaimToken}::uuid,
        ${input.packetClaimGeneration}::bigint,
        ${input.completionArtifact.artifactType}::text,
        ${input.completionArtifact.content}::text,
        ${input.completionArtifact.metadata === null
          ? null
          : JSON.stringify(input.completionArtifact.metadata)}::jsonb
      ) as "sourceArtifactId"
    `
    if (!row) throw new S4LifecycleError('conflict', 'The packet success finalizer lost ownership.')
    return row
  })
}

export async function finalizeLocalSuccessV2(input: S4LocalLifecycleOwnership & {
  completionArtifact: S4CompletionArtifact
}): Promise<{ sourceArtifactId: string }> {
  return withIssuer(async (sql) => {
    const [row] = await sql<{ sourceArtifactId: string }[]>`
      select forge.finalize_local_success_v2(
        ${input.localRunEvidenceId}::uuid, ${input.localClaimToken}::uuid,
        ${input.localClaimGeneration}::bigint,
        ${input.completionArtifact.artifactType}::text,
        ${input.completionArtifact.content}::text,
        ${input.completionArtifact.metadata === null
          ? null
          : JSON.stringify(input.completionArtifact.metadata)}::jsonb
      ) as "sourceArtifactId"
    `
    if (!row) throw new S4LifecycleError('conflict', 'The local finalizer lost ownership.')
    return row
  })
}

export async function finalizeLocalFailureV2(input: S4LocalLifecycleOwnership & {
  failureCode:
    | 'local_execution_failed'
    | 'local_invocation_uncertain'
    | 'external_repository_change_requires_review'
    | 'worker_stopped'
}): Promise<boolean> {
  return withIssuer(async (sql) => {
    const [row] = await sql<{ ok: boolean }[]>`
      select forge.finalize_local_failure_v2(
        ${input.localRunEvidenceId}::uuid, ${input.localClaimToken}::uuid,
        ${input.localClaimGeneration}::bigint, ${input.failureCode}::text
      ) as ok
    `
    if (!row?.ok) throw new S4LifecycleError('conflict', 'The local finalizer lost ownership.')
    return true
  })
}

export async function finalizePacketFailureV2(input: S4LifecycleOwnership & {
  failure: Extract<PacketTerminalOutcome, { status: 'failed' }>
}): Promise<boolean> {
  return ownershipBoolean(input, (sql) => sql<{ ok: boolean }[]>`
    select forge.finalize_packet_failure_v2(
      ${input.runtimeAuditId}::uuid, ${input.localClaimToken}::uuid,
      ${input.localClaimGeneration}::bigint, ${input.packetClaimToken}::uuid,
      ${input.packetClaimGeneration}::bigint, ${input.failure.failureCode}::text,
      ${'failureStage' in input.failure ? input.failure.failureStage : null}::text
    ) as ok
  `)
}

export async function recoverLinkedS4LifecycleV2(input: {
  agentRunId: string
}): Promise<{ result: S4LinkedRecoveryResult; completionArtifactId: string | null }> {
  return withIssuer(async (sql) => {
    const [row] = await sql<{
      result: S4LinkedRecoveryResult
      completionArtifactId: string | null
    }[]>`
      select result, completion_artifact_id as "completionArtifactId"
      from forge.recover_linked_s4_lifecycle_v2(${input.agentRunId}::uuid)
    `
    if (!row) throw new S4LifecycleError('conflict', 'The linked S4 recovery had no result.')
    return row
  })
}

export async function casPacketReapprovalV2(input: {
  taskId: string
  workPackageId: string
  priorRuntimeAuditId: string
  expectedMarkerFingerprint: string
  newDecisionId: string
}): Promise<boolean> {
  return withIssuer(async (sql) => {
    const [row] = await sql<{ ok: boolean }[]>`
      select forge.cas_packet_reapproval_v2(
        ${input.taskId}::uuid, ${input.workPackageId}::uuid,
        ${input.priorRuntimeAuditId}::uuid, ${input.expectedMarkerFingerprint}::text,
        ${input.newDecisionId}::uuid
      ) as ok
    `
    if (!row?.ok) throw new S4LifecycleError('conflict', 'Packet reapproval lost its marker compare-and-set.')
    return true
  })
}
