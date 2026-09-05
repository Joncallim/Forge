# Reviewer A — Architecture / Distributed Systems Review Report

**Date:** 2026-09-04
**Scope:** Forge VNext specification tranche (SPEC-0001 through SPEC-0015, ADR 0015, frozen-vs-open, implementation-checklist, industry-benchmark-matrix)

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** The specs address dual-source-of-truth, state/outcome separation, replay semantics, idempotency, and cross-store durability comprehensively. SPEC-0002 explicitly prohibits compound status strings and separates lifecycle from outcome. SPEC-0004 defines the complete side-effect lifecycle including submission_uncertain. SPEC-0009 handles causality and loop prevention. SPEC-0014 mandates the EXPAND→BACKFILL→SHADOW→SWITCH→VERIFY→CONTRACT migration sequence. No blocking architecture issues found.

## Findings

### F1: Redis durability wording in SPEC-0009
- **Severity:** Medium
- **Disposition:** Advisory
- **Angle:** architecture/distributed-systems
- **Evidence:** SPEC-0009 R4 says "PostgreSQL MUST be the authoritative store for Trigger occurrence truth. Redis MAY be used for transport." SPEC-0002 R9 says "Redis is reconstructable queue/wakeup/retry/cache transport."
- **Why it matters:** The word "reconstructable" is aspirational — if Redis is the only wakeup mechanism and PostgreSQL is the truth, there must be a defined reconstruction path. The specs reference #347 for this but do not define the exact mechanism.
- **Proposed remediation:** Add a note in SPEC-0009 R4 referencing SPEC-0014 migration principles for how PostgreSQL truth is used to reconstruct Redis state after failure. The #347 issue body already covers this; the spec cross-reference would help.
- **Residual uncertainty:** Low — #347 is planned as a concrete implementation of this seam.

### F2: Lease/fencing details deferred to implementation
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** architecture/distributed-systems
- **Evidence:** SPEC-0002 R4 (Execution lifecycle includes `leased` state), SPEC-0002 concurrency section mentions "fencing tokens or equivalent". ADR 0015 mentions lease/fencing only in passing.
- **Why it matters:** Leases and fencing are critical for correctness in a distributed system. Leaving the exact mechanism to implementation is appropriate at the spec level, but implementers must know which patterns to follow.
- **Proposed remediation:** SPEC-0002 concurrency section should reference SPEC-0004's Operation lifecycle for how leases interact with side-effect states, and mention that the implementation should reuse proven queue/Epic-172 fencing patterns (as #340 does).
- **Residual uncertainty:** Low — the specs correctly avoid over-specifying implementation details.

### F3: Clock semantics for leases
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** architecture/distributed-systems
- **Evidence:** SPEC-0002 R9 defines UTC for timestamps and IANA for schedules, and says "monotonic duration measurements MAY use local monotonic clocks."
- **Why it matters:** Lease expiry must use authoritative clock semantics (database clock preferred over worker clock) to prevent stale workers from exploiting clock skew.
- **Proposed remediation:** SPEC-0002 R9 should explicitly state that lease expiry uses database clock as authority, consistent with the existing "authoritative clock semantics" language.
- **Residual uncertainty:** Low — the existing language already points in this direction.

### F4: Trigger causality and loop prevention
- **Severity:** Low
- **Disposition:** Advisory
- **Angle:** architecture/distributed-systems
- **Evidence:** SPEC-0009 R7 (causality tracking) and R8 (loop prevention) are well-defined.
- **Why it matters:** This is correctly specified. The bounded depth/count/budget/time requirements for explicit recursive flows are appropriate.
- **Proposed remediation:** None needed.
- **Residual uncertainty:** None.

### F5: Cross-store durability
- **Severity:** Medium
- **Disposition:** Advisory
- **Angle:** architecture/distributed-systems
- **Evidence:** SPEC-0014 R3 defines dual-write requirements. SPEC-0004 R4 defines Operation lifecycle including `submission_uncertain`.
- **Why it matters:** The dual-write semantics between PostgreSQL and Redis are correctly gated by #347, which defines the durable occurrence outbox. The specs correctly defer the exact mechanism while defining the principles.
- **Proposed remediation:** Add a cross-reference from SPEC-0014 R3 to SPEC-0004 R4 and #347 for the PostgreSQL→Redis durability seam.
- **Residual uncertainty:** Low.

## Pass Coverage

| Pass | Checked | Findings | Not Covered |
|---|---|---|---|
| Dual sources of truth | Yes | 0 | - |
| State/outcome conflation | Yes | 0 | - |
| Replay semantics | Yes | 0 | - |
| Leases/fencing | Yes | F2, F3 | Exact mechanism |
| Cross-store durability | Yes | F1, F5 | Exact reconstruction mechanism |
| Idempotency | Yes | 0 | - |
| Ambiguous submission | Yes | 0 | - |
| Trigger causality | Yes | 0 | - |
| Migration semantics | Yes | 0 | - |
| Time semantics | Yes | F3 | - |
| Restart recovery | Yes | 0 | - |

## Required Next Actions

All findings are advisory. No blocking issues.

- F1: Cross-reference #347 in SPEC-0009.
- F2: Reference SPEC-0004 and Epic-172 fencing patterns in SPEC-0002 concurrency section.
- F3: Clarify lease clock authority in SPEC-0002 R9.
- F5: Cross-reference between SPEC-0014 R3 and SPEC-0004 R4.
