import { createHash, randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { Project } from '@/db/schema'
import {
  OPERATION_CATALOG,
  resolveOperationDefinition,
} from '@/lib/operations/catalog'
import {
  type VerificationGoalRunResult,
  type VerificationGoalRunTerminalCode,
} from '@/lib/verification-goals/run-contracts'
import { VERIFICATION_GOAL_SYSTEM_LIMITS_V1 } from '@/lib/verification-goals/system-limits'
import {
  buildGoalOperationExecutionProfileV1,
  goalOperationExecutionProfileDigest,
} from '@/lib/verification-goals/execution-profiles'
import { operationFingerprint } from '@/lib/operations/contracts'
import { loadVerificationGoalFilesystemAuthority } from './filesystem-authority'
import { computeGoalRepositoryProfile } from './repository-profile'
import { launchRootAnchoredCommand } from './root-command-launcher'
import type { TrustedExecutableRegistryV1 } from './trusted-executables'

export const VERIFICATION_GOAL_RUNNER_VERSION = 1 as const

export type VerificationGoalRunnerContext = {
  project: Project
  runId: string
  trustedExecutables: TrustedExecutableRegistryV1
  nodePath: string
  gitPath: string
}

export type VerificationGoalRunOutcome = {
  result: VerificationGoalRunResult
  terminalCode: VerificationGoalRunTerminalCode
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function nowPlusSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000)
}

/**
 * Executes one verification goal run from queued to terminal state.
 *
 * This is a minimal manual-runner slice: it claims the PostgreSQL business
 * lease, loads filesystem authority, computes the repository profile, runs the
 * canonical operation sequence in order, and terminalizes. It does not yet
 * implement the full root-shim/TrustedProjectRootLease retention boundary or
 * scheduler integration; those are separate architecture slices.
 */
export async function executeVerificationGoalRun(
  context: VerificationGoalRunnerContext,
): Promise<VerificationGoalRunOutcome> {
  const { project, runId, trustedExecutables } = context

  // 1. Claim business lease.
  const leaseGeneration = BigInt(1)
  const leaseToken = randomUUID()
  const leaseExpiresAt = nowPlusSeconds(
    VERIFICATION_GOAL_SYSTEM_LIMITS_V1.businessLeaseMs / 1000,
  )

  await db.execute(sql`
    SELECT public.forge_claim_verification_goal_run_lease_v1(
      ${runId}::uuid,
      ${leaseGeneration}::bigint,
      ${leaseToken}::uuid,
      ${leaseExpiresAt}::timestamptz
    )
  `)

  try {
    // 2. Load filesystem authority.
    const filesystemAuthority = await loadVerificationGoalFilesystemAuthority(project)

    // 3. Compute repository profile.
    const repositoryProfile = await computeGoalRepositoryProfile({
      authority: filesystemAuthority,
      gitPath: context.gitPath,
    })

    if (!repositoryProfile.supported) {
      return terminalize(context, {
        result: 'inconclusive',
        terminalCode: repositoryProfile.reasonCode ?? 'unsupported_repository_identity',
      })
    }

    // 4. Load run row and resolved policy.
    const [runRow] = await db.execute<{
      registry_revision_id: string
      registry_entry_ordinal: number
      snapshot_id: string
      goal_id: string
      definition_version: number
      definition_digest: string
      source_path: string
      execution_binding_digest: string | null
      policy_revision_id: string
      policy_revision_sequence: string
      resolved_policy: unknown
      resolved_policy_fingerprint: string
      trigger_kind: string
    }>(sql`
      SELECT
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
        trigger_kind
      FROM public.verification_goal_runs
      WHERE id = ${runId}::uuid
    `)

    if (!runRow) {
      return terminalize(context, {
        result: 'inconclusive',
        terminalCode: 'internal_infrastructure_error',
      })
    }

    const resolvedPolicy = runRow.resolved_policy as {
      operations: Array<{
        ordinal: number
        operationId: string
        operationVersion: number
        definitionDigest: string
        executionProfileDigest: string
        eligibility: string
        timeoutSeconds: number
      }>
    }

    // 5. Execute operations in canonical order.
    for (const operation of resolvedPolicy.operations) {
      const definition = resolveOperationDefinition({
        operationId: operation.operationId,
        operationVersion: operation.operationVersion,
      }, OPERATION_CATALOG)

      const profile = buildGoalOperationExecutionProfileV1(definition)
      const profileDigest = goalOperationExecutionProfileDigest(profile)
      if (profileDigest !== operation.executionProfileDigest) {
        return terminalize(context, {
          result: 'inconclusive',
          terminalCode: 'operation_contract_changed',
        })
      }

      const childId = await beginChildOperation(context, operation)

      const launchResult = await launchRootAnchoredCommand({
        rootLease: filesystemAuthority,
        executable: trustedExecutables.git,
        argv: buildGitArgv(definition.adapter),
        timeoutMs: operation.timeoutSeconds * 1000,
        safeEnvironment: {},
      })

      const childOutcome = classifyChildResult(launchResult)
      await finalizeChildOperation(childId, childOutcome)

      if (childOutcome.result !== 'passed') {
        return terminalize(context, {
          result: childOutcome.result,
          terminalCode: childOutcome.terminalCode,
        })
      }
    }

    return terminalize(context, { result: 'passed', terminalCode: 'passed' })
  } catch (error) {
    console.error('Verification goal run failed:', error)
    return terminalize(context, {
      result: 'inconclusive',
      terminalCode: 'internal_infrastructure_error',
    })
  }
}

function buildGitArgv(adapter: string): string[] {
  switch (adapter) {
    case 'repository_status_read_v1':
      return ['status', '--porcelain', '--untracked-files=all']
    case 'repository_diff_summary_v1':
      return ['diff', '--stat']
    case 'repository_branch_read_v1':
      return ['rev-parse', '--abbrev-ref', 'HEAD']
    default:
      return ['status', '--porcelain']
  }
}

function classifyChildResult(result: Awaited<ReturnType<typeof launchRootAnchoredCommand>>): {
  result: VerificationGoalRunResult
  terminalCode: VerificationGoalRunTerminalCode
} {
  if (result.timedOut) {
    return { result: 'inconclusive', terminalCode: 'execution_deadline_exceeded' }
  }
  if (result.signal !== null) {
    return { result: 'inconclusive', terminalCode: 'operation_infrastructure_failed' }
  }
  if (result.exitCode !== 0) {
    // Conservative v1 classifier: no deterministic functional-negative classifier
    // exists, so command failure is inconclusive rather than a project regression.
    return { result: 'inconclusive', terminalCode: 'operation_infrastructure_failed' }
  }
  return { result: 'passed', terminalCode: 'passed' }
}

async function beginChildOperation(
  context: VerificationGoalRunnerContext,
  operation: {
    ordinal: number
    operationId: string
    operationVersion: number
    definitionDigest: string
    executionProfileDigest: string
    eligibility: string
    timeoutSeconds: number
  },
): Promise<string> {
  const idempotencyKey = operationFingerprint(
    'verification-goal-child',
    `${context.runId}:${operation.ordinal}:${operation.operationId}:${operation.operationVersion}`,
  )
  const [row] = await db.execute<{ id: string }>(sql`
    SELECT public.forge_begin_verification_goal_child_operation_v1(
      ${context.runId}::uuid,
      ${operation.ordinal}::integer,
      ${operation.operationId}::text,
      ${operation.operationVersion}::integer,
      ${'filesystem.project.read'}::text,
      ${idempotencyKey}::text,
      ${operation.definitionDigest}::text,
      ${operationFingerprint('scope', context.project.id)}::text,
      ${operationFingerprint('request', operation.operationId)}::text,
      ${operationFingerprint('inputs', {})}::text,
      ${operationFingerprint('reason', 'verification-goal-proof')}::text,
      ${JSON.stringify({ allowed: true, capability: 'filesystem.project.read' })}::jsonb
    ) as id
  `)
  return row!.id
}

async function finalizeChildOperation(
  childId: string,
  outcome: { result: VerificationGoalRunResult; terminalCode: VerificationGoalRunTerminalCode },
): Promise<void> {
  await db.execute(sql`
    UPDATE public.operation_runs
    SET status = ${outcome.result === 'passed' ? 'completed' : 'failed'},
        completed_at = now(),
        outcome_fingerprint = ${operationFingerprint('outcome', outcome.terminalCode)}
    WHERE id = ${childId}::uuid
  `)
}

async function terminalize(
  context: VerificationGoalRunnerContext,
  outcome: VerificationGoalRunOutcome,
): Promise<VerificationGoalRunOutcome> {
  const evidenceSetDigest = sha256Hex(`${context.runId}:${outcome.terminalCode}`)
  const evidenceUnitFingerprint = sha256Hex(`${context.runId}:${outcome.result}`)

  // Create a minimal v2 outcome row for the run.
  const [outcomeRow] = await db.execute<{ id: string }>(sql`
    INSERT INTO public.execution_outcomes (
      verification_goal_run_id, attempt_key, schema_version, transport_status,
      result, failure_class, retryable, evidence_refs, verifier_required,
      verification_status
    ) VALUES (
      ${context.runId}::uuid,
      ${'verification-goal-run'}::text,
      2,
      'ok',
      ${outcome.result === 'passed' ? 'completed' : outcome.result === 'failed' ? 'failed' : 'needs_attention'},
      ${outcome.result === 'failed' ? 'functional' : null},
      false,
      '[]'::jsonb,
      false,
      'not_required'
    )
    RETURNING id
  `)

  await db.execute(sql`
    SELECT public.forge_terminalize_verification_goal_run_v1(
      ${context.runId}::uuid,
      ${outcome.result}::text,
      ${outcome.terminalCode}::text,
      ${outcomeRow!.id}::uuid,
      ${evidenceSetDigest}::text,
      ${evidenceUnitFingerprint}::text
    )
  `)

  return outcome
}
