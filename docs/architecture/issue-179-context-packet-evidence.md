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
nonce. They must also match the locked project's current internal root-binding
revision; an old-root decision is `revoked`, not issuable.

Historical authorization must not be reconstructed by joining an old audit to a mutable current approval row. Each packet claim stores an immutable, bounded authorization snapshot:

```ts
type PacketAuthorizationSnapshot = {
  schemaVersion: 2;
  source: 'package_allow_once' | 'project_always_allow';
  grantApprovalId: string | null;
  grantDecisionRevision: string;
  rootBindingRevision: string;
  grantDecisionNonce: string | null;
  grantMode: 'allow_once' | 'always_allow';
  approvedCapabilities: FilesystemProjectCapability[];
  requiredCapabilities: FilesystemProjectCapability[];
  decidedByUserId: string;
  decidedAt: string;
  coverageFingerprint: string;
};
```

The fingerprint uses canonical capability, policy, decision, and root-binding
revision fields only. It never includes a path, host-resource reference, prompt,
file name, content excerpt, free-text reason, or credential.

Required additive schema changes:

- `projects.root_binding_revision BIGINT NOT NULL DEFAULT 0`, where `0` is the
  sole unbound/non-issuable state, plus an internal opaque
  `host_resource_ref`, authoritative opaque `host_id`, host-binding-key
  fingerprint, and a bounded `root_maintenance_state`
  (`none|deleting|repair_required`) with nullable UUID token and expected revision.
  `host_resource_ref` is an installation-keyed digest of the host ID plus the
  platform-normalized canonical real path; it is never a packet field. Reuse the
  existing `archived_at` as the one project-removal tombstone and add only bounded
  `archived_by_user_id`/`archive_reason:'project_removed'` audit fields. A partial
  unique index on `(host_id, host_resource_ref) WHERE archived_at IS NULL AND
  host_resource_ref IS NOT NULL` rejects two live project records for one exact
  physical root, including aliases, while allowing a safely released root to be
  reused. There is no second `deleted_at` lifecycle;
- durable `project_host_root_hierarchy_claims` for every live root and missing-root
  reservation. Each owner stores one installation-keyed full-root reference and
  the ordered installation-keyed references for every canonical ancestor prefix.
  A deferred constraint trigger locks one host hierarchy-guard row and rejects a
  candidate whose full reference equals another live owner's full/ancestor
  reference or whose ancestor set contains another live owner's full reference.
  Sibling roots may share ancestors; ancestor/descendant roots may not. Raw paths
  and segment names never enter this table;
- durable `project_host_root_reservations` for roots that do not exist yet. Each
  row stores authoritative host ID, binding-key fingerprint, canonical existing
  parent resource identity, platform-normalized missing suffix digest, random
  reservation token, exact root-writer instance ID and database-credential
  generation for the current transition, hierarchy-claim owner ID, a restricted
  root-management-only planned path,
  `planned|materialized|bound|cleanup_required`, created-object identity when
  available, and database times. The path is never packet evidence, a task event,
  or general API/log output. Its live unique key is the host, parent identity, and
  suffix digest;
- durable `forge_worker_instances` capability/heartbeat rows with instance ID,
  authoritative host ID, maximum worker and root-management writer protocols,
  host-fence-service and operating-system containment-adapter versions,
  host-binding-key fingerprint, last-seen database time, and
  `active|draining|drained` state. Worker and web/root-management writers register
  separately; root writers also carry the current database-credential generation.
  Capability history and drain acknowledgements are append-only
  activation evidence;
- `filesystem_mcp_grant_approvals.grant_decision_nonce UUID NULL` during migration; every new `allow_once` write requires it after cutover;
- a durable decision revision on the approval decision/effective snapshot, using the #178 project-serialized revision contract;
- `work_packages.claim_protocol_version INTEGER NULL`, written by the database on
  each transition to `running` and retained as durable claim evidence, plus
  protocol-v2 `claim_worker_instance_id`, `claim_host_id`, `claim_host_resource_ref`, and
  `claim_root_binding_revision` for every local-root all-mode claim;
- nullable protocol-v2 `agent_runs.claim_worker_instance_id`, `claim_host_id`,
  `claim_host_resource_ref`, and `claim_root_binding_revision`; a created run copies
  the package pin exactly;
- `tasks.unresolved_local_change_count INTEGER NOT NULL DEFAULT 0` plus nullable
  canonical `local_change_barrier_fingerprint`. The atomic terminalizer,
  acknowledgement, and quarantine paths derive this materialized claim barrier
  from every sibling audit's exact host/repository review evidence while holding
  the task and sibling package rows. A count/fingerprint mismatch is an integrity
  hold, never a reason to proceed;
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
  - a pre-submission repository baseline fingerprint and post-quiescence repository
    change result (`unchanged|changed|unverifiable`) with a fingerprint-bound
    repository review (`not_applicable|review_required|reviewed`); abandonment is
    solely a separate integrity-quarantine resolution disposition;
  - post-submission effect intent (`not_started|active|quiesced`) with bounded stage,
    owning host ID, random fence token, and nullable host-apply ledger fingerprint;
  - host-apply recovery review (`not_applicable|review_required|reviewed`) bound to
    that exact ledger fingerprint; a recovery marker copies, never invents, it;
  - nullable current recovery-worker instance ID, recovery token, and recovery
    lease. These identify the fresh process performing stale recovery and never
    replace the immutable claiming-worker pin;
  - terminal success/failure outcome and bounded failure code/stage, with database
    checks matching the normative tuple table below.
- run-scoped `work_package_host_apply_ledgers` plus ordered entry rows. An entry
  references the existing validated output-plan entry ID/ordinal and stores only
  `planned|applying|applied|unknown`, claim/fence identity, and database times;
  packet-owned evidence never copies its path or error detail;
- append-only `filesystem_mcp_issuance_recovery_actions` with actor, typed action
  (`review_local_changes|acknowledge_possible_submission|retry_execution|resolve_after_allow_once_reapproval`),
  prior runtime-audit/agent-run IDs, marker fingerprint, delivery state, nullable
  prior/authorizing root-binding revision, authorizing decision
  revision/coverage fingerprint/approval ID, database time,
  and a unique `(runtime_audit_id, action, marker_fingerprint)` key.
- append-only `filesystem_mcp_integrity_alerts` and
  `filesystem_mcp_integrity_resolutions`, uniquely fingerprinted per audit/reason,
  with bounded reason, actor/owner, database time, prior alert ID, chosen typed
  resolution (`verified_success|verified_failure|quarantined_abandoned`), and no
  path or free text. A quarantine resolution additionally binds the sorted set of
  every affected sibling marker, repository baseline/change fingerprint,
  host-ledger fingerprint, host-review disposition, and one canonical
  sibling-evidence-set fingerprint. It records repository disposition
  `reviewed|abandoned`; omission is invalid.
- append-only `forge_host_binding_key_rotations` with active and pending key
  fingerprints/credential generations, one random rotation token, actor/time,
  `preparing|rebinding|verified|promoted|rolled_back`, bounded batch checkpoints,
  and a complete-set verification fingerprint. It never stores either key.

Two separate partial unique indexes are required for protocol v2 `operation='context_packet'` rows:

- `(agent_run_id, operation)` — one packet claim for every packet run;
- `(grant_approval_id, grant_decision_nonce, operation)` where the nonce is non-null — the additional one-time-decision fence.

SQL migration predicates, Drizzle schema declarations, and conflict writers must be semantically identical.

## Durable worker-protocol barrier

Mixed-worker safety uses the existing pre-read package claim boundary, not the
later runtime-audit insert and not a process-local feature flag. Add a singleton
`forge_runtime_protocol_epochs` row for `name='work_package_execution'` with
`minimum_worker_protocol`, `minimum_root_management_protocol`, nullable active host
ID, minimum host-fence-service/containment-adapter versions, active
host-binding-key fingerprint, active root-writer credential generation,
activation actor/time, and immutable activation
audit. It begins at protocol 1 with no active host.

An expand-phase PostgreSQL trigger runs on every work-package status transition to
`running`, a boundary every current legacy worker already traverses before the
executor can read repository context. The trigger reads the transaction-local
`forge.worker_protocol` setting (`1` when absent for legacy binaries), takes a
shared lock on the epoch row, rejects a lower protocol, and writes the observed
version to `work_packages.claim_protocol_version`. At epoch 2 it also requires a
transaction-local `forge.worker_instance_id`. After the epoch row, it locks that
exact `forge_worker_instances` row `FOR SHARE` and requires `active`, database-time
freshness within 30 seconds, the epoch host, protocol 2, sufficient fence-service
and containment versions, and exact host-binding-key fingerprint equality. It pins
the validated instance ID on the package. A caller cannot satisfy the trigger with
host/version strings alone. One shared v2 package-claim
primitive locks project → task → every sibling package in ascending ID order,
recomputes dependency/candidate eligibility, rejects `projects.archived_at IS NOT
NULL`, proves no sibling is running or leased and none is `awaiting_review`, and
requires the locked task's unresolved-local-change count to be zero with no
barrier fingerprint. It sets both
`SET LOCAL forge.worker_protocol='2'` and
`SET LOCAL forge.worker_instance_id='<registered-instance-id>'`; the trigger reads
host, versions, and binding-key fingerprint from that locked registry row rather
than trusting parallel caller settings. It only then attempts
one conditional `running` transition. This is required for packet-bearing execution,
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
a fresh command snapshot to query both every `running` package with null/protocol-1
claim evidence and the complete worker-instance capability/heartbeat registry.
Any package, project binding, worker, or root-writer capability blocker aborts
without advancing. Otherwise, statement three updates the epoch to 2, pins the one
active host/minimum fence-service and containment versions/binding-key fingerprint,
and records the immutable package/project/instance activation snapshot before
commit. A v1 transition that acquired the shared lock
first therefore commits and is visible to statement two, forcing activation to
abort. If activation acquired the exclusive lock first, a later v1 transition
waits, sees epoch 2, and fails. A single-statement check or a snapshot established
before the lock wait is forbidden. Activation does not lock entity rows or mutate
them, so it cannot reverse the entity order. The epoch is monotonic and never lowered.

Initial protocol-v2 execution that can read or mutate a local project is explicitly
single-active-host. Every worker and web/root-management process registers and
heartbeats one typed `forge_worker_instances` row from operator-controlled stable
host identity; a process cannot self-assert a different host at claim or management
time. Activation requires exactly one distinct fresh active host, every fresh
worker and root writer on that host to advertise protocol 2, the required
fence-service/containment versions, and one equal host-binding-key fingerprint.
Every stale, legacy, incompatible, divergent-key, or other-host row must have an
audited `drained` disposition.
Active instances heartbeat every 10 seconds and are fresh only when PostgreSQL
`now() - last_seen_at <= interval '30 seconds'`; an older non-drained row blocks
activation rather than being assumed dead.
The activation audit snapshots the exact instance IDs and kinds, host ID, binding-key
fingerprint, root-writer credential generation, versions, heartbeats, ingress
ownership, and drain evidence. Missing, stale, unreachable,
incompatible, divergent-key, or multiple-host evidence is a machine-checkable
blocker. Multi-host local execution
remains disabled until a later architecture supplies durable host-affine routing.
A later unregistered/stale/draining process or process from another host cannot
bypass activation: the package/root-mutation triggers reject its instance before
repository access.

Cutover still requires operational drain of pre-trigger processes before epoch-2
activation; no schema change can retroactively stop a binary that was already past
the package claim when the trigger was installed. After the expand trigger has been
deployed everywhere and the drain is proven, the durable activation fence prevents
an old binary from reconnecting. Tests cover a genuine pre-trigger worker that must
be externally drained and both bridge-trigger lock orderings: v1-shared-first
forces activation to abort, while activation-exclusive-first rejects the v1
package transition with zero repository reads.

### Durable project-root writer barrier

The project-root trigger is enabled only inside the cutover maintenance window,
after project-management ingress is disabled, the v1 database credential and
sessions are revoked, old web/root-writer services are drained, and the canonical
S3 TypeScript reconciler has processed every expansion-window root change. It
never calls or duplicates that reconciler. While the epoch is still 1 it rejects
every root-bearing project mutation and hard delete; ingress remains disabled, so
this is a short activation barrier rather than a supported old-route mode.

At epoch 2 the trigger covers any root-bearing project insert, any update of
`local_path`, host binding, positive root-binding revision, root maintenance, or
`archived_at`/archive audit fields, and hard delete. A rootless insert is the sole
exception: `local_path`, host/resource/key binding, hierarchy owner, maintenance,
and reservation fields must all remain null/`none`; it confers no filesystem
authority. Attaching a root later is a full reservation/binding transition. Hard
delete is always rejected. Every governed transition requires
`forge.root_management_protocol='2'`, a transaction-local registered writer
instance ID, maintenance/reservation token, authoritative host ID, resource ref,
binding-key fingerprint, and a well-formed monotonic revision/tombstone transition.
It locks and validates that exact fresh active instance after the epoch row, using
the same host/key/capability checks as a worker claim plus exact active root-writer
credential-generation equality. Missing or malformed state
fails before any database mutation.

Activation's exclusive epoch lock serializes statement two with this trigger.
The trigger rejects root mutation until activation commits; after activation it
accepts only registered v2 writers. The operational drain includes old web and
root-management processes already past any database boundary; rollback never
restarts them. No trigger or transaction waits for an external namespace,
resource, hierarchy, or containment fence: routes acquire it first with zero
database locks, then set the validated token/settings and enter the database
order.

The root-mutation trigger cannot undo filesystem work an old route performs before
its database statement. Cutover therefore keeps project-management ingress
disabled while it revokes the v1 web database role/credential, terminates every old
session, drains/disables the old service units, activates the epoch with a new
root-writer credential generation, and only then enables ingress to registered v2
instances. A restarted old web binary cannot authenticate or read a project path,
so its POST/PUT/DELETE request fails before route filesystem work. The activation
audit binds the credential generation, terminated sessions, disabled service units,
and exact ingress owner. This governs Forge-managed services; it does not claim to
sandbox an unrelated host process with direct operating-system access.

The installation host-binding key is operator-controlled secret material; only
its stable fingerprint is stored in PostgreSQL. Missing or divergent same-host key
material blocks registration, root management, activation, and claims. Backup is
a required cutover artifact. Rotation or loss is an explicit two-phase maintenance
event; a normal root writer can never cross the active-key trigger by itself.
The operator disables issuance and project ingress, revokes the active root-writer
credential, drains every instance, and proves there is no live claim, reservation,
containment lease, or effect. One exclusive transaction then creates a rotation
row/token and records `active K1` plus `pending K2` and its pending credential
generation without changing the active epoch key.

Only a separately credentialed rotation command may use that token. With no
database locks held it acquires the complete old/new hierarchy and resource-fence
set in canonical order. Restartable bounded transactions lock affected project
rows ascending → epoch → rotation instance → host hierarchy guard → reservations, compare-and-
set K1 inputs, and write shadow K2 references/checkpoints; normal claims and root
writers remain disabled and cannot observe shadow bindings as authority. After a
complete-set scan proves every live project and reservation has exactly one K2
shadow and no K1/K2 hierarchy collision, one transaction atomically promotes K2,
its credential generation, and all verified shadows and marks the rotation
`promoted`. Ingress credentials rotate only in that commit; registered K2 writers
start afterward. Before promotion, a crash resumes from verified checkpoints or
rolls back all shadows under the same token. After promotion, rollback to K1 is
forbidden; recovery completes K2 activation. Root-binding revisions and grant
decisions do not rotate because the physical root did not change; any identity
mismatch instead becomes repair-required and revokes authority. It is never a
silent configuration replacement.

## Lock order and claim transaction

The complete global order is:

```text
project
  → task(s ascending)
  → work package(s ascending)
  → grant approval/decision row(s ascending)
  → worker-protocol epoch
  → worker/root-writer instance row(s ascending)
  → host root-hierarchy guard row
  → agent run(s ascending)
  → runtime audit(s ascending)
  → host-apply ledger(s) by run ID, then entries by ordinal
  → all artifact rows (agent-run ID, artifact type, artifact ID ascending)
  → issuance-recovery action rows (runtime-audit ID, action, marker fingerprint)
  → integrity alert rows (runtime-audit ID, reason, evidence fingerprint)
  → integrity resolution rows (alert ID, expected fingerprint, resolution)
  → review-gate row(s ascending)
```

Candidate discovery and exact-replay lookup may happen without retained locks,
but every mutation reacquires the applicable rows in this order. New ledger,
artifact, action, alert, and resolution rows use these stable keys for uniqueness
waits. Activation/drain locks the epoch and then instance rows ascending. A
run-lifetime host-resource fence is an external precondition, not a database row:
post-claim worker revalidation, recovery, project create/repoint/tombstone, and
every filesystem-management path acquire it while holding **no** database locks,
then enter the order above. A path repoint acquires old and new opaque resource
refs in byte order. A missing-root create first uses its namespace reservation
fence. No database transaction waits for an external fence, preventing a fence↔row
cycle.

Pre-create reservations are a disjoint transaction family serialized by the
prefix-aware namespace/hierarchy fence. After acquiring that fence with zero
database locks, planning, materialization, cleanup, and final binding lock
protocol epoch → exact fresh root-writer instance → host hierarchy guard →
reservation. Every transition revalidates active host/key/protocol/freshness/
drain state and exact root-writer credential generation, and compare-and-sets the
reservation's writer-instance/generation pin. Final binding then inserts the new
project, promotes the hierarchy owner, and marks the reservation `bound`; it
acquires no task/package/approval/run rows. No entity-first path later locks a
reservation. A stale, draining, unregistered, divergent-key, or wrong-generation
writer fails before filesystem work and cannot clean up a newer owner's object.

Live health checks and other network/system probes happen before the transaction and are not persistence inputs. Every current `ready → running` writer must call the shared protocol-v2 package-claim primitive. In every mode it locks project → task → all sibling packages ascending, recomputes candidate/dependency state under lock, rejects an archived project, proves no sibling has `running|awaiting_review` status or a live execution lease, and requires zero unresolved-local-change count plus a null barrier fingerprint. The package status remains the mandatory-review barrier; the task-local-change fields are the separate host/repository evidence barrier. Gate, acknowledgement, and quarantine decisions change them only under the same task/package locks and exact downstream evidence locks. This includes packet-free and handoff-only paths even when there is no MCP project snapshot. For a packet-bearing package, extend that same package/run claim transaction rather than creating an independent claim lifecycle:

1. Lock project, task, and every sibling package row in global order; recompute
   eligibility, require `root_maintenance_state:'none'` plus a populated unique
   host binding for any local root, and select the one candidate under those locks.
2. Lock the applicable approval/decision row after the package.
3. Re-read current package requirements and canonical admission. Verify exact required coverage and decision revision. For `allow_once`, also verify the approval ID + nonce is approved and unconsumed.
   The decision root-binding revision must equal the locked project and the package
   claim pin; an old-root decision is revoked.
4. The shared primitive sets transaction-local worker protocol 2 and exact
   registered instance ID, then conditionally moves the package to `running`; the
   trigger locks/checks the epoch and that instance row, and records claim protocol
   2 plus the authoritative instance/host/resource/root-revision pin.
5. Create the `agent_runs` row and existing execution lease, copying the exact
   worker-instance pin.
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
may compare-and-set an exact `packet_issuance` marker away and move
`blocked → ready`. They reject `packet_integrity_hold` without mutation. An
integrity hold may be cleared only by the separately authorized, fingerprint-bound
privileged repair procedure below. Generic S2 broker retry, admission freshness,
and `promotePackageWithFreshnessCas` must preserve both kinds and blocked status. This prevents an always-allow package,
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
- immediately after ACP returns and before response-driven local work;
- entry to sandbox apply, validation, host apply, repository evidence, and
  completion preparation;
- before each host-file intent and immediately before its atomic replacement;
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

Immediately before the first ACP transport call, while it owns the resource fence,
the worker computes and persists a versioned opaque repository baseline
fingerprint under both lease predicates. The baseline covers canonical relative
entry identity, type, metadata, and content needed to detect tracked, untracked,
renamed, and deleted changes; no path or content is exposed in packet evidence or
public APIs. The scanner contract is versioned and bounded: it uses `lstat`, never
follows symlinks, reads content only from regular files, represents links and
special entries by bounded type/metadata, and never opens a FIFO, socket, or
device. Exact versioned rules exclude `.git` internals and Forge's protected
run-state directory while still including tracked, ignored, and untracked working-
tree entries. File-count, per-file byte, total-byte, depth, and wall-time ceilings
are persisted with the scanner version. Two matching ordered scans—or a platform
snapshot with equivalent proof—are required for stability. Pre-submission churn,
overflow, unsupported entry metadata, or any incomplete scan stops before the ACP
call as `preflight_failed`. The same condition after possible exposure produces a
bounded `unverifiable` comparison, never silently unchanged. The owner then CAS-persists
`delivery.state:'submitting'` with a random `submissionAttemptId` and database-time
`intentAt`. Only then may it perform external I/O. A
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

### Run-lifetime host-resource fence and post-submission quiescence

Forge derives an internal `hostResourceRef` from the operator-controlled stable
host ID and the platform-normalized canonical physical root. Canonicalization
resolves symlinks, applies case folding only on a case-insensitive filesystem, and
uses stable filesystem device/object identity where the host supports it. An
installation-keyed digest makes the reference opaque outside the trusted host
boundary. If Forge cannot prove that aliases converge to one identity, it disables
protocol-v2 local-root execution on that host. `hostResourceRef` is unrelated to
the random project-scoped packet `rootRef` and never appears in packet evidence,
copy, logs, queue payloads, or public APIs.

The project row owns the authoritative host ID, resource reference, and monotonic
root-binding revision. The all-mode claim transaction pins all three on the run.
After claim commit and **before the first repository read, context selection, or
packet assembly**, the worker acquires the corresponding exclusive operating-
system advisory lock in Forge-controlled host state while holding no database
locks. It then enters a short top-down transaction and revalidates the project
binding, claim, and both leases. A mismatch fails before any repository bytes are
read. The worker retains this one resource fence through packet assembly,
submission, response-driven local work, atomic terminal finalization, and
descendant quiescence. Packet-free and handoff-only execution must do the same
whenever they read or mutate the local root. This is host-resource exclusion, not
distributed filesystem fencing or an ACP sandbox.

A dedicated host fence service, outside the queue worker's failure domain and
running under a separate protected operating-system principal, owns the resource
lock and durable local lease record. Its state directory and socket/API are not
readable, writable, signalable, or callable by the worker/ACP principal except
through the narrow authenticated client endpoint. Every request verifies kernel
peer credentials plus an unguessable lease capability bound to run ID, current
worker instance ID, root identity, and containment-group ID. Release always asks
the kernel adapter for emptiness; it never trusts a caller's declaration. State
tamper/corruption, peer mismatch, replay, cross-run/root token use, service death,
or unverifiable adapter state marks the lease `orphaned|disabled` and blocks root
reuse until protected-state recovery proves the exact group empty.

The long-lived queue/control worker stays outside containment. For each run, the
service creates an authenticated per-run execution child and places that child,
ACP, validation, response-driven work, and every descendant in one non-escapable
lease group before any member can access the project. The adapter—not inherited
descriptors, parent/child guesses, process names, or a best-effort process-group
scan—proves whether that complete per-run group is empty. On normal completion the
child commits/quiesces the run, exits, and the service releases only after it
independently observes the group empty; the queue worker need not exit. Execution-
child, control-channel, adapter, or service loss changes the durable lease to
`orphaned`; database recovery and root management remain actionless. On restart,
the service reacquires/retains the resource fence from protected durable state and
may release it only after the adapter proves the exact group empty. Protocol-v2
local execution is disabled on any host where a descendant can escape containment,
the protected service boundary is unavailable, or emptiness cannot be proved.

This containment establishes liveness and resource exclusion only. It does not
restrict ACP shell, network, credential, or filesystem permissions and is not a
security sandbox. Prompt text likewise cannot stop equivalent direct repository
work. A live owner waits until the adapter proves the ACP subtree empty, then—before
any Forge response-driven stage—computes the post-submission repository fingerprint.
After owner loss, same-host recovery waits for the complete lease group to become
empty before computing it. A detected or unverifiable change sets fingerprint-
bound repository review to `review_required` even when Forge's own effect intent
is `not_started` and its host-apply ledger is empty. After a valid provider response
this stops later local stages and terminalizes with bounded
`external_repository_change_requires_review`; submission-uncertain recovery keeps
its delivery-specific primary cause but the same review barrier. A new run,
reapproval, retry, unrelated acknowledgement, or root-management operation cannot
proceed until review is `reviewed` or a privileged quarantine resolution records
an authorized `abandoned` disposition. The exact fingerprint-bound
`review_local_changes` acknowledgement that atomically changes `review_required →
reviewed`, and the privileged exact quarantine transition, are the only actions
allowed to cross this barrier; otherwise the barrier would block its own
resolution.

Project creation, root repoint, tombstone/delete, recursive filesystem cleanup,
and every other root-management path participate in the same fence and writer-
protocol contract. Existing candidate roots use their physical resource fence.
A destination that does not exist first derives a namespace identity from the
authoritative host, binding-key fingerprint, canonical existing parent physical
identity, and each platform-normalized missing suffix segment. The hierarchy fence
service takes shared locks on every strict canonical ancestor and an exclusive
lock on the complete candidate root, shallow-to-deep with opaque references as the
tie-breaker. Siblings may share ancestor locks; an ancestor/descendant pair
conflicts in either acquisition order. The route acquires that hierarchy fence
before `mkdir`, clone, or cleanup and inserts a random-token reservation plus its
full/ancestor hierarchy claim in a short transaction. It retains the hierarchy
fence through `planned → materialized`,
derives/acquires the new physical resource fence, and atomically converts the
reservation to the unique live project binding. A loser or crash recovery may
delete only an object whose reservation token **and** recorded physical object
identity still match and whose protected subtree has no other live reservation or
binding. Later path reuse, a mismatched object, or any descendant claim becomes
`cleanup_required`, never an unscoped recursive delete.

Root-management paths discover current/candidate identities without retained
database locks, acquire hierarchical namespace locks and resource fences in the
canonical order above,
then start a fresh top-down transaction. That transaction sets the epoch-2 writer
instance/maintenance settings, revalidates the old binding and revision, enforces
the exact-root unique index plus the deferred no-ancestor/no-descendant hierarchy
constraint, and rejects mutation while any pinned
claim/lease, sibling `awaiting_review`, active effect, unproven containment
quiescence, unresolved S4 marker, nonzero/mismatched task-local-change barrier,
host-ledger review, or repository-change review remains. These barriers apply to
terminal and nonterminal tasks. A normal marker
must be resolved or its task explicitly cancelled without rewriting evidence.
Cancellation acquires the complete applicable tail, requires quiescent effects and
completed exact host/repository review, appends actor/reason audit, and retains
every marker/audit/artifact.

Create compare-and-sets unbound revision `0` to the next positive revision and
inserts the unique hierarchy binding. Repoint atomically advances its revision/binding
and invokes S3's `project_root_repoint` negative reconciler so old-root decisions
become revoked before commit. Project deletion is a tombstone, never a cascading
row delete. After proving no live execution, mandatory review, effect, or exact
local-change barrier, its top-down finalization atomically closes every nonterminal
task/package with bounded reason `project_removed`, sets the existing
`archived_at` plus actor/reason audit, clears `local_path` and the live host/
hierarchy binding, and releases the partial unique key while retaining the project
`rootRef`, tasks, packages, runs, audits, artifacts, actions, alerts, and resolutions.
Queue discovery, direct progression, sibling continuation, and every all-mode
claim reject an archived project even if a stale wake remains. Normal queries hide
tombstones; evidence/operator queries address them explicitly.
A hard purge is forbidden until a separate retention/export architecture exists.
Recursive cleanup first persists typed `deleting` maintenance intent, performs
filesystem work outside the database transaction while retaining the fence, and
then commits the tombstone in a fresh top-down transaction. Crash recovery
reacquires the same fence and either completes the exact intent or enters bounded
manual repair; it never guesses. No path waits for an external fence while holding
a database lock.

This root-binding protocol closes path reuse and overlap: Project B cannot claim
the same, ancestor, or descendant root while Project A owns the hierarchy/resource
fences, and the unique/hierarchy binding cannot move or be
reused until A has no live pin, containment quiescence is proven, and every exact
host/repository review or abandonment is complete. It also prevents a path edit or
tombstone cleanup from changing the repository underneath a packet being assembled.

A valid response is persisted as `delivery:'submitted'` before Forge applies any
response-driven local effect. The worker already owns the run-lifetime resource
fence. A short top-down transaction revalidates the pinned binding and both leases,
then CAS-persists an `active` post-submission effect intent with authoritative
opaque host ID, random fence token, and current closed stage. The combined
heartbeat remains active. Before every later stage and before each file
replacement, the worker rechecks the binding and both ownership predicates and
advances the durable stage under compare-and-set. Each host file uses a validated
write-plan entry and:

1. persists ledger entry `planned → applying` under the fence and ownership token;
2. performs one atomic replacement only after another ownership check;
3. persists `applying → applied` before starting the next entry.

A crash after replacement but before step 3 leaves `applying`; recovery later
maps it to `unknown`, never guesses applied/unapplied. A live owner that catches a
failed/ownership-lost step 3 has the same uncertainty: while retaining the fence it
must durably map the entry to `unknown` before terminalizing. If PostgreSQL is
unavailable it leaves intent active and the run nonterminal for fenced recovery;
it cannot report a caught terminal failure or success from memory. The ledger references the
existing output-plan entry identity/ordinal. Exact paths remain in the separate
authorized host-write/output evidence where already required for repository work;
they never enter packet audit, marker, artifact, alert, API copy, or logs.

The per-run execution child holds the resource fence through the atomic database
finalizer. If local work began, that commit sets the effect intent to `quiesced`;
a no-local-stage success truthfully remains `not_started`. The child then exits and
the protected service releases only after independent per-run group emptiness.

Stale recovery preserves the original claiming instance as immutable history but
does not require that dead process to remain fresh. A candidate fresh worker W2
first enters a short top-down transaction, proves its authoritative host ID equals
the locked package/run pin, locks the epoch and both W1/W2 instance rows in
ascending ID order, and requires W2 to be distinct, `active`, database-time fresh,
same-host/key/protocol/fence/containment generation, and not draining. For
`active|quiesced`, the pinned host must also equal `effectIntent.hostId`;
`not_started` has no intent host. The transaction compare-and-sets the audit's
current recovery-instance ID, random token, and database-time lease, then commits.
No process may reuse W1's stable instance ID as W2.

With no database locks held, W2 presents that run/instance/root/group-bound token
to the protected fence service and asks for the pinned durable lease. Lock
acquisition alone is never proof of quiescence: the adapter must prove the complete
per-run execution group empty. W2 then re-enters the canonical database order,
relocks W1/W2 ascending after the epoch, revalidates its freshness and recovery
token/lease, and rereads the candidate. Only then may it terminalize and expose a
recovery marker; it maps leftover `applying` entries to `unknown`, fingerprints the
final ledger state, and persists `quiesced` when local work began. An actionable
marker requires effect intent `not_started|quiesced`, never `active`.

A wrong-host/key/capability W2, stale/draining/unregistered W2, same-ID takeover,
nonempty/unverifiable group, orphaned service lease, or unavailable authoritative
host is alert-only: recovery changes no run/package/marker state, creates no retry
action, emits one deduplicated bounded `post_submission_quiescence_unproven`
integrity alert, and retries only through a fresh instance on the authoritative
owning host. Thus no actionable marker or later run can coexist with an in-flight
stale host operation.

The quiescence-alert insert is the sole path that does not own the resource fence. It
never waits for that fence while holding database locks. After a bounded failed
lease/quiescence acquisition—or after authoritative host mismatch/unavailability prevents an
attempt—it starts a short fresh transaction, follows the full applicable
database order through audit → host ledger → artifacts → alert, revalidates the
same active intent/fingerprint, inserts or rereads the unique alert, and commits
without changing run/package/lease/marker state.

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
  | 'external_repository_change_requires_review'
  | 'post_submission_execution_failed';

type PostSubmissionFailureStage =
  | 'sandbox_apply'
  | 'validation'
  | 'host_apply'
  | 'repository_evidence'
  | 'completion_preparation';

type PacketPostSubmissionEffectIntent =
  | { state: 'not_started' }
  | {
      state: 'active';
      stage: PostSubmissionFailureStage;
      hostId: string;
      fenceToken: string;
      hostApplyLedgerFingerprint: string | null;
      startedAt: string;
    }
  | {
      state: 'quiesced';
      lastStage: PostSubmissionFailureStage;
      hostId: string;
      fenceToken: string;
      hostApplyLedgerFingerprint: string | null;
      quiescedAt: string;
    };

type HostApplyRecoveryReview =
  | { state: 'not_applicable' }
  | {
      state: 'review_required';
      ledgerFingerprint: string;
      reviewedAt: null;
      reviewedByUserId: null;
    }
  | {
      state: 'reviewed';
      ledgerFingerprint: string;
      reviewedAt: string;
      reviewedByUserId: string;
    };

type RepositoryChangeReview =
  | {
      state: 'not_applicable';
      baselineFingerprint: string | null;
      changeResult: 'not_observed' | 'unchanged';
    }
  | {
      state: 'review_required';
      baselineFingerprint: string;
      changeResult: 'changed' | 'unverifiable';
      changeFingerprint: string;
      reviewedAt: null;
      reviewedByUserId: null;
    }
  | {
      state: 'reviewed';
      baselineFingerprint: string;
      changeResult: 'changed' | 'unverifiable';
      changeFingerprint: string;
      reviewedAt: string;
      reviewedByUserId: string;
    };

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
  hostApplyReview: HostApplyRecoveryReview;
  repositoryChangeReview: RepositoryChangeReview;
  autoRetryable: false;
  markerFingerprint: string;
  policyFingerprint: string;
  coverageFingerprint: string;
};

type PacketIssuanceRecoveryState =
  | {
      grantMode: 'allow_once';
      deliveryState: 'submission_failed';
      disposition: 'review_local_changes';
      nextDisposition: 'reapprove_allow_once';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'allow_once';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'review_local_changes';
      nextDisposition: 'review_then_reapprove_allow_once';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'submission_failed';
      disposition: 'review_local_changes';
      nextDisposition: 'retry_execution';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'review_local_changes';
      nextDisposition: 'review_submission';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
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

type PacketIntegrityAlertReason =
  | PacketIntegrityHoldV2['reason']
  | 'post_submission_quiescence_unproven';
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
| `assembled` | `submitted` | authorization/lease codes, `worker_stopped`, `provider_response_invalid`, `external_repository_change_requires_review`, or `post_submission_execution_failed` with exactly one closed `failureStage` |

Effect intent, host ledger, terminal state, host-review state, and external-runtime
repository review form one second normative compatibility table. “No entries”
means the run has no host-apply ledger entry rows; “complete” means every expected
output-plan entry is `applied`. Repository review is independently required when
the baseline comparison detects or cannot exclude an ACP-originated change.

| Durable phase | Terminal state | Effect intent | Host ledger | Host review | Repository review |
|---|---|---|---|---|---|
| Before any ACP call (`not_exposed`) | nonterminal or failed | `not_started` | no entries | `not_applicable` | `not_applicable + not_observed`; baseline may be null |
| ACP attempted before an accepted valid response, including `submission_failed|submission_uncertain` | nonterminal or failed | `not_started` | no entries | `not_applicable` | `not_applicable` only when the complete baseline comparison is unchanged; otherwise `review_required|reviewed` |
| Valid response persisted, before first Forge local stage | nonterminal or failed | `not_started` | no entries | `not_applicable` | `not_applicable` only when unchanged; otherwise `review_required|reviewed` |
| Local stage executing or live finalizer retrying | nonterminal only | `active(stage)` | `planned|applying|applied`; never `unknown` | `not_applicable` | derived independently from baseline comparison after containment quiescence |
| Caught local-stage failure | failed as `post_submission_execution_failed(failureStage)` | `quiesced(lastStage)` where `lastStage === failureStage` | no `applying`; may contain `unknown` when a completed replacement lacks a provable outcome write | `review_required` when host changes are applied or unknown, otherwise `not_applicable` | `review_required|reviewed` when changed/unverifiable, otherwise `not_applicable` |
| Recovered failure after any local stage | failed with the deterministic recovery code | `quiesced(lastStage)` | no `applying`; may contain `unknown` | `review_required|reviewed` when any host change is applied or unknown | `review_required|reviewed` when changed/unverifiable, otherwise `not_applicable` |
| Successful run with no response-driven local stage | succeeded | `not_started` | no entries | `not_applicable` | `not_applicable + unchanged` only |
| Successful run after one or more local stages | succeeded | `quiesced(actualLastStage)` | complete for a declared host-write plan, otherwise no entries; no `planned|applying|unknown` | `not_applicable` | `not_applicable + unchanged` only |

No terminal row may coexist with `effectIntent.state:'active'`; `quiesced` is
terminal-only. `not_started`
forbids a host ledger and host-apply review, but it does not imply that an
unconfined ACP runtime left the repository unchanged. Every `active|quiesced` intent
host ID must match the linked run's pinned host ID; recovery obtains the resource
reference and root-binding revision only from that locked run/package pin.
Every nonempty ledger has one canonical fingerprint equal to the intent and any
`review_required|reviewed` union. A reviewed fingerprint cannot authorize a
different ledger. A failed row with `submitted` may remain `not_started` only when
no local stage began; once a stage began, terminalization requires `quiesced`.
Success is admitted only by the two explicit, disjoint success rows. A changed or
unverifiable repository comparison can never succeed, even after review; it stops
Forge local stages and terminalizes failed as
`external_repository_change_requires_review`. A no-stage success never fabricates
a `lastStage`.
The same terminal transaction recomputes the locked task's unresolved-local-change
count/fingerprint from every sibling audit. Review acknowledgement and privileged
quarantine recompute it under the same top-down locks. Claim paths trust neither a
stale count nor a marker alone: count/fingerprint disagreement is an integrity
hold. Thus terminal package A can never leave packet, packet-free, or handoff-only
sibling B claimable while A's exact host/repository review remains required.

The migration installs same-row checks plus a deferred PostgreSQL constraint
trigger that calls one versioned tuple-validation function across the audit,
ledger entries, host-review data, and baseline/change review before commit. Live/recovery finalizers and
privileged repair call the same predicate under the complete lock order. Drizzle
parsers and API readers import matching fixtures; S6 exhausts every allowed row
and representative forbidden cross-product. No layer may maintain a looser copy.

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
repository-evidence preparation, or completion/review-gate preparation. It is
valid only with `assembled + submitted` and requires exactly one
`PostSubmissionFailureStage`; every other failure code forbids `failureStage`.
Delivery remains `submitted`, so recovery follows the possible-prior-work path and
never automatically resubmits. A `host_apply` failure may have changed some files
before it stopped. The packet audit records only the closed stage; existing
repository/host-apply evidence remains the separate source for changed files.
The exact `review_local_changes` action covers partial local changes; the separate
`acknowledge_possible_submission` action covers prior uncertain/accepted external
submission. Both must complete when both facts apply. The operator must inspect
and resolve the working tree before choosing a new run; Forge never claims rollback.

The failure code and local-change evidence are independent. If the process dies
instead of returning a caught stage error, stale recovery may truthfully select a
lease/worker code while the monotonic effect intent/host ledger or external-runtime
change fingerprint still forces review. Therefore every crash after submission or stage entry,
including finalizer rollback followed by process death, retains possible-local-
change guidance without mislabeling the primary terminal cause.

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
`rootRef`, and the separate internal host-resource uniqueness rule prevents them
from simultaneously owning the same canonical physical root.

The packet keeps the existing assembly ceilings: `50` included files, `160 KiB` total included bytes, `24 KiB` per file, traversal depth `6`, `500` directory entries, and `5,000` total traversed entries. `rootRef` is at most `80` ASCII characters. Redaction summary has at most `32` known keys and each count is `0..5,000`. Artifact human-readable content is at most `16 KiB` and is derived only from typed fields and static copy. Values outside these bounds fail closed rather than being persisted.

## Stale claim reconciliation

`reconcileStaleFilesystemIssuanceClaims()` runs at startup and periodic recovery.
Candidate discovery selects expired audit IDs without holding audit-row locks. It
uses the fresh W2 selection/token, protected service handoff, and group-emptiness
protocol above. Its terminalizing transaction:

1. locks project → task → every sibling package in ascending ID
   order → approval decision → worker-protocol epoch → historical claiming and
   current recovery worker instances in ascending ID order
   → agent run → runtime audit in global order;
2. compare-and-sets only a still-`claiming` row whose lease is expired according to PostgreSQL `now()`;
3. invalidates the token by the terminal status transition;
4. fails the linked running agent run, clears only that run's `executionLease`, and moves the package to a structured issuance-recovery block;
5. derives the task's unresolved-local-change count/fingerprint from every sibling
   audit and compare-and-sets task `running → approved` only when no other sibling retains
   a live execution lease or `awaiting_review` status; otherwise the task remains `running` and the marker is
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
canonical typed terminal-tuple equality in the audit and artifact; mismatch
enters a neutral, non-retryable integrity hold and alerts operators without
changing packet evidence or exposing a retry action. For terminal failure, repair
fails the run, clears only its lease, blocks the package, and copies the exact
immutable failure object and delivery into the marker; it never derives a
worker/lease replacement cause. For terminal success, repair creates no failure
marker. It may reconstruct the normal success-side run/package/review-gate
transition only when the matching completion artifact, repository evidence
required by the configured host-write mode, and every required review-gate
materialization (or proof that no gate is required) already exist for that run. Otherwise it enters the neutral integrity hold for
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
data-repair procedure, never a normal recovery action. The generic S4 admission
guard treats both `packet_issuance` and `packet_integrity_hold` as absolute blocks.

Integrity operations are owned by Release/DevOps. Entering an integrity hold or
exceeding the bounded host-quiescence wait inserts one deduplicated
`filesystem_mcp_integrity_alerts` row with audit/run/package/task/project IDs,
closed reason, evidence fingerprint, database time, and owner; it also emits a
bounded task event after commit. No alert contains a path, exception, or evidence
payload. Before protocol-v2 activation, implementation must add
`docs/operators/packet-integrity-repair.md` and checked-in commands:

```text
npm run packet-integrity:inspect -- --audit <id>
npm run packet-integrity:resolve -- --audit <id> --actor <operator-id> \
  --expected-fingerprint <digest> \
  --resolution <verified_success|verified_failure|quarantined_abandoned>
```

Inspection is bounded/read-only. Resolution requires the privileged operator
role, locks in the complete order, compare-and-sets the alert/hold fingerprint,
and writes one append-only resolution row. `verified_success` runs only the exact
success reconstruction predicate; `verified_failure` requires coherent immutable
failed audit/artifact evidence and copies it exactly. Neither option rewrites
immutable packet evidence. `quarantined_abandoned` is the sole terminal outcome
for a proven immutable audit/artifact mismatch that can satisfy neither predicate.
It requires the exact alert fingerprint, no live sibling lease, no sibling
`awaiting_review`, quiescent containment/effects, and one complete exact evidence
set for every affected sibling. Every sibling host-ledger and repository-change
review must be `not_applicable|reviewed`, or the operator must choose the separate
privileged repository disposition `abandoned`. That abandonment binds the sorted
sibling marker IDs, baseline/change fingerprints, ledger fingerprints, and current
root binding into the resolution's canonical sibling-evidence-set fingerprint.
Then one complete-order transaction writes the append-only adjudication, moves the
held package and every remaining nonterminal sibling to `cancelled`, and closes
the task as `cancelled`. It retains
the alert, hold, audit, artifact, and run unchanged, creates no recovery action,
and can never make the packet or task retryable. Readers join the resolution and
render permanent evidence quarantine/closure. If no resolution predicate is
proven, the command makes no mutation and the hold remains. A quiescence alert
resolves automatically only after owning-host recovery acquires the fence and
commits a coherent terminal state. Unauthorized, stale, duplicate, and
cross-project requests fail closed.

Terminalizing the task never clears a repository-management barrier by itself.
Any unresolved marker, host review, repository-change review, or mismatched
sibling-evidence fingerprint blocks repoint, tombstone, cleanup, and path reuse for
terminal as well as nonterminal tasks. A normal exact `reviewed` transition or the
separate privileged quarantine disposition `abandoned` satisfies the matching
fingerprint; task terminalization by itself does not.

`reconcilePacketRecoveryTaskDisposition(taskId)` owns the sibling-convergence seam.
It runs in a new top-down transaction after any sibling releases/terminalizes its
execution lease, and at startup/periodic recovery. It locks project → task → all
sibling packages ascending, validates at least one S4 packet marker, and changes
task `running → approved` only when no sibling retains a live execution lease or
`awaiting_review` status. It
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

Before the grant/delivery row is actionable, review precedence applies. If either
exact host-apply or repository-change review is `review_required`, the marker's
only normal disposition/action is `review_local_changes`, independent of delivery
or grant mode. It stores the deterministic `nextDisposition` from the table below.
Only the matching fingerprint-bound action may change required reviews to
`reviewed`; privileged quarantine is the only abandonment alternative.

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

No recovery action changes immutable `deliveryState`. `review_local_changes`
requires at least one exact `review_required` host/repository fingerprint,
attests that the operator inspected/resolved those local changes, atomically
changes every matched review to `reviewed`, recomputes the task's materialized
local-change count/fingerprint, and advances only to the stored
`nextDisposition`. It does not acknowledge provider acceptance and requires no
current grant coverage. `not_applicable` is valid only when the corresponding
ledger/baseline proves no possible change. A definitive `submission_failed` can
therefore complete local review before moving to direct reapproval/retry.

Separately, `acknowledge_possible_submission` is valid only for
`submission_uncertain|submitted` after all local-change reviews are complete. It
sets database-time `acknowledgedAt`/actor and changes
`review_then_reapprove_allow_once → reapprove_allow_once` or
`review_submission → reviewed_submission`. The request marker fingerprint commits
to delivery and every review fingerprint. Each compare-and-set rotates the marker
fingerprint; the action ledger keeps the prior request fingerprint for exact
replay while the next CTA carries the new fingerprint. A marker with acknowledged
fields and any other disposition is invalid and fails closed.

S4 owns the mutation behind these actions, suggested route:

```text
POST /api/tasks/{taskId}/work-packages/{packageId}/packet-issuance-recovery
{
  schemaVersion: 2,
  action: review_local_changes | retry_execution | acknowledge_possible_submission,
  priorRuntimeAuditId,
  markerFingerprint
}
```

The route authorizes the operator, then locks project → task → every sibling
package in ID order → current grant decision → protocol epoch → exact pinned
claim/recovery worker instances in ascending ID order → prior agent run → prior runtime audit → host-apply ledger and
entries → all applicable prior-run artifacts in
stable order (including the exact packet artifact) → any existing/new matching
recovery-action row by unique key → applicable integrity alerts/resolutions →
review gates.
Under those locks it proves canonical typed equality between the audit and
artifact terminal tuples before reading the marker as actionable. Every action requires task
`approved`, package `blocked`, a request whose task/package route owns the exact
prior audit, the exact marker/prior-audit/delivery identity, and no active lease.
It also requires no sibling `awaiting_review`, no unresolved
host-effect/containment intent. Both host-apply and repository-change review states
must be `not_applicable|reviewed` for any action that can enable a new claim;
`review_local_changes` and the privileged quarantine command are the two exact
fingerprint-bound exceptions that may resolve their own barrier.
It checks the append-only ledger by the complete versioned request identity before
requiring the marker to remain present, so an exact replay still returns the
recorded result after successful marker clearing. Neither local-change review nor
possible-submission acknowledgement requires current grant coverage: the operator
must be able to resolve old evidence after the grant was revoked. The latter
changes `allow_once` to
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

Both states require the authorizing decision's root-binding revision to equal the
locked current project. State 1 therefore cannot survive a repoint; state 2 can
authorize a new run on the new root only after explicit reapproval. The action row
records both prior and current root-binding revisions.

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

Every successful local-change review, possible-submission acknowledgement, retry,
or one-time-reapproval resolution writes one append-only
`filesystem_mcp_issuance_recovery_actions` row containing actor, action, prior
audit/run IDs, marker fingerprint, immutable delivery state, nullable authorizing
current decision revision/coverage fingerprint, prior/current root-binding
revision, resulting package status and
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
#178 rotates the nonce under project → task → every sibling package in ID order →
approval locks, it calls an S4-owned package-scoped resolver in the same
transaction. Package scope limits grant evaluation; sibling locks enforce the
task-wide review barrier. The resolver continues to protocol epoch → exact worker
instance → prior agent run → runtime
audit → host-apply ledger/entries → all artifacts in stable order, including the
exact packet artifact → existing/new recovery action → integrity
alerts/resolutions → review gates. It proves canonical typed audit/artifact tuple
equality and validates the locked host-ledger and repository-change review
fingerprints. It verifies the
exact `reapprove_allow_once` marker/fingerprint, changed fresh nonce, current
policy/root-binding revision, no active lease, and no sibling `awaiting_review`,
then clears only the packet marker and moves `blocked → ready`. It inserts
`resolve_after_allow_once_reapproval` evidence referencing the new approval
decision; marker clearing and evidence are atomic. It never clears an S3
filesystem-grant marker. A stale marker, second reapproval, changed policy, active
lease, unresolved review, or integrity hold is a compare-and-set miss. Redis wakes
the task only after the combined transaction commits.

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

Artifact content is a bounded human-readable summary derived only from these persisted typed snapshots. A live finalizer extends the existing run/package terminal transaction: after external work completes—or after a bounded external-work stage fails—it locks top-down, verifies both ownership predicates and the pinned root binding, terminalizes the agent run and package/review-gate transition, clears the execution lease, writes any recovery marker and task disposition for failure, transitions the audit to terminal, and upserts the artifact in one transaction while still holding the run-lifetime resource fence. Sandbox writes, validation commands, host writes, repository-evidence preparation, and review-gate preparation happen before this transaction and each maps to the closed post-submission stage above. The transaction contains no network, Redis, filesystem, provider, or rendering work. A gate insert or other finalizer database failure rolls the whole transaction back and persists no `completion_preparation` cause; the host fence service retains exclusion while the worker retries and, on process/control loss, keeps the lease orphaned until the containment adapter proves the complete group empty. Thus a protocol-v2 writer cannot commit terminal packet evidence while leaving its linked run/package `running`. The partial unique index makes repeated or competing live/recovery finalizers idempotent; it does not replace this crash-consistency transaction. Recovery never rereads or reassembles a burned packet. The invariant-repair branch above handles legacy/manual partial state without rewriting already-terminal evidence.

## Review-gate concurrency boundary

Review-gate materialization and decisions participate in the same global order.
The finalizer and every gate-decision transaction lock project → task → package →
applicable runs/audits ascending → host ledgers/entries by run/ordinal → all
artifacts by stable key → applicable recovery actions → integrity
alerts/resolutions → all relevant gate rows ascending; no path
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
    internal host-resource refs, secrets, HTML, control characters,
    raw exceptions, and rejected text do not leak through any packet-owned
    persistence/diagnostic surface.
19. Deferred optional merge overlay text is absent; static ACP non-sandbox warning remains.
20. Pure filesystem write planning hint remains present without packet.
21. Existing-project backfill, old-writer inserts during cutover, and permitted
    path rename preserve the lifetime-stable opaque `rootRef`. Concurrent project
    create/repoint attempts for the same canonical root—including symlink, alias,
    case, and filesystem-object variants—and for ancestor/descendant roots select
    one non-overlapping hierarchy binding; the loser fails closed before create,
    recursive cleanup, claim, or repository reads.
22. Every issuance failure persists `autoRetryable:false`; `always_allow`
    exposes `retry_execution` immediately only for
    `not_exposed|submission_failed` **and only when no local-change review is
    required**. Any delivery with required host/repository review first exposes
    `review_local_changes`. Post-intent states then expose
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
31. Package-epoch tests cover a genuinely pre-trigger process that must be
    operationally drained and both package bridge-trigger orderings under `READ COMMITTED`: v1 shared
    first commits and forces activation to abort; activation exclusive first
    rejects v1 with zero repository reads. Packet, packet-free, and handoff-only v2
    claims all succeed after epoch 2 and persist protocol 2.
32. Direct progress, sibling-completion continuation, and periodic readiness all
    encounter valid and malformed S4 markers. None calls generic promotion; only
    the exact S4 action/resolver clears the marker and makes the package ready.
33. Every valid grant-mode/delivery/review-precedence/disposition/acknowledgement
    marker tuple parses;
    every known-invalid cross-product is neutral and non-actionable. A successful
    acknowledgement rotates the marker fingerprint while an exact prior request
    still replays from the ledger.
34. A valid submitted response then fails independently at sandbox apply,
    validation, host apply after at least one successful file, repository-evidence
    preparation, and completion/review-gate preparation. Each case persists
    one exact `post_submission_execution_failed` stage, performs no second model
    submission, preserves separate host evidence, and requires acknowledgement of
    possible prior and partial local work. Local-change review and possible-
    submission acknowledgement are separate typed actions and neither changes
    immutable delivery.
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
39. Lease expiry/recovery races before the first host replacement, between two
    replacements, and after the final replacement before evidence/finalization.
    The resource fence prevents actionable recovery while stale effects run; a crash
    after replacement/before outcome yields ledger `unknown` and mandatory
    fingerprint-bound working-tree review.
    The same result is required when the live owner catches failure or ownership
    loss on the `applying → applied` persistence step; it cannot terminalize until
    it durably maps uncertainty to `unknown`.
40. Process death after every post-submission stage and finalizer rollback proves
    monotonic effect intent preserves possible-local-change guidance even when the
    primary terminal code is lease/worker loss. No new run starts until quiescence
    and required host review are proven.
41. A sibling `awaiting_review` races a later packet/packet-free/handoff-only claim,
    packet recovery, and its review decision in both orderings. Package locks keep
    task `running`, suppress recovery actions, and start no later specialist until
    mandatory review completes.
    Repeat with terminal sibling host/repository `review_required`: the materialized
    task barrier blocks all three claim modes and every repository read until exact
    review or quarantine resolves the matching fingerprint.
42. Duplicate action, exact replay, one-time resolution, success repair, and gate
    decision races acquire host ledgers/entries, all artifacts, action rows,
    integrity alerts/resolutions, and gates in the complete tail without deadlock.
43. Every normal packet retry, acknowledgement, reapproval, S2 refresh, and generic
    promotion rejects both integrity-hold reasons. Authorized repair requires the
    exact alert fingerprint, writes one resolution, and cannot rewrite evidence;
    only mismatch adjudication may cancel/close without retry. Unauthorized/stale
    attempts leave the hold unchanged.
44. Pre-transaction completion preparation failure persists its exact closed
    stage; a gate insert/finalizer transaction failure fully rolls back and
    persists no `completion_preparation` cause.
45. A packet read and host apply race project root repoint, unregister, recursive
    delete, and reuse by a second project. Run-lifetime resource fencing plus the
    pinned revision yields one owner; the management loser waits/retries or
    conflicts without reading, deleting, or overwriting the other repository.
46. Root repoints and two-root swaps acquire old/new resource refs in both byte
    orderings without deadlock. Crash after typed delete intent and after host
    cleanup is recovered exactly or enters bounded manual repair; no claim starts
    during maintenance.
47. Kill the per-run execution child, queue worker, protected host fence service,
    and control channel first, last, and simultaneously while ACP/validation descendants,
    use nested spawn/`setsid`/double-fork equivalents, and ignore normal
    termination. Recovery remains actionless until the operating-system
    containment adapter proves the complete per-run group empty. Normal success
    releases without terminating the queue worker. A fresh same-host W2 is pinned
    as recovery owner and locks W1/W2 ascending; a different, missing, stale,
    divergent-key, insufficient-adapter, same-ID takeover, or unreachable W2 is
    alert-only and cannot terminalize.
    Wrong-host recovery covers both `not_started` (run/package pin only) and
    `active|quiesced` (run/package pin plus intent host) without reading a field
    absent from the union.
48. Exhaustive assembly/delivery/terminal/effect/ledger/host-review/repository-
    review fixtures prove the two normative tables, stage equality, fingerprint
    equality, no terminal `active`, the disjoint no-local-stage/with-local-stage
    success branches, success only with unchanged/not-applicable repository
    evidence, and no successful row with `planned|applying|unknown`. PostgreSQL
    constraint, finalizer, repair, parser, API, and S5 results agree.
49. Activation and every later claim reject zero, unregistered, multiple, stale,
    draining, incompatible, wrong-host, divergent-binding-key, and undrained
    worker/root-writer registrations. One fresh single-host capability set
    succeeds, exact instance IDs are pinned, and the immutable activation audit
    reproduces the decision.
50. A true audit/artifact mismatch cannot satisfy verified success or failure.
    Only exact privileged `quarantined_abandoned` closes the package/task, leaves
    immutable evidence and the alert intact, writes one resolution, and exposes no
    retry. A sibling with unknown host changes or changed/unverifiable ACP effects
    keeps root management blocked until the resolution binds its exact reviewed or
    abandoned evidence. Stale, duplicate, unauthorized, or active-sibling attempts
    do nothing.
51. Two create/clone requests race one nonexistent destination, alias/case forms,
    a symlinked parent, and existing/nonexistent ancestor/descendant destinations
    in both orderings. Crash at `planned`, materialized, physical-fence, and
    bind boundaries. Only the reservation winner creates/binds; cleanup requires
    matching token and physical object identity and never deletes a reused path.
52. Archiving/tombstoning a normal and `quarantined_abandoned` project atomically
    cancels every nonterminal task/package with `project_removed`, releases only
    the live path/root hierarchy binding, and leaves every task, package, run,
    audit, artifact, action, alert, resolution, and project `rootRef` queryable.
    Queued wakes and all three claim modes do nothing; hard delete fails.
53. Genuine legacy project POST/PUT/DELETE writers operate only before the cutover
    maintenance barrier. Disabled ingress plus v1 database-role revocation/session
    termination and service drain then prevent a restarted old route from reading
    a path before filesystem work. The root trigger is enabled only afterward,
    rejects root mutations while epoch 1, and accepts only registered v2 writers
    after exact activation; it never calls the S3 TypeScript reconciler.
    New writer routes prove the exact registered instance, credential generation,
    and maintenance/reservation token.
54. Seed legacy approvals with no root-at-decision evidence, including repoint and
    repoint-away/back history. Root binding never makes them issuable; explicit
    reapproval on the locked current revision is required.
55. An ACP runtime changes the repository before Forge's first local stage and
    then succeeds, fails, or leaves submission uncertain. Changed or unverifiable
    baseline comparison can never succeed, requires exact review, and blocks retry,
    reapproval, new run, repoint, tombstone, and path reuse. Only the exact
    `review_local_changes` or privileged quarantine transition may cross its own
    fingerprint barrier.
56. Host-binding-key backup/rotation disables issuance/root management, drains all
    instance kinds, proves containment/effects/reservations quiescent, creates
    active-K1/pending-K2 rotation state, crash-tests every shadow-rebind batch and
    complete-set verification, and atomically promotes K2/credentials before
    reactivation. No mixed set or simultaneous K1/K2 authority becomes visible.
57. Reservation planning, materialization, cleanup, and binding lock epoch → exact
    fresh root-writer instance → hierarchy guard → reservation. Activation, drain,
    and rotation races reject stale, draining, unregistered, wrong-key, or wrong-
    generation writers before filesystem work and after materialization.
58. Rootless `localPath:null` project creation succeeds after epoch 2 only with the
    complete binding/maintenance set null and grants no filesystem authority.
    Partial state fails; later local-root attachment uses the full reservation and
    hierarchy protocol.
59. The versioned repository scanner never follows symlinks or opens FIFO/socket/
    device entries, remains within file/byte/depth/time bounds for huge/churning
    trees, fails preflight before exposure when baseline proof is impossible, and
    produces post-exposure `unverifiable` plus exact review otherwise.
60. Unauthorized service socket calls, peer mismatch, state mutation/deletion,
    service `SIGKILL`, stale/cross-run token replay, and corrupt-state restart never
    release or reuse a root; they create protected orphaned/disabled state.
61. `submission_failed + changed|unverifiable` in both grant modes first exposes
    only `review_local_changes`; after exact review, immutable delivery remains
    `submission_failed` and the correct reapprove/retry action becomes eligible.
62. Unbound revision `0`, initial binding, legacy expansion-window path changes,
    and repoint-away/back strictly increase by compare-and-set; no command resets
    a revision or makes a legacy decision issuable.

Real PostgreSQL owns transaction, lock, lease, migration, index, and failure-injection evidence. Lease tests compare against database time, not a fake worker clock. #181 composes a small cross-slice sentinel set from these tests instead of maintaining a second policy implementation.

## Additive migration, cutover, and rollback

The claimed uniqueness guarantee is valid only after legacy packet issuers are drained. Deployment order is therefore part of the architecture:

1. **Expand schema.** Add a nullable project `root_ref` UUID with
   `DEFAULT gen_random_uuid()` and a unique index; additive root-binding revision
   with explicit unbound default `0`,
   opaque host-resource/host identity and binding-key fingerprint,
   root-maintenance/archive audit fields, the live-only partial uniqueness and
   hierarchy-claim/guard constraints, pre-create reservation table with writer
   pins, task-local-change barrier fields, key-rotation rows, and typed worker/root-writer
   capability/heartbeat registry;
   nullable protocol-v2 nonce/revision/claim/snapshot fields, the exact partial
   indexes, host-apply ledger/entries, append-only issuance-recovery action and
   integrity alert/resolution tables with their unique keys, the protocol epoch
   singleton, package claim-protocol/instance/recovery columns, repository baseline/change
   evidence, and the rejecting package-transition trigger. Do **not** enable the
   project-root trigger while legacy project routes remain live. New
   projects receive a random reference at creation. Backfill existing
   projects in bounded, restartable batches with database-generated random UUIDs.
   Keep the default through the whole mixed-version window so an old project writer
   cannot insert a new null after the backfill scan. Verify every project is
   populated, then make `root_ref` non-null before any v2
   preview/evidence producer is enabled. Do not rewrite legacy approvals with
   synthetic nonces. Do not reinterpret required legacy zero/default audit
   columns as a truthful packet snapshot.
   `host_resource_ref` remains nullable during expansion because PostgreSQL cannot
   safely canonicalize host filesystems. Install the dry-run-only form of the
   checked-in host command and layman-readable procedure
   `docs/operators/project-root-binding-v2.md`; applying it is a post-drain cutover
   step below, never a live legacy bridge.
2. **Deploy dual readers.** Readers understand v1 and v2. Every legacy filesystem
   approval without a stored root-binding revision is non-issuable and requires
   explicit reapproval; current-path inspection is never historical authority.
   Legacy audit rows without a typed assembly snapshot render as `unknown_legacy`,
   never `not_assembled` or invented zero counts.
3. **Deploy v2 writers disabled.** New workers can write/read v2, while the durable
   epoch remains 1 and packet issuance stays disabled. Verify every package claim
   mode uses the shared protocol primitive and traverses the `running`-transition
   trigger before executor work. Deploy the v2 root routes and protected fence/
   containment services disabled. Continue recording expansion-window project
   changes for the later canonical S3 reconciliation; no PostgreSQL trigger calls
   TypeScript or attempts project → epoch → task locking.
4. **Drain legacy issuers and root writers.** Disable project-management ingress;
   stop and drain every worker or web/
   management process already past a new trigger, including genuine pre-trigger
   processes; revoke the v1 web database role/credential and terminate its sessions.
   A process-local flag alone is not proof that another old process is absent.
   Under the canonical S3 order, reconcile every project changed during expansion.
   Then run
   `npm run project-roots:bind-v2 -- --actor <operator-id> --apply`; it derives and
   hierarchy-fences roots outside database locks, compare-and-sets host/key/
   hierarchy state and the next positive revision, and never upgrades legacy
   approvals. Duplicate, alias, ancestor/descendant, or unbound rows remain held.
   With ingress still disabled, enable the project-root trigger; at epoch 1 it
   rejects root mutation rather than invoking S3.
5. **Cut over.** Start only v2-capable workers, verify no v1 claim remains, then
   run the checked-in `web` maintenance command
   `npm run protocol:activate-work-package-v2 -- --actor <operator-id>`. Its
   default dry run reports every blocker; `--apply` verifies `READ COMMITTED`,
   executes the privileged three-statement activation, is idempotent, verifies
   epoch/postconditions, and retains the database activation audit. The
   layman-readable procedure is
   `docs/operators/work-package-protocol-v2-cutover.md`; ad hoc SQL is forbidden.
   Before `--apply`, the command requires exactly one fresh active host and proves
   every registered worker/root writer uses the one binding-key fingerprint and
   supports the host fence service plus non-escapable operating-system containment
   adapter; all stale, incompatible, divergent-key, legacy, and other-host instances
   require audited drain evidence. It snapshots those rows in the activation audit.
   Install the
   checked-in integrity inspect/repair commands and runbook. Missing capability,
   authoritative host identity, drain evidence, or runbook is a cutover blocker.
   It records the new root-writer credential generation and exact v2 ingress owner;
   only after commit may project-management ingress be enabled. It also requires
   every live local project to have a positive non-overlapping root
   binding/fingerprint, no root-maintenance intent or unresolved reservation/
   rotation, and
   retained audit from the binding command. Legacy approvals remain held.
   Run exactly
   `npm run protocol:activate-work-package-v2 -- --actor <operator-id> --apply` to
   advance the durable epoch;
   `project-roots:bind-v2` never does so. Only after activation commits may the
   operator enable registered S3/root writers and project ingress. Enable packet
   issuance last. Shared-first v1 package claims cause activation to abort;
   activation-first rejects stale v1 package claims before repository reads.
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
required, disable packet issuance and root management, ask the host fence service/
containment adapter to prove every active group empty, terminalize or integrity-
hold every active effect intent, drain v2 workers and root writers, and keep both
paths disabled until v2-capable processes with the same host identity,
host-binding-key fingerprint, containment/fence protocol, and ledger protocol are
restored. Rollback never reenables a legacy hard-delete or root writer.

## Implementation order

1. Land #178's decision revision and operator-hold contracts.
2. Add only the expand schema/backfill, exact indexes, root-binding/reservation/
   tombstone protocol, worker/root-writer capability registry, host-apply ledger,
   repository baseline/change review, issuance-recovery action/integrity tables,
   database-default root-reference lifecycle, worker/root-writer protocol barriers, and legacy
   readers. Do not register the destructive root scrub in the ordinary pending
   migration chain yet.
3. Add the shared all-mode protocol-v2 package claim, integrated packet claim,
   combined heartbeat, packet-recovery candidate guard, sibling task-state
   reconciler, and top-down stale/partial-state repair behind a disabled gate.
4. Add instruction projection and structured serialization with native system-role
   policy for role-preserving adapters and explicitly non-enforcing flattened
   guidance for ACP.
5. Replace executor capability merge/gating copies.
6. Acquire the resource fence before any repository read; stage typed assembly
   metadata before exposure; add the host fence service and operating-system
   containment adapter, root-management integration, monotonic effect intent,
   per-entry apply ledger, and quiescent same-host
   recovery; then atomically
   finalize the run/package/lease, audit, artifacts, action/marker, gates, and task
   disposition while holding the fence.
7. Add race, restart, injection, migration, mixed-worker, rollback, and failure-point tests.
8. Add the checked-in activation command and operator runbook, exercise the real
   command under both bridge-trigger orderings and a genuine pre-trigger worker,
   and retain its database audit as release evidence.
9. Drain legacy issuers and web/root writers and activate the durable protocol barrier before #180
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
Also stop if a sibling under mandatory review can be bypassed; if any normal route
can clear an integrity hold; if a true mismatch has no evidence-preserving terminal
quarantine; if the complete host-ledger/artifact/action/integrity/gate lock tail
cannot be preserved; if the canonical physical root cannot be fenced from before
its first read through descendant quiescence; if project management can bypass the
same fence; if current-host identity or single-host activation capability cannot
be proven; if terminal/effect/ledger compatibility cannot be enforced; or if an
unknown/partial host apply can expose retry without fingerprint-bound working-tree
review. Stop if nonexistent-root creation lacks a namespace reservation; if a
project deletion can cascade immutable evidence; if an exact fresh registered
worker/root-writer and binding-key fingerprint are not enforced after cutover; if
containment emptiness cannot be proved; if unconfined ACP changes are undetected or
unreviewed; or if quarantine can remove a sibling repository-review barrier.
