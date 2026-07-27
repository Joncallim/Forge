\set ON_ERROR_STOP on

-- Admin-only disposable-fixture arrangement for ROOT-R2A. This is deliberately
-- not a production authority path and remains incomplete until R2A1b/R2A2 add
-- packages and invoke the dedicated reconciler command.
DO $fixture$
BEGIN
  IF current_user = 'forge_project_root_reconciler' THEN
    RAISE EXCEPTION 'root authority fixture must not run as the reconciler login';
  END IF;
END;
$fixture$;

INSERT INTO public.projects (
  id, name, submitted_by, root_ref, root_binding_revision,
  grant_decision_revision, mcp_config
) VALUES (
  '27000000-0000-4000-8000-000000000700',
  'Root authority reconciliation fixture',
  '27000000-0000-4000-8000-000000000001',
  '27000000-0000-4000-8000-000000000701',
  1,
  1,
  '{"profile":"default","requiredMcps":["filesystem","github"],"overrides":{}}'::jsonb
);

INSERT INTO public.project_filesystem_grant_decisions (
  id, project_id, decision, capabilities, grant_decision_revision,
  root_binding_revision, decision_fingerprint, decision_generation,
  decided_by, decided_at
) VALUES (
  '27000000-0000-4000-8000-000000000702',
  '27000000-0000-4000-8000-000000000700',
  'approved',
  '["filesystem.project.read"]'::jsonb,
  1,
  1,
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  1,
  '27000000-0000-4000-8000-000000000001',
  '2026-07-28T00:00:00.000Z'::timestamptz
);

UPDATE public.project_filesystem_current_decision_pointers
SET
  current_decision_id = '27000000-0000-4000-8000-000000000702',
  current_decision_project_id = '27000000-0000-4000-8000-000000000700',
  current_decision_revision = 1,
  current_root_binding_revision = 1,
  current_decision_fingerprint =
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  current_decision_generation = 1,
  pointer_generation = 1
WHERE project_id = '27000000-0000-4000-8000-000000000700';

DO $assertions$
DECLARE
  project_row public.projects%ROWTYPE;
  decision_row public.project_filesystem_grant_decisions%ROWTYPE;
  pointer_row public.project_filesystem_current_decision_pointers%ROWTYPE;
BEGIN
  SELECT * INTO STRICT project_row
  FROM public.projects
  WHERE id = '27000000-0000-4000-8000-000000000700';
  SELECT * INTO STRICT decision_row
  FROM public.project_filesystem_grant_decisions
  WHERE id = '27000000-0000-4000-8000-000000000702';
  SELECT * INTO STRICT pointer_row
  FROM public.project_filesystem_current_decision_pointers
  WHERE project_id = project_row.id;

  IF project_row.submitted_by <> '27000000-0000-4000-8000-000000000001'::uuid
     OR project_row.root_ref IS NULL
     OR project_row.root_binding_revision <= 0
     OR project_row.grant_decision_revision <= 0
     OR project_row.mcp_config <> '{"profile":"default","requiredMcps":["filesystem","github"],"overrides":{}}'::jsonb
     OR decision_row.project_id <> project_row.id
     OR decision_row.decision <> 'approved'
     OR decision_row.capabilities <> '["filesystem.project.read"]'::jsonb
     OR decision_row.grant_decision_revision <> project_row.grant_decision_revision
     OR decision_row.root_binding_revision <> project_row.root_binding_revision
     OR decision_row.decision_generation <> 1
     OR decision_row.decision_fingerprint !~ '^sha256:[0-9a-f]{64}$'
     OR pointer_row.current_decision_id <> decision_row.id
     OR pointer_row.current_decision_project_id <> project_row.id
     OR pointer_row.current_decision_revision <> decision_row.grant_decision_revision
     OR pointer_row.current_root_binding_revision <> decision_row.root_binding_revision
     OR pointer_row.current_decision_generation <> decision_row.decision_generation
     OR pointer_row.current_decision_fingerprint <> decision_row.decision_fingerprint
     OR pointer_row.current_decision_fingerprint !~ '^sha256:[0-9a-f]{64}$'
     OR pointer_row.pointer_generation <> decision_row.decision_generation
  THEN
    RAISE EXCEPTION 'root authority project fixture has invalid project decision or current pointer parentage';
  END IF;

  IF (SELECT count(*) FROM public.project_filesystem_grant_decisions
      WHERE project_id = project_row.id) <> 1
     OR (SELECT count(*) FROM public.project_filesystem_current_decision_pointers
         WHERE project_id = project_row.id) <> 1
     OR (SELECT count(*) FROM public.project_filesystem_current_decision_pointers
         WHERE project_id = project_row.id AND current_decision_id IS NOT NULL) <> 1
  THEN
    RAISE EXCEPTION 'root authority project fixture has duplicate or ambiguous current authority';
  END IF;
END;
$assertions$;
