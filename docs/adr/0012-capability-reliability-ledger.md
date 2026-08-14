# ADR 0012: Capability reliability ledger

## Status

Accepted. Implemented in migration `0031_capability_reliability_ledger.sql`.

Primary design document:
`docs/architecture/issue-186-capability-reliability-ledger.md`.

## Context

ADR 0010 gave Forge a canonical record of *what happened* on one attempt. ADR
0011 gave it deterministic typed operations. Neither answers whether a specific
kind of work has repeatedly succeeded under comparable conditions, which is the
evidence issue #189 will need before it may widen any permission.

A single reliability score per agent or model would hide the differences that
matter — scope, project, model, harness, and policy — and would encourage exactly
the unsafe promotion this Epic exists to prevent.

## Decision

Forge records an append-only ledger of individual **capability attempts** and
computes reliability metrics per **cohort**, on demand, from those attempts.

A cohort is the domain-separated SHA-256 fingerprint of project, capability key,
scope, runtime/model, and policy. Because a material change to any of those
produces a different cohort, requalification is automatic: new conditions start a
new sample count, and prior evidence is retained but no longer counted. The four
component fingerprints are stored beside the cohort fingerprint so drift is
attributable to a specific input rather than only detectable.

Capability keys are namespaced — `workpackage:<role>/<capability>` from the
existing `CAPABILITY_TAXONOMY`, or `operation:<id>@<version>` from the ADR 0011
catalog — so model-executed work and deterministic operations can never share a
cohort. One work package writes one attempt row per capability it exercised, all
sharing an `attempt_group_id` and a multiplicity count, so per-capability and
per-attempt views are both available without double-counting. When the Architect
classification is missing or exceeds the fan-out bound, a single reserved
`unclassified` row records the gap instead of guessing a capability.

`capability_attempts` is immutable: identity and the ingest-time outcome
snapshot cannot be updated or deleted, enforced by a database trigger. Evidence
that arrives later — verification results and human decisions, and in later
slices rollbacks and overrides — is appended to
`capability_attempt_adjudications` in gapless sequence order, never written
back into the attempt. Concurrent writers (for example a QA gate and a
reviewer gate decided for the same attempt at the same moment) serialize on
a transaction-scoped advisory lock keyed on the attempt id, so a decision can
never be silently dropped by a sequence conflict.

Whether an attempt counts as verified is decided by a closed `verification_mode`.
`self_reported` and `human_review` never contribute to the independently verified
pass rate; only `deterministic_adapter` (ADR 0011) and `independent_agent` do.
`independent_agent` has no producer until issue #188, so v1 rejects it at ingest
rather than allowing an unbacked value to be stored. Deterministic operations
carry `verifier_required = false` on their canonical outcome, so their real
verdict — the ADR 0011 run's verification status — is appended as a
`verification_recorded` adjudication with mode `deterministic_adapter` instead
of being discarded at ingest. Forge's current honest answer for most cohorts is
reported explicitly as an unverified-completion rate instead of being folded
into a pass rate.

The ledger has no free-text column. Every `text` column is a closed enum, a
64-hex fingerprint, or the bounded capability-key grammar, each enforced by a
`CHECK` constraint. Model prose, file paths, repository-relative names, and
credentials therefore cannot enter the ledger even by mistake, and no redaction
helper is needed on this path. Scope is fingerprinted from the project's opaque
`root_ref` and revisions, never from `local_path`.

Metrics are a pure function of stored attempts, adjudications, a window, and an
explicit `now`. No materialized summary is stored in v1: a cache that can
disagree with its evidence is a class of bug this ledger exists to avoid, and the
cohort index makes on-demand computation a bounded scan. Below a minimum sample
size a cohort reports `insufficient_evidence` with null rates; if any in-window
attempt's linked outcome has changed since ingest, the cohort reports
`evidence_drift` and suppresses all rates. Drift is detected at read time and
reported through the summary state — reading a cohort performs no writes, so
routine inspection never mutates the audit ledger. Critical failures are
reported unconditionally in every state, computed over the cohort's full
critical history rather than the rolling rate window, so neither an aggregate
nor a 90-day window can conceal one.

Ingest hangs off the existing canonical-outcome boundaries — the three work
package handoff sites and, after its transaction commits, the ADR 0011 operation
finalize path. Writes are best-effort and idempotent on
`(execution_outcome_id, capability_key)`: a ledger failure never fails a task,
package, run, or operation, and a recovered worker re-running a boundary writes
nothing new. Historical attempts are not backfilled; a missing attempt is
unavailable evidence, never success. The ordinary application role receives
`SELECT` and `INSERT` on the ledger tables and nothing else.

## Consequences

Issues #188, #189, #190, and #191 read this contract instead of deriving trust
from statuses, free-text errors, or a worker's own account of its performance.
Autonomy decisions in #189 can cite a cohort, a sample size, a verification mode,
and the evidence rows behind each number.

This ADR grants no autonomy and changes no permission. It adds no dashboard, HTTP
route, scheduled job, or background recomputation. It does not produce
independent verification, and it does not replace the task, work package, agent
run, artifact, execution outcome, operation run, or approval gate records that
remain authoritative for their own state.

Three capabilities are defined but not yet producible: rollback and override
adjudications have storage contracts and metrics but no writer until #189/#190,
independent-agent verification is refused until #188, and the
`evidence_drift_detected` adjudication kind is contract-only until an explicitly
mutating operator command exists. All are deliberate — the storage shape is
stable, and the gaps are visible rather than filled with optimistic defaults.
