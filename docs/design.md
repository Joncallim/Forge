# Forge Design Guide

This guide holds the product model, UI direction, screenshot evidence, and
visual QA notes for Forge.

## Plain-English Summary

Forge should feel like managing a small AI software team, not chatting with one
assistant. Every screen should make it clear what is happening, why it is
happening, what needs attention, and what decision the human should make next.

The UI must also be honest about the current beta boundary. Planning,
approvals, provider health, artifacts, and sandboxed Workforce records can be
shown as present capability. Host-repository writes, PR automation, merge
automation, live specialist MCP grants, and parallel execution should be framed
as future or gated behavior unless the implementation changes.

## Product Model

Primary workflow:

```text
Brief -> Plan -> Architecture -> Work Package -> Agent Run -> Review -> Ship
```

Core objects:

| Object | Meaning |
|---|---|
| Project | A repository or software initiative with persistent context |
| Brief | The human-written intent |
| Orchestration plan | The PM layer that scopes goals, risks, and acceptance criteria |
| Architecture plan | The technical direction for components, data, interfaces, and sequencing |
| Work package | A scoped unit that can be assigned to an agent or harness |
| Agent run | One execution attempt by a worker |
| Review | The human decision point with evidence |
| Ship | Commit, PR, merge, deploy, or export |

## UI Direction

Forge is an operational tool. The design target is closer to Linear, Vercel,
Raycast, GitHub pull requests, and Datadog than a marketing website.

Use:

- Clear state over decoration.
- Information density over empty whitespace.
- Evidence over conversation.
- Split-pane workflows where they reduce page hopping.
- Tables for dense operational data.
- Compact cards only when grouping repeated items.
- Color only where it carries meaning.
- CSS-first motion only for useful state changes.

Avoid:

- Giant empty cards.
- Decorative gradients.
- Chat-only workflows for complex work.
- Vague AI sparkle visuals.
- Agent names without state, output, or accountability.
- Hiding diffs, logs, tests, or failures behind too many clicks.

## Required Screens

| Screen | Purpose |
|---|---|
| Command Center | Show active projects, running agents, queue status, blocked tasks, review items, recent shipped work, and provider health |
| Project Workspace | Show repository, objective, docs, tasks, agent runs, decisions, risks, and recent PRs |
| Task Workspace | Show brief, requirements, plan, files touched, diffs, tests, logs, reviewer notes, and approval actions |
| Agent Workspace | Show identity, model/provider, state, workspace/branch, token/cost/time, logs, output, retry/fork/stop controls |
| Skill And Persona Library | Show available skills, personas, commands, source, project fit, and update status |

## Screenshot Use

Use screenshots when they help a reader understand a workflow state faster than
prose:

- Setup wizard: first-run provider choice.
- Provider review: configured provider health and local discovery.
- Task awaiting approval: the human checkpoint after Architect planning.
- Completed Orchestrator task: the approved beta-stage endpoint.

Keep screenshots grounded in real UI states. Do not use decorative mockups for
operator or developer docs.

## Screenshot Evidence

Last refreshed: 2026-06-24.

The checked-in screenshots under `docs/assets/gui/` are documentation evidence.
The release gate remains the automated Playwright smoke test, which starts the
app with a mock Architect and verifies setup, provider presets, project
creation, task execution, approval, and completion.

| State | Desktop | Mobile |
|---|---|---|
| Setup wizard | <img src="assets/gui/desktop-01-setup.png" alt="Desktop setup wizard" width="420"> | <img src="assets/gui/mobile-01-setup.png" alt="Mobile setup wizard" width="220"> |
| Providers after preset | <img src="assets/gui/desktop-02-providers.png" alt="Desktop providers page" width="420"> | <img src="assets/gui/mobile-02-providers.png" alt="Mobile providers page" width="220"> |
| Task awaiting approval | <img src="assets/gui/desktop-03-task-awaiting-approval.png" alt="Desktop task awaiting approval" width="420"> | <img src="assets/gui/mobile-03-task-awaiting-approval.png" alt="Mobile task awaiting approval" width="220"> |
| Task completed | <img src="assets/gui/desktop-04-task-completed.png" alt="Desktop task completed" width="420"> | <img src="assets/gui/mobile-04-task-completed.png" alt="Mobile task completed" width="220"> |

## Visual QA Notes

Recheck these after major UI changes:

- Long provider and model labels at mobile width.
- Mobile bottom navigation from deep scroll positions.
- Long Architect artifacts on the task detail page.
- Empty, loading, failed, and degraded-provider states.
- Workforce panels when persisted planning records are visible.
- Agent configuration pages if prompt or harness editing changes.

## Reference Stack

Use these references as taste and workflow input, not as copy targets:

- Linear for task clarity and compact hierarchy.
- Vercel for deployment and status polish.
- Raycast for fast command surfaces.
- GitHub pull requests for review and diff workflows.
- Datadog and Retool for operational dashboards.
- Anthropic Skills for skill packaging ideas.
- Superpowers and BMAD for disciplined AI delivery workflow ideas.
- Claude Squad for concurrent worker UX ideas.
- Archon for project knowledge and task context ideas.
