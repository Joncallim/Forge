import { describe, expect, it } from 'vitest'

import { verificationGoalRegistryManifest } from '@/lib/verification-goals/manifest'
import type { LoadedVerificationGoal } from '@/lib/verification-goals/registry'

function loadedGoal(
  goalId: string,
  sourcePath: string,
  definitionDigest: string,
  definitionVersion = 1,
): LoadedVerificationGoal {
  return {
    definition: {
      schemaVersion: 1,
      goalId,
      definitionVersion,
      title: `${goalId} title`,
      description: `${goalId} description`,
      capability: 'filesystem.project.read',
      severity: 'high',
      enabled: true,
      operations: [{ operationId: 'repository.status.read', operationVersion: 1 }],
    },
    definitionDigest,
    sourcePath,
  }
}

describe('verification goal registry manifest', () => {
  it('sorts exact membership before computing an order-independent digest', () => {
    const alpha = loadedGoal(
      'alpha-goal',
      '.forge/verification-goals/alpha.json',
      'a'.repeat(64),
    )
    const zeta = loadedGoal(
      'zeta-goal',
      '.forge/verification-goals/zeta.json',
      'f'.repeat(64),
      2,
    )

    const forward = verificationGoalRegistryManifest([alpha, zeta])
    const reverse = verificationGoalRegistryManifest([zeta, alpha])

    expect(reverse).toEqual(forward)
    expect(forward.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(forward.entries).toEqual([
      {
        goalId: 'alpha-goal',
        definitionVersion: 1,
        definitionDigest: 'a'.repeat(64),
        sourcePath: '.forge/verification-goals/alpha.json',
      },
      {
        goalId: 'zeta-goal',
        definitionVersion: 2,
        definitionDigest: 'f'.repeat(64),
        sourcePath: '.forge/verification-goals/zeta.json',
      },
    ])
    expect(JSON.stringify(forward)).not.toContain('snapshotId')
    expect(JSON.stringify(forward)).not.toContain('/private/')
  })

  it('has a fixed domain-separated digest for the empty registry', () => {
    expect(verificationGoalRegistryManifest([])).toEqual({
      entries: [],
      digest: '20a76e4e51a860e4488c0115fbc42c3e15b580d7e16189ab59bbf2b1bd5820e6',
    })
  })

  it('changes identity when the same definition moves to another source path', () => {
    const digest = 'a'.repeat(64)
    const before = verificationGoalRegistryManifest([
      loadedGoal('moved-goal', '.forge/verification-goals/before.json', digest),
    ])
    const after = verificationGoalRegistryManifest([
      loadedGoal('moved-goal', '.forge/verification-goals/after.json', digest),
    ])

    expect(after.digest).not.toBe(before.digest)
  })
})
