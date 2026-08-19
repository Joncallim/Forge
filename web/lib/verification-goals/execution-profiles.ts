import { createHash } from 'node:crypto'

import type { OperationDefinition } from '@/lib/operations/contracts'

export const VERIFICATION_GOAL_OPERATION_EXECUTION_PROFILE_VERSION = 1 as const

export type GoalOperationFailureDisposition =
  | 'functional'
  | 'policy'
  | 'authority'
  | 'infrastructure'
  | 'evidence'
  | 'cancelled'

export type GoalOperationExecutionProfileV1 = {
  schemaVersion: typeof VERIFICATION_GOAL_OPERATION_EXECUTION_PROFILE_VERSION
  operationId: string
  operationVersion: number
  adapterContractVersion: number
  commandTemplateDigest: string
  gitSafetyProfileVersion: number
  gitSafetyProfileDigest: string
  deterministicVerifierContractVersion: number
  deterministicVerifierDigest: string
  failureClassifierContractVersion: number
  failureClassifierDigest: string
  rootLauncherContractVersion: number
  trustedExecutableContractVersion: number
}

const GOAL_OPERATION_EXECUTION_PROFILE_DOMAIN =
  'forge:verification-goal:operation-execution-profile:v1\0' as const

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Builds the immutable execution profile for one goal-eligible operation.
 * The digest participates in the registry execution binding and the run
 * environment evidence, so any change to fixed command template, Git hardening,
 * verifier, classifier, launcher or executable contract requires explicit
 * registry re-import before execution resumes.
 */
export function buildGoalOperationExecutionProfileV1(
  definition: OperationDefinition,
): GoalOperationExecutionProfileV1 {
  const profile: GoalOperationExecutionProfileV1 = {
    schemaVersion: VERIFICATION_GOAL_OPERATION_EXECUTION_PROFILE_VERSION,
    operationId: definition.id,
    operationVersion: definition.version,
    adapterContractVersion: 1,
    commandTemplateDigest: sha256Hex(definition.adapter),
    gitSafetyProfileVersion: 1,
    gitSafetyProfileDigest: sha256Hex('forge:git-safety-profile:v1:read-only'),
    deterministicVerifierContractVersion: 1,
    deterministicVerifierDigest: sha256Hex(
      `forge:deterministic-verifier:v1:${definition.adapter}`,
    ),
    failureClassifierContractVersion: 1,
    failureClassifierDigest: sha256Hex(
      `forge:failure-classifier:v1:${definition.adapter}:conservative`,
    ),
    rootLauncherContractVersion: 1,
    trustedExecutableContractVersion: 1,
  }
  return profile
}

export function goalOperationExecutionProfileDigest(
  profile: GoalOperationExecutionProfileV1,
): string {
  return sha256Hex(
    [
      GOAL_OPERATION_EXECUTION_PROFILE_DOMAIN,
      String(profile.schemaVersion),
      profile.operationId,
      String(profile.operationVersion),
      String(profile.adapterContractVersion),
      profile.commandTemplateDigest,
      String(profile.gitSafetyProfileVersion),
      profile.gitSafetyProfileDigest,
      String(profile.deterministicVerifierContractVersion),
      profile.deterministicVerifierDigest,
      String(profile.failureClassifierContractVersion),
      profile.failureClassifierDigest,
      String(profile.rootLauncherContractVersion),
      String(profile.trustedExecutableContractVersion),
    ].join('\n'),
  )
}
