import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const proof = readFileSync(
  fileURLToPath(new URL('../../scripts/ci/prove-installer-managed-migrations.sh', import.meta.url)),
  'utf8',
)

describe('installer-managed migration proof', () => {
  it('derives the exact latest ledger from the authoritative Drizzle journal', () => {
    expect(proof).toContain('MIGRATION_JOURNAL="$REPO_ROOT/web/db/migrations/meta/_journal.json"')
    expect(proof).toContain('process.stdout.write(`${entries.length} ${entries.at(-1).when}\\n`);')
    expect(proof).toContain('--set expected_migration_count="$EXPECTED_MIGRATION_COUNT"')
    expect(proof).toContain('--set expected_latest_migration_at="$EXPECTED_LATEST_MIGRATION_AT"')
    expect(proof).toContain("current_setting('forge.proof_expected_migration_count')::bigint")
    expect(proof).toContain("current_setting('forge.proof_expected_latest_migration_at')::bigint")

    expect(proof).not.toMatch(/__drizzle_migrations\)\s*<>\s*\d+/)
    expect(proof).not.toMatch(/max\(created_at\)[\s\S]{0,80}<>\s*\d+/)
  })
})
