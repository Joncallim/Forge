# Forge Web App

This folder contains the Forge dashboard, API routes, database schema, tests,
and worker.

The dashboard lets an operator:

- sign in with a password and optional passkey,
- configure AI providers,
- create projects,
- submit tasks,
- review generated plans,
- approve or reject Orchestrator-stage work.

When a task is created, the API stores it in PostgreSQL and puts a job in Redis.
By default, `npm run dev` starts an embedded worker loop to pick up that job.

## Local Development

From `web/`:

```bash
npm install
npm run db:migrate
npm run db:seed-agents
npm run dev
```

Open:

```text
http://localhost:3000
```

## Required Services

Forge Web expects:

- PostgreSQL, for app data and encrypted provider settings.
- Redis, for task queues and live task events.
- A worker loop, embedded by default or run separately for split deployments.
- At least one AI provider, unless you only run mock tests.

When running from `web/`, both Next.js and the worker load the active Forge
workspace env file, which defaults to `~/Documents/Forge/config/forge.env`.
Repository `.env` files are legacy fallbacks only.

## Common Commands

```bash
forge                   # start the dashboard and embedded task worker
forge doctor            # check env, PostgreSQL, Redis, and GitHub CLI readiness
forge upgrade           # sync dependencies, migrations, seeds, and checks
forge reset-credentials # reset the local account password
npm run dev             # start the dashboard and embedded task worker
npm run worker          # start only the task worker for split deployments
npm run db:migrate      # apply database migrations
npm run db:seed-agents  # load default agent prompts
npm run doctor          # check env, PostgreSQL, Redis, and GitHub CLI readiness
npm test                # run unit tests
npm run build           # production build check
```

The `forge` launcher is the operator-facing wrapper. The npm commands remain
the source of truth for development and split-process workflows. See
[../docs/cli-command-architecture.md](../docs/cli-command-architecture.md).

## Task Flow

1. The user creates a task in the browser.
2. `POST /api/tasks` saves the task as `pending`.
3. The API pushes `{ taskId }` to Redis queue `forge:tasks`.
4. The worker claims the job and marks the task `running`.
5. The worker calls the configured Architect provider.
6. The worker stores the generated plan as an artifact.
7. The task becomes `awaiting_approval`.
8. The user approves or rejects the plan.
9. Approved Orchestrator-stage tasks become `completed`.

## Database Migrations

Schema lives in [db/schema.ts](db/schema.ts).

To apply migrations:

```bash
npm run db:migrate
```

To create a new migration after changing `db/schema.ts`:

```bash
npm run db:generate -- --name short_change_name
```

See [../docs/developer-guide.md](../docs/developer-guide.md).

## Docker

The root `scripts/setup.sh` starts only PostgreSQL and Redis for host-based
development.

To run the app itself in containers:

```bash
docker compose up web
docker compose --profile worker up worker
```

## Current Worker Scope

By default, the worker runs the Architect planning stage and waits for explicit
plan approval. Workforce materialization and handoff are default-on unless set
to `0` or `false`, so approved tasks can be materialized into work packages and
handoff/review-gate state. Generated package execution is opt-in with
`FORGE_WORK_PACKAGE_EXECUTION=1` and sandbox-only. Host-repository edits,
branches, commits, pull requests, merges, live specialist MCP grants, and
parallel specialist execution remain future work.

See [../docs/developer-guide.md](../docs/developer-guide.md).

For local command-line-agent providers, see
[../docs/acp-zed-connector.md](../docs/acp-zed-connector.md).
