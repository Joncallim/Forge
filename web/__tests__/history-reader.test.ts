import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturedParameters, mockEnd, mockQuery } = vi.hoisted(() => ({
  capturedParameters: [] as unknown[],
  mockEnd: vi.fn(),
  mockQuery: vi.fn(),
}))

vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(
    (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      capturedParameters.push(...parameters)
      return mockQuery(strings, ...parameters)
    },
    { end: mockEnd },
  )),
}))

describe('Architect history credential handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedParameters.length = 0
    process.env.FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL = 'postgresql://history-reader/test'
    mockQuery.mockResolvedValue([])
    mockEnd.mockResolvedValue(undefined)
  })

  it('zeroes the bounded raw credential buffer after the database call', async () => {
    const { readArchitectPlanHistory } = await import('@/lib/mcps/history-reader')
    await readArchitectPlanHistory({
      planVersion: '1',
      sessionCredential: '00000000-0000-4000-8000-000000000000',
      taskId: '00000000-0000-4000-8000-000000000001',
    })

    const credentialBytes = capturedParameters.find((value): value is Buffer => Buffer.isBuffer(value))
    expect(credentialBytes).toBeDefined()
    expect(credentialBytes).toHaveLength(36)
    expect(credentialBytes?.every((byte) => byte === 0)).toBe(true)
    expect(mockEnd).toHaveBeenCalledWith({ timeout: 5 })
  })
})
