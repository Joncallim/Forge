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

const exactScenarioIds = [
  'vnext.a1.contracts',
  'vnext.a1.schema',
  'vnext.a1.service-owner-cas',
  'vnext.a1.protected-postgres',
  'vnext.a1.projectless-lifecycle',
  'vnext.a1.protected-cleanup-failure',
  'vnext.a1.protected-restart',
  'vnext.a1.protected-reupgrade',
  'vnext.a1.pointer-concurrency-fixture-boundary',
  'vnext.a1.manifest-identity',
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

  it('[scenarioId=vnext.a1.protected-postgres] makes the protected PostgreSQL proof non-skippable when selected', () => {
    expect(manifest.proofs.find((proof) => proof.id === 'C5-protected-postgres')).toMatchObject({ runnerBinding: 'a1-vitest-postgres' })
    expect(manifest.runnerBindings.find((binding) => binding.id === 'a1-vitest-postgres')).toMatchObject({ forbidSkipped: true })
  })

  it('[scenarioId=vnext.a1.projectless-lifecycle] binds the project-less lifecycle proof', () => {
    expect(manifest.proofs.find((proof) => proof.id === 'C8-projectless-lifecycle')).toMatchObject({ file: '__tests__/vnext-runtime-foundation.postgres.test.ts' })
  })

  it('[scenarioId=vnext.a1.protected-cleanup-failure] requires durable recovery after cleanup failure', () => {
    expect(manifest.proofs.find((proof) => proof.id === 'C5a-protected-cleanup-failure')).toBeTruthy()
  })

  it('[scenarioId=vnext.a1.protected-restart] requires restart reconciliation of an open handoff', () => {
    expect(manifest.proofs.find((proof) => proof.id === 'C5b-protected-restart')).toBeTruthy()
  })

  it('[scenarioId=vnext.a1.protected-reupgrade] requires a re-upgrade to select the owning wrapper', () => {
    expect(manifest.proofs.find((proof) => proof.id === 'C5c-protected-reupgrade')).toBeTruthy()
  })

  it('[scenarioId=vnext.a1.pointer-concurrency-fixture-boundary] keeps successor creation outside non-closing A1', () => {
    expect(manifest.proofs.find((proof) => proof.id === 'C9-pointer-concurrency-boundary')).toBeTruthy()
  })

  it('[scenarioId=vnext.a1.manifest-identity] keeps exact scenario identity and runner bindings complete', () => {
    const staticBinding = manifest.runnerBindings.find((binding) => binding.id === 'a1-vitest-static')
    expect(staticBinding).toMatchObject({ runner: 'vitest', command: 'npx vitest run __tests__/vnext-phase0-conformance.contract.test.ts', forbidSkipped: true })
    expect(staticBinding?.executionKeys).toEqual(exactScenarioIds.map((id) => `vitest::${id}`))
    expect(manifest.proofs.flatMap((proof) => proof.scenarioIds)).toEqual(exactScenarioIds)
  })
})
