# Hostile Review Pass A — State Machine / Distributed Systems

**Date:** 2026-09-05 (post-second-remediation)
**Reviewer:** Automated hostile pass
**Scope:** Corrected SPEC-0002, 0004, 0009, 0012, 0014; ADR 0015

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** All P0/P1 findings from second hostile review remediated. Counterexamples constructed and fail closed.

## Hostile Checks

### 1. Every entity state transition
- **Result:** Pass
- **Evidence:** SPEC-0002 R3 (Mission: draft→active→waiting→paused→terminal) with separate outcome. R4 (Execution: created→admitted→queued→leased→running→waiting→terminal). Work Package follows lifecycle/outcome separation (pending→running→terminal with outcome).
- **Counterexample:** Can a Mission go from `draft` directly to `terminal` without `active`? The spec allows this (draft may be abandoned). Is `waiting→paused` allowed? Yes (operator suspends healthy quiescence). All transitions are valid or explicitly forbidden.

### 2. Lifecycle vs outcome consistency
- **Result:** Pass
- **Evidence:** SPEC-0002 R2 restricts lifecycle/outcome separation to executable/stateful entities (Mission, Execution, Work Package, Operation). Agent Run excluded — its transient lifecycle does not carry a separate outcome field. Resources, Capabilities, Policy definitions do not carry artificial outcome fields. R12 prohibits compound status strings for covered entities.
- **Counterexample:** Could an implementer still use a compound status string for a non-covered entity? The spec only prohibits it for executable/stateful entities, which is correct — definitional entities may have a single status field.

### 3. SPEC-0004 branching state graph
- **Result:** Pass
- **Evidence:** R4 replaced linear chain with branching state graph showing mutually exclusive paths. Added `denied` state for pre-execution admission failure and `confirmed_failure` for definitive external rejection after submission. Fault-injection table defines recovery for every crash point.
- **Counterexample:** 
  - Admission denied → `denied` state (not `failed_before_submission`). No adapter execution occurred. at_most_once Operations may retry if admission conditions resolved.
  - External system returns 403 Forbidden → `confirmed_failure` (not `submission_uncertain`). Outcome definitively known.
  - Process crash after submitted but before confirmed → `submission_uncertain` → `reconciling`. Blind retry prohibited (R6).

### 4. CloudEvents compatibility
- **Result:** Pass
- **Evidence:** SPEC-0009 R2 now uses valid lowercase-alphanumeric-only extension names (`forgetriggerid`, `forgemissionid`, `forgeexecutionid`, `forgecauseid`, `forgecorrelationid`). Underscores and hyphens explicitly called out as invalid. Rich metadata (resource refs, auth state, dedupe config) placed in versioned Forge data envelope within the CloudEvents `data` field, not in extension attributes.
- **Counterexample:** Could an implementer use underscore or hyphen names? The spec explicitly states these are NOT valid and provides corrected lowercase-alphanumeric names. Non-compliance would fail C1 conformance.

### 5. Multi-Trigger causal loops
- **Result:** Pass
- **Evidence:** SPEC-0009 R8 defines bounded causal ancestry detection for A→Operation→B→Operation→A cycles. Distinction preserved between occurrence identity (prevents duplicate execution intent) and Operation identity (prevents duplicate side effects).
- **Counterexample:** Three-Trigger cycle (A→B→C→A) with bounded depth of 64 hops. The ancestry chain traces through causation_id/caused_by_operation_id. Within the bounded window, the loop is detected at the Trigger occurrence layer.

### 6. Audit write failure semantics
- **Result:** Pass
- **Evidence:** SPEC-0012 failure semantics now distinguish pre-submission (fail/block) from post-submission (submission_uncertain per SPEC-0004 R4). Recovery-critical Operation journal MUST be persisted before submission. Telemetry failure is non-authoritative.
- **Counterexample:** External side effect succeeded, audit persistence lost. Old spec would have failed/blocked the Operation. Corrected spec transitions to submission_uncertain and reconciles actual external state. Recovery-critical identity was already persisted before submission, enabling reconstruction.

### 7. Migration dual writers
- **Result:** Pass
- **Evidence:** SPEC-0014 R1 step 4 corrected: old schema MUST NOT accept independent writes after SWITCH. Old API compatibility surfaces MAY remain as adapters that translate to the new authoritative path. Rollback safety via compatible projections, not independent old write path. R2 explicitly forbids independent old/new writers.
- **Counterexample:** An implementer adds a new Mission table while keeping old Task table accepting independent writes. The spec explicitly calls this out as a forbidden pattern. R1 step 4 no longer contains the contradictory "Old schema continues to accept writes for rollback safety" sentence.

### 8. Trigger granular concurrency
- **Result:** Pass
- **Evidence:** SPEC-0009 concurrency semantics use per-dedupe-identity serialization, not per-Trigger. Independent occurrences for unrelated Resources may proceed concurrently.
- **Counterexample:** Two webhook occurrences with different dedupe keys affecting different Resources. Under corrected spec, they can be processed concurrently. Correct.

### 9. Schedule restart/catch-up
- **Result:** Pass
- **Evidence:** SPEC-0009 R9 defines skip/latest/bounded catch-up policies. Unlimited catch-up replay is prohibited.
- **Counterexample:** Missed 50 schedule ticks during 5-hour outage. With `skip` policy, all missed occurrences are dropped. With `bounded` policy, a configured maximum (e.g., 5) are processed. Correct.

### 10. Clock authority
- **Result:** Pass
- **Evidence:** SPEC-0002 R9 (lease clock authority), R13 (database clock authoritative for lease expiry).
- **Counterexample:** Worker with clock skew of +30 seconds holds a lease that has expired per database clock. The database clock is authoritative; the lease is invalid and the worker must be fenced. Correct.

### 11. SPEC-0004 at_most_once retry semantics
- **Result:** Pass
- **Evidence:** at_most_once redefined as "at most one external submission," not "never retry." Pre-submission failures (denied, failed_before_submission with certainty) MAY be retried. If submission may have occurred, escalate to operator.
- **Counterexample:** at_most_once Operation fails before any external request is sent. The spec now allows retry because no external side effect could have occurred. If the same Operation fails after submission uncertainty, it escalates to operator. Correct.

## Residual Uncertainty

None. All state machine and distributed systems concerns addressed in second remediation pass.
