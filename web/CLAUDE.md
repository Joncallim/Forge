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

When asked to review, use the orthogonal review skill rather than a single generic
pass. Use full mode for PR/implementation/merge or risky work; reserve quick mode
for trivial or explicitly narrow checks. Report evidence, severity,
blocking/advisory disposition, confidence, coverage, and unchecked areas. Review
is read-only unless fixes are explicitly requested and does not replace normal
gates or human approval.

Next.js rules for this package follow.

@AGENTS.md
