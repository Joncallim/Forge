import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const controller = readFileSync(fileURLToPath(new URL('../scripts/managed-docker-migration-controller.ts', import.meta.url)), 'utf8')
const compose = readFileSync(fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)), 'utf8')
describe('managed Docker migration authority', () => {
  it('uses the five-identity boundary and never gives the app superuser authority', () => {
    for (const role of ['forge_admin', 'forge_schema_owner', 'forge_migrator_', 'forge_runtime_api_login', 'forge']) expect(controller).toContain(role)
    expect(controller).toContain('connection limit 1')
    expect(controller).toContain('pg_advisory_lock')
    expect(controller).toContain('reassign owned by forge to forge_schema_owner')
    expect(controller).toContain("usename = any(array['forge','forge_runtime_api_login'])")
    expect(compose).toContain('POSTGRES_USER: ${POSTGRES_USER:-forge_admin}')
    expect(compose).toContain('postgresql://forge:${FORGE_APP_DATABASE_PASSWORD')
  })
})
