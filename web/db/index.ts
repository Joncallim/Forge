import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { getRequiredEnv } from '@/lib/env'

type ForgeDb = PostgresJsDatabase<typeof schema>
type PostgresClient = ReturnType<typeof postgres>

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
