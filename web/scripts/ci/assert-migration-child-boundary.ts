import { readFile } from 'node:fs/promises'
import postgres from 'postgres'

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value) throw new Error(`Missing migration child boundary argument ${name}.`)
  return value
}

async function main(): Promise<void> {
  const controllerPid = option('--controller-pid')
  const adminHost = option('--admin-host')
  const adminPort = option('--admin-port')
  const adminUser = option('--admin-user')
  const database = option('--database')
  if (process.getuid?.() === 0) throw new Error('Migration child retained root operating-system authority.')
  if (process.getgroups?.().some((group) => group !== process.getgid?.())) throw new Error('Migration child retained a supplementary operating-system group.')
  let parentReadable = false
  try { await readFile(`/proc/${controllerPid}/environ`); parentReadable = true } catch {}
  if (parentReadable) throw new Error('Migration child could read the trusted controller environment through procfs.')

  const migrationUrl = process.env.DATABASE_URL
  if (!migrationUrl) throw new Error('Migration child has no ephemeral database URL.')
  const migration = postgres(migrationUrl, { max: 1, connect_timeout: 2 })
  try {
    const [identity] = await migration<{ sessionUser: string }[]>`select session_user as "sessionUser"`
    if (!identity?.sessionUser.match(/^forge_migrator_[0-9a-f]{32}$/)) throw new Error('Migration child database session is not the ephemeral migrator.')
  } finally { await migration.end({ timeout: 1 }) }

  const admin = new URL(`postgresql://${encodeURIComponent(adminUser)}@localhost/${encodeURIComponent(database)}`)
  if (adminHost.startsWith('/')) admin.searchParams.set('host', adminHost)
  else admin.hostname = adminHost
  if (adminPort) admin.port = adminPort
  const peer = postgres(admin.toString(), { max: 1, connect_timeout: 1 })
  let acquiredAdmin = false
  try { await peer`select 1`; acquiredAdmin = true } catch {} finally { await peer.end({ timeout: 1 }) }
  if (acquiredAdmin) throw new Error('Migration child acquired administrator database authority outside its ephemeral session.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
