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
  shared sibling-aware reconciler proves neither lease nor review barrier;
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
  `planned|applying|unknown` fail at PostgreSQL commit and every reader;
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
  fingerprint working-tree review precedes any new run;
- packet read/host apply race project root repoint, unregister/delete with and
  without recursive cleanup, old/new root swaps, and reuse by a second project.
  Same-root aliases/symlinks/case variants converge to one opaque resource fence
  and one unique binding; repoints acquire both refs in byte order and revoke
  old-root grants before the new root is claimable;
- recursive-delete crash barriers before maintenance intent, after intent/before
  filesystem work, after cleanup/before database tombstone, and during repair prove
  claims stay blocked and recovery completes the exact token or enters bounded
  manual repair without guessing. Tombstoning releases the live root but retains
  every project/task/package/run/audit/artifact/action/alert/resolution row; hard
  delete fails;
- race two clone/create requests for a nonexistent destination, canonical parent
  aliases/case variants, and every planned/materialized/physical-fence/bind crash
  boundary. The namespace reservation chooses one winner; cleanup requires exact
  reservation token plus physical object identity and never deletes a reused path;
- kill the worker, fence service, control channel, and containment adapter first,
  last, and simultaneously while ACP/validation descendants close descriptors,
  detach, and ignore termination. Recovery stays actionless until the operating-
  system adapter proves the complete lease group empty. Wrong, stale, missing,
  divergent-key, insufficient-containment, or unreachable host registration is
  alert-only and cannot terminalize;
- capture a repository baseline under the fence before ACP submission. Direct ACP
  changes followed by valid response, failure, or submission uncertainty produce
  changed/unverifiable fingerprint-bound review before any Forge local stage or
  later action;
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
- claim/recovery races an `awaiting_review` sibling and its decision in both
  orderings; no later specialist or recovery action appears before required review;
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
  at activation and every later claim/mutation. One fresh active host with the
  required fence service/containment adapter/key/credential generation succeeds.
  The test verifies exact instance pin, actor, capability snapshot, epoch
  host/version/key,
  idempotency, postconditions, and saved database audit from the operator runbook;
  packet, packet-free, and handoff-only v2 claims all succeed after epoch 2;
- assert every mutating path's complete database order includes project → tasks →
  packages → decisions → protocol epoch → instance rows → runs → audits → host
  ledgers → artifacts → recovery actions → integrity alerts/resolutions → gates;
- race legacy web POST/PUT/DELETE with activation before/after statement two. With
  ingress disabled and v1 database sessions revoked, a restarted old route fails
  before reading a path or touching the filesystem; epoch-1 writes invalidate the
  binding and epoch-2 malformed writers fail the root-mutation trigger;
- exercise binding-key backup, divergent same-host key material, loss, and rotation.
  Rotation keeps issuance/root management disabled, drains every instance, proves
  containment/effects empty, fences old/new refs, rebinds every live root, audits
  both fingerprints, and requires a new activation before any action;

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
| Durable `submitting` intent, crash before/around ACP call | package S4 `blocked`; task `approved` after containment/fence recovery | claim terminal failed; one-time nonce burned | staged assembly; recovery maps delivery to `submission_uncertain`; repository comparison is unchanged or exact review-required; run/audit failed + one artifact | no submission replay | acknowledge possible prior work and any exact repository review; then grant-mode action |
| Transport proves pre-acceptance rejection | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | delivery `submission_failed`; repository comparison persists; run/audit failed + one artifact | no packet auto-retry | complete any exact repository review, then `allow_once` reapproval or explicit `always_allow` retry |
| Transport accepts response, Forge validation rejects it | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | exactly one external prompt call; delivery `submitted`; terminal `provider_response_invalid`; repository comparison persists; failed run/audit + one artifact | no correction submission on this packet claim | acknowledge accepted submission and any repository review, then grant-mode action |
| ACP changes the repository before Forge local work | package S4 `blocked`; task follows lease/review barrier | claim terminal failed; one-time nonce burned | baseline comparison is `changed|unverifiable`; valid response uses `external_repository_change_requires_review` with `not_started`/no host ledger; failure/uncertainty keeps its delivery cause; exact repository review fingerprint persists | no Forge local stage, model replay, or automatic rollback | inspect/resolve the working tree and acknowledge the exact repository fingerprint before any later action |
| Valid submitted response, then local execution stage fails | package S4 `blocked`; task follows lease/review barrier | claim terminal failed; one-time nonce burned | delivery stays `submitted`; effect intent becomes `quiesced`; terminal `post_submission_execution_failed` plus exactly one stage (`sandbox_apply|validation|host_apply|repository_evidence|completion_preparation`); one failed run/audit/artifact; host ledger and repository-change fingerprints persist | no model resubmission, local retry, or rollback | acknowledge prior external work; complete every required exact host/repository review, then grant-mode action |
| Finalizer/repair proposes an invalid terminal/effect/ledger tuple | no terminal package/task change; existing nonterminal state remains owned or recovers normally | claim remains unterminalized | deferred PostgreSQL predicate rejects terminal `active`, mismatched stage/fingerprint, quiesced `applying`, or success with `planned|applying|unknown`; no artifact/marker split | transaction rollback only | none until a valid finalizer/recovery predicate succeeds |
| Transport accepted/returned, crash before outcome persistence | package S4 `blocked`; task `approved` after containment/fence recovery | claim terminal failed; one-time nonce burned | recovery uses `submission_uncertain`; baseline comparison is unchanged or review-required; one failed run/audit and one artifact | no submission replay | acknowledge possible prior work and exact repository review before any new decision/run |
| `submitted` persisted, crash before effect intent | host fence service retains/orphans the pinned lease; after containment emptiness proof, package S4 `blocked`; task follows lease/review barrier | claim terminal failed; one-time nonce burned | delivery remains `submitted`; effect is `not_started`; baseline comparison and repository review are mandatory; failed run/audit + one artifact | no submission replay | acknowledge prior submission and exact repository review before any new decision/run |
| Active post-submission effect, fence/containment unproven | package/run remain unchanged; task remains `running` | claim stays `claiming`; nonce burned | active intent/ledger immutable; durable lease active/orphaned; one deduplicated quiescence alert; no terminal marker | owning-host fence-service recovery only; no state mutation/new run until full group empty | no web action; “Waiting for worker changes to stop” |
| Project root repoint/tombstone/reuse races any live repository read or effect | running claim retains the pinned package/root binding; management mutation does not commit | claim/nonce unchanged | one canonical resource fence covers aliases and both projects; no cross-root read/write/delete | management waits/retries or conflicts; no database lock waits for the fence | resolve every active/review/packet barrier, then retry management |
| Worker/fence service/control dies while a descendant survives | package/run remain unchanged; task `running` | claim stays `claiming`; nonce burned | durable lease becomes orphaned; adapter has not proved the full group empty; quiescence alert only | no recovery action based only on lock acquisition | no web action; owning-host recovery later |
| Recovery runs on wrong, stale, missing, divergent-key, insufficient-containment, or unreachable host | package/run remain unchanged; task `running` | claim stays `claiming`; nonce burned | persisted instance/host/key/root pin and intent unchanged; bounded alert only | no local-fence inference, terminalization, or new run | restore authoritative owning host/registration/capability |
| Crash during host apply or after replacement before outcome | recovery acquires the service lease after containment emptiness, blocks package; task follows lease/review barrier | claim terminal failed; nonce burned | leftover `applying → unknown`; effect becomes `quiesced`; primary failure may remain lease/worker loss; host review required by ledger fingerprint | no host/model retry or rollback | inspect/resolve working tree and acknowledge every required exact host/repository fingerprint before grant-mode action |
| Live atomic replacement succeeds but `applying → applied` persistence fails or loses ownership | package/run remain nonterminal while PostgreSQL is unavailable, or terminalize failed only after uncertainty is durable | claim remains fenced until the durable transition; nonce burned | under the service lease the entry becomes `unknown`, exact ledger review is required, and success is rejected | owning-host recovery only; no guessed outcome | inspect/resolve the working tree against the exact ledger fingerprint before any later action |
| Atomic live terminal transaction fails | package/run/lease/audit/marker/task, host-ledger, artifact, action, integrity, and gate rows all remain at preterminal state until retry/recovery; resource fence remains held while live retry runs; then package follows terminal outcome | claim remains `claiming`; nonce stays burned | whole terminal transaction rolls back; staged assembly/delivery/effect/ledger remain; no `completion_preparation` cause is persisted | automatic terminal-state retry only while fenced; owning-host recovery after process death | row-specific action only after atomic terminal/quiescent state exists |
| Seeded terminal-failure audit/artifact + live-package split | S4 repair fails the run, clears its lease, blocks package; task follows sibling rule | terminal claim remains immutable; nonce remains burned | exact audit/artifact tuple equality required; marker copies the immutable failure object/delivery; no second artifact | idempotent S4 repair only; no submission | disposition-specific action from immutable failure |
| Seeded terminal-success audit/artifact + complete success materialization | repair completes the exact normal package/review-gate transition; task follows normal completion/review rule | successful claim remains immutable; nonce remains burned | matching completion artifact, configured repository evidence, and review-gate materialization are required; no marker/second artifact | idempotent success reconstruction only; no submission | none |
| Seeded terminal-success with incomplete materialization | live run failed only for bounded integrity reason; lease cleared; package has typed S4 integrity hold; task follows sibling rule | immutable packet claim/outcome unchanged | existing evidence unchanged; one bounded Release/DevOps alert; `packet_integrity_hold` is non-retryable and is not a packet-failure marker | exact privileged success repair only when every predicate is proven | no web action; fingerprint-bound runbook/command |
| Immutable audit/artifact mismatch plus sibling unknown repository work | live run failed only for integrity reason; lease cleared; package/task held until adjudication | immutable packet claim/outcomes remain conflicting and unchanged | one bounded alert; exact `quarantined_abandoned` binds every sibling marker/baseline/change/ledger/review fingerprint and reviewed/abandoned disposition before closure | never retry/resubmit/rewrite evidence; root management remains blocked on incomplete sibling evidence | Release/DevOps may permanently close only with the exact evidence set; UI renders evidence quarantine, never repair promise |
| Project tombstone after normal or quarantined task | project hidden from normal lists; live path/root binding released | all claim/decision history unchanged | every project/task/package/run/audit/artifact/action/alert/resolution and original `rootRef` retained | hard purge forbidden; physical root may be reused only after all review barriers | authorized history says “Project removed — evidence retained” and shows no former path |
| Redis wake fails after grant/recovery action | committed package `ready`; task `approved` | unchanged | unchanged | periodic database sweep re-enqueues; duplicate wakes harmless | none |
| Always-allow packet block, then project grant revoked/restored | package remains S4 `blocked` until explicit retry; task `approved` | prior claim remains terminal; new decision has a greater decision revision and current root-binding revision | prior run/audit/artifact immutable; recovery action records prior/current decision and root revisions; new run later snapshots them | none while uncovered; no automatic retry after restore/root change | grant control while uncovered; after exact explicit approval, retry (and prior-submission acknowledgement first when required) |
| Worker restart or lease expiry | owning-host recovery first obtains the durable service lease and proves the complete containment group empty, then stale state becomes package S4 `blocked`; task follows lease/review barrier | token invalidated; audit terminal failed; one-time nonce burned | run failed; one artifact from staged state; stale owner cannot perform a later host operation; host/repository review may remain required | startup/periodic owning-host reconciliation only, never delivery/host replay | disposition-specific exact review action above |
| Generic stale-running recovery sees linked v2 claim | only unified S4 recovery mutates package/task | unified token invalidation; nonce remains burned | one failed run/audit/artifact; no generic stale marker or duplicate event | S4 sweeper/delegation only | disposition-specific action above |
| Packet recovery completes while sibling lease is live | package stays S4 `blocked`; task stays `running` | terminal claim/nonce unchanged | marker/artifact immutable; sibling run remains live | S4 post-sibling/periodic task reconciler later moves only task `running → approved` | no action until task is approved, then marker-specific action |
| Packet recovery completes while sibling is `awaiting_review` | package stays S4 `blocked`; task stays `running` | terminal claim/nonce unchanged | marker/artifact immutable; required review state unchanged | review decision completes first; S4 reconciler later moves only task | no action; “Waiting for required review” |

S6 imports S4's exact schema: assembly is `assembled|not_assembled`; staged
delivery is
`not_exposed|submitting|submission_failed|submitted|submission_uncertain`, while
terminal artifacts exclude live `submitting`. Audit/run finalization is separate
from delivery and never appears as a delivery enum. Each artifact also carries
S4's terminal `{status:'succeeded'|'failed'}` discriminant; success is valid only
with `assembled+submitted`, and failure requires one compatible closed code plus
the conditional closed post-submission stage. The suite exhausts valid and known-
invalid assembly/delivery/effect/terminal/code/stage/ledger/host-review/repository-
review tuples:
`active` is nonterminal only, post-effect terminal state is `quiesced`, caught
local failure has equal effect/failure stage, quiesced forbids `applying`, success
requires every expected entry `applied`, and all fingerprints match. PostgreSQL
constraint, live/recovery finalizer, repair, parser, API, and S5 fixtures share the
same expected table. It also exhausts the
grant-mode × delivery-state recovery-disposition matrix, including
`reapprove_allow_once`, `review_then_reapprove_allow_once`, `retry_execution`,
and `review_submission`, plus every known-invalid grant-mode/delivery/disposition/
acknowledgement and both review cross-products. Acknowledgement never changes
immutable delivery: it changes disposition to `reapprove_allow_once` or
`reviewed_submission` and, when required, host/repository review to `reviewed`,
with database actor/time and exact ledger/baseline/change fingerprint evidence.
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
until S4's post-sibling/periodic task reconciler reaches `approved`.

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
- specialist-authored source artifacts, sandbox files, and host-applied repository
  changes remain a separate output boundary and may legitimately contain model
  output derived from repository context. They are never treated as proof that a
  model did not echo input; the test above covers only Forge-owned packet evidence
  and diagnostic copies;
- prompt logging retains only the existing digest/byte-count snapshot and bounded
  section/omission counts, never the executable prompt string.
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
   pre-intent recovery uses explicit retry, and post-intent states require
   possible-submission acknowledgement before any new decision/run.
8. Race two identical recovery actions: one ledger row and one wake survive, and
   both version-2 requests carry the same routed task/package, prior audit, and
   marker fingerprint and return the recorded success even after marker clearing.
   Then substitute a route/identity field and prove the stale request returns `409`
   without wake.
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
    action; after S4's post-sibling task reconciler reaches `approved`, the bounded
    action may appear. Repeat with an `awaiting_review` sibling and assert “Waiting
    for required review” until its mandatory gate decision completes.
12. Invoke direct progress, sibling continuation, and periodic readiness with an
    S4 recovery or integrity-hold marker while current always-allow admission is
    otherwise valid. None promotes or claims it; only the exact packet
    action/resolver can clear a recovery marker. Every normal action rejects an
    integrity hold; it has no web action.
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
15. Render an expired submitted claim with active/orphaned containment lease and
    quiescence alert as “Waiting for worker changes to stop.” Wrong-host recovery
    and worker/fence-service/control loss with a surviving descendant remain
    actionless until owning-host recovery proves the complete lease group empty and
    persists `quiesced`.
16. Repoint a project root after approval. The old decision renders “Project root
    changed — approve context again,” exposes no retry, and displays neither path
    nor the internal resource reference. Explicit new-root approval is required.
17. Render changed and unverifiable ACP repository evidence as “Repository changed
    during worker submission — review required.” Exact review hides every retry,
    reapproval, quarantine, and root action until acknowledged; no path/diff/raw
    error appears.
18. Tombstone a project and prove authorized history renders “Project removed —
    evidence retained,” normal lists hide it, path reuse does not relabel the old
    evidence, and no former path/live-root control appears.

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
   nonce/claim/snapshot/effect fields, nullable root-binding/host-resource/key/
   maintenance/tombstone fields, pre-create reservation table,
   work-package/agent-run root and worker-instance pins, typed worker/root-writer
   capability registry, host-apply ledger/entries, repository baseline/change
   review, issuance-recovery action and integrity alert/resolution tables, protocol
   epoch active-host/key/fence-service/containment/root-writer-credential fields,
   `work_packages.claim_protocol_version`, the rejecting package
   `running`-transition and project-root-mutation triggers, new status vocabulary,
   and partial indexes without
   changing legacy readers. Existing
   artifacts remain valid; S6 verifies schema/Drizzle/writer predicate parity and
   the deferred terminal/effect/ledger/repository-review constraint predicate.
   Project root uniqueness is partial to non-tombstoned live bindings, and
   protocol-v2 hard delete is rejected.
2. **Deploy dual readers and guarded writers.** New readers treat every legacy
   filesystem decision without a stored root-binding revision as non-issuable, old preview decisions as
   `unknown_legacy`, old zero-default audit rows as `unknown_legacy` rather than
   proof of assembly, and legacy path-valued `root` as hidden. No current-path
   observation or binding command upgrades legacy authority.
3. **Durable protocol barriers and drain.** With the epoch still 1 and v2 issuance
   disabled, prove packet, packet-free, and handoff-only package claims use the
   shared protocol primitive and reach the database transition trigger before
   executor work. Prove new root routes acquire reservation/resource fences before
   filesystem work and reach the root-mutation trigger. Disable project-management
   ingress, revoke the v1 web database role/credential and terminate its sessions,
   stop/drain worker and web/root-writer processes already past either trigger, and
   prove no running package has null/protocol-1 claim evidence.
   Run `npm run project-roots:bind-v2 -- --actor <operator-id>` first as dry-run,
   then `--apply`, using `docs/operators/project-root-binding-v2.md`. Prove
   canonical alias/symlink/case collisions remain audited/unbound blockers until
   repointed/tombstoned; the command never changes public `rootRef` or any legacy
   approval. Every decision without immutable historical binding evidence remains
   held for explicit reapproval, including repoint-away-and-back fixtures.
4. **Cut over producers.** Invoke the checked-in `web` command
   `npm run protocol:activate-work-package-v2 -- --actor <operator-id>` exactly as
   the operator runbook specifies. Prove its default dry run reports blockers and
   `--apply` verifies/uses the privileged three-statement PostgreSQL
   `READ COMMITTED` protocol: lock epoch exclusively; after any wait, query running
   null/v1 claims plus the complete worker/root-writer capability registry and project root
   bindings in a fresh command snapshot; then advance the monotonic epoch to 2,
   pin the one authoritative active host, binding-key fingerprint, minimum fence-
   service/containment versions, root-writer credential generation, and exact v2
   ingress owner, then audit the exact snapshot. Prove actor identity, idempotency,
   postconditions, and saved audit;
   ad hoc SQL fails the release gate. Enable v2 workers to write run-scoped claims and lifetime-stable opaque
   `rootRef`. Prove v1-shared-first commits and makes activation abort, while
   activation-exclusive-first rejects the later v1 transition with zero reads.
   Separately start a genuine
   pre-trigger fixture and prove activation is forbidden until the fixture is
   externally drained. Rollback never lowers the epoch.
   Activation is also forbidden for zero/multiple fresh hosts; any unregistered,
   stale, draining, incompatible, divergent-key, other-host, or non-drained worker/
   root-writer instance; any unbound/maintenance root or live reservation; or a
   missing run-lifetime fence service/containment adapter. The package trigger
   locks/validates the exact fresh instance and rejects a later wrong-host/key/
   containment claim before repository reads. The root trigger does the same for
   project mutation. Enable project-management ingress only after activation
   commits the exact owner/credential generation. A restarted v1 route cannot
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
old audit rows, concurrent old project insert/repoint/delete during root backfill/
activation, canonical root-binding collisions, missing-root reservations,
tombstones, and existing duplicate-permitted
artifact types. An incompatible old
packet writer reconnecting through the bridge trigger is rejected at its package
transition before repository reads. Rollback is
code-only and forward-schema-compatible: leave additive columns, indexes, root
default/bindings, ledgers/alerts, registry, and monotonic epoch in place; disable
v2 packet production and root management; prove all containment groups empty and
intents terminal/held; and never restart an old packet or root writer against v2
state. Host-binding-key loss/rotation follows disable → drain → prove empty →
rebind every live root → audit → reactivate; divergent keys never silently split a
fence identity.

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
- #179 owns run-scoped claims for both grant modes, nonce fencing, snapshot and
  artifact terminal repair, packet-recovery actions/acknowledgements, rootRef/path
  scrub, root-binding/reservation/tombstone/fence/containment protocol, worker/root-
  writer activation registry, effect-ledger/repository-review constraint, integrity adjudication,
  prompt/log leakage tests, and schema/mixed-version tests.
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
5. Add run-lifetime fence-service/containment, reservation/tombstone/root-reuse,
   wrong-host, binding-key, effect-ledger and ACP baseline crash barriers, plus
   review-pending arbitration.
6. Add complete host-ledger/artifact/action/integrity/gate lock-order races plus
   terminal/effect/ledger/repository-review constraint tests.
7. Add worker/root-writer capability, root-binding, ingress/credential activation,
   key-rotation, and rollback tests.
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
or diagnostics.

## Stop conditions

Stop if the test needs hand-setting approval status, external services, packet
content persistence, worker-wall-clock lease authority, timing sleeps as race
proof, policy reimplementation, or production-only test hooks that bypass
route/transaction behavior. Stop if mixed-version behavior, a failure-matrix row,
or a persistence sink has no explicit owner and sentinel.
Also stop if a test can expose a new run/action before fence-service/containment
quiescence, either fingerprint-bound working-tree review, or mandatory sibling review; if normal web
actions can clear integrity holds; if completion preparation and atomic rollback
are conflated; if root management/path reuse or wrong-host recovery can bypass the
run-lifetime fence; if nonexistent-root creation lacks a namespace reservation; if
activation/later claims cannot machine-check the exact single-host instance/key/
containment/credential snapshot; if an old web route can read a path after cutover;
if quarantine can drop a sibling root-management barrier; if effect/ledger/
repository-review/terminal tuples diverge between PostgreSQL and readers; or if
lock-order tests omit epoch/instance rows, host ledgers, artifacts, action rows,
integrity rows, or gates.
