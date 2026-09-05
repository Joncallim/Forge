# Forge — Agent & Workforce Model

Forge has **one** runtime-neutral agent/workforce model. Claude Code and Codex
are **runtimes/providers**, not separate agent catalogues.

Read the architecture in this order:

- `docs/adr/0014-forge-vnext-general-agent-runtime.md` — product-wide VNext
  ontology and invariants.
- `docs/forge-vnext-architecture.md` — full target architecture and phase order.
- `docs/adr/0007-forge-agent-workforce-model.md` — the current coding/Software
  Engineering role taxonomy beneath the broader VNext model.

This file is the shared instruction surface for any agent — Claude Code, Codex,
an API model, or a local model — operating on this repository.

## The four layers

For the current coding product and future Software Engineering Workforce:

1. **Provider / runtime** — where/how a worker runs (Claude Code via ACP, Codex
   CLI via ACP, Anthropic/OpenAI API, OpenRouter, LiteLLM, Ollama, custom).
2. **Broad Software Engineering role** — Architect, Product, UX, Frontend,
   Backend, QA, Review, Security, DevOps, Documentation, Release, and optional
   MCP Installer.
3. **Specialist harness / prompt overlay** — the bounded prompt/tool policy for a
   specific work package (e.g. React implementation, E2E tests, security review).
4. **Workforce template** — a reusable team assembled from roles plus
   labels/harnesses.

Under VNext, these coding roles are **not** the universal catalogue for every
Workforce. Other installed Workforces may define domain-specific roles while
using the same generic Mission/Execution/Resource/Capability/Grant contracts.

The web app stores the current coding agents as **editable database records**.
Repository seed prompts are defaults; logged-in users can add or edit app agents
and assign them to editable workforces. Treat seed files as defaults, not the
full runtime catalogue.

## Runtime reality

Forge is currently a coding-focused, single-operator beta. The normal web runtime
is not a manual agent session: the web app records durable task state in
PostgreSQL, Redis carries queue/wakeup transport, and the Forge worker runs the
supported planning/admission/evidence stages.

**Specialist execution and host-repository file materialization are currently
unavailable.** Forge does not yet have the OS-enforced confined writer required
for those mutations. `FORGE_WORK_PACKAGE_EXECUTION` and
`FORGE_HOST_REPOSITORY_WRITES` are reserved/request signals; setting them to an
enable value does **not** create authority or make writes available. The runtime
must fail closed until the confined execution boundary is implemented and proven.

Do not imply capabilities Forge does not have yet: specialist repository writes,
parallel autonomous specialists, automatic commits/PRs/merges, unrestricted MCP
runtime grants, persistent general-agent Missions, or installed non-coding
Workforces.

VNext is an accepted target architecture, not a claim that those features already
ship. When docs and runtime differ, inspect the live implementation and current
release evidence before making a capability claim.

## Roles

These broad roles describe the current coding product and future Software
Engineering Workforce. Detailed specialists are harness/prompt overlays layered
onto them, not extra top-level coding agents.

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
and review. Do not write implementation code directly when a specialist role is
more appropriate.

Manual Codex operation may spawn native subagents defined under `.codex/agents/`.
Those files are an optional manual helper surface mirroring the coding roles
above; they are not the product source of truth for the app catalogue.

Do not instantiate every role ceremonially. For a small bounded change, use the
smallest team that provides independent implementation and verification. Add
roles only for distinct workstreams or security/release risk. Prefer deterministic
checks over extra model calls. Run application checks from `web/` unless a
command explicitly says otherwise.

### Core responsibilities

1. **Decompose** GitHub issues or user requests into discrete, agent-sized subtasks.
2. **Select** the right role for each subtask.
3. **Review** every pull request via the Review role and recommend merge or
   rework; execute a merge only with explicit user authorization and an
   available merge capability.
4. **Maintain** architectural consistency across components.
5. **Recommend acceptance or rework** based on evidence. Merges, deployments,
   external writes, and other consequential actions still require explicit user
   authorization.
6. **Assign one writer per file.** Review, Security, and Adversarial passes stay
   read-only. QA is read-only when it is the independent verification pass, but
   may receive exclusive test-file ownership before work begins; implementation
   agents must not edit those files in that mode.
7. **Do not invent authority from role or prose.** A model/role saying an action
   is safe does not grant filesystem, network, GitHub, MCP, or other capability.
   VNext authority is always constrained by Forge policy and explicit scoped
   grants.

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
Reviewers/verifiers produce evidence; trusted deterministic Forge/GitHub gates
make authoritative decisions.

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

```text
Issue / Request
      |
      v
1. Architect / planning as needed -> design + task breakdown
      |
      v
2. Assign bounded implementation work
      |
      v
3. Deterministic checks + QA evidence
      |
      v
4. Review -> orthogonal review protocol (Security/Adversarial evidence for high-risk changes)
      |
      v
5. PM/operator -> recommend acceptance or rework; merge only with explicit user authorization
```

This is a manual/repository workflow description, not proof that the current web
runtime autonomously executes every stage.

### Decision rules

- Run Architect/design work for new features or cross-cutting changes; do not add
  ceremonial planning calls for trivial mechanical edits.
- Always run independent Review before recommending merge of substantive PRs.
- Never recommend merge without the applicable test/CI evidence.
- For refactors touching >3 files, run an architecture pass before implementation.
- For security-sensitive changes (auth, secrets, filesystem, command execution,
  repository writes, tool permissions, prompt injection, merge automation),
  escalate Security/Adversarial findings as **evidence** before merge; a model
  review is not itself a security-policy allow decision.

## Stack constraints

- Language/runtime: determined per project — confirm from the repository before
  assuming.
- Database: PostgreSQL 16+ for durable persistence; Redis 7+ for reconstructable
  queue/wakeup/cache transport.
- Models: any supported configured provider/runtime for the current beta. The
  current coding path still has legacy provider assignments/default-provider
  fallback; VNext #335 replaces runtime selection with deterministic,
  provider-neutral budget/routing policy.

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
