# Issue #187 Architecture Review — Round 6

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **Material terminal/evidence-accounting findings found. Amendment required.**

## R6-F1 — overall canonical outcome v2 mapping is still not frozen

Severity: Blocker

Angle: Canonical outcome / lower-tier implementation

The architecture requires an overall #185-compatible outcome but leaves an implementer to choose result/transport/verifier/failure-class mappings.

Required amendment:

Freeze goal-subject outcome v2 semantics:

### Child deterministic operation pass

```text
transport_status=ok
result=completed
stop_reason_code=null
failure_class=null
retryable=false
verifier_required=false
verification_status=not_required
```

The actual deterministic verdict remains `operation_runs.verification_status=passed` and reliability-v2 records deterministic-adapter verification from that exact child run, consistent with ADR 0012.

### Child deterministic functional command failure with durable audit

```text
transport_status=ok
result=failed
stop_reason_code=operation_execution_failed
failure_class=functional
retryable=false
verifier_required=false
verification_status=not_required
```

### Child deterministic verification failure

```text
transport_status=ok
result=failed
stop_reason_code=validation_failed
failure_class=functional
retryable=false
verifier_required=false
verification_status=not_required
```

(`operation_runs.verification_status=failed`.)

### Child authority/policy block

```text
transport_status=ok
result=blocked
failure_class=authority|policy
```

### Child timeout/infrastructure/evidence failure

```text
transport_status=error
result=failed|needs_attention according to the frozen v2 result table
failure_class=infrastructure|evidence|cancelled
```

Never decisive functional failure.

### Overall goal passed

```text
transport_status=ok
result=completed
stop_reason_code=null
failure_class=null
retryable=false
verifier_required=false
verification_status=not_required
```

### Overall goal failed

```text
transport_status=ok
result=failed
stop_reason_code=verification_goal_failed
failure_class=functional
retryable=false
verifier_required=false
verification_status=not_required
```

### Overall goal inconclusive

```text
transport_status=ok
result=needs_attention
stop_reason_code=<exact closed goal terminal code>
failure_class=authority|policy|infrastructure|evidence|cancelled
retryable=false
verifier_required=false
verification_status=not_required
```

Goal `terminal_code` and overall outcome stop code must match one exact mapping table.

## R6-F2 — goal terminal-code taxonomy is not fully closed

Severity: Blocker

Angle: State / reporting

Required amendment:

Define exact v1 terminal codes and which lifecycle/result they permit:

```text
completed/passed:
  passed

completed/failed:
  functional_operation_failed
  functional_verification_failed

completed/inconclusive:
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

expired/no result:
  dispatch_expired
```

Do not include an operator-cancel code until a cancel API/state transition is actually designed.

## R6-F3 — `recovery_required` must count against a bounded project active-run ceiling

Severity: High

Angle: Scalability / unresolved evidence

`max_queued_runs` and `max_concurrent_runs` alone do not bound unresolved recovery rows across many goals.

Required amendment:

Project policy adds `max_active_runs`, where active means:

```text
queued | running | recovery_required
```

Admission enforces all three independently:

- queued count < `max_queued_runs`;
- running count < `max_concurrent_runs` when a worker starts/claims;
- total active count < `max_active_runs` at admission.

Recommended default `max_active_runs=10` when `maxQueued=8,maxConcurrent=2`. Recovery-required rows therefore cannot accumulate without bound.

## R6-F4 — exact status-count semantics must be specified

Severity: High

Angle: Admission / concurrency

Required amendment:

- `max_queued_runs`: status exactly `queued`;
- `max_concurrent_runs`: live business leases in status `running`; a worker claim is denied if the project running ceiling is reached;
- `max_active_runs`: `queued|running|recovery_required`;
- `expired|completed` consume none of these capacities;
- start budget counts all new admitted runs regardless of later status.

All counts use project-scoped indexed queries and the canonical project/policy lock order.

## R6-F5 — goal proof “clean” must not inherit task-specific ignored-path semantics

Severity: Blocker

Angle: Repository evidence / correctness

The existing task repository helper intentionally ignores `.forge/task-runs/**` when deciding whether repository-writing work is dirty. A project-level clean-commit proof must not silently inherit that exception.

Required amendment:

Verification-goal `clean=true` means the hardened `git status --porcelain=v1 -z --untracked-files=all` yields **zero status entries**, with no Forge-path exclusion. If Forge runtime artifacts are expected inside a repository, operators must place them outside the project or explicitly `.gitignore` them; the proof runner does not hide them.

This also means an untracked verification-goal file can be imported for definition evidence but cannot produce a decisive clean-commit proof until it is committed/ignored in a way consistent with the desired repository truth.

## R6-F6 — goal-subject evidence must become immutable after authoritative creation

Severity: Blocker

Angle: Audit integrity

Lease-fenced insertion is not enough if an ordinary app path can later UPDATE/DELETE proof evidence.

Required amendment:

For goal subjects:

- repository command audits are append-only and cannot be updated/deleted;
- execution outcomes v2 are append-once and cannot be upsert-mutated after creation;
- terminal operation-run identity/outcome linkage cannot change after protected finalization;
- operation-run events and goal-run events are append-only;
- repository/environment snapshots are immutable;
- completed/expired goal-run terminal fields cannot be rewritten except through an explicitly versioned future adjudication/history table, never in-place.

Use PostgreSQL triggers/ACLs/protected routines so privileged accidental application SQL cannot rewrite goal evidence. Existing task-subject mutability contracts are not silently changed unless their own ADR is amended.

## R6-F7 — overall evidence-set drift must be rechecked at read/consumer boundaries

Severity: High

Angle: Evidence drift

Even with immutability, readers should not trust a stored digest without reconstructing the relationship when it matters for reliability/Sentinel/autonomy.

Required amendment:

- history reader validates/rederives `goal_evidence_set_digest` for decisive runs or uses a tested DB view/helper that does so;
- a mismatch yields explicit `evidence_drift`/inconclusive trust state and suppresses decisive current status for downstream trust decisions;
- reliability-v2 does not ingest/score a child if its parent evidence set is inconsistent;
- #189/#190/#191 consume validated evidence, not only run.result.

## R6-F8 — undefined “attempt generation” in child idempotency is unnecessary

Severity: Medium

Angle: Contract clarity

The v1 runner deliberately never retries/replays a child operation inside one goal run after uncertainty. Therefore no separate child attempt generation is needed.

Required amendment:

Child operation idempotency key is domain-separated over exactly:

```text
goal run id
canonical operation ordinal
operation id/version
definition digest
execution binding digest
```

A new proof attempt is a new goal-run identity.

## R6-F9 — manual idempotency uniqueness needs a database scope

Severity: Medium

Angle: Referential integrity

Required amendment:

Partial unique index for manual runs:

```text
UNIQUE(requested_by_user_id, manual_idempotency_key)
WHERE trigger_kind='manual'
```

The stored request fingerprint then distinguishes same-key replay from same-key different intent.

## R6-F10 — scheduler “same ref” requirement should be explained explicitly

Severity: Medium

Angle: #187 contract interpretation

The scheduler intentionally allows a later interval to re-observe the same commit because environment/operational state can change; it must not create duplicate evidence from the same **slot** or concurrent overlapping goal/ref.

Required amendment:

- unique slot + one active goal prevents overlapping duplicate scheduled runs;
- repeated later slots on the same commit are separate observations, not separate unique reliability evidence units;
- reliability-v2 unique evidence-unit count prevents promotion sample inflation;
- wording in acceptance mapping should say this satisfies “scheduled runs do not overlap or create duplicate evidence for the same goal/ref” at the concurrent/slot level while retaining later observations.

## Round 6 conclusion

Round 6 still found blockers: exact outcome/terminal mappings, strict clean semantics, active recovery capacity, and post-write evidence immutability. These must be amended before a no-blocker pass.
