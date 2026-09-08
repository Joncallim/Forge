# Forge web app — Claude context

Claude Code is a **runtime/provider** in Forge, not a separate agent taxonomy.
Forge has one runtime-neutral model shared by Claude Code, Codex, API providers,
and local models.

Read:

- `../AGENTS.md` — shared repository instructions and current runtime boundary.
- `../.ai/skills/orthogonal-review.md` — default review protocol whenever Jonathan
  asks to review code, implementation, a PR, a fix, or a task.
- `../docs/adr/0014-forge-vnext-general-agent-runtime.md` — product-wide VNext
  ontology and invariants.
- `../docs/forge-vnext-architecture.md` — accepted target architecture and phase order.
- `../docs/adr/0007-forge-agent-workforce-model.md` — current coding/Software
  Engineering role taxonomy beneath the broader VNext model.

Do not treat `.codex/agents` as the product source of truth; current app agents
are editable database records. Architect/Product/UX/Frontend/Backend/QA/Review/
Security/DevOps/Documentation/Release are coding/Software Engineering roles, not
a closed universal role catalogue for every future VNext Workforce.

Do not infer future capability from the roadmap. The current web beta keeps
specialist execution and host-repository writes fail-closed until the supported
OS-enforced confined writer is implemented and proven. A feature flag request is
not authority.

When asked to review, use the orthogonal review skill rather than a single generic
pass. Use full mode for PR/implementation/merge or risky work; reserve quick mode
for trivial or explicitly narrow checks. Report evidence, severity,
blocking/advisory disposition, confidence, coverage, and unchecked areas. Review
is read-only unless fixes are explicitly requested and does not replace normal
gates or human approval. Reviewer/Security/Adversarial model output is evidence,
not an allow decision that can widen execution authority.

Next.js rules for this package follow.

@AGENTS.md
