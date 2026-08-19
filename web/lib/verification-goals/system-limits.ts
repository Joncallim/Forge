/**
 * Code-owned system limits for verification goal execution (issue #187 section 12).
 *
 * These are protocol/security invariants, not operator tunables. Project policy
 * may be stricter; it may never exceed these ceilings.
 */

export const VERIFICATION_GOAL_SYSTEM_LIMITS_V1 = {
  businessLeaseMs: 30_000,
  leaseRenewTargetMs: 10_000,
  leaseLocalSafetyMarginMs: 5_000,
  recoveryQuiescenceGraceMs: 5_000,
  maxOperationsPerRun: 16,
  maxRunDeadlineSeconds: 600,
  minRunDeadlineSeconds: 10,
  maxQueueAgeSeconds: 300,
  minScheduleIntervalSeconds: 60,
} as const

export const VERIFICATION_GOAL_RUNNER_CONTRACT_VERSION = 1 as const
