# Industry Benchmark & Reference Matrix

**Date:** 2026-09-04
**Purpose:** Record what Forge borrows from industry standards and what it deliberately does not adopt as a dependency.

## Principles

1. **Borrow principles, not necessarily implementations.** Forge is a local-first, single-operator runtime in a GenAI agent space. Many enterprise-grade standards solve problems Forge does not yet have (multi-tenancy, global distribution, regulatory compliance).
2. **Keep the dependency surface small.** Every adopted dependency is a maintenance burden, security risk, and compatibility constraint.
3. **Design for future compatibility.** Where a standard is likely to become relevant, Forge's data models and interfaces should be mappable without being constrained by them today.

## Matrix

| Standard | Relevant Principle | Forge Equivalent | Adopted? | Why / Why Not | Future Compatibility |
|---|---|---|---|---|---|
| **Temporal** (durable execution) | Durable workflow semantics, retry, timeout, saga pattern | Forge Execution + Work Package + Operation lifecycle (SPEC-0002, SPEC-0004) | No — principle only | Forge needs deterministic-first control without a heavyweight runtime dependency. Temporal is excellent but would become the orchestrator, conflicting with ADR 0014's "no permanent parent" and "zero-token idle" requirements. | Forge's Execution/Operation lifecycle could be mapped to Temporal concepts if distributed orchestration is needed later. |
| **Cedar** (authorization) | PARC model, default-deny, explicit forbid-overrides-permit, policy-as-code | Forge Grant + Policy model (SPEC-0003) | No — principle only | Cedar's evaluation semantics are a good fit, but adding Cedar as a dependency would introduce a Rust/Wasm runtime dependency and a new policy language. Forge's v1 policy engine is simpler and Cedar-compatible concepts can be adopted later. | Forge's PARC model (Principal + Action/Capability + Resource + Context) is Cedar-compatible. Policy could be expressed in Cedar in a future version. |
| **OPA/Rego** (policy separation) | Policy is separate from enforcement, versioned, auditable | Forge Policy entity (SPEC-0002) | No — principle only | OPA is a proven policy engine, but Forge's v1 policy needs are narrower (grant checks, egress rules, gate evaluation). Adding OPA would be disproportionate complexity for the current phase. | Forge policy data model could be exported to OPA for advanced policy needs. |
| **AWS idempotency/retry/reconciliation** | Stable idempotency keys, reconcile-before-retry, at-most-once semantics | Operation idempotency and reconciliation (SPEC-0004) | Yes — principle adopted | AWS's guidance on idempotency and reconciliation is battle-tested and directly applicable to Forge's side-effect model. | Forge's stable Operation identity and idempotency key usage follow AWS patterns directly. |
| **CloudEvents** | Standard event envelope, source/type/subject/id, extensibility | Trigger occurrence envelope (SPEC-0009) | Yes — compatible envelope | CloudEvents is a CNCF standard with wide adoption. Forge uses a compatible envelope without requiring the SDK. | Full CloudEvents SDK integration can be added later. Forge extensions are namespaced for clean mapping. |
| **OpenTelemetry** | Traces, metrics, logs correlation, semantic conventions | Observability spans and metrics (SPEC-0012) | Yes — mapping, not dependency | OTel semantic conventions are useful for interoperability, but Forge must keep GenAI-specific semantics independent because OTel GenAI conventions are still evolving. | Forge metrics use OTel-compatible naming. A future exporter can bridge to OTel backends. |
| **RFC 9457** (Problem Details) | Machine-readable error responses with type/title/status/detail/instance | Error contract (SPEC-0007) | Yes — compatible format | RFC 9457 is a simple, widely-adopted standard for HTTP API errors. Forge extends it with Forge-specific fields. | Full RFC 9457 compliance with standard `type` URIs. |
| **JSON Schema 2020-12** | Schema validation for API inputs/outputs/manifests | Package manifest and Operation schemas (SPEC-0010, SPEC-0004) | Yes — adopted | JSON Schema is the de-facto standard for JSON validation. Using it avoids inventing a custom schema language. | Package manifests use JSON Schema 2020-12 directly. |
| **SemVer** | Version compatibility signaling | Package versioning (SPEC-0010) | Yes — adopted | SemVer is universally understood and sufficient for Forge's package compatibility model. | Standard SemVer with Forge-specific MAJOR/MINOR/PATCH semantics. |
| **OCI generic artifacts** | Content-addressed artifact identity, registry protocol | Package identity and provenance (SPEC-0010, SPEC-0011) | No — compatible design | OCI registry protocol adds operational complexity that Forge does not need in v1 (local/Git distribution is sufficient). However, content-addressed identity is compatible. | Package identity design is OCI-compatible. Future registry support would use OCI protocol. |
| **SLSA** | Supply chain integrity levels | Provenance model (SPEC-0011) | No — principle only | SLSA levels require specific attestations and infrastructure. Forge's v1 provenance captures essential information without claiming a SLSA level. | Provenance data model is SLSA-inspired. Full SLSA compliance would require additional attestation generation. |
| **Sigstore/Cosign** | Signing, transparency log, keyless signing | Signature hooks in provenance (SPEC-0011) | No — future hook | Sigstore is powerful but introduces a dependency on external services (Fulcio, Rekor) that conflicts with Forge's local-first principle. | Provenance schema includes signature fields for future Sigstore integration. |
| **CycloneDX** | Software Bill of Materials | Package dependency tracking | No — future export | CycloneDX is a BOM format, not an authority manifest. Forge's package model is richer than a dependency list. | CycloneDX export can be added for BOM purposes without changing the authority model. |
| **OWASP Agentic Security** | Agent-specific threat taxonomy | Agentic threat model (SPEC-0013) | Yes — principle adopted | OWASP's taxonomy is the most relevant agent-security framework. Forge maps each threat to existing controls. | Threat model is reviewed annually and updated as OWASP taxonomy evolves. |
| **NIST AI RMF GAI** | AI risk management framework | Agentic threat model (SPEC-0013) | Yes — principle adopted | NIST AI RMF GAI provides complementary risk management guidance. Forge incorporates its principles (govern, map, measure, manage). | Risk management practices evolve with the framework. |
| **Google SRE practices** | SLI/SLO/error budget, reliability engineering | Reliability profile (SPEC-0015) | Yes — principle adopted | Google SRE practices are the gold standard for operational reliability. Forge applies them to the GenAI agent domain. | SLOs will be set based on baseline data following SRE methodology. |
| **MCP** (Model Context Protocol) | Standardized model-context tool interface | Adapter protocol (one of several) | Yes — one adapter protocol | MCP is adopted as one integration protocol for capability adapters. It does not define Forge's core ontology or authority model. | MCP credentials remain audience/resource scoped; token passthrough is prohibited. |
| **A2A** (Agent-to-Agent) | Inter-agent communication protocol | External runtime integration | No — future use | A2A is designed for independent agent systems to interoperate. Native Forge Agent Runs/Workforces do not communicate through A2A internally. Any future A2A agent is treated as an external runtime under normal policy. | A2A integration would be through the Capability adapter plane with full grant/policy/budget/egress enforcement. |
| **FOCUS** (FinOps) | Cloud cost reconciliation | Cost telemetry (SPEC-0006) | No — compatible | FOCUS is a FinOps standard for cloud cost reporting. Forge's internal cost data is simpler (single-operator, local-first). | Cost data model is compatible with future FOCUS-format export. |

## Summary of Dependencies

### Directly adopted
- JSON Schema 2020-12 (validation)
- SemVer (versioning)
- RFC 9457 (error format)
- CloudEvents (event envelope — compatible, not SDK)

### Principles adopted, no direct dependency
- Temporal (durable execution semantics)
- Cedar (authorization model)
- OPA (policy separation)
- AWS idempotency/retry patterns
- OpenTelemetry (observability mapping)
- SLSA (provenance principles)
- OWASP Agentic Security (threat taxonomy)
- NIST AI RMF GAI (risk management)
- Google SRE (reliability engineering)

### Future compatibility hooks
- OCI (artifact identity)
- Sigstore/Cosign (signing)
- CycloneDX (BOM export)
- A2A (agent interoperability)
- FOCUS (cost reporting)
- Full CloudEvents SDK

### Not adopted
- Temporal SDK
- Cedar policy engine
- OPA/Rego
- OCI registry protocol
- Sigstore/Cosign services
- CycloneDX as authority
- A2A as internal protocol
- FOCUS as runtime schema
