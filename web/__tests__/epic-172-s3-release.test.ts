import { describe, expect, it, vi } from 'vitest'
import { completeEpic172S3Release } from '@/lib/mcps/epic-172-s3-release'

function order(overrides: Partial<Parameters<typeof completeEpic172S3Release>[0]['order']> = {}) {
  return {
    validateEpic172ReleaseOrder: vi.fn(),
    getEpic172ReleaseOrderNode: vi.fn(() => ({ owner: { issue: 178, slice: 's3' } })),
    getEpic172ReleaseOrderEdges: vi.fn((graph: 'codeDependencyGraph' | 'runtimeActivationGraph') => graph === 'codeDependencyGraph'
      ? [{ from: 's2_issue_177', to: 's3_issue_178' }]
      : [{ from: 'step0_retention_bridge', to: 's3_issue_178' }]),
    ...overrides,
  }
}

describe('Epic 172 S3 release seam', () => {
  it('delegates the atomic signed transition only after manifest ownership and predecessor checks', async () => {
    const consume = vi.fn().mockResolvedValue({ receiptId: 'receipt-s3' })
    await expect(completeEpic172S3Release({
      authorizationAttemptId: 'auth-1',
      buildSha: 'build-sha',
      controllerIdentity: 'controller-1',
      order: order(),
      reviewedSha: 'reviewed-sha',
      transition: { consumeAuthorizationAndRecordS3: consume },
    })).resolves.toEqual({ receiptId: 'receipt-s3' })
    expect(consume).toHaveBeenCalledOnce()
  })

  it('never calls Step 0 when owner or runtime predecessor is wrong', async () => {
    const consume = vi.fn()
    await expect(completeEpic172S3Release({
      authorizationAttemptId: 'auth-1',
      buildSha: 'build-sha',
      controllerIdentity: 'controller-1',
      order: order({ getEpic172ReleaseOrderNode: vi.fn(() => ({ owner: { issue: 179, slice: 's4' } })) }),
      reviewedSha: 'reviewed-sha',
      transition: { consumeAuthorizationAndRecordS3: consume },
    })).rejects.toThrow(/does not assign/)
    expect(consume).not.toHaveBeenCalled()
  })
})
