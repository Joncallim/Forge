# Issue #187 Architecture: Verification Goal Run Policy and Goal-Owned Execution

Status: **Consolidated after orthogonal architecture review rounds 1–10. Runtime implementation remains unauthorized until a fresh post-amendment review finds no material blockers in the inspected scope.**

| Field | Value |
|---|---|
| Issue | [#187 — Add project verification goals and scheduled proof runs](https://github.com/Joncallim/Forge/issues/187) |
| Parent Epic | [#184 — Continuous verification and earned autonomy](https://github.com/Joncallim/Forge/issues/184) |
| Foundation | ADR 0013 registry; ADR 0011 Operation Catalog; ADR 0010 canonical outcomes; ADR 0012 reliability ledger |
| Downstream | #188 independent verification; #189 earned autonomy; #190 Project Sentinel; #191 reporting |
| Review audit | `docs/architecture/issue-187-review-*.md` |
| Scope | Complete #187 architecture: executable goal definitions, execution authority, manual proof runs, evidence/history, reliability integration, bounded scheduling, migration/recovery/release boundaries |

---

## 1. Outcome

Forge already knows which repository-backed verification-goal definitions were explicitly imported and which complete registry revision is authoritative. It cannot safely run those definitions yet.

Issue #187 is complete only when Forge can:

1. prove the live repository goal registry still matches the explicitly imported authoritative registry;
2. select only explicitly reviewed deterministic Operation Catalog entries;
3. resolve operator/system execution ceilings without letting repository text grant authority;
4. create a first-class **verification goal run**, never a synthetic implementation task;
5. bind decisive proof to one supported repository profile, one strict Git-clean commit identity, one trusted root lease, one trusted executable set and one execution-environment fingerprint;
6. execute the exact bound operations in canonical ordinal order under PostgreSQL-owned lease fencing;
7. classify functional proof failure separately from authority, policy, infrastructure, evidence, cancellation and recovery uncertainty;
8. emit child operation outcomes plus one overall #185-compatible canonical goal outcome;
9. calculate evidence-backed last-green / first-observed-failure history without hiding nondeterminism;
10. feed comparable child-operation evidence into #186 without sample inflation;
11. support manual runs first, then a bounded DB-time scheduler;
12. preserve human/project authority and fail closed on every unknown version, stale binding, unsupported repository state or missing evidence.

The first executable version is deliberately narrow: **Git-metadata/read proof only**. It does not run repository scripts, package managers, tests, builds, arbitrary commands or models. Broader proof operations require new reviewed Operation Catalog entries and execution profiles.

It does not edit code, repair failures, create branches or PRs, merge, deploy, issue live MCP handles or modify autonomy.

---

## 2. Existing contracts that must not be weakened

- ADR 0013 / PRs #328–#330 are definition-only. A stored goal snapshot or registry head is not execution authority and never means a goal passed.
- Goal schema v1 remains definition-only forever.
- Current Operation Catalog execution is task-owned and uses task/work-package filesystem authority. A proof run must not fabricate those identities.
- Current `execution_outcomes`, `operation_runs`, repository command audits and reliability v1 are task-owned.
- Existing task/outcome/reliability history keeps its original meaning after migration.
- Existing project filesystem decision + current pointer is the durable project-level filesystem authority. Do not invent a second project grant mode.
- Current root binding captures `(path, dev, ino)` but closes the handle. That is not a sufficient executable trust boundary.
- PostgreSQL is business truth. Redis is delivery/wake-up only.
- Git repository configuration/metadata is not assumed safe merely because the requested Git command sounds read-only.

---

## 3. Non-negotiable invariants

| ID | Invariant |
|---|---|
| I1 | Goal runs are never synthetic tasks/work packages/agent runs/task attempts. |
| I2 | Schema-v1 goal snapshots can never execute. |
| I3 | Every run binds an exact current registry revision+entry+snapshot+execution binding and exact project policy revision through real foreign keys. |
| I4 | Live repository goal manifest must equal explicitly imported current head before admission and around execution. |
| I5 | Repository configuration can only request or restrict work; it cannot widen permissions, rate, concurrency, deadline, evidence, verifier or autonomy. |
| I6 | Existing and new projects are default-disabled for manual and scheduled proof execution. Missing policy is deny. |
| I7 | Only exact code-owned goal-eligible Operation Catalog id/version pairs may execute. Absence means denied. |
| I8 | Initial eligible operations are zero-input, trusted-project, read-only, deterministic and bound to reviewed execution profiles. |
| I9 | Goal reads require the current approved project filesystem decision containing `filesystem.project.read`; package `allow_once` is never goal authority. |
| I10 | A run has durable PostgreSQL identity before Redis delivery. |
| I11 | One active run per project+logical goal across manual/scheduled triggers. |
| I12 | Queued, running, recovery and total-active capacities plus start rate are DB-bounded. |
| I13 | PostgreSQL lease generation/token is the sole business mutation fence. Redis claim ownership is not business authority. |
| I14 | Every goal-subject proof write is DB lease-fenced and becomes immutable after authoritative insertion/finalization. |
| I15 | Post-claim Git execution uses a retained TrustedProjectRootLease and root-anchored launcher; raw pathname `cwd` is forbidden. |
| I16 | Git and Node executable identities are resolved/pinned by Forge before entering a project; project PATH cannot select them. |
| I17 | Decisive pass/fail requires the closed supported repository profile, strict Git-clean state, exact commit/OID and environment/profile fingerprints. |
| I18 | Registry/project/root/grant/policy/catalog/eligibility/execution-profile/repository/build/executable drift cannot produce a stale pass/fail. |
| I19 | Operations are canonical sorted ordinals, sequential, bounded by one overall deadline; no workflow language/dataflow/parallelism. |
| I20 | Protected child-begin can start only the exact next stored operation; skipped/duplicate/extra operations are structurally impossible. |
| I21 | Exit zero/transport success is never enough; deterministic verifier + relational evidence are required. |
| I22 | A goal may fail only from an explicitly versioned operation failure classifier returning `functional`; generic process/nonzero errors are never functional. |
| I23 | Incomplete/uncertain child execution is never replayed or inferred within the same goal run. |
| I24 | Terminalizer validates the exact child prefix and atomically writes overall outcome, evidence digest/unit, final event and terminal run state. |
| I25 | Overall goal outcomes never become capability-reliability samples; exact child outcomes only. |
| I26 | Repeating the same evidence unit cannot manufacture independent #186 sample count; conflicting repeats make evidence unstable. |
| I27 | Scheduler scans only the exact current protected schedule binding head, uses DB-time slots, no catch-up stampede, and all project budgets still apply. |
| I28 | Failure produces evidence only; never repair/autonomy/GitHub/grant/model action. |
| I29 | Unknown schema/contract/policy/manifest/eligibility/execution-profile/Git-safety/launcher version fails closed. |
| I30 | Public API/Redis/reliability records never copy local paths, raw Git config, dirty paths, raw command output, credentials or lease tokens. |

---

## 4. Version inventory

```text
Goal definition                           v1 definition-only; v2 executable declaration
Registry manifest                         v1 existing; v2 membership+execution binding
Registry execution binding                v1
Project verification policy               v1
Resolved run policy                       v1
Goal run / events                         v1
Repository profile / identity evidence    v1
Git safety profile                        v1
Trusted executable registry               v1
Trusted root command launcher             v1
Execution environment evidence            v1
Goal evidence-set descriptor              v1
Goal aggregate evidence unit              v1
Canonical execution outcome               v1 existing task; v2 goal failure classification
Capability reliability                    v1 task; v2 goal subject/environment/evidence unit
Goal operation eligibility                v1 code-owned allowlist
Goal operation execution profile          v1
Redis goal envelope                       v1
Scheduler binding/head/slot               v1
```

Any semantic change bumps the owning version/digest. Unknown versions do not fall back.

---

## 5. Goal definition v2

```ts
type VerificationGoalEvidenceRequirement =
  | 'repository_identity'
  | 'execution_environment'
  | 'canonical_operation_outcomes'
  | 'operation_evidence'

type VerificationGoalScheduleDeclaration =
  | null
  | { kind: 'interval'; everySeconds: number }

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

Forbidden repository-controlled fields:

- command, shell, argv, operation inputs;
- cwd/path/environment;
- adapter/tool/MCP/server/executable;
- credentials/secrets;
- model/provider/verifier/prompt;
- callback/webhook;
- cron expression;
- operation dependencies, interpolation or piping;
- autonomy/repair action.

Unknown keys fail import.

Severity is reporting/escalation metadata only. It never reduces risk or increases permission.

`requiredEvidence` is additive only. Base proof evidence remains unconditional.

`verification_goal_snapshots` gains `definition_schema_version` and exact DB constraints for closed v1 OR closed v2 shapes. Existing v1 rows remain unchanged.

Every executable v2 source file must later be proven tracked at the exact decisive HEAD; definition-only v1 imports may remain untracked because they authorize no execution.

---

## 6. Code-owned operation eligibility

Keep eligibility separate from historical OperationDefinition digests:

```ts
const VERIFICATION_GOAL_OPERATION_ELIGIBILITY_VERSION = 1 as const

type Eligibility = 'not_allowed'|'manual_only'|'manual_and_scheduled'

type GoalOperationEligibilityTable = ReadonlyMap<
  `${string}@${number}`,
  Eligibility
>
```

Rules:

- absent -> `not_allowed`;
- exact operation id/version only;
- v1 additionally requires zero inputs, `trusted_project`, `read_only`, reviewed read-only recovery, supported deterministic verifier and no unsupported human/independent verifier;
- schedule requires every operation `manual_and_scheduled`;
- independent verifier required before #188 -> blocked;
- eligibility version/digest participates in registry binding and run environment.

This is a code-level security allowlist, not DB/operator configuration.

---

## 7. Goal operation execution profile

Logical OperationDefinition is not sufficient because fixed argv, safety preamble, verifier semantics and failure classification live in code.

Each eligible operation has exactly one profile:

```ts
type GoalOperationFailureDisposition =
  | 'functional'
  | 'policy'
  | 'authority'
  | 'infrastructure'
  | 'evidence'
  | 'cancelled'

type GoalOperationExecutionProfileV1 = {
  schemaVersion: 1
  operationId: string
  operationVersion: number
  adapterContractVersion: number
  commandTemplateDigest: string
  gitSafetyProfileVersion: number
  gitSafetyProfileDigest: string
  deterministicVerifierContractVersion: number
  deterministicVerifierDigest: string
  failureClassifierContractVersion: number
  failureClassifierDigest: string
  rootLauncherContractVersion: number
  trustedExecutableContractVersion: number
}
```

The profile digest is part of registry execution binding. Any change to fixed command template, Git hardening, verifier, failure classifier, launcher or executable contract requires a changed profile digest and explicit registry re-import before execution resumes.

Failure-classification rule:

- process launch failure -> infrastructure;
- deadline/abort/lease loss -> cancelled/infrastructure;
- policy/authority/root/registry drift -> policy/authority/evidence;
- missing/invalid relational evidence -> evidence;
- generic nonzero/unknown adapter error -> infrastructure or evidence, **never functional**;
- `functional` is allowed only when the profile's deterministic versioned classifier can distinguish a semantic project failure from execution failure.

Initial repository-read operations should be conservative: if there is no deterministic functional-negative classifier, command failure is inconclusive rather than a project regression.

Source-contract tests enumerate every eligible operation and require exactly one profile.

---

## 8. Registry execution binding and manifest v2

Repository snapshot is source configuration. Forge execution policy can change independently.

```ts
type VerificationGoalOperationBindingV1 = {
  operationId: string
  operationVersion: number
  definitionDigest: string
  capability: string
  eligibility: 'manual_only'|'manual_and_scheduled'
  executionProfileDigest: string
}

type VerificationGoalExecutionBindingV1 = {
  schemaVersion: 1
  eligibilityPolicyVersion: 1
  eligibilityPolicyDigest: string
  operations: VerificationGoalOperationBindingV1[]
}
```

Canonical binding -> `execution_binding_digest`.

Registry entry adds binding contract version + nullable binding/digest:

- v1 definition entry -> null execution binding;
- v2 executable entry -> required binding.

A repository definition does **not** need a fake definition-version bump merely because Forge changes its execution profile. The same immutable snapshot may appear in a later registry revision with a new Forge binding after explicit import.

Registry revision adds `manifest_schema_version default 1`:

- manifest v1 remains byte-compatible for historical revisions;
- any executable entry requires manifest v2;
- v2 membership identity includes goal/version/definition digest/source path/entry contract/execution binding digest in canonical order.

Protected registry routine recomputes the declared manifest version. Import response exposes manifest version/digest.

---

## 9. Live registry attestation

Explicit import is activation. Forge never auto-imports on execution.

Read-only live attestation reuses the hardened no-follow bounded registry reader and returns only canonical manifest identity + captured project authority.

Admission:

1. authenticate owner and capture project authority;
2. live-attest registry outside long DB locks;
3. canonical transaction locks project -> filesystem authority -> registry head/revision/entry -> verification policy -> capacity/budget rows;
4. recheck owner/archive/root/path revisions and require attested manifest exactly equals current imported head;
5. create queued run only if all checks pass.

Filesystem may change after admission; therefore worker re-attests again before any proof is trusted.

Post-claim live attestation first proves the current project pathname still corresponds to the live TrustedProjectRootLease `(dev, ino)`, then uses the registry's directory/file-handle reader. Re-attest before first child, before every child and before terminalization.

Mismatch -> inconclusive/stale; never auto-import.

---

## 10. Registry-to-current project authority

Current project must still equal the registry import authority tuple:

```text
submitted_by / owner
archived_at == null
local_path identity
root_ref
root_binding_revision
grant_decision_revision
project updated revision
```

Any mismatch -> `registry_authority_stale`; explicit re-import required.

Any v1 registry-head revision change while a run is queued/running invalidates that run for decisive proof.

---

## 11. Project verification policy

Immutable protected revisions + one protected current head:

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
- max_queue_age_seconds
- max_operations_per_run
- max_concurrent_runs
- max_queued_runs
- max_active_runs
- start_budget_window_seconds
- max_starts_per_window
- actor_kind: migration_seed | system_default | human
- actor_user_id nullable only by closed actor shape
- predecessor_revision_id
- created_at

verification_goal_policy_heads
- project_id
- policy_revision_id
- revision_sequence
- updated_at
```

Protected fixed-search-path writer:

- locks project/head;
- verifies owner + expected head CAS;
- validates all bounded values;
- appends one immutable revision and advances head atomically;
- ordinary app cannot direct UPDATE/DELETE/head movement;
- PUBLIC execute revoked;
- closed ACL and failure-safe migration-owner cleanup proven.

Existing and new projects get a valid disabled policy. Missing head is deny.

Recommended initial defaults:

```text
manual=false
scheduling=false
min schedule interval=3600s
max run deadline=600s
max queue age=300s
max operations=16
max running=2
max queued=8
max active=10
start budget window=3600s
max starts/window=20
```

One canonical seed definition drives migration and new-project initialization parity.

Capacity semantics:

- queued = `status=queued`;
- concurrent = running with unexpired DB lease;
- active = queued | running | recovery_required;
- completed/expired consume no active capacity;
- expired running is unresolved/active but not a compute slot; recovery transitions it to `recovery_required`;
- start budget counts new admitted rows in the rolling DB-time window; idempotent replay and rejected admission do not count.

Minimal project settings GET/PATCH may edit this policy; server derives actor and digest.

---

## 12. System limits and process availability

One code-owned protocol source:

```ts
const VERIFICATION_GOAL_SYSTEM_LIMITS_V1 = {
  businessLeaseMs: 30_000,
  leaseRenewTargetMs: 10_000,
  leaseLocalSafetyMarginMs: 5_000,
  recoveryQuiescenceGraceMs: 5_000,
  // named absolute parser/policy/scheduler/preflight ceilings
} as const
```

Runtime availability is:

```text
build capability
∩ process-start restrict-only emergency kill switch
∩ current project verification policy
∩ supported Git/root/executable profile
```

The process kill switch is read once at process start; changing it requires restart. Emergency stop kills/restarts the worker process. In-flight rows fail closed through lease/watchdog recovery. A future live DB global switch is separate security-reviewed work.

---

## 13. Project filesystem authority

`loadVerificationGoalFilesystemAuthority(projectId, goalCapability)` consumes the existing project filesystem current pointer + immutable decision.

Requirements:

- current decision exists and is `approved`;
- capability set contains `filesystem.project.read`;
- root/grant revisions match project, registry and run authority;
- no package identity is involved;
- package `allow_once` decisions are ignored and never consumed.

No new project `grant_mode` column is invented.

---

## 14. Trusted executable registry

Goal execution does not resolve Node or Git from the project cwd or an inherited arbitrary PATH.

Process-start reusable module concept:

```ts
type TrustedExecutableIdentityV1 = {
  kind: 'node'|'git'
  absoluteRealPath: string // internal only; never public evidence
  device: bigint
  inode: bigint
  contentDigest: string
  normalizedVersion: string
}
```

Rules:

- Node identity is based on the running trusted `process.execPath` / equivalent absolute runtime identity;
- Git is resolved to one absolute real file before entering any project;
- Git/Node executable must not reside inside Forge workspace, any registered project root, prompts/templates/runtime-writable project-controlled directory or other protected workspace path;
- capture stat identity + content digest/version once at process startup;
- re-stat identity before launch; mismatch disables goal execution;
- root shim launches absolute executable; no child PATH lookup;
- public evidence stores safe digest/version, never the local absolute path.

A privileged host adversary capable of replacing trusted system binaries/kernel state is outside this local-project threat model and remains explicit residual risk.

---

## 15. TrustedProjectRootLease

Evolve the existing canonical project-root binding primitive; do not fork workspace/path safety.

```ts
type TrustedProjectRootLease = Readonly<{
  path: string
  dev: bigint
  ino: bigint
  handle: OpaqueDirectoryHandle
  close(): Promise<void>
}>
```

Acquisition:

1. existing workspace/protected-project overlap validation;
2. canonical real path;
3. final `lstat` requires real non-symlink directory;
4. open `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`;
5. `fstat` and re-`lstat`/realpath exact match;
6. retain the handle for the entire goal business-worker lease.

The handle is never serialized or exposed. Close it in worker `finally` on success, local fence or recovery handoff.

Retaining the handle prevents expected inode reuse while the run lease is alive.

Existing task execution need not change behavior in the same #187 PR if that would alter its contract, but project canonicalization/binding primitives must remain shared.

---

## 16. Root-anchored command launcher

Raw `execFile(..., { cwd: projectPath })` is forbidden for post-claim goal commands.

Use a small code-owned Node shim from the trusted Forge build, never loaded from project disk. Start it with the trusted absolute Node identity and a minimal allowlist environment stripped of Node injection surfaces (`NODE_OPTIONS`, `NODE_PATH`, preload/module-search overrides).

Internal call contract is not model/repository controlled:

```text
project path
expected dev/ino
target executable kind = git
trusted absolute executable identity
fixed command template/argv
bounded timeout + abort metadata
```

Shim sequence:

1. open project path `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`;
2. `fstat` exact expected dev/ino from still-live parent root lease;
3. `process.chdir(projectPath)`;
4. immediately bigint-stat `.` and require exact expected dev/ino;
5. mismatch -> fixed `root_changed`; target is never started;
6. verify supported Git repository profile described below;
7. spawn the trusted absolute Git executable **without `cwd`**, inheriting the already-resolved current directory object;
8. use exact pinned safe environment/global options/fixed argv; no shell;
9. propagate abort/deadline; terminate and wait for Git; no orphan child;
10. return structured fixed status + bounded output.

Race closure:

- swap before shim open -> inode mismatch;
- swap between open and `chdir` -> `stat('.')` mismatch before Git starts;
- swap after `chdir`/stat -> cwd is already the authorized directory object;
- retained parent root handle prevents expected same-inode reuse.

Unsupported OS/primitive -> verification-goal execution unavailable. Initial support is only platforms proven by CI (macOS/Linux).

All post-claim goal Git commands use this boundary: repository/profile preflight, object format/HEAD, strict status/index checks, executable-goal tracked check, gitlink detection and eligible Operation Catalog adapters.

---

## 17. Goal Git safety profile

Git documents that repository config/attributes/filters can execute helpers and that partial clones may perform network demand-fetch. Safety therefore uses a positive versioned profile, not "read-only Git" intuition.

```ts
type GoalGitSafetyProfileV1 = {
  schemaVersion: 1
  supportedGitVersions: readonly GitVersionRange[]
  fixedGlobalOptionsDigest: string
  safeEnvironmentDigest: string
  localConfigPolicyDigest: string
  metadataLayoutPolicyDigest: string
  indexPolicyDigest: string
  objectStorePolicyDigest: string
}
```

Unknown/unvalidated Git version -> `git_version_unsupported`; execution unavailable.

Exact profile version/digest participates in operation execution profile, registry execution binding and run environment.

### 17.1 Safe Git environment

Build from scratch; do not inherit general process environment.

The reviewed profile fixes/removes at least:

```text
HOME / XDG_CONFIG_HOME -> Forge-owned empty non-project context
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
GIT_DIR unset
GIT_WORK_TREE unset
GIT_COMMON_DIR unset
GIT_OBJECT_DIRECTORY unset
GIT_ALTERNATE_OBJECT_DIRECTORIES unset
GIT_INDEX_FILE unset
GIT_NO_LAZY_FETCH=1
GIT_NO_REPLACE_OBJECTS=1
GIT_OPTIONAL_LOCKS=0
GIT_TERMINAL_PROMPT=0
GIT_ASKPASS / SSH_ASKPASS noninteractive deny
pager/editor/credential helper surfaces disabled
external/interactive diff disabled
core.fsmonitor=false
core.untrackedCache=false
core.ignorestat=false
```

Use exact pinned global options such as explicit `--git-dir=.git --work-tree=.` and command-specific safety flags. Fixed command-template digest covers those prefixes/`-c` overrides.

Committed attributes may be forced from exact HEAD using the reviewed `GIT_ATTR_SOURCE=HEAD` / equivalent profile. Local/global/system attribute sources outside the committed tree are not permitted as hidden execution inputs.

### 17.2 Local Git config inspection

`.git/config` must be a bounded real no-follow file under anchored `.git`.

Read it either as a bounded file through anchored handles or through one exact reviewed no-include config-reading command under the safe profile. Includes are detected as data but never followed.

Reject at minimum:

- `[include]`, `[includeIf ...]`, external include paths;
- worktree/object/index redirection;
- `filter.*` clean/smudge/process/required config;
- external diff/helper/process config not explicitly neutralized;
- external `core.attributesFile` / `core.excludesFile`;
- partial/promisor configuration;
- sparse-worktree configuration;
- any other execution-bearing key listed by the supported Git safety profile.

Raw config values/content are never persisted/logged. Only safe normalized reason codes/digests leave the preflight boundary.

Malformed/oversize/unsupported config -> `unsupported_git_config`.

### 17.3 Supported repository metadata layout

Decisive v1 supports only an ordinary non-bare standalone repository:

- `<root>/.git` is a direct real directory, not file/symlink;
- no linked-worktree gitdir indirection;
- `.git/commondir` absent;
- `.git/objects` and `.git/refs` are contained real directories under `.git`;
- `.git/config`, `.git/HEAD`, `.git/index` are real no-follow regular files;
- `packed-refs`, if present, is a contained real regular file;
- `.git/objects/info/alternates` absent/empty;
- `.git/info/grafts` absent/empty;
- `.git/info/attributes` absent/empty;
- no unsupported object/index redirection environment/config.

Unsupported layout -> `linked_worktree_unsupported` or `unsupported_git_metadata_layout`.

### 17.4 Object store / network profile

- partial/promisor clone is unsupported decisive v1;
- `GIT_NO_LAZY_FETCH=1` is always active;
- missing object with no-lazy-fetch -> `incomplete_object_store` inconclusive;
- object alternates unsupported;
- replacement refs disabled (`GIT_NO_REPLACE_OBJECTS=1`);
- grafts unsupported;
- no fetch/network/credential fallback.

### 17.5 Index profile

Ordinary `git status` can be unsound for special index modes. Before decisive execution:

- reject any assume-unchanged path;
- reject any skip-worktree path;
- reject sparse checkout/index state;
- reject split index;
- `core.ignorestat=false`;
- raw path names from index scans remain in memory only and are discarded;
- index/profile fingerprint is captured and rechecked around execution.

Closed unsupported codes include `sparse_checkout_unsupported` and `split_index_unsupported`.

### 17.6 Executable goal source tracking

Every executable v2 registry source file must be tracked by Git at the exact proven HEAD. Verify exact tracked membership through fixed plumbing without persisting source path lists beyond the already-bounded registry entry.

If an executable goal is untracked/ignored relative to HEAD -> `goal_definition_untracked`; no decisive proof.

---

## 18. Repository profile result

Hide all Round 8–10 Git complexity behind one reviewed module result so routes/adapters do not reimplement it:

```ts
type GoalRepositoryProfileV1 = {
  schemaVersion: 1
  supported: boolean
  reasonCode: GoalRepositoryProfileReasonCode | null
  objectFormat: 'sha1'|'sha256'|null
  metadataFingerprint: string|null
  indexFingerprint: string|null
  configFingerprint: string|null
  gitSafetyProfileVersion: number
  gitSafetyProfileDigest: string
}
```

The runner consumes this one profile result. Unknown reason/config state fails closed.

Repository snapshot evidence includes the profile fingerprints but never raw config/path data.

---

## 19. Canonical DB lock and capacity order

Required cross-subsystem order:

```text
project
-> current project filesystem decision/pointer
-> registry head/revision/entry
-> verification policy head/revision
-> schedule head/binding when scheduling
-> active/budget serialization rows
-> target goal run
-> child operation/evidence rows
```

Reconcile against existing registry/filesystem lock order before implementation. Filesystem/Git traversal happens outside long DB locks; DB state is then rechecked under the same canonical order.

Worker claim locks project/policy capacity serialization before counting live running leases and moving queued->running. Two workers cannot both consume the same final slot.

---

## 20. Resolved run policy

The runner never executes directly from repository JSON.

Store exact bounded `resolved_policy` v1 JSON and fingerprint on the run:

```text
project id
registry revision id/sequence/manifest digest
registry entry/snapshot/definition/execution-binding identities
project verification policy id/sequence/digest
trigger kind manual|scheduled
effective deadline / queue age / schedule interval
effective required evidence
system-limit version + execution availability
Git safety profile version/digest
trusted executable contract version
canonical operation ordinals 0..N-1 with exact
  id/version/definition digest/execution profile digest/eligibility/timeout
resolver contract version
```

Worker loads this immutable snapshot and only revalidates current authority. It never silently resolves a new policy for an existing run.

Any policy-head change in v1 invalidates queued/running decisive proof.

---

## 21. Goal run persistence and lifecycle

`verification_goal_runs` stores:

- project + exact composite registry-entry/snapshot binding;
- exact project policy binding;
- immutable resolved policy JSON/fingerprint;
- trigger kind and actor/idempotency or schedule slot binding;
- admission expiry;
- captured authority fingerprint;
- lifecycle state;
- result + terminal code only when completed;
- overall outcome id only when completed;
- goal evidence-set digest + goal evidence-unit fingerprint only when completed;
- lease generation/token/expiry only while running;
- started/finished/recovery timestamps;
- safe environment/repository evidence links through one-to-one child tables, not circular nullable ownership.

Lifecycle:

```text
queued
  started_at null
  result/outcome/evidence digests null
  lease null

running
  started_at set once
  current unexpired DB lease
  result/outcome null

recovery_required
  started_at set
  no live worker lease
  recovery_not_before set
  no inferred result

completed
  started_at + finished_at
  result = passed|failed|inconclusive
  overall outcome + evidence-set digest + goal evidence-unit
  no live lease

expired
  never started
  finished_at set
  result/outcome/evidence digests null
  terminal dispatch code = dispatch_expired
```

Partial unique active `(project_id, goal_id)` covers queued|running|recovery_required.

Manual idempotency partial unique `(requested_by_user_id, manual_idempotency_key)` and a stored request fingerprint over contract+actor+project+goal. Same key+same intent replays; same key+different intent -> 409.

Indexes: project/status/created, project+goal+finished, project+created start budget, status expiries/recovery, snapshot history.

---

## 22. Repository identity evidence

One immutable row per run, created after claim using the trusted root launcher/profile:

```text
project/root/grant/project revision snapshot
object format sha1|sha256
HEAD full OID
strict Git-clean=true
Git metadata/profile fingerprint
index fingerprint
config fingerprint
repository snapshot fingerprint
captured_at
```

Strict Git-clean for v1 means the hardened profile sees **zero normal porcelain status entries** with `--untracked-files=all`, while special index modes that can suppress checking have already been rejected.

Do not exclude Forge paths from cleanliness. Runtime artifacts must live outside the project or be normal repository-ignored operational data; executable goal definitions themselves must be tracked at exact HEAD.

SHA-1 requires 40 hex; SHA-256 requires 64. Unknown/unborn/bare/submodule/gitlink/unsupported profile -> inconclusive.

Raw dirty/index paths are discarded in memory and never copied to run evidence.

Revalidate profile+HEAD+clean state before and after every child and before terminalization.

---

## 23. Execution environment evidence

One immutable row per run:

```text
schema/version
runner contract version
Forge build identity + release-state class
root launcher contract version/digest
trusted Node identity digest/version
trusted Git identity digest/version
Git safety profile version/digest
platform/architecture
operation execution-binding digest
eligibility version/digest
environment fingerprint
captured_at
```

No hostname, username, local path, environment dump, credentials, network metadata.

If trustworthy build identity is unavailable locally, use a distinct `unavailable_local` environment class/fingerprint; never silently combine it with release evidence.

---

## 24. Shared execution-subject migration

Do not create a second competing outcome/operation/audit system.

Generalize shared ledgers with a closed subject shape:

```ts
type ExecutionSubject =
  | { kind:'task'; taskId:string }
  | { kind:'verification_goal_run'; verificationGoalRunId:string }
```

Database uses real FKs + exclusive CHECK constraints, not a free polymorphic UUID.

### `execution_outcomes`

- existing task rows remain schema v1 and task FK non-null by v1 subject shape;
- goal rows use outcome contract v2, goal run FK non-null, all task/package/agent/task-attempt FKs null;
- task unique `(task_id, attempt_key)` preserved;
- goal unique `(verification_goal_run_id, attempt_key)` added;
- goal outcome rows append-once/immutable.

### `operation_runs`

- task rows preserve task semantics;
- goal rows require goal-run FK + `goal_operation_ordinal`;
- task-only links are null for goal rows;
- partial unique `(verification_goal_run_id, goal_operation_ordinal)`;
- partial unique goal idempotency key;
- current task phase graph preserved.

### repository command audits

- exclusive subject shape;
- goal audit requires exact `operation_run_id` belonging to the same goal run;
- goal audit immutable after insert;
- raw cwd/argv remain protected internal evidence only; public surfaces expose IDs/fingerprints.

### `capability_attempts`

- task v1 preserved;
- goal reliability contract v2 allows goal-run FK and null task-only links;
- child operation outcome only; overall goal outcome excluded.

No goal row may land until all deployed readers/writers understand the dual subject model.

---

## 25. Canonical outcome v2 and functional-failure boundary

Goal-owned outcomes extend #185 with closed `failureClass`:

```text
functional
policy
authority
infrastructure
evidence
cancelled
```

Closed child mapping:

- verified successful child -> completed, no failure class;
- deterministic versioned functional-negative -> failed + `functional`;
- deterministic verifier failure classified by the pinned verifier/classifier -> functional only when the classifier explicitly says so;
- policy denial -> blocked + `policy`;
- root/project/grant/registry/catalog drift -> blocked/needs_attention + `authority|evidence`;
- process launch/nonzero generic/unsupported/missing executable/object store -> needs_attention + `infrastructure|evidence`;
- timeout/lease loss/abort -> needs_attention + `cancelled|infrastructure`.

**No unknown/generic nonzero maps to functional.**

Goal terminal `failed` is reachable only from an exact child v2 functional failure.

All other non-pass conditions are inconclusive or recovery-required.

Closed run terminal codes include at least:

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
linked_worktree_unsupported
unsupported_git_metadata_layout
unsupported_git_config
partial_clone_unsupported
incomplete_object_store
sparse_checkout_unsupported
split_index_unsupported
grafts_unsupported
goal_definition_untracked
git_version_unsupported
git_executable_untrusted
submodule_repository_unsupported
unsupported_repository_identity
missing_required_evidence
operation_infrastructure_failed
operation_evidence_failed
execution_deadline_exceeded
lease_lost
system_execution_disabled
internal_infrastructure_error
dispatch_expired   // expired state only
```

DB/source-contract tests freeze every terminal-code -> lifecycle/result/failure-class mapping. No `unknown` fallback on goal proof.

---

## 26. Operation ordinals

Operations are a declarative set executed in canonical `(operationId, operationVersion)` order; the resolved run policy stores ordinal 0..N-1.

Protected child-begin receives only run id + lease identity + requested ordinal. It loads the stored resolved policy and derives the exact operation itself.

Before creating a child:

- run must be `running` with exact unexpired generation/token;
- ordinal in range;
- no existing row at same ordinal;
- every earlier ordinal exists and is terminal decisive pass;
- no later ordinal exists;
- current DB authority still matches stored binding;
- idempotency key is deterministically derived from run+ordinal+operation+definition+execution-binding/profile.

No child retry generation exists in v1.

PostgreSQL cannot prove live filesystem facts. The sequence is explicitly:

```text
runner live-attests root/registry/repository
-> protected DB child-begin enforces DB/ordinal state
-> root launcher anchors exact cwd and repository profile immediately before target start
-> execute fixed child
-> post-attest filesystem/repository
-> lease-fenced protected child evidence/finalize
```

---

## 27. Outer cancellation, business lease and watchdog

Extend shared operation executor with optional outer `AbortSignal`/deadline. Existing task callers remain unchanged when absent.

Goal child execution composes:

- operation timeout;
- overall run deadline;
- PostgreSQL business-lease watchdog;
- process shutdown/emergency disable.

Overall deadline begins at durable DB `started_at` and includes environment/profile/registry/repository preflight.

Lease parameters v1:

```text
DB lease = 30s
renew target = 10s
local monotonic safety fence <=25s since last confirmed lease
DB error never extends local authority
late renewal response cannot revive a fenced worker
```

After local fence:

- abort root shim/Git;
- no new child or proof write;
- DB-fenced writes fail anyway;
- close TrustedProjectRootLease in `finally`.

Root shim must terminate and wait for its fixed Git child; prohibited helper/filter configuration prevents untracked grandchildren in v1.

---

## 28. Lease-fenced immutable evidence

Protected routines/triggers verify exact run id + generation + token + `running` + unexpired lease before authoritative goal proof writes:

- child begin/event/finalize;
- command audit;
- goal event;
- repository/environment snapshot;
- child outcome/link;
- overall terminalization.

After authoritative creation/finalization, goal evidence is append-only/immutable at DB layer and ordinary app ACL cannot UPDATE/DELETE it.

Future human/verifier/autonomy interpretation appends separate adjudication/history; it never rewrites #187 deterministic proof.

---

## 29. Manual API

### POST `/api/projects/:projectId/verification-goals/:goalId/runs`

- authenticated current project owner;
- request body empty;
- UUID `Idempotency-Key` required;
- caller cannot provide repository path/ref, operation, arguments, deadline override, policy, actor, model or verifier.

Two-phase admission: live attestation then canonical locked DB recheck/capacity/budget/create queued row+expiry. Redis delivery occurs post-commit and is recoverable from PostgreSQL.

Expected fixed redacted denials cover invalid request/key, conflict, project hidden, registry stale, goal non-executable/disabled, binding/eligibility/profile changed, verifier unavailable, system disabled, manual disabled, filesystem authority missing, active/budget/queue limit, unsupported root/Git/executable profile.

### GET one run

Bounded authenticated safe response only:

- lifecycle/result/closed terminal code;
- safe commit object format/OID;
- safe environment/profile identity;
- duration/timestamps;
- child operation IDs/outcome IDs/evidence IDs;
- latest safe recovery state.

Never return local path, raw output/config, Redis details, lease token, DB internals or credentials.

---

## 30. Redis delivery and DB claim

Redis envelope contains only:

```text
schemaVersion
runId
occurrenceId
```

Reuse generic queue occurrence/claim/retry/dead-letter/recovery primitives instead of cloning queue logic.

Worker flow:

```text
receive Redis occurrence
-> canonical project capacity lock
-> acquire PostgreSQL goal business lease
-> only after durable lease claim, ACK Redis best-effort
-> business authority is now DB lease only
```

Duplicate delivery/ACK loss cannot acquire a second DB lease. DB uncertainty never assumes ownership or drops work.

Queued rows without a successful Redis delivery are redispatched by a bounded DB recovery sweep.

---

## 31. Runner

```text
queued
 -> Redis occurrence
 -> serialized DB lease claim
 -> ACK Redis best-effort
 -> acquire+retain TrustedProjectRootLease
 -> start overall deadline/watchdog
 -> capture trusted executable/environment identity
 -> revalidate system/project/registry live manifest/policy/filesystem/catalog/eligibility/execution profiles
 -> compute supported GoalRepositoryProfileV1 through root shim
 -> require every executable v2 goal source tracked at exact HEAD
 -> capture strict repo snapshot
 -> ordinal loop:
      confirm lease/deadline
      live + DB authority/profile/HEAD/clean recheck
      protected begin exact next stored operation
      root-anchored executor with inputs={} and fixed audit-only reason
      conservative failure classifier
      lease-fenced immutable child audit/outcome/evidence
      post-check profile/HEAD/clean/live registry
      stop at first non-pass; never create later ordinal
 -> final live/profile/DB checks
 -> protected prefix/evidence terminalizer
 -> overall outcome + evidence-set digest + goal evidence-unit + final event + completed row atomically
 -> close root lease finally
 -> post-commit best-effort child reliability-v2 ingest
```

No LLM/model/provider is invoked.

---

## 32. Valid child prefixes

```text
PASSED
  exact ordinals 0..N-1
  every child terminal decisive pass

FAILED
  exact ordinals 0..k
  0..k-1 decisive pass
  k explicit outcome-v2 functional fail
  no child >k

INCONCLUSIVE
  exact canonical prefix only
  no later child after first non-pass
  no functional-failure requirement

RECOVERY_REQUIRED
  uncertain/incomplete child remains preserved and is not inferred
```

No mutable "skipped" placeholder rows.

Terminalizer locks and validates the exact child set before completion.

---

## 33. Overall evidence descriptor

Protected terminalizer derives, never accepts from caller, a canonical descriptor containing:

- repository snapshot id/fingerprint/profile;
- environment snapshot id/fingerprint;
- ordered child ordinal/run/outcome/fingerprint/evidence links;
- result + terminal code.

Compute `goal_evidence_set_digest` over this concrete run.

Atomically:

1. verify run lease + current DB authority;
2. verify repository/environment rows belong exactly to run;
3. validate child prefix + relational evidence;
4. insert immutable overall outcome;
5. insert final event;
6. store result/code/evidence-set digest/goal evidence-unit;
7. clear lease and mark completed.

Idempotent replay returns existing terminal state only if exact digest matches.

Trust readers rederive/validate evidence set. Mismatch -> `evidence_drift`; decisive trust suppressed.

Expired queued runs have no outcome or evidence digest.

---

## 34. Recovery

No child replay or inferred success after lease loss.

Examples:

- crash before command audit -> no child evidence;
- command audit written but child finalization missing -> audit is not result;
- child finalized then worker dies -> parent v1 does not resume to next child;
- lost/uncertain lease -> parent recovery-required.

Recovery quarantine:

1. fence/advance generation so stale worker writes fail;
2. set `recovery_required`;
3. `recovery_not_before` >= last trusted lease horizon + maximum child timeout + fixed grace;
4. after horizon, verify no live lease / no newer authoritative child outcome / no new evidence;
5. protected recovery completes parent **inconclusive** while preserving existing child evidence;
6. if quiescence cannot be proven, remain recovery-required and operator-visible.

V1 has only read-only fixed Git operations. Any future side-effecting operation requires a different recovery contract.

---

## 35. Queue expiry

DB-time dispatcher expires an unstarted queued run after its stored queue-age bound:

```text
queued -> expired
started_at remains null
finished_at set
no result
no overall outcome
evidence digests null
terminal dispatch code = dispatch_expired
```

Expired rows never enter history/reliability evidence.

---

## 36. Goal events

Append-only gapless guarded event stream with closed phase/status/code and optional relational child/snapshot/evidence refs.

No prose, paths, config content or raw errors.

Worker-authored events are lease-fenced. Scheduler/recovery/system events use their own protected authority routines.

---

## 37. Goal aggregate history and evidence instability

```text
goal_evidence_unit_fingerprint = H(
  project id,
  goal snapshot/definition digest,
  registry execution binding digest,
  repository snapshot fingerprint including strict OID + Git metadata/profile,
  resolved policy fingerprint,
  execution environment fingerprint
)
```

`goal_evidence_set_digest` identifies one concrete run's exact rows.

`goal_evidence_unit_fingerprint` identifies materially equivalent proof conditions across repeated runs.

Only completed decisive pass/fail with validated evidence participate in decisive history.

If one identical goal evidence unit has both pass and fail observations -> `currentEvidenceState='unstable'`. A later pass on the same unit does not silently resolve trust.

History/read model reports separately:

```text
latestObservationResult
latestObservationAt
lastDecisiveResult
lastDecisiveAt
lastGreen observation
firstObservedFailingCommit observation
decisive-only consecutive pass/fail streaks
evidence freshness/age
currentEvidenceState = stable | unstable | unavailable
```

Inconclusive observations do not become pass/fail streak members, but they remain visible as the latest observation and current-health consumers must not infer health from streak alone.

"First observed failing commit" is observation history, not proof of the causal first bad commit.

---

## 38. Capability reliability v2

Only child operation outcomes ingest. Overall goal outcome is excluded.

Goal reliability rows:

- contract version 2;
- goal-run FK, task links null;
- exact operation capability key;
- outcome-v2 digest/failure class;
- environment fingerprint;
- resolved goal policy/binding fingerprints;
- `evidence_unit_fingerprint`.

Child evidence unit:

```text
H(project, goal execution binding, exact operation profile,
  strict repository snapshot, resolved policy, environment)
```

Store every observation for audit, but metrics expose raw observation count and unique promotion-grade evidence-unit count separately.

Repeated same evidence unit counts once for sample independence. Conflicting outcomes on same unit -> reliability instability and no promotion-grade evidence.

Do not ingest:

- overall goal outcome;
- inconclusive/uncertain/nonterminal child;
- expired run;
- drifted evidence;
- recovery-required run.

Reliability ingest is post-commit best-effort and can never change the proof result.

---

## 39. Scheduling model

Scheduling is delivered only after manual execution is proven.

Use three DB surfaces:

```text
verification_goal_schedule_bindings   -- immutable exact config/authority binding
verification_goal_schedule_heads      -- one protected current project+goal pointer, nullable/disabled
verification_goal_schedule_slots      -- append-only per binding+sequence observation
```

### Binding

Protected reconciliation under project-first lock constructs a binding from:

- exact current executable registry revision/entry/snapshot/execution binding;
- exact current project verification policy revision;
- exact interval declaration;
- eligibility/execution profile digests.

Binding stores DB-time `anchor_at`, interval and fingerprint.

Protected CAS advances current head to exact binding. Concurrent reconciliation has one winner and exact binding replay is idempotent.

If goal/schedule is disabled, removed, stale or current policy changes, the head becomes explicit disabled/no-binding until matching reconciliation succeeds. Historical bindings remain immutable evidence but are not scanned.

Only the binding named by the current head may produce a slot.

### Slot

```text
slot_sequence = floor((db_now - anchor_at) / interval)
unique(binding_id, slot_sequence)
```

Scheduler considers only the current due slot; no historical catch-up backlog.

Slot transaction rechecks current schedule head + registry + policy + system availability + filesystem authority + project budgets before creating a queued run.

No HEAD/OID in slot identity because commit is captured by worker later.

One active project+goal still prevents overlap. Same commit may be observed in later operational slots, but same evidence unit does not create a second independent reliability sample.

Scanner uses bounded batch/cursor and a minimum scan cadence. Missed downtime does not stampede.

---

## 40. Downstream contracts

### #188 Independent Verification Workforce

- #187 deterministic result is immutable;
- #188 adds separate verifier run/history/adjudication;
- it never rewrites #187 proof;
- repository v2 cannot select model/provider/verifier;
- any goal requiring independent verification is blocked until #188 producer exists.

### #189 Earned autonomy

- consumes only validated stable evidence/reliability;
- repository schema contains no autonomy action;
- inconclusive, drifted or unstable evidence cannot promote.

### #190 Project Sentinel

#187 emits deterministic evidence primitives only:

- stable regression candidate: prior stable pass -> new stable fail under comparable supported evidence;
- evidence instability signal;
- not a Sentinel finding and never an automatic repair.

### #191 Reporting

#187 provides only bounded run/policy/history read contracts required for operation. Full filtering/export/dashboard belongs to #191.

---

## 41. Rolling delivery order

0. **Registry v2/binding/live attestation** — execution remains unavailable.
1. **Protected default-disabled policy API/settings** — execution remains unavailable.
2. **Shared-ledger expansion** — exclusive task/goal subject/version/ordinal, dual readers; no goal rows yet.
3. **Goal run/evidence + protected lease/ordinal/immutability/outcome-v2** — execution remains unavailable.
4. **Task compatibility cutover** — backfill subject/version fields; install exclusive constraints only after all readers/writers support them.
5. **Trusted execution substrate** — TrustedExecutableRegistry, TrustedProjectRootLease, root launcher, Git safety/repository profile, outer deadline, goal filesystem authority, queue/lease/watchdog/ordinal runner, POST/GET. Hosted proofs must pass before manual build capability exists. Projects still default disabled.
6. **Manual execution release** — operator may opt a project into manual proofs.
7. **Aggregate history + reliability v2**.
8. **Protected schedule bindings/heads/slots + scheduler proof**.
9. **Scheduling build capability** — only after scheduler multi-worker/outage/budget evidence passes; project still requires explicit scheduling opt-in.

No goal-subject row enters a shared table before all deployed consumers understand it.

---

## 42. Migration and ACL proof

Every DB slice requires:

- Drizzle journal/current-tip parity;
- fresh installer-managed migration;
- populated upgrade from existing latest;
- legacy repair path where applicable;
- protected-owner bootstrap/handoff failure cleanup;
- fixed search path on protected routines;
- immediate PUBLIC revoke;
- closed ordinary-app ACL inventory;
- no interval where legacy task referential integrity is weakened;
- invalid subject/project/registry/policy/ordinal shapes rejected by PostgreSQL;
- crash/retry/idempotency proof;
- historical task/outcome/reliability meaning unchanged;
- goal evidence UPDATE/DELETE rejection under real PostgreSQL roles;
- schedule-head/binding/slot CAS/race proof.

---

## 43. Module boundaries

```text
web/lib/verification-goals/
  contracts.ts
  eligibility.ts
  execution-profiles.ts
  git-safety-profile.ts
  system-limits.ts
  policy-contracts.ts
  history.ts

web/lib/projects/
  local-path.ts                 # shared canonicalization/root binding primitives

web/worker/verification-goals/
  registry-attestation.ts
  admission.ts
  filesystem-authority.ts
  trusted-executables.ts
  root-command-launcher.ts
  repository-profile.ts
  repository-snapshot.ts
  environment-snapshot.ts
  ledger.ts
  runner.ts
  scheduler.ts

web/worker/operations/
  context.ts
  executor.ts                   # optional outer signal/deadline + subject adapter

web/worker/queue/
  generic occurrence/claim/retry/dead-letter primitives reused
```

Rules:

- pure contracts are DB-free;
- routes are thin;
- subject adapters isolate task vs goal execution;
- one Git safety/profile module; no duplicate route/worker allowlists;
- one root binding primitive; no forked workspace safety;
- queue payload identity-only;
- scheduler has no LLM;
- operator tunables DB-backed/versioned;
- code constants are only protocol/security invariants.

---

## 44. Agent-sized implementation slices

### Slice A — definition/registry activation

- v2 parser + DB exact v1/v2 constraints;
- operation eligibility + execution profiles + digests;
- manifest v2 + entry binding;
- live registry attestation;
- tests for semantic binding drift and explicit re-import.

### Slice B — protected execution authority/evidence schema

- project verification policy revisions/head;
- dual execution subjects across shared ledgers;
- verification goal run/events;
- outcome v2;
- lease/ordinal protected routines;
- goal evidence immutability;
- no execution.

### Slice C — trusted read-only execution substrate

- TrustedExecutableRegistry;
- retained root lease;
- root-anchored Node shim;
- GoalGitSafetyProfile + GoalRepositoryProfile;
- no-lazy-fetch/no-replace/index/config/metadata/tracked-goal checks;
- outer signal/deadline;
- goal filesystem authority;
- POST/GET;
- Redis delivery + DB lease/watchdog;
- ordinal child runner + overall terminalizer/evidence unit.

### Slice D — history/reliability

- safe current-health/history reader;
- aggregate stable/unstable evidence;
- reliability-v2 child evidence-unit semantics.

### Slice E — bounded scheduling

- schedule binding/head reconciliation;
- DB-time slots;
- multi-worker dedup;
- bounded scanner/outage semantics;
- project capacity/start-budget enforcement.

### Slice F — closure proof/docs

- E2E manual + scheduled paths;
- migration/ACL/Redis/lease/root race/Git adversarial/evidence drift tests;
- operator/developer documentation;
- exact acceptance mapping to #187.

No lower-tier implementer may absorb a later slice merely because a table/module is nearby.

---

## 45. #187 acceptance/deviation map

- repository-backed versioned goal: v1 preserved, executable v2 added;
- safe verifier/command policy: exact goal-eligible Operation Catalog entries + execution profiles; repository cannot author commands;
- timeout/resource bounds: project policy + code-level system ceiling + child timeout + overall deadline;
- manual first: yes;
- scheduling through controlled DB/Redis runtime: yes, after manual proof;
- structured pass/fail/inconclusive evidence: outcome v2 + relational child/overall evidence;
- repository commit/environment fingerprint: strict repo snapshot + environment profile;
- last known good / first observed failing state: evidence-validated history, not causal bisection;
- canonical outcomes #185: child + overall dual-subject v2;
- reliability #186: child-only v2, unique evidence units;
- overlapping schedule dedup: current binding head + unique slot + active goal constraint;
- disabled goals: no admission/slot;
- tests: parser/policy/injection/path/root/Git/subject/ordinal/dedup/history/redaction/ACL/recovery;
- failure does not repair code: hard non-goal;
- browser/Playwright lane remains separate and deferred;
- original example `failure.autonomyAction` intentionally **not** implemented in repository schema; #189 owns autonomy policy.

---

## 46. Verification matrix

### Definition / registry

- v1 import compatibility;
- exact v2 allowed/rejected keys;
- operation binding/profile digest;
- manifest v1/v2;
- code/eligibility/profile semantic drift requires re-import;
- live registry changed/removed/disabled/untracked goal.

### Root / executable / Git security

- root pathname swaps before shim open, between open/chdir and after chdir;
- retained-handle inode-reuse resistance;
- trusted Git/Node absolute executable identity; malicious project PATH cannot replace target;
- executable replacement after startup disables goal execution;
- linked worktree/commondir/alternates/grafts/partial clone rejected;
- no lazy fetch / no replace refs;
- include/includeIf/filter/process/diff/helper/credential/object/worktree redirect config fixtures;
- `.git/info/attributes` external override rejected;
- HOME/XDG/system/global config isolation;
- assume-unchanged/skip-worktree/sparse/split-index rejected;
- SHA-1 and SHA-256 fixtures;
- executable goal tracked at exact HEAD;
- submodule/gitlink unsupported;
- adversarial helper sentinel proves no repository helper process starts;
- unsupported Git version/profile fails closed;
- raw paths/config never leak.

### Policy / capacity / referential integrity

- default disabled/missing head;
- protected policy CAS/ACL;
- exact queued/running/recovery/active/start-budget semantics;
- concurrent claims serialize;
- exact entry/policy composite FKs;
- task/goal exclusive subject constraints;
- ordinal next-only and no later child after failure.

### Outcome / evidence

- every terminal code has frozen result/failure class;
- process/nonzero generic never functional;
- deterministic functional classifier mutation tests;
- pass/fail/inconclusive valid prefix closure;
- relational audit ownership;
- immutable goal evidence;
- evidence-set rederivation/drift;
- aggregate same-unit instability.

### Lease / queue / recovery

- duplicate Redis delivery;
- ACK loss;
- DB uncertainty;
- 25s local fence;
- late renewal cannot revive;
- stale token write denied;
- crash before/after audit/child finalize;
- root shim cancellation no orphan;
- quarantine horizon;
- queue expiry;
- DB redispatch.

### API / history / reliability

- auth + owner scope;
- empty request body;
- idempotency replay/conflict;
- all policy/system/filesystem/profile/budget/active denials;
- bounded safe GET;
- latest inconclusive visible separately from decisive streak;
- evidence freshness;
- same evidence unit repeated pass counts once for promotion;
- same-unit pass+fail -> unstable;
- overall outcome excluded from reliability.

### Scheduler

- protected current binding head;
- config change disables/supersedes old binding;
- interval anchor/slot math under DB time;
- two scheduler workers one slot winner;
- active goal overlap;
- queue/running/active/start budgets;
- stale registry/policy/profile;
- downtime current-slot-only/no backlog;
- bounded scanner;
- same commit later slot does not add independent trust sample.

### Rolling / migration

- dual consumers before subject cutover;
- no goal rows before compatible readers;
- populated upgrades;
- protected-owner failure cleanup;
- task history unchanged;
- manual build capability unavailable until root/Git/evidence proof passes;
- scheduler capability unavailable until multi-worker scheduler proof passes.

---

## 47. Release evidence

Implementation release requires, as applicable:

- normal lint/typecheck/unit/build;
- PR Contract;
- real PostgreSQL migration/ACL/ordinal/immutability/CAS proofs;
- real Redis duplicate/loss/recovery proofs;
- DB lease outage/watchdog tests;
- root pathname-swap tests around shim open/chdir;
- trusted executable PATH-replacement tests;
- Node injection-environment tests;
- malicious Git config/filter/include/credential/helper sentinel;
- partial clone/no-lazy-fetch and replace-ref fixtures;
- assume-unchanged/skip-worktree/sparse/split-index fixtures;
- SHA-1/SHA-256 repository fixtures;
- live registry drift;
- manual E2E;
- scheduler multi-worker/offline/budget tests;
- aggregate/child instability;
- evidence-drift and leakage sentinels;
- mutation tests proving classifiers/profile versions matter;
- independent Security/Adversarial review.

Architecture confidence is never substituted for executable evidence.

---

## 48. Explicit non-goals

- synthetic task proof;
- arbitrary shell/model-authored command;
- repository-supplied operation inputs;
- dirty/unsupported repository decisive proof;
- linked worktree/submodule/sparse/split-index/partial-clone support v1;
- side-effecting operations v1;
- package-manager/test/build commands v1;
- operation parallelism/workflow language;
- auto-repair;
- autonomy policy;
- Sentinel implementation;
- independent model/browser verifier;
- branch/commit/PR/merge;
- live MCP grants;
- broad host cron;
- deployment;
- full #191 dashboard/export.

---

## 49. Residual threat boundary

V1 is designed to defend against stale/malformed repository state, repository-controlled worktree content, local Git configuration that attempts to redirect/execute helpers, queue/worker duplication, stale workers, and ordinary concurrent local changes.

It is **not** a sandbox against a privileged host adversary that can replace the kernel, Forge process, trusted system executables or mutate process memory while proof is executing. That requires an OS-enforced confined execution environment outside this slice.

No architecture text may imply otherwise.

---

## 50. Post-amendment review rule

Fresh review must restart from the consolidated document and live repository, not merely confirm prior findings were copied.

Required axes:

- issue/contract/acceptance mapping;
- schema/version/FK/ordinal/migration/ACL;
- full manual API -> queue -> DB lease -> root/executable/Git profile -> child executor -> evidence -> history path;
- scheduler binding/head/slot path;
- crash/recovery/expiry;
- auth/authority/resource/leakage/stale-worker security;
- Git/root/config/object/index/executable containment;
- outcome functional-vs-infrastructure classification;
- immutable/drift/unstable evidence;
- #186 sample independence;
- #188–#191 compatibility;
- modularity/reuse/hardcoding;
- CI/release evidence.

Any material finding -> amend and restart fresh passes.

Acceptable final architecture wording is only:

> No blockers were found in the inspected architecture scope. This does not prove absence of defects; remaining implementation and platform uncertainty must still be validated through the release evidence above.
