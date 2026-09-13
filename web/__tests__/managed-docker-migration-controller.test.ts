import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const controller = readFileSync(fileURLToPath(new URL('../scripts/managed-docker-migration-controller.ts', import.meta.url)), 'utf8')
const compose = readFileSync(fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)), 'utf8')
describe('managed Docker migration authority', () => {
  it('holds application quiescence through the complete protected lifecycle', () => {
    for (const role of ['forge_schema_owner', 'forge_migrator_', 'forge_runtime_api_login', 'forge']) expect(controller).toContain(role)
    expect(controller).toContain('connection limit 1')
    expect(controller).toContain('pg_advisory_lock')
    expect(controller).toContain('reassign owned by forge to forge_schema_owner')
    expect(controller).toContain("usename=any(array['forge','forge_runtime_api_login'])")
    expect(controller.indexOf('revoke connect on database')).toBeLessThan(controller.indexOf("apply-vnext-phase0-a1-runtime-foundation.sh"))
    expect(controller.indexOf("apply-vnext-phase0-a1-runtime-foundation.sh")).toBeLessThan(controller.indexOf('reconcile-forge-app-privileges.sql'))
    expect(controller.indexOf('reconcile-forge-app-privileges.sql')).toBeLessThan(controller.indexOf('await assertProtectedMigrationLiveAttestation'))
    expect(controller.indexOf('await assertProtectedMigrationLiveAttestation')).toBeLessThan(controller.indexOf('await closeLifecycleCas'))
    expect(controller.indexOf('await closeLifecycleCas')).toBeLessThan(controller.lastIndexOf('grant connect on database'))
    expect(compose).toContain('POSTGRES_USER: ${POSTGRES_USER:-forge_admin}')
    expect(compose).toContain('postgresql://forge:${FORGE_APP_DATABASE_PASSWORD')
  })

  it('passes the ephemeral credential only to the child and cleans it up on all outcomes', () => {
    expect(controller).toContain('DATABASE_URL: migrationUrl(adminUrl, migrator, migratorPassword)')
    expect(controller).toContain("FORGE_MANAGED_DOCKER_MIGRATIONS: '0'")
    expect(controller).toContain('drop role if exists ${safe(migrator)}')
    expect(controller).toContain('finally')
    expect(controller).not.toContain('prepareManagedDockerMigration')
  })

  it('attests and rejects any remaining application-owned public object before reconnect', () => {
    expect(controller).toContain("relowner='forge'::regrole")
    expect(controller).toContain('Managed Docker app ownership reconciliation did not reach the required boundary.')
    expect(controller).toContain('Managed Docker protected migration did not close its durable cleanup state.')
  })
})
