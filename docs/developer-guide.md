# Forge Developer Guide

This guide is for changing Forge. It combines the old worker, database,
prompt, command, and documentation notes into one developer reference.

## Plain-English Summary

Forge is a Next.js app with a background worker. The dashboard records what the
operator wants. The worker does the queued work and saves evidence for review.

The current worker starts with the Architect planning stage. Workforce data
structures now exist for work packages, harnesses, approval gates, and version
control summaries. Work-package handoff is available after approval; sequential
specialist execution is opt-in with `FORGE_WORK_PACKAGE_EXECUTION=1`. Executable packages may receive bounded read-only
host-repository context. Generated files remain in per-package sandboxes under
`.forge/task-runs/<task-id>/<work-package-id>/attempt-<attempt-number>/` for
review and manual application. Direct host repository writes are unavailable.
Forge still does not grant MCP runtime access to specialists, create branches or
commits, open pull requests, merge work, run autonomous reviewer agents, or run
specialists in parallel.

The MCP/capability broker is an admission-time gate: it decides whether a work
package may be claimed and handed off based on the requested MCP capabilities,
their safe-beta allowlist, fallback policy, package-local prompt overlays, and
MCP health. It does not enforce capabilities at runtime (`runtimeEnforcement`
is `not_implemented`) -- specialists run sandboxed with no real MCP tools -- so
"brokered" here means gated admission, not a runtime sandbox over live tools.
Use precise grant terms: Architect-proposed grants, Forge broker decisions,
operator-approved grant snapshots, and effective run-scoped instructions.

Admission is being consolidated onto **one contract** (EPIC #172, ADR
[0009](adr/0009-mcp-admission-contract.md)). The same normalized
`McpAdmissionDecision` object -- with a capability `mode` of `planning_only`,
`bounded_context_required`, `bounded_context_approved`, `blocked`, or
`deferred_live_mcp`, plus a `recoveryAction` -- drives grant preview, plan
approval, handoff blocking, and operator recovery copy, so those surfaces cannot
disagree. Capabilities fall into three classes: **planning-only** (prompt
overlays, MCP-aware subtasks, `filesystem.project.write`; warn, never block),
**bounded read-only** (`filesystem.project.read|list|search`; may need an
explicit operator grant), and **deferred live MCP** (live tool handles, GitHub
write/branch/PR/merge/settings/secret, filesystem write/delete/admin; a product
boundary, not a broken install). The classifier is catalog-sourced
(`MCP_CATALOG.runtime.capabilities` plus a documented safe-read supplement
carrying today's allowlist), and a safe read is delivered as a bounded packet
only where a context producer exists for that MCP -- filesystem today; GitHub
reads have no producer yet, so they are honest planning context, not an
approvable bounded grant. Historically the same policy was re-derived
by four divergent paths (`validateMcpExecutionDesign`, `deriveMcpGrantDecisions`,
`evaluateWorkPackageMcpBroker`, and `requiresFilesystemGrantApproval`); they are
becoming thin adapters over the shared core in `web/lib/mcps/admission.ts`.

ACP providers are local command-line-agent providers. Forge starts the
configured ACP adapter on demand, speaks JSON-RPC over stdio, and receives text
back through the same provider interface used by the worker. The currently wired
Agent Client Protocol adapters wrap local tools such as Codex CLI and Claude
Code; the underlying CLI must already be installed, authenticated, and runnable
on the worker host. Architect ACP calls run in an isolated runtime directory.
Executable work-package ACP calls are opt-in after task approval. ACP adapters
are local processes, not OS-confined sandboxes; enable them only when a real
external confinement boundary is present. See [ACP
and the Zed connector](acp-zed-connector.md).

## Local Development

From `web/`:

```bash
npm install
npm run db:migrate
npm run db:seed-agents
npm run dev
```

### PostgreSQL proof commands

The ordinary zero-skip unit command excludes the database-backed S4 file so it
does not reuse the release-recorder database:

```bash
npm run test:unit:zero-skip
```

The mandatory S4 proof must use a freshly migrated database and all six
dedicated URLs (`FORGE_S4_POSTGRES_TEST_DATABASE_URL`,
`FORGE_EPIC_172_TEST_APP_DATABASE_URL`, `FORGE_PACKET_ISSUER_DATABASE_URL`,
`FORGE_ARCHITECT_PLAN_WRITER_DATABASE_URL`,
`FORGE_ARCHITECT_PLAN_RESOLVER_DATABASE_URL`, and
`FORGE_ARCHITECT_PLAN_HISTORY_READER_DATABASE_URL`). CI runs:

```bash
FORGE_S4_REQUIRE_POSTGRES_TEST=1 npm run test:mcp:s4-postgres -- --reporter=line
```

The command fails when required URLs are missing. CI also fails if the Vitest
report contains a skipped S4 test or does not report a passing test. This is a
database-boundary regression proof, not proof that every production path is
safe.

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
| `web/lib/providers/acp` | ACP catalog, readiness handshake, stdio transport, and AI SDK adapter |
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

Current task path without Workforce packages:

```text
POST /api/tasks
  -> insert task in PostgreSQL
  -> push { taskId } to Redis list forge:tasks
  -> worker claims the job
  -> task becomes running
  -> Architect model produces Markdown
  -> artifact is saved
  -> task becomes awaiting_approval
  -> operator approves or rejects the plan
  -> approval job marks the task completed
```

Current task path with Workforce materialization enabled:

```text
POST /api/tasks
  -> insert task in PostgreSQL and push { taskId } to forge:tasks
  -> worker runs Architect planning and saves the plan artifact
  -> Workforce planning records and the plan approval gate are materialized
  -> task becomes awaiting_approval
  -> operator approves the plan
  -> approval job releases ready work packages
  -> MCP/capability broker validates the next handoff before ready/claim
  -> execution reads bounded host context, writes generated output to
     `.forge/task-runs/<task-id>/<work-package-id>/attempt-<attempt-number>/`
     for review and manual application
  -> manual package QA/Reviewer/Security review gates complete when required
  -> task completes after all work packages and review gates are complete
```

Cancellation is enforced worker-side, not just at the API. The operator Stop
route cancels the task, its active work packages, pending gates, and running
runs inside one transaction; the worker complements this by refusing to write
results for a cancelled task. Workforce materialization takes a `FOR UPDATE`
lock on the task row and skips its inserts unless the task is still `running`,
and the Architect run is only marked `completed` while it is still `running`,
so a Stop that lands mid-plan cannot leave a cancelled task with fresh work
packages, an actionable approval gate, or a completed run. Post-execution
package writes are similarly guarded by the per-run execution lease.

Feature flag defaults:

| Variable | Default | Effect |
|---|---|---|
| `FORGE_WORKFORCE_MATERIALIZATION` | enabled | Set `0` or `false` to skip durable work-package/gate records. |
| `FORGE_WORK_PACKAGE_HANDOFF` | enabled | Set `0` or `false` to stop package handoff claims. |
| `FORGE_WORK_PACKAGE_EXECUTION` | disabled | Set `1` to explicitly enable specialist package execution; otherwise create handoff artifacts only. |
| `FORGE_HOST_REPOSITORY_WRITES` | unavailable | Leave unset, or set `0`, `false`, `off`, `no`, or `disabled`, for successful sandbox-only execution. Enable values fail closed after preserving sandbox output. The legacy `FORGE_REPOSITORY_EDITS` alias follows the same rule. |
| `FORGE_ACP_WORK_PACKAGE_EXECUTION` | disabled | Set `1` only when a real external confinement boundary protects the local ACP adapter process. |
| `FORGE_RUNNING_WORK_PACKAGE_STALE_SECONDS` | `900` | Recovery window before a retry marks an interrupted running work package blocked and starts the next eligible attempt. |

### Executable Workforce Beta

`FORGE_WORK_PACKAGE_EXECUTION=0` (the default) changes only the final package execution step:
approval records reviewable handoff artifacts but does not call a specialist
package model. With host-write configuration unset or explicitly disabled,
package models run successfully and keep generated files under
`.forge/task-runs` for review and manual application. An enable value such as
`1` explicitly enables package execution; it never authorizes a host write.

When execution is enabled:

1. Forge claims at most one eligible non-review specialist package at a time
   after plan approval and broker admission.
2. The project local path is validated before execution.
3. The specialist may receive bounded read-only host context: package summary,
   acceptance criteria, previous artifacts, rework reasons, prompt overlays,
   MCP-aware subtasks, repository evidence, and a bounded file/context packet.
4. The model must return one `work_package_execution_json` block with relative
   file paths and optional validation commands.
5. Forge creates a fresh package sandbox at
   `<validated-project-root>/.forge/task-runs/<task-id>/<work-package-id>/attempt-<attempt-number>/`.
6. Generated files are written only inside that sandbox. Forge rejects absolute
   paths, `..`, `.git`, `node_modules`, symlinks, and local conflict-copy names.
7. Package validation requests are limited to `npm test`, `npm run build`, and
   `npm run lint`. In the beta, Forge performs static validation of the
   generated sandbox output for those command labels, including script safety,
   placeholder checks, and JavaScript syntax checks; it does not run arbitrary
   package scripts.
8. Direct host repository application is unavailable. If an operator requests
   it with an enable value, Forge preserves the sandbox output and returns a
   fail-closed unavailable result. A hardened repository-write adapter is
   required before this boundary can change.
9. Package artifacts record the generated file list, sandbox path, command
   results, model/provider snapshot, and review source artifact.

Operators and reviewers can inspect:

- work-package status, assigned role, dependencies, acceptance criteria, and
  blocked reason;
- proposed MCP/tool grants, broker decisions, operator-approved grant snapshots,
  and effective run-scoped instructions;
- prompt overlays and MCP-aware subtasks for the package run;
- sandbox file lists and static validation results;
- repository evidence and command audits;
- QA, Reviewer, and Security gates tied to the source run and source artifact;
- rework reasons and stale-gate replacement metadata;
- structured security findings for high-risk packages.

Important non-goals for the beta:

- no live MCP grants, credentials, or runtime tool handles are issued to
  specialists;
- no branches, commits, check polling, PRs, merges, or issue auto-closure are
  created;
- no parallel specialist execution runs;
- no user-edited grant scopes are supported;
- no autonomous QA, Reviewer, or Security agent-run gates are required;
- no harness-enforced tool policy, reference-path policy, output schema, or
  validation policy is active.

`agent_harnesses` remain planning and routing metadata for this beta. A harness
can describe intended prompts, references, tool policy, output schema, and
validation checks, but those fields do not grant tools or enforce execution
policy until a later slice wires them in.

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

## ACP Provider Path

ACP is the Agent Client Protocol. Forge uses it to call local coding agents
through adapter processes instead of direct cloud API calls.

Current ACP flow:

```text
getModel(providerConfigId, { cwd })
  -> AcpLanguageModel
  -> AcpSessionClient.start(agentId, cwd)
  -> pinned local ACP adapter binary
  -> initialize
  -> session/new with caller-provided cwd
  -> optional session/set_config_option for model selection
  -> session/prompt
  -> streamed agent_message_chunk text
```

Important implementation constraints:

- `web/lib/providers/acp/transport.ts` owns the line-delimited JSON-RPC stdio
  framing and starts adapter subprocesses with a deny-by-default environment
  allowlist. Session callers choose the adapter process cwd; executable package
  calls pass the package attempt sandbox, and Architect planning uses an
  isolated runtime directory instead of the host repository root.
- `web/lib/providers/acp/handshake.ts` owns readiness checks and actionable
  health states.
- `web/lib/providers/acp/client.ts` owns one prompt turn and closes the adapter
  process afterward.
- `web/lib/providers/acp/language-model.ts` adapts ACP text output into the
  Vercel AI SDK `LanguageModelV3` interface.
- ACP does not currently provide Forge with token usage, structured tool calls,
  or runtime MCP grants.
- ACP model selection is passed only when the runtime exposes a compatible
  session config option.

## Workforce Architecture

Forge now separates editable app configuration from task-scoped execution
records:

1. Agents are editable records in `agent_configs`. The seeded Codex roles are
   defaults, not a closed enum.
2. Workforces are editable templates in `workforces`, with ordered memberships
   in `workforce_agents`.
3. Work packages remain task-scoped execution records produced from Architect
   plans.
4. Specialist harnesses in `agent_harnesses` describe planning and routing
   intent for this beta; they are not execution-policy objects yet.

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

ADR 0005 records the first Workforce persistence slice. ADR 0006 records the
executable Workforce beta boundary. The current app extends that direction by
making agent and workforce configuration editable before execution routing
consumes those templates.

## Agent Prompts

Agents are runtime-neutral Forge roles (see `AGENTS.md` and
`docs/adr/0007-forge-agent-workforce-model.md`); Claude Code and Codex are
runtimes, not separate catalogues. The seed defaults currently ship as
`.codex/agents/*.toml` versioned files, which double as an optional manual Codex
helper surface; a later #124 phase moves the product source of truth to a
runtime-neutral catalogue.

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
manager prompt. Seeded default workforces start with the Architect agent labeled
as the **Workforce supervisor**. That label makes workflow ownership explicit
without adding a new broad agent role. In normal keep mode, the seed script
backfills memberships only for default workforces that have no members; overwrite
mode resets those teams to the shipped defaults. For this slice, the exports are
mirrors; import/edit conflict handling is intentionally out of scope.

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
npm run lint
git diff --check
npx tsc --noEmit --pretty false
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
