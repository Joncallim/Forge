import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../test-contracts/vnext-phase0-v1.json', import.meta.url)), 'utf8')) as {
  schemaVersion: number
  contractVersion: string
  proofs: Array<{ id: string, runner: string, file: string }>
}

describe('VNext Phase 0 conformance manifest', () => {
  it('is an explicit, complete A1 proof registry', () => {
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.contractVersion).toBe('vnext-phase0-v1')
    expect(manifest.proofs.map((proof) => proof.id)).toEqual(expect.arrayContaining(['C1-contracts', 'C2-schema', 'C4-service-owner-cas', 'C5-protected-postgres', 'C8-projectless-lifecycle']))
    for (const proof of manifest.proofs) expect(readFileSync(fileURLToPath(new URL(`../${proof.file}`, import.meta.url)), 'utf8')).toBeTruthy()
  })
})
