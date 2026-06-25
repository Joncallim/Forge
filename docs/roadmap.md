# Forge Roadmap

Last updated: 2026-06-25

## Plain-English Summary

Forge is in an Orchestrator-stage beta. The web app is the control plane for
projects, providers, agents, tasks, run logs, artifacts, and approvals. The
worker is the execution plane for queued tasks.

Today, the worker runs the Architect planning stage, saves a Markdown plan,
asks follow-up questions when needed, and pauses for human approval. It does
not yet edit repositories, run implementation specialists, execute tests,
create commits, open pull requests, or merge work.

The next product stage is the Workforce architecture: durable work packages,
specialist harnesses, explicit approval gates, and eventually safe repository
execution.

## Operational Understanding

### Release 1: Orchestrator-Stage Beta

Release 1 is ready for single-operator beta use when the deployment checklist is
satisfied and the release gates pass in the target environment.

Completed P0 scope:

1. End-to-end smoke test for registration/login, setup wizard preset, provider
   health, project creation, task enqueue, worker Architect run, artifact
   display, approval, and completion.
2. Deployment checklist for the workspace env file, database migrations, Redis,
   worker startup, provider keys, passkey RP values, and workspace prompt paths.
3. Startup/runtime validation for missing critical environment variables with
   clear operator-facing errors.
4. Screenshot-backed UX audit using representative seeded projects, providers,
   tasks, artifacts, and failure states.

Security posture:

- Single-operator registration is gated after the first user and protected
  against concurrent first-user creation.
- Route handlers require a valid session before project, provider, agent, task,
  and run-stream access.
- Agent prompt file writes are limited to safe agent slugs and the configured
  agent prompt directory.
- Secrets are stored as environment-variable names or encrypted app settings,
  not raw provider key values in ordinary records.

Stability posture:

- Production build passes without live PostgreSQL or Redis environment
  variables.
- Task creation rejects missing or archived projects before queueing.
- Task lifecycle writes use conditional transitions for user actions and worker
  claims.
- Worker retry, dead-letter, stuck-job recovery, and structured task attempt
  history have a first implementation.

Current UX follow-up:

- Long-label, deep mobile navigation, long-artifact, Workforce panel, and
  degraded-state visual checks remain tracked in `docs/design.md`.

### Release Gates

Run from `web/` before release:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Latest recorded local gate result, from 2026-06-24:

```bash
npm run lint              # pass
npx tsc --noEmit          # pass
npm test                  # pass, 187 tests
npm run build             # pass, with existing Turbopack NFT trace warning
```

## Technical Details

### P1 Product Hardening

1. Break up the largest dashboard pages:
   `providers/page.tsx`, `agents/page.tsx`, and `tasks/[id]/page.tsx`.
2. Move mutable dashboard data loading toward server-owned initial data plus
   focused client refreshes, then re-enable the React compiler
   `set-state-in-effect` lint rule.
3. Continue worker recovery hardening:
   expand retry policy tests, add richer cancellation checks between major
   steps, and use task attempt history for operator diagnostics.
4. Add observability:
   structured logs, health/readiness endpoints for worker dependencies, and
   task/run correlation IDs.
5. Add permission checks around project/task access once multi-user behavior is
   productized beyond local operator usage.

### P2 Workforce And Autonomous Coding

Forge should support more than one generic Backend, Frontend, QA, DevOps, and
Reviewer agent. Instead of asking one broad "frontend agent" to do everything,
Forge should be able to call a UX flow designer, web design specialist,
accessibility specialist, React implementation specialist, and performance
specialist when the task calls for them.

Adopt an editable workforce model:

1. Keep seeded defaults for Architect, Backend, Frontend, QA, Reviewer, DevOps,
   Documentation, and Adversarial, but do not treat that list as the full app
   catalog.
2. Let users add more agents and assign them to editable workforces.
3. Add specialist harnesses as routing/config overlays where a reusable run
   contract is needed. Examples: `react-implementation`, `e2e-test`,
   `security-review`, and `adversarial-review`.
4. Materialize Architect output into durable work packages with dependencies,
   required capabilities, assigned role, optional harness, input artifact IDs,
   output artifact IDs, and acceptance criteria.
5. Keep PostgreSQL authoritative. Redis should carry wake-up jobs, retry
   scheduling, and dead-letter transport, not orchestration truth.

Target task lifecycle:

```text
pending
  -> running(planning)
  -> awaiting_answers?
  -> awaiting_plan_approval
  -> running(executing)
  -> awaiting_review
  -> awaiting_final_approval
  -> completed
```

Target work package lifecycle:

```text
pending -> ready -> running -> blocked -> needs_rework -> completed -> failed -> cancelled
```

Approval gates:

- Plan approval before repository writes.
- Tool/MCP approval when requested capabilities are unavailable or high-risk.
- QA gate after implementation packages.
- Reviewer gate before final approval.
- Final human approval before merge.
- Security reviewer required for auth, secrets, payments, data access, GitHub
  token handling, or arbitrary filesystem execution.

### Specialist Harnesses

Each subagent has two pieces:

- Agent identity: what the subagent is good at.
- Agent harness: how Forge runs it.

A harness defines:

- system prompt,
- allowed tools,
- required skills or reference files,
- input context shape,
- output artifact shape,
- validation checks,
- model/provider preference,
- retry and escalation behavior.

The orchestrator flow:

1. Architect breaks the task into work packages.
2. Orchestrator maps each package to one or more specialist harnesses.
3. Each specialist receives a bounded context packet: task summary, relevant
   files, constraints, previous artifacts, and acceptance criteria.
4. Specialists return structured artifacts, not only prose.
5. QA and Reviewer validate outputs before merge or final approval.
6. The orchestrator records every run and stores artifacts for review.

Initial specialist catalog:

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

Example web design harness:

- Inputs: task brief, current screenshots or route descriptions, relevant
  component files, design-system references, target user and workflow, and
  acceptance criteria.
- Outputs: UI implementation plan, component/file change list, interaction
  states, responsive notes, accessibility checklist, and visual QA checklist.
- Validation: build and lint pass, Playwright screenshot check for key
  viewports, no text overlap, keyboard navigation for new controls, and local
  design-system fit.

### Workforce Data Model Direction

Add a subagent registry instead of expanding a fixed enum forever.

Core tables:

- `agent_harnesses`
  - `id`
  - `slug`
  - `role`
  - `display_name`
  - `category`
  - `description`
  - `system_prompt`
  - `tool_policy`
  - `reference_paths`
  - `output_schema`
  - `validation_checks`
  - `default_provider_config_id`
  - `is_active`
- `work_packages`
  - `id`
  - `task_id`
  - `sequence`
  - `assigned_role`
  - `harness_id`
  - `status`
  - `title`
  - `summary`
  - `inputs`
  - `acceptance_criteria`
  - `required_capabilities`
  - `blocked_reason`
- `work_package_dependencies`
  - `work_package_id`
  - `depends_on_work_package_id`
- `approval_gates`
  - `id`
  - `task_id`
  - `work_package_id`
  - `gate_type`
  - `status`
  - `requested_by_run_id`
  - `decision_by`
  - `decision_reason`
- `vcs_changes`
  - `task_id`
  - `branch`
  - `pr_url`
  - `base_sha`
  - `head_sha`
  - `diff_artifact_id`
  - `merge_status`

`agent_configs` is now an editable agent catalog, and `workforces` plus
`workforce_agents` define reusable teams. Later execution routing should select
from these templates instead of a hardcoded role list.

### Workforce Rollout

First build slice:

1. Add an ADR for two-tier roles, harness overlays, state machine, approval
   gates, and Redis/Postgres ownership boundaries.
2. Add schema and migrations for harnesses, work packages, dependencies,
   approval gates, VCS change records, and `agent_runs` extensions.
3. Materialize the latest Architect artifact metadata into read-only
   `work_packages`, behind a feature flag where execution behavior is involved.
4. Show work packages, gates, and VCS summary on the task detail page.
5. Keep specialist execution, repository writes, commits, PRs, and merges out of
   this slice.

Next execution slices:

1. Add a dispatcher that maps Architect work packages to harnesses by
   capability, not only fixed stage names.
2. Run one safe specialist after Architect, initially sequentially and behind a
   feature flag.
3. Store specialist artifacts and show them on the task page.
4. Add QA and Reviewer gates before generated code can be accepted.
5. Add repository checkout and branch management.
6. Persist diffs, test output, review comments, routing decisions, and final
   decision logs.
7. Create commits and GitHub pull requests.
8. Add merge/rework gates driven by Reviewer and QA outcomes.
9. Move from static harnesses to editable harnesses after the fixed path is
   reliable.

Risks:

- Too many specialists can make simple tasks slow and expensive.
- Weak routing can call the wrong specialist and create noise.
- Parallel subagents can produce conflicting changes.
- Long prompts and broad context packets can hide the actual requirement.
- Editable harnesses need guardrails so a bad prompt cannot bypass review.

Guardrails:

- Start with a small enabled subset.
- Require every specialist to return structured artifacts.
- Keep context packets bounded and explicit.
- Run tests after implementation specialists.
- Require reviewer sign-off before merge or user approval.
- Track cost, duration, and failure rate per harness.

### GitHub Authentication

GitHub authentication must happen in the web UI, and only when the `gh` CLI is
not already authenticated. When the CLI is already logged in, Forge uses that
token and never prompts.

- Phase 1, Personal Access Token: implemented. When the CLI is not
  authenticated, Settings prompts for a PAT, validates it against GitHub, and
  stores it encrypted in `app_settings`. Token resolution order for repository
  operations is stored PAT, then `gh` CLI token, then an allowlisted legacy
  per-project `githubTokenEnvVar` (`GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PAT`, or
  `FORGE_GITHUB_TOKEN`).
- Phase 2, GitHub OAuth device flow: planned. Register a GitHub OAuth app and
  run device-code authorization in the web UI so the user authorizes Forge
  without creating a PAT by hand.

### Install And CLI Experience

The supported local startup path remains:

```bash
bash scripts/install.sh
cd web
npm run dev
```

Current install hardening:

- Cross-platform macOS/Linux installer.
- Preflight checks with `--check`.
- Upgrade path with `--upgrade`.
- Install record so uninstall avoids removing user-owned packages.
- Safe uninstall by default.

Future terminal installer goals:

- Explain each install step in plain English.
- Show progress for slow steps such as Homebrew/Linux package installs,
  `npm install`, migrations, and model downloads.
- Let users choose local AI, cloud AI, or provider setup later.
- Install PostgreSQL and Redis as native local services so Docker is not
  required.
- Keep secrets out of terminal history.
- Write a clear install summary and uninstall record.

The starter CLI command taxonomy is documented in
`docs/cli-command-architecture.md`. The global `forge` launcher is a thin
wrapper over existing install, uninstall, web, and recovery scripts.

## Reference Material

Primary source docs:

- `README.md`
- `AGENTS.md`
- `web/README.md`
- `docs/operator-guide.md`
- `docs/developer-guide.md`
- `docs/design.md`
- `docs/adr/0004-cross-agent-checkpointing.md`
- `docs/adr/0005-workforce-orchestration-graph.md`

Current implementation anchors:

- `web/worker/index.ts`
- `web/worker/runtime.ts`
- `web/worker/queue.ts`
- `web/worker/orchestrator.ts`
- `web/worker/architect-artifact.ts`
- `web/worker/agent-breakdown.ts`
- `web/worker/capability-classification.ts`
- `web/worker/mcp-execution-design.ts`
- `web/db/schema.ts`
