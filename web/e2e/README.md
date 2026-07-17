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

## Step 0 release bridge

Epic 172 Step 0 deliberately keeps project-management changes disabled. Later
release steps must present signed evidence before those changes can be enabled.
That means a small number of older browser flows cannot complete yet, including
task creation, approval, cancellation, retry, and MCP plan-review writes.

Continuous integration sets `FORGE_EPIC_172_STEP0_E2E_BRIDGE=1` only on the
Playwright test runner. The flag is not passed to the Forge web server and does
not enable an application route. A reviewed inventory in
`e2e/epic-172-step0-bridge.ts` skips only tests that require the later signed
activation. Every other test still runs. A source test fails when a Playwright
test is added, renamed, removed, or left out of that inventory.

The mixed-lock Case F test is also run first as a dedicated check. It proves the
real filesystem-grant HTTP route returns 503 without changing stored data, then
uses the shared internal mutation service to test lock order. This keeps the
disabled boundary and the recovery regression covered without a runtime bypass.
