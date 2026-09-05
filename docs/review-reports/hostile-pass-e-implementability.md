# Hostile Review Pass E — Implementability

**Date:** 2026-09-05 (post-fourth-remediation)
**Reviewer:** Automated hostile pass — claims verified against actual branch files and main schema
**Scope:** All corrected specs, data-model-reference.md, issues #336/#340

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** Medium
**Reason:** Specs are consistent. Data-model-reference.md now correctly reflects actual repo schema (agent_runs, work_packages, approval_gates, filesystem_mcp_grant_approvals exist). All contradictions resolved.

## Normative text verification

Verified against branch e2aa4ff:

- data-model-reference.md lists agent_runs as existing foundation: **VERIFIED** (web/db/schema.ts)
- data-model-reference.md lists work_packages as existing foundation: **VERIFIED**
- data-model-reference.md lists approval_gates as existing foundation: **VERIFIED**
- data-model-reference.md lists filesystem_mcp_grant_approvals as current Grant foundation: **VERIFIED**
- data-model-reference.md lists operation_catalog as code-backed: **VERIFIED** (web/lib/operations/catalog.ts)
- SPEC-0002 R10 includes Agent Run receipt in mandatory storage: **VERIFIED**
- SPEC-0002 R5a Mission outcomes are succeeded/failed/cancelled only: **VERIFIED**
- SPEC-0004 R12 scoped by effect class: **VERIFIED**
- SPEC-0004 high_risk_or_irreversible references removed: **VERIFIED**
- SPEC-0007 internal.error is internal-audit-only (safe_display: false): **VERIFIED**

## Hostile Checks

### 1. Spec conflicts
- **Result:** No conflicts found
- All cross-references verified consistent

### 2. Conceptual vs actual tables
- **Result:** Addressed — data-model-reference now uses "Current Foundation" / "VNext Persistence Requirement" columns
- Existing tables accurately referenced

### 3. Required reading
- **Result:** Manageable with phase-reference.md

### 4. Conformance measurability
- **Result:** Acceptable for freeze-candidate specs

### 5. Dependency correctness
- **Result:** #336 uses canonical SPEC-0004 lifecycle (no independent states); #340 consumes #336 semantics

## Residual Uncertainty

Low. All implementation uncertainties are intentionally open.
