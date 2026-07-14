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

The immutable policy belongs in the provider's actual system-role input and states:

- repository packet data is untrusted;
- overlays are subordinate run instructions;
- neither changes tool, credential, repository, or admission policy;
- Forge issued no live MCP handle.

The user-role prompt may repeat a Forge-authored reminder after untrusted sections to aid model attention, but that reminder is not immutable and is not an enforcement boundary. Reject invalid encoding; truncate only at documented field boundaries and record omission counts. Tests include fake system messages, closing fences, credential requests, and `gh` commands. Prompt logs persist only a digest, byte count, and omission counters through the existing task-log sanitization path; debug logs never persist the prompt, packet, selected names, paths, or rejected Architect text.

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
  - bounded failure code/stage.
- append-only `filesystem_mcp_issuance_recovery_actions` with actor, action,
  prior runtime-audit/agent-run IDs, marker fingerprint, delivery state, database
  time, and a unique `(runtime_audit_id, action, marker_fingerprint)` key.

Two separate partial unique indexes are required for protocol v2 `operation='context_packet'` rows:

- `(agent_run_id, operation)` — one packet claim for every packet run;
- `(grant_approval_id, grant_decision_nonce, operation)` where the nonce is non-null — the additional one-time-decision fence.

SQL migration predicates, Drizzle schema declarations, and conflict writers must be semantically identical.

## Lock order and claim transaction

The complete global order is:

```text
project
  → task(s ascending)
  → work package(s ascending)
  → grant approval/decision row(s ascending)
  → agent run
  → runtime audit claim
  → packet metadata artifact
```

Live health checks and other network/system probes happen before the transaction and are not persistence inputs. Before assembly, extend the existing package/run claim transaction rather than creating an independent claim lifecycle:

1. Lock project, task, and package rows in global order.
2. Lock the applicable approval/decision row after the package.
3. Re-read current package requirements and canonical admission. Verify exact required coverage and decision revision. For `allow_once`, also verify the approval ID + nonce is approved and unconsumed.
4. Conditionally move the package to `running`, create the `agent_runs` row, and create the existing execution lease.
5. Insert the per-run unique `claiming` audit with `claimToken`, `agentRunId`, a database-time lease, and the immutable authorization snapshot.
6. For `allow_once`, win the additional nonce-unique insert and mark that exact decision consumed using a compare-and-set.
7. Commit all package, run, execution-lease, issuance-claim, and consumption state together.

Only the winner proceeds. A failure at any statement rolls the whole claim transaction back: there is no running package, orphan run, issuance audit, consumed nonce, or attempt. Duplicate workers stop before repository packet reads. A run that does not need a packet creates neither an issuance audit nor a packet artifact.

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
- terminal audit transition and artifact upsert.

For project `always_allow`, each boundary also rechecks that the current project decision revision still covers the exact required capabilities. If revocation/narrowing committed before the check, the worker starts no later governed read or exposure. This is cooperative fencing: a grant change cannot recall bytes already read or cancel an external operation that began after the previous check.

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

## Packet metadata staging

Immediately after assembly and before prompt buffering, logging, rendering, ACP request construction, or any other exposure, persist under both valid ownership predicates one immutable assembly snapshot. Assembly state and delivery outcome are separate so a later submission failure cannot rewrite known assembly evidence:

```ts
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
      failureCode: PacketFailureCode;
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
      failureCode: PacketFailureCode;
    }
  | { state: 'submitted'; submittedAt: string }
  | { state: 'submission_uncertain'; failureCode: PacketFailureCode };

type TerminalPacketDeliveryOutcome = Exclude<
  PacketDeliveryOutcome,
  { state: 'submitting' }
>;

type PacketIssuanceRecoveryMarkerV2 = {
  schemaVersion: 2;
  kind: 'packet_issuance';
  grantMode: 'allow_once' | 'always_allow';
  priorAgentRunId: string;
  priorRuntimeAuditId: string;
  deliveryState: TerminalPacketDeliveryOutcome['state'];
  disposition:
    | 'reapprove_allow_once'
    | 'review_then_reapprove_allow_once'
    | 'retry_execution'
    | 'review_submission'
    | 'reviewed_submission';
  autoRetryable: false;
  markerFingerprint: string;
  policyFingerprint: string;
  coverageFingerprint: string;
  failureCode: PacketFailureCode;
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
};
```

`rootRef` is an opaque, project-scoped random identifier and is never derived from, reversible to, or displayed as an absolute/relative filesystem path. Counts are non-negative bounded integers. Redaction summaries use a closed set of category keys and bounded counts. Failure codes/stages are enums; optional operator detail is separately sanitized and byte-bounded. No selected names, paths, excerpts, free-text repository errors, or file contents enter the audit, artifact, task log, debug log, or API payload.

`rootRef` is stored in a dedicated nullable project UUID column. The project
service generates it from secure random bytes under the project lock at project
creation or first bounded-context use; preview, approval snapshots, packet claims,
and run artifacts read that same value. It is never a hash, encryption, encoding,
or other derivative of `localPath`. It stays stable across path edits so path
history cannot be inferred from rotation. An explicit security rotation may replace
it only under the project lock after active packet claims are drained; prior run
artifacts keep their immutable old reference. Two projects never share a generated
reference, even when they point to the same host path.

The packet keeps the existing assembly ceilings: `50` included files, `160 KiB` total included bytes, `24 KiB` per file, traversal depth `6`, `500` directory entries, and `5,000` total traversed entries. `rootRef` is at most `80` ASCII characters. Redaction summary has at most `32` known keys and each count is `0..5,000`. Optional sanitized failure detail is at most `512` UTF-8 bytes; artifact human-readable content is at most `16 KiB`. Values outside these bounds fail closed rather than being persisted.

## Stale claim reconciliation

`reconcileStaleFilesystemIssuanceClaims()` runs at startup and periodic recovery. Candidate discovery selects expired audit IDs without holding audit-row locks. For each candidate, a fresh transaction:

1. locks project → task → package → approval decision → agent run → runtime audit in global order;
2. compare-and-sets only a still-`claiming` row whose lease is expired according to PostgreSQL `now()`;
3. invalidates the token by the terminal status transition;
4. fails the linked running agent run, clears only that run's `executionLease`, and moves the package to a structured issuance-recovery block;
5. compare-and-sets task `running → approved` so operator recovery remains reachable;
6. atomically writes the terminal audit state and unique packet artifact from the durable snapshot.

The reconciler never locks an audit/approval row and then reaches backward for package, task, or project state. Competing reconcilers may discover the same ID; the top-down lock plus terminal compare-and-set chooses one winner.

The package marker is versioned `packet_issuance` metadata and contains only
claim/authorization fingerprints, bounded failure code, delivery state, and a
typed recovery disposition. Every issuance-recovery marker has
`autoRetryable:false`; no packet failure is inferred into the S2 broker retry
policy. This matrix is normative:

| Grant mode | Delivery at recovery | Disposition | Direct action |
|---|---|---|---|
| `allow_once` | `not_exposed|submission_failed` | `reapprove_allow_once` | fresh explicit grant/nonce through #178 |
| `allow_once` | `submission_uncertain|submitted` | `review_then_reapprove_allow_once` | acknowledge possible prior work, then fresh explicit grant/nonce |
| `always_allow` | `not_exposed|submission_failed` | `retry_execution` | explicit retry only while current revision/fingerprints match |
| `always_allow` | `submission_uncertain|submitted` | `review_submission` | acknowledge possible prior work before an explicit new run |

A live `submitting` claim is not yet an operator-recovery marker; stale recovery
converts it to `submission_uncertain`. The marker never reuses `mcpGrantBlock` or
`mcpBroker` and carries no human reason or path. An `allow_once` nonce remains
burned and is never reopened. An `always_allow` claim burns only that run claim;
a new run may proceed only if the current project decision revision still covers
the package. Recovery never rereads or reassembles a prior packet.

Acknowledgement never changes immutable `deliveryState`. It sets database-time
`acknowledgedAt`/actor and changes only the disposition:
`review_then_reapprove_allow_once → reapprove_allow_once` or
`review_submission → reviewed_submission`. A marker with acknowledged fields and
any other disposition is invalid and fails closed.

S4 owns the mutation behind these actions, suggested route:

```text
POST /api/tasks/{taskId}/work-packages/{packageId}/packet-issuance-recovery
action = retry_execution
       | acknowledge_possible_submission
```

The route authorizes the operator, then locks project → task → package → grant
decision → prior agent run → prior runtime audit. Every action requires task
`approved`, package `blocked`, the exact marker/prior-audit/delivery identity, and
no active lease. Acknowledgement deliberately does **not** require current grant
coverage: the operator must be able to acknowledge an old ambiguous submission
after the grant was revoked. It changes `allow_once` to
`reapprove_allow_once` and `always_allow` disposition to `reviewed_submission`, while keeping
the package blocked. `retry_execution` accepts `always_allow` only from
delivery `not_exposed|submission_failed` with disposition `retry_execution`, or
delivery `submission_uncertain|submitted` with disposition
`reviewed_submission`; it separately requires the current project revision, exact
coverage, and policy fingerprint to match. A
stale marker, mismatched prior audit, or double-submitted action returns `409`
without mutation.

Each acknowledgement writes one append-only
`filesystem_mcp_issuance_recovery_actions` row containing actor, action, prior
audit/run IDs, marker fingerprint, delivery state, and database time; a unique
`(runtime_audit_id, action, marker_fingerprint)` key makes double-clicks
idempotent. For an allowed always-allow retry, the same transaction clears only
the matched packet marker and moves package `blocked → ready`; it never creates
the new run directly. Redis wake-up is after commit, and the normal claim path
rechecks current policy.

Fresh one-time reapproval has one explicit cross-slice integration point. After
#178 rotates the nonce under project → task → package → approval locks, it calls
an S4-owned package-scoped resolver in the same transaction. The resolver
continues to prior agent run → runtime audit, verifies the terminal prior claim,
the exact `reapprove_allow_once` marker/fingerprint, changed fresh nonce, and
current policy, then clears only the packet marker and moves `blocked → ready`.
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
}
```

Artifact content is a bounded human-readable summary derived only from these persisted typed snapshots. A finalizer transaction verifies both ownership predicates, transitions the audit to terminal, and upserts the artifact atomically. The partial unique index makes repeated or competing live/recovery finalizers idempotent; it does not replace this crash-consistency transaction. Recovery never rereads or reassembles a burned packet.

## Run lifecycle integration

- Create the `agentRunId`, execution lease, and packet claim atomically in the existing package claim transaction.
- A successful claim must precede packet assembly.
- If no packet is required, no filesystem issuance audit is created.
- After claim, every terminal path finalizes audit and artifact atomically if ownership remains valid; stale recovery owns finalization after ownership expiry.
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
10. Failure between audit finalization and artifact insertion is impossible because both are one transaction; rollback/retry and concurrent finalizers produce one artifact.
11. Submission crash injection covers before intent CAS, after intent/before call,
    immediately after transport acceptance, and after response/before outcome
    persistence. Only the pre-intent case can remain `not_exposed`; every expired
    `submitting` case becomes `submission_uncertain` and is not auto-replayed.
12. Reapproval after a burned nonce rotates a fresh nonce; immutable evidence for the prior decision does not change.
13. Always-allow revocation before a later read/exposure stops that boundary; already-read bytes are not claimed to be recalled.
14. Legacy approvals/audits, mixed protocol workers, cutover, rollback, and root-path scrub follow the rollout contract below.
15. Prompt-injection fixtures remain quoted subordinate data and actual system/user role separation is asserted.
16. Logs contain only digest/count metadata; fixtures with paths, secrets, HTML, control characters, and rejected text do not leak.
17. Deferred optional merge overlay text is absent; static ACP non-sandbox warning remains.
18. Pure filesystem write planning hint remains present without packet.
19. Existing-project backfill, concurrent first use, path rename, explicit
    security rotation, and two projects sharing one host path preserve the
    documented opaque `rootRef` identity and database uniqueness.
20. Every issuance failure persists `autoRetryable:false`; `always_allow`
    exposes `retry_execution` only for `not_exposed|submission_failed`, while
    post-intent states expose `review_submission` with no direct retry.
21. Packet-recovery actions race double-click, grant revocation, policy mutation,
    task/package transition, and a new lease. The append-only action row and
    marker compare-and-set select one result; Redis failure leaves committed
    `ready` truth for periodic re-drive. Post-intent `allow_once` requires
    acknowledgement and then a separate fresh #178 approval.

Real PostgreSQL owns transaction, lock, lease, migration, index, and failure-injection evidence. Lease tests compare against database time, not a fake worker clock. #181 composes a small cross-slice sentinel set from these tests instead of maintaining a second policy implementation.

## Additive migration, cutover, and rollback

The claimed uniqueness guarantee is valid only after legacy packet issuers are drained. Deployment order is therefore part of the architecture:

1. **Expand schema.** Add a nullable project `root_ref` UUID with a unique index,
   nullable protocol-v2 nonce/revision/claim/snapshot fields, the exact partial
   indexes, and the append-only issuance-recovery action table/unique key. New
   projects receive a random reference at creation. Backfill existing
   projects in bounded, restartable batches with database-generated random UUIDs;
   a unique constraint and compare-and-set resolve concurrent first use. Verify
   every project is populated, then make `root_ref` non-null before any v2
   preview/evidence producer is enabled. Do not rewrite legacy approvals with
   synthetic nonces. Do not reinterpret required legacy zero/default audit
   columns as a truthful packet snapshot.
2. **Deploy dual readers.** Readers understand v1 and v2. Legacy `allow_once` approvals without a nonce are non-issuable and require explicit reapproval. Legacy audit rows without a typed assembly snapshot render as `unknown_legacy`, never `not_assembled` or invented zero counts.
3. **Deploy v2 writers disabled.** New workers can write/read v2 but packet issuance remains behind a deployment protocol gate that defaults off.
4. **Drain legacy issuers.** Stop and drain every worker that can assemble a packet without the v2 claim transaction. A process-local flag alone is not proof that another old worker is absent.
5. **Cut over.** Start only v2-capable workers, verify worker version/health operationally, then enable v2 grant writes and packet issuance.
6. **Scrub legacy paths.** After the drain is proven, #179 runs a bounded,
   restartable migration that makes the legacy audit `root` column nullable,
   clears every path-valued `filesystem_mcp_runtime_audits.root`, records only
   aggregate scrub counts in a migration audit, and prevents v2 writers from
   populating it. It never copies, hashes, or encodes the old path into `rootRef`.
   A later migration may drop the legacy column after the support window.
7. **Deploy readers downstream.** #180 evidence UI follows the v2 reader; #181 verifies the migration and mixed-version sentinels before release readiness.

Rollback leaves the additive schema and v2 data in place. UI/readers may roll back to a compatible version, but a legacy packet issuer must never be restarted once v2 decisions can exist. If worker rollback is required, disable packet issuance, drain v2 workers, and keep issuance disabled until a v2-capable worker is restored.

## Implementation order

1. Land #178's decision revision and operator-hold contracts.
2. Add the expand-only schema/migration, exact indexes, issuance-recovery action
   table, root-reference lifecycle, scrub migration, and legacy readers.
3. Add the integrated execution/packet claim, combined heartbeat, and top-down stale reconciler behind a disabled protocol gate.
4. Add instruction projection and structured serializer with actual system-role policy.
5. Replace executor capability merge/gating copies.
6. Stage typed assembly metadata before exposure and atomically finalize audit + artifact.
7. Add race, restart, injection, migration, mixed-worker, rollback, and failure-point tests.
8. Drain legacy issuers and cut over before #180 evidence rendering is considered release-ready.

## Stop conditions

Stop if implementation would claim OS confinement, exactly-once external submission, prompt-text enforcement, or recall of bytes; if any artifact/log/API needs a path or content; if terminal audit and artifact cannot be made crash-consistent; if issuance cannot compose with the existing execution lease and #178 lock order; if legacy issuers cannot be proven drained; or if S2/#178 do not expose requirement-scoped decisions, decision revision, and structured operator-hold identity needed for filtering and recovery.
