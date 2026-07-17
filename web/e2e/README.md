# Running Forge end-to-end tests safely

Forge end-to-end (E2E) tests delete database rows and flush Redis. They must
never run against the database and Redis instance used by the normal Forge app.

Provide all three safeguards explicitly:

```sh
export FORGE_E2E_ALLOW_DESTRUCTIVE_RESET=1
export FORGE_E2E_DATABASE_URL='postgresql://forge_e2e:password@localhost:5432/forge_e2e'
export FORGE_E2E_REDIS_URL='redis://localhost:6379/15'
DATABASE_URL="$FORGE_E2E_DATABASE_URL" npm run db:migrate
npm run e2e
```

The PostgreSQL user and database names must contain `e2e` or `test`. The Redis
URL must select a nonzero logical database. Playwright ignores inherited
`DATABASE_URL` and `REDIS_URL` values unless they exactly match these dedicated
test URLs. Continuous integration uses the same contract.
