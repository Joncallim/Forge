#!/usr/bin/env bash
set -euo pipefail

# Compatibility shim for the populated-upgrade proof. It uses the short-lived
# admin connection only to provision the disposable login and capture a
# watermark; the reconciliation process itself receives only the dedicated URL.
if [[ $# -eq 0 ]]; then
  : "${FORGE_DATABASE_ADMIN_URL:?Set the short-lived PostgreSQL administrator URL.}"
  psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command \
    "ALTER ROLE forge_project_root_reconciler PASSWORD 'forge_project_root_reconciler_test';" >/dev/null
  authority="${FORGE_DATABASE_ADMIN_URL#*://}"
  export FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL="postgresql://forge_project_root_reconciler:forge_project_root_reconciler_test@${authority#*@}"
  while :; do
    rows="$(psql "$FORGE_PROJECT_ROOT_RECONCILER_DATABASE_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 --command "SELECT forge.materialize_project_root_ref_expansion_v1(100);")"
    [[ "$rows" =~ ^[0-9]+$ ]] || { echo 'Legacy root materialization returned an invalid row count.' >&2; exit 1; }
    [[ "$rows" == '0' ]] && break
  done
  watermark="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 --command \
    "SELECT last_generation FROM public.project_root_change_journal_counter WHERE singleton;")"
  if [[ ! "$watermark" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo 'The root journal watermark is malformed.' >&2
    exit 1
  fi
  exec npx tsx scripts/reconcile-project-root-expansion.ts \
    --through "$watermark" --actor 11111111-1111-4111-8111-111111111111 --apply
fi
exec npx tsx scripts/reconcile-project-root-expansion.ts "$@"
