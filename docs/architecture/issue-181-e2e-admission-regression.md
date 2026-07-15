# Issue #181 Architecture: End-to-End MCP Admission Regression

Status: architecture proposal
Issue: #181
Parent: #172
Depends on: #177, #178, #179, #180

## Objective

Create a representative, deterministic regression suite for the failure that motivated Epic #172. The suite must exercise the real approval route and handoff pipeline, prove preview/approval/handoff parity, and cover recovery, prompt filtering, issuance evidence, and operator presentation without becoming one brittle monolithic test.

## Test architecture

Use four layers sharing typed fixtures:

1. **Contract invariant matrix** — fast tests over preview, approval evaluator, and broker adapters for fixed package + fixed health.
2. **PostgreSQL integration flows** — real route, lock, grant, recovery, nonce, audit, and artifact behavior.
3. **Thin Playwright operator flow** — only user-visible state and actions that unit/integration tests cannot prove.
4. **Supported-host boundary flow** — a separately trusted, serial Ubuntu runner
   proves the operating-system containment, protected-service, committed-election,
   and teardown guarantees that an ordinary PostgreSQL or browser fixture cannot
   establish.

Do not put the entire acceptance matrix into Playwright. Do not replace the real
approve route with hand-set task states. The host-boundary layer imports scenario
identities from the same reviewed manifest, but repository code never owns its root
harness, runner lifecycle, or release attestation verifier.

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

S6 imports S4's one database-owned
`forge.insert_packet_authorization_snapshot_v2(...)` constructor. Application code
passes only its typed relational task, package, run, approval-decision, grant,
root-binding, coverage, and source-arm IDs/enums. The function locks and validates
that exact tuple, selects one closed source arm, and alone constructs the canonical
`JSONB` object and its scalar mirrors. No application caller passes JSON/JSONB,
builds authorization with object spread/merge, or inserts the snapshot directly.
A duplicate-aware raw-JSON boundary rejects repeated lexical keys
*before* PostgreSQL parses them as `JSONB`, because `JSONB` would otherwise collapse
duplicates and erase evidence of the attack. The database validator then requires
exact JSON/scalar equality and the retained scoped approval foreign key.

Protocol-v2 identity is total rather than nullable-by-convention. Every v2 claim,
runtime audit, authorization snapshot, packet artifact, action, and recovery row has
non-null task, work-package, and run identity wherever that row kind requires them;
the package/task/run foreign keys and source-arm checks cannot be bypassed with SQL
`NULL` or partial `MATCH SIMPLE` semantics. Nullable legacy columns remain readable
only through the closed legacy arm and can never satisfy a v2 predicate.

- two workers race one `allow_once` decision nonce: at most one claim/packet;
- two workers race one `always_allow` package attempt: at most one run-scoped
  claim/packet, with current decision and root-binding revisions recorded;
- raw authorization input with a duplicate top-level or nested semantic key is
  rejected before `JSONB` conversion. Fixed-constructor fixtures mutate every typed
  field, key order, source arm, scalar mirror, and package/task/run identity; direct
  SQL attempts with a null task, package, or run identity, a cross-scope approval,
  or a JSON/scalar mismatch fail before claim, nonce burn, run, audit, artifact,
  event, or prompt construction;
- packet, packet-free, and handoff-only candidates race pairwise in both
  orderings: the shared primitive locks all siblings, recomputes eligibility, and
  establishes exactly one running specialist/lease;
- every locally pinned run atomically creates generic local-run evidence before the
  first repository read. Packet-free/handoff runs create no packet audit/artifact/
  delivery or packet action, but generic legacy stale recovery rejects them;
- execution, generic local-evidence, and optional packet-issuance claims have
  independent tokens/expiries. Heartbeat and recovery exercise all three expiry
  winners and every pairwise tie; none infers or refreshes another;
- for each of those three leases, copy the exact still-live token, run identity,
  and expiry to another database connection authenticated as the wrong process
  principal. Exercise heartbeat, repository-read batches, packet assembly, prompt
  exposure/submission, every local stage and file replacement, and finalization.
  Every boundary must reject before repository/external I/O or state mutation;
  token possession never substitutes for the connection-authenticated pinned
  instance;
- claim versus reapproval follows lock order. S6 imports S4's append-only approval-
  decision rows and separately compare-and-set current-decision pointer: every
  reapproval inserts a new immutable decision with a strictly greater project-
  serialized positive revision and fresh nonce and advances only the
  pointer, while prior audit foreign keys continue to identify unchanged historical
  decisions. A migration/parity test proves the old package-unique history index is
  removed/replaced and package uniqueness lives on the preallocated pointer;
- stale lease recovery invalidates token and never reopens nonce;
- delayed stale owner cannot begin later governed reads or finalize;
- normal handoff stale-running recovery delegates packet-bearing v2 runs to the
  unified S4 transaction and never writes a competing generic stale marker/event;
- direct progress, sibling continuation, and periodic readiness never promote a
  valid or known-invalid S4 recovery/integrity marker through generic admission;
- first claim, two sequential reapprovals, and concurrent claim/reapproval rotate
  to fresh nonces without updating or deleting either prior decision; historical
  audit queries still resolve every original approval tuple;
- each coherently terminalized success or failure yields exactly one typed packet metadata artifact with
  a compatible terminal success/failure discriminant; all known-invalid
  assembly/delivery/code/conditional-stage tuples fail closed. The second
  normative matrix exhausts effect intent, terminal state, ledger entries, host
  review, stage equality, and fingerprints; terminal `active` and success with
  `planned|applying|unknown` fail at PostgreSQL commit and every reader. Success
  has two disjoint branches—no local stage=`not_started`, local stage=
  `quiesced(actualLastStage)`—and both require repository unchanged/
  not-applicable for working-tree, Git-control, and Git-storage evidence; changed/unverifiable
  success fails everywhere;
- post-assembly snapshot is durable before exposure;
- pre-assembly failure is explicit. Inject each closed claim-stage failure before
  preflight and prove only `not_assembled/claim` with
  `authorization_changed|execution_lease_expired|local_evidence_lease_expired|
  issuance_lease_expired` can
  commit. Then establish preflight and inject those same causes plus
  `worker_stopped|preflight_failed`, proving `not_assembled/preflight`. Every
  cross-stage code, assembly count, or invented preflight fact is rejected by the
  database, finalizer, parser, and presenter;
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
  fingerprint working-tree/Git-control/Git-storage review precedes any new run;
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
  the service-only committed-election view is tested with rolled-back, stale,
  replayed, cross-run/root/W2/generation, revoked-reader, TLS-outage, rotation, and
  service-restart cases; only the exact committed row can be burned. Race committed
  receipt expiry separately at the protected-service grant and W2's final database
  compare-and-set. Re-election is permitted only after **both** the database
  recovery lease and committed service receipt expire and the service proves that
  takeover was never granted. It must atomically retain the exact protected
  `expired_ungranted` receipt tombstone before a top-down database transaction may
  compare-and-set the old election/owner/receipt, append the matching database
  election tombstone, increment the recovery epoch, and store the greater-epoch W2
  candidate/challenge bound to that protected tombstone. Crash before/after each
  expiry, no-grant proof, protected tombstone, database tombstone, and greater-epoch
  commit resumes or remains actionless without concurrent W2 authority. Race the
  old receipt against the greater recovery epoch, replacement W2, and binding
  generation; it remains historical replay evidence and can never grant takeover
  or terminalize;
- keep the authoritative host unavailable beyond every ordinary worker/recovery
  timeout while containment emptiness remains unproven. The packet claim stays
  live/actionless, the run has zero terminal packet artifacts, and repeated S6
  observation never fabricates an artifact or waits for an unsafe liveness promise.
  After a valid same-host recovery finally proves quiescence, the one coherent
  terminal transaction creates the sole artifact;
- the committed-election test uses a real PostgreSQL 16 TLS fixture with a test
  certificate authority, server certificate, service-only client certificate,
  distinct worker/maintenance/read roles, fixed security-barrier view grants, and
  no base-table/function access for the reader. It verifies pinned-CA/name failure,
  client-cert rotation overlap, old-cert revocation, role leakage denial, server/
  reader restart, receipt-expiry/higher-epoch races, and root-owned certificate/
  database cleanup;
- capture working-tree, Git-control, and Git-storage baselines under their ordered fences before
  packet selection/ACP exposure. Direct ACP changes followed by valid response,
  failure, or submission uncertainty produce
  changed/unverifiable fingerprint-bound review before any Forge local stage or
  later action. FIFO/socket/device entries, symlink loops, huge/churning trees, and
  file/byte/depth/time ceilings prove the versioned scanner never hangs/follows a
  link/opens a special file; baseline failure stops pre-exposure and comparison
  failure becomes `unverifiable`. Independently mutate Git config, hooks, HEAD/ref,
  index, linked-worktree administration, submodule control, loose objects, pack/
  index/MIDX, commit graph, alternates, replace/grafts, shallow, packed refs,
  reflogs, maintenance state, and unreachable objects. Truncation, replacement,
  repack/garbage collection, and external common-dir/alternate variants become
  changed/unverifiable; an unfenced/unbounded Git store fails before access;
- run Git discovery only through the checked-in sterile environment builder. Seed
  hostile system/global/XDG/HOME configuration, `include`/`includeIf`, Git
  environment variables, external/symlinked hooks and attributes, executable
  filters/diff/textconv/fsmonitor/credential helpers, and alternate object paths;
  every external authority is rejected before Git execution or included under an
  ordered fence. Configure partial-clone/promisor metadata, missing promised
  objects, alternates, replacement refs, and a hostile upload-pack URL. Every Git
  invocation, including the capability probe, has exact `GIT_NO_LAZY_FETCH=1`; the
  sterile wrapper refuses to spawn without it. A checkout-independent,
  release-pinned capability probe bound to the exact Git binary digest decides
  whether that binary supports the global `--no-lazy-fetch` option without
  repository discovery, configuration, object access, or network access. The
  wrapper adds `git --no-lazy-fetch` to every operational invocation if and only if
  the matching probe succeeds, and omits the unsupported option otherwise. Missing,
  mismatched, or ambiguous probe evidence disables local execution. Both supported
  and unsupported branches prove lazy fetch is explicitly disabled; all
  object writes are disabled, no credential or network helper can start, and a
  missing object makes pre-exposure evidence
  unavailable rather than fetching, hydrating, repacking, writing a commit-graph,
  or mutating the object database. Exercise each version-1 scanner default and hard maximum: working
  tree 100k/500k files, 32/256 MiB hashed, 4/32 GiB observed, depth 128/256,
  60/300 s; Git control 100k/500k, 64 MiB/1 GiB, 4/32 GiB, 64/128, 60/300 s; Git
  storage 500k/2m, 8/64 GiB, 64/512 GiB, 32/64, 120/600 s. Boundary-1/default/
  maximum/maximum+1 fixtures prove over-max configuration is rejected and timeout/
  churn cannot turn a partial snapshot into authority;
- attempt ACP writes to its own and sibling project `.forge/task-runs`, `../` and
  symlink aliases, including between response/quiescence/finalization. Protected
  control state outside the project is inaccessible to the per-run principal;
  every permitted exchange mutation is bounded and digest-evidenced. Same-owner
  mode `0700` is never accepted as proof of protection. On the supported host,
  mount/execution tests prove the exchange and protected-state boundaries use the
  intended `nosuid`/`nodev` policy; set-user-ID/set-group-ID files, file
  capabilities, device nodes, `/proc/<pid>/mem`, `/proc/<pid>/{maps,environ,fd}`,
  `process_vm_readv`, `ptrace`, and cross-user signal attempts cannot cross the
  worker/service/run-user boundary or disclose process memory. The immutable,
  signature-verified trusted shim baked outside the checkout runs under a distinct
  non-ACP user ID, is non-dumpable, and is protected by the kernel ptrace/process-
  memory boundary. ACP cannot assume that user ID, forge `SO_PEERCRED`, signal or
  trace the shim, inherit its descriptors, or replace, shadow, argument-inject,
  environment-inject, proxy, or directly invoke it; the only allowed elevated
  executable transition therefore fails closed on impersonation;
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
  W2/quiescence and every repository comparison remain mandatory; wrong W2 is
  alert-only; sibling claims/root management stay blocked until exact review or
  quarantine. Unchanged/no-host-effect evidence exposes direct
  `retry_local_execution` only when the invocation state is
  `definitive_not_started`, written by the still-live exact owner/attempt from the
  trusted typed pre-I/O refusal. `invoking|returned|uncertain` exposes
  `local_invocation_uncertain` and acknowledgement before retry even when every
  repository comparison is unchanged. Changed/unverifiable evidence exposes
  review first; after review, the same invocation-state rule selects direct retry
  or possible-invocation acknowledgement. Retry also requires server-owned
  ordinary-policy eligibility. Every coherent reviewed state exposes
  `decline_local_retry` without forcing acknowledgement. None automatically runs
  work, and no packet evidence is manufactured;
- claim/recovery races an `awaiting_review` sibling and its decision in both
  orderings; no later specialist or recovery action appears before required review;
- repeat with a terminal sibling's host/repository `review_required`: the task's
  exact database-maintained local-change projection blocks packet, packet-free, and
  handoff-only claims until review/quarantine resolves it. S6 imports S4's closed
  `CURRENT_LOCAL_PROJECTION_HEAD_KINDS` tuple with exactly eight kinds. Package
  creation and the migration backfill preallocate exactly one current-head row per
  kind in the same package transaction; a later source mutation advances an existing
  head by compare-and-set and never inserts a ninth row. The 256-package maximum
  therefore has exactly 2,048 current heads, and recovery remains count-neutral.
  Exercise stale zero/null, stale nonzero, wrong count/version/fingerprint, missing,
  duplicated, unknown-kind and ninth heads, direct writes, bounded/idempotent
  backfill, two concurrent sibling review transitions, and rollback between
  evidence/head/projection. At maximum cardinality, recovery, possible-invocation
  and possible-submission acknowledgement, both decline paths, quarantine,
  cancellation, projection repair, and mixed-version migration must all advance
  their preallocated heads and complete within budget without allocating a row or
  requiring capacity relief. Deferred constraints and every claim fail before
  repository reads when the final heads and task aggregate disagree;
- seed a legacy task with 257 packages and prove S4's durable
  `active|archive_pending|legacy_archived` task disposition and checkpointed,
  whole-task evidence-preserving archive path. Inspect and dry-run are actionless;
  apply moves the original task through `archive_pending`, cancels or retains its
  packages under the closed archive policy, preserves all 257 packages, immutable
  history, and current-head identities in place, and ends at `legacy_archived`
  without reparenting or deleting evidence. Crash/resume and rollback at every
  batch boundary are idempotent. The separately created replacement stores its
  exact source task, `pending|eligible|cancelled` state, positive version, and
  fingerprints; every claim/wake/ingress/root boundary rejects pending. Final
  source archive and replacement `pending → eligible` commit atomically, while
  rollback leaves it pending and cancellation preserves evidence. Replacement tasks
  admit no more than 256 packages and preallocate exactly 2,048 heads at the cap; the archived
  task can never be claimed or silently reactivated;
- atomic packet finalization races a stale review-gate decision in both
  orderings; top-down locks and in-transaction source-run/artifact/package/lease
  checks produce one coherent winner without deadlock;
- duplicate action, exact replay, one-time resolution, success repair, and review
  decision prove the complete generic-evidence/task-source → optional-audit → host-
  ledgers/entries → all-artifacts → generic-local then packet-recovery-actions →
  integrity-alerts/resolutions → review-gates lock tail;
- every normal web recovery/reapproval path rejects integrity holds. The bounded
  Release/DevOps alert deduplicates, privileged resolution checks authorization
  and fingerprint by mandatory alert ID, and one append-only result survives;
  packetless W2 closure writes one service-authored `quiescence_proven` resolution;
  the full closed local-reason × packet/null-audit matrix proves
  `missing_local_evidence` inserts an alert with nullable local FK plus immutable
  expected non-FK identity and no fabricated row. Projection recompute, generic
  failure reconstruction, service quiescence, and quarantine each accept only their
  reason-specific predicate. The server classifies an evidence-present
  `local_evidence_mismatch` as reconstructable only when the immutable run/effect/
  ledger/repository tuple proves one exact failed state; otherwise it is
  irreconcilable. Missing evidence is quarantine-only, while projection mismatch
  and quiescence incoherence retain their own bounded predicates. S5 tests consume
  that classification and never collapse a reconstructable mismatch into mandatory
  quarantine copy;
  immutable evidence is not
  rewritten. A true audit/artifact mismatch can only append
  `quarantined_abandoned`, bind every affected sibling marker/baseline/change/
  ledger/review fingerprint plus reviewed/abandoned repository disposition,
  cancel/close the package/task, and remain permanently non-retryable. An unknown-
  ledger sibling continues to block root management until included exactly. The
  same closed-state test covers a generic local hold: exact resolution, complete
  sibling-evidence-set fingerprint, repository disposition, and cancelled package/
  task render the generic “Task closed — evidence quarantined” state; missing or
  mismatched closure remains the actionless unresolved hold;
- pre-transaction `completion_preparation` failure persists that stage, while a
  gate/finalizer database failure rolls back and persists no such cause;
- one committed generic local-run row makes every local-root ACP invocation at
  most once, including packet-free/handoff execution. Before any ACP I/O the test
  observes the database compare-and-set `not_started → invoking` with a random
  attempt ID. The still-live owner holding the exact execution/generic leases and
  attempt ID may record `definitive_not_started` only from a trusted, typed adapter
  refusal produced before adapter process launch, socket/network, credential, or
  repository I/O begins. That proof and transition commit under the same ownership
  compare-and-set. Recovery never manufactures this proof: an already committed
  `returned` state remains `returned`, but orphan/stale recovery always maps a
  surviving `invoking` row to `uncertain`. This includes a crash after the adapter
  returns but before the live owner's `returned` compare-and-set commits. A restart
  never treats either as a fresh call. `uncertain|returned` require
  exact `acknowledge_possible_local_invocation` before retry, while ordinary decline
  is available without acknowledgement. The acknowledgement appends actor/time,
  preserves immutable invocation uncertainty, rotates the local marker fingerprint,
  and produces the explicit post-ack `retry_local_execution` marker. Exact replay
  returns that same marker without a second mutation; stale pre-ack identity returns
  409. S5 exposes retry only when current server policy is eligible and continues to
  expose ordinary decline without asking for acknowledgement again. Malformed/invalid/transport
  failures after working-tree, control, ref, or object-store mutation never reach a
  second adapter call. For packet runs, an
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
- direct registry insert/update/delete, cross-row writes, and protected-column
  writes are denied to every process principal. The fixed-search-path heartbeat
  routine is owned by a non-login role, has `PUBLIC` execute revoked, maps immutable
  `session_user` even though definer `current_user` differs, locks protocol epoch →
  exact authenticated instance → applicable active/pending binding generation or
  rotation, matching the global instance-before-generation order, and compare-and-
  sets only the caller's freshness. PostgreSQL lock-wait tests race heartbeat with
  drain, rotation, activation, replacement, and claim in both orderings and reject
  any implementation that locks rotation before instance. An
  exact pending K2 candidate may heartbeat only its pending generation but cannot
  claim/root-write. Draining,
  revoked, stale-generation, duplicate-principal, and heartbeat/drain/activation/
  claim races cannot revive authority;
- the non-worker total-loss watchdog can call only the fixed
  `forge_alert_unavailable_recovery_worker()` `SECURITY DEFINER` function and read
  its bounded membership/recovery view. The function is owned by a `NOLOGIN` role,
  fixes and qualifies `search_path`, has `PUBLIC` execution revoked, and maps the
  dedicated watchdog `session_user`; the watchdog cannot `SET ROLE`, heartbeat,
  claim, fence, terminalize, repair, inspect repository evidence, call another
  definer function, or read/write a base table. It also cannot supply or select a
  candidate, evidence, run, instance, host, generation, or alert ID: the fixed
  no-argument function derives every bounded candidate and identifier from its
  qualified view and database time. Hostile temporary schemas/functions, caller
  search paths, parameterized-function variants, direct SQL, duplicate watchdogs,
  and concurrent W2 promotion yield either one deduplicated alert after the exact
  database-time zero-eligible-W2 predicate or no mutation;
- invoke the real epoch-2 instance-replacement command for rolling worker/root-
  writer restart, abrupt W1 death, all active workers gone, at-capacity replacement,
  rollback, and concurrent claim/recovery. Only the maintenance principal promotes
  a same-host/current-generation bounded candidate; the old principal is revoked,
  sessions terminated, ingress stays disabled on failure, and W2 election remains
  a separate step. For root writers, hold the old row `draining`, acquire external
  fences, and race each pinned `planned|materialized|cleanup_required` reservation
  and maintenance intent. The canonical compare-and-set either adopts it under the
  new instance/credential generation or retains it as `cleanup_required`; the
  append-only takeover ledger binds old/new identity and object token. Normal root
  writers cannot self-transfer and ingress never opens on a partial takeover;
- import the canonical version-2 manifest and derive its ordered relative edges;
  no production mutation is required to acquire a fictitious full prefix. Each production mutation
  declares a checked-in sequence fixture containing every row category it actually
  acquires—grant/reconciliation, all-mode claim, local and packet actions,
  finalizer/repair, W2 election, activation/replacement/rotation, and project/root
  management. Static validation proves each sequence is an ordered subsequence of
  the manifest, retains ascending/stable order within repeated categories, omits
  only inapplicable rows, and contains no undeclared/reversed acquisition. The
  separately declared namespace-reservation terminal extension is validated
  against #179's disjoint root-lifecycle rule and never continues to a later
  delivery/recovery family. Real PostgreSQL barriers then race every adjacent pair
  actually acquired by each path in both
  orderings, observe the wait through `pg_stat_activity`/`pg_blocking_pids`, and
  prove bounded completion/no deadlock plus stale compare-and-set rejection;
- before any retained-evidence expansion, use one sacrificial pre-bridge fixture to
  prove the genuine filesystem-first DELETE route can irreversibly remove its
  repository before the SQL outcome. That fixture records the historical loss and
  is never reused to assert retained evidence. Deploy the bridge route and drain
  every old process/session, then create a fresh post-bridge retention fixture.
  For that fixture DELETE must conflict or archive **before** `fs.rm`, the database
  hard-delete guard must reject direct SQL, and every evidence-bearing project
  foreign key must be `RESTRICT|NO ACTION`; no cascade may erase task/run/audit/
  artifact evidence. Only then open the journal window and exercise genuine
  legacy POST/PUT/archive. Root-reference migration tests prove the database-owned
  insert bridge/default gives a fresh UUID to both omitted and explicitly null
  `root_ref` inserts. While bounded backfill still has null legacy rows, unrelated
  updates to those rows succeed, but any bound non-null row rejects re-null. The
  migration must not create a `NOT VALID` non-null helper before backfill; only
  after a repeatable zero-null/unique verification may it add and validate the
  non-null check and set `root_ref NOT NULL`. After ingress disable, v1 credential/session revocation, service drain, and S3
  reconciliation through the post-session-termination journal watermark, a
  restarted old route fails before path read/filesystem work. Race legacy create,
  repoint, repoint-away/back, archive, and an old transaction committing
  during drain around scan/watermark boundaries; crash/resume the checked-in
  reconciliation command and block binding/trigger/activation on every gap.
  The root trigger is enabled afterward, rejects root mutation at epoch 1, never
  calls S3, and rejects malformed writers at epoch 2;
- exercise binding-key backup, divergent same-host key material, loss, and rotation.
  Rotation keeps issuance/root management disabled, drains every instance, proves
  claims/effects/reservations empty and every K1 task projection, local/packet
  marker, review, integrity hold, and terminal-evidence tuple coherent, creates
  active-K1/pending-K2 token state,
  crash-tests durable owner-level shadows after every batch/complete verification,
  and rejects missing/duplicate/stale-source/wrong-generation rows. A dataset larger
  than one batch proves the authority switch updates only the constant-size epoch
  pointer/credential/status plus bounded candidate set—no owner row. Post-flip
  cleanup is bounded/restartable and never restores K1; all readers/constraints see
  exactly one generation. Tests invoke only these literal documented commands:
  `npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref
  <opaque-secret-ref> --actor <operator-id>`,
  `npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref
  <opaque-secret-ref> --actor <operator-id> --apply`,
  `npm run protocol:inspect-host-binding-key-rotation-v2 -- --rotation
  <rotation-id>`, and `npm run protocol:rotate-host-binding-key-v2 -- --rotation
  <rotation-id> --discard --actor <operator-id> --apply`, and verify
  `docs/operators/host-binding-key-rotation-v2.md` matches them;
- create a rootless `localPath:null` project after epoch 2 with every binding field
  null and prove no filesystem authority. Reject partial bindings; later root
  attachment and existing-project repoint to a nonexistent destination use the
  entity-first reservation branch. Race each against packet-free/handoff claims,
  reservation cleanup/recovery, activation, and rotation in both orderings; inspect
  PostgreSQL waits/no deadlock and assert one revision/binding/hierarchy owner, no
  partial authority, and S3 negative reconciliation on repoint;
- on the supported host-boundary runner, attack the protected fence service
  through unauthorized socket calls, peer-
  credential mismatch, state mutation/deletion, `SIGKILL`, stale/cross-run token
  replay, descendant cgroup escape, and corrupt restart. Also attack mount and Unix
  identity boundaries with set-user-ID/set-group-ID binaries, file capabilities,
  device nodes, `/proc/<pid>/mem`, `/proc/<pid>/{maps,environ,fd}` traversal,
  descriptor inheritance, `process_vm_readv`, `ptrace`, and cross-user signals.
  Attempt to assume the trusted shim identity, forge `SO_PEERCRED`, signal/trace
  the shim, or replace/proxy/inject its path, environment, and arguments; verify
  the expected `nosuid`/`nodev` behavior and immutable shim allowlist. The root-
  owned fixture proves cgroup v2 group emptiness, distinct service/worker/run/shim
  user IDs, a non-dumpable shim with a kernel ptrace/process-memory boundary, and
  `SO_PEERCRED` identity. Exhaust the pre-provisioned run-user pool, verify capacity backpressure,
  then prove a slot generation changes only after cgroup/process/session/descriptor/
  protected-state cleanup and capability revocation. A surviving descendant or
  stale capability quarantines the slot and prevents reuse. Every attack case
  remains orphaned/disabled and cannot release/reuse the root;
- prove unbound revision `0`, initial binding, every journaled expansion-window
  mutation, and repoint-away/back strictly increase without reset or legacy
  authority upgrade;

Tests must state the actual guarantee: cooperative one-winning-claim and best-effort delivery, not cryptographic recall of bytes or in-flight I/O.

### Packet evidence cardinality

The suite asserts the exact zero-or-one boundary:

- approval rejection, pre-claim filesystem hold, optional no-packet execution, and
  a losing duplicate worker create no packet issuance artifact;
- a committed but still-live, unquiesced, or unavailable-host packet claim has zero
  terminal packet artifacts and at most one artifact can ever exist for the run;
- exactly one typed packet metadata artifact exists only after coherent atomic
  terminalization or an authorized repair proves its complete predicate, including
  terminal failure and safe stale-claim recovery. No liveness claim is made when
  containment emptiness or an authoritative same-host recovery worker cannot be
  proven;
- artifact creation/finalization never rereads or reassembles packet contents.

### Complete failure and recovery matrix

Lower-slice tests own every row; S6 composes representative sentinels. `Burned`
means a one-time decision nonce can be replaced only by explicit reapproval.
For every coherent row with possible packet submission or local invocation,
evidence-preserving decline remains available after required quiescence/review
without acknowledging uncertainty. Acknowledgement is a prerequisite only for an
action that enables a new run. The operator-action cells below describe the
enablement path and do not remove that table-wide decline alternative.

| Failure boundary | Durable package / task after recovery | Nonce / claim | Run, audit, and artifact | Automatic recovery | Operator action |
|---|---|---|---|---|---|
| Before approval | package unchanged; task `awaiting_approval` | no nonce claim or packet claim | no run/audit/artifact | none | correct policy/grant and submit approval |
| Approval commits, before handoff | package `pending|ready`; task `approved` | fresh `allow_once` nonce unclaimed; no packet claim | no run/audit/artifact | periodic database sweep may replace a lost Redis wake | none unless policy changes |
| Coverage lost after approval, before claim | package S3 `blocked`; task `approved` | nonce unclaimed; no packet claim | zero attempts/runs/audits/artifacts | no generic retry | restore exact coverage or explicitly reapprove |
| Project root repointed after approval, before claim | old-root decision becomes `revoked`; affected package S3 `blocked`; task follows lease/review barrier | no packet claim; old nonce/decision is non-issuable | stable public `rootRef`, but incremented internal root-binding revision; no old-root read | no automatic carry-over to the new repository | explicitly approve context for the new root |
| Atomic package/run/packet-claim transaction rolls back | package remains `ready`; task returns/stays `approved` | no committed claim; nonce unconsumed | no runnable run, attempt, audit, or artifact | queue may safely try the whole claim again | none |
| Live execution, generic-local, or packet token copied to a wrong-principal connection | package/task/run remain owned by the original authenticated instance | every original claim remains live and unchanged; copied credential gains no ownership | no extra heartbeat, read, assembly, exposure, submission, local stage, file replacement, finalization, audit, or artifact | none; copied-token request is rejected before I/O/mutation | restore/use the exact connection-authenticated pinned instance; token possession alone is never actionable |
| Claim committed, failure before preflight is established | package S4 `blocked`; task `approved` | claim terminal failed; `allow_once` nonce burned; `always_allow` has no nonce | atomic run/audit failure plus one artifact with `not_assembled/claim`, delivery `not_exposed`, no counts, and only `authorization_changed|execution_lease_expired|local_evidence_lease_expired|issuance_lease_expired` | evidence finalization only; no packet auto-retry | `allow_once`: reapprove; `always_allow`: explicit `retry_execution` if current coverage matches; either may decline after exact review/quiescence |
| Preflight established, failure before assembly | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | atomic run/audit failure plus one artifact with `not_assembled/preflight`, delivery `not_exposed`, no counts, and claim-stage code plus `worker_stopped|preflight_failed` | evidence finalization only; no packet auto-retry | same grant-mode action as claim-stage failure |
| Failure during assembly after durable intent | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | the same assembly attempt terminalizes as `assembly.state:'assembly_unconfirmed'`, stage `assembly`, failure code `assembly_failed`, delivery `not_exposed`; one artifact with no counts or `rootRef` | evidence finalization only | same grant-mode actions as prior row; never reassemble the old claim |
| Last packet byte selected, crash/DB failure before assembly snapshot commits | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | pre-read `assembling` intent terminalizes as `assembly.state:'assembly_unconfirmed'`, delivery `not_exposed`; one artifact with no counts/rootRef and no assertion that assembly did or did not complete | evidence finalization only; never reread/reassemble | same grant-mode actions as prior row; copy says no durable assembly proof |
| Assembly complete, before exposure | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | staged `assembly.state:'assembled'`; atomic failed terminal outcome + one artifact with delivery `not_exposed` and truthful counts/rootRef | terminal transaction may retry; no packet replay | `allow_once`: reapprove; `always_allow`: explicit `retry_execution` if coverage matches |
| Durable `submitting` intent, crash before/around ACP call | package S4 `blocked`; task `approved` after containment/fence recovery | claim terminal failed; one-time nonce burned | staged assembly; recovery maps delivery to `submission_uncertain`; repository comparison is unchanged or exact review-required; run/audit failed + one artifact | no submission replay | exact local review first when required; then acknowledge possible prior submission and take the grant-mode action |
| Transport proves pre-acceptance rejection | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | delivery `submission_failed`; repository comparison persists; run/audit failed + one artifact | no packet auto-retry | exact local review first when required; then `allow_once` reapproval or explicit `always_allow` retry; delivery remains rejected |
| Transport accepts response, Forge validation rejects it | package S4 `blocked`; task `approved` | claim terminal failed; one-time nonce burned | exactly one external prompt call; delivery `submitted`; terminal `provider_response_invalid`; repository comparison persists; failed run/audit + one artifact | no correction submission on this packet claim | exact local review first when required; then acknowledge accepted submission and take the grant-mode action |
| ACP changes working-tree, Git-control, or Git-storage state before Forge local work | package has exact local/S4 block; task follows lease/review barrier | optional packet claim terminal failed; one-time nonce burned only when present | any comparison is `changed|unverifiable`; packet valid response uses `external_repository_change_requires_review` with `not_started`/no host ledger; failure/uncertainty keeps delivery cause; generic local evidence and exact combined review fingerprint persist | no Forge local stage, model replay, or automatic rollback | run exact generic `review_local_changes`; for uncertain/submitted packet delivery separately acknowledge possible prior submission before any grant-mode action |
| Valid submitted response, then local execution stage fails | package S4 `blocked`; task follows lease/review barrier | claim terminal failed; one-time nonce burned | delivery stays `submitted`; effect intent becomes `quiesced`; terminal `post_submission_execution_failed` plus exactly one stage (`sandbox_apply|validation|host_apply|repository_evidence|completion_preparation`); one failed run/audit/artifact; host ledger and repository-change fingerprints persist | no model resubmission, local retry, or rollback | complete exact `review_local_changes`, then separately acknowledge prior external work before the grant-mode action |
| Finalizer/repair proposes an invalid terminal/effect/ledger tuple | no terminal package/task change; existing nonterminal state remains owned or recovers normally | claim remains unterminalized | deferred PostgreSQL predicate rejects terminal `active`, mismatched stage/fingerprint, quiesced `applying`, fabricated no-stage `quiesced`, or success with incomplete ledger or changed/unverifiable repository evidence; no artifact/marker split | transaction rollback only | none until a valid finalizer/recovery predicate succeeds |
| Transport accepted/returned, crash before outcome persistence | package S4 `blocked`; task `approved` after containment/fence recovery | claim terminal failed; one-time nonce burned | recovery uses `submission_uncertain`; baseline comparison is unchanged or review-required; one failed run/audit and one artifact | no submission replay | exact local review first when required, then acknowledge possible prior submission before any new decision/run |
| `submitted` persisted, crash before effect intent | host fence service retains/orphans the pinned lease; after containment emptiness proof, package S4 `blocked`; task follows lease/review barrier | claim terminal failed; one-time nonce burned | delivery remains `submitted`; effect is `not_started`; baseline comparison and repository review are mandatory; failed run/audit + one artifact | no submission replay | exact local review first when required, then acknowledge prior submission before any new decision/run |
| Active post-submission effect, fence/containment unproven | package/run remain unchanged; task remains `running` | claim stays `claiming`; nonce burned | active intent/ledger immutable; durable lease active/orphaned; one deduplicated quiescence alert; no terminal marker | owning-host fence-service recovery only; no state mutation/new run until the per-run group is empty | no web action; “Waiting for worker changes to stop” |
| Project root repoint/tombstone/reuse races any live repository read or effect | running claim retains the pinned package/root binding; management mutation does not commit | claim/nonce unchanged | hierarchy/resource fences cover aliases plus ancestor/descendant roots; no cross-root read/write/delete | management waits/retries or conflicts; no database lock waits for the fence | resolve every active/review/packet barrier, then retry management |
| Per-run child/fence service/control dies while a descendant survives | package/run remain unchanged; task `running` | claim stays `claiming`; nonce burned | durable lease becomes orphaned; adapter has not proved the per-run group empty; quiescence alert only | no recovery action based only on lock acquisition | no web action; owning-host recovery later |
| Recovery W2 is wrong, stale, missing, same-ID/principal, spoofed through a caller GUC, divergent-key, insufficient-containment, or unreachable | package/run remain unchanged; task `running` | optional packet claim stays `claiming`; nonce unchanged | historical W1 pin and attempted generic recovery evidence remain bounded; fabricated/rolled-back/replayed service challenge or missing receipt makes no terminal mutation; zero terminal packet artifacts remain valid indefinitely | no local-fence inference, terminalization, artifact fabrication, or new run | restore a distinct connection-authenticated authoritative same-host W2 and complete one service challenge/receipt election |
| Crash during host apply or after replacement before outcome | recovery acquires the service lease after containment emptiness, blocks package; task follows lease/review barrier | claim terminal failed; nonce burned | leftover `applying → unknown`; effect becomes `quiesced`; primary failure may remain lease/worker loss; host review required by ledger fingerprint | no host/model retry or rollback | exact local review, then separate possible-submission acknowledgement, then grant-mode action |
| Live atomic replacement succeeds but `applying → applied` persistence fails or loses ownership | package/run remain nonterminal while PostgreSQL is unavailable, or terminalize failed only after uncertainty is durable | claim remains fenced until the durable transition; nonce burned | under the service lease the entry becomes `unknown`, exact ledger review is required, and success is rejected | owning-host recovery only; no guessed outcome | inspect/resolve the affected working-tree/Git-control/Git-storage state against the exact fingerprints before any later action |
| Atomic live terminal transaction fails | package/run/lease/audit/marker/task, host-ledger, artifact, action, integrity, and gate rows all remain at preterminal state until retry/recovery; resource fence remains held while live retry runs; then package follows terminal outcome | claim remains `claiming`; nonce stays burned | whole terminal transaction rolls back; staged assembly/delivery/effect/ledger remain; no `completion_preparation` cause is persisted | automatic terminal-state retry only while fenced; owning-host recovery after process death | row-specific action only after atomic terminal/quiescent state exists |
| Seeded terminal-failure audit/artifact + live-package split | S4 repair fails the run, clears its lease, blocks package; task follows sibling rule | terminal claim remains immutable; nonce remains burned | exact audit/artifact tuple equality required; marker copies the immutable failure object/delivery; no second artifact | idempotent S4 repair only; no submission | disposition-specific action from immutable failure |
| Seeded terminal-success audit/artifact + complete success materialization | repair completes the exact normal package/review-gate transition; task follows normal completion/review rule | successful claim remains immutable; nonce remains burned | matching completion artifact, unchanged/not-applicable repository evidence, one exact no-stage/with-stage success tuple, and review-gate materialization are required; no marker/second artifact | idempotent success reconstruction only; no submission | none |
| Seeded terminal-success with incomplete materialization | live run failed only for bounded integrity reason; lease cleared; package has typed S4 integrity hold; task follows sibling rule | immutable packet claim/outcome unchanged | existing evidence unchanged; one bounded Release/DevOps alert; `packet_integrity_hold` is non-retryable and is not a packet-failure marker | exact privileged success repair only when every predicate is proven | no web action; fingerprint-bound runbook/command |
| Immutable audit/artifact mismatch plus sibling unknown repository work | live run failed only for integrity reason; lease cleared; package/task held until adjudication | immutable packet claim/outcomes remain conflicting and unchanged | one bounded alert; exact `quarantined_abandoned` binds every sibling marker/baseline/change/ledger/review fingerprint and reviewed/abandoned disposition before closure | never retry/resubmit/rewrite evidence; root management remains blocked on incomplete sibling evidence | Release/DevOps may permanently close only with the exact evidence set; UI renders evidence quarantine, never repair promise |
| Project archive/tombstone after normal or quarantined task | project hidden from normal lists; every nonterminal task/package cancelled as `project_removed`; live hierarchy/root binding released | all claim/decision history unchanged | every project/task/package/run/audit/artifact/action/alert/resolution and original `rootRef` retained | hard purge forbidden; stale wakes/all-mode claims are no-ops; physical root may be reused only after all review barriers | authorized history says “Project removed — evidence retained,” shows no former path, and exposes no execution action |
| Redis wake fails after grant/recovery action | committed package `ready`; task `approved` | unchanged | unchanged | periodic database sweep re-enqueues; duplicate wakes harmless | none |
| Always-allow packet block, then project grant revoked/restored | package remains S4 `blocked` until explicit retry; task `approved` | prior claim remains terminal; new decision has a greater decision revision and current root-binding revision | prior run/audit/artifact immutable; recovery action records prior/current decision and root revisions; new run later snapshots them | none while uncovered; no automatic retry after restore/root change | grant control while uncovered; after exact explicit approval, retry (and prior-submission acknowledgement first when required) |
| Packet-free/handoff precondition fails before invocation intent | generic `local_effect_recovery` block or actionless terminal evidence; task follows sibling checks | no packet claim/nonce/audit/artifact/delivery | generic evidence stays `not_started`; zero adapter calls and no repository effect; this bare state is not S4's safe-retry arm | evidence finalization only; no automatic or explicit new run | evidence-preserving `decline_local_retry` only when S4's exact coherent decline predicate is representable; otherwise no action. Direct retry requires a separate exact legal S4 `definitive_not_started` state |
| Live exact owner receives trusted typed refusal before adapter process/network/credential/repository I/O | generic `local_effect_recovery` block; task `approved` after sibling checks | no packet claim/nonce/audit/artifact/delivery | the same attempt ownership-CAS terminalizes `invoking → definitive_not_started`; zero adapter calls | evidence finalization only | explicit policy-eligible retry or `decline_local_retry`; no acknowledgement |
| Packet-free/handoff crashes or loses ownership after `invoking` without typed refusal/return proof | actionless quiescence wait, then generic `local_effect_recovery` block; task/root remain held until W2 proves emptiness | no packet claim/nonce/audit/artifact/delivery | generic invocation becomes `uncertain`; run evidence, repository comparisons, W2 election, and task projection persist | authenticated W2/group emptiness only; no replay/correction call | exact review when required; acknowledgement only before retry, or `decline_local_retry` without acknowledgement |
| Packet-free/handoff adapter returns valid, malformed, invalid, or transport result | generic local block when result cannot complete normally; task follows sibling rule | no packet claim/nonce/audit/artifact/delivery | one wire call; durable `returned` boundary plus response classification and all repository evidence; validation never calls the adapter again | finalization/recovery only; no adapter replay | exact review when required; acknowledgement only before retry, or decline without acknowledgement |
| Packet-free/handoff crashes after durable return before finalization | generic local block after W2/quiescence; task follows sibling rule | no packet claim/nonce/audit/artifact/delivery | recovery preserves `returned`, one-call proof, effect/ledger/repository evidence; no invented response or second call | owning-host recovery/finalization only | exact review when required; acknowledgement only before retry, or decline without acknowledgement |
| Coherent packet recovery is declined | owning package and sibling-aware task become `cancelled` through normal terminal policy | prior claim/nonce/delivery remain immutable | exact packet action records actor/time/marker fingerprint; all audit/artifact/review evidence remains | none; no run or wake | `decline_packet_recovery`, including uncertain submission without forced acknowledgement |
| Worker restart or lease expiry | fresh same-host W2 is first promoted through audited epoch-2 membership when necessary, then connection-authenticated, completes protected challenge/receipt, obtains the service lease, and proves the per-run group empty; stale local state becomes an exact block | optional packet token invalidated/audit terminal failed; one-time nonce remains burned | generic run evidence terminalizes; packet runs add one artifact from staged state; W1 remains historical; host/all repository reviews may remain required | startup/periodic owning-host reconciliation only, never delivery/host replay | disposition-specific exact local and optional packet action above |
| Generic stale-running recovery sees linked v2 local evidence | only unified generic-local recovery mutates package/task; packet continuation runs only when audit exists | unified local/optional packet token invalidation; nonce remains burned when present | one failed run/generic record and optional audit/artifact; no competing legacy stale marker/event | S4 sweeper/delegation only | generic local action plus optional packet disposition |
| Recognized operator hold completes while sibling lease or review is live | held package stays blocked; task stays `running` | terminal claim/nonce unchanged or absent | S3/S4/local marker immutable; sibling evidence unchanged | shared post-sibling/startup/periodic operator-hold reconciler later moves only task `running → approved` | no action until task approved, then marker-specific action |
| Terminal sibling retains host/working-tree/Git-control/Git-storage `review_required` | task may be `approved`, but its verified local-change projection remains nonzero and every other package is unclaimable | terminal optional claim/nonce unchanged; no new claim | exact sibling generic evidence/ledger/reviews and task version/source fingerprint match | no packet, packet-free, or handoff-only claim/read/write until exact review/quarantine | only the owning exact local-review or privileged quarantine action |
| Task local-change projection is stale or directly forged | package remains ready/blocked without claim; task enters integrity hold | no claim/nonce/run/lease | deferred constraint or claim-time aggregate rejects stale zero/null, stale nonzero, wrong count/version/source fingerprint; source evidence is unchanged | repair/backfill through the one database function only | no UI retry/new-run action |

S6 imports S4's exact schema: assembly is
`assembled|not_assembled|assembly_unconfirmed`; the owner persists `assembling`
intent before the first packet read and terminalizes an uncommitted snapshot as
`assembly_unconfirmed` with no counts/rootRef. Staged
delivery is
`not_exposed|submitting|submission_failed|submitted|submission_uncertain`, while
terminal artifacts exclude live `submitting`. Audit/run finalization is separate
from delivery and never appears as a delivery enum. Each artifact also carries
S4's terminal `{status:'succeeded'|'failed'}` discriminant; success is valid only
with `assembled+submitted`, and failure requires one compatible closed code plus
the conditional closed post-submission stage. The suite exhausts valid and known-
invalid generic effect/terminal/ledger/host-review/working-tree/Git-control/Git-storage/task-
projection tuples, plus packet assembly/delivery/code/stage when an audit exists:
`active` is nonterminal only; no-stage terminal state may be `not_started`, while
post-stage terminal state is `quiesced`. Caught
local failure has equal effect/failure stage, quiesced forbids `applying`, success
uses the disjoint no-stage/with-stage branch, requires every expected entry
`applied`, and requires all repository comparisons `unchanged/not_applicable`; changed,
unverifiable, reviewed-success, and fabricated-stage tuples fail. All fingerprints
match. PostgreSQL
constraint, live/recovery finalizer, repair, parser, API, and S5 fixtures share the
same expected table. It also exhausts the
  grant-mode × delivery-state recovery-disposition matrix, including
  `reapprove_allow_once`, `review_then_reapprove_allow_once`, `retry_execution`,
  `review_submission`, and `decline_packet_recovery`, plus every known-invalid
  grant-mode/delivery/disposition/acknowledgement and all review cross-products.
  Generic `review_local_changes`
changes the exact host/working-tree/Git-control/Git-storage reviews and database-
maintained task projection using `{localRunEvidenceId,evidenceFingerprint}`. It
writes exactly one generic action; for a packet it clears only the local marker and
  atomically advances the exact dependent packet disposition, while a no-packet
  marker rotates to its stored `retry_local_execution|acknowledge_possible_local_invocation`
  disposition. Local acknowledgement preserves immutable invocation ambiguity;
  retry moves the package to ready only under the locked server policy revision/
  fingerprint. `decline_local_retry` cancels coherent reviewed work without a run/
  wake and without forcing acknowledgement. Packet action
  `acknowledge_possible_submission` separately changes disposition to
  `reapprove_allow_once` or `reviewed_submission`; packet decline preserves
  delivery and cancels normally.
  Packet retry/acknowledgement/decline use
  `{priorRuntimeAuditId,markerFingerprint}`. All seven handlers persist database
  actor/time, reject stale/cross-kind identity, and bind exact
  ledger/baseline/change fingerprint evidence. The internal S3→S4 one-time-
  reapproval resolver is the eighth durable mutation identity: it is not a UI route
  action, uses its separately typed nonce/marker compare-and-set identity, and must
  appear in lock-order, replay, and parity fixtures without being counted as an
  eighth CTA.
Retry from `reviewed_submission` still requires
current exact always-allow coverage and root-binding revision. The locked route may accept the same effective
decision or a greater effective decision revision that exactly covers unchanged
package policy only when canonical S1 `readEffectiveGrantState` returns approved
with `source:'project-level'` and `grantMode:'always_allow'`; the locked decision
is then snapshotted as `project_always_allow`. An equal/newer package denial still wins. It
records prior/current decision and root-binding revisions, and
missing/narrower/unknown/root-changed coverage fails
closed.

Redaction summaries import S4's closed `PacketRedactionCategory` union. They are
`Partial<Record<PacketRedactionCategory, bounded integer>>`, never
`Record<string, number>`. PostgreSQL writer/constraint, parser, API, artifact, and
S5 presenter all reject an unknown key before any sink can render it. A seeded
path/content/credential in a JSON key is an invalid persisted tuple, not displayable
redaction copy.

Every terminal matrix row uses S4's exact closed `PacketFailureCode`. An already
persisted stage/delivery cause remains primary. Otherwise simultaneous
observations use the fixed precedence
`authorization_changed → execution_lease_expired → local_evidence_lease_expired →
issuance_lease_expired → delivery/stage-specific cause → worker_stopped`.
Preflight/assembly failure supplies the named stage cause; proven transport refusal →
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
- the sole raw-Architect-plan source is the append-only, ACL-protected
  `architect_plan_versions` plus `architect_plan_entries` store; the current
  `adr_text/architect_plan` artifact is a non-text version header. The dedicated
  `GET /api/tasks/{taskId}/architect-plan-history/{planVersion}` route returns the
  version's entries only after current task ACL reauthorization and a committed,
  text-free `architect_plan_history_reads` audit; unauthorized, cross-task, and
  wrong-stage reads return no bytes. Direct `SELECT` on either raw-text table is
  denied to every general web, worker, application, export, diagnostic, migration-
  runner, and release-controller principal. S6 uses real login-role tests to prove
  only S4's two fixed-search-path, `PUBLIC`-revoked least-privilege reader boundaries
  can read text: the ACL-plus-audit human-history reader and the package-bound
  executable-fragment resolver. Cross-calling either boundary from the other or
  copying its connection identity fails before bytes are returned. Both logins are
  non-superuser, `NOINHERIT`, cannot `SET ROLE`, and have no session-authorization
  capability. The package resolver derives its exact worker from immutable
  `session_user`. The shared human-history web login is not an end-user identity:
  its reader accepts an opaque Forge session credential plus task/version as
  prepared/binary parameters, hashes and locks the matching live database session,
  derives the user there, rechecks ACL, and atomically appends the text-free audit.
  It accepts no user ID and never stores/logs/audits/returns the raw credential. Two
  users behind the same web login prove valid same-scope reads; swapped, expired,
  revoked, fabricated, cross-user/task, wrong-login, and definer-`current_user`
  calls return zero bytes and cannot forge a read audit. Import S4's exact plan-entry identity and projection-
  resolver fixtures: `{planArtifactId,planVersion,entryId,contentDigest}` resolves
  only for the same project/task, package agent, canonical requirement/capability
  binding, plan version, and entry. Cross-project/task/version/entry/agent/
  requirement/digest references, stale replay, and a current-plan substitution for
  an older reference fail before prompt serialization. The rejected sentinel is
  absent from every runtime package, execution-design payload, source excerpt,
  general live task/run API, server-sent event, task snapshot/replay payload,
  log/export/error/diagnostic, Redis job/retry/dead-letter payload, and provider/ACP
  wire capture. S6 exercises S4's bounded post-drain purge of legacy Redis and
  persisted runtime snapshots: purged jobs cannot be replayed, while the authorized
  history/detail reader still returns the immutable entries and read audit. Static source
  parity rejects a second history source, copied runtime projection, or production
  schema invented by S6. Before the compatibility drain, every generic task-log
  reader hides all prompt-shaped front-matter keys and aliases. After every old
  writer is drained, S4's checkpointed historical scrub removes string, object,
  array/nested, and alias forms from every retained task-log row without copying
  plaintext into its journal. S6 seeds every historical shape and proves zero
  plaintext through direct SQL, task-log/API/export/SSE/snapshot/replay,
  Redis/queue payloads, logs, errors, and diagnostics before that checkpoint can
  complete. Hostile direct SQL, function execution, `SET ROLE`, session-
  authorization, search-path/temp-object shadowing, and cross-project/task/type/
  stage/version/entry/agent/requirement/binding substitutions all return zero text
  and create no forged history-read audit;
- every CI output is a leakage sink, including process stdout/stderr, step
  annotations/summaries, machine-readable and HTML reports, trace ZIPs and their
  extracted resources, logs, screenshots and screenshot metadata, attachments,
  diffs/patches, core/error dumps, and artifact manifests. A no-tee wrapper prevents
  child output, summaries, and annotations from reaching the live runner channel;
  only fixed status codes are live. Request headers, cookies, credentials, and
  prompt-bearing request/response bodies are removed before any allowlisted
  diagnostic record is generated. Only schema-validated sanitized UTF-8 text/JSON
  regenerated from path-free tuples may upload. Raw logs/traces/reports, screenshots,
  videos, Document Object Model snapshots, attachments, diffs, dumps, archives, and
  every opaque/binary format remain inside the disposable VM and are destroyed.
  The pre-upload scanner rejects every non-allowlisted type, unknown key, parse
  failure, or seeded sentinel and emits only a path-free signed manifest/digest;
- specialist-authored source artifacts, bounded per-run exchange files, and host-applied repository
  changes remain a separate output boundary and may legitimately contain model
  output derived from repository context. They are never treated as proof that a
  model did not echo input; the test above covers only Forge-owned packet evidence
  and diagnostic copies;
- seed unique sentinels in task prompt, selected file name/path/content, accepted
  and rejected overlays, and credential-like text; exercise normal, no-command, and
  stderr-warning executor branches plus task-log storage/export/API/server-sent
  events/diagnostics/errors. Also inject a failure only after the prompt-bearing
  request has been constructed/submitted so raw Playwright/runner trace, report,
  screenshot, attachment, diff, and log collection is quarantined and rejected from
  upload. Seed stdout/stderr/annotation/summary and pixel-rendered screenshot/video
  variants; a fake live GitHub sink receives no sentinel and every media/binary file
  is non-allowlisted even when compression removes literal bytes. Every old
  `frontMatter.prompt` producer/alias is gone, including normal, no-command,
  stderr-warning, and the no-op handoff start/completion paths. A source-parity
  sentinel enumerates these production call sites so a no-op path cannot escape
  merely because it makes no provider call. Generic front matter rejects prompt-
  shaped fields; only the allowlisted bounded section/omission counts and server-
  private versioned domain-separated keyed digest remain. Mixed-version fixtures
  seed legacy unversioned/unkeyed `sha256` prompt digests and prove all readers,
  API/SSE/log exports, and diagnostics expose exactly S4's count-only
  `{kind:'unknown_legacy_digest',byteCount}` arm when its bounded byte count is
  valid, or omit the whole snapshot when it is not. This same two-outcome fixture
  applies before drain, during the checkpointed migration, and after post-drain
  completion. The migration removes every raw digest and may retain only that exact
  count-only arm; any alternate suppression/truncation metadata, reclassified keyed
  record, or keyed value invented without the original bytes is rejected;
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
   possible-submission acknowledgement before any new decision/run. Packet review
   atomically advances the dependent packet marker; no-packet review advances to a
   stored possible-invocation acknowledgement or policy-eligible
   `retry_local_execution` control. Coherent reviewed packet/local state also shows
   its ordinary decline control without forcing acknowledgement.
8. Race duplicate packet retry, possible-submission acknowledgement, and packet-
   decline requests:
   one action row/wake survives and packet version-2
   `{priorRuntimeAuditId,markerFingerprint}` replays exactly. Race duplicate local-
   change review, possible-invocation acknowledgement, local retry, and local
   decline with generic
   `{localRunEvidenceId,evidenceFingerprint}`. Substitute
   stale/cross-kind/route identity for each handler and prove `409` with no mutation
   or wake.
9. Revoke and restore an always-allow grant around a packet-recovery marker. The UI
   hides retry while uncovered, shows explicit reauthorization for the newer exact
   decision, requires acknowledgement first for post-intent delivery, and the new
   run snapshots the new decision/root-binding revision. Race an equal/newer package denial against the
   restore and prove canonical denial-wins hides retry.
10. Exercise every durable live packet phase: preparing, assembling, assembled, submitting,
    submission-rejected/finalizing, and accepted/finalizing. Each is actionless;
    live `assembling` renders neutral “Preparing project context” copy with no
    counts or actions and is rejected from every terminal artifact. Recovery maps
    an expired/crashed `assembling` attempt only to `assembly_unconfirmed`;
    every schema-valid expired/partial observation enters typed actionless
    `state_pending_reconciliation` and says “Refreshing run state” until recovery.
    Unknown status, unsupported schema, and corrupt cross-products instead use
    `state_unavailable` and “State unavailable—Forge update or operator repair
    required.” Kill the worker after each stage
    and prove a new process renders only PostgreSQL state, never a synthesized
    failed/finalizing phase.
11. Independently leave execution, local-evidence, and packet-issuance ownership
    active while packet/local recovery completes. Then leave a sibling execution
    lease live. Each barrier suppresses action. The task
    stays `running` and the marker says “Waiting for active package” without an
    action; after the shared operator-hold reconciler reaches `approved`, the bounded
    action may appear. Repeat with an `awaiting_review` sibling and assert “Waiting
    for required review” until its mandatory gate decision completes.
    Repeat for an S3-only filesystem hold and mixed recognized holds through direct
    and startup/periodic convergence. Repeat with a terminal sibling local-change barrier: no sibling new-run action
    appears, while only the marker owning the exact fingerprint exposes its review,
    acknowledgement, policy-eligible retry, or decline.
12. Invoke direct progress, sibling continuation, and periodic readiness with an
    S4 recovery, packet/local integrity-hold, or generic `local_effect_recovery` marker while
    current admission is otherwise valid. None promotes or claims it; only the
    exact owning packet/local action can clear its marker and neither clears the
    other. Every normal action rejects an integrity hold; it has no web action.
13. Render every post-submission failure stage from the exact failed
    audit/artifact/marker tuple. All copy is static; `host_apply` and a required
    host-ledger review warn of possible partial changes; changed ledger fingerprint
    hides retry; no path/raw detail or automatic resubmission appears.
14. Seed tuple mismatch, immutable-success-plus-failure-marker, packet integrity,
    and generic local-integrity states with mandatory alert identity. Incomplete
    success uses repair language; true mismatch
    says evidence is quarantined, not repairable. Every unresolved state is
    non-retryable/actionless and names Release/DevOps plus the runbook. A task-
    projection mismatch points only to projection repair, quiescence
    incoherence waits only for service-authored proof, and missing local evidence
    uses nullable row identity plus expected non-FK identity and quarantine copy.
    Exact
    `quarantined_abandoned` plus complete sibling-evidence-set/repository
    disposition and cancelled package/task renders “Task closed — evidence
    quarantined” with no browser control or new run. Incomplete sibling evidence
    remains unresolved and keeps root-management actions hidden.
    The presenter receives S5's branded, server-validated terminal/current join,
    not an artifact plus browser-supplied marker fields. That join carries the
    immutable terminal artifact, its independent runtime-audit ID and generic
    local-evidence ID/fingerprint, and the separately loaded current projection and
    optional recovery marker. Same-run/different-audit, same-run/different-evidence-
    ID, same-ID/different-fingerprint, stale marker, repaired marker, and no-marker
    substitutions must fail relationship validation. Failure still renders the
    immutable terminal artifact but asserts no current-state relationship.
15. Render an expired packet or no-packet local run with active/orphaned containment lease and
    quiescence alert as “Waiting for worker changes to stop.” Wrong-host recovery
    and per-run-child/protected-service/control loss with a surviving descendant
    remain actionless until a distinct authenticated same-host W2 proves the per-
    run group empty and persists `quiesced`. Queue-worker survival alone does not
    prolong a normally completed run. When no active W2 remains, the local union
    says “Recovery worker unavailable — Release/DevOps action required,” retains
    bounded alert/membership correlation, returns `actions:[]`, and names only the
    literal dry-run
    `npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>`
    plus `docs/operators/work-package-instance-replacement-v2.md`. It exposes no
    refresh, retry, acknowledgement, or decline; audited epoch-2 replacement later
    resumes the same state. A mutation sentinel rejects the retired “Waiting for
    an authorized recovery worker” total-loss copy while a separate transient
    unreachable-W2 fixture retains neutral waiting copy.
16. Repoint a project root after approval. The old decision renders “Project root
    changed — approve context again,” exposes no retry, and displays neither path
    nor the internal resource reference. Explicit new-root approval is required.
17. Render changed and unverifiable ACP working-tree, Git-control, or Git-storage evidence as “Repository changed
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
    review. Exact review later exposes reapproval/retry without changing delivery,
    even though the immutable comparison remains changed/unverifiable; the exact
    reviewed fingerprint plus zero task projection is the gate.
20. Seed working-tree/Git-control/Git-storage baseline/change/review or task-barrier version/
    source mismatch and audit-level
    `abandoned`; all render neutral integrity state with no action. Only a joined
    quarantine resolution may render abandonment.
21. Render both valid success branches with unchanged/not-applicable working-tree,
    Git-control, and Git-storage evidence;
    fabricated no-stage `quiesced`, incomplete ledger, and changed/unverifiable
    success tuples remain neutral and actionless.
22. Render packet-free and handoff-only generic recovery with exact quiescence,
    reason-specific local integrity, local review, possible-invocation
    acknowledgement, eligible/ineligible retry-policy states, decline, and typed
    packetless pending/unavailable states. Packet counts/
    audit/artifact/assembly/delivery/packet-retry/reapproval/acknowledgement remain
    absent. A packet run may show both presenters; generic review clears only its
    marker while atomically advancing the exact dependent packet disposition.

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

Never print packet contents, credentials, raw request bodies, or secret-like overlay
text. Never print root/selected paths or rejected Architect text. Diagnostics may
print opaque IDs, tuple fields, bounded enum failure stages, fingerprints, and
counts only after the same sink redactor and strict diagnostic schema. The live
channel receives only those regenerated fixed-schema tuples; no diagnostic or
reporter may tee raw child bytes or bypass the upload allowlist, schema scan, and
signed manifest.

## Migration, rollout, and rollback verification

S4 changes cross web and worker process boundaries, so S6 must prove this rollout:

For a legacy task above the 256-package cap, Release/DevOps uses only S4's exact
whole-task archive interfaces and layman-readable procedure:

```text
npm run protocol:inspect-local-projection-overlimit -- --task <legacy-task-id>
npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id>
npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id> --apply
docs/operators/local-projection-overlimit-archive-v2.md
```

The archive command never splits, reparents, deletes, or fabricates evidence. Its
checkpointed batches preserve the original task/package/evidence/head identities.
The named replacement is separate operator-created work with new identities, no
copied authority/evidence, at most 256 packages, and exactly eight preallocated
heads per package. It is durably `pending`, and every governed boundary rejects it;
apply locks and validates both tasks/versions/fingerprints before atomically making
the source `legacy_archived` and only that replacement `eligible`. Inspection and dry run report opaque IDs, counts,
checkpoint, and fingerprint only.

#179 Step 0 is the sole creator/version owner of the checked-in
`web/lib/mcps/epic-172-release-order-v1.json` schema and its one data-only
validator, `web/lib/mcps/epic-172-release-order.ts`. Neither imports S3 or
remaining-S4 symbols. The file contains one shared node registry plus two
separately named graphs:

- `codeDependencyGraph` records exact slice prerequisites: Step 0 depends on S2;
  S3 depends on S2 plus Step 0; remaining S4 depends on S2 plus S3; S5 depends on
  S2 plus remaining S4; S6 depends on S2, S3, remaining S4, and S5.
- `runtimeActivationGraph` records the deployment/cutover chain below.

The two validators reject using either graph's nodes or edges as the other graph.
#178/S3 and later slices import the same manifest/validator and record only their
owned node evidence through manifest-backed release state; they never create a
copy, helper, schema, or graph. The required runtime chain is:

```text
step0_retention_bridge
  → s3_issue_178
  → s4_expand
  → s4_producers_disabled
  → s5_compatible_consumers_deployed
  → s6_pre_activation_green
  → s4_controlled_activation
  → s6_post_activation_green
  → ingress_and_issuance_enabled
  → s5_s6_release_ready
```

Every node records the exact predecessor evidence and build identity. The manifest
rejects a missing, reordered, duplicated, or prose-only edge, graph substitution,
or a second file/helper. It also requires the
exact single-owner tuple for every node: `owner:{issue:179,slice:'step0'}` for
`step0_retention_bridge`; `owner:{issue:178,slice:'s3'}` for `s3_issue_178`;
`owner:{issue:179,slice:'s4'}` for `s4_expand`, `s4_producers_disabled`,
`s4_controlled_activation`, and `ingress_and_issuance_enabled`;
`owner:{issue:180,slice:'s5'}` for `s5_compatible_consumers_deployed`; and
`owner:{issue:181,slice:'s6'}` for both S6 green gates and
`s5_s6_release_ready`. The last node is the S6 controller's combined readiness
attestation; it does not transfer S5 implementation ownership to #181.

S6 imports the release-evidence bootstrap installed by Step 0 before either S3 or
remaining S4 lands: the manifest-backed append-only evidence/key/policy/consumption
tables, fixed checked-in Node verifier/recorder/consumer, and dedicated certificate-
authenticated writer/transition principals. The bootstrap imports no S3 or
remaining-S4 symbol and leaves every recorder/consumer except the one bounded Step 0
path disabled. S6 creates no second release table, mutable readiness flag, verifier,
or key state.

Every graph-node evidence receipt, final-readiness node, and non-node
`enabled_build_tests_green` evidence uses Ed25519 in S4's dedicated durable-release-
evidence signature domain. Every transition authorization uses S4's separate
transition-authorization signature domain. Neither may use an unsigned
`database_maintenance` arm, the other release domain, or the host-harness
attestation domain. The durable signed envelope binds its schema/manifest version,
node or required-evidence kind, owner,
exact build identities and trusted SHA, epoch where applicable, controller GitHub
App/integration and run/job, predecessor receipt identities/fingerprint,
suite/manifest/output evidence when applicable, signing-key ID/generation, a random
single-use nonce, and issued-at. The recorder verifies the signature, nonce, and
that issued/recorded database time falls inside the signer's valid policy interval
before retaining the immutable evidence. There is no separate signed record-by
field. Once accepted, that
record is durable evidence for its exact node/build/SHA/epoch/predecessors; elapsed
wall time or routine signer rotation cannot erase it or make a separately landable
Step 0/S3 deployment dead-end. It never authorizes a later transition by itself.

Every consumer instead requires a separately signed, renewable transition-
authorization envelope bound to the target canonical transition identity, exact
durable predecessor receipt set, current pinned-key generation/policy, controller
run/job, random single-use nonce, issued-at, and an expiry no more than 30 minutes
after issue. Only this fresh authorization is rechecked for expiry at consumption.
An expired unused authorization attempt remains audit; a newly signed attempt with
a new exact attempt ID and nonce may replace its authority but cannot replace,
mutate, or duplicate durable node evidence. Rotation,
retirement, compromise revocation, and emergency disable follow S4's imported
lifecycle and can stop new authorizations without rewriting history. Neither a
future/unregistered key nor a host-harness key can become release authority.

S6 imports S4's exact canonical transition-identity helper and type verbatim:
`{manifestVersion,nodeOrRequiredEvidenceKind,owner,exactBuilds,reviewedSha,
epochOrNone,canonicalPredecessorReceiptSetDigest}`. The completed-transition store
has one unique key over that identity in addition to unique durable evidence receipt
IDs; the authorization ledger separately prevents reuse of each authorization nonce.
A downstream transition locks the canonical identity, append-only durable evidence,
key/policy, authorization, complete predecessors, and consumption identities;
verifies Ed25519 plus every binding and current authorization-expiry predicate; then
records predecessor consumption and resulting node evidence atomically. Exact replay
returns the recorded result. A different authorization attempt ID, nonce, controller
run, signature, or receipt for an already completed canonical transition is a
duplicate conflict, not a second node. A changed kind, owner, build, reviewed SHA,
epoch, or predecessor set has a different identity and must satisfy its own manifest
edge. Two concurrent consumers therefore produce one winner even with separately
valid fresh authorizations. Transaction rollback consumes nothing. S6 tests forged,
expired, replayed, cross-build, reviewed-SHA-only mutation, required-evidence-kind
substitution, Step 0 `epochOrNone`, wrong predecessor/domain/key generation,
same-transition/different-receipt, renewable authorization after more than 30 minutes,
signer rotation between separately deployed nodes, concurrent double consumption,
and rollback before/after every insert.

The release-order sentinel evaluates every strict graph prefix. Scrub dry-run,
apply, and resume are actionless for every prefix that ends before
`s5_s6_release_ready`; only the complete graph plus that exact readiness receipt
may pass the scrub prerequisite.

1. **`step0_retention_bridge` — freeze legacy hard delete before expansion.** Deploy the bridge removal route
   that rejects or archives before filesystem work, disable all project-management ingress, and
   drain every pre-bridge web process/database session. Prove none remains between
   `fs.rm` and SQL. The first migration replaces all evidence-bearing project
   cascades with `RESTRICT|NO ACTION` and installs the database hard-delete guard.
   A sacrificial fixture executed before the bridge proves the old route's possible
   irreversible repository loss and is never reused as retention evidence. A fresh
   fixture created only after bridge deployment, process/session drain, FK change,
   and hard-delete guard proves archive-or-conflict retains every evidence row.
   In this same separately landable slice, install the release-evidence bootstrap
   described above, pin the initial Ed25519 key/App/ruleset policy, and use its sole
   enabled recorder to append signed `step0_retention_bridge` for the exact bridge
   build and retention postconditions. Direct SQL, an unsigned database fact, or a
   prose/check status cannot substitute. Only after that signed row commits may the
   S3 recorder be enabled for its one manifest-owned transition.
   Project ingress stays closed after those checks; neither the journal window nor
   any remaining S4 expansion opens yet.
2. **`s3_issue_178` — land and verify #178/S3.** With project ingress still closed, install the
   decision-revision, operator-hold, negative reconciliation, root-binding, and
   canonical lock-manifest/helper contract. The release gate records Ed25519-signed
   exact S3 build and test evidence through the Step 0 store. Missing, unsigned, or
   duplicate-transition S3 evidence rejects every remaining S4 schema,
   journal, reader, writer, or producer node.
3. **`s4_expand` — expand schema and deploy compatible S4 readers.** #179 first adds nullable project `root_ref` with **no
   default** while project ingress remains closed. Before the one mixed-version
   project-ingress reopen, a database-owned insert bridge
   assigns `gen_random_uuid()` when a new row omits `root_ref` **or explicitly sends
   null**, and a separate metadata change installs `DEFAULT gen_random_uuid()` for
   omitted values. The update guard permits unrelated updates where a pre-existing
   row remains null during backfill, but rejects every non-null-to-null transition
   so a bound row cannot be re-nulled. Bounded restartable batches fill all legacy/
   race nulls and repeat until uniqueness and zero nulls are verified. No `NOT
   VALID` non-null helper exists before that proof; only afterward may the migration
   add and validate its non-null check and set the column `NOT NULL`.
   The same expansion adds nullable nonce/claim/snapshot/effect fields, explicit
   unbound root revision `0`, nullable
   host-resource/key/maintenance/archive audit fields, exact-root partial index,
   hierarchy claims/guard, writer-pinned pre-create reservations, database-
   maintained task local-change projection/deferred constraint with version
   `INTEGER NOT NULL DEFAULT 0` and nullable source-set fingerprint (0/null remains
   non-authoritative until verified backfill), plus the eight S4-owned current-
   projection head kinds preallocated once per package. Creation writes all eight
   in the package transaction; migration backfills them in bounded, idempotent
   batches before the package becomes v2-authoritative; subsequent source changes
   only compare-and-set existing heads and never grow row count. Generic local-run
   evidence/actions, binding generations/owner-level rotation shadows, expansion-
   window root-change journal, recovery challenge/receipt fields, work-package/
   agent-run root and worker-instance pins, typed per-incarnation worker/root-writer
   principal registry with a unique normalized database principal, append-only
   epoch-2 membership changes and root-transition takeover ledger, protected
   current-principal heartbeat function, and
   service-only committed-election view/principal; host-apply ledger/entries;
   working-tree/Git-control/Git-storage evidence and review; generic local-review/
   local-retry plus issuance-recovery actions; and integrity alert/resolution
   tables (including service-authored `quiescence_proven`), protocol
   epoch active-host/key/generation/fence/containment/root-writer-credential fields,
   `work_packages.claim_protocol_version`, the rejecting package
   `running`-transition trigger, new status vocabulary,
   and partial indexes without
   changing legacy readers. Existing
   artifacts remain valid; S6 verifies schema/Drizzle/writer predicate parity and
   the deferred generic-effect/ledger/all-repository/task-projection and optional-
   packet constraint predicates. The expansion also installs the closed typed
   authorization constructor, duplicate-aware raw-JSON ingress parser, immutable
   JSONB/scalar validator, scoped approval foreign key, and protocol-v2 non-null
   task/package/run predicates. It rejects duplicate lexical JSON keys before
   `JSONB`, raw object spread/merge writers, and every null-identity direct-SQL
   bypass before producers are enabled.
   Project root exact uniqueness is partial to `archived_at IS NULL`; the durable
   hierarchy constraint rejects ancestor/descendant live roots, and
   protocol-v2 hard delete is rejected.
   As part of the same disabled-producer expansion, deploy dual readers and guarded
   writers. New readers treat every legacy
   filesystem decision without a stored root-binding revision as non-issuable, old preview decisions as
   `unknown_legacy`, old zero-default audit rows as `unknown_legacy` rather than
   proof of assembly, and legacy path-valued `root` as hidden. No current-path
   observation or binding command upgrades legacy authority.
4. **`s4_producers_disabled` — prove durable barriers and drain.** With the epoch still 1, register v2
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
   Crash/resume it and require exactly one audited outcome from the closed
   `insert|root_update|archive` vocabulary for every generation; hard delete is
   already impossible. Any gap/later legacy
   commit blocks the next command. Run
   `npm run project-roots:bind-v2 -- --actor <operator-id>` first as dry-run, then
   exactly `npm run project-roots:bind-v2 -- --actor <operator-id> --apply`, using
   `docs/operators/project-root-binding-v2.md`. Prove canonical alias/symlink/case
   and ancestor/descendant collisions remain audited/unbound blockers until
   repointed/archived; the command never changes public `rootRef` or any legacy
   approval. Every decision without immutable historical binding evidence remains
   held for explicit reapproval, including repoint-away-and-back fixtures.
   With ingress still disabled, enable the root trigger and prove it rejects root
   mutation at epoch 1 without calling S3 or locking task/package rows.
5. **`s5_compatible_consumers_deployed` — deploy compatible S5 and disabled S6.** S5
   readers must accept legacy/unknown plus the complete S4 schema without
   manufacturing state. The external S6 controller, exact-App ruleset, preflight,
   suite manifest, output quarantine, and signed-result verifier are deployed but
   cannot enable ingress or issuance.
6. **`s6_pre_activation_green` — require exact pre-activation evidence.** The
   controller-owned required check runs the complete pre-activation partition and
   records one fresh signed receipt for the exact S4/S5 builds, predecessor
   evidence, reviewed SHA, and host image. Missing, stale, cross-build, skipped,
   retried, or runner-self-attested evidence leaves epoch 1 and all ingress/
   issuance disabled.
7. **`s4_controlled_activation` — activate while every producer remains disabled.** Invoke the checked-in `web` command
   `npm run protocol:activate-work-package-v2 -- --actor <operator-id>` for dry-run
   and exactly
   `npm run protocol:activate-work-package-v2 -- --actor <operator-id> --apply`
   for cutover. Prove apply verifies/uses the privileged three-statement PostgreSQL
   `READ COMMITTED` protocol: lock epoch exclusively; after any wait, query running
   null/v1 claims plus the complete authenticated worker/root-writer candidate
   registry and unique principal set, verified task projections, journal/binding
   audit, epoch-2 membership state, and project roots in
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
   project mutation. Activation commits with queue intake, S3/root writers, project
   ingress, and packet issuance still disabled.
8. **`s6_post_activation_green` — require exact post-activation evidence.** The
   external controller runs the exact post-activation partition against the
   committed epoch/build and verifies the signed result, output-scan digest,
   teardown, and VM destruction/reimage receipt. The fresh signed receipt binds
   the exact activated epoch, S4/S5 builds, controller run, and pre-activation
   receipt. Failure leaves every writer and ingress/issuance path disabled.
9. **`ingress_and_issuance_enabled` — enter one bounded provisional window, with
   issuance last.** One #179-owned audited operation consumes the exact signed post-
   activation receipt, appends the uniquely identified Ed25519-signed enablement
   node, enables only the registered S3/root-writer principals in the activation
   snapshot, then queue/project ingress, and packet issuance last. In the same
   transaction it compare-and-sets Step 0's one mutable authoritative singleton from
   `disabled` to S4-owned state `provisional`, with database-owned `started_at`,
   non-extendable `expires_at = started_at + interval '1560 seconds'`, exact
   operation/build/SHA/epoch/receipt identity, the digest of the initial random
   secret generated and retained locally by the external controller before opening,
   authenticated release-controller login identity, and
   `lease_expires_at = least(clock_timestamp() + interval '45 seconds',
   expires_at)`. The closed singleton state type is only
   `disabled|provisional|active`. Partial enablement rolls back; no S5/S6 path may
   recreate, extend, or bypass this authority. A separate append-only,
   non-authoritative transition audit records dispositions
   `opened|heartbeat|failed_disabled|expired_disabled|manually_disabled|promoted_active`
   without becoming a second readiness flag or state machine.

   Every queue intake, project-management ingress, S3/root-writer mutation, package
   claim, bounded-context read, packet exposure, and issuance boundary checks the
   same singleton and PostgreSQL time before external or repository I/O. `active`
   is open. `provisional` is open only for the exact owner/build/SHA/epoch while
   both `clock_timestamp() < expires_at` and
   `clock_timestamp() < lease_expires_at`. The external controller uses
   its dedicated non-superuser, `NOINHERIT`, certificate-authenticated
   `session_user` plus the single-use lease secret to heartbeat every 10 seconds.
   Before each direct mutually authenticated database call, it generates the next
   random secret locally and sends the current raw secret plus only the next digest
   as prepared/binary parameters. The function hashes and consumes the current
   secret, compare-and-sets its digest/generation to the supplied next digest/
   generation, and returns no raw token.
   The fixed function can extend only that exact lease to at most 45 seconds from
   database time and never beyond the immutable outer deadline. A reused/stolen token,
   wrong login, stale fingerprint, old operation, delayed heartbeat, or `SET ROLE`
   attempt cannot refresh authority.

   A suite failure, skipped/retried test, output/teardown/destruction failure,
   controller-detected database or Checks outage, or controller cancellation calls
   the dedicated failure transition immediately. It compare-and-sets only the exact
   provisional owner to `disabled`, clears every writer/ingress/issuance flag, and
   appends `failed_disabled` atomically. Controller death requires no successful
   callback: its missed heartbeat makes every governed boundary reject within 45
   seconds. At either lease or outer expiry, the first boundary closes the same
   flags and appends `expired_disabled` before rejecting; a separately credentialed
   non-worker database-time watchdog performs the same idempotent transition while
   idle. Expiry/disable does not lower the protocol epoch, delete evidence,
   fabricate a graph node, or restart a legacy writer.

   Release/DevOps uses only these exact interfaces and guide:

   ```text
   npm run protocol:inspect-epic-172-provisional-enablement -- --operation <operation-id>
   npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id>
   npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id> --apply
   docs/operators/epic-172-provisional-enablement-v1.md
   ```

   Inspect is read-only. Disable without `--apply` is an exact dry run; apply locks
   the operation/evidence and closes writers, ingress, and issuance atomically.
   It appends `manually_disabled` but leaves authoritative state simply `disabled`.
   `project-roots:bind-v2` never advances the epoch. A restarted v1 route cannot
   authenticate/read a path and fails before filesystem work. The
   Release/DevOps integrity inspect/resolve commands plus runbook pass their
   authorization/fingerprint tests. Process principals cannot write their registry
   rows directly; only the fixed-search-path heartbeat may update the caller's
   `last_seen_at`.
   Before the first routine restart, run exactly
   `npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>`
   as the dry run and then exactly
   `npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id> --apply`.
   The matching procedure is
   `docs/operators/work-package-instance-replacement-v2.md`.
   It disables the affected ingress scope, revokes/drains the old principal and
   sessions, uses the separate maintenance principal, appends the compare-and-set
   membership audit, and promotes only the bounded compatible replacement set.
   S6 proves crash/resume, rollback-before-promotion, simultaneous replacements,
  and the all-active-instances-gone path. Root-writer replacement additionally
   proves external-fenced adoption or `cleanup_required` disposition for every old
  reservation/maintenance pin and the append-only takeover ledger before ingress;
  no worker flag, reused principal, self-transfer, or direct registry mutation may
  create epoch-2 membership. When all workers are gone, the separately credentialed
  non-worker watchdog—not a worker heartbeat—detects expired ownership plus zero
  eligible W2 and writes exactly one deduplicated alert before maintenance
  replacement proceeds;
- crash-test bounded principal retirement and garbage collection after replacement.
  A maintenance-owned transaction may retire a revoked/stale instance only after
  sessions are terminated and no package/run, recovery election/receipt, membership
  or takeover ledger, reservation, maintenance intent, alert, or audit still needs
  its immutable identity. Retirement first marks the incarnation draining/revoked,
  revokes login/connection authority, and terminates every session; it then destroys
  the provisioned client certificate and private key in the credential store and
  drops the database login role. The registry and audit retain an immutable
  normalized principal-name/incarnation tombstone and all historical references;
  neither that name nor incarnation may ever be reused. Crash tests stop before and
  after each revoke, session termination, certificate/key destruction, role drop,
  and tombstone transition and prove idempotent resume without declaring a resource
  destroyed early. Capacity tests cap and alert on the total active, candidate,
  pending-retirement, and retired-but-not-destroyed roles, certificates, and keys—not
  merely the active/candidate slot count—and block provisioning before that bounded
  resource backlog can exhaust the host or database. Wrong-generation, live-reference,
  concurrent heartbeat/claim, and partial root-writer takeover remain retained and
  non-authoritative. The failure-injection suite enters that lifecycle only through
  exact dry-run
  `npm run protocol:gc-work-package-principals -- --actor <operator-id>` and exact
  apply
  `npm run protocol:gc-work-package-principals -- --actor <operator-id> --apply`,
  and verifies `docs/operators/work-package-principal-lifecycle-v2.md` matches both.

After enablement, the external controller reruns the complete manifest-required
release suites against the actually enabled build. It records
`enabled_build_tests_green` as controller-owned required evidence inside the later
final-readiness receipt, not as an eleventh graph node. That signed receipt binds
the exact enabled S3/S4/S5/S6 builds, trusted SHA, epoch, controller App/integration
and run/job, suite-manifest and executed-ID digests, output/teardown/destruction
evidence, signing-key generation, and the exact `ingress_and_issuance_enabled`
predecessor receipt. A pre-enable, stale, partial, retried, cross-build, or runner-
self-attested result is not this evidence. The controller must record and consume it
before the provisional operation's database deadline; no client clock or renewed
receipt extends that deadline.

The enabled controller has a hard **660-second** database-measured deadline from
the provisional `started_at`, leaving a 900-second safety margin before the outer
1,560-second fail-closed deadline. Its fixed execution graph is: controller
orchestration and scheduling in at most 60 seconds; signed host preflight in at
most 30 seconds; then the five fully isolated suites run concurrently,
without retry, with the slowest bounded at 420 seconds; output scan, teardown,
out-of-band destruction/reimage, and their signed evidence complete in at most 120
seconds; controller verification, signing, evidence recording, and the final
readiness transaction complete in at most 30 seconds. The controller heartbeats
every 10 seconds throughout all five phases. It may not serialize the five suite
ceilings, borrow unused time from the safety margin, extend either deadline, or
retry a partition. A phase-budget miss invokes the authoritative failure-disable
transition. S6 proves a near-cap 660-second success and deterministic failure for
every one-second-over-budget, missed-heartbeat, and outer-expiry ordering.

10. **`s5_s6_release_ready` — mark final readiness.** Only after #179's enablement
   evidence is durable and the exact fresh `enabled_build_tests_green` receipt is
   verified, and while the exact provisional operation is still before both its
   PostgreSQL outer deadline and live controller-lease deadline, may the S6
   controller atomically insert two unique consumption rows—one for
   `ingress_and_issuance_enabled`, one for `enabled_build_tests_green`—append exactly
   one Ed25519-signed `s5_s6_release_ready` row under the canonical transition
   identity, compare-and-set the singleton from `provisional` to `active` with null
   expiry/lease, and append the non-authoritative `promoted_active` audit disposition. All
   authority/evidence writes commit or roll
   back together. A second enabled-build receipt, different nonce/signature for the
   same transition, expired/disabled operation, or already-consumed enablement row
   cannot record another readiness node. UI consumes but never manufactures this
   state. `enabled_build_tests_green` remains nested required evidence; adding it to
   either graph is invalid.

After that exact final-readiness receipt exists, #179—not test-only S6—may run its
separately gated restartable post-drain scrub/later migration through
exact dry run
`npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id>`, exact
apply
`npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id> --apply`,
and exact inspect
`npm run protocol:inspect-legacy-runtime-root-scrub -- --operation <operation-id>`, using
`docs/operators/legacy-runtime-root-scrub-v2.md`. S6 seeds legacy rows, crashes/
resumes bounded checkpoints, verifies only aggregate counts, proves applied
batches are not rolled back, and requires a zero-remaining inspect result before
eventual column drop. The operation is not registered as an ordinary expansion
migration. Readiness denial sentinels omit, forge, expire, replay, cross-bind, or
substitute the `enabled_build_tests_green`/enablement receipt, race two final-
readiness consumers using the same and separately valid receipt/nonces, and roll
back before/after each of the two consumption inserts, readiness insert, and
provisional-to-active promotion/audit append; none records a second or partial
`s5_s6_release_ready`.
Kill the controller and runner, fail/timeout each suite, drop the database and
Checks API at every boundary, expire the window while idle and during each
ingress/issuance path, expire the 45-second lease during every governed boundary,
race stale/stolen heartbeats with failure, and race automatic expiry with manual
disable and final promotion. The failure transition/watchdog/first caller closes
all flags exactly once, every later
path rejects before I/O, inspect reports the durable reason, and a disabled
operation cannot be extended, reactivated, or finalized. Scrub denial sentinels try dry-run,
apply, and resume with epoch 2, post-activation green, and ingress/issuance
enablement but no valid final receipt—or with final evidence missing the enabled-
build subreceipt. Every attempt is actionless and creates no scrub operation or
checkpoint. A resumed scrub rechecks the same exact final receipt and nested
evidence.

Compatibility tests cover old-web/new-worker and new-web/old-worker combinations,
legacy `allow_once`, old grant-blocked/failed packages, preview rows without mode,
old audit rows, a sacrificial pre-bridge irreversible-loss fixture distinct from a
fresh post-bridge retained-evidence fixture, and concurrent old
project insert/repoint/archive during the pre-cutover expansion window followed by
S3 reconciliation, canonical exact
and ancestor/descendant root-binding collisions, rootless projects, missing-root reservations,
tombstones, and existing duplicate-permitted
artifact types. An incompatible old
packet writer reconnecting through the bridge trigger is rejected at its package
transition before repository reads. Rollback is
code-only and forward-schema-compatible: leave additive columns, indexes, root
default/bindings, generic evidence, all repository evidence, ledgers/alerts,
journal, principal registry, membership audit, committed-election view, and
monotonic epoch in place; disable
v2 packet production and root management; prove all per-run containment groups empty and
intents terminal/held; and never restart an old packet or root writer against v2
state. Host-binding-key loss/rotation follows disable/drain → active-K1/pending-K2
owner shadow generations → complete-set verification → constant-size active-
generation/key/credential pointer plus bounded candidate promotion → bounded old-
generation cleanup → reactivate; divergent keys never silently split authority.
The release evidence records the exact rotation dry-run/apply/inspect/discard
commands and `docs/operators/host-binding-key-rotation-v2.md`, never ad hoc SQL or a
direct owner rewrite.

Unsupported-host tests run the activation preflight on macOS, Windows, same-user
development, and non-delegated container fixtures. Each refuses protocol-v2
activation with epoch still 1, performs no v2 drain/scrub, and preserves truthful
legacy/pre-cutover presentation. Existing beta support is not silently converted
into a claim of Linux containment.

## CI commands and budgets

S6 adds explicit package scripts; the generic `npm test` and `npm run e2e` remain
green and continue to include the appropriate suites.

Planned `web/package.json` commands are exact so CI cannot silently select a
different layer:

```json
{
  "preflight:mcp:host-boundary": "node scripts/run-with-deadline.mjs 30 -- node scripts/verify-mcp-host-boundary-attestation.mjs --harness-socket /run/forge-host-boundary/attest.sock --controller-challenge /run/forge-host-boundary/controller-challenge.json --public-key /usr/share/forge-host-boundary/attestation.pub --signed-envelope-out .artifacts/mcp-host-boundary-preflight.signed.json",
  "test:mcp:contract": "node scripts/run-with-deadline.mjs 60 -- node scripts/run-vitest-contract.mjs --manifest test-contracts/mcp-admission-v2.json --partition contract -- vitest run __tests__/mcp-admission-invariant.test.ts --testTimeout=10000",
  "test:mcp:postgres": "node scripts/run-with-deadline.mjs 240 -- node scripts/run-playwright-contract.mjs --manifest test-contracts/mcp-admission-v2.json --partition postgres --forbid-skips --forbid-retries -- --project=mcp-postgres --grep @mcp-postgres --timeout=45000",
  "test:mcp:issuance": "node scripts/run-with-deadline.mjs 300 -- node scripts/run-playwright-contract.mjs --manifest test-contracts/mcp-admission-v2.json --partition issuance --forbid-skips --forbid-retries -- --project=mcp-issuance --grep @mcp-issuance --timeout=60000",
  "e2e:mcp-operator": "node scripts/run-with-deadline.mjs 240 -- node scripts/run-playwright-contract.mjs --manifest test-contracts/mcp-admission-v2.json --partition operator-desktop --partition operator-mobile --forbid-skips --forbid-retries -- --project=mcp-operator-desktop --project=mcp-operator-mobile --grep @mcp-operator --timeout=60000",
  "test:mcp:host-boundary": "node scripts/run-with-deadline.mjs 420 -- node scripts/run-playwright-contract.mjs --manifest test-contracts/mcp-admission-v2.json --partition host-boundary --preflight-attestation .artifacts/mcp-host-boundary-preflight.signed.json --attestation-public-key /usr/share/forge-host-boundary/attestation.pub --require-attestation-signature --forbid-skips --forbid-retries -- --project=mcp-host-boundary --grep @mcp-host-boundary --timeout=90000"
}
```

`web/test-contracts/mcp-admission-v2.json` is a reviewed, checked-in allowlist—not
output generated from the current test tree. It has `schemaVersion:2` and six
partitions (`contract`, `postgres`, `issuance`, `operator-desktop`, and
`operator-mobile`, plus `host-boundary`). Each partition declares its runner, an explicit
`expectedCount`, and the complete sorted array of stable execution keys. A source
test declares one globally unique `scenarioId`; a Playwright execution key is the
composite `{projectName}::{scenarioId}`, while a Vitest key is
`vitest::{scenarioId}`. Thus one operator source scenario can appear once in the
desktop partition and once in the mobile partition without duplicating its source
identity. Execution keys are globally unique, count must equal array length, and
empty or wildcard entries are invalid. Adding, deleting, renaming, or
repartitioning a required test therefore changes this reviewed contract file in
the same PR.

The contract partition includes a checked-in architecture-parity sentinel. It
extracts stable machine-readable fixtures generated from the canonical production
types/constants. Parity is dimension-scoped rather than requiring every slice to
restate fields it does not own:

- ADR 0009 supplies the integrated S3–S6 fixture;
- #178 supplies the S3 lock prefix, grant/operator-hold transitions, revision/root-
  binding contract, journal handoff, and internal S3→S4 one-time-reapproval resolver;
- #179 supplies the three ownership leases, S4 lock tail, evidence/recovery enums,
  exact rollout/runbook command strings, and seven UI-route action identities:
  `review_local_changes`, `acknowledge_possible_local_invocation`,
  `retry_local_execution`, `decline_local_retry`, `retry_execution`,
  `acknowledge_possible_submission`, and `decline_packet_recovery`;
- #180 supplies current-state pending/unavailable/integrity branches and the exact
  action-to-presentation mapping; and
- #181 supplies the four-layer → five-suite-command → six-manifest-partition mapping,
  the separate host preflight, and trusted-runner evidence contract.

The sentinel therefore asserts eight durable mutation identities—the seven exact
UI-route actions above plus the internal S3→S4 resolver—without presenting the
resolver as an eighth CTA. It checks failure-code precedence, the canonical
  canonical version-2 manifest's relative lock edges plus every production path's
  applicable-row sequence, and the
following complete literal command/runbook set:

```text
npm run project-roots:reconcile-expansion -- --through <generation> --actor <operator-id> --apply
npm run project-roots:bind-v2 -- --actor <operator-id>
npm run project-roots:bind-v2 -- --actor <operator-id> --apply
npm run protocol:inspect-local-projection-overlimit -- --task <legacy-task-id>
npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id>
npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id> --apply
npm run protocol:activate-work-package-v2 -- --actor <operator-id>
npm run protocol:activate-work-package-v2 -- --actor <operator-id> --apply
npm run protocol:inspect-epic-172-provisional-enablement -- --operation <operation-id>
npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id>
npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id> --apply
npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>
npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id> --apply
npm run protocol:gc-work-package-principals -- --actor <operator-id>
npm run protocol:gc-work-package-principals -- --actor <operator-id> --apply
npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref <opaque-secret-ref> --actor <operator-id>
npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref <opaque-secret-ref> --actor <operator-id> --apply
npm run protocol:inspect-host-binding-key-rotation-v2 -- --rotation <rotation-id>
npm run protocol:rotate-host-binding-key-v2 -- --rotation <rotation-id> --discard --actor <operator-id> --apply
npm run local-execution-integrity:inspect -- --alert <id>
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution verified_success
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution verified_failure
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution projection_recomputed
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution generic_failure_reconstructed
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution quarantined_abandoned --expected-sibling-evidence-set-fingerprint <digest> --repository-disposition reviewed
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution quarantined_abandoned --expected-sibling-evidence-set-fingerprint <digest> --repository-disposition abandoned
npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id>
npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id> --apply
npm run protocol:inspect-legacy-runtime-root-scrub -- --operation <operation-id>
npm run protocol:inspect-host-boundary-controller -- --run <controller-run-id> --sha <sha>
npm run protocol:verify-host-boundary-controller-ruleset -- --repository <owner/repo> --app-id <github-app-id> --check forge/host-boundary-controller
npm run protocol:retry-host-boundary-controller-check -- --run <controller-run-id> --sha <sha> --actor <operator-id> --expected-state failed --apply
npm run protocol:retry-host-boundary-controller-check -- --run <controller-run-id> --sha <sha> --actor <operator-id> --expected-state timed_out --apply
npm run protocol:rotate-host-boundary-controller-key -- --pending-key-ref <opaque-secret-ref> --actor <operator-id>
npm run protocol:rotate-host-boundary-controller-key -- --pending-key-ref <opaque-secret-ref> --actor <operator-id> --apply
npm run protocol:inspect-host-boundary-controller-key-rotation -- --rotation <rotation-id>
npm run protocol:rotate-host-boundary-controller-key -- --rotation <rotation-id> --discard --actor <operator-id> --apply
docs/operators/project-root-binding-v2.md
docs/operators/local-projection-overlimit-archive-v2.md
docs/operators/work-package-protocol-v2-cutover.md
docs/operators/epic-172-provisional-enablement-v1.md
docs/operators/work-package-instance-replacement-v2.md
docs/operators/work-package-principal-lifecycle-v2.md
docs/operators/host-binding-key-rotation-v2.md
docs/operators/local-execution-integrity-repair.md
docs/operators/legacy-runtime-root-scrub-v2.md
docs/operators/host-boundary-controller-v2.md
```

The fixture rejects optional-option notation, prose aliases, renamed placeholders,
missing commands/guides, and any added ad hoc alternative.
For `quarantined_abandoned`, the request and append-only resolution store the exact
operator-supplied sibling-evidence-set fingerprint and explicit repository
disposition; the server never recomputes or chooses either value after the request.
The controller runbook names Release/DevOps ownership and the only supported
pending/failed-check inspection, exact-App ruleset verification, fingerprinted
retry, and dual-key rotation/discard paths. Retry never reruns a successful or
still-pending controller operation and never bypasses fresh signed evidence.
It does not copy policy logic into tests; an intentional
change updates the owning production source and the affected subset of all five
architecture fixtures in one reviewed PR.

Database scenarios carry exactly one of `@mcp-postgres` or `@mcp-issuance` in
their title or Playwright `tag` property—never a free-form annotation that
`--grep` cannot select. Visible browser scenarios carry `@mcp-operator`; they do
not carry either database-only tag. Host-containment scenarios carry only
`@mcp-host-boundary`; they are not admitted to a generic or database project.

`playwright.config.ts` defines dedicated single-desktop `mcp-postgres` and
`mcp-issuance` projects, desktop/mobile `mcp-operator-*` projects, and the
Linux-only serial `mcp-host-boundary` project. The generic
desktop/mobile projects set
`grepInvert: /@mcp-postgres|@mcp-issuance|@mcp-operator|@mcp-host-boundary/`, so unqualified
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
| `npm run preflight:mcp:host-boundary` | signed-image/kernel/identity/service/PostgreSQL-TLS prerequisite attestation | n/a | 30 s |
| `npm run test:mcp:contract` | Vitest canonical/parity/mutation sentinels | 10 s | 60 s |
| `npm run test:mcp:postgres` | desktop-only real-route, grants, lock-order, Redis recovery | 45 s | 240 s |
| `npm run test:mcp:issuance` | desktop-only nonce/claim/lease/failure-point races | 60 s | 300 s |
| `npm run e2e:mcp-operator` | Chromium desktop + mobile visible flow/accessibility | 60 s | 240 s |
| `npm run test:mcp:host-boundary` | Ubuntu 24.04 cgroup/UID/socket containment and descendant-escape sentinels | 90 s | 420 s |

For the post-enable proof these five suite commands run concurrently in isolated
database, Redis, filesystem, and host-fixture namespaces; their 420-second maximum
is one DAG phase, not a 1,260-second serial allowance. The 60-second controller-
orchestration phase, 30-second preflight, 420-second concurrent suite phase,
120-second teardown/output/destruction phase, and 30-second signing/final-
transaction phase form the mandatory 660-second outer
controller budget described above. Workflow/process ceilings remain defensive inner
bounds and cannot authorize a retry or extend that controller deadline.

The release-blocking host-boundary job in `.github/workflows/web-ci.yml` targets a
dedicated **ephemeral, single-job** self-hosted runner labelled `[self-hosted,
linux, x64, forge-host-boundary]`. A controller outside the repository checkout
provisions its signed immutable Ubuntu 24.04/Linux 6.8+ image, unified cgroup v2,
systemd scopes, separate unprivileged worker/service/test user IDs, root-owned
fence-service state, and a Unix-domain socket whose peer is checked with
`SO_PEERCRED`. Before the checkout namespace starts, the controller verifies and
prefetches the exact reviewed merge-queue SHA, digest-pinned action implementations,
package/cache inputs, test image, and local PostgreSQL TLS fixture. Nothing is
resolved or downloaded lazily by repository code.

The controller then places checkout/test code in a separate zero-egress user,
mount, PID, and network namespace. Only the controller/runner coordinator outside
that namespace retains narrowly allowlisted GitHub control-plane access for job
status and cancellation; checkout code has no route to GitHub, package registries,
provider endpoints, metadata services, or the public network. All test services
are already-local fixtures. The immutable root harness and its narrow fixed API are
baked and signature-verified outside the checkout; repository code cannot replace
it, select arbitrary root commands, paths, users, sockets, cgroups, or mounts, or
obtain its attestation key.

For each job the external controller creates a single-use random challenge/nonce
bound to workflow run, job, trusted commit SHA, image digest, boot ID, harness/
fixture digest, PostgreSQL TLS fixture identity, issued-at, and short expiry. The
checkout-controlled `verify-mcp-host-boundary-attestation.mjs` client can only send
the controller challenge over the fixed root-harness socket, request evaluation of
the fixed capability list, and verify the returned envelope with the pinned public
key. Repository code can mint neither attestation facts nor the signature. The
harness returns a signed, immutable envelope over that nonce and the observed
kernel/cgroup/UID/socket/protected-state facts. Before any scenario runs, the host
test command independently re-verifies that envelope's signature and pinned key as
well as its scenario bindings. A controller-side verifier outside both checkout
clients remains an independent authority and verifies signer identity, nonce,
signature, run/job/SHA/image/boot/harness/TLS bindings, and expiry before accepting
the preflight gate. Missing capabilities or evidence fails the job—never skips or
retries it. Negative tests cover forged signatures, wrong signer/job/SHA/boot,
expired envelopes, changed harness/image/TLS identity, and replay across jobs.

The privileged runner is reachable only from a trusted merge-queue SHA or a manual
dispatch protected by the release environment; it never runs `pull_request_target`
or untrusted fork/branch code with privilege. Untrusted pull requests run the
unprivileged partitions and the required-check handoff remains pending until that
exact reviewed SHA receives trusted evaluation. The job token is read-only, has no
write permission or repository/environment secrets, and is never exposed inside
the checkout namespace.

A separate external-controller-owned GitHub Check Run named
`forge/host-boundary-controller` is the required merge-queue/release check. The
controller creates it as `in_progress` for the exact SHA before provisioning and it
stays pending after the runner job and `test:mcp:host-boundary` process exit. Only
the controller's outside-checkout GitHub App credential has `checks:write`; the
runner, workflow token, checkout, harness, and cleanup callback cannot conclude or
replace it. The repository ruleset pins the required check to the exact audited
controller GitHub App integration/App ID, not its display name alone. A same-name
GitHub Actions check or check from another App is foreign evidence, cannot satisfy
the rule, and raises a configuration-drift failure while the controller check stays
pending. The checked-in expected App ID/ruleset fingerprint is verified before
provisioning and through the exact operator command/runbook above.

Checkout callbacks and process exit are advisory. The outside-checkout coordinator
observes the process and manifest execution, then signs one single-use suite-result
envelope containing controller run/job/SHA/image/boot identity, suite-manifest and
executed-ID digests, first-attempt-only exit status, output-scan digest, result
nonce, issued-at, and expiry. It signs failure as well as success and will not sign
an incomplete manifest, missing output scan, retry, skip, or duplicate execution.
The controller concludes success only after it has independently
verified the signed preflight envelope, the signed successful suite-result envelope,
verified the signed teardown envelope, destroyed/reimaged the VM out of band, and
verified its own signed destruction/reimage receipt for the same run/job/SHA/boot.
Any missing, inconsistent, replayed, or late fact concludes failure after the
controller deadline; runner success/callback alone can never make the required
check green.

At job end, root-harness cleanup of scopes, transient users, sockets, certificates,
and databases is best-effort evidence collection, not the containment authority.
The harness signs a second challenge-bound teardown envelope containing the
preflight identity, final zero-residue observations, time, and expiry; the external
verifier applies the same signature/replay/job/SHA/boot checks. Cleanup failure or a
nonzero observation fails the release gate, but cannot keep the host alive. On
success, failure, runner loss, timeout, or cancellation, the independent controller
uses an out-of-band deadline/TTL and cancellation watcher to revoke the runner and
destroy the entire VM. A controller-signed destruction/reimage receipt, not a
checkout `always()` step, is authoritative; absence of that receipt fails the gate
and prevents runner reuse. Tests kill the runner and root harness during cleanup,
drop job callbacks, forge runner success/conclusion output, replay a prior receipt,
forge/replay/cross-bind/expire the suite-result envelope, omit one manifest ID,
substitute a stale output-scan digest, create same-name foreign-App/Actions checks,
delay the Checks API, duplicate callbacks, expire the TTL, and prove controller
destruction still occurs while its required Check Run remains pending and then
fails unless the complete same-job evidence set arrives. A transient Check Run API
failure is retried only by the controller and never delegated to the runner.
Every next job starts from a fresh signed image. macOS, Windows, containers without
these kernel controls, and same-user emulation are unsupported evidence for this
gate.

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
worker. Every privileged child runs through a no-tee quarantine wrapper. Raw child
stdout/stderr, reporters, annotations, summaries, attachments, traces, screenshots,
videos, diffs, and dumps are written only inside the disposable VM; before scanning,
the live GitHub runner channel receives fixed schema-free status codes and opaque
run IDs, never child bytes. Controller, harness, and cancellation diagnostics use
the same fixed-schema channel.

The only uploadable diagnostic bundle is a strict allowlist of canonical sanitized
UTF-8 text/JSON records regenerated from path-free typed tuples after request-body
redaction. Raster images, video, Document Object Model snapshots, core/error dumps,
raw traces/reports/logs, archives, encrypted/unknown containers, and every other
opaque/binary format are never uploadable; they remain inside the VM and are
destroyed with it. The pre-upload scanner parses every allowlisted record, rejects
unknown fields/types, scans values and keys for every seeded sentinel, and signs a
path-free manifest/digest. A hit, parse/schema failure, non-allowlisted file, or
manifest mismatch suppresses the whole upload and fails the check. A fake live
GitHub sink proves zero sentinel bytes before the scan, including when a sentinel
is printed to stdout/stderr or requested as an annotation/summary. CI uploads only
the signed sanitized tuple bundle plus opaque audit/run IDs. It also
fails if a suite is skipped unexpectedly or exceeds its budget;
increasing a budget requires an explicit review note. Generic `npm test` and
`npm run e2e` must still pass under repository-wide defaults, but their result is
smoke compatibility, not a substitute for manifest-bound release evidence. The
strict no-skip/no-retry policy is scoped to the five suite commands; the separate
preflight command is a same-job trust/attestation gate and must pass first.

## Coverage ownership

- #181 adds no production policy.
- If a scenario requires production behavior not implemented by #177–#180, fix the owning implementation PR/issue rather than adding test-only branches.
- Shared helpers must not reimplement classification or admission.
- #179 owns generic local-run evidence/recovery plus packet claims for both grant
  modes, nonce fencing, snapshot/artifact terminal repair, packet actions/
  acknowledgements, rootRef/path scrub, root-binding/reservation/tombstone/fence/
  containment protocol, per-incarnation principal activation, task projection,
  change journal, binding-generation rotation, effect ledger/all-repository
  constraints, protected registry heartbeat, epoch-2
  membership replacement, service-only committed-election reader, integrity
  adjudication, prompt/log leakage tests, and schema/mixed-
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
4. Integrate issuance/evidence race scenarios, including duplicate-key-before-
   `JSONB`, fixed typed authorization construction, and protocol-v2 null-identity
   direct-SQL attacks, plus append-only approval decisions/current-pointer
   reapproval history.
5. Add protected control-state/exchange and run-lifetime fence/containment,
   new/existing-project reservation, tombstone/root-reuse, caller-authentication,
   binding-generation, generic effect-ledger and all-repository crash barriers,
   plus review-pending arbitration.
6. Add complete generic-evidence/optional-audit/host-ledger/artifact/action/
   integrity/gate lock-order races plus terminal/effect/all-repository/task-
   projection constraint tests, including exactly eight preallocated current heads
   per package and count-neutral maximum-cardinality recovery/action/migration.
7. Add candidate/active principal, no-direct-registry-write/protected-heartbeat,
   service-only committed-election reader, audited epoch-2 replacement,
   pre-activation all-mode, root-binding, journal, Step 0 release-store bootstrap,
   durable-node/fresh-transition-authorization Ed25519 identity, projection-
   overlimit legacy archive, provisional ingress/credential activation/controller-
   lease/expiry/disable/promotion, key-rotation, and rollback tests.
8. Add integrity alert/runbook/privileged-resolution/quarantine sibling-evidence
   contract tests.
9. Add prompt filtering/injection assertions, immutable-`session_user` definer-
   reader attacks, and the historical task-log prompt scrub.
10. Add thin Playwright packet-current-state and packet-independent local recovery,
    quiescence, reason-specific integrity, review, possible-invocation
    acknowledgement, policy-eligible retry, decline, pending, and unavailable flows.
11. Add the claim/preflight boundary, full failure/recovery, and mixed-version
    matrices, including the no-local-ACP-replay sentinel.
12. Add persistence-wide leakage sentinels, raw-plan direct-SQL/principal attacks,
    and failure diagnostics.
13. Wire the five named suite commands plus the separate same-job host-boundary
    preflight client, immutable root harness, external signed-attestation verifier,
    exact-App-pinned controller-owned required Check Run, signed suite-result
    envelope, controller-enforced zero-egress namespace/destruction TTL, no-tee
    live-output quarantine, sanitized text/JSON-only upload allowlist, TLS fixture,
    controller/provisional-enablement operator runbooks and exact commands, and
    numeric budgets, including the 660-second enabled-run DAG.

## Completion gate

The Epic regression is complete when the named commands exercise contract,
PostgreSQL, issuance, operator, and supported-host boundary layers within budget,
while normal `npm test`,
build, migrations, and Playwright remain green. The suite must fail when any one
admission surface is deliberately mutated to disagree, when an incompatible worker
or root writer tries to act, when a legacy approval becomes issuable, when a
post-bridge hard delete loses evidence, or when a path/content sentinel reaches packet persistence
or any CI output/upload sink. It must also fail for caller-instance spoofing, a pre-activation v2
claim, stale-zero task projection, no-packet legacy recovery, working-tree,
Git-control, Git-storage/history-authority, or reachable `.forge` tampering;
fabricated W2 handoff; worker-written registry authority; missing audited epoch-2
replacement, rotation shadow, journal generation, or supported-host preflight; a
second local ACP call after any possible repository mutation; or provider-
attributing `submission_failed` copy.
It must fail on any ADR/#178/#179/#180/#181 owner-dimension parity drift; missing local-lease cause or
precedence; missing generic invocation intent/acknowledgement/decline; root-writer
pin takeover without its ledger; external Git authority, lazy promisor fetch/object
write, or an over-max scanner; post-bridge pre-expansion hard delete/cascade;
unsupported-host v2 activation; privileged host
CI on an untrusted SHA; a replaceable root harness; a non-TLS/overprivileged
committed-election reader; a forged/replayed/expired or checkout-self-authored
attestation; a runner-concluded or prematurely green controller check; missing
exact-App ruleset pin or signed complete suite-result envelope; S4 activation
without S5 consumers and S6 pre-activation evidence; ingress/issuance before S6
post-activation evidence; live child output reaching the runner channel;
external cancellation/TTL destruction; unsafe Unix privilege transition; missing
teardown/destruction/reimage receipt; unredacted request body; or an unscanned/
sentinel-bearing allowlisted record, or any uploaded trace, report, raw log,
screenshot/video/DOM snapshot, attachment, diff, dump, archive, or opaque binary.
It must also fail if Step 0 does not own the one release-manifest schema/validator,
if Step 0 does not install the signed release-evidence bootstrap before S3/S4, if
any graph node or transition uses unsigned/database-only evidence, if one canonical
transition accepts a different receipt/nonce or records twice,
if code-dependency and runtime-activation graphs are absent or substituted, if S5
accepts `not_assembled/assembly` or lacks live `assembling`, or if total W2 loss
renders passive waiting copy instead of the exact Release/DevOps branch. It also
fails if copied live execution/generic/packet credentials work under a wrong
database principal at any governed boundary; if an unavailable authoritative host
fabricates a terminal artifact; if a bare `not_started` local invocation exposes
retry; if recovery maps a surviving `invoking` row to `returned`; if rejected
Architect text escapes `architect_plan_entries` into any runtime/operational sink;
if either no-op handoff prompt producer survives; if a legacy unkeyed digest is
re-exported, represented by an alternate suppression/truncation arm, or treated as
keyed evidence; if a historical prompt-shaped task-log field survives or is exposed
before scrub; if a general database principal can directly read raw plan text, if a
human reader trusts shared-login `session_user` as a user or accepts an asserted user
ID instead of deriving it from a live opaque Forge session, if the package reader
does not derive its worker from `session_user`,
or if either dedicated reader is invoked outside its exact role; if plan history or an
eligible projection reference leaks through live/SSE/snapshot/replay/Redis state
or crosses its exact entry scope; if release
evidence bypasses the manifest-backed append-only store, pinned signing-key
lifecycle, Ed25519 signature domain, canonical transition identity,
freshness/replay, or atomic-consumption rules; if a duplicate lexical authorization
key reaches `JSONB`, a writer bypasses the fixed typed constructor, or a protocol-v2
claim/audit/artifact/action accepts a null required task/package/run identity; if
the 256-package projection lacks exactly 2,048 preallocated current heads, any
normal action allocates a ninth head, or max-cardinality recovery, acknowledgement,
decline, quarantine, cancellation, repair, or migration cannot complete count-
neutrally; if provisional ingress/issuance survives its database deadline,
controller death, suite failure, timeout, or database/Checks outage, or if any path
can bypass/extend a non-active operation; if final readiness does not atomically
consume both enablement and `enabled_build_tests_green`, uniquely append its node,
and promote the same provisional operation; if final readiness lacks the post-
enable `enabled_build_tests_green` evidence or that evidence is incorrectly added
as a graph node; or if legacy-root scrub dry-run/
apply/resume succeeds before exact `s5_s6_release_ready` evidence.

## Stop conditions

Stop if the test needs hand-setting approval status, external services, packet
content persistence, worker-wall-clock lease authority, timing sleeps as race
proof, policy reimplementation, or production-only test hooks that bypass
route/transaction behavior. Stop if mixed-version behavior, a failure-matrix row,
or a persistence sink has no explicit owner and sentinel.
Also stop if a test can expose a new run/action before fence-service/containment
quiescence, every fingerprint-bound working-tree/Git-control/Git-storage review,
or mandatory sibling review; if normal web
actions can clear integrity holds; if completion preparation and atomic rollback
are conflated; if root management/path reuse or wrong-host recovery can bypass the
run-lifetime fence; if nonexistent-root creation lacks a namespace reservation; if
activation/later claims cannot machine-check the exact single-host instance/key/
containment/credential snapshot; if an old web route can read a path after cutover;
if quarantine can drop a sibling root-management barrier; if effect/ledger/
repository-review/terminal tuples diverge between PostgreSQL and readers; or if a
production mutation lacks an applicable-row sequence fixture, is not an ordered
subsequence of the canonical version-2 manifest, violates stable intra-category
order, acquires an undeclared row, or lacks
real PostgreSQL barriers for its adjacent applicable edges. Stop if the supported Ubuntu host-boundary suite can skip,
retry, run under one user, lack cgroup-v2/systemd/`SO_PEERCRED` proof, or use a
non-release-blocking runner; if it can execute untrusted fork/branch code,
`pull_request_target`, repository-controlled root commands, writable tokens,
secrets/egress, or an unsigned/replayed/self-verified preflight; if controller
cancellation/TTL cannot destroy the VM independently of checkout/root-harness
cleanup; if the external-controller-owned required Check Run can be concluded by
the runner, can be satisfied by a same-name foreign-App/Actions check, lacks a
signed manifest-complete suite-result envelope, or turns green before verified
signed teardown plus destruction/reimage receipt; if any protocol-2 mode can run before activation; if
a caller GUC substitutes for database identity; if no-packet local work can use
legacy or packet recovery; if a coherent stale task projection passes; if any
local-root ACP path can replay after possible mutation; if worker/root-writer
principals can mutate membership or protected registry state; if epoch-2 restart
lacks the audited replacement command; if the recovery service can read committed
election state through an unselected trust path; if Git-control, Git storage, or
same-owner `.forge` state is ignored; if W2 challenge/receipt crash boundaries are
untested, including both database-lease/receipt expiries, the no-takeover-grant
proof, protected `expired_ungranted` tombstone, matching database election tombstone,
and greater recovery epoch; if
heartbeat reverses the instance-before-generation lock order; if the watchdog
`SECURITY DEFINER` boundary or principal retirement/GC crash recovery is untested;
if any Git invocation lacks exact `GIT_NO_LAZY_FETCH=1`, if the immutable binary-
capability probe and every invocation disagree about whether to add
`git --no-lazy-fetch`, or if either branch can lazy-fetch/write objects; if setid/file capabilities, `/proc/<pid>/mem`,
`process_vm_readv`, `ptrace`, signals, device nodes, mount flags, or shim-identity
impersonation can cross the supported-host boundary; if the shim lacks a distinct
user ID and kernel non-dumpable/ptrace boundary; if existing-project reservation
binding reverses locks; if rotation
rewrites all owners in its flip; if journal watermark gaps pass cutover; or if raw
prompt aliases survive.
Stop if local retry ignores any of the three ownership leases, sibling barriers, or
server policy eligibility; if unchanged repository evidence exposes direct retry
without `definitive_not_started`, including from bare `not_started`; if an
orphaned/recovered `invoking` attempt can become either `returned` or
`definitive_not_started`, or if the still-live exact owner/attempt can record that
state without the trusted typed pre-I/O refusal and ownership compare-and-set; if
coherent reviewed packet/local recovery lacks an
ordinary decline path; if decline coerces uncertainty acknowledgement; if unknown/
corrupt state is presented as transient; if missing local evidence needs a
fabricated row; if a root-writer replacement can orphan or silently seize old pins;
if the expansion window still permits hard delete/cascade; if sterile Git discovery
or numeric maxima are not exercised; if any rollout/repair/GC/rotation/scrub command
or runbook is absent from literal parity, represented with optional/shorthand
notation, or replaced by ad hoc SQL; if any prompt-bearing request body reaches a
reporter/trace before redaction; if any raw child byte reaches the live runner
channel; if any non-allowlisted media/binary/archive can upload; if sanitized
text/JSON bypasses schema/key/value scanning and the signed manifest; if the seeded
post-prompt failure does not exercise live and stored sinks; or if unsupported macOS/Windows/container fixtures
can advance epoch 2.
Stop as well if a copied ownership token works under a principal other than the
pinned authenticated instance; if terminal packet-artifact cardinality assumes
liveness while quiescence/owning-host recovery is unproven; if rejected Architect
text has any source besides the append-only ACL-gated `architect_plan_entries` or
enters a runtime package/API/SSE/log/export/error/wire sink; if a no-op handoff
producer, historical prompt-shaped task-log field, or legacy unkeyed prompt digest
bypasses read hiding and checkpointed migration parity;
if an eligible plan entry can cross project/task/version/entry/agent/requirement/
digest scope or survive in a forbidden live/SSE/snapshot/replay/Redis sink; if a
general application principal can select raw plan entries, if a definer reader
authorizes owner `current_user`, if the human reader cannot reject swapped/expired/
revoked session credentials with zero bytes/audit, or if either reader
can run outside its exact ACL/package-bound role; if arbitrary authorization JSON can bypass the
fixed constructor, duplicate keys can reach `JSONB`, or SQL null semantics can erase
a required protocol-v2 task/package/run scope; if reapproval mutates a decision
already referenced by historical evidence instead of inserting a new immutable
decision with strictly greater revision/fresh nonce and compare-and-setting the
current pointer, or if the old package-unique history index survives; if the exact eight projection heads
are not preallocated per package or any ordinary action/migration needs a ninth row
at maximum cardinality; if an over-limit task can be reparented, deleted, claimed,
or cleared without the checkpointed whole-task archive and retained evidence; if
the named replacement can claim while `pending` or become eligible outside the
atomic source-archive/replacement CAS; if
Step 0 cannot install and use the signed release store
before S3; if any graph node/transition is not Ed25519 signed; if canonical
transition uniqueness can be evaded with another receipt/nonce; if durable recorded
node evidence expires before a later separately deployed node, or if a transition
authorization can use the wrong signature domain/key generation, omit expiry/nonce/
predecessor/build bindings, replay, double-consume, or stay consumed after a rolled-
back transition; if any ingress/issuance boundary can run after the provisional
database deadline, the 45-second controller lease, or manual/automatic/failure
disable, if the controller does not generate/retain the initial secret before open,
if heartbeat uses a different login/service, stores/returns raw tokens, or fails to
rotate digest/generation atomically, if a heartbeat can extend either deadline, if the enabled proof is not
bounded by the exact 660-second DAG, if failure cannot close all flags without
lowering the epoch, or if final readiness does not atomically consume both exact
receipts and promote the same operation; if `enabled_build_tests_green` is missing
from final readiness, predates enablement, binds a different enabled build, or
appears as an eleventh graph node; or if root scrub can start or resume before the
complete final-readiness evidence.
