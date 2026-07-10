# ADR 0009: MCP Admission Contract and Bounded Context Grants

## Status

Accepted for EPIC #172 (MCP Execution Readiness and Bounded Context Grants).
Establishes the single admission contract; the implementation slices (#172 → S1–S6
child issues) build on it. Supersedes the code-level policy scattered across the
four admission paths described below. Related: ADR
[0006](0006-executable-workforce-beta-boundary.md) (beta boundary),
[0008](0008-filesystem-mcp-bounded-context-grants.md) (filesystem bounded context
grants), and #43 (Architect-driven MCP assignment and prompt overlays).

## Context

Forge distinguishes three kinds of MCP involvement, and the whole epic exists
because the code does not distinguish them in one place:

1. **Planning-only MCP context** — the Architect says an MCP would help. Forge
   records it as run-scoped prompt instructions (`promptOverlay`,
   `mcpAwareSubtasks`). It grants nothing.
2. **Bounded read-only context grants** — Forge assembles a project-scoped,
   inspectable read-only context packet (file names, selected excerpts) after an
   explicit operator grant. Capabilities: `filesystem.project.read`,
   `filesystem.project.list`, `filesystem.project.search`.
3. **Live MCP tool handles** — a worker calling an MCP directly at runtime. This
   is **deferred**. It is not implemented in this beta and must read as a product
   boundary, not a broken install.

Today the same beta capability policy is re-derived by **four overlapping code
paths** that do not agree:

| # | Path | Location | Consumes | Purpose |
|---|------|----------|----------|---------|
| 1 | `validateMcpExecutionDesign` | `web/worker/mcp-execution-design.ts:326-454` | parsed `McpExecutionDesign` fence | approval-time validation |
| 2 | `deriveMcpGrantDecisions` / `decisionStatus` | `web/worker/mcp-execution-design.ts:753-867` | same design | grant-decision preview |
| 3 | `evaluateWorkPackageMcpBroker` | `web/worker/mcp-execution-design.ts:599-739` | persisted `workPackages.mcpRequirements` + `metadata.mcpGrants` | handoff-time broker |
| 4 | `requiresFilesystemGrantApproval` / `summarizeFilesystemCapabilities` | `web/lib/mcps/filesystem-grants.ts:90-339` | `mcpRequirements` + `metadata` | filesystem grant gate |

A **fifth** re-implementation lives client-side in
`web/app/dashboard/tasks/[id]/page.tsx:348-444`
(`canonicalFilesystemCapability`, `filesystemPackageCapabilitySummary`,
`unresolvedRequiredFilesystemGrants`), reading yet another requirement field set.

Concrete divergences observed (all are #172's named failure mode — *preview and
handoff disagree*):

- **Approval never runs the handoff broker.** `web/app/api/tasks/[id]/approve/route.ts`
  gates only on `requiresFilesystemGrantApproval`; it never calls
  `evaluateWorkPackageMcpBroker`. A package the broker will block at handoff for a
  non-filesystem reason (required GitHub MCP unhealthy, an unsafe GitHub write
  capability, an MCP-aware subtask capability not covered by an approved grant)
  passes approval and only blocks later at handoff. **This is the root defect.**
- **`filesystem.project.write` has three verdicts.** Planning/broker treat it as a
  planning-only *warning* (`isPlanningOnlyFilesystemWrite`,
  `mcp-execution-design.ts:318-320`); `canonicalFilesystemProjectCapability`
  (`filesystem-grants.ts:38-45`) maps it to `null` so
  `summarizeFilesystemCapabilities` silently *drops* it, while
  `hasUnsafeFilesystemCapability` flags it *unsafe*.
- **Capability normalization / aliasing is duplicated** with different alias
  models. `filesystem-grants.ts` collapses `filesystem.read` ↔
  `filesystem.project.read`; `mcp-execution-design.ts` keeps a one-way widening
  (`approvedCoverageCapabilityKeys:551-559`, `filesystemUnqualifiedAlias:561-565`).
- **Requirement field sets differ.** The grant gate reads
  `permissions+capabilities+requiredCapabilities+mcpCapabilities`
  (`filesystem-grants.ts:77-84`); the broker reads only `capabilities+permissions`
  (`capabilityArray:498-516`); the UI reads
  `capabilities+permissions+mcpCapabilities`. A requirement expressed only via
  `requiredCapabilities` is blocked by the server but shown as "no grant needed".
- **The safe allow-list is encoded three times** and never sources the catalog:
  `SAFE_BETA_CAPABILITY_PATTERNS` (`mcp-execution-design.ts:7-18`), the regex in
  `canonicalFilesystemProjectCapability` (`filesystem-grants.ts:41`), and
  `MCP_CATALOG[id].runtime.capabilities` (`catalog.ts:18,37`, the ostensible source
  of truth, never read by admission).
- **Denying a required filesystem grant burns an execution attempt.**
  `requiresFilesystemGrantApproval` returns `{blocked:false}` for any `denied`
  effective phase regardless of blocking capabilities
  (`filesystem-grants.ts:315-322`), so the package is claimed, then the executor
  throws `Filesystem MCP context blocked` (`work-package-executor.ts:~1515`),
  consuming an attempt for a guaranteed failure.
- **Recovery is not deterministic.** The per-task `always_allow` route only
  reconciles siblings in `pending/ready/blocked/needs_rework`
  (`tasks/[id]/filesystem-grants/route.ts:418-421`); the project-level route also
  reconciles `failed` siblings (`projects/[id]/filesystem-grant/route.ts:166-243`).
  The same grant state yields different outcomes depending on which endpoint issued it.
- **UI conflates a product boundary with a broken install.** Grant-preview copy is
  a 3-way ternary on `decision.status` only
  (`tasks/[id]/page.tsx:3171-3175`); a deferred GitHub-write capability renders the
  identical destructive "resolve this MCP issue" copy as a genuinely unhealthy MCP.
  There is no neutral badge bucket for deferred/planning
  (`statusBadgeClass:1203-1245`), and `RetryHandoffControls` offers "Re-run stalled
  handoff" even for non-retryable blocks.

## Decision

Introduce **one normalized admission decision** and route every surface through it.
The exact same decision object drives preview badges, approval blocking, handoff
blocking, filesystem recovery, and operator copy. Live MCP tool handles remain
deferred; no runtime tool is ever issued to a package run.

### The contract: `McpAdmissionDecision`

New module `web/lib/mcps/admission.ts` (types may live here or re-export from
`web/lib/mcps/types.ts`):

```ts
export type McpCapabilityClass =
  | 'planning_only'      // filesystem.project.write, prose-only hints
  | 'bounded_read_only'  // filesystem.project.read|list|search (+ catalog read/list/search)
  | 'deferred_live_mcp'  // github write/branch/pr/merge/settings/secret, filesystem write/delete/admin, any live tool handle
  | 'unknown'            // capability names no known MCP

export type McpAdmissionMode =
  | 'planning_only'
  | 'bounded_context_required'
  | 'bounded_context_approved'
  | 'blocked'
  | 'deferred_live_mcp'

export type McpAdmissionStatus = 'allowed' | 'warning' | 'blocked'

export type McpRecoveryAction =
  | 'continue_as_prompt_context'
  | 'approve_project_filesystem_context'
  | 'install_or_fix_mcp'
  | 'revise_plan'
  | 'defer_live_mcp_feature'

export type McpAdmissionDecision = {
  schemaVersion: 1
  mcpId: 'filesystem' | 'github' | string
  agent: string
  requirement: 'required' | 'optional'
  requestedCapabilities: string[]
  normalizedCapabilities: string[]
  mode: McpAdmissionMode
  status: McpAdmissionStatus
  reason: string
  recoveryAction?: McpRecoveryAction
  evidenceRefs: string[]
}
```

### Shared primitives (single copy each)

`web/lib/mcps/capability-normalization.ts` (new) is the ONLY home for:

- `normalizeCapability(cap)` — `trim().toLowerCase().replace(/\s+/g,'_')`.
- `classifyCapability(mcpId, cap): McpCapabilityClass` — reads the
  `bounded_read_only` set from `MCP_CATALOG[mcpId].runtime.capabilities` (plus
  filesystem project-alias spellings), folds in the `planning_only` set
  (`filesystem.project.write`) and the explicit `deferred_live_mcp` set. This makes
  the catalog the single declarative allow-list and gives `deferred_live_mcp` an
  explicit name instead of the generic "outside the allowed beta scope" string.
- `coverageKeysForGrant(cap)` / `coverageKeysForProhibition(cap)` — one alias model
  for `filesystem.read` ↔ `filesystem.project.read` (decide and document the
  direction once; see ADR 0008). Replaces `approvedCoverageCapabilityKeys`,
  `filesystemProjectAlias`, `filesystemUnqualifiedAlias`,
  `prohibitedCoverageCapabilityKeys`.
- `mergeCapabilityFields(entry)` — the one union of requirement fields. Define
  `REQUIREMENT_CAPABILITY_FIELDS = ['permissions','capabilities','requiredCapabilities','mcpCapabilities']`
  and read exactly those so the broker, grant gate, UI, and executor never diverge.
- `isMcpHealthy(status)` / `mcpHealthReason(mcpId, status)` — one health predicate
  and one message source.
- `canProceedWithoutMcp(requirement, fallback)` — `optional` +
  `continue_without_mcp`.

### The core producer

```ts
export function admitMcpRequirement(input: {
  mcpId: string
  agent: string
  requirement: 'required' | 'optional'
  requestedCapabilities: string[]
  prohibitedCapabilities: string[]
  status: ProjectMcpStatus | null
  hasPromptOnlyContext: boolean
  fallback: { action: McpFallbackAction }
  projectGrantCovers?: boolean       // filesystem bounded-context already approved
  evidenceRefs?: string[]
}): McpAdmissionDecision
```

Decision rules (preserving every current safety behavior):

- Unknown MCP → `mode:'blocked'`, `recoveryAction:'revise_plan'`,
  `class:'unknown'`.
- All requested capabilities are `planning_only` (or none actionable) →
  `mode:'planning_only'`, `status:'warning'`,
  `recoveryAction:'continue_as_prompt_context'`.
- Any `deferred_live_mcp` capability → `mode:'deferred_live_mcp'`,
  `status:'blocked'`, `recoveryAction:'defer_live_mcp_feature'`.
- Bounded read-only + already covered by an approved/project grant →
  `mode:'bounded_context_approved'`, `status:'allowed'`.
- Bounded read-only + not yet covered → `mode:'bounded_context_required'`,
  `status:'blocked'` (unless `optional`+`continue_without_mcp` → `warning`),
  `recoveryAction:'approve_project_filesystem_context'`.
- MCP unhealthy/missing/disabled and required with no prompt-only fallback →
  `status:'blocked'`, `recoveryAction:'install_or_fix_mcp'` (retryable);
  otherwise `warning`.
- `required` with no capabilities but prompt-only context present → `warning`
  (planning-only), not blocked.

`recoveryAction` replaces the fragile `isRetryableMcpBrokerBlock` string-matching:
retryable ⇔ `recoveryAction === 'install_or_fix_mcp'`.

### Adapters (shape-preserving, so persisted JSON and readers do not change)

Co-located in `admission.ts`:

- `decisionsToValidation(decisions): McpExecutionValidation`
- `decisionsToGrantPreview(decisions): McpGrantDecisions` — maps
  `mode`/`status` → `proposed|warning|blocked`, keeps `decisionId`,
  `sourceRequirementIndex`, `promptOverlayPresent`, **and adds** `mode`,
  `recoveryAction`, `normalizedCapabilities`, `evidenceRefs`.
- `decisionsToBrokerCheck(decisions, label): WorkPackageMcpBrokerCheck`

`web/lib/mcps/execution-design-metadata.ts:99-232` keeps reading the same
`grantDecisions`/`validation` JSON, extended (non-breaking, back-derive `mode` for
old artifacts).

## Consolidation map (four paths → one)

| Current function | Becomes |
|---|---|
| `validateMcpExecutionDesign` (`mcp-execution-design.ts:326-454`) | builds `admitMcpRequirement` per (requirement, agent); returns `decisionsToValidation` |
| `decisionStatus` + `deriveMcpGrantDecisions` (`:753-867`) | `deriveMcpGrantDecisions` calls `admitMcpRequirement`; `decisionStatus` deleted |
| `evaluateWorkPackageMcpBroker` (`:599-739`) + helpers `:488-591` | builds entries via `brokerEntries`, calls `admitMcpRequirement` with `mergeCapabilityFields`; returns `decisionsToBrokerCheck`; local `normalizeCapability/coverageCapabilityKey/unsafeCapability/capabilityArray/healthyStatus/canProceedWithoutMcp/isPlanningOnlyFilesystemWrite/SAFE_BETA_CAPABILITY_PATTERNS` deleted, imported from shared modules |
| `requiresFilesystemGrantApproval` / `summarizeFilesystemCapabilities` (`filesystem-grants.ts`) | filesystem-specific persistence over the shared classifier; imports normalization; keeps `FilesystemProjectCapability` nominal type + `ProjectFilesystemGrant` persistence |
| `mcpCapabilityList` (`work-package-executor.ts:1252-1260`) | imports `mergeCapabilityFields` |
| client helpers (`tasks/[id]/page.tsx:348-444`) | import shared helpers or consume a server-computed grant-state payload |

## Implementation slices

### S1 — Contract and terminology (child issue → S1)

- Create `web/lib/mcps/capability-normalization.ts` and `web/lib/mcps/admission.ts`
  with the types, primitives, `admitMcpRequirement`, and the three adapters above.
- Make `classifyCapability` read `MCP_CATALOG[mcpId].runtime.capabilities` and
  encode the explicit `deferred_live_mcp` list. Delete `SAFE_BETA_CAPABILITY_PATTERNS`.
- Write this ADR (done) and align roadmap/task-detail copy on the three-way
  terminology (planning-only / bounded read-only / deferred live MCP).

### S2 — Broker consolidation (child issue → S2)

- Migrate the four functions per the consolidation map. Delete duplicated helpers.
- **Enforce admission at approval.** In `web/app/api/tasks/[id]/approve/route.ts`,
  after the existing `requiresFilesystemGrantApproval` check (~`:189-209`), run the
  admission decision over every package and refuse approval (mirroring the existing
  `missingFilesystemGrant` early return) when any decision is `status:'blocked'`,
  returning the normalized `reason` + `recoveryAction`. Approval then enforces
  exactly what handoff enforces.
- **Invariant:** for any fixed package, `deriveMcpGrantDecisions` (preview),
  `evaluateWorkPackageMcpBroker` (handoff), and `requiresFilesystemGrantApproval`
  produce the same `mode`/`status`. New tests
  (`web/__tests__/mcp-admission-invariant.test.ts`) assert agreement for: required
  no-capability grants, prompt-only context, filesystem read/list/search,
  `filesystem.project.write`, an unsafe/deferred GitHub write, an unknown MCP, and a
  requirement expressed via each of the four capability fields.

### S3 — Filesystem grant recovery (child issue → S3)

- `requiresFilesystemGrantApproval` (`filesystem-grants.ts:315-322`) must NOT return
  `{blocked:false}` for a `denied` effective phase when blocking capabilities are
  non-empty; return a distinct terminal outcome (e.g. `deniedRequired:true`) so
  handoff holds the package pre-claim (zero attempts). Optional/`continue_without_mcp`
  denials stay non-blocking.
- `filesystemGrantHandoffBlock` (`work-package-handoff.ts:876-906`): branch on the
  denied-required outcome to `failWorkPackageForFilesystemGrant` with a message that
  names the operator denial and is recoverable via the existing
  `FILESYSTEM_GRANT_BLOCK_METADATA_KEY`. Pass `project?.mcpConfig` into
  `requiresFilesystemGrantApproval` in BOTH branches (the default branch at
  `:896-899` currently omits it), closing the approval-vs-handoff project-coverage divergence.
- Make recovery deterministic: the per-task `always_allow` route
  (`tasks/[id]/filesystem-grants/route.ts:418-421`) must reconcile `failed`
  grant-blocked siblings too, or delegate to the shared reconciliation used by
  `projects/[id]/filesystem-grant/route.ts:166-243`. Both endpoints must recover the
  identical package set for identical grant state.
- Preserve: filesystem blocks are `terminalBlock:true` and never auto-retried
  (`blocked-handoff-retry.ts:67-79`).

### S4 — Prompt/context assembly and bounded-context packet evidence (child issue → S4; builds on #43)

- Specialist prompts receive `promptOverlay` + `mcpAwareSubtasks` +
  `mcpRequirements` as **instructions**, never as tool grants
  (`work-package-executor.ts` prompt assembly). No live MCP handle is ever issued.
- The bounded read-only context packet (root path, selected file names/excerpts,
  included/omitted counts, redaction summary — per ADR 0008) is attached to the run
  as an **inspectable artifact**, referenced from `McpAdmissionDecision.evidenceRefs`.
- Sandbox-generated files (`.forge/task-runs/...`) stay clearly separated from
  host-repository writes in artifacts.
- `mcpCapabilityList` imports `mergeCapabilityFields`; executor filesystem gating uses
  shared `coverageKeysForGrant`/`classifyCapability` rather than re-deriving
  `filesystem.project.read` membership.

### S5 — UI and copy hardening (child issue → S5)

- New `web/lib/mcps/admission-copy.ts`: pure map from `mode`+`recoveryAction`+`status`
  → `{ statusKey, badgeText, headline, body, cta? }`. Every surface reads it, so copy
  cannot drift. Mapping:
  - `planning_only` → neutral "Planning context", body "Recorded as run-scoped prompt
    instructions; writes go through the Forge sandbox/host-apply path, no live MCP
    tools attached", no CTA.
  - `bounded_context_required` → amber "Needs project context", CTA scroll to the
    package's filesystem grant control.
  - `bounded_context_approved` → green "Context approved".
  - `blocked` + `install_or_fix_mcp` → red, CTA deep-link
    `/dashboard/projects/{projectId}#project-mcps-heading`.
  - `blocked` + `revise_plan` → red, CTA open Request-changes flow.
  - `deferred_live_mcp` → **neutral slate** "Deferred — beta boundary", body "Live MCP
    tool handles are not part of this beta. This is a product boundary, not a broken
    install", no CTA.
- Add `deferred`/`planning` neutral buckets to `statusBadgeClass`
  (`tasks/[id]/page.tsx:1203-1245`).
- Extend `execution-design-metadata.ts` decision type/normalizer to carry `mode`,
  `recoveryAction`, `normalizedCapabilities`, `evidenceRefs` (back-derive `mode` for
  old artifacts).
- Replace the status-only ternary (`:3171-3175`), split planning-only warnings from
  degradation warnings (`:3146-3155`), stop rendering deferred capabilities as
  destructive alerts (`:3135-3144`), gate `RetryHandoffControls` on retryability,
  surface the bounded-context packet inline, and add remediation CTAs +
  bounded-context note on the projects page (`projects/[id]/page.tsx:1035-1052`) and
  the MCPs catalog page (`mcps/page.tsx`).
- The worker must persist `mode`+`recoveryAction` on BOTH the `grantDecisions`
  preview decisions AND the per-package block metadata (`blockedReason`) so
  `RetryHandoffControls` routes correctly.

### S6 — End-to-end regression (child issue → S6)

- `web/__tests__` (or `web/e2e`) regression for a local-only tiny task-tracker
  project: Architect creates frontend/QA/docs/review packages; the MCP plan includes
  prompt-only context and no live tool handles; approval succeeds; handoff advances
  ready packages; a required `filesystem.project.read|search` grant still blocks until
  approved or denied through the intended path; a deferred GitHub-write capability is
  reported as `deferred_live_mcp`, not an install error.
- Plus the S2 preview==handoff invariant suite.

## Consequences

- Preview, approval, handoff, filesystem recovery, and UI copy are structurally
  incapable of disagreeing because they consume one decision object built by one
  producer over one set of primitives sourced from one catalog.
- `deferred_live_mcp` is a first-class, named mode, so blocks say "deferred live MCP
  feature" instead of a generic beta-scope error, and the UI shows a product
  boundary instead of a broken install.
- Denying a required filesystem grant no longer burns an execution attempt; recovery
  is deterministic across both endpoints.
- Live MCP runtime handles remain out of scope. Issuing them is a later,
  security-reviewed epic that depends on #40 (adversarial mode) and #60 (security
  review workforce). The eventual DB-backed MCP capability catalogue belongs to #121;
  this ADR keeps the allow-list catalog-sourced in code as the precursor.

## Out of scope

Live MCP tool handles for package runs; arbitrary filesystem write grants through
MCP; GitHub write/merge automation (#69); user-edited arbitrary grant scopes beyond
the bounded flows here; parallel specialist execution; replacing the sandbox
execution JSON path.
