#!/usr/bin/env bash
set -euo pipefail

: "${FORGE_DATABASE_ADMIN_URL:?Set the short-lived PostgreSQL administrator URL.}"
if [[ $# -eq 1 && "${1:-}" == '--apply' ]]; then
  through="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 --command "SELECT last_generation FROM public.project_root_change_journal_counter WHERE singleton;")"
elif [[ "${1:-}" == '--through' && "${2:-}" =~ ^(0|[1-9][0-9]*)$ && "${3:-}" == '--apply' && $# -eq 3 ]]; then
  through="$2"
else
  echo 'Usage: npm run project-roots:strict-cutover -- --through <nonnegative-generation> --apply' >&2
  exit 2
fi

psql "${FORGE_DATABASE_ADMIN_URL}" --set ON_ERROR_STOP=1 <<SQL
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $cutover$
DECLARE v_through bigint := ${through}::bigint;
BEGIN
  IF (SELECT state FROM public.forge_epic_172_enablement_state WHERE singleton_id = 'epic-172') <> 'disabled' THEN
    RAISE EXCEPTION 'strict root-reference cutover requires Step 0 to remain disabled' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_root_reconciliation_operations operation
    WHERE operation.through_generation = v_through AND operation.state = 'complete'
      AND operation.last_processed_generation = v_through AND operation.cumulative_count = v_through
  ) OR (SELECT last_generation FROM public.project_root_change_journal_counter WHERE singleton) <> v_through
    OR (SELECT coalesce(max(generation), 0) FROM public.project_root_change_journal) <> v_through
    OR (SELECT count(*) FROM public.project_root_change_journal) <> v_through
    OR (SELECT count(*) FROM public.project_root_reconciliation_outcomes) <> v_through
    OR EXISTS (SELECT 1 FROM public.projects WHERE root_ref IS NULL) THEN
    RAISE EXCEPTION 'strict root-reference cutover requires exact completed watermark coverage' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index index_row
    WHERE index_row.indexrelid = 'public.projects_root_ref_idx'::pg_catalog.regclass AND index_row.indisvalid
  ) THEN RAISE EXCEPTION 'strict root-reference cutover requires a valid concurrent projects(root_ref) index' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.projects'::regclass AND conname = 'projects_root_ref_not_null_proof') THEN
    ALTER TABLE public.projects ADD CONSTRAINT projects_root_ref_not_null_proof CHECK (root_ref IS NOT NULL) NOT VALID;
  END IF;
  -- Compatibility marker only; C6 authority is the exact operation/outcome set above.
  UPDATE public.project_root_ref_reconciliation SET state = 'complete', updated_at = pg_catalog.clock_timestamp() WHERE singleton;
END;
$cutover$;
ALTER TABLE public.projects VALIDATE CONSTRAINT projects_root_ref_not_null_proof;
ALTER TABLE public.projects ALTER COLUMN root_ref SET NOT NULL;
COMMIT;
SQL

echo "Strict root-reference cutover completed at watermark ${through}; Step 0 remains disabled."
