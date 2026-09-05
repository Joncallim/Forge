# Forge Product Roadmap

Last updated: 2026-09-03

This is the canonical **product-roadmap view** for Forge.

For the full architecture and invariants, read
[`forge-vnext-architecture.md`](forge-vnext-architecture.md) and
[ADR 0014](adr/0014-forge-vnext-general-agent-runtime.md).
For exact implementation order and release gates, read
[`near-term-roadmap.md`](near-term-roadmap.md).
The programme is tracked by
[Epic #333](https://github.com/Joncallim/Forge/issues/333).

The repository history preserves the earlier coding/Workspace roadmap. Its
forward-looking priority is superseded by Forge VNext.

## Current Product Truth

Forge is still a coding-focused, single-operator beta today. The current product
has substantial planning, work-package, admission, operation, outcome, evidence,
and reliability foundations, but it is **not yet** the general agent runtime
described below.

The current execution boundary remains fail-closed where a safe OS-enforced
execution mechanism has not yet been proven. Do not read this roadmap as a claim
that future Workforces, persistent Missions, broad connectors, or autonomous
writes already ship.

Current capability details belong in `README.md`, `docs/wiki.md`, the operator
and developer guides, and the live implementation. Repository state beats roadmap
aspiration.

## Product North Star

> **Forge is a local-first, budget-aware, deterministic-first runtime for
> installing, governing, and operating AI Workforces.**
>
> Install a Workforce. Bind the resources it may use. Grant bounded
> capabilities. Give it a Mission. Forge handles deterministic orchestration,
> budgeting, delegation, execution, verification, evidence, recovery, and
> escalation.

Software Engineering is the first flagship Workforce. It is not the permanent
definition of Forge Core.

## Product Principles

1. **No permanent LLM parent agent.** Models are ephemeral workers. Scheduling,
   routing, policy, budgets, state, retries, recovery, triggers, and evidence are
   deterministic software.
2. **Zero-token idle.** Persistent monitoring or waiting should consume no model
   tokens when nothing meaningful changes.
3. **Cost to verified outcome.** Forge optimizes expected total cost under a
   quality/risk floor, not simply the cheapest individual model call.
4. **Forge owns authority.** Agents receive narrowly scoped, revocable grants
   and cannot widen them.
5. **Resource is not Capability.** Authority is always tied to a resource scope,
   Principal, constraints, and policy.
6. **Evidence before trust.** Workers and reviewers produce evidence; trusted
   Forge gates make authoritative decisions.
7. **Declarative Workforces.** Installing a Workforce does not grant arbitrary
   executable plugin code or connector credentials.
8. **Explicit side-effect recovery.** Ambiguous external writes reconcile before
   retry instead of risking duplicate actions.
9. **Versioned and pinned behaviour.** Workforce, workflow, prompt, policy,
   operation, provider/model resolution, resource versions, and evidence remain
   reconstructable for a run.
10. **No big-bang rewrite.** Current Project/Task coding flows stay compatible
    while generic VNext contracts are introduced underneath them.
11. **Reuse existing trust foundations.** MCP admission, typed Operations,
    canonical outcomes, capability reliability, verification goals, and Epic
    #184 are extended rather than duplicated.
12. **Hermes contributes lessons, not implementation.** No Hermes runtime,
    state/config compatibility, routing bridge, parent-agent architecture, or
    Forge-to-Hermes fallback belongs in the target system.
13. **No model ensembles in this programme.** Ensemble/voting and latent-model
    bridging remain explicitly deferred.

## Canonical VNext Concepts

- **Mission** — durable desired outcome or responsibility.
- **Execution** — one bounded attempt/cycle pursuing a Mission.
- **Workflow** — reusable orchestration template.
- **Work Package** — dependency-scoped unit of work.
- **Agent Run** — one bounded model/agent invocation.
- **Operation** — concrete deterministic read/write action.
- **Resource** — repository, file set, corpus, mailbox, service, database, etc.
- **Capability** — class of action that may be allowed.
- **Grant** — Capability + Resource scope + constraints + policy for a Principal.
- **Principal** — identity acting in Forge.
- **Artifact** — durable versioned output/evidence with provenance.
- **Gate** — trusted policy decision over evidence.
- **Trigger** — event/condition requesting an Execution.
- **Budget** — hard/soft limits on spend, tokens, calls, time, retries, and
  concurrency.
- **Policy** — versioned deterministic rule set.
- **Workforce** — versioned organisation of roles, workflows, prompts, schemas,
  policies, and evaluations.

Project and Task remain compatibility/UI concepts during migration. A non-coding
Mission must not require fake Git/repository fields.

## Roadmap

The order is dependency-significant. A later phase may prototype, but it cannot
claim completion by bypassing an earlier safety or contract gate.

| Phase | Issue | Product outcome |
|---|---:|---|
| 0 | [#334](https://github.com/Joncallim/Forge/issues/334) | Generic runtime contracts and a compatibility seam around today's coding product. |
| 1 | [#335](https://github.com/Joncallim/Forge/issues/335) | Deterministic budgets, provider routing, context economics, and routing receipts. |
| 2 | [#336](https://github.com/Joncallim/Forge/issues/336) | Secure generic execution envelope, authority lineage, typed admission, and side-effect recovery. |
| 3 | [#337](https://github.com/Joncallim/Forge/issues/337) | Software Engineering proves end-to-end safe delivery through the generic runtime. |
| 4 | [#338](https://github.com/Joncallim/Forge/issues/338) | Software Engineering becomes the first declarative installable Workforce package. |
| 5 | [#339](https://github.com/Joncallim/Forge/issues/339) | Deep Research proves non-repository reasoning, evidence, and provider-egress controls. |
| 6 | [#340](https://github.com/Joncallim/Forge/issues/340) | Persistent Missions, checkpoints, leases, quiescence, and bounded autonomy. |
| 7 | [#341](https://github.com/Joncallim/Forge/issues/341) | Trigger/Event runtime with authentication, dedupe, causality, loop prevention, and zero-token idle. |
| 8 | [#342](https://github.com/Joncallim/Forge/issues/342) | General Resource/Capability adapter plane with brokered credentials and recovery semantics. |
| 9 | [#343](https://github.com/Joncallim/Forge/issues/343) | Infrastructure Ops proves persistent event-driven bounded side effects. |
| 10 | [#344](https://github.com/Joncallim/Forge/issues/344) | HearthBot cuts over to Forge and Hermes is completely retired. |

## Three Reference Workforces

Forge should prove the runtime with three deliberately different Workforces
before expanding the catalogue broadly.

### Software Engineering

Proves safe mutation and deterministic verification:

```text
Mission
  -> plan
  -> bounded implementation
  -> deterministic validation
  -> independent review evidence
  -> trusted gates
  -> remediation
  -> branch + commit + PR
```

General auto-merge is not required.

### Deep Research

Proves the runtime is not repository-shaped:

- web/document Resources;
- bounded parallel discovery where useful;
- evidence provenance;
- contradiction and uncertainty handling;
- citation/claim validation;
- prompt-injection resistance;
- provider/data-egress policy;
- non-code Artifacts.

The release proof must run without a fake Project/Git record.

### Infrastructure Ops

Proves persistent, triggered, side-effectful autonomy:

```text
deterministic health probe
  -> healthy/unchanged -> no model call
  -> meaningful failure
       -> deterministic remediation where possible
       -> bounded cognition only if needed
       -> typed reversible action
       -> verification
       -> escalation when policy requires
```

This is intentionally a safer third proof than granting early Personal Ops
access to sensitive email/calendar workflows.

## Budget Direction

Forge should use three computational tiers:

- **Tier 0 — deterministic/no model:** scheduling, health, state, routing,
  budgets, permissions, hashing, recovery, dedupe, evidence calculations.
- **Tier 1 — economical cognition:** extraction, triage, mechanical work,
  routine review, summarisation, bulk processing.
- **Tier 2 — stronger cognition:** architecture, difficult diagnosis, conflicting
  evidence, security-sensitive analysis, repeated lower-tier failure, high-value
  synthesis.

Workforces request provider-neutral cognitive requirements rather than hard-coded
vendor models. The deterministic router resolves them against provider health,
budget, data-egress policy, operator policy, and comparable reliability evidence.

Hard budgets are checked before provider calls and must remain safe under
concurrent reservations. Unknown provider cost remains unknown; Forge must not
forge unknown usage into zero or pretend an unenforceable spend ceiling is hard.

## Installable Workforce Direction

A Workforce package is a declarative organisation containing concepts such as:

- roles/agents;
- workflows;
- prompts/reference material;
- schemas;
- additive gates/evaluations;
- required/optional capabilities;
- supported Resource types;
- cognitive requirements;
- budget defaults;
- version/provenance/dependency metadata.

Install does not mean authorize. Package policies cannot weaken mandatory Forge,
system, or operator ceilings. Transitive dependencies are pinned and included in
permission review. Running Missions stay pinned to the revision they started
with.

Distribution starts with local and pinned-Git sources. A public registry is a
later product/supply-chain decision.

## Hermes / HearthBot End State

Keep the useful lessons:

- economical/strong model tiers;
- role-aware deterministic routing/failover;
- actionable provider health, including auth/quota/rate-limit states;
- durable routing receipts;
- deterministic monitoring before model invocation;
- scheduled responsibilities and conditional notifications;
- bounded fan-out and independent review;
- actionable dashboards;
- Telegram/HearthBot as a convenient interface.

Do not import:

- Hermes source code or runtime;
- Hermes state database/model;
- parent-agent prompts;
- cron prompts;
- routing implementation;
- provider configuration format;
- delegation-manifest semantics;
- a Forge-to-Hermes fallback path.

Final target:

```text
HearthBot / Web / CLI / API
          |
        Forge
          |
Mission + Workforce runtime
          |
Capability / Operation plane
```

During migration, each external workflow has exactly one writer/authority at a
time. Hermes is fully removed after the three runtime proofs pass.

## Existing Trust Programme

Do not build a second reliability/autonomy system.

Epic [#184](https://github.com/Joncallim/Forge/issues/184) remains the canonical
continuous-verification/earned-autonomy programme. VNext directly reuses:

- #201 — deterministic Operation Catalog;
- #185 — canonical execution outcomes;
- #186 — capability reliability ledger;
- #187 — verification-goal registry foundations already delivered.

Remaining #187–#191 work must align with VNext. Scheduled proof runs and
Sentinel-style checks should ultimately consume the Trigger/Event substrate
rather than create a separate scheduler or orchestration truth.

## Broad Workspace Expansion

Forge Workspace remains a useful future interface direction, but broad dockable
Workspace expansion is **not the next architectural priority**. Small UI work
that directly supports evidence, recovery, budgets, permissions, or current phase
release gates may proceed. Broad Workspace surface area waits until the VNext
runtime contracts and core proof Workforces justify it.

The historical Workspace proposal remains in `docs/workspace-roadmap.md` as
reference material.

## Explicitly Deferred

- model ensembles and latent-model bridging;
- automatic generation of trusted Workforces;
- self-modifying runtime/Workforce code;
- arbitrary model-authored shell authority;
- public Workforce marketplace/registry;
- distributed Forge clusters;
- broad auto-merge/deployment authority;
- enterprise multi-user RBAC;
- broad Forge Workspace expansion;
- Personal Ops/email/calendar autonomy as an early proof;
- generic arbitrary model-output caching without explicit validity semantics.

## Programme Success

VNext is proven when:

1. Software Engineering safely delivers code through the generic contracts.
2. Deep Research completes non-repository evidence work through the same Core.
3. Infrastructure Ops owns a persistent bounded responsibility with zero-token
   idle periods and verified reversible side effects.
4. Budgets, routing, grants, evidence, recovery, and version pinning are
   reconstructable and enforced.
5. Restart/replay cannot silently duplicate confirmed side effects.
6. Workers cannot widen their own authority or self-grade into trust.
7. HearthBot operates as a thin Forge interface.
8. Hermes is no longer required and is fully removed.

At that point Forge is no longer a coding orchestrator with extra integrations.
It is a general agent runtime with Software Engineering as one installed
Workforce.

## Normative Specifications

The VNext programme is governed by a set of normative specifications in `docs/specs/`. These define what Forge MUST do across all components.

| Spec | Title | Key contribution |
|---|---|---|
| SPEC-0001 | Specification Authoring Standard | Structure and conventions for all specs |
| SPEC-0002 | Runtime Contract v1 | Canonical ontology, lifecycle states, identity rules |
| SPEC-0003 | Authorization & Grants v1 | PARC model, default-deny, child Grant constraint |
| SPEC-0004 | Operation & Side-Effect Semantics v1 | Operation Catalog, idempotency, reconciliation |
| SPEC-0005 | Resource Classification, Data Egress & Secrets v1 | Classification levels, egress authorization, credential brokering |
| SPEC-0006 | Model Invocation & Cost Contract v1 | Budget hierarchy, provider routing, cost telemetry |
| SPEC-0007 | Error & Reason Codes v1 | Namespaced reason codes, error contract |
| SPEC-0008 | Conformance Test Standard v1 | Test classes C1-C8, failure injection requirements |
| SPEC-0009 | Trigger/Event Envelope v1 | CloudEvents compatibility, causality, loop prevention |
| SPEC-0010 | Workforce Package v1 | Declarative package format, install vs authorize |
| SPEC-0011 | Provenance & Supply Chain v1 | Content addressing, tamper detection |
| SPEC-0012 | Observability vs Audit v1 | Audit primacy, telemetry privacy |
| SPEC-0013 | Agentic Threat Model v1 | Threat-to-control mapping against OWASP/NIST |
| SPEC-0014 | Migration & Compatibility v1 | EXPAND→BACKFILL→SHADOW→SWITCH→VERIFY→CONTRACT |
| SPEC-0015 | Reliability / SLO Profile v1 | Hard invariants, SLI baselining |

Issue bodies should reference these specs instead of redefining cross-cutting semantics.

For the frozen-vs-open distinction, see `docs/frozen-vs-open.md`. For the implementation checklist, see `docs/implementation-checklist.md`. For the industry standards matrix, see `docs/industry-benchmark-matrix.md`.
