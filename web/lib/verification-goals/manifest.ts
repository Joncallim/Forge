import { createHash } from 'node:crypto'

import {
  compareVerificationGoalStrings,
} from '@/lib/verification-goals/contracts'
import {
  buildVerificationGoalExecutionBindingV1,
} from '@/lib/verification-goals/executable-contracts'
import type { LoadedVerificationGoal } from '@/lib/verification-goals/registry'

export const VERIFICATION_GOAL_REGISTRY_MANIFEST_DOMAIN =
  'forge:verification-goal:registry-manifest:v1\0' as const
export const VERIFICATION_GOAL_REGISTRY_MANIFEST_V2_DOMAIN =
  'forge:verification-goal:registry-manifest:v2\0' as const

export type VerificationGoalRegistryManifestEntryV1 = Readonly<{
  goalId: string
  definitionVersion: number
  definitionDigest: string
  sourcePath: string
}>

export type VerificationGoalRegistryManifestEntryV2 = VerificationGoalRegistryManifestEntryV1 & Readonly<{
  entrySchemaVersion: 1 | 2
  executionBindingDigest: string | null
}>

export type VerificationGoalRegistryManifestV1 = Readonly<{
  entries: readonly VerificationGoalRegistryManifestEntryV1[]
  digest: string
}>

export type VerificationGoalRegistryManifestV2 = Readonly<{
  schemaVersion: 2
  entries: readonly VerificationGoalRegistryManifestEntryV2[]
  digest: string
}>

export type VerificationGoalRegistryManifest = VerificationGoalRegistryManifestV1 | VerificationGoalRegistryManifestV2
export type VerificationGoalRegistryManifestEntry = VerificationGoalRegistryManifestEntryV1 | VerificationGoalRegistryManifestEntryV2

function compareManifestEntries(
  left: VerificationGoalRegistryManifestEntryV1,
  right: VerificationGoalRegistryManifestEntryV1,
): number {
  return compareVerificationGoalStrings(left.goalId, right.goalId)
    || left.definitionVersion - right.definitionVersion
    || compareVerificationGoalStrings(left.definitionDigest, right.definitionDigest)
    || compareVerificationGoalStrings(left.sourcePath, right.sourcePath)
}

function lengthPrefixedScalar(value: string): Buffer {
  const scalar = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from(`${scalar.byteLength}:`, 'ascii'), scalar])
}

/** Existing all-v1 registries keep their exact v1 manifest bytes and digest. */
export function verificationGoalRegistryManifestV1Payload(
  entries: readonly VerificationGoalRegistryManifestEntryV1[],
): Buffer {
  return Buffer.concat([
    Buffer.from(VERIFICATION_GOAL_REGISTRY_MANIFEST_DOMAIN, 'utf8'),
    lengthPrefixedScalar(String(entries.length)),
    ...entries.flatMap((entry) => [
      lengthPrefixedScalar(entry.goalId),
      lengthPrefixedScalar(String(entry.definitionVersion)),
      lengthPrefixedScalar(entry.definitionDigest),
      lengthPrefixedScalar(entry.sourcePath),
    ]),
  ])
}

export function verificationGoalRegistryManifestV2Payload(
  entries: readonly VerificationGoalRegistryManifestEntryV2[],
): Buffer {
  return Buffer.concat([
    Buffer.from(VERIFICATION_GOAL_REGISTRY_MANIFEST_V2_DOMAIN, 'utf8'),
    lengthPrefixedScalar(String(entries.length)),
    ...entries.flatMap((entry) => [
      lengthPrefixedScalar(entry.goalId),
      lengthPrefixedScalar(String(entry.definitionVersion)),
      lengthPrefixedScalar(entry.definitionDigest),
      lengthPrefixedScalar(entry.sourcePath),
      lengthPrefixedScalar(String(entry.entrySchemaVersion)),
      lengthPrefixedScalar(entry.executionBindingDigest ?? ''),
    ]),
  ])
}

/** Backward-compatible alias for callers/tests that inspect the v1 payload. */
export function verificationGoalRegistryManifestPayload(
  entries: readonly VerificationGoalRegistryManifestEntryV1[],
): Buffer {
  return verificationGoalRegistryManifestV1Payload(entries)
}

export function verificationGoalRegistryManifest(
  goals: readonly LoadedVerificationGoal[],
): VerificationGoalRegistryManifest {
  const orderedGoals = [...goals].sort((left, right) => compareManifestEntries(
    {
      goalId: left.definition.goalId,
      definitionVersion: left.definition.definitionVersion,
      definitionDigest: left.definitionDigest,
      sourcePath: left.sourcePath,
    },
    {
      goalId: right.definition.goalId,
      definitionVersion: right.definition.definitionVersion,
      definitionDigest: right.definitionDigest,
      sourcePath: right.sourcePath,
    },
  ))
  const hasExecutableDefinition = orderedGoals.some((goal) => goal.definition.schemaVersion === 2)

  if (!hasExecutableDefinition) {
    const entries: VerificationGoalRegistryManifestEntryV1[] = orderedGoals.map((goal) => ({
      goalId: goal.definition.goalId,
      definitionVersion: goal.definition.definitionVersion,
      definitionDigest: goal.definitionDigest,
      sourcePath: goal.sourcePath,
    }))
    return {
      entries,
      digest: createHash('sha256')
        .update(verificationGoalRegistryManifestV1Payload(entries))
        .digest('hex'),
    }
  }

  const entries: VerificationGoalRegistryManifestEntryV2[] = orderedGoals.map((goal) => ({
    goalId: goal.definition.goalId,
    definitionVersion: goal.definition.definitionVersion,
    definitionDigest: goal.definitionDigest,
    sourcePath: goal.sourcePath,
    entrySchemaVersion: goal.definition.schemaVersion,
    executionBindingDigest: goal.definition.schemaVersion === 2
      ? buildVerificationGoalExecutionBindingV1(goal.definition).executionBindingDigest
      : null,
  }))
  return {
    schemaVersion: 2,
    entries,
    digest: createHash('sha256')
      .update(verificationGoalRegistryManifestV2Payload(entries))
      .digest('hex'),
  }
}
