import { createHash, randomUUID } from 'node:crypto'

import { db } from '@/db'
import type { Project } from '@/db/schema'
import { sql } from 'drizzle-orm'
import type { VerificationGoalDefinition } from '@/lib/verification-goals/contracts'
import { VERIFICATION_GOAL_RUNNER_CONTRACT_VERSION } from '@/lib/verification-goals/system-limits'
import { DEFAULT_VERIFICATION_GOAL_POLICY } from '@/lib/verification-goals/policy-contracts'
import type { VerificationGoalExecutionBindingV1 } from '@/lib/verification-goals/executable-contracts'
import { OPERATION_CATALOG, resolveOperationDefinition } from '@/lib/operations/catalog'
import {
  buildGoalOperationExecutionProfileV1,
  goalOperationExecutionProfileDigest,
} from '@/lib/verification-goals/execution-profiles'
import { GOAL_GIT_SAFETY_PROFILE_V1, goalGitSafetyProfileDigest } from '@/lib/verification-goals/git-safety-profile'

export type ManualRunAdmissionInput = {
  project: Project
  goal: VerificationGoalDefinition
  snapshotId: string
  sourcePath: string
  definitionDigest: string
  registryRevisionId: string
  registryEntryOrdinal: number
  executionBinding: VerificationGoalExecutionBindingV1 | null
  requestedByUserId: string
  manualIdempotencyKey: string
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
 * Admits a manual verification goal run.
 *
 * Creates a queued run row bound to the exact registry entry, snapshot,
 * execution binding, and current project policy. The caller is responsible for
 * live registry attestation and policy/capacity checks before invocation.
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
      input.executionBinding?.executionBindingDigest ?? '',
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

  const [existing] = await db.execute<{ id: string }>(sql`
    SELECT id FROM public.verification_goal_runs
    WHERE requested_by_user_id = ${input.requestedByUserId}::uuid
      AND manual_idempotency_key = ${input.manualIdempotencyKey}::uuid
  `)

  if (existing) {
    return { runId: existing.id, state: 'existing' }
  }

  const [run] = await db.execute<{ id: string }>(sql`
    INSERT INTO public.verification_goal_runs (
      project_id,
      registry_revision_id,
      registry_entry_ordinal,
      snapshot_id,
      goal_id,
      definition_version,
      definition_digest,
      source_path,
      execution_binding_digest,
      policy_revision_id,
      policy_revision_sequence,
      resolved_policy,
      resolved_policy_fingerprint,
      trigger_kind,
      requested_by_user_id,
      manual_idempotency_key,
      manual_request_fingerprint,
      admission_expiry,
      authority_fingerprint,
      status
    ) VALUES (
      ${input.project.id}::uuid,
      ${input.registryRevisionId}::uuid,
      ${input.registryEntryOrdinal}::integer,
      ${input.snapshotId}::uuid,
      ${input.goal.goalId}::text,
      ${input.goal.definitionVersion}::integer,
      ${input.definitionDigest}::text,
      ${input.sourcePath}::text,
      ${input.executionBinding?.executionBindingDigest ?? null}::text,
      ${randomUUID()}::uuid,
      ${1}::bigint,
      ${JSON.stringify(resolvedPolicy)}::jsonb,
      ${resolvedPolicyFingerprint}::text,
      'manual',
      ${input.requestedByUserId}::uuid,
      ${input.manualIdempotencyKey}::uuid,
      ${manualRequestFingerprint}::text,
      ${admissionExpiry}::timestamptz,
      ${authorityFingerprint}::text,
      'queued'
    )
    RETURNING id
  `)

  return { runId: run!.id, state: 'created' }
}

function buildResolvedPolicy(input: ManualRunAdmissionInput): Record<string, unknown> {
  const operations = input.goal.operations
    .map((operationRef, index) => {
      const definition = resolveOperationDefinition(operationRef, OPERATION_CATALOG)
      const profile = buildGoalOperationExecutionProfileV1(definition)
      return {
        ordinal: index,
        operationId: definition.id,
        operationVersion: definition.version,
        definitionDigest: sha256Hex(JSON.stringify(definition)),
        executionProfileDigest: goalOperationExecutionProfileDigest(profile),
        eligibility: 'manual_only',
        timeoutSeconds: Math.min(
          definition.timeoutMs / 1000,
          DEFAULT_VERIFICATION_GOAL_POLICY.maxRunDeadlineSeconds,
        ),
      }
    })

  return {
    schemaVersion: 1,
    projectId: input.project.id,
    registryRevisionId: input.registryRevisionId,
    registryEntryOrdinal: input.registryEntryOrdinal,
    snapshotId: input.snapshotId,
    goalId: input.goal.goalId,
    definitionVersion: input.goal.definitionVersion,
    definitionDigest: input.definitionDigest,
    executionBindingDigest: input.executionBinding?.executionBindingDigest ?? null,
    policyRevisionId: null,
    policyRevisionSequence: 1,
    triggerKind: 'manual',
    effectiveDeadlineSeconds: DEFAULT_VERIFICATION_GOAL_POLICY.maxRunDeadlineSeconds,
    effectiveQueueAgeSeconds: DEFAULT_VERIFICATION_GOAL_POLICY.maxQueueAgeSeconds,
    effectiveRequiredEvidence: ['repository_identity', 'execution_environment'],
    systemLimitVersion: VERIFICATION_GOAL_RUNNER_CONTRACT_VERSION,
    executionAvailability: true,
    gitSafetyProfileVersion: GOAL_GIT_SAFETY_PROFILE_V1.schemaVersion,
    gitSafetyProfileDigest: goalGitSafetyProfileDigest(GOAL_GIT_SAFETY_PROFILE_V1),
    trustedExecutableContractVersion: 1,
    canonicalOperationOrdinals: operations,
  }
}
