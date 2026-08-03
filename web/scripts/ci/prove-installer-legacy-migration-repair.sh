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
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/forge-legacy-repair-dbr1.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT

case "$FORGE_LEGACY_REPAIR_ADMIN_DATABASE" in
  ''|*[!A-Za-z0-9_]* ) echo 'Unsafe disposable database name.' >&2; exit 64 ;;
esac
case "$FORGE_LEGACY_REPAIR_MIGRATION_USER" in
  ''|*[!A-Za-z0-9_]* ) echo 'Unsafe disposable migration role name.' >&2; exit 64 ;;
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
    WHERE rolname LIKE $q$forge_release_%$q$ OR rolname LIKE $q$forge_s4_%$q$
    ORDER BY rolname;
    SELECT granted.rolname || chr(58) || member.rolname
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    WHERE granted.rolname LIKE $q$forge_release_%$q$ OR granted.rolname LIKE $q$forge_s4_%$q$
       OR member.rolname LIKE $q$forge_release_%$q$ OR member.rolname LIKE $q$forge_s4_%$q$
    ORDER BY 1;' > "$TEMP_ROOT/$label.roles"
}

assert_unchanged() {
  local before="$1" after="$2" case_name="$3"
  cmp -s "$TEMP_ROOT/$before.ledger" "$TEMP_ROOT/$after.ledger" || { echo "$case_name changed the migration ledger." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.schema" "$TEMP_ROOT/$after.schema" || { echo "$case_name changed the database catalog." >&2; exit 1; }
  cmp -s "$TEMP_ROOT/$before.roles" "$TEMP_ROOT/$after.roles" || { echo "$case_name changed the role boundary." >&2; exit 1; }
}

run_repair() {
  (
    cd "$WEB_ROOT"
    DATABASE_URL="$FORGE_LEGACY_REPAIR_DATABASE_URL" FORGE_DATABASE_ADMIN_URL="$FORGE_LEGACY_REPAIR_ADMIN_URL" \
      npm run protocol:repair-epic-172-legacy-release
  )
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

prepare_0026_baseline
strip_current_migration_grants
snapshot current-0026-normalized

prepare_legacy_fixture
admin_psql --command "UPDATE drizzle.__drizzle_migrations SET hash = '0000000000000000000000000000000000000000000000000000000000000000' WHERE created_at = 1784258966103;"
snapshot hash-near-miss-before
expect_refusal 'Migration-hash near-miss'
snapshot hash-near-miss-after
assert_unchanged hash-near-miss-before hash-near-miss-after 'Migration-hash near-miss'

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

echo 'Proving the full managed sequence is stable at latest when run twice.'
run_managed_sequence
snapshot managed-latest-once
run_managed_sequence
snapshot managed-latest-twice
assert_unchanged managed-latest-once managed-latest-twice 'Managed latest rerun'
admin_psql <<'SQL'
DO $proof$
BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 29
     OR (SELECT max(created_at) FROM drizzle.__drizzle_migrations) <> 1784274000000 THEN
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
