#!/usr/bin/env bash
set -euo pipefail
: "${FORGE_DATABASE_ADMIN_URL:?Set the disposable administrator URL.}"

# The fixture deliberately makes the production concurrent unique build fail.
# PostgreSQL retains the same-name invalid index, giving the builder's recovery
# path a deterministic, non-timing-dependent input.
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public.projects (id, name, submitted_by, root_ref)
SELECT '27000000-0000-4000-8000-000000000050', 'Duplicate root index A', id, '27000000-0000-4000-8000-0000000000aa'::uuid FROM public.users LIMIT 1;
INSERT INTO public.projects (id, name, submitted_by, root_ref)
SELECT '27000000-0000-4000-8000-000000000060', 'Duplicate root index B', id, '27000000-0000-4000-8000-0000000000aa'::uuid FROM public.users LIMIT 1;
SQL
if npm run project-roots:build-concurrent-index -- --apply; then
  echo 'Duplicate roots unexpectedly allowed the unique concurrent index build.' >&2; exit 1
fi
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command "SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid = 'public.projects_root_ref_idx'::regclass AND NOT indisvalid" >/dev/null
psql "$FORGE_DATABASE_ADMIN_URL" --set ON_ERROR_STOP=1 --command "UPDATE public.projects SET root_ref = '27000000-0000-4000-8000-0000000000bb'::uuid WHERE id = '27000000-0000-4000-8000-000000000060'"
bash scripts/ci/reconcile-migration-0027-root-refs.sh
npm run project-roots:build-concurrent-index -- --apply
npm run project-roots:build-concurrent-index -- --apply
