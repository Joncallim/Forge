# Issue #187 Architecture: Verification Goal Run Policy and Goal-Owned Execution

Status: **Architecture draft — no runtime execution is authorized by this document.**

| Field | Value |
|---|---|
| Issue | [#187 — Add project verification goals and scheduled proof runs](https://github.com/Joncallim/Forge/issues/187) |
| Parent Epic | [#184 — Continuous verification and earned autonomy](https://github.com/Joncallim/Forge/issues/184) |
| Existing foundation | ADR 0013, authoritative verification-goal registry revisions, deterministic Operation Catalog (ADR 0011), canonical execution outcomes (ADR 0010), capability reliability ledger (ADR 0012) |
| Consumed by | #188 independent verification, #189 earned autonomy, #190 Project Sentinel, #191 reporting |
| This PR | Architecture only: execution-policy contract, goal-run authority model, shared-ledger generalization plan, manual/scheduled sequencing |

---

## 1. Plain-language summary

Forge can now answer **which verification-goal definitions are authoritative for a project**. It cannot yet safely run those goals.

That gap is larger than adding a `Run` button. The current deterministic-operation path, canonical outcome ledger, repository command audits, and reliability ledger are all built around an existing Forge **task**. A verification proof run is not an implementation task and must not manufacture a fake task or work package merely to satisfy foreign keys or permission checks.

This architecture introduces a first-class **verification goal run** as a separate execution subject. It keeps repository definitions declarative, resolves operator-controlled execution ceilings outside repository text, binds every run to the exact authoritative goal revision and repository state, and reuses the Operation Catalog only after the shared execution/evidence layers can represent a non-task subject without weakening their existing task guarantees.

The first executable version remains intentionally narrow:

- goal definitions reference only existing, enabled, zero-input deterministic operations;
- operations run sequentially under the same trusted-project and filesystem-read ceilings already enforced by Forge;
- the repository must be clean and pinned to one commit for a decisive pass/fail result;
- a definition, project authority, filesystem grant, repository root, repository commit, or execution-policy change during a run invalidates the run rather than being silently ignored;
- repository configuration can request work, but cannot grant itself more permission, more frequency, more concurrency, more time, or more autonomy;
- failure records evidence only. It does not repair code, revoke autonomy directly, create branches, open pull requests, or merge anything.

The design is deliberately split into implementation slices so lower-tier agents can implement one contract at a time without inventing missing policy.

---

## 2. Current constraints that this architecture must preserve

### 2.1 Verification definitions are definition-only

ADR 0013 and the merged #187 registry slices establish:

- repository files under `.forge/verification-goals/*.json` are declarative;
- current v1 goals contain identity, description, capability, severity, enabled state, and references to zero-input Operation Catalog entries;
- successful import creates immutable snapshots and an authoritative project registry revision;
- a stored definition or current head does not authorize execution and never means a goal passed.

This document does not reinterpret existing v1 snapshots as executable. Existing evidence must retain the meaning it had when written.

### 2.2 The Operation Catalog is task-owned today

The production `executeTrustedOperation` path resolves authority from an approved/running `task_id`, optionally a work package, agent run, and task attempt. Repository-read authority currently requires a current work package whose effective capabilities and current project filesystem grant admit `filesystem.project.read`.

A proof runner therefore cannot safely call the production path by inventing a dummy task/work package. Doing so would:

- blur implementation work with verification evidence;
- make task status part of a project-level proof's authority;
- pollute task history and reporting;
- create fake reliability attempts;
- allow future task-specific rules to accidentally widen or narrow proof execution;
- make scheduling depend on an artificial task lifecycle.

### 2.3 Shared evidence ledgers are task-owned today

The following current records require a task identity or assume one:

- `execution_outcomes.task_id` is non-null and uniqueness is `(task_id, attempt_key)`;
- `operation_runs.task_id` is non-null and uniqueness is `(task_id, idempotency_key)`;
- `capability_attempts.task_id` is non-null;
- repository command audits are recorded against a task and optionally a work package/agent run.

The architecture must generalize those records without dropping referential integrity and without creating a parallel, incompatible definition of execution success.

### 2.4 Redis is transport, not project truth

PostgreSQL remains authoritative for project configuration, registry heads, run identity, run state, evidence links, and history. Redis may wake workers and carry bounded occurrence identifiers. A missing Redis key, retry, reconnect, or lost response must never create a second authoritative run or silently change the run's result.

---

## 3. Architectural decisions

### Decision A — verification goal runs are first-class execution subjects

Introduce a closed subject model:

```ts
export type ExecutionSubject =
  | { kind: 'task'; taskId: string }
  | { kind: 'verification_goal_run'; verificationGoalRunId: string }
```

This is a domain type, not a polymorphic unvalidated UUID. Database tables keep real foreign keys to the applicable subject table and enforce an exclusive shape with `CHECK` constraints.

No production proof-run path may create a synthetic task or work package.

### Decision B — preserve goal schema v1; executable goals require schema v2

Schema v1 keeps its existing meaning: **definition evidence only**.

A new schema v2 adds an explicit execution declaration. This avoids silently assigning execution semantics to already-imported rows.

Proposed repository shape:

```json
{
  "schemaVersion": 2,
  "goalId": "repository-readable",
  "definitionVersion": 2,
  "title": "Repository remains readable",
  "description": "Forge can inspect the trusted project without running repository code.",
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

The `execution` block is a **request for a bounded policy**, not permission.

Initial schedule shape, when scheduling is implemented:

```json
{
  "kind": "interval",
  "everySeconds": 86400
}
```

Cron expressions, shell text, command strings, paths, environment variables, arbitrary operation inputs, callback names, tool names, adapter names, and user-selected credentials are not part of v2.

### Decision C — repository policy can only make execution stricter

The effective run policy is the intersection of four independently owned inputs:

1. **Goal declaration** — repository-owned desired trigger/deadline/additional evidence.
2. **Project verification policy revision** — operator-owned, database-backed limits.
3. **Operation definitions** — code-owned risk, capability, timeout, adapter, verification, and approval requirements.
4. **System safety invariants** — a small set of centralized absolute protocol ceilings required to prevent pathological values even if configuration is corrupt.

The effective policy always chooses the more restrictive result. Repository text never selects a more permissive profile.

Examples:

- goal says manual=true, project policy says manual=false → manual is disabled;
- goal requests daily schedule, project policy disables schedules → no scheduled runs;
- goal requests 60-second interval, project policy minimum is one hour → effective interval is at least one hour;
- goal requests 30-minute deadline, project policy maximum is 10 minutes → effective deadline is 10 minutes;
- operation definition requires a stricter timeout or verifier → operation definition wins;
- current filesystem authority does not permit the capability → execution is blocked regardless of any policy/profile field.

### Decision D — operator-tunable limits are database-backed and versioned

Do not scatter runtime numbers across route, queue, and worker modules.

Introduce project-scoped immutable policy revisions plus one current pointer, conceptually:

```text
verification_goal_policy_revisions
- id
- project_id
- revision_sequence
- policy_digest
- manual_enabled
- scheduling_enabled
- min_schedule_interval_seconds
- max_run_deadline_seconds
- max_concurrent_runs
- max_queued_runs
- created_by_user_id
- predecessor_revision_id
- created_at

verification_goal_policy_heads
- project_id
- policy_revision_id
- revision_sequence
- updated_at
```

A migration seeds one conservative project policy revision for existing projects. Operators can later edit policy through an authenticated project-settings surface without changing TypeScript.

Code-level constants remain only for true protocol/safety invariants such as maximum encoded integer size, closed enum values, and an absolute upper bound that configuration may never exceed.

### Decision E — failure does not contain an autonomy action

Issue #187's original example contains `failure.autonomyAction`. This architecture deliberately does **not** let repository configuration name or trigger an autonomy action before #189 defines that policy domain.

A proof run emits a stable failure signal containing only bounded identity and evidence. #189 may later consume that signal under its own operator-controlled policy. #190 may create/deduplicate a Sentinel finding under its own contract.

This avoids a circular trust problem where repository text can instruct Forge to change permissions.

### Decision F — one canonical operation/evidence model, generalized safely

Do not create `verification_execution_outcomes`, a second operation ledger, or a second command-audit semantics merely to avoid migration work.

Instead, generalize existing shared records to support exactly two subject kinds while preserving old task rows.

Migration rule: existing rows are backfilled as `subject_kind='task'`; task-specific foreign keys and checks remain required for task rows.

### Decision G — initial proof runs require a stable clean repository state

The first runner must not claim "last green commit" while checking arbitrary uncommitted state.

Before any goal operation runs, Forge captures a trusted repository snapshot:

```ts
export type VerificationRepositorySnapshotV1 = {
  schemaVersion: 1
  headCommit: string
  clean: true
  rootRef: string
  rootBindingRevision: string
  projectRevision: string
  grantDecisionRevision: string
  snapshotFingerprint: string
}
```

Initial decisive execution requires `clean: true` and a 40-hex Git commit identity from a fixed, no-shell read path. If the worktree is dirty or repository identity cannot be proven, the request is blocked/inconclusive; it does not create pass/fail history.

The runner rechecks the same repository identity before each operation and before terminalization. A changed commit or newly dirty worktree terminates as inconclusive/superseded evidence, never as a pass or a functional failure.

This restriction can be relaxed in a later version only after a repository-state fingerprint contract can attribute dirty-state evidence without leaking paths or contents.

### Decision H — operations are an unordered declarative set, executed canonically

Current definitions canonicalize operation references. V2 keeps that model.

- operation references form a set, not a user-authored workflow language;
- execution order is canonical `(operationId, operationVersion)` order;
- initial runner is sequential;
- there are no operation dependencies, variables, interpolation, or output-to-input piping;
- initial runner is fail-fast after the first non-passing operation or any authority/evidence drift;
- adding dependency graphs or data flow requires a new goal schema version and separate review.

Sequential execution is intentional. Parallel proof operations would need a shared cancellation, lease, and stale-authority contract and do not improve the first release enough to justify that complexity.

---

## 4. Core invariants

Every implementation slice must map tests to these invariants.

| # | Invariant |
|---|---|
| I1 | A verification goal run is never represented by a synthetic task/work package. |
| I2 | Schema-v1 goal snapshots remain definition-only and cannot be executed. |
| I3 | Only the exact current authoritative registry revision and one of its entries can be admitted for a new run. |
| I4 | Disabled goals never reach the queue or operation executor. |
| I5 | Repository configuration cannot increase operator/system permissions, concurrency, frequency, timeout, or autonomy. |
| I6 | The effective execution policy is versioned, deterministic, fingerprinted, and reconstructable from stored inputs. |
| I7 | Every operation is an exact enabled, non-deprecated Operation Catalog id/version whose capability equals the goal capability. |
| I8 | Initial executable goals use zero-input operations only. No model/repository text reaches command argv, cwd, adapter, tool, server, or environment selection. |
| I9 | A goal run has one first-class database identity before it enters Redis. |
| I10 | Redis occurrence replay cannot create a second authoritative goal run. |
| I11 | Only one current execution lease may mutate a running goal run. Stale workers cannot terminalize or append authoritative run evidence. |
| I12 | Current project/root/grant/policy/registry authority is revalidated before each repository operation and before terminalization. |
| I13 | A decisive result is bound to one clean repository commit. Repository drift during a run yields no pass/fail history. |
| I14 | Existing task-owned outcomes, operation runs, command audits, and reliability rows preserve their current meaning and referential constraints. |
| I15 | Goal-owned operation runs and outcomes cannot populate task-only work-package/agent/task-attempt links. |
| I16 | Transport/adapter success alone cannot produce a goal pass; every operation's deterministic verification and canonical outcome must be present and valid. |
| I17 | Missing, malformed, drifted, or unlinked evidence is inconclusive/blocked evidence, never success. |
| I18 | Goal failures record evidence only; they do not directly repair code, alter autonomy, create branches/PRs, merge, or widen MCP/filesystem grants. |
| I19 | Last-green, first-observed-failure, and streaks are derived only from decisive runs for the same current goal definition/policy cohort. |
| I20 | Scheduled overlap/deduplication is project+goal+ref scoped; manual reruns remain possible as distinct deliberate requests. |
| I21 | Run/evidence records store closed codes, fingerprints, UUID evidence references, and bounded metadata; model prose and repository contents do not enter proof ledgers. |
| I22 | All schema and authority changes fail closed when their version is unknown. |

---

## 5. Goal schema v2 contract

Add v2 beside v1; do not mutate the v1 parser's meaning.

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

### 5.1 Evidence semantics

The resolved policy always requires the base evidence needed for a trustworthy run:

- authoritative registry revision + goal snapshot;
- project/root/grant/policy authority fingerprint;
- clean repository identity;
- each operation run id;
- each canonical execution outcome id;
- each operation's required evidence references.

`requiredEvidence` in repository configuration is **additive**. It cannot remove base evidence. Unknown evidence kinds fail import.

### 5.2 Numeric bounds

Parser-level absolute bounds are centralized in one contract module and mirrored by database checks where values are persisted. Operator-configured policy is expected to be materially tighter.

Do not duplicate numeric literals in API routes, workers, queue consumers, tests, docs, and SQL. Tests must assert parser, resolver, migration defaults, and database constraints agree.

### 5.3 Definition versioning

Any change to `execution`, operations, capability, severity, or enabled state requires a higher `definitionVersion` because those values change what or how Forge proves.

Importing the same project/goal/version with a different digest remains a hard conflict.

---

## 6. Resolved execution policy

The runner never acts directly on repository JSON. Admission resolves a typed immutable policy snapshot:

```ts
export type ResolvedVerificationGoalRunPolicyV1 = {
  schemaVersion: 1
  projectId: string
  registryRevisionId: string
  goalSnapshotId: string
  goalId: string
  goalDefinitionVersion: number
  goalDefinitionDigest: string
  projectPolicyRevisionId: string
  projectPolicyRevisionSequence: string
  triggerKind: 'manual' | 'scheduled'
  effectiveDeadlineSeconds: number
  effectiveScheduleEverySeconds: number | null
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

`policyFingerprint` uses canonical JSON and a new domain-separated digest. It includes semantic contract versions, not timestamps that do not affect behavior.

Admission stores the exact resolved policy or its bounded canonical components before queueing. Later workers do not re-resolve a different policy and pretend it was the same run. They revalidate that the current authority still permits the stored policy. A stricter/currently changed policy causes the queued/running work to stop; it never widens the stored run.

---

## 7. Project verification policy

### 7.1 Purpose

Operator settings answer: **how much proof-running activity may this project consume?**

Repository goals answer: **what does this repository want proved?**

Keeping those concerns separate prevents a repository change from enabling a high-frequency worker loop or increasing resource ceilings.

### 7.2 Initial policy fields

The first project policy revision contains only values the runner can actually enforce:

```ts
export type ProjectVerificationPolicyV1 = {
  schemaVersion: 1
  manualEnabled: boolean
  schedulingEnabled: boolean
  minScheduleIntervalSeconds: number
  maxRunDeadlineSeconds: number
  maxConcurrentRuns: number
  maxQueuedRuns: number
}
```

Do not add pretend controls for CPU, memory, network, or sandbox strength until the execution layer can enforce them.

### 7.3 Immutable revisions

Policy edits append revisions and advance one protected project pointer. A run stores the exact revision it resolved against.

A current-policy change while work is queued/running is treated as authority drift. The worker rechecks whether its stored effective policy is still allowed. It may continue only if the current policy is semantically equal or stricter in a way that does not invalidate the already-started work; the simple initial implementation may conservatively stop on any revision change.

Conservative stop-on-revision-change is preferred for v1 because it is deterministic and easy to prove.

---

## 8. Goal-run persistence contract

### 8.1 `verification_goal_runs`

Add one authoritative run table. Suggested fields:

```text
verification_goal_runs
- id uuid primary key
- project_id uuid not null
- registry_revision_id uuid not null
- goal_snapshot_id uuid not null
- goal_id text not null
- definition_version integer not null
- definition_digest text not null
- policy_revision_id uuid not null
- policy_fingerprint text not null
- authority_fingerprint text not null
- trigger_kind text not null                  -- manual | scheduled
- trigger_idempotency_key text not null
- requested_by_user_id uuid null               -- required for manual, null for scheduler
- repository_head_commit text null             -- set only after trusted clean snapshot
- repository_snapshot_fingerprint text null
- status text not null                          -- queued | running | completed | blocked | cancelled
- result text null                              -- passed | failed | inconclusive when completed
- terminal_code text null                       -- closed taxonomy
- started_at timestamptz null
- completed_at timestamptz null
- created_at timestamptz not null
```

Identity fields are immutable after insert. Lifecycle fields may advance only through fixed application transitions or a protected database routine; no arbitrary status updates.

Recommended closed terminal codes initially include:

```text
passed
operation_failed
operation_verification_failed
authority_changed
registry_superseded
policy_changed
repository_dirty
repository_changed
missing_repository_identity
missing_required_evidence
operation_disabled
operation_deprecated
operation_contract_changed
filesystem_authority_denied
queue_cancelled
lease_lost
timeout
internal_error
```

Codes must distinguish a functional proof failure from infrastructure/authority uncertainty. Only `operation_failed`/`operation_verification_failed` under valid evidence can contribute a decisive failed proof; authority and infrastructure failures are inconclusive/blocked.

### 8.2 Run events

Add append-only `verification_goal_run_events` for bounded phase history. The table stores closed phase/status/detail codes and UUID evidence references, not free-form logs.

Suggested phases:

```text
admission
queued
lease
repository_snapshot
operation
finalization
```

Per-operation detail belongs primarily in `operation_runs`; goal events reference those run ids rather than duplicating output.

### 8.3 No mutable status-summary table in the first slice

Do not immediately add a second mutable `verification_goal_status` table.

Last green, first observed failing commit/time, and streaks can be calculated deterministically from immutable decisive run history for the current goal snapshot/policy cohort. #191 may add a rebuildable projection if query volume later justifies it.

---

## 9. Generalizing canonical execution outcomes

### 9.1 Do not remove task integrity

Change `execution_outcomes` to represent exactly one execution subject:

```text
subject_kind: task | verification_goal_run
task_id: uuid null
verification_goal_run_id: uuid null
```

Database check:

```text
subject_kind = task
  -> task_id is not null and verification_goal_run_id is null
subject_kind = verification_goal_run
  -> task_id is null and verification_goal_run_id is not null
```

Task-only links (`work_package_id`, `agent_run_id`, `task_attempt_id`) must all be null for goal-run subjects.

Replace the one task-only unique index with subject-specific partial uniqueness:

```text
UNIQUE(task_id, attempt_key) WHERE subject_kind='task'
UNIQUE(verification_goal_run_id, attempt_key) WHERE subject_kind='verification_goal_run'
```

Existing rows backfill to task subject before the new check becomes valid.

### 9.2 Contract version

Do not silently call this the old schema-v1 meaning if the serialized/public domain contract changes. Either:

- keep row `schema_version=1` and treat subject columns as storage-generalization only when the TypeScript `ExecutionOutcome` shape does not expose a breaking identity field; or
- deliberately introduce outcome contract v2 and provide explicit parsers for historical v1 rows.

The implementation architecture pass must decide this before migration code. Do not improvise mid-PR.

Preferred direction: **execution outcome contract v2** because task identity was explicitly part of ADR 0010's semantic decision. Historical v1 remains readable.

---

## 10. Generalizing deterministic operation execution

### 10.1 Context loader split

Refactor the current task-specific composition into a shared trusted project scope plus subject-specific authority loaders:

```ts
type TrustedProjectOperationScope = {
  projectId: string
  projectRoot: string | null
  rootBindingRevision: string
  projectRevision: string
  grantDecisionRevision: string
}

type TrustedOperationSubjectContext =
  | TaskOperationSubjectContext
  | VerificationGoalOperationSubjectContext
```

Then:

```text
load task authority
      ┐
      ├─> compose trusted project scope -> shared operation policy -> fixed adapter
      ┘
load goal-run authority
```

Do not duplicate the executor or adapter implementations.

### 10.2 Goal-run authority

For `verification_goal_run`:

- load the run from PostgreSQL;
- require current run/lease eligibility;
- load its exact project, registry revision, snapshot, and policy revision;
- require the registry head still equals the run's bound revision;
- require project active state and the exact root/grant/project revisions used by admission;
- require current effective project filesystem authority for the operation capability;
- require the run's clean repository identity still matches;
- derive policy ceilings server-side;
- caller supplies no project id, root path, capability set, grant, command, adapter, or policy version.

### 10.3 `allow_once`

Initial goal-run repository reads require current `always_allow` authority. `allow_once` remains blocked until a dedicated proof-run consumption protocol exists.

Scheduled execution must never consume an interactive one-time grant implicitly.

### 10.4 Operation idempotency

Each goal operation attempt key is derived from immutable run identity + canonical operation ordinal/id/version + attempt number using a domain-separated hash.

The operation caller does not invent it.

---

## 11. Repository command audits

Current fixed operation adapters write repository command audits against `task_id` and may include task/work-package links.

Generalize audit ownership using the same exclusive subject rule rather than omitting audit evidence for goal runs.

Goal-run command audits:

- link to `verification_goal_run_id`;
- have no work package or agent run;
- continue to use the fixed no-shell command runner;
- retain existing bounded/redacted audit behavior;
- are referenced by operation evidence UUIDs;
- are not copied into the goal-run event ledger.

The mandatory repository-clean/HEAD preflight requires a fixed trusted helper. It must persist only safe identity evidence (commit id, clean/dirty result, fingerprints) and must not persist raw dirty-file paths merely to decide whether the tree is clean.

If the existing command-audit sink cannot make that privacy guarantee, add a dedicated fixed repository-identity evidence record rather than storing raw porcelain status in a goal-run ledger.

---

## 12. Manual-run API

### 12.1 Route

Initial endpoint:

```text
POST /api/projects/:projectId/verification-goals/:goalId/runs
```

Request body: **none**.

The caller cannot submit:

- local path;
- registry revision;
- snapshot id;
- operation list;
- operation inputs;
- timeout;
- schedule;
- capability;
- policy profile;
- actor id;
- repository ref.

The server resolves all of those from authenticated session + current project/registry/policy state.

### 12.2 Idempotency

Require a bounded UUID `Idempotency-Key` header for manual create. Network retries with the same key return the same run. A deliberate later click uses a new key and may create a new manual run on the same commit.

Do not deduplicate all manual runs by commit; repeated human verification is a legitimate action.

### 12.3 Admission transaction

The route must, in one consistent authority boundary:

1. authenticate session and project ownership/access;
2. apply the existing project-management ingress gate;
3. lock/read current registry head and selected goal entry;
4. require schema v2 + enabled goal + manual declaration;
5. lock/read current project verification policy head;
6. resolve operation definitions and effective policy;
7. enforce project queue/concurrency admission;
8. create one `verification_goal_runs` identity with its policy/authority fingerprints;
9. commit;
10. enqueue only the resulting run UUID/occurrence after commit.

If enqueue fails after commit, the database row remains recoverable queued truth. Do not delete it and do not fabricate success.

### 12.4 Response

Return `202 Accepted` with bounded fields:

```json
{
  "schemaVersion": 1,
  "runId": "uuid",
  "goalId": "repository-readable",
  "status": "queued",
  "replayed": false
}
```

Expected errors use fixed codes and do not expose local paths, operation internals, raw policy JSON, or database errors.

---

## 13. Queue, lease, and recovery architecture

### 13.1 Dedicated job type, shared queue primitives

Verification runs need their own semantic job type and keys. They may reuse generic queue primitives once those primitives are parameterized, but they must not masquerade as task jobs.

Redis envelope carries only bounded identifiers, for example:

```ts
{
  schemaVersion: 1,
  runId: string,
  occurrenceId: string
}
```

No goal definition, path, command, evidence, policy JSON, or secret belongs in Redis.

### 13.2 PostgreSQL execution lease

Use PostgreSQL as the authoritative mutation fence for a run. Recommended lease fields or a child lease table:

```text
lease_generation bigint
lease_token uuid null
lease_owner text null
lease_expires_at timestamptz null
```

Claim increments generation and writes a fresh token under compare-and-set. Every authoritative run mutation verifies exact generation/token and unexpired database time.

Redis claim ownership alone is insufficient evidence that a stale process may still write PostgreSQL after a reconnect or response-loss race.

### 13.3 Recovery

Recovery scans PostgreSQL for queued/running runs whose queue occurrence/lease is absent or expired, then re-enqueues a new occurrence without creating a new run identity.

A worker that loses the database lease aborts its local `AbortSignal`, stops starting new operations, and cannot terminalize the run even if an earlier external command later returns.

Initial execution is read-only, but stale-worker fencing is still required because duplicate evidence would corrupt reliability/history.

### 13.4 Retry policy

Do not automatically retry a functional failed proof.

Infrastructure retry is a later bounded policy. The first manual runner may conservatively require a new run request after an inconclusive terminal result. Scheduling can create the next normal scheduled run at the next slot.

This avoids conflating "the behavior failed" with "the proof infrastructure failed."

---

## 14. Runner flow

Canonical v1 flow:

```text
run UUID already exists in PostgreSQL
  -> worker acquires DB execution lease
  -> revalidate registry/project/policy authority
  -> capture clean repository HEAD
  -> persist safe repository snapshot evidence
  -> for each canonical operation, sequentially:
       -> revalidate lease + authority + repository HEAD/clean state
       -> construct goal-owned trusted operation context
       -> execute exact Operation Catalog id/version
       -> require terminal canonical outcome + deterministic verification + required evidence
       -> stop on first non-pass or drift
  -> revalidate lease + authority + repository HEAD/clean state
  -> atomically terminalize goal run
  -> best-effort reliability ingestion only after the canonical run/outcome transaction is durable
```

### 14.1 Result mapping

**Passed**

All operations completed, deterministic verification passed, mandatory evidence is present, and authority/repository identity remained unchanged through terminalization.

**Failed**

At least one operation produced a decisive functional/verification failure under still-valid authority and repository identity. The run may update failed-proof history.

**Inconclusive**

The proof could not establish pass/fail because of timeout, lost authority, changed registry/policy/repository state, missing evidence, queue/lease loss, unsupported operation state, or infrastructure fault. It must not increment pass/fail streaks.

**Blocked**

Admission prevented execution before the runner had a valid proof attempt, for example disabled goal, policy denial, no filesystem authority, dirty repository, or queue capacity. Blocked requests do not become false failures.

### 14.2 First failure and last green

For the **current goal snapshot + policy cohort**:

- `lastGreen` = most recent decisive passed run;
- `consecutivePasses` = passes after the most recent decisive failure, ignoring blocked/inconclusive runs;
- `consecutiveFailures` = decisive failures after the most recent decisive pass, ignoring blocked/inconclusive runs;
- `firstObservedFailingCommit` = earliest decisive failed clean commit in the current unresolved failure episode;
- a later decisive pass resolves that episode but does not delete history.

"First observed" is intentional. Forge does not claim that commit introduced the bug unless a separate bisect/provenance mechanism proves causation.

Definition/policy cohort changes start new current streak semantics while preserving prior history.

---

## 15. Capability reliability integration

Do not ingest a goal-level aggregate as though it were one operation capability attempt.

Each deterministic operation run may feed #186 using its existing operation capability key, but the reliability ledger must first be generalized to support `verification_goal_run` as the parent execution subject.

Required changes in the later reliability slice:

- goal-run rows have `task_id = null` and `verification_goal_run_id != null` under an exclusive subject constraint;
- work-package/agent/task-attempt links are null;
- operation run id remains the specific operation evidence source;
- runtime fingerprint remains the deterministic adapter identity;
- scope/policy fingerprints include the goal-run project/root/grant/policy cohort;
- a goal-level pass does not duplicate all operation attempts a second time;
- `independent_agent` remains unavailable until #188 produces it.

Best-effort reliability ingestion must never change the canonical goal-run result.

---

## 16. Scheduling contract

Scheduling is intentionally after manual execution is proven.

### 16.1 Repository request vs operator enablement

A schema-v2 goal may request an interval. It runs on schedule only when current project policy also enables scheduling.

Effective cadence is no more frequent than the project minimum and system absolute floor.

### 16.2 Slot identity

Scheduled deduplication uses a deterministic slot key derived from:

- project id;
- authoritative goal snapshot id;
- effective policy fingerprint;
- scheduled interval identity/window;
- clean repository HEAD commit.

A unique constraint/idempotency record prevents two scheduler workers from creating duplicate authoritative evidence for the same goal/ref/slot.

### 16.3 Overlap

At most one running proof per project+goal in v1. If a new slot arrives while the prior run is still active, record/emit a bounded `overlap_skipped` scheduler event rather than queueing a second run.

A project-wide `maxConcurrentRuns` ceiling also applies across different goals.

### 16.4 Disabled/superseded goals

The scheduler resolves the current registry head on every tick. Removed, disabled, schema-v1, superseded, or policy-disabled goals do not run.

The scheduler never executes historical snapshots merely because they still exist in PostgreSQL.

---

## 17. Security and abuse cases

### 17.1 Malicious repository raises schedule frequency

Denied by project policy minimum, project scheduling enablement, queue/concurrency limits, and system floor.

### 17.2 Malicious repository references a dangerous operation

Import fails unless the exact operation exists, is enabled/non-deprecated, has matching capability, and is allowed by the current goal schema. The initial executable schema accepts the same zero-input bounded operation family already reviewed under ADR 0011.

### 17.3 Repository changes after admission

Registry head, project authority, repository HEAD, and clean state are rechecked. Drift invalidates the run.

### 17.4 Project path is replaced or rebound

Existing root identity/revision validation remains mandatory. Goal execution does not trust a stored pathname alone.

### 17.5 One-time filesystem grant is present

Initial runner refuses it. No implicit one-time consumption by scheduler or proof worker.

### 17.6 Duplicate Redis delivery

Only the database run/lease holder may mutate. Duplicate occurrences converge on one run identity.

### 17.7 Stale worker completes after lease loss

Its token/generation is rejected at every write/terminalization boundary. Local abort is advisory; database fencing is authoritative.

### 17.8 Repository becomes dirty mid-run

Terminal result is inconclusive/repository_changed. It is never attributed as a clean failing commit or clean pass.

### 17.9 Goal definition asks Forge to revoke autonomy

No such executable field exists in v2. Failure evidence is consumed later by #189 under operator-controlled policy.

### 17.10 Prompt injection in title/description

Title/description remain bounded metadata and never influence operation selection, inputs, command construction, policy, or adapter choice. The deterministic runner does not ask a model to interpret them.

---

## 18. Migration strategy

Implement shared-ledger generalization before the manual runner can execute.

Recommended migration order:

1. Add immutable project verification-policy revision/head tables and seed conservative current rows.
2. Add `verification_goal_runs` and run events/lease state.
3. Generalize canonical outcomes with explicit subject identity; backfill task rows; add exclusive checks and partial unique indexes.
4. Generalize operation runs with explicit subject identity; backfill task rows; preserve task-link checks.
5. Generalize repository command audits with explicit subject identity; preserve task history.
6. Only after those constraints are proven, enable goal-owned operation composition.
7. Generalize capability-attempt subject identity in the reliability-integration slice.

Every migration must include:

- populated-upgrade proof from the current migration tip;
- rollback/failure-safe ownership cleanup consistent with the protected migration model already used by Forge;
- closed application ACL inventory updates;
- proof that old task rows remain readable and unchanged in meaning;
- proof that invalid cross-subject link combinations are rejected by PostgreSQL, not only TypeScript.

Do not temporarily drop the old task uniqueness/foreign-key protection before replacement constraints are active.

---

## 19. API and module boundaries

Suggested modules, subject to implementation review:

```text
web/lib/verification-goals/contracts.ts
  - v1 + v2 definition parsing
  - canonicalization/digests

web/lib/verification-goals/policy-contracts.ts
  - project policy contract
  - resolved policy contract
  - deterministic policy intersection

web/worker/verification-goals/admission.ts
  - current registry/policy/project authorization
  - manual/scheduled admission

web/worker/verification-goals/repository-snapshot.ts
  - fixed clean HEAD proof

web/worker/verification-goals/runner.ts
  - lease-fenced sequential orchestration

web/worker/verification-goals/ledger.ts
  - run/events terminalization

web/worker/operations/context.ts
  - shared trusted project scope
  - task subject loader
  - goal-run subject loader

web/worker/queue.ts or a generic queue module
  - parameterized queue primitives, no proof-specific policy
```

Rules:

- contract modules do not import the database;
- policy resolution is a pure function once authoritative inputs are loaded;
- repository filesystem access lives behind one trusted project-root boundary;
- queue code transports identities but does not decide goal policy;
- API routes remain thin authenticated orchestration shells;
- no giant switch combining task and goal behavior throughout the codebase: use discriminated subject adapters at the boundary and shared execution beneath them.

---

## 20. Implementation slices after this architecture PR

### Slice A — policy contracts and database policy revisions

- add schema-v2 parser alongside v1;
- add project policy revisions/heads;
- add pure resolver + fingerprints;
- no runner, queue, or operation execution.

### Slice B — goal-run ledger and shared execution-subject migration

- add `verification_goal_runs` + events/lease contract;
- generalize `execution_outcomes`, `operation_runs`, and command audits;
- refactor trusted operation context into task/goal subject loaders;
- no public manual Run endpoint until PostgreSQL and ACL proofs pass.

### Slice C — manual-run vertical slice

- owner-only bodyless route + request idempotency;
- queue run identity;
- DB lease/fencing/recovery;
- clean repository HEAD snapshot;
- sequential zero-input deterministic operation execution;
- goal-level result mapping;
- no scheduling.

### Slice D — history + reliability integration

- deterministic last-green/first-failure/streak queries;
- generalize capability attempts for goal-run subject;
- ingest operation attempts after canonical terminalization;
- no independent model verification yet.

### Slice E — scheduling and overlap/dedup

- project policy-controlled interval scheduler;
- bounded queue/cost/frequency limits;
- slot idempotency + overlap skip;
- disabled/superseded handling;
- recovery and operational docs.

### Slice F — #187 closure proof

- sample executable schema-v2 goal;
- manual and scheduled end-to-end proof;
- migration/ACL/Redis failure proofs;
- docs and operator recovery commands;
- verify #187 acceptance criteria without implementing #188/#189/#190 behavior.

---

## 21. Verification plan

### 21.1 Contract tests

- v1 still parses exactly as before and remains non-executable;
- v2 exact-key validation;
- unknown execution/schedule/evidence keys fail closed;
- operation mismatch/disabled/deprecated/input-bearing operation fails;
- definition version/digest changes when execution policy changes;
- project policy intersection is monotonic: repository config cannot widen policy;
- fingerprints are locale-independent and stable.

### 21.2 Database tests

- populated upgrade preserves all task outcomes/operation runs/audits;
- exclusive execution subject constraints reject zero-subject and two-subject rows;
- goal-subject rows reject task/work-package/agent/task-attempt links;
- policy revisions append; pointer only advances correctly;
- run identity fields cannot mutate;
- stale lease token/generation cannot write/terminalize;
- manual idempotency key is replay-safe;
- scheduled slot uniqueness is race-safe.

### 21.3 Authority/race tests

Exercise both meaningful interleavings without correctness sleeps:

- registry head changes before admission commit;
- registry head changes after queueing/before execution;
- policy revision changes while queued;
- root binding/grant changes before each operation;
- repository HEAD changes between operations;
- repository becomes dirty during operation sequence;
- lease transfers while old worker is awaiting an adapter;
- enqueue response lost after DB commit;
- duplicate Redis delivery;
- terminal DB transaction response lost and replayed.

### 21.4 Operation tests

- exact canonical operation order;
- no input injection;
- no arbitrary shell/path/env;
- operation disable/version change after admission stops safely;
- missing canonical outcome/evidence cannot pass;
- deterministic adapter failure vs infrastructure timeout map differently;
- second operation never starts after first failure/authority drift.

### 21.5 API tests

- unauthenticated denied;
- wrong owner/project hidden;
- archived/inaccessible project hidden;
- body rejected;
- malformed/missing idempotency key rejected;
- schema-v1 and disabled goal not queued;
- policy-disabled/manual-disabled goal not queued;
- same idempotency key returns same run;
- new key can deliberately rerun same commit.

### 21.6 Scheduler tests

- project scheduling disabled wins over repo schedule;
- minimum interval wins over too-frequent repo request;
- duplicate scheduler workers create one slot run;
- same slot/ref does not duplicate evidence;
- new ref can create a new run;
- active overlap skips rather than duplicates;
- removed/disabled/superseded goals never execute.

### 21.7 Security/adversarial tests

- goal metadata prompt injection cannot affect command/policy;
- repository path/root replacement fails closed;
- malicious operation reference rejected;
- one-time grant not consumed by proof runner;
- schedule cannot bypass manual/project policy;
- stale worker cannot write after lease loss;
- local path/raw dirty file list not copied into goal-run ledger or Redis;
- failure cannot directly mutate autonomy, code, GitHub, or MCP grants.

---

## 22. Observability and operator recovery

A blocked/inconclusive proof must tell the operator **what category failed and what action is safe**, without raw infrastructure errors.

Minimum stable recovery categories:

- import/upgrade goal definition;
- enable goal;
- enable manual/scheduled project policy;
- clean repository;
- restore project filesystem read authority;
- retry after current run/lease recovery;
- inspect operation evidence;
- rerun manually with a new idempotency key.

Later operator commands must be documented as literal supported commands/APIs, not ad hoc SQL.

---

## 23. Explicit non-goals for this architecture/slice

- arbitrary model-authored shell execution;
- operation arguments sourced from repository text;
- dirty-worktree decisive proof results;
- parallel goal operations;
- operation dependency graphs/data flow;
- automatic repair;
- direct autonomy promotion/revocation;
- Sentinel finding implementation;
- independent model Verification Workforce execution;
- branch/commit/PR/merge authority;
- live MCP tool grants;
- production deployment;
- broad host cron;
- a polished reporting dashboard.

---

## 24. Architecture review checklist

Before this architecture is implementation-ready, orthogonal review must explicitly cover:

1. Contract fit against #184/#187, ADRs 0010–0013, and issue #60/#188 boundaries.
2. Execution-subject migration and backwards compatibility for existing task evidence.
3. Project/root/filesystem/policy/registry/repository authority races.
4. Queue occurrence idempotency, database lease fencing, response-loss recovery.
5. Goal-result semantics and the distinction between failed vs inconclusive.
6. Reliability cohort integrity and no double counting.
7. Schedule abuse, overlap, dedup, queue/cost pressure.
8. Command/audit privacy, prompt injection, path rebinding, stale-worker effects.
9. Migration ordering, protected role/ACL cleanup, populated upgrade proof.
10. API/operator recovery clarity and downstream #188/#189/#190/#191 extensibility.
11. Modularity: task and goal subjects share infrastructure without repeated domain switches.
12. Hardcoding review: tunable values are DB-backed; only protocol/safety invariants remain in code.

Review findings must be amended into this document before implementation work begins. A final review may state **No blockers found in the inspected scope**; it may not claim the architecture is defect-free.
