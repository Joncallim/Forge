import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const installer = sourceFor('../../scripts/install.sh')
const controller = sourceFor('../scripts/managed-docker-migration-controller.ts')
const childBoundary = sourceFor('../scripts/ci/assert-migration-child-boundary.ts')
const compose = sourceFor('../../docker-compose.yml')
const migrationDockerfile = sourceFor('../Dockerfile.migration')
const adminUpgrade = sourceFor('../../scripts/ci/upgrade-compose-postgres-admin.sh')
const reconciler = sourceFor('../../scripts/reconcile-forge-app-privileges.sql')
const protectedState = sourceFor('../scripts/ci/protected-migration-state.ts')
const packageJson = JSON.parse(sourceFor('../package.json')) as { devDependencies?: Record<string, string> }
const journal = JSON.parse(sourceFor('../db/migrations/meta/_journal.json')) as {
  entries: Array<{ idx: number; when: number }>
}

describe('installer-managed migration proof', () => {
  it('builds a checkout-independent finite privileged helper with an audited import closure', () => {
    expect(packageJson.devDependencies?.esbuild).toBe('0.28.1')
    const output = mkdtempSync(join(tmpdir(), 'forge-managed-helper-test-'))
    try {
      execFileSync(process.execPath, [pathFor('../scripts/ci/build-managed-migration-helper.mjs'), output], {
        cwd: pathFor('..'),
        env: { HOME: tmpdir(), PATH: '/usr/bin:/bin', NODE_ENV: 'test' },
      })
      const metafile = JSON.parse(readFileSync(join(output, 'metafile.json'), 'utf8')) as {
        outputs: Record<string, { imports?: Array<{ path: string; external?: boolean }> }>
        forgeVerifiedAbsoluteInputs: string[]
        forgeVerifiedVirtualInputs: string[]
      }
      const allowedBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
      expect(metafile.forgeVerifiedAbsoluteInputs.length).toBeGreaterThan(0)
      expect(metafile.forgeVerifiedAbsoluteInputs.every((input) => input.startsWith(pathFor('..')))).toBe(true)
      expect(metafile.forgeVerifiedAbsoluteInputs).not.toEqual(expect.arrayContaining([
        expect.stringContaining('/lib/load-env'),
        expect.stringContaining('/node_modules/@next/env/'),
      ]))
      expect(metafile.forgeVerifiedVirtualInputs).toEqual(['forge-managed-helper:explicit-environment'])
      expect(Object.values(metafile.outputs).flatMap((outputEntry) => outputEntry.imports ?? [])
        .every((entry) => entry.external && allowedBuiltins.has(entry.path))).toBe(true)
      const startup = spawnSync(process.execPath, [join(output, 'controller.mjs'), '--run'], {
        cwd: tmpdir(), env: { NODE_ENV: 'test' }, encoding: 'utf8',
      })
      expect(startup.status).toBe(1)
      expect(startup.stderr).toContain('Missing required controller environment value')
      expect(startup.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package|Dynamic require/)
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })

  it('installs and re-verifies every native helper artifact before admin resolution', () => {
    const preAuthorityBoundary = installer.indexOf('# Package and verify the finite privileged helper')
    const helperInstall = installer.indexOf('install_managed_migration_helper', preAuthorityBoundary)
    const adminResolution = installer.indexOf('resolve_managed_local_admin', preAuthorityBoundary)
    expect(preAuthorityBoundary).toBeGreaterThan(-1)
    expect(helperInstall).toBeGreaterThan(preAuthorityBoundary)
    expect(adminResolution).toBeGreaterThan(helperInstall)
    expect(installer).toContain('--native-legacy-repair-sql "$MANAGED_HELPER_ROOT/epic-172-legacy-0023-0025-v1.sql"')
    expect(installer).toContain('"$canonical_target/epic-172-legacy-0023-0025-v1.sql" "$canonical_target/node"')
    expect(installer).toContain('digest.digest("hex")!==expected')
    expect(installer).toContain('Homebrew/user-owned Node cannot cross the privileged helper boundary')
    expect(installer).toContain('root_group="$(/usr/bin/id -gn 0)"')
    expect(controller).toContain("assertInstalledHelperFile(legacyRepairSql, 'legacy repair artifact')")
  })

  it('keeps Docker dependency installation credential-free and children distinct from the controller', () => {
    expect(migrationDockerfile).toContain('npm ci --ignore-scripts')
    expect(migrationDockerfile).not.toMatch(/DATABASE_URL|POSTGRES_PASSWORD|FORGE_DATABASE_ADMIN_URL/)
    expect(compose).not.toContain('./web:/forge/web')
    expect(compose).toContain('pg_isready -U forge_admin')
    expect(controller).toContain("line.startsWith('node:')")
    expect(controller).toContain("uid === process.getuid?.()")
    expect(childBoundary).toContain('`/proc/${controllerPid}/environ`')
  })

  it('converges the reserved legacy Compose administrator transition without exposing its credential', () => {
    expect(compose).toContain('dockerfile: Dockerfile.postgres-admin-upgrade')
    expect(adminUpgrade).toContain("'\\getenv admin_password PGPASSWORD'")
    expect(adminUpgrade).not.toMatch(/-v\s+admin_password|--variable[= ]admin_password/)
    expect(adminUpgrade).toContain("r.rolname='forge_admin_transition'")
    expect(adminUpgrade).toContain('not exists(select 1 from pg_auth_members')
    expect(adminUpgrade).toContain('not exists(select 1 from pg_shdepend')
    expect(adminUpgrade).toContain('FORGE_ADMIN_UPGRADE_FAIL_AFTER_CREATE')
    expect(adminUpgrade).toContain('FORGE_ADMIN_UPGRADE_FAIL_AFTER_RENAME')
    expect(adminUpgrade).toContain('drop role forge_admin_transition')
  })

  it('recovers all historical owner memberships and keeps controller state outside broad app grants', () => {
    expect(protectedState).toContain("'forge_release_routines_owner'")
    const reassign = controller.indexOf('reassign owned by ${safe(migrator)} to forge_schema_owner')
    const dropOwned = controller.indexOf('drop owned by ${safe(migrator)}')
    expect(reassign).toBeGreaterThan(-1)
    expect(dropOwned).toBeGreaterThan(reassign)
    expect(reconciler).toContain('REVOKE ALL PRIVILEGES ON TABLE public.forge_protected_migration_handoffs FROM PUBLIC, forge, forge_runtime_api, forge_runtime_api_login;')
    expect(sourceFor('../../scripts/repair.sh')).toContain('run_managed_local_migrations')
  })

  it('routes the hosted TCP fixture through the shared Docker controller', () => {
    expect(managedInstallerProof).toContain('scripts/managed-docker-migration-controller.ts --run')
    expect(managedInstallerProof).toContain('FORGE_MANAGED_DOCKER_MIGRATIONS=1')
    expect(managedInstallerProof).toContain('/usr/bin/sudo -n')
    expect(managedInstallerProof).not.toContain('run_managed_local_migration_sequence')
    expect(managedInstallerProof).not.toContain('FORGE_S5_FORCE_HANDOFF_FAILURE')
    expect(managedInstallerProof).not.toContain('FORGE_REGISTRY_FORCE_HANDOFF_FAILURE')
  })

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
