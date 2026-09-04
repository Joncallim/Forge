# Reviewer B — Security / Adversarial Review Report

**Date:** 2026-09-04
**Scope:** Forge VNext specification tranche

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** The specs build security on strong foundations: default-deny authorization (SPEC-0003 R1), explicit forbid-overrides-permit semantics (SPEC-0003 R2), fail-closed evaluation (SPEC-0003 R3), separation of Resource and Capability (SPEC-0003), untrusted external content (SPEC-0005 R7), credential brokering (SPEC-0005 R8), and a comprehensive threat model (SPEC-0013) mapped to existing controls. The sandbox conformance profile (ADR 0015) is principled and test-driven. No blocking security issues found.

## Findings

### F1: SPEC-0003 R6 — Sources that cannot mint authority
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** security/adversarial
- **Evidence:** SPEC-0003 R6 lists "Role labels (textual names)", "Prompt prose", "Model output", "Feature flags", "Package text or metadata", "External Resource contents", and "Adapter responses" as sources that MUST NOT mint authority.
- **Why it matters:** This is a comprehensive and correct list. However, "Adapter responses" is somewhat ambiguous — does it include the adapter's metadata about available operations?
- **Proposed remediation:** Clarify that adapter capability metadata (e.g., "I can also write files") is also untrusted authority, even if it comes from a trusted adapter channel. Only explicit Operation Catalog entries (SPEC-0004 R1) define available capabilities.
- **Residual uncertainty:** Low.

### F2: SPEC-0005 R7 — External Resource contents are untrusted
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** security/adversarial
- **Evidence:** SPEC-0005 R7 lists what untrusted data MUST NOT do. The list is comprehensive.
- **Why it matters:** This is a critical security boundary. The list correctly prohibits Capability minting, policy alteration, resource widening, routing changes, budget increases, secret requests, and verification disabling.
- **Proposed remediation:** Add one item: "change authentication decisions." Authentication of event sources (SPEC-0009 R3) should also be immune to untrusted data.
- **Residual uncertainty:** Low.

### F3: SPEC-0009 R3 — Authentication vs authorization separation
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** security/adversarial
- **Evidence:** SPEC-0009 R3: "Authentication of the event source (verifying who sent the event) MUST be separate from authorization to act (whether the source is permitted to trigger the resulting Execution)."
- **Why it matters:** Correctly specified. The separation ensures that a validly authenticated source cannot automatically trigger an Execution without proper authorization.
- **Proposed remediation:** None needed.
- **Residual uncertainty:** None.

### F4: SPEC-0010 R4 — Capability expansion requires review
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** security/adversarial
- **Evidence:** SPEC-0010 R4: "A package version that requests new or broader Capabilities MUST require explicit operator or policy review before activation."
- **Why it matters:** This prevents silent privilege escalation through package updates. Correctly specified.
- **Proposed remediation:** Add that transitive dependency capability expansion is also subject to review, not just direct capability requests. SPEC-0010 R7 already says "Transitive Capability requests MUST be visible to the operator before activation."
- **Residual uncertainty:** None.

### F5: SPEC-0003 R9 — Pinned behaviour vs current security
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** security/adversarial
- **Evidence:** SPEC-0003 R9: "Running Missions pin the following for reproducibility... However, before every new consequential action, Forge MUST re-evaluate the current security ceiling."
- **Why it matters:** This is a critical security invariant — a revoked permission must deny a previously pinned grant. Correctly specified.
- **Proposed remediation:** None needed. However, implementers should note that "current security ceiling" re-evaluation must not introduce a TOCTOU window between check and action.
- **Residual uncertainty:** Low — TOCTOU is a general implementation concern, not a spec gap.

### F6: SPEC-0013 — Threat model
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** security/adversarial
- **Evidence:** SPEC-0013 R1 maps 20 threats to preventive and detective controls. All controls reference existing Forge concepts.
- **Why it matters:** Comprehensive threat model with no gaps identified in the current scope.
- **Proposed remediation:** Add a note that the threat model should be expanded as new Capabilities (email, calendar, financial operations) are added.
- **Residual uncertainty:** Low — deferred threats are appropriate for v1.

### F7: Sentinel-secret tests (SPEC-0005 R9)
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** security/adversarial
- **Evidence:** SPEC-0005 R9 lists sentinel-secret test locations including "Model context (prompts)" and "Adapter responses."
- **Why it matters:** Comprehensive list. Ensuring these tests are part of CI and release gates is critical.
- **Proposed remediation:** None. Well-specified.
- **Residual uncertainty:** None.

## Pass Coverage

| Pass | Checked | Findings | Not Covered |
|---|---|---|---|
| Authority escalation | Yes | 0 | - |
| Prompt injection | Yes | F2 | Untrusted data boundary |
| Role/prose-derived permissions | Yes | 0 (SPEC-0003 R6) | - |
| Package supply chain | Yes | F4 | Transitive dependency review |
| Secret leakage | Yes | 0 (SPEC-0005 R8/R9) | - |
| Egress policy bypass | Yes | 0 (SPEC-0005 R4) | - |
| Confused deputy | Yes | 0 (SPEC-0013 T16) | - |
| Token passthrough | Yes | 0 (SPEC-0005 R8) | - |
| Sandbox escape | Yes | ADR 0015 | - |
| Stale approval | Yes | 0 (SPEC-0003 R8) | - |
| Stale security policy | Yes | 0 (SPEC-0003 R9) | TOCTOU |
| Self-verification | Yes | 0 (SPEC-0013 T12) | - |
| Malicious external events | Yes | 0 (SPEC-0009 R3, SPEC-0013 T19) | - |
| Evidence tampering | Yes | 0 (SPEC-0013 T13) | - |

## Required Next Actions

All findings are advisory. No blocking issues.

- F1: Clarify adapter capability metadata as untrusted authority.
- F2: Add authentication decisions to the untrusted-data protection list.
- F4: Cross-reference transitive capability review.
- F5: Note TOCTOU as implementation concern.
