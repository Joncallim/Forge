# Forge VNext — General Agent Runtime Architecture

Status: **Accepted product direction for Epic #333**
Date: 2026-09-10

This document defines the long-term architecture and implementation order for
Forge VNext.

Forge is still a coding-focused single-operator beta today. This document does
**not** claim the capabilities below already exist. It defines the contracts
that new work must converge on while the current coding product keeps working.

The VNext programme is tracked by [Epic #333](https://github.com/Joncallim/Forge/issues/333).
The architectural decision is recorded in
[ADR 0014](adr/0014-forge-vnext-general-agent-runtime.md).

## North Star

> **Forge is a local-first, budget-aware, deterministic-first runtime for
> installing, governing, and operating AI Workforces.**
>
> Install a Workforce. Bind the resources it may use. Grant bounded
> capabilities. Give it a Mission. Forge handles orchestration, budgeting,
> delegation, execution, verification, evidence, recovery, and escalation.

Software Engineering is the first flagship Workforce. It is not the permanent
definition of Forge.

The target is not a smarter chatbot that happens to launch other chatbots. The
target is an agent runtime in which ordinary software does ordinary software
work and models are invoked only when judgement is actually needed.

## The Most Important Design Choice

Forge Core must not contain a permanent LLM parent agent.

```text
Bad target

user / timer / event
       |
       v
always-on parent model
       |
       +--> chooses models
       +--> checks state
       +--> decides whether anything changed
       +--> coordinates workers
       +--> retries work
       +--> rewrites handoff context
       +--> burns context and tokens
```

VNext instead uses:

```text
user / timer / event
       |
       v
+---------------------------+
| deterministic Forge Core  |
|---------------------------|
| state machine             |
| Workflow readiness/kernel |
| scheduler / triggers      |
| routing policy            |
| context selection         |
| budget policy             |
| permission broker         |
| operation catalog         |
| recovery / reconciliation |
| evidence / gates          |
+---------------------------+
       |
       | only when cognition is required
       v
  ephemeral model worker
       |
       v
 structured artifact/evidence
```

An idle Forge installation should consume **zero model tokens** merely because
wall-clock time passes. Routine Work Package sequencing and handoff should also
consume zero model tokens.

## Product Layers

```text
+--------------------------------------------------------------+
| Interfaces                                                   |
| Web UI | CLI | API | HearthBot/Telegram | future clients     |
+--------------------------------------------------------------+
| Mission + Workforce Runtime                                  |
| Missions | Executions | workflows | work packages | gates    |
+--------------------------------------------------------------+
| Deterministic Control Plane                                  |
| state | workflow kernel | context selection | policy         |
| budgets | routing | triggers | recovery | evidence           |
| leases | audit | version pinning                             |
+--------------------------------------------------------------+
| Resource + Capability Plane                                  |
| filesystem | GitHub | browser | MCP | mail | calendar | DB   |
| capability admission | credential broker | egress policy     |
+--------------------------------------------------------------+
| Execution Plane                                              |
| confined workers | ACP/API/local models | typed operations   |
+--------------------------------------------------------------+
```

The interfaces may change. The control-plane boundaries should not.

## Core Invariants

These are architecture rules, not suggestions.

### 1. Models are workers, not the operating system

Scheduling, Workflow readiness, routine handoff, routing, retry policy, budgets,
trigger processing, state transitions, permission checks, recovery,
deduplication, and evidence handling are deterministic software.

A model may propose a plan, decomposition or operation request. It does not
become the final policy authority because it wrote convincing prose, and it does
not need to rewrite predecessor output merely to hand work to another model.

### 2. Agents never possess authority

Forge possesses authority and lends narrowly scoped, revocable grants to a
specific execution principal.

A child scope is always an intersection/subset of its parent scope.

```text
Operator/workspace ceiling
        |
        v
Mission grant envelope
        |
        v
Execution subset
        |
        v
Work Package subset
        |
        v
Agent Run subset
        |
        v
Operation admission
```

No prompt, Workforce package, reviewer, adapter, or child worker may widen this
chain.

### 3. Resource and Capability are different things

A Resource is the thing Forge may reason about or affect.

Examples:

- a Git repository;
- a directory;
- a document corpus;
- a mailbox or thread;
- a calendar;
- a database;
- a service;
- a web source set.

A Capability is a class of action.

Examples:

- `filesystem.read`;
- `filesystem.write`;
- `github.pr.create`;
- `mail.send`;
- `calendar.event.create`;
- `service.restart`.

A Grant therefore means approximately:

```text
Capability
+ Resource scope
+ constraints
+ policy version
+ expiry / operation bounds
+ Principal
```

A package requesting `mail.send` is not the same as a package receiving
permission to send from every mailbox to every recipient.

### 4. Workers produce evidence; gates decide

A Reviewer agent can produce a Review Artifact. It cannot make the Review Gate
true merely by returning `PASS`.

```text
Reviewer / verifier
       |
       v
structured evidence artifact
       |
       v
trusted gate evaluator
       |
       +--> pass
       +--> fail
       +--> human required
```

This extends Forge's existing principle that workers do not become the sole
graders of their own work.

### 5. Workforces are declarative organisations

A Workforce package describes an organisation and its operating contracts. It
is not a trusted executable plugin.

The package may contain:

- roles/agents;
- workflows and dependency definitions;
- prompts and references;
- input/output schemas;
- gates/evaluations;
- required and optional capabilities;
- supported resource types;
- cognitive/model-class preferences;
- budget defaults;
- package metadata and provenance.

It must not gain arbitrary host execution simply because the user installed it.
Executable capability adapters live behind a separately reviewed Forge
boundary.

### 6. External writes are uncertain until proven otherwise

Network failures can happen after a remote system accepted a request. Forge
must not interpret every connection failure as "nothing happened; retry it."

Side-effect adapters need explicit lifecycle and recovery semantics such as:

```text
not_started
submitted / possibly_submitted
confirmed
failed_before_submission
submission_uncertain
reconciled_success
reconciled_failure
```

Where supported, use operation identities/idempotency keys. Where the remote
system cannot guarantee idempotency, Forge must reconcile or require operator
review before retrying.

### 7. Behaviour-changing inputs are versioned and pinned

A completed or running execution must be reconstructable from the things that
could materially change its behaviour:

- Forge version;
- Workforce package version/digest;
- workflow revision;
- role/prompt/harness revision;
- policy revision;
- capability/operation version;
- resolved provider/model and configuration;
- resource versions/fingerprints where available;
- input artifact ids/digests;
- context compiler/selection revision and delivered packet identity where a
  model was invoked.

Installing Workforce v1.5 must not silently change a Mission already running on
v1.4.

### 8. Evidence and important artifacts are immutable by revision

Do not silently overwrite evidence that a gate or autonomy decision already
consumed. Create a later revision/artifact and preserve provenance.

This follows the same evidence-first direction as Forge's canonical outcomes,
Operation Catalog, capability reliability ledger, and verification-goal
registry.

### 9. PostgreSQL remains orchestration truth

Redis may wake workers, carry retry scheduling, and hold reconstructable cache
state. It must not become the only place that knows whether a Mission,
Execution, Work Package, Agent Run, Grant, Gate, or external operation really
happened.

A graph/framework checkpoint store, mutable workflow-state document, or model
conversation must not become a second source of readiness or execution truth.

### 10. No big-bang VNext rewrite

Current Project/Task behaviour remains supported through a compatibility seam.
New generic contracts are introduced underneath/alongside the existing product,
then new features are required to use them.

Do not duplicate the current task, work-package, operation, outcome, or evidence
truth merely to obtain cleaner names.

## Canonical Ontology

| Term | Meaning |
|---|---|
| **Mission** | Durable desired outcome or responsibility. It may be finite or persistent. |
| **Execution** | One bounded attempt/cycle pursuing a Mission. |
| **Workflow** | Reusable orchestration template. |
| **Work Package** | Dependency-scoped unit of work inside an Execution and the durable handoff unit between workflow stages. |
| **Agent Run** | One bounded invocation of a model/agent runtime consuming freshly compiled context. |
| **Operation** | Concrete deterministic action/read performed by Forge or an adapter. |
| **Resource** | Thing Forge can read, reason about, or affect. |
| **Capability** | Class of action that may be permitted. |
| **Grant** | Capability applied to resource scope under constraints/policy for a Principal. |
| **Principal** | Identity acting in Forge: operator, Mission, run, trigger, adapter, verifier, system controller, etc. |
| **Artifact** | Durable output/evidence with provenance and revision/digest. |
| **Gate** | Trusted policy decision over evidence. |
| **Trigger** | Event/condition requesting an Execution. |
| **Budget** | Hard and soft limits governing spend, calls, tokens, time, retries, concurrency, etc. |
| **Policy** | Versioned deterministic rules that constrain routing, grants, gates, budgets, egress, autonomy, or recovery. |
| **Workforce** | Versioned organisation of roles, workflows, prompts, schemas, policies and evaluations. |

There is deliberately no separate canonical `Handoff` entity. A handoff is a
runtime transition from a ready Work Package through governed context
compilation into an Agent Run. This avoids creating another orchestration record
that can disagree with Work Package or Artifact state.

### Compatibility With Today's Product

Do not immediately rename or delete today's concepts.

Initial mapping:

```text
Current Project
  -> coding compatibility surface
  -> one or more repository/filesystem Resource bindings

Current Task
  -> finite coding compatibility surface
  -> Mission/Execution representation through the VNext seam

Current Work Package / Agent Run / Artifact / Gate / Operation
  -> reuse as existing durable primitives where contracts fit
```

A future non-coding Mission must be representable without inventing a fake Git
repository or local project path.

## Budget And Model Economics

### The objective is not "cheapest model"

The useful quantity is:

> **Expected cost to a verified outcome, subject to a required quality floor.**

A cheap model that fails three times and requires a frontier repair may be more
expensive than one stronger initial call. Forge should measure this rather than
optimising sticker price alone.

### Three computational tiers

#### Tier 0 — no model

Use deterministic code for:

- schedules/events;
- health probes;
- deduplication;
- state transitions;
- Workflow readiness, fan-out and joins;
- provider readiness;
- budget checks;
- routing;
- context reference selection and limits;
- permission/policy checks;
- hashing/index invalidation;
- retry/recovery decisions;
- canonical evidence calculations.

This tier should handle routine idle orchestration and ordinary Work Package
handoff.

#### Tier 1 — economical cognition

Use economical/local models for bounded tasks such as:

- classification;
- extraction;
- source triage;
- mechanical implementation;
- routine review;
- summarisation;
- large-volume evidence processing.

#### Tier 2 — stronger cognition

Use standard/frontier models when the task/risk/evidence justifies it:

- architecture;
- difficult diagnosis;
- conflicting evidence;
- security-sensitive analysis;
- repeated lower-tier failure;
- high-value synthesis.

There is deliberately no ensemble/voting tier in this programme.

### Provider-neutral cognitive requirements

A Workforce should prefer declarations such as:

```yaml
cognition:
  class: economy
  reasoning: medium
  context: high
```

rather than hard-coding one vendor model.

The deterministic router resolves this against operator policy, provider health,
available budget, data-egress policy, and observed evidence.

### Budget hierarchy

At minimum:

```text
Workspace ceiling
     -> Workforce defaults
          -> Mission budget
               -> Execution reservation / consumption
                    -> Agent Run actual usage
```

Hard limits can include:

- USD/equivalent cost where known;
- input/output/total tokens;
- model calls;
- frontier calls;
- child work packages/depth;
- retries;
- concurrency;
- wall-clock duration.

Budgets are checked before a provider call. No agent may increase its own
budget.

### Required cost telemetry

Forge already stores per-run input tokens, output tokens, and cost when
available. VNext should aggregate/reconcile that truth instead of inventing a
parallel usage ledger.

Important metrics:

- Mission/Execution cost;
- tokens per verified outcome;
- cost of failed/refused/blocked calls;
- retry/remediation cost;
- frontier escalation rate;
- deterministic/no-model completion rate;
- context size by run;
- reusable validated artifact/index hit rate;
- budget holds/stops.

Unknown usage is **unknown**, not forged into zero.

## Routing And Provider Health

Routing is deterministic software, not another LLM call.

A routing decision should consider:

- requested cognitive class/requirements;
- provider/model eligibility;
- auth/readiness;
- quota exhaustion;
- rate limiting;
- data-egress restrictions;
- cost/budget ceiling;
- versioned operator/workforce policy;
- scoped reliability evidence when comparable.

Each resolved model run gets a routing receipt recording enough information to
explain why that provider/model was chosen or why fallback/escalation occurred.

## Context And Data Handling

### Agents are ephemeral

An agent run should resemble a bounded function invocation:

```text
validated context packet
       -> model/runtime
       -> structured artifact
       -> runtime context can disappear
```

Durable memory belongs in Forge state, resources and artifacts, not in one
permanent conversation transcript.

### Context planning is reference-first

Before restricted payload is assembled, Forge builds an inspectable context
selection manifest from safe metadata and authoritative references. The exact
implementation name is owned by #335; `ContextManifest` is the working term.

It should identify:

- the Mission/Execution/Work Package/Agent Run intent;
- required and optional Resource/Artifact/evidence references;
- exact revisions/digests/fingerprints where available;
- classification and trust class;
- selection and stable exclusion/rejection reasons;
- byte/token/item estimates and ceilings;
- required output schema/reference;
- context compiler/policy revision.

The manifest is not another handoff database. Large predecessor outputs remain
Artifacts/Resources and are referenced rather than copied into a durable prose
relay.

### Context packets are first-class

After destination/provider/egress/budget admission, the ContextCompiler
materializes the exact packet for one Agent Run. A worker receives only the
minimum useful content selected from the manifest:

- Mission/Work Package summary;
- relevant resource references/extracts;
- constraints and acceptance criteria;
- grants/capability descriptions;
- relevant prior artifacts/evidence;
- required output schema;
- budget/context ceiling.

External text is labelled untrusted data. It does not become Forge policy just
because it contains instructions. Unrelated predecessor output and private model
reasoning/transcripts are not inherited by default.

The delivered packet has an identifiable version/digest/provenance record under
retention/redaction policy. Required missing, stale, oversized or policy-
ineligible context fails closed; optional exclusion must be deterministic and
inspectable.

### Data egress is a policy boundary

A Resource may carry a classification such as public/internal/confidential or a
more specific operator policy. Provider policy may be local-only,
approved-cloud, or otherwise constrained.

Provider resolution happens before confidential content is assembled into a
prompt for an ineligible provider.

### Reuse carefully

Early VNext should favour content-addressed deterministic reuse:

- resource indexes;
- file/document extraction;
- hashes/fingerprints;
- validated immutable artifacts.

Do not make arbitrary model-output caching an early dependency. Cognitive
outputs may be nondeterministic, stale, policy-sensitive, or unsafe to reuse.
Any later reusable-result mechanism needs explicit validity semantics.

## Deterministic Workflow Execution And Handoff

Forge needs graph-shaped workflow capability, but it does not need a model or
third-party agent framework to become the authority for that graph.

### Work Package is the handoff unit

The runtime transition is:

```text
ready Work Package
  -> deterministic context-reference selection
  -> #335 provider/egress/budget admission
  -> exact bounded ContextPacket
  -> Agent Run or deterministic Operation
  -> structured Artifact/evidence
  -> deterministic Workflow advancement
```

A supervisor model may still be invoked when genuine judgement is required —
for example, to propose a different decomposition after repeated failure — but
ordinary sequencing and relay are not cognitive tasks.

### Workflow v1 is a DAG

The first generic Workflow kernel (#367) should support a versioned directed
acyclic graph (DAG):

- node/Work Package definitions;
- dependency edges;
- deterministic entry/readiness rules;
- bounded fan-out;
- deterministic joins;
- existing Gate and Execution `waiting` semantics;
- expected input/output Artifact/schema requirements;
- bounded retry/remediation policy references.

Cycles, dangling edges and impossible joins fail before execution. Rework is
represented by explicit attempt/revision lineage under hard remediation limits,
not unrestricted graph cycles. Persistent repeated responsibility belongs to
Mission/Execution/Trigger semantics later in the roadmap.

### State stays in canonical Forge entities

The Workflow kernel calculates readiness from authoritative Mission, Execution,
Work Package, Artifact, Gate, Grant, Budget and lease state. It does not own a
second generic mutable state document.

Parallel branches may execute when dependencies, budget/capacity and Resource
mutation policy allow it. #367 owns dependency/readiness/fan-out/join mechanics;
#336 owns OS confinement and mutation conflict enforcement. Both consume #335,
and they can be implemented in parallel after it.

#337 is the first production convergence: Software Engineering must use both the
#367 Workflow kernel and #336 secure execution boundary rather than a coding-only
sequencer.

### Framework boundary

LangGraph or another graph/agent framework may be evaluated later as an optional
runtime adapter only if it remains subordinate to Forge's canonical state,
context, Grant, Operation, Artifact and Gate contracts. Its checkpoint store or
agent-to-agent protocol must not become a second orchestration authority.

## Secure Execution Envelope

Path validation is not an OS sandbox.

The first supported mutation backend must explicitly control:

- filesystem mounts/namespaces;
- read/write resource bindings;
- symlink/path escape;
- network/egress;
- environment/secret exposure;
- child processes;
- CPU/memory/disk/time limits;
- cleanup and cancellation;
- stale worker leases/fencing.

Default posture for an ordinary worker should trend toward:

```text
no broad network
no ambient secrets
no broad host write
only required bounded host/resource read
```

Capability adapters can receive narrowly brokered credentials outside the model
process where possible.

## Resource Concurrency

Parallelism is valuable only when the resource model makes it safe.

Operations should be able to express mutation semantics such as:

- read;
- append;
- exclusive write;
- compare-and-swap/versioned write;
- transactional operation where supported.

The scheduler/resource broker prevents conflicting writers rather than hoping
two agents do not edit the same thing.

For Software Engineering, one isolated branch/worktree or writer lane per
mutation scope is the natural first proof.

## Workforce Packages

### Package shape

Exact syntax belongs to Phase 4, but the package needs the following semantic
parts:

```text
workforce/
  manifest
  agents-or-roles/
  workflows/
  prompts-and-references/
  schemas/
  policies/
  evaluations-or-gates/
  README
```

The manifest should cover:

- package id/version/schema;
- compatible Forge version;
- capabilities/resources requested;
- cognitive requirements;
- budget defaults;
- workflows/roles;
- package provenance/digest;
- dependencies if genuinely necessary.

Package Workflow definitions execute through the generic #367 kernel. A package
must not gain its own hidden orchestration runtime simply because it contains a
workflow description.

### Install does not mean authorize

```text
install
  -> validate/pin package
  -> inspect requested capabilities
  -> operator/policy decision
  -> activate under ceilings
```

A new package version that requests broader authority needs a new permission
review.

### Updates do not mutate running Missions

Running work stays pinned. Operator edits create an explicit local derived
revision/overlay; they do not silently impersonate the upstream package version.

### Distribution starts local/Git

Prove local and pinned Git installation/update/rollback before building a public
registry or marketplace.

Package signatures can prove provenance. They do not prove that a package is
safe.

## Persistent Missions

A persistent Mission is not a persistent model session.

It owns durable intent and policy and may produce many bounded Executions.
It can be:

- running;
- waiting/quiescent;
- blocked;
- approval-required;
- paused;
- completed/failed/cancelled where the Mission is finite.

Persistent Missions need:

- checkpoints;
- leases/fencing;
- hard budgets;
- child-depth/fan-out limits;
- cancellation/revocation;
- durable escalation reasons;
- concise validated prior-state artifacts.

A Mission waiting for tomorrow's event should have no active model context and
consume no tokens.

## Trigger And Event Runtime

Triggers are more than cron strings.

A Trigger occurrence needs identity and causality so Forge can deduplicate and
prevent loops:

- trigger definition/version;
- source/principal;
- occurrence/event id;
- time;
- dedupe/replay key;
- causal parent operation/event;
- Mission correlation id;
- processing/retry state.

Use deterministic filters/detectors before waking a model.

This avoids expensive patterns such as:

```text
every hour -> model -> "nothing changed"
```

and dangerous loops such as:

```text
Forge sends email
  -> sent-email event
  -> Forge sees event
  -> sends another email
  -> ...
```

The scheduler implementation (cron, systemd, internal scheduler, etc.) sits
behind the Trigger contract rather than becoming the product model.

## Capability Adapters

Workforces declare needs. Adapters provide the hands.

Examples eventually include:

- filesystem/repositories/Git/GitHub;
- web/browser/documents;
- MCP;
- ACP-backed runtimes;
- Notion/knowledge sources;
- email/calendar;
- databases/HTTP APIs;
- infrastructure/service control.

An adapter contract should cover:

- resource/capability ids and versions;
- credentials without model-visible ambient secrets;
- typed inputs/outputs;
- rate/quota/readiness state;
- idempotency/reconciliation;
- timeout/cancellation;
- network/egress;
- redaction/evidence.

Executable adapter code is a different trust class from a declarative Workforce
package.

## Three Reference Workforces

Do not build ten Workforces before the runtime proves itself.

### 1. Software Engineering

Proves safe mutation and deterministic verification.

Release proof:

```text
request
 -> plan
 -> deterministic Work Package readiness/dispatch
 -> bounded per-run context
 -> bounded implementation
 -> tests
 -> independent review
 -> remediation
 -> branch/commit/PR
```

No general auto-merge is required.

### 2. Deep Research

Proves generality outside repositories:

- web/document resources;
- bounded parallel discovery and joins through the generic Workflow kernel;
- selective per-run context rather than sending the full corpus to every worker;
- evidence provenance;
- contradiction handling;
- citation/claim verification;
- non-code artifacts;
- provider egress policy.

A Research Mission must work without a fake Project/Git record.

### 3. Infrastructure Ops

Proves persistent, triggered, side-effectful non-coding autonomy.

Representative proof:

```text
health probe
 -> unchanged/healthy -> zero model calls
 -> meaningful failure
      -> deterministic diagnosis/remediation if possible
      -> economical model only if needed
      -> typed reversible remediation
      -> verification
      -> escalate when policy requires
```

This is a cleaner third proof than Personal Ops because faults and rollback are
more technically testable before Forge receives sensitive email/calendar
responsibilities.

## Hermes / HearthBot Relationship

Hermes is an experiment from which Forge should keep lessons, not code.

### Concepts worth keeping

| Lesson observed in HearthBot/Hermes | Forge-native requirement |
|---|---|
| Cheap workers can handle large amounts of routine work | Provider-neutral economy/standard/frontier routing under budgets |
| Provider availability changes | Deterministic provider health with auth/quota/rate-limit states |
| Failover must be explainable | Durable routing receipt |
| Agent polling wastes tokens | Deterministic event/change detection before model invocation |
| Long parent-agent context is expensive | Ephemeral workers + bounded ContextManifest/ContextPacket + durable artifacts |
| Supervisor prose handoffs repeatedly spend tokens and lose detail | Deterministic Work Package dispatch + reference-first artifact routing |
| Parallel exploration/review can help | Bounded fan-out under dependency/resource/budget checks |
| Independent review catches failures | Evidence-producing reviewers + trusted gates |
| Dashboards can mislead when they summarize the wrong truth | Evidence-first, actionable operator state |
| Scheduled responsibilities are useful | Forge Trigger + persistent Mission semantics |
| Telegram is convenient | HearthBot becomes a thin Forge client/interface |

### Explicitly do not import

- Hermes source code;
- Hermes runtime dependency;
- Hermes state database/state model;
- Hermes parent-agent prompts;
- Hermes cron prompts;
- Hermes routing implementation;
- Hermes provider configuration format;
- Hermes delegation-manifest semantics;
- a Forge-to-Hermes fallback path.

The migration rule is:

> **Preserve the lesson. Reconsider the mechanism.**

### Final target

```text
HearthBot / Web / CLI / API
          |
          v
        Forge
          |
          v
Mission + Workforce runtime
          |
          v
Capability / Operation plane
```

Hermes is absent from that chain.

During cutover, each external workflow has exactly one writer/authority at a
time. Shadow observation is allowed only when it cannot duplicate side effects.

## VNext Roadmap

| Phase | Issue | Outcome |
|---|---:|---|
| 0 | [#334](https://github.com/Joncallim/Forge/issues/334) | Generic contracts + compatibility seam; no big-bang rewrite |
| 1 | [#335](https://github.com/Joncallim/Forge/issues/335) | Deterministic budgets, provider routing, ContextManifest/ContextCompiler, context economics |
| 1B | [#367](https://github.com/Joncallim/Forge/issues/367) | Deterministic Workflow DAG readiness, fan-out/join and artifact-routed dispatch; parallel with Phase 2 after #335 |
| 2 | [#336](https://github.com/Joncallim/Forge/issues/336) | Secure execution envelope, authority lineage, side-effect recovery |
| 3 | [#337](https://github.com/Joncallim/Forge/issues/337) | Software Engineering completes end-to-end through converged #367 Workflow + #336 confinement contracts |
| 4 | [#338](https://github.com/Joncallim/Forge/issues/338) | Declarative Workforce packages; extract Software Engineering |
| 5 | [#339](https://github.com/Joncallim/Forge/issues/339) | Deep Research proves non-repository generality |
| 6 | [#340](https://github.com/Joncallim/Forge/issues/340) | Persistent Missions, checkpoints, leases, bounded autonomy |
| 7 | [#341](https://github.com/Joncallim/Forge/issues/341) | Trigger/Event runtime, dedupe, causality, zero-token idle |
| 8 | [#342](https://github.com/Joncallim/Forge/issues/342) | General Resource/Capability adapter plane |
| 9 | [#343](https://github.com/Joncallim/Forge/issues/343) | Infrastructure Ops persistent side-effect proof |
| 10 | [#344](https://github.com/Joncallim/Forge/issues/344) | HearthBot cutover; remove Hermes completely |

The order is dependency-significant. After #335, #367 and #336 may proceed in
parallel. #337 is the first production convergence point and must not begin until
its Workflow, confinement, verification and proof dependencies are complete.
A later phase may prototype, but it cannot claim completion by bypassing an
earlier contract gate.

## Relationship To Existing Earned-Autonomy Work

Do not create a second reliability/autonomy system.

Epic [#184](https://github.com/Joncallim/Forge/issues/184) remains the trust
programme.

Already-delivered foundations are especially valuable to VNext:

- #201 — deterministic Operation Catalog;
- #185 — canonical execution outcomes;
- #186 — capability reliability ledger;
- #187 — verification goal registry work already landed in part.

Remaining #187–#191 work must be reconciled with the VNext generic contracts.
For example, scheduled proof runs should eventually consume the Trigger
substrate rather than creating an unrelated scheduler; Sentinel should consume
canonical Trigger/Mission state rather than becoming a second orchestrator.

## Runtime Conformance Suite

Every applicable phase, Workforce, and capability adapter should prove the
following rather than relying on model confidence.

1. **Restart safety** — kill the process mid-work and recover correctly.
2. **Replay safety** — duplicate delivery does not duplicate confirmed side effects or intended Agent Run dispatches.
3. **Authority containment** — child principals cannot increase their grant scope.
4. **Resource containment** — unrelated resources remain inaccessible.
5. **Secret containment** — arbitrary credentials/environment data are not exposed.
6. **Network containment** — unauthorized egress fails.
7. **Budget containment** — work stops before exceeding hard ceilings.
8. **Audit completeness** — material decisions/actions and context selection are reconstructable from evidence.
9. **Verification independence** — workers cannot self-grade into authority.
10. **Package integrity** — tampered package content/provenance is detected.
11. **Update pinning** — running Missions do not silently change on package update.
12. **External uncertainty** — ambiguous side effects reconcile rather than blind-retry.
13. **Prompt-injection resistance** — hostile resource content cannot widen policy/authority.
14. **Cancellation correctness** — cancelled/revoked work cannot continue acting.
15. **Operator kill switch** — outstanding authority can be fenced/revoked.
16. **Resource concurrency** — conflicting exclusive writers cannot silently race.
17. **Data-egress enforcement** — ineligible providers never receive restricted content.
18. **Zero-token idle** — deterministic monitoring/scheduling can remain active without model calls when nothing meaningful changes.
19. **Zero-token routine orchestration** — Workflow readiness, fan-out/join and handoff do not invoke a model merely to coordinate other models.
20. **Context isolation** — downstream Agent Runs receive only selected bounded context; unrelated predecessor output/private reasoning is not inherited by default.
21. **Workflow replay safety** — crash/restart or duplicate wakeups cannot double-dispatch one intended attempt or create conflicting readiness truth.

Each phase should add the subset it can actually prove; later phases inherit the
suite.

## Explicitly Deferred

Do not let these expand the programme before its core proofs pass:

- model ensembles;
- latent/model-state bridging;
- automatic generation of trusted Workforces;
- self-modifying agent/runtime code;
- arbitrary model-authored shell authority;
- public Workforce marketplace/registry;
- distributed Forge cluster architecture;
- enterprise multi-user role-based access control;
- broad automatic merge/deployment authority;
- broad Forge Workspace UI expansion;
- Personal Ops/email/calendar autonomy as an early proof workload;
- direct agent-to-agent messaging as an internal orchestration substrate;
- arbitrary executable Workflow callbacks/reducers or unrestricted cyclic graphs;
- LangGraph or another agent framework as Forge Core's authoritative Workflow,
  checkpoint, Grant, Gate or persistence layer.

Local/Git Workforce installation is sufficient to prove plug-and-play packaging.
A later public registry is a separate supply-chain/product decision.

## Remaining Implementation Decisions

These are deliberately **not** prematurely frozen by this architecture document.
They need their own evidence/ADR in the phase that implements them:

- exact database migration shape for Mission/Execution compatibility;
- exact internal WorkflowDefinition schema/storage projection and module layout,
  within #367's DAG/single-authority constraints;
- exact ContextManifest/ContextPacket storage/retention representation within
  #335's governed-invocation contract;
- exact sandbox technology and first supported host platform;
- exact package manifest/DSL syntax;
- exact provider cost metadata source/update mechanism;
- exact capability-adapter process/RPC/plugin boundary;
- exact resource-classification taxonomy;
- exact event scheduler backend;
- exact rules for reusable non-deterministic/cognitive results, if added later.

The invariants above constrain those choices without pretending the correct
implementation is already known.

## Definition Of VNext Success

Forge VNext is proven when all three reference Workforces run through the same
Core contracts and the evidence shows:

- Software Engineering can safely mutate and deliver code;
- Deep Research can perform non-repository evidence work;
- Infrastructure Ops can own a persistent, event-driven responsibility with
  bounded reversible side effects;
- routine idle operation does not burn model tokens;
- routine Workflow sequencing/handoff does not burn model tokens;
- every cognitive Agent Run receives bounded, reconstructable context selected
  from authoritative references;
- budgets and routing are inspectable and enforced;
- no worker can widen its own authority;
- restart/replay does not silently duplicate side effects or Agent Run dispatch;
- HearthBot can operate as a thin Forge interface;
- Hermes is no longer required and can be fully removed.

At that point Forge is no longer a coding orchestrator with extra integrations.
It is a general agent runtime with Software Engineering as one installed
Workforce.
