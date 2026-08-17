# Issue #187 Architecture Review — Round 5

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **Material ordering/protocol findings found. Consolidation amendment required.**

## R5-F1 — child goal operations need a persisted canonical ordinal

Severity: Blocker

Angle: Execution ordering / database integrity

The resolved policy contains an ordered list, but `operation_runs` currently has no goal-operation ordinal. A goal-subject row with a valid operation id/version and goal FK would not by itself prove that the caller executed the correct next operation, did not skip an operation, or did not add an extra eligible operation.

Required amendment:

- add nullable `verification_goal_operation_ordinal` to `operation_runs`;
- task subject -> ordinal null;
- goal subject -> ordinal non-null, bounded `0 <= ordinal < resolvedPolicy.operations.length`;
- partial unique `(verification_goal_run_id, verification_goal_operation_ordinal)` for goal subjects;
- goal operation begin is a protected lease-authorized routine that checks the exact operation id/version/definition digest at that ordinal in the stored resolved policy;
- begin also proves every prior ordinal has a terminal passing child outcome and no later ordinal exists;
- idempotency key includes run id + ordinal + exact binding + attempt generation;
- caller cannot supply an arbitrary operation list.

## R5-F2 — fail-fast terminalization needs an exact child-prefix rule

Severity: Blocker

Angle: Evidence completeness

A failed goal intentionally does not execute operations after the first decisive functional failure. Therefore “every planned operation must have an outcome” is wrong for fail-fast execution.

Required amendment:

Terminal validation must enforce one of these exact shapes:

- pass: child ordinals `0..N-1` exist and all terminal-pass;
- failed: child ordinals `0..k` exist, `0..k-1` pass, ordinal `k` is decisive functional fail, no child ordinal `>k` exists;
- inconclusive: only a valid canonical prefix exists, with no child after the first non-passing/uncertain point; a nonterminal child is permitted only for the recovery path.

No explicit mutable “skipped” rows are necessary in v1; the resolved policy plus validated prefix explains why later operations did not run.

## R5-F3 — overall goal outcome evidence needs a deterministic evidence-set digest

Severity: High

Angle: Canonical outcome / evidence drift

UUID evidence refs alone do not identify the expected evidence set or detect later accidental linkage drift.

Required amendment:

- terminalizer constructs a canonical typed evidence descriptor from exact repository snapshot id+fingerprint, environment snapshot id+fingerprint, exact child operation run/outcome ids+fingerprints in ordinal order, and terminal result class;
- compute domain-separated `goal_evidence_set_digest`;
- persist it on the goal run and/or overall outcome linkage;
- overall outcome evidence refs are derived by the protected terminalizer only, never supplied by caller;
- readers/reliability/Sentinel can rederive/compare the evidence-set digest without trusting an arbitrary UUID array.

## R5-F4 — project start-budget semantics must be exact

Severity: High

Angle: Resource control / concurrency

Required amendment:

`max_starts_per_window` means **successful new run admissions**, not retries/idempotency replays and not worker starts.

Under the project policy-head lock, admission counts `verification_goal_runs` for the same project with `created_at >= transaction_timestamp() - start_budget_window_seconds`, using the project+created_at index. Every newly created manual/scheduled run consumes one unit regardless of later pass/fail/inconclusive/expiry. Idempotency replay consumes none.

## R5-F5 — global runtime availability source/transition semantics are underspecified

Severity: High

Angle: Release safety

A “global availability gate” must not imply a live dynamically mutable flag if the implementation cannot observe it.

Required amendment:

- code-owned build capability says whether manual/scheduled goal execution code is released in this build;
- process-start environment kill switches may only restrict it;
- changing an environment kill switch requires worker/web process restart;
- emergency stop kills/restarts the relevant process; DB lease expiry/watchdog makes in-flight work recover/inconclusive;
- running work is not promised to observe an external environment-file edit without process restart;
- build/gate contract version is persisted in resolved policy/environment evidence.

If a later live DB-backed system kill switch is desired, it is a separate reviewed extension.

## R5-F6 — run lease timing must be concrete enough for implementation and recovery

Severity: High

Angle: Protocol timing / lower-tier implementation

Required amendment: central `VERIFICATION_GOAL_SYSTEM_LIMITS_V1` contains protocol constants, initially:

- DB business lease duration: 30 seconds;
- renewal target: every 10 seconds;
- local monotonic safety margin: 5 seconds;
- local worker fence no later than 25 seconds after the most recent successful claim/renew response if a further renewal cannot be confirmed;
- read-only recovery quiescence grace: 5 seconds after the maximum bound child-operation timeout beyond the last trusted lease horizon.

These are code-level safety/protocol values, not operator-tunable project defaults, and are declared once/tested for parity.

## R5-F7 — repository/registry/environment preflights must themselves be deadline-bounded

Severity: High

Angle: Resource exhaustion

The overall deadline cannot start only at child operations while registry traversal, Git status, object-format checks, submodule detection, or environment inspection can take unbounded time.

Required amendment:

- overall run deadline starts when DB run enters `running`;
- every post-claim filesystem/Git/environment preflight receives the same outer abort/deadline;
- each helper also has a smaller fixed operation timeout and bounded output/file count;
- preflight timeout -> inconclusive infrastructure/timeout, never functional failure.

## R5-F8 — project filesystem authority should reuse the existing persistent project-decision model directly

Severity: High

Angle: Current-schema fit / avoiding redundant state

Current `project_filesystem_grant_decisions` represents the persistent project-level authorization and does not have the package-level `grantMode` column.

Required amendment:

For goal v1, require the current project filesystem decision pointer to resolve to an immutable **approved** decision whose canonical capability set contains `filesystem.project.read` and whose root/grant revisions equal the registry/run authority. That project-level decision is the durable always-allow authority.

Do not add a new project `grant_mode` field. Package-level `allow_once` approvals are simply not a goal-run authority source and are never consumed by the scheduler/runner.

## R5-F9 — execution-environment version discipline needs an explicit build identity component

Severity: High

Angle: Comparability / code drift

Contract-version discipline alone can be missed by a code change.

Required amendment:

Environment evidence includes a bounded Forge build identity when available (release commit/build digest supplied by installer/build pipeline) plus runner-contract/eligibility/binding versions. In unversioned local development where no trustworthy build identity exists, record a closed `buildIdentityState='unavailable_local'`; that evidence remains valid operationally but starts a distinct/requalification cohort and must not masquerade as a release build.

Do not hash arbitrary source files at runtime as an authority substitute.

## R5-F10 — live registry attestation and scheduler stale-state loops need bounded repetition

Severity: Medium

Angle: I/O pressure

Registry reads are already bounded by ADR 0013, but a stale registry can otherwise be re-attested every tight scheduler cycle.

Required amendment:

- scheduler has one named minimum scan cadence/system batch limit;
- a `registry_stale` slot/binding observation suppresses repeat run creation and repeated full attestation until the next bounded scheduler scan or registry-head/project authority change;
- manual endpoint remains explicit user action and uses existing authenticated API rate/abuse controls; it does not create a background retry loop.

## R5-F11 — environment/read-only command helper hardening should reuse current safe-env work rather than fork it

Severity: Medium

Angle: Modularity

The live repository already centralizes substantial Git environment hardening (`GIT_CONFIG_NOSYSTEM`, null global config, disabled fsmonitor/untracked cache/external diff/credentials/LFS filter, optional locks off, prompts/pager disabled).

Required amendment:

The goal-specific repository identity and eligible operation path should reuse/refactor that single safe Git environment builder and extend it only where needed. Do not create a second drifting list of Git safety variables.

## R5-F12 — no exact goal result may be terminalized without validating child ordinal closure

Severity: Blocker

Angle: Stale/corrupt evidence

The protected overall terminal routine must lock/read child operation rows in ordinal order and enforce R5-F2. An overall `passed` or `failed` cannot be written based only on application-provided child IDs/evidence refs.

## Round 5 conclusion

Round 5 found three new blockers around exact operation ordering and terminal evidence closure plus several protocol-precision gaps. Fold these into the primary design and perform a new independent review; no no-blocker verdict yet.
