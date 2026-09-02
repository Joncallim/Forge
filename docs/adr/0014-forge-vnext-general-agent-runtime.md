# ADR 0014: Forge VNext Is A Deterministic, Budget-Aware General Agent Runtime

**Status:** Accepted for Epic #333
**Date:** 2026-09-03

## Context

Forge began as a coding-oriented agent control plane. That focus produced useful
and unusually strong foundations: durable work packages, bounded context,
capability/MCP admission, typed deterministic Operations, canonical outcomes,
capability-reliability evidence, verification goals, approval gates, and an
explicit fail-closed execution boundary.

The current product model nevertheless assumes software-delivery concepts in
many important places: Project is repository-shaped, Task is the primary unit of
intent, the visible role catalogue is coding-oriented, and several lifecycle
surfaces assume Git/file delivery.

Jonathan wants Forge to become his primary orchestrator beyond coding. Workforces
should be installable and reusable for domains such as research and operations.
The replacement must also be substantially more budget-efficient than the
Hermes/HearthBot orchestration experiment.

Hermes provided useful lessons about model tiers, provider failover, scheduling,
conditional notifications, Telegram control, and operational dashboards. Its
implementation also demonstrated failure modes Forge should avoid: token-heavy
parent-agent orchestration, accumulated conversational context, model-driven
polling, and duplicated orchestration state.

The design therefore needs to generalize Forge without discarding the trust work
already built or recreating Hermes inside Forge under a different name.

## Decision

Forge VNext adopts the following product definition:

> **Forge is a local-first, budget-aware, deterministic-first runtime for
> installing, governing, and operating AI Workforces.**

Software Engineering becomes the first official Workforce rather than the
permanent definition of Forge Core.

The detailed architecture and phased programme live in
[`docs/forge-vnext-architecture.md`](../forge-vnext-architecture.md) and
[Epic #333](https://github.com/Joncallim/Forge/issues/333).

### 1. Forge Core has no permanent LLM orchestrator

Scheduling, routing, trigger processing, state transitions, budgeting, policy,
permission checks, retries, recovery, deduplication, and evidence handling are
deterministic software.

Models are ephemeral workers invoked for bounded cognitive tasks. An idle Forge
system must not need a model call merely because time passed.

### 2. Optimize expected cost to a verified outcome

Budget efficiency is a first-class runtime contract.

Forge does not optimize simply for the cheapest model call. Routing is
provider-neutral and deterministic and should minimize expected total cost to a
verified outcome while respecting quality, risk, data-egress, and operator
policy floors.

Per-run token/cost evidence already stored by Forge is extended and aggregated;
a parallel usage truth is not introduced.

No LLM is called solely to select another LLM.

Model ensembles are explicitly deferred from the VNext programme.

### 3. Adopt a generic runtime ontology

The product-wide terms are:

- Mission;
- Execution;
- Workflow;
- Work Package;
- Agent Run;
- Operation;
- Resource;
- Capability;
- Grant;
- Principal;
- Artifact;
- Gate;
- Trigger;
- Budget;
- Policy;
- Workforce.

Current Project and Task concepts remain compatibility surfaces initially. VNext
must not perform a destructive rename or duplicate existing orchestration truth
merely to obtain the new vocabulary.

### 4. Authority belongs to Forge, not agents

A run receives a narrowly scoped, revocable Grant derived from its parent
authority envelope. Child work may reduce authority but cannot expand it.

Resource and Capability are separate. A capability request such as
`github.pr.create` or `mail.send` is not authority until Forge binds it to an
approved resource scope, principal, constraints, policy, and expiry/operation
limits.

Prompt text, Workforce package content, worker output, and external resource
content cannot widen grants.

### 5. Workers produce evidence; trusted gates decide

Reviewer/verifier agents produce structured evidence artifacts. They do not make
an authoritative gate pass simply by asserting success.

Gate decisions are evaluated through versioned Forge policy against evidence and
may result in pass, fail, or human-required states.

This extends the existing rule that a worker is not its own sole authoritative
grader.

### 6. Workforce packages are declarative, not trusted executable plugins

Installable Workforces may define roles, workflows, prompts, schemas, reference
material, evaluations, capability requirements, resource needs, cognitive
requirements, and budget defaults.

Installing a Workforce does not grant it arbitrary code execution or connector
credentials.

Executable capability/connector adapters belong to a separately reviewed trust
boundary and remain subject to Forge operation/grant policy.

### 7. Side effects use explicit uncertainty and reconciliation

External operations may have ambiguous results when transport fails after
submission. Forge must distinguish failed-before-submission from
submission-uncertain and confirmed outcomes.

Adapters should use stable operation identities/idempotency keys where supported
and provide reconciliation/read-after-write behaviour for uncertain outcomes.
Blind retry after ambiguous external submission is not a valid default.

### 8. Behaviour-changing inputs are versioned and pinned

A run must be reconstructable from versioned/digested Workforce, workflow,
prompt/harness, policy, operation/capability, provider/model resolution, resource
snapshot/fingerprint, and input artifact references where those inputs are
material.

Running Missions do not silently adopt a newly installed Workforce revision.
Package permission expansion requires a new decision.

### 9. PostgreSQL remains durable orchestration/evidence truth

Redis remains queue/wakeup/retry/cache transport. It must not become the only
source of truth for Missions, grants, gates, external side effects, or completed
operations.

Existing canonical outcomes, Operation Catalog, capability reliability,
verification-goal records, MCP admission, and related evidence are reused rather
than replaced by VNext duplicates.

### 10. Generalize through a compatibility seam, not a rewrite

VNext first defines generic contracts and maps existing Project/Task coding paths
through them. New functionality is then required to use those contracts.

Software Engineering must prove the generic runtime before it is extracted into
an installable official Workforce. Deep Research then proves non-repository
generality. Infrastructure Ops proves persistent event-driven bounded side
effects.

### 11. Hermes contributes requirements, not implementation

Forge may re-derive useful behaviours learned from Hermes/HearthBot, including:

- cost-aware model tiers;
- role-aware provider routing/failover;
- provider health taxonomy;
- routing receipts;
- scheduled responsibilities;
- deterministic change detection;
- conditional notifications;
- bounded parallel exploration/review;
- actionable dashboards;
- Telegram/HearthBot control.

Forge must not import or depend on Hermes source code, state database, routing
bridge, cron prompts, provider configuration format, parent-agent prompts,
delegation manifests, or runtime APIs.

The final architecture has HearthBot as a thin Forge client/interface and Hermes
absent.

## Relationship To ADR 0007

ADR 0007 remains valid as the runtime-neutral agent/workforce taxonomy for the
current coding product and, ultimately, the Software Engineering Workforce.

ADR 0014 supersedes ADR 0007 **only where ADR 0007's coding-oriented role model
could be read as the universal product ontology**. Forge Core no longer assumes
that Architect/Product/Frontend/Backend/QA/Review/etc. are the only meaningful
agent roles across all Workforces.

The useful separation of provider/runtime, role, harness/overlay, and Workforce
remains compatible with this ADR.

## Relationship To Epic 184

Epic #184 remains the canonical continuous-verification/earned-autonomy
programme.

Delivered #201 (Operation Catalog), #185 (canonical outcomes), and #186
(capability reliability) are direct VNext foundations.

Remaining #187–#191 work must consume or align with the VNext Mission/Resource/
Trigger/Grant contracts where those concepts matter, rather than establishing a
second project-only scheduler, verifier, autonomy truth, or orchestrator.

## Consequences

### Positive

- Forge can expand beyond coding without discarding its trust architecture.
- Idle/persistent operation can be token-free when no reasoning is necessary.
- Model/provider choice becomes replaceable infrastructure rather than package
  identity.
- Workforces can be installed and updated without automatically granting broad
  authority.
- Evidence, authority, cost, and recovery become reconstructable across domains.
- Hermes can be retired cleanly rather than embedded inside Forge.

### Costs

- The compatibility seam adds temporary conceptual complexity while Project/Task
  and Mission/Execution coexist.
- Capability adapters require more rigorous contracts than direct SDK calls.
- Version pinning/provenance and side-effect reconciliation add persistence and
  test burden.
- Some existing project-specific #184 work may need refactoring/resequencing.
- Budget-aware routing requires reliable provider health/cost metadata and
  careful treatment of unknown usage.

These costs are accepted because they prevent much larger coupling and safety
costs later.

## Explicit Non-Goals

This ADR does not authorize or require:

- model ensembles or latent-state bridging;
- arbitrary model-authored shell execution;
- automatic generation of trusted Workforces;
- self-modifying runtime/package code;
- a public Workforce marketplace;
- distributed Forge clustering;
- broad auto-merge/deploy authority;
- enterprise multi-user RBAC;
- broad Forge Workspace UI expansion before runtime proofs;
- Hermes compatibility/import work.

## Validation

This ADR is considered correctly implemented only when the phased acceptance
gates in Epic #333 and `docs/forge-vnext-architecture.md` pass with objective
evidence.

The final three-workforce proof is:

1. Software Engineering safely mutates/delivers code through generic contracts.
2. Deep Research completes non-repository evidence work through the same Core.
3. Infrastructure Ops runs a persistent event-driven responsibility with
   zero-token idle periods and bounded reversible side effects.

Only after those runtime proofs should HearthBot cut over fully to Forge and
Hermes be removed.
