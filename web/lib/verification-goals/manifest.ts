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

export type VerificationGoalRegistryManifestEntry = Readonly<{
  goalId: string
  definitionVersion: number
  definitionDigest: string
  sourcePath: string
  entrySchemaVersion: 1 | 2
  executionBindingDigest: string | null
}>

export type VerificationGoalRegistryManifest = Readonly<{
  schemaVersion: 1 | 2
  entries: readonly VerificationGoalRegistryManifestEntry[]
  digest: string
}>

function compareManifestEntries(
  left: VerificationGoalRegistryManifestEntry,
  right: VerificationGoalRegistryManifestEntry,
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
  entries: readonly VerificationGoalRegistryManifestEntry[],
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
  entries: readonly VerificationGoalRegistryManifestEntry[],
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
  entries: readonly VerificationGoalRegistryManifestEntry[],
): Buffer {
  return verificationGoalRegistryManifestV1Payload(entries)
}

export function verificationGoalRegistryManifest(
  goals: readonly LoadedVerificationGoal[],
): VerificationGoalRegistryManifest {
  const entries = goals.map((goal) => {
    const executionBindingDigest = goal.definition.schemaVersion === 2
      ? buildVerificationGoalExecutionBindingV1(goal.definition).executionBindingDigest
      : null
    return {
      goalId: goal.definition.goalId,
      definitionVersion: goal.definition.definitionVersion,
      definitionDigest: goal.definitionDigest,
      sourcePath: goal.sourcePath,
      entrySchemaVersion: goal.definition.schemaVersion,
      executionBindingDigest,
    }
  }).sort(compareManifestEntries)
  const schemaVersion: 1 | 2 = entries.some((entry) => entry.entrySchemaVersion === 2) ? 2 : 1
  const payload = schemaVersion === 1
    ? verificationGoalRegistryManifestV1Payload(entries)
    : verificationGoalRegistryManifestV2Payload(entries)

  return {
    schemaVersion,
    entries,
    digest: createHash('sha256')
      .update(payload)
      .digest('hex'),
  }
}
