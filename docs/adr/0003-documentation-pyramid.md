# ADR 0003: Documentation Pyramid — Enforcement Mechanism

## Status

Proposed

## Context

Issue #31 asks that Forge documentation serve three audiences at once — business
user, operator, developer — via a 4-layer structure (Plain-English Summary →
Operational Understanding → Technical Details → Reference Material), so any
reader can stop once their question is answered without losing technical depth
for those who keep reading.

The issue itself is a standard, not code. The open question is the enforcement
mechanism: a new agent under `.claude/agents/`, a style guide, a lint check, or
some combination. `docs/` currently holds 12 docs of widely varying density
(`ux-audit.md` at 65 lines, `UI_REFERENCE_STACK.md` at 417), several of which
already informally lead with plain English (README, `worker-process.md`) but
without a consistent, checkable layer boundary.

This is a solo-maintained open-source project. The mechanism must be cheap to
apply and cheap to maintain — not a process that itself becomes tech debt.

## Decision

**Both, but staged: style guide first, agent second, gated on pilot success.**

1. Add `docs/STYLE_GUIDE.md` — a standalone reference encoding the 4-layer
   pyramid, the audience model (Reader A/B/C), the documentation smells list,
   and the rewrite process from issue #31, adapted to this repo's existing
   Markdown conventions (no front matter, plain headers, as seen across
   `docs/*.md`).
2. Add `.claude/agents/documentation.md` as a new specialist agent, following
   the exact structural convention of `architect.md`: YAML front matter with
   `name`, `description`, `model`, and the provider-alternatives comment
   block; then a Responsibilities / Output Format / Right-Sizing /
   Constraints body. Its operating instructions point to
   `docs/STYLE_GUIDE.md` as the source of truth rather than duplicating the
   pyramid inline — so the standard has one canonical home and the agent
   definition stays short.
3. Update `CLAUDE.md`'s agent table to add the `documentation` row, consistent
   with how the other six agents are listed.

A standalone style guide alone would leave the standard unenforced — nothing
in the current PM workflow (Architect → Backend/Frontend → QA → Reviewer)
would naturally apply it. An agent alone, with the pyramid only living inside
the agent's prompt, would make the standard invisible to humans writing docs
by hand and to other agents (Architect, Backend) who touch docs/ incidentally.
Both artifacts, with the agent deferring to the guide, gets us enforcement
without duplication.

## Alternatives Considered

- **Lint-style automated check** (e.g. a script asserting H2 section titles
  match layer names). Rejected for this slice — the pyramid is a structural
  and tonal judgment call (is this sentence "plain English"?), not a
  pattern-matchable rule. Worth revisiting only if the pilot proves the layer
  boundaries are consistent enough to be machine-checkable.
- **Style guide only, no agent.** Rejected: nothing in the existing workflow
  invokes a style guide proactively; it would sit unused like an unreferenced
  CONTRIBUTING.md section.
- **Agent only, pyramid defined inline in the agent file.** Rejected: makes
  the standard agent-only, harder for a human contributor to read or apply by
  hand, and couples the standard's definition to one agent's prompt.

## Pilot Scope

One PR, two files:

1. `.claude/agents/documentation.md` (new agent, per Decision #2).
2. `docs/STYLE_GUIDE.md` (new style guide, per Decision #1).
3. Rewrite **`docs/worker-process.md`** as the worked example.

**Why `worker-process.md`:** it is the doc most likely to be a new
contributor's or operator's first deep dive into "how does Forge actually run
a task" — more central to the mental model than a leaf reference doc like
`database-migrations.md`, and denser/more jargon-mixed than the README (it
moves from "the worker picks up tasks" straight into queue names, job state
machines, and event publishing within a few paragraphs, with no layer
boundary). It is also short enough (284 lines) to rewrite in one sitting,
unlike `UI_REFERENCE_STACK.md` (417 lines, lower-traffic).

## Acceptance Criteria for the Pilot

- A non-technical reader can answer "what does the worker do and why does it
  exist?" from Layer 1 alone, within the first 100 words, without reading
  further.
- An operator can find "how do I run a worker locally / what happens if it's
  down" in Layer 2 without reading Layer 3.
- A developer can still find the exact queue names (`forge:tasks`,
  `forge:approvals`), state transitions, and API routes in Layer 3/4 — no
  technical content present in the current doc may be dropped, only
  relocated.
- The four layers are visually distinguishable (clear `##` headers naming the
  layer or its intent) so a reviewer can check boundary placement by skimming
  headers alone.

## Consequences

- Positive: establishes one canonical, reusable standard; the agent definition
  stays small because it delegates to the guide; CLAUDE.md's agent table
  changes by exactly one row.
- Negative: yet another agent definition to keep in sync if the pyramid
  evolves (mitigated by the agent deferring to the guide rather than
  duplicating it).
- Explicitly out of scope: rewriting any other doc in `docs/` or the README.
  A full-repo pass is follow-on work, gated on the pilot rewrite being
  reviewed and accepted.

## Open Questions for Repo Owner

1. Should the Documentation agent be invoked automatically whenever an
   Architect/Backend/Frontend/DevOps PR touches `docs/`, or only on explicit
   request? (Affects whether this becomes a workflow step in `CLAUDE.md`'s
   Decision Rules section.)
2. Should layer-boundary enforcement ever become a lint check, or is
   Reviewer-agent/human judgment sufficient indefinitely given project size?
3. Does the README count as in-scope for a *second* pilot once
   `worker-process.md` is accepted, or does it stay hand-tuned outside the
   pyramid given it already reads reasonably well today?
4. Should `docs/STYLE_GUIDE.md` also govern code comments / inline agent
   prompts, or strictly `docs/`-tree Markdown?

## Task Breakdown

1. `[Architect]` — this ADR (done).
2. `[Backend]` or `[Frontend]` — n/a, this is a docs-only slice; no
   application code changes.
3. `[Reviewer]` — write `docs/STYLE_GUIDE.md` content and
   `.claude/agents/documentation.md`, following `architect.md`'s structural
   convention (front matter + Responsibilities/Output Format/Right-Sizing/
   Constraints), then rewrite `docs/worker-process.md` using the new layers.
   *(Assigning the drafting work to Reviewer or a human, not Architect, since
   it is prose authorship rather than system design — PM's call at
   dispatch time.)*
4. `[Reviewer]` — audit the rewritten `worker-process.md` against the
   Acceptance Criteria above before merge.
