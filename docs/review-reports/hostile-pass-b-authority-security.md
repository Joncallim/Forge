# Hostile Review Pass B — Authority / Security

**Date:** 2026-09-05 (post-fourth-remediation)
**Reviewer:** Automated hostile pass — claims verified against actual branch files
**Scope:** SPEC-0003 (verified against branch content), SPEC-0005, 0010, 0011, 0013; ADR 0015

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** Grant admission fencing with admission token, revision binding, and revocation invalidation now present in normative SPEC-0003. All security counterexamples fail closed.

## Normative text verification

The following claims are verified against the actual branch content (e2aa4ff):

- SPEC-0003 concurrency section contains admission token revision binding: **VERIFIED**
- SPEC-0003 concurrency section contains revocation invalidation of outstanding tokens: **VERIFIED**
- SPEC-0003 concurrency section contains lease/admission coupling: **VERIFIED**
- SPEC-0003 concurrency section contains C4/C5 conformance requirements: **VERIFIED**
- SPEC-0003 R10 says operator cannot bypass hard invariants (no exception mechanism): **VERIFIED**

## Hostile Checks

### 1. Child Grant monotonic narrowing
- **Result:** Pass — SPEC-0003 R5 enforced at issuance and authorization time

### 2. Explicit deny precedence
- **Result:** Pass — SPEC-0003 R2 deny overrides allow

### 3. Policy evaluation failure
- **Result:** Pass — SPEC-0003 R3 fail-closed

### 4. Operator authority limits
- **Result:** Pass — SPEC-0003 R10: hard invariants non-overridable; no operator exception mechanism exists

### 5. Grant admission fencing (TOCTOU protection)
- **Result:** Pass — SPEC-0003 concurrency:
  - Admission token binds exact Grant/policy/Resource revisions at admission time
  - Token validity re-verified before consequential action (model invocation, external submission)
  - Revocation invalidates all outstanding tokens under that Grant revision
  - Lease binds to admission state at lease grant time
  - C4/C5 conformance tests required
- **Counterexample:** Grant revoked between admission check and model invocation. The admission token's specific revisions are invalidated; recheck at invocation time fails. TOCTOU window closed.

### 6. Stale approval
- **Result:** Pass — SPEC-0003 R8 binds approval to exact revision/digest

### 7. Current security vs pinned behavior
- **Result:** Pass — SPEC-0003 R9 with admission token invalidation

### 8-16. Additional checks
- **Result:** All pass — package metadata, adapter responses, Resource content, credential brokering, egress ordering, package source, self-verification, audit failure, sandbox escape — all verified against normative specs

## Residual Uncertainty

Low. Grant admission fencing addresses TOCTOU at the normative level.
