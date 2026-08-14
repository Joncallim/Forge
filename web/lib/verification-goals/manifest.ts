import { createHash } from 'node:crypto'

import {
  compareVerificationGoalStrings,
} from '@/lib/verification-goals/contracts'
import type { LoadedVerificationGoal } from '@/lib/verification-goals/registry'

export const VERIFICATION_GOAL_REGISTRY_MANIFEST_DOMAIN =
  'forge:verification-goal:registry-manifest:v1\0' as const

export type VerificationGoalRegistryManifestEntry = Readonly<{
  goalId: string
  definitionVersion: number
  definitionDigest: string
  sourcePath: string
}>

export type VerificationGoalRegistryManifest = Readonly<{
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

export function verificationGoalRegistryManifestPayload(
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

export function verificationGoalRegistryManifest(
  goals: readonly LoadedVerificationGoal[],
): VerificationGoalRegistryManifest {
  const entries = goals.map((goal) => ({
    goalId: goal.definition.goalId,
    definitionVersion: goal.definition.definitionVersion,
    definitionDigest: goal.definitionDigest,
    sourcePath: goal.sourcePath,
  })).sort(compareManifestEntries)

  return {
    entries,
    digest: createHash('sha256')
      .update(verificationGoalRegistryManifestPayload(entries))
      .digest('hex'),
  }
}
