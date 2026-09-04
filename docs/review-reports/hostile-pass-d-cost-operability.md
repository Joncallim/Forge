# Hostile Review Pass D — Cost / Operability

**Date:** 2026-09-04 (post-remediation)
**Reviewer:** Automated hostile pass
**Scope:** Corrected SPEC-0006, 0012, 0015

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** Circuit-breaking refined by failure class. SLO semantics corrected. Cost model comprehensive.

## Hostile Checks

### 1. Parallel reservation oversubscription
- **Result:** Pass
- **Evidence:** SPEC-0006 R7: sum of active reservations + consumed usage MUST NOT exceed hard ceiling. Atomic reservation required.
- **Counterexample:** Budget has $10 hard limit. Three concurrent invocations each reserve $4 ($12 total). The system must detect this would exceed the limit and deny the third invocation. Correct.

### 2. Provider outage storms
- **Result:** Pass
- **Evidence:** SPEC-0006 R14: per-failure-class circuit-breaking with exponential backoff. No generic cooldown.
- **Counterexample:** Provider is unreachable. Circuit-breaker stops routing new invocations, applies exponential backoff, periodically probes. After recovery, resumes routing. No retry storm. Correct.

### 3. Auth-error retry storms
- **Result:** Pass
- **Evidence:** SPEC-0006 R14: authentication_error blocks until credentials/config change or explicit readiness validation succeeds. No automatic retry.
- **Counterexample:** Provider credentials expire. Circuit-breaker blocks all invocations and does NOT retry automatically. Operator must fix credentials and explicitly validate. Correct.

### 4. Unknown cost
- **Result:** Pass
- **Evidence:** SPEC-0006 R8: unknown cost remains UNKNOWN, never zero. Under hard monetary ceiling, blocks further cost-incurring invocations unless conservative bounding estimate or alternative policy exists.
- **Counterexample:** Provider doesn't return usage data. Cost is recorded as UNKNOWN. If a hard $10 ceiling exists and $8 is already consumed, the remaining $2 must be reserved conservatively. If unknown cost exceeds remaining budget, the invocation is denied. Correct.

### 5. Hidden model calls
- **Result:** Pass
- **Evidence:** SPEC-0006 R1: every production model invocation MUST cross the governance boundary. SPEC-0008 R4: zero-token-idle proof requires instrumented invocation boundary.
- **Counterexample:** A "deterministic" operation silently calls a model for "just one quick classification." The governance boundary would catch this — every production call must cross the boundary (R1). Correct.

### 6. Idle model usage
- **Result:** Pass
- **Evidence:** SPEC-0009 R10: Trigger with no pending occurrences consumes zero model tokens. SPEC-0002 R11: waiting Mission consumes zero model tokens. SPEC-0015 H7: model call on declared zero-token path is a hard invariant violation.
- **Counterexample:** Schedule evaluation checks every second and calls a model to "see if anything interesting happened." This violates zero-token-idle and triggers H7. Correct.

### 7. Trigger/event storms
- **Result:** Pass
- **Evidence:** SPEC-0009 R5: deduplication strategies (exact_match, idempotent, coalesce, latest_only). SPEC-0009 R8: bounded depth/count/budget/time for recursive flows.
- **Counterexample:** Webhook receives 1000 identical requests in 1 second. exact_match dedup strategy with appropriate window reduces to one occurrence. Event storm handled without creating 1000 Executions. Correct.

### 8. Telemetry cardinality
- **Result:** Pass
- **Evidence:** SPEC-0012 R4: telemetry MUST NOT explode high-cardinality dimensions. SPEC-0012 R6: default telemetry MUST NOT export prompts, responses, resource bodies, credentials, PII.
- **Counterexample:** Implementation adds per-file-path telemetry dimension. This is prohibited by R4. Correct.

### 9. Conformance suite operational cost
- **Result:** Pass
- **Evidence:** SPEC-0008 R4: zero-token-idle proof requires instrumentation, not source inspection. SPEC-0008 R7: tests MUST be isolated, MUST NOT depend on other tests' side effects.
- **Counterexample:** Conformance suite makes real model calls during testing. Tests must use isolated fixtures and must not depend on production credentials (SPEC-0008 security section). Correct.

### 10. Package install/update churn
- **Result:** Pass
- **Evidence:** SPEC-0010 R4: capability expansion requires review per version. SPEC-0010 R8: running Mission pins package version — updates don't alter running Missions.
- **Counterexample:** Package is updated 50 times in a day. Each update with capability changes requires review. Running Missions are unaffected. Correct.

## Residual Uncertainty

Low. Cost/operability concerns are well-addressed. Exact provider cost metadata source/update mechanism (#335) remains an implementation decision.
