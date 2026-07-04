import { describe, expect, it, vi } from 'vitest'
import { claimLegacyOwnership } from '@/lib/bootstrap-ownership'

describe('claimLegacyOwnership', () => {
  it('assigns both legacy projects and legacy tasks to the bootstrap user', async () => {
    const where = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn(() => ({ where }))
    const update = vi.fn(() => ({ set }))

    await claimLegacyOwnership({ update } as never, 'user-abc')

    expect(update).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenNthCalledWith(1, { submittedBy: 'user-abc' })
    expect(set).toHaveBeenNthCalledWith(2, { submittedBy: 'user-abc' })
    expect(where).toHaveBeenCalledTimes(2)
  })
})
