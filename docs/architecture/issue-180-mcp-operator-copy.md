# Issue #180 Architecture: Unified MCP Operator Presentation

Status: architecture proposal
Issue: #180
Parent: #172
Depends on: #176, #177, #179

## Objective

Give operators one consistent explanation and action for every canonical MCP admission state across task, project, and MCP catalog surfaces. The UI reads persisted canonical state; it does not infer admission, mutate broker metadata, parse human reasons, or recreate filesystem policy.

## Presentation contract

Create `web/lib/mcps/admission-copy.ts` as one copy module with three surface
presenters plus one current issuance-recovery presenter. Task admission decisions,
project health rows, catalog entries, and the S4 packet-recovery marker are
different truth sources; no presenter invents fields owned by another source.

```ts
type AdmissionDecisionPresentationInput = {
  mode: McpAdmissionMode;
  admissionStatus: McpAdmissionStatus;
  recoveryAction?: McpRecoveryAction;
  grantState?: {
    phase: EffectiveGrantState['phase'];
    consumed?: boolean;
    revocationReason?: string;
  };
  requirement: 'required' | 'optional';
  retryable: boolean;
  projectId: string;
  packageGrantTargetId?: string;
};

type ProjectMcpPresentationInput = {
  projectId: string;
  mcpId: McpId;
  installState: McpInstallState;
  healthStatus: McpHealthStatus;
  enabled: boolean;
  remediation?: ProjectMcpStatus['remediation'];
  runtime: McpCatalogEntry['runtime'];
};

type CatalogMcpPresentationInput = Pick<McpCatalogEntry, 'id' | 'runtime'>;

type PacketCurrentStatePresentationInput =
  | {
      source: 'active_claim';
      taskStatus: TaskStatus;
      packageStatus: WorkPackageStatus;
      auditStatus: 'claiming';
      phase:
        | 'preparing'
        | 'assembled'
        | 'submitting'
        | 'accepted_finalizing'
        | 'failed_finalizing';
      deliveryState:
        | 'not_exposed'
        | 'submitting'
        | 'submission_failed'
        | 'submitted';
      leaseActive: true;
      databaseObservedAt: string;
    }
  | {
      source: 'recovery_marker';
      marker: PacketIssuanceRecoveryMarkerV2;
      taskStatus: TaskStatus;
      packageStatus: WorkPackageStatus;
      currentPolicyFingerprint: string;
      currentAuthorization:
        | { state: 'same_decision'; decisionRevision: string }
        | {
            state: 'newer_covering_decision';
            priorDecisionRevision: string;
            decisionRevision: string;
          }
        | { state: 'not_covering' }
        | { state: 'unknown' };
      executionLeaseActive: boolean;
      issuanceLeaseActive: boolean;
    };

type PresentationCta =
  | { kind: 'scroll'; label: string; targetId: string }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'request_changes'; label: string }
  | {
      kind: 'retry';
      label: string;
      handler: 'retry_mcp_broker' | 'retry_packet_execution';
    }
  | {
      kind: 'review_submission';
      label: string;
      handler: 'acknowledge_possible_submission';
    }
  | { kind: 'install'; label: string; handler: 'install_mcp' }
  | { kind: 'enable'; label: string; handler: 'enable_mcp' }
  | { kind: 'connect'; label: string; handler: 'connect_account' }
  | { kind: 'configure'; label: string; handler: 'configure_project_mcp' }
  | { kind: 'inspect_fix'; label: string; handler: 'inspect_mcp_health' }
  | { kind: 'refresh'; label: string; handler: 'refresh_mcp_health' };

type AdmissionPresentation = {
  statusKey: 'planning' | 'approved' | 'action_required' | 'deferred' | 'unhealthy' | 'legacy';
  tone: 'neutral' | 'positive' | 'warning' | 'danger';
  badgeText: string;
  headline: string;
  body: string;
  cta?: PresentationCta;
};

type McpSurfacePresentation = AdmissionPresentation;

admissionPresentation(input: AdmissionDecisionPresentationInput): AdmissionPresentation;
projectMcpPresentation(input: ProjectMcpPresentationInput): McpSurfacePresentation;
catalogMcpPresentation(input: CatalogMcpPresentationInput): McpSurfacePresentation;
packetCurrentStatePresentation(input: PacketCurrentStatePresentationInput): AdmissionPresentation;
```

The functions must be deterministic, total, side-effect-free, and tested as
matrices. Human strings live here; component code renders the result. Shared
primitives own tones, badges, CTA shapes, runtime-boundary wording, and safe text
normalization, while each presenter accepts only fields its source can truthfully
provide.

## Three truth sources

The task page keeps these sources visually and structurally separate:

1. **Historical decision** — the versioned S2 preview/approval snapshot explains
   what Forge decided at that time.
2. **Current actionable state** — current package grant phases, project grant
   revision, package status, S2 broker marker, S4 `packet_issuance` recovery
   marker, active run-scoped packet audit, and leases determine which action is
   valid now.
3. **Issued evidence** — the immutable S4 artifact belongs to one exact
   `agentRunId` and work-package attempt.

Current grant state may add a bounded stale-state note to a historical decision,
but it must never relabel an old decision or packet artifact. Packet evidence is
rendered in the matching run/attempt, never selected as a task-global "latest"
artifact.

## Canonical mapping

### Tuple validation and precedence

The mapper validates the complete normalized tuple before selecting copy. The
following precedence is normative:

1. malformed, unknown, or incoherent persisted tuples become a neutral
   `unknown_legacy`/recompute presentation with no retry;
2. `recoveryAction:'revise_plan'` is an action-required presentation, including a
   required deferred requirement;
3. `recoveryAction:'approve_project_filesystem_context'` is an action-required
   grant presentation driven by structured grant phase;
4. `recoveryAction:'install_or_fix_mcp'` is unhealthy/remediation copy, even when
   `mode:'bounded_context_approved'` records that grant coverage exists;
5. warning-only deferred/planning states are neutral and never retryable;
6. positive `Context approved` requires `mode:'bounded_context_approved'`,
   `admissionStatus:'allowed'`, coherent approved and unconsumed grant state, no
   recovery action, and `retryable:false`.

Valid combinations include:

| Mode | Admission status | Recovery action | Presentation |
|---|---|---|---|
| `planning_only` | `allowed|warning` | `continue_as_prompt_context` | neutral planning; no CTA |
| `bounded_context_required` | `blocked|warning` | `approve_project_filesystem_context` | phase-aware grant action |
| `bounded_context_approved` | `allowed` | none | positive approved context |
| `bounded_context_approved` | `blocked|warning` | `install_or_fix_mcp` | unhealthy/remediation, never positive |
| `blocked` | `blocked` | `revise_plan` | destructive/action-required revise-plan |
| `deferred_live_mcp` | `blocked` | `revise_plan` | neutral boundary plus revise-plan CTA |
| `deferred_live_mcp` | `warning` | `defer_live_mcp_feature` | neutral boundary; no CTA |
| `unknown_legacy` | any normalized legacy status | none | neutral recompute; no retry |

Examples of incoherent tuples are approved context without an approved current
grant, required context with an unconsumed covering approval, retryable true for
anything other than an install/fix broker block, and a positive status with a
remediation action. They fail safely; the UI never repairs them from reason text.

### Planning only

- Badge: `Planning context`
- Tone: neutral
- Body: instruction-only; no MCP capability or bounded packet issued.
- CTA: none.
- Pure `filesystem.project.write` warning remains neutral and is not grouped with degradation.

### Bounded context required

Phase-specific copy:

- `none|proposed|not_issued`: `Needs project context`;
- `denied`: `Context was denied`;
- `revoked`: `Project context was removed`, include bounded revocation reason;
- approved + consumed: `One-time context approval was already used`.

CTA scrolls to the exact package grant controls. Do not infer phase from reason text.

### Bounded context approved

- When allowed and coherent, badge `Context approved`, positive tone, and body
  saying only approved read-only project context may be assembled.
- When health overlay changes the same mode to warning/blocked plus
  `install_or_fix_mcp`, render unhealthy/remediation copy, not green approval.
- Packet evidence is independent: show the matching run artifact when it exists;
  otherwise say that no packet evidence exists for that run.

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
- validate complete tuple coherence after validating each enum; a recognized mode
  with a missing/unknown `admissionStatus`, recovery action, or incompatible grant
  state is not positive;
- bound every persisted array and string before rendering: at most 64 items per
  list, 300 UTF-8 bytes for operator detail/revocation text, 120 bytes for labels,
  and 80 bytes for opaque identifiers;
- remove control/bidirectional formatting characters and use the existing MCP
  secret redaction for health/reason detail; never expose a host path;
- package current grant phases override stale preview grant state for live display;
- no reason-string parsing;
- S5 writes no broker/admission state.

All untrusted detail is rendered as React text nodes. It is never passed to
Markdown, `dangerouslySetInnerHTML`, an `href`, or a DOM identifier. Presenter CTAs
construct routes and targets only from validated application identifiers.

Legacy preview decisions without a canonical mode or admission status remain
readable as neutral recompute history. Legacy S4 packet artifacts containing a
path-valued `root` are never rendered. New evidence uses opaque `rootRef`; rollout
keeps the reader dual-format until S4 producers are upgraded, but neither format
authorizes an action.

## Task page architecture

### Decision groups

Group canonical decisions into separate sections:

1. Planning context;
2. Approved bounded context;
3. Action required;
4. Deferred boundary;
5. Legacy/recompute.

Do not put deferred or pure planning warnings in the destructive blocker alert.

### Broker retry controls

`RetryHandoffControls` renders only when all current compatibility conditions are
true:

- task status is exactly `approved`;
- package status is still `blocked`;
- the current versioned broker marker has `retryable:true` and
  `primaryRecoveryAction:'install_or_fix_mcp'`;
- the marker's package-policy fingerprint and block revision still match current
  package policy;
- no execution lease or S4 issuance claim is active for the package.

The retry route re-reads and locks project, task, and package in the global order,
rechecks the same predicate, and returns a structured stale-action `409` without
enqueueing when it no longer holds. The UI check is convenience, not authority.
Setup/remediation, revise-plan, approve-context, and issuance reapproval actions are
never rendered as retry.

### Packet issuance recovery controls

The current-state reader validates either S4's live run-scoped claim summary or
its versioned `packet_issuance` marker and passes the discriminated input to
`packetCurrentStatePresentation`; it never folds either source into the S2
`mcpBroker` contract. Runtime parsing normalizes unknown task/package statuses to
a fail-closed neutral state before the typed presenter is called.

- The server exhaustively maps a live `claiming` audit with an unexpired lease:
  `not_exposed` is “Preparing project context” or “Context assembled”; `submitting`
  is “Submitting to worker”; `submitted` is “Worker accepted — finalizing”; and
  `submission_failed` is “Submission failed — finalizing”. These are current states
  with no action, not immutable run evidence, and are never read from a terminal
  artifact. The server validates the phase/delivery combination, computes
  `leaseActive` against PostgreSQL time, and supplies the observation timestamp;
  the browser never compares `leaseExpiresAt` with `Date.now()`. An expired or
  incoherent observation normalizes to neutral “Refreshing run state” until S4
  recovery/finalization persists a terminal result.

- `reapprove_allow_once` shows “Approve one-time context again” and targets the
  package grant control. It never renders generic retry because the nonce burned
  when the packet claim committed.
- `review_then_reapprove_allow_once` first shows the possible-prior-submission
  acknowledgement. After the S4 action records that acknowledgement, the marker
  becomes `reapprove_allow_once`; only then does the package grant control create
  a fresh nonce.
- `retry_execution` is available for an `always_allow` marker whose delivery is
  `not_exposed|submission_failed` and disposition is `retry_execution`, or whose
  delivery is `submission_uncertain|submitted` and separately recorded
  disposition is `reviewed_submission`. In both cases the task is `approved`, the
  package is still `blocked`, package policy is unchanged, current authorization
  is `same_decision|newer_covering_decision`, and neither execution nor issuance
  lease is active. A newer decision is shown as explicit reauthorization, not as
  continuity of the old grant. The server route locks and rechecks the same
  predicate, records the authorizing current revision, clears only the matched
  marker, moves the package to `ready`, and wakes after commit. The normal claim
  path creates the new run and snapshots that current decision.
- `review_submission` is a marker disposition paired with immutable delivery
  `submission_uncertain|submitted`. It states that ACP may already have accepted
  work and offers S4's acknowledgement action. Acknowledgement keeps delivery
  unchanged, sets actor/time, and changes only the disposition to
  `reviewed_submission`; if exact current coverage still holds, the presenter may
  then offer S4's explicit `retry_execution` action. A live `submitting` claim is
  evidence-only and has no recovery action until stale recovery converts delivery
  to `submission_uncertain`.

If `currentAuthorization.state` is `not_covering`, the UI offers no packet retry.
It says that project context changed and targets the exact grant control. After an
operator restores complete coverage, the server returns
`newer_covering_decision`; a pre-intent marker may then expose explicit retry, and
a post-intent marker may do so only after possible-submission acknowledgement.
`unknown` remains neutral and actionless. The browser never compares revision
strings or computes capability coverage.

Every issuance marker has `autoRetryable:false`; the UI does not synthesize queue
retry from delivery state. Unknown/malformed/stale markers are neutral, expose no
action, and return a stale-action response if a previously rendered control races
current state.

### Grant controls

Each package grant control has a stable DOM target. The copy helper’s approve CTA points to it. First-time, denied, revoked, and consumed states are visually and textually distinct.

### Packet evidence

Read S4 artifact by `(agentRunId, artifactType='mcp_bounded_context_packet_metadata')`.

Display only:

- opaque approved `rootRef` (or the phrase `this project`); never a filesystem path;
- included count;
- byte count;
- omitted count;
- redaction summary;
- assembly state and delivery state as separate facts.

Never display selected paths, root paths, file names, excerpts, or contents. Ignore
generic artifact prose and render only validated typed metadata. Clearly separate
packet evidence from sandbox-generated files and host-applied changes. A failed
pre-assembly snapshot shows stage and sanitized reason without invented zero
counts. Delivery copy is exhaustive over S4's exact states:
`not_exposed|submission_failed|submitted|submission_uncertain`; terminal artifacts
never contain live `submitting`. Assembly never implies ACP acceptance. The
current-state reader may show any validated live phase above only while its lease
is valid. After recovery/finalization, the matching terminal artifact/marker owns
the result; an expired `submitting` intent becomes `submission_uncertain`.

### Client policy removal

Remove client-side filesystem capability canonicalization and unresolved-grant calculations. Prefer server-computed canonical decisions/current grant state. Any remaining helper must be a pure presentation utility over typed server data, not policy.

## Project MCP surface

For each configured MCP:

- health/status badge;
- runtime boundary note based on catalog mode and `liveTools`;
- remediation CTA from catalog metadata for missing, disabled, unhealthy, configuration-required, and auth-required states;
- stable anchor `project-mcps-heading`.

Project-health action precedence is exhaustive:

| Current state | Action |
|---|---|
| install missing | install using catalog remediation |
| installed but disabled or `enabled:false` | enable |
| `auth_required` | connect account |
| `configuration_required` | configure project path/settings |
| `unhealthy` | inspect/fix using bounded remediation |
| `unknown` | refresh status; no handoff retry |
| healthy and enabled | no remediation CTA |
| incoherent/future value | neutral `Status unavailable`; refresh only |

Each project action uses the matching typed `kind` and validated `handler` (or a
catalog-owned validated `href` where navigation is the real action). Setup actions
are never encoded as `retry`; components switch exhaustively on this discriminant
and cannot call a different handler because two actions share a generic link.

Project health describes setup independently of a historical task decision. In
particular, GitHub planning-only context is not presented as admission-blocked by
GitHub runtime health.

Boundary text examples:

- filesystem: `Bounded read-only context; no live tool handles`;
- github external service: `Planning context only in this beta; no live tool handles`.

## MCP catalog surface

Each catalog entry displays:

- `Bounded context` for `bounded_context_packet`;
- `External service` for `external_service`;
- static `No live tool handles (beta)` line;
- supported safe-read capabilities and remediation metadata without implying runtime authorization.

The catalog presenter consumes static catalog data only. It never accepts project
health, task retryability, or grant state. An unknown future runtime mode or
`liveTools:true` value fails to neutral `Runtime boundary unavailable` copy and
does not invent beta authorization.

## Accessibility and responsive behavior

- Badge color is never the only signal.
- CTAs have descriptive labels and focus targets.
- Deep-link target receives visible focus/scroll margin.
- Neutral deferred/planning states retain adequate contrast.
- Mobile cards preserve headline, body, and action ordering.
- Artifact metadata tables collapse into labelled rows on narrow screens.
- Cross-page remediation focuses a programmatically focusable
  `project-mcps-heading` after fragment navigation and retains scroll margin.
- Async grant, retry, and stale-action results use appropriate polite/assertive
  live regions without moving focus unexpectedly.

## Test matrix

Unit-test every valid
`(mode,admissionStatus,recoveryAction,grantState,requirement,retryable)` mapping,
all invalid tuple pairs, and malformed/legacy inputs. Exhaustively test project
health and catalog runtime presenters, including unknown future enum values.

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
13. approved coverage plus unhealthy status never renders green;
14. stale policy fingerprint or active lease hides retry and the route rejects it;
15. hostile/oversized strings are bounded, redacted, and rendered as text;
16. two runs keep historical decision, current controls, and each run's evidence separate;
17. legacy path-valued `root` is not rendered and new opaque `rootRef` is;
18. missing/unhealthy GitHub project health does not relabel admitted planning context.
19. every S4 delivery state renders separately from assembly and never implies
    submission from counts alone;
20. one-time issuance recovery targets reapproval, safe pre-intent always-allow
    recovery uses the locked retry predicate, and post-intent ambiguity initially
    requires review with no retry; only a recorded acknowledgement may yield the
    `reviewed_submission` disposition and then expose the same locked
    current-coverage retry predicate.
21. `not_issued` maps to Needs project context, and each project health state
    invokes its distinct typed install/enable/connect/configure/fix/refresh action.
22. a live `submitting` audit is current in-progress state only; terminal artifacts
    reject `submitting` and render recovered `submission_uncertain` separately.
    Live preparing/assembled/submitting/accepted-finalizing/failed-finalizing
    phases are exhaustive, actionless, and never sourced from terminal artifacts.
23. task/package status normalization and every CTA discriminant fail closed; an
    install CTA cannot carry a refresh/configure handler.
24. skewed browser clocks cannot change live submission copy because the server's
    database-time `leaseActive` observation is authoritative.
25. revocation hides packet retry; restoring exact always-allow coverage under a
    newer revision renders explicit reauthorization and permits one locked retry
    (after acknowledgement for post-intent delivery), while narrower/unknown
    coverage and changed package policy remain actionless.
26. two identical recovery actions converge on one recorded success and one visible
    transition; only a changed fingerprint/state renders a stale-action `409`.

## Ownership boundaries

- #177 owns broker and decision persistence.
- #178 owns grant recovery behavior.
- #179 owns issuance and artifact schema.
- #180 is reader/presentation only.
- If a required field is missing from current producers, fix the producing issue/contract instead of persisting UI state here.

## Implementation order

1. Land the S4 evidence schema and producer with opaque `rootRef` and ensure S2
   broker fields are deployed.
2. Add the three surface presenters, the issuance-recovery presenter, and
   exhaustive tests.
3. Harden the dual-format metadata reader, including incoherent/future values.
4. Replace task-page status/retry/grant rendering and remove client policy copies.
5. Add run-linked packet evidence display.
6. Update project and catalog MCP surfaces.
7. Run accessibility, hostile-input, responsive, and preview verification.

S5 is read-compatible during rollout: old records stay neutral and non-actionable;
new fields become visible only after their producer is deployed. Rollback removes
only the S5 reader/UI code. It does not roll back or reinterpret S2/S4 schema, and
old path-valued evidence remains suppressed.

## Stop conditions

Stop if the UI must parse reasons, infer retryability, invent legacy modes, persist
admission state, render an unvalidated tuple, or expose packet root paths,
names/paths/content. Stop if the retry route cannot atomically recheck current
compatibility, or if copy claims ACP is sandboxed or that equivalent operations are
impossible outside the MCP channel.
