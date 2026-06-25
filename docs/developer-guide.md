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
| `.codex/agents` | Versioned seed defaults for manual Codex roles |
| `.claude/agents` | Optional legacy Claude prompt import location when present locally |

Mutable Forge runtime and user-owned files live outside the checkout under the
active workspace root, which defaults to `~/Documents/Forge`:

```text
~/Documents/Forge/
  config/forge.env
  prompts/agents/*.toml
  workforces/<slug>/{workforce.json,workflow.json,manager-prompt.md}
  projects/
  mcps/
  local-memory/checkpoints/
  runtime/
  logs/
  backups/
```

The web process, worker, drizzle, seed scripts, and doctor load
`config/forge.env` from that workspace. Repository `.env` files are legacy
fallbacks only.

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

Codex manual operation uses `.codex/agents/*.toml` as versioned defaults.

On install, Forge copies those defaults to
`~/Documents/Forge/prompts/agents/*.toml`. The web app edits the workspace copy,
not the repository copy. Upgrades keep local workspace prompts unless the
installer is run with `--overwrite-prompts` or
`FORGE_PROMPT_UPGRADE_MODE=overwrite`; overwritten prompts are backed up under
`~/Documents/Forge/backups/prompts/`.

If an operator has local `.claude/agents/*.md` files from an older checkout,
the seed script can still import them as a fallback. The repository no longer
ships those files; do not make that legacy format the primary source of truth
for new Forge behavior.

Workforces are stored in PostgreSQL for runtime and exported to
`~/Documents/Forge/workforces/` after seed/create/update/archive operations.
Those exports include the ordered agent table, workflow JSON, and workforce
manager prompt. For this slice, the exports are mirrors; import/edit conflict
handling is intentionally out of scope.

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

## CLI Notes

The global `forge` launcher is a thin operator wrapper. Keep implementation
logic in the existing install, doctor, worker, and npm flows; CLI commands
should route to those sources of truth instead of duplicating behavior.
