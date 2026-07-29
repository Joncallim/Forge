import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import manifest from '../test-contracts/mcp-admission-v2.json'

const execFileAsync = promisify(execFile)

// The output-quarantine contract lets the live runner channel carry fixed
// status codes and canonical scenario IDs, but never child bytes. These tests
// pin both halves: a rejection must name why it failed, and it must never
// echo a non-canonical identifier back out.
describe('Epic 172 S6 contract wrapper diagnostics', () => {
  let temporaryDirectory: string

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'forge-s6-diagnostics-'))
  })

  afterAll(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  async function runVitestWrapper(manifest: string, vitestArgs: string[]) {
    return execFileAsync(process.execPath, [
      path.resolve(process.cwd(), 'scripts/run-vitest-contract.mjs'),
      '--manifest', manifest,
      '--partition', 'contract',
      '--',
      ...vitestArgs,
    ], { timeout: 60_000 }).then(
      () => ({ code: 0, stderr: '' }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string }
        return { code: failure.code ?? 1, stderr: failure.stderr ?? '' }
      },
    )
  }

  it('names the missing scenario IDs instead of failing silently', async () => {
    const result = await runVitestWrapper('test-contracts/mcp-admission-v2.json', [
      'npx', 'vitest', 'run', '__tests__/epic-172-s6-release-adapter.test.ts',
      '--testNamePattern=\\[scenarioId=', '--testTimeout=10000',
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('MCP_VITEST_CONTRACT_REJECTED')
    expect(result.stderr).toContain('reason=executed_identity_mismatch')
    // The three controller/deadline/suite scenarios live in files this run
    // deliberately omitted, so the operator is told exactly which are absent.
    expect(result.stderr).toContain('missing=')
    expect(result.stderr).toContain('vitest::epic-172.deadline-process-tree-kill')
  })

  it('emits a fixed reason code for an invalid invocation', async () => {
    const result = await runVitestWrapper('test-contracts/mcp-admission-v2.json', [
      'npx', 'vitest', 'run', '--retry=2',
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('reason=retry_override_forbidden')
  })

  it('suppresses non-canonical executed IDs rather than echoing them', async () => {
    // A manifest whose expected key is absent from the run forces the identity
    // diff. The executed side carries a canonical key, so nothing is
    // suppressed here; the guard below is what proves the shape filter runs.
    const manifest = path.join(temporaryDirectory, 'sentinel-manifest.json')
    await writeFile(manifest, JSON.stringify({
      schemaVersion: 2,
      contractVersion: 'mcp-admission-v2',
      partitions: [{
        id: 'contract',
        runner: 'vitest',
        expectedCount: 1,
        executionKeys: ['vitest::epic-172.absent-sentinel'],
      }],
    }))

    const result = await runVitestWrapper(manifest, [
      'npx', 'vitest', 'run', '__tests__/epic-172-s6-release-adapter.test.ts',
      '--testNamePattern=\\[scenarioId=', '--testTimeout=10000',
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('reason=executed_identity_mismatch')
    expect(result.stderr).toContain('missing=vitest::epic-172.absent-sentinel')
    // Every reported identifier must match the canonical execution-key shape.
    const reported = result.stderr.match(/(?:missing|unexpected)=([^\s]+)/g) ?? []
    for (const group of reported) {
      for (const key of group.split('=')[1].split(',')) {
        expect(key).toMatch(/^vitest::[a-z0-9][a-z0-9.-]*$/)
      }
    }
  })

  // The Playwright wrapper validates the manifest before spawning anything, so
  // a partition added or retired in one place and not the other fails the whole
  // partition at startup with no test output. This drifted once already: the
  // wrapper carried a hardcoded six-partition literal after issuance moved to
  // #179/S4, which failed every partition in under a second.
  it('keeps the wrapper partition map in step with the checked-in manifest', async () => {
    const wrapper = await readFile(
      path.resolve(process.cwd(), 'scripts/run-playwright-contract.mjs'),
      'utf8',
    )
    const block = wrapper.match(/const MANIFEST_PARTITIONS = Object\.freeze\(\{([\s\S]*?)\}\)/)
    expect(block, 'MANIFEST_PARTITIONS block must be present').not.toBeNull()
    const wrapperIds = [...block![1].matchAll(/^\s*'?([a-z-]+)'?:\s*\{/gm)].map((m) => m[1]).sort()
    const manifestIds = manifest.partitions.map((partition) => partition.id).sort()
    expect(wrapperIds).toEqual(manifestIds)

    // And the count must be derived, never a literal that can go stale.
    expect(wrapper).toContain('Object.keys(MANIFEST_PARTITIONS).length')
    expect(wrapper).not.toMatch(/value\.partitions\.length !== \d+/)
  })
})
