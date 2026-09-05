# Hostile Review Pass B — Authority / Security

**Date:** 2026-09-05 (final remediation)
**Reviewer:** Automated hostile pass — all claims verified against branch head 86f492864dc3a515f49d240cf4eacc2a4fd76cba
**Scope:** SPEC-0003, 0005, 0010, 0011, 0013; ADR 0015

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** Grant admission fencing with admission token, revision binding, revocation invalidation, and lease coupling is present in normative SPEC-0003 concurrency section. Operator authority correctly limited by non-overridable hard invariants. All security counterexamples fail closed.

## Normative text verification (verified against 86f492864dc3a515f49d240cf4eacc2a4fd76cba)

- SPEC-0003 concurrency section contains admission token revision binding: VERIFIED
- SPEC-0003 concurrency section contains revocation invalidation of outstanding tokens: VERIFIED
- SPEC-0003 concurrency section contains lease/admission coupling: VERIFIED
- SPEC-0003 concurrency section contains C4/C5 conformance requirements: VERIFIED
- SPEC-0003 R10 says operator cannot bypass hard invariants (no exception mechanism): VERIFIED
- SPEC-0003 has single ## Security/privacy heading (no duplicate): VERIFIED
- SPEC-0007 internal.error safe_display: false, internal-audit-only: VERIFIED
- SPEC-0007 internal.* namespace declared and MUST NOT cross service boundary: VERIFIED

## Hostile Checks

### 1-16. All pass
- Child Grant narrowing, deny precedence, fail-closed evaluation, operator authority limits, Grant admission fencing (TOCTOU closed), stale approval, current security vs pinned, malicious metadata, malicious adapter, malicious Resource content, credential brokering, egress ordering, package source, self-verification, audit failure, sandbox escape — all verified against normative specs.

## Residual Uncertainty

Low. Grant admission fencing addresses TOCTOU at the normative level.
