# Forge VNext Architecture Review Record

Date: 2026-09-03  
Scope: Forge VNext product direction, architecture invariants, phase order, Hermes/HearthBot relationship, budget model, installable Workforce design, and compatibility with the live Forge repository.

Reviewed repository state: `main` after `dc78d0e` and the then-current architecture/docs/issues including ADR 0007, ADRs 0010–0013, Epic #184, #187, Operation Catalog/canonical outcome/capability-reliability work, `AGENTS.md`, `README.md`, `docs/roadmap.md`, and `docs/near-term-roadmap.md`.

This is an architecture review, not proof that the implementation already satisfies VNext.

## Review Verdict

Status: **No blockers found in the inspected architecture scope after revision**

Confidence: **High for roadmap/contract direction; medium for implementation feasibility details that deliberately remain phase-level decisions.**

Reason: The original general-agent roadmap contained several material risks: coding assumptions could have been hardened before generalisation, "cheap" routing could have optimized the wrong metric, Workforce packages could have become an executable plugin bypass, persistent Missions lacked distributed-systems/recovery semantics, and Hermes migration risked preserving a second orchestration authority. The plan was revised between review passes to close those design problems. The final architecture reuses Forge's existing trust/evidence foundations and leaves unresolved implementation choices explicitly gated rather than guessed.

## Iterative Findings And Resolutions

### Pass 1 — Contract / product definition

Finding: The first roadmap risked becoming "coding Forge with broader names." Current Project, Task, repository root and coding role assumptions are structurally strong in the live product.

Resolution:

- define Mission/Execution/Resource/Capability/Grant/etc. as product-wide contracts;
- keep Project/Task as compatibility surfaces initially;
- require a non-repository Research proof;
- prohibit fake repository fields for non-coding Missions.

Result: resolved in ADR 0014, #334 and the canonical VNext architecture.

### Pass 2 — Sequencing / architecture coupling

Finding: Finishing all autonomous coding features before defining the generic seam would harden more Git/PR/repository assumptions into Core and make later extraction more expensive.

Resolution:

```text
generic contracts
  -> compatibility seam
  -> budget/control-plane contracts
  -> secure execution
  -> finish Software Engineering through those contracts
  -> extract it as a package
```

This keeps the current product usable without doing a big-bang rewrite.

Result: resolved in #334–#338.

### Pass 3 — Trust / authority

Finding: A role/capability model alone is insufficient for a general agent platform. The plan needed to answer who is acting, on what resource, under which authority, and whether child work can widen that authority.

Resolution:

- add Principal;
- separate Resource from Capability;
- define Grant as scoped authority;
- require Mission → Execution → Work Package → Agent Run → Operation authority intersection;
- add operator kill/revocation semantics;
- make grant changes deterministic policy decisions, not prompt output.

Result: resolved in ADR 0014 and #336.

### Pass 4 — Verification authority

Finding: "Reviewer agent passes gate" creates a confused trust boundary. A model producing a review should not automatically be the authority that declares the evidence sufficient.

Resolution:

```text
reviewer/verifier
  -> evidence artifact
  -> trusted policy gate evaluator
  -> pass / fail / human_required
```

This extends Forge's existing independent-verification principles rather than replacing them.

Result: resolved in ADR 0014, #336 and #337.

### Pass 5 — Budget / token economics

Finding: "Use cheap models" is not a robust budget strategy. A weak cheap model can cost more after repeated failures, remediation and frontier escalation.

Resolution:

Define the optimization objective as:

> minimum expected cost to a verified outcome, subject to a quality/risk floor.

Additional changes:

- deterministic routing rather than an LLM router;
- no always-on parent model;
- zero-token idle requirement;
- hard pre-call budget admission;
- provider-neutral cognitive classes;
- routing receipts;
- context budgets;
- metrics for failed-call burn, remediation, frontier escalation and tokens/cost per verified outcome;
- reuse existing `agent_runs` token/cost truth rather than creating a parallel ledger.

Result: resolved in #335.

### Pass 6 — Context and caching

Finding: Aggressive generic model-output caching looked economical but introduced stale-policy, nondeterminism and provenance risks before a validity contract existed.

Resolution:

- make bounded context packets first-class;
- ephemeral workers do not inherit permanent conversations;
- prioritize content-addressed deterministic reuse for indexes/extracts/validated immutable artifacts;
- defer general cognitive-result caching until explicit validity semantics exist.

Result: resolved in the architecture and #335/#339.

### Pass 7 — Workforce package / supply-chain boundary

Finding: If `forge workforce install` loads arbitrary Python/JavaScript into Forge Core, declarative capability admission becomes largely meaningless because installed package code could bypass the broker.

Resolution:

- Workforces are declarative organisations;
- executable capability adapters are a separate trust class/boundary;
- install does not equal authorize;
- version pinning/provenance/digests are required;
- permission expansion on update requires a new decision;
- operator edits create derived revisions;
- running Missions remain pinned.

Result: resolved in #338.

### Pass 8 — Execution confinement

Finding: The current missing "confined writer" is necessary but not sufficient for a general agent runtime. Filesystem path validation alone cannot protect secrets, network, child processes, resource usage or host services.

Resolution:

The execution envelope must explicitly constrain:

- filesystem mounts/namespaces;
- network egress;
- environment/secrets;
- processes;
- CPU/memory/disk/time;
- stale leases/cancellation;
- resource mutation concurrency.

Result: resolved in #336.

### Pass 9 — External side effects / recovery

Finding: Coding can often use Git state to infer outcomes. General operations such as email, calendar, GitHub and service control have ambiguous submission windows. Blind retry can duplicate side effects.

Resolution:

- explicit submitted/uncertain/confirmed lifecycle;
- stable operation/idempotency identities where available;
- reconciliation/read-after-write before retry when uncertain;
- canonical outcomes/evidence preserved through recovery.

Result: resolved in #336/#342.

### Pass 10 — Persistent Missions / distributed state

Finding: "Continue until success" could become an unbounded recursive agent loop and did not define restart ownership.

Resolution:

- Mission vs Execution split;
- durable checkpoints;
- leases/fencing;
- hard budget/fan-out/depth/retry/time limits;
- quiescent/waiting state with no active model context;
- child agents cannot increase budgets;
- PostgreSQL remains authoritative.

Result: resolved in #340.

### Pass 11 — Trigger/event semantics

Finding: "cron and webhooks" was too shallow. Duplicate events, self-generated feedback loops, event storms and replay could create repeated work or side effects.

Resolution:

- event identity;
- dedupe/replay keys;
- causal ancestry/correlation;
- debounce/coalescing;
- dead-letter recovery;
- self-loop prevention;
- deterministic no-change filter before any model call;
- scheduler backend hidden behind Trigger contract.

Result: resolved in #341.

### Pass 12 — Privacy / provider egress

Finding: Generic Resource access means Forge may read private material and then route it to a third-party model. Capability admission alone does not control that data boundary.

Resolution:

- Resource classification/provider-egress policy;
- resolve provider eligibility before restricted context is assembled;
- model workers do not receive ambient connector credentials;
- adapter logs/evidence must redact sensitive data.

Result: resolved in #335/#336/#342.

### Pass 13 — Parallelism / resource conflicts

Finding: Parallel agents can improve throughput but can also silently corrupt shared resources or waste tokens by rereading the same corpus.

Resolution:

- parallelism is budget/dependency/resource-aware, not ceremonial;
- mutation semantics include read/append/exclusive-write/versioned/transactional concepts;
- one writer per file/resource lane where applicable;
- share validated source/index artifacts rather than independently ingesting all context.

Result: resolved in #336/#337/#339.

### Pass 14 — Proof-workload selection

Finding: Deep Research proves non-code reasoning but is primarily read-heavy. It cannot prove persistent side-effectful autonomy. Personal Ops would prove writes but introduces high-sensitivity email/calendar risks too early.

Resolution:

Use three sequential reference Workforces:

1. Software Engineering — safe mutation + deterministic verification;
2. Deep Research — non-repository reasoning/evidence;
3. Infrastructure Ops — persistent triggers + bounded reversible side effects + zero-token idle.

Personal Ops is deferred until those runtime proofs exist.

Result: resolved in #337, #339 and #343.

### Pass 15 — Hermes migration

Finding: Keeping Hermes as a Forge adapter/fallback would preserve the very token-heavy dual-orchestrator architecture VNext is meant to remove. Running both as writers during migration could duplicate actions.

Resolution:

- Hermes is a requirements/lesson source only;
- no Forge→Hermes fallback;
- one workflow has exactly one writer/authority at a time;
- HearthBot becomes a thin Forge client;
- retire Hermes only after the runtime has proven itself across all three reference Workforces;
- final gate removes services/timers/cron and Hermes-only credentials.

Result: resolved in #344.

### Pass 16 — Existing Forge trust architecture / duplication

Finding: A broad VNext programme could accidentally build new reliability, operation, verification, scheduler or autonomy systems alongside #172/#184 rather than reuse them.

Resolution:

- explicitly retain #201 Operation Catalog, #185 canonical outcomes and #186 capability reliability;
- retain Epic #184 as the trust/autonomy programme;
- require remaining #187–#191 to consume/alignment-check VNext contracts;
- rebase scheduled proof runs/Sentinel on the Trigger substrate where appropriate rather than establishing second truths.

Result: resolved in #333/#334 and ADR 0014.

### Pass 17 — Scope / simplification

Finding: Several attractive features would multiply scope before the architecture is proven.

Deferred:

- ensembles/latent bridges;
- public package marketplace;
- auto-generated trusted Workforces;
- self-modifying runtime;
- distributed clusters;
- broad auto-merge/deployment;
- enterprise multi-user RBAC;
- broad Forge Workspace expansion;
- Personal Ops as an early proof;
- generic arbitrary model-output caching.

Result: VNext remains large but dependency-ordered and testable.

## Orthogonal Pass Coverage

| Pass | Checked | Findings | Remaining uncertainty |
|---|---:|---:|---|
| Contract / requirements | Yes | 2 material | Exact UI vocabulary migration remains phase-specific |
| Repository/current architecture | Yes | 3 material | Implementation must re-check live repo at each phase |
| State / data / persistence | Yes | 2 material | Exact Mission/Execution schema/migration deliberately not frozen |
| Error handling / recovery | Yes | 3 material | Connector-specific reconciliation capabilities vary |
| Tests / verification | Yes | 2 material | Conformance suite is planned, not implemented |
| Security / permissions / secrets | Yes | 5 material | Exact sandbox and adapter process technology deliberately not frozen |
| Budget / model economics | Yes | 4 material | Cost metadata freshness/source requires phase ADR |
| UX / operator experience | Yes | 2 advisory | Exact dashboard surfaces remain deferred |
| Regression / compatibility | Yes | 3 material | Compatibility seam needs code-level proof |
| Supply chain / packages | Yes | 3 material | Exact manifest/dependency resolver syntax remains open |
| Concurrency / scalability | Yes | 2 material | Distributed multi-host Forge is explicitly deferred |
| Hermes cutover | Yes | 3 material | Live Hermes inventory belongs to final cutover phase |
| Scope / simplification | Yes | 1 material | Future features should be re-reviewed against non-goals |

## Required Next Actions

The architecture is frozen into the VNext programme. Implementation should start
with #334 and must not skip directly to new Workforces or Hermes cutover.

Before each phase is marked complete:

1. inspect current `main`, not this review snapshot;
2. map the phase against this ADR/architecture and its GitHub acceptance criteria;
3. run relevant conformance tests plus normal release gates;
4. run a fresh orthogonal review after fixes;
5. record residual risk rather than treating model confidence as proof.

## Remaining Open Implementation Decisions

These are not architecture blockers; they are intentionally deferred because the
correct choice depends on implementation evidence:

- exact Mission/Execution database migration strategy;
- exact OS confinement technology and first supported host;
- exact package manifest/DSL;
- exact provider cost metadata source/update mechanism;
- exact executable capability-adapter isolation/RPC boundary;
- exact resource-classification taxonomy;
- exact scheduler backend;
- whether and how verified cognitive result reuse is ever safe.

Each should receive an ADR or explicit issue-level design when its phase begins.

## Final Statement

> No blockers were found in the inspected architecture scope after the iterative revisions above. This does not prove absence of defects. The remaining unchecked areas are implementation-specific behaviour, live-host confinement, connector-specific external semantics, migrations, and empirical cost/quality performance. Those uncertainties are now explicit phase gates rather than hidden assumptions.