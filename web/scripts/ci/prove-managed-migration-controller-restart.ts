import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import postgres from 'postgres'

const execFileAsync = promisify(execFile)
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
    const first = spawn('npx', ['tsx', '-e', "import('./scripts/managed-docker-migration-controller.ts').then((module) => module.default.runManagedDockerMigration()).catch((error) => { console.error(error.stack); process.exit(1) })"], {
      cwd: process.cwd(), env: controllerEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
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
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', 'scripts/managed-docker-migration-controller.ts', '--run'], {
      cwd: process.cwd(), env: retryEnv, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    })
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
    await execFileAsync('npx', ['tsx', 'scripts/managed-docker-migration-controller.ts', '--run'], {
      cwd: process.cwd(), env: retryEnv, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    })
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
