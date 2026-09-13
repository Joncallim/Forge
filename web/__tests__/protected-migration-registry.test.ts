import { describe, expect, it } from 'vitest'
import {
  protectedMigrationRecoveryPlan,
  protectedMigrationRegistry,
  syntheticFutureProtectedMigration,
} from '@/scripts/ci/protected-migration-registry'

const runtime = protectedMigrationRegistry[0]

describe('protected migration registry', () => {
  it('replays the owning wrapper when a committed migration still has cleanup pending', () => {
    const plan = protectedMigrationRecoveryPlan({
      journalTags: [runtime.migrationTag],
      appliedTags: new Set([runtime.migrationTag]),
      cleanupPendingTags: new Set([runtime.migrationTag]),
    })
    expect(plan).toEqual([runtime])
  })

  it('does not replay a fully cleaned protected migration after a process restart', () => {
    const plan = protectedMigrationRecoveryPlan({
      journalTags: [runtime.migrationTag],
      appliedTags: new Set([runtime.migrationTag]),
      cleanupPendingTags: new Set(),
    })
    expect(plan).toEqual([])
  })

  it('routes a re-upgrade through the protected wrapper before ordinary migrations', () => {
    const plan = protectedMigrationRecoveryPlan({
      journalTags: [runtime.migrationTag],
      appliedTags: new Set(),
      cleanupPendingTags: new Set(),
    })
    expect(plan).toEqual([runtime])
  })

  it('accepts a future owner-aware protected migration without inventing its schema or creator', () => {
    const plan = protectedMigrationRecoveryPlan({
      journalTags: [syntheticFutureProtectedMigration.migrationTag],
      appliedTags: new Set(),
      cleanupPendingTags: new Set(),
      registry: [syntheticFutureProtectedMigration],
    })
    expect(plan).toEqual([syntheticFutureProtectedMigration])
    expect(syntheticFutureProtectedMigration).toMatchObject({
      id: 'synthetic-future-protected-migration',
      protectedOwner: 'forge_synthetic_future_routines_owner',
    })
    expect(syntheticFutureProtectedMigration.migrationTag).not.toContain('0035')
  })
})
