# Reviewer D — Cost / Operability Review Report

**Date:** 2026-09-04
**Scope:** Forge VNext specification tranche

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** The specs are cost-conscious and operability-aware. SPEC-0006 defines the optimization target correctly (minimum expected cost to verified outcome, not cheapest call). SPEC-0012 separates audit from telemetry. SPEC-0015 defines hard invariants that get zero error budget. The zero-token-idle requirement (ADR 0014, SPEC-0009 R10) is a binding invariant. No blocking cost or operability issues found.

## Findings

### F1: Unknown cost semantics (SPEC-0006 R8)
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** cost/operability
- **Evidence:** SPEC-0006 R8: "Unknown usage/cost remains UNKNOWN, never zero. Under a hard monetary ceiling, unknown cost blocks further cost-incurring invocations unless a conservative bounding estimate or explicit alternative policy exists."
- **Why it matters:** Correctly specified. However, "conservative bounding estimate" could be complex to implement for providers without published pricing.
- **Proposed remediation:** Add guidance that for providers without pricing data, the conservative bound should use the configured maximum possible cost or deny unknown-cost providers under hard monetary ceilings (as the spec already allows via "explicit alternative policy").
- **Residual uncertainty:** Low — the spec correctly provides escape hatches for operators who want to allow unknown-cost providers.

### F2: Zero-token-idle proof requirement (SPEC-0008 R4)
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** cost/operability
- **Evidence:** SPEC-0008 R4: "Any feature claiming zero-token operation MUST instrument all model call paths and prove: model_call_count == 0. Source inspection alone is insufficient."
- **Why it matters:** This is a strong requirement that prevents the common failure mode of "we think it's zero-token but actually there's a hidden call." Well-specified.
- **Proposed remediation:** None. This is exemplary.
- **Residual uncertainty:** None.

### F3: Budget race oversubscription (SPEC-0006 R7)
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** cost/operability
- **Evidence:** SPEC-0006 R7: "Parallel reservations MUST NOT collectively oversubscribe a hard budget."
- **Why it matters:** Correctly specified. Preventing oversubscription requires atomic reservation operations, which the spec mentions.
- **Proposed remediation:** Add a note that the implementation should consider using database-level advisory locks or optimistic concurrency control for budget reservations, as the choice has performance implications.
- **Residual uncertainty:** Low — implementation detail.

### F4: Observability cardinality (SPEC-0012 R4)
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** cost/operability
- **Evidence:** SPEC-0012 R4: "Telemetry MUST NOT explode high-cardinality dimensions such as individual file paths, full prompt texts, full model responses, resource bodies, credential values, or unbounded user identifiers."
- **Why it matters:** Correctly specified. High-cardinality dimensions are a common cause of observability cost blowup.
- **Proposed remediation:** None. Well-specified.
- **Residual uncertainty:** None.

### F5: Default telemetry privacy (SPEC-0012 R6)
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** cost/operability
- **Evidence:** SPEC-0012 R6 lists what default telemetry MUST NOT export.
- **Why it matters:** This prevents accidental export of sensitive data through telemetry pipelines. Correctly specified.
- **Proposed remediation:** Add that the classification-based egress rules (SPEC-0005) should also apply to telemetry destinations. Telemetry to a third-party backend is a form of egress.
- **Residual uncertainty:** Low.

### F6: Provider failure storms
- **Severity:** Medium
- **Disposition:** Advisory
- **Angle:** cost/operability
- **Evidence:** SPEC-0006 R10 (provider readiness taxonomy) and SPEC-0006 R11 (routing receipts) provide the foundation for handling provider failures. However, there's no explicit requirement for circuit-breaking or backoff during provider outages.
- **Why it matters:** If a provider goes down, naive retry could cause a "retry storm" that wastes budget and amplifies the outage.
- **Proposed remediation:** Add a requirement that the invocation broker (SPEC-0006 R1) should implement circuit-breaking or exponential backoff for provider-level failures, not just per-Operation retries.
- **Residual uncertainty:** Low — the readiness taxonomy already captures "unreachable" state, which can be used for circuit-breaking.

### F7: Operational SLI baselining (SPEC-0015 R4)
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** cost/operability
- **Evidence:** SPEC-0015 R4: "Forge MUST collect baseline measurements for operational SLIs before setting numeric SLO targets."
- **Why it matters:** Correctly specified. Setting SLOs without data is guessing.
- **Proposed remediation:** None. Well-specified.
- **Residual uncertainty:** None.

## Pass Coverage

| Pass | Checked | Findings | Not Covered |
|---|---|---|---|
| Hidden model calls | Yes | 0 (SPEC-0008 R4) | - |
| Zero-token-idle violations | Yes | 0 (ADR 0014, SPEC-0009 R10) | - |
| Context amplification | Yes | 0 (SPEC-0006 R1 step 8) | - |
| Fan-out cost | Yes | 0 (SPEC-0006 R5) | - |
| Budget race oversubscription | Yes | F3 | Exact mechanism |
| Unknown cost | Yes | F1 | - |
| Retries/rework cost | Yes | 0 (SPEC-0006 R12) | - |
| Observability cardinality | Yes | 0 (SPEC-0012 R4) | - |
| Provider failure storms | Yes | F6 | Circuit-breaking |
| Queue wakeups | Yes | 0 (SPEC-0009, #347) | - |
| Operational complexity | Yes | 0 | - |

## Required Next Actions

All findings are advisory. No blocking issues.

- F1: Add guidance on conservative bounding estimates.
- F3: Add note on budget reservation concurrency control.
- F5: Cross-reference telemetry egress with SPEC-0005.
- F6: Add circuit-breaking requirement for provider failures.
