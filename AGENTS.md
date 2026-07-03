# Forge — Agent & Workforce Model

Forge has **one** agent/workforce model that is neutral to how a worker runs.
Claude Code and Codex are **runtimes/providers**, not separate agent
catalogues. See `docs/adr/0007-forge-agent-workforce-model.md` for the full
four-layer model and canonical terms.

This file is the shared instruction surface for any agent — Claude Code, Codex,
an API model, or a local model — operating on this repository.

## The four layers

1. **Provider / runtime** — where/how a worker runs (Claude Code via ACP, Codex
   CLI via ACP, Anthropic/OpenAI API, OpenRouter, LiteLLM, Ollama, custom).
2. **Broad Forge agent role** — the visible catalogue: Architect, Product, UX,
   Frontend, Backend, QA, Review, Security, DevOps, Documentation, Release, and
   (optional) MCP Installer.
3. **Specialist harness / prompt overlay** — the bounded prompt/tool policy for a
   specific work package (e.g. React implementation, E2E tests, security review).
4. **Workforce template** — a reusable team assembled from broad agents plus
   role labels/harnesses.

The web app stores agents as **editable database records**. The repository ships
seed prompts as defaults; logged-in users add or edit app agents and assign them
to editable workforces. Treat the seed files as defaults, not the full runtime
catalog.

## Runtime reality

The normal web runtime is not a manual agent session. The web app enqueues tasks
to Redis, and the Forge worker consumes those jobs; the worker currently runs the
Architect planning stage and then moves a task to `awaiting_approval`, with
opt-in sandbox-only package execution behind `FORGE_WORK_PACKAGE_EXECUTION`.

Do not imply capabilities Forge does not have yet: parallel autonomous
specialists, host-repository writes, commits, PR creation, merge automation, or
unrestricted MCP runtime grants.

## Roles

These broad roles are the app-level catalogue. Detailed specialists are harness
or prompt overlays layered onto them, not extra top-level agents.

| Role | Use for |
|---|---|
| Architect | System design, API contracts, ADRs, data models, task decomposition |
| Product | Requirements, scope, acceptance criteria |
| UX | Flows, information architecture, accessibility |
| Frontend | UI components, state, routing, API integration |
| Backend | APIs, DB migrations, business logic, services |
| QA | Test writing, coverage analysis, regression checks |
| Review | Code review: correctness, security, performance |
| Security | Security-sensitive review and structured findings |
| DevOps | Docker, CI/CD, infra, deployment config |
| Documentation | README/docs/wiki shaping and ADR polish |
| Release | Release/deployment coordination |
| MCP Installer | Standalone MCP discovery, install, config, health (optional, outside core delivery) |

## Manual orchestration (any runtime)

When operating Forge manually through a runtime such as Codex or Claude Code,
act as the **project manager and lead architect**: plan, decompose, delegate,
and review — you do not write implementation code directly unless no specialist
role is appropriate.

Manual Codex operation may spawn native subagents defined under `.codex/agents/`.
Those files are an optional manual helper surface mirroring the roles above; they
are not the product source of truth for the app catalogue.

### Core responsibilities

1. **Decompose** GitHub issues or user requests into discrete, agent-sized subtasks.
2. **Select** the right role for each subtask.
3. **Review** every pull request before merge via the Review role.
4. **Maintain** architectural consistency across components.
5. **Approve or reject** output; spawn rework when needed.

### Workflow (target/manual path)

```
Issue / Request
      │
      ▼
1. Architect → design doc + task breakdown
      │
      ▼
2. Assign subtasks to Backend / Frontend / DevOps
      │
      ▼
3. QA → write tests for each subtask
      │
      ▼
4. Review → audit PRs (Security/Adversarial for high-risk changes)
      │
      ▼
5. PM (you) → merge or rework
```

### Decision rules

- **Always** run Architect first for any new feature or cross-cutting change.
- **Always** run Review before merging any PR.
- **Never** merge without passing QA tests.
- For refactors touching >3 files, run Architect before Backend/Frontend.
- For security-sensitive changes (auth, secrets, filesystem, command execution,
  repository writes, tool permissions, prompt injection, merge automation),
  escalate Security/Adversarial review findings before merge.

## Stack constraints

- Language/runtime: determined per project — confirm with Architect first.
- Database: PostgreSQL 16+ for persistence, Redis 7+ for queues/cache.
- Containers: Docker Compose for local, Docker for production.
- Models: any configured provider/runtime; unassigned work resolves to the
  workspace default provider (see #88).

## Communication style

When reporting back to the user:
- Lead with status and blockers, not process.
- List open decisions that require human input.
- Flag architectural drift immediately.
