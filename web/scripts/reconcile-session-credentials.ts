import '../lib/load-env'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'
import { computeCredentialDigest, isCanonicalSessionCredential } from '@/lib/session-credential-digest'

type LegacyCache = { userId: string; lastSeenAt: number }
type SessionRow = {
  credentialDigest: Buffer | null
  databaseNow: Date
  expiresAt: Date | null
  id: string
  lastSeenAt: Date
  purgePendingAt: Date | null
  revokedAt: Date | null
  storageVersion: number
  userId: string
}

const USAGE = `Usage: npm run session-credentials:reconcile -- [--apply] [--finalize]

Without flags, reports the current expansion state and row counts without changing data.
  --apply       Enter draining state, reconcile legacy Redis sessions, and purge old keys.
  --finalize    With --apply, require a zero scan and apply strict NOT NULL constraints.
  --help        Show this help without connecting to PostgreSQL or Redis.`

function parseArgs(): { apply: boolean; finalize: boolean; help: boolean } {
  const args = new Set(process.argv.slice(2))
  for (const arg of args) {
    if (arg !== '--apply' && arg !== '--finalize' && arg !== '--help') {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (args.has('--finalize') && !args.has('--apply')) {
    throw new Error('--finalize requires --apply')
  }
  return {
    apply: args.has('--apply'),
    finalize: args.has('--finalize'),
    help: args.has('--help'),
  }
}

function parseLegacyCache(raw: unknown, expectedUserId: string, redisNowMs: number): LegacyCache | null {
  if (typeof raw !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const candidate = value as { userId?: unknown; lastSeenAt?: unknown }
  if (candidate.userId !== expectedUserId
      || typeof candidate.lastSeenAt !== 'number'
      || !Number.isFinite(candidate.lastSeenAt)
      || candidate.lastSeenAt < 0
      || candidate.lastSeenAt > redisNowMs) return null
  return { userId: candidate.userId, lastSeenAt: candidate.lastSeenAt }
}

async function readLegacyAuthority(redis: Redis, key: string): Promise<{
  cache: unknown
  expiresAtMs: number
  redisNowMs: number
}> {
  const result = await redis.eval(
    `local value = redis.call('GET', KEYS[1])
local expires = redis.call('PEXPIRETIME', KEYS[1])
local now = redis.call('TIME')
return {value or false, expires, now[1], now[2]}`,
    1,
    key,
  )
  if (!Array.isArray(result) || result.length !== 4) {
    throw new Error('Redis returned a malformed legacy-session authority tuple')
  }
  return {
    cache: result[0],
    expiresAtMs: Number(result[1]),
    redisNowMs: Number(result[2]) * 1000 + Math.floor(Number(result[3]) / 1000),
  }
}

async function scanLegacyRedisKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [nextCursor, page] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 250)
    cursor = nextCursor
    for (const key of page) {
      if (!key.startsWith('session:v2:')) keys.push(key)
    }
  } while (cursor !== '0')
  return [...new Set(keys)].sort()
}

async function main(): Promise<void> {
  const options = parseArgs()
  if (options.help) {
    console.log(USAGE)
    return
  }
  const database = postgres(getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
  const redis = new Redis(getRequiredEnv('REDIS_URL'), { maxRetriesPerRequest: 3 })
  let locked = false
  try {
    const [summary] = await database<{
      pending: number
      state: string
      unreconciled: number
    }[]>`
      select reconciliation.state,
        count(*) filter (where session.credential_storage_version < 2)::integer as unreconciled,
        count(*) filter (where session.legacy_redis_purge_pending_at is not null)::integer as pending
      from session_credential_reconciliation reconciliation
      left join sessions session on true
      where reconciliation.singleton
      group by reconciliation.state
    `
    if (!summary) throw new Error('Session credential reconciliation state is missing')
    const legacyRedisKeys = await scanLegacyRedisKeys(redis)
    if (!options.apply) {
      console.log(JSON.stringify({
        mode: 'dry-run',
        ...summary,
        legacyRedisKeys: legacyRedisKeys.length,
      }))
      return
    }
    if ((process.env.FORGE_SESSION_CREDENTIAL_MODE?.trim() || 'strict') !== 'strict') {
      throw new Error('Set FORGE_SESSION_CREDENTIAL_MODE=strict and drain old web processes before applying reconciliation.')
    }
    const [lock] = await database<{ locked: boolean }[]>`
      select pg_catalog.pg_try_advisory_lock(
        pg_catalog.hashtextextended('forge:session-credential-reconciliation:v1', 0)
      ) as locked
    `
    if (!lock?.locked) throw new Error('Another session credential reconciliation is already running')
    locked = true

    await database.begin(async (tx) => {
      const [state] = await tx<{ state: string }[]>`
        select state from session_credential_reconciliation
        where singleton for update
      `
      if (!state || state.state === 'strict') return
      await tx`
        update session_credential_reconciliation
        set state = 'draining', updated_at = pg_catalog.clock_timestamp()
        where singleton and state = 'expansion'
      `
    })

    let migrated = 0
    let revoked = 0
    for (;;) {
      const [row] = await database<SessionRow[]>`
        select id, user_id as "userId", credential_digest_v1 as "credentialDigest",
          expires_at as "expiresAt", last_seen_at as "lastSeenAt",
          revoked_at as "revokedAt", credential_storage_version as "storageVersion",
          legacy_redis_purge_pending_at as "purgePendingAt",
          pg_catalog.clock_timestamp() as "databaseNow"
        from sessions
        where credential_storage_version < 2
        order by id
        limit 1
      `
      if (!row) break

      const credential = row.id
      const legacyKey = `session:${credential}`
      let valid = false
      let digest = row.credentialDigest
      let expiresAt = row.expiresAt
      let lastSeenAt = row.lastSeenAt
      let authorityExpiryMs: number | null = null

      if (!row.purgePendingAt && row.storageVersion < 2) {
        if (isCanonicalSessionCredential(credential)) {
          const authority = await readLegacyAuthority(redis, legacyKey)
          const cache = parseLegacyCache(authority.cache, row.userId, authority.redisNowMs)
          valid = cache !== null
            && Number.isSafeInteger(authority.expiresAtMs)
            && authority.expiresAtMs > authority.redisNowMs
          if (valid && cache) {
            const expectedDigest = computeCredentialDigest(credential).digest
            if (row.credentialDigest !== null
                && !row.credentialDigest.equals(expectedDigest)) {
              valid = false
            }
            digest = expectedDigest
            expiresAt = new Date(authority.expiresAtMs)
            lastSeenAt = new Date(cache.lastSeenAt)
            authorityExpiryMs = authority.expiresAtMs
          }
        }
        if (valid && digest && expiresAt) {
          await database`
            update sessions
            set credential_digest_v1 = ${digest}, expires_at = ${expiresAt},
              last_seen_at = ${lastSeenAt}, credential_storage_version = 1,
              legacy_redis_purge_pending_at = pg_catalog.clock_timestamp()
            where id = ${credential}::uuid and credential_storage_version < 2
              and legacy_redis_purge_pending_at is null
          `
        } else {
          await database`
            update sessions
            set revoked_at = coalesce(revoked_at, pg_catalog.clock_timestamp()),
              legacy_redis_purge_pending_at = coalesce(
                legacy_redis_purge_pending_at, pg_catalog.clock_timestamp()
              )
            where id = ${credential}::uuid and credential_storage_version < 2
          `
        }
      }

      const [staged] = await database<SessionRow[]>`
        select id, user_id as "userId", credential_digest_v1 as "credentialDigest",
          expires_at as "expiresAt", last_seen_at as "lastSeenAt",
          revoked_at as "revokedAt", credential_storage_version as "storageVersion",
          legacy_redis_purge_pending_at as "purgePendingAt",
          pg_catalog.clock_timestamp() as "databaseNow"
        from sessions where id = ${credential}::uuid
      `
      if (authorityExpiryMs !== null
          && staged?.expiresAt?.getTime() !== authorityExpiryMs) {
        throw new Error('PostgreSQL did not preserve the exact Redis PEXPIRETIME value')
      }
      const stagedLive = staged?.storageVersion === 1
        && staged.credentialDigest !== null
        && staged.expiresAt !== null
        && staged.revokedAt === null
        && staged.expiresAt > staged.databaseNow

      if (stagedLive && staged) {
        await redis.set(
          `session:v2:${staged.credentialDigest!.toString('hex')}`,
          JSON.stringify({
            userId: staged.userId,
            expiresAt: staged.expiresAt!.getTime(),
            lastSeenAt: staged.lastSeenAt.getTime(),
          }),
          'PXAT',
          staged.expiresAt!.getTime(),
        )
      }
      await redis.del(legacyKey)

      if (stagedLive) {
        await database`
          update sessions
          set id = ${randomUUID()}::uuid, credential_storage_version = 2,
            legacy_redis_purge_pending_at = null,
            legacy_redis_invalidated_at = pg_catalog.clock_timestamp()
          where id = ${credential}::uuid and credential_storage_version = 1
            and legacy_redis_purge_pending_at is not null
        `
        migrated += 1
      } else {
        await database`
          delete from sessions
          where id = ${credential}::uuid and credential_storage_version < 2
            and legacy_redis_purge_pending_at is not null
        `
        revoked += 1
      }
    }

    const orphanLegacyKeys = await scanLegacyRedisKeys(redis)
    for (let offset = 0; offset < orphanLegacyKeys.length; offset += 250) {
      await redis.del(...orphanLegacyKeys.slice(offset, offset + 250))
    }
    const legacyKeysAfterPurge = await scanLegacyRedisKeys(redis)
    if (legacyKeysAfterPurge.length !== 0) {
      throw new Error(`Legacy Redis zero-scan failed with ${legacyKeysAfterPurge.length} keys`)
    }

    await database`
      update session_credential_reconciliation
      set rows_migrated = rows_migrated + ${migrated},
        rows_revoked = rows_revoked + ${revoked},
        updated_at = pg_catalog.clock_timestamp()
      where singleton
    `

    if (options.finalize) {
      const finalLegacyKeys = await scanLegacyRedisKeys(redis)
      if (finalLegacyKeys.length !== 0) {
        throw new Error(`Strict session cutover Redis zero-scan failed with ${finalLegacyKeys.length} keys`)
      }
      await database.begin(async (tx) => {
        const [state] = await tx<{ state: string }[]>`
          select state from session_credential_reconciliation
          where singleton for update
        `
        if (!state || state.state !== 'draining') {
          throw new Error('Strict session cutover requires the draining state')
        }
        const [remaining] = await tx<{ count: number }[]>`
          select count(*)::integer as count from sessions session
          where session.credential_storage_version <> 2
             or session.credential_digest_v1 is null
             or session.expires_at is null
             or session.legacy_redis_purge_pending_at is not null
             or session.credential_digest_v1 = pg_catalog.sha256(
               pg_catalog.convert_to('forge:web-session:v1', 'UTF8')
               || pg_catalog.decode('00', 'hex')
               || pg_catalog.convert_to(session.id::text, 'UTF8')
             )
        `
        if (!remaining || remaining.count !== 0) {
          throw new Error(`Strict session cutover zero-scan failed with ${remaining?.count ?? 'unknown'} rows`)
        }
        await tx`alter table sessions validate constraint sessions_credential_digest_v1_length_chk`
        await tx`alter table sessions validate constraint sessions_credential_storage_version_chk`
        await tx`alter table sessions alter column credential_digest_v1 set not null`
        await tx`alter table sessions alter column expires_at set not null`
        await tx`
          update session_credential_reconciliation
          set state = 'strict', updated_at = pg_catalog.clock_timestamp()
          where singleton
        `
      })
    }
    console.log(JSON.stringify({
      legacyRedisKeysPurged: orphanLegacyKeys.length,
      migrated,
      revoked,
      state: options.finalize ? 'strict' : 'draining',
    }))
  } finally {
    if (locked) {
      await database`select pg_catalog.pg_advisory_unlock(
        pg_catalog.hashtextextended('forge:session-credential-reconciliation:v1', 0)
      )`.catch(() => {})
    }
    redis.disconnect()
    await database.end({ timeout: 5 })
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
