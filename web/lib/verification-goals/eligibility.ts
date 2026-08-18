import { createHash } from 'node:crypto'

import {
  canonicalJson,
  operationFingerprint,
  type OperationDefinition,
} from '@/lib/operations/contracts'
import {
  OPERATION_CATALOG,
  resolveOperationDefinition,
} from '@/lib/operations/catalog'

export const VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION = 1 as const
export const VERIFICATION_GOAL_EXECUTION_PROFILE_SCHEMA_VERSION = 1 as const
export const VERIFICATION_GOAL_GIT_SAFETY_CONTRACT_VERSION = 1 as const
export const VERIFICATION_GOAL_ROOT_LAUNCHER_CONTRACT_VERSION = 1 as const

export type VerificationGoalOperationEligibility =
  | 'not_allowed'
  | 'manual_only'
  | 'manual_and_scheduled'

export type VerificationGoalTriggerKind = 'manual' | 'scheduled'

export type VerificationGoalOperationExecutionProfileV1 = {
  schemaVersion: 1
  operationId: string
  operationVersion: number
  adapterContractVersion: number
  commandTemplateDigest: string
  gitSafetyContractVersion: number
  deterministicVerifierContractVersion: number
  deterministicVerifierDigest: string
  rootLauncherContractVersion: number
  failureClassifierContractVersion: number
  failureClassifier: 'inconclusive_only'
}

export type VerificationGoalOperationBindingV1 = {
  operationId: string
  operationVersion: number
  definitionDigest: string
  capability: string
  adapter: string
  risk: string
  scope: string
  timeoutMs: number
  verification: string
  approvalRequired: boolean
  independentVerificationRequired: boolean
  eligibility: Exclude<VerificationGoalOperationEligibility, 'not_allowed'>
  executionProfile: VerificationGoalOperationExecutionProfileV1
  executionProfileDigest: string
}

const COMMAND_TEMPLATES = Object.freeze({
  'repository.status.read@1': ['git', 'status', '--short'],
  'repository.diff.summary@1': ['git', 'diff', '--no-ext-diff', '--no-textconv', '--stat', '--'],
  'repository.branch.read@1': ['git', 'branch', '--show-current'],
} as const)

/**
 * This allowlist is deliberately separate from the Operation Catalog. Adding an
 * Operation Catalog entry must not silently make repository configuration able
 * to schedule it as a verification goal.
 */
export const VERIFICATION_GOAL_OPERATION_ELIGIBILITY = Object.freeze({
  'repository.status.read@1': 'manual_and_scheduled',
  'repository.diff.summary@1': 'manual_and_scheduled',
  'repository.branch.read@1': 'manual_and_scheduled',
} as const satisfies Record<string, VerificationGoalOperationEligibility>)

function sha256(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`forge:verification-goal:${domain}:v1\0`, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex')
}

function operationKey(operationId: string, operationVersion: number): string {
  return `${operationId}@${operationVersion}`
}

function commandTemplateFor(key: string): readonly string[] {
  const template = (COMMAND_TEMPLATES as Readonly<Record<string, readonly string[]>>)[key]
  if (!template) throw new Error(`Verification goal operation ${key} has no reviewed command template.`)
  return template
}

function executionProfileFor(definition: OperationDefinition): VerificationGoalOperationExecutionProfileV1 {
  const key = operationKey(definition.id, definition.version)
  const commandTemplate = commandTemplateFor(key)
  return {
    schemaVersion: VERIFICATION_GOAL_EXECUTION_PROFILE_SCHEMA_VERSION,
    operationId: definition.id,
    operationVersion: definition.version,
    adapterContractVersion: 1,
    commandTemplateDigest: sha256('command-template', commandTemplate),
    gitSafetyContractVersion: VERIFICATION_GOAL_GIT_SAFETY_CONTRACT_VERSION,
    deterministicVerifierContractVersion: 1,
    deterministicVerifierDigest: sha256('deterministic-verifier', {
      adapter: definition.adapter,
      verification: definition.verification,
      contract: 'exit-zero-bounded-output-with-command-audit',
    }),
    rootLauncherContractVersion: VERIFICATION_GOAL_ROOT_LAUNCHER_CONTRACT_VERSION,
    failureClassifierContractVersion: 1,
    // The current three read operations can prove successful deterministic
    // reads, but their negative process/adapter outcomes are not yet safe to
    // classify as a project regression. The later functional verifier operation
    // gets a separately reviewed classifier before it can produce `failed`.
    failureClassifier: 'inconclusive_only',
  }
}

export function verificationGoalEligibilityPolicyDigest(): string {
  const entries = Object.entries(VERIFICATION_GOAL_OPERATION_ELIGIBILITY)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, eligibility]) => {
      const [operationId, versionText] = key.split('@')
      const operationVersion = Number(versionText)
      const definition = resolveOperationDefinition({ operationId, operationVersion }, OPERATION_CATALOG)
      const profile = executionProfileFor(definition)
      return {
        key,
        eligibility,
        executionProfileDigest: sha256('execution-profile', profile),
      }
    })
  return sha256('eligibility-policy', {
    version: VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION,
    entries,
  })
}

export function resolveVerificationGoalOperationBinding(input: {
  operationId: string
  operationVersion: number
  goalCapability: string
  trigger: VerificationGoalTriggerKind
  catalog?: ReadonlyMap<string, OperationDefinition>
}): VerificationGoalOperationBindingV1 {
  const catalog = input.catalog ?? OPERATION_CATALOG
  const definition = resolveOperationDefinition({
    operationId: input.operationId,
    operationVersion: input.operationVersion,
  }, catalog)
  const key = operationKey(definition.id, definition.version)
  const eligibility = (VERIFICATION_GOAL_OPERATION_ELIGIBILITY as Readonly<Record<string, VerificationGoalOperationEligibility>>)[key]
    ?? 'not_allowed'

  if (eligibility === 'not_allowed') {
    throw new Error(`Verification goal operation ${key} is not on the goal-execution allowlist.`)
  }
  if (input.trigger === 'scheduled' && eligibility !== 'manual_and_scheduled') {
    throw new Error(`Verification goal operation ${key} is not approved for scheduled execution.`)
  }
  if (!definition.enabled || definition.deprecated) {
    throw new Error(`Verification goal operation ${key} is disabled or deprecated.`)
  }
  if (definition.capability !== input.goalCapability) {
    throw new Error(`Verification goal operation ${key} does not match the goal capability.`)
  }
  if (
    definition.inputKeys.length !== 0
    || definition.scope !== 'trusted_project'
    || definition.risk !== 'read_only'
    || definition.verification !== 'deterministic_adapter'
    || definition.recovery !== 'none_read_only'
    || definition.approvalRequired
  ) {
    throw new Error(`Verification goal operation ${key} is outside the v1 bounded execution profile.`)
  }
  if (definition.independentVerificationRequired) {
    throw new Error(`Verification goal operation ${key} requires an independent verifier that is not available in #187.`)
  }

  const executionProfile = executionProfileFor(definition)
  return {
    operationId: definition.id,
    operationVersion: definition.version,
    definitionDigest: operationFingerprint('definition', definition),
    capability: definition.capability,
    adapter: definition.adapter,
    risk: definition.risk,
    scope: definition.scope,
    timeoutMs: definition.timeoutMs,
    verification: definition.verification,
    approvalRequired: definition.approvalRequired,
    independentVerificationRequired: definition.independentVerificationRequired,
    eligibility,
    executionProfile,
    executionProfileDigest: sha256('execution-profile', executionProfile),
  }
}

export function verificationGoalExecutionBindingDigest(bindings: readonly VerificationGoalOperationBindingV1[]): string {
  return sha256('execution-binding', {
    schemaVersion: 1,
    eligibilityPolicyVersion: VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION,
    eligibilityPolicyDigest: verificationGoalEligibilityPolicyDigest(),
    operations: bindings,
  })
}
