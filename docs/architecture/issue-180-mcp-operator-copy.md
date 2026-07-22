# Issue #180 Architecture: Unified MCP Operator Presentation

Status: architecture proposal
Issue: #180
Parent: #172
Depends on: #176, #177, #178, remaining #179/S4

## Objective

Give operators one consistent explanation and action for every canonical MCP admission state across task, project, and MCP catalog surfaces. The UI reads persisted canonical state; it does not infer admission, mutate broker metadata, parse human reasons, or recreate filesystem policy.

## Presentation contract

Create `web/lib/mcps/admission-copy.ts` as one copy module with four surface
presenters, including terminal packet evidence, plus two current-state presenters:
packet issuance and packet-independent local-run recovery. Task admission decisions,
project health rows, catalog entries, terminal packet evidence, the S4 packet
marker, and generic local evidence are different truth sources; no presenter
invents fields owned by another source.

```ts
// Imported from S3; S5 does not redeclare or widen either union.
type AdmissionFilesystemGrantPresentationState =
  | {
      kind: 'not_applicable';
    }
  | {
      kind: 'effective_approved';
      grantPhase: 'approved';
      grantConsumed: false;
      grantDecisionRevision: CanonicalPositiveDecisionRevision;
      revocationReason: null;
    }
  | ({ kind: 'operator_hold' } & FilesystemGrantHoldState);

type AdmissionDecisionPresentationInput = {
  mode: McpAdmissionMode;
  admissionStatus: McpAdmissionStatus;
  recoveryAction?: McpRecoveryAction;
  grantState: AdmissionFilesystemGrantPresentationState;
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
      phase: 'assembling';
      assemblyState: 'assembling';
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

// Imported from S4's one production evidence module; S5 neither redeclares nor
// widens TerminalPacketAssemblyState, TerminalPacketDeliveryOutcome,
// PacketTerminalOutcome, PacketFailureCode, PostSubmissionFailureStage,
// LocalRunEffectIntent, HostApplyRecoveryReview, or RepositoryChangeReview.
type PacketTerminalEffectDisplayProjection =
  | Pick<
      Extract<LocalRunEffectIntent, { state: 'not_started' }>,
      'state'
    >
  | Pick<
      Extract<LocalRunEffectIntent, { state: 'quiesced' }>,
      'state' | 'lastStage' | 'hostApplyLedgerFingerprint'
    >;

type PacketHostApplyReviewDisplayProjection =
  | Extract<HostApplyRecoveryReview, { state: 'not_applicable' }>
  | Pick<
      Extract<HostApplyRecoveryReview, { state: 'review_required' }>,
      'state' | 'ledgerFingerprint'
    >
  | Pick<
      Extract<HostApplyRecoveryReview, { state: 'reviewed' }>,
      'state' | 'ledgerFingerprint'
    >;

type PacketRepositoryReviewDisplayProjection =
  | Pick<
      Extract<RepositoryChangeReview, { state: 'not_applicable' }>,
      'state' | 'baselineFingerprint' | 'changeResult'
    >
  | Pick<
      Extract<RepositoryChangeReview, { state: 'review_required' }>,
      'state' | 'baselineFingerprint' | 'changeResult' | 'changeFingerprint'
    >
  | Pick<
      Extract<RepositoryChangeReview, { state: 'reviewed' }>,
      'state' | 'baselineFingerprint' | 'changeResult' | 'changeFingerprint'
    >;

type PacketTerminalDisplayProjection = Readonly<{
  schemaVersion: 2;
  assembly: TerminalPacketAssemblyState;
  delivery: TerminalPacketDeliveryOutcome;
  terminal: PacketTerminalOutcome;
  effect: PacketTerminalEffectDisplayProjection;
  hostApplyReview: PacketHostApplyReviewDisplayProjection;
  repositoryReviews: Readonly<{
    workingTree: PacketRepositoryReviewDisplayProjection;
    gitControl: PacketRepositoryReviewDisplayProjection;
    gitStorage: PacketRepositoryReviewDisplayProjection;
  }>;
  combinedRepositoryReviewFingerprint: string;
}>;

// This projection is exhaustive only for immutable terminal evidence. Mutable
// packet-recovery marker, acknowledgement, disposition, and action state remains
// exclusively in PacketCurrentStatePresentationInput.

type PacketArtifactPresentationInput =
  | {
      source: 'validated_artifact';
      agentRunId: string;
      localRunEvidenceFingerprint: string;
      projection: PacketTerminalDisplayProjection;
    }
  | {
      source: 'artifact_unavailable';
      agentRunId: string;
      reason:
        | 'unsupported_schema_version'
        | 'invalid_artifact_binding'
        | 'invalid_assembly_tuple'
        | 'unknown_redaction_category'
        | 'invalid_redaction_count'
        | 'invalid_delivery_tuple'
        | 'invalid_terminal_tuple'
        | 'unknown_failure_code'
        | 'invalid_failure_stage'
        | 'invalid_effect_tuple'
        | 'invalid_host_ledger_tuple'
        | 'invalid_host_apply_review'
        | 'invalid_repository_review'
        | 'invalid_repository_review_fingerprint'
        | 'terminal_projection_mismatch';
    };

type PacketRecoveryRequestIdentity = {
  schemaVersion: 2;
  priorRuntimeAuditId: string;
  markerFingerprint: string;
};

type LocalEffectRecoveryRequestIdentity = {
  schemaVersion: 1;
  localRunEvidenceId: string;
  evidenceFingerprint: string;
};

type IntegrityQuarantineRequestIdentity = {
  schemaVersion: 1;
  alertId: string;
  reason:
    | PacketIntegrityHoldV2['reason']
    | LocalEffectIntegrityHoldV1['reason'];
  projectId: string;
  taskId: string;
  packageId: string;
  priorAgentRunId: string;
  packetAuditId: string | null;
  localRunEvidenceId: string | null;
  expectedLocalRunEvidenceId: string | null;
  expectedEvidenceFingerprint: string;
  expectedClassificationFingerprint: string;
  expectedSiblingEvidenceSetFingerprint: string;
  requestedResolution: 'quarantined_abandoned';
  requestedRepositoryDisposition: 'reviewed' | 'abandoned';
  actorId: string;
};

type LocalIntegrityRepairClassification =
  | {
      reason: 'missing_local_evidence';
      outcome: 'quarantine_only';
      permittedResolution: 'quarantined_abandoned';
      classificationFingerprint: string;
    }
  | {
      reason: 'local_evidence_mismatch';
      outcome: 'reconstructable';
      permittedResolution:
        | 'verified_success'
        | 'verified_failure'
        | 'generic_failure_reconstructed';
      classificationFingerprint: string;
    }
  | {
      reason: 'local_evidence_mismatch';
      outcome: 'irreconcilable';
      permittedResolution: 'quarantined_abandoned';
      classificationFingerprint: string;
    }
  | {
      reason: 'task_projection_mismatch';
      outcome: 'reconstructable';
      permittedResolution: 'projection_recomputed';
      classificationFingerprint: string;
    }
  | {
      reason: 'task_projection_mismatch';
      outcome: 'irreconcilable';
      permittedResolution: 'quarantined_abandoned';
      classificationFingerprint: string;
    }
  | {
      reason: 'quiescence_state_incoherent';
      outcome: 'awaiting_service_proof';
      permittedResolution: 'quiescence_proven';
      classificationFingerprint: string;
    }
  | {
      reason: 'quiescence_state_incoherent';
      outcome: 'irreconcilable';
      permittedResolution: 'quarantined_abandoned';
      classificationFingerprint: string;
    };

type LocalEffectIntegrityHoldPresentationState =
  | {
      hold: Extract<
        LocalEffectIntegrityHoldV1,
        { reason: 'missing_local_evidence' }
      >;
      repairClassification: Extract<
        LocalIntegrityRepairClassification,
        { reason: 'missing_local_evidence' }
      >;
    }
  | {
      hold: Extract<
        LocalEffectIntegrityHoldV1,
        { reason: 'local_evidence_mismatch' }
      >;
      repairClassification: Extract<
        LocalIntegrityRepairClassification,
        { reason: 'local_evidence_mismatch' }
      >;
    }
  | {
      hold: Extract<
        LocalEffectIntegrityHoldV1,
        { reason: 'task_projection_mismatch' }
      >;
      repairClassification: Extract<
        LocalIntegrityRepairClassification,
        { reason: 'task_projection_mismatch' }
      >;
    }
  | {
      hold: Extract<
        LocalEffectIntegrityHoldV1,
        { reason: 'quiescence_state_incoherent' }
      >;
      repairClassification: Extract<
        LocalIntegrityRepairClassification,
        { reason: 'quiescence_state_incoherent' }
      >;
    };

type LocalIntegrityQuarantineResolutionPresentation = {
  schemaVersion: 1;
  kind: 'quarantined_abandoned';
  alertId: string;
  reason: LocalEffectIntegrityHoldV1['reason'];
  projectId: string;
  taskId: string;
  packageId: string;
  priorAgentRunId: string;
  packetAuditId: string | null;
  localRunEvidenceId: string | null;
  expectedLocalRunEvidenceId: string | null;
  requestIdentity: IntegrityQuarantineRequestIdentity;
  actorId: string;
  resolvedAt: string;
  evidenceFingerprint: string;
  classificationOutcome: 'quarantine_only' | 'irreconcilable';
  classificationFingerprint: string;
  resolutionFingerprint: string;
  siblingEvidenceSetFingerprint: string;
  repositoryDisposition: 'reviewed' | 'abandoned';
};

type PacketCurrentStatePresentationInput =
  | {
      source: 'active_claim';
      taskStatus: TaskStatus;
      packageStatus: WorkPackageStatus;
      auditStatus: 'claiming';
      claimState: ActivePacketClaimState;
      ownership: {
        executionLeaseActive: true;
        localEvidenceLeaseActive: true;
        packetIssuanceLeaseActive: true;
      };
      databaseObservedAt: string;
    }
  | {
      source: 'state_pending_reconciliation';
      reason:
        | 'expired_claim_observed'
        | 'partial_terminalization_observed';
      taskStatus: TaskStatus;
      packageStatus: WorkPackageStatus;
      localRunEvidenceId: string | null;
      priorRuntimeAuditId: string | null;
      databaseObservedAt: string;
    }
  | {
      source: 'state_unavailable';
      reason:
        | 'unknown_persisted_status'
        | 'unsupported_schema_version'
        | 'invalid_persisted_tuple';
      taskStatus: TaskStatus | 'unknown';
      packageStatus: WorkPackageStatus | 'unknown';
      localRunEvidenceId: string | null;
      priorRuntimeAuditId: string | null;
      databaseObservedAt: string;
    }
  | {
      source: 'recovery_marker';
      marker: PacketIssuanceRecoveryMarkerV2;
      projectArchived: false;
      taskStatus: TaskStatus;
      packageStatus: WorkPackageStatus;
      localChangeBarrier: {
        unresolvedCount: number;
        fingerprint: string | null;
        version: number;
        sourceSetFingerprint: string;
      };
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
      localEvidenceLeaseActive: boolean;
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
        schemaVersion: 1;
        kind: 'quarantined_abandoned';
        alertId: string;
        projectId: string;
        taskId: string;
        packageId: string;
        priorAgentRunId: string;
        priorRuntimeAuditId: string;
        requestIdentity: IntegrityQuarantineRequestIdentity;
        actorId: string;
        resolvedAt: string;
        evidenceFingerprint: string;
        classificationFingerprint: string;
        resolutionFingerprint: string;
        siblingEvidenceSetFingerprint: string;
        repositoryDisposition: 'reviewed' | 'abandoned';
      };
      taskStatus: 'cancelled';
      packageStatus: 'cancelled';
    };

// This symbol and the only constructor for the branded join live in the
// server-only packet-terminal/current-state loader. Neither is exported to a
// Client Component, API request schema, action payload, or presenter input.
const serverValidatedPacketTerminalCurrentStateJoin: unique symbol = Symbol(
  'serverValidatedPacketTerminalCurrentStateJoin',
);

type ServerValidatedPacketTerminalCurrentStateJoin = Readonly<{
  [serverValidatedPacketTerminalCurrentStateJoin]: true;
  terminal: Readonly<{
    artifact: Extract<PacketArtifactPresentationInput, { source: 'validated_artifact' }>;
    agentRunId: string;
    runtimeAuditId: string;
    localRunEvidenceId: string;
    localRunEvidenceFingerprint: string;
  }>;
  current: Readonly<{
    // This projection is loaded and validated independently. It remains the sole
    // mutable recovery/current-state presenter input.
    projection: PacketCurrentStatePresentationInput | null;
    markerRelationship:
      | Readonly<{
          state: 'current';
          agentRunId: string;
          priorRuntimeAuditId: string;
          localRunEvidenceId: string;
          localRunEvidenceFingerprint: string;
          markerFingerprint: string;
        }>
      | Readonly<{
          state: 'stale' | 'repaired' | 'absent';
        }>;
  }>;
}>;

type PacketTerminalCurrentStateRelationship =
  | Readonly<{
      state: 'validated';
      artifact: Extract<PacketArtifactPresentationInput, { source: 'validated_artifact' }>;
      current: Extract<PacketCurrentStatePresentationInput, { source: 'recovery_marker' }>;
    }>
  | Readonly<{
      state: 'terminal_only';
      artifact: Extract<PacketArtifactPresentationInput, { source: 'validated_artifact' }>;
      reason:
        | 'no_current_marker'
        | 'stale_current_marker'
        | 'repaired_current_marker'
        | 'terminal_current_state_mismatch';
    }>;

type LocalRunRecoveryPresentationInput =
  | {
      source: 'local_effect_recovery';
      marker: LocalEffectRecoveryMarkerV1;
      localRunEvidenceId: string;
      packetAuditId: string | null;
      taskStatus: TaskStatus;
      packageStatus: WorkPackageStatus;
      localChangeBarrier: {
        unresolvedCount: number;
        fingerprint: string | null;
        version: number;
        sourceSetFingerprint: string;
      };
      ownershipBarrier: {
        executionLeaseActive: boolean;
        localEvidenceLeaseActive: boolean;
        packetIssuanceLeaseActive: boolean;
      };
      siblingBarrier: 'none' | 'active_execution' | 'awaiting_review';
      invocationState:
        | 'definitive_not_started'
        | 'invoking'
        | 'returned'
        | 'uncertain';
      repositoryReviews: {
        workingTree: RepositoryChangeReview;
        gitControl: RepositoryChangeReview;
        gitStorage: RepositoryChangeReview;
      };
      localRetryEligibility:
        | {
            state: 'eligible';
            policyRevision: string;
            policyFingerprint: string;
          }
        | {
            state: 'ineligible';
            reason:
              | 'attempts_exhausted'
              | 'retry_disabled'
              | 'handoff_policy_disallows';
          };
    }
  | {
      source: 'state_pending_reconciliation';
      reason:
        | 'expired_local_claim_observed'
        | 'partial_local_terminalization_observed';
      localRunEvidenceId: string | null;
      packetAuditId: null;
      databaseObservedAt: string;
    }
  | {
      source: 'state_unavailable';
      reason:
        | 'unknown_persisted_status'
        | 'unsupported_schema_version'
        | 'invalid_persisted_tuple';
      localRunEvidenceId: string | null;
      packetAuditId: string | null;
      databaseObservedAt: string;
    }
  | {
      source: 'quiescence_wait';
      reason:
        | 'local_run_quiescence_unproven'
        | 'authorized_recovery_worker_unavailable';
      localRunEvidenceId: string;
      packetAuditId: string | null;
      alertId: string;
      membershipChangeId: string | null;
      evidenceFingerprint: string;
      effectIntent: Extract<
        LocalRunEffectIntent,
        { state: 'not_started' | 'active' }
      >;
      containmentLeaseState: 'active' | 'orphaned';
      taskStatus: 'running';
      packageStatus: 'running';
    }
  | ({
      source: 'local_effect_integrity_hold';
      taskStatus: TaskStatus;
      packageStatus: WorkPackageStatus;
    } & LocalEffectIntegrityHoldPresentationState)
  | {
      source: 'local_integrity_quarantine_closed';
      hold: LocalEffectIntegrityHoldV1;
      resolution: LocalIntegrityQuarantineResolutionPresentation;
      taskStatus: 'cancelled';
      packageStatus: 'cancelled';
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
      handler: 'retry_execution';
      request: PacketRecoveryRequestIdentity;
    }
  | {
      kind: 'review_submission';
      label: string;
      handler: 'acknowledge_possible_submission';
      request: PacketRecoveryRequestIdentity;
    }
  | {
      kind: 'reapprove_packet_context';
      label: string;
      targetId: string;
      request: PacketRecoveryRequestIdentity;
    }
  | {
      kind: 'decline_packet_recovery';
      label: string;
      handler: 'decline_packet_recovery';
      request: PacketRecoveryRequestIdentity;
    }
  | {
      kind: 'review_local_changes';
      label: string;
      handler: 'review_local_changes';
      request: LocalEffectRecoveryRequestIdentity;
    }
  | {
      kind: 'retry_local_execution';
      label: string;
      handler: 'retry_local_execution';
      request: LocalEffectRecoveryRequestIdentity;
    }
  | {
      kind: 'acknowledge_possible_local_invocation';
      label: string;
      handler: 'acknowledge_possible_local_invocation';
      request: LocalEffectRecoveryRequestIdentity;
    }
  | {
      kind: 'decline_local_retry';
      label: string;
      handler: 'decline_local_retry';
      request: LocalEffectRecoveryRequestIdentity;
    }
  | { kind: 'install'; label: string; handler: 'install_mcp' }
  | { kind: 'enable'; label: string; handler: 'enable_mcp' }
  | { kind: 'connect'; label: string; handler: 'connect_account' }
  | { kind: 'configure'; label: string; handler: 'configure_project_mcp' }
  | { kind: 'inspect_fix'; label: string; handler: 'inspect_mcp_health' }
  | { kind: 'refresh'; label: string; handler: 'refresh_mcp_health' };

type PacketRecoveryPrimaryCta = Extract<
  PresentationCta,
  {
    kind:
      | 'retry_packet_execution'
      | 'review_submission'
      | 'reapprove_packet_context';
  }
>;
type PacketRecoveryDeclineCta = Extract<
  PresentationCta,
  { kind: 'decline_packet_recovery' }
>;
type LocalRecoveryPrimaryCta = Extract<
  PresentationCta,
  {
    kind:
      | 'retry_local_execution'
      | 'acknowledge_possible_local_invocation';
  }
>;
type LocalRecoveryDeclineCta = Extract<
  PresentationCta,
  { kind: 'decline_local_retry' }
>;
type StandalonePresentationCta = Exclude<
  PresentationCta,
  PacketRecoveryPrimaryCta | LocalRecoveryPrimaryCta
>;

type PresentationActions =
  | readonly []
  | readonly [StandalonePresentationCta]
  | readonly [
      primary: PacketRecoveryPrimaryCta,
      decline: PacketRecoveryDeclineCta,
    ]
  | readonly [
      primary: LocalRecoveryPrimaryCta,
      decline: LocalRecoveryDeclineCta,
    ];

type AdmissionPresentation = {
  statusKey: 'planning' | 'approved' | 'action_required' | 'deferred' | 'unhealthy' | 'legacy';
  tone: 'neutral' | 'positive' | 'warning' | 'danger';
  badgeText: string;
  headline: string;
  body: string;
  actions: PresentationActions;
};

type PacketArtifactPresentation = Omit<AdmissionPresentation, 'actions'> & {
  actions: readonly [];
};

type McpSurfacePresentation = AdmissionPresentation;

admissionPresentation(input: AdmissionDecisionPresentationInput): AdmissionPresentation;
projectMcpPresentation(input: ProjectMcpPresentationInput): McpSurfacePresentation;
catalogMcpPresentation(input: CatalogMcpPresentationInput): McpSurfacePresentation;
packetCurrentStatePresentation(input: PacketCurrentStatePresentationInput): AdmissionPresentation;
packetArtifactPresentation(input: PacketArtifactPresentationInput): PacketArtifactPresentation;
localRunRecoveryPresentation(input: LocalRunRecoveryPresentationInput): AdmissionPresentation;

// Exported only by the server-only loader module, never by admission-copy.ts.
validatePacketTerminalCurrentStateRelationship(
  joined: ServerValidatedPacketTerminalCurrentStateJoin,
): PacketTerminalCurrentStateRelationship;
```

The six presenter functions in `admission-copy.ts` must be deterministic, total,
side-effect-free, and tested as matrices. Human strings live there; component code
renders the result. Shared primitives own tones, badges, action shapes, runtime-
boundary wording, and safe text normalization, while each presenter accepts only
fields its source can truthfully provide. The brand, private constructor, database
loader, validator, and relationship result live in a separate `server-only` module.
The relationship comparison itself is deterministic, but neither it nor its joined
input is a browser-facing presenter export.

The packet-artifact loader joins the exact run-linked S4 artifact to its exact,
independently identified runtime audit and terminal generic local-run evidence,
including the local-evidence ID and fingerprint, host-ledger review, and independent
working-tree, Git-control, and Git-storage reviews. It validates S4's complete
terminal compatibility predicate first, then projects only the immutable terminal
`PacketTerminalDisplayProjection` plus the exact agent-run and generic-evidence
fingerprint binding into `PacketArtifactPresentationInput`. The projection imports
S4's exact terminal assembly, terminal delivery, terminal outcome, failure-code/
conditional-stage, bounded terminal effect, host-ledger review, and repository-
review types. It is exhaustive only for those immutable facts. It does not accept
independently composed browser fields or copy a mutable recovery marker,
acknowledgement, disposition, or action identity into terminal artifact evidence.

When terminal history and current packet recovery are requested together, a
`server-only` loader performs one database observation and returns the branded
`ServerValidatedPacketTerminalCurrentStateJoin`. Its private constructor accepts
only rows returned by that loader. It carries the immutable terminal artifact plus
the independently loaded exact runtime-audit ID, generic local-evidence ID and
fingerprint, and the separately validated current projection and marker-relationship
values. No browser field, query parameter, API body, action request, or serialized
presenter input can supply the run, audit, evidence, or marker identity. The loader
creates a module-private runtime `Symbol` property and the validator checks that
exact symbol, so a TypeScript assertion outside the module cannot create an object
that passes the runtime brand check.

`validatePacketTerminalCurrentStateRelationship` accepts only that branded join. A
current marker must match the terminal tuple on exact `agentRunId`, runtime-audit
ID, generic local-evidence ID, and generic local-evidence fingerprint before its
immutable recovery failure, delivery, host-review, three repository-review, and
combined-review-fingerprint facts are compared. Same-run/different-audit,
same-run/different-evidence-ID, and same-evidence-ID/different-fingerprint are all
mismatches. Mutable disposition, acknowledgement, and action-ledger progress is
validated only by the separately loaded `PacketCurrentStatePresentationInput`; it
is not compared as terminal history or copied into the immutable projection.

A current matching marker returns `validated`. An absent, stale, repaired, or
mismatched marker returns `terminal_only`: the immutable artifact still goes to
`packetArtifactPresentation`, remains actionless, and is never relabelled or hidden;
no current relationship, combined relationship copy, or action request is emitted.
If a current projection is independently valid, it may still be rendered solely by
`packetCurrentStatePresentation`, without asserting that it describes the terminal
artifact. Only server-produced presenter outputs cross the browser boundary; the
branded tuple and all relationship identity fields remain server-only.

S5 imports S4's closed `PacketRedactionCategory` union and owns only the static
label for each known category. It never accepts `Record<string, number>` at the
presentation boundary. An unknown category, negative/fractional/over-limit count,
unsupported schema, invalid delivery/terminal/failure/effect/ledger/review tuple,
or artifact-to-generic-evidence mismatch becomes actionless
`artifact_unavailable`; the raw key/value is never rendered. The projection has no
action request identity, filesystem path, selected name, content, ledger entry,
exception detail, or free-text field. Fingerprints are validation inputs, not
display copy. `packetArtifactPresentation` always returns `actions:[]`; neither
packet artifact state nor privileged integrity quarantine adds a browser mutation
or an eighth S4 handler.

The bounded action list is part of the contract. Zero actions means actionless; one
is the only valid control; two is always the primary recovery action followed by
the applicable evidence-preserving packet/local decline action. No state returns
more than two. Review precedence returns review alone until every required review
is complete. A coherent reviewed retry/reapproval/acknowledgement state returns that
primary action first and decline second; an exhausted/ineligible local retry returns
decline alone. Components render one labelled action group in array order, preserve
that order on mobile, and keep each button's exact immutable request identity.
The two-action type permits only packet-primary + packet-decline or local-primary +
local-decline; a setup, review, packet/local cross-pair, or decline-first tuple is
not representable. The primary and decline requests in a two-action tuple carry the
same versioned identity values; normalization rejects a mixed audit/evidence ID or
fingerprint before presentation. A recovery primary cannot appear alone: when its
ordinary decline is not safe, the primary is not safe either and the state is
actionless or review-only.

This is the complete current-state action matrix after fail-closed normalization:

| Current state | `actions` |
|---|---|
| active claim, pending reconciliation, unavailable state, quiescence wait, integrity hold, or quarantine closure | `[]` |
| any exact host/repository review is required | `[review_local_changes]` |
| coherent packet needs one-time reapproval | `[reapprove_packet_context, decline_packet_recovery]` |
| coherent packet may have been submitted and needs acknowledgement | `[review_submission, decline_packet_recovery]` |
| coherent always-allow packet is retry-eligible | `[retry_packet_execution, decline_packet_recovery]` |
| coherent packet has no currently valid primary recovery action | `[decline_packet_recovery]` |
| coherent local invocation needs acknowledgement | `[acknowledge_possible_local_invocation, decline_local_retry]` |
| coherent local retry is policy-eligible | `[retry_local_execution, decline_local_retry]` |
| coherent local retry is exhausted or policy-ineligible | `[decline_local_retry]` |
| non-recovery decision, setup, remediation, or catalog state | `[]` or its one exact typed action; never decline |

`reapprove_packet_context` is a packet-recovery-specific focus action, not the
generic bounded-context approval scroll. It carries the exact prior-audit/marker
identity and targets the exact package grant control so the S3→S4 resolver can
compare-and-set the same recovery state after a fresh approval.

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
   `admissionStatus:'allowed'`, the exact `effective_approved` arm, no
   recovery action, and `retryable:false`.

`grantState` is never a bag of optional phase/consumed/reason fields. S5 imports
S3's closed `FilesystemGrantHoldState`,
`CanonicalPositiveDecisionRevision`, and `FilesystemGrantRevocationReason` types.
The revocation reason is exactly
`project_grant_removed|project_grant_narrowed|project_root_repoint`; an unknown,
free-text, path-like, credential-like, or control-text value fails normalization to
actionless unavailable/legacy copy and is never passed to or echoed by the typed
presenter.

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
- `revoked` + `project_grant_removed`: `Project context was removed`;
- `revoked` + `project_grant_narrowed`: `Project context no longer covers this package`;
- `revoked` + `project_root_repoint`: `Project root changed — approve context again`;
- approved + consumed: `One-time context approval was already used`.

These are static strings selected from the imported enum, not bounded/rendered
operator text. CTA scrolls to the exact package grant controls. Do not infer phase
from or display reason text.

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
`packet_issuance` marker, or typed packet integrity hold and passes it to
`packetCurrentStatePresentation`. For a terminal artifact plus recovery marker, it
first requires the server-only branded join and exact run/audit/evidence-ID/
evidence-fingerprint relationship above; component or browser code cannot supply
identity fields or independently pair presenter inputs. A terminal-only result
keeps immutable artifact copy separate and asserts no current relationship.
The generic reader separately validates bounded quiescence/local-effect state and
passes it to `localRunRecoveryPresentation`; a packet page may join both by the
audit's required local-run evidence ID. Neither source is folded into the S2
`mcpBroker` contract. Runtime parsing normalizes unknown task/package statuses to a
fail-closed neutral state before a typed presenter is called.

- The server exhaustively maps a live `claiming` audit with an unexpired lease
  into `ActivePacketClaimState`. The discriminated union makes impossible pairs
  unrepresentable: pre-intent `not_assembled` and live-only `assembling` are
  distinct, neither is submitted, and submitting always has assembled metadata.
  Both pre-intent `preparing` and live `assembling` render the neutral “Preparing
  project context” copy with no counts, root reference, redaction summary, or
  action. The other states render “Context assembled”, “Submitting to worker”,
  “Worker accepted — finalizing”, or “Submission rejected — finalizing”. These are
  the last durable staged states, with no action; they are
  not worker-memory failure intent and are never read from a terminal artifact. A
  local preflight/assembly/provider/post-submission error remains on its last
  durable staged copy until S4 atomically commits terminal evidence. S5 never
  invents `failed_finalizing`. The server validates the complete claim-state
  discriminant and requires the execution, generic local-evidence, **and** packet-
  issuance leases to be simultaneously active at the PostgreSQL observation time;
  it supplies that timestamp and typed ownership tuple;
  the browser never compares `leaseExpiresAt` with `Date.now()`. An expired
  observation with an unproven active/orphaned containment lease and S4's generic bounded alert
  renders “Waiting for worker changes to stop” with no action until the
  protected authoritative host fence service and operating-system containment
  adapter prove the complete per-run execution group empty. This state is supplied
  through the packet-independent local presenter below, not fabricated as packet
  state. The long-lived queue worker is not part of that group. A wrong, stale,
  divergent-key, insufficient-containment, or unreachable host remains actionless.
  Total loss of an eligible authorized W2 uses the distinct static copy “Recovery
  worker unavailable — Release/DevOps action required,” carries only bounded alert/
  membership correlation, and names the exact dry run
  `npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>`
  plus `docs/operators/work-package-instance-replacement-v2.md`. These are operator
  instructions, not a browser link, command runner, or CTA; `actions` remains `[]`.
  Other expired but schema-valid observations use the explicit
  `state_pending_reconciliation` branch and render neutral “Refreshing run state”
  until S4 recovery/finalization persists a terminal result.

- Unsupported schema versions, unknown persisted statuses, and corrupt/incoherent
  tuples use `state_unavailable`, not the transient reconciliation branch. They
  render neutral “State unavailable—Forge update or operator repair required,”
  expose no action, and never imply that a periodic refresh can repair the record.

- A typed `packet_integrity_hold` is reason-specific and has no web action.
  `terminal_success_materialization_incomplete` renders neutral “Run evidence
  needs operator repair.” `audit_artifact_mismatch` renders “Run evidence
  conflicts — quarantined” and explains that immutable records cannot be rewritten;
  Release/DevOps may inspect and, when neither verified outcome is provable,
  permanently close the task. Neither state borrows packet-failure copy or offers
  reapproval/retry. Both name Release/DevOps ownership and the checked-in
  `docs/operators/local-execution-integrity-repair.md` procedure without making its
  privileged command a browser CTA. Alert ID/fingerprint are bounded support
  correlation, not user-editable inputs.

- An exact append-only `quarantined_abandoned` resolution joined to that mismatch,
  cancelled package, and cancelled task renders “Task closed — evidence
  quarantined.” It states that Forge preserved the conflicting records and no new
  run is available. Before emitting closure, the server validates the complete
  request identity: alert, project/task/package/run/audit, hold evidence,
  classification, expected sibling-evidence set, requested repository disposition,
  actor, and append-only resolution fingerprints must all route to and equal the
  stored resolution. It also validates the exact sibling-evidence-set fingerprint
  and `reviewed|abandoned` repository disposition; the UI may state
  “Repository evidence was intentionally abandoned” for the latter without
  exposing paths or ledger detail. Missing/mismatched resolution or sibling
  evidence remains the unresolved integrity hold and root-management barrier; the
  browser never infers closure from status alone.

- Evidence/history routes may explicitly read a tombstoned project and render
  neutral “Project removed — evidence retained.” They keep the original opaque
  `rootRef` correlation and immutable task/run evidence, show no former path or
  live-root control, execution/retry/reapproval/review-gate/root-management CTA, or
  active package progression, and never attach that history to a later project
  that reuses the released physical root. Normal project lists continue to hide
  tombstones. S5 consumes S4's bounded `project_removed` cancellation state; it
  never infers removal from a missing path.

- `reapprove_allow_once` shows “Approve one-time context again” and targets the
  package grant control. It never renders generic retry because the nonce burned
  when the packet claim committed.
- Review precedence applies before every grant/delivery disposition. When any S4
  host-ledger, working-tree, Git-control, or Git-storage evidence is
  `review_required`, S5
  offers only `review_local_changes` with label “I reviewed the local changes,”
  bound to the exact generic local-run evidence ID and combined fingerprint. For
  definitive `submission_failed`, copy keeps the two facts separate: “The request
  was not accepted. Forge also detected local changes that require review.” It does
  not attribute the failure or changes to a provider. After S4 records the local review, it advances
  to the stored delivery/grant-mode disposition without changing delivery.
- `review_then_reapprove_allow_once` then shows only the possible-prior-submission
  acknowledgement. After S4 records it against the exact marker, delivery, and
  audit identity, the marker becomes `reapprove_allow_once`; only then does the
  package grant control create a fresh nonce.
- `retry_execution` is available for an `always_allow` marker whose delivery is
  `not_exposed|submission_failed` and disposition is `retry_execution`, or whose
  delivery is `submission_uncertain|submitted` and separately recorded
  disposition is `reviewed_submission`. In both cases the task is `approved`, the
  package is still `blocked`, package policy is unchanged, current authorization
  is `same_decision|newer_covering_decision`, and execution, local-evidence, and
  issuance leases are all inactive. Host apply plus the independent working-tree,
  Git-control, and Git-storage review states must each be
  `not_applicable|reviewed`. Each working-tree, Git-control, and Git-storage tuple
  must be either `unchanged + not_applicable` or
  `changed|unverifiable + reviewed` with its exact fingerprint, and
  the task-local-change count/fingerprint/version/source set must be the verified
  zero/null/current tuple; required, missing, mismatched, or stale review/projection exposes no retry. A newer
  decision is shown as explicit reauthorization, not as
  continuity of the old grant. The server route locks and rechecks the same
  predicate, records the authorizing current revision, clears only the matched
  marker, moves the package to `ready`, and wakes after commit. The normal claim
  path creates the new run and snapshots that current decision.
- `review_submission` is a marker disposition paired with immutable delivery
  `submission_uncertain|submitted`. It states that ACP may already have accepted
  work and offers S4's acknowledgement action. Acknowledgement keeps delivery
  unchanged, sets actor/time only after local-change review is complete, and changes the disposition to
  `reviewed_submission`; if exact current coverage still holds, the presenter may
  then offer S4's explicit `retry_execution` action. A live `submitting` claim is
  evidence-only and has no recovery action until stale recovery converts delivery
  to `submission_uncertain`.
- Every coherent, quiescent, fully reviewed packet recovery state also offers the
  ordinary “Do not retry—close this package” action. It carries the exact packet
  request identity, preserves delivery/evidence, creates no run or wake, and does
  not force the operator to acknowledge whether uncertain prior submission
  occurred. Privileged quarantine remains reserved for incoherent evidence.

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
retry from delivery state. A schema-valid stale marker is neutral and may return a
stale-action response if a previously rendered control races current state.
Unsupported/malformed state uses the actionless `state_unavailable` copy above.

The current-state reader imports S4's discriminated
`PacketIssuanceRecoveryMarkerV2` union and rejects every known-invalid
grant-mode/delivery/disposition/acknowledgement combination before presentation.
It joins `priorRuntimeAuditId` to the exact prior audit and its required generic
local-run evidence row, all applicable run artifacts (including the packet
  artifact), any host-apply ledger/review, and all authoritative pre-exposure
  working-tree/Git-control/Git-storage baselines plus post-quiescence comparison/
  review rows. It proves the typed terminal tuples equal; binds marker, host review, all repository
reviews, and the task-local-change version/source fingerprint; and validates assembly + delivery + terminal status + failure code/
conditional stage together. Normal repository review accepts only
`not_applicable|review_required|reviewed`; `abandoned` is valid solely on a joined
integrity-quarantine resolution and never on an audit/marker review. The marker
alone is insufficient. Missing,
mismatched, or terminal-success-plus-failure-marker evidence becomes a typed or
neutral integrity hold with no action. The browser never assembles those
independent fields into a state.

Every mutation control carries its authoritative immutable request identity.
Packet retry, possible-submission acknowledgement, and packet decline carry S4's
version-2 `{priorRuntimeAuditId, markerFingerprint}`. Generic local review,
possible-invocation acknowledgement, retry, and decline carry version-1
`{localRunEvidenceId, evidenceFingerprint}`. Components do not reconstruct either
from the current marker or send an action-only request. The seven mutation handlers
are exactly S4's `review_local_changes`,
`acknowledge_possible_local_invocation`, `retry_local_execution`,
`decline_local_retry`, `retry_execution`, `acknowledge_possible_submission`, and
`decline_packet_recovery`; presentation kind `retry_packet_execution` maps to
handler `retry_execution` and is not a second action identity. All seven reject
stale identity without mutation. `assembly_unconfirmed`, unknown redaction state,
integrity inspection, and privileged quarantine closure are presentation/evidence
states only; none adds a handler or CTA. When stale recovery leaves the
task `running` because another sibling package still holds a live execution lease,
the marker renders neutral “Waiting for active package” with no action. If
`siblingBarrier:'awaiting_review'`, it instead renders “Waiting for required
review.” Actions
become eligible only after S4's shared post-sibling/periodic operator-hold reconciler makes
the task exactly `approved`; S5 never performs that transition.

`localRunRecoveryPresentation` owns the closed packet-independent union. Its
server reader joins a valid `metadata.local_effect_recovery` to the exact generic
local-run row, host ledger/review, working-tree/Git-control/Git-storage comparisons,
protected-service receipt/quiescence state, all three ownership leases, sibling
barrier, server-computed retry-policy eligibility, and verified task aggregate.
Expired/partial packetless state uses its own `state_pending_reconciliation` branch
and “Refreshing run state” copy. Unknown, unsupported, or corrupt local state uses
the actionless `state_unavailable` branch and “State unavailable—Forge update or
operator repair required”; it is never described as transient.
`quiescence_wait` renders “Waiting for worker changes to stop” for an existing
owner that has not proved quiescence. Total eligible-W2 loss instead renders
“Recovery worker unavailable — Release/DevOps action required,” the exact
`protocol:replace-work-package-instance` dry run, and
`docs/operators/work-package-instance-replacement-v2.md`. Both states are
browser-actionless and use mandatory alert ID plus optional membership correlation;
the command is static copy, never executed by the page.
`local_effect_integrity_hold` renders neutral
“Local run evidence needs operator attention,” names Release/DevOps and the generic
integrity runbook, and exposes no browser action or packet nouns. The server reader,
not the browser, calls S4's reason-specific repair-predicate helper over the exact
alert/hold/run/effect/ledger/repository/audit tuple and supplies the matching
`repairClassification` plus a fingerprint of that classification. The reason,
classification, and hold fingerprint must agree before presentation:

- `missing_local_evidence` is always `quarantine_only`. Copy says “Required local
  run evidence is missing” and that only evidence-preserving quarantine can close
  the task. It never claims that the absent row can be reconstructed and never
  fabricates a local-run evidence ID.
- A `local_evidence_mismatch` classified `reconstructable` says “Local run evidence
  can be reconstructed from preserved records” and points Release/DevOps to the
  exact runbook inspection/repair path. It does **not** use “quarantined,” “must be
  abandoned,” or other terminal copy before the privileged repair runs.
- A `local_evidence_mismatch` classified `irreconcilable` says “Local run evidence
  conflicts and cannot be reconstructed” and explains that evidence-preserving
  quarantine is the remaining privileged runbook path. The browser never infers
  irreconcilability merely because the hold reason is `local_evidence_mismatch`.
- `task_projection_mismatch` uses projection-repair copy only for a server-proven
  `projection_recomputed` predicate; an irreconcilable source set uses quarantine
  copy. `quiescence_state_incoherent` says it is waiting for service-authored proof
  only for `awaiting_service_proof`; an irreconcilable tuple uses quarantine copy.

Every integrity-hold classification returns `actions:[]`. The classification is
operator guidance, not repair authority, and the privileged command independently
rechecks the same fingerprint and predicate.

`local_integrity_quarantine_closed` is the sole generic local closure branch. The
server may emit it only when one exact append-only `quarantined_abandoned`
resolution joins the routed hold by alert ID, reason, local/expected evidence
identity, hold evidence fingerprint, server classification outcome/fingerprint,
resolution fingerprint, project/task/package/run identity, optional packet-audit
identity, and complete sibling-evidence-set fingerprint; classification is exactly
`quarantine_only|irreconcilable`, repository disposition is exactly
`reviewed|abandoned`, task and package are both `cancelled`, and no unresolved
sibling evidence is omitted. The persisted request identity must also carry the
same alert, expected hold/classification/sibling fingerprints, and requested
repository disposition; a resolution over a recomputed or differently requested
evidence set is not closure. It
renders “Task closed — evidence quarantined,” says Forge retained the evidence and
no new run is available, and returns `actions:[]`. Only disposition `abandoned`
adds “Repository evidence was intentionally abandoned.” The copy contains no path,
packet noun, repair promise, or browser repair control.

A cancelled status alone never creates closure. A missing resolution, stale hold/
resolution fingerprint, wrong reason, cross-project or cross-route identity,
incomplete sibling set, or missing repository disposition cannot enter the closed
branch. When the original hold itself remains coherent, the API returns the same
actionless `local_effect_integrity_hold`; when even its routed identity is invalid,
it returns actionless `state_unavailable` with `invalid_persisted_tuple`. The
browser never chooses this fallback or joins a resolution locally.

A null `packetAuditId` is a truthful no-packet run. Pending review shows only “I
reviewed the local changes.” A direct `retry_local_execution` is available only
when the immutable generic invocation state is `definitive_not_started`, written by
the still-live exact owner/attempt from S4's trusted typed `pre_io_refusal` before
adapter process, socket/network, credential, or repository I/O, and the working-
tree, Git-control, and Git-storage evidence is entirely
`unchanged|not_applicable`. It also requires the current server eligibility and
barriers below. That marker shows “Start another attempt,” keyed by
`{localRunEvidenceId,evidenceFingerprint}`. That explicit action is not automatic
retry and is distinct from packet `retry_execution`; it is visible only for task
`approved`, package `blocked`, no sibling or execution/local-evidence/packet lease
barrier, `localRetryEligibility.state:'eligible'` with the current policy revision/
fingerprint, and a verified current zero local-change aggregate. Recovery never
manufactures `definitive_not_started`. `invoking|returned|uncertain` always
normalizes to `local_invocation_uncertain`; it cannot expose retry until the exact
possible-invocation acknowledgement is durably recorded. If ordinary retry
is exhausted or disabled, the presenter states that fact and never fabricates a
retry control. `local_invocation_uncertain` first offers “I understand the prior
local invocation may have happened”; this preserves the invocation evidence and
then exposes retry only when the same server policy is eligible. Every coherent,
quiescent, fully reviewed local marker also offers “Do not retry—close this
package,” including directly from uncertain invocation without forcing that
acknowledgement. Decline preserves evidence and creates no run or wake. Packet counts, assembly,
delivery, acknowledgement, packet reapproval/retry, and packet artifact remain
absent. Missing/mismatched generic evidence is represented by the typed local
integrity branch rather than a fabricated valid marker. For a packet run, the one
generic review action clears only the local marker and atomically advances the
dependent packet disposition; it never writes a packet review action. Packet
actions never clear local evidence.

S5 imports S4's exact closed `PacketFailureCode` enum. It maps only those values to
bounded copy; an unknown value is legacy/unknown and actionless, never displayed as
server-provided free text. `post_submission_execution_failed` additionally
  requires S4's closed stage and renders static stage copy. For `host_apply`, the
  copy warns that some local files may already have changed. Every such submitted
  failure says the external submission may have produced work, says Forge did not
  roll back local changes, requires the operator to inspect/resolve repository
  state—including working-tree files, Git control/configuration, and Git object/
  history storage as applicable—
and offers no automatic resubmission. It never displays a path, file name, command,
provider text, or raw/sanitized exception.
`external_repository_change_requires_review` renders “Repository changed during
the worker attempt — review required.” It explains that the Agent Communication
  Protocol (ACP) runtime is not a filesystem sandbox, Forge stopped before its own
  local apply stages, and the operator must review the affected repository-state
  categories. It does not say
the provider caused the change. Changed and
unverifiable results use the same bounded caution; no raw path, diff, or error is
shown on this packet surface.
`completion_preparation` refers only to work before the atomic finalizer; a gate
insert/finalizer rollback remains in-progress/recovery state and never renders that
cause.

### Grant controls

Each package grant control has a stable DOM target. The copy helper’s approve CTA points to it. First-time, denied, revoked, and consumed states are visually and textually distinct.

### Packet evidence

Read S4 artifact by `(agentRunId, artifactType='mcp_bounded_context_packet_metadata')`.

For `assembly.state:'assembled'`, display only:

- opaque approved `rootRef` (or the phrase `this project`); never a filesystem path;
- included count;
- byte count;
- omitted count;
- the closed-category redaction summary using S5-owned static labels; and
- assembly state, delivery state, and terminal success/failure as separate facts.

`not_assembled` displays only its validated bounded `claim|preflight` failure stage
and static cause. `assembly` is not a valid `not_assembled` stage. Live
`assembling` exists only in `ActivePacketClaimState` and is rejected from every
terminal artifact/parser branch.
S4's `assembly_unconfirmed` is a third, distinct truth state: render “Packet
assembly could not be confirmed” and explain that Forge has no durable proof that
assembly completed. It carries and displays no `rootRef`, included/byte/omitted
counts, or redaction summary; it is never relabelled `not_assembled`, `assembled`,
or zero files. It is actionless except for a separately valid recovery marker whose
full predicates independently authorize an existing one of the seven S4 actions.
The artifact itself never authorizes retry.

S5 imports S4's closed redaction-category enum and maps each category to fixed copy.
The artifact reader rejects an unknown key, duplicate key after normalization,
non-integer/negative/over-5,000 count, an enumerable-key count greater than
`PACKET_REDACTION_CATEGORIES.length`, or a redaction summary on
`not_assembled|assembly_unconfirmed`. Rejection renders actionless
“Packet evidence unavailable—Forge update or operator repair required”; it never
prints the unknown key or falls back to a generic operator-supplied label.

Never display selected paths, root paths, file names, excerpts, or contents. Ignore
generic artifact prose and render only validated typed metadata. Clearly separate
packet evidence from sandbox-generated files and host-applied changes. A failed
pre-assembly snapshot shows stage plus enum-derived static failure copy without
invented zero counts or raw/sanitized exception detail. `assembly_unconfirmed`
likewise exposes no count, redaction, or root-reference field because missing
durable proof cannot be converted into either successful assembly or definitive
non-assembly. A terminal success is
valid only with `assembled+submitted`, working-tree, Git-control, and Git-storage evidence
`unchanged/not_applicable`, and
one of S4's disjoint effect tuples: `not_started` with no local stage/ledger, or
`quiesced(actualLastStage)` with a complete declared host-write ledger. Changed or
unverifiable evidence never renders success, even when reviewed. A terminal failure must match S4's exact
assembly/delivery/failure-code/conditional-stage compatibility table. A
post-submission execution failure is shown separately from provider-response
validity and from host-change evidence; packet state never claims whether local
changes were fully or partially applied. Delivery copy is exhaustive over S4's exact states:
`not_exposed|submission_failed|submitted|submission_uncertain`; terminal artifacts
never contain live `submitting`. Assembly never implies ACP acceptance. The
current-state reader may show any validated live phase above only while its lease
is valid. After recovery/finalization, the matching terminal artifact/marker owns
the result; an expired `submitting` intent becomes `submission_uncertain`.
The host-apply ledger and ACP working-tree/Git-control/Git-storage baseline/change evidence remain separate:
packet presentation consumes only their bounded
`not_applicable|review_required|reviewed` states and fingerprints. Exact write-plan
entries, repository paths, and diffs stay in the authorized repository-change
surface and are never copied into packet copy, task events, or integrity alerts.

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
| typed transient `unknown` | refresh status; no handoff retry |
| healthy and enabled | no remediation CTA |
| incoherent/future value | neutral `Status unavailable — update Forge or inspect operator configuration`; no action |

Each project action uses the matching typed `kind` and validated `handler` (or a
catalog-owned validated `href` where navigation is the real action). Setup actions
are never encoded as `retry`; components switch exhaustively on this discriminant
and cannot call a different handler because two actions share a generic link.
Only a schema-valid, server-classified transient `unknown` health observation may
produce `refresh`. An unknown future enum, unsupported schema, or incoherent tuple
cannot be repaired by repeating the same read, so its normalized presentation is
actionless update/operator-inspection copy and never “Refreshing.”

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
- A non-empty `actions` tuple renders as one `role="group"` labelled by the
  presentation headline. DOM order, visual order, and keyboard tab order are the
  tuple order: primary first, decline second. Responsive CSS must not use `order`,
  reversal, or a separate overflow menu to move decline ahead of the primary.
- A single action remains the only item in that labelled group; `actions:[]` renders
  no empty group. Primary and decline use distinct descriptive labels, expose one
  busy state for the submitted control, and announce stale/conflict results without
  moving focus or silently enabling the sibling control.
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
2. each closed revocation enum maps to static copy, while every unknown/raw reason
   fails closed without display;
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
    recovery uses the locked retry predicate, every exact local-change barrier
    first exposes `review_local_changes`, and post-intent ambiguity then requires
    possible-submission acknowledgement with no retry; only recorded actions may yield the
    `reviewed_submission` disposition and then expose the same locked
    current-coverage retry predicate.
21. `not_issued` maps to Needs project context, and each actionable project health
    state invokes its distinct typed install/enable/connect/configure/fix action.
    Only typed transient `unknown` invokes refresh; incoherent/future/schema-
    unsupported health is actionless update/operator-inspection copy.
22. a live `submitting` audit is current in-progress state only; terminal artifacts
    reject `submitting` and render recovered `submission_uncertain` separately.
    Live preparing/assembled/submitting/accepted-finalizing/rejected-finalizing
    phases are exhaustive, actionless, and never sourced from terminal artifacts.
23. task/package status normalization and every CTA discriminant fail closed; an
    install CTA cannot carry a refresh/configure handler.
24. skewed browser clocks cannot change live submission copy because the server's
    database-time execution + local-evidence + packet-issuance ownership tuple is
    authoritative. Expiry of each lease independently suppresses active copy.
25. revocation hides packet retry; restoring exact always-allow coverage under a
    newer revision renders explicit reauthorization and permits one locked retry
    (after acknowledgement for post-intent delivery), while narrower/unknown
    coverage and changed package policy remain actionless.
26. two identical recovery actions converge on one recorded success and one visible
    transition; only a changed fingerprint/state renders a stale-action `409`.
27. every valid `ActivePacketClaimState` pair renders its intended actionless copy;
    unsupported schema/unknown status/invalid phase-assembly-delivery cross-products
    fail closed to “State unavailable—Forge update or operator repair required,”
    not “Refreshing.” Preflight, assembly,
    provider-validation, and post-submission local failures cannot be inferred
    before terminal commit; a restarted reader shows the last durable phase.
28. Packet retry, possible-submission acknowledgement, and packet decline carry
    exact version-2 prior-audit/marker identity. Generic local review, possible-
    invocation acknowledgement, retry, and decline carry exact version-1 local-
    evidence/fingerprint identity. Components cannot submit action-only requests or
    substitute packet/local/cross-task identity.
29. a project allow decision racing an equal/newer package denial renders
    `not_covering` from the canonical reader and never exposes packet retry.
30. a recovery marker on a `running` task with a live sibling package renders
    “Waiting for active package” without an action; the same durable marker becomes
    actionable only after the shared operator-hold reconciler makes the task `approved`.
    An `awaiting_review` sibling renders “Waiting for required review” and likewise
    suppresses every action.
    A materialized sibling local-change barrier suppresses every new-run/reapproval
    action, while the exact marker that owns the fingerprint may expose only its
    local-review or explicit local-retry action.
31. every closed S4 `PacketFailureCode` maps to bounded static copy, while an
    unknown/future code is neutral, actionless, and never rendered verbatim.
32. every valid S4 grant-mode/delivery/review-precedence/disposition/
    acknowledgement marker tuple renders exactly its allowed primary action and,
    only when coherent and fully reviewed, decline as the optional second action.
    Review-required state renders review alone; every known-invalid cross-product
    is neutral and actionless before the typed presenter.
33. terminal success renders only for `assembled+submitted`. Every valid terminal
    failure tuple renders assembly, delivery, and enum-derived cause separately;
    every known-invalid stage/delivery/code combination and all raw path-bearing
    exception text fail closed without display. `assembly_unconfirmed` is a valid
    failed evidence state but can render neither assembled/not-assembled certainty
    nor `rootRef`, counts, redaction summary, or retry authority.
34. every closed post-submission stage renders bounded static copy. `host_apply`
    warns of possible partial local changes; all stages require prior-work review,
    expose no automatic resubmission, and never render raw/path-bearing detail.
35. a recovery marker is actionable only when the server-only loader joins the exact
    prior audit, generic local-evidence ID/fingerprint, artifact, and separately
    loaded current projection and the validator proves their equal typed failed
    tuple. Same-run/different-audit, same-run/different-evidence-ID, same-evidence-
    ID/different-fingerprint, stale marker, repaired marker, no marker, terminal-
    success-plus-failure-marker, and both `PacketIntegrityHoldV2` reasons assert no
    terminal/current relationship and manufacture no action. The valid immutable
    terminal artifact still renders through its own actionless presenter.
36. killing the worker after each persisted active phase and reading from a new
    process proves S5 derives preparing, assembled, submitting,
    rejected-finalizing, or accepted-finalizing from PostgreSQL alone and never
    synthesizes `failed_finalizing`.
37. an expired packet or no-packet local run with active effect intent and a
    quiescence alert renders “Waiting for worker changes to stop,” remains
    actionless, and never exposes a new-run control until S4 persists `quiesced`.
    If no eligible W2 remains, the typed local branch says “Recovery worker
    unavailable — Release/DevOps action required,” shows the exact instance-
    replacement dry run and runbook with alert/membership correlation, and still
    has `actions:[]`. A
    packetless expired/partial terminal state uses its typed pending branch; an
    unknown/corrupt local tuple uses actionless unavailable copy.
38. every `HostApplyRecoveryReview` tuple is exhaustive. `review_required` uses
    exact local-run/ledger-fingerprint `review_local_changes` and hides retry/reapproval;
    `reviewed` permits only the normal locked predicate; changed fingerprints fail
    closed. The same matrix independently covers working-tree, Git-control, and Git-storage
    `RepositoryChangeReview`, including `not_observed`, unchanged, changed, and
    unverifiable outcomes.
39. `completion_preparation` renders only for a terminal failed tuple. Atomic
    gate/finalizer rollback remains neutral in-progress/recovery state and cannot
    be mislabeled with that cause.
40. each integrity reason creates one bounded mandatory alert support correlation
    with Release/DevOps/runbook copy and zero actions. Missing local evidence uses
    quarantine-only copy. Local evidence mismatch fixtures import S4's server
    predicate and distinguish reconstructable repair copy from irreconcilable
    quarantine copy; the presenter cannot infer either from reason alone. No
    browser repair control exists; unauthorized, stale-classification/fingerprint,
    and normal recovery controls leave the hold unchanged.
41. exact packet or generic-local `quarantined_abandoned` resolution plus cancelled
    task/package, matching request alert/project/task/package/run/audit/local-
    evidence identity, expected hold/classification/sibling fingerprints, actor,
    requested resolution/disposition, stored resolution fingerprints, and the
    complete sibling-evidence-set/repository disposition renders permanent evidence
    quarantine/closure with zero actions. A missing, stale, cross-project, wrong-
    reason, cross-run/audit, incomplete-sibling, recomputed-request, missing-
    disposition, or status-only resolution never renders closure and remains
    actionless.
42. wrong-host recovery and per-run-child/fence-service/control loss with a surviving ACP
    or validation descendant retain “Waiting for worker changes to stop” and expose
    no control until S4's protected containment adapter proves the complete per-run
    group empty. Queue-worker survival does not keep a normally completed run held;
    only an authenticated fresh same-host recovery instance may finish stale work.
43. a root-binding mismatch renders bounded `root_changed` reapproval copy with no
    old-decision retry and no old/new path or internal resource reference.
44. changed or unverifiable working-tree, Git-control, or Git-storage evidence before Forge's first local stage
    renders the bounded external-change review message for valid response, failure,
    and submission uncertainty. Retry, reapproval, new-run, and root-management
    actions remain hidden; only exact local review or privileged quarantine can
    resolve its own fingerprint barrier.
45. tombstoned project evidence remains reachable from the authorized history/
    support route with “Project removed — evidence retained,” while normal lists
    hide it, root reuse does not relabel it, no former path is displayed, and no
    execution/retry/reapproval/review-gate/root-management CTA is present.
46. `submission_failed + changed|unverifiable` in both grant modes says “The
    request was not accepted” and separately says local changes need review. A
    provider HTTP rejection and a locally definitive adapter/pre-send/transport
    refusal render identical neutral actor wording. Only local review is offered;
    afterward immutable delivery remains `submission_failed` and the correct
    reapproval/retry action appears.
47. A marker whose working-tree/Git-control/Git-storage comparison/review fingerprint differs
    from its generic record, audit, or task barrier version/source set renders a
    neutral integrity hold with no action. The same parity holds for host ledger/
    review evidence.
48. Audit/marker-level repository `abandoned` is rejected as incoherent. Only an
    exact joined quarantine resolution may render intentional abandonment, and it
    never exposes retry.
49. Both successful effect branches render only when working-tree, Git-control, and Git-storage
    evidence are unchanged/not-applicable. A fabricated no-stage `quiesced` tuple and every success
    with changed/unverifiable/reviewed evidence fail closed.
50. Packet-free and handoff-only local-run recovery renders exact generic
    quiescence/local-change state, local review, possible-invocation acknowledgement,
    server-policy-eligible retry, and ordinary decline. Each execution/local/
    packet ownership lease and both sibling barriers suppress actions independently;
    attempts-exhausted, retry-disabled, and handoff-policy-disallows expose no retry.
    Packet audit/artifact/counts/delivery/packet retry/reapproval/acknowledgement
    remain absent. A packet run joins both presenters; generic review advances the
    exact dependent packet disposition without writing a packet review action.
51. Stale packet identity is rejected without mutation by packet retry, possible-
    submission acknowledgement, and packet decline. Stale generic local-run identity
    is rejected by local review, possible-invocation acknowledgement, retry, and
    decline. Substituting packet identity for local evidence, or vice
    versa, fails closed.
52. `state_pending_reconciliation` covers only schema-valid expired claim or partial
    terminalization with “Refreshing run state,” observation identity, bounded
    reason, and no CTA. Unknown status, unsupported schema, and corrupt tuple use
    `state_unavailable` with update/operator-repair copy and no promise of automatic
    transition.
53. The local presenter exhausts valid recovery, quiescence, open integrity, and
    `local_integrity_quarantine_closed` branches. Missing row, wrong run/root/
    fingerprint, stale task projection, and packetless corrupt evidence use their
    exact classification or fail-closed fallback with no packet noun or control.
54. Reviewed changed/unverifiable evidence in either grant mode exposes the stored
    action only when every changed repository tuple has its exact reviewed
    fingerprint and the task projection is current zero. Historical result remains
    changed/unverifiable; unchanged is required only for terminal success.
55. Every coherent, quiescent, fully reviewed packet/local marker offers decline
    with its exact identity, preserves evidence, and creates no run/wake. Retry,
    reapproval, or uncertainty acknowledgement appears first and decline second;
    review-required state shows review alone; exhausted local retry shows decline
    alone. Uncertain packet submission or local invocation may be declined without
    forcing the corresponding acknowledgement. Both controls fail closed together
    under stale identity, ownership, sibling, projection, or integrity barriers.
56. Local integrity copy distinguishes projection repair, service-authored
    quiescence proof, missing-evidence quarantine-only, reconstructable mismatch,
    and irreconcilable mismatch. Missing evidence uses the expected non-FK identity
    and never fabricates a local-evidence row; reconstructable mismatch never uses
    quarantine/abandonment copy before resolution.
57. Repository-change copy and tests name and independently exhaust working-tree,
    Git-control/configuration, and Git-storage/history categories; no branch reduces
    the required review to working-tree files alone.
58. **Presenter contract:** table-driven tests exhaust `PresentationActions` as
    zero, one, and the two valid family-paired tuples. Packet/local primary and
    decline coexist in that order; cross-family, decline-first, review-plus-decline,
    setup-plus-decline, recovery-primary-only, mixed request identity, and three-
    action outputs fail type/normalization tests. A handler-set parity test imports
    the seven S4 mutation identities exactly; mutating packet retry from
    `retry_execution` to the presentation kind `retry_packet_execution` fails.
    Adding an eighth handler for assembly evidence, integrity inspection, or
    quarantine closure fails parity. Closure and every integrity classification
    return exactly `[]`.
59. **Current-state API/loader:** route-owned fixtures join the exact local hold,
    S4 server classification, and optional quarantine resolution. Exact local
    closure serializes only after every request/route/alert/reason/evidence/
    classification/resolution/sibling/disposition/status equality passes. Stale
    request or resolution fingerprint, cross-project/package/run/audit identity,
    incomplete or changed sibling set, missing disposition, and cancelled-status-
    only fixtures never serialize closure; a coherent original hold remains open,
    while an invalid base route becomes `state_unavailable`.
60. **Playwright:** desktop and mobile task pages prove primary then decline DOM,
    visual, and tab order in one labelled action group for retry, reapproval, packet
    acknowledgement, and local-invocation acknowledgement. Single review/decline
    and zero-action closure render correctly; stale-click responses announce the
    conflict and do not leave either coexisting action enabled from old state.
61. **Runbook contract:** checked-in integrity inspect/resolve fixtures prove
    `missing_local_evidence` offers only `quarantined_abandoned`; reconstructable
    mismatch reports and accepts only its server-selected repair resolution; and
    irreconcilable mismatch accepts quarantine only after the exact fingerprint and
    complete sibling evidence are supplied. The refreshed API then renders repair
    state or permanent closure respectively, never a premature browser promise.
62. **Assembly truth:** one S4 fixture for each terminal `assembled`,
    `not_assembled/claim`, `not_assembled/preflight`, and
    `assembly_unconfirmed/assembly` state crosses restart and API serialization.
    A terminal `not_assembled/assembly` tuple is rejected. The
    unconfirmed fixture persists no `rootRef`, count, or redaction field and renders
    the exact no-durable-proof copy, never zero counts, “not assembled,” “assembled,”
    retry, reapproval, acknowledgement, or decline from artifact state alone.
63. **Closed redaction categories:** fixtures render every S4-owned category through
    its static label and exact bounded count. The parity fixture imports
    `PACKET_REDACTION_CATEGORIES`, proves all 12 current members render, and derives
    the maximum only from `.length`; a thirteenth unknown-key sentinel must fail.
    Unknown/mixed-case aliases, duplicate-after-normalization keys, negative/
    fractional/over-5,000 counts, a key count greater than the imported array
    length, and any redaction map on `not_assembled|assembly_unconfirmed` become
    actionless packet-evidence-unavailable copy without echoing the key.
64. **Total worker loss:** with the watchdog's exact no-eligible-W2 alert and
    membership evidence, desktop/mobile/API fixtures render Release/DevOps ownership,
    exact dry run
    `npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>`,
    and `docs/operators/work-package-instance-replacement-v2.md`, with no link,
    command execution, refresh, retry, acknowledgement, decline, or other CTA.
65. **Health truth:** typed transient `unknown` alone returns the refresh handler.
    Unknown-future enum, unsupported schema, and every incoherent install/enabled/
    health tuple render actionless update/operator-inspection copy; repeated reads
    cannot be described as remediation.
66. **Request-bound quarantine:** packet and generic-local fixtures vary every
    request and resolution field independently: alert, closed hold reason, project,
    task, package, run, packet audit, local/expected evidence, hold/classification/
    sibling fingerprint, actor, requested resolution, requested repository
    disposition, resolution fingerprint, and cancelled statuses. Only total
    equality renders permanent
    closure; a changed sibling set after inspection remains the open actionless hold.
67. **Decline and retry audit:** exhaust pre-acknowledgement and post-
    acknowledgement packet/local uncertainty, fully reviewed and review-required
    states, policy-eligible/ineligible retry, `assembly_unconfirmed`, total-worker-
    loss, future health, and every integrity state. Coherent uncertainty permits
    direct evidence-preserving decline without acknowledgement; unavailable,
    unquiesced, unreviewed, stale-identity, and integrity states expose neither
    decline nor misleading retry. The handler-set remains the same seven identities.
68. **Closed grant-state presentation:** import every S3 hold arm and all three
    `FilesystemGrantRevocationReason` values. Each enum selects its exact static
    copy. Unknown/free-text, path, credential, bidirectional/control-text, invalid
    phase/consumed/revision/reason cross-products, and a reason on any non-revoked
    arm become actionless unavailable/legacy copy without echoing the value.
69. **Live assembly presentation:** a leased live claim exhausts pre-intent
    `preparing/not_assembled`, live-only `assembling`, assembled, submitting,
    accepted-finalizing, and rejected-finalizing. `assembling` renders neutral
    preparing copy with no counts/root/action and is rejected from terminal
    artifacts; no fixture normalizes it to `not_assembled`.
70. **At-most-once local invocation:** with all repository domains
    `unchanged|not_applicable`, only a still-live exact-owner trusted typed pre-I/O
    refusal and durable `definitive_not_started` may expose direct
    `retry_local_execution`. Orphaned/recovered `invoking`, durable `returned`, and
    `uncertain` each render `local_invocation_uncertain`, require exact
    acknowledgement before retry, and still allow decline without acknowledgement.
    Wire-call and stale-identity fixtures prove no possible first invocation is
    repeated.
71. **Terminal packet projection mutation:** begin with each valid S4 terminal
    assembly/delivery/outcome/effect row and mutate, one field at a time, the
    artifact/run binding, assembly discriminant and counts, delivery state,
    terminal status, every closed failure code, required/forbidden conditional
    failure stage, effect state/last stage/ledger fingerprint, host-ledger review
    state/fingerprint, each working-tree/Git-control/Git-storage review state,
    baseline/change result/change fingerprint, and combined review fingerprint.
    Every invalid or mismatched mutation selects its exact static
    `artifact_unavailable` reason, renders no raw value, and returns `actions:[]`.
    Positive fixtures exhaust both success effect branches and every valid failure
    row, proving assembly, delivery, terminal result, enum-derived failure/stage,
    bounded effect, host-ledger review, and all three repository-review facts remain
    separate. Type-parity fixtures fail if S4 adds a `PacketFailureCode`,
    `PostSubmissionFailureStage`, delivery state, terminal assembly state, effect
    arm, host review arm, or repository review arm without an S5 mapping.
72. **Terminal/current relationship mutation:** pair every valid failed terminal
    artifact with each coherent mutable recovery-marker phase through the real
    server-only loader; direct construction of the branded join outside that module
    and browser-supplied run/audit/evidence identity fail type, import-boundary, and
    request-schema tests. Mutate the terminal/current `agentRunId`, exact runtime-
    audit ID, generic local-evidence ID, generic local-evidence fingerprint, marker
    fingerprint, recovery failure, delivery state, host-review tuple, each working-
    tree/Git-control/Git-storage review tuple, and combined review fingerprint one
    field at a time. Include explicit same-run/different-audit, same-run/different-
    evidence-ID, same-evidence-ID/different-fingerprint, stale-marker, repaired-
    marker, and no-marker fixtures. Also pair a succeeded terminal artifact with a
    recovery marker. Every invalid relationship returns `terminal_only`, preserves
    the independently valid immutable terminal artifact with `actions:[]`, emits no
    asserted current relationship or request identity, and never lets browser code
    choose either identity. Positive fixtures prove acknowledgement, disposition,
    and action-ledger changes remain mutable solely through
    `PacketCurrentStatePresentationInput`, never alter the immutable terminal
    projection, and never make `packetArtifactPresentation` return an action.

## Ownership boundaries

- #177 owns broker and decision persistence.
- #178 owns grant recovery behavior.
- #179 owns generic local-run evidence plus packet issuance/artifact schema.
- #180 is reader/presentation only.
- If a required field is missing from current producers, fix the producing issue/contract instead of persisting UI state here.

## Implementation order

1. Land the S4 generic local-run/working-tree/Git-control/Git-storage evidence, packet/fence/host-ledger/
   integrity schema and producer with opaque `rootRef`; install its operator
   runbook; and ensure S2 broker fields are deployed.
2. Add the three surface presenters plus the two current-state presenters and the
   `server-only` terminal/current loader. Keep its brand and constructor private;
   accept no browser-supplied run, audit, evidence, or marker identity. Their
   closed unions cover packet issuance/integrity and packet-independent local
   recovery/quiescence/open-integrity/quarantine-closure state. The server reader
   imports S4's exact repair predicates to compute the fingerprinted local integrity
   classification; the browser only maps it to copy. Add exhaustive presenter,
   API/loader, Playwright, and runbook-contract tests.
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
Also stop if any action appears while host quiescence or working-tree/Git-control/Git-storage review is
unproven, while a sibling awaits mandatory review, or on an integrity hold; if
packet copy needs host ledger paths; or if atomic finalizer rollback is mislabeled
as `completion_preparation`.
Stop if Git-control or Git-storage evidence is omitted; if a no-packet local run must manufacture
packet evidence/action; if local review is authorized only by a packet identity;
if a stale task projection is presented as retryable; or if `submission_failed`
copy attributes rejection to a provider without persisted actor evidence.
Stop if “Refreshing run state,” packet-independent quiescence, local integrity, or
explicit no-packet retry lacks a typed branch; if reviewed changed/unverifiable
evidence is required to become historically unchanged; or if generic local review
writes a packet action instead of atomically advancing only its dependent packet
disposition.
Stop if unknown/corrupt current state is falsely described as transient; if any
coherent reviewed recovery lacks an ordinary decline path; if uncertain packet or
local work coerces acknowledgement before decline; if local retry ignores any
ownership/sibling barrier or server policy eligibility; or if repository copy
reduces Git control/storage changes to a working-tree-only warning.
Stop if browser or component input can construct the terminal/current join; if the
join omits the independent runtime-audit ID, generic local-evidence ID, or evidence
fingerprint; if the validator accepts same-run/different-audit, same-run/different-
evidence-ID, or same-ID/different-fingerprint; or if an absent, stale, repaired, or
mismatched marker hides or relabels valid immutable terminal history instead of
returning terminal-only with no asserted current relationship.
Stop if a raw or widened filesystem revocation reason reaches copy; if live
`assembling` is relabelled `not_assembled` or accepted as terminal; or if direct
local retry is authorized by unchanged repository evidence without the exact
durable `definitive_not_started` trusted-refusal proof.
Stop if a future/incoherent health tuple offers refresh; if total eligible-W2 loss
is presented as passive waiting without Release/DevOps ownership, the exact
instance-replacement dry run, and its runbook; or if either operator-only state
gains a browser handler.
Stop if a two-action tuple can mix packet/local families, put decline first, or
change order across breakpoints; if missing evidence is described as repairable; if
`local_evidence_mismatch` is described as quarantined before the server proves it
irreconcilable; if status alone can imply quarantine closure; or if any stale,
cross-project, incomplete-sibling, wrong-reason, or mismatched-fingerprint
resolution can enter `local_integrity_quarantine_closed`.
Stop if `assembly_unconfirmed` displays a root reference, count, redaction summary,
assembled/not-assembled certainty, or artifact-derived recovery action; if a
redaction key is not imported from S4's closed enum or an unknown key/value is
rendered; if quarantine closure is not bound to the exact inspected request and
stored resolution identities; or if any of those presentation states creates an
eighth S4 mutation handler.
