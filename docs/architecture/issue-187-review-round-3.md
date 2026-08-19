# Issue #187 Architecture Review — Round 3

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **Material cross-version/source-of-truth findings found. Consolidation required.**

## R3-F1 — import-time execution bindings belong to registry entries/revisions, not repository snapshots

Severity: Blocker

Angle: Source of truth / versioning

A goal snapshot is immutable evidence of repository configuration keyed by project + goal + repository `definitionVersion`. Code-owned Operation Catalog/eligibility policy may change while the repository file remains byte-identical. Storing the code-owned binding on the snapshot would either silently mutate repository evidence or force the repository author to bump `definitionVersion` for a Forge code-policy change.

Required amendment:

- keep `verification_goal_snapshots` as repository-definition truth;
- schema v2 snapshot records its definition schema version but not mutable code-owned execution semantics;
- add `execution_binding` + `execution_binding_digest` to immutable `verification_goal_registry_entries` for v2 entries;
- the binding includes exact Operation Catalog definition digests and exact verification-goal eligibility-policy version/digest;
- the complete registry revision manifest v2 includes each v2 entry's execution-binding digest;
- a later Forge code/eligibility change can re-import the unchanged snapshot into a new registry revision with a new binding, without rewriting the snapshot or requiring a repository definition-version bump;
- run binds to the exact entry/binding in its exact registry revision.

## R3-F2 — registry manifest semantics need an explicit version

Severity: Blocker

Angle: Backward compatibility / protected routine

The current manifest hashes definition identity/path only. Executable v2 registry authority must also bind code-owned execution semantics.

Required amendment:

- add `manifest_schema_version` to registry revisions (historical rows = 1);
- manifest v1 remains byte-compatible for existing definition-only registries;
- manifest v2 includes exact ordered membership plus nullable/exact execution-binding digest;
- any registry containing an executable v2 entry uses manifest v2;
- protected revision-construction routine recomputes/validates according to the declared manifest schema;
- transition identity/dedup remains version-domain-separated;
- import response contract is versioned/additive so clients can see the registry manifest schema.

## R3-F3 — last imported registry can become stale when repository goal files change

Severity: Blocker

Angle: Repository-as-config truth

Project/root/grant authority can remain unchanged while a clean repository commit edits/removes/disables `.forge/verification-goals/*.json`. If a scheduler runs only the last imported registry head, it can execute stale repository configuration indefinitely.

Required amendment:

- add a bounded read-only live-registry attestation using the same hardened directory-anchored/no-follow reader as import;
- attestation computes the current manifest schema/digest and execution bindings without mutating PostgreSQL;
- before manual/scheduled run admission, capture project/registry authority, attest live registry outside long DB locks, then enter the canonical admission transaction and recheck the captured authority/head;
- admitted live manifest must equal the current registry revision manifest exactly;
- mismatch returns/records `registry_content_stale` and instructs re-import; no automatic import/activation in v1;
- worker re-attests live registry before the first operation and before finalization (and may recheck before each operation) so a post-admission config edit cannot become a stale pass/fail.

This preserves explicit import as the activation step while keeping repository files the configuration truth.

## R3-F4 — a goal run itself needs a canonical #185-compatible outcome

Severity: Blocker

Angle: #187 acceptance / evidence model

Child operations have canonical outcomes, but issue #187 requires goal runs to emit canonical outcomes. A separate ad-hoc `passed|failed|inconclusive` row is not enough for downstream #190/#191 evidence.

Required amendment:

- terminal decisive/inconclusive goal runs write one overall canonical execution outcome anchored to `verification_goal_run` subject using a reserved final attempt key;
- `verification_goal_runs.execution_outcome_id` is null until terminalization then points to that overall outcome;
- overall outcome + final run event + run state/link are one atomic terminal transaction;
- child operation outcomes remain separate and are the only rows eligible for operation-capability reliability ingest;
- overall outcome evidence is validated from the exact repository snapshot + exact child operation/outcome set;
- #188 later appends independent verification/adjudication rather than rewriting the overall deterministic outcome.

## R3-F5 — live registry attestation must be part of execution drift checks

Severity: High

Angle: TOCTOU / runtime

A read-only pre-admission manifest comparison is only a point-in-time observation. Repository files can change after it.

Required amendment:

- worker re-attests manifest under the trusted root after DB claim and around operation/terminal boundaries;
- manifest mismatch yields inconclusive `registry_content_changed`, not functional failure;
- dirty repository state is independently checked and also prevents decisive evidence;
- no long-lived DB lock is held across filesystem traversal.

## R3-F6 — current registry entry schema can carry execution binding history safely

Severity: High

Angle: Data model

The existing registry entry is already immutable per registry revision and has exact snapshot/project/goal/version/digest FKs. That is the correct location for code-owned binding evidence.

Required amendment:

- extend entry with nullable binding fields under a schema-version shape check;
- v1 entry: binding null;
- executable v2 entry: binding non-null + bounded exact JSON + SHA-256;
- add a composite unique identity including the binding digest for run/schedule FKs where appropriate.

## R3-F7 — overall outcome and child outcome must not double-count reliability

Severity: Blocker

Angle: #186 integration

Required amendment:

- reliability ingestion for goal subjects is only from terminal child `operation_runs` with exact operation capability keys;
- the overall goal execution outcome never creates a capability attempt;
- the goal outcome is for project proof history/reporting/Sentinel/autonomy evidence references.

## R3-F8 — repeated same-commit observations need evidence-unit semantics, not destructive dedup

Severity: Blocker

Angle: Reliability integrity

Suppressing duplicate attempt rows entirely would hide nondeterminism: the same commit/environment might pass once and fail later. Counting every repeated run as independent promotion evidence allows sample inflation.

Required amendment:

- reliability v2 records every goal-owned operation observation;
- add `evidence_unit_fingerprint` (project + goal/binding + operation + clean commit + goal policy + environment);
- metrics expose all observation count and **unique evidence unit** count;
- promotion-grade sample count is based on unique evidence units, not raw repeated observations;
- conflicting decisive results inside one evidence unit produce an explicit evidence-instability/conflict state and cannot support autonomy promotion;
- scheduled/manual repetition of one unchanged commit can demonstrate operational history but cannot manufacture independent trust samples.

## R3-F9 — reliability contract v2 must version deterministic runtime semantics

Severity: High

Angle: #186 compatibility

Current deterministic runtime fingerprint is only `{adapterKind}` and `contract_version=1` is closed in PostgreSQL.

Required amendment:

- goal-subject reliability uses contract v2;
- deterministic runtime fingerprint v2 includes adapter kind + goal execution-environment fingerprint;
- policy fingerprint includes subject kind + exact goal policy/registry binding;
- v1 task rows/readers stay valid;
- no optimistic backfill of historical attempts.

## R3-F10 — overall run needs safe execution-environment evidence

Severity: High

Angle: #187 contract / comparability

Required amendment:

Add one append-only environment snapshot per started run containing only bounded non-secret server facts, e.g.:

```text
schemaVersion
runnerContractVersion
platform
arch
nodeRuntimeVersion (normalized contract)
gitVersion (normalized contract)
operationBindingsDigest
verificationGoalEligibilityPolicyVersion/digest
fingerprint
```

No hostname, environment dump, username, path, secret, or credential. Goal-history cohort includes the environment fingerprint; API exposes the fingerprint, not raw internals unless explicitly safe.

## R3-F11 — global runtime availability must remain a stricter ceiling than project policy

Severity: High

Angle: Release safety / rollback

Required amendment:

- centralized system runtime gates for manual goal execution and scheduling;
- unavailable/missing gate fails closed;
- gates can only disable capability; they never enable a project whose DB policy is disabled;
- Slice B keeps execution unavailable; Slice C release enables manual availability only after proof; Slice E separately enables scheduling availability;
- global gate state/version is included in resolved policy/environment evidence where semantically relevant.

## R3-F12 — current eligibility must cover approval-required and high-risk future operations

Severity: Blocker

Angle: Forward safety

Required amendment:

A separate code-owned `VERIFICATION_GOAL_OPERATION_ELIGIBILITY` security allowlist (default absent=not allowed) is versioned independently of OperationDefinition to preserve historical definition digests.

Initial eligibility requires:

- exact id/version allowlisted;
- zero inputs;
- `risk=read_only`;
- `scope=trusted_project`;
- no unsupported human approval requirement;
- supported deterministic verifier/recovery semantics;
- mode `manual_only` or `manual_and_scheduled`.

Schedule admission rejects any `manual_only` member.

## R3-F13 — overall run deadline must actually bound the sum of child operations

Severity: Blocker

Angle: Resource bound / runtime

Required amendment:

- run execution deadline starts at `started_at` using DB time;
- shared executor accepts outer abort signal/deadline;
- each child adapter gets `min(definition timeout, remaining run deadline)`;
- no next operation starts with expired/insufficient remaining deadline;
- lease heartbeat continues independently while adapter awaits;
- deadline exhaustion is inconclusive, never functional failure.

## R3-F14 — queued dispatch needs an explicit expiry state

Severity: High

Angle: Lifecycle

A max queue age requires a terminal non-proof state; forcing queued->completed would violate “started/completed proof” semantics.

Required amendment:

Use lifecycle such as:

```text
queued | running | recovery_required | completed | expired
```

- `expired`: never started, no proof result, no pass/fail history, terminal/ended timestamp;
- `completed`: started and has passed|failed|inconclusive;
- active-run unique constraint excludes completed/expired.

## R3-F15 — same goal should have one active run across all trigger kinds in v1

Severity: High

Angle: Concurrency / sample pressure

Required amendment:

Partial unique active constraint over project + logical goal identity for `queued|running|recovery_required`. A second distinct manual request gets fixed `goal_run_active`; different goals may run up to project ceiling.

## R3-F16 — goal-run evidence writes must themselves be lease-fenced

Severity: Blocker

Angle: Stale-worker evidence

It is insufficient to fence only the parent terminal row. A stale worker could otherwise append command audits or operation events after losing the goal lease.

Required amendment:

For goal subjects, begin/event/finalize operation ledger writes and command-audit evidence insertion validate the exact live goal-run lease generation/token (or a protected derived authorization) before mutation. A stale worker can neither create new authoritative evidence nor terminalize child/parent state.

## R3-F17 — initial read-only recovery can use a bounded quarantine horizon

Severity: High

Angle: Recovery liveness

`recovery_required` must not block the goal forever if the worker died after spawning a read-only child.

Required amendment:

- only operations explicitly eligible as read-only may participate in #187 v1;
- after lease loss, no stale evidence write is possible (R3-F16);
- protected recovery waits at least the maximum eligible operation timeout + abort/quiescence safety margin after the last valid lease;
- after that horizon and database fencing, an incomplete read-only child can leave historical nonterminal operation evidence while the parent safely closes **inconclusive**;
- no operation is replayed and no functional result is inferred;
- future side-effecting operations require a new recovery contract and are not covered by this rule.

## R3-F18 — run admission should be a two-phase authority + filesystem attestation, not hold DB locks during traversal

Severity: High

Angle: Concurrency / performance

Required amendment:

1. authenticate and capture project/root/registry authority;
2. read live registry/compute manifest through hardened bounded filesystem code outside long DB locks;
3. enter canonical transaction;
4. lock/recheck project, registry head, policy head, filesystem decision, budgets;
5. compare live manifest to the still-current head;
6. create run or fail.

Scheduler can cache one attestation only within the exact captured project/root authority for a bounded project batch; transaction recheck remains mandatory.

## Round 3 conclusion

Round 3 found additional blockers. A consolidated architecture must change binding ownership, registry manifest versioning/live attestation, overall canonical outcome, reliability evidence-unit semantics, global/runtime deadlines, and lease-fenced child evidence before another full pass can claim no material blockers.
