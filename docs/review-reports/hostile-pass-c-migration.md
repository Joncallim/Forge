# Hostile Review Pass C — Migration / Source of Truth

**Date:** 2026-09-04 (post-remediation)
**Reviewer:** Automated hostile pass
**Scope:** Corrected SPEC-0014, SPEC-0002, #334 issue

## Review Verdict

**Status:** No blockers found in the inspected scope
**Confidence:** High
**Reason:** Single-writer discipline is now explicit. Mapping is corrected and consistent.

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

### 4. Schema transition
- **Result:** Pass
- **Evidence:** SPEC-0014 R1: EXPAND (add Mission/Execution tables) → BACKFILL (populate from Task/Project) → SHADOW → SWITCH → VERIFY → CONTRACT.
- **Counterexample:** EXPAND adds Mission table with new schema. BACKFILL populates it from existing Task records. SHADOW runs both paths and compares. SWITCH makes Mission authoritative for reads, but old API writes still route through compatibility adapter. VERIFY confirms all consumers use new authority. CONTRACT removes old Task table. Correct.

### 5. Rollback
- **Result:** Pass
- **Evidence:** SPEC-0014 R8: every migration MUST have documented rollback procedure. Rollback point MUST be tested before production. Rollback restores previous authoritative representation.
- **Counterexample:** After SWITCH, a critical bug is found. Rollback procedure restores Task table as authoritative. Compatibility adapter switches back. Mission table data may be preserved for re-migration. Correct.

### 6. Old API compatibility
- **Result:** Pass
- **Evidence:** SPEC-0014 R7: old code paths continue using Project/Task through compatibility seam. Seam translates to Mission/Execution internally.
- **Counterexample:** Old code calls `getTask(taskId)`. Compatibility adapter looks up the corresponding Mission, extracts current lifecycle/outcome, and returns the old Task format. No dual truth. Correct.

### 7. Shadow compare
- **Result:** Pass
- **Evidence:** SPEC-0014 R1 step 3: SHADOW COMPARE runs old and new paths in parallel, compares results, does not switch authoritative read yet.
- **Counterexample:** Shadow compare runs old Task→Project read and new Mission→Execution read for the same entity. Results are compared. Discrepancies are logged but do not affect production state. Correct.

### 8. Authoritative write switching
- **Result:** Pass
- **Evidence:** SPEC-0014 R2: single-writer discipline. Old API writes route through compatibility adapter. No independent old/new writers.
- **Counterexample:** After SWITCH, an old code path tries to write directly to the Task table. This is forbidden — all writes must go through the compatibility adapter which produces canonical Mission/Execution state. Correct.

## Residual Uncertainty

Low. The migration sequence and single-writer discipline are well-defined. The exact database migration shape remains an implementation decision (#334).
