#!/usr/bin/env bash
set -euo pipefail

canonical_index_refusal='strict root-reference cutover requires the exact canonical concurrent projects(root_ref) index'

expect_failure() {
  local expected_message="$1"
  shift
  local output
  output="$(mktemp)"
  if "$@" >"$output" 2>&1; then
    cat "$output" >&2
    rm -f "$output"
    echo "Expected command to fail: $*" >&2
    exit 1
  fi
  if ! grep -F -- "$expected_message" "$output" >/dev/null; then
    cat "$output" >&2
    rm -f "$output"
    echo "Expected failure message was absent: $expected_message" >&2
    exit 1
  fi
  rm -f "$output"
}

assert_cutover_not_started() {
  local root_not_null proof_constraint
  root_not_null="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --command \
    "SELECT attnotnull FROM pg_catalog.pg_attribute WHERE attrelid = 'public.projects'::regclass AND attname = 'root_ref' AND NOT attisdropped")"
  proof_constraint="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --command \
    "SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid = 'public.projects'::regclass AND conname = 'projects_root_ref_not_null_proof'")"
  if [[ "$root_not_null" != 'f' || "$proof_constraint" != '0' ]]; then
    echo 'Canonical-index refusal altered strict-cutover schema state.' >&2
    exit 1
  fi
}

usage() {
  echo 'Usage: prove-migration-0027-root-index-lifecycle.sh --prepare|--recover' >&2
  exit 2
}

phase="${1:-}"
case "$phase" in
  --prepare|--recover) [[ $# -eq 1 ]] || usage ;;
  *) usage ;;
esac
: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"

case "$phase" in
  --prepare)
    # The index guard runs before watermark coverage, so this remains an exact
    # cutover refusal even though preparation has not reconciled journal rows.
    expect_failure "$canonical_index_refusal" \
      bash scripts/ci/cutover-migration-0027-root-ref.sh --apply
    assert_cutover_not_started

# A valid but structurally wrong same-name index is never disposable production
# state. The production builder and cutover both refuse it without replacement.
    psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command \
      'CREATE UNIQUE INDEX CONCURRENTLY projects_root_ref_idx ON public.projects(id) WHERE root_ref IS NOT NULL'
    wrong_index_before="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --field-separator='|' --command \
      "SELECT indexrelid::oid, pg_catalog.pg_get_indexdef(indexrelid) FROM pg_catalog.pg_index WHERE indexrelid = pg_catalog.to_regclass('public.projects_root_ref_idx')")"
    if [[ -z "$wrong_index_before" ]]; then
      echo 'Failed to create the deterministic wrong root-reference index.' >&2
      exit 1
    fi
    expect_failure 'projects_root_ref_idx exists with a noncanonical definition.' \
      npm run project-roots:build-concurrent-index -- --apply
    expect_failure "$canonical_index_refusal" \
      bash scripts/ci/cutover-migration-0027-root-ref.sh --apply
    assert_cutover_not_started
    wrong_index_after="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --field-separator='|' --command \
      "SELECT indexrelid::oid, pg_catalog.pg_get_indexdef(indexrelid) FROM pg_catalog.pg_index WHERE indexrelid = pg_catalog.to_regclass('public.projects_root_ref_idx')")"
    if [[ "$wrong_index_after" != "$wrong_index_before" ]]; then
      echo 'The valid wrong root-reference index was replaced or changed.' >&2
      exit 1
    fi
    psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command \
      'DROP INDEX CONCURRENTLY public.projects_root_ref_idx'

# The fixture deliberately makes the production concurrent unique build fail.
# PostgreSQL retains the same-name invalid index, giving the builder's recovery
# path a deterministic, non-timing-dependent input.
    psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public.projects (id, name, submitted_by, root_ref)
SELECT '27000000-0000-4000-8000-000000000050', 'Duplicate root index A', id, '27000000-0000-4000-8000-0000000000aa'::uuid FROM public.users LIMIT 1;
INSERT INTO public.projects (id, name, submitted_by, root_ref)
SELECT '27000000-0000-4000-8000-000000000060', 'Duplicate root index B', id, '27000000-0000-4000-8000-0000000000aa'::uuid FROM public.users LIMIT 1;
SQL
    expect_failure 'could not create unique index "projects_root_ref_idx"' \
      npm run project-roots:build-concurrent-index -- --apply
    invalid_index="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --command \
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid = pg_catalog.to_regclass('public.projects_root_ref_idx') AND (NOT indisvalid OR NOT indisready))")"
    if [[ "$invalid_index" != 't' ]]; then
      echo 'The failed concurrent build did not retain the expected invalid index.' >&2
      exit 1
    fi
    expect_failure "$canonical_index_refusal" \
      bash scripts/ci/cutover-migration-0027-root-ref.sh --apply
    assert_cutover_not_started
    psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command \
      "UPDATE public.projects SET root_ref = '27000000-0000-4000-8000-0000000000bb'::uuid WHERE id = '27000000-0000-4000-8000-000000000060'"
    ;;
  --recover)
    invalid_index="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --command \
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid = pg_catalog.to_regclass('public.projects_root_ref_idx') AND (NOT indisvalid OR NOT indisready))")"
    if [[ "$invalid_index" != 't' ]]; then
      echo 'The prepared invalid root-reference index was unexpectedly absent or valid.' >&2
      exit 1
    fi
    npm run project-roots:build-concurrent-index -- --apply
    npm run project-roots:build-concurrent-index -- --apply
    ;;
  *) usage ;;
esac
