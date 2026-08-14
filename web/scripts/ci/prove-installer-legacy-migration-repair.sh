#!/usr/bin/env bash
# Disposable PostgreSQL proof for the exact 0023/0025 legacy-release repair.
# It rebuilds one database per refusal case so a rejected catalog can never
# influence the succeeding repair or the real installer sequence.
set -Eeuo pipefail

: "${FORGE_LEGACY_REPAIR_DATABASE_URL:?Set the disposable migration URL.}"
: "${FORGE_LEGACY_REPAIR_ADMIN_URL:?Set the disposable administrator URL.}"
: "${FORGE_LEGACY_REPAIR_ADMIN_HOST:?Set the disposable administrator host.}"
: "${FORGE_LEGACY_REPAIR_ADMIN_USER:?Set the disposable administrator user.}"
: "${FORGE_LEGACY_REPAIR_ADMIN_PASSWORD:?Set the disposable administrator password.}"
: "${FORGE_LEGACY_REPAIR_ADMIN_DATABASE:?Set the disposable database name.}"
: "${FORGE_LEGACY_REPAIR_MIGRATION_HOST:?Set the disposable migration host.}"
: "${FORGE_LEGACY_REPAIR_MIGRATION_USER:?Set the disposable migration user.}"
: "${FORGE_LEGACY_REPAIR_MIGRATION_PASSWORD:?Set the disposable migration password.}"

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd -P "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd -P "$WEB_ROOT/.." && pwd)"
FIXTURE="$SCRIPT_DIR/sql/installer-legacy-0023-0025-fixture.sql"
CONSUMER_OTHER_DATABASE=forge_installer_legacy_consumer_other_test
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/forge-legacy-repair-dbr1.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT
source "$REPO_ROOT/scripts/ci/current-migration-ledger.sh"

case "$FORGE_LEGACY_REPAIR_ADMIN_DATABASE" in
  ''|*[!A-Za-z0-9_]* ) echo 'Unsafe disposable database name.' >&2; exit 64 ;;
esac
[ "$FORGE_LEGACY_REPAIR_ADMIN_DATABASE" = forge ] || {
  echo 'The real native-installer proof requires the disposable database name forge.' >&2
  exit 64
}
case "$FORGE_LEGACY_REPAIR_MIGRATION_USER" in
  ''|*[!A-Za-z0-9_]* ) echo 'Unsafe disposable migration role name.' >&2; exit 64 ;;
esac
case "$CONSUMER_OTHER_DATABASE" in
  ''|*[!A-Za-z0-9_]* ) echo 'Unsafe disposable consumer database name.' >&2; exit 64 ;;
esac

migration_psql() {
  PGPASSWORD="$FORGE_LEGACY_REPAIR_MIGRATION_PASSWORD" \
    PGHOST="$FORGE_LEGACY_REPAIR_MIGRATION_HOST" \
    PGUSER="$FORGE_LEGACY_REPAIR_MIGRATION_USER" \
    PGDATABASE="$FORGE_LEGACY_REPAIR_ADMIN_DATABASE" \
    psql --set ON_ERROR_STOP=1 "$@"
}

admin_psql() {
  PGPASSWORD="$FORGE_LEGACY_REPAIR_ADMIN_PASSWORD" \
    PGHOST="$FORGE_LEGACY_REPAIR_ADMIN_HOST" \
    PGUSER="$FORGE_LEGACY_REPAIR_ADMIN_USER" \
    PGDATABASE="$FORGE_LEGACY_REPAIR_ADMIN_DATABASE" \
    psql --set ON_ERROR_STOP=1 "$@"
}

admin_server_psql() {
  PGPASSWORD="$FORGE_LEGACY_REPAIR_ADMIN_PASSWORD" \
    PGHOST="$FORGE_LEGACY_REPAIR_ADMIN_HOST" \
    PGUSER="$FORGE_LEGACY_REPAIR_ADMIN_USER" \
    PGDATABASE=postgres \
    psql --set ON_ERROR_STOP=1 "$@"
}

admin_consumer_other_psql() {
  PGPASSWORD="$FORGE_LEGACY_REPAIR_ADMIN_PASSWORD" \
    PGHOST="$FORGE_LEGACY_REPAIR_ADMIN_HOST" \
    PGUSER="$FORGE_LEGACY_REPAIR_ADMIN_USER" \
    PGDATABASE="$CONSUMER_OTHER_DATABASE" \
    psql --set ON_ERROR_STOP=1 "$@"
}

prepare_cross_database_consumer() {
  admin_server_psql --quiet --command "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = '${CONSUMER_OTHER_DATABASE}' AND pid <> pg_catalog.pg_backend_pid();"
  admin_server_psql --command "DROP DATABASE IF EXISTS \"${CONSUMER_OTHER_DATABASE}\";"
  admin_server_psql --command "CREATE DATABASE \"${CONSUMER_OTHER_DATABASE}\" OWNER \"${FORGE_LEGACY_REPAIR_MIGRATION_USER}\";"
  admin_server_psql <<'SQL'
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'forge_release_evidence_consumer') THEN
    CREATE ROLE forge_release_evidence_consumer
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$role$;
SQL
  admin_consumer_other_psql <<'SQL'
CREATE TABLE public.forge_consumer_cross_database_probe (id integer PRIMARY KEY);
GRANT USAGE ON SCHEMA public TO forge_release_evidence_consumer;
GRANT SELECT ON TABLE public.forge_consumer_cross_database_probe TO forge_release_evidence_consumer;
SQL
}

drop_cross_database_consumer_database() {
  admin_server_psql --quiet --command "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = '${CONSUMER_OTHER_DATABASE}' AND pid <> pg_catalog.pg_backend_pid();"
  admin_server_psql --command "DROP DATABASE IF EXISTS \"${CONSUMER_OTHER_DATABASE}\";"
}

reset_database() {
  admin_server_psql --quiet --command "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = '${FORGE_LEGACY_REPAIR_ADMIN_DATABASE}' AND pid <> pg_catalog.pg_backend_pid();"
  admin_server_psql --command "DROP DATABASE IF EXISTS \"${FORGE_LEGACY_REPAIR_ADMIN_DATABASE}\";"
  admin_server_psql --command "CREATE DATABASE \"${FORGE_LEGACY_REPAIR_ADMIN_DATABASE}\" OWNER \"${FORGE_LEGACY_REPAIR_MIGRATION_USER}\";"
}

prepare_0026_baseline() {
  reset_database
  (
    cd "$WEB_ROOT"
    DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" FORGE_DATABASE_ADMIN_URL="$FORGE_LEGACY_REPAIR_ADMIN_URL" \
      npm run protocol:bootstrap-epic-172-release-roles
    DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" npx tsx scripts/ci/migrate-through-0025.ts
    DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" FORGE_DATABASE_ADMIN_URL="$FORGE_LEGACY_REPAIR_ADMIN_URL" \
      npm run protocol:bootstrap-epic-172-s3-release-owner
    DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" npx tsx scripts/ci/migrate-through-0026.ts
  )
}

strip_current_migration_grants() {
  # The current 0025 migration deliberately grants the migration login schema
  # usage and the Step 0 read routine. Those grants did not exist in the real
  # legacy catalog; remove them only in this disposable reconstruction.
  admin_psql --set migration_role="$FORGE_LEGACY_REPAIR_MIGRATION_USER" <<'SQL'
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA forge FROM :"migration_role";
REVOKE USAGE, CREATE ON SCHEMA forge FROM :"migration_role";
SQL
}

apply_legacy_fixture() {
  admin_psql --file "$FIXTURE"
  strip_current_migration_grants
  # The legacy catalog predates migration 0025's PUBLIC execute revocation.
  # Restore that exact old ACL after reconstructing the disposable fixture.
  admin_psql --command 'GRANT EXECUTE ON FUNCTION public.forge_epic_172_reject_mutation_v1() TO PUBLIC;'
}

prepare_legacy_fixture() {
  prepare_0026_baseline
  apply_legacy_fixture
}

snapshot() {
  local label="$1"
  migration_psql --no-align --tuples-only --quiet --command \
    'SELECT hash || chr(58) || created_at FROM drizzle.__drizzle_migrations ORDER BY created_at' > "$TEMP_ROOT/$label.ledger"
  PGPASSWORD="$FORGE_LEGACY_REPAIR_ADMIN_PASSWORD" \
    PGHOST="$FORGE_LEGACY_REPAIR_ADMIN_HOST" \
    PGUSER="$FORGE_LEGACY_REPAIR_ADMIN_USER" \
    PGDATABASE="$FORGE_LEGACY_REPAIR_ADMIN_DATABASE" \
    pg_dump --schema-only --no-owner --quote-all-identifiers \
      | sed '/^\\restrict /d; /^\\unrestrict /d' > "$TEMP_ROOT/$label.schema"
  admin_psql --no-align --tuples-only --quiet --command '
    SELECT rolname || chr(58) || rolcanlogin || chr(58) || rolinherit || chr(58) || rolsuper || chr(58) || rolcreatedb || chr(58) || rolcreaterole || chr(58) || rolreplication || chr(58) || rolbypassrls
    FROM pg_catalog.pg_roles
    WHERE rolname = $q$forge$q$ OR rolname LIKE $q$forge_release_%$q$ OR rolname LIKE $q$forge_s4_%$q$
    ORDER BY rolname;
    SELECT granted.rolname || chr(58) || member.rolname
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    WHERE granted.rolname = $q$forge$q$ OR member.rolname = $q$forge$q$
       OR granted.rolname LIKE $q$forge_release_%$q$ OR granted.rolname LIKE $q$forge_s4_%$q$
       OR member.rolname LIKE $q$forge_release_%$q$ OR member.rolname LIKE $q$forge_s4_%$q$
    ORDER BY 1;' > "$TEMP_ROOT/$label.roles"
  admin_psql --no-align --tuples-only --quiet --command '
    SELECT namespace_row.nspname || chr(46) || routine.proname || chr(40)
      || pg_catalog.pg_get_function_identity_arguments(routine.oid) || chr(41) || chr(58)
      || pg_catalog.md5(pg_catalog.pg_get_functiondef(routine.oid)) || chr(58)
      || owner_role.rolname || chr(58) || routine.prosecdef || chr(58)
      || COALESCE(pg_catalog.array_to_string(routine.proconfig, chr(44)), $q$<null>$q$) || chr(58)
      || COALESCE((SELECT pg_catalog.string_agg(
        COALESCE(grantee.rolname, $q$PUBLIC$q$) || chr(58) || privilege.privilege_type || chr(58)
          || privilege.is_grantable || chr(58) || grantor.rolname,
        chr(44) ORDER BY COALESCE(grantee.rolname, $q$PUBLIC$q$), privilege.privilege_type,
          privilege.is_grantable, grantor.rolname)
        FROM pg_catalog.aclexplode(
          COALESCE(routine.proacl, pg_catalog.acldefault($q$f$q$, routine.proowner))
        ) privilege
        LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
        JOIN pg_catalog.pg_roles grantor ON grantor.oid = privilege.grantor), $q$<null>$q$)
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = routine.proowner
    WHERE routine.oid IN (
      pg_catalog.to_regprocedure($q$public.forge_epic_172_reject_mutation_v1()$q$),
      pg_catalog.to_regprocedure($q$forge.guard_epic_172_s3_evidence_insert_v1()$q$)
    )
    ORDER BY 1;' > "$TEMP_ROOT/$label.trigger-routines"
  admin_psql --no-align --tuples-only --quiet --command '
    WITH acl_inventory AS (
      SELECT $q$table$q$ || chr(124) || namespace_row.nspname || chr(124)
        || relation.relname || chr(124) || COALESCE(grantee.rolname, $q$PUBLIC$q$) || chr(124)
        || privilege.privilege_type || chr(124) || privilege.is_grantable || chr(124) || grantor.rolname AS entry
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault($q$r$q$, relation.relowner))
      ) privilege
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
      JOIN pg_catalog.pg_roles grantor ON grantor.oid = privilege.grantor
      WHERE namespace_row.nspname = $q$public$q$ AND relation.relkind IN ($q$r$q$, $q$p$q$)
      UNION ALL
      SELECT $q$column$q$ || chr(124) || namespace_row.nspname || chr(124)
        || relation.relname || chr(124) || attribute.attname || chr(124)
        || COALESCE(grantee.rolname, $q$PUBLIC$q$) || chr(124) || privilege.privilege_type
        || chr(124) || privilege.is_grantable || chr(124) || grantor.rolname AS entry
      FROM pg_catalog.pg_attribute attribute
      JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
      JOIN pg_catalog.pg_roles grantor ON grantor.oid = privilege.grantor
      WHERE namespace_row.nspname = $q$public$q$ AND relation.relkind IN ($q$r$q$, $q$p$q$)
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
    )
    SELECT entry FROM acl_inventory ORDER BY entry;' > "$TEMP_ROOT/$label.relation-acls"
}

assert_unchanged() {
  local before="$1" after="$2" case_name="$3"
  cmp -s "$TEMP_ROOT/$before.ledger" "$TEMP_ROOT/$after.ledger" || { echo "$case_name changed the migration ledger." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.schema" "$TEMP_ROOT/$after.schema" || { echo "$case_name changed the database catalog." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.roles" "$TEMP_ROOT/$after.roles" || { echo "$case_name changed the role boundary." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.trigger-routines" "$TEMP_ROOT/$after.trigger-routines" || { echo "$case_name changed the trigger-routine boundary." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.relation-acls" "$TEMP_ROOT/$after.relation-acls" || { echo "$case_name changed relation ACLs." >&2; exit 1; }
}

assert_only_external_acl_changed() {
  local before="$1" after="$2" case_name="$3"
  cmp -s "$TEMP_ROOT/$before.ledger" "$TEMP_ROOT/$after.ledger" || { echo "$case_name changed the migration ledger." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.roles" "$TEMP_ROOT/$after.roles" || { echo "$case_name changed the role boundary." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.trigger-routines" "$TEMP_ROOT/$after.trigger-routines" || { echo "$case_name changed the trigger-routine boundary." >&2; exit 1; }
}

assert_only_exact_0026_external_acl_changed() {
  local before="$1" after="$2" expected_entry="$3" case_name="$4" filtered
  filtered="$TEMP_ROOT/$after.filtered-relation-acls"
  [ "$(grep -Fxc "$expected_entry" "$TEMP_ROOT/$after.relation-acls")" = 1 ] \
    || { echo "$case_name lacks its one external ACL entry." >&2; exit 1; }
  grep -Fvx "$expected_entry" "$TEMP_ROOT/$after.relation-acls" > "$filtered"
  cmp -s "$TEMP_ROOT/$before.relation-acls" "$filtered" \
    || { echo "$case_name changed another relation ACL." >&2; exit 1; }
}

run_repair() {
  (
    cd "$WEB_ROOT"
    DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" FORGE_DATABASE_ADMIN_URL="$FORGE_LEGACY_REPAIR_ADMIN_URL" \
      npm run protocol:repair-epic-172-legacy-release
  )
}

ensure_forge_app_role() {
  admin_server_psql <<'SQL'
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'forge') THEN
    CREATE ROLE forge
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'forge' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Literal forge role does not have the exact app-role attributes';
  END IF;
END;
$role$;
SQL
}

grant_exact_forge_contamination() {
  # Reproduce the old installer exactly: its administrator broadly granted CRUD
  # after migrations, so PostgreSQL records each protected grant from its owner.
  admin_psql <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge;
SQL
}

revoke_forge_contamination() {
  admin_psql <<'SQL'
DO $cleanup$
DECLARE
  protected_relation record;
  protected_columns text;
BEGIN
  FOR protected_relation IN
    SELECT namespace_row.nspname AS schema_name, relation.relname AS relation_name, relation.oid
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
    ORDER BY relation.oid
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM forge',
      protected_relation.schema_name,
      protected_relation.relation_name
    );
    SELECT pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO protected_columns
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = protected_relation.oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
    IF protected_columns IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES (%s) ON TABLE %I.%I FROM forge',
        protected_columns,
        protected_relation.schema_name,
        protected_relation.relation_name
      );
    END IF;
  END LOOP;
END;
$cleanup$;
SQL
}

restore_canonical_forge_boundary() {
  revoke_forge_contamination
  admin_psql <<'SQL'
GRANT SELECT ON TABLE
  public.work_package_local_projection_sources,
  public.work_package_local_projection_heads
TO forge;
SQL
}

assert_protected_forge_acl_count() {
  local expected_count="$1"
  local actual_count exact_live_count
  actual_count="$(admin_psql --no-align --tuples-only --quiet --command "
  SELECT count(*)
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
  ) privilege
  JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
  WHERE namespace_row.nspname = 'public'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
    AND grantee.rolname = 'forge';")"
  [ "$actual_count" = "$expected_count" ] || {
    echo "Expected $expected_count protected forge ACL rows, found $actual_count." >&2
    exit 1
  }
  if [ "$expected_count" = 148 ]; then
    exact_live_count="$(admin_psql --no-align --tuples-only --quiet --command "
    SELECT count(*)
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND grantee.rolname = 'forge'
      AND privilege.privilege_type IN ('DELETE', 'INSERT', 'SELECT', 'UPDATE')
      AND NOT privilege.is_grantable
      AND privilege.grantor = relation.relowner;")"
    [ "$exact_live_count" = 148 ] || {
      echo "Exact installer contamination expected 148 owner-granted ACL rows, found $exact_live_count." >&2
      exit 1
    }
  elif [ "$expected_count" = 2 ]; then
    exact_live_count="$(admin_psql --no-align --tuples-only --quiet --command "
    SELECT count(*)
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE namespace_row.nspname = 'public'
      AND relation.relname IN ('work_package_local_projection_sources', 'work_package_local_projection_heads')
      AND grantee.rolname = 'forge'
      AND privilege.privilege_type = 'SELECT'
      AND NOT privilege.is_grantable
      AND privilege.grantor = relation.relowner;")"
    [ "$exact_live_count" = 2 ] || {
      echo "Canonical projection boundary expected two exact SELECT grants, found $exact_live_count." >&2
      exit 1
    }
  fi
}

run_installer_grant_privileges() {
  local label="$1"
  (
    export FORGE_INSTALL_LIBRARY=1
    export FORGE_INSTALL_STATE_DIR="$TEMP_ROOT/$label-state"
    export FORGE_WORKSPACE_ROOT="$TEMP_ROOT/$label-workspace"
    export FORGE_ENV_FILE="$TEMP_ROOT/$label.env"
    if [ "${FORGE_LEGACY_REPAIR_PRODUCTION_NATIVE_ROUTE:-0}" != 1 ]; then
      export FORGE_INSTALL_TEST_ADMIN_MODE=current
      export FORGE_INSTALL_TEST_PSQL_SOCKET="${FORGE_LEGACY_REPAIR_ADMIN_SOCKET:-/tmp}"
      export FORGE_INSTALL_TEST_PSQL_PORT="${PGPORT:-5432}"
    fi
    source "$REPO_ROOT/scripts/install.sh"
    SERVICE_MODE=native
    MANAGE_LOCAL_DB=1
    DRY_RUN=0
    grant_forge_privileges
  )
}

run_installer_provision_database() {
  local label="$1"
  local encoded_password="${2:-installer-race-proof}"
  local proof_env="$TEMP_ROOT/$label.env"
  printf 'DATABASE_URL=postgresql://forge:%s@localhost:5432/forge\n' "$encoded_password" > "$proof_env"
  (
    export FORGE_INSTALL_LIBRARY=1
    export FORGE_INSTALL_STATE_DIR="$TEMP_ROOT/$label-state"
    export FORGE_WORKSPACE_ROOT="$TEMP_ROOT/$label-workspace"
    export FORGE_ENV_FILE="$proof_env"
    if [ "${FORGE_LEGACY_REPAIR_PRODUCTION_NATIVE_ROUTE:-0}" != 1 ]; then
      export FORGE_INSTALL_TEST_ADMIN_MODE=current
      export FORGE_INSTALL_TEST_PSQL_SOCKET="${FORGE_LEGACY_REPAIR_ADMIN_SOCKET:-/tmp}"
      export FORGE_INSTALL_TEST_PSQL_PORT="${PGPORT:-5432}"
    fi
    source "$REPO_ROOT/scripts/install.sh"
    SERVICE_MODE=native
    MANAGE_LOCAL_DB=1
    DRY_RUN=0
    DB_PASSWORD="$(native_forge_database_password "$(initial_env_value DATABASE_URL)")" || return
    provision_database
  )
}

assert_encoded_installer_password() {
  local label="$1" encoded_password="$2" expected_password="$3"
  local endpoint="${FORGE_LEGACY_REPAIR_DATABASE_URL#*@}"
  local login_url="postgresql://forge:${encoded_password}@${endpoint}"
  run_installer_provision_database "$label-first" "$encoded_password"
  run_installer_provision_database "$label-rerun" "$encoded_password"
  (
    cd "$WEB_ROOT"
    FORGE_ENCODED_LOGIN_URL="$login_url" \
      FORGE_ENCODED_ADMIN_URL="$FORGE_LEGACY_REPAIR_ADMIN_URL" \
      FORGE_EXPECTED_PASSWORD="$expected_password" node <<'NODE'
const crypto = require('node:crypto')
const postgres = require('postgres')
const client = postgres(process.env.FORGE_ENCODED_LOGIN_URL, { max: 1 })
const admin = postgres(process.env.FORGE_ENCODED_ADMIN_URL, { max: 1 })
Promise.all([
  client`SELECT current_user AS user_name`,
  admin`SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = 'forge'`,
])
  .then(([rows, passwordRows]) => {
    if (rows.length !== 1 || rows[0].user_name !== 'forge') {
      throw new Error('encoded installer credential did not authenticate the forge role')
    }
    const verifier = passwordRows[0]?.rolpassword ?? ''
    const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier)
    if (!match) throw new Error('forge role did not retain a SCRAM password verifier')
    const salted = crypto.pbkdf2Sync(process.env.FORGE_EXPECTED_PASSWORD, Buffer.from(match[2], 'base64'), Number(match[1]), 32, 'sha256')
    const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest()
    const storedKey = crypto.createHash('sha256').update(clientKey).digest()
    if (!crypto.timingSafeEqual(storedKey, Buffer.from(match[3], 'base64'))) {
      throw new Error('installer did not store the once-decoded native URL password')
    }
  })
  .then(() => Promise.all([client.end(), admin.end()]))
  .catch(async (error) => {
    await Promise.all([client.end().catch(() => {}), admin.end().catch(() => {})])
    console.error(error)
    process.exit(1)
  })
NODE
  )
}

prove_encoded_installer_password() {
  assert_encoded_installer_password encoded-password 'p%40ss%3Aword!' 'p@ss:word!'
  assert_encoded_installer_password multibyte-password 'caf%C3%A9%F0%9F%94%92' 'café🔒'

  local injection_encoded='x%5C%27%29%3B%20CREATE%20TABLE%20public.forge_password_injection_sentinel%28id%20integer%29%3B%20--'
  local injection_decoded="x\\'); CREATE TABLE public.forge_password_injection_sentinel(id integer); --"
  admin_server_psql --set admin_role="$FORGE_LEGACY_REPAIR_ADMIN_USER" <<'SQL'
ALTER ROLE :"admin_role" SET standard_conforming_strings = off;
SQL
  assert_encoded_installer_password injection-password "$injection_encoded" "$injection_decoded"
  admin_server_psql --set admin_role="$FORGE_LEGACY_REPAIR_ADMIN_USER" <<'SQL'
ALTER ROLE :"admin_role" RESET standard_conforming_strings;
SQL
  [ "$(admin_psql --no-align --tuples-only --quiet --command "SELECT pg_catalog.to_regclass('public.forge_password_injection_sentinel') IS NULL;")" = t ] \
    || { echo 'Encoded installer password created the SQL injection sentinel.' >&2; exit 1; }

  local verifier_before verifier_after invalid_encoded
  verifier_before="$(admin_server_psql --no-align --tuples-only --quiet --command "SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = 'forge';")"
  for invalid_encoded in bad%FF bad%C0%80 bad%E2%28%A1 bad%E2%82 bad%ED%A0%80 bad%F4%90%80%80 bad%00value; do
    if run_installer_provision_database "invalid-${invalid_encoded//\%/}" "$invalid_encoded" >/dev/null 2>&1; then
      echo "Malformed encoded installer password was unexpectedly accepted: $invalid_encoded" >&2
      exit 1
    fi
  done
  verifier_after="$(admin_server_psql --no-align --tuples-only --quiet --command "SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = 'forge';")"
  [ "$verifier_before" = "$verifier_after" ] \
    || { echo 'Malformed encoded installer password mutated the forge verifier.' >&2; exit 1; }
}

run_repair_grant_privileges() {
  local label="$1"
  (
    export FORGE_REPAIR_LIBRARY=1
    if [ "${FORGE_LEGACY_REPAIR_PRODUCTION_NATIVE_ROUTE:-0}" != 1 ]; then
      export FORGE_REPAIR_TEST_ROUTE=current
      export FORGE_REPAIR_TEST_PSQL_SOCKET="${FORGE_LEGACY_REPAIR_ADMIN_SOCKET:-/tmp}"
      export FORGE_REPAIR_TEST_PSQL_PORT="${PGPORT:-5432}"
    fi
    source "$REPO_ROOT/scripts/repair.sh"
    DRY_RUN=0
    reconcile_forge_privileges "$FORGE_LEGACY_REPAIR_ADMIN_DATABASE"
  ) > "$TEMP_ROOT/$label.log" 2>&1
}

assert_no_direct_forge_app_authority() {
  admin_psql <<'SQL'
DO $proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    WHERE privilege.grantee = 'forge'::pg_catalog.regrole
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
    WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
      AND privilege.grantee = 'forge'::pg_catalog.regrole
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))
    ) privilege
    WHERE namespace_row.nspname = 'public'
      AND privilege.grantee = 'forge'::pg_catalog.regrole
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl default_acl
    CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) privilege
    WHERE default_acl.defaclnamespace = 'public'::pg_catalog.regnamespace
      AND privilege.grantee = 'forge'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'Forge retained direct app authority after transactional rollback';
  END IF;
END;
$proof$;
SQL
}

assert_owner_driven_forge_boundary() {
  admin_psql <<'SQL'
DO $proof$
DECLARE
  projection_name text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND privilege.grantee = 'forge'::pg_catalog.regrole
      AND (
        relation.relname NOT IN ('work_package_local_projection_sources', 'work_package_local_projection_heads')
        OR privilege.privilege_type <> 'SELECT'
        OR privilege.is_grantable
        OR privilege.grantor <> relation.relowner
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND privilege.grantee = 'forge'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'Owner-driven installer boundary retained unexpected forge authority';
  END IF;
  FOREACH projection_name IN ARRAY ARRAY[
    'work_package_local_projection_sources',
    'work_package_local_projection_heads'
  ]
  LOOP
    IF (
      SELECT count(*)
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) privilege
      WHERE namespace_row.nspname = 'public'
        AND relation.relname = projection_name
        AND privilege.grantee = 'forge'::pg_catalog.regrole
        AND privilege.privilege_type = 'SELECT'
        AND NOT privilege.is_grantable
        AND privilege.grantor = relation.relowner
    ) <> 1 THEN
      RAISE EXCEPTION 'Projection % lacks exact forge SELECT authority', projection_name;
    END IF;
  END LOOP;
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relname = 'forge_epic_172_s3_release_state'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'SELECT'
      AND NOT privilege.is_grantable
  ) <> 1 THEN
    RAISE EXCEPTION 'S3 release state lost its existing PUBLIC SELECT path';
  END IF;
END;
$proof$;
SQL
}

wait_for_activity_condition() {
  local application_name="$1" condition="$2" attempt count
  for attempt in $(seq 1 100); do
    count="$(admin_psql --no-align --tuples-only --quiet --command "
      SELECT count(*)
      FROM pg_catalog.pg_stat_activity
      WHERE application_name = '$application_name'
        AND $condition;")"
    [ "$count" -ge 1 ] && return 0
    sleep 0.1
  done
  return 1
}

prove_acl_grant_race_refusal() {
  local label="$1" grant_sql="$2"
  local fixture_application="forge_acl_fixture_$label"
  local repair_application="forge_acl_repair_$label"
  local race_fifo="$TEMP_ROOT/$label.fifo"
  local fixture_log="$TEMP_ROOT/$label-fixture.log"
  local repair_log="$TEMP_ROOT/$label-repair.log"
  local race_admin_url separator fixture_pid repair_pid repair_status

  mkfifo "$race_fifo"
  exec 9<>"$race_fifo"
  PGAPPNAME="$fixture_application" \
    PGPASSWORD="$FORGE_LEGACY_REPAIR_ADMIN_PASSWORD" \
    PGHOST="$FORGE_LEGACY_REPAIR_ADMIN_HOST" \
    PGUSER="$FORGE_LEGACY_REPAIR_ADMIN_USER" \
    PGDATABASE="$FORGE_LEGACY_REPAIR_ADMIN_DATABASE" \
    psql --set ON_ERROR_STOP=1 < "$race_fifo" > "$fixture_log" 2>&1 &
  fixture_pid=$!
  printf 'BEGIN;\n%s\n' "$grant_sql" >&9
  if ! wait_for_activity_condition "$fixture_application" "state = 'idle in transaction'"; then
    printf 'ROLLBACK;\n\\q\n' >&9
    exec 9>&-
    wait "$fixture_pid" || true
    echo "$label fixture did not reach idle-in-transaction coordination state." >&2
    exit 1
  fi

  case "$FORGE_LEGACY_REPAIR_ADMIN_URL" in
    *\?*) separator='&' ;;
    *) separator='?' ;;
  esac
  race_admin_url="${FORGE_LEGACY_REPAIR_ADMIN_URL}${separator}application_name=${repair_application}"
  (
    cd "$WEB_ROOT"
    DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" FORGE_DATABASE_ADMIN_URL="$race_admin_url" \
      npm run protocol:repair-epic-172-legacy-release
  ) > "$repair_log" 2>&1 &
  repair_pid=$!
  if ! wait_for_activity_condition "$repair_application" "wait_event_type = 'Lock'"; then
    printf 'ROLLBACK;\n\\q\n' >&9
    exec 9>&-
    wait "$fixture_pid" || true
    kill "$repair_pid" 2>/dev/null || true
    wait "$repair_pid" 2>/dev/null || true
    sed -n '1,120p' "$repair_log" >&2
    echo "$label repair did not expose deterministic pg_stat_activity lock-wait evidence." >&2
    exit 1
  fi

  printf 'COMMIT;\n\\q\n' >&9
  exec 9>&-
  wait "$fixture_pid"
  set +e
  wait "$repair_pid"
  repair_status=$?
  set -e
  if [ "$repair_status" -eq 0 ]; then
    sed -n '1,120p' "$repair_log" >&2
    echo "$label concurrent ACL change was unexpectedly accepted or normalized." >&2
    exit 1
  fi
}

prepare_0026_acl_race_state() {
  case "$1" in
    current)
      prepare_0026_baseline
      ;;
    legacy)
      prepare_legacy_fixture
      ;;
    repaired)
      prepare_legacy_fixture
      run_repair >/dev/null
      ;;
    *) echo "Unknown exact-0026 ACL race state: $1" >&2; exit 64 ;;
  esac
  ensure_forge_app_role
}

prove_0026_acl_race_refusal() {
  local state="$1" kind="$2" surface="${3:-release}" grant_sql cleanup_sql
  local relation column grantee expected_entry
  local label="0026-$state-$surface-$kind-acl-race"
  prepare_0026_acl_race_state "$state"
  case "$surface" in
    release)
      relation=forge_epic_172_enablement_state
      column=state
      grantee=forge
      ;;
    projection)
      relation=work_package_local_projection_heads
      column=head_kind
      case "$state" in
        current) grantee=forge ;;
        legacy) grantee=PUBLIC ;;
        repaired) grantee=forge_release_transition ;;
      esac
      ;;
    *) echo "Unknown exact-0026 ACL race surface: $surface" >&2; exit 64 ;;
  esac
  case "$kind" in
    table)
      grant_sql="SET ROLE forge_release_routines_owner;
GRANT INSERT ON TABLE public.$relation TO $grantee;
RESET ROLE;"
      cleanup_sql="SET ROLE forge_release_routines_owner;
REVOKE INSERT ON TABLE public.$relation FROM $grantee;
RESET ROLE;"
      expected_entry="table|public|$relation|$grantee|INSERT|false|forge_release_routines_owner"
      ;;
    column)
      grant_sql="SET ROLE forge_release_routines_owner;
GRANT SELECT ($column) ON TABLE public.$relation TO $grantee;
RESET ROLE;"
      cleanup_sql="SET ROLE forge_release_routines_owner;
REVOKE SELECT ($column) ON TABLE public.$relation FROM $grantee;
RESET ROLE;"
      expected_entry="column|public|$relation|$column|$grantee|SELECT|false|forge_release_routines_owner"
      ;;
    *) echo "Unknown exact-0026 ACL race kind: $kind" >&2; exit 64 ;;
  esac

  snapshot "$label-before"
  prove_acl_grant_race_refusal "$label" "$grant_sql"
  snapshot "$label-after"
  assert_only_external_acl_changed "$label-before" "$label-after" "Exact-0026 $state $surface $kind GRANT race"
  assert_only_exact_0026_external_acl_changed \
    "$label-before" "$label-after" "$expected_entry" "Exact-0026 $state $surface $kind GRANT race"
  expect_refusal "Committed exact-0026 $state $surface $kind GRANT drift"
  snapshot "$label-rerun"
  assert_unchanged "$label-after" "$label-rerun" "Committed exact-0026 $state $surface $kind GRANT refusal"
  admin_psql --command "$cleanup_sql"
}

assert_only_external_role_changed() {
  local before="$1" after="$2" case_name="$3"
  cmp -s "$TEMP_ROOT/$before.ledger" "$TEMP_ROOT/$after.ledger" \
    || { echo "$case_name changed the migration ledger." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.schema" "$TEMP_ROOT/$after.schema" \
    || { echo "$case_name changed the database catalog." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.trigger-routines" "$TEMP_ROOT/$after.trigger-routines" \
    || { echo "$case_name changed the trigger-routine boundary." >&2; exit 1; }
}

prove_role_boundary_race_refusal() {
  local surface="$1" mutation="$2"
  local label="role-race-$surface-$mutation"
  local fixture_application="forge_role_fixture_${surface}_${mutation}"
  local surface_application fixture_sql cleanup_sql race_admin_url separator
  local race_fifo="$TEMP_ROOT/$label.fifo"
  local fixture_log="$TEMP_ROOT/$label-fixture.log"
  local surface_log="$TEMP_ROOT/$label-surface.log"
  local fixture_pid surface_pid surface_status retained

  case "$mutation" in
    attribute)
      fixture_sql='ALTER ROLE forge CREATEROLE;'
      cleanup_sql='ALTER ROLE forge NOCREATEROLE;'
      ;;
    membership)
      fixture_sql='GRANT forge_release_transition TO forge;'
      cleanup_sql='REVOKE forge_release_transition FROM forge;'
      ;;
    *) echo "Unknown role-race mutation: $mutation" >&2; exit 64 ;;
  esac
  case "$surface" in
    legacy) surface_application="forge_role_surface_$mutation" ;;
    shared) surface_application=forge-shared-app-privilege-reconciliation ;;
    installer) surface_application=forge-installer-role-provision ;;
    *) echo "Unknown role-race surface: $surface" >&2; exit 64 ;;
  esac

  snapshot "$label-before"
  mkfifo "$race_fifo"
  exec 9<>"$race_fifo"
  PGAPPNAME="$fixture_application" \
    PGPASSWORD="$FORGE_LEGACY_REPAIR_ADMIN_PASSWORD" \
    PGHOST="$FORGE_LEGACY_REPAIR_ADMIN_HOST" \
    PGUSER="$FORGE_LEGACY_REPAIR_ADMIN_USER" \
    PGDATABASE="$FORGE_LEGACY_REPAIR_ADMIN_DATABASE" \
    psql --set ON_ERROR_STOP=1 < "$race_fifo" > "$fixture_log" 2>&1 &
  fixture_pid=$!
  printf 'BEGIN;\n%s\n' "$fixture_sql" >&9
  if ! wait_for_activity_condition "$fixture_application" "state = 'idle in transaction'"; then
    printf 'ROLLBACK;\n\\q\n' >&9
    exec 9>&-
    wait "$fixture_pid" || true
    echo "$label fixture did not reach idle-in-transaction state." >&2
    exit 1
  fi

  case "$surface" in
    legacy)
      case "$FORGE_LEGACY_REPAIR_ADMIN_URL" in
        *\?*) separator='&' ;;
        *) separator='?' ;;
      esac
      race_admin_url="${FORGE_LEGACY_REPAIR_ADMIN_URL}${separator}application_name=${surface_application}"
      (
        cd "$WEB_ROOT"
        DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" FORGE_DATABASE_ADMIN_URL="$race_admin_url" \
          npm run protocol:repair-epic-172-legacy-release
      ) > "$surface_log" 2>&1 &
      ;;
    shared)
      (run_repair_grant_privileges "$label") > "$surface_log" 2>&1 &
      ;;
    installer)
      (run_installer_provision_database "$label") > "$surface_log" 2>&1 &
      ;;
  esac
  surface_pid=$!
  if ! wait_for_activity_condition "$surface_application" "wait_event_type = 'Lock'"; then
    printf 'ROLLBACK;\n\\q\n' >&9
    exec 9>&-
    wait "$fixture_pid" || true
    kill "$surface_pid" 2>/dev/null || true
    wait "$surface_pid" 2>/dev/null || true
    sed -n '1,160p' "$surface_log" >&2
    echo "$label did not expose the required pre-commit lock wait." >&2
    exit 1
  fi

  printf 'COMMIT;\n\\q\n' >&9
  exec 9>&-
  wait "$fixture_pid"
  set +e
  wait "$surface_pid"
  surface_status=$?
  set -e
  case "$surface" in
    shared)
      [ "$surface_status" -eq 0 ] \
        && grep -Fq 'Could not transactionally refresh forge app privileges (non-fatal).' "$TEMP_ROOT/$label.log" \
        || { sed -n '1,160p' "$surface_log" >&2; echo "$label did not refuse after the racing commit." >&2; exit 1; }
      ;;
    *)
      [ "$surface_status" -ne 0 ] \
        || { sed -n '1,160p' "$surface_log" >&2; echo "$label unexpectedly accepted the unsafe committed role boundary." >&2; exit 1; }
      ;;
  esac

  case "$mutation" in
    attribute)
      retained="$(admin_server_psql --no-align --tuples-only --quiet --command "SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = 'forge';")"
      [ "$retained" = t ] || { echo "$label normalized or lost the external attribute change." >&2; exit 1; }
      ;;
    membership)
      retained="$(admin_server_psql --no-align --tuples-only --quiet --command "SELECT count(*) FROM pg_catalog.pg_auth_members WHERE roleid = 'forge_release_transition'::pg_catalog.regrole AND member = 'forge'::pg_catalog.regrole;")"
      [ "$retained" = 1 ] || { echo "$label normalized or lost the external membership change." >&2; exit 1; }
      ;;
  esac
  snapshot "$label-after"
  assert_only_external_role_changed "$label-before" "$label-after" "$label"
  admin_server_psql --command "$cleanup_sql"
}

expect_refusal() {
  local case_name="$1"
  if run_repair; then
    echo "$case_name unexpectedly entered the legacy repair path." >&2
    exit 1
  fi
}

echo 'Proving exact legacy repair refusal cases against isolated disposable databases.'

prepare_0026_baseline
snapshot current-managed-0026-before
run_repair
snapshot current-managed-0026-after
assert_unchanged current-managed-0026-before current-managed-0026-after 'Current managed 0026 no-op'

prepare_0026_baseline
admin_psql --command 'GRANT EXECUTE ON FUNCTION public.forge_epic_172_reject_mutation_v1() TO PUBLIC;'
snapshot current-public-without-s4-before
run_repair
snapshot current-public-without-s4-after
assert_unchanged current-public-without-s4-before current-public-without-s4-after 'Current 0026 PUBLIC ACL no-op'

prepare_0026_baseline
admin_psql --set migration_role="$FORGE_LEGACY_REPAIR_MIGRATION_USER" <<'SQL'
GRANT EXECUTE ON FUNCTION public.forge_epic_172_reject_mutation_v1() TO :"migration_role";
SQL
snapshot current-third-trigger-acl-before
expect_refusal 'Current 0026 third trigger-routine ACL shape'
snapshot current-third-trigger-acl-after
assert_unchanged current-third-trigger-acl-before current-third-trigger-acl-after 'Current 0026 third trigger-routine ACL shape'

prepare_cross_database_consumer
prepare_0026_baseline
snapshot current-cross-database-consumer-before
run_repair
snapshot current-cross-database-consumer-after
assert_unchanged current-cross-database-consumer-before current-cross-database-consumer-after 'Current 0026 cross-database consumer no-op'
drop_cross_database_consumer_database

prepare_0026_baseline
admin_psql --set migration_role="$FORGE_LEGACY_REPAIR_MIGRATION_USER" <<'SQL'
REVOKE EXECUTE ON FUNCTION forge.read_epic_172_enablement_state_v1() FROM :"migration_role";
SQL
snapshot current-missing-read-grant-before
expect_refusal 'Current 0026 missing read grant'
snapshot current-missing-read-grant-after
assert_unchanged current-missing-read-grant-before current-missing-read-grant-after 'Current 0026 missing read grant'

prepare_0026_baseline
admin_psql --set migration_role="$FORGE_LEGACY_REPAIR_MIGRATION_USER" <<'SQL'
GRANT CREATE ON SCHEMA forge TO :"migration_role";
SQL
snapshot current-extra-schema-grant-before
expect_refusal 'Current 0026 extra schema grant'
snapshot current-extra-schema-grant-after
assert_unchanged current-extra-schema-grant-before current-extra-schema-grant-after 'Current 0026 extra schema grant'

echo 'Proving every exact-0026 ACL fingerprint serializes table and column GRANT races.'
for acl_state in current legacy repaired; do
  prove_0026_acl_race_refusal "$acl_state" table
  prove_0026_acl_race_refusal "$acl_state" column
done

echo 'Proving exact-0026 projection ACL fingerprints serialize forge, PUBLIC, and protocol-role GRANT races.'
for acl_state in current legacy repaired; do
  prove_0026_acl_race_refusal "$acl_state" table projection
  prove_0026_acl_race_refusal "$acl_state" column projection
done

prepare_0026_baseline
strip_current_migration_grants
admin_psql --command 'GRANT EXECUTE ON FUNCTION public.forge_epic_172_reject_mutation_v1() TO PUBLIC;'
snapshot current-0026-normalized

prepare_legacy_fixture
admin_psql --command "UPDATE drizzle.__drizzle_migrations SET hash = '0000000000000000000000000000000000000000000000000000000000000000' WHERE created_at = 1784258966103;"
snapshot hash-near-miss-before
expect_refusal 'Migration-hash near-miss'
snapshot hash-near-miss-after
assert_unchanged hash-near-miss-before hash-near-miss-after 'Migration-hash near-miss'

prepare_legacy_fixture
admin_psql --command "UPDATE drizzle.__drizzle_migrations SET hash = '0000000000000000000000000000000000000000000000000000000000000000' WHERE created_at = 1784259621495;"
snapshot non-pair-hash-near-miss-before
expect_refusal 'Non-pair migration-hash near-miss'
snapshot non-pair-hash-near-miss-after
assert_unchanged non-pair-hash-near-miss-before non-pair-hash-near-miss-after 'Non-pair migration-hash near-miss'

prepare_legacy_fixture
admin_psql <<'SQL'
UPDATE drizzle.__drizzle_migrations
SET hash = CASE created_at
  WHEN 1784258966103 THEN 'e8234134bb5356d2c0093d4618a6e60251e2c16b8bdf8dcacfd5673cbbafbe85'
  WHEN 1784263200000 THEN '1fa66528143fad4b17dd91e64d64a07135098e4102f6ab5441e167e5458496de'
END
WHERE created_at IN (1784258966103, 1784263200000);
SQL
snapshot current-hash-legacy-catalog-before
expect_refusal 'Current hashes with legacy catalog'
snapshot current-hash-legacy-catalog-after
assert_unchanged current-hash-legacy-catalog-before current-hash-legacy-catalog-after 'Current hashes with legacy catalog'

prepare_legacy_fixture
admin_psql <<'SQL'
ALTER TABLE public.forge_epic_172_enablement_state
  DROP CONSTRAINT forge_epic_172_enablement_sha_chk,
  ADD CONSTRAINT forge_epic_172_enablement_sha_chk
    CHECK (reviewed_sha IS NULL OR reviewed_sha ~ '^x$');
SQL
snapshot constraint-near-miss-before
expect_refusal 'Constraint/schema near-miss'
snapshot constraint-near-miss-after
assert_unchanged constraint-near-miss-before constraint-near-miss-after 'Constraint/schema near-miss'

prepare_legacy_fixture
admin_psql <<'SQL'
CREATE TRIGGER forge_unexpected_release_trigger
BEFORE UPDATE ON public.forge_release_signer_keys
FOR EACH STATEMENT EXECUTE FUNCTION public.forge_epic_172_reject_mutation_v1();
SQL
snapshot extra-trigger-near-miss-before
expect_refusal 'Protected-table extra-trigger near-miss'
snapshot extra-trigger-near-miss-after
assert_unchanged extra-trigger-near-miss-before extra-trigger-near-miss-after 'Protected-table extra-trigger near-miss'

prepare_legacy_fixture
admin_psql --command 'REVOKE EXECUTE ON FUNCTION public.forge_epic_172_reject_mutation_v1() FROM PUBLIC;'
snapshot legacy-no-public-without-s4-before
expect_refusal 'Legacy no-PUBLIC ACL without local S4 state'
snapshot legacy-no-public-without-s4-after
assert_unchanged legacy-no-public-without-s4-before legacy-no-public-without-s4-after 'Legacy no-PUBLIC ACL without local S4 state'

prepare_legacy_fixture
admin_psql <<'SQL'
CREATE OR REPLACE FUNCTION public.forge_epic_172_reject_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN OLD;
END;
$function$;
SQL
snapshot trigger-routine-body-near-miss-before
expect_refusal 'Trigger-routine body near-miss'
snapshot trigger-routine-body-near-miss-after
assert_unchanged trigger-routine-body-near-miss-before trigger-routine-body-near-miss-after 'Trigger-routine body near-miss'

prepare_legacy_fixture
admin_psql --set migration_role="$FORGE_LEGACY_REPAIR_MIGRATION_USER" <<'SQL'
ALTER FUNCTION forge.guard_epic_172_s3_evidence_insert_v1() OWNER TO :"migration_role";
SQL
snapshot trigger-routine-owner-near-miss-before
expect_refusal 'Trigger-routine owner near-miss'
snapshot trigger-routine-owner-near-miss-after
assert_unchanged trigger-routine-owner-near-miss-before trigger-routine-owner-near-miss-after 'Trigger-routine owner near-miss'

prepare_legacy_fixture
admin_psql <<'SQL'
SET ROLE forge_release_routines_owner;
GRANT EXECUTE ON FUNCTION forge.guard_epic_172_s3_evidence_insert_v1() TO forge_release_transition;
RESET ROLE;
SQL
snapshot trigger-routine-acl-near-miss-before
expect_refusal 'Trigger-routine ACL near-miss'
snapshot trigger-routine-acl-near-miss-after
assert_unchanged trigger-routine-acl-near-miss-before trigger-routine-acl-near-miss-after 'Trigger-routine ACL near-miss'

prepare_legacy_fixture
admin_psql <<'SQL'
CREATE OR REPLACE FUNCTION forge.guard_epic_172_s3_state_transition_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;
SQL
snapshot s3-state-guard-body-near-miss-before
expect_refusal 'S3 state guard body near-miss'
snapshot s3-state-guard-body-near-miss-after
assert_unchanged s3-state-guard-body-near-miss-before s3-state-guard-body-near-miss-after 'S3 state guard body near-miss'

prepare_legacy_fixture
admin_psql --command 'DROP TRIGGER forge_epic_172_s3_release_state_one_way ON public.forge_epic_172_s3_release_state;'
snapshot s3-state-trigger-missing-before
expect_refusal 'S3 state one-way trigger missing'
snapshot s3-state-trigger-missing-after
assert_unchanged s3-state-trigger-missing-before s3-state-trigger-missing-after 'S3 state one-way trigger missing'

prepare_legacy_fixture
admin_psql <<'SQL'
SET ROLE forge_release_routines_owner;
GRANT EXECUTE ON FUNCTION forge.complete_epic_172_s3_release_v1(uuid,text,uuid,integer,text,jsonb,jsonb,text,bigint,jsonb,text,text,uuid,bigint,text,text,text,text,bytea,uuid,timestamptz,jsonb)
  TO forge_release_evidence_writer;
RESET ROLE;
SQL
snapshot s3-completion-routine-acl-near-miss-before
expect_refusal 'S3 completion routine ACL near-miss'
snapshot s3-completion-routine-acl-near-miss-after
assert_unchanged s3-completion-routine-acl-near-miss-before s3-completion-routine-acl-near-miss-after 'S3 completion routine ACL near-miss'

prepare_legacy_fixture
admin_psql --command 'REVOKE SELECT ON TABLE public.forge_release_signer_keys FROM forge_release_evidence_consumer;'
snapshot consumer-near-miss-before
expect_refusal 'Consumer ACL/role near-miss'
snapshot consumer-near-miss-after
assert_unchanged consumer-near-miss-before consumer-near-miss-after 'Consumer ACL/role near-miss'

prepare_legacy_fixture
admin_psql --command 'GRANT USAGE ON SCHEMA public TO forge_release_evidence_consumer;'
snapshot consumer-schema-near-miss-before
expect_refusal 'Consumer local-authority near-miss'
snapshot consumer-schema-near-miss-after
assert_unchanged consumer-schema-near-miss-before consumer-schema-near-miss-after 'Consumer local-authority near-miss'

prepare_legacy_fixture
admin_psql --command 'GRANT SELECT ON TABLE public.forge_epic_172_enablement_state TO PUBLIC;'
snapshot public-acl-near-miss-before
expect_refusal 'PUBLIC table ACL near-miss'
snapshot public-acl-near-miss-after
assert_unchanged public-acl-near-miss-before public-acl-near-miss-after 'PUBLIC table ACL near-miss'

prepare_legacy_fixture
admin_psql --command 'GRANT INSERT ON TABLE public.forge_epic_172_release_evidence TO forge_release_evidence_writer;'
snapshot writer-acl-near-miss-before
expect_refusal 'Writer table ACL near-miss'
snapshot writer-acl-near-miss-after
assert_unchanged writer-acl-near-miss-before writer-acl-near-miss-after 'Writer table ACL near-miss'

prepare_legacy_fixture
admin_psql --command 'GRANT SELECT ON TABLE public.forge_epic_172_release_evidence TO forge_release_evidence_writer WITH GRANT OPTION;'
snapshot grant-option-near-miss-before
expect_refusal 'Table ACL grant-option near-miss'
snapshot grant-option-near-miss-after
assert_unchanged grant-option-near-miss-before grant-option-near-miss-after 'Table ACL grant-option near-miss'

prepare_legacy_fixture
admin_psql <<'SQL'
GRANT SELECT ON TABLE public.forge_epic_172_release_evidence TO forge_release_evidence_writer WITH GRANT OPTION;
SET ROLE forge_release_evidence_writer;
GRANT SELECT ON TABLE public.forge_epic_172_release_evidence TO forge_release_transition;
RESET ROLE;
SQL
snapshot wrong-grantor-near-miss-before
expect_refusal 'Table ACL wrong-grantor near-miss'
snapshot wrong-grantor-near-miss-after
assert_unchanged wrong-grantor-near-miss-before wrong-grantor-near-miss-after 'Table ACL wrong-grantor near-miss'

echo 'Proving exact repair, ledger immutability, repaired no-op, and managed latest sequence.'
prepare_legacy_fixture
snapshot legacy-before-repair
run_repair
snapshot repaired-once
cmp -s "$TEMP_ROOT/legacy-before-repair.ledger" "$TEMP_ROOT/repaired-once.ledger" || { echo 'Repair changed the immutable migration ledger.' >&2; exit 1; }
# The only authority normalization is removal of migration-login ACLs by
# strip_current_migration_grants. PostgreSQL appends an ALTER TABLE ADD COLUMN,
# so repaired required_evidence has a different non-semantic ordinal position
# than a fresh 0026 column. Raw dumps remain above for no-mutation checks; this
# comparison removes only that declaration. The repair fingerprint separately
# requires its exact jsonb type, NOT NULL shape, and check constraint.
sed '/^    "required_evidence" "jsonb" NOT NULL,$/d' "$TEMP_ROOT/current-0026-normalized.schema" \
  > "$TEMP_ROOT/current-0026-canonical.schema"
sed '/^    "required_evidence" "jsonb" NOT NULL,$/d' "$TEMP_ROOT/repaired-once.schema" \
  > "$TEMP_ROOT/repaired-canonical.schema"
cmp -s "$TEMP_ROOT/current-0026-canonical.schema" "$TEMP_ROOT/repaired-canonical.schema" || {
  diff -u "$TEMP_ROOT/current-0026-canonical.schema" "$TEMP_ROOT/repaired-canonical.schema" >&2 || true
  echo 'Repaired legacy schema differs from normalized current 0026.' >&2
  exit 1
}
run_repair
snapshot repaired-twice
assert_unchanged repaired-once repaired-twice 'Repaired no-op'

run_s4_bootstrap() {
  (
    cd "$WEB_ROOT"
    DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" FORGE_DATABASE_ADMIN_URL="$FORGE_LEGACY_REPAIR_ADMIN_URL" \
      npm run protocol:bootstrap-epic-172-s4-roles
  )
}

expect_s4_bootstrap_failure() {
  set +e
  run_s4_bootstrap
  local status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo 'The legacy fixture unexpectedly completed the S4 bootstrap.' >&2
    exit 1
  fi
}

migrate_through_0027() {
  (
    cd "$WEB_ROOT"
    DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" npx tsx scripts/ci/migrate-through-0027.ts
  )
}

managed_env="$TEMP_ROOT/managed.env"
printf 'DATABASE_URL=%s\n' "$FORGE_LEGACY_REPAIR_DATABASE_URL" > "$managed_env"
run_managed_sequence() {
  (
    export DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL"
    export FORGE_DATABASE_ADMIN_URL="$FORGE_LEGACY_REPAIR_ADMIN_URL"
    export FORGE_ENV_FILE="$managed_env"
    export FORGE_INSTALL_LIBRARY=1
    source "$REPO_ROOT/scripts/install.sh"
    MANAGED_LOCAL_ADMIN_MODE=current
    run_managed_local_migration_sequence
  )
}

echo 'Proving accepted S4 boundary variants and later-ledger reruns.'
prepare_legacy_fixture
expect_s4_bootstrap_failure
snapshot failed-bootstrap-public-mismatch-before
expect_refusal 'Failed-bootstrap local S4 with PUBLIC trigger ACL'
snapshot failed-bootstrap-public-mismatch-after
assert_unchanged failed-bootstrap-public-mismatch-before failed-bootstrap-public-mismatch-after 'Failed-bootstrap local S4 with PUBLIC trigger ACL'

prepare_legacy_fixture
expect_s4_bootstrap_failure
admin_psql --command 'REVOKE EXECUTE ON FUNCTION public.forge_epic_172_reject_mutation_v1() FROM PUBLIC;'
snapshot failed-bootstrap-before
run_repair
snapshot failed-bootstrap-after
cmp -s "$TEMP_ROOT/failed-bootstrap-before.ledger" "$TEMP_ROOT/failed-bootstrap-after.ledger" || {
  echo 'Failed-bootstrap S4 repair changed the immutable migration ledger.' >&2
  exit 1
}
cmp -s "$TEMP_ROOT/failed-bootstrap-before.roles" "$TEMP_ROOT/failed-bootstrap-after.roles" || {
  echo 'Failed-bootstrap S4 repair changed the role boundary.' >&2
  exit 1
}
run_repair
snapshot failed-bootstrap-repaired-twice
assert_unchanged failed-bootstrap-after failed-bootstrap-repaired-twice 'Failed-bootstrap repaired no-op'

# A database reset drops all local grants and objects but intentionally leaves
# the cluster-global S4 principals. That exact zero-authority state is safe.
prepare_legacy_fixture
snapshot zero-authority-s4-before
run_repair
snapshot zero-authority-s4-after
cmp -s "$TEMP_ROOT/zero-authority-s4-before.ledger" "$TEMP_ROOT/zero-authority-s4-after.ledger" || {
  echo 'Zero-authority S4 repair changed the immutable migration ledger.' >&2
  exit 1
}
cmp -s "$TEMP_ROOT/zero-authority-s4-before.roles" "$TEMP_ROOT/zero-authority-s4-after.roles" || {
  echo 'Zero-authority S4 repair changed the role boundary.' >&2
  exit 1
}

prepare_legacy_fixture
run_repair
run_s4_bootstrap
migrate_through_0027
snapshot repaired-0027-before
run_repair
snapshot repaired-0027-after
assert_unchanged repaired-0027-before repaired-0027-after 'Repaired 0027 no-op'

ensure_forge_app_role
grant_exact_forge_contamination
assert_protected_forge_acl_count 148
snapshot contaminated-0027-before
expect_refusal 'Exact installer-grant contamination at 0027'
snapshot contaminated-0027-after
assert_unchanged contaminated-0027-before contaminated-0027-after 'Exact installer-grant contamination at 0027 refusal'
revoke_forge_contamination

echo 'Proving the full managed sequence normalizes once and is then stable at latest.'
run_managed_sequence
# A real legacy install ran the broad app grant after reaching latest. Recreate
# that state before the next upgrade so the 0028 normalizer sees a real shape.
grant_exact_forge_contamination
assert_protected_forge_acl_count 148
run_managed_sequence
snapshot managed-latest-once
assert_protected_forge_acl_count 2
run_managed_sequence
snapshot managed-latest-twice
assert_unchanged managed-latest-once managed-latest-twice 'Managed latest rerun'
admin_psql \
  --set expected_migration_count="$FORGE_CURRENT_MIGRATION_COUNT" \
  --set expected_latest_migration_at="$FORGE_CURRENT_LATEST_MIGRATION_AT" <<'SQL'
SELECT pg_catalog.set_config('forge.proof_expected_migration_count', :'expected_migration_count', false);
SELECT pg_catalog.set_config('forge.proof_expected_latest_migration_at', :'expected_latest_migration_at', false);

DO $proof$
BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations)
       <> current_setting('forge.proof_expected_migration_count')::bigint
     OR (SELECT max(created_at) FROM drizzle.__drizzle_migrations)
       <> current_setting('forge.proof_expected_latest_migration_at')::bigint THEN
    RAISE EXCEPTION 'Managed sequence did not reach the exact latest ledger';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid IN ('forge_release_routines_owner'::regrole, 'forge_s4_routines_owner'::regrole)
  ) THEN
    RAISE EXCEPTION 'Managed sequence retained temporary owner membership';
  END IF;
END;
$proof$;
SQL

echo 'Proving exact installer-grant normalization and near-miss refusal at the 0028 checkpoint.'
ensure_forge_app_role
admin_psql <<'SQL'
CREATE TABLE public.forge_legacy_ordinary_acl_probe (
  id integer PRIMARY KEY,
  value text NOT NULL
);
SQL
grant_exact_forge_contamination
assert_protected_forge_acl_count 148
echo 'Proving legacy normalizer role races block, then refuse the committed unsafe boundary.'
prove_role_boundary_race_refusal legacy attribute
prove_role_boundary_race_refusal legacy membership
snapshot exact-installer-contamination-before
run_repair
snapshot exact-installer-contamination-after
cmp -s "$TEMP_ROOT/exact-installer-contamination-before.ledger" "$TEMP_ROOT/exact-installer-contamination-after.ledger" || {
  echo 'Installer-grant normalization changed the immutable migration ledger.' >&2
  exit 1
}
assert_protected_forge_acl_count 2
admin_psql <<'SQL'
DO $proof$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relname = 'forge_legacy_ordinary_acl_probe'
      AND privilege.grantee = 'forge'::pg_catalog.regrole
      AND privilege.privilege_type IN ('DELETE', 'INSERT', 'SELECT', 'UPDATE')
      AND NOT privilege.is_grantable
  ) <> 4 THEN
    RAISE EXCEPTION 'Legacy normalization removed ordinary table CRUD grants';
  END IF;
END;
$proof$;
SQL
run_repair
snapshot exact-installer-contamination-rerun
assert_unchanged exact-installer-contamination-after exact-installer-contamination-rerun 'Normalized installer-grant rerun'

admin_server_psql --command 'ALTER ROLE forge CREATEROLE;'
snapshot unsafe-forge-attribute-before
expect_refusal 'Unsafe literal forge role attribute'
snapshot unsafe-forge-attribute-after
assert_unchanged unsafe-forge-attribute-before unsafe-forge-attribute-after 'Unsafe literal forge role attribute refusal'
admin_server_psql --command 'ALTER ROLE forge NOCREATEROLE;'

admin_server_psql --command 'GRANT forge_release_transition TO forge;'
snapshot unsafe-forge-membership-before
expect_refusal 'Unsafe literal forge role membership'
snapshot unsafe-forge-membership-after
assert_unchanged unsafe-forge-membership-before unsafe-forge-membership-after 'Unsafe literal forge role membership refusal'
admin_server_psql --command 'REVOKE forge_release_transition FROM forge;'

admin_psql <<'SQL'
SET ROLE forge_release_routines_owner;
GRANT SELECT (reviewed_sha) ON TABLE public.forge_epic_172_enablement_state TO forge;
RESET ROLE;
SQL
snapshot clean-column-contamination-before
expect_refusal 'Clean durable catalog with protected column grant'
snapshot clean-column-contamination-after
assert_unchanged clean-column-contamination-before clean-column-contamination-after 'Clean protected column-grant refusal'
admin_psql <<'SQL'
SET ROLE forge_release_routines_owner;
REVOKE SELECT (reviewed_sha) ON TABLE public.forge_epic_172_enablement_state FROM forge;
RESET ROLE;
SQL

grant_exact_forge_contamination
admin_psql <<'SQL'
SET ROLE forge_release_routines_owner;
GRANT SELECT (reviewed_sha) ON TABLE public.forge_epic_172_enablement_state TO forge;
RESET ROLE;
SQL
snapshot dirty-column-contamination-before
expect_refusal 'Exact installer-grant contamination with protected column grant'
snapshot dirty-column-contamination-after
assert_unchanged dirty-column-contamination-before dirty-column-contamination-after 'Dirty protected column-grant refusal'
admin_psql <<'SQL'
SET ROLE forge_release_routines_owner;
REVOKE SELECT (reviewed_sha) ON TABLE public.forge_epic_172_enablement_state FROM forge;
RESET ROLE;
SQL
restore_canonical_forge_boundary

grant_exact_forge_contamination
admin_psql --command 'GRANT INSERT ON TABLE public.architect_plan_versions TO PUBLIC;'
snapshot dirty-public-table-authority-before
expect_refusal 'Exact installer contamination with effective PUBLIC table authority'
snapshot dirty-public-table-authority-after
assert_unchanged dirty-public-table-authority-before dirty-public-table-authority-after 'Dirty PUBLIC table-authority refusal rollback'
admin_psql --command 'REVOKE INSERT ON TABLE public.architect_plan_versions FROM PUBLIC;'
restore_canonical_forge_boundary

grant_exact_forge_contamination
admin_psql --command 'GRANT SELECT (task_id), UPDATE (task_id) ON TABLE public.architect_plan_versions TO PUBLIC;'
snapshot dirty-public-column-authority-before
expect_refusal 'Exact installer contamination with effective PUBLIC column authority'
snapshot dirty-public-column-authority-after
assert_unchanged dirty-public-column-authority-before dirty-public-column-authority-after 'Dirty PUBLIC column-authority refusal rollback'
admin_psql --command 'REVOKE SELECT (task_id), UPDATE (task_id) ON TABLE public.architect_plan_versions FROM PUBLIC;'
restore_canonical_forge_boundary

grant_exact_forge_contamination
admin_psql --command 'GRANT SELECT ON TABLE public.work_package_local_projection_sources TO PUBLIC;'
snapshot dirty-public-projection-authority-before
expect_refusal 'Exact installer contamination with PUBLIC projection SELECT'
snapshot dirty-public-projection-authority-after
assert_unchanged dirty-public-projection-authority-before dirty-public-projection-authority-after 'Dirty PUBLIC projection-authority refusal rollback'
admin_psql --command 'REVOKE SELECT ON TABLE public.work_package_local_projection_sources FROM PUBLIC;'
restore_canonical_forge_boundary

grant_exact_forge_contamination
admin_psql --command 'GRANT SELECT (task_id) ON TABLE public.architect_plan_versions TO forge_architect_plan_history_reader;'
snapshot dirty-unrelated-column-acl-before
expect_refusal 'Exact installer contamination with unrelated-principal column ACL'
snapshot dirty-unrelated-column-acl-after
assert_unchanged dirty-unrelated-column-acl-before dirty-unrelated-column-acl-after 'Strict legacy unrelated-principal column-ACL refusal'
admin_psql --command 'REVOKE SELECT (task_id) ON TABLE public.architect_plan_versions FROM forge_architect_plan_history_reader;'
restore_canonical_forge_boundary

admin_psql <<'SQL'
SET ROLE forge_release_routines_owner;
GRANT SELECT ON TABLE public.forge_epic_172_enablement_state TO forge;
RESET ROLE;
SQL
snapshot partial-installer-contamination-before
expect_refusal 'Partial installer-grant contamination'
snapshot partial-installer-contamination-after
assert_unchanged partial-installer-contamination-before partial-installer-contamination-after 'Partial installer-grant contamination refusal'
restore_canonical_forge_boundary

admin_psql <<'SQL'
SET ROLE forge_s4_routines_owner;
GRANT INSERT ON TABLE public.architect_plan_versions TO forge;
RESET ROLE;
SQL
snapshot partial-s4-contamination-before
expect_refusal 'Partial non-release S4 installer-grant contamination'
snapshot partial-s4-contamination-after
assert_unchanged partial-s4-contamination-before partial-s4-contamination-after 'Partial non-release S4 contamination refusal'
restore_canonical_forge_boundary

admin_psql <<'SQL'
SET ROLE forge_release_routines_owner;
GRANT INSERT ON TABLE public.work_package_local_projection_sources TO forge;
RESET ROLE;
SQL
snapshot partial-projection-contamination-before
expect_refusal 'Partial projection installer-grant contamination'
snapshot partial-projection-contamination-after
assert_unchanged partial-projection-contamination-before partial-projection-contamination-after 'Partial projection contamination refusal'
restore_canonical_forge_boundary

admin_psql --set migration_role="$FORGE_LEGACY_REPAIR_MIGRATION_USER" <<'SQL'
ALTER TABLE public.architect_plan_versions OWNER TO :"migration_role";
SQL
snapshot protected-owner-drift-before
expect_refusal 'Fixed protected inventory wrong owner'
snapshot protected-owner-drift-after
assert_unchanged protected-owner-drift-before protected-owner-drift-after 'Fixed protected inventory wrong-owner refusal'
admin_psql <<'SQL'
ALTER TABLE public.architect_plan_versions OWNER TO forge_s4_routines_owner;
SQL

grant_exact_forge_contamination
admin_psql <<'SQL'
SET ROLE forge_release_routines_owner;
GRANT TRUNCATE ON TABLE public.forge_epic_172_enablement_state TO forge;
RESET ROLE;
SQL
snapshot extra-installer-contamination-before
expect_refusal 'Extra installer-grant contamination'
snapshot extra-installer-contamination-after
assert_unchanged extra-installer-contamination-before extra-installer-contamination-after 'Extra installer-grant contamination refusal'
restore_canonical_forge_boundary

echo 'Proving concurrent table and column ACL changes serialize across the full protected inventory.'
assert_protected_forge_acl_count 2
snapshot table-acl-race-before
prove_acl_grant_race_refusal table "SET ROLE forge_s4_routines_owner;
GRANT INSERT ON TABLE public.architect_plan_versions TO forge;
RESET ROLE;"
snapshot table-acl-race-after
assert_only_external_acl_changed table-acl-race-before table-acl-race-after 'Concurrent protected S4 table grant'
admin_psql <<'SQL'
DO $proof$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    WHERE namespace_row.nspname = 'public'
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND privilege.grantee = 'forge'::pg_catalog.regrole
  ) <> 3 OR (
    SELECT count(*)
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relname = 'architect_plan_versions'
      AND privilege.grantee = 'forge'::pg_catalog.regrole
      AND privilege.privilege_type = 'INSERT'
      AND NOT privilege.is_grantable
      AND privilege.grantor = relation.relowner
  ) <> 1 THEN
    RAISE EXCEPTION 'Concurrent S4 table grant was not preserved as the sole external ACL change';
  END IF;
END;
$proof$;
SQL
expect_refusal 'Committed concurrent protected S4 table grant'
snapshot table-acl-race-rerun
assert_unchanged table-acl-race-after table-acl-race-rerun 'Committed concurrent S4 table-grant refusal'
admin_psql <<'SQL'
SET ROLE forge_s4_routines_owner;
REVOKE INSERT ON TABLE public.architect_plan_versions FROM forge;
RESET ROLE;
SQL
assert_protected_forge_acl_count 2

snapshot column-acl-race-before
prove_acl_grant_race_refusal column "SET ROLE forge_s4_routines_owner;
GRANT SELECT (task_id) ON TABLE public.architect_plan_versions TO forge;
RESET ROLE;"
snapshot column-acl-race-after
assert_only_external_acl_changed column-acl-race-before column-acl-race-after 'Concurrent protected S4 column grant'
admin_psql <<'SQL'
DO $proof$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    WHERE namespace_row.nspname = 'public'
      AND owner_role.rolname IN ('forge_release_routines_owner', 'forge_s4_routines_owner')
      AND privilege.grantee = 'forge'::pg_catalog.regrole
  ) <> 2 OR (
    SELECT count(*)
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation.relname = 'architect_plan_versions'
      AND attribute.attname = 'task_id'
      AND privilege.grantee = 'forge'::pg_catalog.regrole
      AND privilege.privilege_type = 'SELECT'
      AND NOT privilege.is_grantable
      AND privilege.grantor = relation.relowner
  ) <> 1 OR (
    SELECT count(*)
    FROM pg_catalog.pg_attribute attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee = 'forge'::pg_catalog.regrole
  ) <> 1 THEN
    RAISE EXCEPTION 'Concurrent S4 column grant was not preserved as the sole external ACL change';
  END IF;
END;
$proof$;
SQL
expect_refusal 'Committed concurrent protected S4 column grant'
snapshot column-acl-race-rerun
assert_unchanged column-acl-race-after column-acl-race-rerun 'Committed concurrent S4 column-grant refusal'
admin_psql <<'SQL'
SET ROLE forge_s4_routines_owner;
REVOKE SELECT (task_id) ON TABLE public.architect_plan_versions FROM forge;
RESET ROLE;
SQL
assert_protected_forge_acl_count 2

echo 'Proving the real installer and repair app-grant transaction against disposable PostgreSQL.'
admin_psql <<'SQL'
CREATE TABLE public.forge_installer_privilege_probe (
  id integer PRIMARY KEY,
  value text NOT NULL
);
SQL
run_installer_grant_privileges installer-grant-success
assert_protected_forge_acl_count 2
assert_owner_driven_forge_boundary
run_repair_grant_privileges repair-grant-success
grep -Fq 'Ensured the forge role can read ordinary forge tables without protected-table DML access.' \
  "$TEMP_ROOT/repair-grant-success.log" || {
  sed -n '1,120p' "$TEMP_ROOT/repair-grant-success.log" >&2
  echo 'Repair did not execute the shared privilege reconciliation successfully.' >&2
  exit 1
}
assert_protected_forge_acl_count 2
assert_owner_driven_forge_boundary

echo 'Proving shared reconciliation role races block, then refuse the committed unsafe boundary.'
prove_role_boundary_race_refusal shared attribute
prove_role_boundary_race_refusal shared membership

echo 'Proving installer provisioning role races block, then refuse the committed unsafe boundary.'
prove_role_boundary_race_refusal installer attribute
prove_role_boundary_race_refusal installer membership

echo 'Proving percent-encoded native installer credentials survive provisioning and rerun.'
prove_encoded_installer_password

admin_psql --command 'GRANT INSERT ON TABLE public.architect_plan_versions TO PUBLIC;'
snapshot shared-public-table-authority-before
run_repair_grant_privileges repair-public-table-authority
snapshot shared-public-table-authority-after
assert_unchanged shared-public-table-authority-before shared-public-table-authority-after 'Shared SQL PUBLIC table-authority rollback'
grep -Fq 'Could not transactionally refresh forge app privileges (non-fatal).' \
  "$TEMP_ROOT/repair-public-table-authority.log" || {
  echo 'Repair did not report the shared SQL PUBLIC table-authority refusal.' >&2
  exit 1
}
admin_psql --command 'REVOKE INSERT ON TABLE public.architect_plan_versions FROM PUBLIC;'

admin_psql --command 'GRANT SELECT (task_id), UPDATE (task_id) ON TABLE public.architect_plan_versions TO PUBLIC;'
snapshot shared-public-column-authority-before
run_repair_grant_privileges repair-public-column-authority
snapshot shared-public-column-authority-after
assert_unchanged shared-public-column-authority-before shared-public-column-authority-after 'Shared SQL PUBLIC column-authority rollback'
grep -Fq 'Could not transactionally refresh forge app privileges (non-fatal).' \
  "$TEMP_ROOT/repair-public-column-authority.log" || {
  echo 'Repair did not report the shared SQL PUBLIC column-authority refusal.' >&2
  exit 1
}
admin_psql --command 'REVOKE SELECT (task_id), UPDATE (task_id) ON TABLE public.architect_plan_versions FROM PUBLIC;'
assert_protected_forge_acl_count 2

admin_psql --command 'GRANT SELECT ON TABLE public.work_package_local_projection_sources TO PUBLIC;'
snapshot shared-public-projection-authority-before
run_repair_grant_privileges repair-public-projection-authority
snapshot shared-public-projection-authority-after
assert_unchanged shared-public-projection-authority-before shared-public-projection-authority-after 'Shared SQL PUBLIC projection-authority rollback'
grep -Fq 'Could not transactionally refresh forge app privileges (non-fatal).' \
  "$TEMP_ROOT/repair-public-projection-authority.log" || {
  echo 'Repair did not report the shared SQL PUBLIC projection-authority refusal.' >&2
  exit 1
}
admin_psql --command 'REVOKE SELECT ON TABLE public.work_package_local_projection_sources FROM PUBLIC;'
assert_protected_forge_acl_count 2

admin_psql --command 'GRANT SELECT (task_id) ON TABLE public.architect_plan_versions TO forge_architect_plan_history_reader;'
snapshot shared-unrelated-column-acl-before
run_repair_grant_privileges repair-unrelated-column-acl
snapshot shared-unrelated-column-acl-after
assert_unchanged shared-unrelated-column-acl-before shared-unrelated-column-acl-after 'Shared SQL unrelated-principal column-ACL preservation'
grep -Fq 'Ensured the forge role can read ordinary forge tables without protected-table DML access.' \
  "$TEMP_ROOT/repair-unrelated-column-acl.log" || {
  echo 'Repair did not accept the unrelated-principal column ACL.' >&2
  exit 1
}
admin_psql --command 'REVOKE SELECT (task_id) ON TABLE public.architect_plan_versions FROM forge_architect_plan_history_reader;'
assert_protected_forge_acl_count 2

admin_server_psql --command 'ALTER ROLE forge INHERIT;'
run_repair_grant_privileges repair-legacy-inherit
admin_server_psql <<'SQL'
DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'forge' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Shared reconciliation did not normalize the known legacy INHERIT delta';
  END IF;
END;
$proof$;
SQL
assert_protected_forge_acl_count 2

admin_server_psql --command 'ALTER ROLE forge CREATEROLE;'
snapshot shared-unsafe-role-before
run_repair_grant_privileges repair-unsafe-role
snapshot shared-unsafe-role-after
assert_unchanged shared-unsafe-role-before shared-unsafe-role-after 'Shared SQL unsafe-role refusal'
grep -Fq 'Could not transactionally refresh forge app privileges (non-fatal).' \
  "$TEMP_ROOT/repair-unsafe-role.log" || {
  echo 'Repair did not report the shared SQL unsafe-role refusal.' >&2
  exit 1
}
admin_server_psql --command 'ALTER ROLE forge NOCREATEROLE;'

admin_server_psql --command 'ALTER ROLE forge NOLOGIN;'
snapshot shared-nologin-role-before
run_repair_grant_privileges repair-nologin-role
snapshot shared-nologin-role-after
assert_unchanged shared-nologin-role-before shared-nologin-role-after 'Shared SQL NOLOGIN-role refusal'
admin_server_psql --command 'ALTER ROLE forge LOGIN;'

admin_server_psql --command 'GRANT forge_release_transition TO forge;'
snapshot shared-membership-before
run_repair_grant_privileges repair-membership
snapshot shared-membership-after
assert_unchanged shared-membership-before shared-membership-after 'Shared SQL membership refusal'
admin_server_psql --command 'REVOKE forge_release_transition FROM forge;'

admin_psql --set migration_role="$FORGE_LEGACY_REPAIR_MIGRATION_USER" <<'SQL'
ALTER TABLE public.architect_plan_versions OWNER TO :"migration_role";
SQL
snapshot shared-wrong-owner-before
run_repair_grant_privileges repair-wrong-owner
snapshot shared-wrong-owner-after
assert_unchanged shared-wrong-owner-before shared-wrong-owner-after 'Shared SQL wrong-owner refusal'
grep -Fq 'Could not transactionally refresh forge app privileges (non-fatal).' \
  "$TEMP_ROOT/repair-wrong-owner.log" || {
  echo 'Repair did not report the shared SQL wrong-owner refusal.' >&2
  exit 1
}
admin_psql <<'SQL'
ALTER TABLE public.architect_plan_versions OWNER TO forge_s4_routines_owner;
SQL
run_repair_grant_privileges repair-after-owner-restore
assert_protected_forge_acl_count 2
assert_owner_driven_forge_boundary
admin_psql <<'SQL'
DO $proof$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) privilege
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE namespace_row.nspname = 'public'
      AND relation.relname = 'forge_installer_privilege_probe'
      AND grantee.rolname = 'forge'
      AND privilege.privilege_type IN ('DELETE', 'INSERT', 'SELECT', 'UPDATE')
      AND NOT privilege.is_grantable
  ) <> 4 THEN
    RAISE EXCEPTION 'Installer did not grant exact ordinary-table CRUD access';
  END IF;
END;
$proof$;
SET ROLE forge;
INSERT INTO public.forge_installer_privilege_probe (id, value) VALUES (1, 'created');
UPDATE public.forge_installer_privilege_probe SET value = 'updated' WHERE id = 1;
SELECT value FROM public.forge_installer_privilege_probe WHERE id = 1;
DELETE FROM public.forge_installer_privilege_probe WHERE id = 1;
RESET ROLE;
SQL

admin_psql <<'SQL'
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM forge;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM forge;
REVOKE USAGE, CREATE ON SCHEMA public FROM forge;
DO $cleanup$
DECLARE
  default_owner record;
BEGIN
  FOR default_owner IN
    SELECT DISTINCT owner_role.rolname
    FROM pg_catalog.pg_default_acl default_acl
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = default_acl.defaclrole
    CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) privilege
    WHERE default_acl.defaclnamespace = 'public'::pg_catalog.regnamespace
      AND privilege.grantee = 'forge'::pg_catalog.regrole
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM forge',
      default_owner.rolname
    );
    EXECUTE pg_catalog.format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM forge',
      default_owner.rolname
    );
  END LOOP;
END;
$cleanup$;
CREATE FUNCTION public.forge_fail_privilege_reconciliation_proof()
RETURNS event_trigger
LANGUAGE plpgsql
AS $proof$
BEGIN
  RAISE EXCEPTION 'forced shared privilege reconciliation failure';
END;
$proof$;
CREATE EVENT TRIGGER forge_fail_privilege_reconciliation_proof
ON ddl_command_end
WHEN TAG IN ('ALTER DEFAULT PRIVILEGES')
EXECUTE FUNCTION public.forge_fail_privilege_reconciliation_proof();
SQL
assert_no_direct_forge_app_authority
snapshot installer-grant-rollback-before
run_installer_grant_privileges installer-grant-failure
snapshot installer-grant-rollback-after
assert_unchanged installer-grant-rollback-before installer-grant-rollback-after 'Installer revoke-stage transaction rollback'
assert_no_direct_forge_app_authority
grep -Fq 'ERROR:' "$TEMP_ROOT/installer-grant-failure-state/install.log" || {
  echo 'Installer revoke-stage failure was not recorded in the isolated install log.' >&2
  exit 1
}
grep -Fq 'forced shared privilege reconciliation failure' "$TEMP_ROOT/installer-grant-failure-state/install.log" || {
  echo 'Installer failure log did not identify the forced post-broad-grant failure.' >&2
  exit 1
}
snapshot repair-grant-rollback-before
run_repair_grant_privileges repair-grant-failure
snapshot repair-grant-rollback-after
assert_unchanged repair-grant-rollback-before repair-grant-rollback-after 'Repair shared-SQL transaction rollback'
assert_no_direct_forge_app_authority
grep -Fq 'Could not transactionally refresh forge app privileges (non-fatal).' \
  "$TEMP_ROOT/repair-grant-failure.log" || {
  echo 'Repair did not report the shared SQL rollback failure.' >&2
  exit 1
}
admin_psql <<'SQL'
DROP EVENT TRIGGER forge_fail_privilege_reconciliation_proof;
DROP FUNCTION public.forge_fail_privilege_reconciliation_proof();
DROP TABLE public.forge_installer_privilege_probe;
DROP TABLE public.forge_legacy_ordinary_acl_probe;
SQL

# S4 principals are cluster-global. Keep this deliberately unsafe membership
# case last so it cannot alter an earlier successful repair proof.
prepare_legacy_fixture
admin_psql --set migration_role="$FORGE_LEGACY_REPAIR_MIGRATION_USER" <<'SQL'
GRANT forge_s4_routines_owner TO :"migration_role";
SQL
snapshot unsafe-s4-before
expect_refusal 'Unsafe S4 membership'
snapshot unsafe-s4-after
assert_unchanged unsafe-s4-before unsafe-s4-after 'Unsafe S4 membership'
admin_psql --set migration_role="$FORGE_LEGACY_REPAIR_MIGRATION_USER" <<'SQL'
REVOKE forge_s4_routines_owner FROM :"migration_role";
SQL

echo 'DBR-1 exact legacy repair, refusal isolation, and managed-sequence proof passed.'
