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
const MAX_FAILURE_OUTPUT_CHARS = 4096

function redactFailureOutput(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1[redacted]@')
    .replace(/(password\s*(?:=|:|is)\s*)\S+/gi, '$1[redacted]')
    .replace(/(admin|app|runtime|predecessor|delegate)_[0-9a-f-]{16,}/gi, '$1_[redacted]')
    .slice(0, MAX_FAILURE_OUTPUT_CHARS)
}

function describeFailure(error: unknown): string {
  if (error instanceof AggregateError) {
    return redactFailureOutput(`${error.message}; causes=${error.errors.map((cause) => cause instanceof Error ? cause.message : String(cause)).join(' | ')}`)
  }
  return redactFailureOutput(error instanceof Error ? error.message : String(error))
}

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
      else reject(new Error(`Controller process group failed (code=${code ?? 'null'}, signal=${signal ?? 'null'}, timeout=${timedOut}, outputOverflow=${overflowed}). Output: ${redactFailureOutput((stderr || stdout).trim())}`))
    })
  })
}
const container = `forge-334-${randomUUID().replaceAll('-', '')}`
const adminPassword = `admin_${randomUUID().replaceAll('-', '')}`
const appPassword = `app_${randomUUID().replaceAll('-', '')}`
const runtimePassword = `runtime_${randomUUID().replaceAll('-', '')}`
const delegatePassword = `delegate_${randomUUID().replaceAll('-', '')}`
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

async function proveForgeObjectsWithForeignDatabaseOwner(): Promise<void> {
  const scopeContainer = `forge-334-owner-scope-${randomUUID().replaceAll('-', '')}`
  const scopeAdminPassword = `admin_${randomUUID().replaceAll('-', '')}`
  const scopeAppPassword = `app_${randomUUID().replaceAll('-', '')}`
  const scopeRuntimePassword = `runtime_${randomUUID().replaceAll('-', '')}`
  let scopeStarted = false
  let scopeAdmin: ReturnType<typeof postgres> | null = null
  try {
    await execFileAsync('docker', ['run', '--rm', '-d', '--name', scopeContainer,
      '-e', `POSTGRES_PASSWORD=${scopeAdminPassword}`, '-e', 'POSTGRES_DB=forge',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine'])
    scopeStarted = true
    const { stdout } = await execFileAsync('docker', ['port', scopeContainer, '5432/tcp'])
    const port = stdout.trim().match(/:(\d+)$/)?.[1]
    if (!port) throw new Error('The owner-scope PostgreSQL proof did not publish a loopback port.')
    const scopeAdminUrl = `postgresql://postgres:${scopeAdminPassword}@127.0.0.1:${port}/forge`
    const scopeAppUrl = `postgresql://forge:${scopeAppPassword}@127.0.0.1:${port}/forge`
    scopeAdmin = postgres(scopeAdminUrl, { max: 1, connect_timeout: 2, onnotice: () => {} })
    await eventually(() => scopeAdmin!`select 1 as ready`, (rows) => rows[0]?.ready === 1, 'owner-scope PostgreSQL readiness')
    await scopeAdmin.unsafe(`
      create role forge login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${scopeAppPassword}';
      create role forge_runtime_api_login login inherit connection limit 5 nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${scopeRuntimePassword}';
      grant create on database forge to forge;
      grant create on schema public to forge;
    `)
    const scopeApp = postgres(scopeAppUrl, { max: 1, connect_timeout: 2 })
    await scopeApp.unsafe(`
      create schema forge_private_scope authorization forge;
      create type forge_private_scope.proof_type as enum ('proof');
      create sequence forge_private_scope.proof_sequence;
      create function forge_private_scope.proof_function() returns integer language sql as 'select 1';
      create table public.forge_public_scope_proof (id integer);
    `)
    await scopeApp.end({ timeout: 1 })
    await executeController([controllerScript, '--run'], {
      ...process.env, FORGE_DATABASE_ADMIN_URL: scopeAdminUrl, DATABASE_URL: scopeAppUrl,
      FORGE_RUNTIME_API_DATABASE_PASSWORD: scopeRuntimePassword, FORGE_MANAGED_DOCKER_MIGRATIONS: '1',
      CI: 'true', FORGE_MANAGED_MIGRATION_PROOF_HOST_CHILD: '1',
    }, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
    const [boundary] = await scopeAdmin<{ databaseOwner: string; forgeOwned: number; normalizedObjects: number }[]>`
      select pg_catalog.pg_get_userbyid((select datdba from pg_catalog.pg_database where datname=current_database())) as "databaseOwner",
        (select count(*)::integer from pg_catalog.pg_shdepend dependency
          where dependency.refclassid='pg_catalog.pg_authid'::pg_catalog.regclass and dependency.refobjid='forge'::pg_catalog.regrole
            and dependency.deptype='o' and dependency.dbid=(select oid from pg_catalog.pg_database where datname=current_database())) as "forgeOwned",
        ((select count(*)::integer from pg_catalog.pg_class class_row join pg_catalog.pg_namespace namespace_row on namespace_row.oid=class_row.relnamespace
          where (namespace_row.nspname='forge_private_scope' or class_row.relname='forge_public_scope_proof')
            and class_row.relowner='forge_schema_owner'::regrole)
          + (select count(*)::integer from pg_catalog.pg_namespace where nspname='forge_private_scope' and nspowner='forge_schema_owner'::regrole)
          + (select count(*)::integer from pg_catalog.pg_proc procedure_row join pg_catalog.pg_namespace namespace_row on namespace_row.oid=procedure_row.pronamespace
              where namespace_row.nspname='forge_private_scope' and procedure_row.proowner='forge_schema_owner'::regrole)
          + (select count(*)::integer from pg_catalog.pg_type type_row join pg_catalog.pg_namespace namespace_row on namespace_row.oid=type_row.typnamespace
              where namespace_row.nspname='forge_private_scope' and type_row.typname='proof_type' and type_row.typowner='forge_schema_owner'::regrole)) as "normalizedObjects"
    `
    if (boundary.databaseOwner !== 'postgres' || boundary.forgeOwned !== 0 || boundary.normalizedObjects < 5) {
      throw new Error(`Non-forge database owner changed during exact-database object handoff: ${JSON.stringify(boundary)}`)
    }
  } finally {
    if (scopeAdmin) await scopeAdmin.end({ timeout: 1 }).catch(() => {})
    if (scopeStarted) await execFileAsync('docker', ['stop', '--time', '2', scopeContainer]).catch(() => {})
  }
}

async function main(): Promise<void> {
  let started = false
  let admin: ReturnType<typeof postgres> | null = null
  try {
    await proveForgeObjectsWithForeignDatabaseOwner()
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
      grant forge_acl_parent to forge_runtime_api_login with inherit true, set false;
    `)
    const controllerEnv = {
      ...process.env,
      FORGE_DATABASE_ADMIN_URL: adminUrl,
      DATABASE_URL: appUrl,
      FORGE_RUNTIME_API_DATABASE_PASSWORD: runtimePassword,
      FORGE_MANAGED_DOCKER_MIGRATIONS: '1',
      CI: 'true',
      FORGE_MANAGED_MIGRATION_PROOF_HOST_CHILD: '1',
      FORGE_MANAGED_MIGRATION_PAUSE_AFTER_FENCE_MS: '60000',
    }
    // NOLOGIN does not prevent a different login from assuming a role through
    // pg_auth_members. Prove that the controller rejects that topology before
    // durable preparation or any role/ownership mutation.
    await admin.unsafe(`create role forge_membership_probe login password '${delegatePassword}'; grant forge to forge_membership_probe`)
    let incomingMembershipRejected = false
    try {
      await executeController([controllerScript, '--run'], { ...controllerEnv, FORGE_MANAGED_MIGRATION_PAUSE_AFTER_FENCE_MS: '0' }, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
    } catch (error) {
      incomingMembershipRejected = String(error).includes('Controller process group failed')
    }
    const [membershipBoundary] = await admin<{ stateExists: boolean; appLogin: boolean; appSuper: boolean; databaseOwner: string }[]>`
      select pg_catalog.to_regclass('public.forge_protected_migration_handoffs') is not null as "stateExists",
        (select rolcanlogin from pg_catalog.pg_roles where rolname='forge') as "appLogin",
        (select rolsuper from pg_catalog.pg_roles where rolname='forge') as "appSuper",
        pg_catalog.pg_get_userbyid((select datdba from pg_catalog.pg_database where datname=pg_catalog.current_database())) as "databaseOwner"
    `
    if (!incomingMembershipRejected || membershipBoundary.stateExists || !membershipBoundary.appLogin
      || membershipBoundary.appSuper || membershipBoundary.databaseOwner !== 'postgres') {
      throw new Error(`Incoming application-role membership did not fail before durable or cluster-wide mutation: ${JSON.stringify({ incomingMembershipRejected, ...membershipBoundary })}`)
    }
    await admin.unsafe('revoke forge from forge_membership_probe; drop role forge_membership_probe')
    await admin.unsafe('create role forge_set_probe nologin superuser; grant forge_set_probe to forge with inherit false, set true')
    let setCapableMembershipRejected = false
    try {
      await executeController([controllerScript, '--run'], { ...controllerEnv, FORGE_MANAGED_MIGRATION_PAUSE_AFTER_FENCE_MS: '0' }, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
    } catch (error) {
      setCapableMembershipRejected = String(error).includes('Controller process group failed')
    }
    const [setMembershipBoundary] = await admin<{ stateExists: boolean; appLogin: boolean; parentSuper: boolean }[]>`
      select pg_catalog.to_regclass('public.forge_protected_migration_handoffs') is not null as "stateExists",
        (select rolcanlogin from pg_catalog.pg_roles where rolname='forge') as "appLogin",
        (select rolsuper from pg_catalog.pg_roles where rolname='forge_set_probe') as "parentSuper"
    `
    if (!setCapableMembershipRejected || setMembershipBoundary.stateExists || !setMembershipBoundary.appLogin || !setMembershipBoundary.parentSuper) {
      throw new Error(`SET-capable application membership did not fail before durable or role mutation: ${JSON.stringify({ setCapableMembershipRejected, ...setMembershipBoundary })}`)
    }
    await admin.unsafe('revoke forge_set_probe from forge; drop role forge_set_probe')
    // REASSIGN OWNED reaches shared objects. Prove a forge-owned second
    // database causes a pre-snapshot refusal and remains completely unchanged.
    await admin.unsafe('alter database forge owner to forge')
    await admin.unsafe('create database forge_foreign_owner_proof owner forge')
    let foreignOwnerRejected = false
    try {
      await executeController([controllerScript, '--run'], { ...controllerEnv, FORGE_MANAGED_MIGRATION_PAUSE_AFTER_FENCE_MS: '0' }, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
    } catch (error) {
      foreignOwnerRejected = String(error).includes('Controller process group failed')
    }
    const [foreignScope] = await admin<{ currentOwner: string; foreignOwner: string; stateExists: boolean }[]>`
      select (select pg_catalog.pg_get_userbyid(datdba) from pg_catalog.pg_database where datname='forge') as "currentOwner",
        (select pg_catalog.pg_get_userbyid(datdba) from pg_catalog.pg_database where datname='forge_foreign_owner_proof') as "foreignOwner",
        pg_catalog.to_regclass('public.forge_protected_migration_handoffs') is not null as "stateExists"
    `
    if (!foreignOwnerRejected || foreignScope.currentOwner !== 'forge' || foreignScope.foreignOwner !== 'forge' || !foreignScope.stateExists) {
      throw new Error(`Foreign forge-owned database did not fail closed before ownership/state mutation: ${JSON.stringify({ foreignOwnerRejected, ...foreignScope })}`)
    }
    await admin.unsafe('alter database forge_foreign_owner_proof owner to postgres')
    await admin.unsafe('drop database forge_foreign_owner_proof')
    const [rejectedState] = await admin<{ operationId: string | null }[]>`
      select operation_id::text as "operationId" from public.forge_protected_migration_handoffs where migration_tag=${tag}
    `
    const preReassignEnv = {
      ...controllerEnv,
      FORGE_MANAGED_MIGRATION_PAUSE_AFTER_FENCE_MS: '0',
      FORGE_MANAGED_MIGRATION_PAUSE_AFTER_LOGIN_FENCE_MS: '60000',
    }
    const preReassignLaunch = controllerLaunch(['-e', `import('./${controllerScript}').then((module) => module.default.runManagedDockerMigration()).catch((error) => { console.error(error.stack); process.exit(1) })`], preReassignEnv)
    const preReassign = spawn(preReassignLaunch.command, preReassignLaunch.args, {
      cwd: process.cwd(), env: preReassignLaunch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let preReassignOutput = ''
    preReassign.stdout.on('data', (chunk) => { preReassignOutput += String(chunk) })
    preReassign.stderr.on('data', (chunk) => { preReassignOutput += String(chunk) })
    const preReassignExited = new Promise<never>((_resolve, reject) => preReassign.once('exit', (code, signal) =>
      reject(new Error(`controller exited before the NOLOGIN seam (${code ?? signal}): ${redactFailureOutput(preReassignOutput)}`))))
    await Promise.race([eventually(async () => {
      const [row] = await admin!<{ operationId: string | null; phase: string; appLogin: boolean; runtimeLogin: boolean; sessions: number }[]>`
        select handoff.operation_id::text as "operationId", handoff.controller_phase as phase,
          (select rolcanlogin from pg_catalog.pg_roles where rolname='forge') as "appLogin",
          (select rolcanlogin from pg_catalog.pg_roles where rolname='forge_runtime_api_login') as "runtimeLogin",
          (select count(*)::integer from pg_catalog.pg_stat_activity where datname=pg_catalog.current_database()
            and usename in ('forge','forge_runtime_api_login')) as sessions
        from public.forge_protected_migration_handoffs handoff where handoff.migration_tag=${tag}
      `
      return row
    }, (row) => row?.operationId !== rejectedState.operationId && row?.phase === 'prepared'
      && !row.appLogin && !row.runtimeLogin && row.sessions === 0, 'durable NOLOGIN pre-REASSIGN seam'), preReassignExited])
    if (!preReassign.pid) throw new Error('The NOLOGIN-seam controller did not expose a process-group id.')
    process.kill(-preReassign.pid, 'SIGKILL')
    await new Promise<void>((resolve) => preReassign.once('exit', () => resolve()))
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
      throw new Error(`${describeFailure(error)} Controller output: ${redactFailureOutput(firstOutput)} Fixed diagnostics: ${redactFailureOutput(JSON.stringify(diagnostics))}`)
    }
    if (!fenced.operationId || !fenced.databaseOid || !fenced.ownerOid || !fenced.aclDigest?.match(/^[0-9a-f]{64}$/)) {
      throw new Error('The PREPARED/FENCED row omitted crash-recovery identity or ACL evidence.')
    }
    const [ownerBoundary] = await admin<{ databaseOwner: string; forgeOwned: number; appLogin: boolean; runtimeLogin: boolean }[]>`
      select pg_catalog.pg_get_userbyid((select datdba from pg_catalog.pg_database where datname=pg_catalog.current_database())) as "databaseOwner",
        (select count(*)::integer from pg_catalog.pg_shdepend dependency
          where dependency.refclassid='pg_catalog.pg_authid'::pg_catalog.regclass and dependency.refobjid='forge'::pg_catalog.regrole
            and dependency.deptype='o' and (dependency.dbid=(select oid from pg_catalog.pg_database where datname=pg_catalog.current_database())
              or (dependency.dbid=0 and dependency.classid='pg_catalog.pg_database'::pg_catalog.regclass
                and dependency.objid=(select oid from pg_catalog.pg_database where datname=pg_catalog.current_database())))) as "forgeOwned",
        (select rolcanlogin from pg_catalog.pg_roles where rolname='forge') as "appLogin",
        (select rolcanlogin from pg_catalog.pg_roles where rolname='forge_runtime_api_login') as "runtimeLogin"
    `
    if (ownerBoundary.databaseOwner !== 'forge_schema_owner' || ownerBoundary.forgeOwned !== 0 || ownerBoundary.appLogin || ownerBoundary.runtimeLogin) {
      throw new Error(`Forge-owned current database did not reach the owner-free NOLOGIN fence: ${JSON.stringify(ownerBoundary)}`)
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

    const comparableAcl = (value: unknown) => (value as AclEntry[]).map((entry) => [entry.grantorOid, entry.grantor, entry.granteeOid, entry.grantee, entry.privilege, entry.grantable])
    const publishLaunch = controllerLaunch(['-e', `import('./${controllerScript}').then((module) => module.default.runManagedDockerMigration()).catch((error) => { console.error(error.stack); process.exit(1) })`], {
      ...retryEnv, FORGE_MANAGED_MIGRATION_PAUSE_AFTER_ACL_RESTORE_MS: '60000',
    })
    const publish = spawn(publishLaunch.command, publishLaunch.args, {
      cwd: process.cwd(), env: publishLaunch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let publishOutput = ''
    publish.stdout.on('data', (chunk) => { publishOutput += String(chunk) })
    publish.stderr.on('data', (chunk) => { publishOutput += String(chunk) })
    const publishExited = new Promise<never>((_resolve, reject) => publish.once('exit', (code, signal) =>
      reject(new Error(`controller exited before atomic completion publication (${code ?? signal}): ${redactFailureOutput(publishOutput)}`))))
    await Promise.race([eventually(async () => {
      const [row] = await admin!<{ phase: string; appLogin: boolean; runtimeLogin: boolean }[]>`
        select controller_phase as phase,
          (select rolcanlogin from pg_catalog.pg_roles where rolname='forge') as "appLogin",
          (select rolcanlogin from pg_catalog.pg_roles where rolname='forge_runtime_api_login') as "runtimeLogin"
        from public.forge_protected_migration_handoffs where migration_tag=${tag}
      `
      return { row, acl: await readAcl(admin!) }
    }, (state) => state.row?.phase === 'restore_pending' && !state.row.appLogin && !state.row.runtimeLogin
      && JSON.stringify(comparableAcl(state.acl)) === JSON.stringify(comparableAcl(durable.acl)), 'ACL-restored pre-publication seam'), publishExited])
    if (!publish.pid) throw new Error('The pre-publication controller did not expose a process-group id.')
    process.kill(-publish.pid, 'SIGKILL')
    await new Promise<void>((resolve) => publish.once('exit', () => resolve()))
    const { stdout, stderr } = await executeController([controllerScript, '--run'], retryEnv, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
    if (!`${stdout}${stderr}`.includes('Managed migration completed under the serialized controller.')) throw new Error('The restarted controller omitted its success evidence.')

    const [closed] = await admin<{ phase: string; cleanup: boolean; oldRoleExists: boolean; migrators: number }[]>`
      select handoff.controller_phase as phase, handoff.cleanup_completed_at is not null as cleanup,
        exists(select 1 from pg_catalog.pg_roles where rolname=${fenced.migrationRole}) as "oldRoleExists",
        (select count(*)::integer from pg_catalog.pg_roles where rolname ~ '^forge_migrator_[0-9a-f]{32}$') as migrators
      from public.forge_protected_migration_handoffs handoff where migration_tag=${tag}
    `
    if (closed.phase !== 'complete' || !closed.cleanup || closed.oldRoleExists || closed.migrators !== 0) {
      throw new Error('Restart did not CAS-close the durable handoff and remove every ephemeral login.')
    }
    const restoredAcl = await readAcl(admin)
    if (JSON.stringify(comparableAcl(restoredAcl)) !== JSON.stringify(comparableAcl(durable.acl))) throw new Error('Restart did not restore the exact normalized grantor-aware database ACL.')
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
    // A completed rerun deliberately performs no reconnect fence. Kill it at
    // a session-only pause after reconciliation and prove the durable complete
    // row, exact ACL, and both long-lived LOGIN attributes remain recoverable.
    const completedAcl = await readAcl(admin)
    const completedLaunch = controllerLaunch(['-e', `import('./${controllerScript}').then((module) => module.default.runManagedDockerMigration()).catch((error) => { console.error(error.stack); process.exit(1) })`], {
      ...retryEnv, FORGE_MANAGED_MIGRATION_PAUSE_COMPLETED_RERUN_MS: '60000',
    })
    const completed = spawn(completedLaunch.command, completedLaunch.args, {
      cwd: process.cwd(), env: completedLaunch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let completedOutput = ''
    completed.stdout.on('data', (chunk) => { completedOutput += String(chunk) })
    completed.stderr.on('data', (chunk) => { completedOutput += String(chunk) })
    const completedExited = new Promise<never>((_resolve, reject) => completed.once('exit', (code, signal) =>
      reject(new Error(`completed controller exited before its no-fence pause (${code ?? signal}): ${redactFailureOutput(completedOutput)}`))))
    await Promise.race([eventually(async () => {
      const [row] = await admin!<{ paused: boolean; phase: string; appLogin: boolean; runtimeLogin: boolean }[]>`
        select exists(select 1 from pg_catalog.pg_stat_activity where datname=pg_catalog.current_database()
            and application_name='forge_completed_rerun_pause') as paused,
          (select controller_phase from public.forge_protected_migration_handoffs where migration_tag=${tag}) as phase,
          (select rolcanlogin from pg_catalog.pg_roles where rolname='forge') as "appLogin",
          (select rolcanlogin from pg_catalog.pg_roles where rolname='forge_runtime_api_login') as "runtimeLogin"
      `
      return row
    }, (row) => row?.paused && row.phase === 'complete' && row.appLogin && row.runtimeLogin, 'completed rerun no-fence pause'), completedExited])
    if (!completed.pid) throw new Error('The completed-rerun controller did not expose a process-group id.')
    process.kill(-completed.pid, 'SIGKILL')
    await new Promise<void>((resolve) => completed.once('exit', () => resolve()))
    const completedAclAfterKill = await readAcl(admin)
    if (JSON.stringify(comparableAcl(completedAclAfterKill)) !== JSON.stringify(comparableAcl(completedAcl))) {
      throw new Error('Completed rerun changed the database ACL before its no-fence crash seam.')
    }
    await executeController([controllerScript, '--run'], retryEnv, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
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
    console.error(describeFailure(error))
    process.exit(1)
  })
