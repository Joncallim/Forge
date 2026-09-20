import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../test-contracts/vnext-phase0-v1.json', import.meta.url)), 'utf8')) as {
  schemaVersion: number
  contractVersion: string
  nonClosing: boolean
  runnerBindings: Array<{ id: string, runner: string, command: string, forbidSkipped: boolean, executionKeys: string[] }>
  proofs: Array<{ id: string, runnerBinding: string, file: string, scenarioIds: string[] }>
}

describe('VNext Phase 0 conformance manifest', () => {
  it('is an explicit, complete A1 proof registry', () => {
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.contractVersion).toBe('vnext-phase0-v1')
    expect(manifest.nonClosing).toBe(true)
    expect(manifest.proofs.map((proof) => proof.id)).toEqual(expect.arrayContaining(['C1-contracts', 'C2-schema', 'C4-service-owner-cas', 'C5-protected-postgres', 'C8-projectless-lifecycle', 'C5a-protected-cleanup-failure', 'C5b-protected-restart', 'C5c-protected-reupgrade', 'C9-pointer-concurrency-boundary']))
    for (const proof of manifest.proofs) expect(readFileSync(fileURLToPath(new URL(`../${proof.file}`, import.meta.url)), 'utf8')).toBeTruthy()
    const bindingIds = new Set(manifest.runnerBindings.map((binding) => binding.id))
    for (const proof of manifest.proofs) {
      expect(bindingIds.has(proof.runnerBinding)).toBe(true)
      expect(proof.scenarioIds).toHaveLength(1)
    }
    for (const binding of manifest.runnerBindings) {
      expect(['vitest', 'command']).toContain(binding.runner)
      expect(binding.command).toBeTruthy()
      expect(binding.forbidSkipped).toBe(true)
      expect(binding.executionKeys.length).toBeGreaterThan(0)
    }
  })

  it('keeps recovery execution markers and the conformance gate anti-skip checks', () => {
    const recovery = manifest.runnerBindings.find((binding) => binding.id === 'a1-protected-migration-recovery')
    const proof = readFileSync(fileURLToPath(new URL('../scripts/ci/prove-vnext-protected-migration-handoff-recovery.ts', import.meta.url)), 'utf8')
    const gate = readFileSync(fileURLToPath(new URL('../scripts/ci/run-vnext-phase0-contract.mjs', import.meta.url)), 'utf8')
    expect(recovery).toMatchObject({ command: 'npm run test:vnext-protected-migration-recovery', forbidSkipped: true })
    for (const marker of ['VNEXT_A1_PROTECTED_CLEANUP_FAILURE_PASSED', 'VNEXT_A1_PROTECTED_RESTART_PASSED', 'VNEXT_A1_PROTECTED_REUPGRADE_PASSED']) {
      expect(proof).toContain(marker)
    }
    expect(gate).toContain('access(proof.file)')
    expect(gate).toContain('A1 protected-migration recovery runner rejected execution, skip state, or scenario identity.')
  })
})
