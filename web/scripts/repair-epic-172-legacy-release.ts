import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { getRequiredEnv } from '@/lib/env'

const legacy0023 = 'bf855fc0d4f110864badedf287c987adbe7913059b3673d385c81b1dbc2d9d31'
const current0023 = 'e8234134bb5356d2c0093d4618a6e60251e2c16b8bdf8dcacfd5673cbbafbe85'
const legacy0025 = '46d68b45f7c0a61d247f7f87770e25b029f9b4bc4ebb904cf33bf57400963d04'
const current0025 = '1fa66528143fad4b17dd91e64d64a07135098e4102f6ab5441e167e5458496de'
const migration0023At = 1784258966103
const migration0025At = 1784263200000
const migration0026At = 1784266800000
const migration0027At = 1784270400000
const migration0028At = 1784274000000
const current0026 = '3434290ee6253c1cfe2b26e482228fceeba017417d0f4449aabcefa900d2d207'
const current0027 = '8cf249d0ba7f10dca9ac1721677a5c6f4c5080d3f9f478156f72e0ac21c5ebd8'
const current0028 = '7b6019d9d2a3a069c51e26a729e071982ddbbd20726727107c2b8c0ad08ee78a'
const repairArtifactSha256 = '1391a720f3215bdfe93ab2092acab2f8d54485efb5e0bb0dc8dcf9812c0b3e77'
const repairArtifact = resolve(dirname(fileURLToPath(import.meta.url)), '../db/repairs/epic-172-legacy-0023-0025-v1.sql')

// `pg_get_functiondef` is deliberately fingerprinted rather than merely
// checking routine names.  A same-signature routine with a changed body or
// SECURITY DEFINER setting is not a repairable legacy database.
const legacyRoutineDigests = [
  'forge.assert_epic_172_transition_authorization_live_v1(uuid,text)|0f3b6819772f08e543c44443f580628c',
  'forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text)|32055e9fe18f23a6f7be13ebf2fccfbc',
  'forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamp with time zone,jsonb)|b61f528e377f2612d4fd7d04f054f8d1',
  'forge.record_epic_172_transition_authorization_v1(uuid,text,text,jsonb,text,integer,text,jsonb,text,bigint,text,text,text,text,uuid,bigint,text,bytea,uuid,timestamp with time zone,timestamp with time zone,jsonb)|8c2c1ef232a2be1322f1798f6bf5e4de',
] as const
const repairedRoutineDigests = [
  'forge.activate_epic_172_release_signer_v1(uuid,uuid,bigint,text,text)|72b10b3063314dc828bf3b543ec7b58d',
  'forge.assert_epic_172_transition_authorization_live_v1(uuid,text)|0f3b6819772f08e543c44443f580628c',
  'forge.constant_time_equal_32_v1(bytea,bytea)|f88bdc5074bead3ba85d8e7ba9c74ce2',
  'forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text)|32055e9fe18f23a6f7be13ebf2fccfbc',
  'forge.epic_172_controller_lease_digest_v1(bytea)|df55e7eaac723e8e1930f28b9113dc9a',
  'forge.install_epic_172_release_signer_v1(uuid,bigint,bytea,text,text,timestamp with time zone,timestamp with time zone,text,text)|a3eba357126595a03e6ce29973c3ab7c',
  'forge.lock_epic_172_release_receipts_v1(uuid[])|34346e7fb66e623c28002a1697e1a727',
  'forge.lock_epic_172_signer_for_verification_v1(uuid)|906e46a9908e246837307438cf3b6c9d',
  'forge.lock_epic_172_transition_verification_v1(uuid[],uuid)|3b14e969ed9271a2ab28165954d0fe95',
  'forge.read_epic_172_enablement_state_v1()|0ecbb7c627fee83a5663f7a6215696bb',
  'forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamp with time zone,jsonb)|2f234098aacdab4dc49843c2b9700f74',
  'forge.record_epic_172_transition_authorization_v1(uuid,text,text,jsonb,text,integer,text,jsonb,text,bigint,text,text,text,text,uuid,bigint,text,bytea,uuid,timestamp with time zone,timestamp with time zone,jsonb)|1a4b77fad6e7af15c6a519a21030a9bc',
  'forge.retire_epic_172_release_signer_v1(uuid,bigint,text,text)|83aaa1c27d96e715d250138922d731f5',
] as const

const s4Roles = [
  'forge_s4_routines_owner', 'forge_architect_plan_writer',
  'forge_architect_plan_resolver', 'forge_architect_plan_history_reader',
  'forge_packet_issuer', 'forge_review_source_resolver',
  'forge_s4_recovery_operator', 'forge_local_projection_archiver',
  'forge_local_evidence_reader', 'forge_project_root_reconciler',
] as const
const protectedReleaseTables = [
  'forge_epic_172_enablement_state', 'forge_epic_172_enablement_transition_audits',
  'forge_epic_172_release_evidence', 'forge_epic_172_release_evidence_consumptions',
  'forge_epic_172_transition_authorizations', 'forge_release_signer_key_lifecycle_audits',
  'forge_release_signer_keys',
] as const
const releaseRoutineNames = [
  'activate_epic_172_release_signer_v1', 'assert_epic_172_transition_authorization_live_v1',
  'constant_time_equal_32_v1', 'consume_epic_172_release_evidence_v1',
  'epic_172_controller_lease_digest_v1', 'install_epic_172_release_signer_v1',
  'lock_epic_172_release_receipts_v1', 'lock_epic_172_signer_for_verification_v1',
  'lock_epic_172_transition_verification_v1', 'read_epic_172_enablement_state_v1',
  'record_epic_172_release_evidence_v1', 'record_epic_172_transition_authorization_v1',
  'retire_epic_172_release_signer_v1',
] as const
const writerRoutineNames = new Set([
  'record_epic_172_release_evidence_v1', 'record_epic_172_transition_authorization_v1',
  'install_epic_172_release_signer_v1', 'activate_epic_172_release_signer_v1',
  'retire_epic_172_release_signer_v1', 'lock_epic_172_signer_for_verification_v1',
  'lock_epic_172_release_receipts_v1',
])
const transitionRoutineNames = new Set([
  'assert_epic_172_transition_authorization_live_v1', 'consume_epic_172_release_evidence_v1',
  'epic_172_controller_lease_digest_v1', 'lock_epic_172_signer_for_verification_v1',
  'lock_epic_172_release_receipts_v1', 'lock_epic_172_transition_verification_v1',
])
const legacyConstraints = new Map<string, string>([
  ['forge_epic_172_enablement_sha_chk', "CHECK (((reviewed_sha IS NULL) OR (reviewed_sha ~ '^[0-9a-f]{40,64}$'::text)))"],
  ['forge_epic_172_enablement_token_chk', "CHECK (((controller_token_digest IS NULL) OR (controller_token_digest ~ '^[0-9a-f]{64}$'::text)))"],
  ['forge_epic_172_release_evidence_sha_chk', "CHECK ((reviewed_sha ~ '^[0-9a-f]{40,64}$'::text))"],
  ['forge_epic_172_transition_authorizations_sha_chk', "CHECK ((reviewed_sha ~ '^[0-9a-f]{40,64}$'::text))"],
  ['forge_release_signer_keys_lifecycle_chk', "CHECK ((((status = 'active'::text) AND (retirement_started_at IS NULL) AND (retired_at IS NULL)) OR ((status = 'retiring'::text) AND (retirement_started_at IS NOT NULL) AND (retired_at IS NULL)) OR ((status = 'retired'::text) AND (retirement_started_at IS NOT NULL) AND (retired_at IS NOT NULL))))"],
  ['forge_release_signer_keys_status_chk', "CHECK ((status = ANY (ARRAY['active'::text, 'retiring'::text, 'retired'::text])))"],
  ['forge_release_signer_lifecycle_new_status_chk', "CHECK ((new_status = ANY (ARRAY['active'::text, 'retiring'::text, 'retired'::text])))"],
  ['forge_release_signer_lifecycle_prior_status_chk', "CHECK (((prior_status IS NULL) OR (prior_status = ANY (ARRAY['active'::text, 'retiring'::text, 'retired'::text]))))"],
])
const repairedConstraints = new Map<string, string>([
  ['forge_epic_172_enablement_sha_chk', "CHECK (((reviewed_sha IS NULL) OR (reviewed_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'::text)))"],
  ['forge_epic_172_enablement_token_chk', 'CHECK (((controller_token_digest IS NULL) OR (octet_length(controller_token_digest) = 32)))'],
  ['forge_epic_172_release_evidence_required_evidence_chk', "CHECK (((jsonb_typeof(required_evidence) = 'array'::text) AND (jsonb_array_length(required_evidence) > 0)))"],
  ['forge_epic_172_release_evidence_sha_chk', "CHECK ((reviewed_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'::text))"],
  ['forge_epic_172_transition_authorizations_sha_chk', "CHECK ((reviewed_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'::text))"],
  ['forge_release_signer_keys_lifecycle_chk', "CHECK ((((status = 'staged'::text) AND (activated_at IS NULL) AND (retirement_started_at IS NULL) AND (retired_at IS NULL)) OR ((status = 'active'::text) AND (activated_at IS NOT NULL) AND (retirement_started_at IS NULL) AND (retired_at IS NULL)) OR ((status = 'retiring'::text) AND (activated_at IS NOT NULL) AND (retirement_started_at IS NOT NULL) AND (retired_at IS NULL)) OR ((status = 'retired'::text) AND (activated_at IS NOT NULL) AND (retirement_started_at IS NOT NULL) AND (retired_at IS NOT NULL))))"],
  ['forge_release_signer_keys_status_chk', "CHECK ((status = ANY (ARRAY['staged'::text, 'active'::text, 'retiring'::text, 'retired'::text])))"],
  ['forge_release_signer_lifecycle_new_status_chk', "CHECK ((new_status = ANY (ARRAY['staged'::text, 'active'::text, 'retiring'::text, 'retired'::text])))"],
  ['forge_release_signer_lifecycle_prior_status_chk', "CHECK (((prior_status IS NULL) OR (prior_status = ANY (ARRAY['staged'::text, 'active'::text, 'retiring'::text, 'retired'::text]))))"],
])
const releaseTriggerFingerprints = [
  'forge_epic_172_enablement_audits_append_only|forge_epic_172_enablement_transition_audits|forge_epic_172_reject_mutation_v1()|O|39b516f25d2c568c90655e333c25cbf7',
  'forge_epic_172_enablement_state_no_delete|forge_epic_172_enablement_state|forge_epic_172_reject_mutation_v1()|O|4e035d84c983bfabe00688a2e059836e',
  'forge_epic_172_release_consumptions_append_only|forge_epic_172_release_evidence_consumptions|forge_epic_172_reject_mutation_v1()|O|ab4fab26e1ee5369aa5f1004a72134be',
  'forge_epic_172_release_evidence_append_only|forge_epic_172_release_evidence|forge_epic_172_reject_mutation_v1()|O|b4e0230edcf7317ad9a9c24655909bad',
  'forge_epic_172_transition_authorizations_append_only|forge_epic_172_transition_authorizations|forge_epic_172_reject_mutation_v1()|O|7b4f12a1508031c69000d952fa12e522',
  'forge_release_signer_keys_no_delete|forge_release_signer_keys|forge_epic_172_reject_mutation_v1()|O|13c0c6f1e332701344f8131ac2693e2d',
  'forge_release_signer_lifecycle_append_only|forge_release_signer_key_lifecycle_audits|forge_epic_172_reject_mutation_v1()|O|09159d710dac8a28733eedc0296b022d',
] as const

function expectedRoutineAcl(
  identity: string,
  expectS4ReadExecute: boolean,
  migrationLogin: string | null,
): string {
  const name = identity.slice('forge.'.length, identity.indexOf('('))
  const grants = ['forge_release_routines_owner:EXECUTE:false:forge_release_routines_owner']
  if (writerRoutineNames.has(name)) grants.push('forge_release_evidence_writer:EXECUTE:false:forge_release_routines_owner')
  if (transitionRoutineNames.has(name)) grants.push('forge_release_transition:EXECUTE:false:forge_release_routines_owner')
  if (expectS4ReadExecute && name === 'read_epic_172_enablement_state_v1') {
    grants.push('forge_s4_routines_owner:EXECUTE:false:forge_release_routines_owner')
  }
  if (migrationLogin && name === 'read_epic_172_enablement_state_v1') {
    grants.push(`${migrationLogin}:EXECUTE:false:forge_release_routines_owner`)
  }
  return grants.sort().join(',')
}

async function exactRoutines(
  sql: postgres.Sql | postgres.TransactionSql,
  expected: readonly string[],
  expectPublicExecute: boolean,
  expectS4ReadExecute: boolean,
  migrationLogin: string | null,
): Promise<boolean> {
  const rows = await sql<readonly {
    identity: string
    definitionDigest: string
    owner: string
    securityDefiner: boolean
    config: readonly string[] | null
    publicExecute: boolean
    acl: string
  }[]>`
    SELECT p.oid::pg_catalog.regprocedure::text AS identity,
      pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) AS "definitionDigest",
      owner_role.rolname AS owner, p.prosecdef AS "securityDefiner",
      p.proconfig AS config,
      EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
        ) privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS "publicExecute",
      (SELECT pg_catalog.string_agg(
        COALESCE(grantee.rolname, 'PUBLIC') || ':' || privilege.privilege_type || ':'
          || privilege.is_grantable || ':' || grantor.rolname,
        ',' ORDER BY COALESCE(grantee.rolname, 'PUBLIC'), privilege.privilege_type, privilege.is_grantable, grantor.rolname
      ) FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) privilege
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
      JOIN pg_catalog.pg_roles grantor ON grantor.oid = privilege.grantor) AS acl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = p.proowner
    WHERE n.nspname = 'forge'
      AND p.proname = ANY(${sql.array([...releaseRoutineNames])}::text[])
    ORDER BY 1
  `
  const actual = rows.map((row) => `${row.identity}|${row.definitionDigest}`)
  if (actual.length !== expected.length || actual.some((row, index) => row !== expected[index])) return false
  return rows.every((row) => (
    row.owner === 'forge_release_routines_owner'
    && row.securityDefiner
    && row.config?.length === 1
    && row.config[0] === 'search_path=pg_catalog, public'
    && row.publicExecute === expectPublicExecute
    && row.acl === expectedRoutineAcl(row.identity, expectS4ReadExecute, migrationLogin)
  ))
}

async function exactReleaseRoleBoundary(
  sql: postgres.Sql | postgres.TransactionSql,
  expectLegacyConsumer: boolean,
): Promise<boolean> {
  const releaseRoles = [
    'forge_release_evidence_writer', 'forge_release_transition', 'forge_release_routines_owner',
    ...(expectLegacyConsumer ? ['forge_release_evidence_consumer'] : []),
  ].sort()
  const roles = await sql<readonly {
    name: string; login: boolean; inherit: boolean; superuser: boolean; createdb: boolean; createrole: boolean; replication: boolean; bypassrls: boolean
  }[]>`
    SELECT rolname AS name, rolcanlogin AS login, rolinherit AS inherit,
      rolsuper AS superuser, rolcreatedb AS createdb, rolcreaterole AS createrole,
      rolreplication AS replication, rolbypassrls AS bypassrls
    FROM pg_catalog.pg_roles
    WHERE rolname = ANY(ARRAY[
      'forge_release_evidence_writer', 'forge_release_transition',
      'forge_release_routines_owner', 'forge_release_evidence_consumer'
    ])
    ORDER BY 1
  `
  if (roles.length !== releaseRoles.length || roles.some((role, index) => (
    role.name !== releaseRoles[index]
    || role.inherit || role.superuser || role.createdb || role.createrole || role.replication || role.bypassrls
    || role.login !== (role.name !== 'forge_release_routines_owner')
  ))) return false
  const [edges] = await sql<readonly { count: number }[]>`
    SELECT pg_catalog.count(*)::integer AS count
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    WHERE granted.rolname = ANY(ARRAY[
      'forge_release_evidence_writer', 'forge_release_transition',
      'forge_release_routines_owner', 'forge_release_evidence_consumer'
    ]) OR member.rolname = ANY(ARRAY[
      'forge_release_evidence_writer', 'forge_release_transition',
      'forge_release_routines_owner', 'forge_release_evidence_consumer'
    ])
  `
  return edges?.count === 0
}

async function exactS4RoleBoundary(
  sql: postgres.Sql | postgres.TransactionSql,
  allowInertS4: boolean,
  migrationLogin: string | null,
): Promise<boolean> {
  const roles = await sql<readonly {
    name: string; login: boolean; inherit: boolean; superuser: boolean; createdb: boolean; createrole: boolean; replication: boolean; bypassrls: boolean
  }[]>`
    SELECT rolname AS name, rolcanlogin AS login, rolinherit AS inherit,
      rolsuper AS superuser, rolcreatedb AS createdb, rolcreaterole AS createrole,
      rolreplication AS replication, rolbypassrls AS bypassrls
    FROM pg_catalog.pg_roles
    WHERE rolname = ANY(${sql.array([...s4Roles])}::text[])
    ORDER BY 1
  `
  if (!allowInertS4 ? roles.length !== 0 : (roles.length !== s4Roles.length || roles.some((role) => (
    role.inherit || role.superuser || role.createdb || role.createrole || role.replication || role.bypassrls
    || role.login !== (role.name !== 'forge_s4_routines_owner')
  )))) return false
  const [s4Authority] = await sql<readonly { relationGrants: number; routineGrants: number; databaseGrants: number; ownedObjects: number }[]>`
    SELECT
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) privilege
       WHERE privilege.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[]))) AS "relationGrants",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_proc routine
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) privilege
       WHERE privilege.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[]))) AS "routineGrants",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_database database_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(database_row.datacl, pg_catalog.acldefault('d', database_row.datdba))) privilege
       WHERE database_row.datname = pg_catalog.current_database()
         AND privilege.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[]))) AS "databaseGrants",
      ((SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class relation
        WHERE relation.relowner IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[])))
       + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_proc routine
          WHERE routine.proowner IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[])))
       + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_namespace namespace_row
          WHERE namespace_row.nspowner IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[])))
       + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_database database_row
          WHERE database_row.datname = pg_catalog.current_database()
            AND database_row.datdba IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[])))) AS "ownedObjects"
  `
  if (!s4Authority || s4Authority.relationGrants !== 0 || s4Authority.routineGrants !== 0
    || s4Authority.databaseGrants !== 0 || s4Authority.ownedObjects !== 0) return false
  const schemaGrants = await sql<readonly { role: string; schema: string; privilege: string; grantable: boolean }[]>`
    SELECT grantee.rolname AS role, namespace_row.nspname AS schema,
      privilege.privilege_type AS privilege, privilege.is_grantable AS grantable
    FROM pg_catalog.pg_namespace namespace_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))
    ) privilege
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE grantee.rolname = ANY(${sql.array([...s4Roles])}::text[])
    ORDER BY 1, 2, 3
  `
  const [edges] = await sql<readonly { count: number }[]>`
    SELECT pg_catalog.count(*)::integer AS count
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    WHERE granted.rolname = ANY(${sql.array([...s4Roles])}::text[])
       OR member.rolname = ANY(${sql.array([...s4Roles])}::text[])
  `
  if (edges?.count !== 0) return false
  if (!await exactForgeSchemaAcl(sql, allowInertS4, migrationLogin)) return false
  if (!allowInertS4) return schemaGrants.length === 0
  const inertUsageRoles = [
    'forge_architect_plan_history_reader', 'forge_architect_plan_resolver',
    'forge_architect_plan_writer', 'forge_local_projection_archiver',
    'forge_packet_issuer', 'forge_project_root_reconciler',
    'forge_review_source_resolver', 'forge_s4_recovery_operator', 'forge_s4_routines_owner',
  ]
  return schemaGrants.length === inertUsageRoles.length && schemaGrants.every((grant, index) => (
    grant.role === inertUsageRoles[index] && grant.schema === 'forge'
    && grant.privilege === 'USAGE' && !grant.grantable
  ))
}

async function exactZeroAuthorityS4Roles(
  sql: postgres.Sql | postgres.TransactionSql,
  migrationLogin: string | null,
): Promise<boolean> {
  const roles = await sql<readonly { name: string; login: boolean; inherit: boolean; superuser: boolean; createdb: boolean; createrole: boolean; replication: boolean; bypassrls: boolean }[]>`
    SELECT rolname AS name, rolcanlogin AS login, rolinherit AS inherit, rolsuper AS superuser,
      rolcreatedb AS createdb, rolcreaterole AS createrole, rolreplication AS replication, rolbypassrls AS bypassrls
    FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[]) ORDER BY 1
  `
  if (roles.length !== s4Roles.length || roles.some((role) => (
    role.inherit || role.superuser || role.createdb || role.createrole || role.replication || role.bypassrls
    || role.login !== (role.name !== 'forge_s4_routines_owner')
  ))) return false
  const [authority] = await sql<readonly { memberships: number; owned: number; tableGrants: number; routineGrants: number; schemaGrants: number; databaseGrants: number }[]>`
    SELECT
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_auth_members membership
       JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_catalog.pg_roles member ON member.oid = membership.member
       WHERE granted.rolname = ANY(${sql.array([...s4Roles])}::text[]) OR member.rolname = ANY(${sql.array([...s4Roles])}::text[])) AS memberships,
      ((SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class WHERE relowner IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[])))
       + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_proc WHERE proowner IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[])))
       + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_namespace WHERE nspowner IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[])))
       + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()
          AND datdba IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[])))) AS owned,
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) privilege
       WHERE privilege.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[]))) AS "tableGrants",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_proc routine
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) privilege
       WHERE privilege.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[]))) AS "routineGrants",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_namespace namespace_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))) privilege
       WHERE privilege.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[]))) AS "schemaGrants",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_database database_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(database_row.datacl, pg_catalog.acldefault('d', database_row.datdba))) privilege
       WHERE database_row.datname = pg_catalog.current_database()
         AND privilege.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY(${sql.array([...s4Roles])}::text[]))) AS "databaseGrants"
  `
  return authority?.memberships === 0 && authority.owned === 0 && authority.tableGrants === 0
    && authority.routineGrants === 0 && authority.schemaGrants === 0 && authority.databaseGrants === 0
    && await exactForgeSchemaAcl(sql, false, migrationLogin)
}

async function exactRoleBoundary(
  sql: postgres.Sql | postgres.TransactionSql,
  expectLegacyConsumer: boolean,
  migrationLogin: string | null,
): Promise<boolean> {
  if (!await exactReleaseRoleBoundary(sql, expectLegacyConsumer)) return false
  return (await exactS4RoleBoundary(sql, false, migrationLogin))
    || (await exactZeroAuthorityS4Roles(sql, migrationLogin))
    || (await exactS4RoleBoundary(sql, true, migrationLogin))
}

async function exactReleaseCatalog(sql: postgres.Sql | postgres.TransactionSql, repaired: boolean): Promise<boolean> {
  const [shape] = await sql<readonly { owners: number; forgeOwner: boolean; requiredEvidence: number; tokenType: string | null; signerDefault: string | null }[]>`
    SELECT
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
       WHERE namespace_row.nspname = 'public' AND relation.relkind = 'r'
         AND relation.relname = ANY(ARRAY[
           'forge_release_signer_keys', 'forge_release_signer_key_lifecycle_audits',
           'forge_epic_172_release_evidence', 'forge_epic_172_transition_authorizations',
           'forge_epic_172_release_evidence_consumptions', 'forge_epic_172_enablement_state',
           'forge_epic_172_enablement_transition_audits'
         ]) AND relation.relowner = 'forge_release_routines_owner'::pg_catalog.regrole) AS owners,
      (SELECT nspowner = 'forge_release_routines_owner'::pg_catalog.regrole FROM pg_catalog.pg_namespace WHERE nspname = 'forge') AS "forgeOwner",
      (SELECT pg_catalog.count(*)::integer FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'forge_epic_172_release_evidence'
         AND column_name = 'required_evidence' AND udt_name = 'jsonb' AND is_nullable = 'NO' AND column_default IS NULL) AS "requiredEvidence",
      (SELECT udt_name FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'forge_epic_172_enablement_state' AND column_name = 'controller_token_digest') AS "tokenType",
      (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'forge_release_signer_keys' AND column_name = 'status') AS "signerDefault"
  `
  if (!shape || shape.owners !== 7 || !shape.forgeOwner || shape.requiredEvidence !== (repaired ? 1 : 0)
    || shape.tokenType !== (repaired ? 'bytea' : 'text')
    || shape.signerDefault !== (repaired ? "'staged'::text" : "'active'::text")) return false
  const constraints = await sql<readonly { name: string; definition: string }[]>`
    SELECT constraint_row.conname AS name, pg_catalog.pg_get_constraintdef(constraint_row.oid) AS definition
    FROM pg_catalog.pg_constraint constraint_row
    JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    WHERE namespace_row.nspname = 'public' AND constraint_row.conname = ANY(ARRAY[
      'forge_epic_172_release_evidence_sha_chk', 'forge_epic_172_release_evidence_required_evidence_chk',
      'forge_epic_172_enablement_sha_chk', 'forge_epic_172_enablement_token_chk',
      'forge_epic_172_transition_authorizations_sha_chk', 'forge_release_signer_keys_status_chk',
      'forge_release_signer_keys_lifecycle_chk', 'forge_release_signer_lifecycle_prior_status_chk',
      'forge_release_signer_lifecycle_new_status_chk'
    ]) ORDER BY 1
  `
  const expected = repaired ? repairedConstraints : legacyConstraints
  if (constraints.length !== expected.size || !constraints.every((constraint) => expected.get(constraint.name) === constraint.definition)) return false
  const [receiptIndex] = await sql<readonly { unique: boolean; valid: boolean; ready: boolean; live: boolean; partial: boolean; expressions: boolean; columns: string }[]>`
    SELECT index_row.indisunique AS unique, index_row.indisvalid AS valid, index_row.indisready AS ready,
      index_row.indislive AS live, index_row.indpred IS NOT NULL AS partial, index_row.indexprs IS NOT NULL AS expressions,
      (SELECT pg_catalog.string_agg(attribute_row.attname, ',' ORDER BY key_column.ordinality)
       FROM pg_catalog.unnest(index_row.indkey) WITH ORDINALITY key_column(attnum, ordinality)
       JOIN pg_catalog.pg_attribute attribute_row
         ON attribute_row.attrelid = table_class.oid AND attribute_row.attnum = key_column.attnum) AS columns
    FROM pg_catalog.pg_index index_row
    JOIN pg_catalog.pg_class index_class ON index_class.oid = index_row.indexrelid
    JOIN pg_catalog.pg_class table_class ON table_class.oid = index_row.indrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_class.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND index_class.relname = 'forge_epic_172_release_evidence_consumptions_authorization_rece'
  `
  const [oldAuthorizationIndex] = await sql<readonly { exists: boolean }[]>`
    SELECT pg_catalog.to_regclass('public.forge_epic_172_release_evidence_consumptions_authorization_idx') IS NOT NULL AS exists
  `
  if (!receiptIndex?.unique || !receiptIndex.valid || !receiptIndex.ready || !receiptIndex.live
    || receiptIndex.partial || receiptIndex.expressions || receiptIndex.columns !== 'authorization_id,receipt_id'
    || oldAuthorizationIndex?.exists) return false
  const triggers = await sql<readonly { fingerprint: string }[]>`
    SELECT trigger_row.tgname || '|' || table_row.relname || '|' || trigger_row.tgfoid::pg_catalog.regprocedure::text
      || '|' || trigger_row.tgenabled::text || '|' || pg_catalog.md5(pg_catalog.pg_get_triggerdef(trigger_row.oid)) AS fingerprint
    FROM pg_catalog.pg_trigger trigger_row
    JOIN pg_catalog.pg_class table_row ON table_row.oid = trigger_row.tgrelid
    WHERE NOT trigger_row.tgisinternal AND trigger_row.tgname = ANY(ARRAY[
      'forge_release_signer_keys_no_delete', 'forge_release_signer_lifecycle_append_only',
      'forge_epic_172_release_evidence_append_only', 'forge_epic_172_transition_authorizations_append_only',
      'forge_epic_172_release_consumptions_append_only', 'forge_epic_172_enablement_state_no_delete',
      'forge_epic_172_enablement_audits_append_only'
    ]) ORDER BY 1
  `
  return triggers.length === releaseTriggerFingerprints.length
    && triggers.every((trigger, index) => trigger.fingerprint === releaseTriggerFingerprints[index])
}

async function exactMigrationLoginBoundary(sql: postgres.Sql | postgres.TransactionSql): Promise<boolean> {
  const [boundary] = await sql<readonly { migrationLogin: string | null; schemaGrants: number; routineGrants: number }[]>`
    WITH migration_login AS (
      SELECT namespace_row.nspowner AS oid, owner_role.rolname AS name
      FROM pg_catalog.pg_namespace namespace_row
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = namespace_row.nspowner
      WHERE namespace_row.nspname = 'drizzle'
    ) SELECT
      (SELECT name FROM migration_login) AS "migrationLogin",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_namespace namespace_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))) privilege
       WHERE namespace_row.nspname = 'forge' AND privilege.grantee = (SELECT oid FROM migration_login)) AS "schemaGrants",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_proc routine
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) privilege
       WHERE namespace_row.nspname = 'forge' AND privilege.grantee = (SELECT oid FROM migration_login)) AS "routineGrants"
  `
  return boundary?.migrationLogin !== null
    && !['forge_release_evidence_writer', 'forge_release_transition', 'forge_release_routines_owner'].includes(boundary.migrationLogin)
    && boundary.schemaGrants === 0 && boundary.routineGrants === 0
}

async function exactCurrentMigrationLoginBoundary(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<string | null> {
  const [boundary] = await sql<readonly {
    migrationLogin: string | null
    schemaGrants: number
    exactSchemaGrants: number
    routineGrants: number
    exactRoutineGrants: number
  }[]>`
    WITH migration_login AS (
      SELECT namespace_row.nspowner AS oid, owner_role.rolname AS name
      FROM pg_catalog.pg_namespace namespace_row
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = namespace_row.nspowner
      WHERE namespace_row.nspname = 'drizzle'
    ) SELECT
      (SELECT name FROM migration_login) AS "migrationLogin",
      (SELECT pg_catalog.count(*)::integer
       FROM pg_catalog.pg_namespace namespace_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))
       ) privilege
       WHERE namespace_row.nspname = 'forge'
         AND privilege.grantee = (SELECT oid FROM migration_login)) AS "schemaGrants",
      (SELECT pg_catalog.count(*)::integer
       FROM pg_catalog.pg_namespace namespace_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))
       ) privilege
       WHERE namespace_row.nspname = 'forge'
         AND privilege.grantee = (SELECT oid FROM migration_login)
         AND privilege.privilege_type = 'USAGE'
         AND NOT privilege.is_grantable
         AND privilege.grantor = 'forge_release_routines_owner'::pg_catalog.regrole) AS "exactSchemaGrants",
      (SELECT pg_catalog.count(*)::integer
       FROM pg_catalog.pg_proc routine
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
       ) privilege
       WHERE namespace_row.nspname = 'forge'
         AND privilege.grantee = (SELECT oid FROM migration_login)) AS "routineGrants",
      (SELECT pg_catalog.count(*)::integer
       FROM pg_catalog.pg_proc routine
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
       ) privilege
       WHERE routine.oid = pg_catalog.to_regprocedure('forge.read_epic_172_enablement_state_v1()')
         AND privilege.grantee = (SELECT oid FROM migration_login)
         AND privilege.privilege_type = 'EXECUTE'
         AND NOT privilege.is_grantable
         AND privilege.grantor = 'forge_release_routines_owner'::pg_catalog.regrole) AS "exactRoutineGrants"
  `
  if (!boundary?.migrationLogin
    || [...s4Roles, 'forge_release_evidence_writer', 'forge_release_transition',
      'forge_release_routines_owner', 'forge_release_evidence_consumer'].includes(boundary.migrationLogin)
    || boundary.schemaGrants !== 1 || boundary.exactSchemaGrants !== 1
    || boundary.routineGrants !== 1 || boundary.exactRoutineGrants !== 1) return null
  return boundary.migrationLogin
}

async function exactProtectedTableAcls(sql: postgres.Sql | postgres.TransactionSql, repaired: boolean): Promise<boolean> {
  const grants = await sql<readonly { entry: string }[]>`
    SELECT relation.relname || '|' || COALESCE(grantee.rolname, 'PUBLIC') || '|'
      || privilege.privilege_type || '|' || privilege.is_grantable || '|' || grantor.rolname AS entry
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) privilege
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = privilege.grantor
    WHERE namespace_row.nspname = 'public'
      AND relation.relname = ANY(${sql.array([...protectedReleaseTables])}::text[])
  `
  const ownerPrivileges = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']
  const writerSelect = new Set([
    'forge_epic_172_release_evidence', 'forge_epic_172_transition_authorizations',
    'forge_release_signer_key_lifecycle_audits', 'forge_release_signer_keys',
  ])
  const transitionSelect = new Set([
    'forge_epic_172_enablement_state', 'forge_epic_172_enablement_transition_audits',
    'forge_epic_172_release_evidence', 'forge_epic_172_release_evidence_consumptions',
    'forge_epic_172_transition_authorizations', 'forge_release_signer_keys',
  ])
  const consumerSelect = new Set([
    'forge_epic_172_release_evidence', 'forge_epic_172_release_evidence_consumptions',
    'forge_epic_172_transition_authorizations', 'forge_release_signer_keys',
  ])
  const expected: string[] = []
  for (const table of protectedReleaseTables) {
    for (const privilege of ownerPrivileges) {
      expected.push(`${table}|forge_release_routines_owner|${privilege}|false|forge_release_routines_owner`)
    }
    if (writerSelect.has(table)) expected.push(`${table}|forge_release_evidence_writer|SELECT|false|forge_release_routines_owner`)
    if (transitionSelect.has(table)) expected.push(`${table}|forge_release_transition|SELECT|false|forge_release_routines_owner`)
    if (!repaired && consumerSelect.has(table)) expected.push(`${table}|forge_release_evidence_consumer|SELECT|false|forge_release_routines_owner`)
  }
  const actual = grants.map((row) => row.entry).sort()
  expected.sort()
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) return false
  const [ownership] = await sql<readonly { objects: number }[]>`
    SELECT ((SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class
      WHERE relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'forge_release_evidence_consumer'))
      + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_proc
        WHERE proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'forge_release_evidence_consumer'))) AS objects
  `
  return ownership?.objects === 0
}

async function exactLegacyConsumerLocalAuthority(
  sql: postgres.Sql | postgres.TransactionSql,
  repaired: boolean,
): Promise<boolean> {
  const [authority] = await sql<readonly {
    owned: number; relationGrants: number; routineGrants: number; schemaGrants: number; databaseGrants: number
  }[]>`
    WITH consumer AS (
      SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'forge_release_evidence_consumer'
    )
    SELECT
      ((SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class WHERE relowner = (SELECT oid FROM consumer))
       + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_proc WHERE proowner = (SELECT oid FROM consumer))
       + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_namespace WHERE nspowner = (SELECT oid FROM consumer))
       + (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_database
          WHERE datname = pg_catalog.current_database() AND datdba = (SELECT oid FROM consumer))) AS owned,
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_class relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) privilege
       WHERE privilege.grantee = (SELECT oid FROM consumer)) AS "relationGrants",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_proc routine
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) privilege
       WHERE privilege.grantee = (SELECT oid FROM consumer)) AS "routineGrants",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_namespace namespace_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))) privilege
       WHERE privilege.grantee = (SELECT oid FROM consumer)) AS "schemaGrants",
      (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_database database_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(database_row.datacl, pg_catalog.acldefault('d', database_row.datdba))) privilege
       WHERE database_row.datname = pg_catalog.current_database()
         AND privilege.grantee = (SELECT oid FROM consumer)) AS "databaseGrants"
  `
  return authority?.owned === 0
    && authority.relationGrants === (repaired ? 0 : 4)
    && authority.routineGrants === 0
    && authority.schemaGrants === 0
    && authority.databaseGrants === 0
}

async function exactForgeSchemaAcl(
  sql: postgres.Sql | postgres.TransactionSql,
  inertS4: boolean,
  migrationLogin: string | null,
): Promise<boolean> {
  const rows = await sql<readonly { grant: string }[]>`
    SELECT COALESCE(grantee.rolname, 'PUBLIC') || ':' || privilege.privilege_type || ':'
      || privilege.is_grantable || ':' || grantor.rolname AS grant
    FROM pg_catalog.pg_namespace namespace_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))) privilege
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = privilege.grantor
    WHERE namespace_row.nspname = 'forge'
    ORDER BY 1
  `
  const expectedRoles = [
    'forge_release_evidence_writer', 'forge_release_transition',
    ...(migrationLogin ? [migrationLogin] : []),
    ...(inertS4 ? [
      'forge_architect_plan_history_reader', 'forge_architect_plan_resolver', 'forge_architect_plan_writer',
      'forge_local_projection_archiver', 'forge_packet_issuer', 'forge_project_root_reconciler',
      'forge_review_source_resolver', 'forge_s4_recovery_operator', 'forge_s4_routines_owner',
    ] : []),
  ].sort()
  const expected = [
    ...expectedRoles.map((role) => `${role}:USAGE:false:forge_release_routines_owner`),
    'forge_release_routines_owner:CREATE:false:forge_release_routines_owner',
    'forge_release_routines_owner:USAGE:false:forge_release_routines_owner',
  ].sort()
  return rows.length === expected.length && rows.every((row, index) => row.grant === expected[index])
}

async function exactEmptyReleaseState(sql: postgres.Sql | postgres.TransactionSql): Promise<boolean> {
  const [state] = await sql<readonly { ok: boolean }[]>`
    SELECT (
      (SELECT pg_catalog.count(*) FROM public.forge_release_signer_keys) = 0
      AND (SELECT pg_catalog.count(*) FROM public.forge_release_signer_key_lifecycle_audits) = 0
      AND (SELECT pg_catalog.count(*) FROM public.forge_epic_172_release_evidence) = 0
      AND (SELECT pg_catalog.count(*) FROM public.forge_epic_172_transition_authorizations) = 0
      AND (SELECT pg_catalog.count(*) FROM public.forge_epic_172_release_evidence_consumptions) = 0
      AND (SELECT pg_catalog.count(*) FROM public.forge_epic_172_enablement_transition_audits) = 0
      AND (SELECT pg_catalog.count(*) FROM public.forge_epic_172_enablement_state) = 1
      AND EXISTS (SELECT 1 FROM public.forge_epic_172_enablement_state
        WHERE singleton_id = 'epic-172' AND state = 'disabled'
          AND owner_operation_id IS NULL AND exact_builds IS NULL AND reviewed_sha IS NULL
          AND epoch IS NULL AND started_at IS NULL AND expires_at IS NULL
          AND enablement_receipt_id IS NULL AND final_readiness_receipt_id IS NULL
          AND opening_authorization_id IS NULL AND controller_login_id IS NULL
          AND controller_run_id IS NULL AND controller_token_digest IS NULL
          AND lease_generation IS NULL AND last_heartbeat_at IS NULL AND lease_expires_at IS NULL)
      AND (SELECT pg_catalog.count(*) FROM public.forge_epic_172_s3_release_state) = 1
      AND EXISTS (SELECT 1 FROM public.forge_epic_172_s3_release_state
        WHERE singleton_id = 's3_issue_178' AND state = 'pending'
          AND predecessor_receipt_id IS NULL AND authorization_id IS NULL
          AND evidence_receipt_id IS NULL AND transition_identity_digest IS NULL AND completed_at IS NULL)
    ) AS ok
  `
  return state?.ok === true
}

async function legacyFingerprint(sql: postgres.Sql | postgres.TransactionSql): Promise<boolean> {
  const [result] = await sql<readonly { ok: boolean }[]>`
    SELECT (
      (SELECT count(*) FROM drizzle.__drizzle_migrations) = 27
      AND (SELECT max(created_at) FROM drizzle.__drizzle_migrations) = ${migration0026At}
      AND (SELECT count(*) FROM public.forge_release_signer_keys) = 0
      AND (SELECT count(*) FROM public.forge_release_signer_key_lifecycle_audits) = 0
      AND (SELECT count(*) FROM public.forge_epic_172_release_evidence) = 0
      AND (SELECT count(*) FROM public.forge_epic_172_transition_authorizations) = 0
      AND (SELECT count(*) FROM public.forge_epic_172_release_evidence_consumptions) = 0
      AND (SELECT count(*) FROM public.forge_epic_172_enablement_transition_audits) = 0
      AND EXISTS (
        SELECT 1 FROM public.forge_epic_172_s3_release_state
        WHERE singleton_id = 's3_issue_178' AND state = 'pending'
          AND predecessor_receipt_id IS NULL AND authorization_id IS NULL
          AND evidence_receipt_id IS NULL AND transition_identity_digest IS NULL
          AND completed_at IS NULL
      )
      AND (SELECT count(*) FROM public.forge_epic_172_s3_release_state) = 1
      AND EXISTS (SELECT 1 FROM public.forge_epic_172_enablement_state WHERE singleton_id = 'epic-172' AND state = 'disabled' AND controller_token_digest IS NULL)
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'forge_epic_172_release_evidence' AND column_name = 'required_evidence')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'forge_epic_172_enablement_state' AND column_name = 'controller_token_digest' AND udt_name = 'text')
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forge_release_evidence_consumer')
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forge_release_evidence_consumer' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
      AND (SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'forge_release_evidence_consumer') = 4
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE grantee = 'forge_release_evidence_consumer'
          AND (table_schema, table_name, privilege_type) NOT IN (
            ('public', 'forge_release_signer_keys', 'SELECT'),
            ('public', 'forge_epic_172_release_evidence', 'SELECT'),
            ('public', 'forge_epic_172_transition_authorizations', 'SELECT'),
            ('public', 'forge_epic_172_release_evidence_consumptions', 'SELECT')
          )
      )
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = 'forge_release_evidence_consumer'::pg_catalog.regrole)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = 'forge_release_evidence_consumer'::pg_catalog.regrole)
      AND to_regprocedure('forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb)') IS NOT NULL
      AND to_regprocedure('forge.record_epic_172_transition_authorization_v1(uuid,text,text,jsonb,text,integer,text,jsonb,text,bigint,text,text,text,text,uuid,bigint,text,bytea,uuid,timestamptz,timestamptz,jsonb)') IS NOT NULL
      AND to_regprocedure('forge.consume_epic_172_release_evidence_v1(uuid,uuid,text,text,text)') IS NOT NULL
      AND to_regprocedure('forge.assert_epic_172_transition_authorization_live_v1(uuid,text)') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'forge' AND p.proname IN (
          'install_epic_172_release_signer_v1', 'activate_epic_172_release_signer_v1',
          'retire_epic_172_release_signer_v1', 'read_epic_172_enablement_state_v1',
          'epic_172_controller_lease_digest_v1', 'constant_time_equal_32_v1',
          'lock_epic_172_signer_for_verification_v1', 'lock_epic_172_release_receipts_v1',
          'lock_epic_172_transition_verification_v1'
        )
      )
      AND (SELECT count(*) FROM public.forge_epic_172_enablement_state) = 1
      AND NOT EXISTS (
        SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
        WHERE r.rolname LIKE 'forge_release_%' OR u.rolname LIKE 'forge_release_%'
      )
    ) AS ok
  `
  if (result?.ok !== true || !await exactEmptyReleaseState(sql) || !await exactReleaseCatalog(sql, false)
    || !await exactMigrationLoginBoundary(sql) || !await exactProtectedTableAcls(sql, false)
    || !await exactLegacyConsumerLocalAuthority(sql, false)
    || !await exactRoutines(sql, legacyRoutineDigests, false, false, null)) return false
  // A first failed S4 bootstrap creates inert principals before it discovers
  // the missing Step 0 read routine.  Both that exact inert set and no S4
  // principals are safe; every other S4 state is an operator intervention.
  return exactRoleBoundary(sql, true, null)
}

async function repairedFingerprint(sql: postgres.Sql | postgres.TransactionSql): Promise<boolean> {
  const [result] = await sql<readonly { ok: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'forge_epic_172_release_evidence' AND column_name = 'required_evidence' AND udt_name = 'jsonb' AND is_nullable = 'NO' AND column_default IS NULL)
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'forge_epic_172_enablement_state' AND column_name = 'controller_token_digest' AND udt_name = 'bytea')
      AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'forge_release_evidence_consumer')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = 'forge_release_evidence_consumer'::pg_catalog.regrole)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = 'forge_release_evidence_consumer'::pg_catalog.regrole)
      AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'forge' AND p.proname IN (
        'install_epic_172_release_signer_v1', 'activate_epic_172_release_signer_v1',
        'retire_epic_172_release_signer_v1', 'read_epic_172_enablement_state_v1',
        'epic_172_controller_lease_digest_v1', 'constant_time_equal_32_v1',
        'lock_epic_172_signer_for_verification_v1', 'lock_epic_172_release_receipts_v1',
        'lock_epic_172_transition_verification_v1'
      )) = 9
      AND to_regprocedure('forge.record_epic_172_release_evidence_v1(uuid,text,integer,text,jsonb,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb)') IS NOT NULL
    ) AS ok
  `
  if (result?.ok !== true || !await exactEmptyReleaseState(sql) || !await exactReleaseCatalog(sql, true)
    || !await exactMigrationLoginBoundary(sql) || !await exactProtectedTableAcls(sql, true)
    || !await exactLegacyConsumerLocalAuthority(sql, true)
    || !await exactRoutines(sql, repairedRoutineDigests, false, false, null)) return false
  return exactRoleBoundary(sql, true, null)
}

async function current0026Fingerprint(sql: postgres.Sql | postgres.TransactionSql): Promise<boolean> {
  const migrationLogin = await exactCurrentMigrationLoginBoundary(sql)
  if (!migrationLogin) return false
  return await exactEmptyReleaseState(sql)
    && await exactReleaseCatalog(sql, true)
    && await exactProtectedTableAcls(sql, true)
    && await exactRoutines(sql, repairedRoutineDigests, false, false, migrationLogin)
    && await exactRoleBoundary(sql, false, migrationLogin)
}

async function durableRepairedFingerprint(sql: postgres.Sql | postgres.TransactionSql): Promise<boolean> {
  // Later migrations legitimately add S4/S5 objects and may populate release
  // state.  The stable repair receipt is therefore the complete protected S3
  // catalog, ACL and routine surface plus the inert legacy consumer principal.
  return await exactReleaseCatalog(sql, true)
    && await exactProtectedTableAcls(sql, true)
    && await exactLegacyConsumerLocalAuthority(sql, true)
    && await exactRoutines(sql, repairedRoutineDigests, false, true, null)
    && await exactReleaseRoleBoundary(sql, true)
}

async function loadRepairArtifact(): Promise<string> {
  const source = await readFile(repairArtifact, 'utf8')
  if (createHash('sha256').update(source).digest('hex') !== repairArtifactSha256) {
    throw new Error('Refusing legacy release repair: fixed repair artifact integrity check failed.')
  }
  return source
}

async function main(): Promise<void> {
  const client = postgres(process.env.FORGE_DATABASE_ADMIN_URL ?? getRequiredEnv('DATABASE_URL'), { max: 1, onnotice: () => {} })
  try {
    const outcome = await client.begin(async (sql) => {
      // Classification belongs to the same critical section as repair.  This
      // prevents an installer from accepting a journal shape that changed
      // between an optimistic read and the migration-ledger lock.
      await sql.unsafe('LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE')
      const lockedLedger = await sql<readonly { hash: string; created_at: number }[]>`
        SELECT hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at
        FOR UPDATE
      `
      const lockedHashes = new Map(lockedLedger.map((row) => [Number(row.created_at), row.hash]))
      const count = lockedLedger.length
      const maxCreatedAt = count === 0 ? null : Number(lockedLedger[count - 1]?.created_at)
      const pair = lockedHashes.get(migration0023At) === current0023
        && lockedHashes.get(migration0025At) === current0025
        ? 'current'
        : lockedHashes.get(migration0023At) === legacy0023
          && lockedHashes.get(migration0025At) === legacy0025
          ? 'legacy'
          : null
      const position = count === 27 && maxCreatedAt === migration0026At
        && lockedHashes.get(migration0026At) === current0026
        ? '0026'
        : count === 28 && maxCreatedAt === migration0027At
          && lockedHashes.get(migration0026At) === current0026
          && lockedHashes.get(migration0027At) === current0027
          ? '0027'
          : count === 29 && maxCreatedAt === migration0028At
            && lockedHashes.get(migration0026At) === current0026
            && lockedHashes.get(migration0027At) === current0027
            && lockedHashes.get(migration0028At) === current0028
            ? '0028'
            : null
      if (!pair || !position) {
        throw new Error('Refusing legacy release repair: locked migration ledger is not an exact supported 0026, 0027, or 0028 position.')
      }

      if (pair === 'current') {
        if (position === '0026' && !await current0026Fingerprint(sql)) {
          throw new Error('Refusing legacy release repair: current 0023/0025 hashes do not have the exact current 0026 catalog.')
        }
        return 'current' as const
      }

      if (position !== '0026') {
        if (!await durableRepairedFingerprint(sql)) {
          throw new Error('Refusing legacy release repair: a later legacy-hash ledger lacks the durable repaired catalog fingerprint.')
        }
        return 'later-repaired' as const
      }

      if (await repairedFingerprint(sql)) {
        return 'already-repaired' as const
      }
      if (!await legacyFingerprint(sql)) {
        throw new Error('Refusing legacy release repair: physical catalog fingerprint is not the exact known legacy state.')
      }

      const repairSql = await loadRepairArtifact()
      await sql.unsafe(repairSql)
      const ledgerAfter = await sql<readonly { hash: string; created_at: number }[]>`
        SELECT hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at
      `
      if (ledgerAfter.length !== lockedLedger.length || ledgerAfter.some((row, index) => (
        row.hash !== lockedLedger[index]?.hash
        || Number(row.created_at) !== Number(lockedLedger[index]?.created_at)
      ))) {
        throw new Error('Legacy release repair unexpectedly altered the immutable migration ledger.')
      }
      if (!await repairedFingerprint(sql)) {
        throw new Error('Legacy release repair did not produce the exact repaired catalog fingerprint.')
      }
      return 'repaired' as const
    })

    if (outcome === 'repaired') {
      console.log('✓ Repaired the exact known Epic 172 legacy release catalog drift without altering the migration ledger.')
    } else if (outcome === 'already-repaired') {
      console.log('✓ Epic 172 legacy release catalog is already repaired at 0026; migration ledger was left unchanged.')
    } else if (outcome === 'later-repaired') {
      console.log('✓ Durable Epic 172 legacy release repair is present at the later migration position; migration ledger was left unchanged.')
    } else {
      console.log('✓ Epic 172 legacy release repair is not needed.')
    }
  } finally {
    await client.end({ timeout: 5 })
  }
}
main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
