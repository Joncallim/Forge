import { describe, expect, it, vi } from 'vitest'
import { completeEpic172S3Release } from '@/lib/mcps/epic-172-s3-release'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const migration = readFileSync(
  fileURLToPath(new URL('../db/migrations/0026_epic_172_s3_grant_lifecycle.sql', import.meta.url)),
  'utf8',
)
const ownerBootstrap = readFileSync(
  fileURLToPath(new URL('../scripts/bootstrap-epic-172-s3-release-owner.ts', import.meta.url)),
  'utf8',
)
const recorder = readFileSync(
  fileURLToPath(new URL('../lib/mcps/epic-172-release-recorder.ts', import.meta.url)),
  'utf8',
)

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
    expect(workflow).toContain('--project=chromium-desktop --workers=1 --retries=0')
    const proofStep = workflow.slice(
      workflow.indexOf('name: Run mandatory S3 PostgreSQL concurrency proof'),
      workflow.indexOf('name: Prove Epic 172 Step 0 disabled ingress'),
    )
    expect(proofStep).toContain('FORGE_S4_POSTGRES_TEST_DATABASE_URL:')
    expect(proofStep).toContain('FORGE_PACKET_ISSUER_DATABASE_URL:')
    expect(workflow).toContain("grep -Eq '[1-9][0-9]* skipped'")
    expect(workflow).toContain("if ! grep -Eq '[1-9][0-9]* passed'")
    const concurrencyProof = readFileSync(
      fileURLToPath(new URL('../e2e/filesystem-grant-lifecycle-concurrency.spec.ts', import.meta.url)),
      'utf8',
    )
    expect(concurrencyProof).not.toMatch(
      /insert into filesystem_mcp_runtime_audits[\s\S]{0,400}duration_ms/i,
    )
    const protectedClaim = concurrencyProof.indexOf('const claim = RUN_S4_ISSUANCE')
    const localEvidence = concurrencyProof.indexOf(
      'insert into work_package_local_run_evidence (',
      protectedClaim,
    )
    const packetIssuer = concurrencyProof.indexOf(
      'forge.insert_packet_authorization_snapshot_v2(',
      protectedClaim,
    )
    expect(protectedClaim).toBeGreaterThan(0)
    expect(localEvidence).toBeGreaterThan(protectedClaim)
    expect(packetIssuer).toBeGreaterThan(localEvidence)
  })

  it('runs the primary unit suite with mandatory release PostgreSQL fixtures and zero lint warnings', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/web-ci.yml', import.meta.url)),
      'utf8',
    )
    expect(workflow).toContain('npm run lint -- --max-warnings=0')
    expect(workflow).toContain('name: Run the complete zero-skip unit suite')
    expect(workflow).toContain('run: npm test')
    expect(workflow).toContain("FORGE_EPIC_172_REQUIRE_POSTGRES_TEST: '1'")
    expect(workflow).toContain('FORGE_EPIC_172_TEST_APP_DATABASE_URL:')
    expect(workflow).toContain('FORGE_EPIC_172_TEST_WRITER_DATABASE_URL:')
    expect(workflow).toContain('FORGE_EPIC_172_TEST_TRANSITION_DATABASE_URL:')
    expect(workflow).not.toContain(
      'run: npx vitest run __tests__/epic-172-release-recorder.postgres.test.ts',
    )
  })

  it('uses a versioned, non-inheriting owner handoff for fresh and upgraded Step 0 databases', () => {
    expect(ownerBootstrap).toContain('forge_begin_epic_172_s3_owner_bootstrap_v1')
    expect(ownerBootstrap).toContain('forge_finalize_epic_172_s3_owner_bootstrap_v1')
    expect(ownerBootstrap).toContain('with admin false, inherit false, set true')
    expect(ownerBootstrap).toContain('A competing release-role membership exists before the S3 handoff')
    expect(ownerBootstrap).toContain('S3 release ownership is already complete')
    expect(ownerBootstrap).toContain(
      'grant references (id) on table public.tasks to forge_release_routines_owner',
    )
    expect(ownerBootstrap).toContain(
      'grant select (id, task_id), references (id) on table public.work_packages to forge_release_routines_owner',
    )
    expect(ownerBootstrap).toContain(
      'revoke references (id) on table public.tasks from forge_release_routines_owner',
    )
    expect(ownerBootstrap).toContain('The post-bootstrap S3 source-table ACL is not exact')
    expect(ownerBootstrap).toContain('The projection-head table owner or direct ACL is not exact')
    expect(migration).toContain('REVOKE ALL ON public.work_package_local_projection_heads FROM PUBLIC')
    expect(migration).toContain(
      'FROM forge_release_evidence_writer, forge_release_transition',
    )
    expect(migration).not.toContain(
      'GRANT SELECT ON public.work_package_local_projection_heads TO PUBLIC',
    )
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON public.work_package_local_projection_heads',
    )
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION forge.preallocate_local_projection_heads_v1() FROM PUBLIC',
    )
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION forge.reject_projection_head_mutation_v1() FROM PUBLIC',
    )
    expect(migration.indexOf('forge_begin_epic_172_s3_owner_bootstrap_v1')).toBeLessThan(
      migration.indexOf('SET LOCAL ROLE forge_release_routines_owner'),
    )
    expect(migration.indexOf('RESET ROLE')).toBeLessThan(
      migration.indexOf('forge_finalize_epic_172_s3_owner_bootstrap_v1'),
    )
  })

  it('makes consumption, signed receipt insertion, and durable S3 state one final-expiry transaction', () => {
    const consumption = migration.indexOf('INSERT INTO public.forge_epic_172_release_evidence_consumptions', 20_000)
    const receipt = migration.indexOf('INSERT INTO public.forge_epic_172_release_evidence (', consumption)
    const finalState = migration.indexOf('UPDATE public.forge_epic_172_s3_release_state', receipt)
    const finalExpiry = migration.indexOf('pg_catalog.clock_timestamp() < v_authorization.expires_at', finalState)
    expect(consumption).toBeGreaterThan(0)
    expect(receipt).toBeGreaterThan(consumption)
    expect(finalState).toBeGreaterThan(receipt)
    expect(finalExpiry).toBeGreaterThan(finalState)
    expect(migration).toContain("state = 'pending'")
    expect(migration).toContain("state = 'complete'")
    expect(migration).toContain("p_consumer_node = 's3_issue_178'")
    expect(migration).toContain('s3_issue_178 evidence requires the atomic dedicated S3 completion transaction')
    expect(migration).toContain('REVOKE ALL ON FUNCTION forge.complete_epic_172_s3_release_v1')
    expect(migration).toContain('TO forge_release_transition')
    expect(recorder).toContain('verifyEpic172ReleaseEvidence({')
    expect(recorder).toContain('verifyStoredTransition(locked, databaseNow')
    expect(recorder).toContain('forge.complete_epic_172_s3_release_v1(')
  })

  it('delegates the atomic signed transition only after manifest ownership and predecessor checks', async () => {
    const consume = vi.fn().mockResolvedValue({ receiptId: 'receipt-s3' })
    await expect(completeEpic172S3Release({
      authorizationAttemptId: 'auth-1',
      buildSha: 'build-sha',
      controllerIdentity: 'controller-1',
      operationId: 'operation-1',
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
      operationId: 'operation-1',
      order: order({ getEpic172ReleaseOrderNode: vi.fn(() => ({ owner: { issue: 179, slice: 's4' } })) }),
      reviewedSha: 'reviewed-sha',
      transition: { consumeAuthorizationAndRecordS3: consume },
    })).rejects.toThrow(/does not assign/)
    expect(consume).not.toHaveBeenCalled()
  })
})
