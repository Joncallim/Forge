# Issue #180 Architecture: Unified MCP Operator Presentation

Status: architecture proposal
Issue: #180
Parent: #172
Depends on: #176, #177, #179

## Objective

Give operators one consistent explanation and action for every canonical MCP admission state across task, project, and MCP catalog surfaces. The UI reads persisted canonical state; it does not infer admission, mutate broker metadata, parse human reasons, or recreate filesystem policy.

## Presentation contract

Create `web/lib/mcps/admission-copy.ts` as a pure, exhaustive mapper.

```ts
type AdmissionPresentationInput = {
  mode: McpAdmissionMode;
  status: McpAdmissionStatus;
  recoveryAction?: McpRecoveryAction;
  grantState?: {
    phase: EffectiveGrantState['phase'];
    consumed?: boolean;
    revocationReason?: string;
  };
  requirement: 'required' | 'optional';
  retryable: boolean;
  projectId: string;
};

type AdmissionPresentation = {
  statusKey: 'planning' | 'approved' | 'action_required' | 'deferred' | 'unhealthy' | 'legacy';
  tone: 'neutral' | 'positive' | 'warning' | 'danger';
  badgeText: string;
  headline: string;
  body: string;
  cta?: {
    kind: 'scroll' | 'link' | 'request_changes' | 'retry';
    label: string;
    href?: string;
    targetId?: string;
  };
};
```

The function must be deterministic, total, side-effect-free, and tested as a matrix. Human strings live here; component code renders the result.

## Canonical mapping

### Planning only

- Badge: `Planning context`
- Tone: neutral
- Body: instruction-only; no MCP capability or bounded packet issued.
- CTA: none.
- Pure `filesystem.project.write` warning remains neutral and is not grouped with degradation.

### Bounded context required

Phase-specific copy:

- `none|proposed`: `Needs project context`;
- `denied`: `Context was denied`;
- `revoked`: `Project context was removed`, include bounded revocation reason;
- approved + consumed: `One-time context approval was already used`.

CTA scrolls to the exact package grant controls. Do not infer phase from reason text.

### Bounded context approved

- Badge: `Context approved`
- Tone: positive
- Body: only approved read-only project context may be assembled.
- If issued artifact exists, show metadata summary; otherwise say not yet issued.

### Blocked + install/fix

- Tone: danger
- CTA: `/dashboard/projects/{projectId}#project-mcps-heading`
- Copy identifies missing, disabled, unhealthy, configuration, or authentication state from structured health/remediation metadata.

### Blocked + revise plan

- Tone: danger
- CTA: open Request Changes flow.
- Do not offer retry.

### Deferred live MCP

- Badge: `Deferred — MCP boundary`
- Tone: neutral/slate, not red install failure.
- Body: Forge issued no MCP capability through its MCP channel. ACP local processes are not security sandboxes and may possess other tools.
- Required/blocking deferred requirement: `revise_plan` CTA.
- Optional warning deferred requirement: no retry and no destructive CTA.

### Unknown legacy

- Badge: `Re-open plan to recompute`
- Tone: neutral/warning
- CTA: request plan regeneration where available.
- Never invent approved/required mode from old status/capabilities.

## Reader normalization

Extend `execution-design-metadata.ts` to read and validate persisted:

- `mode`;
- `recoveryAction`;
- `admissionStatus`;
- structured `grantState`;
- `normalizedCapabilities`;
- `capabilityClasses`;
- `evidenceRefs`.

Rules:

- malformed values become `unknown_legacy` or are omitted fail-closed;
- package current grant phases override stale preview grant state for live display;
- no reason-string parsing;
- S5 writes no broker/admission state.

## Task page architecture

### Decision groups

Group canonical decisions into separate sections:

1. Planning context;
2. Approved bounded context;
3. Action required;
4. Deferred boundary;
5. Legacy/recompute.

Do not put deferred or pure planning warnings in the destructive blocker alert.

### Retry controls

`RetryHandoffControls` renders only when persisted `metadata.mcpBroker.retryable === true`. Its action and label derive from persisted `primaryRecoveryAction`. Never infer retryability from status or reason.

### Grant controls

Each package grant control has a stable DOM target. The copy helper’s approve CTA points to it. First-time, denied, revoked, and consumed states are visually and textually distinct.

### Packet evidence

Read S4 artifact by `(agentRunId, artifactType='mcp_bounded_context_packet_metadata')`.

Display only:

- approved root identifier;
- included count;
- byte count;
- omitted count;
- redaction summary;
- assembled versus pre-assembly failure state.

Never display selected paths, file names, excerpts, or contents. Clearly separate packet evidence from sandbox-generated files and host-applied changes.

### Client policy removal

Remove client-side filesystem capability canonicalization and unresolved-grant calculations. Prefer server-computed canonical decisions/current grant state. Any remaining helper must be a pure presentation utility over typed server data, not policy.

## Project MCP surface

For each configured MCP:

- health/status badge;
- runtime boundary note based on catalog mode and `liveTools`;
- remediation CTA from catalog metadata for missing, disabled, unhealthy, configuration-required, and auth-required states;
- stable anchor `project-mcps-heading`.

Boundary text examples:

- filesystem: `Bounded read-only context; no live tool handles`;
- github external service: `Planning context only in this beta; no live tool handles`.

## MCP catalog surface

Each catalog entry displays:

- `Bounded context` for `bounded_context_packet`;
- `External service` for `external_service`;
- static `No live tool handles (beta)` line;
- supported safe-read capabilities and remediation metadata without implying runtime authorization.

## Accessibility and responsive behavior

- Badge color is never the only signal.
- CTAs have descriptive labels and focus targets.
- Deep-link target receives visible focus/scroll margin.
- Neutral deferred/planning states retain adequate contrast.
- Mobile cards preserve headline, body, and action ordering.
- Artifact metadata tables collapse into labelled rows on narrow screens.

## Test matrix

Unit-test every valid `(mode,status,recoveryAction,grantState,requirement,retryable)` mapping and malformed/legacy inputs.

Component/integration tests:

1. first-time, denied, revoked, consumed copy distinct;
2. revocation reason shown bounded and escaped;
3. deferred required has revise-plan CTA;
4. deferred optional has no retry;
5. planning-only write neutral and separate;
6. install/fix deep-link target exists;
7. retry absent when broker is non-retryable;
8. packet artifact reveals no paths/content;
9. legacy decision does not fabricate approval;
10. project unhealthy/missing remediation;
11. catalog boundary badges;
12. keyboard focus and mobile rendering.

## Ownership boundaries

- #177 owns broker and decision persistence.
- #178 owns grant recovery behavior.
- #179 owns issuance and artifact schema.
- #180 is reader/presentation only.
- If a required field is missing from current producers, fix the producing issue/contract instead of persisting UI state here.

## Implementation order

1. Add presentation contract and exhaustive tests.
2. Harden metadata reader.
3. Replace task-page status/retry/grant rendering.
4. Add packet evidence display.
5. Remove client policy reimplementation.
6. Update project and catalog MCP surfaces.
7. Run accessibility, responsive, and preview verification.

## Stop conditions

Stop if the UI must parse reasons, infer retryability, invent legacy modes, persist admission state, or expose packet names/paths/content. Stop if copy claims ACP is sandboxed or that equivalent operations are impossible outside the MCP channel.
