# Issue #181 Architecture: End-to-End MCP Admission Regression

Status: architecture proposal
Issue: #181
Parent: #172
Depends on: #177, #178, #179, #180

## Objective

Create a representative, deterministic regression suite for the failure that motivated Epic #172. The suite must exercise the real approval route and handoff pipeline, prove preview/approval/handoff parity, and cover recovery, prompt filtering, issuance evidence, and operator presentation without becoming one brittle monolithic test.

## Test architecture

Use three layers sharing typed fixtures:

1. **Contract invariant matrix** — fast tests over preview, approval evaluator, and broker adapters for fixed package + fixed health.
2. **PostgreSQL integration flows** — real route, lock, grant, recovery, nonce, audit, and artifact behavior.
3. **Thin Playwright operator flow** — only user-visible state and actions that unit/integration tests cannot prove.

Do not put the entire acceptance matrix into Playwright. Do not replace the real approve route with hand-set task states.

## Shared scenario builder

Create a reusable fixture builder, suggested location:

```text
web/__tests__/helpers/mcp-admission-scenarios.ts
```

It must create:

- fixture `schemaVersion: 2`;
- exact expected lower-slice contract versions for S2 admission, S3 hold/marker,
  S4 claim/evidence/recovery, and S5 presentation;
- project and MCP catalog/status state;
- Architect design fence;
- task/work packages;
- requirement keys and requirement-scoped overlays;
- subtask capability bindings;
- package/project grant state;
- captured health snapshot;
- expected canonical decisions and recovery actions.

Scenario IDs should be stable and table-driven. A parser rejects an unknown
fixture or lower-slice contract version rather than defaulting it. A deliberate
wrong-version fixture proves that failure. Tests assert public results, not
internal helper call counts except where proving no packet/run creation.

## Layer 1: preview == approval == handoff invariant

Create or extend:

```text
web/__tests__/mcp-admission-invariant.test.ts
```

For each scenario, invoke:

- `deriveMcpGrantDecisions`;
- the same approval evaluation function used by the real route;
- `evaluateWorkPackageMcpBroker`.

Normalize only compatibility wrappers and assert equality of:

- requirementKey;
- mode;
- admissionStatus;
- recoveryAction;
- primary decision identity;
- retryable;
- grant phase;
- health observation discriminant and timestamp.

Required matrix:

- all capability classes;
- all four requirement capability fields;
- all three fallback actions;
- deny-wins over optional fallback;
- qualified/unqualified filesystem aliases;
- prototype-key resources;
- operation/resource typos;
- invalid known pairs;
- cross-MCP and unknown delivery;
- grant-only legacy state;
- current keyless raw+derived pairing;
- same-agent/same-MCP requirements with one missing context;
- ambiguous legacy overlay;
- absent health;
- mixed required-covered and optional-uncovered filesystem capabilities;
- multi-MCP subtasks with per-capability requirement bindings;
- warning-only context producing no subtask coverage.

The suite should fail clearly on the first divergent surface and print scenario ID plus canonical tuple.

## Layer 2: tiny task-tracker real route flow

Use a local task-tracker fixture with frontend, QA, docs, and reviewer packages.

### Flow A: prompt-only planning context

- Healthy GitHub safe-read requirement with requirement-scoped overlay.
- No live tool handle.
- Real `POST /api/tasks/[id]/approve` succeeds.
- Handoff advances eligible packages.
- Executable prompt contains only admitted structured instructions.

### Flow B: approval-time filesystem rejection

- Required filesystem read missing or explicitly denied.
- Real approve route returns 409.
- Task state does not flip.
- No agent run, attempt, packet audit, or handoff claim exists.

### Flow C: post-approval loss and recovery

- Approval succeeds while coverage exists.
- Project coverage is narrowed/revoked before handoff.
- Handoff holds package `blocked` before claim with zero attempts and task not failed.
- Operator restores coverage through a real grant endpoint.
- Shared reconciliation moves package to `ready` and re-drives task.

### Flow D: planning-only write

- `filesystem.project.write` remains visible in planning instructions.
- It does not require or issue a read packet.
- It does not activate stale bounded-read approval.

### Flow E: deferred required versus optional

- Required GitHub write: blocked + `revise_plan`.
- Optional + continue fallback: warning + `defer_live_mcp_feature` and approval succeeds.
- Neither produces live MCP tools.
- Adversarial merge-through-`gh` overlay text is absent from executable instructions.

### Flow F: GitHub planning context

- Healthy safe read + materialized overlay: planning-only and allowed.
- Absent, missing, disabled, unhealthy, auth-required, and configuration-style
  health observations with the same materialized overlay remain planning-only and
  allowed: this delivery kind consumes no MCP runtime and is not health-gated.
- Required safe read without its own context: blocked + revise plan.
- No planning-only GitHub case gets an install/fix admission action or bounded
  packet, although the separate project-health presenter may still offer setup.

## Layer 2: grant/reconciliation concurrency

Real PostgreSQL interleavings:

- concurrent disjoint `always_allow` grants preserve union/unrelated config;
- concurrent broker metadata survives reconciliation;
- approval reads fresh locked policy after concurrent mutation;
- task and project endpoints recover identical package set;
- historical grant-blocked failed package compatibility is narrow;
- no lock-order deadlock.

Tests coordinate transactions with explicit barriers and observed PostgreSQL lock
waits, not timing sleeps. Each race runs in both meaningful orderings. Lease and
expiry comparisons use PostgreSQL `now()`/`clock_timestamp()` as the implementation
requires; mocking worker `Date` is not correctness evidence.

## Layer 2: allow-once issuance and evidence

Tests from #179 must be composed into the product scenario rather than duplicated inconsistently. Every packet attempt, whether backed by `allow_once` or
`always_allow`, first acquires one run-scoped issuance claim with an ownership token
and lease. `allow_once` additionally claims and burns its immutable decision nonce;
`always_allow` instead snapshots the locked project grant decision revision and
exact coverage fingerprint.

- two workers race one `allow_once` decision nonce: at most one claim/packet;
- two workers race one `always_allow` package attempt: at most one run-scoped
  claim/packet, with current project revision recorded;
- claim versus reapproval follows lock order;
- stale lease recovery invalidates token and never reopens nonce;
- delayed stale owner cannot begin later governed reads or finalize;
- normal handoff stale-running recovery delegates packet-bearing v2 runs to the
  unified S4 transaction and never writes a competing generic stale marker/event;
- reapproval rotates nonce;
- success and failure each yield exactly one typed packet metadata artifact;
- post-assembly snapshot is durable before exposure;
- pre-assembly failure is explicit;
- artifact has counts/opaque `rootRef`/redaction only, no root path,
  names/paths/content;
- concurrent finalizers respect partial unique index.
- one committed packet claim makes at most one external model/ACP submission; an
  accepted but Forge-invalid response does not trigger the existing automatic
  correction loop;
- a v1 audit writer held across durable epoch-2 activation is rejected before any
  bounded repository read;

Tests must state the actual guarantee: cooperative one-winning-claim and best-effort delivery, not cryptographic recall of bytes or in-flight I/O.

### Packet evidence cardinality

The suite asserts the exact zero-or-one boundary:

- approval rejection, pre-claim filesystem hold, optional no-packet execution, and
  a losing duplicate worker create no packet issuance artifact;
- once a run-scoped packet claim commits, that run eventually has exactly one
  typed packet metadata artifact, including terminal failure and stale-claim
  recovery;
- artifact creation/finalization never rereads or reassembles packet contents.

### Complete failure and recovery matrix

Lower-slice tests own every row; S6 composes representative sentinels. `Burned`
means a one-time decision nonce can be replaced only by explicit reapproval.

| Failure boundary | Durable package / task after recovery | Nonce / claim | Run, audit, and artifact | Automatic recovery | Operator action |
|---|---|---|---|---|---|
| Before approval | package unchanged; task `awaiting_approval` | no nonce claim or packet claim | no run/audit/artifact | none | correct policy/grant and submit approval |
| Approval commits, before handoff | package `pending|ready`; task `approved` | fresh `allow_once` nonce unclaimed; no packet claim | no run/audit/artifact | periodic database sweep may replace a lost Redis wake | none unless policy changes |
| Coverage lost after approval, before claim | package S3 `blocked`; task `approved` | nonce unclaimed; no packet claim | zero attempts/runs/audits/artifacts | no generic retry | restore exact coverage or explicitly reapprove |
| Atomic package/run/packet-claim transaction rolls back | package remains `ready`; task returns/stays `approved` | no committed claim; nonce unconsumed | no runnable run, attempt, audit, or artifact | queue may safely try the whole claim again | none |
| Claim committed, failure before assembly | package S4 `blocked`; task `approved` | claim terminal failed; `allow_once` nonce burned; `always_allow` has no nonce | run failed; audit failed plus one atomic artifact with `assembly.state:'not_assembled'`, stage `preflight`, delivery `not_exposed` | evidence finalization only; no packet auto-retry | `allow_once`: reapprove; `always_allow`: explicit `retry_execution` if current coverage matches |
| Failure during assembly | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | run/audit failed plus one artifact with `assembly.state:'not_assembled'`, stage `assembly`, delivery `not_exposed`; no counts | evidence finalization only | same grant-mode actions as prior row; never reassemble the old claim |
| Assembly complete, before exposure | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | staged `assembly.state:'assembled'`; terminal failed audit + one artifact with delivery `not_exposed` and truthful counts/rootRef | terminal evidence transaction may retry; no packet replay | `allow_once`: reapprove; `always_allow`: explicit `retry_execution` if coverage matches |
| Durable `submitting` intent, crash before/around ACP call | package S4 `blocked`; task `approved` after lease recovery | claim terminal failed; one-time nonce burned | staged assembly; recovery maps delivery to `submission_uncertain`; run/audit failed + one artifact | no submission replay | acknowledge possible prior work; then reapprove one-time or explicitly retry always-allow under current coverage |
| Transport proves pre-acceptance rejection | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | delivery `submission_failed`; run/audit failed + one artifact | no packet auto-retry | `allow_once`: reapprove; `always_allow`: explicit `retry_execution` if coverage matches |
| Transport accepts response, Forge validation rejects it | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | exactly one external prompt call; delivery `submitted`; failed run/audit + one artifact | no correction submission on this packet claim | acknowledge accepted submission, then grant-mode action |
| Transport accepted/returned, crash before outcome persistence | package S4 `blocked`; task `approved` after recovery | claim terminal failed; one-time nonce burned | recovery uses `submission_uncertain`; one failed run/audit and one artifact | no submission replay | acknowledge possible prior work before any new decision/run |
| `submitted` persisted, crash before finalization | package S4 `blocked`; task `approved` after recovery | claim terminal failed; one-time nonce burned | delivery remains `submitted`; failed run/audit + one artifact | no submission replay | acknowledge prior submission before any new decision/run |
| Terminal audit + artifact transaction fails | package/run stay under the preterminal claim until recovery, then package S4 `blocked`; task `approved` | claim remains `claiming` until top-down sweeper wins; nonce stays burned | both terminal audit and artifact writes roll back; staged assembly/delivery remain; sweeper commits both atomically | automatic terminal-evidence retry only | row-specific action only after atomic terminal state exists |
| Redis wake fails after grant/recovery action | committed package `ready`; task `approved` | unchanged | unchanged | periodic database sweep re-enqueues; duplicate wakes harmless | none |
| Always-allow packet block, then project grant revoked/restored | package remains S4 `blocked` until explicit retry; task `approved` | prior claim remains terminal; new decision has a greater revision | prior run/audit/artifact immutable; recovery action records the authorizing new revision; new run later snapshots it | none while uncovered; no automatic retry after restore | grant control while uncovered; after exact restore, explicit retry (and prior-submission acknowledgement first when required) |
| Worker restart or lease expiry | stale live state becomes package S4 `blocked`; task `approved` | token invalidated; audit terminal failed; one-time nonce burned | run failed; one artifact from staged state; stale owner loses every later CAS | startup/periodic reconciliation only, never delivery replay | disposition-specific action above |
| Generic stale-running recovery sees linked v2 claim | only unified S4 recovery mutates package/task | unified token invalidation; nonce remains burned | one failed run/audit/artifact; no generic stale marker or duplicate event | S4 sweeper/delegation only | disposition-specific action above |

S6 imports S4's exact schema: assembly is `assembled|not_assembled`; staged
delivery is
`not_exposed|submitting|submission_failed|submitted|submission_uncertain`, while
terminal artifacts exclude live `submitting`. Audit/run finalization is separate
from delivery and never appears as a delivery enum. The suite asserts the
grant-mode × delivery-state recovery-disposition matrix, including
`reapprove_allow_once`, `review_then_reapprove_allow_once`, `retry_execution`,
and `review_submission`. Acknowledgement never changes immutable delivery: it
changes only disposition to `reapprove_allow_once` or `reviewed_submission` with
database actor/time evidence. Retry from `reviewed_submission` still requires
current exact always-allow coverage. The locked route may accept the same decision
or a greater decision revision that exactly covers unchanged package policy; it
records the authorizing revision, and missing/narrower/unknown coverage fails
closed.

## Prompt/instruction assertions

Parse the structured MCP instruction block rather than substring-searching the whole prompt where possible.

Assert:

- every emitted requirement is tied to an eligible canonical decision;
- whole mixed subtask omitted if one binding is ineligible;
- deferred/unknown/blocked/non-deliverable warning Architect text absent;
- static Forge boundary warning present;
- pure planning-only filesystem write hint present;
- fake system markers and closing fences remain JSON data;
- role-preserving adapters carry policy only in the captured system-role wire
  input; the ACP fake instead asserts its real flattened `session/prompt` guidance
  and makes no role-separation/enforcement claim;
- an optional Forge-authored reminder after user-role data is tested only as
  attention guidance, never as immutable policy or enforcement;
- no raw packet content is persisted as artifact.
- no packet content, selected/root path, rejected requirement/overlay/subtask text,
  or credential sentinel appears in task logs, task-log export, run errors,
  runtime-audit JSON, artifact prose/metadata, `work_packages.metadata`,
  `blocked_reason`, task events, API/Server-Sent Events responses, captured console
  diagnostics, or queue payloads;
- prompt logging retains only the existing digest/byte-count snapshot and bounded
  section/omission counts, never the executable prompt string.

## Layer 3: Playwright operator flow

Keep this small:

1. Open task with planning, deferred, unhealthy, grant-required, and approved examples.
2. Verify canonical badges/copy/CTA grouping.
3. Approve project context via UI and observe held package recover.
4. Verify retry control absent for revise-plan/deferred blocks.
5. Verify packet metadata summary and no file paths/content.
6. Verify deep link to project MCP remediation and keyboard focus.
7. Verify one-time pre-intent recovery targets fresh approval, always-allow
   pre-intent recovery uses explicit retry, and post-intent states require
   possible-submission acknowledgement before any new decision/run.
8. Race two identical recovery actions: one ledger row and one wake survive, and
   both return the recorded success. Then change marker fingerprint/state and prove
   that stale request returns `409` without wake.
9. Revoke and restore an always-allow grant around a packet-recovery marker. The UI
   hides retry while uncovered, shows explicit reauthorization for the newer exact
   decision, requires acknowledgement first for post-intent delivery, and the new
   run snapshots the new revision.
10. Exercise every live packet phase: preparing, assembled, submitting,
    accepted/finalizing, and failed/finalizing. Each is actionless current state;
    expired/incoherent observations remain neutral until recovery.

Back-end integration tests remain authoritative for concurrency and state transitions.

## Isolation and determinism

- Unique project/task IDs per test.
- Fixed health observations. Lease/claim time is database-owned: fixtures use
  PostgreSQL timestamps relative to database time and transaction barriers rather
  than a mocked worker clock.
- No external provider or network dependency.
- Local ACP fake records submitted prompt but exposes no host tools.
- Database transactions cleaned after each test.
- Queue wakeups captured by deterministic fake/isolated Redis namespace.
- Table-driven matrices may run in parallel only when fixtures are fully isolated.
- PostgreSQL race tests use unique rows plus dedicated connections and verify
  blocking through `pg_stat_activity`/`pg_blocking_pids` before releasing barriers.

## Failure diagnostics

On failure print:

- scenario ID;
- canonical package policy fingerprint;
- fixed health snapshot;
- preview tuple;
- approval tuple/HTTP response;
- handoff tuple/status;
- relevant run/audit/artifact IDs.

Never print packet contents, credentials, or raw secret-like overlay text.
Never print root/selected paths or rejected Architect text. Diagnostics may print
opaque IDs, tuple fields, bounded enum failure stages, fingerprints, and counts.

## Migration, rollout, and rollback verification

S4 changes cross web and worker process boundaries, so S6 must prove this rollout:

1. **Expand schema first.** #179 adds/backfills the unique project `root_ref` with
   database `DEFAULT gen_random_uuid()` retained for old writers, nullable
   nonce/claim/snapshot fields, issuance-recovery action table, protocol epoch
   singleton/default/rejecting trigger, new status vocabulary, and partial indexes
   without changing legacy readers. Existing
   artifacts remain valid; S6 verifies schema/Drizzle/writer predicate parity.
2. **Deploy dual readers and guarded writers.** New readers treat legacy
   `allow_once` without nonce as non-issuable, old preview decisions as
   `unknown_legacy`, old zero-default audit rows as `unknown_legacy` rather than
   proof of assembly, and legacy path-valued `root` as hidden.
3. **Durable protocol barrier and drain.** With the epoch still 1 and v2 issuance
   disabled, prove every audit insert reaches the database trigger before a bounded
   read. Stop/drain v1 workers and prove no v1 claim remains.
4. **Cut over producers.** Transactionally advance the monotonic epoch to 2, then
   enable v2 workers to write run-scoped claims and lifetime-stable opaque
   `rootRef`. Hold a v1 writer across activation and prove its claim rolls back with
   zero repository reads. Rollback never lowers the epoch.
5. **Post-drain scrub.** Only after durable epoch-2 evidence, #179—not test-only
   S6—runs its separately gated restartable operation/later migration that clears
   legacy persisted root paths and records only aggregate scrub counts. It is not
   registered as an ordinary expansion migration. S6 seeds legacy rows and verifies
   the result.
6. **Deploy S5, then S6.** UI consumes but never manufactures new state.

Compatibility tests cover old-web/new-worker and new-web/old-worker combinations,
legacy `allow_once`, old grant-blocked/failed packages, preview rows without mode,
old audit rows, concurrent old project inserts during root backfill/non-null
cutover, and existing duplicate-permitted artifact types. An incompatible old
packet writer is rejected by the epoch trigger before repository reads. Rollback is
code-only and forward-schema-compatible: leave additive columns, indexes, root
default, and monotonic epoch in place, disable v2 packet production, and never
restart an old packet writer against v2 state.

## CI commands and budgets

S6 adds explicit package scripts; the generic `npm test` and `npm run e2e` remain
green and continue to include the appropriate suites.

Planned `web/package.json` commands are exact so CI cannot silently select a
different layer:

```json
{
  "test:mcp:contract": "node scripts/run-with-deadline.mjs 60 -- vitest run __tests__/mcp-admission-invariant.test.ts --testTimeout=10000",
  "test:mcp:postgres": "node scripts/run-with-deadline.mjs 240 -- node scripts/run-playwright-contract.mjs --forbid-skips --forbid-retries -- --project=mcp-postgres --grep @mcp-postgres --timeout=45000",
  "test:mcp:issuance": "node scripts/run-with-deadline.mjs 300 -- node scripts/run-playwright-contract.mjs --forbid-skips --forbid-retries -- --project=mcp-issuance --grep @mcp-issuance --timeout=60000",
  "e2e:mcp-operator": "node scripts/run-with-deadline.mjs 240 -- node scripts/run-playwright-contract.mjs --forbid-skips --forbid-retries -- --project=mcp-operator-desktop --project=mcp-operator-mobile --grep @mcp-operator --timeout=60000"
}
```

Database scenarios carry exactly one of `@mcp-postgres` or `@mcp-issuance` in
their title or Playwright `tag` property—never a free-form annotation that
`--grep` cannot select. Visible browser scenarios carry `@mcp-operator`; they do
not carry either database-only tag.

`playwright.config.ts` defines dedicated single-desktop `mcp-postgres` and
`mcp-issuance` projects plus desktop/mobile `mcp-operator-*` projects. The generic
desktop/mobile projects set
`grepInvert: /@mcp-postgres|@mcp-issuance|@mcp-operator/`, so unqualified
`npm run e2e` runs each dedicated MCP scenario only through its owning project and
never duplicates a database race or operator scenario in the generic viewports.
Dedicated projects use matching `grep`/`testMatch` rules, `retries:0`, and serial
execution for shared database suites. Remove the current
`testInfo.project.name !== 'chromium-desktop'` skip from
`mcp-handoff-concurrency.spec.ts`; project selection belongs in configuration/tags,
not runtime `test.skip`. CI runs
each named and generic command with `--list`, asserts exact expected test IDs and
cardinality, and fails on overlap, omission, or duplicate selection.

| Script | Scope | Per-test timeout | CI wall-clock budget |
|---|---|---:|---:|
| `npm run test:mcp:contract` | Vitest canonical/parity/mutation sentinels | 10 s | 60 s |
| `npm run test:mcp:postgres` | desktop-only real-route, grants, lock-order, Redis recovery | 45 s | 240 s |
| `npm run test:mcp:issuance` | desktop-only nonce/claim/lease/failure-point races | 60 s | 300 s |
| `npm run e2e:mcp-operator` | Chromium desktop + mobile visible flow/accessibility | 60 s | 240 s |

`scripts/run-playwright-contract.mjs` first records the exact `--list` manifest,
runs Playwright with machine-readable results, and fails if any selected test is
missing, runtime-skipped, retried/flaky, duplicated, or unexpected. Injected one-skip
and first-attempt-only-failure fixtures prove those gates. The outer
`scripts/run-with-deadline.mjs` terminates the process tree and exits non-zero at
the stated wall budget; workflow job `timeout-minutes` is a second outer bound.
Per-test `--timeout`/Vitest `--testTimeout` flags above are mandatory, not prose.
PostgreSQL suites remain serial unless DB and Redis namespaces are isolated per
worker. CI uploads traces, screenshots, scenario tuples, and opaque audit/run IDs
on failure. It fails if a suite is skipped unexpectedly or exceeds its budget;
increasing a budget requires an explicit review note.

## Coverage ownership

- #181 adds no production policy.
- If a scenario requires production behavior not implemented by #177–#180, fix the owning implementation PR/issue rather than adding test-only branches.
- Shared helpers must not reimplement classification or admission.
- #179 owns run-scoped claims for both grant modes, nonce fencing, snapshot and
  artifact terminal repair, packet-recovery actions/acknowledgements, rootRef/path
  scrub, prompt/log leakage tests, and schema/mixed-version tests.
- #180 owns the three surface presentation matrices plus the packet current-state
  presenter, hostile-input bounds, exact retry/action compatibility,
  history/current/evidence separation, and accessibility.
- #181 owns only representative cross-slice sentinels plus CI wiring and budgets;
  it imports lower-slice fixtures without copying their policy matrices.
- ADR 0008's older statement that missing/denied preclaim grants create runtime
  audit rows is superseded by ADR 0009: preclaim holds create structured package
  block evidence but zero issuance audit/artifact; a committed packet claim creates
  run-linked issuance evidence.

## Implementation order

1. Build shared scenario builder and invariant matrix.
2. Add real approve-route task-tracker flows.
3. Add grant recovery/concurrency flows.
4. Integrate issuance/evidence race scenarios.
5. Add prompt filtering/injection assertions.
6. Add thin Playwright presentation flow.
7. Add the failure/recovery and mixed-version matrices.
8. Add persistence-wide leakage sentinels and failure diagnostics.
9. Wire the four named CI commands and enforce numeric budgets.

## Completion gate

The Epic regression is complete when the named commands exercise contract,
PostgreSQL, issuance, and operator layers within budget, while normal `npm test`,
build, migrations, and Playwright remain green. The suite must fail when any one
admission surface is deliberately mutated to disagree, when an incompatible worker
tries to claim, or when a path/content sentinel reaches persistence or diagnostics.

## Stop conditions

Stop if the test needs hand-setting approval status, external services, packet
content persistence, worker-wall-clock lease authority, timing sleeps as race
proof, policy reimplementation, or production-only test hooks that bypass
route/transaction behavior. Stop if mixed-version behavior, a failure-matrix row,
or a persistence sink has no explicit owner and sentinel.
