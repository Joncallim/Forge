# ADR 0016: Deterministic Workflow Kernel And Artifact-Routed Handoff

## Status

Accepted product direction for Forge VNext. Repository adoption is carried by PR #368.

## Date

2026-09-10

## Context

Forge already has the durable primitives needed for multi-agent work:

- PostgreSQL-backed Work Packages and dependency records;
- Agent Runs;
- immutable/revisioned Artifacts;
- trusted Gates;
- Grants, budgets, Operations, leases and evidence;
- non-authoritative local checkpoints from ADR 0004;
- the first coding-oriented Workforce graph from ADR 0005.

ADR 0014 further establishes the VNext rule that models are ephemeral workers
and deterministic Forge Core owns orchestration, routing, policy, recovery and
evidence.

One remaining gap is ordinary supervisor-to-specialist handoff. A naive
multi-agent implementation can require a supervisor model to reread predecessor
outputs, summarize them into prose, and pass that summary to the next model.
That creates repeated token/latency cost, loses provenance, and risks turning
narrative text into an implicit orchestration state.

A general agent framework such as LangGraph could provide graph execution and
checkpointing, but making such a framework authoritative would create a second
state/recovery model beside Forge's existing PostgreSQL entities and trust
contracts.

Forge therefore needs graph-shaped workflow execution without another
orchestration authority.

## Decision

### 1. Work Package remains the handoff unit

Forge does not add a canonical `Handoff` or `HandoffEnvelope` entity.

A handoff is a runtime transition:

```text
ready Work Package
  -> select authoritative Resource/Artifact/evidence references
  -> governed context/provider/budget/egress admission
  -> exact bounded ContextPacket
  -> Agent Run or deterministic Operation
  -> structured Artifact/evidence
  -> deterministic Workflow advancement
```

The Work Package remains the dependency-scoped unit of work. Artifacts and
Resource references carry durable substance between stages.

### 2. Workflow v1 is a versioned directed acyclic graph

The first generic Workflow kernel uses a versioned **directed acyclic graph
(DAG)** of Work Package definitions and dependencies.

The kernel must reject before dispatch:

- dependency cycles;
- dangling dependency edges;
- unsupported Workflow revisions;
- impossible required joins;
- malformed required input/output/Gate references.

This is the deliberately narrow first Workflow contract. General cyclic
workflow programming is not required for VNext.

### 3. Rework is attempt lineage, not a graph cycle

Retries and remediation create explicit bounded attempt/revision lineage under
Mission/Execution/Work Package budget and remediation ceilings.

A logical rework loop therefore does not require the Workflow definition itself
to contain an unrestricted cycle. Persistent repeated responsibility belongs to
Mission/Execution/Trigger semantics in later phases.

### 4. Readiness is deterministic but not authority

The Workflow kernel derives readiness from authoritative Forge state, including:

- predecessor Work Package outcomes;
- required Artifact/evidence presence and pinned versions/digests;
- Gate results and Execution waiting state;
- cancellation/revocation/lease state;
- deterministic eligibility signals exposed by budget/policy services.

A readiness result is only a preflight decision. It does not reserve budget,
select a provider, mint a Grant, or authorize mutation.

For a cognitive Agent Run, #335 remains the final atomic authority for current
provider/data-egress eligibility and budget/concurrency reservation at dispatch.
For a mutation, #336 remains the final authority for current Resource/Grant/
lease/confinement checks at execution.

A stale readiness result can therefore fail closed at either later boundary.

### 5. Context planning and payload construction belong to #335

The Workflow kernel passes context requirements and authoritative references; it
does not concatenate predecessor transcripts or ask a supervisor to summarize
them.

#335 owns the governed context boundary:

1. Build a reference-first ContextManifest from safe metadata and authoritative
   Resource/Artifact/evidence refs.
2. Apply classification, destination/provider, budget and policy admission.
3. Only after the destination is eligible, materialize the exact bounded
   ContextPacket for the Agent Run.
4. Retain enough version/digest/provenance evidence to explain what the run
   received, subject to retention/redaction policy.

Required missing, stale, oversized or policy-ineligible context fails closed.
Unrelated predecessor output and private model reasoning/transcripts are not
inherited by default.

### 6. Fan-out and join are deterministic

Dependency-independent Work Packages may become ready concurrently.

Join readiness is deterministic from predecessor outcomes and required
Artifacts/evidence. Every cognitive branch separately crosses #335's atomic
budget/concurrency reservation; multiple nodes being ready does not imply that
all model calls are admitted.

Resource mutation conflicts are not solved by Workflow topology or prompts.
They remain #336 Resource/lease/confinement policy.

### 7. Agent output is evidence/proposal, not authority

Agent Runs may produce typed Artifacts containing implementation output,
findings, decomposition proposals, Operation requests or follow-up proposals.
They cannot directly:

- widen Grants;
- increase hard budgets;
- change protected policy;
- mark trusted Gates passed;
- set authoritative Mission/Execution lifecycle or outcome;
- create unbounded child work.

Forge validates output and applies permitted state transitions through trusted
Core services.

### 8. Existing Gate and waiting semantics are reused

Human or trusted policy pauses use SPEC-0002 Gate results and Execution
`waiting`. The Workflow kernel does not introduce a separate graph-interrupt
lifecycle.

### 9. PostgreSQL remains the single durable orchestration truth

Mission, Execution, Work Package, Agent Run receipt, Artifact, Gate, Grant and
Operation state remain authoritative in PostgreSQL.

Redis may continue to provide reconstructable wake-up/retry transport.
ADR 0004 Markdown checkpoints remain non-authoritative support material.
Later persistent-Mission checkpoints may contain bounded validated references or
projections needed to resume, but they must not become a second Workflow state
store.

The Workflow kernel must not introduce an authoritative generic mutable graph
blob or external framework checkpoint database.

### 10. Migration uses the full SPEC-0014 sequence

The existing coding-oriented sequential path is migrated using the complete
SPEC-0014 R1 discipline:

```text
EXPAND
  -> BACKFILL / ADAPT
  -> SHADOW COMPARE
  -> SWITCH AUTHORITATIVE PATH
  -> VERIFY
  -> CONTRACT OLD SURFACE
```

Shadow comparison may evaluate old and new readiness decisions, but only one
path is authoritative at any point. The migration must not create independent
old/new writers.

### 11. #367 and #336 proceed in parallel after #335

#367 owns deterministic Workflow definition validation, readiness, dispatch
identity, fan-out/join, Gate/wait integration and artifact-routed handoff.

#336 independently owns OS confinement, mutation authority, Resource leases and
side-effect recovery.

Both consume #335. Neither needs to block the other's implementation. #337 is
the first production convergence point and proves Software Engineering using
both branches.

### 12. Third-party graph frameworks are subordinate adapters only

LangGraph or another graph/agent framework is not a Forge Core dependency for
VNext and must not become the authoritative Workflow, checkpoint, Grant, Gate,
budget or persistence layer.

A future adapter may be evaluated for a specific Workforce/runtime only if:

- Forge remains the authoritative source of runtime state;
- all cognitive calls still cross #335;
- all mutations still cross #336/typed Operations;
- Artifacts/Gates remain Forge evidence/authority;
- framework checkpoints are disposable/reconstructable or otherwise explicitly
  non-authoritative;
- no direct agent-to-agent channel bypasses Forge context/authority boundaries.

## Compatibility With Earlier ADRs

### ADR 0004 — Cross-Agent Checkpointing

Remains valid for its current worker slice. Its Markdown checkpoints are
explicitly non-authoritative and may be missing/stale/deleted without changing
true runtime state. ADR 0016 extends the same principle to VNext Workflow
execution.

### ADR 0005 — Workforce Orchestration Graph

Remains the accepted first Workforce persistence slice. Its PostgreSQL Work
Packages, dependencies, Gates and Agent Run links are foundations for ADR 0016.
ADR 0016 refines the VNext execution semantics: the generic kernel is
DAG-based, handoff is a transition rather than a new entity, context is compiled
through #335, and routine sequencing does not require a manager model.

### ADR 0014 — Forge VNext General Agent Runtime

ADR 0016 specializes ADR 0014's deterministic-Core rule for Workflow execution
and handoff. It does not change the VNext ontology or authority hierarchy.

## Consequences

### Positive

- Supervisors stop paying a recurring token cost merely to rewrite handoffs.
- Downstream context is provenance-preserving and inspectable.
- Fork/join parallelism can be deterministic and budget-aware.
- Crash/restart behavior can be reasoned about from canonical Forge entities.
- Software Engineering and Deep Research can share one Workflow mechanism.
- Forge avoids importing another framework's checkpoint/recovery model into its
  trust boundary.

### Costs

- #335 becomes responsible for a stronger context-selection/compilation
  contract.
- A new #367 implementation tranche is required before #337.
- Compatibility shadowing is needed to retire the existing sequential handoff
  path safely.
- DAG-only v1 deliberately defers some dynamic workflow patterns.

## Alternatives Considered

### Put Workflow orchestration directly in #337

Rejected. The flagship Software Engineering proof should integrate established
Core contracts, not invent a new generic orchestration engine while proving it.

### Make #336 depend on #367

Rejected. Workflow readiness is not necessary to prove OS confinement and would
unnecessarily delay the security branch.

### Implement #367 before #335

Rejected. Dispatch/fan-out would otherwise need to invent its own context,
provider and concurrency/budget boundary.

### Add a durable Handoff entity

Rejected. It duplicates Work Package/Artifact semantics and creates another
record that can disagree with authoritative state.

### Use LangGraph as Forge Core

Rejected for VNext. Its graph/checkpoint abstractions would overlap Forge's
existing persistence, recovery, Grant, Gate and evidence architecture. A future
subordinate adapter remains possible.

### Allow arbitrary cyclic Workflow graphs in v1

Rejected. Attempt lineage and persistent Mission/Trigger semantics cover the
near-term required loops more clearly and make replay/recovery/budget bounds
easier to verify.

## Validation Requirements

#367 may close only after proving at minimum:

1. a three-node linear synthetic Workflow with zero model calls for routing;
2. a fork/join synthetic Workflow with deterministic join readiness;
3. cycle/dangling-edge/impossible-join rejection;
4. minimal context selection with missing/stale/oversized/ineligible fail-closed
   cases through #335;
5. duplicate-dispatch prevention across crash/restart/wakeup replay;
6. parallel budget/concurrency safety through #335 final reservations;
7. stale readiness recheck at #335/#336 authority boundaries;
8. model/Workflow content cannot widen authority or set trusted Gate state;
9. existing Gate/waiting semantics rather than a graph-specific interrupt state;
10. full SPEC-0014 migration shadow proof without dual writers;
11. PostgreSQL reconstruction of authoritative Workflow progress;
12. zero model tokens for routine readiness, sequencing, fan-out/join and
    handoff.

## References

- ADR 0004 — Cross-Agent Checkpointing
- ADR 0005 — Workforce Orchestration Graph
- ADR 0014 — Forge VNext General Agent Runtime
- SPEC-0002 — Runtime Contract v1
- SPEC-0003 — Authorization & Grants v1
- SPEC-0006 — Model Invocation & Cost Contract v1
- SPEC-0007 — Error & Reason Codes v1
- SPEC-0008 — Conformance Test Standard v1
- SPEC-0012 — Observability vs Audit v1
- SPEC-0014 — Migration & Compatibility v1
- Issue #335 — budget/routing/context economics
- Issue #336 — secure generic execution envelope
- Issue #367 — deterministic Workflow kernel
- Issue #337 — Software Engineering integration proof
