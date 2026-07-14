# Issue #180 Architecture Review Amendments

Status: historical review record.

All normative amendments below were incorporated into
`issue-180-mcp-operator-copy.md` during integrated review round 3. The primary
architecture document is authoritative; this file records why it changed and must
not override or narrow the primary document.

## Review round 1 findings and resolutions

### 1. One module does not mean one overloaded input contract

Task admission decisions, project health rows, and catalog entries are different source types. Forcing all three into one `AdmissionPresentationInput` would either invent fields or create a weak optional union.

Keep one copy module with three exhaustive pure presenters sharing common output primitives:

```ts
admissionPresentation(input: AdmissionDecisionPresentationInput): AdmissionPresentation;
projectMcpPresentation(input: ProjectMcpPresentationInput): McpSurfacePresentation;
catalogMcpPresentation(input: CatalogMcpPresentationInput): McpSurfacePresentation;
```

Shared types own tones, badges, CTA shapes, runtime-boundary wording, and escaping. Each function accepts only fields its source can truthfully provide.

### 2. Current grant state and historical decision state must be visually separated

A persisted preview decision explains what was decided at plan/approval time. Current package/project grant state explains whether the action is still available now. The task page should render:

- canonical decision presentation from persisted S2 fields;
- current grant control state from current package metadata/project config;
- issued packet evidence from S4 artifact.

Do not merge these into a single ambiguous object. If current state differs, show a bounded stale-state note and use current state for actionable controls.

### 3. Retry CTA and remediation CTA are different actions

- retry is allowed only when persisted broker `retryable` is true and current state remains compatible;
- project setup/remediation links are available for unhealthy/missing/config/auth states even when no handoff retry is currently valid;
- revise-plan and approve-context actions are never rendered as retry.

### 4. Packet artifact failure states need truthful copy

For `packetAssembled:false`, do not render zero files/bytes as if assembly completed. Show failure stage and bounded reason, with no counts unless persisted. For assembled snapshots, display exactly the metadata contract and no inferred path details.

### 5. ACP boundary wording must be centralized and context-sensitive

The shared module exports one vetted boundary sentence. Task deferred copy and catalog/project runtime notes use the same meaning but may use short/long variants. Wording must say that Forge issued no MCP handle through this channel and must not claim the ACP process lacks equivalent shell/network capabilities.

### 6. Presentation must be safe for unknown future enum values

Readers validate persisted enums and map malformed/unknown values to a safe legacy/recompute presentation. UI switches should be exhaustive over normalized types and never fall through to a positive or retryable state.

## Historical round 2 conclusion

At that point the architecture preserved one source of human copy while keeping
admission, project-health, and catalog inputs distinct. Integrated round 3 later
added total tuple precedence, locked retry compatibility, opaque packet root
references, bounded safe text, rollout compatibility, and stronger tests; consult
the primary document for the current contract.
