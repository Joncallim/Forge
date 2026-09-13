import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const controller = readFileSync(fileURLToPath(new URL('../scripts/managed-docker-migration-controller.ts', import.meta.url)), 'utf8')
const state = readFileSync(fileURLToPath(new URL('../scripts/ci/protected-migration-state.ts', import.meta.url)), 'utf8')
const installer = readFileSync(fileURLToPath(new URL('../../scripts/install.sh', import.meta.url)), 'utf8')
const bootstrapSources = [
  'bootstrap-epic-172-release-roles.ts', 'bootstrap-epic-172-s3-release-owner.ts',
  'bootstrap-epic-172-s4-roles.ts', 'bootstrap-epic-172-s5-recovery-owner.ts',
  'repair-epic-172-legacy-release.ts',
].map((file) => readFileSync(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), 'utf8'))
const compose = readFileSync(fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)), 'utf8')
const serviceBlock = (name: string) => {
  const start = compose.indexOf(`  ${name}:`)
  const remainder = compose.slice(start + `  ${name}:`.length)
  const nextService = remainder.search(/\n  [a-z][^:\n]*:/)
  return compose.slice(start, nextService < 0 ? undefined : start + `  ${name}:`.length + nextService)
}
describe('managed Docker migration authority', () => {
  it('holds application quiescence through the complete protected lifecycle', () => {
    for (const role of ['forge_schema_owner', 'forge_migrator_', 'forge_runtime_api_login', 'forge']) expect(controller).toContain(role)
    expect(state).toContain('connection limit 1')
    expect(state.indexOf('lockAndValidateExistingControllerState(tx')).toBeLessThan(state.indexOf('alter role ${safeRole(role.migrationRole)} nologin'))
    expect(state).toContain('durableAclDigest(existing.databaseName')
    expect(state).toContain('durable ACL role identity changed')
    expect(controller).toContain('pg_advisory_lock')
    expect(controller).toContain('reassign owned by forge to forge_schema_owner')
    for (const bootstrap of [
      'runEpic172ReleaseRoleBootstrap', 'runEpic172S3OwnerBootstrap',
      'runEpic172LegacyReleaseRepair', 'runEpic172S4RoleBootstrap', 'runEpic172S5OwnerBootstrap',
    ]) expect(controller).toContain(bootstrap)
    expect(controller).toContain('runWithDatabaseUrlSentinel')
    expect(controller).toContain("env: childEnv")
    expect(controller).toContain('selectEphemeralChildUid')
    expect(controller).toContain("scripts/ci/assert-migration-child-boundary.ts")
    expect(controller).toContain('process.setgroups?.([])')
    expect(controller).toContain('reserved = await pool.reserve()')
    expect(controller.match(/const pool = postgres\(/g)).toHaveLength(1)
    expect(controller).toContain('adminClient: sql, migrationRole: migrator')
    expect(controller).toContain('if (nativeAdminSocketOpened) throw new Error(NATIVE_AUTHORITY_LOST)')
    expect(controller).toContain("process.env.CI !== 'true'")
    for (const source of bootstrapSources) {
      expect(source).not.toMatch(/postgres\((?:adminUrl|migrationUrl)/)
      expect(source).toMatch(/openBootstrap(?:Admin|DatabaseContext)/)
    }
    expect(controller).toContain("usename=any(array['forge','forge_runtime_api_login'])")
    expect(controller.indexOf('revoke connect on database')).toBeLessThan(controller.indexOf('migrate-through-0034.ts'))
    expect(controller.indexOf('migrate-through-0034.ts')).toBeLessThan(controller.lastIndexOf('reconcile-forge-app-privileges.sql'))
    expect(controller.lastIndexOf('reconcile-forge-app-privileges.sql')).toBeLessThan(controller.lastIndexOf('await assertProtectedMigrationLiveAttestation'))
    expect(controller.indexOf('await assertProtectedMigrationLiveAttestation')).toBeLessThan(controller.indexOf('await closeLifecycleCas'))
    expect(controller.indexOf('await closeLifecycleCas')).toBeLessThan(controller.lastIndexOf('await restoreDatabaseAcl'))
    expect(controller).toContain("membership.inherit_option")
    expect(controller).toContain("grant.grantee === 'PUBLIC' ? 'public'")
    expect(controller).toContain('set local role ${quoteCatalogIdentifier(grant.grantor)}; revoke connect')
    expect(controller).toContain('Managed migration did not restore the exact database ACL snapshot including grantors.')
    expect(controller).toContain('prepareProtectedMigrationController')
    expect(state.indexOf('create role ${safeRole(migrationRole)}')).toBeLessThan(state.indexOf("controller_phase='prepared'"))
    expect(controller).toContain('grantorOid')
    expect(controller).toContain("controller_phase='complete'")
    expect(controller).toContain('operation_id=${operationId}::uuid')
    expect(compose).toContain('POSTGRES_USER: ${POSTGRES_USER:-forge_admin}')
    expect(compose).toContain('postgresql://forge:${FORGE_APP_DATABASE_PASSWORD')
  })

  it('keeps administrator and migrator secrets in the one-shot migration lane', () => {
    const migration = serviceBlock('migration')
    const web = serviceBlock('web')
    const worker = serviceBlock('worker')
    expect(migration).toContain('FORGE_DATABASE_ADMIN_URL')
    expect(migration).toContain('FORGE_RUNTIME_API_DATABASE_PASSWORD')
    for (const longLivedService of [web, worker]) {
      expect(longLivedService).not.toContain('FORGE_DATABASE_ADMIN_URL')
      expect(longLivedService).not.toContain('POSTGRES_PASSWORD')
      expect(longLivedService).toContain('FORGE_RUNTIME_DATABASE_URL')
    }
    expect(web).toContain('service_completed_successfully')
    expect(worker).toContain('service_completed_successfully')
  })

  it('passes the ephemeral credential only to the child and cleans it up on all outcomes', () => {
    expect(controller).toContain('createMigrationChildEnvironment(ephemeralMigrationUrl, process.env, childPrivateDirectory)')
    expect(controller).toContain('createEphemeralMigrationUrl(applicationUrl, migrator, migratorPassword)')
    expect(readFileSync(fileURLToPath(new URL('../scripts/ci/managed-migration-child-environment.ts', import.meta.url)), 'utf8')).toContain("FORGE_MANAGED_DOCKER_MIGRATIONS: '0'")
    expect(controller).not.toContain('FORGE_DATABASE_ADMIN_URL: adminUrl')
    expect(controller).not.toContain('...process.env')
    expect(controller).not.toContain('PGHOST:')
    expect(controller).not.toContain('FORGE_DATABASE_ADMIN_URL: adminUrl')
    expect(controller).toContain('drop role ${safe(migrator)}')
    expect(controller).toContain('application reconnect authority remains fenced')
    expect(controller).toContain('finally')
    expect(controller).not.toContain('prepareManagedDockerMigration')
    expect(controller).not.toMatch(/process\.env\.DATABASE_URL\s*=/)
    for (const source of bootstrapSources) {
      expect(source).not.toMatch(/process\.env\.DATABASE_URL\s*=/)
      expect(source).toContain('explicit')
    }
  })

  it('attests and rejects any remaining application-owned public object before reconnect', () => {
    expect(controller).toContain("dependency.deptype='o'")
    expect(controller).toContain('refused forge-owned shared objects outside the exact current database')
    expect(controller).toContain("relowner='forge'::regrole")
    expect(controller).toContain('Managed Docker app ownership reconciliation did not reach the required boundary.')
    expect(controller).toContain('Managed Docker protected migration cleanup state changed before its CAS close.')
  })

  it('routes native managed installs through the same single controller', () => {
    const sequence = installer.slice(
      installer.indexOf('run_managed_local_migration_sequence()'),
      installer.indexOf('\n}\n', installer.indexOf('run_managed_local_migration_sequence()')) + 2,
    )
    expect(sequence.match(/run_managed_local_migration_stage/g)).toHaveLength(1)
    expect(sequence).toContain('controller')
    const dispatch = installer.slice(installer.indexOf('run_managed_local_controller()'), installer.indexOf('\n}\n', installer.indexOf('run_managed_local_controller()')) + 2)
    expect(dispatch).toContain('/usr/bin/env -i')
    expect(dispatch).toContain('--native-socket')
    expect(dispatch).toContain('--native-env-file')
    expect(dispatch).not.toContain('preserve-environment')
    expect(dispatch).not.toContain('preserve-env=')
    expect(dispatch).not.toContain('DATABASE_URL')
    expect(dispatch).not.toContain('FORGE_DATABASE_ADMIN_URL')
    expect(dispatch).not.toMatch(/PG(?:HOST|PORT|USER)/)
    expect(installer).not.toMatch(/controller\) FORGE_MANAGED_DOCKER_MIGRATIONS=1 npm run db:migrate/)
    expect(controller).toContain('process.chdir(helperRoot)')
    expect(controller).toContain("execFileAsync('/usr/bin/id', ['-nu', String(peerUid)])")
    expect(controller).toContain('resolvedPeerUid !== peerUid || resolvedPeerGid !== peerGid')
    expect(dispatch).toContain('--native-helper-root')
    expect(dispatch).not.toContain('--native-repo-root')
    expect(dispatch).not.toContain('--native-child-tsx')
    expect(controller).toContain("const protectedValues = parseProtectedEnvFile(await readFile(envFile, 'utf8'))")
    expect(controller).toContain("key === 'DATABASE_URL' || key === 'FORGE_DATABASE_ADMIN_URL' || key.startsWith('PG')")
  })

  it('executes the native controller with no inherited database authority environment', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'forge-native-controller-env-'))
    const envFile = resolve(directory, 'forge.env')
    writeFileSync(envFile, 'DATABASE_URL=postgresql://forge:secret@localhost/wrong_database\n', { mode: 0o600 })
    const args = ['tsx', 'scripts/managed-docker-migration-controller.ts', '--run',
      '--native-socket', '/var/run/postgresql', '--native-port', '5432', '--native-database', 'forge',
      '--native-env-file', envFile,
      '--native-helper-root', dirname(process.cwd()), '--native-peer-uid', '1', '--native-peer-gid', '1',
      '--native-child-node', '/usr/bin/gnutrue',
      '--native-reconcile-sql', '/usr/bin/gnutrue', '--native-legacy-repair-sql', '/usr/bin/gnutrue']
    const invoke = (env: NodeJS.ProcessEnv) => {
      try { execFileSync('npx', args, { cwd: process.cwd(), env, encoding: 'utf8', stdio: 'pipe' }); return '' }
      catch (error) { return `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}` }
    }
    try {
      const cleanOutput = invoke({ PATH: process.env.PATH, NODE_ENV: 'test' })
      expect(cleanOutput).toContain('Managed native assert-migration-child-boundary child is not a regular installed file')
      expect(cleanOutput).not.toContain('inherited a forbidden database authority environment')
      expect(invoke({ PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: 'postgresql://ambient-admin:secret@host/forge' }))
        .toContain('inherited a forbidden database authority environment')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
