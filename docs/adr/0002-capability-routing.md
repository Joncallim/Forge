# 0002. Capability classification as a field on the architect's plan output

## Status

Proposed

## Context

Issue #30 proposes evolving Forge from agent-centric orchestration into a
capability-oriented platform: classify required capabilities first, then
assemble the smallest viable Workforce, decompose into Work Orders, execute
on pluggable Worker runtimes (Claude Code, Codex, Goose, humans), and verify
with a tiered Verification Workforce. It also sketches MCP tools
(`create_task`, `get_next_work_order`, etc.) for external runtimes to
participate. The issue is explicitly exploratory and multi-month in scope.

Today's routing model, grounded in the actual code:

- `.claude/agents/*.md` defines a **fixed set** of specialist agents
  (architect, backend, frontend, qa, reviewer, devops). `web/db/seed-agents.ts`
  parses these files' frontmatter into `agent_configs` rows keyed by
  `agentType` — there is no notion of capability, only agent identity.
- `web/worker/orchestrator.ts` (`buildArchitectPrompt`) asks the architect
  model to write a Markdown plan, tag each implementation step with a
  `[Role]` marker drawn from that fixed agent set ("Never invent specialist
  titles"), and append a fenced `agent_breakdown_json` block.
- `web/worker/agent-breakdown.ts` parses that block into
  `{role, tasks, summary, steps}`, falling back to regex-extracting `[Role]`
  tags from the Markdown if the JSON block is missing or malformed.
- Routing is binary and agent-shaped from the start: the architect picks
  *which agents*, never *which capabilities the task needs, independent of
  who provides them*. There is no Workforce, Work Order, or pluggable
  runtime layer anywhere in the codebase.

## Decision

Adopt the issue's core principle — classify capabilities before committing
to agents — but implement only the smallest verifiable slice now. Everything
past that slice is explicitly deferred (see Out of Scope).

**The slice:** add a `capabilities` field to the architect's existing
structured output, alongside `agent_breakdown_json`. No new entities, tables,
runtimes, or routing logic — the field is descriptive metadata attached to
the plan the human already reviews before approval.

1. Extend the architect prompt in `buildArchitectPrompt` to require a third
   fenced block, `capability_classification_json`, of shape:
   ```json
   { "required": ["game-logic", "unit-testing"],
     "optional": ["e2e-testing"],
     "excluded": [{"capability": "seo", "reason": "no public-facing content"}] }
   ```
2. Add a parser in `web/worker/capability-classification.ts` (mirroring
   `agent-breakdown.ts`'s fence-parse-with-fallback pattern) that validates
   against a fixed taxonomy (below) and degrades to `{required: [], optional:
   [], excluded: []}` on parse failure — never blocks plan persistence.
3. Persist the parsed result in the existing `artifacts.metadata` JSON column
   (alongside the `agent_breakdown_json` data already stored there) rather
   than a new table.
4. Surface it as a read-only section in the plan/diff UI
   (`web/components/PlanDiffView.tsx` or wherever the plan is rendered) for
   human review. It does **not** change which agents actually get invoked —
   that remains driven by the existing `[Role]` tags.

This is intentionally inert: it produces a visible classification artifact
without touching execution, so its real-world accuracy can be evaluated
before any routing logic depends on it.

## Alternatives considered

- **Build the full Workforce/Work-Order/Worker-runtime stack now** — rejected.
  This is a solo-maintained project; the issue itself frames this as
  multi-month and exploratory. Building pluggable runtimes and a verification
  tiering system before knowing whether capability classification is even
  accurate is high risk for unproven benefit.
- **Skip capability classification, go straight to capability-driven agent
  selection** — rejected. Today's `[Role]` tagging already works and changing
  which agents get invoked based on an unproven classification step risks
  regressing existing behavior. Ship the artifact first, prove it's reliable,
  then consider wiring it to routing in a follow-on ADR.
- **Free-form capability strings (no taxonomy)** — rejected. Unconstrained
  strings from an LLM will drift and fragment; a fixed v1 list keeps the
  field useful and diffable.

## Capability taxonomy (v1, flat list)

Grouped by existing agent for readability only — the list itself is flat,
agent-agnostic strings:

- Architect: `system-design`, `api-contract-design`, `data-modeling`
- Backend: `api-implementation`, `database-migration`, `business-logic`, `background-jobs`, `service-integration`
- Frontend: `ui-implementation`, `state-management`, `routing`, `api-integration`
- QA: `unit-testing`, `integration-testing`, `e2e-testing`, `coverage-analysis`
- Reviewer: `security-review`, `code-review`, `performance-review`
- DevOps: `ci-cd-config`, `infra-config`, `deployment`

## Task breakdown

1. **[Architect]** Extend `buildArchitectPrompt` with the
   `capability_classification_json` instructions and the fixed taxonomy list;
   define the JSON schema precisely (required/optional/excluded shape above).
2. **[Backend]** Implement `web/worker/capability-classification.ts`
   (parse + validate against taxonomy + fallback), wire it into
   `web/worker/orchestrator.ts` alongside the existing agent-breakdown parse,
   and persist into `artifacts.metadata.capabilityClassification`.
3. **[Frontend]** Render the classification (required/optional/excluded) as a
   read-only block in the plan view component, visually distinct from the
   agent breakdown.
4. **[QA]** Unit tests for the parser (valid JSON, malformed JSON, unknown
   capability strings, missing block) and a snapshot test confirming
   `artifacts.metadata` round-trips the classification.
5. **[Reviewer]** Confirm the new field is additive only — no behavioral
   change to which agents run, no new DB migration, no new dependency.

## Out of scope (deferred to future ADRs, pending this slice's results)

- Workforce abstraction (logical capability groupings as first-class entities)
- Work Orders (bounded delegation units with allowed-files/acceptance-criteria)
- Pluggable Worker runtime layer (Codex, Goose, LangGraph, human operators)
- Verification Workforce tiering (deterministic / consistency / frontier review)
- MCP tool surface (`create_task`, `get_next_work_order`, `submit_artifact`, etc.)

## Acceptance criteria

- Architect plans for new/revised tasks include a `capability_classification_json`
  block validated against the fixed taxonomy.
- Parse failures (malformed JSON, unknown capability strings) never block
  plan persistence or task progression to `awaiting_approval`.
- The classification is visible in the plan UI but provably does not alter
  which `[Role]`-tagged agents are invoked (same task, same agent breakdown,
  with or without the new field).
- At least one excluded capability includes a non-empty justification string
  in test fixtures, proving the schema captures "why excluded."
- No new database table or migration is introduced; the field lives in
  `artifacts.metadata`.

## Open questions

1. Should `excluded` justification text be mandatory (enforced by schema) or
   advisory only? Issue #30 says "should actively justify" but mandatory
   validation adds failure-mode risk to the architect stage.
2. Once this slice ships, what's the bar for moving to phase 2 (capability
   classification actually influencing which agents are invoked)? E.g. N
   tasks reviewed with no human-flagged misclassification?
3. Should the taxonomy be hardcoded in the prompt/parser (this proposal) or
   stored in a DB table editable via the providers/agents admin UI? Hardcoded
   is simpler now; a table matters only if capabilities need to evolve faster
   than code deploys.
4. Is a flat 20-string taxonomy sufficient long-term, or should Product/
   Marketing/Business capabilities from the issue be added now even though no
   corresponding agent exists yet to act on them?
5. Should this classification be versioned per plan revision (so re-running
   the architect after answered questions can show a capability diff), or is
   "latest only" (current `loadLatestPlanArtifact` pattern) sufficient for v1?
