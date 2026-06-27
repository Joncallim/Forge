UPDATE "provider_health_checks" SET "status" = CASE WHEN "reachable" THEN 'ready' ELSE 'unreachable' END;
