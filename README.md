# Forge

Forge is a local control room for AI coding work.

You open Forge in a browser, connect one or more AI models, create a software
task, and review the plan Forge produces. The long-term goal is a managed AI
workforce that can plan, build, test, review, and prepare pull requests while a
human stays in control of the important decisions.

Today, Forge is an Orchestrator-stage beta. It plans work and waits for your
approval. It does not yet edit your repository, make commits, or open pull
requests by itself.

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

## Fast Setup

From the repository root:

```bash
bash scripts/install.sh
```

The installer prepares local services, creates `.env`, installs web
dependencies, prepares the database, and can set up a small local Ollama model
so Forge can run without API keys.

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
only, set `FORGE_PASSKEYS_ENABLED=0` in `.env` before creating the first account.

If you kept settings during uninstall/reinstall, Forge keeps the existing
single-user account. Registration will stay closed, so recover from the shell:

```bash
forge reset-credentials
```

Use `http://localhost:3000` for local passkeys unless you also update
`WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` in `.env`.

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

- Automatic repository edits.
- Multi-agent implementation runs.
- Test execution by agents.
- Branch, commit, pull request, and merge automation.
- Full specialist harness execution from the Workforce roadmap.

The first Workforce build slice is present as durable planning records:
work packages, harness metadata, approval gates, and VCS summaries can now be
stored and displayed. Execution remains a later slice.

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

- [Operator guide](docs/operator-guide.md) - install, run, deploy, uninstall, and troubleshoot Forge.
- [CLI architecture](docs/cli-command-architecture.md) - `forge` command taxonomy and routing.
- [Developer guide](docs/developer-guide.md) - web app, worker, database, tests, prompts, and coding standards.
- [Design guide](docs/design.md) - product model, UI principles, screenshot evidence, and visual QA notes.
- [Roadmap](docs/roadmap.md) - current beta status, Workforce architecture, and upcoming slices.
- [Architecture decisions](docs/adr/) - durable ADRs for major technical decisions.
