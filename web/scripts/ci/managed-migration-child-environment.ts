export type MigrationChildEnvironment = NodeJS.ProcessEnv & Readonly<{
  PATH: string
  NODE_ENV: 'development' | 'production' | 'test'
  DATABASE_URL: string
  FORGE_MANAGED_DOCKER_MIGRATIONS: '0'
}>

/** Build the complete child environment from an allowlist. The caller's
 * administrator URL, libpq PG* routing, and every unrelated ambient value are
 * deliberately unreachable from a migration child. */
export function createMigrationChildEnvironment(
  migrationUrl: string,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): MigrationChildEnvironment {
  const environment: MigrationChildEnvironment = {
    PATH: ambient.PATH ?? '',
    NODE_ENV: ambient.NODE_ENV === 'development' || ambient.NODE_ENV === 'test' ? ambient.NODE_ENV : 'production',
    DATABASE_URL: migrationUrl,
    FORGE_MANAGED_DOCKER_MIGRATIONS: '0',
  }
  const keys = Object.keys(environment).sort()
  if (keys.some((key) => key === 'FORGE_DATABASE_ADMIN_URL' || key.startsWith('PG'))
    || !new URL(environment.DATABASE_URL).username.match(/^forge_migrator_[0-9a-f]{32}$/)
    || keys.join(',') !== 'DATABASE_URL,FORGE_MANAGED_DOCKER_MIGRATIONS,NODE_ENV,PATH') {
    throw new Error('Managed migration child environment crossed the administrator authority boundary.')
  }
  return environment
}

export function createEphemeralMigrationUrl(
  applicationUrl: string,
  migrationRole: string,
  migrationPassword: string,
  routing: Readonly<{ PGHOST?: string; PGPORT?: string }> = { PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT },
): string {
  const result = new URL(applicationUrl)
  if (!result.hostname) {
    if (!routing.PGHOST) throw new Error('A socket-routed controller must provide PGHOST so children receive explicit non-ambient routing.')
    result.host = 'localhost'
    result.searchParams.set('host', routing.PGHOST)
    if (routing.PGPORT) result.searchParams.set('port', routing.PGPORT)
  }
  result.searchParams.delete('user')
  result.searchParams.delete('password')
  result.username = migrationRole
  result.password = migrationPassword
  return result.toString()
}
