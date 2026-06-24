import '../lib/load-env'
import { sql } from 'drizzle-orm'
import { checkRuntimeEnv } from '../lib/env'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const GITHUB_CLI_TIMEOUT_MS = 5000

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '')
}

async function checkGitHubCli(): Promise<boolean> {
  const required = truthy(process.env.FORGE_REQUIRE_GITHUB_CLI)
  let failed = false

  try {
    const version = await execFile('gh', ['--version'], { timeout: GITHUB_CLI_TIMEOUT_MS })
    const firstLine = version.stdout.trim().split('\n')[0] || 'gh installed'
    console.info(`ok GITHUB_CLI installed (${firstLine})`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const label = required ? 'failed' : 'warn'
    console.info(`${label} GITHUB_CLI installed (${message})`)
    return required
  }

  try {
    await execFile('gh', ['auth', 'status'], { timeout: GITHUB_CLI_TIMEOUT_MS })
    console.info('ok GITHUB_CLI authenticated')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const label = required ? 'failed' : 'warn'
    console.info(`${label} GITHUB_CLI authenticated (${message})`)
    failed = required
  }

  return failed
}

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

    if (await checkGitHubCli()) {
      failed = true
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
