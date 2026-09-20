import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
const composeAdminUpgradeProof = sourceFor('../../scripts/ci/prove-compose-postgres-admin-upgrade.sh')
const legacyRepairProof = sourceFor('../scripts/ci/prove-installer-legacy-migration-repair.sh')
const populatedUpgradeProof = sourceFor('../scripts/ci/prove-migration-0027-upgrade.sh')
const populatedUpgradeAssertions = sourceFor('../scripts/ci/sql/migration-0027-expansion-assertions.sql')
const installer = sourceFor('../../scripts/install.sh')
const controller = sourceFor('../scripts/managed-docker-migration-controller.ts')
const childBoundary = sourceFor('../scripts/ci/assert-migration-child-boundary.ts')
const webCi = sourceFor('../../.github/workflows/web-ci.yml')
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
      const closure = JSON.parse(readFileSync(join(output, 'closure-manifest.json'), 'utf8')) as { files: Array<{ name: string }> }
      const closureNames = closure.files.map((entry) => entry.name)
      expect(closureNames).toContain('migrate-through-0034.mjs')
      expect(closureNames).toContain('db/migrations/meta/_journal.json')
      expect(closureNames).toContain('db/migrations/0034_vnext_phase0_a1_runtime_foundation.sql')
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
    expect(installer).toContain('--native-helper-root "$MANAGED_HELPER_ROOT"')
    expect(installer).toContain('closure-manifest.json')
    expect(installer).toContain('Managed migration helper bytes do not match the independently pinned release digest')
    expect(installer).toContain('crypto.createHash("sha256").update(rebuilt).digest("hex")!==expected')
    expect(installer).toContain('node-v$version-darwin-$architecture.tar.xz')
    expect(installer).toContain('5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1')
    expect(installer).toContain('96dff79f4e19a78715da559ec7cac2028f4985a175ea0c3454625a269c21deb7')
    expect(installer).toContain('root="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/forge-node-darwin.XXXXXX")" || return 1')
    expect(installer.match(/\/bin\/rm -rf "\$root"/g)?.length).toBeGreaterThanOrEqual(5)
    expect(installer).toContain('root_group="$(/usr/bin/id -gn 0)"')
    expect(controller).toContain("assertInstalledHelperFile(legacyRepairSql, 'legacy repair artifact')")
    expect(controller).toContain('process.chdir(helperRoot)')
    expect(controller).not.toContain('--native-child-tsx')
  })

  it('rejects modified helper bytes against the release pin before elevation', () => {
    const output = mkdtempSync(join(tmpdir(), 'forge-managed-helper-hostile-'))
    try {
      execFileSync(process.execPath, [pathFor('../scripts/ci/build-managed-migration-helper.mjs'), output], { cwd: pathFor('..'), env: { HOME: tmpdir(), PATH: '/usr/bin:/bin', NODE_ENV: 'test' } })
      const pin = installer.match(/digest='([0-9a-f]{64})'/)?.[1]
      expect(readFileSync(join(output, 'bundle.sha256'), 'utf8').trim()).toBe(pin)
      const packPath = join(output, 'bundle.pack')
      const pack = JSON.parse(readFileSync(packPath, 'utf8')) as { version: number; files: Array<{ name: string; bytes: number; sha256: string; content: string }> }
      const controllerEntry = pack.files.find((entry) => entry.name === 'controller.mjs')!
      const changed = Buffer.concat([Buffer.from(controllerEntry.content, 'base64'), Buffer.from('\n// hostile checkout mutation\n')])
      controllerEntry.content = changed.toString('base64')
      controllerEntry.bytes = changed.length
      controllerEntry.sha256 = createHash('sha256').update(changed).digest('hex')
      const changedPack = Buffer.from(`${JSON.stringify(pack)}\n`)
      expect(createHash('sha256').update(changedPack).digest('hex')).not.toBe(pin)
      writeFileSync(join(output, 'hostile.pack'), changedPack)
      symlinkSync(join(output, 'hostile.pack'), join(output, 'swapped.pack'))
      expect(createHash('sha256').update(readFileSync(join(output, 'swapped.pack'))).digest('hex')).not.toBe(pin)
      const installStart = installer.indexOf('install_managed_migration_helper()')
      expect(installer.indexOf('[ "$computed" = "$digest" ]', installStart)).toBeLessThan(installer.indexOf('if [ "${EUID:-$(/usr/bin/id -u)}" -ne 0 ]', installStart))
      expect(installer).toContain('Root\n    # never follows a checkout/build pathname')
      expect(installer).toContain('receive_bounded_privileged_stream "$pack_bytes" "$staging/bundle.pack"')
      expect(installer.indexOf('stream_digest=', installStart)).toBeLessThan(installer.indexOf('const pack=JSON.parse', installStart))
      expect(installer.indexOf('Managed migration helper Node.js changed before pack parsing.', installStart)).toBeLessThan(installer.indexOf('const pack=JSON.parse', installStart))
      expect(installer).not.toContain('"$build_dir/$name"')
      expect(installer).toContain('Installed managed migration helper Node.js digest changed during privileged copy.')
      expect(installer).toContain('Installed managed migration helper digest does not match its independently pinned release bundle.')
      expect(installer.indexOf('installed_node_digest=', installStart)).toBeLessThan(installer.indexOf('"$canonical_target/node" -e', installStart))
      expect(installer.indexOf('MANAGED_HELPER_ROOT="$canonical_target"', installStart)).toBeGreaterThan(installer.indexOf('digest does not match its independently pinned release bundle', installStart))
      expect(installer).toContain('install.sh is the operator-trusted entry boundary')
      const darwinStart = installer.indexOf('prepare_pinned_darwin_managed_node()')
      expect(installer.indexOf('receive_bounded_privileged_stream "$archive_bytes" "$staging/node.tar.xz"', darwinStart)).toBeLessThan(installer.indexOf('/usr/bin/tar -xJf "$staging/node.tar.xz"', darwinStart))
      expect(installer.indexOf('installed_digest=', darwinStart)).toBeLessThan(installer.indexOf('printf \'%s\\n\' "$target/node"', darwinStart))
      expect(installer).toContain('18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572')
      expect(installer).toContain('0b4f059915f3bf3c6cbb02422f4a529bfb21cbbec2d29851c9a5d833f78a04f6')
    } finally { rmSync(output, { recursive: true, force: true }) }
  })

  it('publishes helper paths with child-readable modes under a restrictive installer umask', () => {
    const build = mkdtempSync(join(tmpdir(), 'forge-managed-helper-mode-build-'))
    const output = mkdtempSync(join(tmpdir(), 'forge-managed-helper-mode-stage-'))
    try {
      execFileSync(process.execPath, [pathFor('../scripts/ci/build-managed-migration-helper.mjs'), build], {
        cwd: pathFor('..'), env: { HOME: tmpdir(), PATH: '/usr/bin:/bin', NODE_ENV: 'test' },
      })
      writeFileSync(join(output, 'bundle.pack'), readFileSync(join(build, 'bundle.pack')), { mode: 0o600 })
      chmodSync(output, 0o700)
      const unpack = installer.match(/"\$staging\/node" -e '\n([\s\S]*?)\n    ' "\$staging" \|\|/)?.[1]
      expect(unpack).toBeTruthy()
      execFileSync(process.execPath, ['-e', `process.umask(0o077);\n${unpack}`, output])
      for (const directory of ['db', 'db/migrations', 'db/migrations/meta']) {
        expect(statSync(join(output, directory)).mode & 0o777).toBe(0o755)
      }
      for (const file of ['controller.mjs', 'migrate-through-0034.mjs', 'db/migrations/0034_vnext_phase0_a1_runtime_foundation.sql', 'closure-manifest.json']) {
        expect(statSync(join(output, file)).mode & 0o777).toBe(0o444)
      }
      expect(installer).toContain('(leaf.mode&0o777)!==0o444')
      expect(installer).toContain('(stat.mode&0o777)!==0o755')
    } finally {
      rmSync(build, { recursive: true, force: true })
      rmSync(output, { recursive: true, force: true })
    }
  })

  it('bounds privileged stream receivers before hash or parse', () => {
    const output = mkdtempSync(join(tmpdir(), 'forge-managed-stream-'))
    try {
      const receive = (payload: string, expected: number, name: string) => spawnSync('/bin/bash', ['-c', `
        set -eu
        FORGE_INSTALL_LIBRARY=1 source "$1"
        receive_bounded_privileged_stream "$2" "$3"
      `, '_', pathFor('../../scripts/install.sh'), String(expected), join(output, name)], { input: payload, encoding: 'utf8' })
      expect(receive('exact', 5, 'exact').status).toBe(0)
      expect(receive('short', 6, 'short').status).not.toBe(0)
      expect(receive('oversized', 5, 'oversized').status).not.toBe(0)
      expect(installer).toContain('remaining=30')
      expect(installer).toContain('/bin/kill -TERM "$receiver"')
      expect(installer).toContain('pack_bytes=3627641')
      expect(installer).toContain('archive_bytes=25950400')
      expect(installer).toContain('archive_bytes=27517304')
    } finally { rmSync(output, { recursive: true, force: true }) }
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

  it('proves native administrator authority without a spoofable TCP-to-socket proxy', () => {
    expect(webCi).toContain('--auth-local peer --auth-host scram-sha-256')
    expect(webCi).toContain("-c listen_addresses='localhost'")
    expect(webCi).toContain('pg_isready" --host "$native_socket"')
    expect(webCi).toContain("ALTER ROLE CURRENT_USER PASSWORD 'forge_native_admin_test'")
    expect(webCi).toContain('FORGE_LEGACY_REPAIR_ADMIN_URL="postgresql://$native_user:forge_native_admin_test@localhost:5433/forge"')
    expect(webCi).not.toContain('socat TCP-LISTEN:5433')
    expect(webCi).not.toContain('--auth trust')
  })

  it('converges the reserved legacy Compose administrator transition without exposing its credential', () => {
    expect(compose).toContain('dockerfile: Dockerfile.postgres-admin-upgrade')
    expect(adminUpgrade).toContain("'\\getenv admin_password PGPASSWORD'")
    expect(adminUpgrade).not.toMatch(/-v\s+admin_password|--variable[= ]admin_password/)
    expect(adminUpgrade).toContain("r.rolname='forge_admin_transition'")
    expect(adminUpgrade).toContain('not exists(select 1 from pg_auth_members')
    expect(adminUpgrade).toContain('not exists(select 1 from pg_shdepend')
    expect(adminUpgrade).toContain('expected_databases(datname, datistemplate, datallowconn)')
    expect(adminUpgrade).toContain("('postgres'::name, false, true)")
    expect(adminUpgrade).toContain("('template0'::name, true, false)")
    expect(adminUpgrade).toContain("('template1'::name, true, true)")
    expect(adminUpgrade).toContain('expected_tablespaces(spcname) as (')
    expect(adminUpgrade).toContain("values ('pg_default'::name), ('pg_global'::name)")
    expect(adminUpgrade).toContain('current_database() not in')
    expect(adminUpgrade).not.toContain("r.rolname='forge' or")
    expect(adminUpgrade).toContain('FORGE_ADMIN_UPGRADE_FAIL_AFTER_CREATE')
    expect(adminUpgrade).toContain('FORGE_ADMIN_UPGRADE_FAIL_AFTER_FENCE')
    expect(adminUpgrade).toContain('FORGE_ADMIN_UPGRADE_FAIL_AFTER_RENAME')
    expect(adminUpgrade).toContain('nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls')
    expect(adminUpgrade).toContain('pg_terminate_backend(pid, 5000)')
    expect(adminUpgrade).toContain("backend_type = 'client backend' and usename = :'legacy_role'")
    expect(adminUpgrade).toContain('administrator role failed exact ownership and cluster-scope attestation')
    expect(adminUpgrade).toContain('FORGE_ADMIN_UPGRADE_TEST_HOLD_AFTER_FENCE_SECONDS')
    expect(adminUpgrade).toContain('alter role forge_admin login superuser createdb createrole replication bypassrls password')
    expect(adminUpgrade).toContain('drop role forge_admin_transition')
    expect(composeAdminUpgradeProof).toContain('official custom POSTGRES_USER/OID-10 initdb ownership succeeds')
    expect(composeAdminUpgradeProof).toContain('for legacy_role in custom_owner forge')
    expect(composeAdminUpgradeProof).toContain('forge_admin_upgrade_foreign')
    expect(composeAdminUpgradeProof).toContain('forge_admin_upgrade_foreign_tablespace')
    expect(composeAdminUpgradeProof).toContain('nonstandard tablespace blocks the custom administrator rename without mutation')
    expect(composeAdminUpgradeProof).toContain('failed second-database refusal changed role or database state')
    expect(composeAdminUpgradeProof).toContain('pre-existing hostile legacy session is fenced')
    expect(composeAdminUpgradeProof).toContain('FORGE_ADMIN_UPGRADE_TEST_HOLD_AFTER_FENCE_SECONDS=8')
    expect(composeAdminUpgradeProof).toContain('hostile legacy session introduced a foreign database, tablespace, or object during transition')
    expect(composeAdminUpgradeProof).toContain('durable legacy fence interruption recovers and then converges idempotently')
    expect(composeAdminUpgradeProof).toContain('COMPOSE_POSTGRES_ADMIN_UPGRADE_TOPOLOGY_PROOF_PASSED')
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

  it('uses the full production native migration boundary in the legacy proof', () => {
    const sequence = legacyRepairProof.slice(
      legacyRepairProof.indexOf('run_managed_sequence()'),
      legacyRepairProof.indexOf("echo 'Proving accepted S4 boundary variants"),
    )
    expect(sequence).toContain('run_managed_local_migrations')
    expect(sequence).toContain('FORGE_INSTALL_TEST_PSQL_SOCKET')
    expect(sequence).toContain('FORGE_INSTALL_TEST_PSQL_PORT')
    expect(sequence).not.toContain('run_managed_local_migration_sequence')
    expect(sequence).not.toContain('resolve_managed_local_admin')
    expect(sequence).not.toContain('MANAGED_LOCAL_ADMIN_MODE=current')
    expect(legacyRepairProof).toContain('chmod 0600 "$managed_env"')
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
