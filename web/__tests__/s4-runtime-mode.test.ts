import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDbExecute, mockPostgres } = vi.hoisted(() => ({
  mockDbExecute: vi.fn(),
  mockPostgres: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { execute: mockDbExecute } }))
vi.mock('postgres', () => ({ default: mockPostgres }))

const credentialNames = [
  'FORGE_PACKET_ISSUER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL',
  'FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL',
  'FORGE_REVIEW_SOURCE_RESOLVER_DATABASE_URL',
  'FORGE_S4_RECOVERY_OPERATOR_DATABASE_URL',
  'FORGE_TASK_EVENT_PUBLISHER_REDIS_URL',
  'FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX',
  'FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID',
] as const
const original = Object.fromEntries(credentialNames.map((name) => [name, process.env[name]]))

function configureAll(): void {
  process.env.FORGE_PACKET_ISSUER_DATABASE_URL = 'postgresql://issuer/test'
  process.env.FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL = 'postgresql://writer/test'
  process.env.FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL = 'postgresql://resolver/test'
  process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL = 'postgresql://history/test'
  process.env.FORGE_REVIEW_SOURCE_RESOLVER_DATABASE_URL = 'postgresql://forge_review_source_resolver@localhost/forge'
  process.env.FORGE_S4_RECOVERY_OPERATOR_DATABASE_URL = 'postgresql://forge_s4_recovery_operator@localhost/forge'
  process.env.FORGE_TASK_EVENT_PUBLISHER_REDIS_URL = 'redis://forge_event_publisher@localhost/0'
  process.env.FORGE_TASK_EVENT_SUBSCRIBER_REDIS_URL = 'redis://forge_event_subscriber@localhost/0'
  process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_HEX = 'a'.repeat(64)
  process.env.FORGE_ARCHITECT_PLAN_DIGEST_KEY_ID = 'test-key-v1'
}

describe('authoritative S4 runtime activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const name of credentialNames) delete process.env[name]
  })

  afterEach(() => {
    for (const name of credentialNames) {
      const value = original[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('uses legacy mode while authority is disabled with no protected credentials', async () => {
    mockDbExecute.mockResolvedValue([{ mode: 'legacy' }])
    const { readS4RuntimeModeV1 } = await import('@/lib/mcps/s4-lease')
    await expect(readS4RuntimeModeV1()).resolves.toBe('legacy')
    expect(mockPostgres).not.toHaveBeenCalled()
  })

  it('uses legacy mode while authority is disabled even after full preprovisioning', async () => {
    configureAll()
    mockDbExecute.mockResolvedValue([{ mode: 'legacy' }])
    const { readS4RuntimeModeV1 } = await import('@/lib/mcps/s4-lease')
    await expect(readS4RuntimeModeV1()).resolves.toBe('legacy')
    expect(mockPostgres).not.toHaveBeenCalled()
  })

  it('opens protected mode only after authority is active and credentials are complete', async () => {
    configureAll()
    mockDbExecute.mockResolvedValue([{ mode: 'protected' }])
    const { readS4RuntimeModeV1 } = await import('@/lib/mcps/s4-lease')
    await expect(readS4RuntimeModeV1()).resolves.toBe('protected')
    expect(mockPostgres).not.toHaveBeenCalled()
  })

  it('fails closed when active authority sees partial protected provisioning', async () => {
    process.env.FORGE_PACKET_ISSUER_DATABASE_URL = 'postgresql://issuer/test'
    mockDbExecute.mockResolvedValue([{ mode: 'protected' }])
    const { readS4RuntimeModeV1 } = await import('@/lib/mcps/s4-lease')
    await expect(readS4RuntimeModeV1()).rejects.toThrow(/credential set is incomplete/i)
    expect(mockPostgres).not.toHaveBeenCalled()
  })

  it('keeps pre-S4 databases compatible only when no protected credential exists', async () => {
    mockDbExecute.mockRejectedValue(Object.assign(new Error('function does not exist'), { code: '42883' }))
    const { readS4RuntimeModeV1 } = await import('@/lib/mcps/s4-lease')
    await expect(readS4RuntimeModeV1()).resolves.toBe('legacy')

    process.env.FORGE_PACKET_ISSUER_DATABASE_URL = 'postgresql://issuer/test'
    await expect(readS4RuntimeModeV1()).rejects.toThrow(/authoritative.*unavailable/i)
    expect(mockPostgres).not.toHaveBeenCalled()
  })

  it('never converts blocked authority or connectivity failures into legacy mode', async () => {
    const { readS4RuntimeModeV1 } = await import('@/lib/mcps/s4-lease')
    mockDbExecute.mockRejectedValueOnce(Object.assign(new Error('authority incomplete'), { code: '55000' }))
    await expect(readS4RuntimeModeV1()).rejects.toThrow(/authoritative.*unavailable/i)
    mockDbExecute.mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }))
    await expect(readS4RuntimeModeV1()).rejects.toThrow(/authoritative.*unavailable/i)
    expect(mockPostgres).not.toHaveBeenCalled()
  })
})
