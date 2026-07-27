#!/usr/bin/env bash
set -euo pipefail
: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"
actor='11111111-1111-4111-8111-111111111111'
authority="${FORGE_DATABASE_ADMIN_URL#*://}"
url="postgresql://forge_project_root_reconciler:forge_project_root_reconciler_test@${authority#*@}"
operation="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --field-separator='|' --set ON_ERROR_STOP=1 --command "SELECT operation_id, through_generation FROM public.project_root_reconciliation_operations WHERE actor_id='${actor}'::uuid ORDER BY created_at DESC LIMIT 1")"
op="${operation%%|*}"; through="${operation#*|}"
project="$(psql "$FORGE_DATABASE_ADMIN_URL" -At --set ON_ERROR_STOP=1 --command 'SELECT project_id FROM public.project_root_change_journal WHERE generation=1')"
[[ "$op" =~ ^[0-9a-f-]{36}$ && "$through" =~ ^[1-9][0-9]*$ && "$project" =~ ^[0-9a-f-]{36}$ ]] || { echo 'contention proof lacks a live operation' >&2; exit 1; }
barrier="$(mktemp -d)"; ready="$barrier/ready"; release="$barrier/release"; winner_out="$barrier/winner"; loser_out="$barrier/loser"
cleanup() { [[ -n "${winner_pid:-}" ]] && kill "$winner_pid" 2>/dev/null || true; rm -rf "$barrier"; }
trap cleanup EXIT
( psql "$url" --set ON_ERROR_STOP=1 <<SQL
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s';
SELECT * FROM forge.claim_project_root_reconciliation_batch_v1('${op}'::uuid,'${actor}'::uuid,1);
SELECT forge.enter_project_root_reconciliation_generation_v1('${op}'::uuid,'${actor}'::uuid,1,'${project}'::uuid);
\! touch '${ready}'
\! while [ ! -f '${release}' ]; do sleep 0.05; done
SELECT * FROM forge.complete_project_root_reconciliation_generation_v1('${op}'::uuid,'${actor}'::uuid,1,'${project}'::uuid,(SELECT outcome FROM public.project_root_change_journal WHERE generation=1));
COMMIT;
SQL
) >"$winner_out" 2>&1 & winner_pid=$!
for _ in $(seq 1 100); do [[ -f "$ready" ]] && break; sleep 0.05; done
[[ -f "$ready" ]] || { cat "$winner_out" >&2; exit 1; }
if psql "$url" --set ON_ERROR_STOP=1 --command "BEGIN; SET LOCAL lock_timeout='250ms'; SET LOCAL statement_timeout='1s'; SELECT * FROM forge.claim_project_root_reconciliation_batch_v1('${op}'::uuid,'${actor}'::uuid,1); COMMIT;" >"$loser_out" 2>&1; then cat "$loser_out" >&2; exit 1; fi
grep -F -- 'canceling statement due to lock timeout' "$loser_out" >/dev/null || { cat "$loser_out" >&2; exit 1; }
touch "$release"; wait "$winner_pid"; unset winner_pid
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command "DO \$\$ BEGIN IF (SELECT count(*) FROM public.project_root_reconciliation_outcomes WHERE operation_id='${op}'::uuid AND generation=1) <> 1 OR EXISTS (SELECT 1 FROM public.project_root_reconciliation_write_contexts WHERE operation_id='${op}'::uuid AND generation=1 AND completed_at IS NULL) THEN RAISE EXCEPTION 'contention proof left an ambiguous reconciliation lineage'; END IF; END \$\$;"
