# Deployment Checklist

Use this before running Forge anywhere beyond a quick local test.

## Services

Forge needs these running:

- PostgreSQL 16 or newer.
- Redis 7 or newer.
- The Next.js web process.
- The Forge worker process.

The web process and worker must point at the same PostgreSQL and Redis
instances.

## Required Environment Variables

Set these for both the web process and worker:

| Variable | Plain-English purpose |
|---|---|
| `DATABASE_URL` | Where PostgreSQL is running. |
| `REDIS_URL` | Where Redis is running. |
| `SESSION_SECRET` | Secret value used for local session/security material. |
| `WEBAUTHN_RP_ID` | Passkey domain, usually the hostname. |
| `WEBAUTHN_RP_NAME` | Display name shown by passkey prompts. |
| `WEBAUTHN_ORIGIN` | Public app origin, such as `https://forge.example.com`. |
| `NEXT_PUBLIC_APP_URL` | Public browser URL for the Forge web app. |

Optional for standalone deployments:

| Variable | Purpose |
|---|---|
| `FORGE_AGENT_CONFIG_DIR` | Absolute path where agent prompt files can be read and written. |

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
| `FORGE_WORKER_MOCK_ARCHITECT` | Test-only mock mode. Do not enable for real runs. |

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

For the full browser smoke test:

```bash
npx playwright install chromium
npm run e2e
```

The E2E test uses a mock helper model. It proves the web app, database, Redis,
worker, setup wizard, task flow, and approval flow are connected.

## Runtime Health

`GET /api/health` checks:

- required environment variables,
- PostgreSQL connectivity,
- Redis connectivity,
- active provider reachability.

Status meanings:

- `ok`: ready.
- `degraded`: running, but something needs attention.
- `down`: PostgreSQL or Redis is unavailable.

## Manual Launch Check

1. Open the app.
2. Create the first account with a password and passkey.
3. Sign out and confirm password login works.
4. Confirm passkey login works on the same browser/device.
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
