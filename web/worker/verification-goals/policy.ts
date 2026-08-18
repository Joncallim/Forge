import { createHash } from 'node:crypto'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { DEFAULT_VERIFICATION_GOAL_POLICY } from '@/lib/verification-goals/policy-contracts'

export const VERIFICATION_GOAL_POLICY_DIGEST_DOMAIN =
  'forge:verification-goal:policy:v1\0' as const

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function policyDigest(policy: {
  manualEnabled: boolean
  schedulingEnabled: boolean
  minScheduleIntervalSeconds: number
  maxRunDeadlineSeconds: number
  maxQueueAgeSeconds: number
  maxOperationsPerRun: number
  maxConcurrentRuns: number
  maxQueuedRuns: number
  maxActiveRuns: number
  startBudgetWindowSeconds: number
  maxStartsPerWindow: number
}): string {
  return sha256Hex(
    [
      VERIFICATION_GOAL_POLICY_DIGEST_DOMAIN,
      String(policy.manualEnabled),
      String(policy.schedulingEnabled),
      String(policy.minScheduleIntervalSeconds),
      String(policy.maxRunDeadlineSeconds),
      String(policy.maxQueueAgeSeconds),
      String(policy.maxOperationsPerRun),
      String(policy.maxConcurrentRuns),
      String(policy.maxQueuedRuns),
      String(policy.maxActiveRuns),
      String(policy.startBudgetWindowSeconds),
      String(policy.maxStartsPerWindow),
    ].join('\n'),
  )
}

/**
 * Seeds the default-disabled verification goal policy for a project.
 *
 * This is intended for migration-time and new-project initialization parity.
 * Human edits use the protected CAS routine with an expected head.
 */
export async function seedVerificationGoalPolicy(input: {
  projectId: string
  actorKind: 'migration_seed' | 'system_default'
  actorUserId?: string
}): Promise<{
  policyRevisionId: string
  revisionSequence: bigint
  headState: 'inserted' | 'advanced'
}> {
  const digest = policyDigest(DEFAULT_VERIFICATION_GOAL_POLICY)
  const [row] = await db.execute<{
    policy_revision_id: string
    revision_sequence: bigint
    head_state: 'inserted' | 'advanced'
  }>(sql`
    SELECT *
    FROM public.forge_commit_verification_goal_policy_revision_v1(
      ${input.projectId}::uuid,
      ${input.actorUserId ?? null}::uuid,
      NULL::uuid,
      NULL::bigint,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.manualEnabled}::boolean,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.schedulingEnabled}::boolean,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.minScheduleIntervalSeconds}::bigint,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.maxRunDeadlineSeconds}::bigint,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.maxQueueAgeSeconds}::bigint,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.maxOperationsPerRun}::integer,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.maxConcurrentRuns}::integer,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.maxQueuedRuns}::integer,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.maxActiveRuns}::integer,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.startBudgetWindowSeconds}::bigint,
      ${DEFAULT_VERIFICATION_GOAL_POLICY.maxStartsPerWindow}::bigint,
      ${input.actorKind}::text,
      NULL::uuid,
      ${digest}::text
    )
  `)

  if (!row) {
    throw new Error('Verification goal policy seed returned no row.')
  }

  return {
    policyRevisionId: row.policy_revision_id,
    revisionSequence: row.revision_sequence,
    headState: row.head_state,
  }
}
