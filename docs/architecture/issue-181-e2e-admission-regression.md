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

### Flow G: project root change revokes old authority

- Approve bounded filesystem context for canonical root A.
- Repoint the project through the real management route to root B while no run or
  review barrier is active.
- The transaction fences both roots, increments the root-binding revision, and
  invokes S3 negative reconciliation.
- Old decisions become `revoked`; handoff creates no packet/read on B until a real
  grant endpoint records explicit new-root approval.
- Public `rootRef` remains opaque/stable for correlation, but is never treated as
  authority or displayed as a path.
- Seed pre-v2 `allow_once` and `always_allow` decisions with no root-binding
  evidence, including roots observed unchanged and repointed A → B → A. The v2
  binding command binds only the project; every legacy decision remains
  non-issuable until the real grant endpoint records explicit reapproval.

## Layer 2: grant/reconciliation concurrency

Real PostgreSQL interleavings:

- concurrent disjoint `always_allow` grants preserve union/unrelated config;
- concurrent broker metadata survives reconciliation;
- approval reads fresh locked policy after concurrent mutation;
- task and project endpoints recover identical package set;
- grant denial, root-repoint revocation, and project reconciliation race a sibling
  `awaiting_review` plus both review decisions; task remains `running` until the
  shared operator-hold reconciler proves neither lease nor review barrier. Create
  an S3-only filesystem hold while a sibling lease is live and while a sibling is
  `awaiting_review`; after each clears, both the direct callback and startup/
  periodic fallback change only task `running → approved`, preserve its marker/
  package block, and create no run, attempt, wake, or claim. Repeat S4-only and
  mixed recognized holds;
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
`always_allow` instead snapshots the locked project grant decision revision,
root-binding revision, and exact coverage fingerprint.

- two workers race one `allow_once` decision nonce: at most one claim/packet;
- two workers race one `always_allow` package attempt: at most one run-scoped
  claim/packet, with current decision and root-binding revisions recorded;
- packet, packet-free, and handoff-only candidates race pairwise in both
  orderings: the shared primitive locks all siblings, recomputes eligibility, and
  establishes exactly one running specialist/lease;
- every locally pinned run atomically creates generic local-run evidence before the
  first repository read. Packet-free/handoff runs create no packet audit/artifact/
  delivery/action, but generic legacy stale recovery rejects them;
- claim versus reapproval follows lock order;
- stale lease recovery invalidates token and never reopens nonce;
- delayed stale owner cannot begin later governed reads or finalize;
- normal handoff stale-running recovery delegates packet-bearing v2 runs to the
  unified S4 transaction and never writes a competing generic stale marker/event;
- direct progress, sibling continuation, and periodic readiness never promote a
  valid or known-invalid S4 recovery/integrity marker through generic admission;
- reapproval rotates nonce;
- success and failure each yield exactly one typed packet metadata artifact with
  a compatible terminal success/failure discriminant; all known-invalid
  assembly/delivery/code/conditional-stage tuples fail closed. The second
  normative matrix exhausts effect intent, terminal state, ledger entries, host
  review, stage equality, and fingerprints; terminal `active` and success with
  `planned|applying|unknown` fail at PostgreSQL commit and every reader. Success
  has two disjoint branches—no local stage=`not_started`, local stage=
  `quiesced(actualLastStage)`—and both require repository unchanged/
  not-applicable for working-tree and Git-control evidence; changed/unverifiable
  success fails everywhere;
- post-assembly snapshot is durable before exposure;
- pre-assembly failure is explicit;
- artifact has counts/opaque `rootRef`/redaction only, no root path,
  names/paths/content;
- concurrent finalizers respect the partial unique index;
- live run/package/lease, packet audit/artifact, recovery marker, and task
  disposition terminalize atomically; seeded partial terminal-audit/live-package
  states split by immutable outcome: exact failure is copied, fully evidenced
  success is reconstructed, and mismatch/incomplete success enters a typed
  integrity hold without evidence rewrite or packet retry;
- a valid provider response then fails at each closed local stage, including host
  apply after one successful file; one submitted request, exact failure stage,
  separate partial-host evidence, and no automatic retry/rollback survive;
- the run-lifetime resource fence is acquired after claim but before the first
  repository read and with no database locks, then held through context assembly,
  submission, finalization, and descendant quiescence. Barriers cover the first
  read, every host replacement, and finalizer; recovery cannot create an action
  while it is held. Crash-left `applying` becomes ledger `unknown`, and exact-
  fingerprint working-tree/Git-control review precedes any new run;
- packet read/host apply race project root repoint, unregister/delete with and
  without recursive cleanup, old/new root swaps, and reuse by a second project.
  Same-root aliases/symlinks/case variants converge to one opaque resource fence
  and one unique binding. Existing/nonexistent ancestor/descendant roots conflict
  through shared-ancestor/exclusive-full hierarchy fences and the durable hierarchy
  constraint; repoints acquire refs in canonical order and revoke
  old-root grants before the new root is claimable;
- recursive-delete crash barriers before maintenance intent, after intent/before
  filesystem work, after cleanup/before database tombstone, and during repair prove
  claims stay blocked and recovery completes the exact token or enters bounded
  manual repair without guessing. Archiving/tombstoning atomically cancels every
  nonterminal task/package with `project_removed`, releases the live hierarchy
  root, and retains every project/task/package/run/audit/artifact/action/alert/
  resolution row. Stale wakes/all-mode claims do nothing and hard delete fails;
- race two clone/create requests for a nonexistent destination, canonical parent
  aliases/case variants, and every planned/materialized/physical-fence/bind crash
  boundary. The hierarchy reservation chooses one winner; reservation-only/new-
  project transitions lock epoch → connection-authenticated fresh root-writer
  instance → active generation/rotation → hierarchy guard → reservation and
  validate credential generation. Existing-project attach/repoint locks the project
  and applicable S3 entity rows first, then that tail. Cleanup requires exact reservation token plus
  physical object identity and no descendant claim, and never deletes a reused or
  nested path;
- kill the per-run execution child, queue worker, protected fence service, control
  channel, and containment adapter first,
  last, and simultaneously while ACP/validation descendants close descriptors,
  detach, and ignore termination. Recovery stays actionless until the operating-
  system adapter proves the complete per-run group empty. Normal success releases
  without terminating the queue worker. Recovery uses a distinct fresh same-host
  W2 whose dedicated database principal equals `current_user`, locks W1/W2
  ascending, and completes the service challenge → committed election → challenge
  burn → receipt handshake. Fabricated/rolled-back/copied/expired/cross-run/root/W2/
  double-consumed challenges and crash/restart before/after commit/burn/receipt are
  actionless or resume exactly once. Wrong, stale, missing, draining, divergent-key,
  insufficient-containment, same-ID/principal, or unreachable W2 is alert-only;
- capture working-tree and Git-control baselines under their ordered fences before
  packet selection/ACP exposure. Direct ACP changes followed by valid response,
  failure, or submission uncertainty produce
  changed/unverifiable fingerprint-bound review before any Forge local stage or
  later action. FIFO/socket/device entries, symlink loops, huge/churning trees, and
  file/byte/depth/time ceilings prove the versioned scanner never hangs/follows a
  link/opens a special file; baseline failure stops pre-exposure and comparison
  failure becomes `unverifiable`. Independently mutate Git config, hooks, HEAD/ref,
  index, linked-worktree administration, and submodule control state; an external
  gitdir that cannot be fenced/scanned fails before repository access;
- attempt ACP writes to its own and sibling project `.forge/task-runs`, `../` and
  symlink aliases, including between response/quiescence/finalization. Protected
  control state outside the project is inaccessible to the per-run principal;
  every permitted exchange mutation is bounded and digest-evidenced. Same-owner
  mode `0700` is never accepted as proof of protection;
- process death after each durable effect-stage entry proves possible-local-change
  guidance survives even when the primary failure code is lease/worker loss;
- wrong-host recovery with `effectIntent:not_started` reads only the locked
  package/run host pin; `active|quiesced` checks both that pin and intent host. Both
  mismatches remain alert-only and never access a union field that is absent;
- atomic replacement success followed by failed/lost-ownership
  `applying → applied` persistence leaves the live run nonterminal or durably maps
  the entry to `unknown` under the service lease. It can never terminalize success;
- definitive `submission_failed + submission_rejected` persistence races a crash
  and lease expiry; recovery preserves the staged rejection cause;
- stale S4 recovery races packet-free and handoff-only claims in both orderings;
  no task moves to `approved` beside a newly established sibling lease;
- crash packet-free and handoff-only local-root runs before/after first read, during
  direct ACP write, before/after host replacement, and with a surviving descendant.
  W2/quiescence and both repository comparisons remain mandatory; wrong W2 is
  alert-only; sibling claims/root management stay blocked until exact review or
  quarantine; no packet evidence is manufactured;
- claim/recovery races an `awaiting_review` sibling and its decision in both
  orderings; no later specialist or recovery action appears before required review;
- repeat with a terminal sibling's host/repository `review_required`: the task's
  exact database-maintained local-change projection blocks packet, packet-free, and
  handoff-only claims until review/quarantine resolves it. Exercise stale zero/null,
  stale nonzero, wrong count/version/fingerprint, direct writes, backfill, two
  concurrent sibling review transitions, and rollback between evidence/projection;
  deferred constraints and every claim fail before repository reads;
- atomic packet finalization races a stale review-gate decision in both
  orderings; top-down locks and in-transaction source-run/artifact/package/lease
  checks produce one coherent winner without deadlock;
- duplicate action, exact replay, one-time resolution, success repair, and review
  decision prove the complete host-ledgers/entries → all-artifacts → recovery-
  actions → integrity-alerts/resolutions → review-gates lock tail;
- every normal web recovery/reapproval path rejects integrity holds. The bounded
  Release/DevOps alert deduplicates, privileged resolution checks authorization
  and fingerprint, and one append-only result survives; immutable evidence is not
  rewritten. A true audit/artifact mismatch can only append
  `quarantined_abandoned`, bind every affected sibling marker/baseline/change/
  ledger/review fingerprint plus reviewed/abandoned repository disposition,
  cancel/close the package/task, and remain permanently non-retryable. An unknown-
  ledger sibling continues to block root management until included exactly;
- pre-transaction `completion_preparation` failure persists that stage, while a
  gate/finalizer database failure rolls back and persists no such cause;
- one committed packet claim makes at most one external model/ACP submission; an
  accepted but Forge-invalid response does not trigger the existing automatic
  correction loop; the packet-bearing AI SDK call has `maxRetries:0`, every lower
  adapter disables replay after possible acceptance, and wire capture proves one
  request under a retryable provider failure;
- both bridge-trigger epoch orderings use the supported three-statement
  `READ COMMITTED` activation: v1-shared-first forces activation to abort, while
  activation-exclusive-first rejects v1 before any repository read. A genuine
  pre-trigger process is proved drained operationally. The test invokes the real
  checked-in activation command in dry-run and `--apply` modes. Zero/multiple,
  stale, unregistered, draining, incompatible, wrong-host, divergent-binding-key,
  insufficient-containment, and undrained worker/root-writer instances are blockers
  at activation and every later claim/mutation. Start authenticated protocol-2
  `candidate` workers while epoch 1 and prove packet, packet-free, and handoff
  claims all fail at the database boundary with zero repository access; a flag is
  insufficient. Race each claim against activation. One fresh candidate host with
  at most 64 instances and the required principal/fence/containment/key/credential
  generation succeeds; the final statement promotes only that audited set.
  The test verifies exact instance/principal pin, actor, capability snapshot, epoch
  host/version/key,
  idempotency, postconditions, and saved database audit from the operator runbook;
  packet, packet-free, and handoff-only v2 claims all succeed only after epoch 2.
  Give stale/draining Wbad still-valid old access and have it name fresh Wgood;
  package claims, reservation paths, root mutation, and W2 election all reject by
  `current_user`. Copy/replay/cross-instance credentials and drain/session races
  fail before repository/filesystem work;
- assert every mutating path's complete database order includes project → tasks →
  packages → decisions → protocol epoch → authenticated instance rows → active
  binding generation/rotation → hierarchy guard when applicable → runs → generic
  local evidence → optional audits → host
  ledgers → artifacts → recovery actions → integrity alerts/resolutions → gates;
- exercise genuine legacy web POST/PUT/DELETE only before the cutover barrier.
  After ingress disable, v1 credential/session revocation, service drain, and S3
  reconciliation through the post-session-termination journal watermark, a
  restarted old route fails before path read/filesystem work. Race legacy create,
  repoint, repoint-away/back, archive, delete, and an old transaction committing
  during drain around scan/watermark boundaries; crash/resume the checked-in
  reconciliation command and block binding/trigger/activation on every gap.
  The root trigger is enabled afterward, rejects root mutation at epoch 1, never
  calls S3, and rejects malformed writers at epoch 2;
- exercise binding-key backup, divergent same-host key material, loss, and rotation.
  Rotation keeps issuance/root management disabled, drains every instance, proves
  claims/effects/reservations empty, creates active-K1/pending-K2 token state,
  crash-tests durable owner-level shadows after every batch/complete verification,
  and rejects missing/duplicate/stale-source/wrong-generation rows. A dataset larger
  than one batch proves the authority switch updates only the constant-size epoch
  pointer/credential/status plus bounded candidate set—no owner row. Post-flip
  cleanup is bounded/restartable and never restores K1; all readers/constraints see
  exactly one generation;
- create a rootless `localPath:null` project after epoch 2 with every binding field
  null and prove no filesystem authority. Reject partial bindings; later root
  attachment and existing-project repoint to a nonexistent destination use the
  entity-first reservation branch. Race each against packet-free/handoff claims,
  reservation cleanup/recovery, activation, and rotation in both orderings; inspect
  PostgreSQL waits/no deadlock and assert one revision/binding/hierarchy owner, no
  partial authority, and S3 negative reconciliation on repoint;
- attack the protected fence service through unauthorized socket calls, peer-
  credential mismatch, state mutation/deletion, `SIGKILL`, stale/cross-run token
  replay, and corrupt restart. Every case remains orphaned/disabled and cannot
  release/reuse the root;
- prove unbound revision `0`, initial binding, every journaled expansion-window
  mutation, and repoint-away/back strictly increase without reset or legacy
  authority upgrade;

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
| Project root repointed after approval, before claim | old-root decision becomes `revoked`; affected package S3 `blocked`; task follows lease/review barrier | no packet claim; old nonce/decision is non-issuable | stable public `rootRef`, but incremented internal root-binding revision; no old-root read | no automatic carry-over to the new repository | explicitly approve context for the new root |
| Atomic package/run/packet-claim transaction rolls back | package remains `ready`; task returns/stays `approved` | no committed claim; nonce unconsumed | no runnable run, attempt, audit, or artifact | queue may safely try the whole claim again | none |
| Claim committed, failure before assembly | package S4 `blocked`; task `approved` | claim terminal failed; `allow_once` nonce burned; `always_allow` has no nonce | atomic run/audit failure plus one artifact with terminal failed/code, `assembly.state:'not_assembled'`, stage `preflight`, delivery `not_exposed` | evidence finalization only; no packet auto-retry | `allow_once`: reapprove; `always_allow`: explicit `retry_execution` if current coverage matches |
| Failure during assembly | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | atomic run/audit failure plus one artifact with terminal `assembly_failed`, `assembly.state:'not_assembled'`, stage `assembly`, delivery `not_exposed`; no counts | evidence finalization only | same grant-mode actions as prior row; never reassemble the old claim |
| Assembly complete, before exposure | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | staged `assembly.state:'assembled'`; atomic failed terminal outcome + one artifact with delivery `not_exposed` and truthful counts/rootRef | terminal transaction may retry; no packet replay | `allow_once`: reapprove; `always_allow`: explicit `retry_execution` if coverage matches |
| Durable `submitting` intent, crash before/around ACP call | package S4 `blocked`; task `approved` after containment/fence recovery | claim terminal failed; one-time nonce burned | staged assembly; recovery maps delivery to `submission_uncertain`; repository comparison is unchanged or exact review-required; run/audit failed + one artifact | no submission replay | exact local review first when required; then acknowledge possible prior submission and take the grant-mode action |
| Transport proves pre-acceptance rejection | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | delivery `submission_failed`; repository comparison persists; run/audit failed + one artifact | no packet auto-retry | exact local review first when required; then `allow_once` reapproval or explicit `always_allow` retry; delivery remains rejected |
| Transport accepts response, Forge validation rejects it | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | exactly one external prompt call; delivery `submitted`; terminal `provider_response_invalid`; repository comparison persists; failed run/audit + one artifact | no correction submission on this packet claim | exact local review first when required; then acknowledge accepted submission and take the grant-mode action |
| ACP changes working-tree or Git-control state before Forge local work | package has exact local/S4 block; task follows lease/review barrier | optional packet claim terminal failed; one-time nonce burned only when present | either comparison is `changed|unverifiable`; packet valid response uses `external_repository_change_requires_review` with `not_started`/no host ledger; failure/uncertainty keeps delivery cause; generic local evidence and exact combined review fingerprint persist | no Forge local stage, model replay, or automatic rollback | run exact generic `review_local_changes`; for uncertain/submitted packet delivery separately acknowledge possible prior submission before any grant-mode action |
| Valid submitted response, then local execution stage fails | package S4 `blocked`; task follows lease/review barrier | claim terminal failed; one-time nonce burned | delivery stays `submitted`; effect intent becomes `quiesced`; terminal `post_submission_execution_failed` plus exactly one stage (`sandbox_apply|validation|host_apply|repository_evidence|completion_preparation`); one failed run/audit/artifact; host ledger and repository-change fingerprints persist | no model resubmission, local retry, or rollback | complete exact `review_local_changes`, then separately acknowledge prior external work before the grant-mode action |
| Finalizer/repair proposes an invalid terminal/effect/ledger tuple | no terminal package/task change; existing nonterminal state remains owned or recovers normally | claim remains unterminalized | deferred PostgreSQL predicate rejects terminal `active`, mismatched stage/fingerprint, quiesced `applying`, fabricated no-stage `quiesced`, or success with incomplete ledger or changed/unverifiable repository evidence; no artifact/marker split | transaction rollback only | none until a valid finalizer/recovery predicate succeeds |
| Transport accepted/returned, crash before outcome persistence | package S4 `blocked`; task `approved` after containment/fence recovery | claim terminal failed; one-time nonce burned | recovery uses `submission_uncertain`; baseline comparison is unchanged or review-required; one failed run/audit and one artifact | no submission replay | exact local review first when required, then acknowledge possible prior submission before any new decision/run |
| `submitted` persisted, crash before effect intent | host fence service retains/orphans the pinned lease; after containment emptiness proof, package S4 `blocked`; task follows lease/review barrier | claim terminal failed; one-time nonce burned | delivery remains `submitted`; effect is `not_started`; baseline comparison and repository review are mandatory; failed run/audit + one artifact | no submission replay | exact local review first when required, then acknowledge prior submission before any new decision/run |
| Active post-submission effect, fence/containment unproven | package/run remain unchanged; task remains `running` | claim stays `claiming`; nonce burned | active intent/ledger immutable; durable lease active/orphaned; one deduplicated quiescence alert; no terminal marker | owning-host fence-service recovery only; no state mutation/new run until the per-run group is empty | no web action; “Waiting for worker changes to stop” |
| Project root repoint/tombstone/reuse races any live repository read or effect | running claim retains the pinned package/root binding; management mutation does not commit | claim/nonce unchanged | hierarchy/resource fences cover aliases plus ancestor/descendant roots; no cross-root read/write/delete | management waits/retries or conflicts; no database lock waits for the fence | resolve every active/review/packet barrier, then retry management |
| Per-run child/fence service/control dies while a descendant survives | package/run remain unchanged; task `running` | claim stays `claiming`; nonce burned | durable lease becomes orphaned; adapter has not proved the per-run group empty; quiescence alert only | no recovery action based only on lock acquisition | no web action; owning-host recovery later |
| Recovery W2 is wrong, stale, missing, same-ID/principal, spoofed through a caller GUC, divergent-key, insufficient-containment, or unreachable | package/run remain unchanged; task `running` | optional packet claim stays `claiming`; nonce unchanged | historical W1 pin and attempted generic recovery evidence remain bounded; fabricated/rolled-back/replayed service challenge or missing receipt makes no terminal mutation | no local-fence inference, terminalization, or new run | restore a distinct connection-authenticated authoritative same-host W2 and complete one service challenge/receipt election |
| Crash during host apply or after replacement before outcome | recovery acquires the service lease after containment emptiness, blocks package; task follows lease/review barrier | claim terminal failed; nonce burned | leftover `applying → unknown`; effect becomes `quiesced`; primary failure may remain lease/worker loss; host review required by ledger fingerprint | no host/model retry or rollback | exact local review, then separate possible-submission acknowledgement, then grant-mode action |
| Live atomic replacement succeeds but `applying → applied` persistence fails or loses ownership | package/run remain nonterminal while PostgreSQL is unavailable, or terminalize failed only after uncertainty is durable | claim remains fenced until the durable transition; nonce burned | under the service lease the entry becomes `unknown`, exact ledger review is required, and success is rejected | owning-host recovery only; no guessed outcome | inspect/resolve the working tree against the exact ledger fingerprint before any later action |
| Atomic live terminal transaction fails | package/run/lease/audit/marker/task, host-ledger, artifact, action, integrity, and gate rows all remain at preterminal state until retry/recovery; resource fence remains held while live retry runs; then package follows terminal outcome | claim remains `claiming`; nonce stays burned | whole terminal transaction rolls back; staged assembly/delivery/effect/ledger remain; no `completion_preparation` cause is persisted | automatic terminal-state retry only while fenced; owning-host recovery after process death | row-specific action only after atomic terminal/quiescent state exists |
| Seeded terminal-failure audit/artifact + live-package split | S4 repair fails the run, clears its lease, blocks package; task follows sibling rule | terminal claim remains immutable; nonce remains burned | exact audit/artifact tuple equality required; marker copies the immutable failure object/delivery; no second artifact | idempotent S4 repair only; no submission | disposition-specific action from immutable failure |
| Seeded terminal-success audit/artifact + complete success materialization | repair completes the exact normal package/review-gate transition; task follows normal completion/review rule | successful claim remains immutable; nonce remains burned | matching completion artifact, unchanged/not-applicable repository evidence, one exact no-stage/with-stage success tuple, and review-gate materialization are required; no marker/second artifact | idempotent success reconstruction only; no submission | none |
| Seeded terminal-success with incomplete materialization | live run failed only for bounded integrity reason; lease cleared; package has typed S4 integrity hold; task follows sibling rule | immutable packet claim/outcome unchanged | existing evidence unchanged; one bounded Release/DevOps alert; `packet_integrity_hold` is non-retryable and is not a packet-failure marker | exact privileged success repair only when every predicate is proven | no web action; fingerprint-bound runbook/command |
| Immutable audit/artifact mismatch plus sibling unknown repository work | live run failed only for integrity reason; lease cleared; package/task held until adjudication | immutable packet claim/outcomes remain conflicting and unchanged | one bounded alert; exact `quarantined_abandoned` binds every sibling marker/baseline/change/ledger/review fingerprint and reviewed/abandoned disposition before closure | never retry/resubmit/rewrite evidence; root management remains blocked on incomplete sibling evidence | Release/DevOps may permanently close only with the exact evidence set; UI renders evidence quarantine, never repair promise |
| Project archive/tombstone after normal or quarantined task | project hidden from normal lists; every nonterminal task/package cancelled as `project_removed`; live hierarchy/root binding released | all claim/decision history unchanged | every project/task/package/run/audit/artifact/action/alert/resolution and original `rootRef` retained | hard purge forbidden; stale wakes/all-mode claims are no-ops; physical root may be reused only after all review barriers | authorized history says “Project removed — evidence retained,” shows no former path, and exposes no execution action |
| Redis wake fails after grant/recovery action | committed package `ready`; task `approved` | unchanged | unchanged | periodic database sweep re-enqueues; duplicate wakes harmless | none |
| Always-allow packet block, then project grant revoked/restored | package remains S4 `blocked` until explicit retry; task `approved` | prior claim remains terminal; new decision has a greater decision revision and current root-binding revision | prior run/audit/artifact immutable; recovery action records prior/current decision and root revisions; new run later snapshots them | none while uncovered; no automatic retry after restore/root change | grant control while uncovered; after exact explicit approval, retry (and prior-submission acknowledgement first when required) |
| Packet-free/handoff local run crashes after root access | generic `local_effect_recovery` block or actionless quiescence wait; task/root remain held | no packet claim/nonce/audit/artifact/delivery exists | generic run evidence, effect/ledger, both comparisons, W2 election and task projection persist; unknown replacement stays `unknown` | authenticated W2 and group emptiness only; legacy generic recovery rejects it | exact generic local review/quarantine only; never packet retry/acknowledgement |
| Worker restart or lease expiry | fresh same-host W2 is connection-authenticated, completes protected challenge/receipt, obtains the service lease, and proves the per-run group empty; stale local state then becomes an exact block | optional packet token invalidated/audit terminal failed; one-time nonce remains burned | generic run evidence terminalizes; packet runs add one artifact from staged state; W1 remains historical; host/both repository reviews may remain required | startup/periodic owning-host reconciliation only, never delivery/host replay | disposition-specific exact local and optional packet action above |
| Generic stale-running recovery sees linked v2 local evidence | only unified generic-local recovery mutates package/task; packet continuation runs only when audit exists | unified local/optional packet token invalidation; nonce remains burned when present | one failed run/generic record and optional audit/artifact; no competing legacy stale marker/event | S4 sweeper/delegation only | generic local action plus optional packet disposition |
| Recognized operator hold completes while sibling lease or review is live | held package stays blocked; task stays `running` | terminal claim/nonce unchanged or absent | S3/S4/local marker immutable; sibling evidence unchanged | shared post-sibling/startup/periodic operator-hold reconciler later moves only task `running → approved` | no action until task approved, then marker-specific action |
| Terminal sibling retains host/working-tree/Git-control `review_required` | task may be `approved`, but its verified local-change projection remains nonzero and every other package is unclaimable | terminal optional claim/nonce unchanged; no new claim | exact sibling generic evidence/ledger/reviews and task version/source fingerprint match | no packet, packet-free, or handoff-only claim/read/write until exact review/quarantine | only the owning exact local-review or privileged quarantine action |
| Task local-change projection is stale or directly forged | package remains ready/blocked without claim; task enters integrity hold | no claim/nonce/run/lease | deferred constraint or claim-time aggregate rejects stale zero/null, stale nonzero, wrong count/version/source fingerprint; source evidence is unchanged | repair/backfill through the one database function only | no UI retry/new-run action |

S6 imports S4's exact schema: assembly is `assembled|not_assembled`; staged
delivery is
`not_exposed|submitting|submission_failed|submitted|submission_uncertain`, while
terminal artifacts exclude live `submitting`. Audit/run finalization is separate
from delivery and never appears as a delivery enum. Each artifact also carries
S4's terminal `{status:'succeeded'|'failed'}` discriminant; success is valid only
with `assembled+submitted`, and failure requires one compatible closed code plus
the conditional closed post-submission stage. The suite exhausts valid and known-
invalid generic effect/terminal/ledger/host-review/working-tree/Git-control/task-
projection tuples, plus packet assembly/delivery/code/stage when an audit exists:
`active` is nonterminal only; no-stage terminal state may be `not_started`, while
post-stage terminal state is `quiesced`. Caught
local failure has equal effect/failure stage, quiesced forbids `applying`, success
uses the disjoint no-stage/with-stage branch, requires every expected entry
`applied`, and requires both repository comparisons `unchanged/not_applicable`; changed,
unverifiable, reviewed-success, and fabricated-stage tuples fail. All fingerprints
match. PostgreSQL
constraint, live/recovery finalizer, repair, parser, API, and S5 fixtures share the
same expected table. It also exhausts the
grant-mode × delivery-state recovery-disposition matrix, including
`reapprove_allow_once`, `review_then_reapprove_allow_once`, `retry_execution`,
and `review_submission`, plus every known-invalid grant-mode/delivery/disposition/
acknowledgement and both review cross-products. Generic `review_local_changes`
changes only the exact host/dual-repository reviews and database-maintained task
projection using `{localRunEvidenceId,evidenceFingerprint}`; possible-submission
acknowledgement separately changes disposition to `reapprove_allow_once` or
`reviewed_submission`. Neither changes immutable delivery. Packet retry/
acknowledgement use `{priorRuntimeAuditId,markerFingerprint}`. All three handlers
persist database actor/time, reject stale/cross-kind identity, and bind exact
ledger/baseline/change fingerprint evidence.
Retry from `reviewed_submission` still requires
current exact always-allow coverage and root-binding revision. The locked route may accept the same effective
decision or a greater effective decision revision that exactly covers unchanged
package policy only when canonical S1 `readEffectiveGrantState` returns approved
with `source:'project-level'` and `grantMode:'always_allow'`; the locked decision
is then snapshotted as `project_always_allow`. An equal/newer package denial still wins. It
records prior/current decision and root-binding revisions, and
missing/narrower/unknown/root-changed coverage fails
closed.

Every terminal matrix row uses S4's exact closed `PacketFailureCode`:
authorization loss/override → `authorization_changed`; execution or issuance
lease loss → the named lease-expiry code; process loss → `worker_stopped`;
preflight/assembly failure → the named stage code; proven transport refusal →
`submission_rejected`; accepted-or-unknown transport outcome →
`submission_uncertain`; accepted but invalid provider output →
`provider_response_invalid`; accepted valid output with changed/unverifiable ACP
repository evidence before Forge local work →
`external_repository_change_requires_review`; accepted valid output followed by local execution
failure → `post_submission_execution_failed` plus its exact closed stage.
Definitive `submission_failed` is persisted with `submission_rejected` and later
lease expiry cannot replace that cause. Atomic finalization rollback has no separate cause
code because it leaves no durable distinguishing fact; recovery uses the last
durable phase and ownership predicates. Unknown or known-incompatible codes fail
closed in S5/S6 and never become free-text assertions. Packet-owned state accepts
no raw/sanitized exception detail. When another sibling package retains a live
execution lease or `awaiting_review` status, S4 recovery leaves the task `running`; the marker is actionless
until the shared post-sibling/startup/periodic operator-hold reconciler reaches
`approved`, including for an S3-only filesystem hold.

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
- no raw packet content is copied by Forge into the packet metadata artifact;
- no packet content, selected/root path, internal host-resource reference, rejected
  requirement/overlay/subtask text, or credential sentinel appears in task logs,
  task-log export, run errors,
  runtime-audit JSON, packet-metadata artifact prose/metadata, `work_packages.metadata`,
  `blocked_reason`, task events, API/Server-Sent Events responses, captured console
  diagnostics, or queue payloads;
- specialist-authored source artifacts, bounded per-run exchange files, and host-applied repository
  changes remain a separate output boundary and may legitimately contain model
  output derived from repository context. They are never treated as proof that a
  model did not echo input; the test above covers only Forge-owned packet evidence
  and diagnostic copies;
- seed unique sentinels in task prompt, selected file name/path/content, accepted
  and rejected overlays, and credential-like text; exercise normal, no-command, and
  stderr-warning executor branches plus task-log storage/export/API/server-sent
  events/diagnostics/errors. Every old `frontMatter.prompt` producer/alias is gone;
  generic front matter rejects prompt-shaped fields; only the allowlisted bounded
  section/omission counts and server-private non-reversible keyed digest remain;
- a static documentation/operator-copy sentinel permits only MCP-channel scope and
  rejects claims that ACP lacks shell, network, credential, or host-filesystem
  access or that unimplemented S3–S6 behavior is already live.

## Layer 3: Playwright operator flow

Keep this small:

1. Open task with planning, deferred, unhealthy, grant-required, and approved examples.
2. Verify canonical badges/copy/CTA grouping.
3. Approve project context via UI and observe held package recover.
4. Verify retry control absent for revise-plan/deferred blocks.
5. Verify packet metadata summary and no file paths/content.
6. Verify deep link to project MCP remediation and keyboard focus.
7. Verify one-time pre-intent recovery targets fresh approval, always-allow
   pre-intent recovery uses explicit retry, every required local-change fingerprint
   first exposes only local review, and post-intent states then require separate
   possible-submission acknowledgement before any new decision/run.
8. Race duplicate packet retry and possible-submission acknowledgement requests:
   one action row/wake survives and packet version-2
   `{priorRuntimeAuditId,markerFingerprint}` replays exactly. Race duplicate local-
   change review with generic `{localRunEvidenceId,evidenceFingerprint}`. Substitute
   stale/cross-kind/route identity for each handler and prove `409` with no mutation
   or wake.
9. Revoke and restore an always-allow grant around a packet-recovery marker. The UI
   hides retry while uncovered, shows explicit reauthorization for the newer exact
   decision, requires acknowledgement first for post-intent delivery, and the new
   run snapshots the new decision/root-binding revision. Race an equal/newer package denial against the
   restore and prove canonical denial-wins hides retry.
10. Exercise every durable live packet phase: preparing, assembled, submitting,
    submission-rejected/finalizing, and accepted/finalizing. Each is actionless;
    every invalid phase/assembly/delivery cross-product and expired/incoherent
    observation remains neutral until recovery. Kill the worker after each stage
    and prove a new process renders only PostgreSQL state, never a synthesized
    failed/finalizing phase.
11. Leave a sibling execution lease live while packet recovery completes. The task
    stays `running` and the marker says “Waiting for active package” without an
    action; after the shared operator-hold reconciler reaches `approved`, the bounded
    action may appear. Repeat with an `awaiting_review` sibling and assert “Waiting
    for required review” until its mandatory gate decision completes.
    Repeat for an S3-only filesystem hold and mixed recognized holds through direct
    and startup/periodic convergence. Repeat with a terminal sibling local-change barrier: no sibling new-run action
    appears, while only the marker owning the exact fingerprint exposes review.
12. Invoke direct progress, sibling continuation, and periodic readiness with an
    S4 recovery, integrity-hold, or generic `local_effect_recovery` marker while
    current admission is otherwise valid. None promotes or claims it; only the
    exact owning packet/local action can clear its marker and neither clears the
    other. Every normal action rejects an integrity hold; it has no web action.
13. Render every post-submission failure stage from the exact failed
    audit/artifact/marker tuple. All copy is static; `host_apply` and a required
    host-ledger review warn of possible partial changes; changed ledger fingerprint
    hides retry; no path/raw detail or automatic resubmission appears.
14. Seed tuple mismatch, immutable-success-plus-failure-marker, and both typed
    integrity-hold reasons. Incomplete success uses repair language; true mismatch
    says evidence is quarantined, not repairable. Every unresolved state is
    non-retryable/actionless and names Release/DevOps plus the runbook. Exact
    `quarantined_abandoned` plus complete sibling-evidence-set/repository
    disposition and cancelled package/task renders “Task closed — evidence
    quarantined” with no browser control or new run. Incomplete sibling evidence
    remains unresolved and keeps root-management actions hidden.
15. Render an expired packet or no-packet local run with active/orphaned containment lease and
    quiescence alert as “Waiting for worker changes to stop.” Wrong-host recovery
    and per-run-child/protected-service/control loss with a surviving descendant
    remain actionless until a distinct authenticated same-host W2 proves the per-
    run group empty and persists `quiesced`. Queue-worker survival alone does not
    prolong a normally completed run.
16. Repoint a project root after approval. The old decision renders “Project root
    changed — approve context again,” exposes no retry, and displays neither path
    nor the internal resource reference. Explicit new-root approval is required.
17. Render changed and unverifiable ACP working-tree or Git-control evidence as “Repository changed
    during the worker attempt — review required.” It never attributes the
    change to the provider. Retry/reapproval/new-run/root actions remain hidden;
    only exact local review or privileged quarantine may resolve its own barrier.
    No path/diff/raw error appears.
18. Tombstone a project and prove authorized history renders “Project removed —
    evidence retained,” normal lists hide it, path reuse does not relabel the old
    evidence, and no former path/live-root/execution/retry/reapproval control appears.
19. Render `submission_failed + changed|unverifiable` for both grant modes. A
    provider HTTP rejection and a locally definitive adapter/pre-send/transport
    refusal both say “The request was not accepted,” then separately describe local
    review. Exact review later exposes reapproval/retry without changing delivery.
20. Seed working-tree/Git-control baseline/change/review or task-barrier version/
    source mismatch and audit-level
    `abandoned`; all render neutral integrity state with no action. Only a joined
    quarantine resolution may render abandonment.
21. Render both valid success branches with unchanged/not-applicable working-tree
    and Git-control evidence;
    fabricated no-stage `quiesced`, incomplete ledger, and changed/unverifiable
    success tuples remain neutral and actionless.
22. Render packet-free and handoff-only generic recovery with exact quiescence/local-
    review state and no packet counts/audit/artifact/assembly/delivery/retry/
    reapproval/acknowledgement. A packet run may show both presenters, but each
    action mutates only its own marker.

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
   nonce/claim/snapshot/effect fields, explicit unbound root revision `0`, nullable
   host-resource/key/maintenance/archive audit fields, exact-root partial index,
   hierarchy claims/guard, writer-pinned pre-create reservations, database-
   maintained task local-change projection/deferred constraint, generic local-run
   evidence/actions, binding generations/owner-level rotation shadows, expansion-
   window root-change journal, recovery challenge/receipt fields, work-package/
   agent-run root and worker-instance pins, typed per-incarnation worker/root-writer
   principal registry, host-apply ledger/entries, dual working-tree/Git-control
   review, issuance-recovery action and integrity alert/resolution tables, protocol
   epoch active-host/key/generation/fence/containment/root-writer-credential fields,
   `work_packages.claim_protocol_version`, the rejecting package
   `running`-transition trigger, new status vocabulary,
   and partial indexes without
   changing legacy readers. Existing
   artifacts remain valid; S6 verifies schema/Drizzle/writer predicate parity and
   the deferred generic-effect/ledger/dual-repository/task-projection and optional-
   packet constraint predicates.
   Project root exact uniqueness is partial to `archived_at IS NULL`; the durable
   hierarchy constraint rejects ancestor/descendant live roots, and
   protocol-v2 hard delete is rejected.
2. **Deploy dual readers and guarded writers.** New readers treat every legacy
   filesystem decision without a stored root-binding revision as non-issuable, old preview decisions as
   `unknown_legacy`, old zero-default audit rows as `unknown_legacy` rather than
   proof of assembly, and legacy path-valued `root` as hidden. No current-path
   observation or binding command upgrades legacy authority.
3. **Durable protocol barriers and drain.** With the epoch still 1, register v2
   processes only as authenticated `candidate` and prove packet, packet-free, and
   handoff-only claims reach the database transition trigger and are rejected
   before executor/repository work. Queue/project ingress and packet issuance stay
   disabled; process flags alone do not pass. Deploy new root routes and the protected fence/containment
   service disabled; do not enable the root trigger while legacy project routes
   remain live. Disable project-management
   ingress, revoke the v1 web database role/credential and terminate its sessions,
   stop/drain workers already past the package trigger and every web/root writer
   that may already have begun filesystem work, and
   prove no running package has null/protocol-1 claim evidence. Capture the journal
   watermark only after credential revocation/session termination and run exactly
   `npm run project-roots:reconcile-expansion -- --through <generation> --actor <operator-id> --apply`.
   Crash/resume it and require an audited outcome for every generation, including
   deleted rows; any gap/later legacy commit blocks the next command. Run
   `npm run project-roots:bind-v2 -- --actor <operator-id>` first as dry-run, then
   exactly `npm run project-roots:bind-v2 -- --actor <operator-id> --apply`, using
   `docs/operators/project-root-binding-v2.md`. Prove canonical alias/symlink/case
   and ancestor/descendant collisions remain audited/unbound blockers until
   repointed/archived; the command never changes public `rootRef` or any legacy
   approval. Every decision without immutable historical binding evidence remains
   held for explicit reapproval, including repoint-away-and-back fixtures.
   With ingress still disabled, enable the root trigger and prove it rejects root
   mutation at epoch 1 without calling S3 or locking task/package rows.
4. **Cut over producers.** Invoke the checked-in `web` command
   `npm run protocol:activate-work-package-v2 -- --actor <operator-id>` for dry-run
   and exactly
   `npm run protocol:activate-work-package-v2 -- --actor <operator-id> --apply`
   for cutover. Prove apply verifies/uses the privileged three-statement PostgreSQL
   `READ COMMITTED` protocol: lock epoch exclusively; after any wait, query running
   null/v1 claims plus the complete authenticated worker/root-writer candidate
   registry, verified task projections, journal/binding audit, and project roots in
   a fresh command snapshot; then advance the monotonic epoch to 2, pin the one
   authoritative host, binding-key/generation pointer, minimum fence/containment
   versions, root-writer credential generation, exact v2 ingress owner, and promote
   only the audited at-most-64 candidate principals, then audit the exact snapshot.
   Prove actor identity, idempotency,
   postconditions, and saved audit;
   ad hoc SQL fails the release gate. Prove v1-shared-first commits and makes activation abort, while
   activation-exclusive-first rejects the later v1 transition with zero reads.
   Separately start a genuine
   pre-trigger fixture and prove activation is forbidden until the fixture is
   externally drained. Rollback never lowers the epoch.
   Activation is also forbidden for zero/multiple fresh candidate hosts; any unregistered,
   stale, draining, incompatible, divergent-key, other-host, or non-drained worker/
   root-writer instance; any unbound/maintenance root or live reservation; or a
   missing run-lifetime fence service/containment adapter, unverified task
   projection, or incomplete journal/binding audit. The package trigger locks/
   validates the exact fresh instance and requires its dedicated principal to equal
   `current_user`, rejecting a later spoofed/wrong-host/key/containment claim before
   repository reads. The root trigger does the same for
   project mutation. Only after activation commits the exact principal/owner/
   credential generation may queue intake, those S3/root writers, and project ingress start; packet
   issuance is enabled last. `project-roots:bind-v2` never advances the epoch. A restarted v1 route cannot
   authenticate/read a path and fails before filesystem work. The
   Release/DevOps integrity inspect/resolve commands plus runbook pass their
   authorization/fingerprint tests.
5. **Post-drain scrub.** Only after durable epoch-2 evidence, #179—not test-only
   S6—runs its separately gated restartable operation/later migration that clears
   legacy persisted root paths and records only aggregate scrub counts. It is not
   registered as an ordinary expansion migration. S6 seeds legacy rows and verifies
   the result.
6. **Deploy S5, then S6.** UI consumes but never manufactures new state.

Compatibility tests cover old-web/new-worker and new-web/old-worker combinations,
legacy `allow_once`, old grant-blocked/failed packages, preview rows without mode,
old audit rows, concurrent old project insert/repoint/delete during the pre-cutover
expansion window followed by S3 reconciliation, canonical exact
and ancestor/descendant root-binding collisions, rootless projects, missing-root reservations,
tombstones, and existing duplicate-permitted
artifact types. An incompatible old
packet writer reconnecting through the bridge trigger is rejected at its package
transition before repository reads. Rollback is
code-only and forward-schema-compatible: leave additive columns, indexes, root
default/bindings, generic evidence, ledgers/alerts, journal, principal registry, and monotonic epoch in place; disable
v2 packet production and root management; prove all per-run containment groups empty and
intents terminal/held; and never restart an old packet or root writer against v2
state. Host-binding-key loss/rotation follows disable/drain → active-K1/pending-K2
owner shadow generations → complete-set verification → constant-size active-
generation/key/credential pointer plus bounded candidate promotion → bounded old-
generation cleanup → reactivate; divergent keys never silently split authority.

## CI commands and budgets

S6 adds explicit package scripts; the generic `npm test` and `npm run e2e` remain
green and continue to include the appropriate suites.

Planned `web/package.json` commands are exact so CI cannot silently select a
different layer:

```json
{
  "test:mcp:contract": "node scripts/run-with-deadline.mjs 60 -- node scripts/run-vitest-contract.mjs --manifest test-contracts/mcp-admission-v2.json --partition contract -- vitest run __tests__/mcp-admission-invariant.test.ts --testTimeout=10000",
  "test:mcp:postgres": "node scripts/run-with-deadline.mjs 240 -- node scripts/run-playwright-contract.mjs --manifest test-contracts/mcp-admission-v2.json --partition postgres --forbid-skips --forbid-retries -- --project=mcp-postgres --grep @mcp-postgres --timeout=45000",
  "test:mcp:issuance": "node scripts/run-with-deadline.mjs 300 -- node scripts/run-playwright-contract.mjs --manifest test-contracts/mcp-admission-v2.json --partition issuance --forbid-skips --forbid-retries -- --project=mcp-issuance --grep @mcp-issuance --timeout=60000",
  "e2e:mcp-operator": "node scripts/run-with-deadline.mjs 240 -- node scripts/run-playwright-contract.mjs --manifest test-contracts/mcp-admission-v2.json --partition operator-desktop --partition operator-mobile --forbid-skips --forbid-retries -- --project=mcp-operator-desktop --project=mcp-operator-mobile --grep @mcp-operator --timeout=60000"
}
```

`web/test-contracts/mcp-admission-v2.json` is a reviewed, checked-in allowlist—not
output generated from the current test tree. It has `schemaVersion:2` and five
partitions (`contract`, `postgres`, `issuance`, `operator-desktop`, and
`operator-mobile`). Each partition declares its runner, an explicit
`expectedCount`, and the complete sorted array of stable execution keys. A source
test declares one globally unique `scenarioId`; a Playwright execution key is the
composite `{projectName}::{scenarioId}`, while a Vitest key is
`vitest::{scenarioId}`. Thus one operator source scenario can appear once in the
desktop partition and once in the mobile partition without duplicating its source
identity. Execution keys are globally unique, count must equal array length, and
empty or wildcard entries are invalid. Adding, deleting, renaming, or
repartitioning a required test therefore changes this reviewed contract file in
the same PR.

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
not runtime `test.skip`. CI runs a static-manifest audit before execution. For each
named partition the wrapper proves `expected manifest IDs → collected IDs →
executed first-attempt IDs` are identical. It also collects the generic projects
and fails if a dedicated ID leaks into a generic viewport or if a required test is
untagged and absent from every partition. This detects deletion and omission
because the expected side is checked in, not derived from `--list`.

| Script | Scope | Per-test timeout | CI wall-clock budget |
|---|---|---:|---:|
| `npm run test:mcp:contract` | Vitest canonical/parity/mutation sentinels | 10 s | 60 s |
| `npm run test:mcp:postgres` | desktop-only real-route, grants, lock-order, Redis recovery | 45 s | 240 s |
| `npm run test:mcp:issuance` | desktop-only nonce/claim/lease/failure-point races | 60 s | 300 s |
| `npm run e2e:mcp-operator` | Chromium desktop + mobile visible flow/accessibility | 60 s | 240 s |

`scripts/run-playwright-contract.mjs` and `scripts/run-vitest-contract.mjs` first
compare collected IDs to the static manifest, run with machine-readable results,
and then compare executed IDs back to the same manifest. They fail on missing,
unexpected, runtime-skipped, retried/flaky, duplicated, or second-attempt results.
Self-tests delete a required test, remove its tag, inject one skip, duplicate an
ID, and inject a first-attempt-only failure to prove each gate. The outer
`scripts/run-with-deadline.mjs` terminates the process tree and exits non-zero at
the stated wall budget; workflow job `timeout-minutes` is a second outer bound.
Per-test `--timeout`/Vitest `--testTimeout` flags above are mandatory, not prose.
PostgreSQL suites remain serial unless DB and Redis namespaces are isolated per
worker. CI uploads traces, screenshots, scenario tuples, and opaque audit/run IDs
on failure. It fails if a suite is skipped unexpectedly or exceeds its budget;
increasing a budget requires an explicit review note. Generic `npm test` and
`npm run e2e` must still pass under repository-wide defaults, but their result is
smoke compatibility, not a substitute for manifest-bound release evidence. The
strict no-skip/no-retry policy is scoped to the four named commands above.

## Coverage ownership

- #181 adds no production policy.
- If a scenario requires production behavior not implemented by #177–#180, fix the owning implementation PR/issue rather than adding test-only branches.
- Shared helpers must not reimplement classification or admission.
- #179 owns generic local-run evidence/recovery plus packet claims for both grant
  modes, nonce fencing, snapshot/artifact terminal repair, packet actions/
  acknowledgements, rootRef/path scrub, root-binding/reservation/tombstone/fence/
  containment protocol, per-incarnation principal activation, task projection,
  change journal, binding-generation rotation, effect ledger/dual repository
  constraints, integrity adjudication, prompt/log leakage tests, and schema/mixed-
  version tests.
- #180 owns the three surface presentation matrices plus packet current-state and
  generic local-recovery presenters, hostile-input bounds, exact retry/action compatibility,
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
5. Add protected control-state/exchange and run-lifetime fence/containment,
   new/existing-project reservation, tombstone/root-reuse, caller-authentication,
   binding-generation, generic effect-ledger and dual repository crash barriers,
   plus review-pending arbitration.
6. Add complete generic-evidence/optional-audit/host-ledger/artifact/action/
   integrity/gate lock-order races plus terminal/effect/dual-repository/task-
   projection constraint tests.
7. Add candidate/active principal, pre-activation all-mode, root-binding, journal,
   ingress/credential activation, key-rotation, and rollback tests.
8. Add integrity alert/runbook/privileged-resolution/quarantine sibling-evidence
   contract tests.
9. Add prompt filtering/injection assertions.
10. Add thin Playwright presentation flow.
11. Add the failure/recovery and mixed-version matrices.
12. Add persistence-wide leakage sentinels and failure diagnostics.
13. Wire the four named CI commands and enforce numeric budgets.

## Completion gate

The Epic regression is complete when the named commands exercise contract,
PostgreSQL, issuance, and operator layers within budget, while normal `npm test`,
build, migrations, and Playwright remain green. The suite must fail when any one
admission surface is deliberately mutated to disagree, when an incompatible worker
or root writer tries to act, when a legacy approval becomes issuable, when hard
delete loses evidence, or when a path/content sentinel reaches packet persistence
or diagnostics. It must also fail for caller-instance spoofing, a pre-activation v2
claim, stale-zero task projection, no-packet legacy recovery, Git-control or
reachable `.forge` tampering, fabricated W2 handoff, missing rotation shadow/journal
generation, or provider-attributing `submission_failed` copy.

## Stop conditions

Stop if the test needs hand-setting approval status, external services, packet
content persistence, worker-wall-clock lease authority, timing sleeps as race
proof, policy reimplementation, or production-only test hooks that bypass
route/transaction behavior. Stop if mixed-version behavior, a failure-matrix row,
or a persistence sink has no explicit owner and sentinel.
Also stop if a test can expose a new run/action before fence-service/containment
quiescence, either fingerprint-bound working-tree/Git-control review, or mandatory sibling review; if normal web
actions can clear integrity holds; if completion preparation and atomic rollback
are conflated; if root management/path reuse or wrong-host recovery can bypass the
run-lifetime fence; if nonexistent-root creation lacks a namespace reservation; if
activation/later claims cannot machine-check the exact single-host instance/key/
containment/credential snapshot; if an old web route can read a path after cutover;
if quarantine can drop a sibling root-management barrier; if effect/ledger/
repository-review/terminal tuples diverge between PostgreSQL and readers; or if
lock-order tests omit epoch/authenticated-instance/binding-generation rows,
generic local evidence, optional audits, host ledgers, artifacts, action rows,
integrity rows, or gates. Stop if any protocol-2 mode can run before activation; if
a caller GUC substitutes for database identity; if no-packet local work can use
legacy recovery; if a coherent stale task projection passes; if Git-control or
same-owner `.forge` state is ignored; if W2 challenge/receipt crash boundaries are
untested; if existing-project reservation binding reverses locks; if rotation
rewrites all owners in its flip; if journal watermark gaps pass cutover; or if raw
prompt aliases survive.
