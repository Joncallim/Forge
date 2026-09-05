# Data Model Reference — Conceptual Ownership & Consolidation

**Date:** 2026-09-05
**Purpose:** Consolidated reference for all conceptual entities defined across the specification framework. This document shows ownership, governing specs, durability requirements, and whether a new physical table is required or intentionally open.

> **Note:** The models below are conceptual. They show required semantic fields, not physical schema. Exact table layout, column types, indexes, partitioning, and storage engine are implementation decisions unless an existing table is explicitly marked as normative.

---

## Entity Inventory

| Entity | Canonical Owner | Governing Spec | Durable? | Existing Table? | New Physical Table Required? |
|---|---|---|---|---|---|
| Mission | Runtime | SPEC-0002 | Yes | No | Required |
| Execution | Runtime | SPEC-0002 | Yes | No | Required |
| Work Package | Runtime | SPEC-0002 | Yes | No | Required |
| Agent Run receipt | Runtime | SPEC-0002 | Yes (receipt/metadata only) | No | Required (durable receipt; cognitive session ephemeral) |
| Artifact | Runtime | SPEC-0002 | Yes | `artifacts` | Existing, extend |
| Gate result | Runtime | SPEC-0002 | Yes | No | Required |
| Grant | Authorization | SPEC-0003 | Yes | `grants` | Existing, extend (add revision/fencing token) |
| Approval record | Authorization | SPEC-0003 | Yes | No | Required |
| Operation definition | Operations | SPEC-0004 | Yes | `operation_catalog` | Existing (ADR 0011) |
| Operation run | Operations | SPEC-0004 | Yes | `operation_runs` | Existing (ADR 0011) |
| Resource classification | Classification | SPEC-0005 | Yes | No | Required |
| Egress policy | Classification | SPEC-0005 | Yes | No | Required |
| Credential binding | Classification | SPEC-0005 | Yes | No | Required (references secure store) |
| Budget allocation | Cost | SPEC-0006 | Yes | No | Required |
| Routing receipt | Cost | SPEC-0006 | Yes | No | Required |
| Provider readiness | Cost | SPEC-0006 | No | No | Not required (operational state) |
| Trigger definition | Events | SPEC-0009 | Yes | No | Required |
| Trigger occurrence | Events | SPEC-0009 | Yes | No | Required |
| Workforce package | Packages | SPEC-0010 | Yes | No | Required |
| Mission package pin | Packages | SPEC-0010 | Yes | No | Required |
| Derived revision | Packages | SPEC-0010 | Yes | No | Required |
| Provenance record | Supply Chain | SPEC-0011 | Yes | No | Required |
| Audit event | Observability | SPEC-0012 | Yes | No | Required |
| Migration registry | Migration | SPEC-0014 | Yes | No | Required |
| Hard invariant violation | Reliability | SPEC-0015 | Yes | No | Required |
| SLI measurement | Reliability | SPEC-0015 | No | No | Not required (telemetry) |
| Conformance test registry | Conformance | SPEC-0008 | No | No | Not required (CI metadata) |
| Threat model registry | Threat Model | SPEC-0013 | No | No | Documentation only |

### Mapping notes

- **Project** is NOT a Mission. It is a Software Engineering compatibility/resource-binding/workspace context (SPEC-0014 R7). The existing Project table remains for compatibility but routes through an adapter to the canonical Mission/Execution representation.
- **Task** is NOT an Execution. It is a finite coding-request compatibility surface that maps to a Mission (SPEC-0014 R7). Retries produce multiple Executions under one Mission.
- **Agent Run receipt** is durable (identity, routing snapshot, token/cost usage, provenance linkage). The cognitive session/context is ephemeral.

---

## Entity Relationship Diagram (Conceptual)

```
Mission (1)
  ├── Trigger definition (0..N, bound to Mission)
  ├── Trigger occurrence (0..N, produced by Trigger)
  ├── Resource (0..N, bound at Mission level)
  ├── Workforce (exactly one, pinned)
  ├── Policy (one or more, applied)
  ├── Budget (exactly one, governing)
  │
  └── Execution (0..N)
        ├── Work Package (0..N)
        │     ├── Agent Run receipt (0..N, durable)
        │     └── Operation run (0..N) → references Operation definition
        ├── Artifact (0..N)
        ├── Gate result (0..N)
        ├── Grant (0..N) → references Principal
        ├── Resource (0..N, snapshot/refinement of Mission bindings)
        └── Budget (exactly one, constrained by Mission budget)

Grant (1)
  └── Child Grant (0..N) [derivation chain]

Workforce Package (1)
  └── Mission Package Pin (0..N) [pinning]
  └── Derived Revision (0..N) [local edits]

Operation definition (1)
  └── Operation run (0..N) [instances]

Resource (1)
  └── Resource Classification (1)
  └── Credential Binding (0..N)

Budget Allocation (tree)
  ├── Workspace/System ceiling
  │   └── Workforce defaults
  │       └── Mission budget
  │           └── Execution reservation
  │               └── Agent Run usage
```

---

## Fields Appearing Across Multiple Entities

| Field | Meaning | Applies To |
|---|---|---|
| `id` (UUIDv7) | Stable opaque identity | All entities |
| `policy_revision` | Revision of governing policy at time of creation/mutation | Mission, Grant, Gate, Trigger definition, Classification, Egress policy |
| `created_at` | UTC timestamp of creation | All durable entities |
| `updated_at` | UTC timestamp of last update | Mutable entities |
| `terminal_at` | UTC timestamp of terminal state transition | Mission, Execution, Work Package, Operation run |
| `principal` | Identity of acting Principal | Execution, Grant, Operation run, Audit event, Provenance, Agent Run receipt |

---

## Coalescing Guidance

Per SPEC-0002 R10, not every conceptual entity requires a separate physical table. Acceptable coalescing patterns:

1. **Operation state** is part of the Operation run record, not a separate table (already in conceptual model).
2. **Agent Run cognitive session** is ephemeral; only the receipt (identity, routing, cost, provenance linkage) is durable.
3. **Gate evaluation** may be stored as evidence artifacts rather than a separate gate table, as long as the result, policy revision, and evaluator identity are durably recorded.
4. **Credential bindings** reference a secure external store; the binding table may be a projection of the external store's state.
5. **Provider readiness** is operational state, not authoritative — may use in-memory cache with periodic persistence for recovery.

---

## References

- SPEC-0002 — Runtime Contract v1 (entity relationships R1, database mapping R10)
- SPEC-0001 — Specification Authoring Standard (data model conventions)
- `docs/frozen-vs-open.md` — Implementation-open decisions
- `docs/implementation-checklist.md` — Cross-cutting implementation questions
