# Issue #178 Architecture: Deterministic Filesystem Grant Recovery

Status: round-3 architecture proposal for implementation review; this primary
document is authoritative for S3

Issue: #178
Parent: #172
Depends on: #176, #177
Canonical policy: `docs/adr/0009-mcp-admission-contract.md`

Related slices: [#179](https://github.com/Joncallim/Forge/issues/179) owns packet
issuance and evidence, [#180](https://github.com/Joncallim/Forge/issues/180)
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
   decisions share its evaluator and lock order but never scan sibling packages.
6. **One lock order.** S3 uses the prefix project → tasks ascending → packages
   ascending → grant approval. #179 owns the full suffix: worker-protocol epoch →
   worker-instance rows ascending → agent runs ascending → runtime audits
   ascending → host-apply ledgers/entries by run and ordinal → all artifacts by
   stable key → issuance-recovery actions by unique key → integrity
   alerts/resolutions by stable key → review-gate rows ascending.
   S3 normally stops at the approval row and does not acquire the epoch row.
7. **No stale whole-JSON writes.** Owned JSONB paths are patched atomically or protected by explicit compare-and-retry.
8. **No automatic retry.** A filesystem grant block requires operator action.

## Proposed domain contracts

### Filesystem grant hold projection

Extend the filesystem projection returned by `requiresFilesystemGrantApproval` with an explicit discriminated recovery state rather than booleans that can conflict:

```ts
type FilesystemGrantHold =
  | {
      blocked: false;
      kind: 'not_required' | 'optional_without_context' | 'approved';
      requestedCapabilities: FilesystemProjectCapability[];
    }
  | {
      blocked: true;
      kind: 'approval_required' | 'denied_required' | 'revoked_required' | 'consumed_once';
      requestedCapabilities: FilesystemProjectCapability[];
      recoveryAction: 'approve_project_filesystem_context';
      grantPhase: EffectiveGrantState['phase'];
      grantDecisionRevision: string | null;
      taskDisposition: 'operator_hold';
      revocationReason?: string;
    };
```

`blocked`, `kind`, and `grantPhase` must all be derived from one canonical admission evaluation. The projection may retain existing compatibility fields temporarily, but no caller should infer denial from strings.

### Durable block metadata

Keep filesystem holds separate from generic MCP broker blocks:

```ts
type FilesystemGrantBlockMetadata = {
  schemaVersion: 2;
  kind: 'filesystem_grant';
  source: 'filesystem-grant-approval';
  taskDisposition: 'operator_hold';
  autoRetryable: false;
  terminalFailure: false;
  holdKind:
    | 'approval_required'
    | 'denied_required'
    | 'revoked_required'
    | 'consumed_once';
  requirementKeys: string[];
  requestedCapabilities: FilesystemProjectCapability[];
  grantPhase: EffectiveGrantState['phase'];
  grantConsumed: boolean;
  grantDecisionRevision: string | null;
  deniedRequired: boolean;
  revocationReason: string | null;
  recoveryAction: 'approve_project_filesystem_context';
  blockFingerprint: string;
  blockedAt: string;
};
```

The marker remains under `FILESYSTEM_GRANT_BLOCK_METADATA_KEY`, never
`metadata.mcpBroker`. `autoRetryable:false` excludes automatic Redis retry;
`terminalFailure:false` and `taskDisposition:'operator_hold'` make the task
nonterminal. The handoff result must not reuse the existing `terminalBlock` flag,
because current orchestrator paths interpret that flag as task failure.

`blockFingerprint` is a versioned digest of the normalized requirement keys,
exact required capability set, grant phase, consumed flag, decision revision, and
root-binding revision. It excludes
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
mandatory task-wide barrier even after every lease clears. S3 uses S4's shared
sibling-aware task reconciler rather than maintaining a weaker aggregate rule.

### Optional fallback

An optional requirement with `continue_without_mcp` stays non-blocking even if the effective phase is denied or revoked. This path must produce no bounded context and no filesystem-grant hold marker.

## Effective grant precedence

`readEffectiveGrantState` remains owned by `admission.ts`.

Every filesystem grant mutation increments a positive, project-scoped PostgreSQL
`BIGINT` counter while the project row is locked. JSON and API snapshots serialize
`grantDecisionRevision` as a canonical base-10 string; code compares parsed
database integers, never JavaScript numbers or lexical strings. The current
revision is retained even when the active project grant is removed. A
package-local approval or denial persists the allocated revision in its effective
phase; an active project grant persists the revision that created or changed it.
`approvedAt` and `deniedAt` remain useful operator evidence but are never compared
for authority.

Every filesystem decision also stores the positive decimal
`rootBindingRevision` from the locked project. `readEffectiveGrantState` accepts a
decision only when that revision equals the project's current internal binding.
Project root creation or backfill may bind the project to revision 1, but it must
never add that revision to a pre-v2 approval. The current schema contains no
immutable root identity captured when a legacy approval was made, so observing
today's path cannot prove what that approval originally authorized. Every legacy
decision without a stored binding revision remains non-issuable until an explicit
operator reapproval records the current locked revision. An unbound or
duplicate/aliased root also fails closed. A later repoint increments the binding
revision and invokes the same negative project reconciler under project → tasks →
packages → approvals locks, marking prior project and package coverage `revoked`
and holding affected unclaimed packages. The new root requires an explicit
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
project object. It owns candidate selection, stable task/package locking,
canonical reevaluation, narrow metadata updates, and a deduplicated list of task
IDs to wake after commit. Equivalent `always_allow` decisions made through the
task and project endpoints therefore recover the same package set.

`allow_once`, package-local denial, and package-local reapproval are deliberately
outside this project-wide scan. They use a package-scoped mutation path under the
same global lock order and can hold or recover only the targeted package. An
`allow_once` decision and its nonce remain package-local even when several
packages request an identical capability.

## Transaction and lock architecture

S3 uses this prefix of the cross-slice global order:

```text
project → affected tasks (ID ascending) → affected packages (ID ascending)
        → grant approval
```

S3 grant mutations normally stop after the grant approval row. #179 defines the
full suffix as grant approval → worker-protocol epoch → worker-instance rows
ascending → agent runs ascending → runtime audits ascending → host-apply
ledgers/entries by run and ordinal → all artifacts by stable key →
issuance-recovery actions by unique key → integrity alerts/resolutions by stable
key → review-gate rows ascending.
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
4. Determine candidate IDs, then lock every affected task in ascending ID order
   and every affected package in ascending ID order.
5. If the S3 mutation rotates or otherwise writes an `allow_once` approval, lock
   that approval row next. #179 follows the same order when it consumes the nonce.
6. Persist project and package-local decision state with the allocated revision.
7. Reconcile the already-locked rows, including positive recovery and negative
   revocation/narrowing holds.
8. Commit.
9. Wake the deduplicated affected task IDs through Redis after commit.

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
   `blocked` before claim. If its task is `running`, lock sibling packages in ID
   order and compare-and-set the task to `approved` only when none has a live
   execution lease or `awaiting_review`. Do not create an agent run or consume an
   attempt.
3. **No longer requires filesystem context.** Clear only a matching filesystem
   marker and recover only a package whose status is proven to be owned by that
   marker. A generic MCP, security, dependency, or reviewer block remains intact.

If canonical inputs or the fingerprint changed after candidate discovery, retry
under the locks. Never infer recovery or revocation from human text.

S3 never clears #179's `packet_issuance` marker through this reconciler. The one
integration point is package-local one-time reapproval: after S3 rotates a fresh
nonce under project → task → packages in ID order → approval locks, it calls
#179's package-scoped resolver in the same transaction. “Package-scoped” limits
grant evaluation; the resolver still locks siblings to enforce the task-wide
   review barrier. It then continues through the complete applicable suffix:
   protocol epoch → exact worker-instance row → prior agent run → runtime audit →
   host-apply ledger/entries → all artifacts → existing or new recovery action →
   integrity alerts/resolutions → review gates. It proves
canonical typed audit/artifact terminal-tuple equality, compare-and-sets the exact
terminal prior audit, `reapprove_allow_once` marker/fingerprint, changed nonce,
current policy, no active lease, and no sibling `awaiting_review`, then clears only
the packet marker and moves `blocked → ready`. A stale marker, second reapproval,
changed policy, active claim, or unresolved review is a no-op/conflict. Redis
wake-up remains after the combined commit.

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

The negative transition writes `holdKind:'revoked_required'`, the new decision
revision, a bounded reason code, and a fresh fingerprint; it never copies a raw
operator reason. A package already running with a claimed execution lease is not
retroactively stripped of packet bytes. #179 owns the per-run claim, issuance
fence, nonce consumption, and stale-claim behavior. Revocation governs the next
claim and all packages not yet claimed.

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
schema compatibility alone is not enough. Roll out in this order:

1. Add the project `BIGINT` decision counter plus nullable decision/root-binding
   revision and marker fields and the dual v1/v2 reader. Do not emit v2 markers
   yet. Every approval without a stored root-binding revision is non-issuable.
2. Drain old workers or enforce a protocol/version gate that prevents them from
   claiming S3-capable packages. An old orchestrator would otherwise turn an
   operator hold into task failure.
3. Use #179's checked-in host-binding procedure to bind the project to the current
   canonical root and initial revision 1. Do not upgrade any legacy approval as a
   side effect. Collision/unbound rows and every decision without historical
   binding evidence remain held until explicit reapproval. Then enable revision
   writers, v2 markers, operator-hold transitions, and positive plus negative
   reconciliation.
4. Deploy #179 packet/claim producers only after S3 readers and lock order are
   compatible. Deploy #180/#181 consumers and tests against that contract.
5. Remove the v1 adapter only after the supported migration window and evidence
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
   package.
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
6. Required denial/revocation/consumed-once holds create no `agent_runs`, consume
   no attempt, and write the bounded v2 marker and fingerprint.
7. A covering grant moves only a matching filesystem-held package
   `blocked → ready`; generic blocks and changed-fingerprint blocks remain.
8. The v2 reader and exact v1 adapter work during rollout, while ambiguous legacy
   errors do not recover. Redis failure after commit is repaired by the sweep.
9. The full project → tasks → packages → approval → protocol epoch → worker
   instances → agent runs → audits → host-apply ledgers/entries → artifacts →
   issuance-recovery actions → integrity alerts/resolutions → review-gate rows order has
   no deadlock across S3 reconciliation, #179 issuance, nonce rotation, and stale
   claim recovery.
10. Fresh one-time reapproval invokes only #179's package-scoped resolver; stale
    marker, double reapproval, policy drift, active-lease, and awaiting-review races cannot clear
    another block or wake before commit.
11. Mixed old/new worker gating and rollback retain operator-hold truth; an old
    worker cannot reinterpret a v2 hold as task failure.
12. Optional `continue_without_mcp` remains executable without a packet, revoked
    and first-time states remain distinct, and filesystem holds remain excluded
    from automatic retry.
13. Every canonical phase, including `proposed` and `not_issued`, plus the
    `consumed` discriminant round-trips through the v2 marker/parser. No known
    canonical state is normalized from reason text or silently mapped to another
    phase.

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

## Implementation order

1. Add the additive revision/marker schema and dual reader.
2. Add canonical projection, revision precedence, fingerprint, and unit tests.
3. Make handoff hold denied/revoked/consumed required grants before claim and
   return a barrier-free task to `approved` while preserving `running` for any live
   sibling lease or `awaiting_review`.
4. Add the locked project reconciliation service and package-local mutation path.
5. Migrate both endpoints to the global lock order, including negative
   reconciliation and post-commit wake-up.
6. Bind decision authority to the internal root revision and make project repoint
   call the same negative reconciler before the new root can be claimed.
7. Drain or gate incompatible workers, then enable v2 writers.
8. Run the PostgreSQL concurrency, failure, and cross-slice tests before #179
   producers or #180 presentation depend on the contract.

## Implementation stop conditions

Stop rather than improvise if:

- S2 does not expose enough canonical decision identity and revision data to
  avoid string or timestamp precedence;
- a correct fix requires whole-package metadata replacement;
- endpoint authorization would require network or Redis work inside the
  transaction;
- historical failed-package recovery cannot be identified by the exact bounded
  compatibility reader;
- an old worker cannot be drained or protocol-gated before v2 holds are emitted;
- lock-order analysis or PostgreSQL tests reveal an unresolved cycle with #179
  approval/audit claims.
