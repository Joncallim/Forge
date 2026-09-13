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
      cleanupStateTags: new Set([runtime.migrationTag]),
    })
    expect(plan).toEqual([runtime])
  })

  it('does not replay a fully cleaned protected migration after a process restart', () => {
    const plan = protectedMigrationRecoveryPlan({
      journalTags: [runtime.migrationTag],
      appliedTags: new Set([runtime.migrationTag]),
      cleanupPendingTags: new Set(),
      cleanupStateTags: new Set([runtime.migrationTag]),
    })
    expect(plan).toEqual([])
  })

  it('routes a re-upgrade through the protected wrapper before ordinary migrations', () => {
    const plan = protectedMigrationRecoveryPlan({
      journalTags: [runtime.migrationTag],
      appliedTags: new Set(),
      cleanupPendingTags: new Set(),
      cleanupStateTags: new Set(),
    })
    expect(plan).toEqual([runtime])
  })

  it('accepts a future owner-aware protected migration without inventing its schema or creator', () => {
    const plan = protectedMigrationRecoveryPlan({
      journalTags: [syntheticFutureProtectedMigration.migrationTag],
      appliedTags: new Set(),
      cleanupPendingTags: new Set(),
      cleanupStateTags: new Set(),
      registry: [syntheticFutureProtectedMigration],
    })
    expect(plan).toEqual([syntheticFutureProtectedMigration])
    expect(syntheticFutureProtectedMigration).toMatchObject({
      id: 'synthetic-future-protected-migration',
      protectedOwner: 'forge_synthetic_future_routines_owner',
    })
    expect(syntheticFutureProtectedMigration.migrationTag).not.toContain('0035')
  })

  it('orders multiple protected migrations by the journal rather than registry declaration', () => {
    const later = { ...syntheticFutureProtectedMigration, id: 'later', migrationTag: '0040_later_protected_migration' }
    const plan = protectedMigrationRecoveryPlan({
      journalTags: [runtime.migrationTag, later.migrationTag],
      appliedTags: new Set(),
      cleanupPendingTags: new Set(),
      cleanupStateTags: new Set(),
      registry: [later, runtime],
    })
    expect(plan).toEqual([runtime, later])
  })

  it('fails closed when the ledger has a protected migration without durable handoff state', () => {
    expect(() => protectedMigrationRecoveryPlan({
      journalTags: [runtime.migrationTag],
      appliedTags: new Set([runtime.migrationTag]),
      cleanupPendingTags: new Set(),
      cleanupStateTags: new Set(),
    })).toThrow(`Applied protected migration '${runtime.migrationTag}' has no durable handoff state`)
  })
})
