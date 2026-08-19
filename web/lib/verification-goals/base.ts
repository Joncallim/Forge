export const VERIFICATION_GOAL_SEVERITIES = [
  'low',
  'medium',
  'high',
  'critical',
] as const

export const MAX_VERIFICATION_GOAL_ID_LENGTH = 64
export const MAX_VERIFICATION_GOAL_DEFINITION_VERSION = 1_000_000
export const MAX_VERIFICATION_GOAL_TITLE_LENGTH = 160
export const MAX_VERIFICATION_GOAL_DESCRIPTION_LENGTH = 2_000
export const MAX_VERIFICATION_GOAL_CAPABILITY_LENGTH = 200
export const MAX_VERIFICATION_GOAL_OPERATIONS = 16

export type VerificationGoalSeverity = typeof VERIFICATION_GOAL_SEVERITIES[number]

export type VerificationGoalOperationReference = {
  operationId: string
  operationVersion: number
}

/** Locale-independent ordering for canonical identities. */
export function compareVerificationGoalStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
