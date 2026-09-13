/**
 * Protected migrations temporarily grant a migration login membership in a
 * non-login owner role. Keep that exceptional path explicit here rather than
 * teaching the ordinary migrator about individual migration timestamps.
 */
export type ProtectedMigration = Readonly<{
  id: string
  migrationTag: string
  protectedOwner: string
  wrapper: string
}>

export const protectedMigrationRegistry = [
  {
    id: 'vnext-runtime-foundation-a1',
    migrationTag: '0034_vnext_phase0_a1_runtime_foundation',
    protectedOwner: 'forge_runtime_routines_owner',
    wrapper: 'scripts/ci/apply-vnext-phase0-a1-runtime-foundation.sh',
  },
] as const satisfies readonly ProtectedMigration[]

/**
 * This checked-in fixture is deliberately not a database migration. It proves
 * that the registry can carry the next protected migration without inventing
 * its schema, creator, cutover, or #346/0035 ownership before that work exists.
 */
export const syntheticFutureProtectedMigration: ProtectedMigration = {
  id: 'synthetic-future-protected-migration',
  migrationTag: '0999_synthetic_future_protected_migration',
  protectedOwner: 'forge_synthetic_future_routines_owner',
  wrapper: 'scripts/ci/apply-synthetic-future-protected-migration.sh',
}

export function protectedMigrationForTag(tag: string, registry: readonly ProtectedMigration[] = protectedMigrationRegistry): ProtectedMigration | undefined {
  return registry.find((migration) => migration.migrationTag === tag)
}

export function protectedMigrationsInJournal(journalTags: readonly string[], registry: readonly ProtectedMigration[] = protectedMigrationRegistry): ProtectedMigration[] {
  const migrationsByTag = new Map(registry.map((migration) => [migration.migrationTag, migration]))
  return journalTags.flatMap((tag) => {
    const migration = migrationsByTag.get(tag)
    return migration ? [migration] : []
  })
}

export function protectedMigrationRecoveryPlan(input: Readonly<{
  journalTags: readonly string[]
  appliedTags: ReadonlySet<string>
  cleanupPendingTags: ReadonlySet<string>
  cleanupStateTags: ReadonlySet<string>
  registry?: readonly ProtectedMigration[]
}>): ProtectedMigration[] {
  const protectedMigrations = protectedMigrationsInJournal(input.journalTags, input.registry)
  for (const migration of protectedMigrations) {
    if (input.appliedTags.has(migration.migrationTag) && !input.cleanupStateTags.has(migration.migrationTag)) {
      throw new Error(`Applied protected migration '${migration.migrationTag}' has no durable handoff state; refusing an automatic migration restart.`)
    }
  }
  return protectedMigrations.filter((migration) => (
    !input.appliedTags.has(migration.migrationTag) || input.cleanupPendingTags.has(migration.migrationTag)
  ))
}
