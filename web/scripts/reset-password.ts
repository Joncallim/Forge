/**
 * Reset the Forge user's password from the command line.
 *
 * Forge is a single-user, self-hosted app with no email/SMS provider, so
 * there is no way to send a "forgot password" link. Whoever can run this
 * script already has shell access to the host running Forge, which is the
 * same trust level required to read .env / the database directly — so a
 * direct password reset here does not weaken the app's security model.
 *
 * This also recovers the case where a passkey was deregistered on the
 * device/authenticator (so passkey sign-in no longer works) and the
 * password was forgotten too: resetting the password here restores access
 * without needing the old password or the old passkey.
 *
 * Preferred safe usage:
 *   forge reset-credentials
 *
 * Script usage:
 *   printf '%s\n' "$NEW_PASSWORD" | npm run auth:reset-password -- --stdin
 */

import '../lib/load-env'
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema'
import { hashPassword, validatePassword } from '../lib/password'
import { clearPasswordLoginRateLimits } from '../lib/auth-rate-limit'

function passwordFromArgs(): string | undefined {
  const arg = process.argv[2]
  if (arg === '--stdin') {
    if (process.argv.length > 3) {
      console.error('[reset-password] Refusing extra arguments because they can leak through shell history and process argv.')
      console.error('[reset-password] Use: forge reset-credentials')
      console.error('[reset-password] Or:  npm run auth:reset-password -- --stdin')
      process.exit(1)
    }
    return readFileSync(0, 'utf8').replace(/\r?\n$/, '')
  }
  if (arg) {
    console.error('[reset-password] Refusing password arguments because they can leak through shell history and process argv.')
    console.error('[reset-password] Use: forge reset-credentials')
    console.error('[reset-password] Or:  npm run auth:reset-password -- --stdin')
    process.exit(1)
  }
  return undefined
}

async function main() {
  const newPassword = passwordFromArgs()

  if (!newPassword) {
    console.error('[reset-password] Usage: forge reset-credentials')
    console.error('[reset-password] Or:    npm run auth:reset-password -- --stdin')
    process.exit(1)
  }

  const passwordError = validatePassword(newPassword)
  if (passwordError) {
    console.error(`[reset-password] ${passwordError}`)
    process.exit(1)
  }

  const [user] = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .limit(1)

  if (!user) {
    console.error('[reset-password] No account exists yet. Create one at /register instead.')
    process.exit(1)
  }

  const passwordHash = await hashPassword(newPassword)
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id))

  console.log(`[reset-password] Password reset for "${user.displayName}". Sign in at /login.`)
  try {
    const clearedRateLimits = await clearPasswordLoginRateLimits()
    if (clearedRateLimits > 0) {
      console.log(`[reset-password] Cleared ${clearedRateLimits} password sign-in throttle key(s).`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[reset-password] Password was reset, but throttle keys could not be cleared: ${message}`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[reset-password] Fatal error:', err)
  process.exit(1)
})
