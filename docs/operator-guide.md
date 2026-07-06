# Forge Operator Guide

This guide is for running Forge on a local machine or a small deployment. It
keeps the practical commands in one place so the README can stay short.

## Plain-English Summary

Forge has four moving pieces:

- The web dashboard you open in a browser.
- PostgreSQL, where Forge stores users, providers, projects, tasks, and results.
- Redis, where Forge queues background work.
- The worker, which picks up queued tasks and calls AI models.

For normal local use, `forge` starts both the dashboard and the worker. For
split deployments, the worker can still run separately.

The most important beta boundary: Forge may write plans, approval records,
work-package records, handoff/review-gate state, and local repository file
edits, but not repository commits. Workforce materialization, handoff,
specialist package execution, and local repository writes are enabled unless
explicitly disabled. Forge may give a specialist bounded read-only
host-repository context. Generated files are written into a package sandbox at
`.forge/task-runs/<task-id>/<work-package-id>/attempt-<attempt-number>/` and,
after the package execution step, repository-affecting files are applied to the local project.
Branches, commits, pull requests, merges, live specialist MCP grants,
autonomous reviewer agents, and parallel specialists are still future work.

## Install

From the repository root:

```bash
bash scripts/install.sh
```

On macOS the installer uses Homebrew. On Linux it uses the detected package
manager: `apt`, `dnf`, `yum`, `zypper`, or `pacman`.

The installer can prepare:

- Node.js 22 or newer.
- PostgreSQL 16 or newer.
- Redis 7 or newer.
- GitHub CLI.
- Optional Ollama local model support.
- `~/Documents/Forge/config/forge.env` with generated local secrets.
- `web/node_modules`.
- Database migrations, workspace agent prompts, and workspace workforce exports.

Readiness and update commands:

```bash
bash scripts/install.sh --check
forge upgrade
FORGE_SKIP_OLLAMA=1 bash scripts/install.sh
```

If an install is interrupted, run `bash scripts/install.sh` again. The installer
preserves existing settings and resumes idempotent steps. Logs are written under
`~/Documents/Forge/runtime/install/`.

Repository files are source and defaults. Editable/runtime files are stored under
the active Forge workspace, which defaults to `~/Documents/Forge`:

```text
config/forge.env
prompts/agents/*.toml
workforces/<slug>/{workforce.json,workflow.json,manager-prompt.md}
projects/
mcps/
runtime/
logs/
backups/
```

## Start And Stop

Normal local startup:

```bash
forge
```

Open `http://localhost:3000`.

Split runtime:

```bash
cd web
FORGE_EMBED_WORKER=0 npm run dev
```

In another terminal:

```bash
cd web
npm run worker
```

Use split runtime only when you intentionally want the web app and worker as
separate processes. Running `npm run worker` alone does not serve the dashboard.

## First Login And Providers

The first account creates a password and, by default, a passkey. For password
only, set this before creating the first account:

```bash
FORGE_PASSKEYS_ENABLED=0
```

Forge is single-user by default. If an uninstall kept settings and credentials,
the existing account remains in Postgres and registration stays closed after
reinstall. Reset that account from the host shell:

```bash
forge reset-credentials
```

The reset command also clears password sign-in throttle keys left in Redis, so
you do not need to wait for the retry window after repeated failed attempts.

Provider keys are needed only for the providers you configure. Forge stores
provider API keys encrypted in the database when entered through the UI. Fixed
cloud providers can also use the allowlisted environment variables below.
Custom, LiteLLM, and local endpoints do not read arbitrary Forge server
environment variables as API keys; enter any required key in the UI or configure
it inside the gateway.

Common provider variables:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `LITELLM_BASE_URL` | LiteLLM gateway |
| `LITELLM_API_KEY` | Optional LiteLLM gateway key, for the gateway itself |

### ACP Providers

ACP providers connect Forge to local coding CLIs through the Agent Client
Protocol. In plain terms, Forge starts a small adapter process, sends it a
prompt, and reads the agent's streamed text response.

For the currently wired ACP adapters:

- Forge starts a pinned local adapter binary from `node_modules/.bin`.
- The adapter subprocess receives a deny-by-default environment allowlist; Forge
  provider keys, GitHub tokens, database URLs, Redis URLs, and encryption
  secrets are not forwarded.
- The adapter wraps the local `codex` or `claude` CLI.
- The local CLI must already be installed and logged in.
- The Forge project must have a local folder so Forge can validate and bound
  repository context. Architect planning uses an isolated runtime directory;
  executable work-package ACP sessions are disabled by default because local ACP
  adapters are not OS-confined by Forge. Set
  `FORGE_ACP_WORK_PACKAGE_EXECUTION=1` only for repositories where that local
  process access is acceptable.
- Installing the Zed editor is not required; Forge uses Agent Client Protocol
  adapter packages, not the editor itself.

See [ACP and the Zed connector](acp-zed-connector.md) for the full simple
explanation and troubleshooting checklist.

GitHub repository operations prefer the encrypted PAT from Settings, then the
authenticated `gh` CLI token. The legacy clone env-var fallback is limited to
`GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PAT`, or `FORGE_GITHUB_TOKEN`; arbitrary
server env vars are rejected.

## Test The Orchestrator

After install:

```bash
cd web
npm run doctor
```

Then create a project and task in the dashboard. A successful Orchestrator-stage
run moves through:

```text
Pending -> Running -> Awaiting Approval -> Completed
```

No-cost mock test:

```bash
cd web
FORGE_WORKER_MOCK_ARCHITECT=1 npm run dev
```

The task should reach `Awaiting Approval` with a plan that starts with
`Mock architect plan...`. That proves the dashboard, database, Redis, worker,
and approval flow are connected.

Provider reachability test:

```bash
cd web
npm run test:providers
npm run test:providers -- --provider "Provider Name"
```

## Executable Workforce Beta

Workforce materialization, handoff, package execution, and local repository
writes are default-on. To keep the older handoff-artifact-only behavior, set
one of the disable values (`0`, `false`, `off`, `no`, or `disabled`) in the
worker environment. If `FORGE_EMBED_WORKER` is enabled, that is the web process
because it hosts the worker loop; in split deployments, do not set it on the
web-only process.

```bash
FORGE_WORK_PACKAGE_EXECUTION=0
```

To run package models but keep generated files sandbox-only, use:

```bash
FORGE_HOST_REPOSITORY_WRITES=0
```

With the default execution path:

1. The operator approves the Architect plan.
2. Forge releases ready work packages and runs the MCP/capability broker.
3. Required blocked MCP/tool grants stop the package before execution. Optional
   grants can continue only when the approved fallback is non-blocking.
4. Forge executes one eligible specialist package at a time.
5. The specialist receives bounded read-only project context and run-scoped
   instructions. This is not a live MCP grant or an unbounded filesystem view.
6. Generated output is written under the project folder at
   `.forge/task-runs/<task-id>/<work-package-id>/attempt-<attempt-number>/`.
7. Repository-affecting files are applied to the local project unless
   `FORGE_HOST_REPOSITORY_WRITES=0` is set.
8. QA, Reviewer, and Security gates appear when required. In this beta, those
   are manual operator decisions, not proof that separate reviewer agents ran.

Operators can review:

- package status, assigned role, dependencies, acceptance criteria, and blocked
  reasons;
- proposed MCP/tool grants, broker decisions, operator-approved grant snapshots,
  and effective run-scoped instructions;
- prompt overlays and MCP-aware subtasks;
- sandbox file lists and static validation results;
- repository evidence and command audits;
- QA, Reviewer, and Security gates tied to the source run and source artifact;
- rework reasons, stale-gate replacement, and attempt history;
- structured security findings for high-risk packages.

Operators can intervene from the task detail page:

- Stop cancels a non-terminal task, marks active package/run state cancelled,
  and leaves package metadata available for diagnosis. Stopping is safe at any
  stage, including while the Architect is still planning: the worker will not
  publish plan results, materialize work packages, or complete its run for a
  task that was cancelled during the run.
- Delete removes one terminal task and its run history without deleting the
  project. Stop active tasks first.
- Retry task requeues the task from the beginning and can use the original or a
  different provider.
- Retry handoff retries a retryable blocked package after the operator fixes
  the broker, repository, or execution blocker.
- Agent history is the primary activity timeline; queue attempts are collapsed
  under it for lower-level retry evidence.

High-risk packages should not be accepted with only a checkbox. Security review
findings should name the review surface, asset, trust boundary, exploit path,
impact, required fix, evidence refs, severity, confidence, and verification
state.

What this beta does not do:

- no live MCP grants, credentials, or runtime tool handles for specialists;
- no branch creation, commits, check polling, pull requests, merges, issue
  closure, or release automation;
- no parallel specialists;
- no user-edited grant scopes;
- no autonomous QA, Reviewer, or Security agent-run gates;
- no harness-enforced execution policy for tools, reference paths, output
  schemas, or validation checks.

## Deployment Checklist

Set these for both the web process and worker:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `SESSION_SECRET` | Secret value used for local session material |
| `NEXT_PUBLIC_APP_URL` | Public browser URL for Forge |

Passkey deployments also need:

| Variable | Purpose |
|---|---|
| `FORGE_PASSKEYS_ENABLED` | Set `0` to disable passkeys |
| `FORGE_TRUST_PROXY` | Set `1` only behind a trusted proxy that controls forwarded IP headers |
| `WEBAUTHN_RP_ID` | Passkey domain, usually the hostname |
| `WEBAUTHN_RP_NAME` | Display name shown by passkey prompts |
| `WEBAUTHN_ORIGIN` | Public app origin, such as `https://forge.example.com` |

Worker and workspace options:

| Variable | Purpose |
|---|---|
| `FORGE_EMBED_WORKER` | Set `0` when running a separate worker |
| `FORGE_AGENT_WEB_SEARCH` | Set `0` to disable no-key web research context |
| `FORGE_AGENT_CONFIG_DIR` | Optional override for app-editable agent prompt files; must stay inside the workspace |
| `FORGE_PROMPT_UPGRADE_MODE` | `keep` or `overwrite` local workspace prompts during install/upgrade |
| `FORGE_WORKFORCE_MATERIALIZATION` | Set `0` or `false` to disable default Workforce record materialization |
| `FORGE_WORK_PACKAGE_HANDOFF` | Set `0` or `false` to disable default work-package handoff claims |
| `FORGE_WORK_PACKAGE_EXECUTION` | Set `0`, `false`, `off`, `no`, or `disabled` to disable default package execution and create handoff artifacts only |
| `FORGE_HOST_REPOSITORY_WRITES` | Set `0`, `false`, `off`, `no`, or `disabled` to keep generated files sandbox-only and skip local project edits |
| `FORGE_ACP_WORK_PACKAGE_EXECUTION` | Set `1`, `true`, `on`, `yes`, or `enabled` only when local ACP package execution is an accepted operator risk |
| `FORGE_RUNNING_WORK_PACKAGE_STALE_SECONDS` | Defaults to `900`; retry handoff treats older running package rows as interrupted and recovers them before continuing |
| `FORGE_WORKSPACE_ROOT` | Fixed workspace root override |
| `FORGE_MCPS_ROOT` | Fixed shared MCP root override |
| `FORGE_WORKER_MAX_ATTEMPTS` | Retry ceiling per task or approval job |
| `FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS` | Stale job recovery window |
| `FORGE_REQUIRE_GITHUB_CLI` | Set `1` for doctor to fail on missing `gh` auth |

Before release:

```bash
cd web
npm run db:migrate
npm run db:seed-agents
npm run doctor
npm run lint
git diff --check
npx tsc --noEmit --pretty false
npm test
npm run build
```

Full browser smoke:

```bash
cd web
npx playwright install chromium
npm run e2e
```

### Manual QA checklist: task detail layout and badge colors (#92)

Visual changes to `web/app/dashboard/tasks/[id]/page.tsx` aren't covered by
Vitest (no jsdom/render harness in this repo). Verify by hand after touching
that file:

1. `cd web && npm run dev`, open a task that has workforce packages, an
   approval gate, required-capabilities classification, and an MCP execution
   design (a task that's reached `awaiting_approval` or later usually has
   all four).
2. At desktop width (≥1024px): confirm the `Prompt` column (left) and
   `Workforce`/`Implementation Plan` column (right) are approximately equal
   width — neither should look cramped or dominate.
3. Confirm `Required Capabilities`, `Open Questions` (if any), and `MCP tool
   access` render in the left-hand column, stacked under `Prompt`, not in
   the right-hand `Workforce` column.
4. Check badge colors are consistent across the page for the same status
   word — e.g. every `completed` badge (task header, agent runs, work
   packages, approval gates, retry history) should be the same green, every
   `failed`/`rejected`/`cancelled` badge the same red, every
   `pending`/`awaiting_*` badge the same amber.
5. Resize to mobile width (<768px): confirm both columns stack vertically
   with no horizontal overflow or clipped content.

### Manual smoke test: workforce task accept → retry → navigate (#86)

The dev-server build-manifest race this guards against (`next dev` evicting
and recompiling inactive route chunks under a long-held SSE connection) is a
timing-dependent Next.js internal behavior, not something that reproduces
deterministically in Vitest. Verify by hand after touching
`web/app/api/tasks/[id]/runs/route.ts`, `web/hooks/useTaskStream.ts`, or
`web/app/dashboard/error.tsx`:

1. `cd web && npm run dev`, sign in, open a project task with workforce
   packages.
2. Accept the first workforce task and leave the task detail page open for
   at least 60 seconds (past the SSE connection's 55s recycle point) — watch
   the Network tab: the `/api/tasks/:id/runs` request should close and a new
   one open automatically, with no "Lost connection" banner shown in the UI.
3. Retry the task, then immediately navigate to `/dashboard/projects` and
   back.
4. Confirm the page loads normally. If it doesn't, and the error overlay
   reads "The dev server is still recompiling," click Retry — confirm it
   recovers without a full `npm run dev` restart.

If step 4's overlay never appears even when forcing the original failure
(deleting `web/.next/dev` mid-request), check that
`web/app/dashboard/error.tsx`'s `isDevManifestError` matcher still matches
the current Next.js ENOENT message shape — it changes across Next versions.

## Database Updates

After pulling new code:

```bash
cd web
npm run db:migrate
```

If you changed the schema, follow the developer workflow in
[developer-guide.md](developer-guide.md).

## Runtime Health

`GET /api/health` checks required environment variables, PostgreSQL, Redis,
GitHub CLI readiness, and provider reachability.

Status meanings:

- `ok`: ready.
- `degraded`: running, but something needs attention.
- `down`: PostgreSQL or Redis is unavailable.

## Uninstall

Preview first:

```bash
forge uninstall --dry-run
```

Remove Forge while keeping settings for a future reinstall:

```bash
forge uninstall --keep-data
```

Remove local Forge data:

```bash
forge uninstall --remove-data
```

Also remove recorded local project folders:

```bash
forge uninstall --remove-data --remove-projects
```

The uninstall script removes only packages recorded as Forge-installed. It does
not remove Homebrew, Linux package managers, Docker, or packages that existed
before Forge.

## Common Problems

If `npm run doctor` fails, check `~/Documents/Forge/config/forge.env`,
PostgreSQL, Redis, and GitHub CLI readiness.

If a task stays `Pending`, the worker is not running or cannot reach Redis.

If a task changes to `Failed`, read the task page error, check the terminal
running Forge, and confirm the Architect agent has a provider assigned.

If provider health says an environment variable is missing, add the real key to
`~/Documents/Forge/config/forge.env` and restart the web app and worker.

If `next dev` starts and then crashes with missing internal Next.js modules
such as `flight-data-helpers`, `use-merged-ref`, or
`app-next-turbopack.js`, stop Forge and run:

```bash
forge repair
```

Repair clears generated Next.js caches, verifies the pinned Next dependency,
reinstalls web dependencies if package files are missing, applies database
migrations when `DATABASE_URL` is available from the workspace env or local/dev
repo/web `.env` fallbacks, and runs the doctor. Production dotenv fallbacks are
not used by repair. It does not delete Forge data or project files.

If an ACP provider is not ready, confirm Node, the local adapter dependency,
the underlying CLI, CLI login, and the project's local folder. Then rerun the
provider health check.

If passkey registration fails, use `http://localhost:3000` locally and confirm
`WEBAUTHN_RP_ID=localhost` and `WEBAUTHN_ORIGIN=http://localhost:3000`.

## CLI Shape

Forge installs a thin global `forge` launcher for normal operator workflows.
The launcher delegates to the existing install, uninstall, web, and recovery
scripts instead of duplicating their logic.

Supported starter commands:

| Command | Purpose |
|---|---|
| `forge` | Start the local dashboard and embedded worker |
| `forge upgrade` | Sync dependencies, migrations, seeds, and checks |
| `forge repair` | Repair local caches, dependencies, migrations, and checks |
| `forge uninstall` | Remove Forge runtime pieces, passing flags through |
| `forge reset-credentials` | Prompt for a new local account password |
| `forge doctor` | Run runtime readiness checks |

See [`cli-command-architecture.md`](cli-command-architecture.md) for command
ownership, routing, and non-goals.
