# Phase Reference — Spec Reading Guide

**Date:** 2026-09-10
**Purpose:** For each current VNext implementation phase or trust prerequisite, list the subset of specs and contracts that MUST be read first. This file follows the phase/issue numbering in `docs/roadmap.md` and Epic #333.

## How to use this guide

1. Find the issue or phase below.
2. Read the issue body first; it owns issue-specific scope and acceptance criteria.
3. Read the listed specs in order (primary first, then supporting).
4. Check `docs/implementation-checklist.md` for cross-cutting questions.
5. Consult `docs/frozen-vs-open.md` for binding vs intentionally open decisions.
6. Re-check current `main` before implementation; this guide does not override live repository state.

---

## Phase 0 — Generic Runtime Contracts And Compatibility Seam (#334)

**Primary specs:**
- SPEC-0001 — Specification Authoring Standard (read once)
- SPEC-0002 — Runtime Contract v1 (ontology, lifecycle, identity)
- SPEC-0003 — Authorization & Grants v1 (PARC model, ceilings)
- SPEC-0014 — Migration & Compatibility v1 (Project/Task mapping and single-authority migration)
- SPEC-0008 — Conformance Test Standard v1

**Supporting:**
- ADR 0014 — Forge VNext General Agent Runtime
- SPEC-0004 — Operation & Side-Effect Semantics only where an existing Operation boundary is exposed through the seam

**Implementation emphasis:**
- Introduce generic Mission/Execution/Resource/Grant contracts without a big-bang rename.
- Preserve existing trusted persistence/evidence as the implementation truth behind narrow generic ports.
- Expose only enough Workflow identity/revision and Work Package/Agent Run shape for later pinning; #367 owns the Workflow executor.

---

## Phase 1 — Budget, Routing, Context And Egress (#335)

**Primary specs:**
- SPEC-0003 — Authorization & Grants v1
- SPEC-0005 — Resource Classification, Data Egress & Secrets v1
- SPEC-0006 — Model Invocation & Cost Contract v1
- SPEC-0007 — Error & Reason Codes v1
- SPEC-0008 — Conformance Test Standard v1
- SPEC-0012 — Observability vs Audit v1

**Supporting:**
- SPEC-0002 — Runtime Contract (Agent Run, Artifact and Execution context)
- SPEC-0013 — Agentic Threat Model v1
- ADR 0014 — deterministic Core and ephemeral model workers

**Implementation emphasis:**
- Every governed model invocation crosses one deterministic broker.
- Context planning is reference-first through an inspectable ContextManifest.
- Provider/data-egress/budget admission occurs before restricted raw payload is materialized.
- The ContextCompiler produces one exact bounded ContextPacket per governed Agent Run.
- Permanent conversations and supervisor-written handoff summaries are not runtime state.

---

## Phase 1B — Deterministic Workflow Kernel And Artifact-Routed Dispatch (#367)

#367 is an implementation phase under already-accepted VNext semantics. It does not add a new normative ontology or second orchestration state model.

**Primary specs:**
- SPEC-0002 — Runtime Contract v1 (Workflow, Work Package, Agent Run, Artifact, Gate and `waiting` semantics)
- SPEC-0003 — Authorization & Grants v1 (Workflow/model content cannot mint authority)
- SPEC-0006 — Model Invocation & Cost Contract v1 (bounded context and concurrency budgets)
- SPEC-0007 — Error & Reason Codes v1 (machine-readable readiness/block reasons)
- SPEC-0008 — Conformance Test Standard v1 (restart, replay and invariant tests)
- SPEC-0012 — Observability vs Audit v1
- SPEC-0014 — Migration & Compatibility v1 (single authority; EXPAND→SHADOW→SWITCH→VERIFY→CONTRACT)

**Supporting:**
- ADR 0014 — deterministic Core; no permanent LLM orchestrator
- #335 — ContextManifest/ContextCompiler, model broker and budget reservation

**Implementation emphasis:**
- Work Package remains the dependency-scoped handoff unit; do not create a second Handoff entity.
- Workflow v1 is a directed acyclic graph; rework uses bounded attempt/revision lineage rather than arbitrary graph cycles.
- Readiness, fan-out/join and routine handoff are deterministic and consume zero model calls.
- PostgreSQL remains orchestration truth; framework/checkpoint state cannot become authoritative.
- #367 may run in parallel with #336 after #335. #337 is their first production convergence.

---

## Phase 2 — Secure Generic Execution Envelope (#336)

**Primary specs:**
- SPEC-0003 — Authorization & Grants v1
- SPEC-0004 — Operation & Side-Effect Semantics v1
- SPEC-0005 — Resource Classification, Data Egress & Secrets v1
- SPEC-0008 — Conformance Test Standard v1 (including the S1-S23 confinement profile)
- SPEC-0013 — Agentic Threat Model v1

**Supporting:**
- ADR 0015 — Secure Execution Technology / conformance profile
- SPEC-0002 — Principal/Execution/Work Package lineage and lease semantics
- SPEC-0006 — pre-existing budget/egress/model-invocation boundary from #335

**Implementation emphasis:**
- Prove OS/runtime confinement before opening mutation authority.
- Keep Grants, typed Operations, mutation leases and side-effect reconciliation independent of model prose.
- #336 and #367 are parallel siblings after #335; #336 does not need the Workflow kernel to prove confinement.

---

## Trust Prerequisite — Independent Verification Workforce/Gates (#188)

**Primary specs:**
- SPEC-0002 — Gate results, Agent Run identity and evidence relationships
- SPEC-0003 — verifier Principal and read-only authority
- SPEC-0008 — conformance and failure injection
- SPEC-0011 — evidence provenance/integrity
- SPEC-0013 — self-verification/confused-deputy threat controls

**Supporting:**
- #335 — fresh bounded verifier context and budgeted invocation
- #336 — read-only Resource Grants/confinement
- #185/#186 — canonical outcomes and capability-reliability evidence

**Implementation emphasis:**
- Deterministic evidence checks run before model verification where possible.
- A verifier produces evidence; a trusted deterministic Gate decides.
- Producer private reasoning/transcripts are not verifier context.

---

## Trust Prerequisite — Verification-Goal On-Demand Proof Execution (#355)

**Primary specs:**
- SPEC-0002 — Execution lifecycle and identity
- SPEC-0003 — Principal/Grant/Resource authority
- SPEC-0004 — typed Operation and retry/reconciliation semantics
- SPEC-0008 — restart/replay/failure-injection conformance
- SPEC-0012 — audit/evidence requirements

**Supporting:**
- #336 — confined deterministic execution
- #185/#186/#187 — outcome, reliability and verification-goal foundations

**Implementation emphasis:**
- Use deterministic typed proof Operations by default; no model or scheduler is required.
- Keep recurring cadence out of this issue; #341/#356 own Trigger-based scheduling.

---

## Phase 3 — Software Engineering End-To-End Proof (#337)

**Primary specs:**
- SPEC-0002 — Mission/Execution/Work Package/Agent Run/Artifact/Gate contracts
- SPEC-0003 — authority lineage
- SPEC-0004 — typed repository/Git/GitHub Operations and reconciliation
- SPEC-0005 — Resource classification/egress
- SPEC-0006 — budget/routing/context broker
- SPEC-0008 — end-to-end conformance and failure injection
- SPEC-0011 — Artifact/provenance integrity
- SPEC-0012 — audit/evidence
- SPEC-0013 — agentic threat controls
- SPEC-0014 — compatibility migration

**Required upstream contracts:**
- #334 — generic compatibility seam
- #335 — ContextManifest/ContextCompiler + governed invocation
- #336 — secure execution envelope
- #367 — deterministic Workflow kernel
- #188 — independent Verification/Gate contract
- #355 — deterministic proof execution

**Implementation emphasis:**
- This is an integration/proof phase, not the place to invent missing generic Workflow/context/security contracts.
- Routine Work Package sequencing/handoff uses #367 and zero model calls.
- Every cognitive Agent Run receives a #335 bounded ContextPacket.
- Every mutation runs through #336 typed authority/confinement.

---

## Phase 4 — Declarative Workforce Packages And Software Engineering Extraction (#338)

**Primary specs:**
- SPEC-0010 — Workforce Package v1
- SPEC-0011 — Provenance & Supply Chain v1
- SPEC-0003 — Authorization & Grants v1
- SPEC-0005 — Resource Classification, Data Egress & Secrets v1
- SPEC-0008 — Conformance Test Standard v1

**Supporting:**
- #337 — proven Software Engineering behavior to preserve
- #367 — package Workflow definitions execute through the generic kernel
- SPEC-0014 — migration/history/pinning discipline

**Implementation emphasis:**
- Package content is declarative data, not executable orchestration code.
- Install does not authorize.
- Software Engineering extraction must remove coding-specific Core assumptions without changing the proven Phase-3 outcome.

---

## Phase 5 — Deep Research Non-Repository Proof (#339)

**Primary specs:**
- SPEC-0002 — generic Mission/Execution/Artifact/Gate contracts
- SPEC-0003 — read-only Resource/Grant authority
- SPEC-0005 — classification and provider/web egress
- SPEC-0006 — bounded per-run context, routing and budgets
- SPEC-0008 — conformance
- SPEC-0011 — evidence provenance
- SPEC-0012 — evidence/audit
- SPEC-0013 — prompt/resource injection controls

**Supporting:**
- #338 — official declarative Workforce package
- #367 — bounded fan-out/join and artifact-routed Work Package dispatch
- #336 — bounded read Operation/confinement semantics

**Implementation emphasis:**
- Prove a Mission with no Project/Git record.
- Reuse #367 fan-out/join rather than inventing a research supervisor runtime.
- Reuse #335 selective context; do not send the whole corpus to each worker.
- Material claims remain linked to source/evidence Artifacts and independent verification.

---

## Phase 6 — Persistent Missions, Checkpoints And Leases (#340)

**Primary specs:**
- SPEC-0002 — Mission/Execution lifecycle, `waiting`, outcomes and lease clock authority
- SPEC-0003 — Mission/Execution Grants and revocation
- SPEC-0008 — restart/replay conformance
- SPEC-0014 — migration/compatibility

**Supporting:**
- SPEC-0004 — consume existing uncertain-side-effect/reconciliation semantics on restart
- #367 — pending/completed Workflow node state remains derived from canonical Work Package/Artifact/Gate truth
- #189 — earned-autonomy ceiling consumed by persistent Missions

**Implementation emphasis:**
- A persistent Mission is durable intent, not a persistent model session.
- Checkpoints contain bounded validated refs/state needed to resume, not replayed conversations.
- Waiting consumes zero model tokens.

---

## Phase 7 — Trigger/Event Runtime (#341)

**Primary specs:**
- SPEC-0009 — Trigger/Event Envelope v1
- SPEC-0002 — Mission lifecycle and `waiting`
- SPEC-0004 — Operation identity and side-effect distinction
- SPEC-0008 — dedupe/replay/zero-token conformance

**Supporting:**
- #340 — persistent Mission lifecycle
- #347 — durable PostgreSQL→Redis continuation/outbox

**Implementation emphasis:**
- PostgreSQL is occurrence truth; Redis is wakeup transport.
- Authenticate source separately from authorizing an Execution.
- Dedupe, causality, loop prevention and deterministic prefilters happen before model wakeup.

---

## Phase 8 — General Resource/Capability Adapter Ecosystem (#342)

**Primary specs:**
- SPEC-0003 — adapter Principal and Grants
- SPEC-0004 — Operation Catalog/effect/retry/reconciliation semantics
- SPEC-0005 — credential brokering and egress
- SPEC-0008 — adapter conformance

**Supporting:**
- #336 — confinement/side-effect journal
- #335 — egress/readiness/budget broker
- #337 — repository/Git/GitHub Operations to migrate
- #339 — web/document Resource readers to generalize

**Implementation emphasis:**
- Workforces request Capabilities; trusted adapters own executable connector code and narrow credential access.
- Package declarations never grant credentials/authority.
- Migrate proven read/write behavior instead of building a parallel connector state model.

---

## Phase 9 — Infrastructure Ops Persistent Side-Effect Proof (#343)

**Primary specs:**
- SPEC-0004 — side-effect lifecycle and reconciliation
- SPEC-0008 — failure injection/conformance
- SPEC-0012 — audit evidence for recovery

**Supporting:**
- SPEC-0002 — persistent Mission/Execution state
- SPEC-0003 — bounded autonomous Grants
- SPEC-0005 — secret/egress controls
- SPEC-0006 — model budget/routing when cognition is required
- SPEC-0009 — Trigger semantics
- #338/#340/#341/#342 — package, persistent Mission, Trigger and adapter runtime
- #189/#190/#366 — autonomy, Sentinel and restore/DR gates

**Implementation emphasis:**
- Healthy/unchanged observation remains deterministic and token-free.
- Prove one narrow reversible action exhaustively before broader operational authority.
- Verification and restart/reconciliation must precede return to quiescence.

---

## Phase 10 — HearthBot Cutover And Hermes Retirement (#344)

**Primary specs:**
- SPEC-0008 — release/conformance evidence
- SPEC-0010 — Workforce package/runtime pinning
- SPEC-0011 — provenance/evidence integrity
- SPEC-0014 — migration/rollback discipline
- SPEC-0015 — hard invariants/reliability

**Supporting:**
- All proven prior VNext contracts used by each retained workflow, especially #335, #340, #341, #342, #343 and #191

**Implementation emphasis:**
- One workflow has one writer/authority at a time.
- HearthBot is a thin Forge interface, not a second orchestrator.
- Hermes requirements may be translated; Hermes code/config/state/runtime is not imported as a fallback.

---

## Bootstrap / Current-Beta Prerequisites

### Dependency-Aware Dispatch (#354 — closed foundation)

**Primary specs:**
- SPEC-0007 — stable machine reason/control codes where applicable
- SPEC-0008 — deterministic/replay-safe control-plane validation

Use #354's dependency/tracking control plane for dispatch readiness. Managed labels are projections/cache, not authority.

### Zero-Token Passive Provider Health (#346)

**Primary specs:**
- SPEC-0006 — Provider readiness and circuit-breaking
- SPEC-0008 — zero-token-idle proof

### GitHub Main Release Gates (#348)

**Primary specs:**
- SPEC-0008 — phase/release closure
- SPEC-0015 — hard invariants

### Default Task-Title Egress (#353)

**Primary specs:**
- SPEC-0005 — classification and egress authorization

---

## Cross-Cutting (all phases)

Every implementation agent MUST read:
- the current issue body and later explicit correction comments;
- `docs/frozen-vs-open.md`;
- `docs/implementation-checklist.md`;
- relevant ADRs for the phase;
- `docs/specs/README.md`;
- current repository code/tests for the implementation seam.

Historical review reports may preserve an older phase map. They are evidence of how the architecture evolved, not current dispatch authority. `docs/roadmap.md`, `docs/near-term-roadmap.md`, Epic #333 and current issue dependency metadata own the current sequence.

---

## Reference: Current Spec Dependencies By Phase

```text
Phase 0  (#334): 0001, 0002, 0003, 0014, 0008
Phase 1  (#335): 0003, 0005, 0006, 0007, 0008, 0012 (+ 0002, 0013)
Phase 1B (#367): 0002, 0003, 0006, 0007, 0008, 0012, 0014 (+ ADR 0014)
Phase 2  (#336): 0003, 0004, 0005, 0008, 0013 (+ 0002, 0006, ADR 0015)
Phase 3  (#337): 0002, 0003, 0004, 0005, 0006, 0008, 0011, 0012, 0013, 0014
Phase 4  (#338): 0010, 0011, 0003, 0005, 0008 (+ 0014, #367)
Phase 5  (#339): 0002, 0003, 0005, 0006, 0008, 0011, 0012, 0013 (+ #367)
Phase 6  (#340): 0002, 0003, 0008, 0014 (+ 0004, #367)
Phase 7  (#341): 0009, 0002, 0004, 0008
Phase 8  (#342): 0003, 0004, 0005, 0008
Phase 9  (#343): 0004, 0008, 0012 (+ 0002, 0003, 0005, 0006, 0009)
Phase 10 (#344): 0008, 0010, 0011, 0014, 0015
```
