# Forge web app — Claude context

Claude Code is a **runtime/provider** in Forge, not a separate agent taxonomy.
Forge has one runtime-neutral agent/workforce model shared by Claude Code,
Codex, API providers, and local models. For that model and the canonical terms
(Provider/Runtime, Agent, Harness, Workforce, Work Package, Architect, Prompt,
Forge Workspace), read:

- `../AGENTS.md` — the shared agent & workforce model.
- `../.ai/skills/orthogonal-review.md` — the default protocol whenever Jonathan
  asks to review code, implementation, a PR, a fix, or a task.
- `../docs/adr/0007-forge-agent-workforce-model.md` — the four-layer model.

Do not treat `.codex/agents` as the product source of truth; app agents are
editable database records, and the broad roles (Architect, Product, UX,
Frontend, Backend, QA, Review, Security, DevOps, Documentation, Release) are the
visible catalogue. Detailed specialists are harness/prompt overlays, not extra
top-level agents.

When asked to review, use the orthogonal review skill rather than a single
generic pass. Report findings by angle, list coverage, and state unchecked areas.

Next.js rules for this package follow.

@AGENTS.md
