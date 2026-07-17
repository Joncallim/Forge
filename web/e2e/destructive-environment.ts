const DESTRUCTIVE_OPT_IN = 'FORGE_E2E_ALLOW_DESTRUCTIVE_RESET'
const E2E_DATABASE_URL = 'FORGE_E2E_DATABASE_URL'
const E2E_REDIS_URL = 'FORGE_E2E_REDIS_URL'

type Environment = Record<string, string | undefined>

export type DestructiveE2EEnvironment = {
  databaseUrl: string
  redisUrl: string
}

function requiredUrl(env: Environment, name: string): URL {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required for destructive E2E tests.`)
  try {
    return new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL.`)
  }
}

function isE2EIdentity(value: string): boolean {
  return /(?:^|[_-])(?:e2e|test)(?:$|[_-])/i.test(value)
}

export function resolveDestructiveE2EEnvironment(
  env: Environment = process.env,
): DestructiveE2EEnvironment {
  if (env[DESTRUCTIVE_OPT_IN] !== '1') {
    throw new Error(`${DESTRUCTIVE_OPT_IN}=1 is required before E2E state may be deleted or flushed.`)
  }

  const databaseUrl = requiredUrl(env, E2E_DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error(`${E2E_DATABASE_URL} must use PostgreSQL.`)
  }
  const databaseUser = decodeURIComponent(databaseUrl.username)
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''))
  if (!isE2EIdentity(databaseUser) || !isE2EIdentity(databaseName)) {
    throw new Error(`${E2E_DATABASE_URL} must use dedicated E2E/test user and database names.`)
  }

  const redisUrl = requiredUrl(env, E2E_REDIS_URL)
  if (!['redis:', 'rediss:'].includes(redisUrl.protocol)) {
    throw new Error(`${E2E_REDIS_URL} must use Redis.`)
  }
  const redisDatabaseText = redisUrl.pathname.replace(/^\//, '')
  const redisDatabase = Number(redisDatabaseText)
  if (!Number.isSafeInteger(redisDatabase) || redisDatabase <= 0) {
    throw new Error(`${E2E_REDIS_URL} must select a dedicated nonzero Redis database.`)
  }

  const resolvedDatabaseUrl = databaseUrl.toString()
  const resolvedRedisUrl = redisUrl.toString()
  if (env.DATABASE_URL && new URL(env.DATABASE_URL).toString() !== resolvedDatabaseUrl) {
    throw new Error('DATABASE_URL must match FORGE_E2E_DATABASE_URL during E2E tests.')
  }
  if (env.REDIS_URL && new URL(env.REDIS_URL).toString() !== resolvedRedisUrl) {
    throw new Error('REDIS_URL must match FORGE_E2E_REDIS_URL during E2E tests.')
  }

  return { databaseUrl: resolvedDatabaseUrl, redisUrl: resolvedRedisUrl }
}
