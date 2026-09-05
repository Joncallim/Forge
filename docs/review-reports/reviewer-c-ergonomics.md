# Reviewer C — Implementation Ergonomics Review Report

**Date:** 2026-09-04
**Scope:** Forge VNext specification tranche

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** Medium
**Reason:** The specs are generally well-structured with clear normative requirements. The "frozen vs open" section correctly identifies what implementers must decide. However, some specs have requirements that are abstract enough that different implementers could interpret them differently, and the total volume of specs (15) plus data models creates a significant reading burden. No blocking ergonomics issues found.

## Findings

### F1: Spec volume and reading burden
- **Severity:** Medium
- **Disposition:** Advisory
- **Angle:** implementation-ergonomics
- **Evidence:** 15 specs totaling approximately 30,000+ words, plus 4 cross-cutting documents, plus ADRs.
- **Why it matters:** Implementation agents must read and understand all applicable specs before starting work. The volume could lead to missed requirements or incorrect interpretations.
- **Proposed remediation:** Create a concise "quick start" guide for each major phase that lists which SPEC requirements are most relevant. The implementation-checklist.md already helps. Consider a per-phase spec subset.
- **Residual uncertainty:** Medium — depends on how implementation agents consume documentation.

### F2: Data model duplication across specs
- **Severity:** Medium
- **Disposition:** Advisory
- **Angle:** implementation-ergonomics
- **Evidence:** SPEC-0002 (Runtime Contract), SPEC-0003 (Authorization), SPEC-0004 (Operations), SPEC-0005 (Classification), SPEC-0006 (Model Invocation), SPEC-0009 (Triggers), SPEC-0010 (Workforce), SPEC-0011 (Provenance), and SPEC-0015 (Reliability) all define database tables with overlapping fields.
- **Why it matters:** The data models are spread across multiple specs. An implementer must cross-reference them to understand the full schema. Some fields appear in multiple tables (e.g., `policy_revision` appears in 6+ tables).
- **Proposed remediation:** Add a consolidated reference data model diagram or index table showing which spec defines which table. Or create a single "Data Model Reference" document that consolidates all table definitions.
- **Residual uncertainty:** Low — the specs are internally consistent, just spread across many files.

### F3: Vague conformance requirements
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** implementation-ergonomics
- **Evidence:** SPEC-0008 R1 defines test classes C1-C8. Some spec requirements reference these classes but many don't have explicit class mappings.
- **Why it matters:** Without explicit class mappings per requirement, implementers may not know which test types are expected.
- **Proposed remediation:** Add a "Conformance" column to each spec's normative requirements table showing which test class(es) apply.
- **Residual uncertainty:** Low — the classes are clear enough that implementers can infer appropriate tests.

### F4: SPEC-0002 R10 — Database mapping rule
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** implementation-ergonomics
- **Evidence:** SPEC-0002 R10 says "Not every ontology concept requires a separate database table. The implementation MAY coalesce entities."
- **Why it matters:** This is good guidance that prevents over-engineering. However, implementers may need more specific guidance about which entities can be coalesced.
- **Proposed remediation:** Add examples of acceptable coalescing (e.g., "Operation state is part of the Operation record, not a separate table" as already stated).
- **Residual uncertainty:** Low.

### F5: Non-testable normative wording
- **Severity:** Medium
- **Disposition:** Advisory
- **Angle:** implementation-ergonomics
- **Evidence:** Some requirements use "SHOULD" language that is difficult to test automatically (e.g., SPEC-0006 R12 optimization target, SPEC-0012 R7 recommended spans).
- **Why it matters:** "SHOULD" requirements that cannot be tested may be ignored or interpreted inconsistently.
- **Proposed remediation:** For each SHOULD requirement, add a note about how compliance could be verified, even if manually.
- **Residual uncertainty:** Low — SHOULD requirements are intentionally weaker than MUST.

### F6: Dependency ordering
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** implementation-ergonomics
- **Evidence:** The issue dependency graph (checked during reconciliation) is acyclic and well-structured.
- **Why it matters:** The VNext phase ordering (#334→#335→#336→#337→#338→#339→#340→#341→#342→#343→#344) is logical and prevents premature implementation of downstream features.
- **Proposed remediation:** None. The dependency ordering is one of the strongest parts of the architecture.
- **Residual uncertainty:** None.

## Pass Coverage

| Pass | Checked | Findings | Not Covered |
|---|---|---|---|
| Over-abstraction | Yes | F1, F2 | - |
| Impossible dependency ordering | Yes | 0 | - |
| Specs requiring future components | Yes | 0 | - |
| Duplicated interfaces | Yes | F2 | - |
| Excessive DB tables | Yes | F4 | - |
| Vague conformance requirements | Yes | F3 | - |
| Non-testable normative wording | Yes | F5 | - |
| Package/adapter boundaries | Yes | 0 | - |
| Accidental waterfall design | Yes | 0 | - |

## Required Next Actions

All findings are advisory. No blocking issues.

- F1: Create per-phase spec subset guides.
- F2: Create consolidated data model reference.
- F3: Add explicit test class mappings to spec requirements.
- F5: Add verification notes for SHOULD requirements.
