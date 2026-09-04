# Hostile Review Pass A — State Machine / Distributed Systems

**Date:** 2026-09-04 (post-remediation)
**Reviewer:** Automated hostile pass
**Scope:** Corrected SPEC-0002, 0004, 0009, 0012, 0014; ADR 0015

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** All P0/P1 findings remediated. Counterexamples constructed and fail closed.

## Hostile Checks

### 1. Every entity state transition
- **Result:** Pass
- **Evidence:** SPEC-0002 R3 (Mission: draft→active→waiting→paused→terminal) with separate outcome. R4 (Execution: created→admitted→queued→leased→running→waiting→terminal). Work Package follows lifecycle/outcome separation (pending→running→terminal with outcome).
- **Counterexample:** Can a Mission go from `draft` directly to `terminal` without `active`? The spec allows this (draft may be abandoned). Is `waiting→paused` allowed? Yes (operator suspends healthy quiescence). All transitions are valid or explicitly forbidden.

### 2. Lifecycle vs outcome consistency
- **Result:** Pass
- **Evidence:** SPEC-0002 R2 restricts lifecycle/outcome separation to executable/stateful entities. Resources, Capabilities, Policy definitions do not carry artificial outcome fields. R12 prohibits compound status strings.
- **Counterexample:** Could an implementer still use a compound status string for a non-covered entity? The spec only prohibits it for executable/stateful entities, which is correct — definitional entities may have a single status field.

### 3. SPEC-0004 branching state graph
- **Result:** Pass
- **Evidence:** R4 replaced linear chain with branching state graph showing mutually exclusive paths. Fault-injection table defines recovery for every crash point.
- **Counterexample:** Process crash after submitted but before confirmed → submission_uncertain → reconciling. Blind retry after uncertain submission is prohibited (R6). Correct.

### 4. CloudEvents compatibility
- **Result:** Pass
- **Evidence:** SPEC-0009 R2 uses valid lowercase-alphanumeric extension names (forge_trigger_id, forge_mission_id, etc.). Warning text explains why colon/underscore names are invalid.
- **Counterexample:** Could an implementer still use colon-separated names? The spec explicitly states they are NOT valid CloudEvents extension attribute names and provides corrected alternatives. Non-compliance would fail C1 conformance.

### 5. Multi-Trigger causal loops
- **Result:** Pass
- **Evidence:** SPEC-0009 R8 defines bounded causal ancestry detection for A→Operation→B→Operation→A cycles. Distinction preserved between occurrence identity (prevents duplicate execution intent) and Operation identity (prevents duplicate side effects).
- **Counterexample:** Three-Trigger cycle (A→B→C→A) with bounded depth of 64 hops. The ancestry chain traces through causation_id/caused_by_operation_id. Within the bounded window, the loop is detected at the Trigger occurrence layer.

### 6. Audit write failure semantics
- **Result:** Pass
- **Evidence:** SPEC-0012 failure semantics now distinguish pre-submission (fail/block) from post-submission (submission_uncertain per SPEC-0004 R4). Telemetry failure is non-authoritative.
- **Counterexample:** External side effect succeeded, audit persistence lost. Old spec would have failed/blocked the Operation. Corrected spec transitions to submission_uncertain and reconciles actual external state. Correct.

### 7. Migration dual writers
- **Result:** Pass
- **Evidence:** SPEC-0014 R2 explicitly forbids independent old/new writers. Single-writer discipline requires old API writes to route through compatibility adapter. Forbidden pattern documented.
- **Counterexample:** An implementer adds a new Mission table while keeping old Task table accepting independent writes. The spec explicitly calls this out as a forbidden pattern.

### 8. Trigger granular concurrency
- **Result:** Pass
- **Evidence:** SPEC-0009 concurrency semantics use per-dedupe-identity serialization, not per-Trigger. Independent occurrences for unrelated Resources may proceed concurrently.
- **Counterexample:** Two webhook occurrences with different dedupe keys affecting different Resources. Under corrected spec, they can be processed concurrently. Under old spec, they would be serialized per-Trigger. Correct.

### 9. Schedule restart/catch-up
- **Result:** Pass
- **Evidence:** SPEC-0009 R9 defines skip/latest/bounded catch-up policies. Unlimited catch-up replay is prohibited.
- **Counterexample:** Missed 50 schedule ticks during 5-hour outage. With `skip` policy, all missed occurrences are dropped and only the next scheduled one fires. With `bounded` policy, a configured maximum (e.g., 5) are processed. Correct.

### 10. Clock authority
- **Result:** Pass
- **Evidence:** SPEC-0002 R9 (lease clock authority), R13 (database clock authoritative for lease expiry).
- **Counterexample:** Worker with clock skew of +30 seconds holds a lease that has expired per database clock. The database clock is authoritative; the lease is invalid and the worker must be fenced. Correct.

## Residual Uncertainty

None. All state machine and distributed systems concerns addressed.
