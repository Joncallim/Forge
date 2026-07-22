#!/usr/bin/env bash
set -euo pipefail

: "${FORGE_DATABASE_ADMIN_URL:?Set the short-lived PostgreSQL administrator URL.}"
if [[ "${1:-}" != '--apply' ]]; then
  echo 'Strict root-reference cutover is actionless without the explicit --apply flag.' >&2
  exit 2
fi

psql "${FORGE_DATABASE_ADMIN_URL}" --set ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $cutover$
BEGIN
  IF (SELECT state FROM public.forge_epic_172_enablement_state WHERE singleton_id = 'epic-172') <> 'disabled' THEN
    RAISE EXCEPTION 'strict root-reference cutover requires Step 0 to remain disabled'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.project_root_ref_reconciliation
    WHERE singleton AND state = 'complete'
  ) OR EXISTS (SELECT 1 FROM public.projects WHERE root_ref IS NULL) THEN
    RAISE EXCEPTION 'strict root-reference cutover requires completed reconciliation and a zero-null scan'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.projects'::pg_catalog.regclass
      AND conname = 'projects_root_ref_not_null_proof'
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_root_ref_not_null_proof
      CHECK (root_ref IS NOT NULL) NOT VALID;
  END IF;
END;
$cutover$;
ALTER TABLE public.projects VALIDATE CONSTRAINT projects_root_ref_not_null_proof;
ALTER TABLE public.projects ALTER COLUMN root_ref SET NOT NULL;
COMMIT;
SQL

echo 'Strict root-reference cutover completed; Step 0 and S4 activation state were not changed.'
