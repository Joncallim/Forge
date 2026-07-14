# Issue #181 Architecture Review Amendments

Status: historical review record.

All normative amendments below were incorporated into
`issue-181-e2e-admission-regression.md` during integrated review round 3. The
primary architecture document is authoritative; this file records why it changed
and must not override or narrow the primary document.

## Review round 1 findings and resolutions

### 1. Test ownership must prevent duplicate policy suites

The S6 suite composes, rather than recopies, lower-slice coverage:

- #177 owns canonical classifier/admission and approval/handoff parity unit matrices;
- #178 owns grant recovery and project/task endpoint concurrency tests;
- #179 owns issuance fencing, failure-point, prompt serialization, and artifact uniqueness tests;
- #180 owns presentation matrix and component accessibility tests;
- #181 owns representative cross-slice flows and a small sentinel subset proving the pieces remain connected.

S6 may import shared fixtures and call lower-level test helpers, but must not maintain a second divergent policy implementation or duplicate every exhaustive matrix row.

### 2. Real approve-route testing needs a truthful dependency seam

The route handler must execute unchanged. External/live MCP health acquisition may be replaced at its existing service boundary with a deterministic fake that returns real `ProjectMcpStatus` shapes and writes the same cached rows. Do not add a production-only bypass or set task status directly.

Test invocation should use the actual HTTP/route contract, authenticated operator context, database transaction, and response payload. The fake seam is limited to network/system health probes and Redis wake-up transport.

### 3. Fixed health parity needs a shared captured observation

The invariant suite must pass one immutable `McpHealthSnapshot[]` fixture to each surface. It must not call live/current health separately for preview, approval, and handoff. Real-route tests separately verify that the route captures health outside the transaction and persists/uses that exact observation.

### 4. Mutation-sentinel tests should prove the invariant suite is meaningful

Add a small test-only mutation harness or deliberately altered adapter fixture showing that the parity suite fails when one surface changes mode/status, drops requirement identity, or selects a different primary blocker. Do not mutate production source at runtime or use brittle source-text rewriting.

### 5. Playwright must not become the concurrency authority

Playwright verifies visible copy, action availability, focus, and the operator flow. PostgreSQL integration tests remain authoritative for zero attempts, row locks, nonce claims, metadata preservation, and artifact uniqueness. Playwright assertions should reference stable semantic selectors and avoid timing-dependent internal state.

### 6. CI runtime and diagnostics need an explicit budget

Split test commands/tags into:

- fast invariant suite;
- PostgreSQL integration suite;
- issuance race/recovery suite;
- Playwright flow.

Use deterministic timeouts, fixed clocks/database time, and bounded race barriers. Failure diagnostics print IDs and canonical tuples but never raw packet content, file paths, credentials, or rejected Architect text.

### 7. Cross-slice fixture versioning

Scenario fixtures carry a schema version and name the expected lower-slice contracts. If a producer schema changes, fixture parsing fails clearly rather than silently defaulting. Scenario builders consume production normalizers/admission contracts and never duplicate their logic.

## Historical round 2 conclusion

At that point the architecture had clearer ownership, exercised the real route,
shared fixed observations, and kept Playwright from becoming an alternate policy
implementation. Integrated round 3 later added the complete failure/recovery and
mixed-version matrices, both packet grant modes, PostgreSQL-time barriers,
persistence-wide leakage sentinels, exact CI budgets, and ADR 0008 supersession;
consult the primary document for the current contract.
