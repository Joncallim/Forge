import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function pathFor(relativePath: string) {
  return fileURLToPath(new URL(relativePath, import.meta.url))
}

function sourceFor(relativePath: string) {
  return readFileSync(pathFor(relativePath), 'utf8')
}

const helperPath = pathFor('../../scripts/ci/current-migration-ledger.sh')
const helper = readFileSync(helperPath, 'utf8')
const managedInstallerProof = sourceFor('../../scripts/ci/prove-installer-managed-migrations.sh')
const legacyRepairProof = sourceFor('../scripts/ci/prove-installer-legacy-migration-repair.sh')
const populatedUpgradeProof = sourceFor('../scripts/ci/prove-migration-0027-upgrade.sh')
const populatedUpgradeAssertions = sourceFor('../scripts/ci/sql/migration-0027-expansion-assertions.sql')
const journal = JSON.parse(sourceFor('../db/migrations/meta/_journal.json')) as {
  entries: Array<{ idx: number; when: number }>
}

describe('installer-managed migration proof', () => {
  it('derives the exact current ledger once from the authoritative Drizzle journal', () => {
    const expectations = execFileSync(
      'bash',
      [
        '-c',
        'set -euo pipefail; source "$1"; printf "%s %s" "$FORGE_CURRENT_MIGRATION_COUNT" "$FORGE_CURRENT_LATEST_MIGRATION_AT"',
        'bash',
        helperPath,
      ],
      { encoding: 'utf8' },
    )

    expect(expectations).toBe(`${journal.entries.length} ${journal.entries.at(-1)?.when}`)
    expect(helper).toContain('entry.idx !== index')
    expect(helper).toContain('entry.when <= entries[index - 1].when')
    expect(helper).toContain('FORGE_CURRENT_MIGRATION_COUNT="$migration_count"')
    expect(helper).toContain('FORGE_CURRENT_LATEST_MIGRATION_AT="$latest_migration_at"')
  })

  it('binds every current-latest proof to the shared expectations without numeric tip pins', () => {
    for (const proof of [managedInstallerProof, legacyRepairProof, populatedUpgradeProof]) {
      expect(proof).toContain('source "$REPO_ROOT/scripts/ci/current-migration-ledger.sh"')
      expect(proof).toContain('--set expected_migration_count="$FORGE_CURRENT_MIGRATION_COUNT"')
      expect(proof).toContain('--set expected_latest_migration_at="$FORGE_CURRENT_LATEST_MIGRATION_AT"')
    }

    for (const sql of [managedInstallerProof, legacyRepairProof, populatedUpgradeAssertions]) {
      expect(sql).toContain(
        "pg_catalog.set_config('forge.proof_expected_migration_count', :'expected_migration_count', false)",
      )
      expect(sql).toContain(
        "pg_catalog.set_config('forge.proof_expected_latest_migration_at', :'expected_latest_migration_at', false)",
      )
      expect(sql).toContain("current_setting('forge.proof_expected_migration_count')::bigint")
      expect(sql).toContain("current_setting('forge.proof_expected_latest_migration_at')::bigint")
      expect(sql).not.toMatch(/__drizzle_migrations\)\s*<>\s*\d+/)
      expect(sql).not.toMatch(/max\(created_at\)[\s\S]{0,80}<>\s*\d+/)
      expect(sql).not.toContain(String(journal.entries.at(-1)?.when))
    }

    expect(populatedUpgradeAssertions).toContain('created_at = 1784270400000')
    expect(populatedUpgradeAssertions).toContain('created_at = 1784274000000')
  })
})
