# Hostile Review Pass E — Implementability

**Date:** 2026-09-05 (post-third-remediation)
**Reviewer:** Automated hostile pass
**Scope:** All corrected specs, issues, and supporting docs

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** Medium
**Reason:** Specs are consistent and well-structured. Data-model-reference.md corrected to match normative specs. Reading burden addressed by phase-reference.md.

## Hostile Checks

### 1. What decisions remain ambiguous?
- **Result:** Low ambiguity
- **Evidence:** Intentionally open decisions documented in frozen-vs-open.md and data-model-reference.md.

### 2. Which specs conflict?
- **Result:** No conflicts found
- **Evidence:** Cross-reference audit:
  - SPEC-0002 (ontology) → SPEC-0003 (authority) → SPEC-0004 (Operations) → consistent
  - SPEC-0002 R5a: Mission terminal outcomes are succeeded/failed/cancelled only (blocked/indeterminate are Execution-only). Consistent with Mission lifecycle (blocked/indeterminate Missions remain non-terminal).
  - SPEC-0002 R1: Agent Run receipt is durable; cognitive session ephemeral. Consistent with data-model-reference.
  - SPEC-0004 R2: effect class and risk class are independent dimensions. R4 scoped to external side-effect Operations only (pure/read/local_mutation use simpler lifecycle).
  - SPEC-0003 concurrency: Grant admission fencing closes TOCTOU window. Consistent with SPEC-0004 pre-submission checks.
  - SPEC-0008 R2: phase-level conformance for freeze candidates; mapping required before implementation. No self-contradiction.
  - SPEC-0014 R1 step 4: old schema MUST NOT accept independent writes. Consistent with R2 single-writer discipline.

### 3. Which "conceptual tables" look mandatory when they should not?
- **Result:** Addressed
- **Evidence:** data-model-reference.md now correctly:
  - Maps Project→workspace context (not Mission)
  - Maps Task→Mission (not Execution)
  - Shows Agent Run receipt as durable (not fully transient)
  - Shows Trigger definition bound to Mission (not under Execution)
  - Shows Work Package as 0..N

### 4. Is required reading manageable?
- **Result:** Yes, with phase-reference.md
- **Evidence:** phase-reference.md lists subset of specs per phase. 4-6 specs per phase, plus supporting docs.

### 5. Are conformance requirements measurable?
- **Result:** Mostly yes
- **Evidence:** SPEC-0008 R2 allows phase-level conformance for freeze-candidate specs. MUST/MUST NOT requirements need executable test or objectively inspectable method. SHOULD may have manual review.

### 6. Does any issue need future code that its dependencies do not provide?
- **Result:** No
- **Evidence:** Dependency graph verified. #336 correctly references SPEC-0004 for Operation lifecycle instead of defining its own states. #340 correctly consumes #336's reconciliation semantics instead of placing it out of scope.

## Residual Uncertainty

Low. All implementation uncertainties are intentionally open decisions documented in the appropriate specs and supporting docs.
