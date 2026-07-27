import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({ default: {} }))

const postgresFactory = vi.fn()
vi.mock('postgres', () => ({ default: (...args: unknown[]) => postgresFactory(...args) }))

const ENV_NAME = 'FORGE_LOCAL_RUN_EVIDENCE_READER_DATABASE_URL'
const original = process.env[ENV_NAME]

function mockClient(behaviour: () => Promise<unknown>) {
  const client = Object.assign(behaviour, { end: vi.fn().mockResolvedValue(undefined) })
  postgresFactory.mockReturnValue(client)
  return client
}

describe('S5 protected local run evidence reader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = original
    vi.restoreAllMocks()
  })

  it('never opens the ordinary application connection', async () => {
    delete process.env[ENV_NAME]
    const { readS5ProtectedLocalRunEvidence, s5LocalEvidenceReaderConfigured } =
      await import('@/lib/mcps/s5-protected-reader')
    expect(s5LocalEvidenceReaderConfigured()).toBe(false)
    await expect(readS5ProtectedLocalRunEvidence('task-1')).resolves.toBeNull()
    expect(postgresFactory).not.toHaveBeenCalled()
  })

  it('fails closed rather than throwing when the fixed principal is denied', async () => {
    process.env[ENV_NAME] = 'postgres://reader@localhost/forge'
    const client = mockClient(() => Promise.reject(Object.assign(new Error('permission denied'), { code: '42501' })))
    const { readS5ProtectedLocalRunEvidence } = await import('@/lib/mcps/s5-protected-reader')
    await expect(readS5ProtectedLocalRunEvidence('task-1')).resolves.toBeNull()
    expect(client.end).toHaveBeenCalled()
  })

  it('returns only safe presentation columns and closes the connection', async () => {
    process.env[ENV_NAME] = 'postgres://reader@localhost/forge'
    const leaseExpiresAt = new Date('2026-07-18T00:00:00.000Z')
    const client = mockClient(() => Promise.resolve([{
      id: 'evidence-1',
      workPackageId: 'package-1',
      agentRunId: 'run-1',
      state: 'terminal',
      leaseExpiresAt,
      terminalAt: null,
      // A column the query does not request; the mapper must drop it even if a
      // future schema change starts returning it.
      claimToken: 'ownership-token',
    }]))
    const { readS5ProtectedLocalRunEvidence } = await import('@/lib/mcps/s5-protected-reader')
    const rows = await readS5ProtectedLocalRunEvidence('task-1')
    expect(rows).toEqual([{
      id: 'evidence-1',
      workPackageId: 'package-1',
      agentRunId: 'run-1',
      state: 'terminal',
      leaseExpiresAt,
      terminalAt: null,
    }])
    expect(JSON.stringify(rows)).not.toContain('ownership-token')
    expect(client.end).toHaveBeenCalled()
  })
})
