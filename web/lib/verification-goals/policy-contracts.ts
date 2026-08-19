/**
 * Project-level verification execution policy contracts (issue #187 section 11).
 *
 * These constants and types are intentionally pure: they describe the protocol
 * boundary and default-disabled policy shape without importing any runtime DB
 * write path.
 */

export const VERIFICATION_GOAL_POLICY_VERSION = 1 as const

export const VERIFICATION_GOAL_POLICY_ACTOR_KINDS = [
  'migration_seed',
  'system_default',
  'human',
] as const

export type VerificationGoalPolicyActorKind =
  typeof VERIFICATION_GOAL_POLICY_ACTOR_KINDS[number]

/**
 * Default policy for every project. Manual and scheduled proof execution are
 * disabled by default; capacities and deadlines are conservative ceilings.
 */
export const DEFAULT_VERIFICATION_GOAL_POLICY = {
  manualEnabled: false,
  schedulingEnabled: false,
  minScheduleIntervalSeconds: 3600,
  maxRunDeadlineSeconds: 600,
  maxQueueAgeSeconds: 300,
  maxOperationsPerRun: 16,
  maxConcurrentRuns: 2,
  maxQueuedRuns: 8,
  maxActiveRuns: 10,
  startBudgetWindowSeconds: 3600,
  maxStartsPerWindow: 20,
} as const

export type VerificationGoalPolicyRevisionV1 = {
  schemaVersion: typeof VERIFICATION_GOAL_POLICY_VERSION
  projectId: string
  revisionSequence: bigint
  policyDigest: string
  manualEnabled: boolean
  schedulingEnabled: boolean
  minScheduleIntervalSeconds: bigint
  maxRunDeadlineSeconds: bigint
  maxQueueAgeSeconds: bigint
  maxOperationsPerRun: number
  maxConcurrentRuns: number
  maxQueuedRuns: number
  maxActiveRuns: number
  startBudgetWindowSeconds: bigint
  maxStartsPerWindow: bigint
  actorKind: VerificationGoalPolicyActorKind
  actorUserId: string | null
  predecessorRevisionId: string | null
}

export type VerificationGoalPolicyRevision = VerificationGoalPolicyRevisionV1

export class VerificationGoalPolicyContractError extends Error {
  readonly code: 'invalid_policy'

  constructor(message: string) {
    super(message)
    this.name = 'VerificationGoalPolicyContractError'
    this.code = 'invalid_policy'
  }
}

function invalid(message: string): never {
  throw new VerificationGoalPolicyContractError(message)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isPositiveBigint(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > BigInt(0)
}

/**
 * Validates the bounded policy revision shape. This is the TypeScript-side
 * mirror of the CHECK constraints on verification_goal_policy_revisions; the
 * database constraints remain authoritative.
 */
export function validateVerificationGoalPolicyRevision(
  revision: VerificationGoalPolicyRevision,
): void {
  if (revision.schemaVersion !== VERIFICATION_GOAL_POLICY_VERSION) {
    invalid('Policy schemaVersion must be 1.')
  }
  if (revision.revisionSequence <= BigInt(0)) {
    invalid('Policy revisionSequence must be positive.')
  }
  if (!/^[0-9a-f]{64}$/.test(revision.policyDigest)) {
    invalid('Policy digest must be a 64-character hex SHA-256.')
  }
  if (!VERIFICATION_GOAL_POLICY_ACTOR_KINDS.includes(revision.actorKind)) {
    invalid('Policy actorKind must be migration_seed, system_default, or human.')
  }
  if (
    (revision.actorKind === 'human' && revision.actorUserId === null)
    || (revision.actorKind !== 'human' && revision.actorUserId !== null)
  ) {
    invalid('Policy actorUserId shape must match actorKind.')
  }
  const bigintFields: Array<keyof VerificationGoalPolicyRevisionV1> = [
    'minScheduleIntervalSeconds',
    'maxRunDeadlineSeconds',
    'maxQueueAgeSeconds',
    'startBudgetWindowSeconds',
    'maxStartsPerWindow',
  ]
  for (const field of bigintFields) {
    const value = revision[field]
    if (!isPositiveBigint(value)) {
      invalid(`Policy ${field} must be a positive bigint.`)
    }
  }
  const intFields: Array<keyof VerificationGoalPolicyRevisionV1> = [
    'maxOperationsPerRun',
    'maxConcurrentRuns',
    'maxQueuedRuns',
    'maxActiveRuns',
  ]
  for (const field of intFields) {
    const value = revision[field]
    if (!isPositiveSafeInteger(value)) {
      invalid(`Policy ${field} must be a positive integer.`)
    }
  }
}
