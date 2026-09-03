# FORGE Near-Term Execution Roadmap

Last updated: 2026-09-03

This document is the **execution-order view** of the Forge roadmap. The current
VNext product direction is defined in
[`docs/forge-vnext-architecture.md`](forge-vnext-architecture.md) and
[ADR 0014](adr/0014-forge-vnext-general-agent-runtime.md). Epic
[#333](https://github.com/Joncallim/Forge/issues/333) is the umbrella programme.

This page answers a narrower question:

> What should Forge finish next, and what evidence is required before moving on?

## Current Position

Forge has already delivered several foundations that VNext should reuse rather
than rebuild:

- unified MCP admission/recovery work under #172;
- deterministic Operation Catalog foundation (#201 / ADR 0011);
- canonical execution outcomes (#185 / ADR 0010);
- capability reliability evidence (#186 / ADR 0012);
- the first verification-goal registry slices (#187 / ADR 0013).

The largest current execution boundary remains intentional: general specialist
writes are still fail-closed until Forge has an OS-enforced confined execution
path.

The next programme should therefore **generalize around the existing trust
layer**, not build a second orchestrator and not resume broad Workspace expansion.

## Guiding Rules

1. **No big-bang rewrite.** Keep today's Project/Task coding path working while
   generic Mission/Resource/Grant contracts are introduced underneath it.
2. **No permanent LLM parent agent.** Deterministic software owns routing,
   budgets, scheduling, policy, recovery and triggers.
3. **Budget before breadth.** Every future model call should be attributable,
   bounded, and chosen through deterministic policy.
4. **Execution safety before autonomy.** Do not open repository or external
   writes until the confined execution/authority model proves them safe.
5. **Reuse trust truth.** #184, #201, #185, #186, #187 and #172 are foundations,
   not legacy systems to replace.
6. **One source of orchestration truth.** New VNext records must not duplicate
   task/work-package/operation/outcome/evidence state.
7. **Hermes contributes lessons only.** No Hermes code, state, config, runtime or
   fallback path belongs in Forge.
8. **No ensembles in this programme.** Model ensembles/latent bridges remain
   deferred.

## 0. Freeze And Merge The VNext Architecture — Epic #333

Merge the reviewed VNext architecture and ADR before implementation starts.

Canonical artifacts:

- `docs/forge-vnext-architecture.md`;
- `docs/adr/0014-forge-vnext-general-agent-runtime.md`;
- `docs/architecture/forge-vnext-review-record.md`;
- issues #333–#344.

### Exit criteria

- The VNext ontology and invariants are accepted in-repo.
- ADR 0007 is clearly scoped as the coding/Software Engineering taxonomy where
  ADR 0014 provides the broader product ontology.
- Epic #184 records the VNext integration/resequencing constraint.
- There is no unresolved architecture blocker in the reviewed scope; remaining
  uncertainties are explicitly assigned to implementation phases.

## 1. Generic Runtime Contracts And Compatibility Seam — #334

Do this **before** adding more autonomous coding machinery.

Define versioned contracts for:

- Mission and Execution;
- Resource and Capability;
- Grant and Principal;
- Workflow / Work Package / Agent Run;
- Artifact and Gate;
- Trigger, Budget and Policy;
- Workforce revisions.

Map the existing coding product through these contracts without destructive
renames or duplicate sources of truth.

### Exit criteria

- Existing Project/Task behaviour remains compatible.
- A non-repository Mission can be represented without fake Git fields.
- PostgreSQL remains durable orchestration/evidence truth; Redis remains
  transport/wakeup state.
- Remaining #187–#191 work has an explicit VNext integration decision before it
  adds project-only scheduling/autonomy concepts.
- No Hermes dependency is added.

## 2. Deterministic Budget, Routing And Context Economics — #335

Before Forge launches more agents, teach the control plane to decide when a model
call is worth making and whether it is affordable.

Implement:

- hierarchical hard budgets;
- pre-call reservation/admission and post-call settlement;
- provider-neutral cognitive classes;
- deterministic provider/model routing and failover;
- actionable provider health categories;
- routing receipts;
- bounded context packets;
- provider/data-egress policy;
- cost-to-verified-outcome telemetry.

Forge already stores per-run input/output tokens and cost when known. Extend that
truth rather than creating a parallel usage database.

### Exit criteria

- No-change/idle paths can finish with zero model calls.
- Hard budgets block before an over-budget provider call.
- Auth/quota/rate-limit failures can fail over deterministically when policy
  permits.
- Every model invocation has explainable routing and actual/unknown usage
  evidence; unknown usage is never forged into zero.
- No LLM is used merely to route another LLM.

## 3. Secure Generic Execution Envelope — #336

Open the current fail-closed execution boundary only through an OS- and
policy-enforced runtime.

Prove:

- filesystem/resource containment;
- network/egress control;
- secret/environment isolation;
- process and resource limits;
- run-scoped grant enforcement and Principal lineage;
- stale-worker fencing and cancellation;
- resource mutation concurrency;
- external side-effect idempotency/reconciliation;
- trusted gate evaluation rather than worker self-approval.

### Exit criteria

- A hostile worker cannot escape the granted resource/secret/network boundary on
  the supported host.
- A child run cannot widen parent authority.
- Ambiguous external submissions hold/reconcile rather than blind-retry.
- Restart/replay does not duplicate supported confirmed side effects.
- Prompt/resource injection cannot alter Forge policy or grants.

## 4. Prove Software Engineering End To End — #337

Only after the generic and secure runtime contracts exist, complete the current
flagship coding path through them.

Target:

```text
Mission
  -> plan
  -> bounded implementation
  -> deterministic validation
  -> independent QA / Review / Security evidence
  -> trusted gates
  -> remediation
  -> branch + commit + PR
```

General auto-merge is not required.

### Exit criteria

- The simple-web-app release gate succeeds twice from clean/repaired supported
  environments.
- Every model run is budgeted and context-bounded.
- Every mutation is attributable to a typed Operation, Principal, Grant and
  resource scope/version.
- Parallel writers cannot silently conflict.
- Reviewers produce evidence; Forge gates make authoritative decisions.
- Current Task UI/API remains compatible through the seam.

## 5. Extract The Installable Software Engineering Workforce — #338

After coding is proven, make it the first real package instead of baking its
roles/workflows permanently into Core.

Prove:

- declarative package manifest and conformance checks;
- local/pinned-Git installation;
- package digests/provenance/version pinning;
- capability/permission review before activation;
- permission-diff review on update;
- running-Mission pinning;
- explicit local derived revisions for operator edits.

### Exit criteria

- Software Engineering passes the same Phase 4 release gate as an installed
  package.
- Installing/removing a Workforce needs no Forge Core source change.
- Workforce package content cannot execute arbitrary host code by virtue of
  installation.
- No coding-only Core hook is added simply to make the extraction pass.

## 6. Prove Non-Coding Generality — Deep Research #339

Deep Research is the second reference Workforce.

It must prove:

- non-repository Resources;
- bounded parallel discovery;
- evidence provenance;
- contradiction/uncertainty handling;
- source/citation validation;
- provider-egress restrictions;
- prompt-injection resistance;
- completion through trusted evidence gates.

### Exit criteria

A Research Mission can run with **no Project/Git record** and produce a verified,
traceable research artifact within hard budgets using the same Forge Core runtime
as Software Engineering.

## 7. Persistent Mission Runtime — #340

Add durable responsibility across multiple bounded Executions:

- checkpoints;
- leases/fencing;
- cancellation/revocation;
- quiescence;
- hard child-depth/fan-out/retry/cost/token/time ceilings;
- concise validated prior-state artifacts.

### Exit criteria

Kill/restart Forge mid-Mission and recover without duplicate confirmed side
effects. A waiting Mission holds no permanent model conversation and consumes no
idle tokens.

## 8. Trigger/Event Runtime — #341

Add schedule/webhook/event semantics behind one Trigger contract:

- occurrence identity;
- dedupe/replay protection;
- causal ancestry;
- loop prevention;
- debounce/coalescing;
- bounded retry/dead-letter state;
- deterministic no-change filtering.

Rebase scheduled proof/Sentinel work on this substrate where appropriate.

### Exit criteria

A deterministic scheduled responsibility can remain active over a meaningful
healthy/no-change window with zero model calls, while duplicate/replayed or
self-generated events do not create duplicate work/side effects.

## 9. General Resource/Capability Adapter Plane — #342

Expand adapters only when proven Workforces need them. Keep Workforces and
connectors separate trust classes.

Candidate families include:

- filesystem/Git/GitHub;
- browser/web/documents;
- MCP/ACP;
- Notion/knowledge sources;
- email/calendar;
- database/HTTP APIs;
- infrastructure/service control.

### Exit criteria

Adapters expose typed, scoped capabilities with credential brokerage,
health/quota state, redaction, timeout/cancellation, idempotency and
reconciliation. Declaring a capability in a Workforce never grants its
credential or authority automatically.

## 10. Prove Persistent Side-Effectful Autonomy — Infrastructure Ops #343

Use a bounded Hearth service-health Mission as the third reference proof.

Healthy/unchanged state should be deterministic and token-free. Meaningful faults
may invoke bounded cognition and predefined reversible remediation under policy.

### Exit criteria

- zero-token healthy observation window;
- deterministic fault detection;
- scoped remediation with independent verification;
- no repeated token/action loop on flapping or failed remediation;
- restart/replay safety;
- prompt-injection resistance in logs/status text.

## 11. Cut HearthBot To Forge And Remove Hermes — #344

Only after the three runtime proofs pass, migrate the retained Hermes/HearthBot
requirements one workflow at a time.

The rule is:

> **One workflow, one writer/authority at a time.**

Keep only useful behaviours; do not pursue bit-for-bit Hermes parity.

HearthBot becomes a thin Forge interface. Hermes is removed from the target
runtime, not kept as fallback.

### Exit criteria

- Every retained Hermes responsibility has a Forge-native owner/test or is
  explicitly dropped.
- No workflow has simultaneous Forge/Hermes write authority.
- A clean reboot starts the required Forge/HearthBot path with Hermes absent.
- Hermes-only services/timers/cron/config/credentials are removed or revoked as
  appropriate.
- Forge has no runtime/source/config/state dependency on Hermes.

## Broad Forge Workspace Expansion Remains Deferred

Small operator/evidence/recovery UI work may proceed when it directly supports
these phases. Broad dockable Workspace/product-surface expansion should not outrun
runtime proof.

Resume it only after the core VNext contracts, secure execution, and at least the
Software Engineering + Deep Research proofs are stable enough to justify the
surface area.

## Decision Filter For New Work

Before adding a large feature, ask:

1. Does it strengthen or prove a VNext contract required by #333?
2. Does it reuse the existing operation/outcome/evidence/trust truth rather than
   duplicate it?
3. Can deterministic software do the job instead of another model call?
4. Does it have a hard budget, authority boundary, failure/recovery path and
   objective verification plan?
5. Is it needed for the next reference proof, or is it attractive but deferrable?

If it is not needed for a current gate and delaying it reduces risk/complexity,
defer it.