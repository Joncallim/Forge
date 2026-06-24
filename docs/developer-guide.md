# Forge Developer Guide

This guide is for changing Forge. It combines the old worker, database,
prompt, command, and documentation notes into one developer reference.

## Plain-English Summary

Forge is a Next.js app with a background worker. The dashboard records what the
operator wants. The worker does the queued work and saves evidence for review.

The current worker runs only the Architect planning stage. Workforce data
structures now exist for work packages, harnesses, approval gates, and VCS
summaries, but specialist execution and repository writes are still future
slices.

## Local Development

From `web/`:

```bash
npm install
npm run db:migrate
npm run db:seed-agents
npm run dev
```

Common commands:

```bash
npm run dev             # dashboard plus embedded worker
npm run worker          # standalone worker for split deployments
npm run db:migrate      # apply migrations
npm run db:generate -- --name short_change_name
npm run db:seed-agents  # seed app agent prompts from .codex/agents
npm run doctor          # env, PostgreSQL, Redis, and GitHub readiness
npm test
npm run lint
npm run build
npm run e2e
```

## Web App Shape

Important directories:

| Path | Purpose |
|---|---|
| `web/app` | Next.js App Router pages and API routes |
| `web/components` | Shared UI components |
| `web/db/schema.ts` | Drizzle schema source of truth |
| `web/db/migrations` | Generated SQL migrations and snapshots |
| `web/worker` | Queue, worker runtime, Architect orchestration, Workforce materialization |
| `web/lib/recommendations.ts` | Static model preset and role recommendation data |
| `.codex/agents` | Manual Codex workforce prompts and default app seed source |
| `.claude/agents` | Legacy Claude prompt compatibility files |

The web process and worker load the repository-root `.env` when run from
`web/`, so local env behavior stays aligned with `.env.example`.

## Worker Runtime

Current task path:

```text
POST /api/tasks
  -> insert task in PostgreSQL
  -> push { taskId } to Redis list forge:tasks
  -> worker claims the job
  -> task becomes running
  -> Architect model produces Markdown
  -> artifact is saved
  -> Workforce planning records are materialized when possible
  -> task becomes awaiting_approval
  -> approval job marks it completed
```

Implemented worker files:

```text
web/worker/index.ts
web/worker/runtime.ts
web/worker/queue.ts
web/worker/orchestrator.ts
web/worker/architect-artifact.ts
web/worker/workforce-materializer.ts
web/worker/task-state.ts
web/worker/events.ts
web/worker/task-attempts.ts
```

Redis queues:

```text
forge:tasks
forge:tasks:processing
forge:tasks:retry
forge:tasks:dead
forge:approvals
forge:approvals:processing
forge:approvals:retry
forge:approvals:dead
```

The worker uses PostgreSQL as the source of truth. Redis carries wake-up jobs,
retry timing, and dead-letter transport.

## Workforce Architecture

Forge now separates editable app configuration from task-scoped execution
records:

1. Agents are editable records in `agent_configs`. The seeded Codex roles are
   defaults, not a closed enum.
2. Workforces are editable templates in `workforces`, with ordered memberships
   in `workforce_agents`.
3. Work packages remain task-scoped execution records produced from Architect
   plans.
4. Specialist harnesses in `agent_harnesses` can still describe how a specific
   agent or package should run.

Core tables:

| Table | Purpose |
|---|---|
| `agent_harnesses` | Reusable specialist/harness registry |
| `agent_configs` | Editable agent identity, prompt, provider, and active state |
| `workforces` | Reusable editable teams of agents |
| `workforce_agents` | Ordered agent membership inside each workforce |
| `work_packages` | Task-scoped units of work |
| `work_package_dependencies` | Ordering between packages |
| `approval_gates` | Human or automated gates |
| `vcs_changes` | Branch, PR, diff, and merge summary records |
| `agent_runs` | Execution attempts, now linkable to work packages and harnesses |

ADR 0005 records the first Workforce persistence slice. The current app extends
that direction by making agent and workforce configuration editable before
execution routing consumes those templates.

## Agent Prompts

Codex manual operation uses `.codex/agents/*.toml`.

The web app seeds editable app agent prompts from `.codex/agents`. Users can add
more agents from the dashboard, archive agents, and place agents into one or
more workforces. Presets only assign providers to matching seeded agents; custom
agents stay unchanged.

The hidden `.claude/agents` files remain legacy compatibility prompts. Do not
make them the primary source of truth for new Forge behavior.

## Database Migrations

`web/db/schema.ts` is the schema source of truth.

When changing the schema:

```bash
cd web
npm run db:generate -- --name short_change_name
npm run db:migrate
npm run lint
npm test
npm run build
```

Files:

- `web/db/migrations/*.sql` are generated SQL steps.
- `web/db/migrations/meta/*.json` are Drizzle snapshots.
- `web/db/migrations/meta/_journal.json` lists known migrations.

Do not hand-edit Drizzle metadata during normal development.

## Testing

Use focused tests for narrow changes and broaden coverage when changing shared
contracts or user-facing flows.

Validation stack:

```bash
cd web
npx tsc --noEmit
npm run lint
npm test
npm run build
npm run e2e
```

E2E tests use a mock Architect and prove setup, provider presets, project
creation, task execution, artifact review, and approval completion. They also
produce screenshot assets used by the design guide.

## Documentation Standard

Docs are prepared for a future wiki. Keep the set small and layered:

- `README.md` for first-time readers.
- `docs/operator-guide.md` for running Forge.
- `docs/developer-guide.md` for changing Forge.
- `docs/design.md` for product, UI, and screenshots.
- `docs/roadmap.md` for backlog and sequencing.
- `docs/adr/*` for durable decisions.

Major docs should move from plain English to operational use to technical
detail to reference material. Do not delete technical detail just to simplify an
opening; move it lower in the document.

## Coding Standards

- Prefer existing project patterns over new abstractions.
- Keep API routes validated and errors structured.
- Keep database changes migration-backed.
- Store secrets as env-var names or encrypted values, never as raw ordinary
  records.
- Make worker steps idempotent where retries are possible.
- Keep UI dense, readable, keyboard-accessible, and explicit about state.
- Run Reviewer and QA before merge.

## Future CLI Notes

Until a global CLI exists, route through existing scripts instead of duplicating
logic. Future commands should wrap the same install, doctor, worker, and npm
flows documented in the operator guide.
