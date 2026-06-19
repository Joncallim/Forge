import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { getRequiredEnv } from '@/lib/env'

type ForgeDb = PostgresJsDatabase<typeof schema>

const globalForDb = globalThis as unknown as {
  forgeDb: ForgeDb | undefined
}

let dbProxy: ForgeDb | undefined

function createDb(): ForgeDb {
  const client = postgres(getRequiredEnv('DATABASE_URL'))
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
