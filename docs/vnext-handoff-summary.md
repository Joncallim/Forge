# Forge VNext — Specification Tranche Completion Summary

**Date:** 2026-09-04
**Purpose:** Handoff summary for subsequent implementation agents.

## Deliverables

### 1. Normative Specification Framework

- `docs/specs/README.md` — Spec index and conventions
- `docs/specs/SPEC-0001.md` — Specification Authoring Standard
- `docs/specs/SPEC-0002.md` — Runtime Contract v1 (ontology, lifecycle, outcomes)
- `docs/specs/SPEC-0003.md` — Authorization & Grants v1
- `docs/specs/SPEC-0004.md` — Operation & Side-Effect Semantics v1
- `docs/specs/SPEC-0005.md` — Resource Classification, Data Egress & Secrets v1
- `docs/specs/SPEC-0006.md` — Model Invocation & Cost Contract v1
- `docs/specs/SPEC-0007.md` — Error & Reason Codes v1
- `docs/specs/SPEC-0008.md` — Conformance Test Standard v1
- `docs/specs/SPEC-0009.md` — Trigger/Event Envelope v1
- `docs/specs/SPEC-0010.md` — Workforce Package v1
- `docs/specs/SPEC-0011.md` — Provenance & Supply Chain v1
- `docs/specs/SPEC-0012.md` — Observability vs Audit v1
- `docs/specs/SPEC-0013.md` — Agentic Threat Model v1
- `docs/specs/SPEC-0014.md` — Migration & Compatibility v1
- `docs/specs/SPEC-0015.md` — Reliability / SLO Profile v1

### 2. Supporting Documents

- `docs/adr/0015-secure-execution-technology.md` — Sandbox conformance profile + technology decision (status: Proposed pending conformance proof)
- `docs/frozen-vs-open.md` — Frozen semantics vs intentionally open decisions (updated for remediation)
- `docs/implementation-checklist.md` — Cross-spec implementation checklist
- `docs/industry-benchmark-matrix.md` — Industry standards reference matrix
- `docs/specs/phase-reference.md` — Per-phase spec reading guide (new)
- `docs/specs/data-model-reference.md` — Conceptual data model ownership reference (new)
- `docs/review-reports/reviewer-a-architecture.md` — Architecture/distributed-systems review
- `docs/review-reports/reviewer-b-security.md` — Security/adversarial review
- `docs/review-reports/reviewer-c-ergonomics.md` — Implementation ergonomics review
- `docs/review-reports/reviewer-d-cost-operability.md` — Cost/operability review
- `docs/vnext-handoff-summary.md` — This document

### 3. Updated Documents

- `docs/roadmap.md` — Added spec index and references

### 4. Issue Reconciliation

All open VNext/trust issues reviewed for:
- Dependency correctness (acyclic graph verified)
- Spec contradictions (none found)
- Hidden forward dependencies (none found)
- Previously identified traps (verified corrected):
  - #341 uses synthetic consumers, does not depend on #356/#190
  - #336 generic confinement may close without #357
  - #189 may close before #356

### 5. Independent Review Findings

**Four orthogonal reviews completed — no blocking issues found.**

| Reviewer | Focus | Status | Key advisory findings |
|---|---|---|---|
| A — Architecture | Distributed systems, replay, idempotency | No blockers | Lease clock authority, Redis reconstruction cross-refs |
| B — Security | Authority escalation, injection, supply chain | No blockers | Adapter metadata clarity, auth protection |
| C — Ergonomics | Implementability, testability | No blockers | Spec volume, consolidated data model |
| D — Cost/Operability | Budget, zero-token, telemetry | No blockers | Circuit-breaking, unknown cost guidance |

All advisory findings are documented with proposed remediations. No blocking remediations were required.

## Dispatch Frontier (post-#354)

The bootstrap dispatch frontier (issues with `Depends on: none`) is:

- **#354** — dependency-aware dispatch (bootstrap priority)
- **#346** — zero-token passive provider health
- **#348** — enforce GitHub main release gates
- **#353** — disable default task-title egress
- **#358** — retire stale branches

After #354 lands, the frontier expands to #334 (Phase 0) which depends on #354.

## Remediation Summary (2026-09-04 Hostile Tranche)

The following P0/P1 findings were remediated before PR creation:

| Finding | Spec | Change |
|---|---|---|
| P0-1 Lifecycle/outcome semantics | SPEC-0002 | Restricted R2 to executable entities; Mission lifecycle now uses single `terminal` state with separate outcome; Work Package follows lifecycle/outcome pattern |
| P0-2 Project/Task migration mapping | SPEC-0014 | Project→workspace context (not Mission); Task→Mission; retries→Executions; removed contradictory "Project is Mission" language |
| P0-3 Side-effect lifecycle | SPEC-0004 | Replaced linear chain with branching state graph; added fault-injection table per transition; clarified confirmation policy requirements |
| P0-4 CloudEvents compatibility | SPEC-0009 | Fixed extension attribute names (valid lowercase-alphanumeric); strengthened multi-Trigger causal loop detection with bounded ancestry |
| P0-5 Audit-write failure semantics | SPEC-0012 | Distinguished pre-submission (fail/block) from post-submission (submission_uncertain) failure; cross-referenced SPEC-0004 |
| P0-6 Classification/egress matrix | SPEC-0005 | Replaced ambiguous MUST/SHOULD/MAY/DENY with PERMIT/CONDITIONAL/DENY; clarified fail-closed rules for unknown/unclassified Resources |
| P0-7 Content vs logical identity | SPEC-0011 | Digest identifies content only; logical Artifact identity remains separate; evidence decisions use provenance + identity |
| P1-8 Migration single-writer | SPEC-0014 | Added explicit single-writer discipline; old API writes route through compatibility adapter; no independent old/new writers |
| P1-9 Sandbox contradiction | ADR 0015 | Conformance profile S1-S23 frozen; technology marked Proposed pending conformance proof; no weakening exceptions |
| P1-10 Trigger serialization | SPEC-0009 | Replaced per-Trigger serialization with granular dedupe-identity/Resource-lane concurrency |
| P1-11 Package identity | SPEC-0010 | Branch/tag resolved to exact commit before activation; digest conflict = supply-chain violation; derived revisions distinct from upstream |
| P1-12 Database models | All specs | Data model sections marked as conceptual; created data-model-reference.md for ownership |
| P2-13 SLO semantics | SPEC-0015 | Hard invariants have zero permissible error budget; softened 30-day/quarterly to representative/recommended |
| P2-14 Circuit-breaking | SPEC-0006 | Per-failure-class recovery semantics; no generic cooldown |
| P2-15 Governance status | All specs + README | Promoted to Accepted after operator-approved merge of PR #359; ADR 0015 remains Proposed pending sandbox conformance proof |
| Additional: Operator authority | SPEC-0003 | Clarified operator authority limited by system ceilings and hard invariants |
| Additional: Conformance wording | SPEC-0008 | MUST/MUST NOT require executable test; SHOULD may use manual review |

## Key Principles For Implementation Agents

1. **Read the relevant specs first.** Cross-cutting semantics are frozen in specs, not redefined per issue.
2. **Use the implementation checklist** (`docs/implementation-checklist.md`) to ensure completeness.
3. **Check the frozen-vs-open document** before making architectural decisions.
4. **Reference specs in issue bodies** instead of redefining semantics.
5. **Do not redesign cross-cutting architecture** unless a concrete contradiction is proven.
6. **Follow the dependency graph** — do not implement downstream phases before their dependencies.
7. **Run conformance tests** per SPEC-0008 classes for each change.
8. **Get independent review** per the orthogonal review protocol.

## Residual Uncertainties

These are explicitly documented areas where future decisions are needed (unchanged — remediation tightened specs without introducing new uncertainties):

1. Exact database migration shape for Mission/Execution compatibility (#334).
2. Exact sandbox technology and first supported host platform (pending conformance proof per ADR 0015).
3. Exact package manifest/DSL syntax (#338).
4. Exact provider cost metadata source/update mechanism (#335).
5. Exact capability-adapter process/RPC/plugin boundary (#342).
6. Exact event scheduler backend (#341).
7. Exact rules for reusable non-deterministic/cognitive results (future).
8. Numerical SLO targets (after baseline collection per SPEC-0015 R4).
9. Conformance mapping details (requirement-to-test-class tables) — deferred to implementation phase.

## Completion Criterion Status

- ✅ All 15 normative specs exist, are Accepted, and cross-reference consistently
- ✅ No material contradiction between specs, ADRs, and open issues (after remediation)
- ✅ No hidden dependency cycles in the issue graph
- ✅ No cross-cutting semantic is being independently redefined in multiple issues
- ✅ Hostile review Pass A (state machine / distributed systems) — completed, no P0/P1 findings
- ✅ Hostile review Pass B (authority/security) — completed, no P0/P1 findings
- ✅ Hostile review Pass C (migration/source-of-truth) — completed, no P0/P1 findings
- ✅ Hostile review Pass D (cost/operability) — completed, no P0/P1 findings
- ✅ Hostile review Pass E (implementability) — completed, no P0/P1 findings
- ✅ P0/P1 findings remediated and verified
- ✅ Supporting documents (phase-reference.md, data-model-reference.md) created
- ✅ GitHub issues reconciled with corrected specs
- ✅ Repository validation — PR #359 merged at `49bf9b1b7e63238bb84d26dd1945b6dca6560f23` after Web CI, PR Contract Check, and GitGuardian passed
- ✅ Remaining uncertainty is genuinely low-level implementation choice or explicitly deferred scope
