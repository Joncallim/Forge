import { describe, expect, it } from 'vitest'
import { createEphemeralMigrationUrl, createMigrationChildEnvironment } from '@/scripts/ci/managed-migration-child-environment'
import { resolveBootstrapDatabaseUrls, runWithDatabaseUrlSentinel } from '@/scripts/ci/bootstrap-database-urls'

describe('managed migration child environment', () => {
  it('is an exact allowlist even under hostile administrator and libpq ambient input', () => {
    const result = createMigrationChildEnvironment(
      'postgresql://forge_migrator_0123456789abcdef0123456789abcdef:child-only@db/forge',
      {
        PATH: '/safe/bin',
        NODE_ENV: 'test',
        FORGE_DATABASE_ADMIN_URL: 'postgresql://admin:secret@db/forge',
        PGHOST: 'hostile-host',
        PGUSER: 'admin',
        PGPASSWORD: 'secret',
        DATABASE_URL: 'postgresql://admin:secret@db/forge',
        UNRELATED_SECRET: 'must-not-cross',
      },
    )
    expect(result).toEqual({
      PATH: '/safe/bin',
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://forge_migrator_0123456789abcdef0123456789abcdef:child-only@db/forge',
      FORGE_MANAGED_DOCKER_MIGRATIONS: '0',
    })
  })

  it('rejects a non-ephemeral database identity', () => {
    expect(() => createMigrationChildEnvironment('postgresql://forge:secret@db/forge', {})).toThrow(
      'Managed migration child environment crossed the administrator authority boundary.',
    )
  })

  it('encodes native socket routing without leaking an administrator identity or PG environment', () => {
    const result = createEphemeralMigrationUrl(
      'postgresql:///forge?user=application&password=application-secret',
      'forge_migrator_0123456789abcdef0123456789abcdef',
      'child-secret',
      { PGHOST: '/var/run/postgresql', PGPORT: '55441' },
    )
    expect(result).toContain('postgresql://forge_migrator_0123456789abcdef0123456789abcdef:child-secret@localhost/forge')
    expect(result).toContain('host=%2Fvar%2Frun%2Fpostgresql')
    expect(result).toContain('port=55441')
    expect(result).not.toContain('application')
  })

  it('keeps the ambient URL stable across concurrent explicit bootstrap work', async () => {
    const previous = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgresql://ambient-app:sentinel@ambient.invalid/forge'
    try {
      const observed = await runWithDatabaseUrlSentinel(async () => {
        const urls = resolveBootstrapDatabaseUrls({
          adminUrl: 'postgresql://explicit-admin:secret@admin.invalid/forge',
          migrationUrl: 'postgresql://forge_migrator_0123456789abcdef0123456789abcdef:secret@migration.invalid/forge',
        })
        await Promise.all([Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 5))])
        expect(process.env.DATABASE_URL).toBe('postgresql://ambient-app:sentinel@ambient.invalid/forge')
        return urls
      })
      expect(observed.adminUrl).toContain('explicit-admin')
      expect(observed.migrationUrl).toContain('forge_migrator_')
      expect(JSON.stringify(observed)).not.toContain('ambient-app')
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })
})
