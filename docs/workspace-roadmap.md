# Forge Workspace Roadmap

Last updated: 2026-07-01

## Plain-English Goal

Forge should eventually feel like a local AI-assisted software workspace: browser,
repo, notes, docs, tests, GitHub, Notion, terminals, and AI agents arranged around
the current task.

The near-term product name should be **Forge Workspace**, not **Forge OS**. The
long-term experience may feel OS-like because panes can be moved, docked, saved,
and operated by humans and agents, but the implementation should stay a
workspace shell rather than a full operating system.

## Product Positioning

Forge Workspace is the next major product direction after the Workforce beta is
reliable enough to execute sequential specialist work in sandboxes.

The goal is not only to show many tools in one screen. The goal is to preserve
context between tools:

```text
Notion spec
  -> linked repo files
  -> linked GitHub issue or PR
  -> linked Forge task
  -> linked Playwright browser run
  -> linked artifacts, notes, diffs, logs, and approvals
```

A human should be able to arrange those surfaces visually, while Forge keeps the
relationship graph underneath them.

## Core Workspace Surfaces

The first-class panes should be:

| Pane | Purpose | First implementation stance |
|---|---|---|
| Human browser | Normal browsing, app previews, docs, local dev servers, auth flows. | Built-in Chromium/WebView where practical; browser profile controlled by the human. |
| Playwright browser | Agent-operated web automation, screenshots, E2E tests, UI inspection, trace capture. | Separate task-scoped Chromium context controlled by the Playwright service. |
| Notepad | Task scratchpad, decision notes, follow-up ideas, quick checklists. | Local-first Markdown or rich-text records stored in Forge. |
| Markdown reader/editor | README, ADRs, plans, generated artifacts, handoff records, review notes. | Markdown renderer plus editor, starting with repo files and Forge artifacts. |
| Coding pane | Focused code edits, diffs, file search, symbol navigation, and patch review. | Monaco-based editor first; do not clone all of VS Code immediately. |
| Terminal and logs | Commands, test output, worker logs, Playwright traces, provider logs. | Bottom drawer with bounded command execution and saved output artifacts. |
| Repo explorer | Local and GitHub-backed repo tree, changed files, branches, commits, docs, ADRs. | Start with read/browse plus diff display; write actions require approval. |
| Notion explorer | Planning pages, project docs, decisions, tasks, wiki pages, and Forge docs. | API-backed explorer, not iframe-first. |
| GitHub explorer | Repos, issues, PRs, checks, Actions runs, comments, releases, linked files. | API-backed explorer with link records back to Forge tasks and Notion pages. |

## Two-Browser Rule

Forge should keep the human browser and the agent browser separate.

### Human Chromium

The human browser lane is for the operator. It may use persistent profile state,
normal tabs, local dev server previews, manual auth flows, downloads, and visual
review. The agent should not silently operate this profile.

### Playwright Chromium

The Playwright lane is for automation. It should be task-scoped, observable, and
disposable by default. Each run should capture screenshots, traces, console logs,
network summaries where safe, page metadata, and enough replay information for a
human to understand what happened.

The agent should only use logged-in sessions or sensitive browser state when the
human grants that capability explicitly for the task.

## Workspace Shell

Start with a dockable layout, not arbitrary overlapping windows.

Dockable panes provide most of the value of an AI-assisted OS while avoiding the
messiest desktop-window problems. The initial shell should support:

1. Left rail for projects, repos, Notion spaces, GitHub objects, active tasks,
   and saved workspaces.
2. Main area with tabs and split panes.
3. Bottom drawer for terminal, logs, tests, worker events, and Playwright traces.
4. Right inspector for selected object metadata, links, permissions, task state,
   and evidence.
5. Command palette for workspace actions.
6. Saved layouts per project, task, or user.

Free-floating moveable windows can be a later layer after saved docked layouts
are stable.

## Link Graph

Forge should not mirror Notion into GitHub or GitHub into Notion naively. It
should maintain a link graph.

Core object:

```ts
type ForgeLink = {
  id: string;
  workspaceId: string;
  sourceType:
    | "notion_page"
    | "notion_database"
    | "github_repo"
    | "github_file"
    | "github_issue"
    | "github_pr"
    | "local_file"
    | "forge_task"
    | "forge_artifact";
  sourceId: string;
  targetType: ForgeLink["sourceType"];
  targetId: string;
  relationship:
    | "documents"
    | "implements"
    | "references"
    | "supersedes"
    | "generated_from"
    | "evidence_for"
    | "blocks"
    | "closes";
  syncPolicy: "read_only" | "write_back_summary" | "write_back_full" | "manual_only";
  lastSeenAt: string | null;
  lastSyncedAt: string | null;
  conflictState: "none" | "stale" | "conflict" | "missing";
};
```

This preserves the current operating boundary: Notion holds planning, memory,
intent, and project rationale; repositories hold implementation truth.

## Proposed Data Model

Initial tables:

- `workspaces`
  - `id`
  - `user_id`
  - `name`
  - `description`
  - `active_project_id`
  - `created_at`
  - `updated_at`
- `workspace_layouts`
  - `id`
  - `workspace_id`
  - `task_id`
  - `name`
  - `layout_json`
  - `is_default`
  - `created_at`
  - `updated_at`
- `workspace_panes`
  - `id`
  - `workspace_id`
  - `layout_id`
  - `pane_type`
  - `title`
  - `state_json`
  - `last_focused_at`
- `workspace_links`
  - `id`
  - `workspace_id`
  - `source_type`
  - `source_id`
  - `target_type`
  - `target_id`
  - `relationship`
  - `sync_policy`
  - `last_seen_at`
  - `last_synced_at`
  - `conflict_state`
- `external_accounts`
  - `id`
  - `user_id`
  - `provider`
  - `display_name`
  - `credential_ref`
  - `scopes_json`
  - `status`
- `browser_sessions`
  - `id`
  - `workspace_id`
  - `session_type`
  - `profile_path`
  - `status`
  - `created_at`
  - `ended_at`
- `browser_runs`
  - `id`
  - `task_id`
  - `browser_session_id`
  - `purpose`
  - `status`
  - `trace_artifact_id`
  - `screenshot_artifact_ids`
  - `summary_artifact_id`
- `sync_events`
  - `id`
  - `workspace_id`
  - `provider`
  - `external_id`
  - `event_type`
  - `payload_summary`
  - `processed_at`
  - `status`

## Service Boundaries

Recommended backend services:

| Service | Responsibility |
|---|---|
| Workspace service | Layouts, panes, saved workspaces, selected project/task context. |
| Filesystem service | Safe local file reads, writes, searches, and path permission checks. |
| Git service | Local status, branches, diffs, commits, and patch application. |
| GitHub service | Repos, issues, PRs, checks, comments, webhooks, and remote file metadata. |
| Notion service | Page/database search, fetch, link metadata, sync cursors, write-back summaries. |
| Browser service | Human browser lifecycle where supported by the desktop/web runtime. |
| Playwright service | Agent browser contexts, screenshots, traces, automation runs, E2E checks. |
| Terminal service | Bounded command execution, logs, approvals, and artifacts. |
| Permission service | Capability requests, approvals, audit records, and policy enforcement. |

## Implementation Plan

### Phase 0: Product framing and ADRs

Deliverables:

1. ADR for Forge Workspace as a dockable shell, not a full OS.
2. ADR for the two-browser rule: human Chromium and Playwright Chromium must be
   separate.
3. ADR for Notion/GitHub link graph semantics and sync boundaries.
4. Data-model migration plan for workspaces, panes, links, browser sessions, and
   sync events.

Acceptance criteria:

- The roadmap names Forge Workspace as the next product direction after
  Workforce reliability.
- Docs explicitly reject naive Notion/GitHub mirroring as the default model.
- Browser permissions and profile separation are documented before build work.

### Phase 1: Workspace shell

Deliverables:

1. Dockable layout with left rail, main panes, bottom drawer, right inspector, and
   command palette.
2. Saved layouts by project and task.
3. Pane registry with typed pane state.
4. Workspace route in the dashboard.

Acceptance criteria:

- A user can save and restore a layout containing at least repo, markdown,
  notepad, task, and log panes.
- Pane state survives refresh.
- Workspace layout changes do not affect task execution semantics.

### Phase 2: Local repo, markdown, notes, and diffs

Deliverables:

1. Repo/file explorer pane.
2. Markdown reader/editor for repo docs and Forge artifacts.
3. Task notepad pane.
4. Diff viewer pane for generated or proposed changes.
5. Terminal/log drawer connected to existing task artifacts and worker logs.

Acceptance criteria:

- A user can open a repo doc, take a task note, inspect a generated artifact, and
  view a diff in one saved workspace.
- File writes are permissioned and scoped to approved project paths.
- Notes and artifacts are searchable from the workspace.

### Phase 3: Playwright browser lane

Deliverables:

1. Playwright service with task-scoped browser contexts.
2. Browser-run records linked to tasks and artifacts.
3. Screenshot and trace capture.
4. UI pane that shows the latest page, screenshots, trace summary, and run log.
5. Human approval gate for sensitive session use or high-risk browser actions.

Acceptance criteria:

- Forge can run a Playwright check against a local dev server and show the result
  in the workspace.
- Each browser run records enough evidence for review.
- The agent browser cannot use the human browser profile by default.

### Phase 4: Notion and GitHub explorers

Deliverables:

1. API-backed Notion explorer for pages, databases, project docs, and Forge wiki
   pages.
2. API-backed GitHub explorer for repos, issues, PRs, files, checks, and comments.
3. Manual link creation between Notion pages, GitHub objects, local files, Forge
   tasks, and Forge artifacts.
4. Link inspector in the workspace right rail.
5. Optional write-back summaries, disabled by default until reviewed.

Acceptance criteria:

- A user can link a Notion spec to a repo, GitHub issue, PR, local file, and Forge
  task.
- Forge can show all linked objects from the task inspector.
- Write-back requires explicit approval and records the target, content, and
  reason.

### Phase 5: Sync and freshness

Deliverables:

1. Manual refresh for Notion and GitHub objects.
2. Sync cursors and `sync_events` records.
3. Webhook ingestion where available.
4. Conflict/staleness display in the inspector.
5. Summary-generation pipeline for changed pages, issues, PRs, and files.

Acceptance criteria:

- Forge can detect that a linked Notion page or GitHub PR changed since the last
  task run.
- Forge warns when a task plan is based on stale linked material.
- Conflicts are surfaced for humans rather than silently overwritten.

### Phase 6: Permissioned agent operations

Deliverables:

1. Agent-readable workspace context packets.
2. Capability requests for browser automation, repo writes, Notion write-back,
   GitHub comments, branch creation, PR creation, and terminal commands.
3. Approval records connected to tasks, panes, links, and artifacts.
4. Human takeover mode for browser and terminal operations.

Acceptance criteria:

- An agent can read the current workspace context and propose a plan grounded in
  the open panes and linked objects.
- Agent write actions are blocked unless the relevant capability is granted.
- Every agent action leaves an audit trail.

## Command Palette Concepts

Starter commands:

- `Open repo`
- `Open linked Notion page`
- `Open linked GitHub issue`
- `Link current file to task`
- `Link Notion page to repo`
- `Summarize linked context`
- `Run Playwright check`
- `Show browser evidence`
- `Draft implementation plan from workspace`
- `Write status summary to Notion`
- `Create GitHub issue from Forge task`
- `Prepare PR summary from artifacts`

## Safety Boundaries

Hard boundaries for early builds:

1. Do not give the agent silent access to the human browser profile.
2. Do not iframe third-party apps as the primary integration strategy.
3. Do not mirror Notion and GitHub bidirectionally without conflict handling.
4. Do not allow repo writes, commits, PRs, Notion updates, GitHub comments, or
   terminal commands without explicit policy and approval gates.
5. Do not treat visual panes as the source of truth; persist task, link,
   artifact, and approval state in PostgreSQL.

## Non-Goals For The First Workspace Release

- Full desktop OS replacement.
- Arbitrary plugin marketplace.
- Full VS Code clone.
- Fully autonomous repository writes.
- Fully autonomous Notion/GitHub write-back.
- Parallel agent browser sessions.
- Cross-device browser profile synchronization.

## Risks

| Risk | Mitigation |
|---|---|
| Scope creep into a full OS | Keep the first release as a dockable workspace shell. |
| Browser profile leakage | Enforce the two-browser rule and task-scoped Playwright contexts. |
| Confusing Notion/GitHub sync | Use explicit link records and manual write-back before automation. |
| Too many panes, weak UX | Start with saved layouts and a small pane registry. |
| Agent actions become hard to audit | Route operations through capability requests and artifacts. |
| Third-party embedding breaks | Prefer API-backed panes and real browser surfaces over iframes. |

## Relationship To Workforce

Workforce remains the execution model. Workspace is the operator and context
model.

```text
Workspace shows and links the context.
Workforce turns approved context into work packages.
Playwright, Git, GitHub, Notion, terminal, and file tools become permissioned
capabilities that specialists can request.
```

The recommended sequencing is:

1. Make sequential sandboxed Workforce execution reliable.
2. Add the Workspace shell for human context management.
3. Add Playwright and Notion/GitHub panes.
4. Let agents request permissioned operations from the workspace context.
5. Only then expand toward PR automation, remote repository writes, and richer
   OS-like behavior.
