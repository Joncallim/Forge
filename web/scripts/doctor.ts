import '../lib/load-env'
import { sql } from 'drizzle-orm'
import { checkRuntimeEnv } from '../lib/env'

async function main(): Promise<void> {
  const envChecks = checkRuntimeEnv()
  const missing = envChecks.filter((check) => !check.present)

  console.info('Forge runtime doctor')
  for (const check of envChecks) {
    console.info(`${check.present ? 'ok' : 'missing'} ${check.name}`)
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.map((check) => check.name).join(', ')}`)
  }

  const { closeDb, db } = await import('../db')
  const { redis } = await import('../lib/redis')

  let failed = false

  try {
    try {
      await db.execute(sql`SELECT 1`)
      console.info('ok DATABASE_URL connection')
    } catch (err) {
      failed = true
      console.error('failed DATABASE_URL connection')
      console.error(err instanceof Error ? err.message : err)
    }

    try {
      await redis.ping()
      console.info('ok REDIS_URL connection')
    } catch (err) {
      failed = true
      console.error('failed REDIS_URL connection')
      console.error(err instanceof Error ? err.message : err)
    }
  } finally {
    await closeDb().catch(() => {})
    redis.disconnect()
  }


  if (failed) {
    process.exit(1)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
