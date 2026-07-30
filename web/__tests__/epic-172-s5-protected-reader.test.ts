import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({ default: {} }))

const postgresFactory = vi.fn()
vi.mock('postgres', () => ({ default: (...args: unknown[]) => postgresFactory(...args) }))

const ENV_NAME = 'FORGE_LOCAL_RUN_EVIDENCE_READER_DATABASE_URL'
const original = process.env[ENV_NAME]

function mockClient(behaviour: () => Promise<unknown>) {
  const client = Object.assign(vi.fn(behaviour), {
    begin: vi.fn(async (_options: unknown, run: (tx: unknown) => Promise<unknown>) => run(client)),
    unsafe: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  })
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
    process.env[ENV_NAME] = 'postgres://forge_local_evidence_reader@localhost/forge'
    const client = mockClient(() => Promise.reject(Object.assign(new Error('permission denied'), { code: '42501' })))
    const { readS5ProtectedLocalRunEvidence } = await import('@/lib/mcps/s5-protected-reader')
    await expect(readS5ProtectedLocalRunEvidence('task-1')).resolves.toBeNull()
    expect(client.end).toHaveBeenCalled()
  })

  it('returns only safe presentation columns and closes the connection', async () => {
    process.env[ENV_NAME] = 'postgres://forge_local_evidence_reader@localhost/forge'
    const leaseExpiresAt = new Date('2026-07-18T00:00:00.000Z')
    const client = mockClient(() => Promise.resolve([{
      evidenceRows: [{
        id: 'evidence-1',
        workPackageId: 'package-1',
        agentRunId: 'run-1',
        state: 'terminal',
        leaseExpiresAt,
        terminalAt: null,
        // A column the query does not request; the mapper must drop it even if a
        // future schema change starts returning it.
        claimToken: 'ownership-token',
      }],
      auditRows: [],
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

  it('reads terminal audits and their evidence from one fixed-principal statement', async () => {
    process.env[ENV_NAME] = 'postgres://forge_local_evidence_reader@localhost/forge'
    const terminalAt = new Date('2026-07-18T00:00:00.000Z')
    const client = mockClient(() => Promise.resolve([{
      evidenceRows: [{
        id: 'evidence-1',
        workPackageId: 'package-1',
        agentRunId: 'run-1',
        state: 'terminal',
        leaseExpiresAt: terminalAt,
        terminalAt,
      }],
      auditRows: [{
        id: 'audit-1',
        workPackageId: 'package-1',
        agentRunId: 'run-1',
        localRunEvidenceId: 'evidence-1',
        assembly: { state: 'assembled' },
        delivery: { state: 'submitted', submittedAt: terminalAt.toISOString() },
        terminal: { status: 'succeeded' },
        terminalAt,
        updatedAt: terminalAt,
        claimToken: 'audit-ownership-token',
      }],
    }]))
    const { readS5ProtectedTerminalSnapshot } = await import('@/lib/mcps/s5-protected-reader')
    const snapshot = await readS5ProtectedTerminalSnapshot('task-1')
    expect(snapshot).toEqual({
      evidenceRows: [{
        id: 'evidence-1',
        workPackageId: 'package-1',
        agentRunId: 'run-1',
        state: 'terminal',
        leaseExpiresAt: terminalAt,
        terminalAt,
      }],
      auditRows: [{
        id: 'audit-1',
        workPackageId: 'package-1',
        agentRunId: 'run-1',
        localRunEvidenceId: 'evidence-1',
        assembly: { state: 'assembled' },
        delivery: { state: 'submitted', submittedAt: terminalAt.toISOString() },
        terminal: { status: 'succeeded' },
        terminalAt,
        updatedAt: terminalAt,
      }],
    })
    expect(JSON.stringify(snapshot)).not.toContain('audit-ownership-token')
    expect(client).toHaveBeenCalledTimes(1)
  })

  it.each([
    'postgres://forge_app@localhost/forge',
    'postgres://forge_local_evidence_reader:secret@localhost/forge',
    'mysql://forge_local_evidence_reader@localhost/forge',
  ])('rejects an unsafe fixed-principal URL before opening a connection', async (url) => {
    process.env[ENV_NAME] = url
    const { readS5ProtectedLocalRunEvidence, s5LocalEvidenceReaderConfigured } =
      await import('@/lib/mcps/s5-protected-reader')
    expect(s5LocalEvidenceReaderConfigured()).toBe(false)
    await expect(readS5ProtectedLocalRunEvidence('task-1')).resolves.toBeNull()
    expect(postgresFactory).not.toHaveBeenCalled()
  })

  it('imports only a validated exported snapshot from the same database', async () => {
    process.env[ENV_NAME] = 'postgres://forge_local_evidence_reader@localhost/forge'
    const client = mockClient(() => Promise.resolve([{ evidenceRows: [], auditRows: [] }]))
    const { readS5ProtectedTerminalSnapshot } = await import('@/lib/mcps/s5-protected-reader')
    await expect(readS5ProtectedTerminalSnapshot('task-1', {
      snapshotId: '00000003-0000001B-1', databaseUrl: 'postgres://forge_app@localhost/forge',
    })).resolves.toEqual({ evidenceRows: [], auditRows: [] })
    expect(client.begin).toHaveBeenCalledWith('isolation level repeatable read read only', expect.any(Function))
    expect(client.unsafe).toHaveBeenCalledWith("set transaction snapshot '00000003-0000001B-1'")
    for (const snapshotId of [
      '00000003-0000001B-1', 'FFFFFFFF-00000000-ABCDEF12',
    ]) {
      await expect(readS5ProtectedTerminalSnapshot('task-1', {
        snapshotId, databaseUrl: 'postgres://forge_app@localhost/forge',
      })).resolves.toEqual({ evidenceRows: [], auditRows: [] })
    }
    for (const snapshotId of [
      '000003A1-1', "00000003-0000001B-1'; select 1; --",
      '00000003-0000001B-1 --', ' 00000003-0000001B-1',
      '00000003-0000001B-1 ', '00000003_0000001B_1',
    ]) {
      await expect(readS5ProtectedTerminalSnapshot('task-1', {
        snapshotId, databaseUrl: 'postgres://forge_app@localhost/forge',
      })).resolves.toBeNull()
    }
    await expect(readS5ProtectedTerminalSnapshot('task-1', {
      snapshotId: '00000003-0000001B-1', databaseUrl: 'postgres://forge_app@other-host/forge',
    })).resolves.toBeNull()
  })
})
