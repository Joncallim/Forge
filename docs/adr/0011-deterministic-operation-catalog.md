# ADR 0011: Deterministic operation catalog

## Status

Accepted.

## Decision

Forge v1 exposes a small, code-owned catalog of typed operations. An agent may
select an operation id and version, provide the exact declared input object,
state an informational reason, and name the required capability. It may not
provide a working directory, path, command, argument list, server name, or tool
name. The reason is fingerprinted for audit but cannot change execution or
idempotency.

The initial catalog contains three read-only operations: Git status, Git diff
summary, and current Git branch. Their adapters have
fixed actions and receive project and task scope only from trusted Forge
context. They do not use a shell, write repository files, materialize generated
files, mutate GitHub or MCP state, or trigger retries.

The production composition entry point is `executeTrustedOperation` in
`web/worker/operations/context.ts`. It joins the task to its project in
PostgreSQL, reads the current project path, root-binding revision, and project
update revision, and validates and canonicalizes an existing root through the
same project-path boundary used by normal Forge execution. Callers cannot
provide a project id or repository root. Direct construction of
`TrustedOperationContext` is reserved for focused tests and already-trusted
internal composition.

The caller also cannot supply capabilities, ceilings, or a policy version.
Forge derives them from the current approved or running task, the linked work
package, current project revisions, and the existing effective filesystem-grant
authority. Repository reads require an approved effective
`filesystem.project.read` project grant in `always_allow` mode. Forge rejects
`allow_once` grants because this executor does not atomically consume them.
Immediately before Git starts, Forge reloads that authority and re-canonicalizes
the current project root; any task, package, grant, revision, or root change
fails closed.

The wrapper verifies every supplied work-package, agent-run, and task-attempt
link against the authoritative task. It always composes repository reads from
Forge's bounded command runner and command-audit writer. Model output and operation request fields cannot
replace these production adapters. Each successful repository operation must
carry its command-audit UUID as evidence; exit code zero alone is insufficient.
If Git fails or cancellation wins after the command starts, the failed phase and
canonical outcome retain that audit UUID without copying raw command output into
the operation ledger.

The diff-summary operation uses the exact argument list
`git diff --no-ext-diff --no-textconv --stat --`. The bounded command runner
rejects weaker variants, so repository attributes cannot select an external
diff helper or text-conversion program.

Every request is checked in this order: request schema, exact inputs, catalog
version, trusted scope, existing policy ceilings, preflight, fixed adapter, and
deterministic output verification. A successful adapter call is not enough to
complete a run; verification must pass. Unknown operations, changed versions,
missing roots, denied capabilities, timeouts, malformed evidence references,
and invalid output fail closed.

The `operation_runs` ledger stores the exact definition version, definition and
scope digests, request/input/reason fingerprints, policy decision, status, and
the linked canonical execution outcome from ADR 0010. Raw model inputs and
reasons are not stored there. Phase events are append-only and have fixed
sequence numbers from request validation through outcome. Starting a run uses a
unique task/idempotency key; final outcome creation, the outcome phase event,
and run terminalization commit in one database transaction.

The terminal run stores a digest of the normalized canonical outcome. Replay
recomputes the digest from the linked outcome row and fails closed if that row
changed. The database permits only the explicit phase graph: validation,
policy, preflight, execution, verification, then outcome. Failed policy,
preflight, or execution phases may move directly to outcome; successful phases
cannot skip their next check.

The scope digest binds the canonical project root, root-binding revision,
project update revision, bounded policy version, normalized capability set, and
the repository-read ceiling. A replay with the same idempotency key fails closed
if any of those inputs changed. Reordering or repeating the same capabilities
does not create a false change.

Every adapter receives an `AbortSignal` and deadline. A timeout aborts the
signal, and Forge waits for the fixed adapter and its audit work to settle before
recording a terminal timeout. An injected adapter that ignores cancellation is
left as an incomplete recovery-required run rather than being terminalized
while work may still continue.

A replay that finds a nonterminal `running` row also fails explicitly as
recovery-required. The incomplete row remains audit evidence; after inspection,
an operator or recovery workflow uses a new attempt key. V1 does not guess that
a stale read completed and does not mutate incomplete history.

## Adding or changing an operation

Add a versioned definition to `web/lib/operations/catalog.ts`, add only a fixed
adapter kind to the closed TypeScript union and executor switch, and add tests
for exact inputs, policy denial, timeout, output verification, and idempotency.
A new path, command, permission, risk, scope, executor, or verification rule is
a new version. Reviewers must confirm that all dynamic values are validated and
that existing repository, MCP, security, and human-approval ceilings remain
stricter. Project-local and model-created registrations are not supported in v1.

To retire an operation, add its replacement first, mark the old definition
deprecated, and keep its historical version readable. Do not edit historical
ledger rows or reuse a version number.

## Auditing

Operators audit `operation_runs` for identity, fingerprints, policy, and the
canonical outcome link, then read `operation_run_events` in sequence order.
Evidence references are UUIDs that point to existing Forge evidence records;
technical output stays in those bounded records. A missing outcome, incomplete
phase history, digest mismatch, or invalid evidence reference is unavailable or
failed evidence, never implied success.

## Consequences

This foundation deliberately provides narrow read automation, not general
command authority. Write operations, rollback actions, independent workforce
verification, project-local definitions, and earned-autonomy promotion require
later reviewed versions and integrations.

This PR establishes the production-safe composition but does not yet connect a
normal agent/model task path to `executeTrustedOperation`. That integration is
a required follow-on before issue 201 can be considered fully closed. MCP health
is also deferred until its dependency chain supports real cancellation.
