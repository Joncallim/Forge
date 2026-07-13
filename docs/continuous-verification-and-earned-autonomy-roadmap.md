# Continuous Verification and Earned Autonomy Roadmap

Last updated: 2026-07-12

Epic: [#184 — Continuous verification and earned autonomy](https://github.com/Joncallim/Forge/issues/184)

## Placement In The Forge Roadmap

This is a **P2.5 trust and reliability layer** between bounded Workforce execution and broad Forge Workspace expansion.

Forge should not increase autonomy merely because an agent appears capable or because a provider request returned successfully. It should first prove that a narrowly scoped capability works repeatedly, that its evidence is independently verified, and that permission can be revoked when reliability or safety changes.

The sequence is:

```text
Bounded execution and MCP admission
  -> canonical outcomes
  -> continuous proof goals
  -> independent verification
  -> capability reliability history
  -> earned and revocable autonomy
  -> evidence-first operator reporting
  -> broader Workspace automation
```

This roadmap extends the existing Architect → Work Package → Worker → Review model. It does not introduce a parallel agent operating system.

## Product Model

The useful Scout → Manager → Worker → Inspector pattern maps into existing Forge concepts:

| External pattern | Forge concept | Responsibility |
|---|---|---|
| Scout | Project Sentinel | Detect deterministic regressions, stuck work, stale reviews, and failed proof goals. |
| Manager | Architect | Convert a supported finding into a bounded work package with acceptance criteria and stop conditions. |
| Worker | Worker / Workforce runtime | Execute the approved package under existing capability and repository policy. |
| Inspector | Verification Workforce | Independently verify output in a fresh bounded context and persist evidence. |

## Design Principles

1. **Transport success is not task success.** A successful API or ACP response may still contain refusal, invalid output, blocking, or incomplete work.
2. **The worker does not grade itself.** Independent evidence is required for verified reliability.
3. **Deterministic checks run first.** CI, tests, proof goals, task state, and repository evidence are inspected before any model is asked to classify or summarize.
4. **Autonomy is capability- and scope-specific.** Forge does not maintain one global trust score for an agent or model.
5. **Evidence must be comparable.** Project, capability, scope, runtime/model, harness, and policy version define the reliability cohort.
6. **Autonomy is revocable.** Critical failures, policy violations, stale evidence, changed runtime/scope, or a human decision can immediately reduce permission.
7. **Existing safety ceilings still apply.** Earned autonomy cannot bypass MCP admission, security review, repository-edit policy, approval gates, or human caps.
8. **No general auto-merge in the initial Epic.** Higher levels stop at bounded branch/PR authority unless a later separately reviewed policy permits more.

## Autonomy Ladder

| Level | Initial meaning |
|---|---|
| L0 | Plan only. |
| L1 | Execute in a sandbox after explicit approval. |
| L2 | Execute bounded low-risk work; a human reviews the result. |
| L3 | Create a branch and draft PR after independent verification. |
| L4 | Open a ready-for-review PR after independent verification. |
| L5 | Reserved for narrowly defined reversible operations; not general auto-merge. |

Levels are policy ceilings, not entitlements. A stricter capability, MCP, security, or human rule always wins.

## Implementation Phases

### Phase 1 — Canonical Outcomes

Issue: [#185](https://github.com/Joncallim/Forge/issues/185)

Normalize execution and verification results so Forge can distinguish:

- transport success/error;
- completed, partial, refused, blocked, needs-attention, failed, or cancelled work;
- stable stop-reason codes;
- retryability;
- evidence references;
- required and completed verification.

This phase must map existing task attempts, work-package execution, MCP admission, agent runs, artifacts, and blocked/recovery paths into one versioned contract without replacing those records.

### Phase 2 — Capability Reliability Ledger

Issue: [#186](https://github.com/Joncallim/Forge/issues/186)

Store append-only comparable capability attempts and calculate deterministic metrics such as:

- independently verified pass rate;
- first-attempt success;
- repair/retry rate;
- human rejection and rollback rate;
- policy blocks and critical failures;
- consecutive verified passes;
- evidence freshness.

Do not collapse materially different capability scopes, models, runtimes, harnesses, or policy versions into one score.

### Phase 3 — Project Verification Goals

Issue: [#187](https://github.com/Joncallim/Forge/issues/187)

Allow projects to declare versioned “what still works” proof goals, preferably through strict repository-visible configuration such as `.forge/goals/*.yml` plus PostgreSQL snapshots and run history.

Goals run on demand first, then on a bounded schedule. They must use supported verification types and existing command/tool policy rather than arbitrary model-authored shell commands.

### Phase 4 — Independent Verification Workforce

Issue: [#188](https://github.com/Joncallim/Forge/issues/188)

Run an independent verifier in a fresh bounded context. It receives the work order, acceptance criteria, diff/sandbox evidence, required checks, and relevant project rules—but not the implementation worker’s private reasoning transcript.

Verification results and findings are stored separately and can require human or Security review for higher-risk work.

### Phase 5 — Earned Autonomy Policy

Issue: [#189](https://github.com/Joncallim/Forge/issues/189)

Evaluate versioned policies using comparable reliability evidence and independent verification.

Promotion requires minimum samples, fresh evidence, no unresolved critical failures, and any required human approval. Demotion or revocation can happen immediately after critical regression, policy violation, rollback, failed proof goal, evidence loss, material cohort change, or explicit human action.

### Phase 6 — Project Sentinel

Issue: [#190](https://github.com/Joncallim/Forge/issues/190)

Add deterministic scheduled/on-demand detectors for:

- failed proof goals;
- CI/check regressions;
- stuck, blocked, repeatedly retried, or dead-lettered work;
- stale required review state;
- blocked implementation requests;
- unresolved critical verification/security findings;
- provider or MCP readiness regressions.

Sentinel preserves and deduplicates evidence, then escalates. It does not directly edit code, merge changes, or silently create speculative repair work.

### Phase 7 — Evidence-First Reporting

Issue: [#191](https://github.com/Joncallim/Forge/issues/191)

Provide a compact operator surface and machine-readable reports for:

- current verification-goal status;
- last known-good and first observed failure;
- reliability cohorts and sample sizes;
- current autonomy level and human ceiling;
- promotion, hold, demotion, and revocation reasons;
- active/resolved Sentinel findings;
- critical failures, overrides, and stale evidence;
- links to tasks, runs, work packages, artifacts, issues, PRs, and proof runs.

Friendly summaries may be shown, but every decision must remain reconstructable from evidence.

## Dependencies And Integration

- Executable Workforce beta and work-package model: #119 and related implementation.
- Unified MCP admission and bounded grants: #172.
- Cross-agent checkpointing: #32.
- AI-native issue/backlog synchronization: #42.
- Adversarial mode: #40.
- Security and verification workforce architecture: #60.
- Closed GitHub-native agent workflow Epic: #141.

PostgreSQL remains orchestration and evidence truth. Redis may schedule checks and recomputation but must not become the canonical reliability or autonomy store. GitHub remains the durable implementation record.

## Initial Data Direction

Potential entities, subject to an ADR and reuse review:

- `execution_outcomes` or an equivalent canonical linked outcome;
- `capability_attempts`;
- `verification_goals`;
- `verification_goal_runs`;
- verification findings linked through existing `agent_runs` and `artifacts` where possible;
- `autonomy_policies`;
- `autonomy_decisions`;
- `sentinel_findings` and append-only observations/events.

Materialized summaries are allowed only if they can be rebuilt from immutable evidence.

## Safety Boundaries

The initial Epic does not include:

- global autonomy for an agent/model;
- worker self-grading as authoritative evidence;
- fully autonomous repair of every regression;
- auto-merge based on a percentage;
- broad host-level cron with unrestricted credentials/filesystem access;
- bypassing MCP, security, repository, or approval policy;
- storing secrets, credentials, or unnecessary model transcripts in reliability records;
- a full Workspace dashboard before the contracts and evidence paths work.

## Epic Completion Test

The Epic is complete when Forge can demonstrate this loop with evidence:

```text
A scoped capability executes
  -> canonical outcome is recorded
  -> independent verification runs
  -> comparable attempt enters the reliability ledger
  -> autonomy policy evaluates and records its decision
  -> a proof goal later regresses
  -> Sentinel detects and preserves the evidence
  -> autonomy is held or revoked before speculative repair
  -> the operator can inspect every reason and evidence reference
```
