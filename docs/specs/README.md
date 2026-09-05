# Forge Specifications

This directory contains the **normative specification framework** for Forge.

## What goes where

| Layer | Purpose | Authority | Mutability |
|---|---|---|---|
| **ADR** (`docs/adr/`) | Durable architectural decision — *why* a choice exists | Binding unless superseded by a later ADR | Append-only; superseding ADR explicitly overrides |
| **Spec** (`docs/specs/`) | Normative requirements — *what* Forge MUST do | Binding across all components | Versioned; breaking changes require spec revision |
| **Issue** (GitHub) | Bounded implementation scope — *how* and *when* | Binding for that issue's changes | Closed when merged; superseded by later issues |
| **Conformance test** (in-code) | Executable proof of a spec requirement | Pass/fail is authoritative | Updated with spec revision |
| **Evidence** (DB/artifact) | Result of one concrete execution | Factual record | Immutable by revision |
| **Documentation/UI** | Explanatory projection | Never hidden authority | Updated as product evolves |

### Layering rule

A lower layer must not silently weaken or redefine a higher normative layer.

- A Spec may constrain but must not contradict an ADR.
- An Issue may scope but must not contradict a Spec or ADR.
- A Conformance test may prove but must not contradict a Spec.
- Documentation/UI must not claim authority that does not exist in the layers above.

## Normative language

This specification framework uses RFC 2119 language:

- **MUST** / **MUST NOT** — absolute requirement.
- **SHOULD** / **SHOULD NOT** — strong recommendation; valid reasons may justify a different choice, but the implications must be understood.
- **MAY** — truly optional.

## Spec statuses

| Status | Meaning |
|---|---|
| **Draft** | Under active development; not yet binding |
| **Proposed** | Freeze candidate under review; not yet binding — pending operator-approved merge |
| **Accepted** | Canonical and binding for its scope on `main` |
| **Superseded** | Replaced by a newer spec version |
| **Deprecated** | Still binding for historical executions; not for new work |

### Status transition

A spec becomes **Accepted** (canonical, binding) when:
1. The PR containing it is merged into `main`, AND
2. The spec status is updated from "Proposed (freeze candidate)" to "Accepted" (may happen in the same merge or a follow-up).

PR #359 merged the reviewed VNext specification tranche into `main`. SPEC-0001 through SPEC-0015 are therefore promoted to **Accepted** by the follow-up governance transition. ADR 0015 remains **Proposed** because the exact sandbox technology still requires S1-S23 conformance proof.

Specs on `main` that are not yet implemented remain authoritative for their scope. A spec that is superseded by a newer version on `main` is marked accordingly.

## Spec index

| ID | Title | Status | Version |
|---|---|---|---|
| SPEC-0001 | Specification Authoring Standard | Accepted | 1.0 |
| SPEC-0002 | Runtime Contract v1 | Accepted | 1.0 |
| SPEC-0003 | Authorization & Grants v1 | Accepted | 1.0 |
| SPEC-0004 | Operation & Side-Effect Semantics v1 | Accepted | 1.0 |
| SPEC-0005 | Resource Classification, Data Egress & Secrets v1 | Accepted | 1.0 |
| SPEC-0006 | Model Invocation & Cost Contract v1 | Accepted | 1.0 |
| SPEC-0007 | Error & Reason Codes v1 | Accepted | 1.0 |
| SPEC-0008 | Conformance Test Standard v1 | Accepted | 1.0 |
| SPEC-0009 | Trigger/Event Envelope v1 | Accepted | 1.0 |
| SPEC-0010 | Workforce Package v1 | Accepted | 1.0 |
| SPEC-0011 | Provenance & Supply Chain v1 | Accepted | 1.0 |
| SPEC-0012 | Observability vs Audit v1 | Accepted | 1.0 |
| SPEC-0013 | Agentic Threat Model v1 | Accepted | 1.0 |
| SPEC-0014 | Migration & Compatibility v1 | Accepted | 1.0 |
| SPEC-0015 | Reliability / SLO Profile v1 | Accepted | 1.0 |
