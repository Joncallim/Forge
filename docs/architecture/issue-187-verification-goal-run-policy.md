# Issue #187 Architecture: Verification Goal Run Policy and Goal-Owned Execution

Status: **Architecture draft — Round 1 findings incorporated. No runtime execution is authorized by this document.**

| Field | Value |
|---|---|
| Issue | [#187 — Add project verification goals and scheduled proof runs](https://github.com/Joncallim/Forge/issues/187) |
| Parent Epic | [#184 — Continuous verification and earned autonomy](https://github.com/Joncallim/Forge/issues/184) |
| Existing foundation | ADR 0013 + authoritative registry revisions; ADR 0011 Operation Catalog; ADR 0010 canonical outcomes; ADR 0012 reliability ledger |
| Downstream | #188 independent verification, #189 earned autonomy, #190 Project Sentinel, #191 reporting |
| This PR | Architecture only: executable-goal contract, policy/authority model, goal-owned run/evidence model, manual execution, history, scheduling, recovery, migration/ACL plan |

---

## 1. Plain-language summary

Forge can already import a strict repository-backed verification-goal registry and identify which complete registry revision is authoritative. It still cannot safely **run** those goals.

The missing boundary is larger than a `Run` button. The production deterministic-operation path, canonical outcome rows, command audits, and reliability attempts are currently anchored to a Forge **task**. A project proof is not an implementation task and must never manufacture a fake task or work package to borrow task authority.

This architecture makes a **verification goal run** a first-class execution subject. It keeps repository files declarative, places execution ceilings in operator-owned database policy, binds a run to the exact imported goal membership and import-time Operation Catalog definitions, binds decisive evidence to one clean repository commit, and reuses Forge's deterministic operation executor only after the shared ledgers can represent a non-task subject without weakening existing task guarantees.

The first executable version is deliberately narrow:

- current schema-v1 goals remain definition-only forever;
- executable goals use explicit schema v2;
- v2 still references only code-owned, enabled, non-deprecated, zero-input deterministic operations;
- repository configuration may request proof work but can never increase permission, rate, concurrency, deadline, evidence authority, or autonomy;
- project verification execution is disabled by default until the operator opts in;
- project proof reads require a current project-level `filesystem.project.read` decision in `always_allow` mode; no fake work-package capability metadata and no implicit `allow_once` consumption;
- operations execute in canonical order, sequentially, and fail closed;
- a decisive pass/fail is attributed only to one clean, stable Git commit;
- project, root, filesystem grant, registry, policy, Operation Catalog, repository, or lease drift invalidates the proof rather than being silently ignored;
- failures record evidence only. They do not edit code, create repair work, alter autonomy, create branches/PRs, merge, or widen MCP/filesystem authority.

Manual proof runs come first. Scheduling is added only after the same goal-owned execution path is proven.

---

## 2. Existing contracts that must not be weakened

### 2.1 ADR 0013 registry semantics

The merged #187 registry work establishes that:

- `.forge/verification-goals/*.json` is repository configuration;
- schema v1 contains goal metadata plus exact zero-input Operation Catalog references;
- imports create immutable goal snapshots and complete predecessor-linked registry revisions;
- the current registry head identifies the authoritative complete registry, including an empty registry;
- the registry revision captures project ownership/archive state, project local-path identity, opaque `rootRef`, root-binding revision, grant-decision revision, project revision, ordered membership, and manifest digest;
- a snapshot or registry head authorizes **nothing** and does not mean a goal ran or passed.

This architecture preserves that meaning. No historical schema-v1 row becomes executable after an upgrade.

### 2.2 ADR 0011 Operation Catalog semantics

The current production catalog is code-owned and contains three fixed read-only Git operations. The current `executeTrustedOperation` path:

- requires an approved/running task;
- derives project/root/revision state from PostgreSQL;
- requires current work-package + project filesystem authority for `filesystem.project.read`;
- refuses `allow_once` because it cannot consume that authority atomically;
- constructs fixed argv itself;
- records command-audit evidence;
- requires deterministic output verification before completion;
- can leave a nonterminal `operation_run` when an adapter does not settle after cancellation.

Goal execution must reuse the executor and fixed adapters, not copy them, but must introduce a real goal-owned authority loader instead of fabricating task state.

### 2.3 ADR 0010 / ADR 0012 task ownership today

Current storage assumes a task:

- `execution_outcomes.task_id` is non-null and identity is task + attempt key;
- `operation_runs.task_id` is non-null and identity is task + idempotency key;
- repository command audits are task-owned;
- `capability_attempts.task_id` is non-null.

Those records must be generalized with explicit subject foreign keys. Referential integrity may not be replaced by an unchecked polymorphic UUID.

### 2.4 PostgreSQL remains truth

PostgreSQL is authoritative for:

- current project/registry/policy authority;
- run identity and lifecycle;
- schedule-slot identity;
- lease/fencing state;
- result/evidence history.

Redis is only a wake-up/claim transport. A Redis loss, reconnect, duplicate delivery, or lost response cannot create a new authoritative run or change a result.

---

## 3. Governing decisions

### D1 — first-class closed execution subjects

Shared execution/evidence code uses a discriminated union:

```ts
export type ExecutionSubject =
  | { kind: 'task'; taskId: string }
  | { kind: 'verification_goal_run'; verificationGoalRunId: string }
```

This is not stored as one polymorphic `subject_id`. Each table keeps real nullable foreign keys plus an exclusive database shape check.

No goal execution path may create a synthetic task, work package, task attempt, agent run, approval gate, or task log.

### D2 — schema v1 stays non-executable; schema v2 requests bounded execution

Schema v1 keeps its historical meaning.

Schema v2 adds an `execution` declaration:

```json
{
  "schemaVersion": 2,
  "goalId": "repository-readable",
  "definitionVersion": 2,
  "title": "Repository remains readable",
  "description": "Forge can inspect the trusted project without running repository-authored code.",
  "capability": "filesystem.project.read",
  "severity": "high",
  "enabled": true,
  "operations": [
    {
      "operationId": "repository.status.read",
      "operationVersion": 1
    }
  ],
  "execution": {
    "manual": true,
    "schedule": null,
    "deadlineSeconds": 120,
    "requiredEvidence": []
  }
}
```

Initial schedule declaration, when Slice E lands:

```json
{
  "kind": "interval",
  "everySeconds": 86400
}
```

Not allowed in schema v2:

- shell text;
- command/argv;
- operation inputs;
- cwd/path;
- environment variables;
- adapter/tool/server names;
- credentials;
- callback names;
- cron expressions;
- operation dependency/data-flow expressions;
- autonomy actions;
- model prompts or verifier prompts.

The execution declaration is a **request**. It is never authority.

### D3 — repository severity is reporting metadata only

`severity` is repository-owned and can affect presentation/escalation metadata. It cannot:

- reduce Operation Catalog risk;
- reduce evidence requirements;
- bypass project policy;
- bypass Security/Reviewer/MCP/filesystem policy;
- grant/revoke autonomy;
- select a verifier.

A malicious repository changing `critical` to `low` therefore cannot weaken a safety boundary.

### D4 — four-layer monotonic policy intersection

Effective execution policy is the deterministic intersection of:

1. repository goal declaration;
2. current operator-owned project verification-policy revision;
3. exact code-owned Operation Catalog definitions bound at import;
4. centralized absolute system protocol/safety ceilings.

The result is always equal or stricter than every permissive repository request.

Examples:

- repo manual=true + project manual=false -> manual disabled;
- repo schedule + project scheduling=false -> no schedule;
- repo every 60s + project minimum 3600s -> effective interval >=3600s;
- repo deadline 1800s + project maximum 600s -> effective deadline=600s;
- 12 operations + project maxOperationsPerRun=4 -> admission denied;
- filesystem read not currently approved -> denied regardless of declaration/policy;
- operation requires independent verification before #188 can supply it -> run admission blocked, never silently downgraded.

### D5 — operator-tunable controls are database-backed and versioned

Do not scatter rate, concurrency, queue, deadline, or operation-count constants through routes/workers/tests.

Project verification policy is immutable revision history plus one protected current head. Values that operators may tune live in these records. Code constants remain only for closed enums, integer-encoding limits, and absolute safety ceilings that must survive corrupted configuration.

### D6 — verification is disabled by default

Migration and new-project creation both establish a valid current project verification policy with:

```text
manual_enabled = false
scheduling_enabled = false
```

No upgrade silently starts executing repository goals.

An authenticated project owner must explicitly opt in through the policy surface.

### D7 — no repository-controlled autonomy action

The original #187 example mentions a failure autonomy action. That is intentionally not executable in #187.

A decisive failed proof produces bounded failure evidence. #189 may later consume that evidence under its own operator-owned autonomy policy. #190 may later convert a regression into a Sentinel finding. Repository text cannot tell Forge to change permission.

### D8 — one shared execution/evidence model, not parallel ledgers

Do not create a second `verification_execution_outcomes` or second deterministic-operation engine.

Generalize the existing shared outcome, operation-run, and command-audit records with explicit task/goal subjects. Historical task rows keep their current meaning and constraints.

### D9 — decisive proof requires one stable clean repository identity

A proof is not allowed to claim “last green commit” against arbitrary dirty state.

Before the first operation, capture a trusted repository snapshot:

```ts
export type VerificationRepositoryIdentityV1 = {
  schemaVersion: 1
  objectFormat: 'sha1' | 'sha256'
  oid: string
  clean: true
  rootRef: string
  rootBindingRevision: string
  grantDecisionRevision: string
  projectRevision: string
  snapshotFingerprint: string
}
```

Rules:

- object format is read by fixed `git rev-parse --show-object-format`;
- OID is read by fixed `git rev-parse HEAD`;
- `sha1` requires exactly 40 lowercase hex characters;
- `sha256` requires exactly 64 lowercase hex characters;
- clean/dirty is determined by a fixed no-shell status helper;
- raw dirty file names are used only in memory to derive `clean`; they are not stored in the goal-run ledger, schedule state, Redis, API response, or repository-snapshot evidence;
- root/project/grant authority is rechecked with the snapshot;
- the same identity is rechecked before each operation and before terminalization.

A dirty tree or changed identity produces an inconclusive proof, never a clean pass/fail.

### D10 — operation references remain a canonical set

Schema v2 does not become a workflow language.

- operation references are sorted canonically by id/version;
- initial execution is sequential;
- no output-to-input piping;
- no dependency graph;
- no variables/interpolation;
- first non-passing operation or authority/evidence drift stops the sequence;
- parallel execution is out of scope until a separately reviewed shared-cancellation/lease contract exists.

---

## 4. Executable-goal import contract

### 4.1 TypeScript contract

Add v2 beside v1. Do not mutate v1 parsing behavior.

```ts
export type VerificationGoalEvidenceRequirement =
  | 'repository_identity'
  | 'canonical_operation_outcomes'
  | 'operation_evidence'

export type VerificationGoalScheduleDeclaration =
  | null
  | {
      kind: 'interval'
      everySeconds: number
    }

export type VerificationGoalExecutionDeclarationV1 = {
  manual: boolean
  schedule: VerificationGoalScheduleDeclaration
  deadlineSeconds: number
  requiredEvidence: VerificationGoalEvidenceRequirement[]
}

export type VerificationGoalDefinitionV2 = {
  schemaVersion: 2
  goalId: string
  definitionVersion: number
  title: string
  description: string
  capability: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  enabled: boolean
  operations: VerificationGoalOperationReference[]
  execution: VerificationGoalExecutionDeclarationV1
}
```

### 4.2 Evidence requirements are additive only

Base evidence is mandatory regardless of `requiredEvidence`:

- exact registry revision + entry + snapshot;
- current project/root/grant/policy authority;
- import-time Operation Catalog bindings;
- clean repository identity;
- every operation run;
- every canonical operation outcome;
- every adapter-required evidence reference.

`requiredEvidence` can only add a supported requirement. It cannot remove base evidence. Import rejects any requested evidence kind that the current runner/operations cannot produce.

### 4.3 Import-time Operation Catalog binding

A v2 snapshot must remember **which exact Operation Catalog definitions were validated when it was imported**, not only id/version text.

Add storage for a bounded canonical list:

```ts
export type VerificationGoalOperationBindingV1 = {
  operationId: string
  operationVersion: number
  definitionDigest: string
  capability: string
  adapter: string
  requiredPolicyCeiling: string
  timeoutMs: number
  verification: string
  independentVerificationRequired: boolean
}
```

Recommended snapshot columns:

```text
definition_schema_version integer not null
operation_bindings jsonb null
operation_bindings_digest text null
```

Shape:

- v1 snapshot -> schema=1, bindings null;
- v2 snapshot -> schema=2, non-empty exact sorted bindings + SHA-256 binding digest.

The v2 definition digest remains the digest of repository configuration. The operation-binding digest is separate code-owned execution evidence.

At run admission and before each operation, current catalog definition digest must equal the imported binding. If a catalog implementation changes without a new operation version, execution fails closed as `operation_contract_changed`. Reimporting the same goal/definition version under a different binding is a hard conflict, not an implicit rebind.

### 4.4 PostgreSQL snapshot constraint must explicitly support v1 OR v2

The current `verification_goal_snapshots.canonical_definition` constraint is exact-v1. The executable-goal migration must replace it with a closed disjunction:

```text
valid_v1_shape OR valid_v2_shape
```

V2 database checks must enforce at least:

- exact top-level keys;
- `schemaVersion=2`;
- exact execution keys;
- manual boolean;
- schedule null or exact interval object;
- bounded integer deadline/interval;
- bounded, duplicate-free closed evidence values;
- bounded operation count;
- v2 operation bindings required and matching snapshot capability/operation identities.

Existing v1 rows must pass unchanged.

### 4.5 Definition version rule

Any change to execution declaration, operations, capability, severity, enabled state, title, or description requires the repository author to increment `definitionVersion` under the existing immutable snapshot conflict rule.

---

## 5. Project verification policy

### 5.1 Data model

```text
verification_goal_policy_revisions
- id uuid primary key
- project_id uuid not null
- revision_sequence bigint not null
- schema_version integer not null
- policy_digest text not null
- manual_enabled boolean not null
- scheduling_enabled boolean not null
- min_schedule_interval_seconds integer not null
- max_run_deadline_seconds integer not null
- max_operations_per_run integer not null
- max_concurrent_runs integer not null
- max_queued_runs integer not null
- start_budget_window_seconds integer not null
- max_starts_per_window integer not null
- actor_kind text not null               -- system_default | migration_seed | human
- actor_user_id uuid null
- predecessor_revision_id uuid null
- created_at timestamptz not null

verification_goal_policy_heads
- project_id uuid primary key
- policy_revision_id uuid not null
- revision_sequence bigint not null
- updated_at timestamptz not null
```

Required constraints:

- append-only policy revisions;
- sequence starts at 1 and advances by one;
- predecessor belongs to same project;
- human actor -> user id required;
- system_default/migration_seed -> user id null;
- positive bounded numeric fields;
- `maxOperationsPerRun` cannot exceed the parser/system absolute goal-operation bound;
- head points to exact project/revision sequence;
- one current head per project.

### 5.2 Protected write authority

Policy changes affect execution permission. The ordinary application login must not directly update/delete policy history or move a head.

Use a fixed-search-path protected routine owned by a non-login role, following the protected-registry pattern:

```text
forge.append_verification_goal_policy_revision_v1(...)
```

It must:

1. lock the project;
2. verify active project and application-asserted authenticated owner;
3. lock the current policy head;
4. verify expected current revision/fingerprint;
5. validate closed bounded policy values;
6. append exactly one revision;
7. advance only the matching head;
8. commit atomically.

As with the registry actor field, the documentation must be honest: PostgreSQL verifies project ownership relationships but does not independently authenticate the web session behind an application-asserted user id.

### 5.3 Default-disabled lifecycle

Existing projects receive one `migration_seed` revision with manual/scheduling disabled.

New projects must receive a `system_default` disabled policy/head atomically through a protected project-insert trigger or equally fail-closed database-backed initializer. A missing policy head is an actionable blocked state; application code never falls back to permissive hardcoded defaults.

### 5.4 Project-wide start budget

`maxConcurrentRuns` and `maxQueuedRuns` do not prevent a repository with many goals from consuming unbounded starts over time. Every manual/scheduled run admission also enforces:

```text
max_starts_per_window / start_budget_window_seconds
```

The project policy-head lock serializes admissions for the project, so concurrent route/scheduler workers cannot both observe the same remaining budget and exceed it.

Manual runs do not bypass this safety budget merely because a human clicked the button.

---

## 6. Canonical lock order

Every code path that touches the same authority must use one order to avoid deadlocks.

For run admission and policy/registry concurrency:

```text
1. project row
2. current project filesystem decision pointer/read authority snapshot
3. verification goal registry head
4. bound registry revision + selected entry/snapshot
5. verification policy head
6. bound policy revision
7. project run-budget / current active-run rows in stable id order
8. new/existing verification goal run
```

The implementation pass must compare this with the existing registry importer and filesystem-grant reconciliation lock order. If an existing producer holds a stricter established order, this document's sequence must be adjusted to match it before code is written; never introduce a reverse lock order just for #187.

Run workers start from an unlocked lookup of `runId -> projectId`, then acquire authoritative locks in the same project-first order before claiming/revalidating the run.

No correctness test may rely on sleeps instead of explicit lock/interleaving control.

---

## 7. Exact registry-to-current-authority binding

Being on the current registry head is not enough. The current project must still be the project that was imported.

Before admitting a run, compare the current project to the registry revision's captured authority tuple:

```text
project.submitted_by          == registry_revision.project_submitted_by
project.archived_at           == null == registry_revision.project_archived_at
project.local_path            == registry_revision.project_local_path
project.root_ref              == registry_revision.root_ref
project.root_binding_revision == registry_revision.root_binding_revision
project.grant_decision_revision == registry_revision.grant_decision_revision
project.updated_at            == registry_revision.project_revision
```

If any field differs, admission fails with a fixed `registry_authority_stale` response and tells the operator to re-import the registry after restoring/confirming project authority.

This prevents an old imported goal from silently running after root rebind, grant revision, owner/project update, archive/reopen, or repository-path change.

A running/queued goal also rechecks that:

- registry head is still exactly its bound revision;
- current project tuple still equals the bound registry tuple;
- policy head is still exactly its bound policy revision.

The first implementation conservatively stops on **any** registry or policy-head revision change, even if a later semantic comparison might prove the selected goal unaffected. Optimizing that requires a later contract.

---

## 8. Goal-run persistence

### 8.1 Exact registry membership foreign key

A run must reference an **entry in its exact registry revision**, not two unrelated IDs.

Add/ensure a unique registry-entry identity such as:

```text
UNIQUE(
  registry_revision_id,
  project_id,
  ordinal,
  snapshot_id,
  goal_id,
  definition_version,
  definition_digest
)
```

`verification_goal_runs` stores that same tuple and has a composite foreign key to it.

This structurally prevents a run from combining revision A with snapshot/goal B.

### 8.2 Exact policy foreign key

Policy revisions expose:

```text
UNIQUE(id, project_id, revision_sequence)
```

The run stores and foreign-keys the exact policy tuple.

### 8.3 `verification_goal_runs`

Recommended fields:

```text
id uuid primary key
project_id uuid not null
registry_revision_id uuid not null
registry_entry_ordinal integer not null
goal_snapshot_id uuid not null
goal_id text not null
definition_version integer not null
definition_digest text not null
policy_revision_id uuid not null
policy_revision_sequence bigint not null
policy_fingerprint text not null
authority_fingerprint text not null
trigger_kind text not null                      -- manual | scheduled
request_actor_kind text not null                -- human | scheduler_v1
requested_by_user_id uuid null
manual_idempotency_key uuid null
manual_request_fingerprint text null
schedule_binding_id uuid null
schedule_slot_sequence bigint null
repository_snapshot_id uuid null
status text not null                            -- queued | running | recovery_required | completed
result text null                                -- passed | failed | inconclusive
terminal_code text null
lease_generation bigint not null default 0
lease_token uuid null
lease_owner text null
lease_expires_at timestamptz null
started_at timestamptz null
completed_at timestamptz null
created_at timestamptz not null
updated_at timestamptz not null
```

Required shapes:

```text
manual:
  actor_kind=human
  requested_by_user_id != null
  manual_idempotency_key != null
  manual_request_fingerprint != null
  schedule fields null

scheduled:
  actor_kind=scheduler_v1
  requested_by_user_id null
  manual fields null
  schedule_binding/slot != null
```

Lifecycle shape:

```text
queued:
  started_at=null, completed_at=null, result=null

running:
  started_at!=null, completed_at=null, result=null, live lease required

recovery_required:
  started_at!=null, completed_at=null, result=null

completed:
  started_at!=null, completed_at!=null, result in passed|failed|inconclusive
  no live lease
```

No arbitrary UPDATE/DELETE permission. Claim/renew/recovery/terminal transitions use fixed guarded routines or narrowly scoped SQL helpers with exact expected state + generation/token predicates.

### 8.4 Run events

`verification_goal_run_events` is append-only:

```text
id
run_id
sequence bigint
phase                  -- admission | dispatch | lease | repository_snapshot | operation | finalization | recovery
status                 -- observed | passed | failed | blocked
code                   -- closed code
operation_run_id null
repository_snapshot_id null
evidence_refs jsonb UUID[]
created_at
```

No free-form error/prose/path/prompt fields.

The goal ledger references operation evidence rather than copying operation output.

---

## 9. Manual request idempotency

Manual run creation requires a UUID `Idempotency-Key` header.

Persist a deterministic request fingerprint over:

```ts
{
  contractVersion: 1,
  actorUserId,
  projectId,
  goalId
}
```

Replay rules:

- same authenticated actor + same key + same request fingerprint -> return the existing run;
- same actor + same key + different project/goal fingerprint -> `409 idempotency_key_conflict`;
- a new deliberate click uses a new UUID and may create another run for the same goal/commit.

On replay of an already-created run, first authenticate/authorize current project access, then compare the persisted request fingerprint. Do not silently reinterpret the old key against a new current registry revision.

A request that failed before a run was created consumes no durable idempotency identity and may be retried after the blocking state is fixed.

---

## 10. Resolved run policy

Admission creates an immutable bounded policy snapshot:

```ts
export type ResolvedVerificationGoalRunPolicyV1 = {
  schemaVersion: 1
  projectId: string
  registryRevisionId: string
  registryEntryOrdinal: number
  goalSnapshotId: string
  goalId: string
  goalDefinitionVersion: number
  goalDefinitionDigest: string
  operationBindingsDigest: string
  projectPolicyRevisionId: string
  projectPolicyRevisionSequence: string
  triggerKind: 'manual' | 'scheduled'
  effectiveDeadlineSeconds: number
  effectiveScheduleEverySeconds: number | null
  maxOperationsPerRun: number
  effectiveRequiredEvidence: VerificationGoalEvidenceRequirement[]
  operationDefinitions: Array<{
    operationId: string
    operationVersion: number
    definitionDigest: string
    capability: string
    timeoutMs: number
    requiredPolicyCeiling: string
    verification: string
    independentVerificationRequired: boolean
  }>
  policyFingerprint: string
}
```

`policyFingerprint` is domain-separated SHA-256 over canonical JSON and semantic contract versions.

A worker never re-resolves different values and pretends they were the original run. It loads the stored resolved policy, then verifies current authority is still equal/stricter and exact heads/bindings are unchanged.

For v1 execution, any policy-head revision change stops the run as inconclusive rather than attempting a partial “still stricter enough” comparison.

---

## 11. Dedicated goal/project filesystem authority loader

A goal run has no work package. It must not call task-specific capability logic with fabricated package metadata.

Add a dedicated loader conceptually:

```ts
loadVerificationGoalFilesystemAuthority(projectId, goalCapability)
```

It reads the current project filesystem decision pointer/decision and current root-binding state under the established project authority rules.

Initial executable requirement:

```text
goal capability == filesystem.project.read
current project decision covers filesystem.project.read
decision == approved
grant mode == always_allow
root binding/current decision revision match registry/run authority
```

`allow_once` fails closed. Scheduled execution can never silently consume an interactive one-time decision.

The loader returns a typed server-derived ceiling; callers cannot supply capability, grant mode, project id, root, decision revision, or policy version.

When future non-filesystem deterministic capabilities are added, each receives its own code-owned authority adapter. Do not grow one generic “permissions JSON” escape hatch.

---

## 12. Trusted repository identity

### 12.1 Dedicated safe snapshot evidence

Add append-only `verification_goal_repository_snapshots`:

```text
id uuid primary key
run_id uuid not null unique
project_id uuid not null
root_ref uuid not null
root_binding_revision bigint not null
grant_decision_revision bigint not null
project_revision timestamptz not null
object_format text not null                -- sha1 | sha256
oid text not null
clean boolean not null
snapshot_fingerprint text not null
captured_at timestamptz not null
```

A dirty preflight may store `clean=false` with the safe repository identity but never raw status paths.

### 12.2 Fixed helper

Use only fixed no-shell Git reads with the existing hardened environment pattern:

```text
git rev-parse --show-object-format
git rev-parse HEAD
git status --porcelain=v1 -z --untracked-files=all
```

Status bytes are reduced in memory to a boolean and discarded.

Do not call the existing presentation-oriented repository-evidence helper if doing so would persist path lists/output that the proof ledger does not need.

### 12.3 Revalidation points

Revalidate clean identity:

1. immediately after acquiring run lease and current authority;
2. before every operation starts;
3. after every operation settles and its evidence is durable;
4. immediately before goal terminalization.

Any mismatch after run start -> completed/inconclusive `repository_changed`.

---

## 13. Generalizing canonical execution outcomes

### 13.1 Storage subject shape

Generalize `execution_outcomes`:

```text
subject_kind: task | verification_goal_run
task_id uuid null
verification_goal_run_id uuid null
```

Database shape:

```text
subject_kind=task:
  task_id != null
  verification_goal_run_id = null

subject_kind=verification_goal_run:
  task_id = null
  verification_goal_run_id != null
  work_package_id = null
  agent_run_id = null
  task_attempt_id = null
```

Use subject-specific partial uniqueness:

```text
UNIQUE(task_id, attempt_key) WHERE subject_kind='task'
UNIQUE(verification_goal_run_id, attempt_key) WHERE subject_kind='verification_goal_run'
```

Add a composite goal-run/project FK where the table also stores project scope indirectly through the linked operation/run; do not permit cross-project subject mismatches.

Historical rows are backfilled to `subject_kind='task'` before the exclusive check becomes valid.

### 13.2 Outcome semantics v2 prerequisite

Current operation failure handling can map both a real fixed-command failure and an evidence/database failure to the same generic `unknown` outcome. That is insufficient for project pass/fail history.

Before a goal can record a **decisive failed proof**, add canonical outcome schema v2 (or an equally explicit versioned extension) with a closed failure class:

```ts
export type ExecutionFailureClassV2 =
  | 'functional'
  | 'policy'
  | 'authority'
  | 'infrastructure'
  | 'evidence'
  | 'cancelled'
```

Goal-owned operations require v2 outcomes. Historical/task v1 outcomes remain readable; task producers may remain v1 until deliberately migrated.

Required distinction for the existing repository adapter:

- fixed Git command ran, audit is durably written, command returned a deterministic non-zero result -> `functional` with audit evidence;
- command audit/evidence persistence failed -> `evidence`;
- database/adapter infrastructure failed without decisive command evidence -> `infrastructure`;
- current authority changed -> `authority`;
- timeout/cancellation -> `infrastructure` or `cancelled` according to exact terminal contract;
- deterministic output verifier rejected completed adapter output -> `functional` with `validation_failed`.

Do not infer functional failure from `stopReasonCode='unknown'`.

### 13.3 Goal decision table

| Operation state | Required evidence valid? | Goal interpretation |
|---|---:|---|
| completed + deterministic verification passed | Yes | operation pass |
| v2 failed + failureClass=functional | Yes | decisive operation failure |
| validation_failed + functional evidence | Yes | decisive operation failure |
| policy/authority block | Any | inconclusive |
| timeout/cancelled | Any | inconclusive |
| infrastructure/evidence failure | Any | inconclusive |
| legacy/generic `unknown` | Any | inconclusive |
| nonterminal operation run | Any | recovery required |
| missing/malformed/mismatched evidence | No | inconclusive |

A goal is `failed` only if at least one operation has a decisive functional failure while authority/repository identity remains valid. Everything else that prevents proof is inconclusive.

---

## 14. Generalizing deterministic operation runs

### 14.1 Subject shape

Generalize `operation_runs` exactly as outcomes:

```text
subject_kind
task_id nullable
verification_goal_run_id nullable
```

Goal subject shape requires:

- `verification_goal_run_id != null`;
- `task/workPackage/agentRun/taskAttempt = null`;
- `project_id` equals the goal run project through a composite FK;
- one exact goal-run operation idempotency key.

Subject-specific unique indexes replace task-only uniqueness without weakening task history.

### 14.2 Shared context composition

Refactor task-specific loading into:

```ts
type TrustedProjectOperationScope = {
  projectId: string
  projectRoot: string | null
  rootRef: string
  rootBindingRevision: string
  grantDecisionRevision: string
  projectRevision: string
}

type TrustedOperationSubjectContext =
  | TaskOperationSubjectContext
  | VerificationGoalOperationSubjectContext
```

Flow:

```text
load task authority --------┐
                            ├-> trusted project scope -> shared policy -> fixed executor/adapter
load goal-run authority ----┘
```

The goal loader:

- loads the exact run;
- verifies live lease generation/token;
- verifies project + registry authority tuple;
- verifies exact current policy head;
- verifies import-time operation binding digest/current catalog digest;
- verifies current dedicated project capability authority;
- verifies repository snapshot identity;
- derives allowed capability/ceiling server-side.

Caller supplies only goal run id + internally derived operation ordinal/attempt identity. No project/root/capability/policy/command is caller-controlled.

### 14.3 Deterministic operation request for a goal

The runner constructs:

```ts
{
  schemaVersion: 1,
  operationId,
  operationVersion,
  inputs: {},
  requestedCapability: goalCapability,
  reason: 'verification_goal_run'
}
```

Use a fixed audit reason, not repository title/description.

Operation idempotency key is domain-separated over:

```text
goal run id + canonical operation ordinal + operation id/version + attempt generation
```

The route/repository cannot choose it.

---

## 15. Command-audit evidence integrity

### 15.1 Subject generalization

Repository command audits must support task or verification-goal-run ownership with the same exclusive subject rule.

Goal audits have:

- `verification_goal_run_id` set;
- task/workPackage/agentRun null;
- project relationship consistent with the run;
- existing fixed argv/safe-env/redaction rules unchanged.

Existing task/non-goal audits retain their historical fields.

### 15.2 Bind operation evidence to the exact operation run

For Operation Catalog executions, add/populate `operation_run_id` on command audits (or an equivalent relational link) so goal terminalization can prove an evidence UUID belongs to the exact operation run that cites it.

For the initial repository adapters, a decisive operation result requires:

```text
operation run -> evidence ref -> command audit
```

with exact subject/run binding.

Future adapter evidence kinds must add their own typed validator. Do not turn UUID arrays into an unchecked “anything exists somewhere” proof.

### 15.3 Path privacy boundary

Existing command audits may contain internal cwd/argv according to current Forge behavior. Goal-run events, repository-snapshot records, Redis messages, public API responses, reliability rows, and schedule records must not copy those paths/raw outputs.

---

## 16. Manual-run API

### 16.1 Create

```text
POST /api/projects/:projectId/verification-goals/:goalId/runs
Idempotency-Key: <UUID>
```

Body: **must be absent/empty**.

Caller cannot submit:

- snapshot/revision ids;
- path/ref/commit;
- operation list/input;
- capability;
- timeout/rate/concurrency;
- evidence requirement;
- actor id;
- grant/policy;
- provider/verifier.

### 16.2 Admission transaction

Canonical steps under the lock order:

1. authenticate session;
2. resolve project and verify current owner/access + project-management ingress gate;
3. check manual idempotency replay/conflict;
4. lock project + current project filesystem authority;
5. lock/read current registry head/revision/selected entry;
6. verify exact registry-to-current project authority tuple;
7. require v2 + enabled + manual requested;
8. verify import-time operation bindings still match current catalog;
9. lock current policy head/revision;
10. require project manual execution enabled;
11. resolve monotonic effective policy;
12. enforce max operations, queued/running ceilings, project start budget;
13. create exactly one queued run + bounded dispatch event;
14. commit;
15. publish the run identity to Redis best-effort/retryably.

A post-commit enqueue failure does not delete the run. A dispatcher/recovery scan republishes queued identities. Duplicate Redis deliveries are harmless because the database run/lease is authoritative.

### 16.3 Create response

```json
{
  "schemaVersion": 1,
  "runId": "uuid",
  "goalId": "repository-readable",
  "status": "queued",
  "replayed": false
}
```

### 16.4 Minimal read path required by #187

Do not wait for #191's full dashboard to make proof runs observable.

Provide an authenticated bounded endpoint such as:

```text
GET /api/projects/:projectId/verification-goal-runs/:runId
```

Return only:

- run id / goal id;
- trigger kind;
- lifecycle status;
- passed/failed/inconclusive result if terminal;
- stable terminal/recovery code;
- clean commit object format/OID if captured;
- timestamps;
- bounded operation run IDs and evidence-reference IDs;
- whether operator action/retry is required.

Do not return local path, raw command output, policy internals, Redis claim data, lease token, or database error text.

#191 later owns aggregation/filtering/dashboard/export polish.

---

## 17. Goal-run state machine

Use one lifecycle state dimension and one terminal result dimension.

```text
queued
  -> running
  -> recovery_required
  -> completed

running -> completed
queued  -> completed   (only through a protected pre-start cancellation/inconclusive transition if needed)
```

Terminal result exists only for `completed`:

```text
passed
failed
inconclusive
```

### 17.1 Semantics

**Passed**

All canonical operations completed, deterministic verification passed, required evidence is linked/valid, and registry/project/root/grant/policy/catalog/repository authority remained current through terminalization.

**Failed**

At least one operation produced a versioned **functional** failure with required evidence while all authority/repository bindings remained valid.

**Inconclusive**

Forge could not decide pass/fail because of dirty/drifting repository, policy/registry/root/grant change, timeout, cancellation, lease loss, infrastructure/evidence failure, operation-contract drift, missing evidence, or recovery uncertainty.

### 17.2 Admission denial vs run result

Conditions detected before a run identity is validly admitted (v1/disabled goal, manual disabled, stale registry authority, no filesystem authority, budget/queue limit) return fixed API/scheduler denial and create no false proof result.

Conditions found after a run is created/claimed (for example repository dirty at worker preflight) terminalize the run as `inconclusive` when it is safe to do so.

### 17.3 Stable terminal codes

Initial closed taxonomy:

```text
passed
functional_operation_failed
functional_verification_failed
repository_dirty
repository_changed
registry_superseded
registry_authority_changed
policy_changed
root_or_grant_authority_changed
operation_contract_changed
required_verifier_unavailable
missing_required_evidence
operation_infrastructure_failed
operation_evidence_failed
timeout
lease_lost
queue_recovery_failed
operator_cancelled
internal_infrastructure_error
```

`failed` is allowed only for the two `functional_*` codes. All other terminal codes are inconclusive.

---

## 18. Database lease and stale-worker fencing

Redis ownership is not sufficient to authorize PostgreSQL mutation.

### 18.1 Claim

A fixed guarded claim transition:

- uses database time;
- requires `status=queued` or an explicitly recoverable state;
- increments `lease_generation`;
- writes fresh UUID token + bounded owner id;
- sets `lease_expires_at` to bounded future DB time;
- moves queued -> running on first claim.

### 18.2 Renewal

Renewal requires exact:

```text
run id + lease generation + lease token + current running state
```

and database time before expiry.

Every authoritative event, repository snapshot link, operation start authorization, recovery mutation, and terminalization verifies the same current lease tuple.

A stale worker's later adapter return cannot write authoritative goal state.

### 18.3 Local cancellation

Lease loss aborts the local `AbortSignal` and prevents any new operation from starting. Abort is advisory; the PostgreSQL generation/token check is the actual fence.

---

## 19. Child operation recovery and uncertain effects

The current Operation Catalog deliberately leaves an operation run nonterminal when a cancelled adapter does not settle. A goal runner must respect that boundary.

### 19.1 No automatic replay of an incomplete child operation

If a child `operation_run` is still `running`/recovery-required after goal worker loss:

- do not run the same goal operation again under the same goal run;
- do not create a second reliability attempt;
- do not infer a pass/fail;
- parent goal moves/stays `recovery_required`.

### 19.2 Safe parent closure

Recovery may close the parent as inconclusive only after it proves that no child operation can still create authoritative evidence/effects under the lost lease, for example the built-in read-only subprocess has settled/quiesced and stale database writes are fenced.

If that cannot be proven, leave the parent `recovery_required` for operator inspection. Never manufacture terminal evidence merely to unblock the queue.

The incomplete child operation row remains historical evidence.

A later deliberate manual goal run uses a **new goal-run identity**; a scheduler uses a later slot. Neither overwrites the incomplete run.

---

## 20. Dispatch, Redis, and recovery

### 20.1 Envelope

Redis carries only:

```ts
{
  schemaVersion: 1,
  runId: string,
  occurrenceId: string
}
```

No path, goal JSON, command, policy JSON, evidence, actor token, lease token, or secret.

### 20.2 Post-commit dispatch recovery

The PostgreSQL `queued` row is sufficient dispatch truth. A bounded dispatcher scans queued/unleased runs and may republish them. Lost publish responses can create duplicate Redis occurrences; database claim fencing converges them on one run.

If generic queue occurrence/retry primitives are extracted from the task queues, policy remains outside those primitives. Queue code transports typed identity; it does not decide goal permission.

### 20.3 Functional failure is never auto-retried

A decisive failed proof is evidence, not a transient job failure.

Initial manual runner does not auto-create a second goal run after inconclusive infrastructure failure either. The operator may request a new run. The scheduler waits for the next normal slot.

This keeps infrastructure retry semantics separate from project behavior.

---

## 21. Canonical runner flow

```text
PostgreSQL queued run already exists
  -> Redis occurrence wakes worker
  -> worker obtains project id without lock
  -> acquire canonical project/registry/policy/run locks
  -> acquire database execution lease
  -> revalidate exact registry-to-current authority + policy + catalog bindings
  -> revalidate project-level always_allow capability authority
  -> capture safe clean repository identity
  -> if dirty/unavailable: safely complete inconclusive
  -> for each canonical operation sequentially:
       -> verify live run lease
       -> revalidate project/registry/policy/catalog/filesystem authority
       -> revalidate clean repository identity
       -> construct fixed goal-owned OperationRequest with {}
       -> execute shared deterministic Operation Catalog entry
       -> require terminal operation outcome v2 + typed evidence
       -> verify exact command/evidence ownership
       -> revalidate repository identity after settlement
       -> on decisive functional failure: stop sequence
       -> on any other non-pass: inconclusive/recovery-required
  -> revalidate lease + all authority + clean repository identity
  -> atomically append final event + terminalize run
  -> only after durable terminalization: best-effort reliability ingestion
```

No model is invoked by this deterministic proof path.

---

## 22. History semantics

Compute from immutable decisive run history. Do not add a mutable status summary in the first execution slice.

A history cohort is at least:

```text
project
+ goal snapshot / definition digest
+ operation-bindings digest
+ project verification-policy fingerprint
```

Only clean-commit decisive passed/failed runs count.

Definitions:

- `lastGreen` = most recent decisive passed run in current cohort;
- `consecutivePasses` = decisive passes after most recent decisive failure; inconclusive runs do not break/increase streak;
- `consecutiveFailures` = decisive failures after most recent decisive pass; inconclusive runs do not break/increase streak;
- `firstObservedFailingCommit` = earliest decisive failed clean commit in the current unresolved failure episode;
- a later decisive pass closes the episode but preserves history.

Use **first observed failing commit**, not “regression introduced by commit.” Forge has not performed a bisect and must not claim causation.

A definition/binding/policy cohort change begins new current streak semantics; prior history remains queryable.

---

## 23. Reliability integration

Do not write one synthetic goal-level capability attempt.

Each completed deterministic operation may feed #186 under its existing key:

```text
operation:<operation-id>@<version>
```

Required generalization:

```text
capability_attempts.subject_kind
capability_attempts.task_id nullable
capability_attempts.verification_goal_run_id nullable
```

Goal subject rejects task/workPackage/agent/taskAttempt links and keeps exact `operation_run_id`.

### 23.1 Prevent silent mixing with task-issued operations

Reliability scope/policy fingerprint for a goal-owned operation includes:

```text
executionSubjectKind = verification_goal_run
goal policy fingerprint
registry/goal binding identity
project/root/grant scope
```

Task-issued and proof-issued samples therefore do not silently collapse into one cohort when their authority/policy context differs.

### 23.2 No incomplete/uncertain ingest

Never ingest a goal operation if:

- operation run is nonterminal;
- canonical outcome/evidence is missing/drifted;
- parent goal lease/evidence attribution is uncertain.

Reliability ingestion remains best-effort after canonical evidence. Its failure cannot change the goal result.

`independent_agent` remains refused until #188 produces an independent verification record.

---

## 24. Independent verification extension point (#188)

#187 deterministic goal result is immutable evidence. #188 must not rewrite it into “verified.”

Future independent verification appends/links separate records:

```text
verification subject = verification_goal_run
verifier run identity
bounded source evidence
criterion/check findings
verification result/history
```

Reverification appends history.

Human-browser and Playwright-browser lanes remain separate. Schema v2 does not define browser verifier types, does not reuse a human browser session, and does not allow a repository to select a model/verifier runtime.

If an imported Operation Catalog binding says `independentVerificationRequired=true` while #188 support is unavailable, manual/scheduled admission is blocked with `required_verifier_unavailable`; it is never downgraded to self/deterministic verification.

---

## 25. Scheduling architecture (after manual execution)

### 25.1 Do not include repository HEAD in pre-dispatch dedup identity

The scheduler must not inspect the filesystem before creating a run merely to build a dedup key.

Scheduled slot identity is based on authoritative configuration/time only. The worker later captures the clean HEAD and binds the proof.

### 25.2 Schedule binding

When the scheduler first observes an eligible current v2 goal + current policy, create/reuse an immutable schedule binding:

```text
verification_goal_schedule_bindings
- id
- project_id
- registry_revision_id
- goal_snapshot_id
- policy_revision_id
- schedule_fingerprint
- interval_seconds
- anchor_at                 -- database time
- created_at
```

The schedule fingerprint includes exact goal definition/binding/policy identities and effective interval.

A registry or policy change creates a new binding with a new database-time anchor. Old bindings remain historical and do not emit new slots.

### 25.3 Slots

```text
verification_goal_schedule_slots
- binding_id
- slot_sequence bigint
- slot_due_at timestamptz
- disposition              -- run_created | overlap_skipped | budget_skipped | policy_stale
- run_id uuid null
- created_at
PRIMARY KEY(binding_id, slot_sequence)
```

Slot sequence derives from `anchor_at + n * interval` using database time.

Two scheduler workers racing on one slot converge on the unique row.

### 25.4 No catch-up stampede

If Forge was offline through many intervals, the scheduler does not enqueue every missed slot. It materializes at most the current eligible slot and records a bounded skipped/catch-up disposition as needed.

### 25.5 Overlap and project budget

V1 permits at most one active run per project+goal. If the prior goal run is active, the slot is `overlap_skipped`.

Project-wide queued/running/start-budget ceilings also apply. If budget is unavailable, record `budget_skipped`; do not build an unbounded delayed backlog.

### 25.6 Disabled/superseded goals

Every scheduler pass resolves the current registry/policy heads. Removed, v1, disabled, policy-disabled, superseded, or stale-authority goals do not execute historical snapshots.

---

## 26. Regression signal boundary for #190/#189

#187 owns proof evidence/history. It does not own Sentinel/autonomy policy.

Expose a deterministic query/event condition:

```text
current-cohort decisive transition:
  prior latest decisive result = passed
  new decisive result = failed
```

This is a **regression candidate**, not a Sentinel finding and not an autonomy action.

#190 may later deduplicate/escalate it into `sentinel_findings`. #189 may independently evaluate failed-proof evidence under operator policy.

No #187 worker creates repair tasks, GitHub issues, autonomy decisions, or code changes.

---

## 27. Security / abuse cases

| Attack / failure | Required behavior |
|---|---|
| Repo sets manual/schedule permissively | Project policy/system ceiling wins |
| Repo creates hundreds of goals | Project start window + queue/concurrency ceilings bound starts |
| Repo lowers severity | Reporting metadata only; safety unchanged |
| Repo references dangerous/unknown op | Import fails closed |
| Catalog same id/version silently changes | Import binding digest mismatch blocks execution |
| Repo asks for evidence runner cannot produce | Import/admission fails closed |
| Repo prompt-injects title/description | Metadata never reaches request reason/argv/policy/model |
| Project root/grant changes after import | Registry-authority stale; re-import required |
| Registry/policy changes while queued/running | Run stops inconclusive |
| Worktree dirty | No decisive pass/fail |
| HEAD/object format changes | Run stops inconclusive |
| Symlink/path root rebound | Existing root identity checks fail closed |
| Only `allow_once` grant exists | Proof run denied; scheduler never consumes it |
| Duplicate Redis delivery | One DB lease/run wins |
| Old worker returns after lease loss | DB generation/token rejects mutation |
| Audit DB write fails after Git runs | Evidence/infrastructure failure; never functional fail |
| Operation adapter does not settle | Parent recovery_required; no replay/pass/fail |
| Same manual idempotency key used for another goal | 409 conflict |
| Scheduler restarts after downtime | No missed-slot stampede |
| Repo asks to revoke autonomy | No executable field; #189 owns decision |
| Repo asks for browser/model verifier | Not in schema v2; #188 owns later path |

---

## 28. Migration and ACL strategy

Execution must remain disabled until the complete migration/constraint chain is proven.

Recommended order:

1. Extend goal snapshot storage/checks for exact v1 OR v2 plus import-time operation bindings.
2. Add protected project verification-policy revisions/heads and disabled default lifecycle for existing/new projects.
3. Add `verification_goal_runs`, repository snapshots, events, guarded lease/terminal routines.
4. Generalize `execution_outcomes` subject identity; preserve task rows/partial uniqueness; add v2 failure semantics needed by goal operations.
5. Generalize `operation_runs` subject identity and ledger API.
6. Generalize repository command audits + exact operation-run evidence linkage.
7. Refactor trusted operation scope into task/goal subject loaders; runtime goal execution still feature-disabled.
8. Add manual run route/queue/worker and enable only after PostgreSQL/ACL/CI proof.
9. Generalize capability attempts for goal subject and add history queries.
10. Add schedule binding/slot tables and scheduler only after manual vertical slice is proven.

Every migration slice must include:

- current-tip migration journal proof;
- populated upgrade from real previous schema with historical task outcomes/runs/audits;
- no window where old task FK/uniqueness is dropped before replacement constraints are active;
- invalid zero-subject/two-subject/cross-project combinations rejected by PostgreSQL;
- append-only/protected-routine owner checks;
- ordinary app ACL closed inventory;
- `PUBLIC` function execute revocation where protected routines are used;
- managed installer + legacy repair + populated upgrade proof;
- forced protected-owner handoff failure and cleanup proof consistent with current Forge migration safety style;
- migration retry/idempotency proof;
- v1 snapshots/history remain readable and non-executable.

Do not mark execution feature-enabled from a migration alone. Code/runtime activation remains separately gated.

---

## 29. Module boundaries

Suggested architecture:

```text
web/lib/verification-goals/contracts.ts
  v1/v2 definition parsing, canonicalization, definition/binding digests

web/lib/verification-goals/policy-contracts.ts
  project policy types, resolved policy, pure monotonic intersection

web/lib/verification-goals/history.ts
  pure/current-cohort history computation from decisive runs

web/worker/verification-goals/admission.ts
  current project/registry/policy/catalog/authority load + manual/scheduled admission

web/worker/verification-goals/filesystem-authority.ts
  project-level capability authority, no work-package shim

web/worker/verification-goals/repository-snapshot.ts
  fixed clean SHA-1/SHA-256 HEAD evidence

web/worker/verification-goals/runner.ts
  lease-fenced sequential orchestration only

web/worker/verification-goals/ledger.ts
  run/events/lease/terminal guarded storage

web/worker/verification-goals/scheduler.ts
  deterministic DB-time binding/slot materialization; no LLM

web/worker/operations/context.ts
  shared trusted project scope + task and goal-run authority adapters

web/worker/operations/executor.ts
  shared deterministic executor; subject-neutral after validated context

web/worker/queue/*
  reusable occurrence/claim transport primitives; no verification policy
```

Rules:

- `lib` contracts are DB-free;
- policy intersection/history are pure functions;
- routes are thin auth/orchestration shells;
- filesystem/root work goes through one trusted boundary;
- subject-specific authority is isolated at adapters, not scattered `if (task else goal)` throughout the executor;
- queue code carries identity, never policy;
- schedule code never invokes an LLM;
- no repo-controlled registration of adapters/verifiers/policies;
- no unexplained magic numbers outside one contract/default source.

---

## 30. Implementation slices for #187

### Slice A — executable-goal + project-policy contracts

- add v2 parser while freezing v1 meaning;
- add v2 snapshot DB shape + import-time operation bindings;
- add protected project policy revisions/heads;
- seed disabled defaults for old/new projects;
- pure monotonic resolver + fingerprints;
- no run/queue/execution.

### Slice B — goal-run/evidence subject foundation

- add goal runs/events/repository snapshot/lease schema;
- exact registry-entry/policy composite FKs;
- generalize canonical outcomes to explicit subjects + outcome-v2 failure class;
- generalize operation runs + command audits;
- relationally bind initial command evidence to operation run;
- refactor trusted operation context into subject adapters;
- goal runtime remains disabled.

### Slice C — manual deterministic vertical slice

- bodyless owner-authorized POST + UUID idempotency conflict semantics;
- minimal GET status endpoint;
- DB-first queued run + Redis transport/re-dispatch;
- DB lease/fencing/recovery;
- dedicated project filesystem authority;
- clean SHA-1/SHA-256 repo identity;
- sequential zero-input operations;
- explicit pass/functional-fail/inconclusive decision table;
- no scheduler.

### Slice D — history + reliability

- current-cohort last-green/first-observed-failure/streak queries;
- generalize capability attempts to goal subject;
- subject/policy cohort separation;
- no synthetic goal aggregate attempt;
- no independent-agent verification yet.

### Slice E — bounded scheduling

- immutable DB-time schedule bindings;
- unique slot observations;
- current-slot only / no catch-up stampede;
- project start budget, queued/running ceilings, overlap skip;
- no historical/superseded execution;
- operator runbook.

### Slice F — #187 closure proof

- checked-in sample schema-v2 goal;
- manual + scheduled end-to-end proof;
- exact migration/ACL/Redis response-loss/duplicate/recovery tests;
- clean commit history proof;
- docs/operator recovery commands;
- confirm #187 acceptance criteria without implementing #188/#189/#190 authority.

---

## 31. Acceptance-criteria mapping and deliberate deviations

| #187 requirement | Architecture mapping |
|---|---|
| Repo-visible versioned goal | v1 preserved; executable v2 under same strict registry |
| Strict unsafe-command rejection | No commands/args/paths/inputs in goal; exact code-owned op bindings |
| Persist definitions and runs | Existing snapshots/revisions + goal-run/event/snapshot history |
| Manual first | Slice C before scheduling |
| Controlled schedule | Slice E DB-time binding/slot + operator policy |
| No overlapping duplicate evidence | One active goal run + unique schedule slot + DB lease |
| Last green / first failure | Decisive current-cohort history rules |
| Canonical outcomes | Shared outcomes generalized + v2 failure class prerequisite |
| Reliability | Per-operation #186 attempts after durable terminal evidence |
| Disabled goals do not run | Import/admission/scheduler checks + current registry head |
| Failure does not auto-repair | Explicit non-goal / #190 boundary |
| Human and Playwright lanes separate | No browser verifier in v2; #188 separate verification records |
| Redaction | Closed run events, UUID refs, no raw dirty paths/Redis payloads |

**Deliberate deviation: `failure.autonomyAction` is not executable in #187.** #189 owns autonomy policy and will consume proof evidence. This is a safety boundary, not a missing implementation.

**Deliberate wording: “first observed failing commit,” not “first bad commit.”** #187 does not perform causality/bisect proof.

---

## 32. Verification matrix

### 32.1 Contract/import

- v1 parses exactly as before and is non-executable;
- v2 exact top-level/execution keys;
- v1/v2 PostgreSQL JSONB shape checks;
- unknown schedule/evidence keys fail;
- non-integer/overflow bounds fail;
- duplicate evidence/operation refs fail;
- input-bearing/unknown/disabled/deprecated/mismatched operations fail;
- imported operation binding digest stable and sorted;
- same goal/version + changed binding hard-conflicts;
- severity cannot influence policy resolver;
- policy resolver property test proves repository inputs never widen policy.

### 32.2 Policy/ACL

- existing/new project gets valid disabled head;
- no hardcoded permissive fallback if head missing;
- human actor shape + owner authorization;
- migration/system actor shape;
- append-only revisions;
- head advances one exact predecessor;
- stale expected head race fails;
- app role lacks direct UPDATE/DELETE/head mutation;
- PUBLIC cannot execute protected routine.

### 32.3 Referential integrity

- exact registry revision+entry+snapshot goal tuple required;
- exact policy revision/project tuple required;
- goal run cannot mix another project's entry/policy;
- outcome/operation/audit goal subject cannot carry task links;
- task historical rows still require task subject;
- zero/two subjects rejected;
- goal operation run project must equal goal run project.

### 32.4 Authority races

Use controlled interleavings, not sleeps:

- project/root/grant changes before admission commit;
- registry head changes after entry read;
- policy head changes after resolution;
- registry/policy changes after queue but before claim;
- root/grant changes before each operation;
- catalog same-version digest changes after admission;
- repo becomes dirty between operations;
- HEAD changes after last operation before terminalization.

Expected: no stale pass/fail.

### 32.5 Repository identity

- SHA-1 object format + 40 hex OID;
- SHA-256 object format + 64 hex OID;
- unknown format refused;
- detached HEAD accepted if OID valid;
- unborn/no HEAD -> inconclusive;
- dirty tracked/untracked changes -> clean=false without persisted path list;
- fsmonitor/textconv/external helpers cannot execute through hardened helper.

### 32.6 Operation result classification

- completed+verified+evidence -> pass;
- fixed command nonzero + durable exact audit -> functional fail;
- deterministic verifier fail -> functional fail;
- audit persistence failure -> inconclusive evidence failure;
- DB/adapter infrastructure failure -> inconclusive;
- authority drift -> inconclusive;
- timeout -> inconclusive;
- legacy `unknown` -> inconclusive;
- missing/mismatched evidence UUID -> inconclusive;
- second operation never starts after decisive failure/drift.

### 32.7 Lease/recovery

- duplicate Redis occurrence -> one lease winner;
- stale token/generation cannot event/operation/terminalize;
- lease loss aborts local worker;
- adapter returns after lease loss -> no authoritative write;
- nonsettling child op -> parent recovery_required;
- no automatic replay of incomplete child;
- safe quiescence can close parent inconclusive;
- otherwise recovery remains required;
- lost enqueue response -> queued run eventually redispatched;
- lost terminal response -> replay reads terminal row, no duplicate evidence.

### 32.8 Manual API

- unauthenticated -> 401;
- non-owner/inaccessible/archived project -> hidden/denied under current app convention;
- nonempty body -> 400;
- invalid/missing idempotency UUID -> 400;
- v1/disabled/manual-false goal -> no run;
- policy disabled -> no run;
- stale registry authority -> re-import required;
- no `always_allow` read -> no run;
- start budget/queue/concurrency exhausted -> no run;
- same key+same actor/project/goal -> same run;
- same key+different intent -> 409;
- GET returns bounded state and hides internals.

### 32.9 History/reliability

- inconclusive never changes pass/fail streaks;
- first observed failing commit begins episode;
- later failure retains first observed commit;
- later pass closes episode;
- definition/binding/policy change creates new current cohort;
- task vs goal operation reliability does not silently mix;
- no reliability row from nonterminal/missing evidence;
- ingest failure does not alter canonical goal result.

### 32.10 Scheduler

- project scheduling=false beats repo schedule;
- minimum interval beats too-frequent request;
- binding uses DB time;
- registry/policy change creates new binding;
- duplicate scheduler workers create one slot disposition;
- active goal -> overlap_skipped;
- project start/queue budget -> budget_skipped;
- no missed-slot stampede after downtime;
- removed/disabled/v1/stale goal never executes;
- HEAD is captured by worker and is not needed for slot dedup.

### 32.11 Security/adversarial

- title/description prompt injection cannot reach operation reason/argv/policy;
- repo cannot set actor/user/policy/grant/adapter/verifier;
- root rebind/symlink replacement fails through trusted project boundary;
- raw dirty paths not stored in goal ledger/snapshot/Redis/API;
- lease token not exposed;
- `allow_once` not consumed;
- repo cannot trigger autonomy/GitHub/code/MCP mutations;
- schedule cannot bypass project-wide budget;
- malformed JSON/duplicate-key/bounds handled by existing strict registry parser contract.

---

## 33. CI / release evidence required before #187 closure

Each implementation slice must run the normal Forge gates plus its focused proof. The final closure must include:

- lint;
- TypeScript;
- complete zero-skip unit command under repository CI convention;
- production build;
- real PostgreSQL migration/populated-upgrade/ACL tests;
- real Redis duplicate/response-loss/claim recovery tests for the new job type;
- deterministic authority race tests;
- SHA-1 and SHA-256 repository fixtures;
- manual API vertical E2E;
- scheduler two-worker/slot/budget proof;
- evidence-leakage sentinel for goal-run DB/API/Redis/log outputs;
- `git diff --check`;
- PR Contract Check;
- Security/Adversarial review for all migrations, auth/authority, filesystem/command, queue/lease, and scheduler slices.

Architecture review and model confidence do not substitute for this evidence.

---

## 34. Explicit non-goals

- synthetic task/work-package proof execution;
- arbitrary model/repository shell;
- repository-supplied operation inputs;
- decisive proof on dirty worktree;
- parallel goal operations;
- operation dependency/data-flow language;
- automatic repair;
- direct autonomy change;
- Sentinel finding implementation;
- independent model verifier implementation;
- browser verifier in schema v2;
- branch/commit/PR/merge authority;
- live MCP tool grants;
- broad host cron;
- production deployment;
- full #191 dashboard/reporting.

---

## 35. Architecture review rule

Before implementation, run the repository's full orthogonal review against this document and the live code/contracts. Review must separately cover:

1. #184/#187 contract and deliberate deviations;
2. exact v1/v2 registry storage compatibility;
3. import-time Operation Catalog binding;
4. execution-subject FKs and historical task compatibility;
5. canonical outcome failure classification;
6. command/evidence ownership;
7. project/registry/policy/filesystem/catalog/repository authority races;
8. canonical lock order/deadlocks;
9. DB lease, Redis duplicate/loss, child-operation recovery;
10. history/reliability comparability;
11. schedule abuse/dedup/overlap/offline recovery;
12. auth/ACL/protected routine/migration cleanup;
13. API/operator recovery clarity;
14. #188/#189/#190/#191 extension boundaries;
15. modularity/reuse and hardcoded-value audit;
16. CI/release evidence completeness.

After every amendment, first verify prior findings are resolved, then run fresh passes for runtime flow, state/persistence, recovery, security, compatibility, and evidence readiness.

A final review may say **“No blockers found in the inspected scope.”** It may not claim absence of defects. Remaining unchecked areas must be named.
