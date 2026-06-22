# Forge Shipping Roadmap

Last updated: 2026-06-22

## Release Target

Ship Forge first as an Orchestrator-stage beta:

- The web app is the control plane for projects, providers, agents, tasks, run
  logs, artifacts, and approvals.
- The worker is the execution plane for queued tasks.
- The current worker scope is architect planning plus human approval. Repository
  edits, specialist implementation agents, test execution, commits, and GitHub
  pull requests are the next product stage.
- The next orchestration stage should support specialist subagents with
  different harnesses: purpose-built prompts, tools, references, output schemas,
  validation checks, and model preferences.
- Install and uninstall tooling are part of the beta quality bar: setup should
  explain what is happening, and uninstall should avoid removing anything the
  user had before Forge.

## Assessment Inputs

- Repository docs: `README.md`, `web/README.md`, `CLAUDE.md`,
  `docs/agent-recommendations.md`, and `docs/worker-process.md`.
- App/runtime files under `web/app`, `web/lib`, `web/worker`, and `web/db`.
- Release checks: `npm run lint`, `npx tsc --noEmit`, `npm test`, and
  `npm run build` from `web/`.
- Product-design audit lens: used for repo-level UX risks. The screenshot-backed
  Orchestrator-stage audit is enforced by Playwright and summarized in
  `docs/ux-audit.md`.

## Resolved In This Pass

- Production build no longer requires `DATABASE_URL` or `REDIS_URL` during
  Next.js route analysis; both clients are resolved lazily at runtime.
- First-user registration uses a short Redis lock before creating the
  account, closing the concurrent registration race.
- Task creation validates that the target project exists and is not
  archived before inserting or enqueuing work.
- Task approval, rejection, cancellation, worker task claims, and approval
  completion use conditional status updates to avoid stale check-then-write
  races.
- Task creation tests cover the missing-project no-enqueue path.
- Production build no longer prerenders DB-backed dashboard routes.
- Next.js proxy convention replaces deprecated `middleware.ts`.
- Redis singleton no longer tries to connect during import-time build analysis.
- Lint passes with current client-fetch dashboard architecture.
- Stale test comments and unused symbols no longer produce false bug signals.
- Web CI gates lint, typecheck, tests, production build, and the
  Orchestrator-stage E2E smoke path.
- Login supports password sign-in and optional passkeys. First-user
  registration can be password-only when `FORGE_PASSKEYS_ENABLED=0`.
- The cross-platform installer supports macOS and Linux from one entrypoint. It
  records what it installs so uninstall helpers can avoid user-owned packages.
- Migration documentation includes a plain-English guide and a README inside the
  migrations folder.
- Specialist subagent planning is captured in
  `docs/specialist-subagents-roadmap.md`.

## P0 Before Orchestrator-Stage Beta

Status: complete as of 2026-06-19.

1. Add an end-to-end smoke test for the main path:
   register/login, setup wizard preset, provider health, project creation, task
   enqueue, worker architect run, artifact display, approval, and completion.
2. Add a deployment checklist covering required environment variables, database
   migrations, Redis availability, worker startup, provider keys, passkey RP
   values, and `FORGE_AGENT_CONFIG_DIR`.
3. Add startup/runtime validation for missing critical env vars with clear
   operator-facing errors.
4. Run a screenshot-backed UX audit on the live app using representative seeded
   projects, providers, tasks, artifacts, and failure states.

## Release 1 Assessment

Release 1 is the Orchestrator-stage beta described above. The app is ready for a
single-operator beta when the deployment checklist is satisfied and the release
gates pass in the target environment.

Security:

- Single-operator registration is gated after the first user and protected
  against concurrent first-user creation. The first account gets password
  sign-in and, when enabled, passkey sign-in.
- Route handlers require a valid session before project, provider, agent, task,
  and run-stream access.
- Agent prompt file writes are limited to allowlisted agent types.
- Secrets are stored as environment-variable names, not provider key values.
- Dependency audit is clean as of the latest local run. Ollama routes
  through the existing OpenAI-compatible provider path instead of the vulnerable
  `ollama-ai-provider` package, and npm overrides pin patched `esbuild` and
  `postcss` versions for nested dependency chains.

Stability:

- Production build passes without live PostgreSQL or Redis env vars.
- `npm audit --audit-level=moderate` reports zero vulnerabilities.
- Task creation rejects missing or archived projects before queueing.
- Task lifecycle writes use conditional transitions for user actions and worker
  claims.
- Unit tests cover API contracts, auth/session behavior, provider registry
  behavior, and SSE streaming.

Scalability:

- The web process and worker process remain separated by Redis queues.
- Duplicate queue delivery is guarded at the task-status layer.
- Worker retry, dead-letter, stuck-job recovery, and structured task attempt
  history now have a first implementation. Broader observability and
  tool-capable execution remain P1/P2 work.

Sustainability:

- The README, deployment checklist, migration guide, install/uninstall guide,
  worker process notes, and UX audit are the source of truth for the
  Orchestrator-stage release.
- Large dashboard page decomposition and server-owned initial dashboard data are
  intentionally left in P1.

User experience:

- The Orchestrator-stage path is documented and smoke-tested from setup through
  approval/completion.
- Missing-project task submission returns a clear 404 instead of an
  internal error.
- Long-label, deep mobile navigation, long-artifact, and degraded-state visual
  checks remain UX follow-up items from `docs/ux-audit.md`.

## Latest Gate Results

Run from `web/` on 2026-06-22:

```bash
npm run lint              # pass
npx tsc --noEmit          # pass
npm test                  # pass, 65 tests
npm run build             # pass
```

## P1 Product Hardening

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

## P2 Autonomous Coding Stage

1. Add a specialist subagent registry and harness model. Each harness should
   define prompt, references, tools, output schema, validation checks, and model
   preference.
2. Add an orchestrator dispatcher that maps Architect work packages to
   specialist capabilities, not only fixed stage names.
3. Start with a small enabled set:
   requirements analyst, web design specialist, React implementation specialist,
   API specialist, database specialist, unit test specialist, E2E test
   specialist, code reviewer, and security reviewer.
4. Add repository checkout and branch management.
5. Persist specialist artifacts, diffs, test output, review comments, routing
   decisions, and final decision logs.
6. Create commits and GitHub pull requests.
7. Add merge/rework gates driven by reviewer and QA outcomes.

See [specialist-subagents-roadmap.md](specialist-subagents-roadmap.md) for the
full plan.

## Ongoing Release Gates

Run from `web/` before release:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```
