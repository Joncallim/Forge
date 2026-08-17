# Issue #187 Architecture Review — Round 2

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **Material findings found. They must be folded into the consolidated architecture before a no-blocker pass.**

## R2-F1 — resolved run policy is described as immutable but not stored

Severity: Blocker

Angle: Persistence / replay

The primary run schema stores a policy fingerprint and immutable source references, but the runner section says the exact resolved policy is stored and reused. Recomputing later can drift when code-level system ceilings/resolution semantics change.

Required amendment:

- persist exact bounded `resolved_policy` schema-v1 JSON (or equivalent normalized columns) on the run;
- validate its exact database shape;
- persist resolver contract version;
- fingerprint the stored resolved policy;
- workers load that snapshot and only revalidate current authority/ceilings; they do not silently resolve a new policy for the same run.

## R2-F2 — Operation Catalog needs an explicit verification-goal eligibility allowlist

Severity: Blocker

Angle: Forward security / operation policy

A future zero-input catalog operation could otherwise become executable from a goal merely because it matches capability/schema checks. Adding an eligibility field to existing operation definitions would change their historical definition digests without a version bump.

Required amendment:

- add a separate code-owned security allowlist keyed by exact `operationId@version`;
- absence means `not_allowed`;
- closed values: `not_allowed | manual_only | manual_and_scheduled`;
- version/fingerprint this eligibility policy and bind it at v2 import/run admission;
- current reviewed read-only operations may be explicitly allowlisted;
- initial eligibility additionally requires `risk=read_only`, `scope=trusted_project`, zero inputs, no human approval requirement, and supported deterministic verification/recovery semantics;
- a scheduled goal cannot contain a `manual_only` operation.

This is a legitimate code-level security allowlist, not operator-editable configuration.

## R2-F3 — repository environment fingerprint required by #187 is missing

Severity: High

Angle: Contract / comparability

Issue #187 requires repository commit/environment fingerprint. Commit identity is designed; execution environment is not.

Required amendment:

Persist one bounded safe environment snapshot/fingerprint per run containing only server-controlled non-secret components such as:

- environment contract version;
- goal-runner contract version;
- platform;
- architecture;
- Node runtime version (or defined compatibility component);
- fixed Git version;
- operation bindings digest;
- verification-goal eligibility-policy version/digest.

Do not include hostname, local path, environment-variable dump, credentials, usernames, or arbitrary process metadata.

Current goal-history/reliability comparability must include the environment fingerprint or an explicitly versioned reduced derivative.

## R2-F4 — repeated proof of one identical commit can inflate earned-reliability evidence

Severity: Blocker

Angle: Reliability / earned autonomy

A human or schedule can legitimately run the same goal repeatedly. Treating every identical goal+operation+commit+policy+environment run as a new #186 sample would allow an unchanged repository to manufacture a large sample count and could later distort #189 autonomy decisions.

Required amendment:

- every goal-owned operation derives `evidence_unit_fingerprint` from project, goal snapshot/binding, exact operation, clean commit, goal policy fingerprint, and execution environment fingerprint;
- goal-run history still records every run;
- #186 goal-subject ingestion is idempotent/deduplicated by evidence unit for trust-sample purposes;
- repeated same-evidence-unit proof does not create another independent reliability sample;
- a new commit, material environment change, operation binding, or policy cohort can produce a new evidence unit.

This requires a reliability contract-version migration for goal subjects; do not overload the current v1 row semantics silently.

## R2-F5 — goal-owned reliability cannot fit the current contract-v1 database checks unchanged

Severity: Blocker

Angle: Schema compatibility

Current `capability_attempts` requires `task_id`, `contract_version=1`, the ADR 0010 v1 stop-reason set, and v1 deterministic-adapter runtime fingerprint semantics.

Required amendment:

- goal-owned attempts use an explicit reliability contract v2 (or a separately reviewed equivalent versioned extension);
- v1 task attempts stay valid/readable;
- v2 has exclusive goal subject FK, evidence-unit fingerprint, goal policy/subject provenance, and outcome-v2 compatibility;
- v2 deterministic runtime fingerprint includes the goal execution-environment fingerprint;
- readers/metrics understand both versions without backfilling historical evidence optimistically.

## R2-F6 — goal deadline/lease loss cannot currently cancel the shared executor

Severity: Blocker

Angle: Runtime / cancellation

The current Operation Catalog executor creates only its own per-operation timeout controller. A goal runner cannot pass an outer abort signal or overall run deadline. Therefore DB lease loss, policy/authority cancellation, or `maxRunDeadlineSeconds` cannot reliably stop an in-flight adapter.

Required amendment:

- extend the shared executor boundary with a caller-owned `AbortSignal` and outer deadline;
- effective adapter deadline is `min(operation timeout, remaining overall run deadline)`;
- external abort is composed with internal timeout;
- task behavior remains backwards compatible when no outer boundary is supplied;
- DB lease-loss watchdog aborts this signal;
- no new operation starts after the overall deadline;
- the goal runner's overall execution deadline starts when the DB run becomes `running`, not while queued.

## R2-F7 — queued runs can execute much later than the request intent

Severity: High

Angle: Recovery / stale dispatch

A DB-first run can remain queued through Redis/worker outage. Without an admission expiry, a manual “run now” request could execute much later against a substantially newer commit while registry/policy remained otherwise unchanged.

Required amendment:

- project policy adds bounded `max_queue_age_seconds`;
- run stores immutable `admission_expires_at` computed from database time;
- worker refuses to start an expired queued run and records/returns a non-decisive expiry disposition;
- scheduled slots also do not build delayed catch-up work after expiry.

The repository commit is still captured by the worker; the API does not perform untrusted pre-dispatch filesystem work.

## R2-F8 — all trigger kinds should share one active-run-per-goal v1 ceiling

Severity: High

Angle: Concurrency / resource pressure

The primary only states scheduled overlap prevention. Two manual requests with different idempotency keys could create concurrent runs for the same goal.

Required amendment:

- v1 admits at most one active (`queued|running|recovery_required`) run per project + current goal identity across manual and scheduled triggers;
- same idempotency replay returns existing run;
- different manual request while active gets fixed `goal_run_active` conflict;
- different goals may run concurrently up to project-wide ceiling.

## R2-F9 — run↔repository snapshot relationship must remain acyclic

Severity: High

Angle: Referential integrity

Avoid a circular mandatory FK where `verification_goal_runs.repository_snapshot_id` references a snapshot that also requires `run_id`.

Required amendment:

- repository snapshot owns unique `run_id -> verification_goal_runs` FK;
- run does not require a snapshot FK;
- query snapshot by run id;
- events may reference snapshot id after it exists.

The current Round-1-consolidated primary already follows this direction; preserve it in final consolidation.

## R2-F10 — run state machine must not contain contradictory queued terminal shapes

Severity: High

Angle: State machine

A completed run requires `started_at`, so a direct queued->completed path would contradict row checks.

Required amendment:

- pre-admission denial creates no run;
- every admitted proof worker moves queued->running before repository preflight;
- dirty/unavailable preflight then completes as inconclusive from running;
- no queued->completed transition in v1.

The current Round-1-consolidated primary already follows this direction; preserve it.

## R2-F11 — DB lease uncertainty needs a monotonic local stop deadline

Severity: Blocker

Angle: Failure / stale worker

During PostgreSQL outage a worker cannot confirm renewal or current authority. It must not continue indefinitely on the basis of a local wall clock.

Required amendment:

- every successful DB lease claim/renewal produces a bounded lease duration and local monotonic safety deadline;
- renewal uncertainty never extends that deadline;
- before the local deadline expires, retry is bounded;
- at deadline, abort in-flight executor boundary and stop all new work;
- after DB recovery only a current generation/token may write;
- late renewal success cannot revive a locally fenced worker after the safety deadline.

## R2-F12 — Redis and DB leases need one clear ownership hierarchy

Severity: High

Angle: Queue call path

Holding both Redis claim and DB business lease as co-authorities would create conflicting stale-owner semantics.

Required amendment:

- Redis occurrence is delivery only;
- once a worker durably acquires the PostgreSQL goal-run lease, it may acknowledge/release the Redis occurrence early;
- active business execution is authorized only by DB lease;
- Redis ack loss can cause duplicate delivery, but duplicate workers fail DB claim and safely discard/ack their duplicate occurrence;
- if DB is unavailable, do not discard the occurrence on an assumed claim;
- Redis outage after a valid DB lease does not grant/revoke business authority; DB lease/watchdog controls continuation.

## R2-F13 — operation crash points need explicit no-inference semantics

Severity: High

Angle: Recovery / evidence

Required amendment:

- crash after command before audit insert -> no functional inference;
- crash after audit insert before operation finalization -> audit alone cannot imply operation pass/fail;
- crash after child operation terminalization before next operation -> initial v1 does not resume the parent after worker lease loss; recovery closes parent inconclusive after proving quiescence/fencing;
- no reliability ingest from incomplete/uncertain child evidence.

This deliberately trades retry efficiency for a smaller trustworthy v1 state machine.

## R2-F14 — schedule scanning must be bounded, not a full unbounded database sweep

Severity: High

Angle: Scalability

Required amendment:

- internal scheduler loop uses bounded cursor/batch processing and database time;
- batch/scan limits live in one named runtime/system configuration source, not duplicated literals;
- slot uniqueness keeps multi-worker scans safe;
- no LLM call;
- no catch-up stampede.

## R2-F15 — schedule binding must include exact registry entry identity

Severity: High

Angle: Referential integrity

Required amendment:

Like runs, schedule bindings must reference the exact registry revision + entry + snapshot/goal tuple and exact policy revision, not independent loose ids.

## R2-F16 — future approval-required operations must fail closed

Severity: Blocker

Angle: Operation forward compatibility

Required amendment:

Verification-goal eligibility and run admission must block any operation whose current binding requires a human approval workflow that #187 does not provide. The runner cannot silently treat `approvalRequired=true` as false.

## R2-F17 — execution outcome v2 must be reflected in downstream reliability schema

Severity: Blocker

Angle: Cross-contract migration

New failure-class/stop-reason semantics cannot be written into current capability-attempt closed checks without a versioned reliability migration. Outcome-v2 and reliability-v2 sequencing must be explicit.

## R2-F18 — full #187 contract requires duration and environment evidence

Severity: Medium

Angle: Contract completeness

Duration may be derived deterministically from DB `started_at`/`completed_at`; the bounded GET/history read path must expose it. Environment fingerprint must be persisted as R2-F3.

## Round 2 conclusion

Round 2 still found blockers. The next consolidated architecture revision must incorporate these findings before the next fresh review. No no-blocker verdict is warranted yet.
