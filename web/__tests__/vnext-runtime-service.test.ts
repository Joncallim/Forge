import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readSessionCredential } = vi.hoisted(() => ({ readSessionCredential: vi.fn() }))
vi.mock('@/lib/session', () => ({ readSessionCredential }))

import {
  createMissionForAuthorizedSession,
  createTaskMissionForAuthorizedSession,
  readMissionForAuthorizedSession,
  RuntimeAuthorizationError,
  transitionExecutionForAuthorizedSession,
  type RuntimeStore,
} from '@/lib/runtime/v1/server-service'

const digest = 'a'.repeat(64)
const credential = '018f2a70-9d7b-4cc2-8c74-9ab3a301cf2f'
const request = new Request('https://forge.test') as never

describe('VNext runtime server service', () => {
  const store: RuntimeStore = {
    createGeneric: vi.fn(async ({ missionId, executionId }) => ({ missionId, executionId })),
    createTask: vi.fn(async ({ missionId, executionId }) => ({ missionId, executionId })),
    readMission: vi.fn(async () => null),
    transitionMission: vi.fn(async () => {}),
    transitionExecution: vi.fn(async () => {}),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    readSessionCredential.mockReturnValue(credential)
  })

  it('rejects every caller-supplied authority field', async () => {
    await expect(createMissionForAuthorizedSession(request, {
      version: 'v1', desiredOutcomeDigest: digest, constraintsDigest: digest,
      ownerUserId: '018f2a70-9d7b-4cc2-8c74-9ab3a301cf2f', resourceBindings: [],
      compatibilityPins: { version: 'v1' }, workflowRevision: 'rev:v1:forged',
    }, store)).rejects.toThrow()
    expect(store.createGeneric).not.toHaveBeenCalled()
  })

  it('passes the opaque cookie credential, then clears the prepared buffer', async () => {
    let captured: Buffer | undefined
    const observingStore: RuntimeStore = { ...store, createGeneric: vi.fn(async (input) => {
      const liveCredential = input.sessionCredential
      captured = liveCredential
      expect(liveCredential.toString('ascii')).toBe(credential)
      return { missionId: input.missionId, executionId: input.executionId }
    }) }
    await createMissionForAuthorizedSession(request, { version: 'v1', desiredOutcomeDigest: digest, constraintsDigest: digest }, observingStore)
    expect(captured).toBeDefined()
    expect(captured?.every((value) => value === 0)).toBe(true)
  })

  it('uses the same credential-only boundary for read, transitions, and Task creation', async () => {
    await readMissionForAuthorizedSession(request, '018f2a70-9d7b-4cc2-8c74-9ab3a301cf2f', store)
    await transitionExecutionForAuthorizedSession(request, '018f2a70-9d7b-4cc2-8c74-9ab3a301cf2f', {
      expectedRevision: '0', lifecycle: 'admitted', outcome: null, blockerReasonCode: null,
      reasonCode: 'execution.admitted', evidenceDigest: null,
    }, store)
    await createTaskMissionForAuthorizedSession(request, '018f2a70-9d7b-4cc2-8c74-9ab3a301cf2f', { version: 'v1', desiredOutcomeDigest: digest, constraintsDigest: digest }, store)
    expect(store.readMission).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer))
    expect(store.transitionExecution).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), expect.any(Object))
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.any(String), sessionCredential: expect.any(Buffer) }))
  })

  it('rejects calls without a canonical session cookie before invoking SQL', async () => {
    readSessionCredential.mockReturnValue(null)
    await expect(readMissionForAuthorizedSession(request, '018f2a70-9d7b-4cc2-8c74-9ab3a301cf2f', store)).rejects.toBeInstanceOf(RuntimeAuthorizationError)
    expect(store.readMission).not.toHaveBeenCalled()
  })
})
