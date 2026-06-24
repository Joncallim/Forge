# Forge Operator Guide

This guide is for running Forge on a local machine or a small deployment. It
keeps the practical commands in one place so the README can stay short.

## Plain-English Summary

Forge has four moving pieces:

- The web dashboard you open in a browser.
- PostgreSQL, where Forge stores users, providers, projects, tasks, and results.
- Redis, where Forge queues background work.
- The worker, which picks up queued tasks and calls AI models.

For normal local use, `npm run dev` starts both the dashboard and the worker.
For split deployments, the worker can run separately.

## Install

From the repository root:

```bash
bash scripts/install.sh
```

On macOS the installer uses Homebrew. On Linux it uses the detected package
manager: `apt`, `dnf`, `yum`, `zypper`, or `pacman`.

The installer can prepare:

- Node.js.
- PostgreSQL 16 or newer.
- Redis 7 or newer.
- GitHub CLI.
- Optional Ollama local model support.
- `.env` with generated local secrets.
- `web/node_modules`.
- Database migrations and default agent prompts.

Readiness and update commands:

```bash
bash scripts/install.sh --check
bash scripts/install.sh --upgrade
FORGE_SKIP_OLLAMA=1 bash scripts/install.sh
```

If an install is interrupted, run `bash scripts/install.sh` again. The installer
preserves existing settings and resumes idempotent steps. Logs are written to
`.forge/install.log`.

## Start And Stop

Normal local startup:

```bash
cd web
npm run dev
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

Provider keys are needed only for the providers you configure. Forge stores
provider API keys encrypted in the database when entered through the UI. If you
use an environment variable, Forge stores the variable name, not the secret.

Common provider variables:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `LITELLM_BASE_URL` | LiteLLM gateway |
| `LITELLM_API_KEY` | LiteLLM gateway key |

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
| `WEBAUTHN_RP_ID` | Passkey domain, usually the hostname |
| `WEBAUTHN_RP_NAME` | Display name shown by passkey prompts |
| `WEBAUTHN_ORIGIN` | Public app origin, such as `https://forge.example.com` |

Worker and workspace options:

| Variable | Purpose |
|---|---|
| `FORGE_EMBED_WORKER` | Set `0` when running a separate worker |
| `FORGE_AGENT_WEB_SEARCH` | Set `0` to disable no-key web research context |
| `FORGE_AGENT_CONFIG_DIR` | Directory for app-editable agent prompt files |
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
npx tsc --noEmit
npm test
npm run build
```

Full browser smoke:

```bash
cd web
npx playwright install chromium
npm run e2e
```

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
bash scripts/uninstall.sh --dry-run
```

Remove Forge while keeping settings for a future reinstall:

```bash
bash scripts/uninstall.sh --keep-data
```

Remove local Forge data:

```bash
bash scripts/uninstall.sh --remove-data
```

Also remove recorded local project folders:

```bash
bash scripts/uninstall.sh --remove-data --remove-projects
```

The uninstall script removes only packages recorded as Forge-installed. It does
not remove Homebrew, Linux package managers, Docker, or packages that existed
before Forge.

## Common Problems

If `npm run doctor` fails, check `.env`, PostgreSQL, Redis, and GitHub CLI
readiness.

If a task stays `Pending`, the worker is not running or cannot reach Redis.

If a task changes to `Failed`, read the task page error, check the terminal
running Forge, and confirm the Architect agent has a provider assigned.

If provider health says an environment variable is missing, add the real key to
`.env` and restart the web app and worker.

If passkey registration fails, use `http://localhost:3000` locally and confirm
`WEBAUTHN_RP_ID=localhost` and `WEBAUTHN_ORIGIN=http://localhost:3000`.

## Future CLI Shape

Forge does not have a global `forge` launcher yet. Current supported commands
remain the install scripts and `web/package.json` scripts.

Reserved future command areas:

| Area | Example commands |
|---|---|
| Start and open | `forge`, `forge dev`, `forge open` |
| Readiness and repair | `forge doctor`, `forge logs`, `forge reset` |
| Install lifecycle | `forge install`, `forge update`, `forge uninstall` |
| Runtime control | `forge worker`, `forge status` |
| Information | `forge version`, `forge help` |
