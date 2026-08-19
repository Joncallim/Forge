import { createHash, randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { Project } from '@/db/schema'
import {
  type VerificationGoalRunResult,
  type VerificationGoalRunTerminalCode,
} from '@/lib/verification-goals/run-contracts'
import {
  VERIFICATION_GOAL_RUNNER_CONTRACT_VERSION,
  VERIFICATION_GOAL_SYSTEM_LIMITS_V1,
} from '@/lib/verification-goals/system-limits'
import {
  resolveVerificationGoalOperationBinding,
  verificationGoalCommandTemplateFor,
  verificationGoalEligibilityPolicyDigest,
  VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION,
} from '@/lib/verification-goals/eligibility'
import { GOAL_GIT_SAFETY_PROFILE_V1, goalGitSafetyProfileDigest } from '@/lib/verification-goals/git-safety-profile'
import { operationFingerprint } from '@/lib/operations/contracts'
import { loadVerificationGoalFilesystemAuthority } from './filesystem-authority'
import { computeGoalRepositoryProfile } from './repository-profile'
import {
  launchRootAnchoredCommand,
  RootCommandLauncherError,
  ROOT_COMMAND_LAUNCHER_CONTRACT_DIGEST,
  ROOT_COMMAND_LAUNCHER_VERSION,
} from './root-command-launcher'
import {
  revalidateTrustedExecutable,
  type TrustedExecutableRegistryV1,
} from './trusted-executables'

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

type ResolvedCanonicalOperation = {
  ordinal: number
  operationId: string
  operationVersion: number
  definitionDigest: string
  executionProfileDigest: string
  eligibility: string
  timeoutSeconds: number
}

type ResolvedRunPolicy = {
  goalCapability?: string
  effectiveDeadlineSeconds?: number
  canonicalOperationOrdinals: ResolvedCanonicalOperation[]
}

type GoalRunRow = {
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
 * The runner claims the PostgreSQL business lease (queued rows only), keeps it
 * renewed on the reviewed 10-second target, records the repository and
 * environment evidence snapshots, executes the exact bound operations in
 * canonical ordinal order under the root-anchored launcher, and terminalizes
 * through the protected v2 routine. A lost lease is never re-claimed here:
 * only the recovery fence may transition an expired running row.
 */
export async function executeVerificationGoalRun(
  context: VerificationGoalRunnerContext,
): Promise<VerificationGoalRunOutcome> {
  const { project, runId, trustedExecutables } = context

  // 1. Claim the business lease. The claim routine accepts queued rows only;
  //    an expired running row belongs to the recovery fence, never to a
  //    competing worker.
  const leaseGeneration = BigInt(1)
  const leaseToken = randomUUID()
  const leaseDurationSeconds = VERIFICATION_GOAL_SYSTEM_LIMITS_V1.businessLeaseMs / 1000
  const leaseExpiresAt = nowPlusSeconds(leaseDurationSeconds)

  await db.execute(sql`
    SELECT public.forge_claim_verification_goal_run_lease_v1(
      ${runId}::uuid,
      ${leaseGeneration}::bigint,
      ${leaseToken}::uuid,
      ${leaseExpiresAt}::timestamptz
    )
  `)

  // 2. Keep the lease renewed on the reviewed cadence. Any renewal failure or
  //    non-owner response disables further proof writes for this process.
  let leaseLost = false
  const renewTimer = setInterval(() => {
    void (async () => {
      try {
        const [row] = await db.execute<{ state: string }>(sql`
          SELECT public.forge_renew_verification_goal_run_lease_v1(
            ${runId}::uuid,
            ${leaseGeneration}::bigint,
            ${leaseToken}::uuid,
            ${nowPlusSeconds(leaseDurationSeconds)}::timestamptz
          ) AS state
        `)
        if (row?.state !== 'renewed') {
          leaseLost = true
        }
      } catch {
        leaseLost = true
      }
    })()
  }, VERIFICATION_GOAL_SYSTEM_LIMITS_V1.leaseRenewTargetMs)

  try {
    // 3. Re-verify the pinned executable identities captured at startup.
    await revalidateTrustedExecutable(trustedExecutables.node)
    await revalidateTrustedExecutable(trustedExecutables.git)

    // 4. Load the retained filesystem authority for the project root.
    const filesystemAuthority = await loadVerificationGoalFilesystemAuthority(project)

    // 5. Load the immutable run row and its stored resolved policy.
    const [runRow] = await db.execute<GoalRunRow>(sql`
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

    const resolvedPolicy = parseResolvedPolicy(runRow.resolved_policy)
    if (resolvedPolicy === null) {
      return terminalize(context, {
        result: 'inconclusive',
        terminalCode: 'operation_contract_changed',
      })
    }

    // 6. Compute the supported repository profile through the hardened reads.
    const repositoryProfile = await computeGoalRepositoryProfile({
      authority: filesystemAuthority,
      gitPath: trustedExecutables.git.absoluteRealPath,
    })

    if (!repositoryProfile.supported) {
      return terminalize(context, {
        result: 'inconclusive',
        terminalCode: repositoryProfile.reasonCode ?? 'unsupported_repository_identity',
      })
    }

    // 7. Record the repository and environment evidence snapshots. Both are
    //    lease-fenced and required before a `passed` terminalization.
    await recordRepositorySnapshot(context, runRow, repositoryProfile)
    await recordEnvironmentSnapshot(context, runRow)

    // 8. Overall deadline begins at durable claim and covers preflight.
    const startedAt = Date.now()
    const effectiveDeadlineSeconds = resolvedPolicy.effectiveDeadlineSeconds !== undefined
      ? Math.min(
          resolvedPolicy.effectiveDeadlineSeconds,
          VERIFICATION_GOAL_SYSTEM_LIMITS_V1.maxRunDeadlineSeconds,
        )
      : VERIFICATION_GOAL_SYSTEM_LIMITS_V1.maxRunDeadlineSeconds

    // 9. Execute the exact bound operations in canonical ordinal order.
    for (const operation of resolvedPolicy.canonicalOperationOrdinals) {
      if (leaseLost) {
        return { result: 'inconclusive', terminalCode: 'lease_lost' }
      }
      if (Date.now() - startedAt > effectiveDeadlineSeconds * 1000) {
        return terminalize(context, {
          result: 'inconclusive',
          terminalCode: 'execution_deadline_exceeded',
        })
      }

      // Re-resolve the reviewed eligibility binding and require the stored
      // digests to match the current code. Any verifier/classifier/profile
      // drift makes the stored policy non-executable instead of silently
      // running a different contract.
      const binding = resolveVerificationGoalOperationBinding({
        operationId: operation.operationId,
        operationVersion: operation.operationVersion,
        goalCapability: resolvedPolicy.goalCapability,
        trigger: 'manual',
      })
      if (
        binding.definitionDigest !== operation.definitionDigest
        || binding.executionProfileDigest !== operation.executionProfileDigest
      ) {
        return terminalize(context, {
          result: 'inconclusive',
          terminalCode: 'operation_contract_changed',
        })
      }

      const template = verificationGoalCommandTemplateFor(
        binding.operationId,
        binding.operationVersion,
      )
      if (template[0] !== 'git') {
        throw new Error(`Verification goal command template for ${binding.operationId} is not a Git command.`)
      }
      const argv = [...template.slice(1)]

      const childId = await beginChildOperation(context, operation, binding.capability)

      const launchResult = await launchRootAnchoredCommand({
        rootLease: filesystemAuthority,
        executable: trustedExecutables.git,
        argv,
        timeoutMs: operation.timeoutSeconds * 1000,
        safeEnvironment: {},
      })

      const childOutcome = classifyChildResult(launchResult)
      await finalizeChildOperation(context, leaseToken, childId, childOutcome)

      if (childOutcome.result !== 'passed') {
        return terminalize(context, childOutcome)
      }
    }

    return terminalize(context, { result: 'passed', terminalCode: 'passed' })
  } catch (error) {
    console.error('Verification goal run failed:', error)
    if (leaseLost) {
      // The DB-fenced terminalizer cannot run without the lease; the recovery
      // fence owns the row from here.
      return { result: 'inconclusive', terminalCode: 'lease_lost' }
    }
    const terminalCode = error instanceof RootCommandLauncherError
      ? launcherTerminalCode(error.code)
      : 'internal_infrastructure_error'
    try {
      return await terminalize(context, {
        result: 'inconclusive',
        terminalCode,
      })
    } catch {
      return { result: 'inconclusive', terminalCode: 'lease_lost' }
    }
  } finally {
    clearInterval(renewTimer)
  }
}

function parseResolvedPolicy(value: unknown): (ResolvedRunPolicy & { goalCapability: string }) | null {
  if (typeof value !== 'object' || value === null) return null
  const policy = value as Partial<ResolvedRunPolicy>
  if (typeof policy.goalCapability !== 'string') return null
  if (!Array.isArray(policy.canonicalOperationOrdinals)) return null
  for (const operation of policy.canonicalOperationOrdinals) {
    if (
      typeof operation !== 'object'
      || operation === null
      || typeof operation.operationId !== 'string'
      || typeof operation.operationVersion !== 'number'
      || typeof operation.definitionDigest !== 'string'
      || typeof operation.executionProfileDigest !== 'string'
      || typeof operation.timeoutSeconds !== 'number'
    ) {
      return null
    }
  }
  return policy as ResolvedRunPolicy & { goalCapability: string }
}

function launcherTerminalCode(code: RootCommandLauncherError['code']): VerificationGoalRunTerminalCode {
  switch (code) {
    case 'root_changed':
      return 'root_changed'
    case 'executable_changed':
      return 'git_executable_untrusted'
    case 'timeout':
    case 'cancelled':
      return 'execution_deadline_exceeded'
    case 'launch_failed':
      return 'operation_infrastructure_failed'
  }
}

function classifyChildResult(result: Awaited<ReturnType<typeof launchRootAnchoredCommand>>): {
  result: VerificationGoalRunResult
  terminalCode: VerificationGoalRunTerminalCode
} {
  if (result.spawnError !== null) {
    // ENOENT/EACCES/STDIO_MAXBUFFER: the target never ran to completion.
    return { result: 'inconclusive', terminalCode: 'operation_infrastructure_failed' }
  }
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

async function recordRepositorySnapshot(
  context: VerificationGoalRunnerContext,
  runRow: GoalRunRow,
  repositoryProfile: Awaited<ReturnType<typeof computeGoalRepositoryProfile>>,
): Promise<void> {
  const { project, runId } = context
  if (
    project.submittedBy === null
    || project.rootBindingRevision <= BigInt(0)
    || project.grantDecisionRevision <= BigInt(0)
  ) {
    throw new Error('Verification goal project filesystem authority is not bound.')
  }
  const repositorySnapshotFingerprint = sha256Hex(
    [
      'forge:verification-goal:repository-snapshot:v1',
      runId,
      String(project.rootBindingRevision),
      String(project.grantDecisionRevision),
      repositoryProfile.objectFormat ?? '',
      repositoryProfile.headOid ?? '',
      repositoryProfile.metadataFingerprint ?? '',
      repositoryProfile.indexFingerprint ?? '',
      repositoryProfile.configFingerprint ?? '',
      String(repositoryProfile.gitSafetyProfileVersion),
      repositoryProfile.gitSafetyProfileDigest,
    ].join('\0'),
  )
  await db.execute(sql`
    SELECT *
    FROM public.forge_record_verification_goal_repository_snapshot_v1(
      ${runId}::uuid,
      ${project.submittedBy}::uuid,
      ${project.updatedAt}::timestamptz,
      ${project.rootBindingRevision}::bigint,
      ${project.grantDecisionRevision}::bigint,
      ${repositoryProfile.objectFormat}::text,
      ${repositoryProfile.headOid}::text,
      ${true}::boolean,
      ${repositoryProfile.metadataFingerprint}::text,
      ${repositoryProfile.indexFingerprint}::text,
      ${repositoryProfile.configFingerprint}::text,
      ${repositorySnapshotFingerprint}::text
    )
  `)
}

async function recordEnvironmentSnapshot(
  context: VerificationGoalRunnerContext,
  runRow: GoalRunRow,
): Promise<void> {
  const { runId, trustedExecutables } = context
  // Goals admitted without a registry execution binding still record a fixed
  // unbound-identity digest so the environment evidence is always present.
  const executionBindingDigest = runRow.execution_binding_digest
    ?? sha256Hex('forge:verification-goal:execution-binding:v1:unbound')
  const releaseStateClass = process.env.NODE_ENV === 'production' ? 'release' : 'development'
  const environmentFingerprint = sha256Hex(
    [
      'forge:verification-goal:environment:v1',
      runId,
      String(VERIFICATION_GOAL_RUNNER_CONTRACT_VERSION),
      String(ROOT_COMMAND_LAUNCHER_VERSION),
      ROOT_COMMAND_LAUNCHER_CONTRACT_DIGEST,
      trustedExecutables.node.contentDigest,
      trustedExecutables.node.normalizedVersion,
      trustedExecutables.git.contentDigest,
      trustedExecutables.git.normalizedVersion,
      String(GOAL_GIT_SAFETY_PROFILE_V1.schemaVersion),
      goalGitSafetyProfileDigest(GOAL_GIT_SAFETY_PROFILE_V1),
      process.platform,
      process.arch,
      executionBindingDigest,
      String(VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION),
      verificationGoalEligibilityPolicyDigest(),
      releaseStateClass,
    ].join('\0'),
  )
  await db.execute(sql`
    SELECT *
    FROM public.forge_record_verification_goal_environment_snapshot_v1(
      ${runId}::uuid,
      ${1}::integer,
      ${VERIFICATION_GOAL_RUNNER_CONTRACT_VERSION}::integer,
      ${'forge-web'}::text,
      ${releaseStateClass}::text,
      ${ROOT_COMMAND_LAUNCHER_VERSION}::integer,
      ${ROOT_COMMAND_LAUNCHER_CONTRACT_DIGEST}::text,
      ${trustedExecutables.node.contentDigest}::text,
      ${trustedExecutables.node.normalizedVersion}::text,
      ${trustedExecutables.git.contentDigest}::text,
      ${trustedExecutables.git.normalizedVersion}::text,
      ${GOAL_GIT_SAFETY_PROFILE_V1.schemaVersion}::integer,
      ${goalGitSafetyProfileDigest(GOAL_GIT_SAFETY_PROFILE_V1)}::text,
      ${process.platform}::text,
      ${process.arch}::text,
      ${executionBindingDigest}::text,
      ${VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION}::integer,
      ${verificationGoalEligibilityPolicyDigest()}::text,
      ${environmentFingerprint}::text
    )
  `)
}

async function beginChildOperation(
  context: VerificationGoalRunnerContext,
  operation: ResolvedCanonicalOperation,
  capability: string,
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
      ${capability}::text,
      ${idempotencyKey}::text,
      ${operation.definitionDigest}::text,
      ${operationFingerprint('scope', context.project.id)}::text,
      ${operationFingerprint('request', operation.operationId)}::text,
      ${operationFingerprint('inputs', {})}::text,
      ${operationFingerprint('reason', 'verification-goal-proof')}::text,
      ${JSON.stringify({ allowed: true, capability })}::jsonb
    ) as id
  `)
  return row!.id
}

function mapChildOutcome(outcome: {
  result: VerificationGoalRunResult
  terminalCode: VerificationGoalRunTerminalCode
}): {
  transportStatus: 'ok' | 'error'
  result: 'completed' | 'failed' | 'needs_attention'
  failureClass: 'functional' | 'infrastructure' | 'cancelled' | null
} {
  if (outcome.result === 'passed') {
    return { transportStatus: 'ok', result: 'completed', failureClass: null }
  }
  if (outcome.result === 'failed') {
    return { transportStatus: 'error', result: 'failed', failureClass: 'functional' }
  }
  // Conservative v1 classifier: no deterministic functional negative exists,
  // so non-pass children are needs_attention (architecture section 25 closed
  // child mapping). Deadlines map to cancellation, everything else to
  // infrastructure.
  if (outcome.terminalCode === 'execution_deadline_exceeded') {
    return { transportStatus: 'error', result: 'needs_attention', failureClass: 'cancelled' }
  }
  return { transportStatus: 'error', result: 'needs_attention', failureClass: 'infrastructure' }
}

async function finalizeChildOperation(
  context: VerificationGoalRunnerContext,
  leaseToken: string,
  childId: string,
  outcome: { result: VerificationGoalRunResult; terminalCode: VerificationGoalRunTerminalCode },
): Promise<void> {
  const mapping = mapChildOutcome(outcome)
  await db.execute(sql`
    SELECT public.forge_finalize_verification_goal_child_operation_v1(
      ${context.runId}::uuid,
      ${leaseToken}::uuid,
      ${childId}::uuid,
      ${mapping.transportStatus}::text,
      ${mapping.result}::text,
      ${mapping.failureClass === null ? null : mapping.failureClass}::text,
      ${false}::boolean,
      ${'not_required'}::text,
      ${operationFingerprint('outcome', `${childId}:${outcome.terminalCode}`)}::text
    )
  `)
}

async function terminalize(
  context: VerificationGoalRunnerContext,
  outcome: VerificationGoalRunOutcome,
): Promise<VerificationGoalRunOutcome> {
  const evidenceSetDigest = sha256Hex(`${context.runId}:${outcome.terminalCode}`)
  const evidenceUnitFingerprint = sha256Hex(`${context.runId}:${outcome.result}`)

  // The v2 terminalizer validates the child prefix, requires repository and
  // environment evidence for `passed`, and atomically writes the overall
  // outcome, evidence digests, final event, and terminal run state.
  await db.execute(sql`
    SELECT public.forge_terminalize_verification_goal_run_v2(
      ${context.runId}::uuid,
      ${outcome.result}::text,
      ${outcome.terminalCode}::text,
      ${evidenceSetDigest}::text,
      ${evidenceUnitFingerprint}::text,
      ${outcome.result === 'failed' ? 'functional' : null}::text
    )
  `)

  return outcome
}
