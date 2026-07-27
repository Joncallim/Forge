#!/usr/bin/env bash
set -euo pipefail

: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"

project_id='27000000-0000-4000-8000-000000000700'
new_root_ref='27000000-0000-4000-8000-000000000703'
actor_id='11111111-1111-4111-8111-111111111111'

# These fixtures are deliberately arranged by the disposable administrator.
# The only reconciliation execution below is the existing dedicated-login shim.
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 \
  --file scripts/ci/sql/migration-0027-root-authority-project-fixture.sql
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 \
  --file scripts/ci/sql/migration-0027-root-authority-package-fixture.sql

psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command \
  "UPDATE public.projects SET root_ref = '${new_root_ref}'::uuid WHERE id = '${project_id}'::uuid"

authority_generation="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 --command \
  "SELECT generation FROM public.project_root_change_journal WHERE project_id = '${project_id}'::uuid AND outcome = 'root_update' ORDER BY generation DESC LIMIT 1")"
if [[ ! "$authority_generation" =~ ^[1-9][0-9]*$ ]]; then
  echo 'The authority fixture did not create an exact root-update journal generation.' >&2
  exit 1
fi

# This is a direct proof that the same URL used by the compatibility shim is
# the fixed, least-privilege reconciler login. The shim itself owns the sole
# post-drain watermark capture and production CLI invocation.
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command \
  "ALTER ROLE forge_project_root_reconciler PASSWORD 'forge_project_root_reconciler_test';" >/dev/null
authority="${FORGE_DATABASE_ADMIN_URL#*://}"
reconciler_url="postgresql://forge_project_root_reconciler:forge_project_root_reconciler_test@${authority#*@}"
if [[ "$(psql "$reconciler_url" --no-align --tuples-only --set ON_ERROR_STOP=1 --command 'SELECT session_user')" != 'forge_project_root_reconciler' ]]; then
  echo 'The root-authority proof did not obtain the dedicated reconciler login.' >&2
  exit 1
fi

# Exactly one operation is created: the existing shim first drains any legacy
# null roots, captures its exact watermark, then runs the production CLI.
bash scripts/ci/reconcile-migration-0027-root-refs.sh

through_generation="$(psql "$FORGE_DATABASE_ADMIN_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 --command \
  "SELECT through_generation FROM public.project_root_reconciliation_operations WHERE actor_id = '${actor_id}'::uuid ORDER BY created_at DESC LIMIT 1")"
if [[ ! "$through_generation" =~ ^[1-9][0-9]*$ ]] || (( authority_generation > through_generation )); then
  echo 'The completed reconciliation operation does not cover the authority root-update generation.' >&2
  exit 1
fi

psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 \
  --set authority_generation="$authority_generation" \
  --set through_generation="$through_generation" \
  --set actor_id="$actor_id" \
  --file scripts/ci/sql/migration-0027-root-authority-reconciliation-assertions.sql
