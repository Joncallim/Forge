# Issue #187 Architecture: Verification Goal Run Policy and Goal-Owned Execution

Status: **Consolidated architecture after orthogonal review rounds 1–4. Implementation is not authorized until fresh post-consolidation review finds no material blockers in scope.**

| Field | Value |
|---|---|
| Issue | [#187 — Add project verification goals and scheduled proof runs](https://github.com/Joncallim/Forge/issues/187) |
| Parent Epic | [#184 — Continuous verification and earned autonomy](https://github.com/Joncallim/Forge/issues/184) |
| Foundation | ADR 0013 registry, ADR 0011 Operation Catalog, ADR 0010 canonical outcomes, ADR 0012 reliability ledger |
| Downstream | #188 independent verification, #189 earned autonomy, #190 Project Sentinel, #191 reporting |
| Scope | Complete #187 architecture: executable goal definitions, run policy/authority, manual proof runs, evidence/history, reliability integration, bounded scheduling, migration/recovery/release boundaries |

---

## 1. Outcome

Forge can already import a strict repository-backed verification-goal registry and identify the authoritative complete registry revision. It cannot safely execute those goals yet.

Issue #187 is complete only when Forge can:

1. prove that the **live repository goal registry still matches the explicitly imported authoritative registry**;
2. select only explicitly reviewed deterministic Operation Catalog entries;
3. resolve operator/system execution ceilings without allowing repository text to grant authority;
4. create a first-class **verification goal run**, not a synthetic implementation task;
5. bind decisive proof evidence to one clean repository commit and a bounded execution environment;
6. execute operations sequentially through the existing deterministic executor under database-owned lease fencing;
7. distinguish functional proof failure from authority, infrastructure, evidence, timeout, and recovery uncertainty;
8. emit one overall #185-compatible canonical outcome for the goal run plus child operation outcomes;
9. calculate last-green / first-observed-failure history from decisive evidence;
10. feed comparable child-operation evidence into #186 without sample inflation;
11. support manual runs first, then a bounded deterministic scheduler;
12. preserve explicit human/project authority and fail closed on every version/authority mismatch.

The first executable version remains **read-only**. It does not edit code, repair failures, create branches/PRs, merge, deploy, issue live MCP handles, or modify autonomy.

---

## 2. Current repository facts that constrain this design

### 2.1 Verification goals are definition-only today

ADR 0013 and PRs #328–#330 establish:

- repository files under `.forge/verification-goals/*.json`;
- schema-v1 goal definitions with exact identity/metadata and zero-input Operation Catalog references;
- immutable `verification_goal_snapshots`;
- immutable predecessor-linked registry revisions and entries;
- one protected current registry head;
- project/root/grant/project-revision authority captured at import;
- no execution authority.

A historical v1 snapshot must never become executable merely because Forge is upgraded.

### 2.2 Operation execution is task-owned today

Current production operation execution:

- requires a `task_id`;
- derives repository-read capability from current work-package + project filesystem authority;
- refuses `allow_once`;
- constructs fixed argv itself;
- records command audits;
- verifies deterministic output before terminalization.

A goal run has no legitimate work package. The new design cannot manufacture one.

### 2.3 Shared ledgers are task-owned today

Current PostgreSQL constraints include:

- `execution_outcomes.task_id NOT NULL` and unique task+attempt key;
- `operation_runs.task_id NOT NULL` and unique task+idempotency key;
- repository command-audit ownership by task;
- `capability_attempts.task_id NOT NULL` and reliability contract version 1.

Those contracts must be generalized without weakening historical task referential integrity.

### 2.4 Current outcome semantics are insufficient for decisive project failure

The current executor can map both a deterministic fixed-command failure and an evidence/database failure into a generic `unknown` failure. A proof history cannot safely call both “project failed.”

Goal-owned operation execution therefore depends on a versioned canonical outcome extension that identifies **failure class**.

### 2.5 PostgreSQL is business truth; Redis is delivery only

For goal runs:

- PostgreSQL owns run identity, policy/authority binding, state, lease, evidence, history, and schedule slots;
- Redis wakes workers and carries bounded occurrence identity only;
- duplicate/lost Redis delivery cannot create a second authoritative run or decide a proof result.

---

## 3. Non-negotiable invariants

| ID | Invariant |
|---|---|
| I1 | A verification goal run is never represented by a synthetic task/work package/agent run/task attempt. |
| I2 | Schema-v1 goal snapshots remain definition-only forever. |
| I3 | A new run binds to the exact current registry revision, exact entry, exact repository snapshot, exact code-owned execution binding, and exact current project policy revision. |
| I4 | Before admission and around execution, the live repository goal registry must attest to the current imported registry manifest; mismatch blocks/stops execution. |
| I5 | Repository configuration can only make execution stricter/request work; it can never increase permission, rate, concurrency, deadline, evidence authority, verifier authority, or autonomy. |
| I6 | Project verification execution is disabled by default for existing and new projects. |
| I7 | Only code-owned explicitly allowlisted Operation Catalog id/version pairs may be executed by goal runs. Absence from the allowlist means denied. |
| I8 | Initial eligible operations are zero-input, trusted-project, read-only, deterministic, hardened against repository-configured helper execution, and require no unsupported human/independent verifier. |
| I9 | Goal repository reads require current project-level `filesystem.project.read` authority in `always_allow` mode. `allow_once` is never silently consumed. |
| I10 | Every admitted run has one PostgreSQL identity before Redis delivery. |
| I11 | At most one active run exists per project + logical goal id in v1 across manual and scheduled triggers. |
| I12 | A live PostgreSQL goal-run lease generation/token is the sole business mutation fence. Redis claim state is not business authority. |
| I13 | Goal-subject operation/audit/outcome writes are database-enforced against the live goal lease; stale workers cannot append authoritative evidence. |
| I14 | A decisive pass/fail is bound to one clean Git repository identity (`sha1` or `sha256`) plus a bounded execution-environment fingerprint. |
| I15 | Registry/project/root/grant/policy/catalog/eligibility/repository/system-availability drift produces no stale pass/fail. |
| I16 | Operations execute in canonical sorted order, sequentially, with one overall deadline; no workflow language, piping, variables, dependency graph, or parallelism exists in v1. |
| I17 | Transport success/exit zero alone cannot produce a pass. Required deterministic verification and subject-bound evidence must be durable. |
| I18 | Only a versioned `functional` operation/verification failure can produce goal result `failed`; authority/infrastructure/evidence/timeout/unknown conditions are inconclusive. |
| I19 | Incomplete child operation runs are never replayed inside the same goal run and never inferred into pass/fail. |
| I20 | Goal terminalization atomically writes the overall canonical outcome, final event, and terminal run state. |
| I21 | Overall goal outcome never creates a capability-reliability attempt; only exact child operation outcomes may feed #186. |
| I22 | Repeated observations of one identical evidence unit do not manufacture independent reliability sample count; conflicting repeats are visible. |
| I23 | Scheduler uses database-time bindings/slots, one current slot only, bounded batches, no historical catch-up stampede, and project-wide start budgets. |
| I24 | Goal failure records evidence only. It cannot repair code, change autonomy, create GitHub mutations, widen grants, or invoke a model. |
| I25 | Unknown contract/schema/policy/manifest/eligibility versions fail closed. |

---

## 4. Contract/version inventory

The implementation must use explicit versions; do not reuse “v1” after changing meaning.

```text
Verification goal definition:
  v1 = definition-only (existing)
  v2 = executable declaration

Registry manifest:
  v1 = existing definition-only membership manifest
  v2 = membership + executable entry binding digest

Registry execution binding:
  v1 = code-owned binding stored on v2 registry entries

Verification project policy:
  v1

Resolved run policy:
  v1

Verification goal run row/events:
  v1

Repository identity evidence:
  v1

Execution environment evidence:
  v1

Canonical execution outcome:
  v1 = existing
  v2 = adds closed failure classification / required new stop codes

Capability reliability:
  v1 = existing task-centric contract
  v2 = supports goal subject + environment/evidence-unit semantics

Verification goal operation eligibility policy:
  v1, code-owned security allowlist

Redis verification-run envelope:
  v1

Scheduler binding/slot:
  v1
```

Semantic code changes to any of these must bump the relevant version/digest. Unknown newer versions never fall back to older interpretation.

---

## 5. Goal definition schema v2

### 5.1 Shape

```ts
export type VerificationGoalEvidenceRequirement =
  | 'repository_identity'
  | 'execution_environment'
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

### 5.2 Explicitly forbidden fields

Schema v2 has no place for:

- command or shell text;
- argv;
- operation input values;
- cwd/path;
- environment variables;
- adapter/tool/MCP/server names;
- credentials/tokens;
- model/provider/verifier choice;
- prompt text;
- callbacks/webhooks;
- cron expressions;
- operation dependencies/output piping;
- autonomy or repair actions.

Unknown keys fail import.

### 5.3 Severity is not a permission input

Repository `severity` is reporting/escalation metadata only. It cannot lower:

- Operation Catalog risk;
- eligibility policy;
- project/system policy;
- evidence requirements;
- filesystem/MCP/security gates;
- independent verification requirements;
- autonomy policy.

### 5.4 Evidence requirements are additive

The runner always requires base evidence:

- current registry revision/entry/binding;
- current project/root/grant/policy authority;
- execution environment;
- clean repository identity;
- every child operation run/outcome;
- adapter-required evidence.

`requiredEvidence` may only add a supported requirement. It cannot remove base evidence. Import rejects a requested evidence kind the current runner/eligible operations cannot produce.

### 5.5 Database snapshot support

`verification_goal_snapshots` remains repository-definition truth.

Add/backfill:

```text
definition_schema_version integer not null default 1
```

Replace the exact-v1 JSONB constraint with a closed disjunction:

```text
valid exact v1 shape
OR
valid exact v2 shape
```

The v2 database check enforces:

- exact top-level keys;
- schemaVersion=2 and column parity;
- exact execution keys;
- manual boolean;
- null or exact interval schedule object;
- bounded positive integer deadline/interval;
- closed duplicate-free evidence array;
- bounded operation array.

Existing v1 rows remain byte/meaning compatible.

---

## 6. Code-owned verification-goal operation eligibility

A goal must not automatically inherit every future zero-input Operation Catalog entry.

### 6.1 Separate security allowlist

Do **not** add a new eligibility field to historical `OperationDefinition` objects if that would change existing definition digests without version bumps.

Create a separate code-owned security allowlist:

```ts
export const VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION = 1 as const

export type VerificationGoalOperationEligibility =
  | 'not_allowed'
  | 'manual_only'
  | 'manual_and_scheduled'

export const VERIFICATION_GOAL_OPERATION_ELIGIBILITY = new Map<
  `${string}@${number}`,
  VerificationGoalOperationEligibility
>()
```

Absence = `not_allowed`.

This is intentionally a code-level security allowlist, not DB/operator-editable metadata.

### 6.2 Initial eligibility predicate

In addition to explicit allowlist membership, v1 execution requires the current OperationDefinition to remain:

```text
inputKeys.length == 0
scope == trusted_project
risk == read_only
approvalRequired == false
recovery == none_read_only (or equivalent reviewed read-only recovery)
verification is a supported deterministic verifier
adapter kind is reviewed for goal execution
```

If `independentVerificationRequired=true` before #188 can produce independent evidence, run admission blocks `required_verifier_unavailable`.

A scheduled goal may contain only `manual_and_scheduled` operations.

### 6.3 Harden eligible Git reads before allowlisting

“Read-only argv” is not sufficient if repository-local Git configuration can trigger helper execution.

Before any current Git adapter is allowlisted for goal execution, harden/prove the exact eligible command family:

- `GIT_CONFIG_NOSYSTEM=1`;
- `GIT_CONFIG_GLOBAL=/dev/null` (or platform-equivalent code-owned null config);
- prompts/pagers disabled;
- `GIT_OPTIONAL_LOCKS=0` for proof reads;
- explicit `-c core.fsmonitor=false` (prevent repository-configured fsmonitor hook/daemon behavior);
- a code-owned empty hooks path or equivalent no-hook boundary where applicable;
- diff commands keep `--no-ext-diff --no-textconv`;
- no command uses shell expansion;
- adversarial fixture attempts repository-configured helper execution and must not trigger a sentinel.

### 6.4 Submodules are unsupported in v1

Initial clean-identity/operation semantics do not claim containment over submodule worktrees.

A fixed safe preflight detects a gitlink (`mode 160000`) in the index. If present, the run completes inconclusive with:

```text
submodule_repository_unsupported
```

A later runner version may introduce explicit submodule root/ref bindings.

---

## 7. Executable binding belongs to the registry entry, not the snapshot

A snapshot says what the repository file declared. Code-owned execution semantics can change independently.

### 7.1 Binding contract

For each v2 registry entry, import computes:

```ts
export type VerificationGoalOperationBindingV1 = {
  operationId: string
  operationVersion: number
  definitionDigest: string
  capability: string
  adapter: string
  risk: string
  scope: string
  timeoutMs: number
  verification: string
  approvalRequired: boolean
  independentVerificationRequired: boolean
  eligibility: 'manual_only' | 'manual_and_scheduled'
}

export type VerificationGoalExecutionBindingV1 = {
  schemaVersion: 1
  eligibilityPolicyVersion: 1
  eligibilityPolicyDigest: string
  operations: VerificationGoalOperationBindingV1[]
}
```

Canonical sorted binding -> domain-separated SHA-256 `execution_binding_digest`.

### 7.2 Registry entry storage

Extend immutable entries:

```text
entry_contract_version integer not null default 1
execution_binding jsonb null
execution_binding_digest text null
```

Shape:

```text
entry v1 / goal definition v1:
  entry_contract_version=1
  binding fields null

executable goal definition v2:
  entry_contract_version=2
  binding fields required
```

The binding may differ in a later registry revision while referencing the same immutable repository snapshot. This avoids forcing the repository author to change `definitionVersion` merely because Forge's code-owned eligibility/catalog policy changed.

### 7.3 Current catalog drift

At run admission and before every child operation, re-resolve the exact Operation Catalog id/version and eligibility policy. Their current digests must equal the bound entry.

Mismatch -> no execution/pass/fail:

```text
operation_contract_changed
```

Operator must re-import the registry to explicitly activate the new binding.

---

## 8. Registry manifest v2 and live registry attestation

### 8.1 Manifest versioning

Add to `verification_goal_registry_revisions`:

```text
manifest_schema_version integer not null default 1
```

Historical revisions are v1.

Manifest v1 remains exactly compatible with existing definition-only imports.

Any registry containing a schema-v2 executable entry uses manifest v2. V2 membership includes, in canonical order:

```text
goal id
definition version
definition digest
repository-relative source path
entry contract version
execution binding digest (null sentinel only for non-executable v1 entries)
```

The manifest digest domain includes manifest schema version.

Protected revision-construction SQL validates/recomputes the declared version. Transition uniqueness/dedup is version-safe.

### 8.2 Import response

The import API response is versioned/additive to expose at least:

- registry revision id/sequence;
- manifest schema version;
- manifest digest;
- head advanced/existing;
- snapshot counts.

Do not silently reinterpret the existing response version after adding fields with semantic meaning.

### 8.3 Explicit import remains activation boundary

The runner/scheduler does **not** auto-import changed repository goal files in v1.

If live repository configuration differs from current imported registry:

```text
registry_content_stale
```

and operator action is “import verification goals.”

This preserves explicit configuration activation while keeping repository files the source content.

### 8.4 Read-only live registry attestation

Add a non-mutating attestation path using the same hardened directory-anchored/no-follow bounded reader as import.

It returns only validated/canonical registry identity:

```ts
{
  manifestSchemaVersion,
  manifestDigest,
  registryEntryIdentities,
  capturedProjectAuthority
}
```

No commands or repository code execute.

### 8.5 Two-phase admission

Do not hold project/database locks while traversing goal files.

Manual/scheduler admission:

1. authenticate / identify candidate project;
2. capture current project/root/registry authority;
3. read/attest live registry outside long DB locks;
4. enter canonical transaction;
5. lock/recheck project, current filesystem authority, registry head/revision, selected entry, policy head/revision, active-run/budget state;
6. require the attested live manifest equals the still-current imported head;
7. create run or fail.

### 8.6 Runtime registry re-attestation

After a worker acquires DB lease, before the first child operation and before terminalization (and conservatively before each child operation), re-attest the live registry.

Mismatch -> completed/inconclusive:

```text
registry_content_changed
```

No stale functional result is recorded.

---

## 9. Exact registry-to-current project authority

Run admission also requires the current project authority tuple to equal the registry revision captured at import:

```text
project.submitted_by             == registry.project_submitted_by
project.archived_at              == null == registry.project_archived_at
project.local_path               == registry.project_local_path
project.root_ref                 == registry.root_ref
project.root_binding_revision    == registry.root_binding_revision
project.grant_decision_revision  == registry.grant_decision_revision
project.updated_at               == registry.project_revision
```

Any mismatch:

```text
registry_authority_stale
```

Operator must re-import after confirming/restoring authority.

Queued/running work rechecks exact current registry head + project tuple. V1 conservatively stops on any registry-head revision change even if a future semantic analysis could prove this goal unchanged.

---

## 10. Project verification policy

### 10.1 Immutable DB policy

```text
verification_goal_policy_revisions
- id uuid PK
- project_id uuid NOT NULL
- revision_sequence bigint NOT NULL
- schema_version integer NOT NULL = 1
- policy_digest text NOT NULL
- manual_enabled boolean NOT NULL
- scheduling_enabled boolean NOT NULL
- min_schedule_interval_seconds integer NOT NULL
- max_run_deadline_seconds integer NOT NULL
- max_queue_age_seconds integer NOT NULL
- max_operations_per_run integer NOT NULL
- max_concurrent_runs integer NOT NULL
- max_queued_runs integer NOT NULL
- start_budget_window_seconds integer NOT NULL
- max_starts_per_window integer NOT NULL
- actor_kind text NOT NULL        -- migration_seed | system_default | human
- actor_user_id uuid NULL
- predecessor_revision_id uuid NULL
- created_at timestamptz NOT NULL

verification_goal_policy_heads
- project_id uuid PK
- policy_revision_id uuid NOT NULL
- revision_sequence bigint NOT NULL
- updated_at timestamptz NOT NULL
```

Constraints:

- append-only revisions;
- gapless per-project sequence;
- predecessor same project;
- human actor requires user id;
- system/migration actor requires null user;
- closed positive numeric bounds;
- one exact project head;
- policy digest canonical/domain-separated.

### 10.2 Protected writes

Ordinary app role cannot directly update/delete policy history or move the head.

Use a fixed-search-path protected routine (name illustrative):

```text
forge.append_verification_goal_policy_revision_v1(...)
```

It:

1. locks project;
2. verifies active project and application-authenticated owner relationship;
3. locks expected current head;
4. validates exact bounded values;
5. appends one revision;
6. advances only exact expected head;
7. commits atomically.

Document the same provenance caveat as current registry: PostgreSQL can verify stored project/actor relationships but does not independently authenticate the web session that supplied the application actor id.

### 10.3 Disabled default

Both existing-project migration and new-project creation establish a valid current policy with:

```text
manual_enabled=false
scheduling_enabled=false
```

Missing policy head fails closed. No permissive fallback constant.

New projects receive a disabled `system_default` policy/head atomically via a protected DB initializer/trigger installed after backfill.

### 10.4 One canonical default seed source

Default numeric values are declared once in a versioned verification-policy default contract/seed and tested for exact parity with migration/new-project initialization. Do not duplicate them through SQL, TypeScript, UI, docs, and tests.

Recommended initial **DB defaults** (operator-editable after creation):

```text
manual_enabled=false
scheduling_enabled=false
min_schedule_interval_seconds=3600
max_run_deadline_seconds=600
max_queue_age_seconds=300
max_operations_per_run=16
max_concurrent_runs=2
max_queued_runs=8
start_budget_window_seconds=3600
max_starts_per_window=20
```

A separate centralized `VERIFICATION_GOAL_SYSTEM_LIMITS_V1` provides absolute stricter sanity ceilings; project values outside those ceilings are rejected. Those system constants are security/protocol limits, not scattered runtime defaults.

### 10.5 Project-wide start budget

Queued/concurrent limits alone do not stop many different goals from creating sustained load.

All manual/scheduled admissions enforce the project rolling start budget under the serialized policy-head lock. Idempotency replays do not consume budget again.

### 10.6 Minimal policy operator surface

Before manual execution can be useful, provide an authenticated project-owner policy read/update API (and a minimal Project Settings surface or supported operator command):

```text
GET   /api/projects/:projectId/verification-policy
PATCH /api/projects/:projectId/verification-policy
```

PATCH body contains exact policy fields + expected revision/sequence only. Server derives actor from session. Caller cannot provide actor user id or policy digest.

---

## 11. System/runtime availability ceiling

Project policy cannot turn on code that is not released/healthy.

Central fail-closed runtime gates:

```text
manualVerificationGoalExecutionAvailable
scheduledVerificationGoalExecutionAvailable
```

Rules:

- missing/unavailable -> false;
- gate can only restrict;
- project policy must separately opt in;
- Slice B keeps both false;
- Slice C release enables manual only after release proof;
- Slice E independently enables scheduling;
- emergency disable blocks new work and causes running work to become inconclusive at the next authority checkpoint;
- gate contract version participates in resolved run policy.

---

## 12. Dedicated project-level filesystem authority

Goal runs have no work package. Never call task/package capability code with fabricated metadata.

Add:

```ts
loadVerificationGoalFilesystemAuthority(projectId, goalCapability)
```

For v1:

```text
goal capability = filesystem.project.read
current project filesystem decision exists
current decision is approved
current decision covers filesystem.project.read
grant mode = always_allow
current root/grant revisions match registry/run authority
```

`allow_once` fails closed.

When future non-filesystem capabilities become eligible, each requires its own reviewed code-owned authority adapter. No generic user-editable permissions JSON may bypass that requirement.

---

## 13. Canonical lock order

Before implementation, reconcile this order against existing registry/filesystem routines and use one order everywhere that takes overlapping locks:

```text
1. project
2. current project filesystem decision pointer/current decision
3. verification registry head
4. bound registry revision + selected entry/snapshot
5. verification policy head
6. bound policy revision
7. active verification runs / project budget rows in stable order
8. target verification run
9. child operation rows only after run lock/lease where applicable
```

If an existing producer has an established conflicting order, adjust this design to match that producer before code is written.

Filesystem traversal/live manifest attestation occurs outside long DB locks; transaction then rechecks the captured authority.

Concurrency tests use controlled barriers/advisory locks, not sleeps as correctness proof.

---

## 14. Resolved run policy

### 14.1 Contract

```ts
export type ResolvedVerificationGoalRunPolicyV1 = {
  schemaVersion: 1
  resolverContractVersion: 1
  projectId: string
  registryRevisionId: string
  registryManifestSchemaVersion: number
  registryEntryOrdinal: number
  goalSnapshotId: string
  goalId: string
  goalDefinitionVersion: number
  goalDefinitionDigest: string
  executionBindingDigest: string
  projectPolicyRevisionId: string
  projectPolicyRevisionSequence: string
  triggerKind: 'manual' | 'scheduled'
  effectiveDeadlineSeconds: number
  effectiveQueueAgeSeconds: number
  effectiveScheduleEverySeconds: number | null
  effectiveRequiredEvidence: VerificationGoalEvidenceRequirement[]
  operations: Array<{
    operationId: string
    operationVersion: number
    definitionDigest: string
    eligibility: 'manual_only' | 'manual_and_scheduled'
    timeoutMs: number
  }>
  systemAvailabilityContractVersion: number
}
```

### 14.2 Store exact resolved policy

`verification_goal_runs` stores:

```text
resolved_policy jsonb NOT NULL
resolved_policy_fingerprint text NOT NULL
```

with exact DB shape/size/version checks.

Workers load that snapshot. They do not rerun a newer resolver and replace semantics for an existing run. They only verify that current authority/gates still permit the stored run.

V1 stops on any current policy-head revision change rather than trying to prove semantic equivalence.

---

## 15. Verification goal run persistence

### 15.1 Exact registry entry identity

Add a composite unique identity on registry entries sufficient for a run/schedule FK:

```text
registry_revision_id
project_id
ordinal
snapshot_id
goal_id
definition_version
definition_digest
entry_contract_version
execution_binding_digest
```

For definition-only entries the binding digest is represented by the schema's approved null shape; executable runs require non-null binding.

### 15.2 Exact policy identity

Policy revisions expose a composite unique identity:

```text
(id, project_id, revision_sequence)
```

### 15.3 `verification_goal_runs`

```text
id uuid PK
project_id uuid NOT NULL

registry_revision_id uuid NOT NULL
registry_entry_ordinal integer NOT NULL
goal_snapshot_id uuid NOT NULL
goal_id text NOT NULL
definition_version integer NOT NULL
definition_digest text NOT NULL
entry_contract_version integer NOT NULL
execution_binding_digest text NOT NULL

policy_revision_id uuid NOT NULL
policy_revision_sequence bigint NOT NULL
resolved_policy jsonb NOT NULL
resolved_policy_fingerprint text NOT NULL
authority_fingerprint text NOT NULL

trigger_kind text NOT NULL                 -- manual | scheduled
request_actor_kind text NOT NULL           -- human | scheduler_v1
requested_by_user_id uuid NULL
manual_idempotency_key uuid NULL
manual_request_fingerprint text NULL
schedule_binding_id uuid NULL
schedule_slot_sequence bigint NULL

admission_expires_at timestamptz NOT NULL
status text NOT NULL                       -- queued | running | recovery_required | completed | expired
result text NULL                           -- passed | failed | inconclusive, completed only
terminal_code text NULL
execution_outcome_id uuid NULL             -- overall goal outcome, completed only

lease_generation bigint NOT NULL DEFAULT 0
lease_token uuid NULL
lease_owner text NULL
lease_expires_at timestamptz NULL
recovery_not_before timestamptz NULL

created_at timestamptz NOT NULL
started_at timestamptz NULL
finished_at timestamptz NULL
updated_at timestamptz NOT NULL
```

Required FKs:

- exact composite registry entry;
- exact policy revision/project;
- project;
- requested user when present;
- overall outcome when terminal (installed after generalized outcome table can represent goal subject).

### 15.4 Trigger shape

```text
manual:
  trigger_kind=manual
  actor_kind=human
  requested_by_user_id not null
  manual idempotency/fingerprint not null
  schedule fields null

scheduled:
  trigger_kind=scheduled
  actor_kind=scheduler_v1
  requested_by_user_id null
  manual fields null
  schedule binding/slot not null
```

### 15.5 Lifecycle shape

```text
queued:
  started=null, finished=null, result=null, overall outcome=null, no business lease

running:
  started!=null, finished=null, result=null, live lease required

recovery_required:
  started!=null, finished=null, result=null, no current live worker lease,
  recovery_not_before!=null

completed:
  started!=null, finished!=null,
  result in passed|failed|inconclusive,
  overall outcome != null,
  no live lease

expired:
  started=null, finished!=null, result=null, overall outcome=null, no live lease,
  terminal_code=dispatch_expired
```

### 15.6 One active logical goal

Partial unique:

```text
UNIQUE(project_id, goal_id)
WHERE status IN ('queued','running','recovery_required')
```

A distinct second manual request for an active goal gets `goal_run_active`. Same idempotency replay returns the same row.

### 15.7 Useful indexes

At least:

```text
(project_id, status, created_at)
(project_id, goal_id, finished_at)
(status, admission_expires_at)
(status, lease_expires_at)
(goal_snapshot_id, finished_at)
```

Project start-budget queries must remain indexed/bounded.

---

## 16. Manual idempotency

Manual POST requires UUID `Idempotency-Key`.

Request fingerprint:

```ts
{
  contractVersion: 1,
  actorUserId,
  projectId,
  goalId
}
```

Rules:

- same actor/key/fingerprint -> return existing run;
- same actor/key/different fingerprint -> `409 idempotency_key_conflict`;
- new deliberate run -> new UUID key;
- a request rejected before creating a run does not consume a durable run idempotency record.

Replay first re-authenticates current project access; it does not reinterpret the old run under a new registry/policy.

---

## 17. Safe repository identity evidence

### 17.1 Evidence table

```text
verification_goal_repository_snapshots
- id uuid PK
- run_id uuid NOT NULL UNIQUE -> verification_goal_runs
- project_id uuid NOT NULL
- root_ref uuid NOT NULL
- root_binding_revision bigint NOT NULL
- grant_decision_revision bigint NOT NULL
- project_revision timestamptz NOT NULL
- object_format text NOT NULL               -- sha1 | sha256
- oid text NOT NULL
- clean boolean NOT NULL
- snapshot_fingerprint text NOT NULL
- captured_at timestamptz NOT NULL
```

The run table does **not** require a snapshot FK, avoiding circular mandatory insertion. Query by unique run id; events may reference snapshot id after creation.

### 17.2 Fixed commands

A dedicated hardened helper uses fixed Git reads, including:

```text
git rev-parse --show-object-format
git rev-parse HEAD
fixed clean-status/index checks
fixed gitlink/submodule detection
```

Do not reuse a presentation helper if it stores file/path lists.

Validation:

```text
sha1   -> exactly 40 lowercase hex OID
sha256 -> exactly 64 lowercase hex OID
unknown object format -> inconclusive
unborn/no HEAD -> inconclusive
bare/unsupported repo shape -> inconclusive
submodule gitlink -> inconclusive in v1
```

Raw dirty paths remain in memory only long enough to derive `clean=false` and are discarded.

### 17.3 Revalidation

Recheck repository identity:

1. after run lease claim;
2. before every child operation;
3. after every child operation settles/evidence is durable;
4. before terminalization.

Mismatch -> `repository_changed` inconclusive.

---

## 18. Safe execution environment evidence

Issue #187 requires an environment fingerprint.

Add append-only one-per-run:

```text
verification_goal_environment_snapshots
- id uuid PK
- run_id uuid NOT NULL UNIQUE
- project_id uuid NOT NULL
- schema_version integer NOT NULL = 1
- runner_contract_version integer NOT NULL
- platform text NOT NULL
- architecture text NOT NULL
- node_runtime_version text NOT NULL
- git_runtime_version text NOT NULL
- operation_binding_digest text NOT NULL
- eligibility_policy_version integer NOT NULL
- eligibility_policy_digest text NOT NULL
- environment_fingerprint text NOT NULL
- captured_at timestamptz NOT NULL
```

Normalize runtime versions through one closed parser; bound strings.

Do not store:

- hostname;
- username;
- local path;
- environment-variable dump;
- secret/token;
- network address;
- arbitrary process metadata.

`environment_fingerprint` is the domain-separated digest of the safe normalized compatibility fields. Goal history and goal-subject reliability use it as a comparability input.

Duration is deterministically derived from DB `started_at` / `finished_at` and exposed by the read path; no separate mutable duration counter is required.

---

## 19. Generalizing canonical outcomes

### 19.1 Subject identity

Extend `execution_outcomes`:

```text
subject_kind text NOT NULL                  -- task | verification_goal_run
task_id uuid NULL
verification_goal_run_id uuid NULL
```

Shape:

```text
task:
  task_id not null
  goal_run_id null

verification_goal_run:
  task_id null
  goal_run_id not null
  work_package_id null
  agent_run_id null
  task_attempt_id null
```

Subject-specific partial uniqueness:

```text
UNIQUE(task_id, attempt_key) WHERE subject_kind='task'
UNIQUE(verification_goal_run_id, attempt_key) WHERE subject_kind='verification_goal_run'
```

Historical rows backfill task subject before cutover.

### 19.2 Outcome contract v2

Goal-owned operation outcomes and the overall goal outcome require schema v2:

```ts
export type ExecutionFailureClassV2 =
  | 'functional'
  | 'policy'
  | 'authority'
  | 'infrastructure'
  | 'evidence'
  | 'cancelled'
```

V2 retains existing normalized transport/result/evidence/verifier fields and adds `failureClass` plus required closed stop reasons sufficient to distinguish at least:

```text
operation_execution_failed
evidence_persistence_failed
authority_changed
operation_contract_changed
registry_content_changed
system_execution_disabled
dispatch_expired
```

Database checks enforce legal result/failure-class combinations.

Historical v1 remains readable. Do not rewrite v1 evidence to pretend it had failure-class information.

### 19.3 Existing repository adapter distinction

Goal eligibility cannot be enabled until the adapter path can distinguish:

- fixed command returns deterministic non-zero + durable exact audit -> functional;
- deterministic output verification failure + evidence -> functional;
- audit/evidence persistence failure -> evidence;
- DB/adapter infrastructure failure without decisive evidence -> infrastructure;
- authority drift -> authority;
- timeout/cancel -> infrastructure/cancelled.

`stopReasonCode='unknown'` is never a decisive goal failure.

---

## 20. Generalizing operation runs

Extend `operation_runs` with the same exclusive subject identity.

Goal subject requires:

```text
verification_goal_run_id not null
project_id matches goal run project via composite FK
task/workPackage/agentRun/taskAttempt null
```

Subject-specific unique idempotency:

```text
UNIQUE(task_id, idempotency_key) WHERE task
UNIQUE(verification_goal_run_id, idempotency_key) WHERE goal
```

Refactor context composition:

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

```text
Task authority loader -----┐
                           ├-> shared trusted project scope -> shared policy -> fixed executor/adapters
Goal authority loader -----┘
```

Goal loader verifies exact:

- live goal lease;
- registry head/entry/binding/live manifest;
- project/root/grant authority;
- policy head/resolved policy;
- system runtime availability;
- repository identity;
- eligibility/catalog binding.

No caller supplies project path, capability set, policy, grant, command, adapter, or tool.

---

## 21. External cancellation / overall run deadline

The current shared executor needs an optional outer execution boundary:

```ts
executeTrustedOperation(request, context, {
  signal?: AbortSignal,
  deadline?: MonotonicDeadline
})
```

Task callers that omit it keep current behavior.

Goal runner composes:

- operation's own timeout;
- remaining overall run deadline;
- DB lease-loss watchdog;
- emergency system-availability disable.

Effective child deadline:

```text
min(operation timeout, remaining run deadline)
```

Overall run deadline begins at DB `started_at`, not queue time.

No new operation starts after deadline. Deadline exhaustion is inconclusive, never functional failure.

---

## 22. Goal-subject evidence writes must be DB-lease fenced

Application helper convention is not enough for stale-worker correctness.

For goal subjects, use fixed protected routines and/or database triggers that verify exact current run:

```text
run id
lease generation
lease token
running state
DB lease not expired
```

before authoritative mutation.

Protect at least:

- operation-run begin/event/finalize;
- goal-subject command-audit insert;
- goal-run event insertion where it represents worker evidence;
- repository/environment evidence linking;
- child outcome creation/link where required;
- overall outcome terminalization.

Task-subject legacy behavior remains compatible.

A stale worker whose subprocess returns after lease loss cannot add goal evidence.

---

## 23. Command-audit evidence integrity

Generalize repository command audits to goal subject with exclusive task/goal ownership.

For Operation Catalog executions, add/populate exact `operation_run_id` (or equivalent relational binding).

Initial adapter evidence chain must validate:

```text
goal run
  -> child operation run
  -> child outcome
  -> exact command audit/evidence
```

An arbitrary UUID-shaped evidence reference is insufficient for decisive failure.

Existing internal audit cwd/argv behavior may remain in the protected command-audit sink; goal events/repository snapshot/Redis/public API/reliability rows do not copy raw local paths/output.

---

## 24. Manual run API

### 24.1 Create

```text
POST /api/projects/:projectId/verification-goals/:goalId/runs
Idempotency-Key: <UUID>
```

Request body must be absent/empty.

Caller cannot submit:

- revision/snapshot/binding ids;
- repo path/ref/commit;
- operation/input/capability;
- time/rate/concurrency;
- evidence/verifier;
- actor/policy/grant;
- runtime/provider/model.

### 24.2 Two-phase admission

Phase 1, outside long DB locks:

1. authenticate session/project access;
2. check idempotency replay intent;
3. capture project/root/current registry authority;
4. read/attest live registry manifest using hardened bounded reader.

Phase 2 transaction under canonical locks:

1. re-auth/lock project + current project filesystem decision;
2. lock registry head/revision/selected exact entry;
3. require live manifest == current imported manifest;
4. require exact project authority == registry import authority;
5. require v2 enabled goal + manual requested + executable binding;
6. verify current Operation Catalog + eligibility binding;
7. lock current project policy;
8. require global manual availability + project manual enabled;
9. resolve/store exact monotonic run policy;
10. enforce `always_allow` goal filesystem authority;
11. enforce active-goal uniqueness + queued/running + start budget;
12. calculate DB-time `admission_expires_at`;
13. create one queued run + bounded dispatch event;
14. commit.

After commit: best-effort/retryable Redis publish of run identity.

### 24.3 Fixed error taxonomy

Expected errors use stable redacted codes, including:

```text
unexpected_request_body
invalid_idempotency_key
idempotency_key_conflict
project_not_found
registry_not_imported
registry_content_stale
registry_authority_stale
goal_not_found
goal_schema_not_executable
goal_disabled
operation_not_goal_eligible
operation_binding_stale
required_verifier_unavailable
system_execution_disabled
manual_execution_disabled
filesystem_authority_denied
goal_run_active
start_budget_exhausted
queue_capacity_exhausted
```

No local paths/raw SQL/Redis details/goal internals leak in public error text.

### 24.4 Create response

```json
{
  "schemaVersion": 1,
  "runId": "uuid",
  "goalId": "repository-readable",
  "status": "queued",
  "replayed": false
}
```

### 24.5 Minimal read path

#187 itself must make a run inspectable before #191 dashboard work:

```text
GET /api/projects/:projectId/verification-goal-runs/:runId
```

Return bounded:

- run/goal id;
- trigger kind;
- lifecycle status;
- terminal proof result/code;
- repository object format/OID if captured;
- environment fingerprint;
- created/started/finished/duration;
- bounded child operation run IDs + outcome/evidence reference IDs;
- whether operator recovery/reimport/rerun is required.

Hide local path, raw output, policy JSON, Redis internals, lease token/generation, DB error text.

---

## 25. Redis delivery and PostgreSQL business lease

### 25.1 Envelope

```ts
{
  schemaVersion: 1,
  runId: string,
  occurrenceId: string
}
```

Nothing else.

### 25.2 Do not add a fourth copy-pasted queue implementation

Current queue code duplicates task/approval/answers definitions. Before adding verification runs, extract/reuse generic queue-definition + envelope/claim/malformed/receipt primitives where safe.

Verification policy remains outside queue code.

### 25.3 Ownership hierarchy

Recommended call path:

1. receive/claim Redis occurrence;
2. load run/project identity;
3. acquire PostgreSQL goal-run business lease;
4. once DB lease is durable, acknowledge/release the Redis occurrence best-effort;
5. execute under DB lease only.

If Redis ack is lost, a duplicate may later arrive. Duplicate worker cannot acquire DB lease and safely drops/acks its occurrence.

If DB cannot confirm lease, do not discard transport based on assumed ownership.

Redis outage after a valid DB lease does not grant/revoke business authority. DB lease + local watchdog decide continuation.

### 25.4 Queued redispatch

Queued PostgreSQL rows are recoverable dispatch truth. A bounded dispatcher scans queued/unexpired rows and republishes. Duplicate delivery is safe.

Malformed Redis messages can be quarantined/discarded through shared safe primitives; a real queued DB run remains redispatchable.

---

## 26. DB run lease and PostgreSQL-outage watchdog

### 26.1 Claim

Protected transition:

- DB transaction time;
- run still `queued`, unexpired, current authority still valid enough to claim;
- increment `lease_generation`;
- fresh UUID token + bounded owner id;
- bounded `lease_expires_at`;
- set `started_at` once;
- queued -> running.

### 26.2 Renewal

Exact predicate:

```text
run id + running + lease generation + lease token + unexpired DB time
```

### 26.3 Local monotonic safety deadline

After each successful claim/renewal, worker derives a local **monotonic** stop deadline no later than the persisted lease horizon.

DB renewal uncertainty:

- bounded retries allowed before local deadline;
- failure never extends deadline;
- at deadline abort outer executor signal and start no new work;
- late renewal response cannot revive a locally fenced worker.

When DB returns, only current generation/token can mutate.

---

## 27. Canonical runner flow

```text
queued PostgreSQL run exists
  -> Redis wake-up
  -> acquire DB goal lease
  -> ack Redis occurrence best-effort
  -> capture safe execution environment
  -> revalidate system/project/registry/live-manifest/policy/filesystem/catalog/eligibility authority
  -> capture clean repository identity
  -> if unsupported/dirty: completed inconclusive (when terminalization is safe)
  -> for each canonical bound operation:
       -> verify live DB lease + overall deadline
       -> revalidate authority + live registry + repository identity
       -> build fixed request:
            schemaVersion=1
            exact bound operation id/version
            inputs={}
            requestedCapability=goal capability
            reason='verification_goal_run'
       -> execute shared deterministic executor with outer signal/deadline
       -> child goal-subject ledger/evidence writes require live lease
       -> require terminal canonical outcome-v2 + exact typed evidence
       -> revalidate repository/live registry/authority after settlement
       -> functional failure => stop with failed candidate
       -> nonfunctional non-pass => inconclusive/recovery path
  -> revalidate lease + system/project/registry/live-manifest/policy/filesystem/catalog/repo identity
  -> atomically create overall goal outcome + final event + completed run
  -> after commit only: best-effort capability reliability-v2 ingestion for child operations
```

No LLM call exists in this path.

---

## 28. Goal result decision table

| Child/authority condition | Decisive? | Goal effect |
|---|---:|---|
| all child operations completed + deterministic verification + exact evidence | Yes | passed |
| child outcome-v2 `failureClass=functional` + exact evidence | Yes | failed |
| deterministic verifier functional failure + evidence | Yes | failed |
| repository dirty/changed | No | inconclusive |
| registry live manifest/head/authority changed | No | inconclusive |
| policy/system/filesystem/catalog/eligibility changed | No | inconclusive |
| timeout/cancel | No | inconclusive |
| infrastructure/evidence failure | No | inconclusive |
| current/legacy `unknown` failure | No | inconclusive |
| missing/mismatched evidence | No | inconclusive |
| child operation nonterminal | No | recovery_required then inconclusive if safely recoverable |

Only explicit functional codes may map `verification_goal_runs.result='failed'`.

---

## 29. Overall canonical goal outcome

Every **completed** goal run writes one overall outcome-v2 anchored to the same `verification_goal_run` subject under a reserved final attempt key.

Mapping:

```text
run passed:
  outcome.result = completed
  failureClass = null

run failed:
  outcome.result = failed
  failureClass = functional

run inconclusive:
  outcome.result = needs_attention (or the exact approved v2 inconclusive mapping)
  failureClass = authority | infrastructure | evidence | cancelled as appropriate
```

The architecture implementation pass must freeze the exact v2 result/stop-reason mapping before migration.

Atomic terminal transaction:

1. lock run, verify live lease/generation/token;
2. validate exact repository + environment snapshots;
3. validate exact expected child operation set/outcomes/evidence;
4. append overall execution outcome;
5. append final goal event;
6. set run execution_outcome_id/result/terminal_code/finished_at/status=completed;
7. clear lease;
8. commit.

Response loss/replay returns existing terminal state; no duplicate outcome/event.

`expired` queued runs do **not** fabricate an overall proof outcome.

---

## 30. Child operation recovery

### 30.1 No in-run replay after uncertainty

If worker lease is lost/crashes and a child `operation_run` is nonterminal:

- never rerun that child in the same goal run;
- never create a second child reliability observation for the same in-run ordinal;
- never infer result from a command audit alone;
- parent becomes `recovery_required`.

### 30.2 Crash points

```text
crash after command, before audit:
  no decisive evidence

crash after audit, before child operation finalization:
  audit alone is not pass/fail

crash after child terminalization, before next child:
  v1 does not resume parent after lease loss; parent recovery closes inconclusive
```

The deliberate v1 rule is **no resume after business worker lease loss**. A new manual run/new schedule slot is a new proof identity.

### 30.3 Read-only quarantine horizon

Because v1 eligible operations are proven read-only and every goal evidence write is DB-lease fenced:

1. recovery fences expired generation/token;
2. running -> recovery_required;
3. set DB-time `recovery_not_before` at least maximum eligible child timeout + abort/quiescence margin beyond the last trusted lease horizon;
4. after horizon, verify no current lease/overall outcome/new authorized child evidence;
5. close parent completed/inconclusive `lease_lost` or exact recovery code;
6. preserve incomplete child row.

No child replay and no functional inference.

Side-effecting future operations are not covered by this recovery contract.

---

## 31. Queued expiry

Admission computes:

```text
admission_expires_at = DB transaction time + effective max queue age
```

A bounded dispatcher/recovery process moves an unstarted expired queued run:

```text
queued -> expired
terminal_code=dispatch_expired
finished_at=DB time
result=null
overall outcome=null
```

An expired run never contributes proof history/reliability.

---

## 32. Run events

Append-only bounded event table:

```text
verification_goal_run_events
- id
- run_id
- sequence bigint
- phase                -- admission | dispatch | lease | environment | repository | operation | recovery | finalization
- status               -- observed | passed | failed | blocked
- code                 -- closed taxonomy
- operation_run_id null
- repository_snapshot_id null
- environment_snapshot_id null
- evidence_refs UUID[]
- created_at
```

No free-text/path/prompt/raw error columns.

Worker-authored goal events require live lease when they affect proof evidence. Protected recovery/system events use their own guarded routine/actor code.

---

## 33. History semantics

Current history cohort includes at least:

```text
project id
goal snapshot / definition digest
registry execution binding digest
resolved goal policy fingerprint
execution environment fingerprint
```

Only clean-commit completed `passed|failed` runs count as decisive history.

Definitions:

- `lastGreen` = most recent decisive pass in current cohort;
- `firstObservedFailingCommit` = earliest decisive failed clean commit in current unresolved failure episode;
- `consecutivePasses` = decisive passes since latest decisive failure; inconclusive ignored;
- `consecutiveFailures` = decisive failures since latest decisive pass; inconclusive ignored;
- later pass closes failure episode but preserves history.

Do not call it “first bad commit” without a separate bisect/causality proof.

A definition/binding/policy/environment cohort change begins new current-cohort history while preserving old evidence.

---

## 34. Capability reliability v2

### 34.1 Overall goal outcome excluded

Only child outcomes linked to terminal `operation_runs` create operation capability observations.

Overall goal outcome never creates a capability attempt.

### 34.2 Goal-subject reliability contract v2

Current v1 DB requires task id/contract=1 and v1 outcome taxonomy. Goal execution requires a versioned reliability extension:

```text
subject_kind = verification_goal_run
verification_goal_run_id != null
task/workPackage/agent/taskAttempt = null
contract_version = 2
evidence_unit_fingerprint NOT NULL
environment_fingerprint NOT NULL
outcome-v2 compatible failure fields/checks
```

Task v1 remains readable unchanged.

V2 deterministic runtime fingerprint includes:

```ts
{
  kind: 'deterministic_adapter',
  adapterKind,
  executionEnvironmentFingerprint
}
```

V2 policy fingerprint includes:

```text
executionSubjectKind=verification_goal_run
resolved goal policy
registry goal/binding identity
```

so task-issued and proof-issued operation evidence does not silently share a cohort under materially different policy.

### 34.3 Evidence unit prevents sample inflation without hiding repeats

Every goal child observation derives:

```text
evidence_unit_fingerprint = H(
  project,
  goal snapshot/binding,
  operation id/version,
  clean repo object format/OID,
  resolved goal policy,
  environment fingerprint
)
```

Store every observation; do **not** discard repeated executions.

Metrics expose:

- raw observation count;
- unique evidence-unit count;
- promotion-grade sample count based on unique evidence units.

If one evidence unit has conflicting decisive outcomes, reliability enters an explicit evidence-instability/conflict state and cannot support autonomy promotion until #189 policy handles it.

Repeated daily/manual proof of one unchanged commit therefore remains visible operational history but cannot manufacture independent trust samples.

### 34.4 No uncertain ingest

No reliability v2 row from:

- nonterminal child operation;
- missing/drifted evidence;
- uncertain subject attribution;
- expired/non-started goal run;
- overall goal outcome.

Ingest remains best-effort after canonical operation evidence; failure never changes goal result.

---

## 35. Scheduling (Slice E, after manual vertical slice)

### 35.1 Repository request + operator/system permission

A v2 goal may request interval scheduling. It schedules only when:

- current live registry exactly matches imported head;
- current entry is executable v2;
- every operation binding is `manual_and_scheduled`;
- project scheduling policy enabled;
- global scheduling availability enabled;
- project authority/current filesystem `always_allow` valid.

### 35.2 Immutable schedule binding

```text
verification_goal_schedule_bindings
- id
- project_id
- exact registry entry composite identity
- exact policy revision composite identity
- execution_binding_digest
- schedule_fingerprint
- interval_seconds
- anchor_at (DB time)
- created_at
```

A registry/policy/binding change produces a new binding.

First due:

```text
anchor_at + effective interval
```

Enabling scheduling does not surprise-run immediately; operator may manually run now.

### 35.3 Slot table

```text
verification_goal_schedule_slots
- binding_id
- slot_sequence bigint
- slot_due_at timestamptz
- disposition text
    run_created
    overlap_skipped
    budget_skipped
    registry_stale
    policy_stale
    system_disabled
- skipped_prior_slots integer default 0
- run_id uuid null
- created_at
PRIMARY KEY(binding_id, slot_sequence)
```

No repository HEAD in slot/dedup identity. Worker captures HEAD after run starts.

### 35.4 Multi-worker and downtime behavior

- DB unique slot makes scheduler races idempotent;
- scheduler uses bounded cursor/batch processing with named centralized scan limits;
- no LLM;
- if offline across many intervals, materialize at most the current eligible slot and bounded skipped count; do not enqueue every missed interval;
- one active logical goal across manual/scheduled means overlap slot is skipped;
- project queued/running/start budget applies;
- budget/overlap skipped slots do not create delayed backlog.

### 35.5 Live registry attestation

Scheduler may perform one bounded live-registry attestation per captured project/root authority and reuse it only within that exact bounded project batch. Each run/slot transaction rechecks DB authority/head. Mismatch -> `registry_stale`, no auto-import.

---

## 36. #189 / #190 / #188 boundaries

### 36.1 Regression candidate only

#187 can deterministically expose:

```text
current-cohort prior decisive latest = passed
new decisive result = failed
```

This is a regression **candidate**, not a Sentinel finding.

#190 later creates/deduplicates findings.

### 36.2 No direct autonomy action

Repository schema v2 has no executable autonomy action. #189 consumes proof/reliability evidence under its own operator-owned policy.

### 36.3 Independent verification is append-only future evidence

#188 later links separate verifier runs/history to a verification goal run/overall outcome. It never rewrites #187 deterministic result.

Human-browser and Playwright-browser lanes remain separate; schema v2 cannot choose a browser/model/provider/verifier.

---

## 37. Migration / rolling-release sequence

Do not combine all schema changes into one unsafe cutover.

### Phase 0 — registry expansion

- add definition schema version support for v2 snapshots;
- add registry manifest schema version;
- add entry contract/binding columns;
- extend protected registry routine/import response;
- v1 manifests/imports remain compatible;
- no goal execution.

### Phase 1 — policy foundation

- add protected policy revisions/heads/default disabled backfill/new-project initializer;
- policy GET/PATCH/project settings;
- manual/schedule global availability false.

### Phase 2 — shared-ledger expand compatibility

- add nullable `verification_goal_run_id`, subject/version fields to shared outcome/operation/audit tables while existing task NOT NULL/task paths remain valid where possible;
- deploy dual-version readers/types;
- audit every generic query/caller that assumes task id non-null;
- goal execution still false.

### Phase 3 — goal run/evidence tables

- add run/events/repository/environment evidence + protected lease/terminal routines;
- add outcome-v2 contracts but no goal rows yet.

### Phase 4 — shared-ledger cutover

- backfill historical rows `subject_kind=task`;
- install exclusive subject checks/composite FKs/partial unique indexes;
- safely relax task NOT NULL only after dual consumers deployed;
- database guard prevents old unsupported consumers from seeing/writing goal rows during cutover;
- prove historical task behavior.

### Phase 5 — manual execution release

- harden/allowlist eligible Git adapters;
- outer abort/deadline support;
- goal authority loader;
- manual route/Redis delivery/DB lease/runner/minimal GET;
- full proof;
- then enable global manual availability; every project still default-disabled.

### Phase 6 — reliability v2/history

- extend capability attempts/readers/metrics for goal subject/evidence units/outcome-v2;
- activate only after dual-version proof.

### Phase 7 — scheduler

- schedule bindings/slots/scheduler loop;
- full multi-worker/offline/budget proof;
- then enable global scheduling availability.

No goal-subject row is written while a supported old consumer can misinterpret nullable task identity.

---

## 38. Migration/ACL proof requirements

Every slice that touches PostgreSQL includes:

- current Drizzle journal parity;
- populated upgrade from current production schema;
- installer-managed, legacy-repair, populated 0026/0027/current-tip paths as relevant;
- protected-owner failure/handoff cleanup proof consistent with existing Forge style;
- fixed-search-path protected functions;
- immediate `REVOKE ... FROM PUBLIC` for protected functions;
- closed ordinary-app ACL inventory;
- no temporary gap where task uniqueness/FK protection is removed before replacement constraints exist;
- invalid zero-subject/two-subject/cross-project/cross-registry/cross-policy shapes rejected by PostgreSQL;
- migration crash/retry idempotency;
- v1 goal snapshots and historical task outcomes/operation runs/reliability remain readable with original meaning.

---

## 39. Module boundaries

```text
web/lib/verification-goals/contracts.ts
  v1/v2 repo definitions; canonical definition digests

web/lib/verification-goals/eligibility.ts
  code-owned exact operation goal-eligibility allowlist/version/digest

web/lib/verification-goals/policy-contracts.ts
  project policy + resolved policy + monotonic pure resolver

web/lib/verification-goals/history.ts
  pure decisive-history calculation

web/worker/verification-goals/registry-attestation.ts
  bounded non-mutating live registry manifest read using trusted importer primitives

web/worker/verification-goals/admission.ts
  two-phase manual/scheduler admission + exact authority rechecks

web/worker/verification-goals/filesystem-authority.ts
  project-level goal capability authority, no work-package shim

web/worker/verification-goals/repository-snapshot.ts
  hardened clean SHA-1/SHA-256 identity + submodule refusal

web/worker/verification-goals/environment-snapshot.ts
  safe bounded runtime compatibility fingerprint

web/worker/verification-goals/ledger.ts
  goal run/events/lease/recovery/terminal protected persistence

web/worker/verification-goals/runner.ts
  sequential orchestration only

web/worker/verification-goals/scheduler.ts
  bounded DB-time binding/slot scheduler; no LLM

web/worker/operations/context.ts
  shared project scope + task/goal subject adapters

web/worker/operations/executor.ts
  subject-neutral deterministic executor + optional outer abort/deadline

web/worker/queue/*
  reusable transport primitives; no verification policy
```

Rules:

- pure contracts do not import DB;
- routes are thin auth/orchestration shells;
- filesystem access stays behind trusted project-root/registry/repository helpers;
- subject differences live at authority/persistence adapters, not scattered switches in every executor phase;
- queue carries identity, not policy;
- scheduler performs deterministic DB/filesystem checks only;
- no repo-controlled adapter/verifier/policy registration;
- operator-tunable numeric values are DB-backed; code constants are closed protocol/security ceilings only.

---

## 40. Implementation slices

### Slice A — executable definition + registry binding + project policy

- v2 parser/DB shape;
- registry manifest v2 + entry execution bindings + live attestation;
- code-owned operation eligibility policy;
- protected policy revisions/heads/defaults + policy API/settings;
- no run/execution.

### Slice B — goal execution-subject/evidence foundation

- goal run/events/repo/environment tables;
- exact composite FKs;
- protected goal lease/evidence routines;
- shared outcome/operation/audit subject expansion;
- outcome-v2 failure class;
- dual-reader/rolling compatibility;
- global execution still disabled.

### Slice C — manual read-only proof vertical slice

- harden/allowlist current read adapters;
- outer abort/deadline support;
- dedicated project filesystem authority;
- bodyless idempotent POST + bounded GET;
- DB-first queue/early Redis ack/DB lease/watchdog;
- clean SHA-1/SHA-256 identity + submodule refusal;
- sequential deterministic operations;
- overall canonical outcome;
- no scheduling.

### Slice D — history + reliability v2

- last green / first observed failure / streaks;
- capability attempt goal subject;
- environment + evidence-unit comparability;
- evidence-instability state;
- overall outcome excluded;
- no #188 independent agent yet.

### Slice E — bounded scheduler

- binding/slot tables;
- bounded cursor loop;
- live manifest current check;
- current-slot only / no catch-up stampede;
- active-goal/queue/concurrency/start-budget controls;
- scheduler recovery/runbook;
- global scheduling activation only after proof.

### Slice F — #187 closure proof/docs

- checked-in sample v2 goal;
- manual and scheduled end-to-end evidence;
- migration/ACL/Redis/DB-lease/registry-drift/repo-drift tests;
- operator run/reimport/recovery guidance;
- acceptance-criteria traceability.

---

## 41. Acceptance-criteria mapping

| #187 requirement | This architecture |
|---|---|
| repository-backed versioned goal | v1 preserved; v2 executable declaration |
| deterministic safe verifier | code-owned eligible Operation Catalog bindings only |
| timeout/resource bounds | DB policy + system ceilings + overall external deadline |
| manual first | Slice C before Slice E |
| controlled scheduling | DB-time binding/slot + policy/budgets/availability |
| structured persisted result/evidence | run/events/repo/env + child outcomes + overall outcome |
| repository commit/environment fingerprint | safe repo identity + environment snapshot |
| last green / first observed failure | decisive current-cohort history |
| canonical outcomes | outcome-v2 child + overall goal outcome |
| reliability compatible | reliability-v2 child operation observations/evidence units |
| overlap/dedup | one active goal + unique schedule slot + DB lease |
| disabled goals never run | current live/imported registry + project/system policy checks |
| failure no unreviewed repair | explicit #190/#189 boundary |
| human/Playwright lanes separate | no browser verifier in v2; #188 separate records |
| redaction | closed events; no raw dirty paths/Redis policy/lease secret/public raw errors |

### Deliberate deviation — autonomy action

The issue's early example includes a failure autonomy action. #187 does not make repository configuration executable autonomy policy. #189 owns that decision and consumes #187 evidence.

### Deliberate wording — first observed failing commit

#187 does not bisect or prove causality. Report “first observed failing commit,” not “commit that introduced failure.”

---

## 42. Verification matrix

### 42.1 Definition/registry

- v1 exact behavior retained/non-executable;
- v2 exact parser/DB keys and bounds;
- duplicate-key/unknown-key/overflow rejected;
- operation unknown/disabled/deprecated/input-bearing/capability mismatch rejected;
- operation not in goal eligibility allowlist rejected;
- scheduled goal with manual-only operation rejected;
- eligibility/catalog binding canonical/deterministic;
- manifest v1 remains compatible;
- manifest v2 includes binding digest;
- same repo snapshot may appear in later revision with new code binding;
- live registry mismatch blocks manual/schedule;
- post-admission live registry change makes run inconclusive.

### 42.2 Git security/identity

Adversarial repository config attempts:

- fsmonitor hook/helper;
- global/system config contamination;
- pager/prompt;
- diff external/textconv;
- optional index lock/write.

Proof no helper sentinel runs and no optional repo mutation occurs.

Also:

- SHA-1 40 hex;
- SHA-256 64 hex;
- unknown format/unborn/bare unsupported -> inconclusive;
- gitlink/submodule -> unsupported inconclusive;
- dirty tracked/untracked state -> clean=false with zero stored path list.

### 42.3 Policy/ACL

- migration/new project gets disabled policy;
- missing head no fallback;
- human/system actor shape;
- owner/CAS stale-head race;
- app cannot direct update/delete/head move;
- PUBLIC cannot execute protected routine;
- repo request never widens resolved policy property tests;
- system availability always stricter.

### 42.4 Referential integrity

- run exact registry entry + binding FK;
- schedule exact entry + policy FK;
- outcome/operation/audit goal subject cannot carry task links;
- task rows remain task-shaped;
- zero/two subject rejected;
- cross-project goal operation rejected;
- completed run requires exact overall outcome;
- expired run cannot have proof result/outcome.

### 42.5 Admission races

Controlled interleavings:

- project/root/grant changes during attestation;
- registry head changes after attestation;
- policy head changes after resolution;
- active run created concurrently;
- start budget concurrent admissions;
- eligibility/catalog build mismatch;
- live registry file commit/change after attestation.

No stale run admitted as valid.

### 42.6 Outcome classification

- completed+deterministically verified+evidence -> child pass;
- fixed nonzero command + durable exact audit -> functional failure;
- verifier reject -> functional failure;
- audit DB failure -> evidence/inconclusive;
- adapter DB/infra failure -> inconclusive;
- authority drift -> inconclusive;
- timeout -> inconclusive;
- legacy/generic unknown -> inconclusive;
- arbitrary/mismatched evidence UUID -> inconclusive;
- overall goal outcome atomically matches run result.

### 42.7 Lease/queue/recovery

- duplicate Redis delivery -> one DB lease winner;
- loser safely acks duplicate;
- Redis ack response lost after DB claim -> no duplicate business work;
- DB unavailable -> no assumed lease/unsafe drop;
- lease renewal uncertainty -> monotonic stop deadline;
- late renewal cannot revive fenced worker;
- stale token cannot insert audit/op event/outcome/run event/terminal state;
- crash command-before-audit -> no inference;
- crash audit-before-op-final -> no inference;
- nonsettling child -> recovery_required;
- read-only quarantine horizon -> parent inconclusive without child replay;
- queued run past admission expiry -> expired;
- lost terminal response -> exact existing outcome/state replay.

### 42.8 Manual API

- unauthenticated/non-owner/inaccessible/archived denied under current app convention;
- body rejected;
- idempotency invalid/missing rejected;
- key same intent replay;
- key different intent 409;
- v1/disabled/manual-false/registry stale/policy disabled/system disabled/no always_allow/budget/active-run all no execution;
- GET bounded output/leakage checks.

### 42.9 History/reliability

- inconclusive/expired excluded from decisive streaks;
- first observed failing commit episode rules;
- policy/binding/environment cohort change resets current cohort;
- overall outcome excluded from capability attempts;
- goal reliability contract v2 preserves task v1;
- repeated same evidence unit does not increase unique sample count;
- conflicting repeated unit yields evidence instability;
- nonterminal/missing evidence no ingest;
- reliability ingest failure cannot change goal result.

### 42.10 Scheduler

- scheduling false wins;
- global gate false wins;
- minimum interval wins;
- first due = anchor+interval;
- duplicate scheduler workers one slot;
- manual active -> schedule overlap skipped;
- project budget -> budget skipped;
- live registry stale -> no run/auto-import;
- policy/registry change -> new binding;
- downtime -> current slot only, bounded skipped count;
- bounded cursor/scan limit;
- removed/disabled/v1 goal never runs.

### 42.11 Migration/rolling compatibility

- old task-only consumers remain valid through expand;
- static/runtime audit finds unguarded task-id assumptions;
- no goal row before dual consumers deployed;
- cutover subject checks/partial uniques preserve task semantics;
- populated current-tip upgrade;
- failure-safe protected owner cleanup/retry;
- task/outcome/op/reliability historical rows unchanged in meaning.

---

## 43. Release evidence before #187 closure

Required, in addition to normal Forge gates:

- lint;
- TypeScript;
- complete zero-skip unit command under repository convention;
- production build;
- real PostgreSQL migration/populated-upgrade/ACL/subject-shape tests;
- real Redis delivery duplicate/loss/malformed/recovery tests;
- DB lease/outage/watchdog controlled tests;
- malicious Git repo-config helper execution sentinel;
- SHA-1 and SHA-256 fixture repositories;
- live registry content drift tests;
- manual API end-to-end;
- scheduler multi-worker/offline/budget proof;
- cross-sink leakage scan for goal DB/API/Redis/log output;
- mutation tests for critical fail-closed predicates;
- `git diff --check`;
- PR Contract Check;
- Security/Adversarial review for every auth/filesystem/command/DB lease/migration/scheduler slice.

Architecture review confidence is not release evidence.

---

## 44. Explicit non-goals

- synthetic task/work-package proof execution;
- arbitrary shell/model commands;
- repository-supplied operation inputs;
- dirty-worktree decisive proof;
- submodule proof coverage in v1;
- side-effecting goal operations in v1;
- parallel operations;
- operation workflow language/data flow;
- automatic repair;
- direct autonomy change;
- Sentinel finding implementation;
- independent model verifier implementation;
- browser verifier in schema v2;
- branch/commit/PR/merge authority;
- live MCP tool grants;
- broad host cron;
- production deployment;
- full #191 dashboard/export.

---

## 45. Post-consolidation architecture review rule

Review this consolidated design afresh against live code, not merely against the prior finding list.

Required independent passes:

1. contract/#187 acceptance/deviation;
2. data model + FK/version/migration compatibility;
3. complete call path from API/scheduler -> registry attestation -> DB admission -> Redis -> DB lease -> repository -> operation executor -> outcomes -> history;
4. failure/recovery and every response-loss/crash boundary;
5. security: auth/ACL, Git config/helper execution, root/path, stale worker, resource abuse, leakage;
6. reliability/#189 trust-sample integrity;
7. scheduler scalability/overlap/offline behavior;
8. API/operator recovery clarity;
9. rolling deployment/regression against current tasks/outcomes/operations/reliability;
10. CI/release-evidence sufficiency;
11. modularity/reuse/hardcoded-value audit;
12. downstream #188/#189/#190/#191 compatibility.

If a pass finds a material issue, amend the primary design, verify the finding is resolved, and start fresh passes again.

A final verdict may state **“No blockers found in the inspected architecture scope.”** It must still name residual uncertainty and may not claim that no defects exist.
