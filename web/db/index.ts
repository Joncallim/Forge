import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { getRequiredEnv } from '@/lib/env'

const client = postgres(getRequiredEnv('DATABASE_URL'))
export const db = drizzle(client, { schema })
