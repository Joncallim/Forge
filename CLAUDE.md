# Forge repository — Claude context

Claude Code is a runtime/provider in Forge, not a separate agent taxonomy.
Forge has one runtime-neutral agent/workforce model shared by Claude Code,
Codex, API providers, and local models.

Read these files first when operating at repository root:

- `AGENTS.md` — shared repository instruction surface and current runtime boundary.
- `.ai/skills/orthogonal-review.md` — default review protocol whenever Jonathan
  asks to review code, implementation, a PR, a fix, or a task.
- `docs/adr/0014-forge-vnext-general-agent-runtime.md` — canonical product-wide
  VNext ontology and invariants.
- `docs/forge-vnext-architecture.md` — accepted target architecture and phase order.
- `docs/adr/0007-forge-agent-workforce-model.md` — coding/Software Engineering
  role taxonomy beneath VNext.
- `web/CLAUDE.md` — web app package context.

Do not infer that accepted VNext architecture already ships. The current web beta
remains coding-focused and specialist/host-repository writes remain fail-closed
until the OS-enforced confined execution boundary is implemented and proven.

When asked to review, do not perform a single generic pass. Use the orthogonal
review skill: full mode for PR/implementation/merge or risky work, and bounded
quick mode only for trivial or explicitly narrow checks. Report evidence,
severity, blocking/advisory disposition, confidence, coverage, and unchecked
areas. Review is read-only unless fixes are explicitly requested and cannot
bypass normal gates or human authority. Never claim that no issues exist; use
scoped verdicts and the skill's explicit "not proof of correctness" caveat.

Reviewers and adversarial/security agents produce evidence. They do not grant
themselves execution authority or replace deterministic Forge/GitHub policy
gates.
