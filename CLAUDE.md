# Forge repository — Claude context

Claude Code is a runtime/provider in Forge, not a separate agent taxonomy.
Forge has one runtime-neutral agent/workforce model shared by Claude Code,
Codex, API providers, and local models.

Read these files first when operating at repository root:

- `AGENTS.md` — shared agent and workforce model for all runtimes.
- `.ai/skills/orthogonal-review.md` — default review protocol whenever Jonathan
  asks to review code, implementation, a PR, a fix, or a task.
- `docs/adr/0007-forge-agent-workforce-model.md` — canonical four-layer model.
- `web/CLAUDE.md` — web app package context.

When asked to review, do not perform a single generic pass. Use the orthogonal
review skill, report findings by angle, list coverage, and state unchecked areas.
Never claim that no issues exist; use scoped verdicts such as "No blockers found
in the inspected scope."
