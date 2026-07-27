#!/usr/bin/env bash
set -euo pipefail

: "${FORGE_MIGRATION_0027_DATABASE_URL:?Set the disposable PostgreSQL 0027 upgrade database URL.}"
: "${FORGE_DATABASE_ADMIN_URL:?Set the short-lived PostgreSQL administrator URL.}"

authority="${FORGE_MIGRATION_0027_DATABASE_URL#*://}"
app_url="postgresql://forge_app_test:forge_app_test@${authority#*@}"
project_id='27000000-0000-4000-8000-0000000007a1'
task_id='27000000-0000-4000-8000-0000000007a2'
package_id='27000000-0000-4000-8000-0000000007a3'

psql "${FORGE_DATABASE_ADMIN_URL}" --set ON_ERROR_STOP=1 <<'SQL'
GRANT CONNECT ON DATABASE forge_migration_0027_upgrade_test TO forge_app_test;
GRANT USAGE ON SCHEMA public TO forge_app_test;
GRANT INSERT ON TABLE public.projects, public.tasks, public.work_packages,
  public.project_filesystem_current_decision_pointers,
  public.filesystem_mcp_current_decision_pointers
  TO forge_app_test;
SQL

psql "${app_url}" --set ON_ERROR_STOP=1 \
  --set project_id="${project_id}" \
  --set task_id="${task_id}" \
  --set package_id="${package_id}" <<'SQL'
INSERT INTO public.projects (id, name)
VALUES (:'project_id'::uuid, 'Ordinary application trigger proof');
INSERT INTO public.tasks (id, project_id, title, prompt)
VALUES (:'task_id'::uuid, :'project_id'::uuid, 'Ordinary application task', 'trigger proof');
INSERT INTO public.work_packages (id, task_id, assigned_role, title, summary, status, sequence)
VALUES (:'package_id'::uuid, :'task_id'::uuid, 'backend', 'Ordinary application package', 'trigger proof', 'pending', 1);
SQL

trigger_state="$(psql "${FORGE_DATABASE_ADMIN_URL}" --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --set project_id="${project_id}" \
  --set package_id="${package_id}" --command "
    SELECT EXISTS (
      SELECT 1 FROM public.project_filesystem_current_decision_pointers
      WHERE project_id = :'project_id'::uuid
    ) AND EXISTS (
      SELECT 1 FROM public.filesystem_mcp_current_decision_pointers
      WHERE work_package_id = :'package_id'::uuid
    ) AND (SELECT count(*) FROM public.work_package_local_projection_heads
           WHERE work_package_id = :'package_id'::uuid) = 8
  ")"
[[ "${trigger_state}" == 't' ]] || { echo 'ordinary application writes did not fire the S3 pointer and projection-head triggers' >&2; exit 1; }
