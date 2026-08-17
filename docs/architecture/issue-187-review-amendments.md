# Issue #187 Architecture Review Amendments

This file records material findings discovered while reviewing `docs/architecture/issue-187-verification-goal-run-policy.md` against the live Forge repository. It is an audit trail for the architecture process, not a substitute for the primary design.

## Round 1 — cross-contract and hidden-boundary review

Status after amendment: **Prior findings addressed in the primary architecture. Fresh orthogonal review required.**

### R1-F1 — schema-v2 definitions would fail the current PostgreSQL snapshot constraint

Severity: Blocker

Angle: Contract / persistence / migration

Evidence: the current `verification_goal_snapshots.canonical_definition` check accepts the exact schema-v1 key set and `schemaVersion=1` only.

Resolution: primary architecture now requires a migration whose database constraint accepts a closed exact v1 OR exact v2 shape, retains existing v1 rows unchanged, and stores v2 import-time operation bindings.

### R1-F2 — a current registry head alone is not enough execution authority

Severity: Blocker

Angle: Authority / state

Evidence: authoritative registry revisions capture owner, archive state, local path, `rootRef`, root-binding revision, grant-decision revision, and project revision at import time. A project may change after import.

Resolution: run admission and execution must compare the full current project authority tuple to the bound registry revision. Any difference blocks/stops execution and requires re-import.

### R1-F3 — synthetic tasks would corrupt execution truth

Severity: Blocker

Angle: Data model / compatibility

Evidence: production operations, outcomes, command audits, and reliability attempts are task-owned today.

Resolution: `verification_goal_run` is a first-class execution subject. Shared ledgers gain exclusive real FKs for `task` vs `verification_goal_run`; a proof run may never manufacture task/work-package identities.

### R1-F4 — scheduled dedup originally depended on a commit that is not known before dispatch

Severity: High

Angle: Runtime flow / scheduling

Resolution: schedule identity is configuration/time based only. A DB-time schedule binding and unique slot are created before dispatch; the worker later captures the clean HEAD. HEAD is proof evidence, not pre-dispatch dedup input.

### R1-F5 — 40-hex Git commit assumption is not portable to SHA-256 repositories

Severity: High

Angle: Compatibility

Resolution: repository identity records `objectFormat: sha1|sha256` and validates 40/64 hex OIDs after fixed `git rev-parse --show-object-format` + `git rev-parse HEAD` reads.

### R1-F6 — policy and scheduler actor provenance was ambiguous

Severity: High

Angle: Audit / authorization

Resolution: policy revisions use closed actor kinds `system_default|migration_seed|human`; run requests use `human|scheduler_v1`, with database shape checks for when a real user id is required. Policy head mutation is protected and owner-authorized.

### R1-F7 — migration could accidentally turn on repository execution

Severity: Blocker

Angle: Security / compatibility

Resolution: existing and new projects receive a valid current policy with both manual and scheduling disabled. Missing policy fails closed. Operator explicitly opts in.

### R1-F8 — separate registry/snapshot ids did not structurally prove membership

Severity: Blocker

Angle: Referential integrity

Resolution: goal runs bind by composite FK to the exact registry revision entry/snapshot/goal/version/digest tuple and exact project policy revision tuple.

### R1-F9 — goal run lifecycle mixed admission blocks with proof failures

Severity: High

Angle: State machine

Resolution: lifecycle is `queued|running|recovery_required|completed`; only completed runs have `passed|failed|inconclusive`. Pre-admission denials do not create a false result. Only explicit functional operation/verification failure may produce `failed`.

### R1-F10 — incomplete child operation replay was unsafe

Severity: Blocker

Angle: Recovery

Evidence: the current Operation Catalog intentionally leaves a run nonterminal when an adapter does not settle after cancellation.

Resolution: no automatic replay of an incomplete child operation within the same goal run. Parent enters `recovery_required`; it may become inconclusive only after quiescence/fencing is proven, otherwise it remains operator-visible recovery-required evidence.

### R1-F11 — current outcome taxonomy cannot safely identify a decisive proof failure

Severity: Blocker

Angle: Outcome semantics / evidence

Evidence: current adapter/audit failures can collapse to a generic `unknown` operation outcome.

Resolution: goal-owned operations require a versioned canonical outcome extension with closed failure class (`functional|policy|authority|infrastructure|evidence|cancelled`). Generic/legacy unknown never counts as a decisive failed proof.

### R1-F12 — project concurrency limits alone did not bound many-goal schedule pressure

Severity: High

Angle: Scalability / abuse

Resolution: project DB policy adds `maxOperationsPerRun`, a project-wide start budget (`maxStartsPerWindow` / `startBudgetWindowSeconds`), queued/running ceilings, and schedule interval floor.

### R1-F13 — manual idempotency could replay an unrelated intent

Severity: High

Angle: API / idempotency

Resolution: manual UUID idempotency keys are bound to a stored actor+project+goal request fingerprint. Same key/same fingerprint replays; same key/different intent is a 409 conflict.

### R1-F14 — task work-package filesystem authority cannot be reused for goal runs

Severity: Blocker

Angle: Permission boundary

Resolution: architecture requires a dedicated project-level goal filesystem authority loader over current project decision state, requires `always_allow`, and refuses `allow_once`. No fake work-package metadata.

### R1-F15 — project policy is execution authority and cannot be ordinary mutable configuration

Severity: Blocker

Angle: Database security / ACL

Resolution: immutable policy revisions + protected current head + fixed-search-path protected mutation routine, no direct app UPDATE/DELETE/head movement, closed ACL and migration-owner cleanup proofs.

### R1-F16 — task-issued and proof-issued operation reliability could silently mix

Severity: High

Angle: Reliability comparability

Resolution: goal operation reliability fingerprints include execution subject kind plus goal policy/registry scope. No synthetic goal aggregate attempt.

### R1-F17 — independent verification could be confused with deterministic goal result

Severity: High

Angle: Downstream #188 compatibility

Resolution: #187 goal result remains immutable deterministic evidence; #188 later appends/links separate verification history. Required independent verification blocks execution until that producer exists. Human and Playwright lanes stay separate.

### R1-F18 — repository severity could be abused as a risk downgrade

Severity: High

Angle: Security policy

Resolution: severity is reporting/escalation metadata only and cannot change permissions, evidence, catalog risk, security gates, or autonomy.

### R1-F19 — #187 needed a minimal operator read path before #191

Severity: Medium

Angle: Operator UX

Resolution: architecture now requires an authenticated bounded GET endpoint for one goal run; #191 retains full dashboard/reporting scope.

### R1-F20 — new-project policy lifecycle was incomplete

Severity: High

Angle: Lifecycle / fail-closed defaults

Resolution: new projects atomically receive/ensure a disabled current verification policy through protected database-backed initialization; missing head never falls back to permissive code defaults.

### R1-F21 — evidence requirement semantics could be mistaken for removable base proof

Severity: High

Angle: Contract

Resolution: repository `requiredEvidence` is additive only; base evidence is unconditional and unsupported requested evidence fails import/admission.

### R1-F22 — clean-worktree check risked leaking file paths

Severity: High

Angle: Privacy / evidence

Resolution: dedicated repository snapshot helper reduces status bytes in memory to clean/dirty and persists only safe identity/fingerprint; raw dirty paths are not copied into goal-run evidence/Redis/API.

### R1-F23 — import-time operation semantics were not pinned

Severity: Blocker

Angle: Supply chain / contract drift

Resolution: schema-v2 snapshots store exact sorted Operation Catalog definition bindings/digest. Same id/version semantic drift blocks execution and conflicts on re-import rather than silently rebinding.

### R1-F24 — evidence UUID ownership was not relationally strong enough for decisive failure

Severity: Blocker

Angle: Evidence integrity

Resolution: Operation Catalog command evidence for initial adapters must link to the exact `operation_run_id` and exact execution subject. Goal terminalization validates subject/run ownership instead of accepting an arbitrary UUID-shaped reference.

### R1-F25 — no canonical multi-authority lock order was stated

Severity: High

Angle: Concurrency / deadlock

Resolution: primary architecture now defines a project-first lock sequence and requires reconciliation with existing registry/filesystem lock order before implementation. Controlled race tests must not use sleeps.

### R1-F26 — interval scheduling lacked a stable anchor and outage behavior

Severity: High

Angle: Scheduling / recovery

Resolution: DB-time immutable schedule bindings establish an anchor for a goal/policy configuration; append-only unique slot observations deduplicate workers, and missed intervals do not create a catch-up stampede.

### R1-F27 — #187 requirement/deviation mapping was implicit

Severity: Medium

Angle: Contract / maintainability

Resolution: primary architecture now maps #187 requirements explicitly and records deliberate deviations (`failure.autonomyAction` deferred to #189; “first observed failing commit” wording; browser verifier deferred/separated).

## Round 1 conclusion

Round 1 found architecture blockers and they have been incorporated into the primary design. This is **not** a no-blocker verdict. A fresh full orthogonal pass must now test the amended architecture for new contradictions or missing boundaries.
