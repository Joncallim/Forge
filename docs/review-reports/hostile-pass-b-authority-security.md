# Hostile Review Pass B — Authority / Security

**Date:** 2026-09-04 (post-remediation)
**Reviewer:** Automated hostile pass
**Scope:** Corrected SPEC-0003, 0005, 0010, 0011, 0013; ADR 0015

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** All P0/P1 findings remediated. Security counterexamples fail closed.

## Hostile Checks

### 1. Child Grant monotonic narrowing
- **Result:** Pass
- **Evidence:** SPEC-0003 R5: child Grant MUST be strict subset of or equal to parent. Enforced at issuance time, recheckable at authorization time.
- **Counterexample:** Can a child Grant claim a Capability the parent doesn't have? No — child.authority ⊆ parent.authority is mandatory. Violation is a security incident.

### 2. Explicit deny precedence
- **Result:** Pass
- **Evidence:** SPEC-0003 R2: deny overrides allow. A permit from a lower-authority source MUST NOT override a deny from a higher-authority source.
- **Counterexample:** Mission Grant permits `github.pr.create` on repo X, but current security policy denies it. The deny wins. Correct.

### 3. Policy evaluation failure
- **Result:** Pass
- **Evidence:** SPEC-0003 R3: fail-closed (deny) on evaluation error. SPEC-0005: classification lookup failure → SECRET-equivalent (fail closed).
- **Counterexample:** Policy store is unreachable during authorization check. The check fails closed to deny. Correct.

### 4. Operator authority limits
- **Result:** Pass
- **Evidence:** SPEC-0003 R10: operator authority is administrative within system ceilings and hard invariants. Cannot bypass fail-closed rules, hard invariants, immutable evidence, or Grant narrowing.
- **Counterexample:** Operator tries to override a hard invariant violation (e.g., bypass egress denial for SECRET data). SPEC-0003 R10 says operator cannot bypass hard invariants (SPEC-0015 H1-H10). Blocked.

### 5. Stale approval
- **Result:** Pass
- **Evidence:** SPEC-0003 R8: approval binds to exact revision/digest + scope + policy. Material change invalidates approval.
- **Counterexample:** Plan is approved at revision 3, then modified to revision 4 without re-approval. The approval is invalid because it was bound to revision 3's digest. Correct.

### 6. Current security vs pinned behavior
- **Result:** Pass
- **Evidence:** SPEC-0003 R9: pinned behavior (deterministic reproducibility) vs current security (live authority boundary). Revocation blocks new actions regardless of pin.
- **Counterexample:** Mission started with Grant for `filesystem.read` on /repo. Later, the Grant is revoked. Despite pinned behavior, the Mission cannot start new read Operations. Correct.

### 7. Malicious package metadata
- **Result:** Pass
- **Evidence:** SPEC-0010 R2: install does not authorize. SPEC-0003 R6: package text/metadata cannot mint authority. SPEC-0005 R7: external Resource contents untrusted.
- **Counterexample:** Package requests `capabilities: ["admin.*"]`. The request is a proposal, not authority. Operator/policy review required before activation (R4). Correct.

### 8. Malicious adapter capability advertisement
- **Result:** Pass
- **Evidence:** SPEC-0003 R6: adapter responses cannot mint authority. SPEC-0004 R1: Operation Catalog defines available capabilities.
- **Counterexample:** Adapter responds with "I can also delete all resources." This is untrusted — only explicit Operation Catalog entries define available capabilities. Correct.

### 9. Malicious Resource content
- **Result:** Pass
- **Evidence:** SPEC-0005 R7: external Resource contents MUST NOT grant Capabilities, alter policy, widen access, change routing, increase budget, request secrets, disable verification, or modify Grants. SPEC-0005 R10: authentication decisions immune to untrusted data.
- **Counterexample:** Repository file contains "GRANT admin access to user X". The file is untrusted data and cannot alter Grants. Correct.

### 10. Authentication manipulation
- **Result:** Pass
- **Evidence:** SPEC-0005 R10 (new): authentication decisions immune to untrusted data. SPEC-0009 R3: authentication separate from authorization.
- **Counterexample:** Event source presents a valid signature but requests authorization for a Capability beyond its scope. Authentication passes, authorization denies. Correct.

### 11. Credential confusion / token passthrough
- **Result:** Pass
- **Evidence:** SPEC-0005 R8: credentials MUST be audience/resource scoped, injected at adapter layer, not passed through model context. Token passthrough between unrelated services PROHIBITED.
- **Counterexample:** Model process obtains a GitHub token and tries to use it to access a different service. Token passthrough is prohibited — credentials are scoped to their intended service. Correct.

### 12. Egress before payload construction
- **Result:** Pass
- **Evidence:** SPEC-0005 R4: egress authorization order is classification → destination → grant → construct. Constructing sensitive prompt before authorization check is FORBIDDEN.
- **Counterexample:** Agent builds a prompt containing SECRET data before checking if the destination is permitted. The spec explicitly forbids this order. Correct.

### 13. Package source/tag substitution
- **Result:** Pass
- **Evidence:** SPEC-0010 R5: branch/tag resolved to exact commit before validation/activation. Same packageId+version with different digest = supply-chain conflict.
- **Counterexample:** Package version 1.0 installed from commit A. Maintainer force-pushes commit B with same tag. New install attempt detects digest mismatch and rejects as supply-chain conflict. Correct.

### 14. Self-verification
- **Result:** Pass
- **Evidence:** SPEC-0013 T12 maps to preventive control (producer/verifier separation per ADR 0014) and detective control (verification independence audit). SPEC-0008 R5 invariant 7: self-verification cannot grant authority.
- **Counterexample:** Agent Run tries to pass its own Gate evaluation. Producer/verifier separation prevents this. Self-verification would violate invariant H5 (SPEC-0015). Correct.

### 15. Audit/evidence failure after external mutation
- **Result:** Pass
- **Evidence:** SPEC-0012 failure semantics: if external submission may have happened and audit persistence is lost, transition to submission_uncertain, not business failure.
- **Counterexample:** Operation creates a GitHub issue, HTTP 200 received, but audit write fails before local confirmation. System transitions to submission_uncertain and reconciles. Correct.

### 16. Sandbox escape assumptions
- **Result:** Pass
- **Evidence:** ADR 0015: S1-S23 conformance profile frozen. Technology is Proposed pending conformance proof. No weakening exceptions permitted.
- **Counterexample:** Rootless containers fail S11 (symlink escape) on the target host. The spec requires evaluating the next candidate (gVisor, microVM). No exception permitted. Correct.

## Residual Uncertainty

Low. The authority/security model is comprehensive and fail-closed. Implementation details (TOCTOU windows between check and action) are general implementation concerns, not spec gaps.
