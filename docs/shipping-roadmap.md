# Forge Shipping Roadmap

Last updated: 2026-06-19

## Release Target

Ship Forge first as a helper-stage beta:

- The web app is the control plane for projects, providers, agents, tasks, run
  logs, artifacts, and approvals.
- The worker is the execution plane for queued tasks.
- The current worker scope is architect planning plus human approval. Repository
  edits, specialist implementation agents, test execution, commits, and GitHub
  pull requests are the next product stage.

## Assessment Inputs

- Repository docs: `README.md`, `web/README.md`, `CLAUDE.md`,
  `docs/agent-recommendations.md`, and `docs/worker-process.md`.
- App/runtime files under `web/app`, `web/lib`, `web/worker`, and `web/db`.
- Release checks: `npm run lint`, `npx tsc --noEmit`, `npm test`, and
  `npm run build` from `web/`.
- Product-design audit lens: used for repo-level UX risks. The screenshot-backed
  helper-stage audit is enforced by Playwright and summarized in
  `docs/ux-audit.md`.

## Resolved In This Pass

- Production build no longer requires `DATABASE_URL` or `REDIS_URL` during
  Next.js route analysis; both clients are resolved lazily at runtime.
- First-user registration now takes a short Redis lock before creating the
  account, closing the concurrent registration race.
- Task creation now validates that the target project exists and is not
  archived before inserting or enqueuing work.
- Task approval, rejection, cancellation, worker task claims, and approval
  completion now use conditional status updates to avoid stale check-then-write
  races.
- Task creation tests cover the missing-project no-enqueue path.
- Production build no longer prerenders DB-backed dashboard routes.
- Next.js proxy convention replaces deprecated `middleware.ts`.
- Redis singleton no longer tries to connect during import-time build analysis.
- Lint now passes with current client-fetch dashboard architecture.
- Stale test comments and unused symbols no longer produce false bug signals.
- Web CI now gates lint, typecheck, tests, production build, and the
  helper-stage E2E smoke path.

## P0 Before Helper-Stage Beta

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

Release 1 is the helper-stage beta described above. The app is ready for a
single-operator beta when the deployment checklist is satisfied and the release
gates pass in the target environment.

Security:

- Passkey-backed single-operator registration is gated after the first user and
  protected against concurrent first-user creation.
- Route handlers require a valid session before project, provider, agent, task,
  and run-stream access.
- Agent prompt file writes are limited to allowlisted agent types.
- Secrets are stored as environment-variable names, not provider key values.
- Dependency audit is clean as of the latest local run. Ollama now routes
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
- Full retry, dead-letter, stuck-job recovery, and structured attempt history
  remain P1 hardening work.

Sustainability:

- The roadmap, deployment checklist, worker process notes, and UX audit are the
  source of truth for the helper-stage release.
- Large dashboard page decomposition and server-owned initial dashboard data are
  intentionally left in P1.

User experience:

- The helper-stage path is documented and smoke-tested from setup through
  approval/completion.
- Missing-project task submission now returns a clear 404 instead of an
  internal error.
- Long-label, deep mobile navigation, long-artifact, and degraded-state visual
  checks remain UX follow-up items from `docs/ux-audit.md`.

## Latest Gate Results

Run from `web/` on 2026-06-19:

```bash
npm run lint              # pass
npx tsc --noEmit          # pass
npm test                  # pass, 38 tests
npm run build             # pass
npm audit --audit-level=moderate  # pass, 0 vulnerabilities
```

## P1 Product Hardening

1. Break up the largest dashboard pages:
   `providers/page.tsx`, `agents/page.tsx`, and `tasks/[id]/page.tsx`.
2. Move mutable dashboard data loading toward server-owned initial data plus
   focused client refreshes, then re-enable the React compiler
   `set-state-in-effect` lint rule.
3. Improve worker recovery:
   retries, dead-letter queues, stuck-job recovery, cancellation checks between
   major steps, and structured task attempt history.
4. Add observability:
   structured logs, health/readiness endpoints for worker dependencies, and
   task/run correlation IDs.
5. Add permission checks around project/task access once multi-user behavior is
   productized beyond local operator usage.

## P2 Autonomous Coding Stage

1. Add repository checkout and branch management.
2. Dispatch backend, frontend, QA, devops, and reviewer stages using the same
   per-agent provider mapping as the architect stage.
3. Persist implementation artifacts, diffs, test output, review comments, and
   final decision logs.
4. Create commits and GitHub pull requests.
5. Add merge/rework gates driven by reviewer and QA outcomes.

## Ongoing Release Gates

Run from `web/` before release:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```
