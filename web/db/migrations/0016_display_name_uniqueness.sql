DO $$
DECLARE
  duplicate_count integer;
  iteration integer := 0;
BEGIN
  LOOP
    SELECT count(*)
      INTO duplicate_count
    FROM (
      SELECT lower(regexp_replace(btrim("display_name"), '\s+', ' ', 'g')) AS normalized_name
      FROM "agent_configs"
      GROUP BY normalized_name
      HAVING count(*) > 1
    ) duplicates;

    EXIT WHEN duplicate_count = 0;

    IF iteration = 0 THEN
      RAISE NOTICE 'Renaming duplicate agent display names before adding unique index: % normalized names affected.', duplicate_count;
    END IF;
    IF iteration >= 1000 THEN
      RAISE EXCEPTION 'Could not make agent display names unique after % rename attempts.', iteration;
    END IF;

    WITH ranked_agents AS (
      SELECT
        "id",
        row_number() OVER (
          PARTITION BY lower(regexp_replace(btrim("display_name"), '\s+', ' ', 'g'))
          ORDER BY "is_system" DESC, "is_active" DESC, "display_name" ASC, "agent_type" ASC, "id" ASC
        ) AS duplicate_rank
      FROM "agent_configs"
    )
    UPDATE "agent_configs" agent
    SET
      "display_name" = agent."display_name" || ' (duplicate ' || agent."id"::text || ')',
      "updated_at" = now()
    FROM ranked_agents
    WHERE agent."id" = ranked_agents."id"
      AND ranked_agents.duplicate_rank > 1;

    iteration := iteration + 1;
  END LOOP;
END $$;--> statement-breakpoint
DO $$
DECLARE
  duplicate_count integer;
  iteration integer := 0;
BEGIN
  LOOP
    SELECT count(*)
      INTO duplicate_count
    FROM (
      SELECT lower(regexp_replace(btrim("display_name"), '\s+', ' ', 'g')) AS normalized_name
      FROM "workforces"
      GROUP BY normalized_name
      HAVING count(*) > 1
    ) duplicates;

    EXIT WHEN duplicate_count = 0;

    IF iteration = 0 THEN
      RAISE NOTICE 'Renaming duplicate workforce display names before adding unique index: % normalized names affected.', duplicate_count;
    END IF;
    IF iteration >= 1000 THEN
      RAISE EXCEPTION 'Could not make workforce display names unique after % rename attempts.', iteration;
    END IF;

    WITH ranked_workforces AS (
      SELECT
        "id",
        row_number() OVER (
          PARTITION BY lower(regexp_replace(btrim("display_name"), '\s+', ' ', 'g'))
          ORDER BY "is_default" DESC, "is_active" DESC, "display_name" ASC, "slug" ASC, "id" ASC
        ) AS duplicate_rank
      FROM "workforces"
    )
    UPDATE "workforces" workforce
    SET
      "display_name" = workforce."display_name" || ' (duplicate ' || workforce."id"::text || ')',
      "updated_at" = now()
    FROM ranked_workforces
    WHERE workforce."id" = ranked_workforces."id"
      AND ranked_workforces.duplicate_rank > 1;

    iteration := iteration + 1;
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_configs_display_name_normalized_idx" ON "agent_configs" USING btree (lower(regexp_replace(btrim("display_name"), '\s+', ' ', 'g')));--> statement-breakpoint
CREATE UNIQUE INDEX "workforces_display_name_normalized_idx" ON "workforces" USING btree (lower(regexp_replace(btrim("display_name"), '\s+', ' ', 'g')));
