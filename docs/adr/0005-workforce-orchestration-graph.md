# ADR 0005: Workforce Orchestration Graph

## Status

Accepted for the first Workforce build slice.

## Context

Forge's current worker runs Architect planning and moves tasks to human
approval. The Architect already emits machine-readable planning metadata:
planned agents, capability classification, MCP execution design, and open
questions.

That metadata was previously stored only on the Architect plan artifact. It was
visible to operators but not durable enough for later specialist execution,
approval gates, QA/review routing, or VCS automation.

## Decision

Forge will introduce a durable Workforce graph in PostgreSQL while keeping Redis
as wake-up and retry transport.

The model has three tiers:

1. Editable app agents seeded from repository defaults but expandable by users.
2. Editable workforces that group any active agents into reusable teams.
3. Task-scoped work packages and specialist harness metadata for execution
   planning, dependencies, gates, and future repository work.

The first slice materializes Architect artifact metadata into read-only
workforce records:

- `agent_harnesses` as the reusable harness registry.
- `work_packages` as task-scoped execution units.
- `work_package_dependencies` as package ordering.
- `approval_gates` as explicit human or automated decisions.
- `vcs_changes` as future branch, diff, commit, and PR tracking.
- nullable `agent_runs.work_package_id`, `agent_runs.harness_id`,
  `agent_runs.stage`, and `agent_runs.attempt_number` for future specialist
  runs.

Repository writes, specialist model dispatch, commits, pull requests, and merge
automation remain out of scope for this slice.

## State Ownership

PostgreSQL is authoritative for:

- task state,
- work package state,
- run state,
- approval gates,
- artifacts,
- VCS change records,
- retry and attempt history.

Redis remains responsible for:

- task wake-up jobs,
- approval wake-up jobs,
- answered-question replan jobs,
- retry scheduling,
- dead-letter transport.

## Rollout

The materializer runs after a successful Architect plan with no open questions.
It can be disabled with:

```text
FORGE_WORKFORCE_MATERIALIZATION=0
```

The task detail API returns workforce records alongside existing task, run,
artifact, attempt, and question data. The task detail page displays the graph as
read-only state and falls back to legacy Architect metadata when a task predates
materialization.

## Consequences

The first Workforce slice creates a stable data surface for later execution
without granting tools or writing repositories.

Approval can evolve from a single task-level status transition into explicit
gates. Specialist execution can be added incrementally by claiming ready work
packages and writing package-scoped `agent_runs`.

The main near-term cost is a larger task detail payload and more schema surface.
That is acceptable because PostgreSQL remains the single source of truth and the
UI is read-only for this slice.
