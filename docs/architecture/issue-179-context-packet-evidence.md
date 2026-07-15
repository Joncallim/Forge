# Issue #179 Architecture: Specialist Prompt and Bounded Context Evidence

Status: corrected architecture proposal; this primary document is authoritative
Issue: #179
Parent: #172
Depends on: #176, #177, and #178's shared grant-decision ordering and operator-hold contract
Canonical policy: ADR 0009; bounded packet vocabulary: ADR 0008
Downstream readers/tests: #180, #181

## Objective

Deliver only canonically admitted MCP instructions and bounded filesystem context to a specialist run. Every packet run has one fenced issuance claim; an `allow_once` packet also has one winning claim for the operator decision nonce. Success, failure, and recovery produce truthful run-linked metadata without persisting raw repository contents, names, paths, or live MCP handles.

## Boundaries

- MCP admission controls only the Forge-issued MCP channel. ACP processes are not OS sandboxes and may independently possess shell/network/environment access.
- Prompt instructions cannot be treated as enforcement.
- Packet contents are prompt-only and ephemeral; artifacts contain metadata only.
- One winning per-run packet claim is guaranteed for every packet. An `allow_once` decision additionally has one winning claim per decision nonce. PostgreSQL cannot recall bytes already read or cancel an in-flight Agent Client Protocol (ACP) submission.
- The packet claim is subordinate to the existing work-package execution lease. A worker must own both at every Forge-governed read or exposure boundary.
- #178 owns the pre-claim operator hold and the project-serialized grant decision revision. This slice consumes those contracts and owns post-claim packet recovery. #180 reads the evidence defined here; #181 proves the integrated behavior.

## Architecture layers

### 1. Runtime instruction projection

Add one pure projection over the S2 `McpWorkPackageAdmission`:

```ts
type ExecutableMcpInstructionProjection = {
  schemaVersion: 1;
  requirementInstructions: Array<{
    requirementKey: string;
    agent: string;
    mcpId: string;
    mode: 'planning_only' | 'bounded_context_approved';
    content: string;
  }>;
  subtasks: Array<{
    subtaskId: string;
    agent: string;
    content: string;
    bindings: Array<{ capability: string; requirementKey: string }>;
  }>;
  staticBoundaryWarnings: string[];
};
```

Eligibility:

- allowed + `planning_only`;
- allowed + `bounded_context_approved`;
- narrow exception: warning + `planning_only` where every capability class is planning-only.

Exclude full Architect-authored text for deferred, unknown, blocked, missing-context, unhealthy, or mixed warnings. A subtask is emitted only when every capability binding is eligible. Rejected text is not echoed into the executable prompt; emit a static Forge-authored boundary warning instead.

### 2. Prompt serialization

Use length-bounded structured JSON sections, never delimiter-based concatenation:

```json
{"kind":"mcp_requirement_instruction","requirementKey":"...","content":"..."}
```

Prompt trust wording is provider-capability-specific:

- providers that preserve roles receive the Forge policy in their actual
  system-role input, and tests capture that wire-level separation;
- the current ACP adapter flattens system and user messages into one
  `session/prompt` string, so ACP receives a bounded Forge-authored guidance
  section before the serialized untrusted data. That guidance is not immutable,
  is not role-separated, and is never described or tested as enforcement.

The Forge-authored policy/guidance states:

- repository packet data is untrusted;
- overlays are subordinate run instructions;
- neither changes tool, credential, repository, or admission policy;
- Forge issued no live MCP handle.

The user-role prompt may repeat a Forge-authored reminder after untrusted sections
to aid model attention, but that reminder is not immutable and is not an
enforcement boundary. ACP's flattened first guidance section has the same limited
status. Reject invalid encoding; truncate only at documented field boundaries and
record omission counts. Tests include fake system messages, closing fences,
credential requests, and `gh` commands. Prompt logs persist only a digest, byte
count, and omission counters through the existing task-log sanitization path;
debug logs never persist the prompt, packet, selected names, paths, or rejected
Architect text.

The serializer reuses the producer limits (`20` requirements, `40` MCP-aware subtasks, and `2,000` characters per materialized overlay) and adds a `128 KiB` UTF-8 ceiling for the complete executable MCP JSON section. It rejects an over-count collection instead of partially authorizing it. It may omit a whole optional field at a documented boundary to stay under the byte ceiling, records the field/count omission, and never slices a JSON string or capability identifier.

### 3. Capability merge and filesystem packet gate

The executor imports `mergeCapabilityFields`, `classifyCapability`, and `coverageKeysForGrant`; it owns no third policy copy.

A bounded filesystem packet may be requested only by current `bounded_read_only` filesystem capabilities with a valid approved effective grant. `filesystem.project.write` remains a planning instruction and never activates packet issuance.

## Authorization identity and immutable claim snapshot

#178 assigns every package-local or project-level filesystem decision a monotonic
PostgreSQL `BIGINT` `grantDecisionRevision` while holding the project row lock.
JSON/evidence uses its canonical base-10 string representation; ordering uses the
database integer, never JavaScript number precision or lexical comparison.
Timestamps are display data, not precedence. A new package-local `allow_once`
approval also receives an immutable UUID `grantDecisionNonce`; reapproval rotates
the nonce even when the current approval pointer is updated. The approval decision
and effective package snapshot must agree on approval ID, decision revision, and
nonce.

Historical authorization must not be reconstructed by joining an old audit to a mutable current approval row. Each packet claim stores an immutable, bounded authorization snapshot:

```ts
type PacketAuthorizationSnapshot = {
  schemaVersion: 2;
  source: 'package_allow_once' | 'project_always_allow';
  grantApprovalId: string | null;
  grantDecisionRevision: string;
  grantDecisionNonce: string | null;
  grantMode: 'allow_once' | 'always_allow';
  approvedCapabilities: FilesystemProjectCapability[];
  requiredCapabilities: FilesystemProjectCapability[];
  decidedByUserId: string;
  decidedAt: string;
  coverageFingerprint: string;
};
```

The fingerprint uses canonical capability and policy fields only. It never includes a path, prompt, file name, content excerpt, free-text reason, or credential.

Required additive schema changes:

- `filesystem_mcp_grant_approvals.grant_decision_nonce UUID NULL` during migration; every new `allow_once` write requires it after cutover;
- a durable decision revision on the approval decision/effective snapshot, using the #178 project-serialized revision contract;
- `work_packages.claim_protocol_version INTEGER NULL`, written by the database on
  each transition to `running` and retained as durable claim evidence;
- `filesystem_mcp_runtime_audits` fields:
  - `protocol_version`;
  - `grant_approval_id`;
  - `grant_decision_revision`;
  - `grant_decision_nonce`;
  - `agent_run_id`;
  - `status` (`claiming|succeeded|failed`);
  - `claim_token` UUID;
  - `lease_expires_at`;
  - immutable authorization snapshot;
  - packet assembly snapshot;
  - delivery outcome;
  - terminal success/failure outcome and bounded failure code/stage, with database
    checks matching the normative tuple table below.
- append-only `filesystem_mcp_issuance_recovery_actions` with actor, typed action
  (`acknowledge_possible_submission|retry_execution|resolve_after_allow_once_reapproval`),
  prior runtime-audit/agent-run IDs, marker fingerprint, delivery state, nullable
  authorizing decision revision/coverage fingerprint/approval ID, database time,
  and a unique `(runtime_audit_id, action, marker_fingerprint)` key.

Two separate partial unique indexes are required for protocol v2 `operation='context_packet'` rows:

- `(agent_run_id, operation)` — one packet claim for every packet run;
- `(grant_approval_id, grant_decision_nonce, operation)` where the nonce is non-null — the additional one-time-decision fence.

SQL migration predicates, Drizzle schema declarations, and conflict writers must be semantically identical.

## Durable worker-protocol barrier

Mixed-worker safety uses the existing pre-read package claim boundary, not the
later runtime-audit insert and not a process-local feature flag. Add a singleton
`forge_runtime_protocol_epochs` row for `name='work_package_execution'` with
`minimum_writer_protocol`, activation actor/time, and immutable activation audit.
It begins at protocol 1.

An expand-phase PostgreSQL trigger runs on every work-package status transition to
`running`, a boundary every current legacy worker already traverses before the
executor can read repository context. The trigger reads the transaction-local
`forge.worker_protocol` setting (`1` when absent for legacy binaries), takes a
shared lock on the epoch row, rejects a lower protocol, and writes the observed
version to `work_packages.claim_protocol_version`. One shared v2 package-claim
primitive locks project → task → every sibling package in ascending ID order,
recomputes dependency/candidate eligibility, proves no sibling is running or
leased, sets `SET LOCAL forge.worker_protocol='2'`, and only then attempts one
conditional `running` transition. This is required for packet-bearing execution,
packet-free execution, and handoff-only mode when
`FORGE_WORK_PACKAGE_EXECUTION=0`; no direct writer may update only its preselected
package. Only the packet-bearing branch continues to the issuance audit/nonce
work below.
The trigger therefore fences a restarted old binary before *any* executor work,
not merely before a late audit. It governs cooperative Forge execution and does
not confine an ACP process or revoke other host access.

Activation is a deployment-operator/database-maintenance action, not a user-facing
web route. It uses an explicit PostgreSQL `READ COMMITTED` transaction. Statement
one locks the epoch row exclusively and finishes any wait. Statement two then uses
a fresh command snapshot to query for every `running` package with null or
protocol-1 claim evidence. If any exists, activation aborts without advancing. If
none exists, statement three updates the epoch to 2 and records the immutable
activation audit before commit. A v1 transition that acquired the shared lock
first therefore commits and is visible to statement two, forcing activation to
abort. If activation acquired the exclusive lock first, a later v1 transition
waits, sees epoch 2, and fails. A single-statement check or a snapshot established
before the lock wait is forbidden. Activation does not lock entity rows or mutate
them, so it cannot reverse the entity order. The epoch is monotonic and never lowered.

Cutover still requires operational drain of pre-trigger processes before epoch-2
activation; no schema change can retroactively stop a binary that was already past
the package claim when the trigger was installed. After the expand trigger has been
deployed everywhere and the drain is proven, the durable activation fence prevents
an old binary from reconnecting. Tests cover a genuine pre-trigger worker that must
be externally drained and both bridge-trigger lock orderings: v1-shared-first
forces activation to abort, while activation-exclusive-first rejects the v1
package transition with zero repository reads.

## Lock order and claim transaction

The complete global order is:

```text
project
  → task(s ascending)
  → work package(s ascending)
  → grant approval/decision row(s ascending)
  → worker-protocol epoch
  → agent run
  → runtime audit claim
  → packet metadata artifact
  → review-gate row(s ascending)
```

Live health checks and other network/system probes happen before the transaction and are not persistence inputs. Every current `ready → running` writer must call the shared protocol-v2 package-claim primitive. In every mode it locks project → task → all sibling packages ascending, recomputes candidate/dependency state under lock, proves no sibling has `running` status or a live execution lease, and claims exactly one eligible package. This includes packet-free and handoff-only paths even when there is no MCP project snapshot. For a packet-bearing package, extend that same package/run claim transaction rather than creating an independent claim lifecycle:

1. Lock project, task, and every sibling package row in global order; recompute
   eligibility and select the one candidate under those locks.
2. Lock the applicable approval/decision row after the package.
3. Re-read current package requirements and canonical admission. Verify exact required coverage and decision revision. For `allow_once`, also verify the approval ID + nonce is approved and unconsumed.
4. The shared primitive sets transaction-local worker protocol 2, then conditionally
   moves the package to `running`; the trigger locks/checks the epoch and records
   claim protocol 2.
5. Create the `agent_runs` row and existing execution lease.
6. Insert the per-run unique `claiming` audit with `claimToken`, `agentRunId`, a database-time lease, and the immutable authorization snapshot.
7. For `allow_once`, win the additional nonce-unique insert and mark that exact decision consumed using a compare-and-set.
8. Commit all package, run, execution-lease, issuance-claim, and consumption state together.

Only the winner proceeds. A failure at any statement rolls the whole claim transaction back: there is no running package, orphan run, issuance audit, consumed nonce, or attempt. Duplicate workers stop before repository packet reads. A run that does not need a packet creates neither an issuance audit nor a packet artifact.

## Packet-recovery admission guard

A validated `metadata.packet_issuance` or `metadata.packet_integrity_hold` marker
is an absolute S4-owned block before generic readiness calculation, admission
refresh, promotion, or package claim. `loadHandoffState`, direct
`progressWorkforce`, sibling-completion continuation, and periodic ready sweeps
must all call one S4 parser/guard before treating a `blocked` package as a
candidate. A known v2 marker with an invalid tuple also
fails closed and is never generically promoted. Current canonical grant coverage
does not clear this guard.

Only the versioned packet-recovery route or the S3→S4 one-time-reapproval resolver
may compare-and-set the exact marker away and move `blocked → ready`. Generic S2
broker retry, admission freshness, and `promotePackageWithFreshnessCas` must
preserve both the marker and blocked status. This prevents an always-allow package,
especially one with `submission_uncertain|submitted`, from rerunning without its
required operator acknowledgement/action.

## Fencing lifecycle

The packet lease is subordinate to the package execution lease. One heartbeat operation renews both under compare-and-set using PostgreSQL `now()`; heartbeat configuration has validated minimum/maximum values and an interval strictly below the lease duration. A worker must not renew either lease after ownership of either one is lost.

The worker verifies both ownership predicates immediately before each governed boundary:

```text
package.status=running
package.executionLease.runId=agentRunId
audit.status=claiming
audit.claimToken matches
audit.claimedByAgentRunId=agentRunId
audit.leaseExpiresAt > database now()
```

Boundaries:

- each repository-content read batch;
- packet exposure to prompt assembly;
- ACP prompt submission;
- atomic run/package/lease and packet-evidence finalization.

For project `always_allow`, each boundary also reruns canonical S1
`readEffectiveGrantState` under the S3 locks and requires
`source:'project-level'`, `grantMode:'always_allow'`, and `phase:'approved'`. The
locked matching project decision row must supply the expected revision and
coverage fingerprint that will be stored as snapshot
`source:'project_always_allow'`. That preserves denial-wins if a package-level denial
races the project grant. If revocation/narrowing/override committed before the
check, the worker starts no later governed read or exposure. This is cooperative
fencing: a grant change cannot recall bytes already read or cancel an external
operation that began after the previous check.

An invalid execution lease, token, expired lease, or superseded project decision prevents subsequent governed reads and persistence, but cannot revoke data already in memory.

Immediately before the first ACP transport call, the owner CAS-persists
`delivery.state:'submitting'` with a random `submissionAttemptId` and database-time
`intentAt`, under both lease predicates. Only then may it perform external I/O. A
definitive pre-acceptance transport rejection may become `submission_failed`; an
accepted response becomes `submitted`. A crash, timeout, or lease expiry from
`submitting` becomes `submission_uncertain`, because PostgreSQL cannot prove what
the transport accepted. `submitting|submission_uncertain|submitted` is never
automatically resubmitted. A failure before the intent CAS is still
`not_exposed` and may follow the package's explicit retry policy without claiming
that an external request started.

One committed packet claim permits at most one external model/ACP submission.
Packet-bearing execution sets the AI SDK `generateText` option `maxRetries:0`,
requires every adapter/provider transport beneath it to disable replay after a
request may have been accepted, and bypasses the executor's current
`MAX_GENERATION_ATTEMPTS` response-validation loop after the first transport call.
If the provider accepted a response that Forge later rejects as malformed or
invalid, delivery remains `submitted`, the run terminalizes as failed, and the
operator follows the same possible-prior-work recovery path; Forge does not submit
a correction prompt on that claim. Packet-free generation may retain its existing
validation retries because it discloses no bounded packet and carries no packet
submission claim.

## Packet metadata staging

Immediately after assembly and before prompt buffering, logging, rendering, ACP request construction, or any other exposure, persist under both valid ownership predicates one immutable assembly snapshot. Assembly state and delivery outcome are separate so a later submission failure cannot rewrite known assembly evidence:

```ts
type PacketFailureCode =
  | 'authorization_changed'
  | 'execution_lease_expired'
  | 'issuance_lease_expired'
  | 'worker_stopped'
  | 'preflight_failed'
  | 'assembly_failed'
  | 'submission_rejected'
  | 'submission_uncertain'
  | 'provider_response_invalid'
  | 'post_submission_execution_failed';

type PostSubmissionFailureStage =
  | 'sandbox_apply'
  | 'validation'
  | 'host_apply'
  | 'repository_evidence'
  | 'completion_materialization';

type PacketAssemblySnapshot =
  | {
      state: 'assembled';
      rootRef: string;
      includedCount: number;
      byteCount: number;
      omittedCount: number;
      redactionSummary: Record<string, number>;
    }
  | {
      state: 'not_assembled';
      failureStage: 'claim' | 'preflight' | 'assembly';
    };

type PacketDeliveryOutcome =
  | { state: 'not_exposed' }
  | {
      state: 'submitting';
      submissionAttemptId: string;
      intentAt: string;
    }
  | {
      state: 'submission_failed';
    }
  | { state: 'submitted'; submittedAt: string }
  | { state: 'submission_uncertain' };

type TerminalPacketDeliveryOutcome = Exclude<
  PacketDeliveryOutcome,
  { state: 'submitting' }
>;

type PacketTerminalOutcome =
  | { status: 'succeeded' }
  | {
      status: 'failed';
      failureCode: Exclude<
        PacketFailureCode,
        'post_submission_execution_failed'
      >;
    }
  | {
      status: 'failed';
      failureCode: 'post_submission_execution_failed';
      failureStage: PostSubmissionFailureStage;
    };

type PacketIssuanceRecoveryCommon = {
  schemaVersion: 2;
  kind: 'packet_issuance';
  priorAgentRunId: string;
  priorRuntimeAuditId: string;
  recoveryFailure: Extract<PacketTerminalOutcome, { status: 'failed' }>;
  autoRetryable: false;
  markerFingerprint: string;
  policyFingerprint: string;
  coverageFingerprint: string;
};

type PacketIssuanceRecoveryState =
  | {
      grantMode: 'allow_once';
      deliveryState: 'not_exposed' | 'submission_failed';
      disposition: 'reapprove_allow_once';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'allow_once';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'review_then_reapprove_allow_once';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'allow_once';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'reapprove_allow_once';
      acknowledgedAt: string;
      acknowledgedByUserId: string;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'not_exposed' | 'submission_failed';
      disposition: 'retry_execution';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'review_submission';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'reviewed_submission';
      acknowledgedAt: string;
      acknowledgedByUserId: string;
    };

type PacketIssuanceRecoveryMarkerV2 =
  PacketIssuanceRecoveryCommon & PacketIssuanceRecoveryState;

type PacketIntegrityHoldV2 = {
  schemaVersion: 2;
  kind: 'packet_integrity_hold';
  priorAgentRunId: string;
  priorRuntimeAuditId: string;
  reason:
    | 'audit_artifact_mismatch'
    | 'terminal_success_materialization_incomplete';
  autoRetryable: false;
  markerFingerprint: string;
};
```

The terminal tuple is normative. `succeeded` permits only `assembled + submitted`
and creates no recovery marker. A failed tuple permits only:

| Assembly | Delivery | Allowed failure code |
|---|---|---|
| `not_assembled/claim` | `not_exposed` | `authorization_changed`, `execution_lease_expired`, `issuance_lease_expired` |
| `not_assembled/preflight` | `not_exposed` | prior row plus `worker_stopped`, `preflight_failed` |
| `not_assembled/assembly` | `not_exposed` | authorization/lease codes plus `worker_stopped`, `assembly_failed` |
| `assembled` | `not_exposed` | authorization/lease codes or `worker_stopped` |
| `assembled` | `submission_failed` | `submission_rejected` |
| `assembled` | `submission_uncertain` | authorization/lease codes, `worker_stopped`, or `submission_uncertain` |
| `assembled` | `submitted` | authorization/lease codes, `worker_stopped`, `provider_response_invalid`, or `post_submission_execution_failed` with exactly one closed `failureStage` |

The first bounded failure successfully persisted by the live owner is primary.
`submission_failed` is atomically staged with `submission_rejected`; recovery
preserves that definitive pair even when a lease later expires. Otherwise, if
stale recovery must derive a cause, it uses the deterministic order
`authorization_changed → execution_lease_expired → issuance_lease_expired →
delivery-specific cause → worker_stopped`. An atomic terminalizer rollback leaves
no durable fact that distinguishes “never started” from “started then rolled
back”, so there is deliberately no `terminalization_interrupted` code; recovery
uses the last durable phase and ownership predicates. SQL checks, Drizzle parsing,
API readers, S5, and S6 accept exactly these tuples. Every known-invalid
cross-product fails closed as legacy/unknown evidence.

`post_submission_execution_failed` means Forge accepted a valid provider response
and then failed at one bounded local stage: sandbox apply, validation, host apply,
repository-evidence persistence, or completion/review-gate materialization. It is
valid only with `assembled + submitted` and requires exactly one
`PostSubmissionFailureStage`; every other failure code forbids `failureStage`.
Delivery remains `submitted`, so recovery follows the possible-prior-work path and
never automatically resubmits. A `host_apply` failure may have changed some files
before it stopped. The packet audit records only the closed stage; existing
repository/host-apply evidence remains the separate source for changed files.
Operator acknowledgement covers both the prior external submission and possible
partial local changes. The operator must inspect and resolve the working tree
before choosing a new run; Forge never claims rollback.

`rootRef` is an opaque, project-scoped random identifier and is never derived from, reversible to, or displayed as an absolute/relative filesystem path. Counts are non-negative bounded integers. Redaction summaries use a closed set of category keys and bounded counts. Packet-owned failure evidence is enum-only: it never accepts raw exception text and has no “sanitized detail” field. No selected names, paths, excerpts, free-text repository errors, or file contents enter the audit, artifact, task log, debug log, event, queue payload, or API response.

`rootRef` is stored in a dedicated project UUID column with database default
`gen_random_uuid()`. The database default is authoritative at creation and protects
old project writers that omit the new column during the mixed-version window. The
project service reads that value; preview, approval snapshots, packet claims, and
run artifacts use the same value. It is never a hash, encryption, encoding, or
other derivative of `localPath`. It stays stable for the lifetime of the project,
including across path edits. Rotation is out of scope because it would invalidate
approved-but-unclaimed snapshots; any future rotation needs its own privileged,
audited invalidation/reapproval design. Two projects never share a generated
reference, even when they point to the same host path.

The packet keeps the existing assembly ceilings: `50` included files, `160 KiB` total included bytes, `24 KiB` per file, traversal depth `6`, `500` directory entries, and `5,000` total traversed entries. `rootRef` is at most `80` ASCII characters. Redaction summary has at most `32` known keys and each count is `0..5,000`. Artifact human-readable content is at most `16 KiB` and is derived only from typed fields and static copy. Values outside these bounds fail closed rather than being persisted.

## Stale claim reconciliation

`reconcileStaleFilesystemIssuanceClaims()` runs at startup and periodic recovery. Candidate discovery selects expired audit IDs without holding audit-row locks. For each candidate, a fresh transaction:

1. locks project → task → every sibling package in ascending ID
   order → approval decision → worker-protocol epoch → agent run → runtime audit
   in global order;
2. compare-and-sets only a still-`claiming` row whose lease is expired according to PostgreSQL `now()`;
3. invalidates the token by the terminal status transition;
4. fails the linked running agent run, clears only that run's `executionLease`, and moves the package to a structured issuance-recovery block;
5. compare-and-sets task `running → approved` only when no other sibling retains
   a live execution lease; otherwise the task remains `running` and the marker is
   visible but has no action until the S4 task-state reconciler below makes it
   `approved`;
6. atomically writes the terminal audit state and unique packet artifact from the durable snapshot.

The reconciler never locks an audit/approval row and then reaches backward for package, task, or project state. Competing reconcilers may discover the same ID; the top-down lock plus terminal compare-and-set chooses one winner.

The existing `recoverStaleRunningPackage` path must not mutate a protocol-v2
packet-bearing package first. After unlocked discovery, it checks for a linked v2
issuance claim. If a nonterminal claim exists, it delegates the candidate ID to
this S4 top-down transaction. A compare-and-set miss is “already handled” only
after rereading under the same locks and proving the package/run are no longer
running and the execution lease is cleared. A terminal packet audit/artifact with
a still-running linked run/package is an invariant-repair branch. It first proves
byte-for-byte-equivalent typed terminal tuples in the audit and artifact; mismatch
enters a neutral, non-retryable integrity hold and alerts operators without
changing packet evidence or exposing a retry action. For terminal failure, repair
fails the run, clears only its lease, blocks the package, and copies the exact
immutable failure object and delivery into the marker; it never derives a
worker/lease replacement cause. For terminal success, repair creates no failure
marker. It may reconstruct the normal success-side run/package/review-gate
transition only when the matching completion artifact, repository evidence
required by the configured host-write mode, and review-gate materialization
already exist for that run. Otherwise it enters the neutral integrity hold for
privileged manual repair. It never resubmits, creates a second artifact, rewrites
terminal evidence, or converts success into retryable failure. Only a run with no
packet claim may use the legacy generic recovery path. Both execution-lease-first
and issuance-lease-first expiry therefore converge on one S4 marker, one failed
run/audit, and one artifact using PostgreSQL time. The legacy path never clears a
v2 execution lease, writes `staleRunningRecovery`, or publishes terminal events for
a packet-bearing run outside the S4 commit.

The neutral integrity branch atomically fails only the live run with bounded
reason `packet_integrity_hold`, clears its lease, blocks the package with the typed
`PacketIntegrityHoldV2`, and applies the sibling-aware task disposition. It does
not state that packet issuance failed, does not create an issuance-recovery action,
and exposes no web recovery CTA. Resolution is a separately authorized privileged
data-repair procedure outside these slices. The generic S4 admission guard treats
both `packet_issuance` and `packet_integrity_hold` as absolute blocks.

`reconcilePacketRecoveryTaskDisposition(taskId)` owns the sibling-convergence seam.
It runs in a new top-down transaction after any sibling releases/terminalizes its
execution lease, and at startup/periodic recovery. It locks project → task → all
sibling packages ascending, validates at least one S4 packet marker, and changes
task `running → approved` only when no sibling retains a live execution lease. It
never clears/promotes the packet marker or wakes execution. This transaction must
not be called while a caller retains a package lock; post-commit invocation and the
periodic fallback preserve the global order. After commit S5 may expose the
marker-specific action.

The package marker is versioned `packet_issuance` metadata and contains only
claim/authorization fingerprints, bounded failure code, delivery state, and a
typed recovery disposition. Every issuance-recovery marker has
`autoRetryable:false`; no packet failure is inferred into the S2 broker retry
policy. A marker is not a standalone terminal record: every reader/action joins
its exact prior audit and packet artifact, proves their typed terminal tuples are
equal, binds the marker fingerprint/identity to that failed tuple, and validates
assembly + delivery + terminal status + failure code/stage together. Missing,
mismatched, or terminal-success-plus-failure-marker evidence is a neutral,
non-retryable integrity hold with no action. This matrix is normative:

| Grant mode | Delivery at recovery | Disposition | Direct action |
|---|---|---|---|
| `allow_once` | `not_exposed|submission_failed` | `reapprove_allow_once` | fresh explicit grant/nonce through #178 |
| `allow_once` | `submission_uncertain|submitted` | `review_then_reapprove_allow_once` | acknowledge possible prior work, then fresh explicit grant/nonce |
| `always_allow` | `not_exposed|submission_failed` | `retry_execution` | explicit retry under the same decision or a newer project decision that exactly covers the unchanged package policy |
| `always_allow` | `submission_uncertain|submitted` | `review_submission` | acknowledge possible prior work before an explicit new run |

A live `submitting` claim is not yet an operator-recovery marker; stale recovery
converts it to `submission_uncertain`. The marker never reuses `mcpGrantBlock` or
`mcpBroker` and carries no human reason or path. An `allow_once` nonce remains
burned and is never reopened. An `always_allow` claim burns only that run claim;
a new run may proceed only if the canonical effective state remains approved from
the matching project-level always-allow decision. Recovery never rereads or
reassembles a prior packet.

Acknowledgement never changes immutable `deliveryState`. It sets database-time
`acknowledgedAt`/actor and changes only the disposition:
`review_then_reapprove_allow_once → reapprove_allow_once` or
`review_submission → reviewed_submission`. That compare-and-set rotates the marker
fingerprint to the digest of the newly acknowledged state; the action ledger keeps
the prior request fingerprint for exact replay, while the next CTA carries the new
fingerprint. A marker with acknowledged fields and any other disposition is
invalid and fails closed.

S4 owns the mutation behind these actions, suggested route:

```text
POST /api/tasks/{taskId}/work-packages/{packageId}/packet-issuance-recovery
{
  schemaVersion: 2,
  action: retry_execution | acknowledge_possible_submission,
  priorRuntimeAuditId,
  markerFingerprint
}
```

The route authorizes the operator, then locks project → task → package → current
grant decision → prior agent run → prior runtime audit. Every action requires task
`approved`, package `blocked`, a request whose task/package route owns the exact
prior audit, the exact marker/prior-audit/delivery identity, and no active lease.
It checks the append-only ledger by the complete versioned request identity before
requiring the marker to remain present, so an exact replay still returns the
recorded result after successful marker clearing. Acknowledgement deliberately
does **not** require current grant
coverage: the operator must be able to acknowledge an old ambiguous submission
after the grant was revoked. It changes `allow_once` to
`reapprove_allow_once` and `always_allow` disposition to `reviewed_submission`,
while keeping the package blocked.

`retry_execution` accepts `always_allow` only from delivery
`not_exposed|submission_failed` with disposition `retry_execution`, or delivery
`submission_uncertain|submitted` with disposition `reviewed_submission`. It then
accepts exactly one of two locked authorization states:

1. the canonical S1 `readEffectiveGrantState` result has `phase:'approved'`,
   `source:'project-level'`, and `grantMode:'always_allow'`, while the locked
   matching project decision revision and coverage fingerprint equal the prior
   authorization snapshot; or
2. that same canonical tuple is approved, the locked matching project decision
   revision is greater, the package policy fingerprint and exact required
   capability set are unchanged, and that decision covers the complete required
   set.

The canonical reader applies the S3 denial-wins rule, so an equal/newer package
denial, unknown legacy state, or a project row hidden by a package override cannot
be mistaken for authorization even when the project decision alone looks broad
enough.

The second state is explicit reauthorization after grant removal, narrowing, or
replacement; it is not automatic retry. The recovery-action row records both the
prior and authorizing current decision revisions and coverage fingerprints. The
old artifact/authorization snapshot remains immutable, and the normal new claim
snapshots the new decision. A missing, older, unknown, non-covering, or
policy-changed decision returns `409` without mutation. A stale marker or
mismatched prior audit also returns `409` without mutation.

Every successful acknowledgement, retry, or one-time-reapproval resolution writes one append-only
`filesystem_mcp_issuance_recovery_actions` row containing actor, action, prior
audit/run IDs, marker fingerprint, immutable delivery state, nullable authorizing
current decision revision/coverage fingerprint, resulting package status and
disposition, and database time; a unique
`(runtime_audit_id, action, marker_fingerprint)` key makes double-clicks
idempotent. For an allowed always-allow retry, the same transaction inserts that
evidence, clears only the matched packet marker, and moves package
`blocked → ready`; it never creates the new run directly. Redis wake-up is after
commit, and the normal claim path rechecks and snapshots current policy.

An exact replay of an already-committed version-2 request
`(runtimeAuditId, action, markerFingerprint)` bound to the same task/package returns
the recorded successful result with HTTP `200`; it
does not mutate or wake again. Two identical concurrent requests select one ledger
winner, and the loser rereads that row and returns the same result. A request whose
marker fingerprint or durable state differs and has no matching successful ledger
row is stale and returns `409`. This makes idempotency and stale-state rejection
separate, deterministic cases.

Fresh one-time reapproval has one explicit cross-slice integration point. After
#178 rotates the nonce under project → task → package → approval locks, it calls
an S4-owned package-scoped resolver in the same transaction. The resolver
continues to prior agent run → runtime audit, verifies the terminal prior claim,
the exact `reapprove_allow_once` marker/fingerprint, changed fresh nonce, and
current policy, then clears only the packet marker and moves `blocked → ready`.
It also inserts `resolve_after_allow_once_reapproval` evidence referencing the new
approval decision; marker clearing and that evidence are atomic.
It never clears an S3 filesystem-grant marker or scans siblings. A stale marker,
second reapproval, changed policy, or active lease is a compare-and-set miss.
Redis wakes the task only after the combined transaction commits.

## Artifact contract

Exactly one artifact per run that acquired a packet claim; runs needing no packet have zero packet artifacts:

```text
artifactType = mcp_bounded_context_packet_metadata
lookup = (agentRunId, artifactType)
```

Add a partial unique index in SQL and `schema.ts`, and use a conflict target with the matching predicate.

Artifact metadata:

```ts
{
  schemaVersion: 2;
  workPackageId: string;
  authorization: PacketAuthorizationSnapshot;
  assembly: PacketAssemblySnapshot;
  delivery: TerminalPacketDeliveryOutcome;
  terminal: PacketTerminalOutcome;
}
```

Artifact content is a bounded human-readable summary derived only from these persisted typed snapshots. A live finalizer extends the existing run/package terminal transaction: after external work completes—or after a bounded external-work stage fails—it locks top-down, verifies both ownership predicates, terminalizes the agent run and package/review-gate transition, clears the execution lease, writes any recovery marker and task disposition for failure, transitions the audit to terminal, and upserts the artifact in one transaction. Sandbox writes, validation commands, host writes, repository-evidence collection, and review-gate preparation happen before this transaction and each maps to the closed post-submission stage above. The transaction contains no network, Redis, filesystem, provider, or rendering work. Thus a protocol-v2 writer cannot commit terminal packet evidence while leaving its linked run/package `running`. The partial unique index makes repeated or competing live/recovery finalizers idempotent; it does not replace this crash-consistency transaction. Recovery never rereads or reassembles a burned packet. The invariant-repair branch above handles legacy/manual partial state without rewriting already-terminal evidence.

## Review-gate concurrency boundary

Review-gate materialization and decisions participate in the same global order.
The finalizer and every gate-decision transaction lock project → task → package →
applicable run/audit/artifact → all relevant gate rows in stable ID order; no path
may lock a gate and then reach backward to the package. Before changing a gate or
package, the decision transaction rereads the source run, exact artifact identity,
package status, and execution-lease state under those locks. It compare-and-sets
the package/gate against those identities. A stale source run/artifact, a new live
lease, or a changed package status is a no-mutation stale decision, never approval
of newer work. Finalizer-versus-gate-decision PostgreSQL races exercise both lock
orderings and prove one coherent winner without deadlock.

## Run lifecycle integration

- Create the `agentRunId`, execution lease, and packet claim atomically in the existing package claim transaction.
- A successful claim must precede packet assembly.
- If no packet is required, no filesystem issuance audit is created.
- After claim, every live terminal path atomically finalizes run, package/lease,
  audit, artifact, marker, and task disposition if ownership remains valid; stale
  recovery owns finalization after ownership expiry.
- Failure after an `allow_once` claim burns the nonce. Failure of an `always_allow` run does not manufacture or burn a decision nonce.
- A pre-assembly or pre-exposure failure returns the package to a structured blocked/recovery state. Persist `submitting` before ACP I/O; recovery maps an expired intent to `submission_uncertain`. Do not automatically redeliver an ambiguous external request.
- Sandbox-generated file artifacts remain separate from repository context metadata and host-apply evidence.

## Concurrency/failure tests

1. Two workers race one `allow_once` nonce: one run claim, one decision claim, one packet assembly.
2. Two workers race one `always_allow` package: one per-run claim and one packet assembly.
3. Claim transaction failure after each write rolls back package status, run, leases, audit, attempt, and nonce consumption.
4. Claim races reapproval and project revocation: global lock order prevents deadlock and decision revisions select the correct result.
5. Delayed owner races lease expiry/reconciler: loss of either execution or issuance ownership prevents a later governed read or finalization.
6. Execution lease expires first, issuance lease expires first, and a heartbeat races both recovery paths; one coordinated terminal state survives.
7. Crash before assembly: explicit `not_assembled` evidence with no fabricated zero counts.
8. Crash after assembly before exposure: persisted truthful assembled metadata.
9. Crash before submission, during submission, and after submission: delivery outcome remains distinct from assembly and ambiguous submission is not redelivered automatically.
10. Failure between run/package/lease, audit, marker, task, and artifact finalization
    is impossible for v2 writers because they share one transaction;
    rollback/retry and concurrent finalizers produce one terminal run state and one
    artifact.
11. Submission crash injection covers before intent CAS, after intent/before call,
    immediately after transport acceptance, and after response/before outcome
    persistence. Only the pre-intent case can remain `not_exposed`; every expired
    `submitting` case becomes `submission_uncertain` and is not auto-replayed.
12. Reapproval after a burned nonce rotates a fresh nonce; immutable evidence for the prior decision does not change.
13. Always-allow revocation before a later read/exposure stops that boundary; already-read bytes are not claimed to be recalled.
14. Legacy approvals/audits, mixed protocol workers, cutover, rollback, and root-path scrub follow the rollout contract below.
15. Prompt-injection fixtures remain quoted subordinate data; wire-level role
    separation is asserted only for adapters that actually preserve roles.
16. Role-preserving providers keep policy in the captured system-role wire input;
    the ACP fake instead proves the real flattened `session/prompt` wire carries
    bounded guidance plus quoted subordinate data and makes no role-separation or
    enforcement claim.
17. A packet-bearing provider response that transport accepts but Forge validation
    rejects produces exactly one external prompt call, terminal
    `{status:'failed', failureCode:'provider_response_invalid'}` plus `submitted`
    delivery evidence, and no automatic correction submission. Packet-free behavior
    retains its existing validation-retry contract.
18. Logs contain only digest/count metadata; absolute/relative paths, filenames,
    secrets, HTML, control characters, raw exceptions, and rejected text do not
    leak through any packet-owned persistence/diagnostic surface.
19. Deferred optional merge overlay text is absent; static ACP non-sandbox warning remains.
20. Pure filesystem write planning hint remains present without packet.
21. Existing-project backfill, old-writer inserts during cutover, path rename, and
    two projects sharing one host path preserve the documented lifetime-stable
    opaque `rootRef` identity, non-null value, and database uniqueness.
22. Every issuance failure persists `autoRetryable:false`; `always_allow`
    exposes `retry_execution` immediately only for
    `not_exposed|submission_failed`. Post-intent states initially expose
    `review_submission` with no retry; only the append-only acknowledgement may
    change disposition to `reviewed_submission`, after which the locked retry
    predicate may accept either the same decision or a newer decision that exactly
    covers unchanged package policy.
23. Packet-recovery actions race double-click, grant revocation, policy mutation,
    task/package transition, and a new lease. The append-only action row and
    marker compare-and-set select one result; Redis failure leaves committed
    `ready` truth for periodic re-drive. Post-intent `allow_once` requires
    acknowledgement and then a separate fresh #178 approval.
24. An exact action replay returns the recorded success with one ledger row and no
    second wake; a changed fingerprint/state returns `409`.
25. Normal stale-running recovery races both lease-expiry orderings and the S4
    reconciler; packet-bearing work yields only the S4 terminal transaction and no
    generic stale marker/event. Crash injection after terminal audit/artifact but
    before package/run cleanup proves the atomic writer has no such commit point;
    a seeded legacy/manual split state takes the idempotent repair branch without
    changing the artifact or resubmitting.
26. An always-allow claim is revoked and restored under a newer decision revision:
    uncovered state has no retry, restored exact coverage permits one explicit
    audited retry, the prior artifact stays unchanged, and the new run snapshots
    the new revision. An equal/newer package denial racing that restore still wins
    in the canonical reader. Older/unknown/narrower decisions and policy drift
    fail closed.
27. A stale claim with another live sibling package keeps the task `running`,
    exposes no recovery action, and becomes actionable only after the S4
    post-sibling/periodic task-state reconciler moves the task to `approved`.
28. The versioned recovery request is bound to its routed task/package, prior
    audit, and marker fingerprint. Exact post-clear replay is `200` with one ledger
    row and no wake; substituted route IDs or identity fields are `409`.
29. An ambiguous retryable provider failure exercises the real packet-bearing AI
    SDK and adapter stack with `maxRetries:0`; wire capture proves exactly one
    external request even when provider defaults would otherwise retry.
30. Every persisted terminal **failure** has exactly one `PacketFailureCode`;
    exhaustive valid and known-invalid assembly/delivery/terminal/code tuples prove
    the parser, SQL checks, API, and UI fail closed with no free-text copy.
31. Epoch tests cover a genuinely pre-trigger process that must be operationally
    drained and both bridge-trigger orderings under `READ COMMITTED`: v1 shared
    first commits and forces activation to abort; activation exclusive first
    rejects v1 with zero repository reads. Packet, packet-free, and handoff-only v2
    claims all succeed after epoch 2 and persist protocol 2.
32. Direct progress, sibling-completion continuation, and periodic readiness all
    encounter valid and malformed S4 markers. None calls generic promotion; only
    the exact S4 action/resolver clears the marker and makes the package ready.
33. Every valid grant-mode/delivery/disposition/acknowledgement marker tuple parses;
    every known-invalid cross-product is neutral and non-actionable. A successful
    acknowledgement rotates the marker fingerprint while an exact prior request
    still replays from the ledger.
34. A valid submitted response then fails independently at sandbox apply,
    validation, host apply after at least one successful file, repository-evidence
    persistence, and completion/review-gate materialization. Each case persists
    one exact `post_submission_execution_failed` stage, performs no second model
    submission, preserves separate host evidence, and requires acknowledgement of
    possible prior and partial local work.
35. Seeded terminal/live splits prove exact audit/artifact tuple equality. Failed
    splits copy the immutable failure object; a fully evidenced success split
    reconstructs only the matching success transition; mismatched or incomplete
    success enters a neutral integrity hold with no retry marker.
36. Pairwise packet, packet-free, and handoff-only claims race in both orderings.
    Every writer locks all siblings and recomputes eligibility, so one specialist
    owns a live lease. Stale recovery races both non-packet modes and never commits
    task `running → approved` beside a newly established sibling lease.
37. Atomic finalization races a stale review-gate decision in both orderings. The
    decision rereads source run/artifact, package status, and lease under top-down
    locks; it either wins coherently or makes no mutation.
38. Definitive `submission_failed + submission_rejected` persistence races a
    crash/lease expiry. Recovery preserves the staged cause rather than
    reclassifying it as lease expiry.

Real PostgreSQL owns transaction, lock, lease, migration, index, and failure-injection evidence. Lease tests compare against database time, not a fake worker clock. #181 composes a small cross-slice sentinel set from these tests instead of maintaining a second policy implementation.

## Additive migration, cutover, and rollback

The claimed uniqueness guarantee is valid only after legacy packet issuers are drained. Deployment order is therefore part of the architecture:

1. **Expand schema.** Add a nullable project `root_ref` UUID with
   `DEFAULT gen_random_uuid()` and a unique index,
   nullable protocol-v2 nonce/revision/claim/snapshot fields, the exact partial
   indexes, the append-only issuance-recovery action table/unique key, the protocol
   epoch singleton, package claim-protocol column, and rejecting package-transition
   trigger. New
   projects receive a random reference at creation. Backfill existing
   projects in bounded, restartable batches with database-generated random UUIDs.
   Keep the default through the whole mixed-version window so an old project writer
   cannot insert a new null after the backfill scan. Verify every project is
   populated, then make `root_ref` non-null before any v2
   preview/evidence producer is enabled. Do not rewrite legacy approvals with
   synthetic nonces. Do not reinterpret required legacy zero/default audit
   columns as a truthful packet snapshot.
2. **Deploy dual readers.** Readers understand v1 and v2. Legacy `allow_once` approvals without a nonce are non-issuable and require explicit reapproval. Legacy audit rows without a typed assembly snapshot render as `unknown_legacy`, never `not_assembled` or invented zero counts.
3. **Deploy v2 writers disabled.** New workers can write/read v2, while the durable
   epoch remains 1 and packet issuance stays disabled. Verify every package claim
   mode uses the shared protocol primitive and traverses the `running`-transition
   trigger before executor work.
4. **Drain legacy issuers.** Stop and drain every worker already past the new
   package trigger, including genuine pre-trigger processes. A process-local flag
   alone is not proof that another old worker is absent.
5. **Cut over.** Start only v2-capable workers, verify no v1 claim remains, then
   run the checked-in `web` maintenance command
   `npm run protocol:activate-work-package-v2 -- --actor <operator-id>`. Its
   default dry run reports every blocker; `--apply` verifies `READ COMMITTED`,
   executes the privileged three-statement activation, is idempotent, verifies
   epoch/postconditions, and retains the database activation audit. The
   layman-readable procedure is
   `docs/operators/work-package-protocol-v2-cutover.md`; ad hoc SQL is forbidden.
   Use that command to advance the durable epoch to 2 before enabling v2 grant writes and packet
   issuance. Shared-first v1 causes activation to abort; activation-first rejects
   stale v1 before repository reads.
6. **Scrub legacy paths.** After epoch-2 activation durably proves cutover, #179
   runs a separately gated, bounded, restartable post-drain operation/later-release
   migration—not an expansion migration already registered with the ordinary
   migrator—that makes the legacy audit `root` column nullable,
   clears every path-valued `filesystem_mcp_runtime_audits.root`, records only
   aggregate scrub counts in a migration audit, and prevents v2 writers from
   populating it. It never copies, hashes, or encodes the old path into `rootRef`.
   A later migration may drop the legacy column after the support window.
7. **Deploy readers downstream.** #180 evidence UI follows the v2 reader; #181 verifies the migration and mixed-version sentinels before release readiness.

Rollback leaves the additive schema, epoch, and v2 data in place and never lowers
the epoch. UI/readers may roll back to a compatible version, but a legacy packet
issuer must never be restarted once v2 decisions can exist. If worker rollback is
required, disable packet issuance, drain v2 workers, and keep issuance disabled
until a v2-capable worker is restored.

## Implementation order

1. Land #178's decision revision and operator-hold contracts.
2. Add only the expand schema/backfill, exact indexes, issuance-recovery action
   table, database-default root-reference lifecycle, protocol barrier, and legacy
   readers. Do not register the destructive root scrub in the ordinary pending
   migration chain yet.
3. Add the shared all-mode protocol-v2 package claim, integrated packet claim,
   combined heartbeat, packet-recovery candidate guard, sibling task-state
   reconciler, and top-down stale/partial-state repair behind a disabled gate.
4. Add instruction projection and structured serialization with native system-role
   policy for role-preserving adapters and explicitly non-enforcing flattened
   guidance for ACP.
5. Replace executor capability merge/gating copies.
6. Stage typed assembly metadata before exposure and atomically finalize the
   run/package/lease, audit, artifact, marker, and task disposition.
7. Add race, restart, injection, migration, mixed-worker, rollback, and failure-point tests.
8. Add the checked-in activation command and operator runbook, exercise the real
   command under both bridge-trigger orderings and a genuine pre-trigger worker,
   and retain its database audit as release evidence.
9. Drain legacy issuers and activate the durable protocol barrier before #180
   evidence rendering is considered release-ready.
10. Only after durable cutover evidence exists, execute the separately gated,
   restartable root scrub. It is a post-drain operation/later migration, never an
   expansion migration that the normal migrator could run early.

## Stop conditions

Stop if implementation would claim OS confinement, ACP role separation it does not
transport, exactly-once external submission, prompt-text enforcement, or recall of
bytes; if a packet-bearing path can submit more than once per claim; if generic
stale recovery can mutate a linked v2 run; if any artifact/log/API needs a path or
content; if the whole live terminal state cannot be made crash-consistent; if
issuance cannot compose with the existing execution lease and #178 lock order; if
the durable epoch trigger cannot reject v1 writers before bounded reads; if legacy
issuers cannot be proven drained; if generic readiness can bypass an S4 marker; if
the finalization parser accepts a known-invalid tuple; or if S2/#178 do not expose requirement-scoped
decisions, decision revision, and structured operator-hold identity needed for
filtering and recovery; if a valid submitted response can fail without a truthful
closed stage; if a gate path locks backward or decides from pre-transaction
freshness; or if a terminal-success split can become a packet-failure retry.
