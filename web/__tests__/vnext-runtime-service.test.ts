import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
const { getAccessibleTask } = vi.hoisted(() => ({ getAccessibleTask: vi.fn() }))
vi.mock('@/lib/session', () => ({ getSession }))
vi.mock('@/lib/task-access', () => ({ getAccessibleTask }))

import {
  createMissionForAuthorizedSession,
  createTaskMissionForAuthorizedSession,
  readMissionForAuthorizedSession,
  RuntimeAuthorizationError,
  transitionExecutionForAuthorizedSession,
  type RuntimeStore,
} from '@/lib/runtime/v1/server-service'

const digest = 'a'.repeat(64)
const request = new Request('https://forge.test') as never

describe('VNext runtime server service', () => {
  const store: RuntimeStore = {
  createForUser: vi.fn(async ({ missionId, executionId }) => ({ missionId, executionId })),
  readMissionForUser: vi.fn(async () => null),
  transitionMissionForUser: vi.fn(async () => {}),
  transitionForUser: vi.fn(async () => {}),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ sessionId: 'session', userId: '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f' })
    getAccessibleTask.mockResolvedValue({ submittedBy: '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f' })
  })

  it('rejects forged owner input and derives the owner from the authorized session', async () => {
    await expect(createMissionForAuthorizedSession(request, {
      version: 'v1', desiredOutcomeDigest: digest, constraintsDigest: digest, resourceBindings: [],
      compatibilityPins: { version: 'v1', workflowRevision: 'zero', policyRevision: 'zero', budgetEnvelopeRevision: 'zero', compatibilityMode: 'software_engineering_legacy_v1' },
      ownerUserId: '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f',
    }, store)).rejects.toThrow()
    await createMissionForAuthorizedSession(request, {
      version: 'v1', desiredOutcomeDigest: digest, constraintsDigest: digest, resourceBindings: [],
      compatibilityPins: { version: 'v1', workflowRevision: 'zero', policyRevision: 'zero', budgetEnvelopeRevision: 'zero', compatibilityMode: 'software_engineering_legacy_v1' },
    }, store)
    expect(store.createForUser).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f',
    }))
  })

  it('passes the authenticated user to reads and transitions, never a client actor', async () => {
    await readMissionForAuthorizedSession(request, '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f', store)
    await expect(transitionExecutionForAuthorizedSession(request, '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f', {
      expectedRevision: '0', lifecycle: 'admitted', outcome: null, blockerReasonCode: null,
      reasonCode: 'execution.admitted', evidenceDigest: null, actorUserId: 'forged',
    }, store)).rejects.toThrow()
    expect(store.readMissionForUser).toHaveBeenCalledWith(expect.any(String), '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f')
  })

  it('does not let a second session read or transition the first user’s Mission', async () => {
    const owner = '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f'
    const other = '018f2a70-9d7b-7cc2-8c74-9ab3a301cf30'
    const isolatedStore: RuntimeStore = {
      createForUser: vi.fn(),
      readMissionForUser: vi.fn(async (_missionId, userId) => userId === owner ? { id: 'mission' } : null),
      transitionMissionForUser: vi.fn(async (_missionId, userId) => {
        if (userId !== owner) throw new Error('owner authorization failed')
      }),
      transitionForUser: vi.fn(async (_executionId, userId) => {
        if (userId !== owner) throw new Error('owner authorization failed')
      }),
    }
    getSession.mockResolvedValue({ sessionId: 'other-session', userId: other })
    expect(await readMissionForAuthorizedSession(request, '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f', isolatedStore)).toBeNull()
    await expect(transitionExecutionForAuthorizedSession(request, '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f', {
      expectedRevision: '0', lifecycle: 'admitted', outcome: null, blockerReasonCode: null,
      reasonCode: 'execution.admitted', evidenceDigest: null,
    }, isolatedStore)).rejects.toThrow('owner authorization failed')
  })

  it('derives Task compatibility ownership from the existing Task authority', async () => {
    getAccessibleTask.mockResolvedValue({ submittedBy: '018f2a70-9d7b-7cc2-8c74-9ab3a301cf30' })
    await expect(createTaskMissionForAuthorizedSession(request, '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f', {
      version: 'v1', desiredOutcomeDigest: digest, constraintsDigest: digest, resourceBindings: [],
      compatibilityPins: { version: 'v1', workflowRevision: 'zero', policyRevision: 'zero', budgetEnvelopeRevision: 'zero', compatibilityMode: 'software_engineering_legacy_v1' },
    }, store)).rejects.toThrow('Runtime compatibility task not found')
  })

  it('rejects calls without an authorized session', async () => {
    getSession.mockResolvedValue(null)
    await expect(readMissionForAuthorizedSession(request, '018f2a70-9d7b-7cc2-8c74-9ab3a301cf2f', store)).rejects.toBeInstanceOf(RuntimeAuthorizationError)
  })
})
