import { describe, expect, it, vi } from 'vitest'
import { completeEpic172S3Release } from '@/lib/mcps/epic-172-s3-release'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
  it('orders migration 0026 strictly after the integrated Step 0 chain', () => {
    const journal = JSON.parse(readFileSync(
      fileURLToPath(new URL('../db/migrations/meta/_journal.json', import.meta.url)),
      'utf8',
    )) as { entries: Array<{ idx: number; tag: string; when: number }> }
    const entries = journal.entries.filter((entry) => entry.tag.startsWith('002'))
    const byTag = new Map(entries.map((entry) => [entry.tag, entry]))
    const exactTags = [
      '0023_epic_172_release_substrate',
      '0024_epic_172_retention_fks',
      '0025_epic_172_release_routines',
      '0026_epic_172_s3_grant_lifecycle',
    ]
    expect(exactTags.map((tag) => byTag.get(tag)?.idx)).toEqual([23, 24, 25, 26])
    expect(exactTags.map((tag) => byTag.get(tag)?.when)).toEqual(
      [...exactTags.map((tag) => byTag.get(tag)?.when)].sort((left, right) => Number(left) - Number(right)),
    )
    expect(byTag.get('0026_epic_172_s3_grant_lifecycle')?.when).toBeGreaterThan(
      byTag.get('0025_epic_172_release_routines')?.when ?? Number.MAX_SAFE_INTEGER,
    )
  })

  it('keeps retained S3 authority history out of ordinary-app E2E truncation', () => {
    for (const relativePath of ['../e2e/helpers.ts', '../e2e/mcp-handoff-concurrency.spec.ts']) {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
      expect(source, relativePath).not.toMatch(
        /truncate\s+table[\s\S]{0,400}(?:filesystem_mcp_grant_approvals|project_filesystem_grant_decisions)/i,
      )
    }
  })

  it('keeps the real PostgreSQL concurrency proof mandatory and single-project in CI', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/web-ci.yml', import.meta.url)),
      'utf8',
    )
    expect(workflow).toContain('name: Run mandatory S3 PostgreSQL concurrency proof')
    expect(workflow).toContain("RUN_FORGE_POSTGRES_TESTS: '1'")
    expect(workflow).toContain('e2e/filesystem-grant-lifecycle-concurrency.spec.ts')
    expect(workflow).toContain('--project=chromium-desktop --workers=1')
    expect(workflow).toContain("grep -Eq '[1-9][0-9]* skipped'")
    expect(workflow).toContain("if ! grep -Eq '[1-9][0-9]* passed'")
  })

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
