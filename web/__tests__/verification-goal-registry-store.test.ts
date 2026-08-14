import { describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { verificationGoalRegistryManifest } from '@/lib/verification-goals/manifest'
import {
  createDatabaseVerificationGoalRegistryStore,
  type VerificationGoalRegistryAuthority,
} from '@/worker/verification-goals/registry-store'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROOT_REF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REVISION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EMPTY_MANIFEST = verificationGoalRegistryManifest([])

function authority(): VerificationGoalRegistryAuthority {
  return {
    projectId: PROJECT_ID,
    applicationAssertedActorUserId: ACTOR_ID,
    submittedBy: ACTOR_ID,
    archivedAt: null,
    localPath: '/workspace/projects/example',
    rootRef: ROOT_REF,
    rootBindingRevision: BigInt(7),
    grantDecisionRevision: BigInt(9),
    projectRevision: '2026-08-15T00:00:00.000000Z',
    priorHeadRevisionId: null,
  }
}

function fakeDatabase(routineResult: unknown) {
  const execute = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async () => {
      if (routineResult instanceof Error) throw routineResult
      return routineResult
    })
  const tx = { execute }
  const database = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  } as unknown as typeof db
  return { database, tx }
}

function sqlStateError(code: string) {
  return Object.assign(new Error('untrusted PostgreSQL detail'), { code })
}

describe('verification goal authoritative registry store', () => {
  it('uses the protected commit routine and returns its stable head result', async () => {
    const { database, tx } = fakeDatabase([{
      registryRevisionId: REVISION_ID,
      revisionSequence: BigInt(1),
      headState: 'advanced',
    }])
    const store = createDatabaseVerificationGoalRegistryStore(database)

    await expect(store.commitRegistry({
      authority: authority(),
      goals: [],
      manifest: EMPTY_MANIFEST,
    })).resolves.toEqual({
      registryRevisionId: REVISION_ID,
      manifestDigest: EMPTY_MANIFEST.digest,
      headState: 'advanced',
      snapshots: [],
    })
    expect(tx.execute).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['P1871', 'project_authority_changed'],
    ['P1872', 'registry_head_changed'],
  ] as const)('maps SQLSTATE %s to the stable typed import code %s', async (state, code) => {
    const { database } = fakeDatabase(sqlStateError(state))
    const store = createDatabaseVerificationGoalRegistryStore(database)

    await expect(store.commitRegistry({
      authority: authority(),
      goals: [],
      manifest: EMPTY_MANIFEST,
    })).rejects.toMatchObject({ code })
  })

  it('maps the SQLSTATE exposed through the database wrapper cause', async () => {
    const wrapped = Object.assign(new Error('database wrapper'), {
      cause: sqlStateError('P1872'),
    })
    const { database } = fakeDatabase(wrapped)
    const store = createDatabaseVerificationGoalRegistryStore(database)

    await expect(store.commitRegistry({
      authority: authority(),
      goals: [],
      manifest: EMPTY_MANIFEST,
    })).rejects.toMatchObject({ code: 'registry_head_changed' })
  })

  it.each(['22023', 'P1873', '42501', 'XX000'])
    ('does not disguise SQLSTATE %s as an authority or head race', async (state) => {
      const failure = sqlStateError(state)
      const { database } = fakeDatabase(failure)
      const store = createDatabaseVerificationGoalRegistryStore(database)

      await expect(store.commitRegistry({
        authority: authority(),
        goals: [],
        manifest: EMPTY_MANIFEST,
      })).rejects.toBe(failure)
    })
})
