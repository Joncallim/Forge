#!/usr/bin/env bash
set -euo pipefail
: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"
actor='11111111-1111-4111-8111-111111111111'
authority="${FORGE_DATABASE_ADMIN_URL#*://}"
url="postgresql://forge_project_root_reconciler:forge_project_root_reconciler_test@${authority#*@}"
fail_phase() { local phase="$1" output="$2"; echo "root contention proof failed during ${phase}" >&2; [[ -f "$output" ]] && cat "$output" >&2; exit 1; }
run_success() { local phase="$1"; shift; local output; output="$(mktemp)"; if ! "$@" >"$output" 2>&1; then fail_phase "$phase" "$output"; fi; cat "$output"; unlink "$output"; }
operation="$(run_success 'load live operation' psql "$FORGE_DATABASE_ADMIN_URL" -At --field-separator='|' --set ON_ERROR_STOP=1 --command "SELECT operation_id, through_generation FROM public.project_root_reconciliation_operations WHERE actor_id='${actor}'::uuid ORDER BY created_at DESC LIMIT 1")"
op="${operation%%|*}"; through="${operation#*|}"
generation_row="$(run_success 'load generation-one journal outcome' psql "$FORGE_DATABASE_ADMIN_URL" -At --field-separator='|' --set ON_ERROR_STOP=1 --command 'SELECT project_id, outcome FROM public.project_root_change_journal WHERE generation=1')"
project="${generation_row%%|*}"; outcome="${generation_row#*|}"
[[ "$op" =~ ^[0-9a-f-]{36}$ && "$through" =~ ^[1-9][0-9]*$ && "$project" =~ ^[0-9a-f-]{36}$ && "$outcome" =~ ^(insert|root_update|archive)$ ]] || { echo 'contention proof lacks a live operation or closed journal outcome' >&2; exit 1; }
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
SELECT * FROM forge.complete_project_root_reconciliation_generation_v1('${op}'::uuid,'${actor}'::uuid,1,'${project}'::uuid,'${outcome}');
COMMIT;
SQL
) >"$winner_out" 2>&1 & winner_pid=$!
for _ in $(seq 1 100); do [[ -f "$ready" ]] && break; sleep 0.05; done
[[ -f "$ready" ]] || fail_phase 'wait for winner context barrier' "$winner_out"
if psql "$url" --set ON_ERROR_STOP=1 --command "BEGIN; SET LOCAL lock_timeout='250ms'; SET LOCAL statement_timeout='1s'; SELECT * FROM forge.claim_project_root_reconciliation_batch_v1('${op}'::uuid,'${actor}'::uuid,1); COMMIT;" >"$loser_out" 2>&1; then fail_phase 'require loser lock-timeout rejection' "$loser_out"; else loser_status=$?; fi
[[ "$loser_status" == 1 ]] || { echo "root contention proof expected command-mode loser psql exit 1, got ${loser_status}" >&2; fail_phase 'require loser lock-timeout rejection' "$loser_out"; }
grep -F -- 'canceling statement due to lock timeout' "$loser_out" >/dev/null || fail_phase 'require loser lock-timeout rejection' "$loser_out"
touch "$release"
if wait "$winner_pid"; then unset winner_pid; else winner_status=$?; echo "root contention proof winner psql exited ${winner_status}" >&2; fail_phase 'complete winner reconciliation' "$winner_out"; fi
run_success 'assert one completed contention lineage' psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command "DO \$\$ BEGIN IF (SELECT count(*) FROM public.project_root_reconciliation_outcomes WHERE operation_id='${op}'::uuid AND generation=1) <> 1 OR EXISTS (SELECT 1 FROM public.project_root_reconciliation_write_contexts WHERE operation_id='${op}'::uuid AND generation=1 AND completed_at IS NULL) THEN RAISE EXCEPTION 'contention proof left an ambiguous reconciliation lineage'; END IF; END \$\$;" >/dev/null
