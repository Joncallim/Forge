# Forge Web

Forge Web is the dashboard and API surface for Forge. It is responsible for
project setup, provider configuration, agent configuration, task submission, and
task/run visibility.

It is not the task executor. Submitting a task writes to PostgreSQL and enqueues
a Redis job. A separate Forge worker process must consume that job and update the
task lifecycle.

## Getting Started

Install dependencies and run the development server:

```bash
npm install
npm run dev
```

In a second terminal, start the worker helper:

```bash
npm run worker
```

Open [http://localhost:3000](http://localhost:3000).

If no providers exist yet, the dashboard opens the setup wizard first. Choose a
preset to create providers and assign them to agents, then review provider
health from the Providers page.

## Runtime Dependencies

- PostgreSQL for users, projects, providers, tasks, runs, and artifacts.
- Redis for job queues, SSE replay, and cross-process events.
- Provider API keys or local model gateways for agent execution.
- A Forge worker process for executing queued tasks.

When running from `web/`, both Next.js and the worker load the repository-root
`.env` file. Keep host-local values such as `DATABASE_URL=...localhost...` in
that file. Docker Compose services inject container-local URLs automatically.

## Task Lifecycle

1. User creates a task in the web UI.
2. `POST /api/tasks` inserts a task row with status `pending`.
3. `POST /api/tasks` pushes `{ taskId }` to Redis queue `forge:tasks`.
4. A worker claims the job, updates the task to `running`, creates an architect
   agent run, streams events, stores the planning artifact, and marks the task
   `awaiting_approval` or `failed`.
5. If the generated plan is approved, `POST /api/tasks/:id/approve` pushes an
   approval job to `forge:approvals`.
6. The worker consumes the approval and marks the helper-stage task `completed`.

Claude Code is not required by the web UI. It can still be used for development,
debugging, and manual operation, but normal task execution starts with the worker
described in `../docs/worker-process.md`.

## Current Worker Scope

The worker currently implements the first helper stage only. It consumes
`forge:tasks`, runs the configured architect model, writes an `adr_text` artifact,
updates task state, and consumes `forge:approvals` to complete approved planning
tasks. It does not yet edit repositories, run backend/frontend worker agents,
create commits, or open pull requests.

## Docker Compose

`scripts/setup.sh` starts only PostgreSQL and Redis for host-based development.
To run the app itself in containers:

```bash
docker compose up web
docker compose --profile worker up worker
```

## Agent Config Files

Agent prompts are stored in the database and can be synced to disk. For
standalone Next.js deployments, set `FORGE_AGENT_CONFIG_DIR` to an absolute path
where the app can read and write agent prompt files.
