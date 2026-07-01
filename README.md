# Forge

Forge is a local control room for AI coding work.

You open Forge in a browser, connect one or more AI models, create a software
task, and review the plan Forge produces. The long-term goal is a managed AI
workforce that can plan, build, test, review, and prepare pull requests while a
human stays in control of the important decisions.

Today, Forge is an Orchestrator-stage beta. In the default path, Forge plans
work and waits for your approval. Workforce materialization and handoff records
are enabled unless explicitly disabled, so approved plans can flow into durable
work-package and gate state. Actual generated package execution is still
opt-in, writes only inside a per-task sandbox, and does not yet apply those
edits to your host repository, make commits, open pull requests, merge code, or
run specialists in parallel.

## What Forge Does Today

1. You create a project.
2. You describe a task.
3. Forge queues the task.
4. A background worker asks the Architect agent to write a plan.
5. Forge saves the plan and shows it in the dashboard.
6. You approve, reject, or revise the plan.

Under the hood, Forge runs a web app, PostgreSQL, Redis, and a worker process.
For normal local use, the worker starts inside the web app, so one command starts
the dashboard and the task loop together.

```text
Browser -> Forge dashboard -> Redis queue -> Forge worker -> AI model -> review in browser
```

## Vocabulary

| Term | Plain-English meaning |
|---|---|
| Dashboard | The browser UI where you configure Forge and review work. |
| Project | A local or GitHub-backed repository Forge can reason about. |
| Task | A request you give Forge, such as "add login" or "review this bug." |
| Architect | The planning agent that writes the first implementation plan. |
| Artifact | A saved output, usually the Architect plan Markdown. |
| Approval | The human checkpoint before Forge marks the current stage complete. |
| Workforce | The future/sandboxed specialist-agent system: Backend, Frontend, QA, Reviewer, DevOps, and custom agents. |
| Forge Workspace | The planned dockable workspace that links browser, repo, notes, docs, Playwright, Notion, GitHub, logs, and AI task context. |
| ACP provider | A local command-line coding agent connected through the Agent Client Protocol. See [ACP and Zed connector](docs/acp-zed-connector.md). |

## Fast Setup

From the repository root:

```bash
bash scripts/install.sh
```

The installer prepares local services, creates
`~/Documents/Forge/config/forge.env`, installs web dependencies, prepares the
database, and can set up a small local Ollama model so Forge can run without API
keys.

Useful variants:

```bash
bash scripts/install.sh --check      # inspect readiness without changing the machine
forge upgrade                        # sync dependencies and migrations after pulling updates
FORGE_SKIP_OLLAMA=1 bash scripts/install.sh
```

Then start Forge:

```bash
forge
```

Open:

```text
http://localhost:3000
```

The first account creates a password and, by default, a passkey. To use password
only, set `FORGE_PASSKEYS_ENABLED=0` in
`~/Documents/Forge/config/forge.env` before creating the first account.

If you kept settings during uninstall/reinstall, Forge keeps the existing
single-user account. Registration will stay closed, so recover from the shell:

```bash
forge reset-credentials
```

Use `http://localhost:3000` for local passkeys unless you also update
`WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` in the workspace env file.

## Try A Task

1. Open the dashboard.
2. Apply a provider preset in setup, or add a provider manually.
3. Create a project from a GitHub repo or local folder.
4. Create a task with a short prompt.
5. Wait for the task to reach `Awaiting Approval`.
6. Read the Architect plan and approve or reject it.

For a no-cost plumbing test, run with the mock Architect:

```bash
cd web
FORGE_WORKER_MOCK_ARCHITECT=1 npm run dev
```

## What Is Not Built Yet

- Applying generated edits to the project repository.
- MCP runtime grants for specialists.
- Branch, commit, pull request, and merge automation.
- Parallel specialist execution.
- Production-ready QA/Reviewer gates for generated code.
- Forge Workspace panes for built-in Chromium, Playwright, notepad, Markdown,
  coding, terminal/logs, Notion, and GitHub.
- Notion/GitHub link graph sync and write-back approvals.

The first Workforce build slice is present as durable planning records:
work packages, harness metadata, approval gates, and VCS summaries can now be
stored and displayed. Workforce materialization and handoff are default-on and
can be disabled with `FORGE_WORKFORCE_MATERIALIZATION=0` or
`FORGE_WORK_PACKAGE_HANDOFF=0`. Sandbox package execution remains opt-in with
`FORGE_WORK_PACKAGE_EXECUTION=1`.

## Forge Workspace Direction

After sequential sandboxed Workforce execution is reliable, the next major
product direction is **Forge Workspace**: a dockable, AI-assisted workbench that
brings browser, repo, notes, docs, Playwright, GitHub, Notion, terminals, logs,
and task artifacts into one saved context.

The product should feel OS-like without becoming a full operating system. The
first implementation should be a workspace shell with dockable panes, a command
palette, a right-side context inspector, and explicit permission gates for agent
operations. The Notion/GitHub integration should use a link graph rather than a
naive bidirectional mirror: Notion remains the planning and intent surface, while
repositories remain the implementation source of truth.

See [Forge Workspace roadmap](docs/workspace-roadmap.md) for the proposed
implementation plan.

## Screenshots

### Setup Wizard

![Forge setup wizard](docs/assets/gui/desktop-01-setup.png)

### Provider Review

![Forge providers page after applying a preset](docs/assets/gui/desktop-02-providers.png)

### Architect Plan Awaiting Approval

![Forge task detail page awaiting approval](docs/assets/gui/desktop-03-task-awaiting-approval.png)

### Completed Orchestrator Task

![Forge task detail page after approval](docs/assets/gui/desktop-04-task-completed.png)

## Docs

- [Wiki overview](docs/wiki.md) - layman-readable overview mirrored into the Notion wiki.
- [Operator guide](docs/operator-guide.md) - install, run, deploy, uninstall, and troubleshoot Forge.
- [CLI architecture](docs/cli-command-architecture.md) - `forge` command taxonomy and routing.
- [Developer guide](docs/developer-guide.md) - web app, worker, database, tests, prompts, and coding standards.
- [Design guide](docs/design.md) - product model, UI principles, screenshot evidence, and visual QA notes.
- [ACP and Zed connector](docs/acp-zed-connector.md) - how Forge talks to local ACP agents such as Codex CLI and Claude Code.
- [Roadmap](docs/roadmap.md) - current beta status, Workforce architecture, Forge Workspace direction, and upcoming slices.
- [Forge Workspace roadmap](docs/workspace-roadmap.md) - proposed implementation plan for dockable panes, browsers, Notion/GitHub linking, and permissioned agent operations.
- [Architecture decisions](docs/adr/) - durable ADRs for major technical decisions.
