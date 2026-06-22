# Orchestrator Model Install And Test Guide

This guide shows how to prove Forge can call an AI Orchestrator model.

In the current beta, the Orchestrator model is the Architect. It reads your task,
writes an implementation plan, and waits for you to approve it. It does not edit
code yet.

## Easiest Path On macOS Or Linux

From the repository root:

```bash
bash scripts/install.sh
```

This installs local services, prepares the database, installs web dependencies,
and can set up a local Ollama model for zero-API-key testing.

Then start Forge:

```bash
cd web
npm run dev
```

Open `http://localhost:3000`.

## Verify Readiness

After installing, confirm the core services are healthy:

```bash
cd web
npm run doctor
```

`npm run doctor` should report that required environment variables, PostgreSQL,
Redis, and GitHub CLI readiness are healthy or clearly warned.

## Sign In

Open:

```text
http://localhost:3000
```

The first account creates a password and, by default, a passkey. To use password
only, set `FORGE_PASSKEYS_ENABLED=0` in `.env` before creating the first
account.

Use `http://localhost:3000` for local passkeys. Do not use an IP address unless
you also change the WebAuthn settings.

## Configure An Orchestrator Model

If the installer set up local Ollama, Forge already has a local provider.
You can skip to the test task.

To use a custom model, put the real API key in `.env`, for example:

```bash
CUSTOM_MODEL_API_KEY=sk-your-real-key
```

Restart `npm run dev` after changing `.env`. If you run a standalone worker,
restart that too.

In Forge:

```text
Dashboard -> Providers -> Add Provider
```

Example for an OpenAI-compatible endpoint:

```text
Display name: GPT Orchestrator
Provider type: Custom
Model ID: gpt-example
Base URL: https://api.example.com/v1
API key environment variable: CUSTOM_MODEL_API_KEY
Local provider: unchecked
```

Important details:

- `Model ID` must be a model your endpoint accepts.
- `Base URL` often needs `/v1` at the end.
- `API key environment variable` is the variable name, not the secret value.
- For a local no-key endpoint, mark it as local.

Then assign that provider to the Architect agent:

```text
Dashboard -> Agents -> Architect -> edit
```

## Create A Test Project And Task

Go to:

```text
Dashboard -> Projects
```

Create a project:

```text
Name: Orchestrator Model Test
GitHub Repo: owner/orchestrator-model-test
Default Branch: main
```

Open the project and create a task:

```text
Title: Test Orchestrator model
Prompt: Write a short implementation plan for adding a hello-world endpoint.
```

Keep the task page open.

## What Success Looks Like

A successful run looks like this:

1. The task changes from `Pending` to `Running`.
2. The terminal running `npm run dev` logs worker activity.
3. The task changes to `Awaiting Approval`.
4. The page shows an Architect run and a generated plan.
5. The plan is not `Mock architect plan...`.

When the plan looks reasonable, click:

```text
Approve generated plan
```

The task should move to:

```text
Completed
```

## No-Cost Mock Test

To test Forge's plumbing without calling a real model, stop Forge and restart it
like this:

```bash
cd web
FORGE_WORKER_MOCK_ARCHITECT=1 npm run dev
```

Then create a task. It should reach `Awaiting Approval`, but the plan will say:

```text
Mock architect plan...
```

That confirms the web app, database, Redis queue, and worker are connected.

## Automated Smoke Test

The automated smoke test uses the mock Orchestrator:

```bash
cd web
npx playwright install chromium
npm run e2e
```

It creates a temporary session, applies a setup preset, creates a project and
task, runs the mock Orchestrator, approves the plan, and confirms the task completes.

## Automated Provider Test Command

To check every active provider's reachability from the command line without
opening the dashboard:

```bash
cd web
npm run test:providers
```

To check a single provider by its display name or id:

```bash
cd web
npm run test:providers -- --provider "GPT Orchestrator"
```

This reuses the same 1-output-token, 3-second-timeout probe as the Providers
page health check, so it costs effectively $0 to run. Pass `--provider
<id-or-displayName>` to filter to a single provider. The command exits
non-zero if any checked provider fails, so it is suitable for wiring into CI.

## Troubleshooting

If `npm run doctor` fails:

- Check that `.env` exists in the repository root.
- Check that PostgreSQL and Redis are running.

If the task stays `Pending`:

- The worker is not running, or it cannot reach Redis.
- Start Forge with `cd web && npm run dev`.

If the task changes to `Failed`:

- Read the error on the task page.
- Check the terminal running Forge.
- Confirm the Architect agent has a provider assigned.
- Confirm the provider has the right model ID, base URL, and API-key variable
  name.

If provider health says an environment variable is missing:

- The provider stores only the variable name.
- The real key must be in `.env`.
- Restart Forge after editing `.env`.

If passkey registration fails:

- Use `http://localhost:3000`.
- Confirm `WEBAUTHN_RP_ID=localhost`.
- Confirm `WEBAUTHN_ORIGIN=http://localhost:3000`.

## Quick Checklist

- PostgreSQL and Redis are running.
- `npm run db:migrate` has completed.
- `npm run doctor` passes.
- The web app is running.
- The embedded or standalone worker is running.
- The Architect agent has a provider.
- A task reaches `Awaiting Approval`.
