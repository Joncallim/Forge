import { describe, expect, it } from 'vitest'
import { GET as live } from '@/app/api/live/route'
import { config } from '@/proxy'

describe('GET /api/live', () => {
  it('returns a cheap liveness response', async () => {
    const response = await live()
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('is excluded from the auth proxy matcher', () => {
    expect(config.matcher).toContain('/api/((?!auth|health|live).*)')
  })
})
