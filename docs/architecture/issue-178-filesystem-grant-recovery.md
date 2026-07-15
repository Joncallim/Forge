# Issue #178 Architecture: Deterministic Filesystem Grant Recovery

Status: round-3 architecture proposal for implementation review; this primary
document is authoritative for S3

Issue: #178
Parent: #172
Depends on: #176, #177
Release prerequisite: #179 Step 0 only (the separately landable project-removal
bridge, full project-management-ingress closure, old-process/session drain,
retention-safe foreign keys, database hard-delete guard, shared release-order
manifest/validator, and the complete signed release-evidence bootstrap described
below)
Canonical policy: `docs/adr/0009-mcp-admission-contract.md`

Related slices: [#179](https://github.com/Joncallim/Forge/issues/179) owns the
separately landable Step 0 safety bridge, shared release-order contract, generic
signed evidence/consumption substrate, and disabled enablement state and, after
S3 lands, the remaining packet issuance and evidence work.
[#180](https://github.com/Joncallim/Forge/issues/180)
owns presentation, and [#181](https://github.com/Joncallim/Forge/issues/181)
owns the cross-slice regression.

## Objective

Make required bounded-filesystem denials, revocations, and missing grants recoverable operator decisions rather than execution failures. A package that cannot proceed because of filesystem context must be held before claim, consume no execution attempt, preserve task actionability, and recover identically regardless of which grant endpoint the operator uses.

## Non-goals

- No live MCP handle issuance.
- No context packet assembly or runtime-audit claim lifecycle; #179 owns that.
  S3 does own the grant endpoint transaction that rotates an `allow_once` nonce,
  so it must leave the transaction in the global lock order #179 consumes.
- No operator UI redesign; #180 owns presentation.
- No broad work-package retry redesign.
- No second implementation of `readEffectiveGrantState`.

## Core invariants

1. **Admission owns the decision.** Recovery reads the canonical S1/S2 decision and never parses human text.
2. **Held is not failed.** Filesystem grant blocks leave the package `blocked`,
   return the task to `approved` only when no sibling owns an execution lease or
   awaits mandatory review, and leave execution attempts unchanged. A task remains
   `running` while either task-wide barrier exists.
3. **Decision order is database order.** A later project `always_allow` may
   supersede an older local denial only when its monotonic
   `grantDecisionRevision` is greater and it covers the exact required set.
   Human timestamps are display fields, never precedence inputs. Every decision
   also binds the project's internal root-binding revision. A project root repoint
   makes older coverage `revoked`; stable public `rootRef` correlation never
   carries authority to a different repository.
4. **Revoked is distinct.** Previously available project coverage that no longer satisfies the package is `revoked`, not first-time `none`.
5. **One project reconciliation routine.** Task-level and project-level
   `always_allow` mutations call the same project-wide service. Package-local
   decisions share its evaluator and lock order. They never evaluate or mutate a
   sibling's grant state, but they prelock the complete sibling set when their
   target package can change task status.
6. **One lock order.** S3 uses the first four families in ADR 0009's
   [canonical machine-readable lock-order list](../adr/0009-mcp-admission-contract.md#canonical-cross-slice-database-lock-order):
   project → tasks ascending → packages ascending → the canonical
   `grant-approval-decision-rows:id-ascending` family. That family locks immutable
   decisions by ID and then the exact preallocated current-decision pointer. As its
   first implementation artifact after Step 0, S3 materializes
   the ADR object exactly at
   `web/lib/mcps/mcp-admission-lock-order-v2.json` and provides the one shared
   ordered-subsequence validator. #179 imports both and owns no copy or helper.
   S3 normally stops at that family and does not acquire the epoch row. A
   mutation may omit an inapplicable family only as an ordered subsequence; it may
   never reorder the families it does acquire.
7. **No stale whole-JSON writes.** Owned JSONB paths are patched atomically or protected by explicit compare-and-retry.
8. **No automatic retry.** A filesystem grant block requires operator action.

## Proposed domain contracts

### Canonical filesystem hold state

The filesystem projection and durable marker use the same closed tagged union.
There is no second persistence shape and no independently writable
`deniedRequired` boolean:

```ts
type CanonicalPositiveDecisionRevision = string & {
  readonly __canonicalPositiveDecisionRevision: unique symbol;
};

type FilesystemGrantRevocationReason =
  | 'project_grant_removed'
  | 'project_grant_narrowed'
  | 'project_root_repoint';

type FilesystemGrantHoldState =
  | {
      holdKind: 'approval_required';
      grantPhase: 'none' | 'proposed' | 'not_issued';
      grantConsumed: false;
      grantDecisionRevision: null;
      revocationReason: null;
    }
  | {
      holdKind: 'denied_required';
      grantPhase: 'denied';
      grantConsumed: false;
      // null is accepted only from the exact legacy adapter; every v2 writer uses
      // a canonical positive decimal revision.
      grantDecisionRevision: CanonicalPositiveDecisionRevision | null;
      revocationReason: null;
    }
  | {
      holdKind: 'revoked_required';
      grantPhase: 'revoked';
      grantConsumed: false;
      grantDecisionRevision: CanonicalPositiveDecisionRevision;
      revocationReason: FilesystemGrantRevocationReason;
    }
  | {
      holdKind: 'consumed_once';
      grantPhase: 'approved';
      grantConsumed: true;
      grantDecisionRevision: CanonicalPositiveDecisionRevision;
      revocationReason: null;
    };

type FilesystemGrantProjection =
  | {
      blocked: false;
      kind: 'not_required' | 'optional_without_context' | 'approved';
      requestedCapabilities: FilesystemProjectCapability[];
    }
  | ({
      blocked: true;
      requestedCapabilities: FilesystemProjectCapability[];
      recoveryAction: 'approve_project_filesystem_context';
      taskDisposition: 'operator_hold';
    } & FilesystemGrantHoldState);

type FilesystemGrantBlockMetadata = {
  schemaVersion: 2;
  kind: 'filesystem_grant';
  source: 'filesystem-grant-approval';
  taskDisposition: 'operator_hold';
  autoRetryable: false;
  terminalFailure: false;
  requirementKeys: string[];
  requestedCapabilities: FilesystemProjectCapability[];
  recoveryAction: 'approve_project_filesystem_context';
  blockFingerprint: string;
  blockedAt: string;
} & FilesystemGrantHoldState;
```

`requiresFilesystemGrantApproval` derives exactly one
`FilesystemGrantHoldState` from the canonical admission result. The marker writer
persists that exact object; it may not rebuild individual fields. The runtime
parser is strict: it rejects unknown keys, non-canonical or non-positive revision
strings, and every phase/consumption/revision/revocation cross-product not shown
above. In particular, `consumed_once + denied`, `consumed_once + false`, and
`revoked_required + null revocationReason` are invalid. The TypeScript union, SQL
`CHECK` constraint over the JSON fields, and runtime parser share an exhaustive
valid/invalid fixture table. Human reason text never participates in this union.

The marker remains under `FILESYSTEM_GRANT_BLOCK_METADATA_KEY`, never
`metadata.mcpBroker`. `autoRetryable:false` excludes automatic Redis retry;
`terminalFailure:false` and `taskDisposition:'operator_hold'` make the task
nonterminal. The handoff result must not reuse the existing `terminalBlock` flag,
because current orchestrator paths interpret that flag as task failure.

`blockFingerprint` is a versioned digest of the normalized requirement keys,
exact required capability set, the canonical hold-state tuple, and root-binding
revision. It excludes
human reason text and timestamps. Recovery compares the fingerprint under lock,
so a stale grant response cannot clear a block created for changed policy. #180
uses the structured fields for copy and treats the fingerprint as an opaque
freshness value; it does not recompute policy in the browser.

## Handoff state transition

### Before claim

`filesystemGrantHandoffBlock` must evaluate both branches using:

- current locked package policy;
- current project MCP configuration;
- captured health observation where relevant;
- exact required bounded filesystem capabilities.

If the canonical projection is blocked:

```text
package pending | ready → blocked
task    running         → approved only with no live sibling lease or `awaiting_review`
task    running         → running while either task-wide barrier remains
```

Effects:

- write/update the filesystem grant block marker;
- do not create `agent_runs`;
- do not increment task attempts;
- do not invoke packet assembly;
- in the same transaction, keep an already-`approved` task approved or compare
  and set `running → approved` only after locking sibling packages in ID order and
  proving none has a live execution lease or `awaiting_review`;
- return `taskDisposition:'operator_hold'` to `progressWorkforce`.

`progressWorkforce` and the orchestrator must distinguish this hold from a
terminal implementation failure. The canonical nonterminal task state is
`approved`. This matches the task grant endpoint's editable states and gives the
operator a reachable reapproval action. A task remains `running` when a different
package has a current execution lease **or** is `awaiting_review`; the latter is a
mandatory task-wide barrier even after every lease clears. S3 and S4 share one
operator-hold task-convergence service. Its closed marker union includes at least
S3 `filesystem_grant` and S4 `packet_issuance`/integrity hold markers; it never
requires an S4 marker when a valid S3 marker exists. Under project → task → all
sibling package locks, it validates at least one recognized hold, proves that no
sibling has a live execution lease or `awaiting_review`, and compare-and-sets only
task `running → approved`. It preserves every package marker and `blocked` status,
creates no run or attempt, and performs no Redis or external work in the
transaction. S3's terminalization path, sibling completion or review-gate
resolution, worker startup, and periodic recovery all invoke or enqueue this same
service. Redis is only a wake hint; the database scan is the loss-tolerant
fallback. S3 may expose a wrapper, but it must not duplicate or weaken the shared
predicate.

### Optional fallback

An optional requirement with `continue_without_mcp` stays non-blocking even if the effective phase is denied or revoked. This path must produce no bounded context and no filesystem-grant hold marker.

## Effective grant precedence

`readEffectiveGrantState` remains owned by `admission.ts`.

Every filesystem grant mutation increments a positive, project-scoped PostgreSQL
`BIGINT` counter while the project row is locked. JSON and API snapshots serialize
`grantDecisionRevision` as a canonical base-10 string; code compares parsed
database integers, never JavaScript numbers or lexical strings. The current
revision is retained even when the active project grant is removed. Every
package-local approval, denial, or reapproval appends a new immutable row to the
approval-decision relation; an active project grant likewise retains the immutable
decision that created or changed it. The existing
`filesystem_mcp_grant_approvals` relation therefore becomes append-only rather
than using one mutable row per work package. Runtime-audit and consumption foreign
keys continue to name the exact historical decision row they observed. The
migration removes the old one-row-per-package unique constraint from the decision
history, adds the pointer's package-scope uniqueness, and installs a database
trigger that rejects update/delete of every committed decision row.
`approvedAt` and `deniedAt` remain useful operator evidence but are never compared
for authority.

Current package authority lives in a separate
`filesystem_mcp_current_decision_pointers` relation with exactly one row per
package decision scope. Package creation and bounded legacy backfill preallocate
that row with a null decision; concurrent writers never race to insert the
authority slot. Its immutable decision foreign key, expected prior
decision ID, expected prior revision, expected pointer fingerprint, and pointer
version form the compare-and-set boundary; the reader joins through this pointer
and never infers current authority from the newest timestamp or largest row ID.
An initial decision appends `D1` and compare-and-sets an empty pointer to `D1`.
Each explicit reapproval allocates both a fresh project-serialized positive
revision and a cryptographically fresh package-local nonce, appends `Dn`, and
compare-and-sets the pointer from the exact prior tuple to `Dn` in the same
transaction. It never updates or deletes `D1..Dn-1`, reuses a consumed nonce, or
changes an audit foreign key. Two reapprovals starting from the same pointer have
one winner: the loser's append and pointer change roll back, then the loser must
reread and obtain explicit operator intent for the new current decision instead
of silently creating a second live approval.

Every filesystem decision also stores the positive decimal
`rootBindingRevision` from the locked project. `readEffectiveGrantState` accepts a
decision only when that revision equals the project's current internal binding.
An unbound project has the one explicit internal revision `0`, which is never
issuable and never serialized as decision authority. Project root creation or
backfill compare-and-sets the locked counter to its next positive value; a normal
first binding therefore becomes revision 1, while no writer ever forces, resets,
or decrements the counter. Binding must never add that revision to a pre-v2
approval. The current schema contains no
immutable root identity captured when a legacy approval was made, so observing
today's path cannot prove what that approval originally authorized. Every legacy
decision without a stored binding revision remains non-issuable until an explicit
operator reapproval records the current locked revision. An unbound or
duplicate/aliased root also fails closed. A later repoint increments the binding
revision and invokes the same negative project reconciler under project → tasks →
packages → approval-decision rows → current-decision pointers locks, marking prior
project and package coverage `revoked` and holding affected unclaimed packages.
The new root requires an explicit
operator decision. No timestamp, current-path comparison, or stable `rootRef`
substitutes for this authority boundary.

Precedence for the exact package-required capability set is:

1. A current project-level grant is `approved` when it covers the full required
   set and no newer package-local denial exists. It supersedes a local denial only
   when the project grant's revision is greater than the denial revision.
2. A valid unconsumed package-local `allow_once` is `approved` only for that
   package. It never triggers a project scan. When current project coverage
   already wins, the endpoint returns the inherited project result and does not
   create a shadow one-time issuance decision.
3. A consumed `allow_once` is `approved` with `consumed:true` at the reader
   contract and becomes a hold in the filesystem projection.
4. A package-local denial wins when its revision is greater than or equal to the
   active project grant revision, or when no covering project grant exists.
5. A formerly covering project grant that was removed or narrowed is `revoked`,
   carrying a bounded `revocationReason` and the latest decision revision.
6. Never-approved remains `none` or `proposed` and uses first-time approval copy.

The reader evaluates coverage against `requiredCapabilities`, not the original
grant breadth. A legacy denial/project pair without comparable revisions is
ambiguous and fails closed as denied/reapproval-required; migration must not use
wall-clock timestamps to manufacture an ordering decision. Explicit operator
reapproval assigns the first comparable revision.

## Shared reconciliation boundaries

Create one server-side project reconciliation service, suggested location:

```text
web/lib/mcps/filesystem-grant-reconciliation.ts
```

It operates on state already locked by the endpoint:

```ts
async function reconcileFilesystemGrantsForProject(
  tx: DbTransaction,
  input: {
    lockedProject: LockedProject;
    nextMcpConfig: ProjectMcpConfig;
    grantDecisionRevision: string;
    trigger:
      | 'task_always_allow'
      | 'project_always_allow'
      | 'project_grant_revocation'
      | 'project_root_repoint';
    actorId: string;
  },
): Promise<FilesystemGrantReconciliationResult>;
```

The service must not reacquire the project lock or reread a pre-transaction
project object. It owns candidate selection, complete task/package lock-set
expansion, stable locking,
canonical reevaluation, narrow metadata updates, and a deduplicated list of task
IDs to wake after commit. Equivalent `always_allow` decisions made through the
task and project endpoints therefore recover the same package set.

`allow_once`, package-local denial, and package-local reapproval are deliberately
outside this project-wide scan. They use a package-scoped mutation path under the
same global lock order and can hold or recover only the targeted package. If the
target can change its task's status, the path still discovers and prelocks every
sibling before its first package lock; package scope limits evaluation and writes,
not the lock footprint needed for a task-wide predicate. An
`allow_once` decision and its nonce remain package-local even when several
packages request an identical capability.

## Transaction and lock architecture

S3 uses this prefix of the cross-slice global order:

```text
project → affected tasks (ID ascending) → affected packages (ID ascending)
        → grant-approval-decision-rows:id-ascending
          (immutable decisions by ID, then the exact preallocated current pointer)
```

S3 grant mutations normally stop after the
`grant-approval-decision-rows:id-ascending` family. #179 owns the remaining
applicable families in ADR 0009's
[canonical machine-readable lock-order list](../adr/0009-mcp-admission-contract.md#canonical-cross-slice-database-lock-order),
including authenticated worker/root-writer instance rows and local-run-evidence/
task-projection current-head rows in the exact family
`local-run-evidence-task-projection-heads:id-ascending`. S3 creates the initial
exact runtime materialization
at `web/lib/mcps/mcp-admission-lock-order-v2.json` plus a shared validator in
`web/lib/mcps/mcp-admission-lock-order.ts`. The validator imports only the JSON
object and standard-library types, deriving its family type from that object; it
has no import from an S4 audit, packet, evidence, producer, or recovery symbol. It
rejects unknown or duplicated families, reverse edges, and any declared
transaction sequence that is not an ordered subsequence. Every S3 mutation and
every later #179 path imports this validator rather than defining another sequence
or helper. A parity test parses the ADR 0009 JSON block and requires exact object
equality with the checked-in runtime JSON before either slice can land.
No path may acquire package before task, approval before package, run/audit before
approval, or artifact before the audit it summarizes. A stale-audit sweeper that
needs a package must first discover candidates without retaining row locks, then
reacquire every required row in the complete #179 order and use a compare-and-set
predicate before changing state.

### Mutation transaction

1. Authorize without treating that read as persistence input.
2. Start a transaction and lock the project row `FOR UPDATE`.
3. Increment/read the project row's `BIGINT` counter, serialize the new positive
   `grantDecisionRevision` as a canonical decimal string for snapshots, and build
   `nextMcpConfig` from the locked value.
4. Determine candidate package IDs without retaining package locks. Derive every
   task whose status may change and lock that complete task set in ascending ID
   order. Revalidate the candidate-task set; if it now contains an unlocked task,
   roll back and retry from the project lock rather than appending a late task lock.
5. While those task locks are held and **before the first package lock**, expand
   the package lock set to the union of every sibling belonging to those tasks.
   Lock that complete set once with one ordered `SELECT ... ORDER BY id FOR
   UPDATE`. Package creation must take its task lock; reparenting must take both
   old/new task locks in ascending ID order. Membership therefore cannot grow
   behind this acquisition; a changed candidate or membership
   predicate causes a full compare-and-set retry from the project lock. Never lock
   a target package and then discover a lower-ID sibling.
6. Lock the applicable immutable approval-decision rows in ID order, followed by
   the package's current-decision pointer. #179 follows this order when it consumes
   the nonce and retains the exact decision-row foreign key.
7. Append the new decision with its allocated revision and, for `allow_once`, its
   fresh nonce; compare-and-set the current pointer from its exact expected prior
   decision/revision/fingerprint to the new row. A failed compare-and-set rolls
   back both writes and requires reread plus explicit intent.
8. Reconcile the already-locked rows, including positive recovery and negative
   revocation/narrowing holds.
9. Commit.
10. Wake the deduplicated affected task IDs through Redis after commit.

There is no network, Redis, health probe, or other external work inside this
transaction. The project lock is acquired once and passed into reconciliation;
the service never nests or reverses it.

### JSONB ownership and compare-and-set

Grant mutation/reconciliation may own only:

- `metadata.mcpGrantPhases`;
- `metadata[FILESYSTEM_GRANT_BLOCK_METADATA_KEY]`.

It must not replace the full package `metadata` object. Prefer PostgreSQL
`jsonb_set` and `#-`. If the object-relational mapper cannot express the narrow
patch, use an explicit metadata version or `updatedAt` compare-and-set and retry
the whole locked evaluation. Clearing a marker requires the expected
`blockFingerprint`; a different fingerprint means policy changed and the
transaction must reevaluate rather than erase the newer hold.

Project MCP configuration mutation similarly derives from one locked source and
uses an exact update predicate. Disjoint grants and unrelated keys must survive;
a stale JavaScript spread is not an acceptable write.

## Reconciliation algorithm

For each locked candidate package, extract the current canonical requirement
keys and exact required filesystem capability set, call the S1-owned
`readEffectiveGrantState`, and project that one result through
`requiresFilesystemGrantApproval`.

Apply exactly one of these transitions:

1. **Now approved.** If the package is `blocked` by the matching v2 filesystem
   marker, clear that marker with its fingerprint compare-and-set, move the
   package to `ready`, preserve its attempt count, and return its task ID for
   post-commit wake-up. A bounded legacy failed package may take the same
   migration path described below.
2. **Now uncovered, denied, consumed, or revoked.** Write or refresh the v2
   marker from canonical inputs. A package still in `pending` or `ready` moves to
   `blocked` before claim. If its task is `running`, use the complete sibling set
   already prelocked before reconciliation and compare-and-set the task to
   `approved` only when none has a live execution lease or `awaiting_review`. No
   package lock may be added here. Do not create an agent run or consume an
   attempt.
3. **No longer requires filesystem context.** Clear only a matching filesystem
   marker and recover only a package whose status is proven to be owned by that
   marker. A generic MCP, security, dependency, or reviewer block remains intact.

If canonical inputs or the fingerprint changed after candidate discovery, retry
under the locks. Never infer recovery or revocation from human text.

S3 never clears #179's `packet_issuance` marker through this reconciler. The one
integration point is package-local one-time reapproval: after S3 rotates a fresh
nonce by appending a decision and advancing its current pointer under project →
task → every sibling package in ID order → the canonical approval-decision/current-
pointer family,
it calls #179's package-scoped resolver in the same transaction. “Package-scoped”
limits grant evaluation; the caller still prelocks every sibling so the task-wide
barrier is authoritative. The resolver then continues through the applicable
ordered subsequence of ADR 0009's canonical version-2 list. For this route that
includes the applicable authenticated worker/root-writer claim/recovery
instances, binding generation/rotation, hierarchy guard, prior run, local-run
evidence and the exact
`local-run-evidence-task-projection-heads:id-ascending` family before any optional audit, ledger,
artifact, action, alert/resolution, or review-gate row. It proves the generic
evidence, working-tree, Git-control, and Git-storage review
fingerprints,
host review, task projection, and any packet audit/artifact terminal tuple are
coherent before it compare-and-sets the exact `reapprove_allow_once` packet
marker/fingerprint, changed nonce, current policy, and inactive lease. It clears
only the packet marker. If `local_effect_recovery`, any exact local review, or the
task projection remains unresolved, the package stays `blocked`, no task is woken,
and no new run is eligible. Only when every independent barrier is clear may it
move `blocked → ready`. A stale marker, second reapproval, changed policy, active
claim, mismatched generic evidence, or unresolved review is a no-op/conflict.
Redis wake-up remains after the combined commit.

That projection family is a fixed current-authority set, not an append-only source
set. #179's shared `CURRENT_LOCAL_PROJECTION_HEAD_KINDS` contains exactly
`local_run`, `local_recovery`, `packet_recovery`, `repository_review`,
`host_apply_review`, `operator_hold`, `integrity`, and `terminal_disposition`.
Package creation/backfill preallocates exactly one head per kind: eight rows per
package and exactly 2,048 rows at the 256-package ceiling. Immutable source
history remains append-only outside projection cardinality. Each applicable
transition appends its history row and, in the same transaction, advances the
existing head count-neutrally by exact prior revision/foreign-key/fingerprint
compare-and-set. Acknowledgement, decline, quarantine, cancellation, repair, and
recovery must reuse these eight rows; no transition may insert a ninth head or
make the aggregate scan a growing history tail.

## Negative reconciliation and revocation

Removing or narrowing a project grant is a state transition, not only a config
edit. `project_grant_revocation` must scan packages whose effective decision came
from that project grant and proactively hold eligible `pending` or `ready`
packages that no longer have exact coverage. For example, narrowing
`read + list` to `read` leaves a read-only package eligible but holds a package
that still requires both capabilities.

`project_root_repoint` uses the same negative scan with a distinct bounded reason.
It carries the newly incremented root-binding revision, revokes every decision
bound to the prior root, and does not manufacture a new grant-decision revision or
change the ordering between otherwise unrelated grant decisions. Only later
explicit operator reapproval allocates new authority for the new root.

The negative transition writes the exact `revoked_required` union arm, including
`grantPhase:'revoked'`, `grantConsumed:false`, the canonical positive decision
revision, one closed `FilesystemGrantRevocationReason`, and a fresh fingerprint;
it never copies a raw operator reason. A package already running with a claimed
execution lease is not retroactively stripped of packet bytes. #179 owns the
per-run claim, issuance fence, nonce consumption, and stale-claim behavior.
Revocation governs the next claim and all packages not yet claimed.

Structured reason categories are:

- first-time: `approval_required`;
- explicit denial: `denied_required`;
- removed/narrowed project grant: `revoked_required`;
- used one-time decision: `consumed_once`.

Human copy belongs in #180; #180 must render these structured categories and
must not reconstruct precedence.

## Failed-package and marker compatibility

The v2 marker above is authoritative. During a bounded migration window, a dual
reader may also recognize the exact v1 marker
`{source:'filesystem-grant-approval'}` and upgrade it on the next safe mutation.
A historical `failed` package may be recovered only when that durable marker
proves the failure was filesystem-grant-related, or when a versioned,
fixture-backed legacy failure signature is converted once to the marker before
recovery.

The legacy signature must be exact, unable to match generic executor failures,
and removed or disabled after the declared support window. Legacy decision rows
without comparable revisions remain ambiguous and fail closed; migration must
not backfill ordering from timestamps. Requirements alone, an error substring,
or a human reason are never sufficient recovery evidence.

## Mixed-version rollout and rollback

S3 adds a new operator-hold disposition that an old worker cannot interpret, so
schema compatibility alone is not enough. Root-trigger installation and epoch
activation are cutover operations, not a live mixed-version bridge: PostgreSQL
must never try to call or duplicate S3's TypeScript reconciler. Roll out in this
acyclic order:

0. As the separately landable #179 Step 0, before S3 or retained-evidence
   expansion, disable **all project-management ingress**, drain every pre-bridge web
   process/database session, and deploy the bridge project-removal route that
   rejects or archives **before** filesystem work. Replace evidence-bearing project
   cascades with `RESTRICT|NO ACTION` and install the database hard-delete guard.
   Before recording its own graph receipt, run the separately reversible bootstrap
   that installs the pinned Ed25519 signer-key policy/audit, generic append-only
   immutable release-evidence store and append-only consumption ledger, checked-in
   verifier/recorder/consumer, dedicated certificate-authenticated `NOINHERIT`
   least-privilege recorder/consumer/transition principals, canonical transition-
   identity uniqueness, and the `disabled|provisional|active` enablement singleton
   initialized to `disabled`. The bootstrap is infrastructure, not a graph node;
   it records no receipt and advances no runtime state. An external lifecycle-valid
   Ed25519 signer must then record the empty-predecessor
   `step0_retention_bridge` receipt through that substrate. Keep every project-
   management ingress path closed after this checkpoint. This checkpoint has no
   dependency on #178 and can land on its own; S3 cannot materialize state or
   record `s3_issue_178` until the signed Step 0 receipt verifies.
1. After Step 0 is proven, land #178's project `BIGINT` decision counter plus
   nullable decision/root-binding revision and marker fields and the dual v1/v2
   reader. Do not emit v2 markers yet.
2. Only after #178 lands, continue #179's remaining expansion while every project-
   management ingress path remains closed. Add nullable `root_ref` with no default,
   then install both the database-owned explicit-null insert bridge and the omitted-
   value default. The update guard permits an existing null to remain null during
   backfill but rejects every non-null-to-null transition. Add the expand-phase
   `project_root_change_journal` with its simple monotonic
   `insert|root_update|archive` trigger enum. `root-update` is not an alias and is
   rejected by the database constraint and parser. Backfill and prove the
   `root_ref` invariants, journal, guards, and database tests before the one allowed
   mixed-version project-ingress reopen. Backfill unbound root revisions to `0`.
   Do not emit v2 markers yet. Every approval without a stored root-binding
   revision is non-issuable. The journal trigger calls no TypeScript and stays
   enabled during the single legacy-compatible ingress window.
3. After all step-2 safeguards and database tests pass, reopen compatible project-
   management ingress exactly once for the mixed-version journal window. No earlier
   or second reopen is permitted.
4. Later, disable packet issuance and **all** project-management ingress again.
   Revoke the v1 web/root-
   writer database credential, terminate its sessions, and drain/disable old web,
   worker, and root-management services. An old orchestrator could otherwise turn
   an operator hold into task failure; an old project route performs filesystem
   work before its database write and therefore cannot be fenced safely by a late
   trigger rejection.
5. Only after credential revocation and session termination, capture the journal's
   database generation as the post-drain watermark. Run exactly
   `npm run project-roots:reconcile-expansion -- --through <generation> --actor <operator-id> --apply`.
   The bounded, restartable command follows the canonical S3 lock order and records
   one audited negative-reconciliation outcome for every journal generation
   through the watermark; each generation's operation is exactly one of
   `insert|root_update|archive`. Hard delete is already impossible. A gap,
   duplicate/incoherent outcome, later
   legacy commit, or interrupted command blocks binding. Then use #179's checked-in
   `npm run project-roots:bind-v2 -- --actor <operator-id> --apply` procedure to
   compare-and-set each live local project to the next positive root revision. Do
   not upgrade any legacy approval. Collision/unbound rows and every decision
   without historical binding evidence remain held until explicit reapproval.
6. Install #179's protocol-v2 root barrier but keep S3/root writers, queue/project
   ingress, and packet issuance disabled. Deploy #180's compatible S5 consumers
   plus #181's disabled S6 controller/harness. The S6 controller must record
   `s6_pre_activation_green` for the exact build before activation is eligible.
7. Under #179's controlled-activation owner, run exactly
   `npm run protocol:activate-work-package-v2 -- --actor <operator-id> --apply`.
   The binding command never advances the epoch, and activation commits with
   ingress and issuance still disabled. #181's controller then records
   `s6_post_activation_green` for that committed epoch/build. Only that receipt
   allows #179 to enable registered S3/root writers and queue/project ingress;
   packet issuance is enabled last in the same audited operation.
8. Mark S5/S6 release-ready only after the post-activation receipt and audited
   ingress/issuance enablement. A S5 reader or S6 test never owns activation or
   enablement.
9. Remove the v1 adapter only after the supported migration window and evidence
   show no remaining v1 rows.

Rollback disables v2 writers and new claims but keeps the additive columns and
dual reader. It must not rewrite revisions, downgrade v2 markers to guessed v1
state, or restart an old worker against packages that already use the new hold
semantics. #181 owns the mixed-version and rollback regression matrix.

## Redis and failure truth

PostgreSQL is the source of truth; Redis only wakes work that is already
eligible. The transaction returns unique task IDs moved to `ready`. After commit,
enqueue each once using the existing approvals/workforce mechanism. A lost or
duplicate wake is harmless because the periodic sweep and conditional package
claim operate from PostgreSQL.

| Failure point | Durable result | Required response |
|---|---|---|
| Hold or revocation transaction fails | No partial marker/status/revision transition | Roll back; package remains in its prior state |
| Grant mutation commits, Redis wake fails | Grant and recovered `ready` packages remain committed | Retry wake or let the periodic sweep rediscover them |
| Policy/fingerprint changes during reconciliation | Newer policy remains intact | Compare-and-set fails; reread and reevaluate under locks |
| Revocation races handoff before claim | Lock winner defines one serial order | Either claim first under #179 fencing, or hold before claim; never both |
| Legacy decisions have no comparable revisions | No guessed precedence | Fail closed and require explicit operator reapproval |
| Generic execution or packet failure occurs | No filesystem recovery proof | Do not auto-convert, recover, or burn a new approval |

## Required tests

Use real PostgreSQL transactions for lock, revision, and JSONB behavior. At
minimum, prove:

1. Two disjoint simultaneous `always_allow` grants preserve their union and all
   unrelated project keys.
2. Reconciliation racing a broker/evidence metadata update preserves both owned
   paths; a stale fingerprint cannot clear a newer marker.
3. Task and project `always_allow` endpoints produce the same recovered project
   package set, while `allow_once`, denial, and reapproval affect only the target
   package. The first package decision appends `D1` and advances the empty current-
   decision pointer. Two sequential reapprovals append `D2` and `D3`, each with a
   fresh positive revision and never-reused nonce, and advance the pointer without
   changing `D1`/`D2` or their audit foreign keys. Two concurrent reapprovals from
   the same expected pointer produce exactly one committed new decision/pointer
   winner; the loser rolls back, rereads, and cannot create another live approval
   without fresh explicit operator intent. Consumption retains the immutable
   decision ID and cannot mutate history, move the pointer backward, or revive a
   consumed nonce.
4. Equal, reversed, and skewed display timestamps never change precedence;
   monotonic revisions do. A legacy pair without revisions fails closed.
   Root repoint increments the independent root-binding revision, revokes every
   old-root decision, and cannot expose the new root until explicit reapproval;
   canonical aliases resolve to the same binding. Seed legacy `allow_once` and
   `always_allow` decisions, including repoint-away-and-back history, and prove
   project binding cannot make any of them issuable without explicit reapproval.
5. Project grant removal and narrowing perform negative reconciliation: exact
   covered subsets stay eligible, uncovered `pending`/`ready` packages become
   blocked, and task `running → approved` occurs only without another live lease
   or sibling `awaiting_review`. Race both hold/revocation and post-review
   reconciliation against approval/rejection decisions in both lock orderings.
   Create an S3-only hold while a sibling lease is live and while a sibling is
   `awaiting_review`; after each barrier clears, prove both the direct post-commit
   callback and startup/periodic fallback use the shared recognized-hold service,
   change only task `running → approved`, preserve the marker/package block, and
   create no run, attempt, wake, or claim before explicit grant action. Repeat the
   shared predicate fixtures for S4-only and mixed S3/S4 holds.
6. Required denial/revocation/consumed-once holds create no `agent_runs`, consume
   no attempt, and write the bounded v2 marker and fingerprint. The projection and
   marker contain the same canonical hold-state arm; neither writer assembles
   independent phase or reason fields.
7. A covering grant moves only a matching filesystem-held package
   `blocked → ready`; generic blocks and changed-fingerprint blocks remain.
8. The v2 reader and exact v1 adapter work during rollout, while ambiguous legacy
   errors do not recover. Redis failure after commit is repaired by the sweep.
9. The ADR 0009 canonical version-2 lock order has no deadlock across S3
   reconciliation, #179 issuance, nonce rotation, local review, and stale claim
   recovery. One-time reapproval racing generic finalization/recovery in both
   orderings must show bounded waits with no deadlock; coexisting packet/local
   markers clear only through their owning actions. A parity mutation sentinel
   must fail when any family in the machine-readable list is deleted, renamed,
   duplicated, or swapped. Opposing-order PostgreSQL fixtures must force
   contention at both authenticated worker/root-writer instance → binding-
   generation and local-run-evidence →
   `local-run-evidence-task-projection-heads:id-ascending` boundaries and
   prove bounded completion without deadlock. An exact S3 PostgreSQL fixture gives
   one task a lower-ID unaffected sibling `P1` and a higher-ID affected target
   `P2`; one transaction performs the S3 target mutation while an opposing
   claim/review transaction contends from `P1`. Capture `pg_blocking_pids` to
   prove real waiting, and require both transactions to complete within the bound,
   with no deadlock and the task/package states satisfying the winning serial
   order. The fixture fails if S3 locks `P2` before discovering/prelocking `P1`.
   Preallocate the exact eight `CURRENT_LOCAL_PROJECTION_HEAD_KINDS` rows for every
   package and assert 2,048 heads at the 256-package ceiling. Acknowledgement,
   decline, quarantine, cancellation, repair, and recovery fixtures append their
   immutable history and compare-and-set an existing head without changing the
   row count; missing, duplicate, unknown-kind, or ninth heads fail closed.
10. Fresh one-time reapproval invokes only #179's package-scoped resolver; stale
    marker, double reapproval, policy drift, active-lease, and awaiting-review races cannot clear
    another block or wake before commit.
11. Mixed old/new worker gating and rollback retain operator-hold truth; an old
    worker cannot reinterpret a v2 hold as task failure.
12. Optional `continue_without_mcp` remains executable without a packet, revoked
    and first-time states remain distinct, and filesystem holds remain excluded
    from automatic retry.
13. The TypeScript type fixtures, strict runtime parser, and SQL `CHECK` fixtures
    exhaust the phase × consumed × decision-revision × revocation-reason cross-
    product for every hold kind. They accept only the four union arms above,
    including `proposed` and `not_issued`, and reject unknown keys,
    non-canonical/zero revisions, `consumed_once + denied`,
    `consumed_once + false`, `revoked_required + null reason`, and every other
    invalid tuple. No known state is normalized from reason text or silently
    mapped to another phase.
14. Before the expansion journal exists, the bridge route is killed/raced around
    the old filesystem/SQL boundary: removal conflicts or archives before `fs.rm`,
    direct SQL/cascades cannot delete evidence, and no old session survives. The
    fixture proves **all** project-management ingress closed before this checkpoint
    and still closed while S3 lands and remaining S4 installs and tests nullable
    `root_ref`, its omitted-value default, the explicit-null insert bridge, the
    non-null-to-null update guard, and the journal. Omitted and explicit-null
    inserts receive database-generated references; unrelated updates may preserve a
    legacy null, but a bound reference can never be cleared. Only after those
    database tests pass does the fixture permit exactly one mixed-version reopen.
    It rejects an early or second reopen, then proves the later full ingress close,
    credential/session drain, and only-after-drain watermark. The journal captures
    legacy `insert`, `root_update` (including repoint-away-and-back), and `archive`,
    and a transaction committing at each drain/watermark boundary. Reconciliation
    crash/resume proves every generation before binding, root-trigger enablement,
    or activation; no generation can be skipped by scanning only surviving rows.
    Its schema, SQL constraint, writer, and parser accept exactly
    `insert|root_update|archive`; a `root-update` mutation sentinel is rejected.
15. Before its own receipt or any S3 state, #179 Step 0 installs the complete
    generic authentication substrate: pinned Ed25519 signer keys plus singleton
    policy/change audit; an append-only immutable release-evidence store and
    append-only consumption ledger; the checked-in verifier, recorder, and
    consumer; dedicated certificate-authenticated `NOINHERIT` least-privilege
    recorder, consumer, and transition principals; canonical transition-identity
    uniqueness; and the singleton `disabled|provisional|active` enablement row
    initialized to `disabled`. The bootstrap is not a graph node, creates no
    unsigned receipt, imports no S3 or remaining-S4 code, and cannot advance
    enablement. #179 Step 0 also solely creates and versions the data-only
    `web/lib/mcps/epic-172-release-order-v1.json` and its one validator,
    `web/lib/mcps/epic-172-release-order.ts`. The JSON has one shared node registry;
    each node stores its owner, required-evidence contract, and exact build identity
    once. Separately named `codeDependencyGraph` and `runtimeActivationGraph` edge sets refer
    to that registry and retain different, fixed meanings. `codeDependencyGraph` proves
    slice implementation/import prerequisites: independently landable Step 0 after
    S2, S3 after S2 plus Step 0, remaining S4 after S2 plus S3, S5 after S2 plus
    remaining S4, and S6 after S2 through S5. It cannot authorize deployment,
    cutover, or ingress. `runtimeActivationGraph` alone accepts the complete acyclic
    operational chain:

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

    The Step 0 fixture proves both checked-in files and every bootstrap component
    exist before an external lifecycle-valid Ed25519 signer records the empty-
    predecessor `step0_retention_bridge` receipt through the generic recorder. The
    receipt binds manifest version, node/evidence kind, owner, exact build/reviewed
    SHA, epoch-or-none, and canonical predecessor-receipt-set digest into one
    immutable unique transition identity. A different receipt ID or nonce cannot
    duplicate that identity. The verifier accepts the signed first node only when
    it records the route, full-ingress-close, drain, retention-FK, hard-delete-
    guard, and exact-build postconditions before `s3_issue_178` can start. It rejects
    unsigned/nullable-signature or maintenance-authority evidence and remaining
    #179 expansion/producers before the S3 contract is installed. Each manifest
    node has machine-readable owner
    metadata:
    `step0_retention_bridge` has `owner:{issue:179,slice:'step0'}` and
    `s3_issue_178` has `owner:{issue:178,slice:'s3'}`; #179/S4 owns expansion,
    producer disablement, controlled activation, and ingress/issuance enablement;
    #180/S5 owns compatible-consumer deployment; #181's S6 controller owns both
    green gates and final S5/S6 release readiness. The validator resolves and
    validates dependencies per step, rejects a missing/mismatched owner, and never
    turns #179's later S4 dependency on #178 into a dependency of its independently
    landable Step 0 node. Every graph node, transition, and required-evidence row,
    including `s3_issue_178`, must carry a non-null lifecycle-valid Ed25519
    signature and be atomically consumed through the generic ledger by the
    dedicated transition path. Fixture, cross-slice contract, implementation-order,
    and static wording-parity sentinels require the same complete bootstrap list
    and its before-first-receipt/before-S3 ordering. Static ownership/import/parity
    sentinels prove Step 0 is the only creator and version owner of both paths; the
    JSON remains data-only;
    the validator imports no S3 or remaining-S4 symbol; and S3/later slices import
    the one validator, address and record evidence only for their owned nodes, and
    create no second file, graph, helper, evidence/consumption store, verifier,
    signer policy/key, principal, transition-identity rule, enablement singleton,
    or metadata copy. Negative fixtures remove,
    duplicate, or reorder each registry node and each named edge; duplicate owner,
    evidence, or build metadata outside the shared registry; substitute either
    graph, edge set, or evidence for the other; reject the obsolete/truncated
    `s4_activate` chain; reject activation before S5 compatibility and S6 pre-
    activation green; reject enablement before S6 post-activation green; and reject
    release readiness before enablement.

## Cross-slice contract

- [#179](https://github.com/Joncallim/Forge/issues/179) consumes this lock order,
  revision, exact coverage, operator-hold, and fingerprint contract for per-run
  packet claims and issuance evidence.
- [#180](https://github.com/Joncallim/Forge/issues/180) renders historical
  decisions, current effective grant state, and packet evidence separately from
  these structured fields.
- [#181](https://github.com/Joncallim/Forge/issues/181) proves positive and
  negative recovery, mixed-version rollout/rollback, failure transitions, and
  cross-slice deadlock freedom.

S3 does not authorize packet issuance, presentation shortcuts, automatic retry,
or merge/release behavior.

The release contract is deliberately acyclic but has two non-interchangeable
meanings. Before recording any graph node, #179 Step 0 solely bootstraps the pinned
Ed25519 signer policy/key/audit, generic immutable evidence store, append-only
consumption ledger, checked-in verifier/recorder/consumer, dedicated least-
privilege recorder/consumer/transition principals, unique canonical transition
identity, and disabled enablement singleton. It also solely creates and versions
the data-only
`web/lib/mcps/epic-172-release-order-v1.json` and its sole validator,
`web/lib/mcps/epic-172-release-order.ts`. One shared node registry stores every
node's owner, required evidence, and exact build identity once. The separate
`codeDependencyGraph` edge set governs implementation/import prerequisites; it cannot
authorize deployment or cutover. The separate `runtimeActivationGraph` edge set governs
release-state transitions and contains this complete required chain:

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

"#179 Step 0" means the bridge route that rejects or archives before
filesystem work, disabling all project-management ingress, draining every pre-
bridge process and database session, replacing evidence-bearing cascades with
`RESTRICT|NO ACTION`, installing the database hard-delete guard, and creating the
shared release-order JSON/validator and complete generic signed-evidence bootstrap.
The bootstrap is not a graph node and produces no receipt. Only after it is
complete may the external lifecycle-valid Ed25519 signer record the empty-
predecessor `step0_retention_bridge`; S3 verifies that immutable receipt and its
unconsumed canonical transition identity before it may record `s3_issue_178`.
It is a separately landable prerequisite and does not depend on S3. All project-
management ingress stays closed through S3 and remaining S4's `root_ref` default,
explicit-null insert bridge, non-null-to-null
guard, journal, and database tests. Exactly one mixed-version reopen may follow
those proofs; the later watermark/cutover requires another full close and drain.
All remaining #179 expansion and producer work follows #178. Exact node ownership
in the shared registry is:

| Manifest node | Required `owner` |
|---|---|
| `step0_retention_bridge` | `owner:{issue:179,slice:'step0'}` |
| `s3_issue_178` | `owner:{issue:178,slice:'s3'}` |
| `s4_expand` | `owner:{issue:179,slice:'s4'}` |
| `s4_producers_disabled` | `owner:{issue:179,slice:'s4'}` |
| `s5_compatible_consumers_deployed` | `owner:{issue:180,slice:'s5'}` |
| `s6_pre_activation_green` | `owner:{issue:181,slice:'s6'}` |
| `s4_controlled_activation` | `owner:{issue:179,slice:'s4'}` |
| `s6_post_activation_green` | `owner:{issue:181,slice:'s6'}` |
| `ingress_and_issuance_enabled` | `owner:{issue:179,slice:'s4'}` |
| `s5_s6_release_ready` | `owner:{issue:181,slice:'s6'}` |

The S6-owned entries are controller attestations; they do not transfer #179's
activation or enablement authority. The Step 0 fixture proves the file/helper,
complete bootstrap, disabled singleton, signed first-node postconditions, and
consumption boundary before S3. S3 and later slices import the Step 0 helper and
authentication substrate unchanged, use and record only their own signed nodes,
and own no copy. Release tooling validates
each graph under its fixed meaning and validates every node's owner, predecessor
evidence, and build identity rather than inferring either graph from a whole-issue
header. It rejects using one graph, edge set, or evidence as the other.

## Implementation order

0. Land and verify the separately deployable #179 Step 0 bridge/full-project-
   ingress-close/drain/retention-safe-FK/hard-delete-guard checkpoint. Step 0 also
   solely creates and versions the data-only release-order JSON and its one
   validator. Before its own receipt, its separately reversible bootstrap installs
   the pinned Ed25519 policy/key/audit, generic immutable evidence/consumption
   ledgers, checked-in verifier/recorder/consumer, dedicated least-privilege
   recorder/consumer/transition principals, canonical transition-identity guard,
   and disabled enablement singleton. Its fixture proves those components, then
   records and verifies the signed empty-predecessor first-node receipt before S3.
   The bootstrap is not a node and emits no unsigned receipt. Neither path imports
   an S3 or remaining-S4 symbol; this checkpoint contains no S3 dependency or
   packet producer.
1. As the first post-Step-0 artifact, materialize ADR 0009's exact version-2 JSON
   object at `web/lib/mcps/mcp-admission-lock-order-v2.json`, add the shared
   S3-owned ordered-subsequence validator, and prove ADR/runtime parity. Neither
   file imports an S4 symbol; remaining #179 only imports them. No S3 state writer
   may land before this contract test passes.
2. With all project-management ingress still closed, import Step 0's release-order
   validator and authentication substrate unchanged, verify/consume the signed
   `step0_retention_bridge` receipt, address and record only the signed
   `s3_issue_178` transition, and add only S3's additive
   decision-revision/marker schema and dual reader. After this S3 contract lands,
   #179 owns the one expansion-window root-change journal/trigger migration,
   reconcile command, and cutover checkpoint; S3 supplies the canonical negative-
   reconciliation callback those downstream components invoke. Do not create a
   second release-order file/helper, create a second journal, or register its
   migration in this slice.
3. Add append-only approval-decision history, the preallocated compare-and-set
   current-decision pointer, canonical projection, revision precedence,
   fingerprint, and unit tests.
4. Make handoff hold denied/revoked/consumed required grants before claim and
   return a barrier-free task to `approved` while preserving `running` for any live
   sibling lease or `awaiting_review`.
5. Add the locked project reconciliation service and package-local mutation path.
6. Migrate both endpoints to the global lock order, including complete sibling-set
   expansion before the first package lock, negative
   reconciliation and post-commit wake-up.
7. Bind decision authority to the internal root revision and make project repoint
   call the same negative reconciler before the new root can be claimed.
8. Keep project-management ingress closed while remaining S4 installs and tests
   nullable `root_ref`, its omitted-value default, the explicit-null insert bridge,
   non-null-to-null guard, and journal. Only after every database proof passes may
   compatible project-management ingress reopen exactly once for the mixed-version
   journal window.
9. Later, fully close project-management ingress and packet issuance again. Drain
   incompatible workers and root writers; after credential/session
   termination capture the `insert|root_update|archive` journal watermark and run
   the exact expansion reconciliation command through it. Only after every generation has an audited
   outcome may the operator bind roots and enable the rejecting root trigger. Keep
   every v2 writer, ingress, and packet producer disabled.
10. Deploy #180's compatible S5 consumers and #181's disabled S6 controller; run
   the complete pre-activation partition and record `s6_pre_activation_green` for
   the exact build.
11. Let #179 perform controlled activation. After #181 records
    `s6_post_activation_green` for the committed epoch/build, let #179 enable
    registered writers and ingress, with packet issuance last.
12. Run the PostgreSQL concurrency, release-order, failure, and cross-slice tests
    against the enabled build. Only after they pass may #181's controller record
    `s5_s6_release_ready` and treat the full release as ready.

## Implementation stop conditions

Stop rather than improvise if:

- S2 does not expose enough canonical decision identity and revision data to
  avoid string or timestamp precedence;
- a package approval would overwrite/delete a historical decision, infer current
  authority without the separate pointer, move that pointer without an exact
  compare-and-set, or reissue a revision/nonce during sequential or concurrent
  reapproval;
- a correct fix requires whole-package metadata replacement;
- endpoint authorization would require network or Redis work inside the
  transaction;
- historical failed-package recovery cannot be identified by the exact bounded
  compatibility reader;
- an old worker cannot be drained or protocol-gated before v2 holds are emitted;
- any project-management ingress can remain open at Step 0, reopen before the S3
  and remaining-S4 `root_ref`/bridge/guard/journal database proofs, or reopen more
  than once before the later full close and drain;
- a pre-bridge project route/session can still reach filesystem-first hard delete,
  an evidence-bearing foreign key can still cascade, or direct SQL hard delete is
  not rejected before the expansion journal opens;
- lock-order analysis or PostgreSQL tests reveal an unresolved cycle with #179
  approval/audit claims;
- the local projection locks cumulative source/history rows instead of the exact
  `local-run-evidence-task-projection-heads:id-ascending` family, any package lacks
  exactly the eight preallocated `CURRENT_LOCAL_PROJECTION_HEAD_KINDS` rows, or an
  acknowledgement, decline, quarantine, cancellation, repair, or recovery needs a
  ninth row rather than a count-neutral head advance;
- Step 0 could record its own receipt or let S3 materialize/record state before the
  pinned Ed25519 policy/key/audit, generic immutable evidence/consumption ledgers,
  checked-in verifier/recorder/consumer, dedicated recorder/consumer/transition
  principals, canonical transition-identity uniqueness, and disabled enablement
  singleton are installed and proven; any Step 0/S3 receipt is unsigned, has a
  nullable/maintenance authority arm, duplicates a canonical transition identity,
  or bypasses atomic consumption;
- #178/S3 would create, version, rewrite, or bypass Step 0's release-order JSON or
  validator or signed-evidence substrate, record another slice's node, duplicate
  shared node metadata/store/verifier/key/principal/enablement state, or use
  `codeDependencyGraph` evidence as `runtimeActivationGraph` evidence (or the reverse).
