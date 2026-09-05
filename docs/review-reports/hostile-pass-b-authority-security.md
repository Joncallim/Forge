# Hostile Review Pass B — Authority / Security

**Date:** 2026-09-05 (post-third-remediation)
**Reviewer:** Automated hostile pass
**Scope:** Corrected SPEC-0003, 0005, 0010, 0011, 0013; ADR 0015

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** Grant admission fencing added to close TOCTOU windows. Operator authority hard-invariant ceiling is non-overridable. All security counterexamples fail closed.

## Hostile Checks

### 1. Child Grant monotonic narrowing
- **Result:** Pass
- **Evidence:** SPEC-0003 R5: child Grant MUST be strict subset of or equal to parent. Enforced at issuance time, recheckable at authorization time. Admission token binds exact Grant revision.

### 2. Explicit deny precedence
- **Result:** Pass
- **Evidence:** SPEC-0003 R2: deny overrides allow. A permit from a lower-authority source MUST NOT override a deny from a higher-authority source.

### 3. Policy evaluation failure
- **Result:** Pass
- **Evidence:** SPEC-0003 R3: fail-closed (deny) on evaluation error. SPEC-0005: classification lookup failure → SECRET-equivalent (fail closed).

### 4. Operator authority limits
- **Result:** Pass
- **Evidence:** SPEC-0003 R10: operator authority is administrative within system ceilings and hard invariants. Hard invariants are non-overridable by any Principal — no operator exception mechanism exists. If an invariant needs changing, that requires spec/ADR/policy revision, not a one-off exception.

### 5. Grant admission fencing (TOCTOU protection)
- **Result:** Pass
- **Evidence:** SPEC-0003 concurrency section now requires:
  - Authorization binds exact Grant/policy/Resource revisions at admission time, producing an admission token.
  - Before every consequential action (model invocation, external submission), the runtime MUST re-verify the admission token's revisions are still valid.
  - Revocation invalidates all outstanding admission tokens under that Grant revision.
  - Execution lease binds to admission state at lease grant time.
- **Counterexample:** Grant is revoked between admission check and model invocation. Old model: recheck passes because current security re-evaluation is done at invocation time. Corrected model: the admission token itself is invalidated on revocation; the recheck at invocation time fails because the specific Grant revision relied upon is no longer valid. TOCTOU window closed.

### 6. Stale approval
- **Result:** Pass
- **Evidence:** SPEC-0003 R8: approval binds to exact revision/digest + scope + policy. Material change invalidates approval.

### 7. Current security vs pinned behavior
- **Result:** Pass
- **Evidence:** SPEC-0003 R9: pinned behavior vs current security. Revocation blocks new actions regardless of pin. Admission token invalidation ensures this is enforced at every consequential action boundary.

### 8. Malicious package metadata
- **Result:** Pass
- **Evidence:** SPEC-0010 R2: install does not authorize. SPEC-0003 R6: package text/metadata cannot mint authority.

### 9. Malicious adapter capability advertisement
- **Result:** Pass
- **Evidence:** SPEC-0003 R6: adapter responses cannot mint authority. SPEC-0004 R1: Operation Catalog defines available capabilities.

### 10. Malicious Resource content
- **Result:** Pass
- **Evidence:** SPEC-0005 R7: external Resource contents MUST NOT grant Capabilities, alter policy, widen access, change routing, increase budget, request secrets, disable verification, or modify Grants.

### 11. Credential confusion / token passthrough
- **Result:** Pass
- **Evidence:** SPEC-0005 R8: credentials MUST be audience/resource scoped, injected at adapter layer, not passed through model context.

### 12. Egress before payload construction
- **Result:** Pass
- **Evidence:** SPEC-0005 R4: egress authorization order is classification → destination → grant → construct. Constructing sensitive prompt before authorization check is FORBIDDEN.

### 13. Package source/tag substitution
- **Result:** Pass
- **Evidence:** SPEC-0010 R5: branch/tag resolved to exact commit before validation/activation. Same packageId+version with different digest = supply-chain conflict.

### 14. Self-verification
- **Result:** Pass
- **Evidence:** SPEC-0013 T12 maps to preventive control (producer/verifier separation per ADR 0014). SPEC-0008 R5 invariant 7: self-verification cannot grant authority.

### 15. Audit/evidence failure after external mutation
- **Result:** Pass
- **Evidence:** SPEC-0012 failure semantics: recovery-critical Operation journal MUST be persisted before external submission. Post-submission audit loss → submission_uncertain.

### 16. Sandbox escape assumptions
- **Result:** Pass
- **Evidence:** ADR 0015: S1-S23 conformance profile frozen. Technology is Proposed pending conformance proof. No weakening exceptions permitted.

## Residual Uncertainty

Low. Grant admission fencing addresses the TOCTOU concern at the normative level. Exact implementation (admission token format, invalidation mechanism) remains an implementation decision.
