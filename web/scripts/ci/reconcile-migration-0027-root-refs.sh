#!/usr/bin/env bash
set -euo pipefail

: "${FORGE_DATABASE_ADMIN_URL:?Set the short-lived PostgreSQL administrator URL.}"
batch_size="${FORGE_ROOT_REF_RECONCILE_BATCH_SIZE:-100}"
if [[ ! "${batch_size}" =~ ^[0-9]+$ ]] || (( batch_size < 1 || batch_size > 1000 )); then
  echo 'FORGE_ROOT_REF_RECONCILE_BATCH_SIZE must be an integer from 1 to 1000.' >&2
  exit 1
fi

preflight="$(psql "${FORGE_DATABASE_ADMIN_URL}" --no-align --tuples-only --set ON_ERROR_STOP=1 --command "
  SELECT state FROM public.forge_epic_172_enablement_state WHERE singleton_id = 'epic-172';
")"
if [[ "${preflight}" != 'disabled' ]]; then
  echo "Root-reference reconciliation requires the existing Step 0 state disabled; got ${preflight}." >&2
  exit 1
fi

for ((attempt = 1; attempt <= 100000; attempt += 1)); do
  result="$(psql "${FORGE_DATABASE_ADMIN_URL}" --no-align --tuples-only --field-separator '|' --set ON_ERROR_STOP=1 \
    --command "SELECT * FROM forge.reconcile_project_root_refs_v1(${batch_size});")"
  IFS='|' read -r batch_rows remaining state <<<"${result}"
  if [[ ! "${batch_rows}" =~ ^[0-9]+$ || ! "${remaining}" =~ ^[0-9]+$ ]]; then
    echo "Unexpected reconciliation result: ${result}" >&2
    exit 1
  fi
  echo "Root-reference batch ${attempt}: updated ${batch_rows}; remaining ${remaining}."
  if [[ "${state}" == 'complete' && "${remaining}" == '0' ]]; then
    break
  fi
  if (( attempt == 100000 )); then
    echo 'Root-reference reconciliation exceeded its deterministic batch limit.' >&2
    exit 1
  fi
done

zero_scan="$(psql "${FORGE_DATABASE_ADMIN_URL}" --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "SELECT count(*) FROM public.projects WHERE root_ref IS NULL;")"
if [[ "${zero_scan}" != '0' ]]; then
  echo "Root-reference zero scan failed with ${zero_scan} null rows." >&2
  exit 1
fi
echo 'Root-reference reconciliation completed with a zero-null scan.'
