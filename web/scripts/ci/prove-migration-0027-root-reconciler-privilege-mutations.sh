#!/usr/bin/env bash
set -euo pipefail

: "${FORGE_DATABASE_ADMIN_URL:?Set the short-lived PostgreSQL administrator URL.}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
assertion_file="${script_dir}/sql/migration-0027-root-reconciler-privileges-assertions.sql"
proof_tmpdir="$(mktemp -d)"

cleanup() {
  rm -rf "${proof_tmpdir}"
}
trap cleanup EXIT

fail_with_output() {
  local phase="$1"
  local output_file="$2"
  echo "Root reconciler privilege mutation proof failed during ${phase}." >&2
  cat "${output_file}" >&2
  exit 1
}

snapshot_application_acls() {
  psql "${FORGE_DATABASE_ADMIN_URL}" --no-align --tuples-only --set ON_ERROR_STOP=1 --command "
    WITH acl_rows AS (
      SELECT 'relation:' || namespace_row.nspname || '.' || relation.relname || ':' || coalesce(relation.relacl::text, '') AS entry
      FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      WHERE namespace_row.nspname IN ('public', 'forge')
      UNION ALL
      SELECT 'column:' || namespace_row.nspname || '.' || relation.relname || '.' || attribute_row.attname || ':' || coalesce(attribute_row.attacl::text, '')
      FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute attribute_row ON attribute_row.attrelid = relation.oid
      WHERE namespace_row.nspname IN ('public', 'forge') AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
      UNION ALL
      SELECT 'routine:' || namespace_row.nspname || '.' || routine.proname || '(' || pg_catalog.oidvectortypes(routine.proargtypes) || '):' || coalesce(routine.proacl::text, '')
      FROM pg_catalog.pg_proc routine JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
      WHERE namespace_row.nspname IN ('public', 'forge')
      UNION ALL
      SELECT 'schema:' || namespace_row.nspname || ':' || coalesce(namespace_row.nspacl::text, '')
      FROM pg_catalog.pg_namespace namespace_row WHERE namespace_row.nspname IN ('public', 'forge')
      UNION ALL
      SELECT 'database:' || database_row.datname || ':' || coalesce(database_row.datacl::text, '')
      FROM pg_catalog.pg_database database_row WHERE database_row.datname = pg_catalog.current_database()
    )
    SELECT md5(coalesce(string_agg(entry, E'\\n' ORDER BY entry), '')) FROM acl_rows"
}

expect_allowlist_rejection() {
  local phase="$1"
  local expected_entry="$2"
  local grant_sql="$3"
  local output_file="${proof_tmpdir}/${phase}.log"
  local status=0

  set +e
  psql "${FORGE_DATABASE_ADMIN_URL}" --set ON_ERROR_STOP=1 >"${output_file}" 2>&1 <<SQL
BEGIN;
${grant_sql}
\i ${assertion_file}
ROLLBACK;
SQL
  status=$?
  set -e

  if [[ "${status}" -ne 3 ]]; then
    fail_with_output "${phase}: expected psql script rejection status 3, received ${status}" "${output_file}"
  fi
  if ! grep -F -- 'root reconciler effective privilege allowlist mismatch' "${output_file}" >/dev/null; then
    fail_with_output "${phase}: exact allowlist rejection was absent" "${output_file}"
  fi
  if ! grep -F -- "${expected_entry}" "${output_file}" >/dev/null; then
    fail_with_output "${phase}: expected unexpected-set entry ${expected_entry} was absent" "${output_file}"
  fi
}

expect_grant_option_rejection() {
  local phase='relation grant option mutation'
  local output_file="${proof_tmpdir}/${phase}.log"
  local status=0 identity_line mutation_owner_role mutation_session_user mutation_current_user mutation_can_set_owner expected_entry

  set +e
  psql "${FORGE_DATABASE_ADMIN_URL}" --set ON_ERROR_STOP=1 >"${output_file}" 2>&1 <<SQL
BEGIN;
SELECT pg_catalog.pg_get_userbyid(relation.relowner) AS mutation_owner_role,
  session_user AS mutation_session_user,
  pg_catalog.pg_has_role(session_user, pg_catalog.pg_get_userbyid(relation.relowner), 'SET') AS mutation_can_set_owner
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
WHERE namespace_row.nspname = 'public' AND relation.relname = 'projects' AND relation.relkind = 'r' \gset
SET LOCAL ROLE :"mutation_owner_role";
SELECT current_user AS mutation_current_user \gset
\echo ROOT_GRANT_OPTION_MUTATION_IDENTITY owner=:mutation_owner_role session=:mutation_session_user current=:mutation_current_user can_set=:mutation_can_set_owner
GRANT SELECT ON TABLE public.projects TO forge_project_root_reconciler WITH GRANT OPTION;
RESET ROLE;
\i ${assertion_file}
ROLLBACK;
SQL
  status=$?
  set -e

  identity_line="$(grep -F -- 'ROOT_GRANT_OPTION_MUTATION_IDENTITY owner=' "${output_file}" || true)"
  [[ "${identity_line}" =~ ^ROOT_GRANT_OPTION_MUTATION_IDENTITY\ owner=([^[:space:]]+)\ session=([^[:space:]]+)\ current=([^[:space:]]+)\ can_set=([tf])$ ]] || {
    fail_with_output "${phase}: mutation connection did not emit its exact owner/session/current role identity" "${output_file}"
  }
  mutation_owner_role="${BASH_REMATCH[1]}"
  mutation_session_user="${BASH_REMATCH[2]}"
  mutation_current_user="${BASH_REMATCH[3]}"
  mutation_can_set_owner="${BASH_REMATCH[4]}"
  [[ "${mutation_owner_role}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "${mutation_session_user}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "${mutation_current_user}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    fail_with_output "${phase}: mutation connection emitted an unsafe role identity" "${output_file}"
  }
  [[ "${mutation_can_set_owner}" == t && "${mutation_current_user}" == "${mutation_owner_role}" ]] || {
    fail_with_output "${phase}: mutation session could not assume the catalog-derived owner role" "${output_file}"
  }
  # PostgreSQL records the ACL grantor as the owner role that issued GRANT.
  # session_user remains in the proof output so inherited authority is visible.
  expected_entry="public.projects:SELECT:grantor=${mutation_owner_role}:grantee=forge_project_root_reconciler"

  if [[ "${status}" -ne 3 ]]; then
    fail_with_output "${phase}: expected psql script rejection status 3, received ${status}" "${output_file}"
  fi
  if ! grep -F -- 'root reconciler effective privilege allowlist mismatch' "${output_file}" >/dev/null; then
    fail_with_output "${phase}: exact allowlist rejection was absent" "${output_file}"
  fi
  if ! grep -F -- "${expected_entry}" "${output_file}" >/dev/null; then
    fail_with_output "${phase}: expected exact unexpected-set entry ${expected_entry} was absent" "${output_file}"
  fi
}

# Every mutation is uncommitted. The assertion failure closes that psql session,
# which rolls the transaction back before the following fresh-session probe.
baseline_acl="$(snapshot_application_acls)"
[[ "${baseline_acl}" =~ ^[0-9a-f]{32}$ ]] || { echo 'root reconciler privilege mutation proof could not fingerprint baseline ACLs' >&2; exit 1; }

expect_allowlist_rejection \
  'relation privilege mutation' \
  'public.projects:INSERT' \
  'GRANT INSERT ON TABLE public.projects TO forge_project_root_reconciler;'

expect_allowlist_rejection \
  'column update privilege mutation' \
  'public.tasks.title' \
  'GRANT UPDATE (title) ON TABLE public.tasks TO forge_project_root_reconciler;'

expect_allowlist_rejection \
  'column select privilege mutation' \
  'public.project_root_reconciliation_write_contexts.actor_id' \
  'GRANT SELECT (actor_id) ON TABLE public.project_root_reconciliation_write_contexts TO forge_project_root_reconciler;'

expect_grant_option_rejection

# This intentionally exercises an effective privilege inherited from PUBLIC,
# rather than only a direct grant to the dedicated login.
expect_allowlist_rejection \
  'public routine execute mutation' \
  'forge.read_epic_172_enablement_state_v1()' \
  'GRANT EXECUTE ON FUNCTION forge.read_epic_172_enablement_state_v1() TO PUBLIC;'

clean_output="${proof_tmpdir}/clean.log"
if ! psql "${FORGE_DATABASE_ADMIN_URL}" --set ON_ERROR_STOP=1 --file "${assertion_file}" >"${clean_output}" 2>&1; then
  fail_with_output 'fresh clean allowlist assertion' "${clean_output}"
fi

[[ "$(snapshot_application_acls)" == "${baseline_acl}" ]] || { echo 'root reconciler privilege mutation proof left application ACL bytes changed after rollback' >&2; exit 1; }
