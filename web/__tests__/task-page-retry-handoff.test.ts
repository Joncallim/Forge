import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
  useRouter: vi.fn(),
}))

vi.mock('@/hooks/useTaskStream', () => ({
  useTaskStream: vi.fn(),
}))

import { retryHandoffMessage } from '@/app/dashboard/tasks/[id]/page'

describe('task page retry handoff controls', () => {
  it('distinguishes newly queued and already queued retry responses', () => {
    expect(retryHandoffMessage('retry_enqueued')).toBe('Retry queued. The worker will re-evaluate this handoff.')
    expect(retryHandoffMessage('retry_already_queued')).toBe('Retry already queued. The worker will re-evaluate this handoff.')
  })
})
