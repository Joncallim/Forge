# Issue #178 Architecture: Deterministic Filesystem Grant Recovery

Status: architecture proposal for implementation review

Issue: #178
Parent: #172
Depends on: #176, #177
Canonical policy: `docs/adr/0009-mcp-admission-contract.md`

## Objective

Make required bounded-filesystem denials, revocations, and missing grants recoverable operator decisions rather than execution failures. A package that cannot proceed because of filesystem context must be held before claim, consume no execution attempt, preserve task actionability, and recover identically regardless of which grant endpoint the operator uses.

## Non-goals

- No live MCP handle issuance.
- No context packet assembly or nonce claim lifecycle; #179 owns that.
- No operator UI redesign; #180 owns presentation.
- No broad work-package retry redesign.
- No second implementation of `readEffectiveGrantState`.

## Core invariants

1. **Admission owns the decision.** Recovery reads the canonical S1/S2 decision and never parses human text.
2. **Held is not failed.** Filesystem grant blocks leave the package `blocked`, the task operator-actionable, and execution attempts unchanged.
3. **Project decisions dominate older package-local decisions when they cover the exact required capability set.** A later `always_allow` grant may supersede a prior local denial.
4. **Revoked is distinct.** Previously available project coverage that no longer satisfies the package is `revoked`, not first-time `none`.
5. **One reconciliation routine.** Task-level and project-level grant endpoints call the same project-wide recovery service.
6. **One lock order.** All grant mutation and reconciliation uses project → tasks ascending → packages ascending.
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
  terminalBlock: true;
  requirementKeys: string[];
  requestedCapabilities: FilesystemProjectCapability[];
  grantPhase: 'none' | 'denied' | 'revoked' | 'approved';
  deniedRequired: boolean;
  revocationReason: string | null;
  recoveryAction: 'approve_project_filesystem_context';
  blockedAt: string;
};
```

The marker remains under `FILESYSTEM_GRANT_BLOCK_METADATA_KEY`, never `metadata.mcpBroker`. This preserves the no-auto-retry discriminator and gives #180 structured copy inputs.

## Handoff state transition

### Before claim

`filesystemGrantHandoffBlock` must evaluate both branches using:

- current locked package policy;
- current project MCP configuration;
- captured health observation where relevant;
- exact required bounded filesystem capabilities.

If the canonical projection is blocked:

```text
pending | ready
  → blocked
```

Effects:

- write/update the filesystem grant block marker;
- do not create `agent_runs`;
- do not increment task attempts;
- do not invoke packet assembly;
- do not mark the task failed;
- return a held result to `progressWorkforce`.

`progressWorkforce` must distinguish a held package from a terminal implementation failure. The task may remain `running` or move to the existing operator-actionable state chosen by the task state machine, but it must not become `failed` solely because a grant is denied or missing.

### Optional fallback

An optional requirement with `continue_without_mcp` stays non-blocking even if the effective phase is denied or revoked. This path must produce no bounded context and no filesystem-grant hold marker.

## Effective grant precedence

`readEffectiveGrantState` remains owned by `admission.ts`.

Precedence for the exact package-required capability set:

1. A current project-level grant covering the full required set is `approved`, even when an older package-local phase is `denied`.
2. A valid unconsumed package-local `allow_once` grant is `approved` when no covering project grant exists.
3. A consumed `allow_once` grant is `approved` with `consumed:true` at the reader contract and becomes a hold in the filesystem projection.
4. A package-local denial is `denied` only when no later covering project grant supersedes it.
5. A formerly covering project grant that was removed or narrowed is `revoked`, carrying a bounded `revocationReason`.
6. Never-approved remains `none` or `proposed` and uses first-time approval copy.

The reader must evaluate coverage against `requiredCapabilities`, not the full original grant breadth.

## Shared project-wide reconciliation service

Create a single server-side service, suggested location:

```text
web/lib/mcps/filesystem-grant-reconciliation.ts
```

Suggested interface:

```ts
async function reconcileFilesystemGrantsForProject(
  tx: DbTransaction,
  input: {
    projectId: string;
    trigger: 'task_allow_once' | 'task_always_allow' | 'project_always_allow' | 'revocation';
    actorId: string;
  },
): Promise<FilesystemGrantReconciliationResult>
```

The service owns:

- locked project configuration read;
- candidate task/package selection;
- stable lock order;
- canonical effective-grant reevaluation;
- clearing or replacing only owned filesystem grant metadata paths;
- moving recoverable packages to `ready`;
- preserving unrelated package metadata;
- returning task IDs that need re-drive;
- audit summary of recovered, still-blocked, and unchanged packages.

Both grant endpoints call this routine inside their transaction. Endpoint-specific code may authorize, validate payloads, and decide grant mode, but must not own separate package-selection or recovery logic.

## Transaction and lock architecture

### Mutation transaction

1. Lock project row `FOR UPDATE`.
2. Read and validate fresh `mcpConfig` from the locked row.
3. Build `nextMcpConfig` from that locked value.
4. Lock affected task rows in ascending stable ID order.
5. Lock candidate package rows in ascending stable ID order.
6. Persist project grant configuration.
7. Persist package-local grant phase changes using narrow JSONB path updates.
8. Run reconciliation over locked rows.
9. Commit.
10. Re-drive eligible tasks after commit through Redis.

All endpoints must follow this order. Authorization reads performed before the transaction are not persistence inputs.

### JSONB ownership

Grant mutation/reconciliation may own only:

- `metadata.mcpGrantPhases`;
- `metadata[FILESYSTEM_GRANT_BLOCK_METADATA_KEY]`.

It must not replace the full package `metadata` object. Prefer PostgreSQL `jsonb_set` and `#-`, or use an explicit `updatedAt`/version compare-and-retry if the ORM cannot express the path update safely.

Project MCP config mutation must preserve disjoint concurrent grants and unrelated keys. Use one locked source value and an exact update predicate; do not spread a stale pre-transaction project object.

## Reconciliation algorithm

For each locked candidate package:

1. Extract canonical required bounded filesystem capabilities.
2. Read current effective grant state from the package metadata and freshly locked project config.
3. Recompute the canonical filesystem projection.
4. If now approved:
   - clear filesystem block marker only;
   - update effective grant phase if required;
   - move `blocked` or eligible grant-failed package to `ready`;
   - preserve attempt count and unrelated metadata.
5. If still blocked:
   - refresh the structured block marker only if its canonical inputs changed;
   - leave status blocked.
6. If no filesystem grant is required:
   - clear stale filesystem block metadata;
   - recover only if the package was blocked specifically by that marker.

Never recover packages blocked for a generic MCP, security, dependency, or reviewer reason.

## Failed-package compatibility

Historical packages may be `failed` because the old executor consumed an attempt after denial. The reconciliation routine may recover a failed package only when:

- the durable filesystem grant block marker proves the failure was grant-related; or
- a narrowly validated legacy failure signature is converted once to the marker before recovery.

Do not recover arbitrary failed packages based solely on requested filesystem capabilities.

## Revocation behavior

Revocation or project grant narrowing must reevaluate affected packages. Packages not yet executed may become held before claim. Packages already executing are not retroactively stripped of bytes; #179 defines issuance fencing. This slice only governs future handoff/claim eligibility.

Structured reason categories:

- first-time: `approval_required`;
- explicit denial: `denied_required`;
- removed/narrowed project grant: `revoked_required`;
- used one-time decision: `consumed_once`.

Human copy belongs in #180.

## Redis and post-commit behavior

The transaction returns the unique task IDs with packages moved to `ready`. After successful commit, enqueue each task once using the existing approvals/workforce wake-up mechanism. Redis is wake-up transport only; PostgreSQL remains truth.

A queue failure after commit must be recoverable by the periodic sweep and must not roll back database state.

## Concurrency tests

Use real PostgreSQL tests for:

1. Two disjoint simultaneous `always_allow` grants: resulting project config contains the union and preserves unrelated keys.
2. Grant reconciliation racing an MCP broker metadata update: both owned fields survive.
3. Per-task and project endpoints receiving the same grant: identical recovered package set.
4. Two endpoints racing the same grant: idempotent final state and one effective re-drive per task.
5. Project grant narrowing while reconciliation runs: locked/fresh configuration determines the result.
6. Package policy mutation before lock acquisition: fresh required capabilities determine recovery.
7. A generic blocked package with filesystem requirements is not incorrectly recovered.

## Acceptance test state machine

```text
required grant denied
  package ready → blocked
  agent run count unchanged
  attempt count unchanged
  task remains operator-actionable

later covering always_allow
  package blocked → ready
  filesystem marker cleared
  task re-driven after commit
```

Also test:

- optional + continue_without_mcp stays executable without packet;
- revoked and first-time states remain distinct;
- consumed allow-once requires explicit reapproval;
- filesystem grant blocks remain excluded from auto-retry.

## Implementation order

1. Add/adjust projection contract and tests.
2. Make handoff hold denied/revoked/consumed required grants before claim.
3. Make `progressWorkforce` preserve operator-actionable task state.
4. Extract project-wide reconciliation service.
5. Migrate both endpoints to shared service and lock order.
6. Add concurrency and exact-transition tests.
7. Update developer/operator documentation only after behavior is proven.

## Implementation stop conditions

Stop rather than improvise if:

- S2 does not expose enough canonical grant identity to avoid string parsing;
- a correct fix requires whole-package metadata replacement;
- endpoint authorization would require holding external/network work inside the transaction;
- historical failed-package recovery cannot be identified without broad unsafe matching;
- lock-order changes reveal an unresolved cycle with #179 issuance claims.
