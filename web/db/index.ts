import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { getRequiredEnv } from '@/lib/env'

type ForgeDb = PostgresJsDatabase<typeof schema>
type PostgresClient = ReturnType<typeof postgres>

const POSTGRES_SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]+$/i

const globalForDb = globalThis as unknown as {
  forgeDb: ForgeDb | undefined
  forgeDbClient: PostgresClient | undefined
}

let dbProxy: ForgeDb | undefined

function createDb(): ForgeDb {
  const client = postgres(getRequiredEnv('DATABASE_URL'))
  globalForDb.forgeDbClient = client
  return drizzle(client, { schema })
}

function getDb(): ForgeDb {
  if (globalForDb.forgeDb) return globalForDb.forgeDb

  const db = createDb()
  if (process.env.NODE_ENV !== 'production') globalForDb.forgeDb = db
  return db
}

export const db =
  dbProxy ??
  (dbProxy = new Proxy({} as ForgeDb, {
    get(_target, prop, receiver) {
      const client = getDb()
      const value = Reflect.get(client, prop, receiver)
      return typeof value === 'function' ? value.bind(client) : value
    },
  }))

export async function closeDb(): Promise<void> {
  const client = globalForDb.forgeDbClient
  if (!client) return

  await client.end({ timeout: 5 })
  globalForDb.forgeDbClient = undefined
  globalForDb.forgeDb = undefined
}

/**
 * Pins ordinary S5 reads to one PostgreSQL snapshot while a least-privilege
 * reader imports that same observation. The snapshot never leaves this
 * server-side callback and the exporter remains open until it has completed.
 */
export async function withExportedRepeatableReadSnapshot<T>(input: {
  run: (tx: ForgeDb, snapshotId: string, databaseUrl: string) => Promise<T>
}): Promise<T> {
  const databaseUrl = getRequiredEnv('DATABASE_URL')
  const client = postgres(databaseUrl, { max: 1, prepare: true, onnotice: () => {} })
  try {
    return await client.begin('isolation level repeatable read read only', async (sql) => {
      const [{ snapshotId }] = await sql<{ snapshotId: string }[]>`select pg_export_snapshot() as "snapshotId"`
      if (typeof snapshotId !== 'string' || !POSTGRES_SNAPSHOT_ID.test(snapshotId)) {
        throw new Error('PostgreSQL returned an invalid exported snapshot identifier.')
      }
      return input.run(drizzle(sql as unknown as PostgresClient, { schema }), snapshotId, databaseUrl)
    }) as unknown as T
  } finally {
    await client.end({ timeout: 5 }).catch(() => {})
  }
}
