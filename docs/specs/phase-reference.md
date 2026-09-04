# Phase Reference — Spec Reading Guide

**Date:** 2026-09-04
**Purpose:** For each major VNext phase or issue family, list the subset of specs that MUST be read first. Implementation agents should read these specs before starting work on the corresponding issue.

## How to use this guide

1. Find your issue or phase below.
2. Read the listed specs in order (primary first, then supporting).
3. Check the implementation checklist (`docs/implementation-checklist.md`) for cross-cutting questions.
4. Consult `docs/frozen-vs-open.md` for decisions that are binding vs intentionally open.

---

## Phase 0 — Core Runtime Migration (#334)

**Primary specs:**
- SPEC-0001 — Specification Authoring Standard (read once)
- SPEC-0002 — Runtime Contract v1 (ontology, lifecycle, identity)
- SPEC-0003 — Authorization & Grants v1 (PARC model, ceilings)
- SPEC-0014 — Migration & Compatibility v1 (Project/Task mapping)
- SPEC-0008 — Conformance Test Standard v1 (test classes, phase closure)

**Supporting:**
- ADR 0014 — Forge VNext General Agent Runtime
- ADR 0015 — Secure Execution Technology (sandbox profile)
- SPEC-0004 — Operation & Side-Effect Semantics (if Operations are migrated)

**Skip for Phase 0:**
- SPEC-0005 (classification — Phase 1)
- SPEC-0006 (model invocation — Phase 1)
- SPEC-0007 (error codes — Phase 1)
- SPEC-0009 (triggers — Phase 2)
- SPEC-0010 (workforce packages — Phase 2)
- SPEC-0011 (provenance — Phase 2)
- SPEC-0012 (observability — Phase 1)
- SPEC-0013 (threat model — reference only)
- SPEC-0015 (reliability — Phase 2)

---

## Phase 1 — Authorization, Classification & Cost (#335)

**Primary specs:**
- SPEC-0003 — Authorization & Grants v1
- SPEC-0005 — Resource Classification, Data Egress & Secrets v1
- SPEC-0006 — Model Invocation & Cost Contract v1
- SPEC-0007 — Error & Reason Codes v1
- SPEC-0008 — Conformance Test Standard v1
- SPEC-0012 — Observability vs Audit v1

**Supporting:**
- SPEC-0002 — Runtime Contract (entity context)
- SPEC-0013 — Agentic Threat Model (control mapping)
- ADR 0015 — Secure Execution Technology (sandbox for adapters)

**Skip:**
- SPEC-0004 (Operations — Phase 2)
- SPEC-0009 (Triggers — Phase 2)
- SPEC-0010 (Workforce packages — Phase 2)
- SPEC-0011 (Provenance — Phase 2)
- SPEC-0014 (Migration — already covered in Phase 0)
- SPEC-0015 (Reliability — Phase 2)

---

## Phase 2 — Sandbox, Packages & Triggers (#336, #338, #341)

### Secure Execution (#336)

**Primary specs:**
- SPEC-0003 — Authorization & Grants v1 (adapter Grants)
- SPEC-0004 — Operation & Side-Effect Semantics v1 (confinement requirements)
- SPEC-0005 — Resource Classification (egress from sandbox)
- SPEC-0008 — Conformance Test Standard v1 (C5, S1-S23)
- SPEC-0013 — Agentic Threat Model v1 (sandbox escape T15)

**Supporting:**
- ADR 0015 — Secure Execution Technology (S1-S23 conformance profile)

### Workforce Packages (#338)

**Primary specs:**
- SPEC-0010 — Workforce Package v1
- SPEC-0011 — Provenance & Supply Chain v1
- SPEC-0003 — Authorization & Grants v1 (Capability requests, activation)
- SPEC-0005 — Resource Classification (package content classification)
- SPEC-0008 — Conformance Test Standard v1

### Triggers & Events (#341)

**Primary specs:**
- SPEC-0002 — Runtime Contract v1 (Mission lifecycle, `waiting` state)
- SPEC-0004 — Operation & Side-Effect Semantics v1 (Operation identity)
- SPEC-0008 — Conformance Test Standard v1
- SPEC-0009 — Trigger/Event Envelope v1

---

## Phase 3 — Adapter, Operation Catalog & Reconciliation (#342, #343)

### Capability Adapters (#342)

**Primary specs:**
- SPEC-0003 — Authorization & Grants v1 (adapter Principal, Grants)
- SPEC-0004 — Operation & Side-Effect Semantics v1 (Operation Catalog, effect classes)
- SPEC-0005 — Resource Classification, Data Egress & Secrets v1 (credential brokering)
- SPEC-0008 — Conformance Test Standard v1

### Side-Effect Recovery (#343)

**Primary specs:**
- SPEC-0004 — Operation & Side-Effect Semantics v1 (reconciliation, submission_uncertain)
- SPEC-0012 — Observability vs Audit v1 (audit evidence for recovery)
- SPEC-0008 — Conformance Test Standard v1 (failure injection)

---

## Phase 4 — Mission Lifecycle, Verification & Release (#340, #339, #344)

### Mission Lifecycle (#340)

**Primary specs:**
- SPEC-0002 — Runtime Contract v1 (Mission lifecycle, outcomes)
- SPEC-0003 — Authorization & Grants v1 (Mission Grants)
- SPEC-0008 — Conformance Test Standard v1

### Verification & Gates (#339)

**Primary specs:**
- SPEC-0002 — Runtime Contract v1 (Gate results, evidence)
- SPEC-0003 — Authorization & Grants v1 (verifier Principal)
- SPEC-0011 — Provenance & Supply Chain v1 (evidence integrity)
- SPEC-0013 — Agentic Threat Model v1 (self-verification T12)
- SPEC-0008 — Conformance Test Standard v1

### Release & Deployment (#344)

**Primary specs:**
- SPEC-0008 — Conformance Test Standard v1 (phase closure)
- SPEC-0010 — Workforce Package v1 (package distribution)
- SPEC-0011 — Provenance & Supply Chain v1 (package provenance)
- SPEC-0014 — Migration & Compatibility v1 (rollback)
- SPEC-0015 — Reliability / SLO Profile v1 (hard invariants, monitoring)

---

## Bootstrap Issues (pre-#354 frontier)

### Zero-Token Passive Provider Health (#346)

**Primary specs:**
- SPEC-0006 — Model Invocation & Cost Contract v1 (provider readiness R10)
- SPEC-0008 — Conformance Test Standard v1 (zero-token-idle proof R4)

### GitHub Main Release Gates (#348)

**Primary specs:**
- SPEC-0008 — Conformance Test Standard v1 (phase closure R6)
- SPEC-0015 — Reliability / SLO Profile v1 (hard invariants H1-H10)

### Default Task-Title Egress (#353)

**Primary specs:**
- SPEC-0005 — Resource Classification, Data Egress & Secrets v1 (classification R1, egress R4)

---

## Cross-Cutting (all phases)

Every implementation agent MUST read:
- `docs/frozen-vs-open.md` — which decisions are binding vs open
- `docs/implementation-checklist.md` — cross-cutting questions to answer
- The relevant ADRs for their phase
- `docs/specs/README.md` — spec conventions and index

---

## Reference: Spec Dependencies by Phase

```
Phase 0 (#334): SPEC-0001, 0002, 0003, 0014, 0008
Phase 1 (#335): SPEC-0003, 0005, 0006, 0007, 0008, 0012, 0013
Phase 2a (#336): SPEC-0003, 0004, 0005, 0008, 0013 + ADR 0015
Phase 2b (#338): SPEC-0010, 0011, 0003, 0005, 0008
Phase 2c (#341): SPEC-0002, 0004, 0008, 0009
Phase 3a (#342): SPEC-0003, 0004, 0005, 0008
Phase 3b (#343): SPEC-0004, 0012, 0008
Phase 4a (#340): SPEC-0002, 0003, 0008
Phase 4b (#339): SPEC-0002, 0003, 0011, 0013, 0008
Phase 4c (#344): SPEC-0008, 0010, 0011, 0014, 0015
```
