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

const staticScenarioIds = [
  'vnext.a1.contracts',
  'vnext.a1.schema',
  'vnext.a1.service-owner-cas',
  'vnext.a1.manifest-identity',
]

const recoveryScenarioIds = [
  'vnext.a1.protected-cleanup-failure',
  'vnext.a1.protected-restart',
  'vnext.a1.protected-reupgrade',
]

describe('VNext Phase 0 A1 executable conformance contract', () => {
  it('[scenarioId=vnext.a1.contracts] binds the versioned contract proof to Vitest', () => {
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.contractVersion).toBe('vnext-phase0-v1')
    expect(manifest.nonClosing).toBe(true)
    expect(manifest.proofs.find((proof) => proof.id === 'C1-contracts')).toMatchObject({ runnerBinding: 'a1-vitest-static' })
  })

  it('[scenarioId=vnext.a1.schema] binds the schema proof to its checked-in source test', () => {
    expect(manifest.proofs.find((proof) => proof.id === 'C2-schema')).toMatchObject({ file: '__tests__/vnext-runtime-foundation-schema.test.ts' })
  })

  it('[scenarioId=vnext.a1.service-owner-cas] binds the authenticated service and CAS proof', () => {
    expect(manifest.proofs.find((proof) => proof.id === 'C4-service-owner-cas')).toMatchObject({ file: '__tests__/vnext-runtime-service.test.ts' })
  })

  it('[scenarioId=vnext.a1.manifest-identity] keeps executable runner bindings and scenario identity complete', () => {
    const staticBinding = manifest.runnerBindings.find((binding) => binding.id === 'a1-vitest-static')
    const postgresBinding = manifest.runnerBindings.find((binding) => binding.id === 'a1-vitest-postgres')
    const recoveryBinding = manifest.runnerBindings.find((binding) => binding.id === 'a1-protected-migration-recovery')
    expect(staticBinding).toMatchObject({ runner: 'vitest', command: 'npx vitest run __tests__/vnext-phase0-conformance.contract.test.ts', forbidSkipped: true })
    expect(staticBinding?.executionKeys).toEqual(staticScenarioIds.map((id) => `vitest::${id}`))
    expect(postgresBinding).toMatchObject({ runner: 'vitest', forbidSkipped: true })
    expect(postgresBinding?.executionKeys).toEqual([
      'vitest::vnext.a1.protected-postgres',
      'vitest::vnext.a1.projectless-lifecycle',
      'vitest::vnext.a1.pointer-concurrency-fixture-boundary',
    ])
    expect(recoveryBinding).toMatchObject({
      runner: 'command',
      command: 'npm run test:vnext-protected-migration-recovery',
      forbidSkipped: true,
      executionKeys: recoveryScenarioIds.map((id) => `command::${id}`),
    })
    for (const proofId of ['C5a-protected-cleanup-failure', 'C5b-protected-restart', 'C5c-protected-reupgrade']) {
      expect(manifest.proofs.find((proof) => proof.id === proofId)).toMatchObject({
        runnerBinding: 'a1-protected-migration-recovery',
        file: 'scripts/ci/prove-vnext-protected-migration-handoff-recovery.ts',
      })
    }
    expect(manifest.proofs.flatMap((proof) => proof.scenarioIds)).toEqual([
      'vnext.a1.contracts', 'vnext.a1.schema', 'vnext.a1.service-owner-cas',
      'vnext.a1.protected-postgres', 'vnext.a1.projectless-lifecycle',
      ...recoveryScenarioIds, 'vnext.a1.pointer-concurrency-fixture-boundary', 'vnext.a1.manifest-identity',
    ])
  })
})
