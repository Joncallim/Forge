DO $fixture$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.projects'::pg_catalog.regclass
      AND attname = 'root_ref' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'The 0027 fixture must be loaded against the exact 0026 schema';
  END IF;
END;
$fixture$;

INSERT INTO public.users (id, display_name)
VALUES ('27000000-0000-4000-8000-000000000001', 'Migration 0027 fixture user');

INSERT INTO public.projects (id, name, submitted_by, local_path)
VALUES
  ('27000000-0000-4000-8000-000000000010', 'Legacy root A', '27000000-0000-4000-8000-000000000001', '/tmp/forge-0027-a'),
  ('27000000-0000-4000-8000-000000000020', 'Legacy root B', '27000000-0000-4000-8000-000000000001', '/tmp/forge-0027-b');
