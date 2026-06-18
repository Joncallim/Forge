# Forge Helper-Stage UX Audit

Last updated: 2026-06-18

## Scope

This audit covers the helper-stage beta path:

1. first dashboard visit with no providers,
2. setup wizard preset application,
3. provider health review,
4. project creation,
5. task creation,
6. worker-generated architect artifact,
7. approval and completion.

## Screenshot Evidence

The Playwright smoke test captures full-page screenshots for the key states:

| State | Screenshot file |
|---|---|
| Setup wizard | `01-setup.png` |
| Providers after preset | `02-providers.png` |
| Task awaiting approval | `03-task-awaiting-approval.png` |
| Task completed | `04-task-completed.png` |

The CI workflow uploads these files in the `playwright-artifacts` artifact from
`web/test-results`, along with the HTML report in `web/playwright-report`.

The current execution environment cannot run the screenshot test locally because
PostgreSQL/Redis are not running and Docker access is unavailable. The audit is
therefore enforced through CI services, which start PostgreSQL and Redis before
running `npm run e2e`.

## Findings

- The setup wizard is the correct first screen for an unconfigured instance. It
  offers concrete provider presets and avoids sending operators to an empty
  dashboard.
- The Providers page is the right post-preset destination because it exposes
  health and missing-key feedback before a task is submitted.
- Project and task creation use direct, focused dialogs with required fields and
  clear submit states.
- The task detail page exposes the current status, agent run, generated
  artifact, and approval action in one place, which matches the helper-stage
  beta workflow.
- The approval flow has a clear terminal state: after approval, the worker marks
  the helper-stage task `completed` and the generated artifact remains visible.

## Risks To Recheck After Visual Artifact Review

- Long provider/model labels should be checked at mobile width in the Providers
  and Setup views.
- Mobile bottom-tab navigation should be rechecked from deep scroll positions;
  an early CI trace showed page content intercepting the Projects tab click, so
  the smoke test now routes directly to the Projects page.
- The task detail page should be checked with longer architect artifacts to
  ensure review controls remain easy to reach.
- Empty, loading, failed, and degraded-provider states need a second audit pass
  once seeded fixtures cover those states.
