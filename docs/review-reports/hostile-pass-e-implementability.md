# Hostile Review Pass E — Implementability

**Date:** 2026-09-05 (post-second-remediation)
**Reviewer:** Automated hostile pass
**Scope:** All corrected specs, issues, and supporting docs

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** Medium
**Reason:** Specs are consistent and well-structured. Reading burden addressed by phase-reference.md. Data model ownership clarified by data-model-reference.md. Some implementation decisions remain intentionally open.

## Hostile Checks

### 1. What decisions remain ambiguous?
- **Result:** Low ambiguity
- **Evidence:** The following are intentionally open (per frozen-vs-open.md and data-model-reference.md):
  - Exact database migration shape (#334)
  - Exact sandbox technology (pending conformance proof per ADR 0015)
  - Exact package manifest/DSL syntax (#338)
  - Exact provider cost metadata source (#335)
  - Exact adapter process boundary (#342)
  - Exact event scheduler backend (#341)
  - Numerical SLO targets (after baseline collection)
- **Counterexample:** An implementer tries to implement #334 without knowing the exact table layout. The spec defines required semantic fields but leaves physical layout open. This is intentional — the implementer should design the schema based on the required fields. Correct.

### 2. Which specs conflict?
- **Result:** No conflicts found
- **Evidence:** Cross-reference audit:
  - SPEC-0002 (ontology) → SPEC-0003 (authority on entities) → SPEC-0004 (Operations on entities) → consistent
  - SPEC-0005 (classification) → SPEC-0003 (classification in authorization context) → consistent
  - SPEC-0006 (cost) → SPEC-0003 (budget in authority computation) → consistent
  - SPEC-0009 (triggers) → SPEC-0002 (Mission lifecycle) → SPEC-0004 (Operation identity) → consistent
  - SPEC-0010 (packages) → SPEC-0011 (provenance) → SPEC-0003 (authorization) → consistent
  - SPEC-0012 (observability) → SPEC-0005 (classification) → SPEC-0004 (audit for recovery) → consistent
  - SPEC-0014 (migration) → SPEC-0002 (ontology mapping) → consistent
  - SPEC-0015 (reliability) → SPEC-0003 (hard invariants) → SPEC-0012 (incident evidence) → consistent
- **Specific conflict checks:**
  - SPEC-0008 R2 vs deferred mapping: RESOLVED. R2 now allows phase-level conformance for freeze-candidate specs, with requirement-to-class mapping required before implementation.
  - SPEC-0014 R1 step 4 vs R2: RESOLVED. Step 4 no longer contains contradictory "old schema accepts writes" language.

### 3. Which "conceptual tables" look mandatory when they should not?
- **Result:** Addressed
- **Evidence:** All spec data model sections now labeled "Conceptual data model" with note: "The exact physical table layout, column types, indexes, and partitioning are implementation decisions." Data-model-reference.md shows which entities require new physical tables vs. implementation-open.
- **Counterexample:** An implementer reads SPEC-0002 and sees a Mission table with specific columns. The conceptual note clarifies this is not a physical schema mandate. The implementer may coalesce, rename, or reorganize columns while preserving required semantic fields.

### 4. Is required reading manageable?
- **Result:** Yes, with phase-reference.md
- **Evidence:** phase-reference.md lists the subset of specs to read per phase. For Phase 0 (#334), only 5 specs are primary. For Phase 1 (#335), 6 specs. For Phase 2 (#336), 5 specs + ADR.
- **Counterexample:** An implementer for #341 (Triggers) would read: SPEC-0002 (Mission lifecycle), SPEC-0004 (Operation identity), SPEC-0008 (conformance), SPEC-0009 (Trigger envelope). That's 4 specs plus supporting docs — manageable.

### 5. Are conformance requirements measurable?
- **Result:** Mostly yes
- **Evidence:** SPEC-0008 R1 refined: MUST/MUST NOT requirements need executable test or objectively inspectable method. SHOULD may have manual review. SPEC-0008 R2 allows phase-level conformance for freeze-candidate specs, with requirement-to-class mapping required before implementation.
- **Counterexample:** SPEC-0006 R12 (optimization target) is a SHOULD-level architecture guidance. It's not directly testable by an automated test, but manual review can verify the routing implementation aligns with this principle. Correct.

### 6. Does any issue need future code that its dependencies do not provide?
- **Result:** No
- **Evidence:** Dependency graph verified — no issue requires code from an issue that isn't its dependency or transitive dependency.

## Residual Uncertainty

Low. The main residual uncertainties are implementation decisions that are intentionally left open.
