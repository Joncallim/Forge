# Forge Wiki

This is the layman-readable Forge overview. It is written so it can be mirrored
into Notion without requiring a reader to know the codebase first.

Last synced from the repository: 2026-06-29.

## What Forge Is

Forge is a local control room for AI coding work. You open a browser dashboard,
connect one or more AI providers, choose a project, describe a task, and review
the plan Forge produces.

The product goal is an AI software team with a human in charge. The current
beta is more cautious: Forge plans work, stores evidence, and asks for approval.
Workforce materialization and handoff records are enabled unless explicitly
disabled, while generated package execution remains opt-in and sandbox-only.
Forge is not yet a fully autonomous pull-request machine.

## What Forge Does Today

Default Orchestrator-stage flow:

```text
You write a task
  -> Forge saves it
  -> Redis wakes the worker
  -> Architect writes a plan
  -> Forge saves the plan
  -> You approve, reject, or revise it
```

Workforce materialization and handoff flow:

```text
Approved plan
  -> work packages
  -> capability/MCP admission check
  -> ready package / review-gate state
  -> optional sandbox execution only when enabled
  -> QA/Reviewer gates where required
```

Still future work:

- Applying generated edits to the host repository.
- Creating branches, commits, pull requests, or merges.
- Granting live MCP tools to specialist agents at runtime.
- Running specialists in parallel.
- Treating QA and Reviewer gates as production-ready merge gates.

## The Simple Analogy

Picture a small software team:

- A product owner says what outcome they want.
- A tech lead writes the plan.
- Specialists handle backend, frontend, QA, DevOps, docs, and review.
- A human approves the important decisions.

Forge is building that pattern for AI coding. The current beta has the control
room, queue, project records, provider records, Architect planning, artifacts,
and approval loop. The full specialist team is being added carefully behind
safety gates.

## The Moving Parts

| Part | What it means |
|---|---|
| Dashboard | The web app you use in the browser. |
| PostgreSQL | The durable database for users, providers, projects, tasks, artifacts, agents, workforces, and approvals. |
| Redis | The fast queue that wakes the worker and carries retry/dead-letter jobs. |
| Worker | The background process that claims queued tasks and calls model providers. |
| Provider | A model connection, such as OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, LiteLLM, or ACP. |
| Architect | The planning agent that writes the first implementation plan. |
| Workforce | Editable agent teams plus task-scoped work packages for specialist execution. |
| Artifact | Saved evidence, such as a plan, run output, or future review result. |

## Screenshots

These screenshots are checked into the repository under `docs/assets/gui/`.
When this page is mirrored into Notion, use raw GitHub image URLs or uploaded
Notion images instead of the repo-relative paths below.

![Setup wizard](assets/gui/desktop-01-setup.png)

![Providers after preset](assets/gui/desktop-02-providers.png)

![Task awaiting approval](assets/gui/desktop-03-task-awaiting-approval.png)

![Completed task](assets/gui/desktop-04-task-completed.png)

Mobile screenshots are also available:

- `docs/assets/gui/mobile-01-setup.png`
- `docs/assets/gui/mobile-02-providers.png`
- `docs/assets/gui/mobile-03-task-awaiting-approval.png`
- `docs/assets/gui/mobile-04-task-completed.png`

## Provider Options

Forge supports several kinds of model connections:

| Option | Best for | Plain-English note |
|---|---|---|
| Direct cloud providers | Teams with provider API keys | Forge talks straight to a known provider endpoint. |
| OpenRouter | Trying many hosted models quickly | One key can reach many model providers. |
| LiteLLM | Production-like routing and fallback | You run a gateway that presents many models as one OpenAI-compatible API. |
| Ollama / LM Studio | Local models | Useful for no-key experiments, privacy, or local GPUs. |
| ACP | Local coding CLIs | Forge starts a local adapter that talks to tools like Codex CLI or Claude Code. |

## ACP And Zed, In Simple Terms

ACP stands for Agent Client Protocol. It is a common way for one program to talk
to a coding agent.

Forge's current ACP support works like this:

```text
Forge
  -> starts a Zed Industries adapter with npx
  -> adapter speaks ACP over JSON-RPC
  -> adapter wraps a real local CLI such as codex or claude
  -> the local CLI uses the account already logged in on your machine
  -> text streams back into Forge
```

You do not need the Zed editor installed for this path. "Zed connector" means
Forge uses Zed's small adapter package as a translator. You still need the
underlying CLI installed and authenticated.

For more detail, see [ACP And The Zed Connector](acp-zed-connector.md).

## How To Start Locally

From the repository root:

```bash
bash scripts/install.sh
forge
```

Open:

```text
http://localhost:3000
```

The installer prepares local services, creates
`~/Documents/Forge/config/forge.env`, installs dependencies, runs migrations,
and can optionally set up a small local Ollama path.

## What To Read Next

- [Operator guide](operator-guide.md) for install, startup, health checks,
  deployment, and uninstall.
- [Developer guide](developer-guide.md) for code structure, worker flow,
  database tables, prompts, and tests.
- [ACP And The Zed Connector](acp-zed-connector.md) for local ACP provider
  behavior.
- [Roadmap](roadmap.md) for the current beta boundary and upcoming Workforce
  work.
- [Design guide](design.md) for UI principles and screenshot evidence.
