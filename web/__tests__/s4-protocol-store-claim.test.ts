import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockPostgres, mockSql, sqlCalls } = vi.hoisted(() => {
  const sqlCalls: Array<{ source: string; values: unknown[] }> = []
  const mockSql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ source: strings.join('?'), values })
      return Promise.resolve([{
        auditId: '33333333-3333-4333-8333-333333333333',
        localRunEvidenceId: '44444444-4444-4444-8444-444444444444',
      }])
    }),
    {
      array: vi.fn((values: unknown[]) => values),
      end: vi.fn().mockResolvedValue(undefined),
    },
  )
  return { mockPostgres: vi.fn(() => mockSql), mockSql, sqlCalls }
})

vi.mock('postgres', () => ({ default: mockPostgres }))

describe('packet authorization claim wrapper', () => {
  afterEach(() => {
    delete process.env.FORGE_PACKET_ISSUER_DATABASE_URL
    vi.clearAllMocks()
    sqlCalls.length = 0
  })

  it('uses the atomic seven-argument lifecycle routine with distinct local and packet tokens', async () => {
    process.env.FORGE_PACKET_ISSUER_DATABASE_URL = 'postgresql://issuer/test'
    const { claimPacketAuthorization } = await import('@/lib/mcps/s4-protocol-store')

    const result = await claimPacketAuthorization({
      agentRunId: '11111111-1111-4111-8111-111111111111',
      decisionId: '22222222-2222-4222-8222-222222222222',
      localLeaseSeconds: 30,
      packetLeaseSeconds: 45,
      requiredCapabilities: ['filesystem.project.read'],
    })

    expect(sqlCalls).toHaveLength(1)
    expect(sqlCalls[0].source).toContain('forge.claim_packet_lifecycle_v2')
    expect(sqlCalls[0].source).not.toContain('insert_packet_authorization_snapshot_v2')
    expect(sqlCalls[0].values).toHaveLength(7)
    expect(sqlCalls[0].values[2]).not.toBe(sqlCalls[0].values[3])
    expect(result).toMatchObject({
      auditId: '33333333-3333-4333-8333-333333333333',
      localRunEvidenceId: '44444444-4444-4444-8444-444444444444',
      localClaimToken: sqlCalls[0].values[2],
      packetClaimToken: sqlCalls[0].values[3],
    })
    expect(mockSql.end).toHaveBeenCalledOnce()
  })
})
