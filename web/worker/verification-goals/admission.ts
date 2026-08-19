import { createHash } from 'node:crypto'

import { db } from '@/db'
import type { Project } from '@/db/schema'
import { sql } from 'drizzle-orm'
import type { VerificationGoalDefinition } from '@/lib/verification-goals/contracts'
import { VERIFICATION_GOAL_RUNNER_CONTRACT_VERSION } from '@/lib/verification-goals/system-limits'
import { DEFAULT_VERIFICATION_GOAL_POLICY } from '@/lib/verification-goals/policy-contracts'
import { resolveVerificationGoalOperationBinding } from '@/lib/verification-goals/eligibility'
import { GOAL_GIT_SAFETY_PROFILE_V1, goalGitSafetyProfileDigest } from '@/lib/verification-goals/git-safety-profile'

export type ManualRunAdmissionInput = {
  project: Project
  goal: VerificationGoalDefinition
  snapshotId: string
  sourcePath: string
  definitionDigest: string
  registryRevisionId: string
  registryEntryOrdinal: number
  executionBindingDigest: string | null
  requestedByUserId: string
  manualIdempotencyKey: string
  /** The current policy head revision; must be the live head at call time. */
  policyRevisionId: string
  policyRevisionSequence: bigint
}

export type ManualRunAdmissionResult = {
  runId: string
  state: 'created' | 'existing'
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function nowPlusSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000)
}

/**
 * Admits a manual verification goal run through the protected DB routine.
 *
 * The routine is the single authoritative write path: it revalidates the live
 * policy head, registry head, entry and snapshot identity under the canonical
 * lock order, enforces manual-execution policy and every capacity/start-budget
 * limit, checks idempotent replay, and creates the queued row and the
 * `admitted` event atomically. The application login has no direct INSERT
 * privilege on `verification_goal_runs`, so a bypassing write cannot work and
 * must not be attempted.
 */
export async function admitManualVerificationGoalRun(
  input: ManualRunAdmissionInput,
): Promise<ManualRunAdmissionResult> {
  const resolvedPolicy = buildResolvedPolicy(input)
  const resolvedPolicyFingerprint = sha256Hex(JSON.stringify(resolvedPolicy))
  const authorityFingerprint = sha256Hex(
    [
      input.project.id,
      input.registryRevisionId,
      input.snapshotId,
      input.definitionDigest,
      input.executionBindingDigest ?? '',
    ].join('\0'),
  )
  const manualRequestFingerprint = sha256Hex(
    [
      input.requestedByUserId,
      input.manualIdempotencyKey,
      input.goal.goalId,
      input.snapshotId,
    ].join('\0'),
  )
  const admissionExpiry = nowPlusSeconds(DEFAULT_VERIFICATION_GOAL_POLICY.maxQueueAgeSeconds)

  const [row] = await db.execute<{ run_id: string; state: 'created' | 'existing' }>(sql`
    SELECT *
    FROM public.forge_admit_verification_goal_run_v1(
      ${input.project.id}::uuid,
      ${input.registryRevisionId}::uuid,
      ${input.registryEntryOrdinal}::integer,
      ${input.snapshotId}::uuid,
      ${input.goal.goalId}::text,
      ${input.goal.definitionVersion}::integer,
      ${input.definitionDigest}::text,
      ${input.sourcePath}::text,
      ${input.executionBindingDigest}::text,
      ${input.policyRevisionId}::uuid,
      ${input.policyRevisionSequence}::bigint,
      ${JSON.stringify(resolvedPolicy)}::jsonb,
      ${resolvedPolicyFingerprint}::text,
      'manual',
      ${input.requestedByUserId}::uuid,
      ${input.manualIdempotencyKey}::uuid,
      ${manualRequestFingerprint}::text,
      NULL::uuid,
      NULL::uuid,
      ${admissionExpiry}::timestamptz,
      ${authorityFingerprint}::text
    ) AS admission
  `)

  if (!row) {
    throw new Error('Verification goal admission returned no row.')
  }
  return { runId: row.run_id, state: row.state }
}

function buildResolvedPolicy(input: ManualRunAdmissionInput): Record<string, unknown> {
  const goalCapability = input.goal.capability
  // Code-owned eligibility is part of admission: an operation outside the
  // reviewed allowlist/profile throws here and the run is never created.
  const operations = input.goal.operations
    .map((operationRef, index) => {
      const binding = resolveVerificationGoalOperationBinding({
        operationId: operationRef.operationId,
        operationVersion: operationRef.operationVersion,
        goalCapability,
        trigger: 'manual',
      })
      return {
        ordinal: index,
        operationId: binding.operationId,
        operationVersion: binding.operationVersion,
        definitionDigest: binding.definitionDigest,
        executionProfileDigest: binding.executionProfileDigest,
        eligibility: binding.eligibility,
        timeoutSeconds: Math.min(
          Math.floor(binding.timeoutMs / 1000),
          DEFAULT_VERIFICATION_GOAL_POLICY.maxRunDeadlineSeconds,
        ),
      }
    })

  const goalDeadlineSeconds = 'execution' in input.goal
    ? input.goal.execution.deadlineSeconds
    : DEFAULT_VERIFICATION_GOAL_POLICY.maxRunDeadlineSeconds
  const requiredEvidence = 'execution' in input.goal
    ? [...input.goal.execution.requiredEvidence]
    : ['repository_identity', 'execution_environment']

  return {
    schemaVersion: 1,
    projectId: input.project.id,
    registryRevisionId: input.registryRevisionId,
    registryEntryOrdinal: input.registryEntryOrdinal,
    snapshotId: input.snapshotId,
    goalId: input.goal.goalId,
    definitionVersion: input.goal.definitionVersion,
    definitionDigest: input.definitionDigest,
    goalCapability,
    executionBindingDigest: input.executionBindingDigest,
    policyRevisionId: input.policyRevisionId,
    // Serialized as text: the JSON column must never see a bigint, and the
    // authoritative bigint travels in the routine parameter instead.
    policyRevisionSequence: input.policyRevisionSequence.toString(),
    triggerKind: 'manual',
    effectiveDeadlineSeconds: Math.min(
      goalDeadlineSeconds,
      DEFAULT_VERIFICATION_GOAL_POLICY.maxRunDeadlineSeconds,
    ),
    effectiveQueueAgeSeconds: DEFAULT_VERIFICATION_GOAL_POLICY.maxQueueAgeSeconds,
    effectiveRequiredEvidence: requiredEvidence,
    systemLimitVersion: VERIFICATION_GOAL_RUNNER_CONTRACT_VERSION,
    executionAvailability: true,
    gitSafetyProfileVersion: GOAL_GIT_SAFETY_PROFILE_V1.schemaVersion,
    gitSafetyProfileDigest: goalGitSafetyProfileDigest(GOAL_GIT_SAFETY_PROFILE_V1),
    trustedExecutableContractVersion: 1,
    canonicalOperationOrdinals: operations,
  }
}
