# Forge Helper Model Installation and Test Guide

This guide gets Forge running on your computer and shows how to test the helper
model. In the current Forge build, the "helper model" is the Architect helper:
it reads a task, writes an implementation plan, and waits for your approval.

The helper does not edit code yet. A successful test means Forge can call your
chosen model, save the plan, and move the task to `Awaiting Approval`.

## What You Need

- Docker Desktop, or Docker Engine with Docker Compose.
- Node.js 22 or newer.
- npm.
- A browser that supports passkeys, such as Chrome, Edge, or Safari.
- An API key for the model endpoint you want to test.

For a real helper-model test, your model endpoint must be reachable from your
computer. If you use the new `Custom` option, the endpoint must speak the
OpenAI-compatible API shape.

## 1. Create The Environment File

From the Forge repository root:

```bash
cp .env.example .env
```

Open `.env` in a text editor.

Set these basics:

```bash
POSTGRES_USER=forge
POSTGRES_PASSWORD=change_me
POSTGRES_DB=forge
DATABASE_URL=postgresql://forge:change_me@localhost:5432/forge
REDIS_URL=redis://localhost:6379/0
NEXT_PUBLIC_APP_URL=http://localhost:3000
WEBAUTHN_RP_ID=localhost
WEBAUTHN_RP_NAME=Forge
WEBAUTHN_ORIGIN=http://localhost:3000
```

Generate a real session secret:

```bash
openssl rand -hex 32
```

Copy the output into `.env`:

```bash
SESSION_SECRET=paste_the_generated_value_here
```

For a custom helper model, add any API-key environment variable name you like.
This example uses `CUSTOM_MODEL_API_KEY`:

```bash
CUSTOM_MODEL_API_KEY=sk-your-real-key
```

If you are using the built-in OpenAI provider instead of `Custom`, set:

```bash
OPENAI_API_KEY=sk-your-real-key
```

If you are using Anthropic or OpenRouter, set the matching key instead:

```bash
ANTHROPIC_API_KEY=sk-ant-your-real-key
OPENROUTER_API_KEY=sk-or-your-real-key
```

## 2. Start The Database And Redis

From the Forge repository root:

```bash
bash scripts/setup.sh
```

This starts PostgreSQL and Redis in Docker.

If this is your first time running the script and it only creates `.env`, edit
`.env` as described above, then run the script again.

## 3. Install The Web App And Prepare The Database

In a terminal:

```bash
cd web
npm install
npm run db:migrate
npm run db:seed-agents
npm run doctor
```

`npm run doctor` should print `ok` for the required environment variables,
PostgreSQL, and Redis.

`npm run db:seed-agents` loads the starter Architect, Backend, Frontend, QA,
Reviewer, and DevOps prompts from `.claude/agents`.

## 4. Start Forge

Open two terminals.

Terminal 1 starts the web app:

```bash
cd web
npm run dev
```

Terminal 2 starts the worker:

```bash
cd web
npm run worker
```

Leave both terminals open.

Open Forge in your browser:

```text
http://localhost:3000
```

## 5. Sign In

The first time you open Forge, register a passkey.

Use the same browser and computer for later sign-ins. Passkeys are local to your
browser/device setup.

## 6. Add A Custom Helper Model

Go to:

```text
Dashboard -> Agents
```

If Forge opens the Setup page first, use the left sidebar and click `Agents`.

Find the `Architect` row and click the pencil/edit button.

In the Provider dropdown, choose:

```text
Custom
```

Fill in the custom provider form.

Example for an OpenAI-compatible endpoint:

```text
Display name: GPT-5.5 Helper
Provider type: Custom
Model ID: gpt-5.5
Base URL: https://api.openai.com/v1
API key environment variable: CUSTOM_MODEL_API_KEY
Local provider: unchecked
```

Important notes:

- `Model ID` can be any model name your endpoint accepts.
- `Base URL` should include `/v1` when your endpoint expects it.
- `API key environment variable` is the variable name from `.env`, not the key
  itself.
- For a local or no-key endpoint, check `Local provider`.

Click `Save`.

You can also create the same provider from:

```text
Dashboard -> Providers -> Add Provider
```

Then assign it to the `Architect` agent on the `Agents` page.

## 7. Create A Test Project And Task

Go to:

```text
Dashboard -> Projects
```

Create a project with simple values:

```text
Name: Helper Model Test
GitHub Repo: owner/helper-model-test
Default Branch: main
```

Open the project, then create a task:

```text
Title: Test helper model
Prompt: Write a short implementation plan for adding a hello-world endpoint.
```

After you create the task, keep the task page open.

## 8. Confirm The Helper Model Ran

A successful real model test looks like this:

1. The task changes from `Pending` to `Running`.
2. The worker terminal logs that it is processing the task.
3. The task changes to `Awaiting Approval`.
4. The page shows an Architect run and a generated plan.
5. The plan text is model-written, not `Mock architect plan...`.

When you are satisfied, click:

```text
Approve generated plan
```

The worker should then move the task to:

```text
Completed
```

## 9. Optional: Run A No-Cost Mock Test First

If you only want to check Forge plumbing before spending model tokens, stop the
worker and restart it like this:

```bash
cd web
FORGE_WORKER_MOCK_ARCHITECT=1 npm run worker
```

Then create a task as described above.

The task should reach `Awaiting Approval`, but the artifact will say:

```text
Mock architect plan...
```

That confirms the database, Redis queue, web UI, and worker are connected. It
does not test your real helper model.

## 10. Automated Smoke Test

The automated smoke test uses the mock helper, not your real model.

Use it to confirm Forge's basic helper-stage workflow:

```bash
cd web
npx playwright install chromium
npm run e2e
```

The test creates its own temporary user/session, applies a preset, creates a
project and task, runs the mock helper, approves the plan, and confirms the task
completes.

## Troubleshooting

If `npm run doctor` fails:

- Check that `.env` exists in the Forge repository root.
- Check that `DATABASE_URL` and `REDIS_URL` use `localhost`.
- Check that Docker is running.
- Run `docker compose ps` and confirm `postgres` and `redis` are healthy.

If the task stays `Pending`:

- The worker is not running, or it cannot reach Redis.
- Start it with `cd web && npm run worker`.
- Check the worker terminal for errors.

If the task changes to `Failed`:

- Open the task page and read the error message.
- Check the worker terminal.
- Confirm the Architect agent has a provider assigned.
- Confirm the provider has the right model ID.
- Confirm the API key environment variable name matches `.env`.
- Confirm the custom base URL is correct and includes `/v1` if required.

If provider health says the environment variable is missing:

- The provider stores only the variable name, such as `CUSTOM_MODEL_API_KEY`.
- The actual key must be in `.env`.
- Restart both `npm run dev` and `npm run worker` after editing `.env`.

If passkey registration fails:

- Use `http://localhost:3000`, not an IP address.
- Confirm `WEBAUTHN_RP_ID=localhost`.
- Confirm `WEBAUTHN_ORIGIN=http://localhost:3000`.

## Quick Success Checklist

- PostgreSQL and Redis are running.
- `npm run db:migrate` has completed.
- `npm run doctor` passes.
- The web app is running.
- The worker is running without `FORGE_WORKER_MOCK_ARCHITECT=1` for a real model
  test.
- The Architect agent is assigned to your chosen provider.
- A new task reaches `Awaiting Approval` and shows a non-mock plan.
