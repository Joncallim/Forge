# Forge UI Reference Stack

This document is the reference stack for improving Forge's UI from workable but ugly into a clear, operator-grade product interface.

Forge should not chase visual novelty. It should feel like a control room for AI engineering work: dense enough for power users, calm enough for review, and structured enough that an operator can see what is running, what is blocked, and what needs a decision.

## Primary UI Direction

Use these as the design target when asking Claude Code to redesign screens:

- Linear for issue/task clarity, keyboard-first flows, tight spacing, and high signal-to-noise.
- Vercel for deployment/status surfaces, clean cards, and developer-console polish.
- Raycast for command palette interaction and quick action flows.
- GitHub Projects for task boards and familiar software-delivery primitives.
- Retool/Datadog for operational dashboards where system state matters more than decoration.

A useful design instruction:

> Act as a senior product designer from Linear, Vercel, Raycast, and Datadog. Redesign Forge as an AI engineering command center. Prioritize clarity, hierarchy, state visibility, fast decisions, and compact workflows. Avoid decorative gradients, oversized cards, vague empty states, and marketing-site styling.

## Recommended Claude / Agent Reference Stack

### 1. Anthropic Skills

Repository: `anthropics/skills`

Use for:

- Official Claude skill structure.
- Document, spreadsheet, slide, and design workflows.
- General reusable skill patterns.
- Source of truth for how Claude-native skills should be packaged.

Forge use:

- Reference this for the internal `skills/` structure.
- Use it when defining Forge-compatible skill packs.
- Use it as the baseline for documentation and workflow ergonomics.

### 2. Superpowers

Repository: `obra/superpowers` or `obra-ai/superpowers` depending on current upstream naming.

Use for:

- Agentic software-development methodology.
- Planning, implementation, testing, and review loops.
- Self-review and disciplined coding-agent behavior.

Forge use:

- Best reference for making Forge feel like a serious development cockpit.
- Use its methodology to shape task lifecycle screens: plan, implement, test, review, merge.
- Use it when designing agent instructions and task templates.

### 3. SuperClaude Framework

Repository: `SuperClaude-Org/SuperClaude_Framework`

Use for:

- Slash-command style workflows.
- Expert personas.
- Thinking modes and reusable commands.

Forge use:

- Reference for Forge command architecture.
- Add personas such as Product Manager, UX Designer, Architect, Frontend Engineer, QA Reviewer, and Release Manager.
- Useful for turning Forge from a queue dashboard into an opinionated command center.

### 4. BMAD Method

Repository: `bmad-code-org/BMAD-METHOD`

Use for:

- PM -> Architect -> Developer flow.
- Structured product requirements and delivery phases.
- Multi-agent software delivery methodology.

Forge use:

- Strong fit for the CEO/CTO/worker model.
- Use this to design Forge's task pipeline:
  - Brief
  - Product clarification
  - Architecture
  - Implementation plan
  - Build
  - Review
  - Ship
- Especially useful for turning vague ideas into scoped work packages.

### 5. Archon

Repository: `coleam00/Archon`

Use for:

- Shared knowledge base.
- Task board.
- Project context for coding agents.
- Repeatable AI coding harnesses.

Forge use:

- Reference for persistent project memory and docs-first workflows.
- Useful when Forge needs richer project context, file maps, architectural notes, and task history.
- Do not blindly copy the UI; use the concept of context-first orchestration.

### 6. Claude Squad

Repository: `smtg-ai/claude-squad`

Use for:

- Running multiple Claude Code agents side by side.
- Isolated workspaces.
- Human review and merge of competing outputs.

Forge use:

- Reference for multi-agent execution UX.
- Useful for showing concurrent workers, isolated branches, terminal sessions, and reviewable outputs.
- Especially useful for future Forge features where multiple agents attempt the same task and the user picks the best result.

### 7. slavingia/skills

Repository: `slavingia/skills`

Use for:

- Positioning, marketing, sales, and shipping product thinking.
- Minimalist Entrepreneur-style product discipline.

Forge use:

- Use for product-market thinking, not UI implementation.
- Helpful for deciding what Forge is for, who it serves, and what should be cut.
- Reference when writing landing-page copy, onboarding, pricing, and user positioning.

## UI / Animation Reference Stack

These are not core orchestration frameworks, but they are useful for improving perceived quality.

### CSS Animations / HyperFrames-style patterns

Use for:

- Subtle card entrance transitions.
- Status changes.
- Queue movement.
- Agent state changes.
- Drawer and command palette transitions.

Forge use:

- Use CSS-first animation wherever possible.
- Keep motion fast, subtle, and operational.
- Good examples: task moves from queued to running; worker goes from idle to active; review panel opens; command palette appears.

Avoid:

- Overanimated dashboards.
- Spinners as decoration.
- Slow transitions that make the product feel heavy.

### Three.js

Repository/site: `three.js`

Use for:

- 3D visualisation.
- Infrastructure maps.
- Container/network topology.

Forge use:

- Optional only.
- Consider later for a visual agent topology map, container map, or infrastructure graph.
- Do not use for the core UI until the basic task, review, and orchestration flows are excellent.

### Flutter Animation References

Use for:

- Native mobile animation ideas.

Forge use:

- Ignore for now unless Forge gets a mobile client.

## What Forge Should Use Now

Immediate priority stack:

1. Anthropic Skills
2. Superpowers
3. BMAD Method
4. SuperClaude Framework
5. Claude Squad concepts for multi-agent execution
6. Archon concepts for knowledge base and task context
7. CSS-first animation polish

Do not start with Three.js. Do not start with mobile-style animation. Do not make the UI look like a SaaS landing page.

## Product Model For Forge

Forge should be built around these primitives:

### Project

A repository or software initiative with persistent context, docs, tasks, agents, settings, and history.

### Brief

A human-written intent. This is the starting point before agents act.

### Orchestration Plan

The CEO/PM layer turns the brief into structured work: goals, constraints, deliverables, risks, and acceptance criteria.

### Architecture Plan

The CTO/Architect layer turns the orchestration plan into technical direction: files, components, data model, interfaces, risks, and sequencing.

### Work Package

A scoped unit of implementation that can be assigned to one or more agents.

### Agent Run

An execution attempt by Claude Code, Codex, OpenCode, or another worker.

### Review

The human decision point. The UI should make it obvious what changed, what passed, what failed, and what needs approval.

### Ship

The final step: commit, PR, merge, deploy, or export.

## Core Screens Forge Needs

### 1. Command Center

Purpose: show what matters now.

Must show:

- Active projects.
- Running agents.
- Queue status.
- Blocked tasks.
- Items awaiting review.
- Recent shipped work.
- Provider health.

Design target: Linear inbox + Vercel deployments + Datadog service status.

### 2. Project Workspace

Purpose: one project, all context.

Must show:

- Repository.
- Current objective.
- Project docs.
- Open tasks.
- Agent runs.
- Decisions.
- Risks.
- Recent commits/PRs.

Design target: GitHub repo page + Linear project + Archon knowledge base.

### 3. Task Detail

Purpose: inspect and approve one piece of work.

Must show:

- Brief.
- Requirements.
- Agent plan.
- Files touched.
- Diff summary.
- Tests/checks.
- Logs.
- Reviewer notes.
- Approve/reject/iterate actions.

Design target: GitHub PR + Claude Code transcript + Linear issue.

### 4. Agent Runs

Purpose: manage workers.

Must show:

- Agent identity.
- Model/provider.
- Workspace/branch.
- Current state.
- Token/cost/time.
- Logs.
- Output artifact.
- Retry/fork/stop controls.

Design target: CI job page + terminal session manager + claude-squad.

### 5. Skill / Persona Library

Purpose: make Forge programmable without editing prompts manually.

Must show:

- Available skills.
- Personas.
- Commands.
- Source repository.
- Project applicability.
- Last updated.

Design target: Raycast extensions + Anthropic Skills.

## Visual Design Rules

- Use a neutral dark interface by default, with a light mode later.
- Use compact spacing; Forge is a tool, not a brochure.
- Make states obvious: queued, running, blocked, needs review, failed, shipped.
- Use one strong accent color for active/primary actions.
- Use muted colors for metadata.
- Use tables for dense operational information.
- Use cards only when grouping matters.
- Prefer split panes over page hopping.
- Make logs collapsible but always accessible.
- Always show the next decision the user needs to make.

## Anti-Patterns

Avoid:

- Giant rounded cards with little content.
- Marketing-page hero sections inside the app.
- Vague AI sparkle visuals.
- Random gradients.
- Too many colored badges.
- Agent names without state, output, or accountability.
- Chat-only interfaces for complex work.
- Hiding diffs, logs, or failures behind too many clicks.

## Starter Prompt For Claude Code

Use this when asking Claude Code to redesign Forge:

```text
You are redesigning Forge, a self-hosted AI coding orchestration dashboard. The current UI is workable but ugly.

Use these references:
- Linear for task clarity and compact hierarchy.
- Vercel for deployment/status polish.
- Raycast for command palette and fast actions.
- GitHub PRs for review and diff workflows.
- Datadog/Retool for operational dashboards.
- Anthropic Skills for skill structure.
- Superpowers for disciplined agentic development workflows.
- BMAD Method for PM -> Architect -> Developer phases.
- SuperClaude for commands and personas.
- Claude Squad for concurrent worker UX.
- Archon for project knowledge/context UX.

Goal:
Turn Forge into an AI engineering command center.

Design principles:
- Clear state over decoration.
- Compact, dense, readable layout.
- Split-pane workflows.
- Every task must show status, owner/agent, next action, and evidence.
- Human review must be first-class.
- Logs, diffs, plans, tests, and decisions must be easy to inspect.
- Use subtle CSS-first animation only for state changes.

Do not create a marketing-style dashboard. Do not add decorative AI gradients or oversized empty cards.

First, audit the existing UI. Then propose a screen architecture. Then implement the highest-impact redesign in small, reviewable commits.
```

## Implementation Order

1. Audit current screens and information hierarchy.
2. Define status model and visual states.
3. Redesign Command Center.
4. Redesign Project Workspace.
5. Redesign Task Detail / Review screen.
6. Add command palette.
7. Add Skill / Persona Library.
8. Add subtle CSS motion for state changes.
9. Only then consider topology visualisations or 3D.

## Bottom Line

For Forge, the best stack is not one single repository. It is:

- BMAD for workflow structure.
- Superpowers for disciplined development behavior.
- Anthropic Skills for skill packaging.
- SuperClaude for commands/personas.
- Claude Squad for parallel agent UX.
- Archon for context and task-board ideas.
- Linear/Vercel/Raycast/GitHub/Datadog as the actual UI taste references.

Forge should become the cockpit for AI software work, not another chat wrapper.
