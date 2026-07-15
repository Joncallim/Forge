# Forge Roadmap

Last updated: 2026-07-10

## Plain-English Summary

Forge is in an Orchestrator-stage beta. The web app is the control plane for
projects, providers, agents, tasks, run logs, artifacts, and approvals. The
worker is the execution plane for queued tasks.

Today, the worker runs the Architect planning stage, saves a Markdown plan,
asks follow-up questions when needed, and pauses for human approval.
Workforce materialization and handoff are enabled unless explicitly disabled, so
Architect completion materializes durable work-package and gate state before
`awaiting_approval`; approval releases ready packages. Generated package
execution and local repository writes are default-on. Generated output is kept
inside per-package attempt sandboxes at
`.forge/task-runs/<task-id>/<work-package-id>/attempt-<attempt-number>/`, then
repository-affecting files are applied to the local project after the package execution step.

Issue #119, "Executable Workforce Beta: capability-brokered sequential
specialist execution," is the exact beta boundary for executable packages. It
adds bounded read-only host-repository context, sandbox artifacts, local project
file edits, capability brokerage, manual QA/Reviewer/Security gates, structured
security findings for high-risk work, and precise grant terminology. It applies
local file edits but does not create commits, grant live MCP runtime access,
open pull requests, merge work, run autonomous reviewer agents, or run
specialists in parallel.

After sequential sandboxed Workforce execution is reliable, the next major
product direction is **Forge Workspace**: a dockable, AI-assisted workbench that
brings browser, repo, notes, docs, Playwright, Notion, GitHub, terminals, logs,
and task artifacts into one saved context. This should feel OS-like over time,
but the product should be framed and implemented as a workspace shell rather
than a full operating system.

Short version: Forge is useful today as a local planning and approval control
room. The current executable milestone is making sequential specialist execution
reliable with sandbox artifacts and local project edits before Forge is trusted
with pull request automation. The following major direction is the Forge
Workspace shell and link graph that preserve context between tools.

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
git diff --check
npm run lint
npx tsc --noEmit --pretty false
npm test
npm run build
```

Latest recorded local validation snapshot, from 2026-07-01. This records gate
command status only; it does not mean final review is complete.

```bash
git diff --check                      # pass
npm run lint                         # pass
npx tsc --noEmit --pretty false      # pass
npm test                             # pass, 48 files, 581 tests
npm run build                        # pass, with known non-fatal Turbopack NFT trace warning
```

The build warning traces through `next.config.ts`,
`worker/repository-evidence.ts`, `worker/work-package-handoff.ts`, and
`worker/orchestrator.ts`, then `worker/runtime.ts` from `instrumentation.ts`.

### Executable Workforce Beta Boundary (#119)

The #119 beta is deliberately narrower than autonomous coding. It proves that
Forge can hand one approved specialist package to a model, collect bounded
read-only host context, write generated output to a package sandbox, and hold
that output behind human review.

In scope:

1. Execute one eligible specialist package at a time after Architect plan
   approval and capability-broker admission.
2. Provide specialists with bounded, inspectable host-repository context. This
   can include a limited file list, selected source/context artifacts, repository
   evidence, previous artifacts, package inputs, acceptance criteria, and rework
   feedback. It is not an unbounded filesystem grant.
3. Write generated files only under
   `.forge/task-runs/<task-id>/<work-package-id>/attempt-<attempt-number>/`.
4. Keep sandbox artifacts visibly separate from host-repository changes,
   branches, commits, and PR output.
5. Store package run artifacts, generated file lists, validation command
   results, repository evidence, blocked reasons, review source artifacts, and
   rework decisions.
6. Require manual QA and Reviewer gates before implementation output is
   accepted. High-risk packages also require a manual Security gate.
7. Require structured security findings for high-risk output, with review
   surface, asset, trust boundary, exploit path, impact, required fix, evidence
   refs, severity, confidence, and verification state.
8. Distinguish grant stages: Architect-proposed grants, Forge broker decisions,
   operator-approved grant snapshots, and effective run-scoped instructions.
9. Treat `agent_harnesses` as planning/routing metadata, not execution policy.

Still out of scope:

- Live MCP runtime grants or credentials for specialists.
- Branch creation, commits, check polling, pull requests, merges, issue
  auto-closure, or release automation.
- Parallel specialist execution.
- User-edited grant scopes.
- Autonomous QA, Reviewer, or Security agent runs as gates.
- Harness-enforced tool policy, reference-path policy, output schema validation,
  or execution policy.
- Default-on package execution before the release gate, documentation, QA,
  Reviewer, Adversarial review, and manual/operator smoke path all pass.

### MCP Execution Readiness and Bounded Context Grants (#172)

The next architecture epic after the #119 beta. MCP ambiguity is now the main
reason an approved task can still stall at handoff, because the same beta
capability policy is re-derived by four divergent code paths (planning
validation, grant preview, handoff broker, and the filesystem grant gate) that do
not agree -- most importantly, plan approval never runs the handoff broker, so a
package can pass approval and then block at handoff.

The epic makes planning, approval, UI state, filesystem grants, and handoff follow
**one admission contract**: a normalized `McpAdmissionDecision` (ADR
[0009](adr/0009-mcp-admission-contract.md)) with a capability `mode`
(`planning_only`, `bounded_context_required`, `bounded_context_approved`,
`blocked`, `deferred_live_mcp`) and a `recoveryAction`, classified from
`MCP_CATALOG` reads plus a documented safe-read supplement. Capabilities resolve
to three classes: planning-only (warn, never block, including
`filesystem.project.write`), bounded read-only
(`filesystem.project.read|list|search`, may need an operator grant -- and only
delivered as a bounded packet where a context producer exists, filesystem today),
and deferred live MCP (live tool handles and write/merge/admin -- a product
boundary, not a broken install). Live MCP tool handles remain out of scope.

Delivered as six sweeping child slices plus #43: #176 (S1 contract/taxonomy),
#177 (S2 consolidation + approval enforcement), #178 (S3 deterministic filesystem
grant/denial recovery), #179 (S4 prompt/context packet evidence), #180 (S5 unified
operator UI copy/recovery-action contract), #181 (S6 end-to-end regression +
preview==handoff invariant), and #43 (Architect-driven MCP assignment/overlays).

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

Current build slice:

1. Add an ADR for two-tier roles, harness overlays, state machine, approval
   gates, and Redis/Postgres ownership boundaries.
2. Add schema and migrations for harnesses, work packages, dependencies,
   approval gates, VCS change records, and `agent_runs` extensions.
3. Materialize the latest Architect artifact metadata into read-only
   `work_packages`, behind a feature flag where execution behavior is involved.
4. Show work packages, gates, and VCS summary on the task detail page.
5. Keep commits, PRs, and merges out of this slice. Work-package handoff,
   execution, and local repository writes are default-on with explicit disable
   flags.

Executable beta epic: #119 Executable Workforce Beta:

1. Route Architect work packages through capability brokerage instead of only
   fixed stage names (#43).
2. Run specialist packages sequentially through the execution path (#60), with
   bounded read-only host-repository context, sandbox artifacts, and local
   project file edits.
3. Store handoff, execution, command, QA, Reviewer, Security, repository
   evidence, rework, and blocked-state artifacts on the task.
4. Add manual QA and Reviewer gates before generated implementation output can
   be accepted. These labels do not imply autonomous reviewer agent execution
   in this beta.
5. Require manual Security gates and structured security findings for auth,
   secrets, filesystem, command execution, MCP/tool grants, GitHub writes,
   repository-write, prompt-injection, data/privacy, and merge-automation work.
6. Preserve rework context: review reasons, source artifacts, attempt numbers,
   stale-gate replacement, and terminal failure handling for repeated package
   failure or rejection.
7. Keep grant states distinct: Architect-proposed grants, Forge broker
   decisions, operator-approved grant snapshots, and effective run-scoped
   instructions.
8. Keep `agent_harnesses` planning-only for this beta. Harness prompts, tool
   policies, reference paths, output schemas, and validation checks are not
   execution policy until a later slice wires them in.
9. Keep MCP runtime grants, commits, PR creation, merge automation,
   user-edited grants, agent-run review gates, harness execution policy, and
   parallel execution out of the beta.

Deferred:

- #69 PR/merge automation waits until sandboxed sequential execution,
  capability brokerage, QA/Reviewer gates, and security review are reliable.
- Repository checkout, branch management, commits, PR creation, and merge/rework
  gates remain future slices after #119.
- Live MCP grant issuance, editable grant scopes, autonomous reviewer agents,
  and harness-enforced execution policy remain future slices after #119.

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

### P3 Forge Workspace And Tool Surfaces

Forge Workspace is the next major product direction after the Workforce beta is
reliable. It should make Forge feel like an AI-assisted workbench without taking
on the scope of a full operating system.

The product frame:

```text
Forge Workspace
  -> dockable panes and saved layouts
  -> browser, Playwright, repo, notes, docs, terminal/logs, Notion, and GitHub
  -> task-scoped link graph
  -> permissioned agent operations
```

The main product principle is context preservation. A Notion spec, GitHub issue,
repo file, Forge task, Playwright run, Markdown plan, terminal log, and review
artifact should be linkable as parts of the same task.

Initial workspace surfaces:

| Surface | Purpose | Boundary |
|---|---|---|
| Human Chromium | User browsing, docs, local previews, auth flows, manual review. | Human-controlled profile. Agents do not silently operate it. |
| Playwright Chromium | Agent automation, screenshots, E2E checks, UI inspection, traces. | Separate task-scoped browser context. |
| Notepad | Task scratchpad, decision notes, temporary checklists. | Local-first Forge record. |
| Markdown reader/editor | README, ADRs, plans, handoff records, review notes. | Repo files and Forge artifacts first. |
| Coding pane | Focused file edits, diffs, and review. | Monaco-based pane first; do not clone a full IDE immediately. |
| Terminal/log drawer | Commands, tests, worker events, browser traces, provider logs. | Bounded execution and artifact capture. |
| Repo explorer | Local and GitHub-backed files, branches, diffs, commits, docs. | Repository remains implementation truth. |
| Notion explorer | Planning pages, project docs, decisions, wiki pages. | Notion remains planning and intent truth. |
| GitHub explorer | Issues, PRs, checks, comments, files, releases. | API-backed pane, linked to tasks/artifacts. |

Implementation sequence:

1. **Workspace shell**: left rail, docked panes, tabs/splits, bottom drawer,
   right inspector, command palette, and saved layouts.
2. **Core panes**: repo explorer, Markdown reader/editor, task notepad, diff
   viewer, terminal/log drawer, and artifact viewer.
3. **Playwright service**: task-scoped Chromium contexts, screenshots, traces,
   page summaries, and run evidence linked to tasks.
4. **Notion/GitHub link graph**: manual links first, then refresh, then
   webhook-backed freshness, then reviewed write-back.
5. **Permissioned agent operations**: agents can read workspace context and
   request capabilities for browser automation, terminal commands, repo writes,
   Notion updates, GitHub comments, branches, and PRs.

Proposed workspace data model additions:

- `workspaces`
- `workspace_layouts`
- `workspace_panes`
- `workspace_links`
- `external_accounts`
- `browser_sessions`
- `browser_runs`
- `sync_events`

`workspace_links` should be the core abstraction. It should link Notion pages,
GitHub repos/issues/PRs/files, local files, Forge tasks, Forge artifacts, and
browser runs with explicit relationship types such as `documents`, `implements`,
`references`, `generated_from`, `evidence_for`, `blocks`, and `closes`.

Sync stance:

- Do not build naive bidirectional Notion/GitHub mirroring.
- Treat Notion as planning, memory, intent, and project rationale.
- Treat repositories as implementation truth.
- Use links, summaries, freshness checks, and explicit write-back approvals.
- Show stale or conflicting linked sources instead of silently overwriting them.

Safety boundaries:

- The human browser profile and Playwright browser profile must stay separate.
- Third-party apps should not depend on iframe embedding as the primary path.
- Agent browser use, terminal commands, repo writes, GitHub mutations, and Notion
  write-back require explicit capabilities and audit records.
- Free-floating desktop-style windows can wait. Start with saved docked layouts.

The detailed implementation plan is in `docs/workspace-roadmap.md`.

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

Planned Epic #172 compatibility boundary:

- Keep today’s macOS/Linux beta install path distinct from the future protected
  local-execution protocol.
- Release-gate that protocol first to Ubuntu 24.04/Linux 6.8+ hosts that pass the
  cgroup/systemd/separate-user/socket preflight.
- On macOS, Windows, same-user development, or an unsupported container, refuse
  protocol-v2 activation, retain a truthful legacy/pre-cutover state, and explain
  migration or adapter options. Never claim the Linux containment guarantee.

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

### ACP Provider Direction

ACP support makes Forge a client for local coding agents rather than only a
client for direct model APIs. The current path uses pinned Agent Client
Protocol adapter packages for Codex CLI and Claude Code:

```text
Forge -> pinned ACP adapter -> local CLI -> logged-in model account
```

This is useful because it lets Forge call tools that already have their own CLI
auth, runtime behavior, and model routing. The cautious boundary is that ACP
currently returns text through Forge's provider interface; it does not yet grant
Forge-managed MCP tools, expose detailed token usage, or make remote repository
automation safe by itself.

Near-term ACP work:

1. Keep readiness errors actionable for missing local adapter binaries, missing
   CLI installs, missing auth, and missing project folders.
2. Expand runtime strategies only after the current Codex CLI and Claude Code
   paths are reliable.
3. Keep ACP-backed package execution tied to the package attempt sandbox and
   Forge-applied execution JSON path guards.
4. Document runtime-specific model-selection behavior instead of promising a
   universal model picker.

## Reference Material

Primary source docs:

- `README.md`
- `AGENTS.md`
- `web/README.md`
- `docs/operator-guide.md`
- `docs/developer-guide.md`
- `docs/wiki.md`
- `docs/workspace-roadmap.md`
- `docs/acp-zed-connector.md`
- `docs/design.md`
- `docs/adr/0004-cross-agent-checkpointing.md`
- `docs/adr/0005-workforce-orchestration-graph.md`
- `docs/adr/0006-executable-workforce-beta-boundary.md`

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
