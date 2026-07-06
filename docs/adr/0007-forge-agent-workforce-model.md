# ADR 0007: Unified Forge Agent / Workforce Model

## Status

Accepted for the #124 agent/workforce clarity work. Establishes the naming
contract; the seed/migration and UI phases of #124 build on it in follow-up
changes.

## Context

Forge's agent model grew Codex-first. `AGENTS.md` was titled and framed around
Codex PM orchestration, `web/CLAUDE.md` only imported it, and `web/db/seed-agents.ts`
bootstrapped defaults from `.codex/agents/*.toml`. The docs and app copy could
be read as "the Forge agent breakdown is only for Codex," even though the web
runtime treats Claude Code and Codex the same way: as execution backends behind
one Forge task/worker model.

Two failure modes follow from that framing:

1. **Taxonomy confusion.** Claude Code and Codex read like separate product
   catalogues instead of interchangeable runtimes for the same Forge roles.
2. **Overpromising.** Copy that leans on a specific runtime's autonomy can imply
   parallel agents, commits, PRs, merge automation, or unrestricted tool access
   that Forge does not actually perform yet.

## Decision

Forge adopts one coherent, runtime-neutral agent/workforce model with four
explicit layers. Claude Code and Codex are **runtimes/providers**, not separate
taxonomies.

### Four-layer model

1. **Provider / runtime** — *where/how a worker runs.* Examples: Claude Code via
   ACP, Codex CLI via ACP, Anthropic API, OpenAI API, OpenRouter, LiteLLM,
   Ollama, custom provider. A default provider resolves unassigned work (see
   #88).
2. **Broad Forge agent role** — *what kind of worker this is.* The visible,
   comprehensible catalogue: Architect, Product, UX, Frontend, Backend, QA,
   Review, Security, DevOps, Documentation, Release, and (optional, outside core
   delivery) MCP Installer.
3. **Specialist harness / prompt overlay** — *the exact bounded job shape, prompt,
   and tool policy for a package.* Detailed specialists (e.g. React
   implementation specialist, E2E test specialist, Security reviewer, Release
   manager) are expressed as harness records, prompt overlays, or workforce role
   labels — not as extra top-level app agents.
4. **Workforce template** — *a reusable team* assembled from broad agents plus
   role labels/harnesses (e.g. Core Delivery, Product Discovery, UX/UI Delivery,
   Backend/API Delivery, Release/Deployment, MCP Setup/Tooling).

The same workforce can run through any configured provider/runtime; the runtime
choice is orthogonal to the role/workforce definition.

### Canonical terms

| Term | Meaning |
|---|---|
| **Provider / Runtime** | Where and how a worker executes (Claude Code, Codex, an API provider, a local model). |
| **Agent** | A broad Forge worker identity (Architect, Backend, QA, …), stored as an editable database record. |
| **Harness / specialist overlay** | The bounded execution contract (prompt/tool policy/job shape) for a specific package. |
| **Workforce** | A reusable team assembled from agents and harnesses. |
| **Work Package** | A task-scoped unit of work produced by the Architect and executed by an agent. |
| **Architect** | The planning agent that decomposes a task into work packages and gates. |
| **Prompt** | The editable system prompt for an agent, managed in the authenticated Forge app and synced to the workspace prompt store. |
| **Forge Workspace** | The private, authenticated operator control plane that ties projects, providers, prompts, workforces, tasks, artifacts, approvals, GitHub issues, MCP tools, and run history together. |

### Where specialists live

Detailed specialists are **not** new top-level app agents. They live as harness
records / prompt overlays / workforce role labels layered onto the broad agent
roles. The broad roles stay the comprehensible app-level catalogue.

### Source of truth for default prompts

The neutral Forge catalogue — not `.codex/agents` — is the intended product
source of truth for seeded defaults. `.codex/agents` remains an optional manual
Codex helper surface. Migration/backfill must preserve user-created agents,
workforces, and user-edited prompts, with reset-to-default as an explicit,
opt-in action. (Implemented across the #124 seed/migration phase.)

### Privacy

The in-app catalogue, prompt bodies, provider choices, workspace paths, and
workforce definitions require a valid Forge session. Public docs describe the
concepts but never expose a user's configured catalogue or private prompts.

### Honesty about current limits

Docs and app copy must not imply capabilities Forge does not yet have:
parallel autonomous specialists, commits, PR creation, merge automation, or
unrestricted MCP runtime grants. These stay out of scope until a future issue
implements them safely.

## Consequences

- One taxonomy to reason about; runtime and role are cleanly separated.
- `AGENTS.md` and `web/CLAUDE.md` become runtime-neutral (this ADR's companion
  changes); the Codex manual-operation workflow becomes one section rather than
  the framing for the whole model.
- Follow-up #124 phases (seed/migration, prompt-editing UX, Agents/Workforces UI,
  and the full docs language pass) implement the model this ADR defines.
- Related: #30 (Workforce umbrella), #108 (naming/slug cleanup), #109 (project
  workspace layout), #114 (ACP model selection), #119 (Executable Workforce
  Beta).
