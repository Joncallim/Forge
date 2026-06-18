# Dedicated Worker Process

Forge should not require a manually started Claude Code session for normal task
execution. Claude Code can remain useful for development, debugging, or emergency
manual operation, but the production path should be a dedicated worker process.

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

An initial worker helper now exists. It consumes queued tasks, runs the architect
planning stage through the configured provider, stores the plan as an artifact,
publishes live task events, and moves the task to `awaiting_approval`. It also
consumes approval jobs from `forge:approvals` and marks approved helper-stage
tasks `completed`.

Claude Code can still be used manually for development, debugging, or emergency
operation, but it is no longer the only path for a queued task to leave
`pending`.

## Target Runtime

The worker runs as a long-lived Node.js process separate from Next.js. The
current implementation handles the architect planning step; the target pipeline
adds repository edits, specialist agents, reviews, and GitHub automation:

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

Host command:

```bash
cd web
npm run worker
```

This starts the long-running helper process. Run it separately from
`npm run dev`.

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
- Store the generated plan in `artifacts`.
- Publish live run events for the UI.
- Avoid storing provider secrets directly; resolve API keys from configured
  environment variable names.

Future responsibilities:

- Claim jobs from Redis without double-processing.
- Recover safely after process crashes.
- Dispatch architect, backend, frontend, QA, reviewer, and devops agents.
- Create branches, commits, and pull requests through GitHub.
- Enforce cancellation and approval gates.

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

Recommended next step:

- Add a retry count to the job payload or a task attempt table.
- Use exponential backoff for transient provider and network failures.
- Move permanently failed jobs to a dead-letter queue such as
  `forge:tasks:dead`.

## Implemented Helper Scope

The current worker implementation is intentionally narrow:

- Claims jobs from `forge:tasks` into `forge:tasks:processing`.
- Claims approvals from `forge:approvals` into `forge:approvals:processing`.
- Loads the task, project, architect agent config, and provider config.
- Marks the task `running`.
- Creates an architect `agent_runs` row.
- Calls the configured provider through the AI SDK.
- Stores the generated plan as an `adr_text` artifact.
- Publishes `run:*`, `artifact:created`, and `task:status` events for the task
  detail page.
- Marks the task `awaiting_approval` on success or `failed` on unrecoverable
  error.
- Marks approved helper-stage tasks `completed`.

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
