import { createHash, randomUUID } from 'node:crypto'
import { sql as drizzleSql } from 'drizzle-orm'
import postgres from 'postgres'
import { db } from '@/db'
import type {
  PacketRedactionSummary,
  PacketTerminalOutcome,
} from './packet-issuance-v2'
import { fixedDatabaseRoleUrl } from './fixed-database-url'

export type S4LeaseLeaseKind = 'execution' | 'local_evidence' | 'issuance'

export const S4_PROTECTED_RUNTIME_ENV = [
  'FORGE_PACKET_ISSUER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL',
  'FORGE_REVIEW_SOURCE_RESOLVER_DATABASE_URL',
  'FORGE_S4_RECOVERY_OPERATOR_DATABASE_URL',
  'FORGE_TASK_EVENT_PUBLISHER_REDIS_URL',
  'FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID',
] as const

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

export type S4CompletionHandoffDiscovery = {
  agentRunId: string
  localRunEvidenceId: string
  runtimeAuditId: string | null
  sourceArtifactId: string
  handoffState: string
}

export type S4CompletionHandoffClaim = S4CompletionHandoffDiscovery & {
  handoffId: string
  workPackageId: string
  taskId: string
  reviewRequirement: string
  createdAt: Date
  claimGeneration: string
  leaseExpiresAt: Date
}

export type S4OperatorRecoveryResult = {
  actionId: string
  result: string
  resultMarkerFingerprint: string | null
  packageStatus: string
}

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
  providerConfigUpdatedAt: Date | null
  acpExecutionMode: 'not_applicable' | 'unconfined_host_process'
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

function recoveryOperatorUrl(): string {
  try {
    return fixedDatabaseRoleUrl({
      environmentName: 'FORGE_S4_RECOVERY_OPERATOR_DATABASE_URL',
      expectedUsername: 'forge_s4_recovery_operator',
      value: process.env.FORGE_S4_RECOVERY_OPERATOR_DATABASE_URL,
    })
  } catch {
    throw new S4LifecycleError('configuration', 'The S4 recovery-operator database URL is not configured safely.')
  }
}

async function withRecoveryOperator<T>(operation: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(recoveryOperatorUrl(), {
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
      'The protected S4 recovery operation failed closed.',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function readS4RuntimeModeV1(): Promise<'legacy' | 'protected'> {
  const configured = S4_PROTECTED_RUNTIME_ENV.filter((name) => Boolean(process.env[name]?.trim()))
  let rows: { mode: string }[]
  try {
    rows = await db.execute<{ mode: string }>(drizzleSql`
      select forge.read_s4_runtime_mode_for_application_v1() as mode
    `)
  } catch (error) {
    // Old databases with no S4 authority reader remain compatible only when no
    // protected credential has been provisioned. Once provisioning starts, an
    // unavailable authority is ambiguous and must fail closed.
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    if (configured.length === 0 && code === '42883') return 'legacy'
    throw new S4LifecycleError(
      configured.length > 0 ? 'configuration' : 'invalid_evidence',
      'The authoritative S4 runtime mode is unavailable.',
    )
  }

  const mode = rows.length === 1 ? rows[0]?.mode : null
  if (mode === 'legacy') return 'legacy'
  if (mode !== 'protected') {
    throw new S4LifecycleError('invalid_evidence', 'The authoritative S4 runtime mode was invalid.')
  }

  if (configured.length !== S4_PROTECTED_RUNTIME_ENV.length) {
    const missing = S4_PROTECTED_RUNTIME_ENV.filter((name) => !process.env[name]?.trim())
    throw new S4LifecycleError(
      'configuration',
      `Protected S4 runtime is active but its credential set is incomplete; missing ${missing.join(', ')}.`,
    )
  }
  return 'protected'
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
        ${input.providerConfigId}::uuid, ${input.modelIdUsed}::text,
        ${input.providerConfigUpdatedAt}::timestamptz, ${input.acpExecutionMode}::text,
        ${input.stage}::text,
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

export async function discoverS4CompletionHandoffV1(input: {
  workPackageId: string
}): Promise<S4CompletionHandoffDiscovery | null> {
  return withIssuer(async (sql) => {
    const rows = await sql<S4CompletionHandoffDiscovery[]>`
      select agent_run_id as "agentRunId",
        local_run_evidence_id as "localRunEvidenceId",
        runtime_audit_id as "runtimeAuditId",
        source_artifact_id as "sourceArtifactId",
        handoff_state as "handoffState"
      from forge.discover_s4_completion_handoff_v1(${input.workPackageId}::uuid)
    `
    if (rows.length > 1) {
      throw new S4LifecycleError('invalid_evidence', 'The S4 completion handoff discovery was ambiguous.')
    }
    return rows[0] ?? null
  })
}

export async function materializeS4CompletionHandoffV1(input: {
  agentRunId: string
  requiredGateTypes: readonly string[]
}): Promise<{ packageStatus: string; sourceArtifactId: string }> {
  const requiredGateTypes = [...new Set(input.requiredGateTypes)].sort()
  return withIssuer(async (sql) => {
    const [row] = await sql<{ packageStatus: string; sourceArtifactId: string }[]>`
      select package_status as "packageStatus", source_artifact_id as "sourceArtifactId"
      from forge.materialize_s4_completion_handoff_v1(
        ${input.agentRunId}::uuid,
        ${sql.array(requiredGateTypes, 1009)}::text[]
      )
    `
    if (!row) throw new S4LifecycleError('conflict', 'The S4 completion handoff was not materialized.')
    return row
  })
}

export async function claimPendingS4CompletionHandoffsV1(input: {
  workerId: string
  claimToken: string
  leaseSeconds?: number
  limit?: number
}): Promise<S4CompletionHandoffClaim[]> {
  const leaseSeconds = input.leaseSeconds ?? 30
  const limit = input.limit ?? 100
  return withIssuer(async (sql) => sql<S4CompletionHandoffClaim[]>`
    select handoff_id as "handoffId", agent_run_id as "agentRunId",
      work_package_id as "workPackageId", task_id as "taskId",
      local_run_evidence_id as "localRunEvidenceId",
      runtime_audit_id as "runtimeAuditId", source_artifact_id as "sourceArtifactId",
      handoff_state as "handoffState", review_requirement as "reviewRequirement",
      created_at as "createdAt", claim_generation::text as "claimGeneration",
      lease_expires_at as "leaseExpiresAt"
    from forge.claim_pending_s4_completion_handoffs_v1(
      ${input.workerId}::text, ${input.claimToken}::uuid,
      ${leaseSeconds}::integer, ${limit}::integer
    )
  `)
}

export async function materializeClaimedS4CompletionHandoffV1(input: {
  agentRunId: string
  requiredGateTypes: readonly string[]
  workerId: string
  claimToken: string
  claimGeneration: string
}): Promise<{ packageStatus: string; sourceArtifactId: string }> {
  const requiredGateTypes = [...new Set(input.requiredGateTypes)].sort()
  return withIssuer(async (sql) => {
    const [row] = await sql<{ packageStatus: string; sourceArtifactId: string }[]>`
      select package_status as "packageStatus", source_artifact_id as "sourceArtifactId"
      from forge.materialize_claimed_s4_completion_handoff_v1(
        ${input.agentRunId}::uuid, ${sql.array(requiredGateTypes, 1009)}::text[],
        ${input.workerId}::text, ${input.claimToken}::uuid,
        ${input.claimGeneration}::bigint
      )
    `
    if (!row) throw new S4LifecycleError('conflict', 'The claimed S4 completion handoff was not materialized.')
    return row
  })
}

export async function finalizeS4MaxAttemptsV1(input: {
  taskId: string
  workPackageId: string
  expectedPackageUpdatedAt: Date
  maxAttempts: number
}): Promise<boolean> {
  return withIssuer(async (sql) => {
    const [row] = await sql<{ finalized: boolean }[]>`
      select forge.finalize_s4_max_attempts_v1(
        ${input.taskId}::uuid, ${input.workPackageId}::uuid,
        ${input.expectedPackageUpdatedAt}::timestamptz,
        ${input.maxAttempts}::integer
      ) as finalized
    `
    return row?.finalized === true
  })
}

export async function applyLocalEffectRecoveryActionV2(input: {
  taskId: string
  workPackageId: string
  localRunEvidenceId: string
  action: string
  expectedMarkerFingerprint: string
  actorUserId: string
}): Promise<S4OperatorRecoveryResult> {
  return withRecoveryOperator(async (sql) => {
    const [row] = await sql<S4OperatorRecoveryResult[]>`
      select action_id as "actionId", result,
        result_marker_fingerprint as "resultMarkerFingerprint",
        package_status as "packageStatus"
      from forge.apply_local_effect_recovery_action_v2(
        ${input.taskId}::uuid, ${input.workPackageId}::uuid,
        ${input.localRunEvidenceId}::uuid, ${input.action}::text,
        ${input.expectedMarkerFingerprint}::text, ${input.actorUserId}::uuid
      )
    `
    if (!row) throw new S4LifecycleError('conflict', 'The local-effect recovery action had no result.')
    return row
  })
}

export async function applyPacketIssuanceRecoveryActionV2(input: {
  taskId: string
  workPackageId: string
  priorRuntimeAuditId: string
  action: string
  expectedMarkerFingerprint: string
  actorUserId: string
  authorizingDecisionId?: string | null
}): Promise<S4OperatorRecoveryResult> {
  return withRecoveryOperator(async (sql) => {
    const [row] = await sql<S4OperatorRecoveryResult[]>`
      select action_id as "actionId", result,
        result_marker_fingerprint as "resultMarkerFingerprint",
        package_status as "packageStatus"
      from forge.apply_packet_issuance_recovery_action_v2(
        ${input.taskId}::uuid, ${input.workPackageId}::uuid,
        ${input.priorRuntimeAuditId}::uuid, ${input.action}::text,
        ${input.expectedMarkerFingerprint}::text, ${input.actorUserId}::uuid,
        ${input.authorizingDecisionId ?? null}::uuid
      )
    `
    if (!row) throw new S4LifecycleError('conflict', 'The packet recovery action had no result.')
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
