import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSession = vi.fn()
const mockGetAccessibleTask = vi.fn()
const mockGuardIngress = vi.fn()
const mockSelect = vi.fn()
const mockApplyLocal = vi.fn()
const mockApplyPacket = vi.fn()
const mockConverge = vi.fn()
const mockEnqueue = vi.fn()

class MockS4LifecycleError extends Error {
  constructor(readonly code: 'configuration' | 'conflict' | 'invalid_evidence', message: string) {
    super(message)
  }
}

function chain(value: unknown) {
  const result: Record<string, unknown> = {
    then: (resolve: (resolved: unknown) => unknown) => Promise.resolve(value).then(resolve),
  }
  for (const method of ['from', 'where', 'limit']) result[method] = () => result
  return result
}

vi.mock('@/lib/session', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/task-access', () => ({ getAccessibleTask: mockGetAccessibleTask }))
vi.mock('@/lib/projects/epic-172-project-ingress', () => ({
  guardEpic172ProjectManagementIngress: mockGuardIngress,
}))
vi.mock('@/db', () => ({ db: { select: mockSelect } }))
vi.mock('@/lib/mcps/s4-lease', () => ({
  applyLocalEffectRecoveryActionV2: mockApplyLocal,
  applyPacketIssuanceRecoveryActionV2: mockApplyPacket,
  S4LifecycleError: MockS4LifecycleError,
}))
vi.mock('@/lib/mcps/filesystem-grant-reconciliation', () => ({
  convergeRecognizedOperatorHoldTask: mockConverge,
}))
vi.mock('@/worker/blocked-handoff-retry', () => ({
  enqueueBlockedHandoffRetry: mockEnqueue,
}))

const taskId = '11111111-1111-4111-8111-111111111111'
const packageId = '22222222-2222-4222-8222-222222222222'
const evidenceId = '33333333-3333-4333-8333-333333333333'
const auditId = '44444444-4444-4444-8444-444444444444'
const fingerprint = `sha256:${'a'.repeat(64)}`

function localRequest(action: string, extra: Record<string, unknown> = {}) {
  return new Request(`http://localhost/api/tasks/${taskId}/work-packages/${packageId}/local-effect-recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, action, localRunEvidenceId: evidenceId, evidenceFingerprint: fingerprint, ...extra }),
  })
}

function packetRequest(action: string) {
  return new Request(`http://localhost/api/tasks/${taskId}/work-packages/${packageId}/packet-issuance-recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 2, action, priorRuntimeAuditId: auditId, markerFingerprint: fingerprint }),
  })
}

describe('protected S4 operator recovery routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: '55555555-5555-4555-8555-555555555555' })
    mockGetAccessibleTask.mockResolvedValue({ id: taskId, status: 'approved' })
    mockGuardIngress.mockResolvedValue(null)
    mockSelect.mockReturnValue(chain([{ id: packageId }]))
    mockConverge.mockResolvedValue(false)
    mockEnqueue.mockResolvedValue({ status: 'enqueued' })
    mockApplyLocal.mockResolvedValue({
      actionId: '66666666-6666-4666-8666-666666666666',
      result: 'recorded', resultMarkerFingerprint: null, packageStatus: 'blocked',
    })
    mockApplyPacket.mockResolvedValue({
      actionId: '77777777-7777-4777-8777-777777777777',
      result: 'recorded', resultMarkerFingerprint: null, packageStatus: 'blocked',
    })
  })

  for (const action of [
    'review_local_changes',
    'acknowledge_possible_local_invocation',
    'retry_local_execution',
    'decline_local_retry',
  ]) {
    it(`executes the exact local action ${action}`, async () => {
      const { POST } = await import('@/app/api/tasks/[id]/work-packages/[packageId]/local-effect-recovery/route')
      const response = await POST(localRequest(action) as never, {
        params: Promise.resolve({ id: taskId, packageId }),
      })
      expect(response.status).toBe(200)
      expect(mockApplyLocal).toHaveBeenCalledWith(expect.objectContaining({
        action, localRunEvidenceId: evidenceId, expectedMarkerFingerprint: fingerprint,
        taskId, workPackageId: packageId,
      }))
      expect(mockConverge).toHaveBeenCalledWith(taskId)
    })
  }

  for (const action of [
    'acknowledge_possible_submission',
    'retry_execution',
    'decline_packet_recovery',
  ]) {
    it(`executes the exact packet action ${action}`, async () => {
      const { POST } = await import('@/app/api/tasks/[id]/work-packages/[packageId]/packet-issuance-recovery/route')
      const response = await POST(packetRequest(action) as never, {
        params: Promise.resolve({ id: taskId, packageId }),
      })
      expect(response.status).toBe(200)
      expect(mockApplyPacket).toHaveBeenCalledWith(expect.objectContaining({
        action, priorRuntimeAuditId: auditId, expectedMarkerFingerprint: fingerprint,
        taskId, workPackageId: packageId,
      }))
      expect(mockConverge).toHaveBeenCalledWith(taskId)
    })
  }

  it('rejects non-exact payloads before the protected mutation', async () => {
    const { POST } = await import('@/app/api/tasks/[id]/work-packages/[packageId]/local-effect-recovery/route')
    const response = await POST(localRequest('review_local_changes', { unexpected: true }) as never, {
      params: Promise.resolve({ id: taskId, packageId }),
    })
    expect(response.status).toBe(400)
    expect(mockApplyLocal).not.toHaveBeenCalled()
  })

  it('does not reveal whether a package belongs to another task', async () => {
    mockSelect.mockReturnValue(chain([]))
    const { POST } = await import('@/app/api/tasks/[id]/work-packages/[packageId]/packet-issuance-recovery/route')
    const response = await POST(packetRequest('retry_execution') as never, {
      params: Promise.resolve({ id: taskId, packageId }),
    })
    expect(response.status).toBe(404)
    expect(mockApplyPacket).not.toHaveBeenCalled()
  })

  it('deduplicates the post-commit wake only when the package becomes ready', async () => {
    mockApplyLocal.mockResolvedValue({
      actionId: '66666666-6666-4666-8666-666666666666',
      result: 'retry_ready', resultMarkerFingerprint: null, packageStatus: 'ready',
    })
    mockEnqueue.mockResolvedValue({ status: 'already_queued' })
    const { POST } = await import('@/app/api/tasks/[id]/work-packages/[packageId]/local-effect-recovery/route')
    const response = await POST(localRequest('retry_local_execution') as never, {
      params: Promise.resolve({ id: taskId, packageId }),
    })
    await expect(response.json()).resolves.toMatchObject({ result: { continuationStatus: 'already_queued' } })
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it('reports a committed action as pending when the post-commit wake fails', async () => {
    mockApplyPacket.mockResolvedValue({
      actionId: '77777777-7777-4777-8777-777777777777',
      result: 'retry_ready', resultMarkerFingerprint: null, packageStatus: 'ready',
    })
    mockEnqueue.mockRejectedValue(new Error('redis unavailable'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { POST } = await import('@/app/api/tasks/[id]/work-packages/[packageId]/packet-issuance-recovery/route')
    const response = await POST(packetRequest('retry_execution') as never, {
      params: Promise.resolve({ id: taskId, packageId }),
    })
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ result: { continuationStatus: 'pending' } })
    consoleError.mockRestore()
  })

  it('normalizes protected state conflicts', async () => {
    mockApplyLocal.mockRejectedValue(new MockS4LifecycleError('conflict', 'secret detail'))
    const { POST } = await import('@/app/api/tasks/[id]/work-packages/[packageId]/local-effect-recovery/route')
    const response = await POST(localRequest('review_local_changes') as never, {
      params: Promise.resolve({ id: taskId, packageId }),
    })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Recovery state changed. Reload and retry.' })
  })
})
