# ADR 0009: MCP Admission Contract and Bounded Context Grants

## Status

Accepted for EPIC #172 (MCP Execution Readiness and Bounded Context Grants).
Establishes the single admission contract; the implementation slices (#172 → S1–S6
child issues) build on it. Supersedes the code-level policy scattered across the
admission paths described below. Related: ADR
[0006](0006-executable-workforce-beta-boundary.md) (beta boundary),
[0008](0008-filesystem-mcp-bounded-context-grants.md) (filesystem bounded context
grants), and #43 (Architect-driven MCP assignment and prompt overlays — see
[#43 re-scope](#43-re-scope) below).

> **Anchor freshness.** Line anchors in this ADR were re-derived against `main`
> after #175 ("Harden work-package execution repair") landed. Before editing,
> re-`grep` the named symbol — anchors drift as `main` moves. Every anchor cites a
> *symbol name* first and a line second; trust the symbol.

## Context

Forge distinguishes three kinds of MCP involvement, and the whole epic exists
because the code does not distinguish them in one place:

1. **Planning-only MCP context** — the Architect says an MCP would help. Forge
   records it as run-scoped prompt instructions (`promptOverlay`,
   `mcpAwareSubtasks`). It grants nothing.
2. **Bounded read-only context grants** — Forge assembles a project-scoped,
   inspectable read-only context packet after an explicit operator grant.
   Capabilities: `filesystem.project.read`, `filesystem.project.list`,
   `filesystem.project.search`. **A bounded grant is only "deliverable" when a
   context producer exists for that MCP.** Today that producer exists for
   `filesystem` only (`MCP_CATALOG.filesystem.runtime.mode ===
   'bounded_context_packet'`). `github` reads are safe but have no producer
   (`runtime.mode === 'external_service'`, `liveTools:false`); they are delivered
   as planning/prompt context, not as an approvable bounded packet.
3. **Live MCP tool handles** — a worker calling an MCP directly at runtime. This
   is **deferred**. It is not implemented in this beta and must read as a product
   boundary, not a broken install.

### The multiple-path problem

The same beta capability policy is re-derived by overlapping code paths that do
not share one producer:

| # | Path | Location (symbol · line on `main`) | Consumes | Purpose |
|---|------|-----------------------------------|----------|---------|
| 1 | `validateMcpExecutionDesign` | `web/worker/mcp-execution-design.ts` · 326 | parsed `McpExecutionDesign` fence | approval-time validation of the Architect design |
| 2 | `deriveMcpGrantDecisions` / `decisionStatus` | `mcp-execution-design.ts` · 803 / 753 | same design | grant-decision preview |
| 3 | `evaluateWorkPackageMcpBroker` | `mcp-execution-design.ts` · 599 | persisted `workPackages.mcpRequirements` + `metadata.mcpGrants` + `mcpAwareSubtasks` | handoff-time broker |
| 4 | `requiresFilesystemGrantApproval` / `summarizeFilesystemCapabilities` | `web/lib/mcps/filesystem-grants.ts` · 303 / 90 | `mcpRequirements` + `metadata` | filesystem grant gate (a *filesystem-only projection*) |
| 5 | client re-implementation | `web/app/dashboard/tasks/[id]/page.tsx` · `filesystemPackageCapabilitySummary` 369, `canonicalFilesystemCapability` 354, `unresolvedRequiredFilesystemGrants` 420 | yet another requirement field set | UI badges/blocking |

Concrete, currently-true divergences (all are #172's named failure mode —
*preview and handoff disagree*):

- **Approval never runs the handoff broker.** `web/app/api/tasks/[id]/approve/route.ts`
  gates only on `requiresFilesystemGrantApproval` (inside the status-flip
  `db.transaction`, `:192`); it never calls `evaluateWorkPackageMcpBroker`. A
  package the broker will block at handoff for a non-filesystem reason (required
  GitHub MCP unhealthy, an unsafe GitHub write capability, an MCP-aware subtask
  capability not covered by an approved grant) passes approval and only blocks
  later at handoff. **This is the root defect.** The approve route loads
  `projects.mcpConfig` (`:161-165`), *not* the `ProjectMcpStatus` health snapshot
  the broker needs, so fixing this is not a one-line call move (see S2).
- **`filesystem.project.write` has three verdicts.** Planning/broker treat it as a
  planning-only *warning* (`isPlanningOnlyFilesystemWrite`,
  `mcp-execution-design.ts:318`); `canonicalFilesystemProjectCapability`
  (`filesystem-grants.ts:38`) maps it to `null` so `summarizeFilesystemCapabilities`
  silently *drops* it, while `hasUnsafeFilesystemCapability` flags it *unsafe*.
- **Capability normalization / aliasing is duplicated** with different alias
  models. `filesystem-grants.ts` collapses `filesystem.read` ↔
  `filesystem.project.read`; `mcp-execution-design.ts` keeps a one-way widening
  (`approvedCoverageCapabilityKeys:551`).
- **Requirement field sets differ.** The grant gate reads
  `permissions+capabilities+requiredCapabilities+mcpCapabilities`
  (`filesystem-grants.ts:77-84`); the broker reads only `capabilities+permissions`
  (`capabilityArray:498`); the executor's `mcpCapabilityList`
  (`work-package-executor.ts:1527`) reads `capabilities+permissions`; the UI reads
  `capabilities+permissions+mcpCapabilities`. A requirement expressed only via
  `requiredCapabilities` is blocked by the filesystem gate but shown by the broker
  as "no grant needed".
- **The safe allow-list is encoded three times** and never sources the catalog:
  `SAFE_BETA_CAPABILITY_PATTERNS` (`mcp-execution-design.ts:7-18`, broader than the
  catalog — it also allows `github.actions.read`, `github.repository.list|search`,
  `github.contents.list|search`), the regex in `canonicalFilesystemProjectCapability`
  (`filesystem-grants.ts:41`), and `MCP_CATALOG[id].runtime.capabilities`
  (`catalog.ts:18,37`, the ostensible source of truth, never read by admission).
- **Denying a *required* filesystem grant burns an execution attempt AND dead-ends.**
  `requiresFilesystemGrantApproval` returns `{blocked:false}` for a `denied`
  effective phase regardless of blocking capabilities (`filesystem-grants.ts:315-322`).
  So handoff does *not* hold the package; it is claimed and the executor throws
  `Filesystem MCP context blocked` (`work-package-executor.ts:1790`), consuming an
  attempt. Worse, that executor failure never writes the `mcpGrantBlock` marker
  (only the handoff gate `failWorkPackageForFilesystemGrant` does,
  `work-package-handoff.ts:807`), so `canEditPackageGrant`
  (`tasks/[id]/filesystem-grants/route.ts:123-143`) refuses grant edits on the
  resulting `failed` package — the operator cannot recover by approving the grant.
- **Recovery scope differs between the two grant endpoints.** The per-task route
  recovers `failed`/`blocked` grant-blocked packages
  (`FAILED_GRANT_RECOVERY_PACKAGE_STATUSES`, `tasks/[id]/filesystem-grants/route.ts:121`)
  but its `always_allow` sibling propagation only touches
  `STANDARD_EDITABLE_PACKAGE_STATUSES` (no `failed`) and only *within the current
  task* (`:411-446`). The project route reconciles across *every task in the
  project* including `failed` (`RECONCILABLE_PACKAGE_STATUSES`,
  `projects/[id]/filesystem-grant/route.ts:166-244`). The same `always_allow` grant
  recovers a different package set depending on which endpoint issued it.
- **UI conflates a product boundary with a broken install.** Grant-preview copy is
  a ternary on `decision.status` only; a deferred GitHub-write capability renders
  the same destructive "resolve this MCP issue" copy as a genuinely unhealthy MCP.
  `statusBadgeClass` (`tasks/[id]/page.tsx:1203`) has no neutral bucket for
  deferred/planning, and `RetryHandoffControls` offers "Re-run stalled handoff"
  even for non-retryable blocks.

## Decision

Introduce **one normalized, package-level admission evaluation** and route every
surface through it. Preview, approval, and handoff all consume the output of a
single producer; the filesystem grant gate becomes a *projection* of that same
evaluation. Live MCP tool handles remain deferred; no runtime tool is ever issued
to a package run.

### Layer 0 — capability classification and delivery kind

`web/lib/mcps/capability-normalization.ts` (new) is the ONLY home for
normalization and classification:

```ts
export type McpCapabilityClass =
  | 'planning_only'      // filesystem.project.write, prose-only hints, and safe reads with no producer
  | 'bounded_read_only'  // safe reads (catalog + supplement) — deliverability depends on deliveryKind
  | 'deferred_live_mcp'  // github write/branch/pr/merge/settings/secret, filesystem write/delete/admin, any live tool handle
  | 'unknown'            // capability names no known MCP, or a known MCP + unrecognized capability

export type McpDeliveryKind =
  | 'bounded_context_packet'  // Forge assembles a read-only packet (filesystem)
  | 'planning_context_only'   // safe reads with no producer yet (github); passed as prompt context, health-gated

// deliveryKind is sourced from the catalog, not re-declared:
//   MCP_CATALOG[id].runtime.mode === 'bounded_context_packet' -> 'bounded_context_packet'
//   otherwise ('external_service') -> 'planning_context_only'
export function mcpDeliveryKind(mcpId: string): McpDeliveryKind

export function normalizeCapability(cap: string): string   // trim().toLowerCase().replace(/\s+/g,'_')
export function classifyCapability(mcpId: string, cap: string): McpCapabilityClass
```

`classifyCapability`'s safe-read set is `MCP_CATALOG[mcpId].runtime.capabilities`
**∪ `SAFE_READ_SUPPLEMENT`**, where `SAFE_READ_SUPPLEMENT` is migrated *verbatim*
from `SAFE_BETA_CAPABILITY_PATTERNS` so no capability that is allowed today
becomes newly `unknown` (specifically `github.actions.read`,
`github.repository.list|search`, `github.contents.list|search`). Deleting
`SAFE_BETA_CAPABILITY_PATTERNS` therefore moves the exact same patterns into a
single documented data set — **not a behavior change**. `filesystem.project.write`
classifies as `planning_only`. Anything not in the safe-read set and not
planning-only classifies as `deferred_live_mcp` (known MCP) or `unknown`.

**Risk ≠ delivery.** A `bounded_read_only` github read is *safe* but not
*deliverable as a bounded packet* — `mcpDeliveryKind('github') ===
'planning_context_only'`, so it is admitted as planning/prompt context (recovery
`continue_as_prompt_context`) and stays health-gated exactly as today; it is never
offered `approve_project_filesystem_context` and never marked
`bounded_context_approved`. Only `filesystem` bounded reads flow through the
approve/deny bounded-context path.

Shared primitives (single copy each, all in `capability-normalization.ts`):
`coverageKeysForGrant(cap)` / `coverageKeysForProhibition(cap)` (one documented
alias direction for `filesystem.read` ↔ `filesystem.project.read`, per ADR 0008;
replaces `approvedCoverageCapabilityKeys`, `filesystemProjectAlias`,
`filesystemUnqualifiedAlias`, `prohibitedCoverageCapabilityKeys`);
`mergeCapabilityFields(entry)` reading exactly
`REQUIREMENT_CAPABILITY_FIELDS = ['permissions','capabilities','requiredCapabilities','mcpCapabilities']`;
`isMcpHealthy(status)` / `mcpHealthReason(mcpId,status)`;
`canProceedWithoutMcp(requirement,fallback)` = `optional` + `continue_without_mcp`
(note: `ask_user` is **blocking**, not a continue fallback).

### Layer 1 — the effective-grant state (no coverage boolean)

A single normalized input models the full filesystem grant lifecycle, so denial
and recovery live in the shared decision instead of a second filesystem-only
policy:

```ts
export type EffectiveGrantState = {
  phase: 'none' | 'proposed' | 'approved' | 'denied' | 'not_issued'
  source: 'none' | 'package-local' | 'project-level'
  status: 'not_issued' | 'approved' | 'denied'
  grantMode?: 'allow_once' | 'always_allow'
  consumed?: boolean            // allow_once already issued -> treat as none for a retry
  coveredCapabilities: string[] // canonical filesystem.project.*
  grantApprovalId?: string
}
export function readEffectiveGrantState(pkg: { metadata: unknown }, project: { mcpConfig: unknown }): EffectiveGrantState
```

`readEffectiveGrantState` distinguishes never-approved (`phase:'none'|'proposed'`),
explicitly denied (`status:'denied'`), consumed allow-once (`consumed:true`),
revoked project grant (was `project-level` but coverage no longer holds →
collapses to `none`), insufficient coverage (`coveredCapabilities` lacks a
required capability), package-local approval (`source:'package-local'`), and
project-level approval (`source:'project-level'`). It reads the same package
`metadata.mcpGrantPhases.effective` and `project.mcpConfig.grants.filesystem` the
current routes write.

### Layer 2 — the per-requirement producer

```ts
export type McpAdmissionMode =
  | 'planning_only' | 'bounded_context_required' | 'bounded_context_approved'
  | 'blocked' | 'deferred_live_mcp' | 'unknown_legacy'
export type McpAdmissionStatus = 'allowed' | 'warning' | 'blocked'
export type McpRecoveryAction =
  | 'continue_as_prompt_context' | 'approve_project_filesystem_context'
  | 'install_or_fix_mcp' | 'revise_plan' | 'defer_live_mcp_feature'

export type McpAdmissionDecision = {
  schemaVersion: 1
  mcpId: 'filesystem' | 'github' | string
  agent: string
  requirement: 'required' | 'optional'
  requestedCapabilities: string[]
  normalizedCapabilities: string[]
  capabilityClasses: Array<{ capability: string; class: McpCapabilityClass; deliveryKind: McpDeliveryKind | null }>
  mode: McpAdmissionMode
  status: McpAdmissionStatus
  reason: string
  recoveryAction?: McpRecoveryAction
  evidenceRefs: string[]   // PLANNED scope only pre-run (root + capability set); run evidence added later, see S4
}

export function admitMcpRequirement(input: {
  mcpId: string
  agent: string
  requirement: 'required' | 'optional'
  requestedCapabilities: string[]
  packageProhibitedKeys: ReadonlySet<string>   // deny-wins set unioned across the whole package (Layer 3)
  status: ProjectMcpStatus | null
  hasPromptOnlyContext: boolean
  effectiveGrant: EffectiveGrantState
  fallback: { action: McpFallbackAction }
  evidenceRefs?: string[]
}): McpAdmissionDecision
```

`capabilityClasses` records the per-capability result so mixed requirements do not
lose information and a `class:'unknown'` capability is representable. The aggregate
`mode`/`status` is chosen by a **total, precedence-ordered decision table** (first
match wins; every branch is defined):

1. **Unknown MCP** → `mode:'blocked'`, `status:'blocked'`, `recoveryAction:'revise_plan'`.
2. **Any capability class `unknown`** (known MCP, unrecognized/typo capability) →
   `mode:'blocked'`, `status:'blocked'`, `recoveryAction:'revise_plan'`.
3. **Any capability prohibited package-wide** (`normalizeCapability(cap)` ∈
   `packageProhibitedKeys`) → treated as `deferred_live_mcp`; go to (4).
4. **Any capability class `deferred_live_mcp`** → `mode:'deferred_live_mcp'`. If
   `requirement==='required'` → `status:'blocked'`, `recoveryAction:'revise_plan'`.
   If `optional` → `status:'warning'`, `recoveryAction:'defer_live_mcp_feature'`
   (approvable, non-blocking). "Product boundary, not broken install" copy applies.
5. **Any capability class `bounded_read_only` with `deliveryKind ===
   'bounded_context_packet'`** (filesystem):
   - covered by `effectiveGrant` (`status:'approved'` & not `consumed` & covers the
     required capabilities) → `mode:'bounded_context_approved'`, `status:'allowed'`.
   - `effectiveGrant.status === 'denied'` & required → `mode:'bounded_context_required'`,
     `status:'blocked'`, `recoveryAction:'approve_project_filesystem_context'`
     (**deniedRequired** — the handoff gate must HOLD, see S3).
   - otherwise not covered → `mode:'bounded_context_required'`; `status:'blocked'`
     unless `optional`+`continue_without_mcp` (`status:'warning'`);
     `recoveryAction:'approve_project_filesystem_context'`.
6. **Any capability class `bounded_read_only` with `deliveryKind ===
   'planning_context_only'`** (github reads): delivered as planning context.
   Health overlay (7) may block; otherwise `mode:'planning_only'`,
   `status:'allowed'`, `recoveryAction:'continue_as_prompt_context'`.
7. **All capabilities `planning_only`, OR zero actionable capabilities:**
   - `required` with zero capabilities and **no** prompt-only context →
     `mode:'blocked'`, `status:'blocked'`, `recoveryAction:'revise_plan'`
     (the plan under-specified a required MCP).
   - otherwise → `mode:'planning_only'`, `status:'warning'`,
     `recoveryAction:'continue_as_prompt_context'`.
8. **Health overlay** (applied to the mode chosen above when it is `allowed`):
   if `!isMcpHealthy(status)` and `required` and not `canProceedWithoutMcp` →
   `status:'blocked'`, `recoveryAction:'install_or_fix_mcp'` (retryable). If
   `optional`+`continue_without_mcp` → `status:'warning'`.

`recoveryAction` replaces the fragile `isRetryableMcpBrokerBlock` string-matching:
a block is **retryable iff its `recoveryAction === 'install_or_fix_mcp'`**.

### Layer 3 — the package-level canonical evaluation (deny-wins + subtasks)

The single evaluation every surface consumes. It unions prohibitions across the
whole package (deny-wins) *before* admitting any requirement, and validates
MCP-aware subtasks against the normalized approved coverage — preserving the
current broker's package-wide prohibition removal and subtask checks
(`evaluateWorkPackageMcpBroker`, `mcp-execution-design.ts:617-631,697-721`).

```ts
export type McpAdmissionEvaluation = {
  decision: McpAdmissionDecision
  source: {                                   // retained so adapters are shape-preserving
    decisionId: string
    sourceRequirementIndex: number
    assignment: { type: McpAssignmentType; targetId: string | null }
    fallback: { action: McpFallbackAction; message: string }
    promptOverlayPresent: boolean
  }
  health: { installState: string; status: string; enabled: boolean; error: string | null }
}

export type McpWorkPackageAdmission = {
  schemaVersion: 2
  evaluations: McpAdmissionEvaluation[]
  subtaskDecisions: Array<{ subtaskId: string; agent: string; capability: string;
    class: McpCapabilityClass; status: McpAdmissionStatus; reason: string; recoveryAction?: McpRecoveryAction }>
  referencedHealth: McpExecutionValidation['health']   // aggregate health array validation needs
  aggregate: {
    status: 'allowed' | 'warning' | 'blocked'
    blocked: string[]
    warnings: string[]
    blockedReason: string | null
    retryable: boolean                          // true iff every blocking decision is install_or_fix_mcp
    primaryRecoveryAction?: McpRecoveryAction    // precedence: revise_plan > approve_project_filesystem_context > install_or_fix_mcp > defer_live_mcp_feature
  }
}

export function admitWorkPackageMcp(input: {
  entries: Array<Record<string, unknown>>       // brokerEntries(): mcpRequirements ∪ metadata.mcpGrants
  subtasks: Array<Record<string, unknown>>      // metadata.mcpAwareSubtasks
  label: string
  statusFor: (mcpId: string) => ProjectMcpStatus | null
  effectiveGrantFor: (mcpId: string) => EffectiveGrantState
  hasPromptOnlyContextFor: (mcpId: string) => boolean
}): McpWorkPackageAdmission
```

`admitWorkPackageMcp`: (1) build `packageProhibitedKeys` = union of
`coverageKeysForProhibition` over every entry; (2) `admitMcpRequirement` per entry
with that set (a capability prohibited anywhere is `deferred_live_mcp`, never
approved); (3) accumulate approved coverage keys minus the prohibition set;
(4) classify each subtask capability and check known MCP + safe scope + covered by
approved coverage, matching the current subtask loop; (5) fold everything into
`aggregate`. This is the canonical evaluation consumed by preview, approval, and
handoff.

### Adapters (shape-preserving, over the evaluation, not bare decisions)

Co-located in `web/lib/mcps/admission.ts`. They take the whole
`McpWorkPackageAdmission` (which retains `source` + `health`), so persisted JSON
and existing readers do not change shape — they are only *extended*:

- `admissionToValidation(admission): McpExecutionValidation` — uses
  `referencedHealth` for the aggregate health array.
- `admissionToGrantPreview(admission): McpGrantDecisions` — keeps `decisionId`,
  `sourceRequirementIndex`, assignment, fallback, raw `health`,
  `promptOverlayPresent`; **adds** `mode`, `recoveryAction`,
  `normalizedCapabilities`, `capabilityClasses`, `evidenceRefs`.
- `admissionToBrokerCheck(admission): WorkPackageMcpBrokerCheck` — plus
  `retryable`, `primaryRecoveryAction`.

**Legacy artifacts.** `web/lib/mcps/execution-design-metadata.ts` (reader, ~99-232)
keeps reading the same `grantDecisions`/`validation` JSON. When a decision lacks
`mode` (pre-#172 artifact), the reader sets `mode:'unknown_legacy'` and **must not
invent** `bounded_context_approved` vs `bounded_context_required` — that
distinction cannot be recovered from status/capabilities/health alone. The UI
(S5) renders `unknown_legacy` as a neutral "Re-open plan to recompute" state and
derives live grant state from the package's current `metadata.mcpGrantPhases`, not
from the stale artifact.

## Consolidation map (paths → one)

Each edit is owned by exactly one slice. Symbols that other callers still import
keep a **transitional re-export** until their callers migrate in the owning slice.

| Current symbol (line on `main`) | Becomes | Owner |
|---|---|---|
| `validateMcpExecutionDesign` (`mcp-execution-design.ts:326`) | builds `admitWorkPackageMcp` over design requirements; returns `admissionToValidation` | S2 |
| `decisionStatus` (`:753`) + `deriveMcpGrantDecisions` (`:803`) | `deriveMcpGrantDecisions` calls `admitWorkPackageMcp`; returns `admissionToGrantPreview`; `decisionStatus` deleted | S2 |
| `evaluateWorkPackageMcpBroker` (`:599`) + helpers `capabilityArray:498`, `approvedCoverageCapabilityKeys:551`, `isPlanningOnlyFilesystemWrite:318` | calls `admitWorkPackageMcp` with `mergeCapabilityFields`; returns `admissionToBrokerCheck`; local normalization/allowlist deleted, imported from shared modules | S2 |
| `SAFE_BETA_CAPABILITY_PATTERNS` (`:7-18`) | migrated verbatim into `SAFE_READ_SUPPLEMENT`; **kept as a transitional re-export in S1**, deleted in S2 after callers move | S1 create / S2 delete |
| `requiresFilesystemGrantApproval` / `summarizeFilesystemCapabilities` (`filesystem-grants.ts:303/90`) | filesystem-specific **projection** of `admitWorkPackageMcp` (filesystem decisions only); imports normalization; keeps `FilesystemProjectCapability` nominal type + `ProjectFilesystemGrant` persistence + `EffectiveGrantState` reader | S3 |
| `isRetryableMcpBrokerBlock` (`:90`) + `buildMcpBrokerBlockMetadata` (`blocked-handoff-retry.ts:32`) | consume `aggregate.retryable`/`primaryRecoveryAction`; persist `mode`+`recoveryAction` under `metadata.mcpBroker` | S2 (broker), S5 (persist for UI) |
| `mcpGrantsForAgent` (`workforce-materializer.ts:157`) | persists `mode`, `recoveryAction`, `normalizedCapabilities`, `evidenceRefs` on each grant (schema bump), not just id/mcp/caps/requirement/status/reason/fallback/health | S2 |
| `mcpCapabilityList` (`work-package-executor.ts:1527`) | imports `mergeCapabilityFields`; executor filesystem gating uses shared `coverageKeysForGrant`/`classifyCapability` | S4 |
| client helpers (`tasks/[id]/page.tsx:348-444`) | import shared helpers OR consume a server-computed grant-state payload; render `mode`+`recoveryAction` via `admission-copy.ts` | S5 |

## Implementation slices

Dependency order: **S1 → S2 → {S3, S4} → S5 → S6.** S3 and S4 both depend on S2's
canonical evaluation + persisted shape. **S5 depends on S4** (it renders the
run-evidence schema S4 defines) and on S2. S6 depends on S2–S5.

### S1 — Contract and terminology

- Create `web/lib/mcps/capability-normalization.ts` (Layer 0 primitives,
  `classifyCapability`, `mcpDeliveryKind`, `SAFE_READ_SUPPLEMENT`) and
  `web/lib/mcps/admission.ts` (Layers 1–3 + adapters).
- Keep `SAFE_BETA_CAPABILITY_PATTERNS` as a transitional re-export of
  `SAFE_READ_SUPPLEMENT` so S1 compiles without touching S2's callers.
- Write this ADR (done) and align roadmap/task-detail copy on the three-way
  terminology.
- **No deletions of live-referenced symbols in S1.**

### S2 — Broker consolidation and approval enforcement

- Migrate the paths per the consolidation map. Delete duplicated helpers only
  after their callers import the shared modules.
- **Enforce admission at approval.** In `web/app/api/tasks/[id]/approve/route.ts`:
  acquire the MCP health snapshot via `getProjectMcpOverview(project)` **before**
  and **outside** the status-flip `db.transaction` (it performs live checks and
  writes cached `ProjectMcpStatus` rows — it must not run inside the transaction
  that flips the task to `approved`). Run `admitWorkPackageMcp` over every package
  using that snapshot; if any `aggregate.status === 'blocked'`, return the same
  409 shape as the existing `missingFilesystemGrant` early return (`:199-209,280`)
  with the normalized `reason` + `primaryRecoveryAction`. **Persist the
  `checkedAt` health snapshot** the approval decision used on the plan-approval
  gate metadata (next to the existing `approvedGrantSnapshot`, `:221-263`).
- **Parity guarantee (narrowed).** For a fixed package and a *fixed health
  snapshot*, `deriveMcpGrantDecisions` (preview), the approval check, and
  `evaluateWorkPackageMcpBroker` (handoff) return the same `mode`/`status` because
  they call one producer. MCP health/config can change between approval and
  handoff, so the promise is: **a block already visible in the approval-time
  snapshot is surfaced at approval, not missed until handoff** — not that an
  approved task can never block later.
- **Invariant tests** (`web/__tests__/mcp-admission-invariant.test.ts`): preview,
  approval, and handoff agree for required no-capability grants, prompt-only
  context, filesystem read/list/search, `filesystem.project.write`, an
  unsafe/deferred GitHub write, a healthy GitHub read (planning-context, not
  bounded), an unknown MCP, a package-wide prohibition that must beat a
  per-entry approval, an MCP-aware subtask capability, and a requirement expressed
  via each of the four capability fields. `requiresFilesystemGrantApproval` is
  tested only as the *filesystem projection* of the same evaluation.

### S3 — Filesystem grant recovery (deterministic, recoverable)

- `requiresFilesystemGrantApproval` (`filesystem-grants.ts:315-322`) must stop
  returning `{blocked:false}` for a `denied` effective phase when blocking
  capabilities are non-empty and no `continue_without_mcp` fallback applies.
  Return a distinct `deniedRequired:true` so handoff HOLDS the package pre-claim
  (zero attempts) instead of letting the executor throw at
  `work-package-executor.ts:1790`.
- **Recoverable held state, not a crash.** `failWorkPackageForFilesystemGrant`
  (`work-package-handoff.ts:807`) sets the package to **`blocked`** (in the
  recovery set) with the `mcpGrantBlock` marker and does **not** drive the task to
  `failed`; `progressWorkforce` (`:1165-1193`) must treat a filesystem-grant
  terminal block as *held* (task stays operator-actionable), not as task failure.
  Both never-approved-required and denied-required take this held path.
- `filesystemGrantHandoffBlock` (`work-package-handoff.ts:876-906`): pass
  `project?.mcpConfig` into `requiresFilesystemGrantApproval` in **both** branches
  (the default branch at `:896-899` currently omits it), closing the
  approval-vs-handoff project-coverage divergence.
- **One project-wide reconciliation routine.** Extract
  `reconcileFilesystemGrantsForProject(projectId, tx)` and call it from **both**
  the per-task `always_allow` path (`tasks/[id]/filesystem-grants/route.ts:411-446`,
  which currently reconciles only current-task standard-status siblings) and the
  project route (`projects/[id]/filesystem-grant/route.ts:166-244`). Both endpoints
  recover the identical package set for identical grant state.
- **Precedence.** A later project-level `always_allow` grant covering a capability
  supersedes an earlier package-local `denied` effective phase for that capability
  (operator's later, broader decision wins). Document and test this precedence in
  `readEffectiveGrantState`.
- **Acceptance tests assert exact transitions** (package `pending/ready →
  blocked`, task not `failed`, zero new `agentRuns`; then grant approval →
  package `ready`, task re-driven), not just attempt counts.
- Preserve: a filesystem block is never auto-retried
  (`shouldAutoRetryBlockedHandoff`, `blocked-handoff-retry.ts:67-79`).

### S4 — Prompt/context assembly and bounded-context packet evidence (builds on #43)

- Specialist prompts receive `promptOverlay` + `mcpAwareSubtasks` +
  `mcpRequirements` as **instructions**, never as tool grants (executor prompt
  assembly around `work-package-executor.ts:1527-1583`). No live MCP handle is
  ever issued.
- **Evidence lifecycle — planned scope vs issued evidence.** Pre-run,
  `McpAdmissionDecision.evidenceRefs` carries only *planned scope* (root path +
  capability set), never file contents. The bounded read-only context packet is
  assembled during execution and requires an `agentRunId`; after the run (including
  **failed** runs) a run-level record is updated with stable artifact refs to the
  packet **metadata** artifact (root, selected file names, included/omitted counts,
  redaction summary — per ADR 0008, which forbids persisting raw file contents).
  **File contents stay prompt-only and are not persisted**; "selected excerpts" are
  not written to an inspectable artifact. `mcpCapabilityList` imports
  `mergeCapabilityFields`; executor filesystem gating uses shared
  `coverageKeysForGrant`/`classifyCapability`.
- Sandbox-generated files (`.forge/task-runs/...`) stay clearly separated from
  host-repository writes in artifacts.

### S5 — UI and copy hardening

- New `web/lib/mcps/admission-copy.ts`: pure map from `mode`+`recoveryAction`+
  `status` → `{ statusKey, badgeText, headline, body, cta? }`. Every surface reads
  it. Mapping:
  - `planning_only` → neutral "Planning context", no CTA.
  - `bounded_context_required` → amber "Needs project context", CTA to the
    package's filesystem grant control.
  - `bounded_context_approved` → green "Context approved".
  - `blocked`+`install_or_fix_mcp` → red, CTA deep-link
    `/dashboard/projects/{projectId}#project-mcps-heading`.
  - `blocked`+`revise_plan` → red, CTA "Request changes / regenerate plan".
  - `deferred_live_mcp` → **neutral slate** "Deferred — beta boundary", body "Live
    MCP tool handles are not part of this beta. This is a product boundary, not a
    broken install." **When it is a *required* (blocking) deferred requirement, it
    still carries the `revise_plan` CTA** so the operator can remove/regenerate the
    offending requirement instead of being stuck with an unapprovable plan and no
    action; an *optional* deferred requirement is warning-only and approvable.
  - `unknown_legacy` → neutral "Re-open plan to recompute"; grant state read live
    from package metadata, never invented.
- Add `deferred`/`planning`/`legacy` neutral buckets to `statusBadgeClass`
  (`tasks/[id]/page.tsx:1203`).
- Extend `execution-design-metadata.ts` decision type/normalizer to carry `mode`,
  `recoveryAction`, `normalizedCapabilities`, `capabilityClasses`, `evidenceRefs`
  (`unknown_legacy` for old artifacts).
- Replace the status-only ternary, split planning-only warnings from degradation
  warnings, stop rendering deferred capabilities as destructive alerts, gate
  `RetryHandoffControls` on `aggregate.retryable`, surface the bounded-context
  packet metadata inline (from S4's schema), and add remediation CTAs +
  bounded-context note on the projects page and the MCPs catalog page
  (`mcps/page.tsx`).
- **Persisted schema is versioned.** The worker persists `mode`+`recoveryAction`
  on BOTH the `grantDecisions` preview decisions AND the per-package block metadata
  (`metadata.mcpBroker`, a JSON object — `work_packages.blocked_reason` stays the
  human text). When multiple decisions block, `aggregate.retryable` is true iff
  every blocking decision is `install_or_fix_mcp`, and
  `primaryRecoveryAction` is the highest-precedence block
  (`revise_plan > approve_project_filesystem_context > install_or_fix_mcp >
  defer_live_mcp_feature`), which drives the single UI CTA.

### S6 — End-to-end regression

- `web/__tests__` (or `web/e2e`) regression for a local-only tiny task-tracker
  project: Architect creates frontend/QA/docs/review packages; the MCP plan
  includes prompt-only context and no live tool handles; approval succeeds;
  handoff advances ready packages; a required `filesystem.project.read|search`
  grant holds the package (recoverable, zero attempts) until approved or denied
  through the intended path; a deferred GitHub-write capability is reported as
  `deferred_live_mcp`, not an install error; a healthy GitHub read is planning
  context, not an approvable bounded packet.
- Plus the S2 preview==approval==handoff invariant suite.

## <a id="43-re-scope"></a>#43 re-scope

#43 predates this boundary and still asks the broker to *issue scoped MCP tools*,
agents to *receive approved tools*, and MCP tool calls to be *audited* — which
conflicts with this ADR's no-live-handle rule — and its examples use unqualified
capability names (`repository.read`, `branches.create`). Under #172, #43 is
re-scoped to its **planning/overlay output only** (Architect MCP assignment,
prompt overlays, MCP-aware subtasks feeding S4), with capability vocabulary
standardized to the `github.*` / `filesystem.project.*` namespace the classifier
and catalog use. Its runtime tool-issuance and tool-call-audit acceptance criteria
move to the later security-reviewed live-MCP epic (depends on #40 adversarial mode
and #60 security-review workforce). See #43 for the updated scope.

## Consequences

- Preview, approval, handoff, filesystem recovery, and UI copy are structurally
  incapable of disagreeing for a fixed health snapshot, because they consume one
  evaluation built by one producer over one set of primitives sourced from one
  catalog. The filesystem gate is a tested projection of that evaluation.
- `deferred_live_mcp` is a first-class, named mode with an operator action, so
  blocks say "deferred live MCP feature" and the UI shows a product boundary with a
  path forward instead of a broken install.
- Denying or withholding a required filesystem grant no longer burns an execution
  attempt or dead-ends; it holds the package in a recoverable state, and recovery
  is deterministic across both endpoints via one project-wide reconciliation.
- Bounded context is delivered only where a producer exists (filesystem);
  safe-but-undeliverable reads (github) are honest planning context.
- Live MCP runtime handles remain out of scope. Issuing them is a later,
  security-reviewed epic that depends on #40 and #60. The eventual DB-backed MCP
  capability catalogue belongs to #121; this ADR keeps the allow-list
  catalog-sourced in code as the precursor.

## Out of scope

Live MCP tool handles for package runs; arbitrary filesystem write grants through
MCP; GitHub write/merge automation (#69); user-edited arbitrary grant scopes beyond
the bounded flows here; parallel specialist execution; replacing the sandbox
execution JSON path.
