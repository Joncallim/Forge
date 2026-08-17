# Issue #187 Architecture: Verification Goal Run Policy and Goal-Owned Execution

Status: **Consolidated architecture after orthogonal review rounds 1–6. Implementation is not authorized until fresh post-amendment review finds no material blockers in scope.**

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
5. bind decisive proof evidence to one strictly clean repository commit and a bounded execution environment;
6. execute the exact bound operations in canonical ordinal order through the existing deterministic executor under database-owned lease fencing;
7. distinguish functional proof failure from authority, infrastructure, evidence, timeout, and recovery uncertainty;
8. emit one overall #185-compatible canonical outcome for the goal run plus child operation outcomes;
9. calculate last-green / first-observed-failure history from validated decisive evidence;
10. feed comparable child-operation evidence into #186 without sample inflation;
11. support manual runs first, then a bounded deterministic scheduler;
12. preserve explicit human/project authority and fail closed on every version/authority/evidence mismatch.

The first executable version remains **read-only**. It does not edit code, repair failures, create branches/PRs, merge, deploy, issue live MCP handles, or modify autonomy.

---

## 2. Current repository facts that constrain this design

### 2.1 Verification goals are definition-only today

ADR 0013 and PRs #328–#330 establish repository files under `.forge/verification-goals/*.json`, schema-v1 goal definitions with exact identity/metadata and zero-input Operation Catalog references, immutable snapshots/revisions/entries, one protected current registry head, import-time project/root/grant/project-revision authority, and no execution authority.

A historical v1 snapshot must never become executable merely because Forge is upgraded.

### 2.2 Operation execution is task-owned today

Current production operation execution requires a `task_id`, derives repository-read capability from current work-package + project filesystem authority, refuses package `allow_once`, constructs fixed argv itself, records command audits, and verifies deterministic output before terminalization.

A goal run has no legitimate work package. The new design cannot manufacture one.

### 2.3 Shared ledgers are task-owned today

Current PostgreSQL constraints include `execution_outcomes.task_id NOT NULL`, `operation_runs.task_id NOT NULL`, task-owned repository command audits, and `capability_attempts.task_id NOT NULL` under reliability contract version 1.

Those contracts must be generalized without weakening historical task referential integrity.

### 2.4 Current outcome semantics are insufficient for decisive project failure

The current executor can map both a deterministic fixed-command failure and an evidence/database failure into a generic `unknown` failure. A proof history cannot safely call both “project failed.”

Goal-owned operation execution therefore depends on a versioned canonical outcome extension that identifies **failure class**.

### 2.5 Existing project filesystem decisions already represent persistent project authority

`project_filesystem_grant_decisions` + `project_filesystem_current_decision_pointers` are the persistent project-level authorization substrate. They do **not** carry the package-level `grantMode` field. Goal execution consumes that existing persistent project decision directly; it does not add a redundant project grant-mode column.

### 2.6 Existing Git command code already has one substantial hardening environment

Repository evidence code centrally disables system/global config, fsmonitor, untracked cache, external diff, credential/LFS process helpers, optional locks, prompts and pagers for its fixed command path. Goal proof helpers must reuse/refactor that single safe environment rather than create another drifting Git-security list.

### 2.7 PostgreSQL is business truth; Redis is delivery only

PostgreSQL owns run identity, policy/authority binding, state, lease, evidence, history, and schedule slots. Redis wakes workers and carries bounded occurrence identity only. Duplicate/lost Redis delivery cannot create a second authoritative run or decide a proof result.

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
| I9 | Goal repository reads require the current persistent project-level filesystem decision to be approved and contain `filesystem.project.read`; package-level `allow_once` is not a goal-run authority source. |
| I10 | Every admitted run has one PostgreSQL identity before Redis delivery. |
| I11 | At most one active run exists per project + logical goal id in v1 across manual and scheduled triggers. |
| I12 | Project queued, running, recovery-required and total-active counts are independently bounded by indexed DB policy checks. |
| I13 | A live PostgreSQL goal-run lease generation/token is the sole business mutation fence. Redis claim state is not business authority. |
| I14 | Goal-subject operation/audit/outcome writes are database-enforced against the live goal lease; stale workers cannot append authoritative evidence. |
| I15 | Goal-subject proof evidence becomes immutable after authoritative creation/finalization. |
| I16 | A decisive pass/fail is bound to one **strictly clean** Git repository identity (`sha1` or `sha256`) plus a bounded execution-environment fingerprint. No task-specific ignored-path exception is permitted. |
| I17 | Registry/project/root/grant/policy/catalog/eligibility/repository/system-availability drift produces no stale pass/fail. |
| I18 | Operations execute in canonical sorted order with a persisted ordinal, sequentially, with one overall deadline; no workflow language, piping, variables, dependency graph, or parallelism exists in v1. |
| I19 | The protected operation-begin transition can start only the exact next operation in the stored resolved policy. No skipped, duplicate, or extra operation may be executed. |
| I20 | Transport success/exit zero alone cannot produce a pass. Required deterministic verification and subject-bound evidence must be durable. |
| I21 | Only a versioned `functional` operation/verification failure can produce goal result `failed`; authority/infrastructure/evidence/timeout/unknown conditions are inconclusive. |
| I22 | Incomplete child operation runs are never replayed inside the same goal run and never inferred into pass/fail. |
| I23 | Goal terminalization validates the exact permitted child-operation prefix and atomically writes the overall canonical outcome, final event, evidence-set digest, and terminal run state. |
| I24 | Overall goal outcome never creates a capability-reliability attempt; only exact child operation outcomes may feed #186. |
| I25 | Repeated observations of one identical evidence unit do not manufacture independent reliability sample count; conflicting repeats are visible. |
| I26 | Scheduler uses database-time bindings/slots, one current slot only, bounded batches, no historical catch-up stampede, and project-wide start budgets. |
| I27 | Goal failure records evidence only. It cannot repair code, change autonomy, create GitHub mutations, widen grants, or invoke a model. |
| I28 | Unknown contract/schema/policy/manifest/eligibility versions fail closed. |

---

## 4. Contract/version inventory

```text
Verification goal definition:
  v1 = definition-only (existing)
  v2 = executable declaration

Registry manifest:
  v1 = existing definition-only membership manifest
  v2 = membership + executable entry binding digest

Registry execution binding: v1
Verification project policy: v1
Resolved run policy: v1
Verification goal run/events: v1
Repository identity evidence: v1
Execution environment evidence: v1
Goal evidence-set descriptor: v1

Canonical execution outcome:
  v1 = existing
  v2 = closed failure classification / new stop reasons

Capability reliability:
  v1 = existing task-centric contract
  v2 = goal subject + environment/evidence-unit semantics

Verification goal operation eligibility: v1, code-owned security allowlist
Verification goal system limits: v1
Redis verification-run envelope: v1
Scheduler binding/slot: v1
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
  | { kind: 'interval'; everySeconds: number }

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

No command/shell/argv, operation input, cwd/path, environment variables, adapter/tool/MCP/server, credentials, model/provider/verifier, prompt, callback/webhook, cron expression, operation dependency/output piping, autonomy action or repair action.

Unknown keys fail import.

### 5.3 Severity is not a permission input

Repository `severity` is reporting/escalation metadata only. It cannot lower Operation Catalog risk, eligibility, project/system policy, evidence requirements, filesystem/MCP/security gates, independent verification requirements, or autonomy policy.

### 5.4 Evidence requirements are additive

The runner always requires current registry/entry/binding, current project/root/grant/policy authority, execution environment, strictly clean repository identity, every **executed** child operation in the valid canonical prefix, and adapter-required evidence.

`requiredEvidence` may only add a supported requirement. It cannot remove base evidence.

### 5.5 Database snapshot support

`verification_goal_snapshots` remains repository-definition truth. Add/backfill `definition_schema_version integer NOT NULL default 1`. Replace the exact-v1 JSONB check with a closed exact-v1 OR exact-v2 disjunction. V2 DB checks mirror exact keys/types/bounds. Existing v1 rows remain byte/meaning compatible.

---

## 6. Code-owned verification-goal operation eligibility

### 6.1 Separate security allowlist

Do not change historical `OperationDefinition` digests merely to add goal eligibility. Use a separate exact id/version allowlist:

```ts
export const VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION = 1 as const

type VerificationGoalOperationEligibility =
  | 'not_allowed'
  | 'manual_only'
  | 'manual_and_scheduled'

export const VERIFICATION_GOAL_OPERATION_ELIGIBILITY = new Map<
  `${string}@${number}`,
  VerificationGoalOperationEligibility
>()
```

Absence = `not_allowed`.

### 6.2 Initial eligibility predicate

In addition to allowlist membership:

```text
inputKeys.length == 0
scope == trusted_project
risk == read_only
approvalRequired == false
recovery == none_read_only (or reviewed equivalent)
verification is a supported deterministic verifier
adapter kind is reviewed for goal execution
```

`independentVerificationRequired=true` blocks until #188 can produce it. Scheduled goals may contain only `manual_and_scheduled` operations.

### 6.3 Harden eligible Git reads before allowlisting

Reuse/refactor the repository's existing centralized hardened Git environment builder rather than create a second list. Effective proof boundary includes disabled system/global config, fsmonitor, untracked cache, external/interactive diff filters and credential/process helpers as applicable, optional locks off, prompts/pagers off, a no-hook boundary where relevant, `--no-ext-diff --no-textconv` for diff, no shell form, and an adversarial helper-execution sentinel.

### 6.4 Submodules unsupported in v1

A fixed safe preflight detects any gitlink (`mode 160000`). If present, goal result is inconclusive `submodule_repository_unsupported`. A later runner version may add explicit submodule bindings.

---

## 7. Executable binding belongs to the registry entry, not the snapshot

A snapshot is repository-definition truth; code-owned execution semantics can change independently.

### 7.1 Binding

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

Canonical sorted binding -> domain-separated `execution_binding_digest`.

### 7.2 Entry storage

Extend immutable registry entries:

```text
entry_contract_version integer NOT NULL default 1
execution_binding jsonb NULL
execution_binding_digest text NULL
```

V1 entry -> binding null. Executable v2 entry -> binding required.

A later Forge code/eligibility change may produce a new registry revision/binding while pointing to the same immutable repository snapshot. Repository authors do not need a fake definition-version bump for Forge code-policy changes.

### 7.3 Current catalog drift

At admission and before every child operation, current Operation Catalog + eligibility digests must equal the bound entry. Mismatch -> `operation_contract_changed`, requiring explicit re-import.

---

## 8. Registry manifest v2 and live attestation

### 8.1 Manifest version

Add `manifest_schema_version integer NOT NULL default 1` to registry revisions.

Manifest v1 stays byte-compatible. Any registry containing executable v2 entries uses manifest v2, whose canonical membership includes goal id, definition version/digest, source path, entry contract version and execution-binding digest (closed null sentinel only for non-executable v1 entries). Digest domain includes manifest version.

Protected registry revision construction validates/recomputes the declared version. Import response is versioned/additive to expose manifest version/digest.

### 8.2 Explicit import remains activation

Runner/scheduler do **not** auto-import. Live content mismatch -> `registry_content_stale`, safe action “import verification goals.”

### 8.3 Bounded live attestation

Use the same hardened directory-anchored/no-follow bounded reader as import, without mutation. Return only canonical manifest identity + captured project authority.

### 8.4 Two-phase admission

1. authenticate/identify project;
2. capture current project/root/registry authority;
3. attest live registry outside long DB locks;
4. enter canonical transaction;
5. lock/recheck project, current filesystem decision, registry head/revision/entry, policy, active-run/budget state;
6. require attested manifest == still-current imported head;
7. create run or fail.

### 8.5 Runtime re-attestation

After DB lease claim, before first child, before each child conservatively, and before terminalization, re-attest live registry under the outer deadline. Mismatch -> inconclusive `registry_content_changed`.

---

## 9. Exact registry-to-current project authority

Admission requires current project authority to equal registry import authority:

```text
submitted_by
archived_at=null
local_path
root_ref
root_binding_revision
grant_decision_revision
updated_at/project_revision
```

Any mismatch -> `registry_authority_stale`; re-import required.

Queued/running work rechecks exact current registry head + project tuple. V1 stops on any registry-head change.

---

## 10. Project verification policy

### 10.1 Immutable policy schema

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
- max_active_runs integer NOT NULL
- start_budget_window_seconds integer NOT NULL
- max_starts_per_window integer NOT NULL
- actor_kind text NOT NULL       -- migration_seed | system_default | human
- actor_user_id uuid NULL
- predecessor_revision_id uuid NULL
- created_at timestamptz NOT NULL

verification_goal_policy_heads
- project_id uuid PK
- policy_revision_id uuid NOT NULL
- revision_sequence bigint NOT NULL
- updated_at timestamptz NOT NULL
```

Append-only gapless revisions, same-project predecessor, closed actor/bounds, protected one-head pointer and canonical digest.

### 10.2 Protected writes

Ordinary app cannot update/delete policy history or move head. Fixed-search-path protected routine locks project/head, verifies owner/CAS, validates exact values, appends one revision and advances exact head atomically. Document application-asserted actor provenance honestly.

### 10.3 Disabled default / one seed source

Existing and new projects get a valid disabled policy; missing head fails closed. New-project initializer is protected/DB-backed.

One versioned seed/default source drives migration and new-project defaults, with parity tests.

Recommended initial DB defaults:

```text
manual_enabled=false
scheduling_enabled=false
min_schedule_interval_seconds=3600
max_run_deadline_seconds=600
max_queue_age_seconds=300
max_operations_per_run=16
max_concurrent_runs=2
max_queued_runs=8
max_active_runs=10
start_budget_window_seconds=3600
max_starts_per_window=20
```

### 10.4 Exact capacity semantics

- `max_queued_runs`: project rows with status exactly `queued`;
- `max_concurrent_runs`: project rows in `running` with live business lease; worker claim is denied if reached;
- `max_active_runs`: project rows in `queued|running|recovery_required` at admission;
- completed/expired consume none;
- start budget counts every newly admitted run regardless of later status.

Counts use project-scoped indexes and canonical locks.

### 10.5 Start budget

Under project policy-head lock, count newly admitted project runs with `created_at >= transaction_timestamp() - window`. Idempotency replay consumes none; rejected attempts consume none.

### 10.6 Minimal policy API

```text
GET   /api/projects/:projectId/verification-policy
PATCH /api/projects/:projectId/verification-policy
```

PATCH sends exact policy fields + expected revision/sequence; server derives actor/digest.

---

## 11. System limits and runtime availability

### 11.1 Protocol limits

Declare once:

```ts
export const VERIFICATION_GOAL_SYSTEM_LIMITS_V1 = {
  businessLeaseMs: 30_000,
  leaseRenewTargetMs: 10_000,
  leaseLocalSafetyMarginMs: 5_000,
  recoveryQuiescenceGraceMs: 5_000,
  // plus named absolute parser/policy/scheduler ceilings
} as const
```

DB lease =30s; target renewal=10s; local fence no later than 25s after last successful lease response if no further confirmation; read-only recovery horizon includes max child timeout +5s grace beyond last trusted lease horizon.

### 11.2 Runtime availability

Availability is intersection of build capability, process-start kill switch (restrict-only), and project policy. Changing process-start kill switch requires restart. Emergency stop terminates/restarts worker/web; DB lease/watchdog recovers in-flight work inconclusively. Do not promise live observation of external env-file edits.

Build/gate contract version participates in resolved policy/environment evidence. A future live DB global kill switch is separately reviewed.

---

## 12. Dedicated project filesystem authority

Add `loadVerificationGoalFilesystemAuthority(projectId, goalCapability)`.

For v1 require current project filesystem pointer -> immutable **approved** decision, canonical capability set contains `filesystem.project.read`, and current root/grant revisions match registry/run authority.

This existing project decision is the durable authority. Do not add a new grant-mode field. Package `allow_once` is not consulted/consumed.

---

## 13. Canonical lock order

Reconcile with existing registry/filesystem routines before implementation:

```text
1 project
2 current project filesystem pointer/decision
3 registry head
4 bound registry revision + entry/snapshot
5 policy head
6 policy revision
7 project active/budget rows stable order
8 target goal run
9 child operation rows after run lock/lease
```

Filesystem traversal occurs outside long DB locks, followed by DB authority recheck. Tests use controlled barriers/locks, not sleeps.

---

## 14. Resolved run policy

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
    ordinal: number
    operationId: string
    operationVersion: number
    definitionDigest: string
    eligibility: 'manual_only' | 'manual_and_scheduled'
    timeoutMs: number
  }>
  systemAvailabilityContractVersion: number
}
```

Operations canonical sorted with ordinals exactly `0..N-1`.

Store exact bounded `resolved_policy` JSON + fingerprint on run. Worker never substitutes a newer resolver result for same run; it revalidates current authority only. V1 stops on any policy-head revision change.

---

## 15. Goal-run persistence

### 15.1 Exact registry/policy FKs

Registry entry exposes composite identity including revision/project/ordinal/snapshot/goal/version/definition digest/entry contract/binding digest. Policy exposes `(id,project,sequence)`. Run and schedule binding FK exact tuples.

### 15.2 Run row

```text
id, project_id
exact registry entry fields
exact policy fields
resolved_policy + fingerprint
authority_fingerprint
trigger/actor/idempotency-or-schedule fields
admission_expires_at
status queued|running|recovery_required|completed|expired
result null|passed|failed|inconclusive
terminal_code
execution_outcome_id null until completed
goal_evidence_set_digest null until completed
lease generation/token/owner/expiry
recovery_not_before
created/started/finished/updated timestamps
```

### 15.3 Trigger/lifecycle checks

Manual requires human user + UUID idempotency/fingerprint, no schedule fields. Scheduled requires scheduler actor + schedule identity, no manual fields.

```text
queued: no start/finish/result/outcome/digest/lease
running: started, no finish/result, live lease
recovery_required: started, no finish/result, no live worker lease, recovery_not_before
completed: started+finished, result, overall outcome, evidence digest, no lease
expired: never started, finished, no result/outcome/digest, code dispatch_expired
```

### 15.4 One active logical goal

Partial unique `(project_id,goal_id)` over queued/running/recovery_required.

### 15.5 Manual idempotency DB uniqueness

Partial unique:

```text
UNIQUE(requested_by_user_id, manual_idempotency_key)
WHERE trigger_kind='manual'
```

Stored fingerprint distinguishes same-intent replay from 409 conflicting intent.

### 15.6 Indexes

At least project+status+created, project+goal+finished, project+created (budget), status+admission expiry, status+lease expiry, snapshot+finished.

---

## 16. Manual idempotency semantics

UUID `Idempotency-Key`; fingerprint = contract version + actor + project + goal. Same actor/key/fingerprint returns existing run. Same actor/key/different fingerprint ->409. New deliberate proof -> new key. Rejected-before-create consumes no run idempotency row. Replay re-authenticates access and never reinterprets old run under new policy/registry.

---

## 17. Strict repository identity evidence

### 17.1 Snapshot table

One immutable row per run with project/root/grant/project revision, object format, OID, strict clean boolean, snapshot fingerprint, captured time. Run does not require reverse snapshot FK; query by unique run id.

### 17.2 Strict clean semantics

Goal proof does **not** reuse task-specific ignored-path behavior.

`clean=true` only when hardened:

```text
git status --porcelain=v1 -z --untracked-files=all
```

returns zero status entries. No `.forge/task-runs/**` or other Forge-path exclusion.

If runtime artifacts would otherwise dirty the project, keep them outside the repository or explicitly ignore them in repository configuration; the proof runner does not hide status entries.

An untracked goal file may be imported as configuration evidence but cannot produce a decisive clean-commit proof until repository cleanliness is restored.

### 17.3 Fixed bounded helper

Reuse hardened Git environment. Fixed commands include object format, HEAD, strict clean status, and gitlink detection. All post-claim registry/repo/environment preflights share overall abort/deadline and have smaller fixed timeout/output/file-count bounds.

SHA1=40 lowercase hex; SHA256=64; unknown/unborn/bare/submodule -> inconclusive as defined. Raw status paths discarded, not persisted.

### 17.4 Revalidation

After claim, before/after every child, before terminalization. Mismatch -> repository_changed inconclusive.

---

## 18. Execution environment evidence

Immutable one-per-run row:

```text
schema/runner contract
forge_build_identity nullable
build_identity_state release|unavailable_local
platform/arch
normalized Node/Git runtime versions
operation binding digest
eligibility policy version/digest
environment fingerprint
captured time
```

When pipeline supplies trustworthy release build identity, persist it. Local development without it records `unavailable_local`, forming a distinct/requalification cohort. Do not runtime-hash arbitrary source files as authority substitute. No hostname/user/path/env dump/secret/network metadata.

Duration derives from DB started/finished timestamps.

---

## 19. Canonical outcome v2

### 19.1 Subject

Extend outcomes with exclusive `subject_kind=task|verification_goal_run`, nullable real FKs, task links null for goal subject, subject-specific partial unique attempt keys. Historical rows backfill task subject before cutover.

### 19.2 Failure class

```ts
type ExecutionFailureClassV2 =
  | 'functional'
  | 'policy'
  | 'authority'
  | 'infrastructure'
  | 'evidence'
  | 'cancelled'
```

Goal outcome-v2 rows are **append-once**; no upsert mutation after protected creation.

### 19.3 Exact child outcome mappings

**Pass**

```text
transport_status=ok
result=completed
stop_reason_code=null
failure_class=null
retryable=false
verifier_required=false
verification_status=not_required
```

`operation_runs.verification_status=passed` is the deterministic verdict.

**Functional command failure with durable exact audit**

```text
transport_status=ok
result=failed
stop_reason_code=operation_execution_failed
failure_class=functional
retryable=false
verifier_required=false
verification_status=not_required
```

**Deterministic output verification failure**

```text
transport_status=ok
result=failed
stop_reason_code=validation_failed
failure_class=functional
retryable=false
verifier_required=false
verification_status=not_required
```

and operation-run verification status failed.

**Authority/policy block**

```text
transport_status=ok
result=blocked
failure_class=authority|policy
retryable=false
```

**Timeout / infrastructure / evidence failure**

```text
transport_status=error
result=needs_attention
failure_class=infrastructure|evidence|cancelled
retryable=false
```

Never decisive functional failure.

DB v2 checks freeze legal result/transport/failure-class/verification combinations.

### 19.4 Goal terminal-code taxonomy

**completed / passed**

```text
passed
```

**completed / failed**

```text
functional_operation_failed
functional_verification_failed
```

**completed / inconclusive**

```text
repository_dirty
repository_changed
registry_content_changed
registry_superseded
registry_authority_changed
policy_changed
filesystem_authority_changed
operation_contract_changed
required_verifier_unavailable
submodule_repository_unsupported
unsupported_repository_identity
missing_required_evidence
operation_infrastructure_failed
operation_evidence_failed
execution_deadline_exceeded
lease_lost
system_execution_disabled
internal_infrastructure_error
```

**expired / no result**

```text
dispatch_expired
```

No operator-cancel code until a cancel API/transition is separately designed.

### 19.5 Overall goal outcome mapping

**Passed**

```text
transport_status=ok
result=completed
stop_reason_code=null
failure_class=null
retryable=false
verifier_required=false
verification_status=not_required
```

**Failed**

```text
transport_status=ok
result=failed
stop_reason_code=verification_goal_failed
failure_class=functional
retryable=false
verifier_required=false
verification_status=not_required
```

Run terminal code retains whether failure was operation execution vs deterministic verification.

**Inconclusive**

```text
transport_status=ok
result=needs_attention
stop_reason_code=<exact run terminal code from the closed inconclusive set>
failure_class=<authority|policy|infrastructure|evidence|cancelled exact mapping>
retryable=false
verifier_required=false
verification_status=not_required
```

The implementation contract/test table maps every inconclusive terminal code to exactly one failure class; no `unknown` fallback is accepted for goal v2.

---

## 20. Operation runs and exact ordinal execution

Extend operation runs with exclusive subject identity and nullable `verification_goal_operation_ordinal`.

Goal subject: goal run FK non-null, project matches goal project, task links null, ordinal non-null. Task ordinal null.

Partial uniques: task+idempotency; goal+idempotency; goal+ordinal.

### 20.1 Protected next-operation begin

Lease-authorized routine receives only run id, live lease generation/token, requested ordinal. It loads stored resolved policy and derives expected op id/version/digest/capability.

It verifies ordinal in range, no row for ordinal, all prior ordinals terminal decisive pass, no later ordinal, live run lease, and required current authority checkpoint. Then generates idempotency key server-side:

```text
H(goal run id, ordinal, operation id/version, definition digest, execution binding digest)
```

No separate child attempt generation exists in v1 because v1 never retries a child inside the same goal run after uncertainty.

### 20.2 Shared context

Task and goal authority loaders feed a shared trusted project operation scope and subject-neutral deterministic executor. Goal loader validates lease, registry/live manifest, project/root/grant, policy, system availability, repository identity and catalog/eligibility. Caller never supplies path/capability/policy/grant/command/adapter/tool.

---

## 21. Outer cancellation / deadline

Shared executor accepts optional outer AbortSignal/monotonic deadline; task callers omitting it retain current behavior.

Goal runner composes operation timeout, remaining overall run deadline, DB lease-loss watchdog and process/runtime shutdown. Effective child deadline = min(operation timeout, remaining goal deadline).

Overall run deadline starts at DB `started_at` and includes all post-claim preflights. No work starts after deadline. Deadline -> inconclusive.

---

## 22. DB-lease-fenced and immutable goal evidence

Goal-subject writes use protected routines/triggers verifying exact run id/generation/token/running/unexpired DB lease before authoritative worker evidence mutation.

Protect at least child operation begin/event/finalize, goal command-audit insert, worker goal events, repository/environment snapshot insert/link, child outcome create/link, and overall terminalization.

After authoritative creation/finalization:

- goal command audits append-only; no update/delete;
- outcome-v2 goal rows append-once; no upsert mutation;
- terminal child operation identity/outcome linkage immutable;
- operation/goal events append-only;
- repo/environment snapshots immutable;
- completed/expired run terminal identity/result/evidence fields immutable.

Future human/independent adjudication appends separate history; it never rewrites proof evidence.

Task-subject legacy mutability is not silently changed unless its own contract is amended.

---

## 23. Command-audit evidence integrity

Generalize command audits to exclusive task/goal subject and link goal Operation Catalog audits to exact `operation_run_id`. Initial chain:

```text
goal run -> child op+ordinal -> child outcome -> exact command audit/evidence
```

Arbitrary UUID evidence refs are insufficient. Protected terminalizer derives refs from relationally validated evidence.

Protected internal command audit may retain current cwd/argv behavior; public goal events/snapshots/Redis/API/reliability do not copy raw local paths/output.

---

## 24. Manual API

### Create

```text
POST /api/projects/:projectId/verification-goals/:goalId/runs
Idempotency-Key: <UUID>
```

Body absent/empty. Caller cannot submit revision/path/ref/operation/input/capability/time/evidence/verifier/actor/policy/grant/runtime.

Two-phase admission: authenticate/idempotency/capture authority/live attestation outside long locks, then canonical transaction rechecks project/filesystem/registry/live manifest/binding/policy/build availability/active counts/start budget and creates exactly one queued run with DB-time admission expiry. Post-commit Redis publish is best-effort/recoverable.

Fixed expected errors include request/idempotency/project/registry staleness/goal schema or disabled/eligibility or binding/verifier/system/manual/filesystem/active/budget/queue denials; all redacted.

### Read

```text
GET /api/projects/:projectId/verification-goal-runs/:runId
```

Bounded status/result/code, safe commit identity, environment fingerprint/build-identity state, timestamps/duration, child run/outcome/evidence IDs and safe recovery action. Hide path/raw output/policy JSON/Redis/lease/DB internals.

---

## 25. Redis delivery / DB business lease

Envelope `{schemaVersion:1,runId,occurrenceId}` only.

Extract/reuse generic queue primitives rather than fourth copy; policy outside queue.

Flow: Redis occurrence -> acquire DB business lease -> once durable, ack Redis best-effort -> business work under DB lease only. Ack loss can duplicate delivery, but loser cannot acquire DB lease and safely acks duplicate. DB uncertainty means do not drop occurrence based on assumed ownership.

Queued DB rows are redispatch truth. Bounded dispatcher republishes unexpired queued rows.

---

## 26. DB lease and outage watchdog

Claim uses DB time, queued/unexpired row, project running capacity, increments generation, writes fresh token/owner, expiry=DB now+30s, sets started once, queued->running.

Renew exact run+running+generation+token+unexpired DB time, target every 10s.

After each successful claim/renew response, local monotonic fence deadline = no later than 25s later. DB errors never extend. At deadline abort outer work and start nothing new. Late response cannot revive fenced worker. Only current DB generation/token can mutate after recovery.

---

## 27. Canonical runner

```text
queued run
 -> Redis wake
 -> DB lease (respect project running ceiling)
 -> best-effort Redis ack
 -> overall deadline active
 -> env snapshot
 -> system/project/registry/live-manifest/policy/filesystem/catalog/eligibility recheck
 -> strict clean repo snapshot
 -> for ordinal 0..N-1:
      lease/deadline + authority/repo recheck
      protected begin derives exact next bound op
      shared deterministic executor inputs={} fixed reason, outer deadline
      lease-fenced immutable child evidence
      exact outcome-v2/evidence validation
      post-child repo/registry/authority recheck
      stop at first functional or nonfunctional non-pass; never create later ordinal
 -> final authority/repo check
 -> protected terminalizer validates exact child prefix
 -> overall outcome + evidence digest + final event + completed run atomically
 -> after commit best-effort child reliability-v2 ingest
```

No LLM.

---

## 28. Exact child-prefix rules

Let `N` = stored planned operation count.

**Passed:** children exactly `0..N-1`, all terminal decisive pass, no extra/duplicate.

**Failed:** children exactly `0..k`, `0..k-1` pass, `k` decisive functional fail, no child >k.

**Inconclusive:** only canonical prefix; prior children pass, next point is terminal nonfunctional non-pass or the one uncertain child handled by recovery; no later child.

There are no mutable skipped rows. Planned list + validated prefix explains fail-fast absence.

Protected terminalizer locks/reads children in ordinal order and enforces these shapes; application-supplied child ID lists cannot bypass it.

---

## 29. Overall goal outcome / evidence-set digest

Every completed run writes one overall outcome-v2 under reserved final attempt key.

Protected terminalizer derives canonical evidence descriptor:

```ts
{
  schemaVersion: 1,
  repositorySnapshot: { id, fingerprint },
  environmentSnapshot: { id, fingerprint },
  childOperations: [
    { ordinal, operationRunId, operationOutcomeId, outcomeFingerprint }
  ],
  result,
  terminalCode
}
```

Child list follows prefix rules. Compute/persist domain-separated `goal_evidence_set_digest` and bind it into overall outcome fingerprint. Overall evidenceRefs derive only from this descriptor.

Atomic terminal transaction validates lease, snapshot ownership/fingerprints, child prefix/outcome/evidence, derives descriptor/digest, inserts immutable overall outcome, final event, completed run fields, clears lease.

Response-loss replay returns existing terminal state. Expired runs have no overall proof outcome.

### Evidence drift at consumer/read boundaries

Decisive history/reliability/#189/#190/#191 consumers rederive/validate the evidence-set relationship (or use a tested DB helper/view that does). Mismatch produces explicit `evidence_drift` trust state and suppresses decisive trust use. `run.result` alone is never sufficient for autonomy/Sentinel trust decisions.

Overall outcome is excluded from capability reliability; only child op outcomes ingest.

---

## 30. Child operation recovery

No replay inside same run after lease loss. No inference from audit alone. Parent recovery_required.

Crash command-before-audit -> no evidence. Audit-before-child-final -> audit alone not result. Child-final-before-next then worker loss -> v1 does not resume; recovery closes parent inconclusive.

Read-only quarantine: fence expired generation, running->recovery_required, `recovery_not_before >= last trusted lease horizon + max bound child timeout + 5s`, then verify no current lease/outcome/new authorized evidence; close parent inconclusive via protected recovery terminalizer while preserving incomplete child. No replay/function inference. Future side effects need new contract.

---

## 31. Queued expiry

Admission expiry = DB transaction time + effective queue age. Bounded dispatcher/recovery changes unstarted queued -> expired, code dispatch_expired, finished DB time, no result/outcome/digest. Excluded from history/reliability.

---

## 32. Run events

Append-only closed event table with run, gapless/guarded sequence, phase (admission/dispatch/lease/environment/repository/operation/recovery/finalization), status, closed code, optional child/snapshot refs, UUID evidence refs, created time. No prose/path/raw errors. Worker proof events lease-fenced; recovery/system events use guarded actor/routine.

---

## 33. History

Current cohort at least project + goal snapshot/definition + registry binding + resolved policy + environment fingerprint. Only validated-evidence, strict-clean, completed passed/failed count.

`lastGreen`, first observed failing commit, consecutive passes/failures use decisive current-cohort runs; inconclusive ignored. Later pass closes failure episode without deleting history. Definition/binding/policy/environment change starts new current cohort. Do not claim causal “first bad commit.”

---

## 34. Capability reliability v2

Only child terminal operation outcomes ingest; overall excluded.

Goal-subject reliability v2: goal FK, task links null, contractVersion=2, evidenceUnitFingerprint, environmentFingerprint, outcome-v2 compatible closed fields. Task v1 unchanged.

Runtime fingerprint v2 includes deterministic adapter kind + execution environment fingerprint. Policy fingerprint includes goal subject + resolved policy + registry binding.

Evidence unit = H(project, goal snapshot/binding, operation id/version, strict clean repo object/OID, resolved policy, environment). Store every observation; metrics expose raw observation count, unique evidence units, promotion-grade unique sample count. Conflicting decisive outcomes within same evidence unit -> explicit instability/conflict and no autonomy promotion.

No ingest from nonterminal/missing/drifted evidence, expired run, uncertain attribution, or overall goal outcome. Ingest failure cannot change proof result.

---

## 35. Scheduling

A v2 interval schedules only when live registry==imported, executable binding scheduled-eligible, project policy enabled, build/process scheduling capability available, and project filesystem authority valid.

Immutable DB-time schedule binding references exact registry entry + policy + binding; new config makes new binding. First due = anchor + interval, so enabling scheduling is not an immediate surprise run.

Slot PK `(binding_id,slot_sequence)` with due time, disposition run_created/overlap_skipped/budget_skipped/registry_stale/policy_stale/system_disabled, bounded skippedPriorSlots, optional run.

No HEAD in slot identity; worker captures later. Multi-worker races converge on unique slot. Bounded cursor batches + named minimum scan cadence. Downtime creates at most current eligible slot plus bounded skipped count, no catch-up stampede. One active logical goal means overlap skipped. Project queued/running/active/start budgets apply.

A later interval may re-observe the same commit: that is a separate operational observation, but **not** another independent reliability evidence unit. The “no duplicate scheduled evidence for the same goal/ref” guarantee applies to concurrent/same-slot duplication; later scheduled observations remain visible without inflating unique trust sample count.

Stale live registry never auto-imports and is reconsidered only on later bounded scheduler scan or authority/head change.

---

## 36. Downstream boundaries

#187 exposes deterministic regression candidate (prior decisive pass -> new decisive fail), not Sentinel finding; #190 owns findings. Repo schema has no autonomy action; #189 consumes validated proof/reliability evidence. #188 later appends separate verifier history linked to goal run/overall outcome; never rewrites deterministic result. Browser/model/provider/verifier not repo-selectable; human/Playwright lanes remain separate.

---

## 37. Rolling migration/release sequence

0. Registry expansion: v2 snapshots, manifest v2, entry binding, live attestation; no execution.
1. Policy: protected revisions/heads/default-disabled + API/settings; build process execution unavailable.
2. Shared-ledger expand: nullable goal subject/version/ordinal fields + dual readers; no goal rows.
3. Goal run/evidence tables + protected lease/child-evidence/terminal routines + outcome-v2; no execution.
4. Shared-ledger cutover: backfill task subject, exclusive checks/FKs/partial uniques, safely relax task NOT NULL after dual consumers; prove historical tasks.
5. Manual release: hardened eligible adapters, outer cancellation/deadline, goal authority, API/queue/lease/watchdog/ordinal runner/GET; proof then build manual capability available; projects still disabled.
6. Reliability v2/history dual-version activation.
7. Scheduler tables/loop/proof then scheduling capability available.

No goal row while supported old consumer can misinterpret nullable task identity.

---

## 38. Migration/ACL proof requirements

Every DB slice includes journal parity, populated upgrade, installer/legacy/current-tip proofs as relevant, protected-owner failure cleanup/retry, fixed search path, PUBLIC revoke, closed app ACL, no task integrity gap, invalid subject/project/registry/policy/ordinal shapes rejected by DB, migration crash/retry, and preservation of historical v1/task meaning.

Goal-subject evidence immutability triggers/routines are included in ACL/privilege inventories and real PostgreSQL tests.

---

## 39. Module boundaries

```text
web/lib/verification-goals/contracts.ts
web/lib/verification-goals/eligibility.ts
web/lib/verification-goals/system-limits.ts
web/lib/verification-goals/policy-contracts.ts
web/lib/verification-goals/history.ts
web/worker/verification-goals/registry-attestation.ts
web/worker/verification-goals/admission.ts
web/worker/verification-goals/filesystem-authority.ts
web/worker/verification-goals/repository-snapshot.ts
web/worker/verification-goals/environment-snapshot.ts
web/worker/verification-goals/ledger.ts
web/worker/verification-goals/runner.ts
web/worker/verification-goals/scheduler.ts
web/worker/operations/context.ts
web/worker/operations/executor.ts
web/worker/queue/*
```

Contracts pure/DB-free; routes thin; trusted filesystem helpers reused; subject differences at authority/persistence adapters; queue carries identity not policy; no LLM scheduler; no repo-controlled registration; operator tunables DB-backed, code constants only protocol/security ceilings.

---

## 40. Implementation slices

**A — executable definition/registry binding/project policy:** v2 parser/DB, manifest v2/entry binding/live attestation, eligibility, protected policy/default/API. No run.

**B — goal subject/evidence:** run/events/repo/env, exact FKs, protected lease/ordinal/evidence/immutability, outcome/op/audit subject expansion, outcome-v2, rolling compatibility. Runtime unavailable.

**C — manual read-only proof:** harden/allowlist adapters, outer deadline, project filesystem authority, bodyless idempotent POST + GET, DB-first queue/early Redis ack/lease/watchdog, strict clean SHA1/SHA256 + submodule refusal, ordinal sequential ops, overall outcome/evidence digest. No scheduler.

**D — history/reliability v2:** last green/first observed failure/streaks, goal capability attempts, environment/evidence units/instability, overall excluded.

**E — bounded scheduler:** binding/slot, bounded loop/live manifest/current-slot, capacities/budgets, recovery/runbook, scheduling build capability after proof.

**F — #187 closure proof/docs:** sample v2 goal, manual+scheduled E2E, migration/ACL/Redis/lease/registry/repo/evidence-drift tests, operator guidance, acceptance trace.

---

## 41. Acceptance mapping / deliberate deviations

| #187 requirement | Architecture |
|---|---|
| repo versioned goal | v1 preserved; v2 executable |
| deterministic safe verifier | code-owned eligible Operation Catalog bindings |
| timeout/resource | DB policy + system limits + overall deadline including preflight |
| manual first | C before E |
| controlled schedule | DB-time binding/slot + policy/budgets/build availability |
| structured result/evidence | run/events/repo/env + child outcomes + overall outcome/evidence digest |
| commit/environment | strict repo identity + environment/build snapshot |
| last green/first failure | validated decisive cohort history |
| canonical outcomes | child + overall outcome-v2 |
| reliability | reliability-v2 child observations/evidence units |
| overlap/dedup | one active goal + ordinal + unique slot + DB lease |
| disabled no run | live/imported registry + project/build policy |
| no auto-repair | explicit #190/#189 boundary |
| human/Playwright separate | no browser verifier v2; #188 separate |
| redaction | closed events/no raw dirty paths/public internals |

Deliberate: repository `failure.autonomyAction` is not executable; #189 owns it. Use “first observed failing commit,” not causal “first bad commit.”

---

## 42. Verification matrix

### Definition/registry
v1 compatibility/non-exec; exact v2 parser/DB; duplicate/unknown/overflow; operation catalog/eligibility mismatches; scheduled manual-only rejection; binding deterministic; manifest v1 compatibility/v2 binding; live registry stale admission/runtime drift.

### Git security/identity
Adversarial repo helper/config sentinel; no optional repo mutation; SHA1/256; unsupported/unborn/bare/submodule; **strict** dirty tracked/untracked including Forge paths; zero persisted path list; outer deadline on preflight.

### Policy/ACL/capacity
Disabled defaults, missing head, actors/CAS, app/PUBLIC denials, monotonic resolver property tests, build gate stricter, exact queued/running/active/start-budget counts.

### Referential/ordinal
Exact entry/policy FKs; exclusive subjects; cross-project rejection; ordinal required/unique/range; protected begin rejects skipped/extra/wrong op; pass/failed/inconclusive prefix closure; completed overall outcome+digest; expired no result.

### Admission races
Project/root/grant, registry/policy head, active run, budget, catalog/eligibility, live registry changes via controlled interleavings.

### Outcome/evidence
Exact v2 mappings; command functional vs audit evidence/infrastructure; verifier failure; authority/timeout/unknown inconclusive; arbitrary UUID rejected; immutable goal evidence; evidence-set rederivation/drift suppresses trust.

### Lease/queue/recovery
Duplicate Redis, ack loss, DB uncertainty, 25s monotonic fence, late renewal, stale-token write denial, crash points, nonsettling child/recovery horizon, queued expiry, terminal response replay.

### API
Auth/owner/body/idempotency, all current/policy/system/filesystem/budget/active denials, bounded GET leakage.

### History/reliability
Inconclusive/expired excluded, failure episode, cohort changes, overall excluded, reliability-v2/task-v1, repeated unit unique count, conflicting unit instability, no uncertain ingest.

### Scheduler
Policy/build gate, interval/anchor, race unique slot, manual overlap, budgets, registry stale, config binding change, current-slot-only downtime, bounded cursor/cadence, removed/disabled/v1 no run, same-ref later observation not unique reliability sample.

### Migration/rolling
Dual readers before nullable task cutover, no premature goal rows, subject/ordinal checks, populated upgrade, protected owner cleanup, historical task evidence unchanged.

---

## 43. Release evidence before #187 closure

Lint, TypeScript, zero-skip unit suite, production build, real PostgreSQL migration/populated-upgrade/ACL/subject/ordinal/immutability tests, real Redis duplicate/loss/malformed/recovery, DB lease/outage/watchdog, malicious Git helper sentinel, SHA1/SHA256 fixtures, live registry drift, manual API E2E, scheduler multi-worker/offline/budget, evidence-drift + cross-sink leakage sentinels, mutation tests, diff check, PR Contract, Security/Adversarial review for auth/filesystem/command/lease/migration/scheduler.

Architecture confidence is not release evidence.

---

## 44. Explicit non-goals

Synthetic task proof, arbitrary shell/model commands, repo operation inputs, dirty decisive proof, submodule proof v1, side-effecting goal ops v1, parallel/workflow language, auto-repair, direct autonomy, Sentinel finding implementation, independent model verifier, browser verifier v2, branch/commit/PR/merge, live MCP grants, broad host cron, deployment, full #191 dashboard/export.

---

## 45. Post-amendment review rule

Fresh review against live code across contract, data/FK/version/ordinal/migration, complete call path, crash/recovery, security/ACL/Git/path/stale-worker/resource/leakage, evidence immutability/drift, reliability trust samples, scheduler, API/operator recovery, rolling compatibility, CI evidence, modularity/hardcoding, downstream #188–#191.

Any material issue -> amend primary, verify prior finding, restart fresh passes.

Final wording may be **“No blockers found in the inspected architecture scope.”** It must name residual uncertainty and never claim absence of defects.
