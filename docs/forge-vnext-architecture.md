# Forge VNext — General Agent Runtime Architecture

Status: **Accepted product direction for Epic #333**
Date: 2026-09-03

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
| scheduler / triggers      |
| routing policy            |
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
wall-clock time passes.

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
| state | policy | budgets | routing | triggers | recovery     |
| evidence | leases | audit | version pinning                  |
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

Scheduling, routing, retry policy, budgets, trigger processing, state
transitions, permission checks, recovery, deduplication, and evidence handling
are deterministic software.

A model may propose a plan or operation request. It does not become the final
policy authority because it wrote convincing prose.

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
- workflows;
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
- input artifact ids/digests.

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
Execution, grant, gate, or external operation really happened.

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
| **Work Package** | Dependency-scoped unit of work inside an Execution. |
| **Agent Run** | One bounded invocation of a model/agent runtime. |
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
- provider readiness;
- budget checks;
- routing;
- permission/policy checks;
- hashing/index invalidation;
- retry/recovery decisions;
- canonical evidence calculations.

This tier should handle routine idle orchestration.

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

### Context packets are first-class

A worker receives the minimum useful packet:

- Mission/Work Package summary;
- relevant resource references/extracts;
- constraints and acceptance criteria;
- grants/capability descriptions;
- relevant prior artifacts/evidence;
- required output schema;
- budget/context ceiling.

External text is labelled untrusted data. It does not become Forge policy just
because it contains instructions.

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
- parallel discovery only when useful;
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
| Long parent-agent context is expensive | Ephemeral workers + bounded context packets + durable artifacts |
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
| 1 | [#335](https://github.com/Joncallim/Forge/issues/335) | Deterministic budgets, provider routing, context economics |
| 2 | [#336](https://github.com/Joncallim/Forge/issues/336) | Secure execution envelope, authority lineage, side-effect recovery |
| 3 | [#337](https://github.com/Joncallim/Forge/issues/337) | Software Engineering completes end-to-end through generic contracts |
| 4 | [#338](https://github.com/Joncallim/Forge/issues/338) | Declarative Workforce packages; extract Software Engineering |
| 5 | [#339](https://github.com/Joncallim/Forge/issues/339) | Deep Research proves non-repository generality |
| 6 | [#340](https://github.com/Joncallim/Forge/issues/340) | Persistent Missions, checkpoints, leases, bounded autonomy |
| 7 | [#341](https://github.com/Joncallim/Forge/issues/341) | Trigger/Event runtime, dedupe, causality, zero-token idle |
| 8 | [#342](https://github.com/Joncallim/Forge/issues/342) | General Resource/Capability adapter plane |
| 9 | [#343](https://github.com/Joncallim/Forge/issues/343) | Infrastructure Ops persistent side-effect proof |
| 10 | [#344](https://github.com/Joncallim/Forge/issues/344) | HearthBot cutover; remove Hermes completely |

The order is dependency-significant. A later phase may prototype, but it cannot
claim completion by bypassing an earlier contract gate.

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
2. **Replay safety** — duplicate delivery does not duplicate confirmed side effects.
3. **Authority containment** — child principals cannot increase their grant scope.
4. **Resource containment** — unrelated resources remain inaccessible.
5. **Secret containment** — arbitrary credentials/environment data are not exposed.
6. **Network containment** — unauthorized egress fails.
7. **Budget containment** — work stops before exceeding hard ceilings.
8. **Audit completeness** — material decisions/actions are reconstructable from evidence.
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
- Personal Ops/email/calendar autonomy as an early proof workload.

Local/Git Workforce installation is sufficient to prove plug-and-play packaging.
A later public registry is a separate supply-chain/product decision.

## Remaining Implementation Decisions

These are deliberately **not** prematurely frozen by this architecture document.
They need their own evidence/ADR in the phase that implements them:

- exact database migration shape for Mission/Execution compatibility;
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
- budgets and routing are inspectable and enforced;
- no worker can widen its own authority;
- restart/replay does not silently duplicate side effects;
- HearthBot can operate as a thin Forge interface;
- Hermes is no longer required and can be fully removed.

At that point Forge is no longer a coding orchestrator with extra integrations.
It is a general agent runtime with Software Engineering as one installed
Workforce.
