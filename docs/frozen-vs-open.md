# Frozen vs Intentionally Open — VNext Architecture Decisions

**Date:** 2026-09-04
**Purpose:** Clarify which architectural decisions are frozen (binding on all implementation) and which are intentionally left open for implementers to decide.

## Frozen Semantics

These decisions are frozen by the normative specs and ADRs. Implementation agents MUST NOT change them without a spec revision.

### Ontology & Lifecycle
- Entity relationships: Mission (0..N Executions) → Execution → Work Package / Operation; Trigger bound to Mission (SPEC-0002 R1)
- Lifecycle vs outcome separation for Mission, Execution, Work Package, Operation; Agent Run excluded (SPEC-0002 R2)
- Mission lifecycle states: draft, active, waiting, paused, terminal (SPEC-0002 R3); outcome is separate
- Execution lifecycle states: created, admitted, queued, leased, running, waiting, terminal (SPEC-0002 R4)
- Execution outcomes: succeeded, failed, cancelled, blocked, indeterminate (SPEC-0002 R5)
- Work Package lifecycle: pending, running, terminal; outcome: succeeded, failed, cancelled, blocked (SPEC-0002)
- Gate results: pass, rework, human_required, blocked (SPEC-0002 R6)
- Opaque identity rule (SPEC-0002 R7)
- Artifact immutability and versioning (SPEC-0002 R8)
- UTC timestamps (SPEC-0002 R9)
- Compound status prohibition (SPEC-0002 R12)

### Authorization & Grants
- PARC authorization model (SPEC-0003 R1)
- Default deny / forbid overrides permit (SPEC-0003 R2)
- Fail-closed evaluation (SPEC-0003 R3)
- Effective authority is intersection of all ceilings (SPEC-0003 R4)
- Child Grant cannot exceed parent (SPEC-0003 R5)
- Sources that cannot mint authority (SPEC-0003 R6)
- Grant structure fields (SPEC-0003 R7)
- Approval binding to exact revision/digest + scope + policy (SPEC-0003 R8)
- Current security revoke vs pinned behaviour (SPEC-0003 R9)
- Grant derivation chain (SPEC-0003 R11)
- Operator authority limited by hard invariants (non-overridable, no exception mechanism) and system ceilings (SPEC-0003 R10)

### Operations & Side Effects
- Operation declaration fields (SPEC-0004 R1)
- Effect classes: pure, read, local_mutation, external_reversible_mutation, external_mutation (SPEC-0004 R2)
- Retry classes: replay_safe, idempotent_with_key, reconcile_before_retry, at_most_once (at most one external submission), human_required (SPEC-0004 R3)
- Side-effect lifecycle as branching state graph with denied, confirmed_failure states (SPEC-0004 R4)
- Stable Operation identity (SPEC-0004 R5)
- Submission uncertainty ≠ failure-before-submission (SPEC-0004 R6)
- Blind retry prohibition after uncertain submission (SPEC-0004 R6)

### Resource Classification & Egress
- Classification levels: PUBLIC, INTERNAL, CONFIDENTIAL, SECRET (SPEC-0005 R1)
- Derived Artifact classification rule (SPEC-0005 R2)
- Declassification rules (SPEC-0005 R3)
- Egress authorization order (SPEC-0005 R4); PERMIT/CONDITIONAL/DENY matrix (SPEC-0005 R6)
- External Resource contents are untrusted (SPEC-0005 R7)
- Credential brokering principle (SPEC-0005 R8)
- Token passthrough prohibition (SPEC-0005 R8)
- Sentinel-secret conformance requirement (SPEC-0005 R9)

### Model Invocation & Cost
- Governed invocation boundary covering production cognition and active operator probes (SPEC-0006 R1)
- Provider-neutral cognitive requirements (SPEC-0006 R2)
- No LLM selects the LLM (SPEC-0006 R3)
- Budget hierarchy (SPEC-0006 R4)
- Hard budget types (SPEC-0006 R5)
- Atomic budget reservation before invocation (SPEC-0006 R6)
- Parallel reservation safety (SPEC-0006 R7)
- Unknown cost remains unknown (SPEC-0006 R8)
- Provider readiness taxonomy (SPEC-0006 R10); circuit-breaking by failure class (SPEC-0006 R14)
- Routing receipt requirement (SPEC-0006 R11)
- Optimization target: minimum expected cost to verified outcome (SPEC-0006 R12)

### Error Codes
- Namespaced reason codes (SPEC-0007 R1)
- Code stability (SPEC-0007 R2)
- Required error fields (SPEC-0007 R4)
- Machine consumers must not parse human prose (SPEC-0007 R6)

### Conformance
- Test classes C1-C8 (SPEC-0008 R1)
- Failure injection requirements (SPEC-0008 R3)
- Zero-token-idle proof requirement (SPEC-0008 R4)
- Property/invariant test requirements (SPEC-0008 R5)
- Phase closure requirements (SPEC-0008 R6)

### Triggers & Events
- CloudEvents-compatible envelope with valid lowercase-alphanumeric extension names; rich metadata in data envelope (SPEC-0009 R1-R2)
- Forge extensions (SPEC-0009 R2)
- Auth separate from authorization (SPEC-0009 R3)
- PostgreSQL as occurrence truth (SPEC-0009 R4)
- Deduplication strategies (SPEC-0009 R5); granular concurrency per dedupe identity (SPEC-0009 concurrency)
- Trigger occurrence identity ≠ Operation identity (SPEC-0009 R6)
- Causality tracking (SPEC-0009 R7)
- Loop prevention including multi-Trigger causal ancestry detection (SPEC-0009 R8)
- Schedule catch-up policies (SPEC-0009 R9)
- Zero-token idle for Triggers (SPEC-0009 R10)
- Filter before model wake (SPEC-0009 R11)

### Workforce Packages
- Package is declarative data (SPEC-0010 R1)
- Install does not authorize (SPEC-0010 R2)
- Manifest schema requirements (SPEC-0010 R3)
- Capability expansion requires review (SPEC-0010 R4)
- Immutable package versions with source resolution and version integrity (SPEC-0010 R5)
- Lockfile requirements (SPEC-0010 R6)
- Dependencies do not inherit permissions (SPEC-0010 R7)
- Package pin for running Missions (SPEC-0010 R8)
- Derived/local package revisions (SPEC-0010 R9)
- Distribution starts local/Git (SPEC-0010 R10)

### Provenance & Supply Chain
- Initial provenance scope (SPEC-0011 R1)
- Provenance is not safety (SPEC-0011 R2)
- Content addressing (SPEC-0011 R3)
- Tamper detection (SPEC-0011 R8)

### Observability vs Audit
- Audit/evidence primacy (SPEC-0012 R1)
- Telemetry loss tolerance (SPEC-0012 R2)
- Correlation identifiers (SPEC-0012 R3)
- Default telemetry privacy (SPEC-0012 R6)

### Threat Model
- Threat inventory (SPEC-0013 R1)
- Control mapping to existing Forge concepts (SPEC-0013 R2)
- Residual risk documentation (SPEC-0013 R4)

### Migration & Compatibility
- Default migration sequence: EXPAND→BACKFILL→SHADOW→SWITCH→VERIFY→CONTRACT (SPEC-0014 R1)
- Single authority rule (SPEC-0014 R2)
- Historical evidence preservation (SPEC-0014 R5)
- Unknown enum fail-closed (SPEC-0014 R6)

### Reliability
- Hard invariants H1-H10 (SPEC-0015 R1)
- Error budgets apply to operational SLIs, not hard invariants (SPEC-0015 R3)
- Baseline before SLOs (SPEC-0015 R4)

## Open For Implementation

These decisions are intentionally left to implementation agents. They are not frozen and may be determined during implementation.

### Exact Implementation Details
- TypeScript module layout and file organization
- Database table names and exact column types (within schema constraints)
- ORM patterns (Drizzle, Kysely, raw SQL)
- Opaque ID implementation (UUIDv7, CUID2, NanoID)
- Exact deterministic policy engine internals
- Schedule library choice (cron, later, etc.)
- OpenTelemetry backend/exporter
- Cache mechanism (Redis patterns, TTLs, invalidation)
- Adapter RPC mechanism (HTTP, gRPC, IPC)
- Exact Linux sandbox technology after conformance testing (rootless Docker, podman, etc.)
- Numerical SLO targets (after baseline collection)

### Deferred Features
These are explicitly deferred from VNext and MUST NOT be implemented:
- Model ensembles/voting/latent-state bridging
- Public Workforce marketplace/registry
- Distributed Forge clusters
- Enterprise multi-user RBAC
- Self-modifying Workforces or runtime code
- Automatic trust of generated Workforces
- Arbitrary model-authored shell authority
- General auto-merge/deploy authority
- Full Workspace shell
- A2A internal orchestration
- Multi-OS sandboxing
- Exhaustive connector catalogue
- Permanent Forge→Hermes fallback

### Later Phase Decisions
These need their own evidence/ADR in the implementing phase:
- Exact database migration shape for Mission/Execution compatibility (#334)
- Exact sandbox technology and first supported host platform (#336)
- Exact package manifest/DSL syntax (#338)
- Exact provider cost metadata source/update mechanism (#335)
- Exact capability-adapter process/RPC/plugin boundary (#342)
- Exact resource-classification taxonomy extensions (#342)
- Exact event scheduler backend (#341)
- Exact rules for reusable non-deterministic/cognitive results (future)
