# Dedicated Worker Process

The worker is the part of Forge that does the background work.

The browser dashboard creates tasks. The worker picks them up, calls the chosen
AI model, saves the result, and updates the task status. Without the worker, a
task can be created but it will stay waiting.

Forge should not require a manually started Claude Code session for normal task
execution. Claude Code can remain useful for development, debugging, or emergency
manual operation, but the normal path is a dedicated worker process.

## Purpose

The worker is the background executor for Forge tasks. It consumes queued work,
coordinates agent runs, updates task state, emits run events, and integrates with
GitHub.

The web app remains the control plane. The worker remains the execution plane.

## Current State

The web app already enqueues tasks:

1. `POST /api/tasks` inserts a task row in PostgreSQL.
2. The API pushes `{ taskId }` to Redis list `forge:tasks`.
3. The task remains `pending` until a worker consumes it.

An initial Orchestrator-stage worker exists. It consumes queued tasks, runs the architect
planning stage through the configured provider, streams Markdown plan output,
stores the plan as an artifact, publishes live task events, and moves the task
to `awaiting_approval`. It also consumes approval jobs from `forge:approvals`
and marks approved Orchestrator-stage tasks `completed`.

Claude Code can still be used manually for development, debugging, or emergency
operation, but it is no longer the only path for a queued task to leave
`pending`.

## Target Runtime

For local single-user installs, the worker starts inside the Next.js server
unless `FORGE_EMBED_WORKER=0` is set. This makes `npm run dev` enough to run the
dashboard and Orchestrator loop together.

For split deployments, the same worker runtime can run as a long-lived Node.js
process separate from Next.js. The current implementation handles the architect
planning step; the target pipeline adds repository edits, specialist agents,
reviews, and GitHub automation:

```text
Redis forge:tasks
  -> worker claims task
  -> loads task, project, agent configs, provider configs
  -> marks task running
  -> creates agent_runs records
  -> dispatches model calls through provider registry
  -> writes artifacts and status updates
  -> opens or updates GitHub PR
  -> marks task awaiting_approval, completed, failed, or cancelled
```

Embedded local command:

```bash
cd web
npm run dev
```

Standalone host command:

```bash
cd web
npm run worker
```

Set `FORGE_EMBED_WORKER=0` for the web process when running a standalone worker
to avoid duplicate local consumers.

Container command:

```bash
docker compose --profile worker up worker
```

## Worker Responsibilities

Current responsibilities:

- Claim jobs from Redis without double-processing.
- Claim approval jobs from Redis.
- Update task status transitions in PostgreSQL.
- Load task, project, architect agent, and provider configuration from the
  database.
- Store the architect run in `agent_runs`.
- Stream and store the generated Markdown plan in `artifacts`.
- Detect broad software type and prompt the architect with a matching design
  persona and specialist-agent handoff catalog.
- Attach no-key web research context unless `FORGE_AGENT_WEB_SEARCH=0`.
- Publish live run events for the UI.
- Avoid storing provider secrets directly; resolve API keys from configured
  environment variable names.

Future responsibilities:

- Claim jobs from Redis without double-processing.
- Recover safely after process crashes.
- Dispatch architect, backend, frontend, QA, reviewer, and devops agents.
- Dispatch specialist subagents through explicit harnesses, such as web design,
  accessibility, API, database, auth/security, E2E QA, CI, and documentation.
- Create branches, commits, and pull requests through GitHub.
- Enforce cancellation and approval gates.

## Specialist Subagent Harnesses

Future orchestration should not rely only on broad fixed roles. The worker
should be able to run a specialist subagent through a named harness.

A harness defines how a subagent is run:

- prompt,
- allowed tools,
- required references,
- expected input packet,
- expected output artifact,
- validation checks,
- default provider/model preference.

For example, a web design specialist can receive product context, relevant
component files, design-system references, viewport expectations, and an
accessibility checklist. Its output should be a structured UI plan and QA
checklist, not an unstructured chat response.

The detailed rollout plan lives in
[`specialist-subagents-roadmap.md`](specialist-subagents-roadmap.md).

## Queue Design

The existing enqueue path uses Redis list `forge:tasks`. Approval uses
`forge:approvals`. The worker claims each list with `BRPOPLPUSH` into a
processing list:

```text
forge:tasks -> forge:tasks:processing
forge:approvals -> forge:approvals:processing
```

On success, remove the job from the processing list. On failure, record the
failure on the task and remove or retry based on retry policy.

The worker also uses retry sorted sets and dead-letter lists:

```text
forge:tasks:retry
forge:tasks:dead
forge:approvals:retry
forge:approvals:dead
```

Each claimed job records a claim timestamp so startup recovery can move stale
processing jobs back to the live queue after a crash.

A later version can move to Redis Streams for stronger delivery semantics,
consumer groups, and replayable job history. A list-based worker is sufficient
for the first implementation if task state in PostgreSQL remains authoritative.

## State Transitions

Initial transition set:

```text
pending -> running
running -> awaiting_approval
running -> completed
running -> failed
awaiting_approval -> approved
awaiting_approval -> rejected
approved -> completed
pending/running -> cancelled
```

The worker should check the current task status before every major step so a
cancelled task stops promptly.

## Concurrency

Start with one worker process and one active task at a time. Add concurrency only
after the single-task path is reliable.

Future concurrency should be explicit:

```text
FORGE_WORKER_CONCURRENCY=1
```

Per-task agent steps can be sequential at first. Parallel specialist agents can
come later once artifact merging and conflict handling are well-defined.

## Failure Handling

Minimum viable behavior:

- Mark task `failed` with `errorMessage` on unrecoverable errors.
- Store partial artifacts before failing where possible.
- Leave enough structured logs to diagnose the failed step.
- Do not retry GitHub write operations blindly if they may have succeeded.

Implemented hardening:

- Attempt counts are carried in the job payload.
- Each claim is recorded in `task_attempts`.
- Retryable task and approval failures move to retry sorted sets with
  exponential backoff.
- Permanently failed jobs move to dead-letter queues such as
  `forge:tasks:dead`.
- Worker startup recovers stale processing-list jobs after
  `FORGE_WORKER_STUCK_JOB_RECOVERY_SECONDS`.

## Implemented Orchestrator Scope

The current worker implementation is intentionally narrow:

- Claims jobs from `forge:tasks` into `forge:tasks:processing`.
- Claims approvals from `forge:approvals` into `forge:approvals:processing`.
- Recovers stale jobs left in processing queues after worker crashes.
- Retries failed task and approval jobs up to `FORGE_WORKER_MAX_ATTEMPTS`.
- Persists task attempt history in `task_attempts`.
- Loads the task, project, architect agent config, and provider config.
- Marks the task `running`.
- Creates an architect `agent_runs` row.
- Calls the configured provider through the AI SDK.
- Stores the generated plan as an `adr_text` artifact.
- Publishes `run:*`, `artifact:created`, and `task:status` events for the task
  detail page.
- Marks the task `awaiting_approval` on success or `failed` on unrecoverable
  error.
- Marks approved Orchestrator-stage tasks `completed`.

It does not yet execute repository edits, specialist implementation agents, test
runs, branch creation, commits, or PR creation.

## Implementation Outline

Implemented files:

```text
web/worker/index.ts
web/worker/queue.ts
web/worker/orchestrator.ts
web/worker/task-state.ts
web/worker/events.ts
web/worker/task-attempts.ts
```

Suggested package scripts:

```json
{
  "worker": "tsx worker/index.ts",
  "worker:dev": "tsx watch worker/index.ts"
}
```

The first worker implementation focuses on reliable task claiming, status
updates, event publishing, and a minimal architect orchestrator. Full multi-agent
coding automation can be layered on after the queue and lifecycle behavior is
proven.

## Environment Loading

When run from `web/`, the worker loads both the repository-root `.env` and
`web/.env*` files before importing database, Redis, or provider modules. This
keeps the host workflow aligned with the root `.env.example`.

Docker Compose injects container-local `DATABASE_URL` and `REDIS_URL` values so
services use `postgres` and `redis` hostnames instead of `localhost`.

## Relationship To Claude Code

Claude Code is optional. It can help build, inspect, or manually operate Forge,
but it should not be required for the web interface to execute tasks once the
worker exists.

Target production model:

```text
Next.js web app + PostgreSQL + Redis + Forge worker
```

Not:

```text
Next.js web app + manually supervised Claude Code session
```
