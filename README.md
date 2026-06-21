# Forge

Autonomous coding factory with a web control plane, provider-configurable agents,
and a queued execution model.

## How It Works

Forge is split into two runtime surfaces:

- **Web UI**: project setup, provider configuration, agent prompt editing, task
  submission, task status, run logs, and artifacts.
- **Worker process**: consumes queued tasks, runs helper stages through
  configured providers, updates task state, and publishes live run events.

The web UI does not execute tasks by itself. When a user submits a task, the API
persists it in PostgreSQL and pushes a job to Redis. A worker must consume that
job for the task to move beyond `pending`.

Claude Code can be used as a manual development-time orchestrator, but it is not
the desired production dependency. The target architecture is a dedicated Forge
worker process. See [docs/worker-process.md](docs/worker-process.md).

```text
Web task -> Redis queue -> Forge worker -> Architect plan -> Approval
```

## Quick Start (macOS — no Docker)

One command installs Postgres + Redis via Homebrew, generates every secret,
writes `.env` for you, prepares the database, and sets up **zero-config local
AI** — it installs Ollama, pulls a small model, and wires every agent to it so
you can run tasks with no API keys at all:

```bash
bash scripts/install-mac.sh
```

You never edit `.env` by hand and you don't need Docker. To use cloud models
instead, add a provider and its key on the Providers page (keys are stored
encrypted in the database, never in `.env`). The script is idempotent — safe to
re-run. To skip the local-AI setup and configure cloud providers yourself, run
`FORGE_SKIP_OLLAMA=1 bash scripts/install-mac.sh`.

Then run the web app and worker in separate terminals (both from `web/`):

```bash
cd web && npm run dev      # web UI at http://localhost:3000
```

```bash
cd web && npm run worker
```

Open `http://localhost:3000`, register your passkey, and submit a task — local
AI is already configured, so no provider setup is required.

## Quick Start (Docker — other platforms)

```bash
cp .env.example .env        # infra defaults work as-is for local Docker
bash scripts/setup.sh       # starts PostgreSQL + Redis via Docker
```

Then prepare the web app and database from `web/`:

```bash
cd web
npm install
npm run db:migrate
npm run db:seed-agents
```

Run the web app and worker from `web/` in separate terminals:

```bash
cd web
npm run dev
```

```bash
cd web
npm run worker
```

Open `http://localhost:3000`.

The first dashboard visit opens the setup wizard when no providers exist. Choose
a preset there, then review provider health from the Providers page.

For a step-by-step custom helper-model test, including the new `Custom` provider
option for the Architect helper, see
[docs/helper-model-install-test.md](docs/helper-model-install-test.md).

## GUI Screenshots

These screenshots come from the passing helper-stage Playwright smoke test in
GitHub Actions.

### Setup Wizard

![Forge setup wizard](docs/assets/gui/desktop-01-setup.png)

### Provider Review

![Forge providers page after applying a preset](docs/assets/gui/desktop-02-providers.png)

### Architect Plan Awaiting Approval

![Forge task detail page awaiting approval](docs/assets/gui/desktop-03-task-awaiting-approval.png)

### Completed Helper Task

![Forge task detail page after approval](docs/assets/gui/desktop-04-task-completed.png)

Containerized web and worker processes are available but intentionally separate
from the default setup command:

```bash
docker compose up web
docker compose --profile worker up worker
```

At the current stage, the web app can create projects, configure providers, edit
agent prompts, and enqueue tasks. The worker consumes queued tasks and runs the
first helper stage: an architect model call that produces a planning artifact,
records an `agent_runs` row, streams events to the task page, and moves the task
to `awaiting_approval`. Approving that plan queues an approval job; the worker
then closes the helper task as `completed`. Full code modification, GitHub branch
creation, and PR automation are still future worker stages.

Target future execution expands the worker pipeline to:

```text
Architect -> Backend / Frontend / QA / DevOps -> Reviewer -> PR / Merge
```

## Agents

| Agent | Model | Role |
|---|---|---|
| architect | kimi-k2 | Design, API contracts, task decomposition |
| backend | gpt-4.1 | APIs, migrations, business logic |
| frontend | gpt-4.1 | UI, state, API integration |
| reviewer | deepseek-r1 | Code review, security, correctness |
| qa | deepseek-r1 | Tests, coverage, regression |
| devops | minimax-01 | Docker, CI/CD, deployment |

## Stack

- **Next.js**: web dashboard and API routes
- **Forge worker**: background executor for queued task helper stages
- **OpenRouter**: routes worker agents to cloud models
- **LiteLLM**: self-hosted OpenAI-compatible gateway for local and hybrid routing
- **Ollama**: local model runner
- **PostgreSQL 16**: task history, agent state, decision logs
- **Redis 7**: job queues, scheduling, session state
- **Docker Compose**: local infrastructure

## Execution Status

The web control plane and initial worker helper are present. Submitted tasks no
longer require a manually started Claude Code session to leave `pending`; the
worker can claim the Redis job, run the architect planning step, persist an
artifact, move the task to `awaiting_approval`, and complete the helper stage
after approval.

The worker does not yet modify repositories, run specialist implementation
agents, create commits, or open GitHub PRs.

## Architecture

See [docs/worker-process.md](docs/worker-process.md) for the worker process
plan. The Notion architecture doc linked from earlier versions may contain
broader design context, but this repository documentation is the source of truth
for the current runtime model.
