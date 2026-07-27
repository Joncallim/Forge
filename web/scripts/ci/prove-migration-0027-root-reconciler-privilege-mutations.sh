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

# Every mutation is uncommitted. The assertion failure closes that psql session,
# which rolls the transaction back before the following fresh-session probe.
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
