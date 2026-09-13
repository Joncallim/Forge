import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import postgres from 'postgres'

const execFileAsync = promisify(execFile)
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
const proofScript = fileURLToPath(import.meta.url)
const controllerScript = 'scripts/managed-docker-migration-controller.ts'
const proofEnvironmentNames = ['CI', 'GITHUB_ACTIONS'] as const

function controllerLaunch(args: string[], environment: NodeJS.ProcessEnv) {
  if (process.getuid?.() !== 0) throw new Error('The controller proof must establish its root boundary before launching a controller.')
  return { command: process.execPath, args: [tsxCli, ...args], env: environment }
}

async function reexecProofAsRoot(): Promise<boolean> {
  if (process.getuid?.() === 0) return false
  const preserved = proofEnvironmentNames.join(',')
  const environment = Object.fromEntries(proofEnvironmentNames.map((name) => [name, process.env[name]]).filter((entry) => entry[1] !== undefined))
  const { stdout, stderr } = await execFileAsync('/usr/bin/sudo', [
    '-n', `--preserve-env=${preserved}`, process.execPath, tsxCli, proofScript,
  ], { cwd: process.cwd(), env: environment, maxBuffer: 16 * 1024 * 1024 })
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  return true
}

async function executeController(args: string[], environment: NodeJS.ProcessEnv, options: { timeout: number; maxBuffer: number }) {
  const launch = controllerLaunch(args, environment)
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(), env: launch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let timedOut = false
    let overflowed = false
    const terminateGroup = () => {
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > options.maxBuffer) {
        overflowed = true
        terminateGroup()
        return
      }
      if (target === 'stdout') stdout += String(chunk)
      else stderr += String(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.once('error', reject)
    const timer = setTimeout(() => { timedOut = true; terminateGroup() }, options.timeout)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut && !overflowed) resolve({ stdout, stderr })
      else reject(new Error(`Controller process group failed (code=${code ?? 'null'}, signal=${signal ?? 'null'}, timeout=${timedOut}, outputOverflow=${overflowed}).`))
    })
  })
}
const container = `forge-334-${randomUUID().replaceAll('-', '')}`
const adminPassword = `admin_${randomUUID().replaceAll('-', '')}`
const appPassword = `app_${randomUUID().replaceAll('-', '')}`
const runtimePassword = `runtime_${randomUUID().replaceAll('-', '')}`
const tag = '0034_vnext_phase0_a1_runtime_foundation'

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const value = await read()
      if (accept(value)) return value
    } catch (error) { lastError = error }
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${label}.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ''}`)
}

type AclEntry = { grantorOid: number; grantor: string; granteeOid: number; grantee: string; privilege: string; grantable: boolean }
async function readAcl(sql: ReturnType<typeof postgres>): Promise<AclEntry[]> {
  const rows = await sql<AclEntry[]>`
    select acl.grantor::integer as "grantorOid", grantor_role.rolname as grantor,
      acl.grantee::integer as "granteeOid", case when acl.grantee=0 then 'PUBLIC' else grantee_role.rolname end as grantee,
      acl.privilege_type as privilege, acl.is_grantable as grantable
    from pg_catalog.pg_database database_row
    cross join lateral pg_catalog.aclexplode(coalesce(database_row.datacl, pg_catalog.acldefault('d',database_row.datdba))) acl
    join pg_catalog.pg_roles grantor_role on grantor_role.oid=acl.grantor
    left join pg_catalog.pg_roles grantee_role on grantee_role.oid=acl.grantee
    where database_row.datname=pg_catalog.current_database()
    order by "grantorOid", "granteeOid", privilege, grantable
  `
  return Array.from(rows)
}

async function main(): Promise<void> {
  let started = false
  let admin: ReturnType<typeof postgres> | null = null
  try {
    await execFileAsync('docker', ['run', '--rm', '-d', '--name', container,
      '-e', `POSTGRES_PASSWORD=${adminPassword}`, '-e', 'POSTGRES_DB=forge',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine'])
    started = true
    const { stdout: portOutput } = await execFileAsync('docker', ['port', container, '5432/tcp'])
    const port = portOutput.trim().match(/:(\d+)$/)?.[1]
    if (!port) throw new Error('The isolated PostgreSQL container did not publish a loopback port.')
    const adminUrl = `postgresql://postgres:${adminPassword}@127.0.0.1:${port}/forge`
    const appUrl = `postgresql://forge:${appPassword}@127.0.0.1:${port}/forge`
    admin = postgres(adminUrl, { max: 1, connect_timeout: 2, onnotice: () => {} })
    await eventually(() => admin!`select current_setting('server_version_num')::integer as version`,
      (rows) => Number(rows[0]?.version) >= 160000 && Number(rows[0]?.version) < 170000, 'PostgreSQL 16 readiness')

    await admin.unsafe(`
      create role forge login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${appPassword}';
      create role forge_runtime_api_login login inherit connection limit 5 nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${runtimePassword}';
      create role forge_acl_parent nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role forge_acl_grantor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      grant connect on database forge to forge_acl_grantor with grant option;
      set role forge_acl_grantor;
      grant connect on database forge to forge_acl_parent;
      grant connect on database forge to forge;
      reset role;
      grant forge_acl_parent to forge_runtime_api_login with inherit true;
    `)
    const aclBefore = await readAcl(admin)

    const controllerEnv = {
      ...process.env,
      FORGE_DATABASE_ADMIN_URL: adminUrl,
      DATABASE_URL: appUrl,
      FORGE_RUNTIME_API_DATABASE_PASSWORD: runtimePassword,
      FORGE_MANAGED_DOCKER_MIGRATIONS: '1',
      FORGE_MANAGED_MIGRATION_PAUSE_AFTER_FENCE_MS: '60000',
    }
    const firstLaunch = controllerLaunch(['-e', `import('./${controllerScript}').then((module) => module.default.runManagedDockerMigration()).catch((error) => { console.error(error.stack); process.exit(1) })`], controllerEnv)
    const first = spawn(firstLaunch.command, firstLaunch.args, {
      cwd: process.cwd(), env: firstLaunch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let firstOutput = ''
    first.stdout.on('data', (chunk) => { firstOutput += String(chunk) })
    first.stderr.on('data', (chunk) => { firstOutput += String(chunk) })
    let fenced
    try {
      const exitedEarly = new Promise<never>((_resolve, reject) => first.once('exit', (code, signal) => {
        reject(new Error(`controller exited before the fence (${code ?? signal}): ${firstOutput.trim()}`))
      }))
      fenced = await Promise.race([eventually(async () => {
      const [row] = await admin!<{ phase: string; migrationRole: string; operationId: string | null; databaseOid: number | null; ownerOid: number | null; aclDigest: string | null }[]>`
        select controller_phase as phase, migration_role::text as "migrationRole", operation_id::text as "operationId",
          database_oid::integer as "databaseOid", database_owner_oid::integer as "ownerOid", database_acl_digest as "aclDigest"
        from public.forge_protected_migration_handoffs where migration_tag=${tag}
      `
      return row
      }, (row) => row?.phase === 'fenced', 'durable fenced controller phase'), exitedEarly])
    } catch (error) {
      const diagnostics = await admin<{ state: string | null; phase: string | null; roles: string[] }[]>`
        select pg_catalog.to_regclass('public.forge_protected_migration_handoffs')::text as state,
          (select controller_phase from public.forge_protected_migration_handoffs where migration_tag=${tag}) as phase,
          array(select rolname from pg_catalog.pg_roles where rolname like 'forge%' order by rolname) as roles
      `.catch(() => [])
      throw new Error(`${error instanceof Error ? error.message : String(error)} Controller output: ${firstOutput.trim()} Fixed diagnostics: ${JSON.stringify(diagnostics)}`)
    }
    if (!fenced.operationId || !fenced.databaseOid || !fenced.ownerOid || !fenced.aclDigest?.match(/^[0-9a-f]{64}$/)) {
      throw new Error('The PREPARED/FENCED row omitted crash-recovery identity or ACL evidence.')
    }
    const appDuringFence = postgres(appUrl, { max: 1, connect_timeout: 1 })
    let fenceRejected = false
    try { await appDuringFence`select 1` } catch { fenceRejected = true } finally { await appDuringFence.end({ timeout: 1 }) }
    if (!fenceRejected) throw new Error('Inherited/PUBLIC application CONNECT unexpectedly survived the durable fence.')

    if (!first.pid) throw new Error('The first controller did not expose a process-group id.')
    process.kill(-first.pid, 'SIGKILL')
    await new Promise<void>((resolve) => first.once('exit', () => resolve()))
    const [crashedRole] = await admin<{ exists: boolean; login: boolean }[]>`
      select exists(select 1 from pg_catalog.pg_roles where rolname=${fenced.migrationRole}) as exists,
        coalesce((select rolcanlogin from pg_catalog.pg_roles where rolname=${fenced.migrationRole}),false) as login
    `
    if (!crashedRole.exists || !crashedRole.login) throw new Error('SIGKILL did not leave the live ephemeral identity required by the adoption proof.')

    const retryEnv = { ...controllerEnv, FORGE_MANAGED_MIGRATION_PAUSE_AFTER_FENCE_MS: '0' }
    const predecessorPassword = `predecessor_${randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`alter role "${fenced.migrationRole}" password '${predecessorPassword}'`)
    const predecessorUrl = new URL(adminUrl)
    predecessorUrl.username = fenced.migrationRole
    predecessorUrl.password = predecessorPassword
    await admin.unsafe(`grant connect on database forge to "${fenced.migrationRole}"`)
    const predecessor = postgres(predecessorUrl.toString(), { max: 1, connect_timeout: 2 })
    const [{ pid: predecessorPid }] = await predecessor<{ pid: number }[]>`select pg_catalog.pg_backend_pid()::integer as pid`
    await admin.unsafe(`revoke connect on database forge from "${fenced.migrationRole}"`)
    const [durable] = await admin<{ databaseName: string; databaseOid: number; ownerOid: number; acl: unknown; aclDigest: string; roleOid: number; phase: string }[]>`
      select database_name::text as "databaseName", database_oid::integer as "databaseOid",
        database_owner_oid::integer as "ownerOid", database_acl as acl, database_acl_digest as "aclDigest",
        migration_role_oid::integer as "roleOid", controller_phase as phase
      from public.forge_protected_migration_handoffs where migration_tag=${tag}
    `
    const restoreDurable = async () => admin!`
      update public.forge_protected_migration_handoffs set database_name=${durable.databaseName}::name,
        database_oid=${durable.databaseOid}::oid, database_owner_oid=${durable.ownerOid}::oid,
        database_acl=${admin!.json(durable.acl as never)}, database_acl_digest=${durable.aclDigest},
        migration_role_oid=${durable.roleOid}::oid, controller_phase=${durable.phase}
      where migration_tag=${tag}
    `
    const rejectTamperWithoutMutation = async (label: string, tamper: () => Promise<unknown>) => {
      await tamper()
      let rejected = false
      try {
        await executeController([controllerScript, '--run'], retryEnv, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
      } catch { rejected = true }
      const [preserved] = await admin!<{ login: boolean; session: boolean; roleOid: number }[]>`
        select auth.rolcanlogin as login, auth.oid::integer as "roleOid",
          exists(select 1 from pg_catalog.pg_stat_activity where pid=${predecessorPid} and usename=${fenced.migrationRole}) as session
        from pg_catalog.pg_authid auth where auth.rolname=${fenced.migrationRole}
      `
      await predecessor`select 1`
      await restoreDurable()
      if (!rejected || !preserved?.login || !preserved.session || preserved.roleOid !== durable.roleOid) {
        throw new Error(`Tampered ${label} state did not reject before preserving the predecessor login, session, and role. diagnostics=${JSON.stringify({ rejected, login: preserved?.login ?? false, session: preserved?.session ?? false, expectedRoleOid: durable.roleOid, actualRoleOid: preserved?.roleOid ?? null })}`)
      }
    }
    await rejectTamperWithoutMutation('database name', () => admin!`
      update public.forge_protected_migration_handoffs set database_name='forge_wrong' where migration_tag=${tag}`)
    await rejectTamperWithoutMutation('database OID', () => admin!`
      update public.forge_protected_migration_handoffs set database_oid=${durable.databaseOid + 1}::oid where migration_tag=${tag}`)
    await rejectTamperWithoutMutation('ACL digest', () => admin!`
      update public.forge_protected_migration_handoffs set database_acl_digest=${'0'.repeat(64)} where migration_tag=${tag}`)
    const [{ oid: postgresOid }] = await admin<{ oid: number }[]>`select oid::integer as oid from pg_catalog.pg_roles where rolname='postgres'`
    await rejectTamperWithoutMutation('role OID mapping', () => admin!`
      update public.forge_protected_migration_handoffs set migration_role_oid=${postgresOid}::oid where migration_tag=${tag}`)
    await rejectTamperWithoutMutation('ledger/phase', () => admin!`
      update public.forge_protected_migration_handoffs set controller_phase='handoff_open' where migration_tag=${tag}`)
    await predecessor.end({ timeout: 1 })

    const { stdout, stderr } = await executeController([controllerScript, '--run'], retryEnv, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
    if (!`${stdout}${stderr}`.includes('Managed Docker migration completed')) throw new Error('The restarted controller omitted its success evidence.')

    const [closed] = await admin<{ phase: string; cleanup: boolean; oldRoleExists: boolean; migrators: number }[]>`
      select handoff.controller_phase as phase, handoff.cleanup_completed_at is not null as cleanup,
        exists(select 1 from pg_catalog.pg_roles where rolname=${fenced.migrationRole}) as "oldRoleExists",
        (select count(*)::integer from pg_catalog.pg_roles where rolname ~ '^forge_migrator_[0-9a-f]{32}$') as migrators
      from public.forge_protected_migration_handoffs handoff where migration_tag=${tag}
    `
    if (closed.phase !== 'complete' || !closed.cleanup || closed.oldRoleExists || closed.migrators !== 0) {
      throw new Error('Restart did not CAS-close the durable handoff and remove every ephemeral login.')
    }
    if (JSON.stringify(await readAcl(admin)) !== JSON.stringify(aclBefore)) throw new Error('Restart did not restore the exact grantor-aware database ACL.')
    const appAfter = postgres(appUrl, { max: 1, connect_timeout: 2 })
    try { await appAfter`select 1` } finally { await appAfter.end({ timeout: 1 }) }

    // Emulate the exact row shape produced before the controller columns
    // existed, then prove an ordinary rerun upgrades it without reopening a
    // protected handoff or inventing a second state record.
    await admin`
      update public.forge_protected_migration_handoffs
      set operation_id=null, controller_phase='handoff_open', database_oid=null, database_owner_oid=null,
        database_acl=null, database_acl_digest=null, migration_role_oid=null, generation=generation+1
      where migration_tag=${tag}
    `
    await executeController([controllerScript, '--run'], retryEnv, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
    const [upgraded] = await admin<{ phase: string; operationId: string | null; aclDigest: string | null; rows: number }[]>`
      select controller_phase as phase, operation_id::text as "operationId", database_acl_digest as "aclDigest",
        (select count(*)::integer from public.forge_protected_migration_handoffs where migration_tag=${tag}) as rows
      from public.forge_protected_migration_handoffs where migration_tag=${tag}
    `
    if (upgraded.phase !== 'complete' || !upgraded.operationId || !upgraded.aclDigest?.match(/^[0-9a-f]{64}$/) || upgraded.rows !== 1) {
      throw new Error('The legacy completed handoff row did not upgrade in place to exact controller state.')
    }
    console.log('VNEXT_A1_CONTROLLER_SIGKILL_RESTART_PASSED')
    if (firstOutput.includes(adminPassword)) throw new Error('The interrupted controller emitted administrator authority material.')
  } finally {
    if (admin) await admin.end({ timeout: 1 }).catch(() => {})
    if (started) await execFileAsync('docker', ['stop', '--time', '2', container]).catch(() => {})
  }
}

reexecProofAsRoot()
  .then((reexecuted) => reexecuted ? undefined : main())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
