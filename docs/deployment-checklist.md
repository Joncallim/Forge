# Deployment Checklist

Use this before running Forge anywhere beyond a quick local test.

## Services

Forge needs these running:

- PostgreSQL 16 or newer.
- Redis 7 or newer.
- GitHub CLI, for repository and pull request tooling.
- The Next.js web process.
- The Forge worker loop, embedded in the web process or run as a standalone
  worker process.

The web process and worker must point at the same PostgreSQL and Redis
instances.

## Required Environment Variables

Set these for both the web process and worker:

| Variable | Plain-English purpose |
|---|---|
| `DATABASE_URL` | Where PostgreSQL is running. |
| `REDIS_URL` | Where Redis is running. |
| `SESSION_SECRET` | Secret value used for local session/security material. |
| `NEXT_PUBLIC_APP_URL` | Public browser URL for the Forge web app. |

Optional for standalone deployments:

| Variable | Purpose |
|---|---|
| `FORGE_EMBED_WORKER` | Set to `0` when running a separate worker process. Defaults to embedded. |
| `FORGE_AGENT_WEB_SEARCH` | Set to `0` to disable no-key web research context for architect planning. Defaults to enabled. |
| `FORGE_AGENT_CONFIG_DIR` | Absolute path where agent prompt files can be read and written. |
| `FORGE_WORKSPACE_ROOT` | Optional hard override for the Forge workspace root. When unset, Forge defaults new local projects and runtime registry files to `~/Documents/Forge`, writes `global-settings.json` there, and creates `mcps`/`templates` subfolders for the workspace structure. |
| `FORGE_MCPS_ROOT` | Optional hard override for the shared MCP root. Must stay inside `FORGE_WORKSPACE_ROOT` or the active workspace root. When unset, Forge defaults to the active workspace's `mcps` directory, and users can change the root from Settings. |

MCP deployment notes:

- Forge-managed MCP installation currently scaffolds catalog manifests under the shared workspace `mcps` root and records install/status state in PostgreSQL.
- The first managed catalog entries are Filesystem and GitHub. Health checks verify the project path and GitHub connection state; Forge does not execute arbitrary MCP install commands.
- Project-specific MCP overrides must stay inside the active workspace root.

Passkey-related:

| Variable | Purpose |
|---|---|
| `FORGE_PASSKEYS_ENABLED` | Set to `0` to hide and disable passkey registration/sign-in. Defaults to `1`. |
| `WEBAUTHN_RP_ID` | Passkey domain, usually the hostname. Required when passkeys are enabled. |
| `WEBAUTHN_RP_NAME` | Display name shown by passkey prompts. Required when passkeys are enabled. |
| `WEBAUTHN_ORIGIN` | Public app origin, such as `https://forge.example.com`. Required when passkeys are enabled. |

Provider keys are needed only for the providers you configure:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic. |
| `OPENAI_API_KEY` | OpenAI. |
| `OPENROUTER_API_KEY` | OpenRouter. |
| `LITELLM_BASE_URL` | LiteLLM gateway URL. |
| `LITELLM_API_KEY` | LiteLLM gateway key, if enabled. |
| Any custom name, such as `CUSTOM_MODEL_API_KEY` | Custom OpenAI-compatible provider. |

Forge stores provider API keys encrypted in the database when entered through
the UI. If you use an environment variable instead, Forge stores the variable
name, not the secret value.

Worker-only:

| Variable | Purpose |
|---|---|
| `FORGE_WORKER_CLAIM_TIMEOUT_SECONDS` | Redis claim timeout. Defaults to 5 seconds. |
| `FORGE_WORKER_MAX_ATTEMPTS` | Number of times a task or approval job can retry before dead-lettering. Defaults to 3. |
| `FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS` | Age after which processing-list jobs are considered stale and recovered. Defaults to 900 seconds. |
| `FORGE_WORKER_MOCK_ARCHITECT` | Test-only mock mode. Do not enable for real runs. |
| `FORGE_REQUIRE_GITHUB_CLI` | Set to `1` when `npm run doctor` should fail if `gh` is missing or unauthenticated. Defaults to warning only. |

## Database

Apply migrations before starting a new version:

```bash
cd web
npm run db:migrate
npm run db:seed-agents
```

See [database-migrations.md](database-migrations.md) for the migration workflow.

## Preflight Checks

Run from `web/`:

```bash
npm run doctor
npm run lint
npm test
npm run build
```

Confirm GitHub CLI readiness:

```bash
gh --version
gh auth status
```

For the full browser smoke test:

```bash
npx playwright install chromium
npm run e2e
```

The E2E test uses a mock Orchestrator model. It proves the web app, database,
Redis, worker, setup wizard, task flow, and approval flow are connected.

## Runtime Health

`GET /api/health` checks:

- required environment variables,
- PostgreSQL connectivity,
- Redis connectivity,
- GitHub CLI availability and authentication,
- active provider reachability.

Status meanings:

- `ok`: ready.
- `degraded`: running, but something needs attention.
- `down`: PostgreSQL or Redis is unavailable.

## Manual Launch Check

1. Open the app.
2. Create the first account with a password and, if enabled, a passkey.
3. Sign out and confirm password login works.
4. If passkeys are enabled, confirm passkey login works on the same browser/device.
5. If no providers exist, confirm the setup wizard opens.
6. Apply a preset or add a provider manually.
7. Confirm provider health.
8. Create a project.
9. Create a task.
10. Confirm it moves from `pending` to `running` to `awaiting_approval`.
11. Review the Architect artifact.
12. Approve the plan.
13. Confirm the task moves to `completed`.

## Rollback Notes

Before replacing a running deployment, back up PostgreSQL. Forge settings,
encrypted provider credentials, users, sessions, tasks, and artifacts are stored
there.
