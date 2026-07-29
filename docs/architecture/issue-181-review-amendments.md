# Issue #181 Architecture Review Amendments

Status: historical review record.

All normative amendments below were incorporated into
`issue-181-e2e-admission-regression.md` during the cited integrated review rounds.
The primary architecture document is authoritative; this file records why it
changed and must not override or narrow the primary document.

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

## Integrated review round 24 findings and resolutions

### 8. S6 must use the same controller-token bytes as S4

The earlier S6 wording said only “domain-separated digest,” which could let the
external controller, database heartbeat, and verifier implement different byte
formats. The primary document now imports S4's exact 32-byte secret, UTF-8 domain,
SHA-256 construction, binary storage, constant-time comparison, and fixed vector.
Cross-component tests reject wrong lengths, domains, encodings, generations,
replays, and compare-and-set losers.

### 9. Human plan-history reads need a real database session contract

The earlier text referred generically to a live database session even though the
current application stores a raw cookie UUID in `public.sessions`, keeps expiry in
Redis, and has no database expiry column. The primary document now imports S4's
exact digest and expiry columns, UUID credential bytes, fixed vector, PostgreSQL-
authoritative sliding refresh, database-before-cache create/refresh/revoke ordering,
digest-keyed cache repair, and bounded legacy rekey migration. Expiry, revocation,
cache failure, malformed credentials, crash/resume, and final raw-key removal are
explicit release-blocking tests.

### 10. Durable Step 0 evidence is not permission for S3 to advance

The S6 release-order restatement previously let `s3_issue_178` appear to proceed
from the durable Step 0 receipt alone. The primary document now requires the S3
transaction to lock that receipt and consume one fresh, exact
`forge_epic_172_transition_authorizations` row before recording S3 evidence.
Expiry, replay, wrong-domain/binding, duplicate transition, and rollback cases fail
closed.

### 11. Correct the duplicated manifest wording

The duplicated `canonical` word is removed; the text now says “canonical version-2
manifest.”

## Integrated review round 25 findings and resolutions

Round 24's five `Joncallim`-authored P0/blocker findings on
`issue-181-e2e-admission-regression.md` were re-checked twice: first against the
S6 branch head alone, and then against the **result of merging the current #180
(S5) base into it**. That second check matters, and corrects the first: two
findings that are absent from the S6 head alone are re-introduced by the base
branch, because the same files are edited on both sides. Dispositions below are
stated against the merged tree, which is what actually ships:

- **Duplicate `test:mcp:issuance` script key.** Not stale, and the duplicate
  turned out to be a symptom of a deeper ownership error rather than a naming
  accident. See "Packet issuance belongs to #179/S4" below for the full
  analysis and the resolution. `web/package.json` now parses with no duplicate
  keys, and every remaining partition collects exactly its manifest count
  (2 postgres, 1+1 operator, 7 host-boundary under
  `FORGE_TRUSTED_HOST_BOUNDARY=1`).
- **S6 release-adapter callbacks.** The adapter no longer accepts injected
  `recordOwnedEvidence`/`consumeOwnedTransition` callbacks; it wraps a single
  concrete `executeEpic172S6AtomicTransition` implementation that opens the
  transition database under the fixed `forge_release_transition` role. See the
  known limitation recorded below for the one remaining gap in that function.
- **CI uploads raw Playwright artifacts.** Not stale — same pattern. The S6
  head carries no upload step, but the #180 base adds `actions/upload-artifact`
  with `if: always()` over the raw report and result trees, so merging
  re-introduces it. The merge drops that step and records why inline. This is
  not merely a policy preference: `__tests__/epic-172-s6-ci-contract.test.ts`
  asserts the workflow contains no such upload, so keeping the base's side
  fails the build.
- **Integrated suite red despite a healthy build.** Resolved, and re-verified
  on the merged tree rather than the head alone. After merging #180 and
  resolving all five conflicts, `npx tsc --noEmit`, `npm run lint --
  --max-warnings=0`, `npm run test:unit:zero-skip` (1738 passed, 0 failed),
  `npm run test:mcp:contract`, and `npm run build` all pass. The finding's
  concern that S6's CI *replaces* required Step-0/S3/S4 steps is addressed
  directly by the merge: the resolved `web-ci.yml` keeps the ordinary-app role
  provisioning, the mandatory S4 PostgreSQL zero-skip proof, the mandatory S3
  PostgreSQL concurrency proof, and the Step-0 disabled-ingress and bridge
  suites, *and* adds the four S6 manifest partitions.
- **External trust evidence.** Still genuinely outstanding — see below. This
  is an operational/DevOps dependency (installing and configuring the
  external controller GitHub App), not something this PR's code can supply.

Two `chatgpt-codex-connector` findings were also triaged:

- **P1 — trusted workflow accepted a moving ref.**
  `.github/workflows/mcp-host-boundary-trusted.yml` now rejects any
  `reviewed_sha` input that is not an exact 40-character lowercase hex commit
  SHA before checkout, closing the branch/tag substitution path. Fixed.
- **P2 — S6 transition adapter selects columns from the S3 completion lock.**
  `executeEpic172S6AtomicTransition` calls
  `forge.lock_epic_172_s3_completion_v1`, which returns `void` and belongs to
  the S3 completion state machine, not a dedicated S6 receipt/consumption
  routine. This is a real defect in the SQL call, confirmed against
  `db/migrations/0026_epic_172_s3_grant_lifecycle.sql`. **Known limitation,
  deferred rather than fixed in this PR:** the function is not called from any
  production code path (only from its own unit test's
  no-database-URL branch), the S6 controller defaults to
  `mode: 'disabled'` / `externalControllerRequired: true`, and there is no
  live path that can reach this query today. Wiring S6 to the correct generic
  `forge.consume_epic_172_release_evidence_v1` routine (plus a matching
  evidence-recording call) is real follow-up work, tracked against #181/#172,
  and should land before the S6 controller is ever enabled — not before this
  beta-scoped architecture PR merges.

### Beta scope note

Per project direction, this PR intentionally does not chase every
release-grade external-trust guarantee described in the primary document
(exact-App ruleset binding, live controller attestation, signed
destruction receipts) before merging. Those remain real requirements before
the S6 controller is *enabled* in production, but are not required to land
this architecture-and-test-scaffolding PR for a beta. The primary document's
language describing the fully-enabled target state is left as-is; this note
only clarifies that reaching that state is out of scope for this PR's merge
bar.

### Merge integration with #198 (S4) and #199 (S5)

This PR sits at the top of a stack: #198 (`issue-179-context-packet-evidence`)
→ #199 (`issue-180-mcp-operator-copy`) → #200 (`issue-181-e2e-admission-regression`).
At the time of Round 25 the S6 branch was 66 commits behind its base and GitHub
reported the pull request as `CONFLICTING`. Five files conflicted, all of them
at the S6↔S4/S5 seam:

| File | Resolution |
|---|---|
| `web/package.json` | Keep base's `test:unit:zero-skip` and `test:mcp:s4-postgres`. Both definitions of `test:mcp:issuance` are removed — see the issuance-ownership section below. |
| `.github/workflows/web-ci.yml` | Keep both sides: base's local-run-evidence reader env, audit-observer env, and mandatory S4 PostgreSQL proof, plus S6's `test:mcp:contract` and the push whitespace check. Drop the raw artifact upload. |
| `web/e2e/filesystem-grant-lifecycle-concurrency.spec.ts` | Take base's file (16 tests, including its two new operator-hold tests) and replay S6's five hunks, which add the authenticated route assertions and the `@mcp-postgres` tags/`scenarioId` annotations. |
| `web/e2e/epic-172-step0-bridge.ts` | Rebuild the exact-inventory list so all 16 merged test titles appear exactly once, with S6's renamed `real-approval-route` title. |
| `web/__tests__/epic-172-step0-e2e-bridge.test.ts` | Take S6's wording; the "eight flows" count is stale once S6 adds the host-boundary flows. |

The bridge sentinel (`classifies every E2E test exactly once`) and the S6 CI
contract sentinel both pass on the merged tree, which is what proves the
inventory and workflow resolutions are correct rather than merely plausible.

### Runtime reachability of the S6 surface

`evaluateEpic172S6ControllerEvidence`, `executeEpic172S6AtomicTransition`,
`parseEpic172S6ExternalEvidenceBundle`, and the release-order assertions are
imported only by their own unit tests. No route, worker, CLI, or component in
the application references them. The S6 controller surface therefore cannot
change application behaviour in this beta; that is the basis on which the P2
SQL defect above is accepted as deferred rather than release-blocking.

### Contract-wrapper failure diagnosability

Round 25 raised a practical objection to the output quarantine: because both
manifest wrappers run their test child with `stdio: ['ignore', 'ignore',
'ignore']` and ordinary CI uploads no report tree, a failing partition printed
`MCP_PLAYWRIGHT_CONTRACT_REJECTED` (or the Vitest equivalent) and nothing else.
That is correct for leak-safety and unusable for debugging.

The wrappers now emit a fixed reason code from a closed enum
(`collected_identity_mismatch`, `executed_identity_mismatch`,
`scenario_retried`, `scenario_skipped`, `scenario_failed`,
`unmanifested_test_executed`, `retry_override_forbidden`,
`missing_attestation_inputs`, `wrapper_error`), and for an identity mismatch
they additionally name the canonical scenario IDs that were missing or
unexpected. This stays inside the quarantine contract, which permits fixed
schema-free status codes and canonical IDs on the live runner channel and
forbids child bytes — no child output is emitted. Reported identifiers are
filtered to the canonical execution-key shape and anything failing that shape
is reduced to a `unexpected_suppressed=<count>` tally, so a hostile or
malformed test title cannot ride the diagnostic channel out of the runner.
`__tests__/epic-172-s6-contract-wrapper-diagnostics.test.ts` pins both the
reason codes and the shape filter.

### Packet issuance belongs to #179/S4, not #181/S6

The duplicate `test:mcp:issuance` key was the visible symptom of a real
ownership error, and the first resolution of that conflict was wrong.

`web/e2e/mcp-issuance.spec.ts` drove
`forge.insert_packet_authorization_snapshot_v2` directly as the
`forge_packet_issuer` login. Three separate changes in the #198→#199 stack made
that impossible, and each one is deliberate:

1. `7876621` dropped `public.epic_172_s4_protocol_state`. S4 activation is now
   derived by `forge.s4_protected_paths_enabled_v1()` from Step 0's
   `forge_epic_172_enablement_state` singleton.
2. The routine gained a seventh parameter, `p_local_claim_token`, splitting the
   local run-evidence token from the packet claim token.
3. Most importantly, the routine became an **internal helper that the packet
   issuer is forbidden to call**. `__tests__/epic-172-s4-context.test.ts`
   asserts `GRANT EXECUTE ... TO forge_packet_issuer` is absent for it, and
   confirms the issuer's only lifecycle entry points are
   `claim_work_package_lifecycle_v2`, the two heartbeat routines, and
   `recover_linked_s4_lifecycle_v2`. Verified against a live database:
   `has_function_privilege('forge_packet_issuer', ...)` is false for the
   snapshot routine and true for the entry point.

Porting the suite would therefore mean re-authoring it against a twenty-argument
entry point in order to reproduce coverage that **already exists and passes**.
`__tests__/epic-172-s4-postgres.test.ts` implements the same three scenarios
under the same names — `allow-once-single-winner: atomically keeps one audit and
one nonce claim`, `failure-recovery-atomicity: rolls back both audit and nonce on
invalid coverage`, and `always-allow-single-run-claim: fails closed without the
immutable S3 project pointer` — all three confirmed passing against real
PostgreSQL 16.

That is precisely what this document's Coverage ownership section forbids: #179
owns packet claims for both grant modes and nonce fencing, while #181 "owns only
representative cross-slice sentinels ... it imports lower-slice fixtures without
copying their policy matrices."

Resolution: the `issuance` partition is removed from S6 entirely — the spec
file, the Playwright project and tag, the manifest partition, the bridge
inventory entries, the wrapper and suite-contract partition maps, the controller
budget, and the ordinary-CI step. Neither definition of `test:mcp:issuance`
survives; the base's alias is also dropped because the base's own CI never
invoked it and the three files it named are already covered by
`test:unit:zero-skip` and `test:mcp:s4-postgres`. The S6 manifest is now a
five-partition contract (contract, postgres, operator-desktop, operator-mobile,
host-boundary) driven by four suite commands.

Round 24's original recommendation — "keep one unique S6-owned issuance script"
— predates #179 taking ownership of issuance and is superseded by it.
