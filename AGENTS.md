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
to Redis, and the Forge worker consumes those jobs. The worker runs Architect
planning, moves a task to `awaiting_approval`, and after approval can execute
specialist packages and apply local repository file edits by default. Set
`FORGE_WORK_PACKAGE_EXECUTION=0` for handoff artifacts only, or
`FORGE_HOST_REPOSITORY_WRITES=0` to keep generated files sandbox-only.

Do not imply capabilities Forge does not have yet: parallel autonomous
specialists, commits, PR creation, merge automation, or unrestricted MCP runtime
grants.

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
| Review | Code review through the orthogonal review protocol in `.ai/skills/orthogonal-review.md` |
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

### Default review behaviour

When Jonathan or a task asks to "review", "check this", "review implementation",
"review PR", "verify a fix", or "do another review pass", use
`.ai/skills/orthogonal-review.md` by default.

Do not perform a single generic review pass. Use full review for PR, implementation,
merge, security, and release-readiness work. A trivial or explicitly narrow check
may use quick review with at least two relevant independent angles and all omitted
passes disclosed. Report evidence-backed findings with severity and
blocking/advisory disposition, inspected scope, confidence, and unchecked areas.
Never claim that no issues exist. Use the scoped verdict language from the skill,
especially "No blockers found in the inspected scope" and the explicit
"not proof of correctness" caveat.

Review is read-only unless fixes are explicitly requested. Report findings before
editing, and never use a review recommendation to bypass tests, CI, MCP/tool or
security policy, repository-write controls, human approval, or merge authority.
The current web executor's sole exception is persistence of an
Architect-designated review-report artifact; that is evidence, not authorization
to edit implementation files. A missing safe artifact path is a blocked work
package, never a reason to invent a repository path.

After fixes, first check whether prior findings were resolved, then run fresh
orthogonal passes so the review also catches regressions introduced by the fix.

The web runtime does not load `.ai/skills` into a Reviewer run. Its concise,
self-contained default is embedded in `.codex/agents/reviewer.toml`, seeded into
`agent_configs.systemPrompt`, and sent by the work-package executor. Repository
defaults apply to fresh installs and explicit overwrite/reset upgrades; the normal
`FORGE_PROMPT_UPGRADE_MODE=keep` path intentionally preserves an operator-edited
Reviewer prompt. Existing operators must opt in by updating/resetting that prompt;
never overwrite their customization silently.

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
4. Review → orthogonal review protocol (Security/Adversarial for high-risk changes)
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

## Documentation style

**Always write documentation to be layman-readable.** Any human-facing prose —
`README`s, files under `docs/`, the wiki, ADRs, developer/operator guides, PR
descriptions, and comments meant for people rather than the compiler — must be
understandable by a smart non-expert who does not already know this codebase.

- Prefer plain language. Say what something does and *why* it matters before how.
- Expand an acronym or term the first time it appears (e.g. "work package", ACP,
  MCP, "execution lease"), or link to where it's defined.
- Lead with the point; keep sentences short. Avoid unexplained jargon and
  insider shorthand.
- Show a concrete example when a concept is easier to grasp than to define.
- Deep implementation detail is welcome, but it should follow a plain-language
  summary a newcomer can follow — not replace it.

This applies to documentation you write directly and to docs produced by the
Documentation role.

## Communication style

When reporting back to the user:
- Lead with status and blockers, not process.
- List open decisions that require human input.
- Flag architectural drift immediately.
