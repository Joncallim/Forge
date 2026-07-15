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

type ActivePacketClaimState =
  | {
      phase: 'preparing';
      assemblyState: 'not_assembled';
      deliveryState: 'not_exposed';
    }
  | {
      phase: 'assembled';
      assemblyState: 'assembled';
      deliveryState: 'not_exposed';
    }
  | {
      phase: 'submitting';
      assemblyState: 'assembled';
      deliveryState: 'submitting';
    }
  | {
      phase: 'accepted_finalizing';
      assemblyState: 'assembled';
      deliveryState: 'submitted';
    }
  | {
      phase: 'rejected_finalizing';
      assemblyState: 'assembled';
      deliveryState: 'submission_failed';
    };

type PacketRecoveryRequestIdentity = {
  schemaVersion: 2;
  priorRuntimeAuditId: string;
  markerFingerprint: string;
};

type PacketCurrentStatePresentationInput =
  | {
      source: 'active_claim';
      taskStatus: TaskStatus;
      packageStatus: WorkPackageStatus;
      auditStatus: 'claiming';
      claimState: ActivePacketClaimState;
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
        | {
            state: 'same_decision';
            decisionRevision: string;
            rootBindingRevision: string;
          }
        | {
            state: 'newer_covering_decision';
            priorDecisionRevision: string;
            decisionRevision: string;
            priorRootBindingRevision: string;
            rootBindingRevision: string;
          }
        | {
            state: 'not_covering';
            reason:
              | 'denied'
              | 'revoked'
              | 'narrowed'
              | 'policy_changed'
              | 'root_changed';
          }
        | { state: 'unknown' };
      executionLeaseActive: boolean;
      issuanceLeaseActive: boolean;
      siblingBarrier: 'none' | 'active_execution' | 'awaiting_review';
    }
  | {
      source: 'integrity_hold';
      hold: PacketIntegrityHoldV2;
      alertId: string;
      evidenceFingerprint: string;
      taskStatus: TaskStatus;
      packageStatus: WorkPackageStatus;
    }
  | {
      source: 'integrity_quarantine_closed';
      hold: PacketIntegrityHoldV2 & { reason: 'audit_artifact_mismatch' };
      resolution: {
        kind: 'quarantined_abandoned';
        actorId: string;
        resolvedAt: string;
        evidenceFingerprint: string;
      };
      taskStatus: 'cancelled';
      packageStatus: 'cancelled';
    }
  | {
      source: 'quiescence_wait';
      reason: 'post_submission_quiescence_unproven';
      priorRuntimeAuditId: string;
      evidenceFingerprint: string;
      effectIntent: Extract<
        PacketPostSubmissionEffectIntent,
        { state: 'active' }
      >;
      taskStatus: 'running';
      packageStatus: 'running';
      leaseActive: false;
    };

type PresentationCta =
  | { kind: 'scroll'; label: string; targetId: string }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'request_changes'; label: string }
  | {
      kind: 'retry';
      label: string;
      handler: 'retry_mcp_broker';
    }
  | {
      kind: 'retry_packet_execution';
      label: string;
      handler: 'retry_packet_execution';
      request: PacketRecoveryRequestIdentity;
    }
  | {
      kind: 'review_submission';
      label: string;
      handler: 'acknowledge_possible_submission';
      request: PacketRecoveryRequestIdentity;
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

The current-state reader validates S4's live run-scoped claim summary, versioned
`packet_issuance` marker, typed integrity hold, or bounded quiescence alert and passes the discriminated input to
`packetCurrentStatePresentation`; it never folds either source into the S2
`mcpBroker` contract. Runtime parsing normalizes unknown task/package statuses to
a fail-closed neutral state before the typed presenter is called.

- The server exhaustively maps a live `claiming` audit with an unexpired lease
  into `ActivePacketClaimState`. The discriminated union makes impossible pairs
  unrepresentable: unassembled is never submitted, and submitting always has
  assembled metadata. It renders “Preparing project context”, “Context assembled”,
  “Submitting to worker”, “Worker accepted — finalizing”, or “Submission rejected
  — finalizing”. These are the last durable staged states, with no action; they are
  not worker-memory failure intent and are never read from a terminal artifact. A
  local preflight/assembly/provider/post-submission error remains on its last
  durable staged copy until S4 atomically commits terminal evidence. S5 never
  invents `failed_finalizing`. The server validates the complete claim-state discriminant, computes
  `leaseActive` against PostgreSQL time, and supplies the observation timestamp;
  the browser never compares `leaseExpiresAt` with `Date.now()`. An expired
  observation with active post-submission effect intent and S4's bounded alert
  renders “Waiting for worker changes to stop” with no action until the
  authoritative owning host and the complete supervised process group prove the
  resource fence quiescent. A wrong, stale, or unreachable host remains in this
  state and never offers a new-run control. Other expired/incoherent observations
  normalize to neutral “Refreshing run state” until S4 recovery/finalization
  persists a terminal result.

- A typed `packet_integrity_hold` is reason-specific and has no web action.
  `terminal_success_materialization_incomplete` renders neutral “Run evidence
  needs operator repair.” `audit_artifact_mismatch` renders “Run evidence
  conflicts — quarantined” and explains that immutable records cannot be rewritten;
  Release/DevOps may inspect and, when neither verified outcome is provable,
  permanently close the task. Neither state borrows packet-failure copy or offers
  reapproval/retry. Both name Release/DevOps ownership and the checked-in
  `docs/operators/packet-integrity-repair.md` procedure without making its
  privileged command a browser CTA. Alert ID/fingerprint are bounded support
  correlation, not user-editable inputs.

- An exact append-only `quarantined_abandoned` resolution joined to that mismatch,
  cancelled package, and cancelled task renders “Task closed — evidence
  quarantined.” It states that Forge preserved the conflicting records and no new
  run is available. Missing/mismatched resolution identity remains the unresolved
  integrity hold; the browser never infers closure from status alone.

- `reapprove_allow_once` shows “Approve one-time context again” and targets the
  package grant control. It never renders generic retry because the nonce burned
  when the packet claim committed.
- `review_then_reapprove_allow_once` first shows the possible-prior-submission
  acknowledgement. When S4's host ledger requires review, the same static copy
  also says local files may contain partial work and the control label is “I
  reviewed the submission and local changes.” After the S4 action records that
  acknowledgement against the exact marker/ledger fingerprint, the marker
  becomes `reapprove_allow_once`; only then does the package grant control create
  a fresh nonce.
- `retry_execution` is available for an `always_allow` marker whose delivery is
  `not_exposed|submission_failed` and disposition is `retry_execution`, or whose
  delivery is `submission_uncertain|submitted` and separately recorded
  disposition is `reviewed_submission`. In both cases the task is `approved`, the
  package is still `blocked`, package policy is unchanged, current authorization
  is `same_decision|newer_covering_decision`, and neither execution nor issuance
  lease is active. `hostApplyReview` must be `not_applicable|reviewed`; required or
  changed-fingerprint review exposes no retry. A newer decision is shown as explicit reauthorization, not as
  continuity of the old grant. The server route locks and rechecks the same
  predicate, records the authorizing current revision, clears only the matched
  marker, moves the package to `ready`, and wakes after commit. The normal claim
  path creates the new run and snapshots that current decision.
- `review_submission` is a marker disposition paired with immutable delivery
  `submission_uncertain|submitted`. It states that ACP may already have accepted
  work and offers S4's acknowledgement action. Acknowledgement keeps delivery
  unchanged, sets actor/time, records the exact host-ledger working-tree review
  when required, and changes the disposition to
  `reviewed_submission`; if exact current coverage still holds, the presenter may
  then offer S4's explicit `retry_execution` action. A live `submitting` claim is
  evidence-only and has no recovery action until stale recovery converts delivery
  to `submission_uncertain`.

`currentAuthorization` is the server's projection of canonical S1
`readEffectiveGrantState`, not a direct project-row coverage check. The reader
preserves S3 denial-wins, including an equal/newer package denial. If
`currentAuthorization.state` is `not_covering`, the UI offers no packet retry. It
says that project context changed and targets the exact grant control. After an
operator restores complete coverage, the server returns
`newer_covering_decision`; a pre-intent marker may then expose explicit retry, and
a post-intent marker may do so only after possible-submission acknowledgement.
`unknown` remains neutral and actionless. The browser never compares revision
strings, root-binding revisions, or capability coverage. A `root_changed`
authorization renders “Project root changed — approve context again”; it never
offers retry under the old decision or displays either filesystem path.

Every issuance marker has `autoRetryable:false`; the UI does not synthesize queue
retry from delivery state. Unknown/malformed/stale markers are neutral, expose no
action, and return a stale-action response if a previously rendered control races
current state.

The current-state reader imports S4's discriminated
`PacketIssuanceRecoveryMarkerV2` union and rejects every known-invalid
grant-mode/delivery/disposition/acknowledgement combination before presentation.
It joins `priorRuntimeAuditId` to the exact prior audit, all applicable run
artifacts (including the packet artifact), and any host-apply ledger; proves the
typed terminal tuples equal; binds marker and host-review fingerprints; and
validates assembly + delivery + terminal status + failure code/conditional stage
together. The marker alone is insufficient. Missing,
mismatched, or terminal-success-plus-failure-marker evidence becomes a typed or
neutral integrity hold with no action. The browser never assembles those
independent fields into a state.

Both packet actions carry S4's immutable version-2 request identity
`{priorRuntimeAuditId, markerFingerprint}`. Components do not reconstruct it from
the current marker or send an action-only request. When stale recovery leaves the
task `running` because another sibling package still holds a live execution lease,
the marker renders neutral “Waiting for active package” with no action. If
`siblingBarrier:'awaiting_review'`, it instead renders “Waiting for required
review.” Actions
become eligible only after S4's post-sibling/periodic task-state reconciler makes
the task exactly `approved`; S5 never performs that transition.

S5 imports S4's exact closed `PacketFailureCode` enum. It maps only those values to
bounded copy; an unknown value is legacy/unknown and actionless, never displayed as
server-provided free text. `post_submission_execution_failed` additionally
requires S4's closed stage and renders static stage copy. For `host_apply`, the
copy warns that some local files may already have changed. Every such submitted
failure says the external submission may have produced work, says Forge did not
roll back local changes, requires the operator to inspect/resolve the working tree,
and offers no automatic resubmission. It never displays a path, file name, command,
provider text, or raw/sanitized exception.
`completion_preparation` refers only to work before the atomic finalizer; a gate
insert/finalizer rollback remains in-progress/recovery state and never renders that
cause.

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
- assembly state, delivery state, and terminal success/failure as separate facts.

Never display selected paths, root paths, file names, excerpts, or contents. Ignore
generic artifact prose and render only validated typed metadata. Clearly separate
packet evidence from sandbox-generated files and host-applied changes. A failed
pre-assembly snapshot shows stage plus enum-derived static failure copy without
invented zero counts or raw/sanitized exception detail. A terminal success is
valid only with `assembled+submitted`; a terminal failure must match S4's exact
assembly/delivery/failure-code/conditional-stage compatibility table. A
post-submission execution failure is shown separately from provider-response
validity and from host-change evidence; packet state never claims whether local
changes were fully or partially applied. Delivery copy is exhaustive over S4's exact states:
`not_exposed|submission_failed|submitted|submission_uncertain`; terminal artifacts
never contain live `submitting`. Assembly never implies ACP acceptance. The
current-state reader may show any validated live phase above only while its lease
is valid. After recovery/finalization, the matching terminal artifact/marker owns
the result; an expired `submitting` intent becomes `submission_uncertain`.
The host-apply ledger remains separate: packet presentation consumes only its
bounded `not_applicable|review_required|reviewed` state and fingerprint. Exact
write-plan entries/paths stay in the authorized repository-change surface and are
never copied into packet copy, task events, or integrity alerts.

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
    Live preparing/assembled/submitting/accepted-finalizing/rejected-finalizing
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
27. every valid `ActivePacketClaimState` pair renders its intended actionless copy;
    invalid phase/assembly/delivery cross-products fail closed to “Refreshing run
    state” and cannot reach the typed presenter. Preflight, assembly,
    provider-validation, and post-submission local failures cannot be inferred
    before terminal commit; a restarted reader shows the last durable phase.
28. retry and acknowledgement controls carry the exact version-2 prior-audit and
    marker-fingerprint identity. A component cannot submit an action-only request
    or substitute identity from another task/package.
29. a project allow decision racing an equal/newer package denial renders
    `not_covering` from the canonical reader and never exposes packet retry.
30. a recovery marker on a `running` task with a live sibling package renders
    “Waiting for active package” without an action; the same durable marker becomes
    actionable only after the S4 task-state reconciler makes the task `approved`.
    An `awaiting_review` sibling renders “Waiting for required review” and likewise
    suppresses every action.
31. every closed S4 `PacketFailureCode` maps to bounded static copy, while an
    unknown/future code is neutral, actionless, and never rendered verbatim.
32. every valid S4 grant-mode/delivery/disposition/acknowledgement marker tuple
    renders the one allowed action; every known-invalid cross-product is neutral
    and actionless before the typed presenter.
33. terminal success renders only for `assembled+submitted`. Every valid terminal
    failure tuple renders assembly, delivery, and enum-derived cause separately;
    every known-invalid stage/delivery/code combination and all raw path-bearing
    exception text fail closed without display.
34. every closed post-submission stage renders bounded static copy. `host_apply`
    warns of possible partial local changes; all stages require prior-work review,
    expose no automatic resubmission, and never render raw/path-bearing detail.
35. a recovery marker is actionable only when the exact prior audit and artifact
    have equal typed failed tuples and match marker identity. Mismatch,
    terminal-success-plus-failure-marker, and both `PacketIntegrityHoldV2` reasons
    render neutral, actionless maintenance copy.
36. killing the worker after each persisted active phase and reading from a new
    process proves S5 derives preparing, assembled, submitting,
    rejected-finalizing, or accepted-finalizing from PostgreSQL alone and never
    synthesizes `failed_finalizing`.
37. an expired submitted claim with active effect intent and a quiescence alert
    renders “Waiting for worker changes to stop,” remains actionless, and never
    exposes a new-run control until S4 persists `quiesced`.
38. every `HostApplyRecoveryReview` tuple is exhaustive. `review_required` uses
    exact marker/ledger-fingerprint acknowledgement and hides retry/reapproval;
    `reviewed` permits only the normal locked predicate; changed fingerprints fail
    closed.
39. `completion_preparation` renders only for a terminal failed tuple. Atomic
    gate/finalizer rollback remains neutral in-progress/recovery state and cannot
    be mislabeled with that cause.
40. each integrity reason creates one bounded support correlation with
    Release/DevOps/runbook copy. A true mismatch uses quarantine language, not a
    repair promise. No browser repair CTA exists; unauthorized, stale-fingerprint,
    and normal recovery controls leave the hold unchanged.
41. exact `quarantined_abandoned` resolution plus cancelled task/package renders
    permanent evidence quarantine/closure with no retry. A missing, stale, wrong-
    reason, or status-only resolution remains actionless and unresolved.
42. wrong-host recovery and worker/supervisor death with a surviving descendant
    retain “Waiting for worker changes to stop” and expose no control until S4
    proves the resource fence quiescent.
43. a root-binding mismatch renders bounded `root_changed` reapproval copy with no
    old-decision retry and no old/new path or internal resource reference.

## Ownership boundaries

- #177 owns broker and decision persistence.
- #178 owns grant recovery behavior.
- #179 owns issuance and artifact schema.
- #180 is reader/presentation only.
- If a required field is missing from current producers, fix the producing issue/contract instead of persisting UI state here.

## Implementation order

1. Land the S4 evidence/fence/host-ledger/integrity-alert schema and producer with
   opaque `rootRef`; install its operator runbook; and ensure S2 broker fields are deployed.
2. Add the three surface presenters plus issuance-recovery, quiescence-wait, and
   integrity-hold presenters, and
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
Also stop if any action appears while host quiescence or working-tree review is
unproven, while a sibling awaits mandatory review, or on an integrity hold; if
packet copy needs host ledger paths; or if atomic finalizer rollback is mislabeled
as `completion_preparation`.
