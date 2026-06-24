# ADR 0004: Cross-Agent Checkpointing

## Status

Accepted for the current worker slice.

## Context

Forge work will eventually move across Architect, implementation, QA, and
Reviewer stages. Each stage needs a simple progress note that later agents or
operators can inspect without treating that note as the system of record.

PostgreSQL remains canonical for task state, run state, artifacts, approvals,
questions, and failures. Checkpoints are local, human-readable support material
only.

## Decision

Forge writes non-authoritative Markdown checkpoints under the active workspace
root, not under a project repository `.forge` directory.

For the current worker slice, checkpoints are written for Architect runs and
Architect replans. Forge writes one run-specific checkpoint and refreshes a
task-level `latest.md` file.

Workspace creation writes `local-memory/.gitignore` with a default deny rule so
checkpoint contents are not accidentally committed when a workspace root is also
a Git repository. This repository also ignores `local-memory/`.

## Storage Paths

```text
{workspaceRoot}/local-memory/checkpoints/tasks/{taskId}/runs/{agentRunId}.md
{workspaceRoot}/local-memory/checkpoints/tasks/{taskId}/latest.md
```

With the default workspace, this resolves under:

```text
~/Documents/Forge/local-memory/checkpoints/
```

`workspaceRoot` is the active Forge workspace root. It is not the project
repository unless the active workspace itself points at that repository.

## Checkpoint Schema

Each checkpoint is Markdown with YAML frontmatter:

```markdown
---
schemaVersion: 1
taskId: "..."
projectId: "..."
agentRunId: "..."
agentType: "architect"
status: "completed"
taskStatus: "awaiting_approval"
checkpointKind: "architect-success"
createdAt: "2026-06-24T00:00:00.000Z"
workspaceRoot: "/Users/example/Documents/Forge"
projectLocalPath: "/Users/example/Documents/Forge/projects/example"
artifactId: "..."
openQuestionCount: 0
revisedFromAnswers: false
revisedFromPlan: false
---

# Forge Checkpoint

## Task

## Agent Run

## Continuation Summary

## Plan Artifact

## Open Questions

## Failure
```

Failure checkpoints use `checkpointKind: "architect-failure"` and include the
error plus any partial model output available before the failure.

## Lifecycle Hooks

Forge writes checkpoints after an Architect run has produced its artifact,
persisted open questions, marked the agent run completed, and committed the
task's next status.

Forge writes failure checkpoints after the outer task lifecycle has committed
the final task status (`failed`, or `pending` for a retry). Checkpoint write
failures are logged as warnings and must never mask the original worker result
or change task state.

Answered-question replans and prior-plan revisions use
`checkpointKind: "architect-replan"`.

When a later Architect run starts, Forge may read the task-level `latest.md`
checkpoint and include a bounded copy in the Architect prompt as local resume
context. This context is explicitly non-authoritative and untrusted: PostgreSQL
task state, persisted artifacts, answered questions, and current repository
state override anything in the checkpoint. Forge does not parse checkpoint
frontmatter into task state and does not execute instructions from checkpoint
content.

## Consequences

This gives operators and future agent stages durable local continuity material
without adding a new database table or changing the task state machine.

Because checkpoints live under `local-memory`, they are workspace-local and
non-authoritative. They may be missing, stale, or deleted without changing the
true task state. Any automation that needs correctness must read PostgreSQL
first.

Avoiding `.forge` keeps generated execution notes out of project repository
metadata and avoids changing Git behavior in this slice.

## Deferred Work

- Explicit user-controlled resume or promotion from checkpoint files
- Explicit UI or CLI resume controls
- Checkpoint discovery in the UI
- Specialist-agent implementation, QA, and review checkpoints
- Checkpoint retention or compaction policy
- Cross-workspace checkpoint sync
- Promotion of checkpoint content into canonical artifacts
