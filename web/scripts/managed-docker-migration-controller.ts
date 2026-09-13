/** Managed-Docker protected migration lifecycle. This controller owns the
 * complete fence: application quiescence through verified cleanup. */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmod, chown, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { assertProtectedMigrationLiveAttestation, ensureProtectedMigrationState, markProtectedMigrationControllerFenced, prepareProtectedMigrationController, recordProtectedMigrationCleanup, recordProtectedMigrationHandoff, type ProtectedMigrationDatabaseSnapshot } from './ci/protected-migration-state'
import { assertProtectedMigrationMarkers, protectedMigrationForTag } from './ci/protected-migration-registry'
import { createEphemeralMigrationUrl, createMigrationChildEnvironment } from './ci/managed-migration-child-environment'
import { runWithDatabaseUrlSentinel } from './ci/bootstrap-database-urls'
import { runEpic172ReleaseRoleBootstrap } from './bootstrap-epic-172-release-roles'
import { runEpic172S3OwnerBootstrap } from './bootstrap-epic-172-s3-release-owner'
import { runEpic172S4RoleBootstrap } from './bootstrap-epic-172-s4-roles'
import { runEpic172LegacyReleaseRepair } from './repair-epic-172-legacy-release'
import { runEpic172S5OwnerBootstrap } from './bootstrap-epic-172-s5-recovery-owner'

const LOCK = 334001
const RUNTIME_MIGRATION_TAG = '0034_vnext_phase0_a1_runtime_foundation'
const RUNTIME_MIGRATION_CREATED_AT = 1786838400000
const OWNER = 'forge_runtime_routines_owner'
const API = 'forge_runtime_api'
const execFileAsync = promisify(execFile)
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
const safe = (value: string) => { if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Unsafe PostgreSQL identifier.'); return `"${value}"` }
type DatabaseAcl = Array<{ grantorOid: number; grantor: string; granteeOid: number; grantee: string; privilege: string; grantable: boolean }>
const quoteCatalogIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`
const normalizeDatabaseAcl = (value: unknown): DatabaseAcl => {
  if (!Array.isArray(value)) throw new Error('Managed migration durable database ACL is not an array.')
  return value.map((candidate) => {
    const entry = candidate as Partial<DatabaseAcl[number]>
    if (!Number.isInteger(entry.grantorOid) || Number(entry.grantorOid) <= 0 || typeof entry.grantor !== 'string' || entry.grantor.length === 0
      || !Number.isInteger(entry.granteeOid) || Number(entry.granteeOid) < 0 || typeof entry.grantee !== 'string' || entry.grantee.length === 0
      || (entry.granteeOid === 0) !== (entry.grantee === 'PUBLIC')
      || !['CONNECT', 'CREATE', 'TEMPORARY'].includes(entry.privilege ?? '') || typeof entry.grantable !== 'boolean') {
      throw new Error('Managed migration durable database ACL contains an invalid entry.')
    }
    return entry as DatabaseAcl[number]
  })
}
const databaseSnapshotDigest = (databaseName: string, databaseOid: number, databaseOwnerOid: number, acl: unknown) => {
  const normalizedAcl = normalizeDatabaseAcl(acl).map((entry) => [entry.grantorOid, entry.grantor, entry.granteeOid, entry.grantee, entry.privilege, entry.grantable])
  return createHash('sha256').update(JSON.stringify([databaseName, databaseOid, databaseOwnerOid, normalizedAcl])).digest('hex')
}

function orderAclReplay(snapshot: ProtectedMigrationDatabaseSnapshot): DatabaseAcl {
  const pending = [...normalizeDatabaseAcl(snapshot.acl)]
  const ordered: DatabaseAcl = []
  const grantAuthority = new Map<string, Set<number>>()
  for (const privilege of ['CONNECT', 'CREATE', 'TEMPORARY']) grantAuthority.set(privilege, new Set([snapshot.databaseOwnerOid]))
  while (pending.length > 0) {
    const index = pending.findIndex((entry) => grantAuthority.get(entry.privilege)?.has(entry.grantorOid))
    if (index < 0) throw new Error('Managed migration durable database ACL has an unreplayable grantor dependency.')
    const [entry] = pending.splice(index, 1)
    ordered.push(entry)
    if (entry.grantable && entry.granteeOid !== 0) grantAuthority.get(entry.privilege)?.add(entry.granteeOid)
  }
  return ordered
}

async function snapshotDatabaseAcl(sql: ReturnType<typeof postgres>): Promise<ProtectedMigrationDatabaseSnapshot> {
  const [identity] = await sql<{ databaseName: string; databaseOid: number; databaseOwnerOid: number }[]>`
    select datname as "databaseName", oid::integer as "databaseOid", datdba::integer as "databaseOwnerOid"
    from pg_catalog.pg_database where datname=pg_catalog.current_database()
  `
  if (!identity) throw new Error('Managed migration could not identify its target database.')
  const aclRows = await sql<DatabaseAcl>`
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
  const acl = Array.from(aclRows)
  return { ...identity, acl, aclDigest: databaseSnapshotDigest(identity.databaseName, identity.databaseOid, identity.databaseOwnerOid, acl) }
}

async function fenceRuntimeConnect(sql: ReturnType<typeof postgres>, database: string): Promise<void> {
  const inherited = await sql<{ roleName: string }[]>`
    with recursive authority(role_oid) as (
      select oid from pg_catalog.pg_roles where rolname in ('forge','forge_runtime_api_login')
      union
      select membership.roleid from pg_catalog.pg_auth_members membership
      join authority on authority.role_oid=membership.member
      where membership.inherit_option
    )
    select role_row.rolname as "roleName" from authority
    join pg_catalog.pg_roles role_row on role_row.oid=authority.role_oid
    where role_row.rolname <> current_user
  `
  const targetRoles = inherited.map((row) => row.roleName)
  const grants = await sql<{ grantor: string; grantee: string }[]>`
    select grantor_role.rolname as grantor,
      case when acl.grantee=0 then 'PUBLIC' else grantee_role.rolname end as grantee
    from pg_catalog.pg_database database_row
    cross join lateral pg_catalog.aclexplode(coalesce(database_row.datacl, pg_catalog.acldefault('d',database_row.datdba))) acl
    join pg_catalog.pg_roles grantor_role on grantor_role.oid=acl.grantor
    left join pg_catalog.pg_roles grantee_role on grantee_role.oid=acl.grantee
    where database_row.datname=pg_catalog.current_database() and acl.privilege_type='CONNECT'
      and (acl.grantee=0 or grantee_role.rolname=any(${sql.array(targetRoles)}::name[]))
    order by acl.grantor, acl.grantee
  `
  await sql.begin(async (transaction) => {
    for (const grant of grants) {
      const grantee = grant.grantee === 'PUBLIC' ? 'public' : quoteCatalogIdentifier(grant.grantee)
      await transaction.unsafe(`set local role ${quoteCatalogIdentifier(grant.grantor)}; revoke connect on database ${database} from ${grantee} cascade`)
    }
  })
  const [boundary] = await sql<{ appConnect: boolean; runtimeConnect: boolean }[]>`
    select pg_catalog.has_database_privilege('forge', current_database(), 'connect') as "appConnect",
      pg_catalog.has_database_privilege('forge_runtime_api_login', current_database(), 'connect') as "runtimeConnect"
  `
  if (boundary?.appConnect || boundary?.runtimeConnect) throw new Error('Managed migration failed to fence effective application CONNECT authority.')
}

async function restoreDatabaseAcl(sql: ReturnType<typeof postgres>, database: string, snapshot: ProtectedMigrationDatabaseSnapshot): Promise<void> {
  const current = await snapshotDatabaseAcl(sql)
  if (current.databaseName !== snapshot.databaseName || current.databaseOid !== snapshot.databaseOid
    || current.databaseOwnerOid !== snapshot.databaseOwnerOid
    || databaseSnapshotDigest(snapshot.databaseName, snapshot.databaseOid, snapshot.databaseOwnerOid, snapshot.acl) !== snapshot.aclDigest) {
    throw new Error('Managed migration durable database ACL identity or digest is invalid.')
  }
  for (const entry of normalizeDatabaseAcl(snapshot.acl)) {
    const [identity] = await sql<{ grantor: boolean; grantee: boolean }[]>`
      select exists(select 1 from pg_catalog.pg_roles where oid=${entry.grantorOid}::oid and rolname=${entry.grantor}) as grantor,
        (${entry.granteeOid}=0 or exists(select 1 from pg_catalog.pg_roles where oid=${entry.granteeOid}::oid and rolname=${entry.grantee})) as grantee
    `
    if (!identity?.grantor || !identity.grantee) throw new Error('Managed migration database ACL role identity changed before restoration.')
  }
  await sql.begin(async (transaction) => {
    for (const entry of current.acl as DatabaseAcl) {
      const grantee = entry.grantee === 'PUBLIC' ? 'public' : quoteCatalogIdentifier(entry.grantee)
      await transaction.unsafe(`set local role ${quoteCatalogIdentifier(entry.grantor)}; revoke ${entry.privilege} on database ${database} from ${grantee} cascade`)
    }
    for (const entry of orderAclReplay(snapshot)) {
      const grantee = entry.grantee === 'PUBLIC' ? 'public' : quoteCatalogIdentifier(entry.grantee)
      await transaction.unsafe(`set local role ${quoteCatalogIdentifier(entry.grantor)}; grant ${entry.privilege} on database ${database} to ${grantee}${entry.grantable ? ' with grant option' : ''}`)
    }
  })
  const restored = await snapshotDatabaseAcl(sql)
  if (restored.databaseName !== snapshot.databaseName || restored.databaseOid !== snapshot.databaseOid
    || restored.databaseOwnerOid !== snapshot.databaseOwnerOid || restored.aclDigest !== snapshot.aclDigest) {
    throw new Error('Managed migration did not restore the exact database ACL snapshot including grantors.')
  }
}

async function closeLifecycleCas(sql: ReturnType<typeof postgres>, migrationRole: string, operationId: string, attestedGeneration: bigint): Promise<bigint> {
  const [closed] = await sql`
    update public.forge_protected_migration_handoffs set generation=generation+1, controller_phase='restore_pending'
    where migration_tag=${RUNTIME_MIGRATION_TAG} and migration_role=${migrationRole}::name
      and cleanup_completed_at is not null and controller_phase='cleanup_complete'
      and generation=${attestedGeneration.toString()}::bigint
      and operation_id=${operationId}::uuid
    returning generation
  `
  if (!closed) throw new Error('Managed Docker protected migration cleanup state changed before its CAS close.')
  return BigInt(closed.generation)
}

async function finalizeLifecycleCas(sql: ReturnType<typeof postgres>, operationId: string, expectedGeneration: bigint): Promise<void> {
  const [closed] = await sql`
    update public.forge_protected_migration_handoffs set generation=generation+1, controller_phase='complete'
    where migration_tag=${RUNTIME_MIGRATION_TAG} and operation_id=${operationId}::uuid
      and controller_phase='restore_pending' and generation=${expectedGeneration.toString()}::bigint
    returning generation
  `
  if (!closed) throw new Error('Managed migration ACL restoration lost its final operation/generation fence.')
}

async function openRuntimeHandoff(sql: ReturnType<typeof postgres>, migrationRole: string, runtimePassword: string | null, operationId: string, expectedGeneration: bigint): Promise<bigint> {
  const protectedMigration = protectedMigrationForTag(RUNTIME_MIGRATION_TAG)
  if (!protectedMigration) throw new Error('The managed Docker protected migration is absent from the checked-in registry.')
  await sql.unsafe(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='${OWNER}') then create role ${OWNER} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
    if not exists(select 1 from pg_roles where rolname='${API}') then create role ${API} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
    ${runtimePassword ? `alter role forge_runtime_api_login password '${runtimePassword.replaceAll("'", "''")}';` : ''}
  end $$;
  grant ${API} to forge_runtime_api_login with inherit true;
  grant ${OWNER} to ${safe(migrationRole)};
  grant usage, create on schema public, forge to ${OWNER} with grant option;
  grant usage on schema forge to ${API};
  grant select, references on table public.users, public.sessions, public.tasks, public.projects to ${OWNER};`)
  return recordProtectedMigrationHandoff(sql, protectedMigration, migrationRole, operationId, expectedGeneration)
}

async function closeRuntimeHandoff(sql: ReturnType<typeof postgres>, migrationRole: string, operationId: string, expectedGeneration: bigint): Promise<bigint> {
  const protectedMigration = protectedMigrationForTag(RUNTIME_MIGRATION_TAG)
  if (!protectedMigration) throw new Error('The managed Docker protected migration is absent from the checked-in registry.')
  await sql.unsafe(`revoke ${OWNER} from ${safe(migrationRole)};
    revoke create on schema public, forge from ${OWNER};
    -- 0034 re-grants forge usage to the API group while the owner handoff is
    -- open.  Remove that dependent grant along with the temporary grant
    -- option, then re-issue the exact API usage below as controller/admin.
    revoke grant option for usage on schema public, forge from ${OWNER} cascade;
    revoke select, update, references on table public.users, public.sessions, public.tasks, public.projects from ${OWNER};
    grant usage on schema forge to ${OWNER};
    grant usage on schema forge to ${API};
    grant select, update on table public.sessions to ${OWNER};
    grant select (id, project_id, submitted_by) on table public.tasks to ${OWNER};
    grant select (id, submitted_by, root_ref, root_binding_revision, archived_at) on table public.projects to ${OWNER};`)
  return recordProtectedMigrationCleanup(sql, protectedMigration, migrationRole, operationId, expectedGeneration)
}

/** Runs the shared native/Docker controller. There is intentionally no public
 * prepare command: releasing the fence before the child has finished is unsafe. */
export async function runManagedDockerMigration(): Promise<void> {
  const native = await nativeControllerInputs(process.argv.slice(2))
  const required = (key: string) => {
    const value = process.env[key]?.trim()
    if (!value) throw new Error(`Missing required controller environment value: ${key}.`)
    return value
  }
  const adminUrl = native?.adminUrl ?? required('FORGE_DATABASE_ADMIN_URL')
  const applicationUrl = native?.applicationUrl ?? required('DATABASE_URL')
  const appPassword = native ? native.appPassword : (process.env.FORGE_APP_DATABASE_PASSWORD?.trim() || new URL(applicationUrl).password)
  const runtimePassword = native ? native.runtimePassword : (process.env.FORGE_RUNTIME_API_DATABASE_PASSWORD?.trim()
    || (process.env.FORGE_RUNTIME_DATABASE_URL?.trim() ? new URL(process.env.FORGE_RUNTIME_DATABASE_URL).password : null))
  if (!appPassword) throw new Error('Managed migration requires the application database password from its URL or controller-only environment.')
  const database = safe(new URL(adminUrl).pathname.slice(1))
  const migratorPassword = randomUUID()
  const migrator = `forge_migrator_${randomUUID().replaceAll('-', '')}`
  const migratorExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  const ephemeralMigrationUrl = createEphemeralMigrationUrl(applicationUrl, migrator, migratorPassword)
  const operationId = randomUUID()
  if (process.getuid?.() !== 0) throw new Error('Managed migration controller must retain root while migration children run under a distinct unprivileged identity.')
  const childUid = await selectEphemeralChildUid(native?.peerUid ?? 0)
  const childGid = await validatedReadOnlyTraversalGid(process.cwd())
  const childIdentity = { uid: childUid, gid: childGid ?? childUid }
  process.setgroups?.([])
  const childPrivateDirectory = await mkdtemp('/tmp/forge-migration-child-')
  await chown(childPrivateDirectory, childIdentity.uid, childIdentity.gid)
  await chmod(childPrivateDirectory, 0o700)
  const pool = postgres(adminUrl, { max: 1, onnotice: () => {}, backoff: false })
  let reserved: Awaited<ReturnType<typeof pool.reserve>> | null = null
  let sql = pool
  if (native) {
    if (!process.setegid || !process.seteuid) throw new Error('Managed native controller cannot establish a bounded peer-admin connection on this platform.')
    process.setegid(native.peerGid)
    process.seteuid(native.peerUid)
    try {
      reserved = await pool.reserve()
      sql = reserved as unknown as typeof pool
      const [authority] = await sql<{ sessionUser: string; superuser: boolean }[]>`
        select session_user as "sessionUser", rolsuper as superuser from pg_catalog.pg_roles where rolname=session_user
      `
      if (authority?.sessionUser !== native.adminUser || !authority.superuser) throw new Error('Managed native controller peer session is not the expected administrator.')
    } finally {
      process.seteuid(0)
      process.setegid(0)
    }
  }
  let locked = false
  let fenced = false
  let handoffOpened = false
  let s5HandoffOpened = false
  let databaseAcl: ProtectedMigrationDatabaseSnapshot | null = null
  let restoreGeneration: bigint | null = null
  let lifecycleGeneration: bigint | null = null
  let primaryFailure: unknown = null
  try {
    const journal = JSON.parse(await readFile(resolve(process.cwd(), 'db/migrations/meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> }
    await assertProtectedMigrationMarkers(resolve(process.cwd(), 'db/migrations'), journal.entries.map((entry) => entry.tag))
    const targetEntry = journal.entries.find((entry) => entry.tag === RUNTIME_MIGRATION_TAG)
    const protectedMigration = protectedMigrationForTag(RUNTIME_MIGRATION_TAG)
    if (!protectedMigration || !targetEntry) throw new Error('The managed migration is absent from the checked-in journal or registry.')
    if (targetEntry.when !== RUNTIME_MIGRATION_CREATED_AT) throw new Error('The managed migration journal timestamp changed without a controller contract update.')
    await sql`select pg_advisory_lock(${LOCK})`
    locked = true
    // A blank PostgreSQL cluster has no application roles yet.  Provision the
    // non-privileged identities before the fence references them; PostgreSQL
    // otherwise rejects REVOKE CONNECT for a role that does not exist.
    await sql.unsafe(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='forge_schema_owner') then create role forge_schema_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='forge') then create role forge login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='forge_runtime_api_login') then create role forge_runtime_api_login login noinherit connection limit 5 nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
      alter role forge password '${appPassword.replaceAll("'", "''")}';
    end $$;`)
    // The prepared row is durable before application CONNECT is touched. It
    // carries the exact database/owner identity, normalized grantor-aware ACL,
    // operation, phase, and generation needed after a hard process death.
    const currentDatabaseAcl = await snapshotDatabaseAcl(sql)
    const [ledgerAtStart] = await sql<{ applied: boolean }[]>`
      select exists(select 1 from drizzle.__drizzle_migrations where created_at=${targetEntry.when}) as applied
    `.catch((error: unknown) => {
      if ((error as { code?: string }).code === '42P01') return [{ applied: false }]
      throw error
    })
    const preparation = await prepareProtectedMigrationController(sql, protectedMigration, migrator, migratorPassword, migratorExpiresAt, operationId, currentDatabaseAcl, ledgerAtStart.applied)
    if (preparation.mode === 'complete') {
      await sql.unsafe(`${runtimePassword ? `alter role forge_runtime_api_login password '${runtimePassword.replaceAll("'", "''")}';` : ''}
        grant ${API} to forge_runtime_api_login with inherit true;`)
      await sql.unsafe(await readFile('../scripts/reconcile-forge-app-privileges.sql', 'utf8'))
      await ensureProtectedMigrationState(sql)
      await assertProtectedMigrationLiveAttestation(sql, protectedMigration, preparation.completedMigrationRole!)
      return
    }
    // Snapshot every database privilege, then remove PUBLIC, direct, and
    // inherited application CONNECT authority. The controller connection
    // holding the lock remains alive until exact restoration is verified.
    databaseAcl = preparation.databaseSnapshot
    fenced = true
    await fenceRuntimeConnect(sql, database)
    lifecycleGeneration = await markProtectedMigrationControllerFenced(sql, protectedMigration, operationId, preparation.generation)
    const pauseAfterFence = Number.parseInt(process.env.FORGE_MANAGED_MIGRATION_PAUSE_AFTER_FENCE_MS ?? '0', 10)
    if (pauseAfterFence > 0) await new Promise((resolvePause) => setTimeout(resolvePause, Math.min(pauseAfterFence, 60_000)))
    await sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname=current_database() and usename=any(array['forge','forge_runtime_api_login'])
        and pid <> pg_backend_pid()
    `
    await sql.unsafe(`grant forge_schema_owner to ${safe(migrator)} with inherit true; grant connect, create on database ${database} to forge_schema_owner; grant usage, create on schema public to forge_schema_owner; grant connect on database ${database} to ${safe(migrator)};`)
    // Legacy application objects never remain application-owned. The temporary
    // login only inherits the non-login schema role and is dropped in finally.
    await sql.unsafe(`reassign owned by forge to forge_schema_owner; alter role forge nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit;`)
    const [authority] = await sql<{ appSuper: boolean; appOwnsObjects: boolean }[]>`
      select (select rolsuper from pg_roles where rolname='forge') as "appSuper",
        exists(select 1 from pg_class where relnamespace='public'::regnamespace and relowner='forge'::regrole) as "appOwnsObjects"
    `
    if (authority?.appSuper || authority?.appOwnsObjects) throw new Error('Managed Docker app ownership reconciliation did not reach the required boundary.')

    if (preparation.ledgerApplied) {
      lifecycleGeneration = await openRuntimeHandoff(sql, migrator, runtimePassword, operationId, lifecycleGeneration)
      handoffOpened = true
      lifecycleGeneration = await closeRuntimeHandoff(sql, migrator, operationId, lifecycleGeneration)
      handoffOpened = false
      await sql.unsafe(await readFile('../scripts/reconcile-forge-app-privileges.sql', 'utf8'))
      await ensureProtectedMigrationState(sql)
      const generation = await assertProtectedMigrationLiveAttestation(sql, protectedMigration, migrator)
      restoreGeneration = await closeLifecycleCas(sql, migrator, operationId, generation)
      return
    }

    const childEnv = createMigrationChildEnvironment(ephemeralMigrationUrl, process.env, childPrivateDirectory)
    const childProcess = { cwd: process.cwd(), env: childEnv, ...childIdentity }
    const runChild = (script: string) => execFileAsync(process.execPath, [tsxCli, script], childProcess)
    await execFileAsync(process.execPath, [tsxCli, 'scripts/ci/assert-migration-child-boundary.ts',
      '--controller-pid', String(process.pid),
      '--admin-host', native ? new URL(adminUrl).searchParams.get('host') ?? 'localhost' : new URL(adminUrl).hostname,
      '--admin-port', native ? new URL(adminUrl).searchParams.get('port') ?? '' : new URL(adminUrl).port,
      '--admin-user', native?.adminUser ?? new URL(adminUrl).username,
      '--database', new URL(adminUrl).pathname.slice(1)], childProcess)
    const bootstrapUrls = { adminUrl, migrationUrl: childEnv.DATABASE_URL }

    // Preserve the historical order and bootstrap invariants.  These calls
    // run in this locked controller, not as children carrying admin secrets.
    await runWithDatabaseUrlSentinel(() => runEpic172ReleaseRoleBootstrap(bootstrapUrls))
    await runChild('scripts/ci/migrate-through-0025.ts')
    await runWithDatabaseUrlSentinel(() => runEpic172S3OwnerBootstrap(bootstrapUrls))
    await runChild('scripts/ci/migrate-through-0026.ts')
    await runWithDatabaseUrlSentinel(() => runEpic172LegacyReleaseRepair({ adminUrl }))
    await runWithDatabaseUrlSentinel(() => runEpic172S4RoleBootstrap(bootstrapUrls))
    await runChild('scripts/ci/migrate-through-0027.ts')
    await runWithDatabaseUrlSentinel(() => runEpic172S5OwnerBootstrap(false, bootstrapUrls))
    s5HandoffOpened = true
    await runChild('scripts/ci/migrate-through-0028.ts')
    await runWithDatabaseUrlSentinel(() => runEpic172S5OwnerBootstrap(true, bootstrapUrls))
    s5HandoffOpened = false
    await runWithDatabaseUrlSentinel(() => runEpic172S5OwnerBootstrap(false, bootstrapUrls))
    s5HandoffOpened = true
    await runChild('scripts/ci/migrate-through-0033.ts')
    await runWithDatabaseUrlSentinel(() => runEpic172S5OwnerBootstrap(true, bootstrapUrls))
    s5HandoffOpened = false

    // The protected 0034 owner is not granted until all source objects exist.
    // It also makes the ordinary Drizzle ledger/schema available to the
    // schema-owner context used by the final child without retaining the
    // disposable login as an owner.
    await sql.unsafe(`reassign owned by ${safe(migrator)} to forge_schema_owner;`)
    lifecycleGeneration = await openRuntimeHandoff(sql, migrator, runtimePassword, operationId, lifecycleGeneration!)
    handoffOpened = true
    // This second child applies only 0034 (the ledger has the prefix).  It
    // receives neither administrator authority nor the application passwords.
    await execFileAsync(process.execPath, [tsxCli, 'scripts/ci/migrate-through-0034.ts'], {
      ...childProcess,
    })
    lifecycleGeneration = await closeRuntimeHandoff(sql, migrator, operationId, lifecycleGeneration)
    handoffOpened = false
    // Historical ordinary migrations execute as the disposable session so
    // their exact `current_user` bootstrap guards remain valid.  Transfer any
    // residual ordinary objects before the login is destroyed; protected
    // migration objects have already moved to their dedicated owner roles.
    await sql.unsafe(`reassign owned by ${safe(migrator)} to forge_schema_owner;`)
    // The reconciler is mandatory, not a best-effort repair after reconnect.
    await sql.unsafe(await readFile('../scripts/reconcile-forge-app-privileges.sql', 'utf8'))
    // The shared reconciler grants legacy app access to ordinary public
    // tables.  Reapply the controller-only state ACL after that broad pass.
    await ensureProtectedMigrationState(sql)
    const attestedGeneration = await assertProtectedMigrationLiveAttestation(sql, protectedMigration, migrator)
    restoreGeneration = await closeLifecycleCas(sql, migrator, operationId, attestedGeneration)
  } catch (error) {
    primaryFailure = error
  } finally {
    const cleanupFailures: unknown[] = []
    // Success and every failure path remove the ephemeral login before app
    // reconnect authority is restored; no process receives its credential.
    if (handoffOpened && lifecycleGeneration !== null) {
      try { lifecycleGeneration = await closeRuntimeHandoff(sql, migrator, operationId, lifecycleGeneration) } catch (error) { cleanupFailures.push(error) }
    }
    if (restoreGeneration === null && lifecycleGeneration !== null) {
      try {
        const [ledger] = await sql<{ applied: boolean }[]>`
          select exists(select 1 from drizzle.__drizzle_migrations where created_at=${RUNTIME_MIGRATION_CREATED_AT}) as applied
        `.catch((error: unknown) => {
          if ((error as { code?: string }).code === '42P01') return [{ applied: false }]
          throw error
        })
        if (!ledger.applied) {
          const [rewound] = await sql`
            update public.forge_protected_migration_handoffs
            set controller_phase='fenced', cleanup_completed_at=null, generation=generation+1
            where migration_tag=${RUNTIME_MIGRATION_TAG} and operation_id=${operationId}::uuid
              and generation=${lifecycleGeneration.toString()}::bigint
            returning generation
          `
          if (rewound) lifecycleGeneration = BigInt(rewound.generation)
        }
      } catch (error) { cleanupFailures.push(error) }
    }
    if (s5HandoffOpened) {
      await runWithDatabaseUrlSentinel(() => runEpic172S5OwnerBootstrap(true, { adminUrl, migrationUrl: ephemeralMigrationUrl }))
        .catch((error) => cleanupFailures.push(error))
    }
    const [migrationRoleState] = await sql<{ exists: boolean }[]>`
      select exists(select 1 from pg_catalog.pg_roles where rolname=${migrator}) as exists
    `.catch((error) => { cleanupFailures.push(error); return [{ exists: true }] })
    if (migrationRoleState.exists) {
      await sql.unsafe(`revoke forge_schema_owner from ${safe(migrator)}`).catch((error) => cleanupFailures.push(error))
      // REASSIGN above moved relations; DROP OWNED now removes only residual
      // grants/dependencies that would otherwise keep this expiring login alive.
      await sql.unsafe(`drop owned by ${safe(migrator)}`).catch((error) => cleanupFailures.push(error))
      await sql.unsafe(`drop role ${safe(migrator)}`).catch((error) => cleanupFailures.push(error))
    }
    let restoreFailure: unknown = null
    if (cleanupFailures.length === 0 && fenced && databaseAcl) {
      try { await restoreDatabaseAcl(sql, database, databaseAcl) } catch (error) { restoreFailure = error }
    }
    if (cleanupFailures.length === 0 && !restoreFailure && restoreGeneration !== null) {
      try { await finalizeLifecycleCas(sql, operationId, restoreGeneration) } catch (error) { restoreFailure = error }
    }
    if (locked) await sql`select pg_advisory_unlock(${LOCK})`.catch(() => {})
    reserved?.release()
    await pool.end({ timeout: 5 })
    await rm(childPrivateDirectory, { recursive: true, force: true })
    if (primaryFailure && (cleanupFailures.length > 0 || restoreFailure)) {
      throw new AggregateError([primaryFailure, ...cleanupFailures, ...(restoreFailure ? [restoreFailure] : [])], 'Managed migration failed and cleanup could not safely restore application reconnect authority.')
    }
    if (primaryFailure) throw primaryFailure
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Managed migration cleanup failed; application reconnect authority remains fenced.')
    if (restoreFailure) throw restoreFailure
  }
}

type NativeControllerInputs = Readonly<{
  adminUrl: string
  applicationUrl: string
  appPassword: string
  runtimePassword: string | null
  peerUid: number
  peerGid: number
  adminUser: string
}>

function parseProtectedEnvFile(raw: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values.set(key, value)
  }
  return values
}

async function nativeControllerInputs(args: string[]): Promise<NativeControllerInputs | null> {
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Managed native controller option ${name} requires a value.`)
    return value
  }
  const socket = option('--native-socket')
  if (!socket) return null
  const inheritedAuthority = Object.keys(process.env).filter((key) => key === 'DATABASE_URL' || key === 'FORGE_DATABASE_ADMIN_URL' || key.startsWith('PG'))
  if (inheritedAuthority.length > 0) throw new Error('Managed native controller inherited a forbidden database authority environment.')
  const port = option('--native-port')
  const databaseName = option('--native-database')
  const envFile = option('--native-env-file')
  const repoRoot = option('--native-repo-root')
  const integerOption = (name: string) => {
    const value = option(name)
    if (!value?.match(/^\d+$/) || Number(value) < 1) throw new Error(`Managed native controller option ${name} requires a non-root numeric identity.`)
    return Number(value)
  }
  const peerUid = integerOption('--native-peer-uid')
  const peerGid = integerOption('--native-peer-gid')
  if (!socket.startsWith('/') || !port?.match(/^\d{1,5}$/) || Number(port) < 1 || Number(port) > 65535
    || !databaseName?.match(/^[a-z_][a-z0-9_]*$/i)
    || !envFile?.startsWith('/') || !repoRoot?.startsWith('/')) {
    throw new Error('Managed native controller received invalid non-secret routing arguments.')
  }
  process.chdir(resolve(repoRoot, 'web'))
  if (process.getuid?.() !== 0) throw new Error('Managed native controller requires root with distinct peer-admin and migration-child identities.')
  const protectedValues = parseProtectedEnvFile(await readFile(envFile, 'utf8'))
  const passwd = await readFile('/etc/passwd', 'utf8')
  const adminUser = passwd.split(/\r?\n/).map((line) => line.split(':')).find((fields) => Number(fields[2]) === peerUid)?.[0] ?? ''
  if (!adminUser.match(/^[a-z_][a-z0-9_]*$/i)) throw new Error('Managed native controller could not derive a safe peer administrator identity.')
  const configuredUrl = protectedValues.get('DATABASE_URL')
  if (!configuredUrl) throw new Error('Managed native controller environment file has no DATABASE_URL.')
  const configuredApplication = new URL(configuredUrl)
  if (!['postgres:', 'postgresql:'].includes(configuredApplication.protocol) || configuredApplication.username !== 'forge'
    || configuredApplication.pathname.slice(1) !== databaseName || !configuredApplication.password
    || configuredApplication.hash || Array.from(configuredApplication.searchParams).length > 0) {
    throw new Error('Managed native controller database binding or URL options disagree with its protected environment file.')
  }
  const appCredential = decodeURIComponent(configuredApplication.password)
  const application = new URL(`postgresql://forge:${encodeURIComponent(appCredential)}@localhost/${databaseName}`)
  application.searchParams.set('host', socket)
  application.searchParams.set('port', port)
  const admin = new URL(application)
  admin.username = adminUser
  admin.password = ''
  admin.searchParams.delete('user')
  admin.searchParams.delete('password')
  const runtimeUrl = protectedValues.get('FORGE_RUNTIME_DATABASE_URL')
  return {
    adminUrl: admin.toString(),
    applicationUrl: application.toString(),
    appPassword: protectedValues.get('FORGE_APP_DATABASE_PASSWORD')?.trim() || appCredential,
    runtimePassword: protectedValues.get('FORGE_RUNTIME_API_DATABASE_PASSWORD')?.trim()
      || (runtimeUrl ? new URL(runtimeUrl).password : null),
    peerUid,
    peerGid,
    adminUser,
  }
}

async function selectEphemeralChildUid(forbiddenUid: number): Promise<number> {
  const active = new Set<number>()
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.match(/^\d+$/)) continue
    try {
      const status = await readFile(`/proc/${entry.name}/status`, 'utf8')
      const ids = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m)
      if (ids) for (const value of ids.slice(1)) active.add(Number(value))
    } catch {}
  }
  const passwd = await readFile('/etc/passwd', 'utf8')
  const mapped = new Set(passwd.split(/\r?\n/).map((line) => Number(line.split(':')[2])).filter(Number.isInteger))
  for (let uid = 60000; uid < 65000; uid += 1) {
    if (uid !== forbiddenUid && !active.has(uid) && !mapped.has(uid)) {
      try {
        await execFileAsync('/usr/bin/getent', ['passwd', String(uid)])
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 2) return uid
        throw new Error(`Managed migration controller could not verify child UID ${uid} against NSS (getent status ${String(code)}).`)
      }
    }
  }
  throw new Error('Managed migration controller could not select an unmapped inactive child UID.')
}

async function validatedReadOnlyTraversalGid(start: string, proposed?: number): Promise<number | undefined> {
  let current = resolve(start)
  let required: number | undefined
  while (true) {
    const metadata = await stat(current)
    if ((metadata.mode & 0o022) !== 0) throw new Error(`Managed migration child path is group/other writable: ${current}`)
    if ((metadata.mode & 0o001) === 0) {
      if ((metadata.mode & 0o010) === 0 || (required !== undefined && required !== metadata.gid)) {
        throw new Error(`Managed migration child cannot obtain one read-only repository traversal group at ${current}.`)
      }
      required = metadata.gid
    }
    if (current === '/') break
    current = resolve(current, '..')
  }
  if (proposed !== undefined && required !== undefined && proposed !== required) throw new Error('Managed native child GID does not match the repository traversal boundary.')
  return required ?? proposed
}

if (process.argv.includes('--run')) runManagedDockerMigration().then(() => console.log('✓ Managed Docker migration completed under the serialized controller.')).catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
