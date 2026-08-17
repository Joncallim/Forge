# Issue #187 Architecture: Verification Goal Run Policy and Goal-Owned Execution

Status: **Consolidated architecture after orthogonal review rounds 1–7. Implementation is not authorized until fresh post-amendment review finds no material blockers in scope.**

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

1. prove the **live repository goal registry still matches the explicitly imported authoritative registry**;
2. select only explicitly reviewed deterministic Operation Catalog entries;
3. resolve operator/system execution ceilings without allowing repository text to grant authority;
4. create a first-class **verification goal run**, not a synthetic implementation task;
5. bind decisive proof evidence to one strictly clean repository commit, one live root object, and a bounded execution environment;
6. execute the exact bound operations in canonical ordinal order through the existing deterministic executor under database-owned lease fencing and root-anchored command launch;
7. distinguish functional proof failure from authority, infrastructure, evidence, timeout, and recovery uncertainty;
8. emit one overall #185-compatible canonical outcome for the goal run plus child operation outcomes;
9. calculate last-green / first-observed-failure history from validated decisive evidence while surfacing repeated-evidence instability;
10. feed comparable child-operation evidence into #186 without sample inflation;
11. support manual runs first, then a bounded deterministic scheduler;
12. preserve explicit human/project authority and fail closed on every version/authority/evidence mismatch.

The first executable version remains **read-only**. It does not edit code, repair failures, create branches/PRs, merge, deploy, issue live MCP handles, or modify autonomy.

---

## 2. Current repository facts that constrain this design

- ADR 0013 / PRs #328–#330 provide definition-only v1 snapshots, immutable registry revisions/entries, current head, import-time project/root/grant authority, and **no execution authority**.
- Current Operation Catalog execution is task-owned, uses task/work-package filesystem context, fixed argv, command audits and deterministic output verification.
- `execution_outcomes`, `operation_runs`, repository command audits and reliability-v1 are task-owned today.
- Current outcome-v1 can collapse function failure and evidence/infrastructure failure to generic `unknown`; goal proof needs failure class.
- Existing project filesystem decision + current pointer is already the persistent project authority substrate; do not invent a project `grantMode`.
- Existing repository command code already centralizes substantial Git environment hardening; goal work must reuse/refactor it.
- Current `assertProjectLocalPathForExecutionBinding` safely captures `(path,dev,ino)` but closes its directory handle. That identity token is insufficient as the final execution boundary because a pathname can be rebound between a check and process start.
- PostgreSQL is business truth; Redis is wake-up/delivery only.

A historical v1 goal or task/outcome/reliability record never changes meaning because Forge is upgraded.

---

## 3. Non-negotiable invariants

| ID | Invariant |
|---|---|
| I1 | A goal run is never represented by a synthetic task/work package/agent run/task attempt. |
| I2 | Schema-v1 goal snapshots remain definition-only forever. |
| I3 | A run binds exact current registry revision/entry/snapshot/execution binding and exact project policy revision. |
| I4 | Live repository goal manifest must equal explicitly imported head before admission and around execution. |
| I5 | Repository config can only request/limit work; never widen permission/rate/concurrency/deadline/evidence/verifier/autonomy. |
| I6 | Existing/new projects are default-disabled for manual and scheduled goal execution. |
| I7 | Only exact code-owned allowlisted Operation Catalog id/version pairs are goal-eligible. Absence=denied. |
| I8 | Initial eligible ops are zero-input, trusted-project, read-only, deterministic, no unsupported approval/verifier, hardened against repo-configured helpers. |
| I9 | Goal reads require current persistent project filesystem decision=approved with `filesystem.project.read`; package `allow_once` is not authority. |
| I10 | Admitted run has PostgreSQL identity before Redis. |
| I11 | One active run per project+logical goal across manual/scheduled. |
| I12 | Queued/running/recovery and total-active project capacities are DB-bounded. |
| I13 | PostgreSQL run lease generation/token is sole business mutation fence; Redis ownership is not business authority. |
| I14 | Goal-subject proof writes are DB lease-fenced and become immutable after authoritative creation/finalization. |
| I15 | Post-claim project command execution uses a **live retained root lease plus root-anchored command launcher**; raw pathname `cwd` is forbidden for goal commands. |
| I16 | Decisive pass/fail binds one strictly clean Git object identity plus execution-environment/build/launcher fingerprint. |
| I17 | Registry/project/root/grant/policy/catalog/eligibility/repo/build drift produces no stale pass/fail. |
| I18 | Operations are canonical sorted ordinals, sequential, one overall deadline, no workflow language/data flow/parallelism. |
| I19 | Protected begin can start only the exact next stored operation; no skipped/duplicate/extra op. |
| I20 | Transport/exit zero alone cannot pass; deterministic verifier + exact relational evidence required. |
| I21 | Only outcome-v2 `functional` child failure can make goal `failed`; all authority/infra/evidence/timeout/unknown is inconclusive. |
| I22 | Incomplete child is never replayed or inferred inside same goal run. |
| I23 | Terminalizer validates exact child prefix and atomically writes overall outcome, final event, evidence digest and run terminal state. |
| I24 | Overall goal outcome never creates capability-reliability sample; exact child outcomes only. |
| I25 | Repeated same evidence unit cannot manufacture independent sample count; conflicting repeats make aggregate evidence unstable. |
| I26 | Scheduler uses DB-time bindings/slots, bounded batches, current slot only, no catch-up stampede, project budgets. |
| I27 | Failure records evidence only; no repair/autonomy/GitHub/grant/model action. |
| I28 | Unknown contract/schema/policy/manifest/eligibility/launcher version fails closed. |

---

## 4. Version inventory

```text
Goal definition: v1 definition-only; v2 executable declaration
Registry manifest: v1 existing; v2 membership + execution binding
Registry execution binding: v1
Project verification policy: v1
Resolved run policy: v1
Goal run/events: v1
Repository identity evidence: v1
Execution environment evidence: v1
Goal evidence-set descriptor: v1
Goal aggregate evidence unit: v1
Canonical outcome: v1 existing; v2 failure classification/new stop reasons
Capability reliability: v1 task; v2 goal subject/environment/evidence unit
Goal operation eligibility: v1 code-owned allowlist
Goal system limits: v1
Trusted root command launcher: v1
Redis goal envelope: v1
Scheduler binding/slot: v1
```

Semantic changes bump relevant version/digest. Unknown versions do not fall back.

---

## 5. Goal definition v2

```ts
type VerificationGoalEvidenceRequirement =
  | 'repository_identity'
  | 'execution_environment'
  | 'canonical_operation_outcomes'
  | 'operation_evidence'

type VerificationGoalScheduleDeclaration = null | { kind: 'interval'; everySeconds: number }

type VerificationGoalExecutionDeclarationV1 = {
  manual: boolean
  schedule: VerificationGoalScheduleDeclaration
  deadlineSeconds: number
  requiredEvidence: VerificationGoalEvidenceRequirement[]
}

type VerificationGoalDefinitionV2 = {
  schemaVersion: 2
  goalId: string
  definitionVersion: number
  title: string
  description: string
  capability: string
  severity: 'low'|'medium'|'high'|'critical'
  enabled: boolean
  operations: VerificationGoalOperationReference[]
  execution: VerificationGoalExecutionDeclarationV1
}
```

Forbidden: shell/argv, op inputs, cwd/path/env, adapter/tool/MCP/server, credentials, model/provider/verifier, prompt/callback/webhook, cron, dependencies/piping, autonomy/repair. Unknown keys fail.

Severity is reporting metadata only, never permission/risk input.

RequiredEvidence is additive; base evidence is mandatory for current registry/binding/authority, environment, strict clean repo identity, every **executed child in valid prefix**, and adapter evidence.

`verification_goal_snapshots` remains repo-definition truth; add `definition_schema_version`, DB exact-v1 OR exact-v2 JSON checks. Existing v1 rows unchanged.

---

## 6. Code-owned operation eligibility

Separate exact id/version security allowlist (do not perturb historical OperationDefinition digests):

```ts
const VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION = 1

type Eligibility='not_allowed'|'manual_only'|'manual_and_scheduled'
Map<`${string}@${number}`, Eligibility>
```

Absent=not_allowed.

Initial eligibility also requires zero inputs, `trusted_project`, `read_only`, no human approval, reviewed read-only recovery, supported deterministic verifier/adapter. Independent verifier required before #188 => blocked. Schedule requires all ops manual_and_scheduled.

Eligible Git operations reuse/refactor one hardened Git environment; no second safety list. Required effective boundary disables system/global config, fsmonitor, untracked cache, external/interactive diff/process/credential helpers as applicable, optional locks, prompts/pagers; no shell; diff keeps no-ext-diff/no-textconv; adversarial helper sentinel mandatory.

Submodule/gitlink => v1 inconclusive `submodule_repository_unsupported`.

---

## 7. Executable binding on registry entry

Snapshot is repository truth; code execution policy can change independently.

```ts
type VerificationGoalOperationBindingV1 = {
  operationId:string; operationVersion:number; definitionDigest:string
  capability:string; adapter:string; risk:string; scope:string; timeoutMs:number
  verification:string; approvalRequired:boolean; independentVerificationRequired:boolean
  eligibility:'manual_only'|'manual_and_scheduled'
}

type VerificationGoalExecutionBindingV1 = {
  schemaVersion:1
  eligibilityPolicyVersion:1
  eligibilityPolicyDigest:string
  operations: VerificationGoalOperationBindingV1[]
}
```

Canonical binding -> `execution_binding_digest`.

Registry entry adds contract version + nullable binding/digest. V1 definition entry => null binding; executable v2 => required binding. Same immutable repo snapshot may appear in later registry revision with new Forge binding; no fake repo definition-version bump.

Admission/before-child re-resolve catalog+eligibility and require current digest == bound. Mismatch `operation_contract_changed`, re-import required.

---

## 8. Registry manifest v2 / live attestation

Registry revision adds `manifest_schema_version default 1`. V1 byte-compatible. Any executable v2 entry => manifest v2 including goal/version/definition digest/source path/entry contract/execution binding digest in canonical order/domain.

Protected revision routine recomputes declared manifest version; import response version exposes manifest version/digest.

Explicit import remains activation. Live mismatch => `registry_content_stale`, no auto-import.

Read-only live attestation reuses hardened no-follow bounded registry reader and returns canonical manifest identity + captured project authority only.

Admission is two-phase: authenticate/capture authority + live attestation outside long locks, then canonical DB transaction rechecks project/filesystem/registry/entry/policy/active/budget and requires attested manifest still equals head.

Post-claim live attestation must also prove the current project pathname still corresponds to the **live TrustedProjectRootLease** `(dev,ino)` before reading `.forge`; then use registry's own directory/file handles. Re-attest before first child, each child conservatively, and terminalization. Mismatch => inconclusive `registry_content_changed`.

---

## 9. Registry-to-current project authority

Current project must equal registry import tuple: owner, active archive state, local path, rootRef, rootBindingRevision, grantDecisionRevision, projectRevision. Mismatch `registry_authority_stale`, re-import required. Queued/running v1 stops on any registry-head revision change.

---

## 10. Project verification policy

Immutable protected revisions/head:

```text
schema v1
manual_enabled, scheduling_enabled
min_schedule_interval_seconds
max_run_deadline_seconds
max_queue_age_seconds
max_operations_per_run
max_concurrent_runs
max_queued_runs
max_active_runs
start_budget_window_seconds
max_starts_per_window
actor_kind migration_seed|system_default|human
actor_user_id nullable by shape
predecessor + sequence + digest + timestamps
```

Protected fixed-search-path writer locks project/head, verifies owner/CAS, validates values, appends one revision/advances head atomically. App cannot direct update/delete/head move; PUBLIC execute revoked. Provenance caveat matches registry application-asserted actor model.

Existing/new projects receive valid disabled policy; missing head fail-closed. One canonical seed source drives migration/new project parity.

Recommended default values:

```text
manual=false; scheduling=false
min interval=3600s; max run deadline=600s; max queue age=300s
max ops=16; max running=2; max queued=8; max active=10
start window=3600s; max starts=20
```

Capacity semantics: queued=status queued; concurrent=running with live DB lease; active=queued|running|recovery_required; completed/expired no capacity. Start budget counts new admitted rows in rolling DB-time window; replay/reject none.

Minimal GET/PATCH project verification-policy API/settings, server-derived actor/digest.

---

## 11. System limits / runtime availability

Single code source:

```ts
const VERIFICATION_GOAL_SYSTEM_LIMITS_V1 = {
  businessLeaseMs:30_000,
  leaseRenewTargetMs:10_000,
  leaseLocalSafetyMarginMs:5_000,
  recoveryQuiescenceGraceMs:5_000,
  // named absolute parser/policy/scheduler/preflight ceilings
} as const
```

Lease 30s, renew target 10s, local fence <=25s without confirmed renewal, recovery horizon includes max child timeout +5s after last trusted lease horizon.

Runtime availability = build capability ∩ process-start restrict-only kill switch ∩ project policy. Kill-switch change requires process restart. Emergency stop kills/restarts process; lease/watchdog recovers in-flight inconclusively. No promise of live env-file observation. Build/gate contract version is evidence. Future live DB global switch separate review.

---

## 12. Persistent project filesystem authority

`loadVerificationGoalFilesystemAuthority(projectId,goalCapability)` uses current project decision pointer -> immutable approved decision; capability set contains `filesystem.project.read`; current root/grant revisions match run/registry. No new grant_mode. Package allow_once ignored/unconsumed.

---

## 13. Trusted project root lease and root-anchored command launcher

Required before goal execution can be enabled.

### 13.1 Live root lease

Refactor/evolve existing project-root binding primitive to retain its safe-opened directory handle:

```ts
type TrustedProjectRootLease = Readonly<{
  path:string
  dev:bigint
  ino:bigint
  handle:OpaqueDirectoryHandle
  close():Promise<void>
}>
```

Acquisition: existing workspace/protected-project overlap checks -> canonical real path -> final lstat real directory/no symlink -> open `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` -> fstat + re-lstat/realpath all exact -> **keep handle open for entire goal business worker**. Retained handle prevents expected inode reuse while live. Never serialize/expose handle. Close in final cleanup/fence handoff.

Do not fork workspace/root canonicalization. Task execution may retain current return identity for compatibility but both use shared binding primitives.

### 13.2 Code-owned Node root command shim

Raw `execFile(...,{cwd:projectPath})` is forbidden for post-claim goal commands.

Launch a small **code-owned Node shim embedded in the already-running Forge build/in memory**, not loaded from project filesystem. Invoke current trusted Node runtime with minimal safe environment that removes Node injection surfaces (`NODE_OPTIONS`, `NODE_PATH`, preload/module-search overrides) plus reviewed Git safe environment.

Internal launch contract (never model/repo supplied): project path, expected dev/ino, closed executable kind `git`, fixed argv, bounded timeout metadata.

Shim:

1. open project path `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`;
2. fstat exact expected dev/ino from still-live parent lease;
3. `process.chdir(projectPath)`;
4. immediately bigint-stat `.` and require exact expected dev/ino;
5. mismatch -> fixed `root_changed`, **no target starts**;
6. spawn fixed target **without `cwd`**, inheriting already-resolved cwd object;
7. fixed argv/env, no shell;
8. propagate abort/timeout to target; no orphan process; return structured status + bounded output.

Race closure:

- swap before open -> inode mismatch;
- swap between open/chdir -> `stat('.')` mismatch, no Git;
- swap after chdir/stat -> cwd already references authorized directory object, later pathname change cannot redirect child;
- retained parent handle prevents same-inode reuse.

Unsupported platform/primitive => goal execution unavailable. Initial supported platforms are those proven in CI (macOS/Linux).

### 13.3 Target executable / environment evidence

Executable is closed kind, not arbitrary path. V1 uses system Git through Forge's safe path policy; repo cannot alter executable selection. Root launcher contract version + Forge build identity + Node/Git versions participate in environment fingerprint. If release identity unavailable local, separate requalification cohort.

### 13.4 Coverage

All post-claim goal Git commands use launcher: object format/HEAD, strict status, gitlink preflight, all eligible Operation Catalog Git adapters.

Direct registry file reads use registry's file-handle reader but first prove current project path still matches live root lease.

---

## 14. DB lock/capacity order

Canonical order: project -> current project filesystem decision -> registry head/revision/entry -> policy head/revision -> active/budget rows -> target run -> child rows. Reconcile with existing producers before implementation; filesystem traversal outside locks then recheck.

Worker claim locks project/policy capacity serialization before counting live running leases and queued->running, so two claims cannot oversubscribe one slot. `max_concurrent` counts running with lease expiry > DB transaction time. Expired running stays active/unresolved but not compute slot; recovery moves it to recovery_required.

---

## 15. Resolved policy

Exact stored bounded v1 JSON/fingerprint with project/registry/entry/snapshot/binding/policy identities, trigger, effective deadline/queue/schedule/evidence, system availability, canonical operations ordinal 0..N-1 exact id/version/digest/eligibility/timeout. Worker loads exact snapshot, only revalidates authority. Any v1 policy-head change stops run.

---

## 16. Goal run / idempotency

Run stores exact entry/policy, resolved policy, authority, trigger/idempotency-or-schedule, admission expiry, lifecycle, result/code, overall outcome, **goal_evidence_set_digest**, **goal_evidence_unit_fingerprint**, lease, timestamps.

Lifecycle:

- queued no start/finish/result/outcome/digests/lease;
- running started/live lease;
- recovery_required started/no live worker lease/recovery_not_before;
- completed started+finished/result/overall outcome/evidence-set digest/goal evidence-unit, no lease;
- expired never started/finished/no result/outcome/digests/code dispatch_expired.

Partial unique active `(project_id,goal_id)` over queued/running/recovery. Manual unique `(requested_by_user_id,manual_idempotency_key)` partial. Fingerprint contract+actor+project+goal: same replay/different 409.

Indexes project status+created, project goal+finished, project+created budget, status expiries, snapshot history.

---

## 17. Strict repo identity

Immutable one-per-run snapshot with project/root/grant/project revision, object format, OID, strict clean, fingerprint/time.

Strict clean = hardened `git status --porcelain=v1 -z --untracked-files=all` **zero entries**, no Forge-path exclusion. Runtime artifacts outside repo or explicitly ignored by repo; runner hides nothing. Untracked goal config may import but cannot yield decisive clean proof.

All Git preflight through root shim under outer deadline + smaller bounds. SHA1 40 hex, SHA256 64. Unknown/unborn/bare/submodule => inconclusive. Raw status paths discarded. Revalidate before/after children/final.

---

## 18. Environment evidence

Immutable one-per-run: schema/runner contract, Forge build identity/state release|unavailable_local, **root launcher contract version**, platform/arch, normalized Node/Git, op binding digest, eligibility version/digest, environment fingerprint. No hostname/user/path/env dump/secrets/network metadata. Build pipeline identity when trustworthy; unavailable_local distinct cohort. Duration DB timestamps.

---

## 19. Outcome v2 / terminal codes / immutability

Outcomes exclusive task/goal; task v1 preserved. Goal v2 append-once. Failure class functional|policy|authority|infrastructure|evidence|cancelled.

Child pass: transport ok, completed, no stop/failure, retry false, verifierRequired false, verificationStatus not_required; op-run verifier passed.

Child durable functional command fail: transport ok, failed, operation_execution_failed, functional. Deterministic verifier fail: transport ok, failed, validation_failed, functional, op-run verifier failed. Authority/policy block: transport ok, blocked, authority|policy. Timeout/infra/evidence: transport error, needs_attention, infra|evidence|cancelled. Never functional.

Run terminal codes:

```text
passed
functional_operation_failed
functional_verification_failed
repository_dirty
repository_changed
root_changed
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
dispatch_expired (expired only)
```

Overall passed: transport ok/completed/no stop. Failed: transport ok/failed/verification_goal_failed/functional. Inconclusive: transport ok/needs_attention/stop exact inconclusive terminal code/failure exact class mapping. DB tests freeze every terminal-code->failure-class mapping; no unknown fallback.

Goal command audits/outcomes/terminal op links/events/repo/env/completed proof fields immutable after authoritative creation. Future adjudication appends separate history.

---

## 20. Operation ordinals

Operation runs exclusive subject + goal ordinal. Goal task links null/project matches goal/ordinal non-null; task ordinal null. Partial uniques goal+ordinal, goal+idempotency.

Protected begin receives run+lease+ordinal only, loads stored policy, derives exact op, checks in-range/no same row/all prior terminal decisive pass/no later row/live DB state, then idempotency H(run,ordinal,op id/version,definition digest,binding digest). No child retry generation.

Filesystem facts are not pretended to be PostgreSQL facts: runner first reattests root/live registry/repo, then protected DB begin enforces DB/ordinal state, then root shim independently anchors cwd at actual command start, then runner post-attests before trusting result.

---

## 21. Outer cancellation/deadline

Shared executor optional outer signal/deadline; tasks unchanged when absent. Goal composes child timeout, overall deadline, DB lease watchdog, process shutdown. Overall starts at DB started_at and includes env/registry/repo preflight. No new work after. Root shim propagates termination to Git, no orphan.

---

## 22. Lease-fenced immutable evidence

Protected DB routines/triggers verify run/gen/token/running/unexpired before worker proof writes: child begin/event/finalize, command audit, goal events, repo/env, child outcome/link, overall terminal. Afterwards append-only/immutable. Task legacy unaffected.

---

## 23. Audit evidence

Goal command audit exact goal subject + operation_run_id. Evidence chain goal->ordinal child->outcome->audit. Arbitrary UUID insufficient. Internal protected cwd/argv may remain; public goal/Redis/API/reliability never copy raw path/output.

---

## 24. Manual API

POST project/goal/runs body empty + UUID Idempotency-Key. Caller cannot supply authority/execution details. Two-phase auth+live attestation then canonical locked recheck/capacity/budget/create queued+expiry; post-commit Redis recoverable.

GET bounded single-run status/result/code, safe commit/env identity, duration, child/evidence refs, safe recovery. No path/raw output/policy/Redis/lease/DB internals.

Expected fixed redacted denials cover invalid request/key/conflict/project/registry stale/goal nonexec/disabled/eligibility/binding/verifier/system/manual/filesystem/active/budget/queue/root-launcher unsupported.

---

## 25. Redis / DB lease

Envelope runId+occurrenceId only. Reuse generic queue primitives. Receive Redis -> acquire DB lease -> after durable claim ack Redis best-effort -> business only DB lease. Duplicate ack loss cannot acquire DB lease. DB uncertainty no assumed ownership/drop. Queued DB redispatch.

---

## 26. Lease/watchdog

Claim serialized through project capacity lock; queued/unexpired -> running, generation++, fresh token, DB expiry +30s, started once. Renew exact state target10s. Local monotonic fence <=25s since last confirmed lease. DB error never extends; late response no revive; abort shim/new work. Root lease closed in worker finally.

---

## 27. Runner

```text
queued -> Redis -> serialized DB lease -> ack Redis
 -> acquire+retain TrustedProjectRootLease
 -> deadline active
 -> env incl launcher/build
 -> revalidate system/project/registry/live manifest/policy/filesystem/catalog/eligibility against root lease
 -> strict clean repo snapshot via root shim
 -> ordinal loop:
      lease/deadline + live/DB/repo recheck
      protected begin exact next op
      root-anchored shared executor inputs={} fixed reason
      lease-fenced immutable child evidence
      outcome-v2/evidence
      post-check
      stop first non-pass, no later ordinal
 -> final checks
 -> protected prefix/evidence terminalization
 -> overall outcome + evidence-set digest + goal evidence-unit + final event + completed row atomically
 -> close root lease finally
 -> post-commit best-effort child reliability-v2
```

No LLM.

---

## 28. Child-prefix rules

Passed exactly 0..N-1 all terminal decisive pass. Failed exactly 0..k with prior pass and k decisive functional fail, no >k. Inconclusive canonical prefix only, no later child; uncertain child handled recovery before completed. No mutable skipped rows. DB terminalizer locks/validates set.

---

## 29. Overall evidence / drift

Protected terminalizer derives canonical evidence descriptor from repo snapshot id/fingerprint, env snapshot id/fingerprint, child ordinal/run/outcome/fingerprint list, result+terminal code. Compute `goal_evidence_set_digest`, bind overall fingerprint; evidence refs derived, caller cannot supply.

Atomic terminal: validate lease/snapshot/child prefix/evidence, insert immutable overall outcome+final event+completed row/digest/unit, clear lease. Replay existing. Expired no outcome.

Trust readers rederive/validate evidence set; mismatch => evidence_drift, suppress decisive trust. Overall excluded reliability.

---

## 30. Recovery

No replay/inference after lease loss. Crash before audit no evidence; audit-before-child-final audit not result; child-final then worker loss v1 no resume.

Read-only quarantine: fence generation; recovery_required; not-before >= last trusted lease horizon + max child timeout +5s; after verify no live lease/outcome/new evidence, protected recovery closes parent inconclusive preserving child. Old root lease died with worker; recovery does not depend on it. Side-effecting ops future contract.

---

## 31. Queue expiry

DB expiry; unstarted queued -> expired/dispatch_expired/finished, no result/outcome/digests. No history/reliability.

---

## 32. Events

Append-only gapless guarded events, closed phase/status/code, optional child/snapshot/evidence refs/time. No prose/path/raw errors. Worker events lease-fenced; recovery/system guarded separately.

---

## 33. Aggregate history / instability

Current cohort = project + goal snapshot/definition + registry binding + resolved policy + environment.

Only validated-evidence strict-clean completed pass/fail are decisive observations.

```text
goal_evidence_unit_fingerprint = H(
  project,
  goal snapshot/definition,
  registry execution binding,
  strict repo object format/OID,
  resolved policy fingerprint,
  execution environment fingerprint
)
```

Evidence-set digest identifies one concrete run; evidence-unit identifies equivalent proof conditions across runs.

History returns lastGreen observation, firstObservedFailingCommit, raw consecutive decisive pass/fail counts (inconclusive ignored), and `currentEvidenceState=stable|unstable`.

If same goal evidence unit has both decisive pass and fail, state=unstable. A later pass on same unit does not silently resolve trust/regression; lastGreen may still display but #189/#190/#191 trust actions are suppressed/flagged until a changed evidence unit or future policy resolves instability.

Do not claim causal first bad commit.

---

## 34. Reliability v2

Only child terminal outcomes ingest; overall excluded. Goal v2: goal FK/task links null/contract2/evidenceUnit/environment/outcome-v2; task v1 preserved.

Runtime fingerprint deterministic adapter+env. Policy fingerprint subject+resolved policy+binding. Child evidence unit H(project, goal binding, op, strict OID, policy, env). Store all observations; raw count, unique units, promotion-grade unique count. Same-unit conflicting outcomes => instability/no promotion.

No ingest uncertain/nonterminal/drifted/expired/overall. Ingest failure does not change proof.

---

## 35. Scheduling

Schedule only when live==imported, executable scheduled-eligible binding, project scheduling enabled, build/process capability available, filesystem authority valid.

Immutable DB-time binding exact entry+policy+binding; first due anchor+interval. Slot PK binding+sequence with bounded dispositions/counters/run. No HEAD in slot identity. Unique slot prevents concurrent duplicate; one active goal prevents overlap. Bounded cursor/min scan cadence; downtime current slot only/no catch-up backlog. Capacities/budget apply. Stale registry no auto-import.

Later slot may re-observe same commit as operational observation; same-slot/concurrent same goal-ref not duplicated, and same evidence unit does not add unique trust sample.

---

## 36. Downstream boundaries

#187 emits stable regression candidate (prior stable pass -> new stable fail) **or aggregate evidence instability**, not Sentinel finding. #190 owns findings. Repo schema no autonomy action; #189 consumes validated proof/reliability. #188 appends verifier history, never rewrites deterministic result. Browser/model/provider/verifier not repo-selectable.

---

## 37. Rolling release

0 registry v2/binding/live attestation.
1 protected default-disabled policy API/settings; execution unavailable.
2 shared-ledger expand subject/version/ordinal + dual readers; no goal rows.
3 goal run/evidence + protected lease/child immutability/outcome-v2; no execution.
4 cutover task backfill/exclusive constraints after dual consumers.
5 manual release: **root lease + code-owned root shim**, harden allowlist, outer deadline, goal authority/API/queue/lease/watchdog/ordinal runner/GET; proof then manual build capability; projects still disabled.
6 history/reliability v2.
7 scheduler proof then scheduling build capability.

No goal row before consumers support it.

---

## 38. Migration/ACL proof

Every DB slice: journal/populated installer/legacy/current-tip, protected-owner failure cleanup, fixed search path/PUBLIC revoke, closed app ACL, no task integrity gap, invalid subject/project/registry/policy/ordinal shapes rejected, crash/retry, historical meaning preserved. Goal evidence immutability real PostgreSQL privileges/tests.

---

## 39. Module boundaries

```text
lib/verification-goals/{contracts,eligibility,system-limits,policy-contracts,history}
worker/verification-goals/{registry-attestation,admission,filesystem-authority,repository-snapshot,environment-snapshot,root-command-launcher,ledger,runner,scheduler}
worker/operations/{context,executor}
worker/queue/* generic primitives
```

Root launcher reuses canonical project binding/workspace safety + Git safe env; embedded shim not loaded from project disk. Pure contracts DB-free; routes thin; subject adapters isolate differences; queue identity-only; scheduler no LLM; tunables DB-backed, constants protocol/security only.

---

## 40. Implementation slices

A v2 definition/manifest/entry binding/live attestation/eligibility/protected policy API.

B goal subject/evidence FKs/protected lease+ordinal+immutability/outcome-v2 dual compatibility, execution unavailable.

C root lease+shim, harden eligible read adapters, outer deadline, goal FS authority, POST/GET, queue/lease/watchdog, strict SHA1/256 clean/submodule refusal, ordinal ops, overall evidence/unit.

D aggregate stable/unstable history + reliability-v2.

E bounded scheduler.

F closure E2E/migration/ACL/Redis/root-race/evidence-drift/docs.

---

## 41. Acceptance / deviations

Repo version=v1 preserve/v2 execute; safe verifier=eligible bound ops; timeout/resource=DB policy+system+overall; manual before schedule; DB scheduler; structured repo/env/child+overall evidence; root-anchored clean commit+env; stable history; outcome-v2; child reliability-v2 unique units; active/ordinal/slot/lease dedup; disabled policies; no repair/autonomy; #188 browser separation; redaction.

Deliberate no executable repo autonomy action (#189). “First observed failing commit,” not causal first bad commit.

---

## 42. Verification matrix

**Definition/registry:** v1 compat, exact v2, binding/manifest version, eligibility, live stale admission/runtime.

**Root/Git security:** retain root lease; race swap before shim open, between open/chdir, after chdir; no redirected Git; retained handle inode-reuse proof; embedded shim not project-replaceable; NODE_OPTIONS/NODE_PATH/preload injection stripped; Git helper/config sentinel; no optional mutation; SHA1/256; strict dirty incl Forge paths; unsupported/unborn/bare/submodule; deadline; launcher cancellation no orphan.

**Policy/capacity:** disabled/missing/CAS/ACL/monotonic resolver/build gate; exact queued/running/active/start budget; concurrent claim serialization.

**Referential/ordinal:** exact entry/policy, exclusive subjects, cross-project, ordinal next-only, pass/fail/inconclusive prefix closure, overall outcome/digests/unit, expired no proof.

**Admission races:** project/root/grant, manifest/head, policy, active/budget, catalog/eligibility controlled interleavings.

**Outcome/evidence:** exact v2 mappings; functional vs evidence/infra; immutable relational proof; evidence-set rederive/drift; same-unit aggregate instability.

**Lease/queue/recovery:** duplicate/ack loss/DB uncertainty/25s fence/late renewal/stale-token write denial/crash/quarantine/expiry/replay.

**API:** auth/body/idempotency/all current policy/system/filesystem/budget/active/root-launcher denials, bounded GET.

**History/reliability:** inconclusive excluded, failure episode, cohort changes, aggregate instability, child unique units, overall excluded, no uncertain ingest.

**Scheduler:** gate/interval/anchor/race/overlap/budgets/stale/config/downtime/bounded scan/same-ref repeat not unique trust.

**Rolling:** dual consumers before nullable task cutover, root-launcher availability, no premature rows, populated upgrade/owner cleanup/task history.

---

## 43. Release evidence

Normal gates plus real PostgreSQL migration/ACL/ordinal/immutability, Redis duplicate/loss/recovery, DB lease outage/watchdog, **root path-swap tests around shim open/chdir**, Node injection-env test, malicious Git helper sentinel, SHA1/256 fixtures, live registry drift, manual E2E, scheduler multi-worker/offline/budget, aggregate/child instability, evidence-drift/cross-sink leakage, mutation tests, PR Contract, Security/Adversarial review.

Architecture confidence is not release evidence.

---

## 44. Explicit non-goals

Synthetic task proof; arbitrary shell/model; repo op inputs; dirty decisive proof; submodule v1; side-effecting ops v1; parallel/workflow language; auto-repair; autonomy; Sentinel implementation; independent model verifier; browser verifier; branch/commit/PR/merge; live MCP grants; broad cron; deployment; full #191 UI/export.

---

## 45. Post-amendment review rule

Fresh review against live code across contract, data/version/FK/ordinal/migration, full API/scheduler->root lease/shim->operation->outcome path, crash/recovery, auth/ACL/Git/root/stale-worker/resource/leakage, immutable/drift/unstable evidence, reliability trust, scheduler, operator recovery, rolling compatibility, CI evidence, modularity/hardcoding, downstream #188–#191.

Any material issue -> amend, verify, restart fresh passes.

Final wording may be **“No blockers found in the inspected architecture scope.”** It must name residual uncertainty and never claim absence of defects.
