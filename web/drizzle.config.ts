import './lib/load-env'
import type { Config } from 'drizzle-kit'

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) return ''

  if (process.env.FORGE_SUPPRESS_MIGRATION_NOTICES !== '1') return url

  const parsed = new URL(url)
  if (!parsed.searchParams.has('options')) {
    parsed.searchParams.set('options', '-c client_min_messages=warning')
  }
  return parsed.toString()
}

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl(),
  },
} satisfies Config
