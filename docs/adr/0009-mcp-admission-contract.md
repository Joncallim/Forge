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
  | 'planning_context_only'   // safe reads with no producer yet (github); passed as prompt context, NOT health-gated (consumes no runtime)

// deliveryKind is sourced from the catalog, not re-declared:
//   MCP_CATALOG[id].runtime.mode === 'bounded_context_packet' -> 'bounded_context_packet'
//   otherwise ('external_service') -> 'planning_context_only'
export function mcpDeliveryKind(mcpId: string): McpDeliveryKind | null  // null for unknown MCP

export function normalizeCapability(cap: string): string   // trim().toLowerCase().replace(/\s+/g,'_')

// Canonicalize only documented legacy aliases. Do not "repair" arbitrary input.
// The current beta accepts unqualified filesystem read/list/search, so these must
// retain their behavior while the persisted vocabulary moves to project-scoped
// names. Bare mutations are not aliases for the sandbox write path.
export function canonicalCapabilityForMcp(mcpId: string, cap: string): string {
  const c = normalizeCapability(cap)
  if (mcpId === 'filesystem') {
    const match = c.match(/^filesystem\.(read|list|search)$/)
    if (match) return `filesystem.project.${match[1]}`
  }
  return c
}

// Exact capabilities accepted by today's SAFE_BETA patterns but absent from the
// corresponding catalog row. Keep the data MCP-keyed so a GitHub supplement can
// never authorize a filesystem request.
export const SAFE_READ_SUPPLEMENT: Readonly<Record<'github' | 'filesystem', readonly RegExp[]>> = {
  filesystem: [],
  github: [
    /^github\.actions\.read$/,
    /^github\.repository\.(read|list)$/,
    /^github\.contents\.(list|search)$/,
  ],
}

// A deferred value is recognized by an explicit MCP-owned resource -> operation
// registry. This is intentionally NOT a Cartesian regex: a globally known verb
// does not make `github.actions.merge` or `github.settings.approve` meaningful.
// Adding a future pair is a deliberate code/catalog change with a test.
export const DEFERRED_CAPABILITY_FAMILIES: Readonly<
  Record<'github' | 'filesystem', Readonly<Record<string, readonly string[]>>>
> = {
  github: {
    issues: ['write', 'create', 'update', 'delete', 'close'],
    pull_requests: ['write', 'create', 'update', 'delete', 'merge', 'close', 'approve', 'list', 'get'],
    contents: ['write', 'create', 'update', 'delete'],
    repository: ['write', 'update', 'delete'],
    actions: ['write', 'dispatch', 'cancel'],
    branches: ['read', 'list', 'get', 'create', 'update', 'delete', 'merge'],
    settings: ['read', 'list', 'get', 'write', 'update'],
    secrets: ['read', 'list', 'get', 'write', 'create', 'update', 'delete', 'rotate'],
    workflows: ['read', 'list', 'get', 'run', 'write', 'create', 'update', 'delete', 'dispatch', 'cancel'],
  },
  filesystem: {
    root: ['write', 'delete', 'admin', 'move', 'create'],
    project: ['write', 'delete', 'admin', 'move', 'create'],
  },
}

// Parse only exact supported address shapes. GitHub capabilities are always
// `github.<resource>.<operation>`. Filesystem keeps one documented legacy shape:
// `filesystem.<operation>` maps to the synthetic registry resource `root`, while
// `filesystem.project.<operation>` maps to `project`. Extra/missing segments fail.
export function capabilityAddress(mcpId: string, c: string):
  { resource: string; operation: string } | null

export function isDeferredCapability(mcpId: string, c: string): boolean {
  const address = capabilityAddress(mcpId, c)
  if (!address || !isKnownMcpId(mcpId)) return false
  const families = DEFERRED_CAPABILITY_FAMILIES[mcpId]
  // `resource` is Architect-controlled. Never use an inherited-property lookup:
  // constructor/__proto__/toString must classify unknown, not reach or throw on an
  // Object.prototype value. This mirrors catalog.ts's isKnownMcpId hardening.
  if (!Object.prototype.hasOwnProperty.call(families, address.resource)) return false
  const operations = families[address.resource]
  return operations?.includes(address.operation) ?? false
}

export function classifyCapability(mcpId: string, cap: string): McpCapabilityClass
```

`classifyCapability` applies a **total, ordered** rule set (first match wins), so
every capability lands in exactly one class and a typo can never be silently
admitted. It **normalizes once at the top** and applies only documented aliases:
`c = canonicalCapabilityForMcp(mcpId, cap)`. Outer whitespace and casing variants
such as ` GitHub.Issues.Read ` classify identically. Internal whitespace still
normalizes to `_`; it is not silently removed around separators, so malformed
`filesystem.project. read` correctly remains unrecognized.

1. `mcpId` is not a known MCP → `unknown`.
2. `c` must start with `${mcpId}.`; a cross-MCP value such as
   `classifyCapability('github','filesystem.project.write')` → `unknown`.
3. `mcpId === 'filesystem' && c === 'filesystem.project.write'` (Forge writes it via the sandbox JSON path,
   never a live tool) → `planning_only`.
4. `isDeferredCapability(mcpId,c)` returns true using an **own-property** resource
   lookup and exact allowed-operation membership → `deferred_live_mcp`.
5. `c` is in `MCP_CATALOG[mcpId].runtime.capabilities` or matches an exact pattern
   in `SAFE_READ_SUPPLEMENT[mcpId]` → `bounded_read_only`, but only after the
   startup/test invariant below has proved that the catalog safe-read set and the
   deferred registry are disjoint.
6. known MCP, matched nothing above (unrecognized resource, operation, or typo) →
   `unknown`.

`runtime.capabilities` is a **safe-read allow-list**, not a generic list of what an
MCP may eventually do. Add `assertSafeCatalogCapabilities()` beside the classifier.
It canonicalizes every catalog capability, rejects any value that matches a
deferred resource/operation pair, and rejects operations outside the closed
`read|list|search|get` vocabulary. Run it when the catalog module is loaded and in
the classifier invariant suite. This is defense in depth: deferred matching also
precedes catalog membership, so accidentally adding `github.pull_requests.write`
to the untyped catalog array cannot turn it into `bounded_read_only`.

`SAFE_READ_SUPPLEMENT` is the exact set accepted by
`SAFE_BETA_CAPABILITY_PATTERNS` but missing from the catalog, so no capability
allowed today becomes newly `unknown` (including `github.repository.read`, which
is easy to miss because `MCP_CATALOG.github` contains `repository.search` but not
`repository.read`). Deleting `SAFE_BETA_CAPABILITY_PATTERNS` therefore
moves the exact same patterns into a single documented data set — **not a behavior
change**.

**Classifier matrix (illustrative — every row is a required test case):**

| mcpId | capability | class | why |
|---|---|---|---|
| `filesystem` | `filesystem.project.read` | `bounded_read_only` | catalog safe-read (rule 4) |
| `filesystem` | `filesystem.read` | `bounded_read_only` | documented legacy alias → `filesystem.project.read` |
| `filesystem` | `filesystem.project.write` | `planning_only` | rule 3 (sandbox JSON path) |
| `filesystem` | `filesystem.write` | `deferred_live_mcp` | recognized legacy mutation, never the sandbox JSON path |
| `filesystem` | `filesystem..write` | `unknown` | malformed address; no empty resource repair |
| `filesystem` | `filesystem.project.delete` | `deferred_live_mcp` | deferred family (rule 5) |
| `github` | `github.issues.read` | `bounded_read_only` | catalog safe-read |
| `github` | `github.actions.read` | `bounded_read_only` | `SAFE_READ_SUPPLEMENT` |
| `github` | `github.repository.read` | `bounded_read_only` | preserved current beta behavior via supplement |
| `github` | `github.pull_requests.write` | `deferred_live_mcp` | deferred family |
| `github` | `github.branches.create` | `deferred_live_mcp` | deferred family |
| `github` | `github.secrets.read` | `deferred_live_mcp` | sensitive-namespace read (enumerated) |
| `github` | `github.issues.reed` (typo) | `unknown` | rule 6 → block `revise_plan` |
| `github` | `github.pull_requests.reed` (typo) | `unknown` | end-anchored family misses → rule 6 |
| `github` | `github.secrets.banana` (typo) | `unknown` | end-anchored family misses → rule 6 |
| `github` | `github.workflows.frobnicate` (typo) | `unknown` | end-anchored family misses → rule 6 |
| `github` | `github.secerts.write` (resource typo) | `unknown` | resource is not in the MCP-owned closed set |
| `github` | `github.actions.merge` (invalid pair) | `unknown` | resource and verb are each known, but the pair is not registered |
| `github` | `github.settings.approve` (invalid pair) | `unknown` | pair is not registered; no Cartesian matching |
| `github` | `github.constructor.write` (prototype key) | `unknown` | resource lookup requires an own property and never throws |
| `github` | `github.__proto__.write` (prototype key) | `unknown` | inherited keys are never registry entries |
| `github` | `filesystem.project.write` (cross-MCP) | `unknown` | namespace does not match `mcpId` |
| `slack` | `slack.messages.read` | `unknown` | rule 1 (unknown MCP) |

**Risk ≠ delivery.** A `bounded_read_only` github read is *safe* but not
*deliverable as a bounded packet* — `mcpDeliveryKind('github') ===
'planning_context_only'`, so it is admitted as planning/prompt context (recovery
`continue_as_prompt_context`); it is never offered
`approve_project_filesystem_context` and never marked `bounded_context_approved`.
Because that path consumes **no** MCP runtime (the specialist receives prose
instructions, not a live tool), it is **not health-gated** — it is instead gated on
whether prompt context was actually materialized for that MCP
(`hasPromptOnlyContext`; see decision-table step 6). A *required* github read with
no materialized prompt context is a plan defect and blocks with `revise_plan`. Only
`filesystem` bounded reads flow through the approve/deny bounded-context path.

Shared primitives (single copy each, all in `capability-normalization.ts`):
`coverageKeysForGrant(cap)` / `coverageKeysForProhibition(cap)` (one documented
alias rule for `filesystem.read|list|search` ↔ the corresponding
`filesystem.project.*` capability, per ADR 0008;
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
  phase: 'none' | 'proposed' | 'approved' | 'denied' | 'revoked' | 'not_issued'
  source: 'none' | 'package-local' | 'project-level'
  status: 'not_issued' | 'approved' | 'denied'
  grantMode?: 'allow_once' | 'always_allow'
  consumed?: boolean            // allow_once already issued -> treat as none for a retry
  coveredCapabilities: string[] // canonical filesystem.project.*
  grantApprovalId?: string
  revocationReason?: string      // set only when phase === 'revoked'
}
// `requiredCapabilities` is REQUIRED: revocation and coverage are defined relative
// to what THIS package needs. The requested capabilities live on
// `work_packages.mcpRequirements`, not in `metadata`/`mcpConfig`, so the reader
// cannot decide "current project grant no longer covers this package" without them.
export function readEffectiveGrantState(
  pkg: { metadata: unknown },
  project: { mcpConfig: unknown },
  requiredCapabilities: string[]   // canonical filesystem.project.* keys from mcpRequirements
): EffectiveGrantState
```

`readEffectiveGrantState` distinguishes never-approved (`phase:'none'|'proposed'`),
explicitly denied (`phase:'denied'`), consumed allow-once (`consumed:true`),
**revoked project grant** and insufficient coverage (`coveredCapabilities` lacks a
required capability), package-local approval (`source:'package-local'`), and
project-level approval (`source:'project-level'`). A **revoked** grant is a
`project-level` grant that previously covered the package but whose coverage was
later removed or narrowed: it returns `phase:'revoked'`, `source:'project-level'`,
with `revocationReason` set — it is **not** collapsed to `none`, so the producer
and the UI can say "project filesystem context was removed, approve it again" and
keep it distinct from a first-time request. It reads the same package
`metadata.mcpGrantPhases.effective` and `project.mcpConfig.grants.filesystem` the
current routes write; the revoked case is exactly the effective phase whose
`source === 'project-filesystem-approval'` while the current
`project.mcpConfig.grants.filesystem` no longer covers the required capabilities
(the case `packageProjectFilesystemEffectivePhase` + `requiresFilesystemGrantApproval`
handle today at `work-package-handoff.ts:869-893`).

**Coverage/revocation are evaluated against `requiredCapabilities`, not against
the grant's full breadth.** A project grant narrowed from `{read,list}` to `{read}`
must keep a package that requires **only** `read` `approved` — not `revoked` — because
its required set is still covered; a package that also requires `list` becomes
`revoked`. This is a required test: narrowing `{read,list} → {read}` with a
`{read}`-only package returns `phase:'approved'`, and the same narrowing with a
`{read,list}` package returns `phase:'revoked'` carrying `revocationReason`.

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

Let `canProceed = canProceedWithoutMcp(requirement, fallback)` — i.e. `optional`
**and** `fallback.action === 'continue_without_mcp'`. `ask_user` and `block` are
**blocking** fallbacks, so `canProceed` is `false` for them. Every "non-blocking"
branch below keys off `canProceed`, never off `requirement === 'optional'` alone,
so the fallback matrix is total across all three fallback actions.

1. **Unknown MCP** → `mode:'blocked'`, `status:'blocked'`, `recoveryAction:'revise_plan'`.
2. **Any capability class `unknown`** (known MCP, unrecognized/typo capability) →
   `mode:'blocked'`, `status:'blocked'`, `recoveryAction:'revise_plan'`.
3. **Any capability prohibited package-wide** (`normalizeCapability(cap)` ∈
   `packageProhibitedKeys`) → `mode:'blocked'`, `status:'blocked'`,
   `recoveryAction:'revise_plan'`, **unconditionally**. This is its own terminal
   outcome evaluated *before* any fallback handling: an explicit package prohibition
   is deny-wins and can **never** be downgraded to a warning by `optional` /
   `continue_without_mcp`. (Matches the current broker, where an unsafe/prohibited
   capability blocks regardless of `optional`.)
4. **Any capability class `deferred_live_mcp`** → `mode:'deferred_live_mcp'`.
   `status:'warning'` **iff `canProceed`**, else `status:'blocked'`. `recoveryAction`
   is `defer_live_mcp_feature` when warning (approvable, non-blocking) and
   `revise_plan` when blocking (so the operator can remove/regenerate the offending
   requirement rather than be stuck). "Product boundary, not broken install" copy
   applies to the `mode` either way.
5. **Any capability class `bounded_read_only` with `deliveryKind ===
   'bounded_context_packet'`** (filesystem):
   - covered by `effectiveGrant` (`phase:'approved'` & not `consumed` & covers the
     required capabilities) → `mode:'bounded_context_approved'`, `status:'allowed'`
     (subject to the health overlay, step 8).
   - `effectiveGrant.phase === 'denied'` & blocking (`!canProceed`) →
     `mode:'bounded_context_required'`, `status:'blocked'`,
     `recoveryAction:'approve_project_filesystem_context'` (**deniedRequired** — the
     handoff gate must HOLD, see S3).
   - `effectiveGrant.phase === 'revoked'` & blocking → `mode:'bounded_context_required'`,
     `status:'blocked'`, `recoveryAction:'approve_project_filesystem_context'`, and
     the `reason` carries `revocationReason` (distinct "context removed" copy, S5).
   - otherwise not covered → `mode:'bounded_context_required'`; `status:'warning'`
     iff `canProceed`, else `status:'blocked'`;
     `recoveryAction:'approve_project_filesystem_context'`.
6. **Any capability class `bounded_read_only` with `deliveryKind ===
   'planning_context_only'`** (github reads): delivered as planning context; it
   consumes no MCP runtime, so it is **not** health-gated. Gate on materialization:
   - `hasPromptOnlyContext` → `mode:'planning_only'`, `status:'allowed'`,
     `recoveryAction:'continue_as_prompt_context'`.
   - not materialized & blocking (`!canProceed`) → `mode:'blocked'`,
     `status:'blocked'`, `recoveryAction:'revise_plan'` (a required read with neither
     a producer nor prompt context is a plan defect — do not admit it).
   - not materialized & `canProceed` → `mode:'planning_only'`, `status:'warning'`,
     `recoveryAction:'continue_as_prompt_context'`.
7. **All capabilities `planning_only`, OR zero actionable capabilities:**
   - zero capabilities, **no** prompt-only context, and `!canProceed` →
     `mode:'blocked'`, `status:'blocked'`, `recoveryAction:'revise_plan'`
     (the plan under-specified access and its `required`, `ask_user`, or `block`
     fallback does not authorize continuation).
   - zero capabilities with `canProceed` (`optional` + `continue_without_mcp`) →
     `mode:'planning_only'`, `status:'warning'`,
     `recoveryAction:'continue_as_prompt_context'`.
   - otherwise → `mode:'planning_only'`, `status:'warning'`,
     `recoveryAction:'continue_as_prompt_context'`.
8. **Health overlay** (applies only to modes whose delivery consumes MCP runtime —
   `bounded_context_approved` and any future live path — and only when the mode
   chosen above is `allowed`; **planning-context and planning-only modes are never
   health-gated**): if `!isMcpHealthy(status)` and `!canProceed` →
   `status:'blocked'`, `recoveryAction:'install_or_fix_mcp'` (retryable). If
   `canProceed` → `status:'warning'`, `recoveryAction:'install_or_fix_mcp'`
   (the package may continue without context, but the warning remains actionable).

`recoveryAction` replaces the fragile `isRetryableMcpBrokerBlock` string-matching:
a block is **retryable iff its `recoveryAction === 'install_or_fix_mcp'`**.

### Layer 3 — the package-level canonical evaluation (deny-wins + subtasks)

The single evaluation every surface consumes. It unions prohibitions across the
whole package (deny-wins) *before* admitting any requirement, and validates
MCP-aware subtasks against the normalized approved coverage — preserving the
current broker's package-wide prohibition removal and subtask checks
(`evaluateWorkPackageMcpBroker`, `mcp-execution-design.ts:617-631,697-721`).

#### Layer 3a — canonical entry join (one evaluation per logical requirement)

`brokerEntries()` concatenates two representations of the *same* logical
requirement: raw `work_packages.mcpRequirements` (Architect-requested policy:
`requirement`, capability fields, `fallback`, `prohibitedCapabilities`) and derived
`metadata.mcpGrants` (the persisted preview decision: `decisionId`,
`sourceRequirementIndex`, `assignment`, `health`, `promptOverlayPresent`, status).
Admitting both independently would double-count decisions, warnings, and summary
counts, and could not populate the `source` envelope reliably.

Before admission, `admitWorkPackageMcp` **joins** entries on one **immutable
`requirementKey`** persisted on *both* representations. `(agent, mcpId)` is
**not** a safe join key: one agent can hold two requirements for the same MCP with
different `prohibitedCapabilities`/`fallback`, and joining on `(agent, mcpId)` would
collapse them — silently dropping one entry's prohibition or fallback. So both
sides must carry a stable per-requirement identity:

- **`normalizeDesign`** assigns `requirementKey` once and persists it in the
  proposed design before preview/materialization. The key is a versioned digest of
  the canonical policy fields (`mcpId`, requirement level, assignment, sorted
  per-agent permissions, sorted prohibitions, and `fallback.action`) plus an
  occurrence counter for exact duplicates. It excludes prose reason/message copy,
  is stable across harmless array/object reordering, and changes when policy changes.
  The Architect is not trusted to supply this identity.
- **`mcpRequirementsForAgent`** (materializer, `workforce-materializer.ts`) persists
  that `requirementKey` and retains the original requirement index + `agent` on each
  `work_packages.mcpRequirements` entry;
- **`mcpGrantsForAgent`** persists the **same** `requirementKey` alongside
  `sourceRequirementIndex`, `agent`, `assignment`, and `promptOverlayPresent` on each
  `metadata.mcpGrants` entry (see the schema-bump rows in the consolidation map).

Prompt context needs the same identity. The Architect fence therefore adds
`requirementContexts: Array<{ sourceRequirementIndex: number; agent: string;
promptOverlay: string }>`; the index addresses the raw requirement in that fence
only. During `normalizeDesign`, Forge validates the index and agent assignment,
then replaces the positional reference with the generated `requirementKey` before
the design is persisted or materialized. The persisted normalized entry is
`{requirementKey, agent, mcpId, promptOverlay}`. `metadata.promptOverlay` remains a
package-level rendering assembled from those entries for executor compatibility,
but it is **not** evidence that every same-agent requirement has context.
`promptOverlayPresent` is computed separately for each grant by exact
`requirementKey` membership. `mcpAwareSubtasks` likewise persists the matching
`requirementKey` for every capability-bearing subtask; an ambiguous subtask that
could match more than one same-agent/same-MCP requirement fails closed with
`revise_plan` until the Architect supplies `sourceRequirementIndex`.

For a legacy fence that has only `promptOverlays: Record<agent,string>`, the
adapter may associate that overlay only when the agent has exactly one
planning-context requirement. With zero or multiple candidates it records a
compatibility warning and materializes none; it must never mark all candidates
present. This makes the required “two same-agent/same-MCP requirements, only one
has context” fixture representable and prevents a generic agent overlay from
authorizing an unrelated requirement.

The join therefore keys on `requirementKey`, and merges with fixed precedence:

- **requested policy** (`requirement`, merged capability fields via
  `mergeCapabilityFields`, `fallback`, `prohibitedCapabilities`) comes from
  `mcpRequirements`;
- **source envelope + persisted health** (`decisionId`, `sourceRequirementIndex`,
  `assignment`, `promptOverlayPresent`, `health`) comes from `metadata.mcpGrants`;
- if only one side is present, its own fields are used and the missing envelope is
  synthesized deterministically (`decisionId = 'req-{requirementKey}'`).

For **pre-migration legacy artifacts** that lack `requirementKey`, the raw
`mcpRequirements` array remains the admission source of truth; derived `mcpGrants`
is envelope data and must never become a second policy decision. Pair a raw entry
with at most one derived grant by this compatibility order:

1. `(sourceRequirementIndex, agent, mcpId)` when both sides contain it;
2. otherwise a strict legacy fingerprint
   `(per-representation occurrence, mcpId, requirement, normalizedCapabilities,
   fallback.action)`, which matches today's two materializer arrays without using
   the unsafe `(agent,mcpId)` key;
3. an unmatched raw entry is admitted once with a deterministic synthesized
   envelope; an unmatched derived grant is **never admitted as policy**. Record a
   compatibility warning and render its stale preview state as `unknown_legacy`.
   A grant-only artifact has no authoritative `prohibitedCapabilities`/requested
   policy snapshot, so it fails closed as `mode:'unknown_legacy'`,
   `status:'blocked'`, `recoveryAction:'revise_plan'` and requires recomputation; a
   previously blocked derived grant can never be re-evaluated into an allow.

This makes the current persisted shape safe without a database backfill and
preserves **exactly one `admitMcpRequirement` call per logical requirement**. Tests
use a fixture copied from today's `mcpRequirementsForAgent` + `mcpGrantsForAgent`
output and assert no duplicate decisions/warnings. They also cover **two same-agent /
same-MCP requirements carrying different prohibitions and fallbacks**, which must
produce two distinct decisions with neither prohibition nor fallback lost, plus a
grant-only legacy fixture whose old blocked status must remain fail-closed.

**Preview parity of deny-wins scope.** The design-stage adapter
(`deriveMcpGrantDecisions` / `validateMcpExecutionDesign`) must partition the
`McpExecutionDesign` requirements into the **same per-agent package units** that
materialization later persists (`agentsForRequirement`, one package per agent)
*before* computing `packageProhibitedKeys`. Otherwise preview would union
prohibitions across all agents while handoff unions them per package, and the two
would disagree. Each agent-package is admitted independently in both preview and
handoff.

```ts
// Versioned per-MCP health OBSERVATION. `statusFor(mcpId)` returns
// `ProjectMcpStatus | null`, and unknown/unconfigured MCPs (decision-table steps 1
// and the unhealthy branches) have NO row — so health must be able to say
// "unavailable" without inventing a snapshot. This is a discriminated union:
//   - observed:true  → a real ProjectMcpStatus row was read; `checkedAt` is that
//     row's timestamp, sourced verbatim (required so a decision can be replayed
//     after cached rows change).
//   - observed:false → no row existed at decision time; `checkedAt` is `null`, an
//     EXPLICIT "unavailable" — never a synthetic/now() timestamp. Replay parity for
//     these cases depends on the *absence*, not on an invented time.
// Approval persists only what it actually observed (each entry keeps its own
// `observed` discriminant); it never fabricates a snapshot for an absent row.
export type McpHealthSnapshot =
  | { schemaVersion: 1; observed: true; mcpId: string; installState: string;
      status: string; enabled: boolean; error: string | null; checkedAt: string }
  | { schemaVersion: 1; observed: false; mcpId: string; installState: 'unknown';
      status: 'unknown'; enabled: false; error: null; checkedAt: null }

The unavailable arm deliberately retains the four legacy preview-health fields.
`admissionToGrantPreview` therefore extends the existing JSON with
`schemaVersion`/`observed`/`mcpId`/`checkedAt`; it never removes fields that
`McpGrantDecisions.health` and `execution-design-metadata.ts` already require.

export type McpAdmissionEvaluation = {
  decision: McpAdmissionDecision
  source: {                                   // retained so adapters are shape-preserving
    requirementKey: string                    // the immutable join key (Layer 3a); makes the evaluation self-describing and the one-per-requirement join testable
    decisionId: string
    sourceRequirementIndex: number
    assignment: { type: McpAssignmentType; targetId: string | null }
    fallback: { action: McpFallbackAction; message: string }
    promptOverlayPresent: boolean
  }
  health: McpHealthSnapshot
}

export type McpWorkPackageAdmission = {
  schemaVersion: 2
  evaluations: McpAdmissionEvaluation[]
  subtaskDecisions: Array<{ subtaskId: string; agent: string; mcpId: string; capability: string;
    class: McpCapabilityClass; status: McpAdmissionStatus; reason: string; recoveryAction?: McpRecoveryAction }>
  referencedHealth: McpExecutionValidation['health']   // aggregate health array validation needs
  aggregate: {
    status: 'allowed' | 'warning' | 'blocked'   // singular `warning`; the broker adapter maps it to plural `warnings`
    blocked: string[]
    warnings: string[]
    blockedReason: string | null
    retryable: boolean                          // blocked decisions exist AND every one is install_or_fix_mcp; false when nothing is blocked
    // `primaryMode`/`primaryRecoveryAction` are BOTH taken from the single decision
    // selected by the recovery-action precedence below, so a mixed package has a
    // deterministic mode+action pair (not an ad-hoc singular `mode`):
    //   revise_plan > approve_project_filesystem_context > install_or_fix_mcp > defer_live_mcp_feature
    primaryMode?: McpAdmissionMode               // mode of the precedence-selected blocking decision
    primaryRecoveryAction?: McpRecoveryAction    // recoveryAction of that same decision
  }
}

export function admitWorkPackageMcp(input: {
  entries: Array<Record<string, unknown>>       // brokerEntries(): mcpRequirements ∪ metadata.mcpGrants
  subtasks: Array<Record<string, unknown>>      // metadata.mcpAwareSubtasks; each carries `id` + `agent` + flat `mcpCapabilities[]`; MCP identity is derived per capability
  label: string
  statusFor: (mcpId: string) => ProjectMcpStatus | null   // may return null (unconfigured/unknown MCP)
  effectiveGrantFor: (entry: { requirementKey: string; mcpId: string; requiredCapabilities: string[] }) => EffectiveGrantState
  hasPromptOnlyContextFor: (entry: { requirementKey: string; agent: string; mcpId: string }) => boolean
}): McpWorkPackageAdmission
```

`admitWorkPackageMcp`: (1) **join** raw entries per Layer 3a into one canonical
entry per logical requirement (keyed on the immutable `requirementKey`). For each
entry, compute `EffectiveGrantState` against **that entry's** bounded required
capabilities—not a package-wide same-MCP union—so a covered required read stays
approved when a separate optional list is uncovered. Compute prompt-context
materialization for that `requirementKey` + agent + MCP (using its persisted
`promptOverlayPresent` and matching subtasks), never as one package-wide MCP boolean;
(2) validate every `prohibitedCapabilities` value against its declaring entry's
`mcpId` using the same canonicalizer/classifier. An unknown, malformed, or
cross-MCP prohibition blocks the package with `revise_plan`; it must never become
an inert deny rule that gives the operator false assurance. Then build
`packageProhibitedKeys` = union of `coverageKeysForProhibition` over the validated
prohibitions; (3) `admitMcpRequirement` per joined entry with that set — a capability
prohibited anywhere is a package-wide policy denial and blocks unconditionally
(deny-wins, decision-table step 3), never approved; (4) accumulate **two** coverage
sets, both minus the prohibition set:
  - `boundedCoverageKeys` — canonical capability keys only from decisions with
    `mode:'bounded_context_approved'` **and `status:'allowed'` after the health
    overlay** (an unhealthy optional warning did not deliver a packet and grants no
    subtask coverage);
  - `planningContextCoverageKeys` — canonical `(agent, capability)` keys from
    planning-context decisions only when `status:'allowed'` and the matching
    requirement's prompt context was actually materialized (a missing-context
    optional warning grants no subtask coverage);
(5) produce a **total** per-subtask decision. `mcpSubtasksForAgent` retains the
existing subtask `id`, `agent`, and flat `mcpCapabilities[]`; a single subtask may
refer to more than one MCP, so it does **not** gain one ambiguous `mcpId` field.
For each capability, derive `mcpId` from its normalized first namespace segment
(`capabilityMcpId`, moved into the shared module). If it is not a known MCP, record
`class:'unknown'`, `deliveryKind:null`, and block before delivery lookup. Otherwise
call `classifyCapability(derivedMcpId, capability)` and
`mcpDeliveryKind(derivedMcpId)`. Before
any class-specific branch, compare `coverageKeysForProhibition(capability)` with
`packageProhibitedKeys`; a match is `blocked` + `revise_plan` unconditionally.
This preserves package-wide deny-wins even for a `planning_only` subtask. Every
remaining capability class has a defined outcome (no branch falls through):
  - unknown MCP or class `unknown` → `blocked`, `revise_plan`;
  - class `deferred_live_mcp` → `blocked`, `revise_plan`;
  - class `planning_only` (e.g. a `filesystem.project.write` subtask hint) →
    `allowed`, **no coverage required** — it is a planning-only instruction, never a
    grant, so it is admitted without appearing in either coverage set;
  - class `bounded_read_only`, `deliveryKind === 'bounded_context_packet'` → must be
    in `boundedCoverageKeys`, else `blocked`, `approve_project_filesystem_context`;
  - class `bounded_read_only`, `deliveryKind === 'planning_context_only'` → must be
    in `planningContextCoverageKeys` **for the same agent** (so a safe `github.*.read`
    subtask is accepted when its matching requirement was admitted as planning
    context, instead of being rejected for lacking a bounded grant), else `blocked`,
    `revise_plan`.

  Each result is recorded in `subtaskDecisions` with the subtask `id`, `agent`, and
  the MCP id derived for that capability. Tests cover one multi-MCP subtask, a
  planning-only subtask, a prohibited planning-only subtask (must block), and a
  same-agent planning-context subtask.
  (6) fold everything into `aggregate`. This is the canonical evaluation consumed by
preview, approval, and handoff.

### Adapters (shape-preserving, over the evaluation, not bare decisions)

Co-located in `web/lib/mcps/admission.ts`. They take the whole
`McpWorkPackageAdmission` (which retains `source` + `health`), so persisted JSON
and existing readers do not change shape — they are only *extended*:

- `admissionToValidation(admission): McpExecutionValidation` — uses
  `referencedHealth` for the aggregate health array.
- `admissionToGrantPreview(admission): McpGrantDecisions` — keeps `requirementKey`,
  `decisionId`, `sourceRequirementIndex`, assignment, fallback, raw `health`,
  `promptOverlayPresent`; **adds** `mode`, `recoveryAction`,
  `normalizedCapabilities`, `capabilityClasses`, `evidenceRefs`, and a canonical
  `admissionStatus: McpAdmissionStatus` (`allowed | warning | blocked`).
  **Status compatibility.** The legacy `McpGrantDecisions.status`
  (`proposed | warning | blocked`) is preserved by the total map
  `allowed → proposed`, `warning → warning`, `blocked → blocked`, so existing
  readers and persisted JSON keep their shape. Literal cross-surface parity is
  asserted on the canonical pair (`mode`, `admissionStatus`) — **not** on the legacy
  `status` string, which stays `proposed`-spelled for the preview surface only.
  `summary` counts are computed from the legacy `status` exactly as today.
- `admissionToBrokerCheck(admission): WorkPackageMcpBrokerCheck` — **status
  compatibility**: the existing `WorkPackageMcpBrokerCheck.status` is
  `allowed | blocked | warnings` (plural), so this adapter maps the canonical
  `aggregate.status` with the total map `allowed → allowed`, `warning → warnings`,
  `blocked → blocked`, preserving the broker's JSON shape. It also carries
  `retryable`, `primaryMode`, and `primaryRecoveryAction` (the deterministic
  precedence-selected pair — the broker keeps per-decision modes via
  `evaluations[]`; the singular `primaryMode` exists only for the block-metadata
  writer below).

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
| `SAFE_BETA_CAPABILITY_PATTERNS` (`:7-18`) | S1 keeps the existing `Record<string, RegExp[]>` API through an explicit compatibility export built from the catalog safe reads + `SAFE_READ_SUPPLEMENT` (same `.test()` behavior; not a direct supplement-only re-export). S2 deletes it only after every caller migrates | S1 compatibility / S2 delete |
| `requiresFilesystemGrantApproval` / `summarizeFilesystemCapabilities` (`filesystem-grants.ts:303/90`) | S2 makes both the filesystem-specific **projection** of `admitWorkPackageMcp`, imports shared normalization/reader policy, and keeps the nominal/persistence types. S3 owns only the new denied/revoked held-state and reconciliation behavior after that projection exists | S2 projection / S3 recovery behavior |
| `readEffectiveGrantState` (`EffectiveGrantState` reader) | **canonical home is `web/lib/mcps/admission.ts` (Layer 1), created and owned by S1.** S3's `filesystem-grants.ts` imports it (or transitional-re-exports it for existing callers); there is exactly one implementation of this policy | S1 own / S3 import |
| `isRetryableMcpBrokerBlock` (`:90`) + `buildMcpBrokerBlockMetadata` (`blocked-handoff-retry.ts:32`) | consume `aggregate.retryable`/`primaryRecoveryAction`; **persist the full versioned `metadata.mcpBroker` here**; S5 reads it only | S2 |
| `normalizeDesign` + `mcpRequirementsForAgent` | `normalizeDesign` assigns/persists a versioned canonical-payload digest `requirementKey` (with duplicate occurrence suffix; not an Architect-supplied key or bare array index), converts validated `requirementContexts[].sourceRequirementIndex` references to that key, and fails closed on ambiguous legacy agent overlays. The materializer preserves the key plus source index and `agent`, so Layer 3a can join collision-safely across reorderings | S2 |
| `mcpGrantsForAgent` (`workforce-materializer.ts:157`) | persists the matching `requirementKey`, `sourceRequirementIndex`, `agent`, `assignment`, `promptOverlayPresent`, plus `mode`, `recoveryAction`, `normalizedCapabilities`, `evidenceRefs` on each grant (schema bump) — not just id/mcp/caps/requirement/status/reason/fallback/health | S2 |
| `mcpSubtasksForAgent` (`workforce-materializer.ts`) | retains the existing `id`, `agent`, and flat `mcpCapabilities[]`, plus the normalized `requirementKey`, on each persisted `metadata.mcpAwareSubtasks` entry (currently `agent` is stripped). Shared `capabilityMcpId` derives the MCP independently for each capability, so one subtask can safely span several MCPs without a synthetic singleton `mcpId`; ambiguous same-MCP association blocks | S2 |
| `mcpCapabilityList` (`work-package-executor.ts:1527`) | imports `mergeCapabilityFields`; executor filesystem gating uses shared `coverageKeysForGrant`/`classifyCapability` | S4 |
| client helpers (`tasks/[id]/page.tsx:348-444`) | import shared helpers OR consume a server-computed grant-state payload; render `mode`+`recoveryAction` via `admission-copy.ts` | S5 |

## Implementation slices

Dependency order: **S1 → S2 → {S3, S4} → S5 → S6.** S3 and S4 both depend on S2's
canonical evaluation + persisted shape. **S5 depends on S4** (it renders the
run-evidence schema S4 defines) and on S2. S6 depends on S2–S5.

### S1 — Contract and terminology

- Create `web/lib/mcps/capability-normalization.ts` (Layer 0 primitives,
  `classifyCapability`, `mcpDeliveryKind`, `SAFE_READ_SUPPLEMENT`) and
  `web/lib/mcps/admission.ts` (Layers 1–3 + adapters). **`admission.ts` is the
  single canonical home of `readEffectiveGrantState` (Layer 1).** S3's
  `filesystem-grants.ts` must import it, never re-implement it — the whole point of
  this ADR is one policy, one reader.
- Keep `SAFE_BETA_CAPABILITY_PATTERNS` as a transitional **compatibility export**
  with its existing `Record<string, RegExp[]>` shape and full behavior. Build it
  from exact regexes for catalog safe reads plus `SAFE_READ_SUPPLEMENT`; callers
  continue using `.test()` unchanged. A direct supplement-only re-export is
  forbidden because it would drop catalog-backed filesystem/GitHub reads before
  S2 migrates those callers.
- Write this ADR (done) and align roadmap/task-detail copy on the three-way
  terminology.
- **No deletions of live-referenced symbols in S1.**

### S2 — Broker consolidation and approval enforcement

- Migrate the paths per the consolidation map. Delete duplicated helpers only
  after their callers import the shared modules.
- In S2, make `requiresFilesystemGrantApproval` and
  `summarizeFilesystemCapabilities` the filesystem projection of the canonical
  package admission. S3 builds denied/revoked held-state recovery on that projection;
  it does not own a second policy migration.
- **Enforce admission at approval.** In `web/app/api/tasks/[id]/approve/route.ts`:
  acquire the MCP health snapshot via `getProjectMcpOverview(project)` **before**
  and **outside** the status-flip `db.transaction` (it performs live checks and
  writes cached `ProjectMcpStatus` rows — it must not run inside the transaction
  that flips the task to `approved`). Run `admitWorkPackageMcp` over every package
  using that snapshot; if any `aggregate.status === 'blocked'`, return the same
  409 shape as the existing `missingFilesystemGrant` early return (`:199-209,280`)
  with the normalized `reason` + `primaryRecoveryAction`. **Persist the exact
  health snapshot** the approval decision consumed — a versioned
  `approvalHealthSnapshot: McpHealthSnapshot[]` on the plan-approval gate metadata,
  next to the existing `approvedGrantSnapshot` (`:221-263`). Persist the exact
  observation result: an MCP whose `statusFor` returned a row is stored
  `observed:true` with that row's `checkedAt`; an MCP with no row is stored
  `observed:false`, the legacy unknown health fields, and `checkedAt:null` — an
  explicit unavailable, never a synthesized `now()`. A single
  ambiguous timestamp cannot replay the decision after cached `ProjectMcpStatus`
  rows change; the per-MCP `checkedAt` (or explicit `null`) is required. Add an
  assertion that the persisted snapshot equals the health inputs passed to
  `admitWorkPackageMcp` — including that absent-row MCPs round-trip as
  `observed:false`, not as an invented snapshot.
- **Broker-block persistence is owned entirely by S2.** The complete, versioned
  `metadata.mcpBroker` producer lives here: `buildMcpBrokerBlockMetadata`
  (`blocked-handoff-retry.ts:32`) persists `{schemaVersion, status:'blocked',
  blocked, warnings, blockedReason, mode, recoveryAction, retryable,
  primaryRecoveryAction, autoRetryAttempts, nextAutoRetryAt}` from `aggregate`
  (`retryable = aggregate.retryable`, `mode = aggregate.primaryMode`,
  `recoveryAction = aggregate.primaryRecoveryAction`). The singular `mode`/
  `recoveryAction` are the precedence-selected pair defined on `aggregate`, so a
  mixed-block package persists a deterministic mode — not an arbitrary one. This
  makes retry/recovery
  (`shouldAutoRetryBlockedHandoff` and the sweep) fully deployable **before** the UI
  slice; S5 only *reads* `metadata.mcpBroker`.
- **Parity guarantee (narrowed).** For a fixed package and a *fixed health
  snapshot*, `deriveMcpGrantDecisions` (preview), the approval check, and
  `evaluateWorkPackageMcpBroker` (handoff) return the same `mode`/`admissionStatus`
  (the canonical pair; the preview's legacy `status` maps `allowed → proposed`)
  because they call one producer. MCP health/config can change between approval and
  handoff, so the promise is: **a block already visible in the approval-time
  snapshot is surfaced at approval, not missed until handoff** — not that an
  approved task can never block later.
- **Invariant tests** (`web/__tests__/mcp-admission-invariant.test.ts`): preview,
  approval, and handoff agree on the canonical (`mode`, `admissionStatus`) pair for
  zero-capability requirements across all three fallback actions (only
  `optional` + `continue_without_mcp` may warn), prompt-only context,
  filesystem read/list/search,
  `filesystem.project.write`, an unsafe/deferred GitHub write, a **package-wide
  prohibition on an `optional`+`continue_without_mcp` requirement (must stay
  `blocked`, never downgraded to a warning)**, a healthy GitHub read
  (planning-context, not bounded), a **required GitHub read with no materialized
  prompt context (blocks `revise_plan`)**, an unknown MCP, a **known-MCP typo
  operation/resource/invalid pair (`github.issues.reed`, `github.pull_requests.reed`,
  `github.secrets.banana`, `github.workflows.frobnicate`, and
  `github.secerts.write`, `github.actions.merge`, `github.settings.approve` — every one must classify `unknown` and block
  `revise_plan`, never `deferred_live_mcp`)**, cross-MCP namespace mismatches,
  prototype-key resources (`github.constructor.write`, `github.__proto__.write`,
  `github.toString.write`) as both requests and prohibitions (unknown/block without
  throwing),
  all qualified/unqualified filesystem `read|list|search` alias pairs, a
  catalog-safety invariant (catalog operations are closed safe-read verbs and
  cannot overlap the deferred registry; an injected
  `github.pull_requests.write` catalog entry is rejected rather than admitted), a
  package-wide prohibition that must beat a
  per-entry approval, MCP-aware subtasks (a bounded filesystem subtask, a
  planning-context `github.*.read` subtask matched to its same-agent requirement, and
  a **`planning_only` subtask (`filesystem.project.write`) admitted without
  coverage unless prohibited package-wide**, a prohibited planning-only subtask,
  and one subtask containing capabilities from two MCPs), a requirement expressed via each of the
  four capability fields, and **all three fallback actions (`continue_without_mcp`,
  `ask_user`, `block`) across deferred, unhealthy bounded-context, and missing
  bounded-context cases** (asserting `ask_user`/`block` never become non-blocking).
  Also assert **one `admitMcpRequirement` call per logical requirement** after the
  Layer 3a join, including **two same-agent/same-MCP requirements with different
  prohibitions and fallbacks** (they must stay two decisions, neither collapsed nor
  losing its prohibition/fallback), and that an **absent-row MCP** round-trips
  through `approvalHealthSnapshot` as `observed:false` with the legacy unknown
  fields intact (no synthesized timestamp). Use today's raw + derived package JSON
  as a legacy join fixture and assert no duplicate decisions/warnings/blocks.
  Add a grant-only legacy fixture (must block `unknown_legacy`), two same-agent /
  same-MCP requirements where only one has a normalized, requirement-indexed
  context entry (the other must block), an ambiguous legacy agent-only overlay
  (materializes neither requirement), and mixed filesystem requirements where covered required `read`
  remains approved while uncovered optional `list` warns. A typoed/cross-MCP
  prohibition must block. Also assert that optional missing-prompt and optional
  unhealthy-bounded warnings create **no** subtask coverage.
  `requiresFilesystemGrantApproval` is tested only as the *filesystem projection* of
  the same evaluation.

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
- **One lock order and no whole-JSON lost updates.** Both grant endpoints begin the
  transaction by selecting the project row `FOR UPDATE`, then derive `nextMcpConfig`
  from that locked, freshly read value. They must not compute a full replacement
  from the project object fetched for authorization before the transaction. The
  reconciliation routine then selects candidate work packages `FOR UPDATE` in
  ascending `work_packages.id` order. All callers use the same project-then-package
  lock order. Package updates use `jsonb_set`/`#-` only for the owned
  `mcpGrantPhases` and `mcpGrantBlock` paths (or an `updatedAt` compare-and-set and
  retry); they never replace `metadata` from a stale JavaScript spread. This
  preserves concurrent broker, lease, audit, and evidence fields. Add two
  concurrency tests: disjoint simultaneous `always_allow` grants retain the union
  plus unrelated `mcpConfig` keys, and a simultaneous broker metadata update
  survives reconciliation.
- **Reuse the S1 reader — do not re-implement.** `filesystem-grants.ts` **imports**
  `readEffectiveGrantState` from `admission.ts` (S1 owns it); S3 adds no second
  copy. S3's job is to pass the required-capability set and the recovery/precedence
  behavior *through* that one reader, and to make `requiresFilesystemGrantApproval`
  a projection over it.
- **Precedence.** A later project-level `always_allow` grant covering a capability
  supersedes an earlier package-local `denied` effective phase for that capability
  (operator's later, broader decision wins). Document and test this precedence in
  the S1-owned `readEffectiveGrantState` (evaluated against the package's
  `requiredCapabilities`).
- **Revoked project grant is distinct from never-approved.** When
  `readEffectiveGrantState` returns `phase:'revoked'` (a project grant that
  previously covered the package no longer does), the held-block `reason` and the S5
  copy say "project filesystem context was removed — approve it again", carrying
  `revocationReason`, separate from the first-time "needs project context" copy.
  Test the two recovery messages separately; a revoked grant must not read as a
  brand-new request.
- **Acceptance tests assert exact transitions** (package `pending/ready →
  blocked`, task not `failed`, zero new `agentRuns`; then grant approval →
  package `ready`, task re-driven), not just attempt counts.
- Preserve: a filesystem block is never auto-retried
  (`shouldAutoRetryBlockedHandoff`, `blocked-handoff-retry.ts:67-79`).

### S4 — Prompt/context assembly and bounded-context packet evidence (builds on #43)

- Specialist prompts receive the admitted `promptOverlay` + `mcpAwareSubtasks` +
  safe/planning `mcpRequirements` subset as **instructions**, never as tool grants (executor prompt
  assembly around `work-package-executor.ts:1527-1583`). No live MCP handle is
  ever issued.
- **Security boundary: MCP-channel admission is not an ACP sandbox.** An Agent
  Client Protocol (ACP) adapter is a local process and Forge explicitly does not
  OS-confine it (`FORGE_ACP_WORK_PACKAGE_EXECUTION=1` is operator acceptance of
  that risk). It may inherit `HOME`, `CODEX_HOME`, `PATH`, and XDG configuration,
  and prompt instructions cannot prevent shell, network, or credential access.
  Therefore `deferred_live_mcp`, “no live MCP handle”, and the S5 badges describe
  only capabilities issued through Forge's MCP channel; they must not claim that
  the worker is unable to perform an equivalent operation by another runtime
  tool. S4 strips deferred/unknown capability details from the executable MCP
  instruction block (retaining only a plain boundary warning), and S5 displays
  “MCP access deferred — ACP runtimes are not a security sandbox” wherever ACP
  execution is enabled. Real process/network/credential/filesystem isolation is a
  prerequisite of any later security-bound capability guarantee and remains in
  the #40/#60 security epic. Tests prove that no deferred tool is issued or
  rendered as an allowed MCP instruction; they do not mislabel prompt compliance
  as OS-level enforcement.
- **Evidence lifecycle — planned scope vs issued evidence.** Pre-run,
  `McpAdmissionDecision.evidenceRefs` carries only *planned scope* (root path +
  capability set), never file contents. The bounded read-only context packet is
  assembled during execution and requires an `agentRunId`; after the run (including
  **failed** runs) insert exactly one idempotent `artifacts` row for the attempt:
  `artifactType:'mcp_bounded_context_packet_metadata'`, linked by
  `artifacts.agentRunId`, with `content` containing the versioned, human-readable
  metadata summary and `metadata` containing `{schemaVersion:1, workPackageId,
  root, selectedFileNames, includedCount, omittedCount, redactionSummary}`.
  `(agentRunId, artifactType)` is the stable lookup contract; retry/upsert behavior
  must not create duplicates for one run. S5 queries this artifact relationship
  directly—no `agent_runs` metadata column or migration is introduced. The artifact
  contains packet **metadata** only (root, selected file names, included/omitted counts,
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
  - `deferred_live_mcp` → **neutral slate** "Deferred — MCP boundary", body "Forge
    did not issue this MCP capability. This is not a broken install. ACP workers
    are local processes and are not security-sandboxed by this MCP decision."
    **When it is a *required* (blocking) deferred requirement, it
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
- **Reads the versioned persisted schema (produced by S2) — S5 persists nothing.**
  S5 does not compute or persist admission state. It reads the `grantDecisions`
  preview (`mode`, `recoveryAction`, `admissionStatus`, `normalizedCapabilities`,
  `capabilityClasses`, `evidenceRefs`) and the per-package `metadata.mcpBroker`
  block (`{mode, recoveryAction, retryable, primaryRecoveryAction, blocked,
  warnings}`; `work_packages.blocked_reason` stays the human text) that S2 wrote,
  and renders them. `RetryHandoffControls` is gated on the persisted
  `metadata.mcpBroker.retryable`; the single CTA is driven by
  `primaryRecoveryAction` (precedence `revise_plan >
  approve_project_filesystem_context > install_or_fix_mcp > defer_live_mcp_feature`).
  Because the producer/persistence contract lives in S2, retry/recovery is
  deployable before this UI slice ships.

### S6 — End-to-end regression

- `web/__tests__` (or `web/e2e`) regression for a local-only tiny task-tracker
  project: Architect creates frontend/QA/docs/review packages; the MCP plan
  includes prompt-only context and no live tool handles; approval succeeds and
  handoff advances ready packages. Split filesystem coverage into two explicit
  scenarios: (A) a task missing required filesystem context is rejected by the
  **real approval route** with 409 and never reaches handoff; (B) a task approved
  while covered then loses/narrows that grant before handoff (or a pre-existing
  approved legacy fixture) and is held `blocked` pre-claim with zero attempts, task
  not failed. Restoring coverage re-drives it. A deferred GitHub-write capability
  is reported as `deferred_live_mcp`, not an install error; a healthy GitHub read
  is planning context, not an approvable bounded packet. The regression also
  verifies requirement-indexed context (two same-agent/same-MCP requirements,
  exactly one materialized), catalog/deferred disjointness, lock-safe concurrent
  grant union, preservation of concurrent package metadata, one packet-metadata
  artifact per run on success/failure, and that deferred/unknown capabilities are
  absent from the executable MCP instruction block. ACP copy explicitly preserves
  the non-sandbox warning.
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

**Health-gating is limited to runtime-consuming delivery modes.** #43's original
"validate installation/health/auth; an unhealthy required MCP blocks" acceptance
criteria must be scoped to `deliveryKind === 'bounded_context_packet'` (and any
future live path) only. A `planning_context_only` read (github) consumes no MCP
runtime — the specialist receives prose instructions, not a live tool — so it is
**never** health-gated; it is gated on prompt-context materialization
(`hasPromptOnlyContext`) instead (decision-table steps 6 and 8). This keeps S1/#43
from reintroducing the preview/handoff divergence by health-gating a path that runs
no MCP. #43's body carries the same qualification.

## Consequences

- Preview, approval, handoff, filesystem recovery, and UI copy are structurally
  incapable of disagreeing for a fixed health snapshot, because they consume one
  evaluation built by one producer over one set of primitives sourced from one
  catalog. The filesystem gate is a tested projection of that evaluation.
- `deferred_live_mcp` is a first-class, named MCP-channel mode with an operator
  action, so blocks show a path forward instead of a broken install without
  misrepresenting an ACP local process as security-confined.
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
