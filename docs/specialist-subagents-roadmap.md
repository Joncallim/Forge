# Specialist Subagents Roadmap

Forge should support more than one generic Backend, Frontend, QA, DevOps, and
Reviewer agent. The orchestrator should be able to call specialist subagents
with purpose-built prompts, references, tools, and validation rules.

In plain English: instead of asking one broad "frontend agent" to do everything,
Forge should be able to call a web design specialist, an accessibility
specialist, a React implementation specialist, and a performance specialist when
the task calls for them.

## Target Shape

Each subagent should have two pieces:

- **Agent identity**: what the subagent is good at.
- **Agent harness**: how Forge runs it.

The harness should define:

- system prompt,
- allowed tools,
- required skills or reference files,
- input context shape,
- output artifact shape,
- validation checks,
- model/provider preference,
- retry and escalation behavior.

This keeps specialist behavior explicit. The orchestrator picks a harness, runs
it, stores the output, and can hand that output to another specialist.

## Orchestrator Flow

1. Architect breaks the task into work packages.
2. Orchestrator maps each package to one or more specialist subagents.
3. Each subagent receives a bounded context packet:
   task summary, relevant files, constraints, previous artifacts, and acceptance
   criteria.
4. Subagents return structured artifacts, not only prose.
5. Reviewer and QA subagents validate outputs before merge or approval.
6. The orchestrator records every run in `agent_runs` and stores artifacts for
   review.

The first implementation can run subagents sequentially. Parallel execution can
come later when artifact merging and conflict handling are reliable.

Current Orchestrator-stage behavior teaches the Architect to detect the broad software
type, adopt a matching design persona, and include specialist handoffs in the
Markdown plan. It also attaches web research context by default so non-coding
specialists, such as marketing, documentation, release, or product agents, are
not treated as second-class citizens.

## Initial Specialist Catalog

| Area | Specialist subagent | Main job |
|---|---|---|
| Product | Product planner | Clarify user outcome, scope, acceptance criteria. |
| Product | Requirements analyst | Turn vague tasks into testable requirements. |
| UX | UX flow designer | Design screen flow, states, and interaction behavior. |
| UX | Accessibility specialist | Check keyboard, screen reader, contrast, and semantics. |
| Frontend | Web design specialist | Produce polished layout, hierarchy, responsive behavior, and design-system fit. |
| Frontend | React implementation specialist | Implement React/Next.js components and state safely. |
| Frontend | Design system specialist | Keep components, tokens, spacing, and patterns consistent. |
| Frontend | Frontend performance specialist | Reduce bundle cost, render churn, and client-side bottlenecks. |
| Frontend | Animation/motion specialist | Add restrained motion where it improves clarity. |
| Backend | API specialist | Design and implement route handlers, validation, and contracts. |
| Backend | Database specialist | Handle schema, migrations, queries, and data integrity. |
| Backend | Auth/security specialist | Review auth flows, secrets, authorization, and abuse cases. |
| Backend | Integration specialist | Connect external APIs, webhooks, and provider clients. |
| QA | Unit test specialist | Add focused unit and contract tests. |
| QA | E2E test specialist | Add Playwright paths for user workflows. |
| QA | Regression specialist | Reproduce bugs and guard against repeat failures. |
| DevOps | CI specialist | Maintain GitHub Actions and release gates. |
| DevOps | Local install specialist | Maintain install, uninstall, doctor, and setup scripts. |
| DevOps | Deployment specialist | Prepare production runtime, env, health checks, and rollback notes. |
| Review | Code reviewer | Find correctness, maintainability, and regression risks. |
| Review | Security reviewer | Focus on auth, data exposure, dependency, and injection risks. |
| Docs | Documentation specialist | Update README, operator docs, and migration notes in plain English. |
| Release | Release manager | Summarize changes, gates, risks, and rollout order. |

This catalog should be data-driven so new subagents can be added without
hard-coding orchestration logic.

## Example Harness: Web Design Specialist

Purpose:

- Turn product requirements into a polished, usable frontend experience.
- Respect the existing design system and application conventions.
- Catch layout, responsive, accessibility, and visual-quality issues before
  implementation is considered complete.

Harness inputs:

- task brief,
- current screenshots or route descriptions,
- relevant component files,
- design-system references,
- target user and workflow,
- acceptance criteria.

Harness prompt should include:

- domain-specific UI guidance,
- responsive layout expectations,
- accessibility expectations,
- existing component conventions,
- instructions to avoid marketing-style layouts for operational tools,
- expected artifact format.

Expected outputs:

- UI implementation plan,
- component/file change list,
- interaction states,
- responsive notes,
- accessibility checklist,
- visual QA checklist.

Validation:

- build and lint pass,
- Playwright screenshot check for key viewports when UI changed,
- no text overlap,
- keyboard navigation works for new controls,
- color and spacing match the local design system.

## Data Model Direction

Add a subagent registry instead of expanding a fixed enum forever.

Potential tables:

- `agent_harnesses`
  - `id`
  - `slug`
  - `display_name`
  - `category`
  - `description`
  - `system_prompt`
  - `tool_policy`
  - `reference_paths`
  - `output_schema`
  - `default_provider_config_id`
  - `is_active`
- `agent_harness_runs`
  - `id`
  - `task_id`
  - `harness_id`
  - `status`
  - `input_summary`
  - `artifact_id`
  - `started_at`
  - `completed_at`
  - `error_message`

The current `agent_configs` table can remain as the simple role-level config
while this is introduced. Later, role configs can point to default harnesses.

## Orchestration Rules

The orchestrator should choose subagents by capability, not by a fixed stage
name. A task can call several specialists from the same area.

Examples:

- "Redesign the setup wizard" should call UX flow, web design, React
  implementation, accessibility, E2E QA, and reviewer.
- "Add password reset" should call requirements, auth/security, API, database,
  React implementation, unit test, E2E test, and security reviewer.
- "Speed up dashboard loading" should call frontend performance, backend/API,
  database, regression QA, and reviewer.

The orchestrator should store why each specialist was selected. That makes run
history understandable and helps improve routing later.

## Rollout Plan

1. Define the harness schema in code with static seed data.
2. Add a read-only Subagents page showing available harnesses.
3. Teach the Architect to produce work packages with requested capabilities.
4. Add an orchestrator dispatcher that maps capabilities to harnesses.
5. Run one specialist after Architect, initially behind a feature flag.
6. Store specialist artifacts and show them on the task page.
7. Add reviewer and QA gates before any generated code can be accepted.
8. Move from static harnesses to editable harnesses after the fixed path is
   reliable.

## Risks

- Too many specialists can make simple tasks slow and expensive.
- Weak routing can call the wrong specialist and create noise.
- Parallel subagents can produce conflicting changes.
- Long prompts and broad context packets can hide the actual requirement.
- Editable harnesses need guardrails so a bad prompt cannot bypass review.

## Guardrails

- Start with a small enabled subset.
- Require every specialist to return structured artifacts.
- Keep context packets bounded and explicit.
- Run tests after implementation specialists.
- Require reviewer sign-off before merge or user approval.
- Track cost, duration, and failure rate per harness.

## Agent Role Self-Evaluation (web-search backed)

The orchestrator can evaluate its configured agents and recommend the best model
for each role (`web/lib/agent-evaluation.ts`, exposed at
`POST /api/agents/evaluate` and surfaced as "Re-evaluate roles" on the Agents
page).

- **Web search.** The evaluation reuses the architect's `buildWebResearchContext`
  (`web/worker/architect-context.ts`) so recommendations can reflect current
  model-capability information instead of a static table. Web research is
  best-effort and degrades gracefully when no search provider is configured.
- **Structured output.** The model returns a validated JSON array of
  `{ agentType, recommendedProviderConfigId, recommendedModelId, rationale,
  confidence }`; malformed output is rejected before anything is shown or applied.
- **Minimal-token provider test command.** `npm run test:providers`
  (`web/scripts/test-providers.ts`) reuses the same 1-output-token, 3-second
  health probe as the Providers page to verify every active provider for
  effectively $0, and exits non-zero on failure for CI. See
  [orchestrator-model-install-test.md](orchestrator-model-install-test.md).
