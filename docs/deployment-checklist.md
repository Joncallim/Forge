# Forge Deployment Checklist

Use this checklist before running the helper-stage beta outside local
development.

## Required Services

- PostgreSQL 16 or newer is reachable from the web and worker processes.
- Redis 7 or newer is reachable from the web and worker processes.
- The web process and worker process use the same PostgreSQL and Redis
  instances.
- Database migrations have been applied from `web/db/migrations`.
- A long-running worker process is started separately from the Next.js web
  process.

## Required Environment

Set these for the web process, worker process, and CI smoke tests where
applicable:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. |
| `REDIS_URL` | Redis connection string. |
| `SESSION_SECRET` | 32-byte hex secret reserved for signed session material. |
| `WEBAUTHN_RP_ID` | Passkey relying-party ID, usually the hostname. |
| `WEBAUTHN_RP_NAME` | Passkey relying-party display name. |
| `WEBAUTHN_ORIGIN` | Public web origin, including scheme and port if needed. |
| `NEXT_PUBLIC_APP_URL` | Public app URL used by browser-facing code. |
| `FORGE_AGENT_CONFIG_DIR` | Absolute prompt-file path for standalone Next.js deployments. |

Set provider-specific keys only for the providers you configure:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API. |
| `OPENAI_API_KEY` | OpenAI API. |
| `OPENROUTER_API_KEY` | OpenRouter. |
| `LITELLM_BASE_URL` | LiteLLM gateway URL. |
| `LITELLM_API_KEY` | LiteLLM gateway auth if enabled. |

Worker-only:

| Variable | Purpose |
|---|---|
| `FORGE_WORKER_CLAIM_TIMEOUT_SECONDS` | Redis claim timeout. Defaults to 5 seconds. |
| `FORGE_WORKER_MOCK_ARCHITECT` | Test-only. Set to `1` only in smoke tests to bypass model calls. |

## Preflight Commands

From `web/`:

```bash
npm run doctor
npm run lint
npx tsc --noEmit
npm test
npm run build
```

For the full helper-stage smoke path, start PostgreSQL and Redis, apply
migrations, install Playwright browsers once, and run:

```bash
npm run db:migrate
npx playwright install chromium
npm run e2e
```

The E2E suite seeds its own user/session, applies the setup wizard preset,
creates a project and task, runs the worker with
`FORGE_WORKER_MOCK_ARCHITECT=1`, verifies the generated artifact, approves it,
and confirms the helper-stage task completes.

## Runtime Health

`GET /api/health` reports:

- required environment variable presence,
- PostgreSQL connectivity,
- Redis connectivity,
- active provider reachability.

Status meanings:

- `ok`: required env, PostgreSQL, Redis, and active providers are healthy.
- `degraded`: PostgreSQL and Redis are reachable but env or provider checks need
  attention.
- `down`: PostgreSQL or Redis is unavailable.

## Launch Verification

1. Open the app and register a passkey-backed operator account.
2. Confirm first dashboard visit opens the setup wizard if no providers exist.
3. Apply a preset and inspect provider health.
4. Create a project.
5. Create a task and confirm it moves from `pending` to `running` to
   `awaiting_approval`.
6. Review the architect artifact.
7. Approve the generated plan and confirm the task moves to `completed`.
