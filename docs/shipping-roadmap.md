# Forge Shipping Roadmap

Last updated: 2026-06-18

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
- Product-design audit lens: used for repo-level UX risks. A screenshot-backed
  UI audit should be run once seeded runtime data and a target viewport matrix
  are available.

## Resolved In This Pass

- Production build no longer prerenders DB-backed dashboard routes.
- Next.js proxy convention replaces deprecated `middleware.ts`.
- Redis singleton no longer tries to connect during import-time build analysis.
- Lint now passes with current client-fetch dashboard architecture.
- Stale test comments and unused symbols no longer produce false bug signals.
- Web CI now gates lint, typecheck, tests, and production build.

## P0 Before Helper-Stage Beta

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
