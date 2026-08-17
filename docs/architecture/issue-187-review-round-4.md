# Issue #187 Architecture Review — Round 4

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **Material runtime/security/release findings found. Consolidation required.**

## R4-F1 — current “read-only Git” adapters are not automatically safe from repository-configured helpers

Severity: Blocker

Angle: Security / command execution

`git status` and related index-refresh paths can consult repository configuration such as `core.fsmonitor`. Treating an adapter as read-only based only on its argv/risk label is insufficient if repository-local Git configuration can cause helper execution.

Required amendment:

Before an Operation Catalog entry can be marked verification-goal eligible:

- eligible Git invocations must explicitly disable repository-configured execution hooks/helpers relevant to the command, including `core.fsmonitor`;
- keep global/system config disabled as today;
- use a code-owned empty hooks path or equivalent fixed no-hook boundary where relevant;
- set `GIT_OPTIONAL_LOCKS=0` for proof reads where supported to avoid optional repository mutation;
- keep pager/prompts disabled;
- diff paths retain `--no-ext-diff --no-textconv` and equivalent hardening;
- add adversarial repo-config tests that attempt helper execution and prove no sentinel executes.

The verification-goal eligibility allowlist must be granted only **after** these proofs pass.

## R4-F2 — submodule containment/cleanliness is ambiguous for v1 proof identity

Severity: High

Angle: Filesystem containment / repository identity

A submodule worktree can have Git metadata or contents with independent roots. A naive `git status` can traverse it or produce cleanliness semantics the goal-run contract has not bounded.

Required amendment:

For v1, either implement a separately proven contained submodule identity contract or fail closed when the index contains gitlink mode `160000`.

Recommended v1 choice: fixed safe preflight detects any gitlink and returns inconclusive/unsupported `submodule_repository_unsupported`. Do not claim proof coverage for submodule contents. A later schema/runner version may add explicit submodule bindings.

## R4-F3 — run overall outcome must be atomic with terminal run state

Severity: Blocker

Angle: Canonical outcome / recovery

Required amendment:

- terminalization creates one overall canonical outcome-v2 for the goal run under a reserved final attempt key;
- validates repository/environment snapshots and exact child operation/outcome set first;
- writes overall outcome + final goal event + `verification_goal_runs.execution_outcome_id` + status/result/finished time in one transaction;
- response-loss replay returns the existing terminal state/outcome;
- a run cannot be `completed` without the linked overall outcome;
- expired queued runs are not completed proof runs and need no fabricated pass/fail outcome.

## R4-F4 — goal-level overall outcome must not feed capability reliability

Severity: Blocker

Angle: #186 double counting

Only operation-run-linked outcomes create operation capability attempts. The overall goal outcome is project-proof evidence for history/#190/#191/#189 references and is explicitly excluded from capability-attempt ingest.

## R4-F5 — queued-expiry state is needed for `maxQueueAge`

Severity: High

Angle: State machine

Final lifecycle:

```text
queued | running | recovery_required | completed | expired
```

- `expired` is terminal, never started, `result=null`, `finished_at!=null`, terminal code `dispatch_expired`;
- `completed` requires started_at + overall canonical outcome + result passed|failed|inconclusive;
- active partial uniqueness covers queued/running/recovery_required only.

## R4-F6 — active-run uniqueness should cover logical goal id across definition changes

Severity: High

Angle: Concurrency

Use project + `goal_id` partial uniqueness for active v1 runs, not only snapshot id. An unresolved old run for the same logical goal blocks a new definition of that goal until recovery/expiry completes. This is conservative and avoids two proof processes claiming the same project assertion concurrently.

## R4-F7 — goal evidence writes need database-enforced lease authorization, not helper convention alone

Severity: Blocker

Angle: Stale worker / database security

Required amendment:

Goal-subject writes to shared ledgers must be protected by fixed routines and/or database triggers that verify the live goal-run lease generation/token. Ordinary direct app SQL must not be able to insert/finalize a goal-subject operation/audit/outcome without that authorization.

Task-subject behavior remains backward compatible.

At minimum protect for goal subjects:

- operation-run begin/event/finalize;
- command-audit insert;
- goal-run event/repository/environment evidence links;
- overall goal outcome terminalization.

A stale worker cannot produce authoritative evidence after its DB lease expires even if its subprocess returns later.

## R4-F8 — overall execution deadline needs an external executor cancellation seam

Severity: Blocker

Angle: Runtime

The shared deterministic executor must accept an optional outer abort signal/deadline. Goal runner composes DB lease-loss/system-disable/overall-deadline cancellation with operation-local timeout. Effective adapter deadline is the minimum. No next operation starts after deadline.

Task callers that do not supply an outer boundary retain current behavior.

## R4-F9 — lease renewal during PostgreSQL outage needs a monotonic fail-closed watchdog

Severity: Blocker

Angle: Recovery

Required amendment:

- DB time is authority for persisted lease expiry;
- after each successful claim/renew, worker derives a local monotonic stop deadline no later than the persisted lease horizon;
- transient DB failure does not extend it;
- late success after local fencing cannot revive that worker;
- deadline expiry aborts in-flight executor and forbids new work;
- recovery later decides inconclusive result.

## R4-F10 — Redis occurrence should be acknowledged once DB business authority is acquired

Severity: High

Angle: Queue ownership hierarchy

Recommended call path:

1. claim/parse Redis occurrence;
2. acquire PostgreSQL goal-run lease;
3. once lease is durable, ack/release Redis occurrence best-effort;
4. continue business work under DB lease only.

If Redis ack is lost, duplicate occurrences can reappear; duplicate workers fail DB lease and safely discard/ack duplicates. If DB cannot confirm lease, do not drop transport based on an assumption.

This avoids two independent business leases.

## R4-F11 — recovery needs a bounded read-only quarantine horizon

Severity: High

Angle: Liveness / stale subprocess

Because v1 eligibility is read-only and every goal evidence write is DB-lease fenced, an expired worker cannot create authoritative post-lease evidence. Recovery can:

- fence expired generation/token;
- enter `recovery_required`;
- set a DB-time `recovery_not_before` at least max eligible operation timeout + abort/quiescence margin beyond last trusted lease;
- after that horizon, if no current lease/terminal outcome exists, close parent inconclusive without replaying the incomplete child;
- preserve nonterminal child operation history.

Side-effecting operations are explicitly not covered.

## R4-F12 — global runtime kill switches are a required stricter ceiling

Severity: High

Angle: Release/rollback

Add centralized fail-closed availability gates:

- manual verification-goal execution availability;
- scheduled verification-goal execution availability.

They can only restrict. Project policy still must opt in. Slice B keeps both unavailable; Slice C enables manual only after release evidence; Slice E separately enables scheduling. A runtime emergency disable makes new work stop/fail closed and running work become inconclusive at the next authority checkpoint.

## R4-F13 — policy needs max queued age and one active run per goal

Severity: High

Angle: Resource / stale intent

Add DB-backed `max_queue_age_seconds`; admission writes `admission_expires_at` from database time. Expired queued run moves to `expired`, not proof history.

Partial unique index limits one active run per project + logical goal across trigger kinds.

## R4-F14 — run policy snapshot needs exact stored resolver output

Severity: Blocker

Angle: Replayability

Persist `resolved_policy` exact bounded JSON + `resolved_policy_fingerprint` + resolver contract version. Immutable input references remain, but workers do not rerun a possibly changed resolver and substitute new semantics for an existing run.

## R4-F15 — #187 requires a project-policy operator surface before default-disabled execution is usable

Severity: High

Angle: Product/API completeness

Slice A must include a minimal authenticated project-policy read/update surface (API and/or Project Settings action) with expected-head CAS. Server derives actor from session; caller cannot provide actor id. Scheduling controls may be stored before the scheduler is globally available but cannot bypass the system availability gate.

## R4-F16 — default policy values need one canonical seed source and parity proof

Severity: Medium

Angle: Hardcoding / maintainability

Operator-tunable values live in DB revisions. The disabled default profile's numeric values must be declared once in a canonical seed/default contract and migration/new-project initialization must be tested for exact parity. Do not duplicate magic values across TypeScript, SQL, UI, and docs.

## R4-F17 — schedule binding needs a deterministic first-due rule

Severity: Medium

Angle: Product semantics

Recommended conservative behavior:

- binding anchor = database time when a current eligible goal/policy is first activated/observed;
- first scheduled due time = `anchor + effectiveInterval`;
- enabling scheduling does not cause an immediate surprise execution; operator can run manually immediately;
- new registry/policy binding gets a new anchor.

## R4-F18 — scheduler needs bounded cursor batches and no full catch-up

Severity: High

Angle: Scalability

Use bounded stable cursor processing and named system runtime scan limits. Multiple scheduler workers may race safely on unique slots. On downtime, materialize only the current eligible slot; preserve a bounded skipped-count/observation rather than creating every historical missed slot.

## R4-F19 — rolling schema deployment needs expand/compat/cutover before goal rows exist

Severity: Blocker

Angle: Release compatibility

Making `task_id` nullable in shared ledgers can break old consumers even if task rows are unchanged.

Required rollout:

1. expand: add new nullable subject columns/version fields while old task NOT NULL/task paths remain valid;
2. deploy dual-version readers/writers and static query audit while goal execution globally disabled;
3. cutover: install exclusive subject checks/partial unique indexes and safely relax task NOT NULL where necessary;
4. prove every generic consumer handles goal-subject rows or filters task subject explicitly;
5. only then enable manual goal execution;
6. reliability v2 and scheduler have their own later activation.

No goal row is written while a supported old consumer can misinterpret nullable task identity.

## R4-F20 — live registry attestation must remain explicit-import activation, not implicit auto-import

Severity: High

Angle: Human authority / source of truth

A live manifest mismatch blocks run/schedule with `registry_content_stale` and asks the operator to import. The runner/scheduler does not automatically activate new repository goal definitions in v1. Explicit import remains the activation boundary.

## Round 4 conclusion

Round 4 found security and release blockers, especially Git repo-config helper execution, database-enforced lease authorization, and rolling compatibility. These must be included in the consolidated architecture before the next fresh review.
