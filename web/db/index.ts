import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { getRequiredEnv } from '@/lib/env'

type ForgeDb = PostgresJsDatabase<typeof schema>
type PostgresClient = ReturnType<typeof postgres>
type ForgeTransaction = Parameters<Parameters<ForgeDb['transaction']>[0]>[0]

// PostgreSQL exports `XXXXXXXX-XXXXXXXX-X` snapshot IDs. Keep every segment
// hexadecimal and bounded before the protected reader embeds it as a literal.
const POSTGRES_SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{1,8}$/i

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
  run: (tx: ForgeTransaction, snapshotId: string, databaseUrl: string) => Promise<T>
}): Promise<T> {
  const databaseUrl = getRequiredEnv('DATABASE_URL')
  const client = postgres(databaseUrl, { max: 1, prepare: true, onnotice: () => {} })
  const database = drizzle(client, { schema })
  try {
    return await database.transaction(async (tx) => {
      const [{ snapshotId }] = await tx.execute<{ snapshotId: string }>(
        sql`select pg_export_snapshot() as "snapshotId"`,
      )
      if (typeof snapshotId !== 'string' || !POSTGRES_SNAPSHOT_ID.test(snapshotId)) {
        throw new Error('PostgreSQL returned an invalid exported snapshot identifier.')
      }
      return input.run(tx, snapshotId, databaseUrl)
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  } finally {
    await client.end({ timeout: 5 }).catch(() => {})
  }
}
