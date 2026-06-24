# 0004. Cross-Agent Task Checkpointing (v1 Slice)

## Status

Proposed

## Context

Issue #32 asks for tasks that can be started by one model (e.g. Claude) and
resumed by a different model (e.g. Codex) without access to the original
conversation history, via repo-native, human-readable files.

Current state, verified against the codebase:

- `tasks` (`web/db/schema.ts`) tracks lifecycle via a `status` text enum
  (`pending|running|awaiting_answers|awaiting_approval|approved|rejected|completed|failed|cancelled`),
  plus `githubBranch`/`githubPrUrl`. It has no field for "what an agent was
  doing" or "what to do next."
- `agentRuns` records one row per agent invocation (type, model, tokens,
  cost) but stores no resumable task content.
- `artifacts` stores agent output (PR URLs, diffs, ADR text, test reports,
  review findings, log output) keyed to an `agentRunId`, but nothing
  resembling a checkpoint or handoff schema.
- There is no `.forge/tasks/`, no `checkpoint` concept, and no
  `activity.jsonl` anywhere in the repo. A root-level `.forge/` directory
  exists but is **gitignored** and currently holds only local installer
  state (install-manifest, logs) — it is not part of the committed project
  repo and not task-scoped.
- The Forge worker today runs only the architect planning stage, then moves
  the task to `awaiting_approval` (per CLAUDE.md). There is no existing
  automatic mid-task observation of file changes or command output.

So issue #32 proposes new ground — nothing to migrate or reconcile, but also
nothing to build on. The design must be additive to the existing `tasks`
lifecycle, not a parallel state machine.

## Decision

**Checkpoint generator: agent-generated, with a Forge-forced fallback at
phase boundaries the orchestrator already observes.** Agents have the
context to explain *why*, which Forge cannot infer from file diffs alone.
But agents forget or run out of context before writing one. Forge already
calls each subagent at known boundaries (task assignment, completion,
`awaiting_approval` transition) — at minimum, Forge enforces "no checkpoint
file newer than this run started -> write a stub checkpoint from the agent's
last tool output" at those points. No new file-watching or command-result
parsing in v1; the fallback only fires at boundaries Forge already
controls.

**Format: Markdown-first, single file.** The issue's stated goal is
human-readable and repo-native; a `.md` file with a fixed set of headers is
both. JSON would parse more reliably but the issue explicitly leads with
markdown, and a resuming model reads files the same way a human does — there
is no separate parser to keep in sync. v1 ships markdown only. JSON/dual
format is deferred until a real consumer (e.g. a CLI or UI) needs to parse
it programmatically.

**No automatic Forge-side observation in v1.** Watching file changes or
command results requires new infrastructure (a watcher, a diff capture
step) with no current hook point. Self-reporting by the agent, backstopped
by the forced-checkpoint fallback above, is the minimum-complexity option
and is what ships.

## Checkpoint Schema (v1, minimum viable)

A single file: `.forge/tasks/<task-id>/checkpoint.md`, fixed template:

```markdown
# Checkpoint: <task-id>

- Status: <pending|running|awaiting_answers|awaiting_approval|...>  (mirrors tasks.status)
- Agent: <architect|backend|frontend|qa|reviewer|devops>
- Model: <model id>
- Timestamp: <ISO8601>

## What changed
<1-5 bullet points>

## Why
<1-3 sentences>

## Files touched
<repo-relative paths, one per line>

## Next exact step
<single imperative sentence — the next agent's first action>

## Verification status
<not run | passed | failed: reason>

## Open questions / blockers
<bullets, or "none">
```

This is the issue's suggested field set, validated: all six fields are
necessary (a resuming model cannot infer "why" or "next step" from diffs
alone) and no field is removable without losing resumability. `Status`,
`Agent`, and `Model` are added because the resuming model needs to know
where in the lifecycle it is without querying Postgres.

## v1 Slice (single Backend PR)

1. Add a checkpoint template constant/helper (e.g.
   `web/lib/checkpoint.ts`) that renders the schema above from a typed
   object.
2. Write `.forge/tasks/<task-id>/checkpoint.md` at three points already
   present in the task lifecycle: when an `agentRun` starts, before a task
   transitions to `awaiting_approval`/`awaiting_answers`, and when a task
   reaches `completed`/`failed`. Reuse existing transition code paths —
   no new orchestration logic.
3. No `forge checkpoint`/`forge handoff`/`forge resume` CLI. No file
   watching. No JSON variant. These are explicit follow-ons.
4. `.forge/` remains gitignored for this slice (see open decisions below);
   checkpoint files are local artifacts, not yet committed to project
   history.

## Consequences

- Resuming a task means: read one markdown file, no transcript needed.
- No change to `tasks`/`agentRuns`/`artifacts` schemas required for v1.
- Risk: if an agent crashes between Forge's boundary checkpoints, the
  resuming model only has the last successfully written checkpoint, not
  mid-step state — acceptable for v1, revisit if it proves insufficient.

## Open Decisions (require human/repo-owner call)

1. **Commit checkpoint files to the project repo, or keep them in Forge's
   own gitignored `.forge/` state?** The issue calls for "repo-native"
   files, but `.gitignore` currently excludes all of `.forge/`. Committing
   exposes task internals in project history; not committing means
   checkpoints don't survive a fresh clone, undercutting cross-agent
   resumption across machines.
2. **Opt-in per task, or always-on?** Always-on guarantees resumability but
   writes a file on every task regardless of need; opt-in keeps the common
   case lean but requires a UI/flag decision.
3. **Retention** — keep one checkpoint per task (overwrite) or an
   append-only history per task? Overwrite is simpler and matches "current
   snapshot"; history enables audit/replay but multiplies file count.
4. **Does a forced Forge-side checkpoint at a phase boundary need to be
   visible to the user as a distinct event** (e.g. surfaced in the Task
   Workspace UI), or is it purely a backend safety net?
