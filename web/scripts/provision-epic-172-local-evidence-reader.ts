import '../lib/load-env'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// `work_package_local_run_evidence` is owned by `forge_s4_routines_owner` and
// the ordinary Forge application login is denied every privilege on it. S5
// still has to present a few facts from that table (which run produced which
// evidence, and whether it reached a terminal state), so it reads through this
// dedicated principal instead.
//
// The grant is column-scoped on purpose. `claim_token` is a live ownership
// credential and `task_id`/`work_package_id`/`agent_run_id` are the only join
// keys S5 needs; PostgreSQL — not application code — is what refuses a query
// that reaches for the token. That makes the redaction a property of the
// database boundary, so a future careless SELECT fails closed rather than
// leaking.
//
// Run this AFTER migrations: the table must exist and already belong to the S4
// owner before the grant can be issued.
// ---------------------------------------------------------------------------

const READER_ROLE = 'forge_local_evidence_reader'
const EVIDENCE_TABLE = 'public.work_package_local_run_evidence'

const READABLE_COLUMNS = [
  'id',
  'task_id',
  'work_package_id',
  'agent_run_id',
  'state',
  'lease_expires_at',
  'terminal_at',
  'created_at',
] as const

// Never readable by this principal. `claim_token` is the live lease credential;
// the rest are protocol internals S5 has no presentation use for.
const FORBIDDEN_COLUMNS = ['claim_token'] as const

const FORBIDDEN_TABLE_PRIVILEGES = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const

async function main(): Promise<void> {
  const adminUrl = process.env.FORGE_DATABASE_ADMIN_URL?.trim()
  if (!adminUrl) {
    throw new Error('FORGE_DATABASE_ADMIN_URL is required; the ordinary Forge login must not grant S4 read access.')
  }

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    const [role] = await admin<{ canLogin: boolean; isSuperuser: boolean }[]>`
      select rolcanlogin as "canLogin", rolsuper as "isSuperuser"
      from pg_catalog.pg_roles where rolname = ${READER_ROLE}
    `
    if (!role) {
      throw new Error(`${READER_ROLE} must be bootstrapped before its read grant is provisioned.`)
    }
    if (!role.canLogin || role.isSuperuser) {
      throw new Error(`${READER_ROLE} must be an unprivileged login role.`)
    }

    // Role membership defeats every column check below. The reader is
    // NOINHERIT, so `has_column_privilege` reports false for claim_token even
    // when the reader is a member of the table owner — but `SET ROLE` still
    // works, and the session then reads the token and writes the table. A
    // membership in either direction is therefore disqualifying: outbound lets
    // the reader assume a stronger role, inbound lets a stronger role assume
    // the reader. Verified against PostgreSQL 16: without this check the script
    // reported the boundary intact while `SET ROLE` read claim_token.
    const memberships = await admin<{ direction: string; other: string }[]>`
      select 'reader_is_member_of' as "direction", grantee.rolname as "other"
      from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles member on member.oid = membership.member
      join pg_catalog.pg_roles grantee on grantee.oid = membership.roleid
      where member.rolname = ${READER_ROLE}
      union all
      select 'is_member_of_reader' as "direction", member.rolname as "other"
      from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles member on member.oid = membership.member
      join pg_catalog.pg_roles grantee on grantee.oid = membership.roleid
      where grantee.rolname = ${READER_ROLE}
    `
    if (memberships.length > 0) {
      throw new Error(
        `${READER_ROLE} must hold no role memberships; found ${
          memberships.map((row) => `${row.direction}=${row.other}`).join(', ')
        }. A membership grants SET ROLE, which bypasses the column-scoped boundary.`,
      )
    }

    const [database] = await admin<{ name: string }[]>`select current_database() as name`
    await admin.unsafe(`grant connect on database ${admin(database.name).toString()} to ${READER_ROLE}`)
      .catch(async () => {
        await admin`grant connect on database ${admin(database.name)} to ${admin(READER_ROLE)}`
      })
    await admin`grant usage on schema public to ${admin(READER_ROLE)}`
    await admin.unsafe(
      `grant select (${READABLE_COLUMNS.join(', ')}) on ${EVIDENCE_TABLE} to ${READER_ROLE}`,
    )

    // Verify the boundary rather than assuming the grants landed as intended.
    const readable = await admin<{ column: string; granted: boolean }[]>`
      select column_name as "column",
        pg_catalog.has_column_privilege(${READER_ROLE}, ${EVIDENCE_TABLE}, column_name, 'SELECT') as "granted"
      from information_schema.columns
      where table_schema = 'public' and table_name = 'work_package_local_run_evidence'
    `
    const missing = READABLE_COLUMNS.filter((column) => (
      !readable.some((row) => row.column === column && row.granted)
    ))
    if (missing.length > 0) {
      throw new Error(`${READER_ROLE} is missing SELECT on: ${missing.join(', ')}`)
    }
    const leaked = FORBIDDEN_COLUMNS.filter((column) => (
      readable.some((row) => row.column === column && row.granted)
    ))
    if (leaked.length > 0) {
      throw new Error(`${READER_ROLE} unexpectedly has SELECT on: ${leaked.join(', ')}`)
    }
    // A column the grant does not name must stay unreadable even if the schema
    // later adds one; anything outside the explicit list is a boundary break.
    const unexpected = readable
      .filter((row) => row.granted && !READABLE_COLUMNS.includes(row.column as typeof READABLE_COLUMNS[number]))
      .map((row) => row.column)
    if (unexpected.length > 0) {
      throw new Error(`${READER_ROLE} unexpectedly has SELECT on unlisted columns: ${unexpected.join(', ')}`)
    }

    for (const privilege of FORBIDDEN_TABLE_PRIVILEGES) {
      const [held] = await admin<{ granted: boolean }[]>`
        select pg_catalog.has_table_privilege(${READER_ROLE}, ${EVIDENCE_TABLE}, ${privilege}) as "granted"
      `
      if (held.granted) {
        throw new Error(`${READER_ROLE} unexpectedly has ${privilege} on ${EVIDENCE_TABLE}`)
      }
    }
    const [schemaCreate] = await admin<{ granted: boolean }[]>`
      select pg_catalog.has_schema_privilege(${READER_ROLE}, 'public', 'CREATE') as "granted"
    `
    if (schemaCreate.granted) {
      throw new Error(`${READER_ROLE} must not be able to create objects in public.`)
    }

    console.log(`✓ Provisioned and verified the column-scoped S5 read boundary for ${READER_ROLE}.`)
    console.log(`  Readable: ${READABLE_COLUMNS.join(', ')}`)
    console.log(`  Denied: ${FORBIDDEN_COLUMNS.join(', ')} plus every write privilege.`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
