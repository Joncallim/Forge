# ADR 0010: Canonical execution outcomes

## Status

Accepted.

## Decision

Forge records one versioned execution outcome for each authoritative execution
or admission boundary. The new `execution_outcomes` ledger is keyed by
`(task_id, attempt_key)`, so a recovered worker updates the same outcome rather
than creating contradictory records.

The v1 contract separates provider transport (`ok` or `error`) from the
semantic result. A successful provider response that contains a refusal is
therefore `transportStatus: 'ok'` and `result: 'refused'`; it is never treated
as completion. Stop reasons use a closed taxonomy. Summaries are redacted and
limited to 1,000 characters. Evidence references contain UUID record IDs only;
raw diagnostics remain in the existing artifact, task-log, command-audit, and
MCP records.

`task_id` is required. Links to a work package, agent run, and queue attempt
are nullable because an admission decision can block before an agent run starts.
The existing lifecycle tables remain the source of truth for their respective
states. The ledger is an interpretation layer for reliability and verification
features.

For v1, worker writes occur at admission blocks and terminal implementation
success/failure boundaries. Historical rows are deliberately not backfilled:
callers must treat a missing outcome as unavailable legacy evidence, not as a
successful execution.

## Consequences

Future reliability scoring, independent verification, and autonomy policy read
this contract instead of deriving meaning from free-text errors. This change
does not redesign retry behavior, create automatic retries, or alter task and
work-package state transitions.
