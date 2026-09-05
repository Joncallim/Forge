# Hostile Review Pass C — Migration / Source of Truth

**Date:** 2026-09-05 (post-second-remediation)
**Reviewer:** Automated hostile pass
**Scope:** Corrected SPEC-0014, SPEC-0002, #334 issue

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** Single-writer discipline now fully consistent. R1 step 4 corrected — no contradictory "old schema accepts writes" language remains.

## Hostile Checks

### 1. Current Project/Task request trace
- **Result:** Pass
- **Evidence:** SPEC-0014 R7: Project = workspace/resource-binding context. Task = finite coding-request compatibility surface mapping to a Mission. Old Task UI creates a Mission and one Execution through the compatibility adapter.
- **Counterexample:** A user creates a Task with a PR description. The Task routes through the compatibility adapter, which creates a Mission with lifecycle=active, outcome=null, and an Execution with lifecycle=created. The old Task API response remains unchanged. Correct.

### 2. Migration into Mission/Execution
- **Result:** Pass
- **Evidence:** SPEC-0014 R1: EXPAND→BACKFILL→SHADOW→SWITCH→VERIFY→CONTRACT sequence. R2: exactly one authoritative write path at any point.
- **Counterexample:** During SHADOW phase, old code still writes to Task table. New code reads from both Task and Mission tables and compares results. No authoritative switch yet. Correct.

### 3. Retry/replan
- **Result:** Pass
- **Evidence:** SPEC-0014 R7: retries/attempts = Executions (one per attempt under the same Mission). SPEC-0002: Mission can have multiple Executions.
- **Counterexample:** Task is retried 3 times. This creates 1 Mission (the Task's intent) with 3 Executions (one per retry). Each Execution has its own lifecycle and outcome. Correct.

### 4. Schema transition — SWITCH step verified
- **Result:** Pass
- **Evidence:** SPEC-0014 R1 step 4: "SWITCH AUTHORITATIVE PATH — All writes (including those from old API compatibility adapters) MUST route through the new canonical writer. Old API compatibility surfaces MAY remain as adapters that translate to the new authoritative path. The old persistence schema MUST NOT accept independent writes."
- **Contradiction check:** The previous version of R1 step 4 said "Old schema continues to accept writes for rollback safety" which directly contradicted R2's single-writer discipline. This sentence has been removed and replaced with the corrected language above.
- **Counterexample:** An implementer reads R1 step 4 and sees "old schema MUST NOT accept independent writes" — consistent with R2. No contradiction. Correct.

### 5. Rollback
- **Result:** Pass
- **Evidence:** SPEC-0014 R8: every migration MUST have documented rollback procedure. Rollback point MUST be tested before production. Rollback relies on preserved compatible projections, not independent old write path.
- **Counterexample:** After SWITCH, a critical bug is found. Rollback procedure switches back to old schema as authoritative. The old schema was kept in a readable state through projections; it was never independently written to after SWITCH. Rollback is safe. Correct.

### 6. Old API compatibility
- **Result:** Pass
- **Evidence:** SPEC-0014 R7: old code paths continue using Project/Task through compatibility seam. Seam translates to Mission/Execution internally.
- **Counterexample:** Old code calls `getTask(taskId)`. Compatibility adapter looks up the corresponding Mission, extracts current lifecycle/outcome, and returns the old Task format. No dual truth. Correct.

### 7. Shadow compare
- **Result:** Pass
- **Evidence:** SPEC-0014 R1 step 3: SHADOW COMPARE runs old and new paths in parallel, compares results, does not switch authoritative read or write yet.
- **Counterexample:** Shadow compare runs old Task→Project read and new Mission→Execution read for the same entity. Results are compared. Discrepancies are logged but do not affect production state. Correct.

### 8. Authoritative write switching
- **Result:** Pass
- **Evidence:** SPEC-0014 R1 step 4: all writes route through new canonical writer. Old persistence schema MUST NOT accept independent writes.
- **Counterexample:** After SWITCH, an old code path tries to write directly to the Task table. This is forbidden — all writes must go through the compatibility adapter which produces canonical Mission/Execution state. Correct.

## Residual Uncertainty

Low. The migration sequence and single-writer discipline are now fully consistent.
