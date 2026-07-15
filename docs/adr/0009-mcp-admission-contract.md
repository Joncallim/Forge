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
   retains the raw text only in ACL-protected, append-only versioned Architect plan
   entries under a non-text artifact header. Runtime packages record normalized policy/bindings and eligible
   projection references, not raw `promptOverlay`, `requirementContexts`, or
   `mcpAwareSubtasks` text. It grants nothing.
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
| 3 | `evaluateWorkPackageMcpBroker` | `mcp-execution-design.ts` · 599 | persisted normalized `workPackages.mcpRequirements` + `metadata.mcpGrants` + subtask bindings/projection refs | handoff-time broker |
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
export type FilesystemGrantRevocationReason =
  | 'project_grant_removed'
  | 'project_grant_narrowed'
  | 'project_root_repoint'

export type EffectiveGrantState = {
  phase: 'none' | 'proposed' | 'approved' | 'denied' | 'revoked' | 'not_issued'
  source: 'none' | 'package-local' | 'project-level'
  status: 'not_issued' | 'approved' | 'denied'
  grantMode?: 'allow_once' | 'always_allow'
  consumed?: boolean            // allow_once already issued -> treat as none for a retry
  coveredCapabilities: string[] // canonical filesystem.project.*
  grantApprovalId?: string
  revocationReason?: FilesystemGrantRevocationReason // set only when phase === 'revoked'
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
  grantState?: {
    phase: EffectiveGrantState['phase']
    consumed?: boolean
    revocationReason?: FilesystemGrantRevocationReason
  }                         // present for bounded filesystem decisions; structured UI discriminator
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
3. **Any capability prohibited package-wide** (`coverageKeysForProhibition(cap)`
   intersects `packageProhibitedKeys`, the same alias-aware test used for subtasks)
   → `mode:'blocked'`, `status:'blocked'`,
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
     `recoveryAction:'approve_project_filesystem_context'` (**denied-required hold** — the
     handoff gate must HOLD, see S3).
   - `effectiveGrant.phase === 'revoked'` & blocking → `mode:'bounded_context_required'`,
     `status:'blocked'`, `recoveryAction:'approve_project_filesystem_context'`, and
     `grantState:{phase:'revoked',revocationReason}` is persisted (distinct
     "context removed" copy, S5). First-time and denied branches likewise persist
     `grantState.phase`; an approved but consumed one-time grant persists
     `{phase:'approved',consumed:true}` and follows the uncovered branch. Human
     `reason` remains explanatory text, not a UI discriminator.
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

Prompt context needs the same identity, but raw Architect text has exactly one
durable home: append-only `architect_plan_entries` attached to a versioned,
non-text Architect artifact header. The artifact `content` is fixed safe copy and
its metadata contains only version/count/digest fields. `architect_plan_versions`
binds task, artifact, monotonic `BIGINT` plan version, digest-key ID, and entry-set
digest. JSON/runtime references encode the version as canonical unsigned base-10
text and order/compare only through PostgreSQL `BIGINT`, never a JavaScript number
or lexical comparison. Entry IDs are 1..256 ASCII `[a-z0-9._:-]`; canonical agent
and subtask components are at most 64 characters and invalid/over-limit input
rejects rather than truncates. Entries are keyed inside `{taskId,planVersion}` and use stable
`plan_body:000000`, `requirement:<requirementKey>`,
`overlay:<requirementKey>:<canonical-agent>`, or
`subtask:<validated-subtask-id>:<canonical-agent>` IDs. They are insert-only with
exact `ON DELETE RESTRICT`; update/delete guards protect versions, entries, and
their artifact header.

A non-login migration owner alone owns the plan version, entry, and text-bearing
columns. `PUBLIC`, web, worker, application, reporting, migration, and maintenance
roles have direct `SELECT` and DML revoked. There are exactly two schema-qualified,
fixed-`search_path=pg_catalog,forge` SECURITY DEFINER readers, both with `PUBLIC`
execution revoked: `forge.read_architect_plan_history_v1(...)` is the audited
human-history reader, and `forge.resolve_architect_plan_entry_v1(...)` is the
package-bound one-entry resolver. Neither accepts free-form SQL, enumerates text,
or exposes a locator; no other view/function/role may read plan text. Each reader is
executable only by its exact certificate-authenticated non-superuser `NOINHERIT`
login, which has no cross-role membership, `SET ROLE`, or session-authorization
privilege. Immutable `session_user` proves the calling boundary, but the shared
human-history web login is never treated as an end-user identity. That reader
has the exact signature
`forge.read_architect_plan_history_v1(p_session_credential bytea, p_task_id uuid,
p_plan_version bigint)`, not a user-ID argument. The current session table is
`public.sessions`, not `forge_sessions`: today `sessions.id uuid` is both the raw
lowercase-UUID `forge_session` cookie and `session:<uuid>` Redis key,
`revoked_at` exists, and no database expiry exists. S4 makes `id` an independent
internal UUID and adds `credential_digest_v1 bytea NOT NULL CHECK
(octet_length(credential_digest_v1) = 32)` with a unique index and
`expires_at timestamptz NOT NULL`; existing `user_id` and `revoked_at` remain the
identity and revocation authority, and existing `last_seen_at` becomes the
database activity clock.

`SESSION_CREDENTIAL_DOMAIN_V1` is exactly UTF-8
`forge:web-session:v1\0` (21 bytes; hex
`666f7267653a7765622d73657373696f6e3a763100`). The credential input is exactly
the current cookie's 36 lowercase ASCII UUID-v4 bytes, including hyphens and valid
variant, with no case fold, percent decode, UUID-binary conversion, normalization,
or hex/base64/text round trip. The database stores
`SHA-256(domain_bytes || credential_bytes)` as a 32-byte `bytea`, with no added
delimiter or length prefix. The fixed vector cookie
`00000000-0000-4000-8000-000000000000` yields
`a4a6fe7265a6d2ec096cb0d31bb6b79d91a3d9a36537827009cb01f22e1f58e4`.
The function receives the credential through a prepared binary bind, validates it,
locks the digest-matched row `FOR UPDATE`, then requires `revoked_at IS NULL` and
`clock_timestamp() < expires_at`; equality is expired. That locked row derives
the user. To preserve today's sliding seven-day lifetime, a valid authentication
strictly more than 60 seconds after `last_seen_at` synchronously sets
`last_seen_at = db_now` and `expires_at = db_now + interval '7 days'` under the
same lock; more frequent reads do not extend it. ACL is rechecked, expiry/revocation
is checked once more with database time, and the text-free audit and text return
commit together.

Redis is only a cache. The v2 key is
`session:v2:<lowercase credential-digest hex>`, never the cookie. Creation commits
PostgreSQL first with one `db_now`, `last_seen_at = db_now`, and
`expires_at = db_now + interval '7 days'`, then writes Redis with `PXAT` no later
than the committed `expires_at`; every
authentication rechecks PostgreSQL. A threshold refresh commits the database
expiry first, and only its after-commit action may advance Redis `PXAT`, never past
that returned expiry. Database refresh failure denies the request and cannot
extend Redis; Redis refresh failure cannot revoke a database-valid session and the
next database-authorized read repairs it. Revocation commits `revoked_at` and a
digest-keyed durable invalidation item first, then deletes Redis; retry/
reconciliation handles deletion failure, and a stale cache entry cannot authorize.
The migration first adds nullable columns
and a dual reader/writer. New sessions use separate row IDs, unchanged UUID
cookies, digests, database expiry, and v2 cache keys. After the legacy sliding-TTL
writer is stopped and its processes drained, each locked legacy row uses Redis 7
`PEXPIRETIME session:<legacy-id>` plus cached `lastSeenAt`: missing, malformed,
non-expiring, or elapsed entries are revoked; a live row gets that exact absolute
`expires_at`, reconciled `last_seen_at`, its digest, a fresh independent ID, and a
v2 `PXAT` no later than that expiry before the raw-key entry is deleted.
The resumable migrator rejects collisions and never extends expiry. Only after all
live rows, binaries, and credentials are drained may S4 remove the raw-ID fallback,
validate and make the columns strict, purge/zero-scan old `session:*` keys and all
sinks, and enable the history route.

The raw credential exists only in the cookie, bounded request buffer, and prepared
binary argument until hashing. Argument-one bind logging/tracing is redacted; it is
never persisted after the migration fence, returned, logged, audited, placed in
SQL text, or included in Redis/invalidation. The bounded legacy-ID migration read
is the sole temporary exception and cannot coexist with the enabled history route.
Required tests cover valid, exact-expiry, expired, revoked, swapped-user/task,
fabricated/malformed, wrong-domain/re-encoded/bit-flipped, simultaneous two-user,
read-versus-revoke, and read-versus-expiry cases; denials return zero bytes and no
read audit. Migration crash/resume, collision, exact expiry/activity backfill,
60-second threshold/seven-day refresh, database-failure/no-Redis-extension,
Redis-failure/database-valid repair, stale-cache/lost-delete, purge, and fixed-
vector tests are mandatory. The package resolver continues
to derive its exact worker identity directly from its distinct `session_user`.
Wrong-login/cross-reader, hostile `SET ROLE`, and catalog tests prove zero-byte/
zero-forged-audit denial and the production role attributes/lack of membership.

Every entry string is NFC normalized. Its canonical bytes are RFC 8785 JSON
Canonicalization Scheme serialization of the complete scoped entry tuple encoded
as UTF-8. `contentDigest` is
`HMAC-SHA-256(K_plan_v1, "forge:architect-plan-entry:v1\0" || canonicalBytes)`;
the row stores only the non-secret key ID and digest, and old keys remain
verification-only while retained references use them. Legacy migration orders
versions by architect run time/run ID/artifact ID and maps recognized fields to
the same stable IDs. Ambiguous input becomes one ordered
`legacy_full_plan` history entry with `projectionEligible:false`; it requires plan
recomputation. Entry insertion and raw artifact content/metadata removal commit in
one transaction, so there is never a second durable text copy.

During `normalizeDesign`, Forge validates each source requirement index, agent
assignment, and subtask capability reference, then writes only normalized policy,
`requirementKey`, capability bindings, and server-private eligible references
`{planArtifactId,planVersion,entryId,contentDigest}` to the runtime package.
Generic APIs never serialize those locators. The task-bound resolver verifies ACL,
task/package/type/stage/version/key/digest, package agent, requirement, and every
binding after admission. Only the eligible verified fragment may exist
ephemerally in that run's executor prompt and provider/Agent Client Protocol (ACP)
wire request. The whole plan row and every rejected/ineligible/unrelated fragment
never enters either wire or a persisted sink.

S4 creates the sole human route,
`GET /api/tasks/{taskId}/architect-plan-history/{planVersion}`, and append-only
`architect_plan_history_reads`. The route verifies current task/project ACL plus
exact task/version/artifact/type/stage and commits a bounded text-free read-audit
tuple before calling only `forge.read_architect_plan_history_v1(...)` and returning
entries. The internal package resolver calls only
`forge.resolve_architect_plan_entry_v1(...)` after admission. Unauthorized/cross-
task/wrong-stage/missing reads return no bytes. Normal task/project/package/artifact APIs, SSE live/snapshot/
replay, task logs/exports, queues, diagnostics, and errors expose neither plan text
nor a locator. Architect output is buffered; raw `run:chunk`/delta and plan
`artifact:created` payloads are deleted. Events contain only opaque run/event IDs,
fixed progress, and `historyAvailable:true`.

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
```

The unavailable arm deliberately retains the four legacy preview-health fields.
`admissionToGrantPreview` therefore extends the existing JSON with
`schemaVersion`/`observed`/`mcpId`/`checkedAt`; it never removes fields that
`McpGrantDecisions.health` and `execution-design-metadata.ts` already require.

```ts
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
  subtaskDecisions: Array<{ subtaskId: string; agent: string; requirementKey: string;
    mcpId: string; capability: string; class: McpCapabilityClass;
    deliveryKind: McpDeliveryKind | null; status: McpAdmissionStatus; reason: string;
    recoveryAction?: McpRecoveryAction }>
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
  subtasks: Array<Record<string, unknown>>      // normalized subtask policy/bindings + eligible plan-artifact projection refs; no raw subtask text
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
  - `planningContextCoverageKeys` — canonical `(requirementKey, agent, capability)` keys from
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
    in `planningContextCoverageKeys` **for the bound requirementKey and same agent**
    (so context from one same-agent/same-capability requirement cannot authorize a
    subtask explicitly bound to another context-missing requirement; a safe `github.*.read`
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
| `normalizeDesign` + `mcpRequirementsForAgent` | `normalizeDesign` assigns/persists a versioned canonical-payload digest `requirementKey` (with duplicate occurrence suffix; not an Architect-supplied key or bare array index), validates `requirementContexts[].sourceRequirementIndex` against it, and fails closed on ambiguous legacy agent overlays. Append-only `architect_plan_entries` under a non-text version header are the only raw-text store. The materializer preserves normalized policy, key, source index, `agent`, and server-private opaque entry references only, so Layer 3a can join collision-safely without copying text into runtime metadata or generic APIs | S2/S4 boundary |
| `mcpGrantsForAgent` (`workforce-materializer.ts:157`) | persists the matching `requirementKey`, `sourceRequirementIndex`, `agent`, `assignment`, `promptOverlayPresent`, plus `mode`, `recoveryAction`, structured `grantState`, `normalizedCapabilities`, `evidenceRefs` on each grant (schema bump) — not just id/mcp/caps/requirement/status/reason/fallback/health | S2 |
| `mcpSubtasksForAgent` (`workforce-materializer.ts`) | replaces raw persisted `metadata.mcpAwareSubtasks` text with normalized `id`, `agent`, flat `mcpCapabilities[]`, per-capability `capabilityBindings[{capability,requirementKey}]`, and opaque eligible plan-artifact projection references. Shared `capabilityMcpId` derives the MCP independently for each capability, so one subtask can safely span several MCPs without a synthetic singleton `mcpId`; missing/ambiguous/conflicting references or bindings block | S2/S4 boundary |
| `mcpCapabilityList` (`work-package-executor.ts:1527`) | imports `mergeCapabilityFields`; executor filesystem gating uses shared `coverageKeysForGrant`/`classifyCapability` | S4 |
| client helpers (`tasks/[id]/page.tsx:348-444`) | import shared helpers OR consume a server-computed grant-state payload; render `mode`+`recoveryAction` via `admission-copy.ts` | S5 |

## Implementation slices

Code-slice dependency order is **S1 → S2 → Step 0 → S3/#178 → S4 → S5 → S6.**
#179 Step 0 is the sole creator and version owner of the data-only
`web/lib/mcps/epic-172-release-order-v1.json` and its one validator,
`web/lib/mcps/epic-172-release-order.ts`. The JSON has one shared node registry
that stores each node's owner, required-evidence contract, and exact build identity
once. It has two separately named edge sets with fixed meanings:

- `codeDependencyGraph` records implementation and import prerequisites. Step 0 follows
  S2 but remains independent of S3; S3 requires S2 plus Step 0; remaining S4
  requires S2 plus S3; S5 requires S2 plus remaining S4; and S6 requires S2 through
  S5. This graph cannot authorize deployment, cutover, ingress, or issuance.
- `runtimeActivationGraph` records operational release transitions and contains the
  complete required chain
  `step0_retention_bridge → s3_issue_178 → s4_expand →
  s4_producers_disabled → s5_compatible_consumers_deployed →
  s6_pre_activation_green → s4_controlled_activation →
  s6_post_activation_green → ingress_and_issuance_enabled →
  s5_s6_release_ready`. This graph cannot satisfy a missing code prerequisite.

The validator imports the data-only JSON and no S3 or remaining-S4 symbol. It
validates each graph only under its named meaning and exposes read-only node/edge
access. #178/S3 and remaining S4–S6 import the Step 0 validator, use and record only
their owned nodes, and never create, regenerate, rewrite, copy, fork, shadow, or add
a second release-order file, graph, metadata registry, or helper. The Step 0 fixture
proves both files exist and validates the first node's route, full-ingress-close,
drain, retention-FK, hard-delete-guard, and exact-build postconditions before S3.

Ownership is resolved per shared-registry node, never from a whole-issue header:
`owner:{issue:179,slice:'step0'}` for `step0_retention_bridge`;
`owner:{issue:178,slice:'s3'}` for `s3_issue_178`;
`owner:{issue:179,slice:'s4'}` for `s4_expand`, `s4_producers_disabled`,
`s4_controlled_activation`, and `ingress_and_issuance_enabled`;
`owner:{issue:180,slice:'s5'}` for `s5_compatible_consumers_deployed`; and
`owner:{issue:181,slice:'s6'}` for `s6_pre_activation_green`,
`s6_post_activation_green`, and `s5_s6_release_ready`. The S6 entries are
controller attestations and do not own #179's activation or enablement. Exact
static ownership/import/parity sentinels reject a missing or mismatched owner;
missing, reordered, duplicated, or copied node/edge/metadata; the obsolete
`s4_activate` alias; any second file/helper; any slice recording another owner's
node; and any substitution of one graph, edge set, or evidence for the other.

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
  that flips the task to `approved`). Inside the transaction, lock and freshly read
  the project first (`FOR UPDATE`, freshly reading `mcpConfig`), then the task
  (`FOR UPDATE`, requiring `awaiting_approval`), then its work
  packages `FOR UPDATE` in ascending ID order. Run `admitWorkPackageMcp` **inside
  that transaction** over those locked rows using the captured health snapshot;
  do not evaluate an earlier package object. If any `aggregate.status === 'blocked'`, return the same
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
  `observed:false`, not as an invented snapshot. A concurrency test pauses after
  health capture, commits a requirements/metadata or project-grant rewrite, then proves approval
  locks/re-reads and evaluates the new policy (or loses a version compare-and-set)
  rather than approving stale policy. Health or grant drift after approval remains
  the separately documented handoff case.
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

### Step 0 — Separately landable retention bridge

- Before #178/S3 lands, #179 owns and deploys the archive-or-reject project-
  removal bridge before filesystem work, disables **all project-management
  ingress**, drains every pre-bridge process/session, converts evidence-bearing
  foreign keys to `RESTRICT|NO ACTION`, and installs the hard-delete guard. Project-
  management ingress stays closed through S3 and remaining S4's `root_ref` default,
  explicit-null insert bridge, non-null-to-null guard, journal, and database tests.
  This node has no S3 dependency.
- Step 0 is also the sole creator/version owner of the data-only
  `web/lib/mcps/epic-172-release-order-v1.json` and its one validator,
  `web/lib/mcps/epic-172-release-order.ts`. Neither imports an S3 or remaining-S4
  symbol. The Step 0 fixture proves both files exist and validates the first node's
  exact owner, build identity, and route/full-ingress-close/drain/foreign-key/guard
  evidence before permitting `s3_issue_178`. A static wording-parity sentinel
  rejects any Step 0 contract, fixture, or release check that narrows the
  prerequisite to delete ingress; only its own denylist fixture may contain that
  stale phrase.
- Before recording its own graph receipt, Step 0 also solely installs the generic
  pinned Ed25519 signer policy/key and audit, append-only immutable durable-release-
  evidence store, separate append-only short-lived
  `forge_epic_172_transition_authorizations` attempts in a distinct Ed25519
  signature domain, append-only consumption ledger, checked-in Node verifier/
  recorder/consumer, dedicated certificate-authenticated `NOINHERIT` evidence-
  writer/consumer/transition principals, canonical transition-identity uniqueness,
  the sole authoritative `disabled|provisional|active` enablement singleton
  initialized to `disabled`, and append-only non-authoritative enablement-transition
  audit. The bootstrap is not a graph node and creates no unsigned receipt. An
  external lifecycle-valid Ed25519 signer records the empty-predecessor
  `step0_retention_bridge` receipt through that substrate before S3 may proceed.
  Once validly recorded, graph-node and required-evidence receipts are immutable
  durable predecessors and do not expire; state transitions separately require a
  fresh exact unexpired authorization attempt with lifetime greater than zero and
  at most 30 minutes. S3 and remaining S4 import this substrate unchanged and do
  not create or widen it.

### S3 — Filesystem grant recovery (deterministic, recoverable)

- **Canonical projection and operator hold.**
  `requiresFilesystemGrantApproval` imports the S1-owned
  `readEffectiveGrantState`; S3 adds no second reader and never parses human
  text. It evaluates both handoff branches with fresh project MCP configuration
  and the exact required capability set. Required `none`, `denied`, `revoked`,
  and consumed-one-time decisions hold before claim when
  `continue_without_mcp` does not apply:

  ```text
  package pending | ready → blocked
  task    running         → approved only with no live sibling lease or `awaiting_review`
  task    running         → running while either task-wide barrier remains
  ```

  The projection and filesystem-only v2 marker import one closed
  `FilesystemGrantHoldState` union; the marker writer persists the selected arm
  rather than independently rebuilding its fields:

  | `holdKind` | `grantPhase` | `grantConsumed` | `grantDecisionRevision` | `revocationReason` |
  |---|---|---:|---|---|
  | `approval_required` | `none`, `proposed`, or `not_issued` | `false` | `null` | `null` |
  | `denied_required` | `denied` | `false` | canonical positive decimal, or `null` only from the exact legacy adapter | `null` |
  | `revoked_required` | `revoked` | `false` | canonical positive decimal | `project_grant_removed`, `project_grant_narrowed`, or `project_root_repoint` |
  | `consumed_once` | `approved` | `true` | canonical positive decimal | `null` |

  There is no independently writable `deniedRequired` boolean, and
  `grantConsumed` is a literal in each union arm rather than a free boolean. The
  strict parser rejects unknown keys and every tuple not in this table. The
  TypeScript type, SQL JSON-field `CHECK`, and parser use the same exhaustive
  cross-product fixtures. The marker creates no `agent_runs` and consumes no
  attempt. Its explicit handoff disposition is
  `{taskDisposition:'operator_hold', autoRetryable:false,
  terminalFailure:false}`. It must not reuse the existing `terminalBlock` flag,
  which current orchestrator paths interpret as task failure. The task returns to
  the grant endpoint's operator-actionable `approved` state only when no sibling
  has a live execution lease or `awaiting_review`. Either task-wide barrier keeps
  the task `running`. S3 and S4 use one database-owned operator-hold task-
  convergence service whose closed recognized-marker union includes S3
  `filesystem_grant` and S4 `packet_issuance`/integrity holds. Under project →
  task → all sibling package locks, it requires at least one recognized hold,
  proves both task-wide barriers clear, and changes only task `running → approved`
  while preserving package markers/blocks and creating no run or attempt. It is
  invoked after sibling completion/review resolution and by startup/periodic
  database discovery; Redis is only a wake hint. An S3-only task never depends on
  the presence of an S4 marker. S3 may wrap the service but must not duplicate its
  predicate or treat the held package as failure.
- **Database-ordered precedence.** Every filesystem decision mutation increments
  a project-scoped PostgreSQL `BIGINT` counter while the project row is locked.
  JSON/evidence serializes the positive `grantDecisionRevision` as a canonical
  decimal string; comparisons use database integers, never JavaScript number
  precision or lexical string order. A project `always_allow` supersedes a package denial only when it
  covers the complete required set and its revision is greater. A denial wins at
  an equal or greater revision. `approvedAt`/`deniedAt` are display evidence only,
  never authority. Legacy rows without comparable revisions fail closed until an
  explicit operator decision assigns one; migration must not manufacture order
  from timestamps. Removed or narrowed project coverage is `revoked`, not
  first-time `none`, and retains the latest revision and a bounded reason code.
  Every decision also stores the locked project's internal root-binding revision.
  A root repoint increments that separate revision and calls the same negative
  reconciler, so old-root project/package decisions become `revoked` and the new
  repository requires explicit reapproval. Stable packet `rootRef` correlation is
  never authority. An unbound project has internal root-binding revision `0`,
  which is never issuable. Initial backfill compare-and-sets the counter to its
  next positive value (normally revision 1) and never resets or decrements it; it
  never upgrades an existing approval because no legacy row contains immutable
  root-at-decision evidence. Every legacy decision without a stored binding
  revision remains non-issuable until explicit reapproval on the current locked
  binding. A current-path comparison cannot manufacture historical authority;
  unbound or duplicate roots fail closed.
- **Package-local `allow_once`.** An unconsumed one-time decision can approve only
  its package. Denial, one-time approval, nonce rotation/consumption, and
  reapproval reevaluate and mutate only that target package; they never run a
  project grant scan. If the target can change task status, however, the path must
  lock the task, discover every sibling, and prelock the complete sibling set once
  in ascending package ID order before locking any package. Package scope limits
  evaluation and writes, not the lock footprint of the task-wide predicate. If a
  covering project grant already wins, do not create a shadow one-time decision.
  #179 owns the per-run claim and nonce-fenced issuance.
- **One positive and negative project reconciler.** Equivalent
  `always_allow` decisions from the task and project endpoints call one service
  with the caller's `lockedProject`, fresh `nextMcpConfig`, allocated revision,
  and closed trigger (`task_always_allow|project_always_allow|project_grant_revocation|project_root_repoint`). It must not reacquire or reread the project. Grant removal or
  narrowing also calls it: eligible `pending`/`ready` packages that lose exact
  coverage proactively become held, while still-covered subsets remain eligible.
  A running, already-claimed package is not retroactively stripped; #179 fences
  the current run and the new decision governs future claims. A root repoint uses
  `project_root_repoint`, carries the incremented root-binding revision, and revokes
  old-root coverage without changing unrelated grant-decision ordering.
<a id="canonical-cross-slice-database-lock-order"></a>

- **Canonical cross-slice database lock order.** The following JSON list is the
  normative design contract for S3-S6 delivery, review, and recovery mutations.
  #178/S3 owns and materializes this exact object at
  `web/lib/mcps/mcp-admission-lock-order-v2.json` and owns the one shared database
  lock helper. Remaining S4 imports both and has no generator, local copy, or second
  helper. All production path declarations import that one runtime manifest. A parity
  sentinel compares its contract name, version, policy, and complete ordered
  family list with this JSON, so neither copy can drift. Other prose references
  the contract and does not maintain a shorter list. A mutation acquires only the
  families applicable to its state as an ordered subsequence. An absent optional
  row is skipped, never used to justify moving a later family earlier or acquiring
  a synthetic filler row.

  ```json
  {
    "contract": "forge-cross-slice-database-lock-order",
    "version": 2,
    "applicableRows": "ordered-subsequence",
    "families": [
      "project",
      "tasks:id-ascending",
      "work-packages:id-ascending",
      "grant-approval-decision-rows:id-ascending",
      "worker-protocol-epoch",
      "authenticated-worker-root-writer-instance-rows:id-ascending",
      "host-binding-generation-rotation-row",
      "host-root-hierarchy-guard-row",
      "agent-runs:id-ascending",
      "local-run-evidence-task-projection-heads:id-ascending",
      "optional-runtime-audits:id-ascending",
      "host-apply-ledgers:run-id-then-entry-ordinal",
      "artifacts:agent-run-id-artifact-type-artifact-id",
      "local-issuance-recovery-actions:local-evidence-or-audit-id-action-marker-fingerprint",
      "integrity-alerts:local-evidence-or-audit-id-reason-evidence-fingerprint",
      "integrity-resolutions:alert-id-expected-fingerprint-resolution",
      "review-gates:id-ascending"
    ]
  }
  ```

  Immediately after Step 0, before any S3 state writer, S3 materializes this exact
  object at `web/lib/mcps/mcp-admission-lock-order-v2.json` and adds the one shared
  ordered-subsequence validator in
  `web/lib/mcps/mcp-admission-lock-order.ts`. A parity test parses this ADR block
  and requires exact object equality. The helper imports only that JSON and
  standard-library types, derives its family type from the object—never an S4
  audit, packet, evidence, producer, or recovery symbol—and rejects unknown/
  duplicate families and reverse edges.
  #179 imports the S3-owned object/helper and owns no generator, copy, or second
  sequence.

  S3 normally stops after the fourth family and does not acquire the epoch row.
  #179 owns the remaining families, including authenticated worker/root-writer
  instance rows and local-run-evidence/task-projection current-head rows. Candidate
  discovery may happen without retained package locks. After the project and
  complete affected-task set are locked, every transaction that may change task
  status expands to every sibling for those tasks **before its first package
  lock**, then locks that complete union once in ascending package ID order.
  Package creation takes its task lock; reparenting takes old/new task locks in
  ascending ID order. Reconciliation may not add a newly discovered lower-ID
  sibling after locking a higher-ID target; membership or candidate drift causes a
  full compare-and-set retry. Every later applicable family follows the checked-in
  order. Rows within one family use the stable key named above. No endpoint nests
  the project lock or performs Redis/network work in the transaction.

  Namespace-reservation transitions are the explicitly disjoint root-lifecycle
  path: a reservation is a terminal row after hierarchy, and no such transaction
  then acquires a run or later delivery/recovery family. #179 selects every
  applicable suffix through the S3-owned shared helper. Static checks reject a
  reverse edge, undeclared acquisition, manifest/ADR mismatch, or second runtime
  sequence.
- **Bounded marker and JSON ownership.** The v2 filesystem marker remains outside
  `metadata.mcpBroker` and contains only structured filesystem kind/source, the
  exact canonical hold-state union arm above, normalized requirement keys/
  capabilities, operator-hold disposition, and `blockFingerprint`. It has no
  separately writable denial/consumption flags. The fingerprint is a versioned
  digest of policy inputs, not human text or timestamps. Recovery clears it only
  with a matching fingerprint. Reconciliation owns narrow
  `metadata.mcpGrantPhases` and filesystem-marker `jsonb_set`/`#-` patches (or a
  metadata-version compare-and-retry), never a stale whole-JSON replacement.
- **Exact recovery.** A matching filesystem-held package moves
  `blocked → ready` after full coverage and its task is woken after commit.
  Changed-fingerprint and generic MCP/security/dependency/reviewer blocks remain.
  Historical `failed` recovery is allowed only through the v2 marker, the exact
  v1 `{source:'filesystem-grant-approval'}` marker, or a versioned,
  fixture-backed, time-bounded legacy adapter that cannot match generic failure.
  The adapter upgrades state on the next safe mutation and never infers from
  requirements or error prose alone.
- **One-time reapproval handoff to S4.** S3 never clears S4's
  `packet_issuance` marker in its project reconciler. After a package-local
  reapproval appends a fresh decision/nonce under project → task → packages in ID
  order → `grant-approval-decision-rows:id-ascending` (decisions then preallocated
  `filesystem_mcp_current_decision_pointers`), compare-and-sets only that pointer,
  and calls S4's package-scoped resolver in the same transaction. Concurrent
  approval/deny/revoke/reapprove retains immutable prior decisions and one pointer
  winner; old audits never resolve through the new pointer.
  Package scope limits grant evaluation; the caller prelocks every sibling for the
  task-wide review barrier. The resolver continues through protocol epoch →
  authenticated worker/recovery instances ascending → active binding generation/
  rotation → hierarchy guard → prior run → generic local-run evidence and the
  locked task projection current-head set → optional audit → host ledger/entries → all
  artifacts → generic local/issuance actions → integrity alerts/resolutions →
  review gates. It proves generic evidence, every repository-review fingerprint,
  host review, task projection, and any packet audit/artifact terminal tuple before
  verifying the exact `reapprove_allow_once` marker/fingerprint, changed nonce,
  current policy, inactive lease, and no sibling `awaiting_review`. It clears only
  its packet marker. An unresolved local-effect marker/review/projection keeps the
  package blocked and creates no wake; only a barrier-free state may move
  `blocked → ready`. Stale/double/policy-drift/active-review/generic-evidence races
  are compare-and-set misses; Redis wakes only after commit.
- **PostgreSQL truth and failure behavior.** PostgreSQL commits decision,
  revision, marker, package, and task transitions atomically. Redis is post-commit
  wake-up only; a failed wake leaves recovered `ready` work for the periodic
  sweep. A failed transaction leaves no partial hold/recovery. Policy or
  fingerprint races retry from locked state. A revocation/handoff race has one
  serialized result: either #179 claims first under its fence, or S3 holds before
  claim. Generic packet/execution failure never burns or recreates an approval.
- **Authorized S3 completion.** S3's final installation/state transaction locks
  and reverifies the durable `step0_retention_bridge` receipt, signer policy/key,
  canonical transition identity, exact predecessor set, consumption keys, and one
  fresh exact signed `forge_epic_172_transition_authorizations` attempt in its
  distinct Ed25519 signature domain. The attempt binds target `s3_issue_178`,
  source receipt, exact owner/build/reviewed SHA/epoch-or-none, operation/controller
  identity, nonce, and expiry. At its final state-changing statement,
  `clock_timestamp()` must prove the attempt unexpired and unconsumed. The
  transaction atomically appends predecessor consumption, commits S3 final state,
  and records the canonically unique durable signed `s3_issue_178` receipt; rollback
  removes all three. An expired unused
  attempt remains audit-only and may be replaced by a newly signed exact attempt
  without rewriting durable evidence. A consumed/replayed attempt or a different
  attempt for the same completed canonical transition cannot advance state.
- **Mixed-version rollout.** The `runtimeActivationGraph` graph is the complete ten-node
  chain above; it does not stop at producer disablement or activation and cannot be
  replaced by `codeDependencyGraph`. #179 Step 0 is separately landable. It disables
  **all project-management ingress**, drains every pre-bridge process/database
  session, deploys the project-removal bridge that rejects or archives before
  filesystem work, converts evidence foreign keys to retention-safe form, and
  installs the database hard-delete guard. It also solely creates and versions the
  data-only `web/lib/mcps/epic-172-release-order-v1.json` and the one
  `web/lib/mcps/epic-172-release-order.ts` validator. Neither file imports S3 or
  remaining-S4 symbols. The Step 0 fixture proves the files and first-node route,
  full-ingress-close, drain, retention-FK, hard-delete-guard, owner, and exact-build
  postconditions before permitting `s3_issue_178`. Before that first receipt, Step
  0 also installs the generic pinned-signer durable-evidence store, separate
  append-only short-lived `forge_epic_172_transition_authorizations` store in its
  distinct Ed25519 signature domain, consumption ledger, verifier/principal,
  transition-identity, and disabled-enablement substrate described above.

  Project-management ingress remains closed while #178 imports the validator,
  ships additive nullable decision/root-binding fields and the dual v1/v2 reader,
  and passes S3 database tests. S3 then uses the one authorized final transaction
  above to consume the durable Step 0 predecessor with a fresh exact unexpired
  attempt and record only `s3_issue_178`. It remains
  closed while remaining S4 first adds nullable `root_ref` with no default, then the
  database-owned explicit-null insert bridge, omitted-value default, non-null-to-
  null update guard, and expand-phase monotonic project-root change journal/trigger,
  and passes their database tests. The journal operation enum is exactly
  `insert|root_update|archive`; schema and parser reject `root-update`. Unbound
  projects use revision `0`, and every approval without a stored binding revision
  is non-issuable. Only after all these safeguards and tests pass may compatible
  project-management ingress reopen exactly once for the mixed-version journal
  window. An early or second reopen is forbidden.

  Later cutover disables packet issuance and **all** project-management ingress
  again, revokes/terminates v1 web credentials and sessions, and drains old web,
  worker, and root-management services. Only after credential revocation/session
  termination may it capture the journal generation and run exactly
  `npm run project-roots:reconcile-expansion -- --through <generation> --actor <operator-id> --apply`.
  The command must record exactly one audited S3 outcome from the closed
  `insert|root_update|archive` vocabulary for every generation through the
  watermark; hard delete is already impossible. Any gap, duplicate/incoherent
  outcome, later legacy commit, or crash blocks progress. Then #179's
  `npm run project-roots:bind-v2 -- --actor <operator-id> --apply` procedure
  compare-and-sets each live local project to the next positive revision and never
  upgrades a legacy approval. After collision/unbound rows are held, install the
  protocol-v2 root barrier while every writer, ingress path, and packet producer
  remains disabled. Deploy #180's compatible S5 consumers and #181's disabled S6
  controller/harness; Step 0's pinned-signer, immutable durable-release-evidence/
  short-lived-transition-authorization/consumption stores, checked-in Node verifier,
  and dedicated principals are
  already present and are only imported. Only an
  exact-build durable `s6_pre_activation_green` receipt recorded under the locked
  signature/domain/nonce/predecessor contract plus a separate exact signed
  at-most-30-minute unexpired transition authorization allows
  #179's controlled activation to run exactly
  `npm run protocol:activate-work-package-v2 -- --actor <operator-id> --apply`.
  The binding command never advances the epoch, and activation commits with ingress/
  issuance disabled. Only #181's exact-epoch/build `s6_post_activation_green`
  receipt allows #179 to open one exact database-time provisional window. That
  operation atomically consumes the receipt, compare-and-sets the Step 0 singleton
  from `disabled` to `provisional`, writes the exact owner/build/SHA/epoch,
  `started_at`, deadline `started_at + interval '1560 seconds'`, exact controller
  login/run/transition-authorization and the digest of the initial secret generated
  and retained by that external controller before opening, and an at-most-45-second
  database lease, then enables
  registered S3/root writers and queue/project ingress, then packet issuance last.
  It records but does not consume the separately signed, canonically unique
  `ingress_and_issuance_enabled` receipt for final readiness. Every ingress/issuance
  boundary gates on the exact overall deadline and live lease. The controller
  heartbeats every 10 seconds using immutable `session_user`; failure changes the
  same singleton to `disabled`, and lease expiry closes it within 45 seconds. The controller
  then records separate signed
  `enabled_build_tests_green` required evidence for the enabled build/epoch and
  exact no-retry 660-second enabled-run DAG (60 seconds orchestration, 30 preflight,
  five isolated suites concurrently within 420, 120 teardown/destruction/Checks,
  30 evidence/final commit), leaving 900 seconds of deadline margin. One final transaction verifies the controller's
  signed readiness envelope, atomically consumes both the enablement and enabled-
  build receipts, appends the uniquely identified signed retained
  `s5_s6_release_ready`, and promotes the same provisional owner to `active`; the required-
  evidence kind is not an eleventh graph node.
  PostgreSQL triggers never
  call or reimplement the S3 TypeScript reconciler. Rollback disables writers/new
  claims but retains schema and the dual reader; it does not guess or downgrade
  revisions or restart v1 services against v2 state. Remove v1 support only after
  the bounded window.
- **Required PostgreSQL tests.** Prove exact hold and recovery transitions,
  barrier-aware `running → approved`, including direct and startup/periodic
  convergence for S3-only, S4-only, and mixed recognized holds after sibling
  lease/review release, zero runs/attempts, monotonic revision precedence under
  equal/reversed timestamps, legacy fail-closed behavior, grant narrowing/removal,
  exact capability subsets, package-local one-time boundaries, fingerprint
  compare-and-set, JSONB coexistence, endpoint equivalence, Redis-wake loss,
  root-repoint revocation/reapproval and alias equivalence, old/new worker gating
  and rollback, grant mutation/revocation against
  `awaiting_review` and both review decisions, and deadlock freedom across the
  canonical version-2 order. The TypeScript type fixtures, strict parser, and SQL
  `CHECK` exhaust the hold-kind × phase × consumed × revision × revocation-reason
  cross-product and accept only the four rows above; malformed-but-enum-valid
  tuples and unknown keys fail before an S3 mutation. A contract-parity mutation sentinel fails for every
  deleted, renamed, duplicated, or swapped family. Opposing-order transactions
  force contention at worker/root-writer instance → binding-generation and local-
  run-evidence → task-projection-source boundaries and finish with bounded waits
  and no deadlock. An exact real-PostgreSQL fixture gives one task a lower-ID
  unaffected sibling `P1` and higher-ID affected target `P2`, races the S3 target
  mutation against an opposing claim/review from `P1`, observes contention through
  `pg_blocking_pids`, and requires bounded completion/no deadlock under the winning
  serial state. It fails if `P2` is locked before S3 discovers/prelocks `P1`.
  Journal schema/writer/parser fixtures accept exactly
  `insert|root_update|archive` and reject `root-update`. Rollout fixtures prove all
  project-management ingress is closed at Step 0 and remains closed throughout S3
  and remaining S4's nullable `root_ref`, omitted-value default, explicit-null
  insert bridge, non-null-to-null guard, journal, and database tests. Omitted and
  explicit-null inserts receive generated references; unrelated updates may retain
  a legacy null, while a bound reference cannot be cleared. Only after these proofs
  may ingress reopen exactly once for the mixed-version journal window. An early or
  second reopen fails. The later full close, credential/session drain, and only-
  after-drain watermark are also mandatory.

  A release-order fixture first proves #179 Step 0 solely owns and has checked in
  the data-only `web/lib/mcps/epic-172-release-order-v1.json` and the one
  `web/lib/mcps/epic-172-release-order.ts` validator, with no S3 or remaining-S4
  import. It also proves Step 0 installs the generic signer/durable-evidence store,
  separate append-only short-lived `forge_epic_172_transition_authorizations`
  store in its distinct Ed25519 signature domain, consumption ledger, checked-in
  verifier/recorder/consumer, dedicated principals, canonical transition identity,
  recorder, sole authoritative disabled enablement singleton, and append-only
  enablement-transition audit before recording its signed first-node receipt; S3
  and remaining S4 only import that substrate. It validates the first node's full
  Step 0 postconditions before S3. It
  proves one shared node registry stores owner, required evidence, and exact build
  identity once; separately named `codeDependencyGraph` and `runtimeActivationGraph` edges
  preserve their fixed meanings; and only `runtimeActivationGraph` contains the complete
  chain `step0_retention_bridge → s3_issue_178 → s4_expand →
  s4_producers_disabled → s5_compatible_consumers_deployed →
  s6_pre_activation_green → s4_controlled_activation →
  s6_post_activation_green → ingress_and_issuance_enabled →
  s5_s6_release_ready`. Exact static ownership/import/parity sentinels verify the
  Step 0/S3/downstream owner mapping; require S3 and later slices to import the one
  validator and use and record only their owned nodes; and reject a second file,
  graph, helper, metadata copy, or direct rewrite. Mutation sentinels delete,
  duplicate, or reorder every registry node and named edge; reject the obsolete/
  truncated `s4_activate` chain; reject activation before S5 compatibility/pre-
  activation green; reject enablement before post-activation green; reject release
  readiness before enablement; and reject substituting either graph, edge set,
  evidence, or build identity for the other.
  A delayed-transition fixture waits more than 30 minutes after valid Step 0
  receipt recording and rotates the signer policy/key: durable predecessor evidence
  remains valid, but an expired authorization attempt cannot advance S3. It proves
  a newly signed exact replacement attempt can authorize the still-pending S3
  transition without duplicating either durable node; replay, wrong binding/domain,
  final-statement expiry, and concurrent double consumption fail closed. Failure
  injection after every verification/consumption/state/receipt write rolls back all
  S3 effects and leaves retry possible only with a still-valid or newly signed exact
  attempt.
  #181 owns
  the cross-slice failure and rollout regression matrix;
  #180 renders historical decision, current effective state, and packet evidence
  separately. A filesystem hold remains excluded from automatic retry.

The detailed S3 design is
`docs/architecture/issue-178-filesystem-grant-recovery.md`. #179 owns issuance
and evidence, #180 owns presentation, and #181 owns the integrated regression;
none of those slices may weaken this state, precedence, or lock contract.

### S4 — Prompt/context assembly and bounded-context packet evidence (builds on #43)

Step 0 of issue #179 depends only on #176/#177. Every remaining S4 item below
depends on #178/S3's decision, hold, reconciliation, and lock-manifest/helper
contract. This split must match the per-step release manifest metadata above.

- Specialist prompts receive only context whose owning decision either has
  `status:'allowed'` and mode `planning_only|bounded_context_approved`, or is the
  explicit pure-planning exception: `status:'warning'`, mode `planning_only`,
  `capabilityClasses.length > 0`, and **every** capability class `planning_only` (for example
  `filesystem.project.write`, which is an instruction for Forge's sandbox JSON
  path, not permission). No missing-context, unhealthy, deferred, unknown, or mixed
  warning qualifies. The runtime package contains only normalized policy/bindings
  plus eligible references into the one ACL-protected versioned Architect plan
  artifact; the task-bound internal resolver obtains requirement/overlay/subtask
  text only after admission as **instructions**, never as tool grants (executor
  prompt assembly around `work-package-executor.ts:1527-1583`). Raw
  `promptOverlay`, `requirementContexts`, and `mcpAwareSubtasks` text is absent from
  `work_packages.metadata` and normal APIs. No live MCP handle is ever issued. A
  subtask is emitted only when **every** per-capability binding is
  eligible; if one binding is deferred, unknown, blocked, or otherwise
  non-deliverable, omit the entire Architect-authored subtask text so a mixed
  subtask cannot smuggle the disallowed instruction through an allowed binding.
- **Architect source/history boundary.** The `artifacts` row is a non-text version
  header; append-only `architect_plan_entries` is the only text-bearing store and
  uses the exact task/version-scoped IDs, NFC/RFC-8785 canonical bytes,
  domain-separated keyed digest, deterministic legacy mapping, and immutability
  guards defined above. S4 creates the task-bound history route plus append-only
  bounded read audit. Generic task/package/artifact APIs, logs/exports, queues,
  diagnostics/errors, live events, SSE snapshots/replay, and both Redis event
  namespaces expose no plan text or locator. Raw `run:chunk`/delta and plan
  `artifact:created` producers are deleted. The task-bound resolver alone may put
  one eligible verified fragment ephemerally into one executor/provider/ACP
  request; the whole row and rejected/ineligible fragments never enter either
  wire or persistence. Before `s4_producers_disabled`, revoke/drain legacy Redis
  publishers/subscribers, purge all `forge:task:{taskId}:history`/`:seq` keys,
  rotate to schema-allowlisted `forge:task-events:v2:{taskId}:history`/`:seq`, and
  prove zero old keys plus zero seeded text/locator values. TTL expiry is not
  erasure.
- **Security boundary: MCP-channel admission is not an ACP sandbox.** An Agent
  Client Protocol (ACP) adapter is a local process and Forge explicitly does not
  OS-confine it (`FORGE_ACP_WORK_PACKAGE_EXECUTION=1` is operator acceptance of
  that risk). It may inherit `HOME`, `CODEX_HOME`, `PATH`, and XDG configuration,
  and prompt instructions cannot prevent shell, network, or credential access.
  Therefore `deferred_live_mcp`, “no live MCP handle”, and the S5 badges describe
  only capabilities issued through Forge's MCP channel; they must not claim that
  the worker is unable to perform an equivalent operation by another runtime
  tool. S4 omits the complete Architect-authored overlay, subtask, and requirement
  text for every deferred, unknown, blocked, or non-deliverable warning decision—not only its
  structured capability name—from the executable prompt (retaining only a static,
  Forge-authored boundary warning), and S5 displays
  “MCP access deferred — ACP runtimes are not a security sandbox” wherever ACP
  execution is enabled. Real process/network/credential/filesystem isolation is a
  prerequisite of any later security-bound capability guarantee and remains in
  the #40/#60 security epic. Tests prove that no deferred tool is issued or
  rendered as an allowed MCP instruction. A positive fixture proves a pure
  `filesystem.project.write` planning hint still reaches the prompt. An adversarial fixture uses optional
  `github.pull_requests.merge` + `continue_without_mcp` with an overlay that says to
  merge through `gh`; the executable prompt contains the static warning but none
  of that overlay/subtask/requirement text. Tests do not mislabel prompt compliance
  as OS-level enforcement.
- **Prompt-injection boundary.** For providers that preserve roles, Forge's actual
  system-role wire input states that bounded packet contents are untrusted data and
  requirement overlays are subordinate run instructions; tests capture that real
  role separation. The current ACP adapter flattens all roles into one
  `session/prompt` string, so it receives a bounded Forge-authored guidance section
  before quoted data and makes no immutable-role or enforcement claim. Serialize
  each section as length-bounded JSON with explicit
  `{kind, requirementKey, content}` fields rather than concatenating raw delimiter
  text; reject/escape invalid encoding and truncate only at documented boundaries.
  A Forge-authored reminder may appear after serialized user-role context to aid
  model attention, but that reminder is not immutable and is not an enforcement
  boundary. Adversarial tests assert actual system/user role separation only for
  adapters that preserve it; the ACP fake asserts the flattened wire representation and
  includes a repository file and an allowed overlay containing fake system markers,
  closing fences, and instructions to use `gh`/read credentials; the bytes remain
  quoted data and do not alter the issued MCP surface. S4 explicitly removes all
  current `frontMatter.prompt` producers (normal, no-command, stderr-warning, no-op
  handoff start, and no-op handoff completion) and downstream aliases. A
  repository-wide source sentinel rejects `prompt`, `promptInput`, `promptOverlay`,
  and equivalent executable-prompt keys at every task-log/front-matter producer
  outside its one denylist fixture. A producer allowlist permits only a versioned domain-
  separated keyed digest, byte count, section counts, and omission counters.
  Task/debug logs, exports, APIs, server-sent events, diagnostics, errors, and
  generic front matter never retain prompt/packet bytes, names, paths, rejected
  Architect text, or credential-like content; there is no assumed pre-existing
  sanitization path. Before writer drain, one historical task-log compatibility
  reader recursively removes every key in the shared closed
  `LEGACY_TASK_LOG_PROMPT_KEYS` tuple—`prompt`, `promptInput`, `promptOverlay`,
  `systemPrompt`, `userPrompt`, `sessionPrompt`, `executablePrompt`, `messages`,
  and snake-case spellings—at every object depth. It hides the whole value whether
  string, object, array, nested message list, or malformed, returns only a safe
  versioned event/count/time allowlist, and maps an unknown container to static
  `legacy_task_log_unavailable`; DB-facing history/API/export/SSE/diagnostic readers
  cannot parse the raw column independently. Compatible readers suppress every legacy unkeyed `sha256`
  prompt snapshot from DB/API/export/event/diagnostic output, exposing at most
  count-only `{kind:'unknown_legacy_digest',byteCount}`. After old writer
  credentials/sessions drain, a checkpointed S4 migration deletes the old digest
  or rewrites it to that count-only arm. It cannot re-key without plaintext and
  may never treat the public digest as keyed material. That arm or absence is the
  complete legacy output vocabulary: `legacyDigestSuppressed`, truncation flags,
  digest prefixes/surrogates, and combined boolean/count shapes are forbidden.
  After old database/Redis writer credentials and sessions drain, a bounded
  primary-key-checkpointed scrub records operation/last key/counts/pre/post row
  fingerprints/state/actor/database time, recursively deletes all closed aliases
  and unkeyed digests, and compare-and-sets the original fingerprint. Crash/resume
  is idempotent, a pre-commit rollback changes nothing, a concurrent mismatch
  pauses, and committed sanitized rows are never reconstructed. Completion scans
  DB plus API/export/live-SSE/snapshot/replay for zero aliases at any depth and zero
  seeded prompt bytes.
- **Every packet has an atomic run claim; `allow_once` adds a decision fence.** S3
  assigns a project-serialized `grantDecisionRevision` to every package/project
  filesystem decision. Every packet run has one claim unique on
  `(agentRunId, operation)` for protocol-v2 `operation:'context_packet'`. A package
  `allow_once` decision also has an immutable UUID `grantDecisionNonce`, rotated by
  explicit reapproval, and an additional unique claim on
  `(grantApprovalId, grantDecisionNonce, operation)` where the nonce is non-null.
  `filesystem_mcp_grant_approvals` is append-only: approve/deny/revoke/reapprove
  inserts a new immutable decision with a strictly greater project-serialized
  positive revision and, for `allow_once`, a fresh nonce. The migration explicitly
  drops/replaces the current history table's package-unique index; package
  uniqueness moves to the preallocated package-keyed
  `filesystem_mcp_current_decision_pointers` stores only current decision ID/
  revision/fingerprint and positive generation. Under canonical lock family
  `grant-approval-decision-rows:id-ascending`, writers lock decision rows then the
  pointer and compare-and-set the exact prior tuple; decisions and pointer commit
  or roll back together. Project `always_allow` likewise uses append-only
  `project_filesystem_grant_decisions` plus one project CAS pointer. No route
  updates/deletes a decision, and old audits keep their exact parent while new
  claims must match the locked pointer/root binding.
  Project `always_allow` claims have no nonce or package approval FK; they snapshot
  the exact already-locked project configuration decision revision, root-binding
  revision, covered capabilities, actor/time, and coverage fingerprint. Each claim stores immutable actor,
  decision time/revision, mode, required/approved capability sets, and a canonical
  policy fingerprint plus the locked root-binding revision so later approval-row
  or project-path updates cannot rewrite history. Old-root decisions are revoked
  and require explicit reapproval. Authoritative
  `authorization_snapshot JSONB NOT NULL` is a closed two-arm union. Its only
  scalar relational mirrors are source, mode, approval ID, decision revision,
  decision nonce, and root-binding revision. Schema-qualified, fixed-search-path
  `IMMUTABLE` `forge.validate_packet_authorization_snapshot_v2(...)` rejects
  malformed/unknown/over-limit JSON and requires
  exact canonical equality between every mirrored JSON/scalar field. It validates
  already-canonical JSONB and therefore does not claim to detect duplicate object
  keys after a JSONB cast. Every raw legacy/external UTF-8 text ingress first runs a
  duplicate-key-aware streaming parser before `JSON.parse`, PostgreSQL `json`, or
  JSONB conversion; a retained legacy JSONB value with no original raw bytes is
  `unknown_legacy`, never newly trusted authority. An update
  guard makes snapshot and mirrors immutable while lifecycle fields terminalize.

  Protocol-v2 `task_id`, `work_package_id`, `agent_run_id`, and
  `local_run_evidence_id` are independently non-null and exactly equal to the
  locked audit/run/local-evidence identity. This CHECK precedes the composite
  `MATCH SIMPLE` FK and partial unique indexes, so null cannot bypass either.
  Direct table DML is denied. Only the schema-qualified fixed-search-path
  `forge.insert_packet_authorization_snapshot_v2(...)` function may insert: it
  accepts typed relational IDs/enums, locks and revalidates the rows, constructs
  canonical JSONB and scalar mirrors itself, and accepts no JSON/text authority
  input.

  The package writer locks the matching
  `filesystem_mcp_current_decision_pointers` row after the decision rows and proves
  its ID/revision/fingerprint parent. The project arm locks the project pointer and
  retains a composite reference to
  `project_filesystem_grant_decisions(project_id,grantDecisionRevision)`. Database
  guards reject decision update/delete or a mismatched pointer target.

  `package_allow_once` requires `grantMode:'allow_once'`, non-null approval/nonce,
  and a composite child key
  `(grantApprovalId,taskId,workPackageId,grantDecisionRevision,
  grantDecisionNonce)` referencing the retained immutable approval's matching
  unique key with exact `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`.
  `project_always_allow` requires `grantMode:'always_allow'` and null approval/
  nonce, so it does not manufacture package authority. SQL validator/CHECK/FK,
  Drizzle parsing, task/project/artifact APIs, and S5 share one two-row fixture
  table and reject every other source × mode × FK-nullability × nonce-nullability
  cross-product, every JSON/scalar mismatch, and otherwise valid cross-package,
  cross-task, or cross-project approval substitution. Task-scoped and project-
  detail always-allow readers call the same canonical locked project-decision
  loader and return byte-equivalent revision/root/capability/fingerprint fields.

  Structured serialization reuses the producer ceilings (20 requirements, 40
  subtasks, 2,000 characters per overlay), caps the full executable MCP JSON block
  at 128 KiB, and omits only whole documented optional fields. Packet assembly keeps
  the current 50-file, 160 KiB total, 24 KiB-per-file, depth-6, 500-entry, and
  5,000-traversal ceilings. Typed evidence also bounds `rootRef` to 80 ASCII
  characters. `PacketRedactionCategory` is the closed literal union
  `private_key_blocks|authorization_bearer|docker_auth|netrc_credentials|
  pgpass_credentials|secret_like_assignments|structured_secret_keys|database_urls|
  url_userinfo|well_known_token_prefixes|cloud_api_tokens|jwt`;
  `PacketRedactionSummary` is a partial record over only those keys, at most once
  each, with integer counts `0..5,000`. Artifact text is capped at 16 KiB.
  Packet-owned evidence has no arbitrary
  failure-detail field; it is enum-only.

  One exported `PACKET_REDACTION_CATEGORIES` array owns this union. The S4 producer,
  schema-qualified database JSON validator, Drizzle parser, finalizer/repair, API
  serializer, S5 presenter, and parity fixtures import it. Unknown/duplicate
  semantic keys, non-object summaries, and out-of-bound counts fail before commit
  or rendering; no layer sanitizes or echoes an unknown key. Configured-pattern
  lists and arbitrary producer strings are not packet evidence.

  Extend the existing package claim transaction instead of creating a second run
  lifecycle. Every S4 transaction imports #178/S3's
  `web/lib/mcps/mcp-admission-lock-order-v2.json` through #178/S3's shared helper,
  declares its applicable rows, and acquires that ordered subsequence. A package
  claim therefore uses the applicable project/task/package/decision prefix and the
  applicable epoch/instance/binding/hierarchy/run/evidence/audit/ledger/artifact/
  action/integrity/review tail; absent audit, packet, or review rows are omitted
  rather than locked synthetically. Namespace reservations remain in the disjoint
  root-lifecycle family and are never synthetic claim locks. One shared package-claim
  primitive locks project, task, and every sibling package in stable order,
  recomputes dependencies/candidate eligibility, rejects an archived project,
  proves no sibling is running/leased or `awaiting_review`, then locks the epoch,
  connection-authenticated instance, active binding generation/rotation, hierarchy
  guard, and exact sibling run/evidence/review current-head set. Projection input is
  the closed shared `CURRENT_LOCAL_PROJECTION_HEAD_KINDS` list with exactly eight
  preallocated current-authority heads per protocol-v2 package, never the growing
  append-only history tail. Each transition appends immutable history outside the
  cap, then count-neutrally advances the applicable head with exact source FK,
  positive revision, fingerprint, and compare-and-set identity. One PostgreSQL
  aggregate must reproduce the task's versioned zero/null local-change projection
  from at most 256 sibling packages; at exactly 256 it reads 2,048 fixed heads.
  The canonical lock family is
  `local-run-evidence-task-projection-heads:id-ascending`. Task package 257 enters
  typed `local_projection_package_limit` and moves the whole legacy task through
  authoritative `active|archive_pending|legacy_archived`. Packages/evidence are
  never reparented, split in place, or deleted. A separately planned replacement
  has new IDs, at most 256 packages, and all eight heads each. It also stores exact
  source-task ID, `pending|eligible|cancelled` replacement state, positive version,
  and source/replacement fingerprint. It starts pending, and every claim/wake/
  ingress/root-mutation gate rejects it before I/O. The exact read-only
  inspect, archive dry-run/apply, and guide are:

  ```text
  npm run protocol:inspect-local-projection-overlimit -- --task <legacy-task-id>
  npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id>
  npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id> --apply
  docs/operators/local-projection-overlimit-archive-v2.md
  ```

  Apply records source/replacement fingerprints and bounded
  `validated|quiesced|archived` checkpoints, rejects live claims/reviews and an
  over-limit replacement, locks source/replacement tasks in ID order followed by
  all package/head rows in ID order, closes ingress, and resumes idempotently. Before final
  CAS, rollback may restore `archive_pending → active` while retaining the hold;
  final archive preserves every source relationship and atomically changes source
  `archive_pending → legacy_archived` plus replacement `pending → eligible` under
  exact versions/fingerprints. Rollback leaves replacement pending; cancellation
  retains its evidence. No path truncates history. Immediate source triggers increment a
  transaction-local per-task mutation generation. Deferred constraints assert once
  for each final `{taskId,mutationGeneration}` through a transaction-local dedup map;
  later DML increments the generation and re-arms the check. Application roles lack
  projection-column DML, and a guard permits updates only from the dedicated non-
  login owner of the fixed-search-path SECURITY DEFINER aggregate writer, so direct
  DML cannot borrow dedup state. Missing, stale, wrong-version, over-cap, or
  mismatched state—including a coherent-looking stale zero—is an integrity hold.
  The release-pinned PostgreSQL 16 maximum-cardinality benchmark runs 1,000 warmed
  validations excluding deliberate lock wait and requires p95 <= 40 ms and p99 <=
  100 ms. It sets transaction-local
  protocol 2, and
  claims exactly one package. This
  applies to packet-bearing, packet-free, and handoff-only execution. A
  packet-bearing transaction then creates the agent
  run and existing execution lease plus one generic local-run evidence row before
  any repository read, inserts the packet claim referencing that row and authorization
  snapshot, and—only for `allow_once`—consumes the exact nonce. Any failure rolls all
  of those writes and the attempt back. A local-root run needing no packet creates
  no packet audit/artifact but still creates generic effect/repository evidence;
  only a truly root-free/no-effect handoff omits both.

  Mixed-worker cutover uses a durable database barrier. A singleton
  `forge_runtime_protocol_epochs` row starts with the work-package execution
  minimum at 1 and no active host. It also has nullable active host, minimum root-
  management protocol, host-fence-service/containment-adapter versions, and active
  host-binding-key fingerprint. An expand-phase PostgreSQL trigger runs on the existing package
  transition to `running`, reads transaction-local worker protocol (`1` when absent
  for legacy binaries), takes a shared epoch lock, rejects a lower writer, and
  records `work_packages.claim_protocol_version`. At epoch 1 it rejects protocol-2
  claims in packet, packet-free, and handoff modes; v2 processes remain
  `candidate`. At epoch 2 it also requires a
  transaction-local worker-instance ID, locks that exact registry row after the
  epoch, and verifies active/fresh state, host, protocol, fence/containment
  versions, active binding generation, and binding-key fingerprint. Each process
  incarnation has a never-reused, independently revocable `NOINHERIT` PostgreSQL
  login/certificate principal; the trigger requires `current_user` to equal the
  named row. A caller GUC/shared credential generation cannot authenticate it. It
  pins the instance on the package/run; caller-supplied host/version strings cannot substitute. The shared claim sets
  protocol and the registered instance ID locally. That transition is the pre-read
  boundary every current executor traverses; an audit-insert trigger would be too
  late. Activation is a privileged maintenance action using `READ COMMITTED`:
  statement one locks the epoch exclusively; statement two, after any lock wait,
  uses a fresh command snapshot and aborts if any running package has
  null/protocol-1 evidence, unbound live project, or any worker/root-writer
  capability/heartbeat/drain row violates the single-active-host/key rule;
  statement three atomically advances to 2, flips the active binding-generation
  pointer, promotes only the audited candidates to `active` (a hard maximum of 64), and audits the exact
  package/project/instance/principal snapshot. Queue/root/project ingress remains
  disabled until commit. A v1
  shared-lock winner commits and forces activation to abort; activation winning
  first rejects the later v1 transition. Single-statement or pre-wait snapshots
  are forbidden. Activation updates only the bounded epoch/candidate set in
  epoch → instance order, so it cannot reverse entity locks, and the epoch is never lowered. This fences Forge's
  cooperative packet producer, not independent ACP host access.

  Initial protocol-v2 local-root execution is single-active-host. Every worker and
  web/root-management process has a typed durable
  `candidate|active|draining|drained|retired`
  capability/heartbeat registration
  containing its operator-controlled stable host ID, maximum worker/root-writer
  protocol, fence-service/containment versions, binding-key fingerprint, dedicated
  database principal, last-seen time, and drain state. Activation additionally
  requires one distinct fresh candidate host, equal key fingerprint and compatible
  capabilities/principals for every selected instance, and audited drain evidence
  for every stale, legacy, incompatible,
  divergent-key, or other-host
  row. Candidate/active instances heartbeat every 10 seconds and are fresh for 30 seconds by
  PostgreSQL time; older non-drained rows block. Activation pins the one host and
  minimum service/adapter versions and key fingerprint on the epoch row. Its immutable audit snapshots that
  exact set. Missing/unreachable evidence
  blocks activation. Multi-host local effects require a later host-affine routing
  architecture; the package/root-mutation triggers reject a later unregistered,
  revoked-principal, stale, draining, divergent-key, or other-host process—and any
  caller naming another good row—before repository access. Drain revokes the exact
  principal and terminates all its sessions before acknowledgement; IDs/principals
  are never reused.

  A database unique constraint covers normalized `database_principal` and the
  never-reused incarnation ID. Process principals receive no direct registry
  `INSERT|UPDATE|DELETE`. Operator/bootstrap code owns immutable identity,
  capability, host/key/generation, and lifecycle state. A `SECURITY DEFINER`
  `forge_heartbeat_current_instance()` owned by a non-login role, with fixed
  `pg_catalog, forge` search path and `PUBLIC` execution revoked, derives exactly
  one row from immutable `session_user` (not the definer-valued `current_user`). It
  locks epoch → exact instance → applicable binding generation/rotation, then
  revalidates the epoch pointer, principal, lifecycle state, and active-or-pending
  generation/token before compare-and-setting only `last_seen_at` for an allowed
  `candidate|active` row. An
  exact pending K2 candidate may attest only its rotation-bound pending generation;
  that heartbeat grants no claim or root-mutation authority. The function cannot
  register, promote, revive, or cross rows. Process roles are non-superuser and
  cannot change session authorization. Drain revokes heartbeat/claim access and
  terminates sessions before acknowledgement.

  Epoch 2 uses a separate, checked-in ongoing membership command; initial
  activation is never replayed for restart. The Release/DevOps maintenance
  principal disables the affected queue/root ingress, provisions a never-reused
  same-host/current-generation candidate, locks epoch then old/new instances
  ascending, proves old-principal revocation/session termination and drain or W2
  eligibility, and atomically writes one append-only membership audit while
  promoting a bounded replacement set (still at most 64). Root-writer replacement
  keeps the old writer `draining` until external fences are held, then atomically
  transfers each exact pinned reservation and maintenance intent to the new writer
  or to `cleanup_required`; a durable takeover ledger binds old/new instance,
  credential generation, object identity, and outcome. Ingress stays disabled
  throughout, and a normal writer cannot transfer its own pins. Failure leaves the
  new row candidate and ingress disabled; it never revives the old principal. A
  separately provisioned standby W2 can therefore be promoted when W1—or every
  active worker—has died, after which the normal W2 election still owns the run.
  Candidate credentials expire after a bounded database-time provisioning window;
  at most 64 unpromoted candidates per host/generation retain live credentials.
  Expired/rolled-back candidates and drained instances follow revoke → terminate
  sessions → retire → certificate destruction/login drop. A restartable GC handles
  at most 64 tombstoned identities per transaction only after proving no membership,
  recovery ownership, transition pin, role ownership/grant, or session remains;
  immutable instance/principal/certificate fingerprints and destroy/drop evidence
  remain append-only and identities are never reused. A locked installation-wide
  budget has a hard maximum of 256 undestroyed credential-resource slots (operators
  may configure less): every candidate and retired login/certificate counts, as does
  one pre-reserved retirement slot for each active principal. Promotion/retirement
  transfer slots instead of exceeding the cap. At the cap, the transaction writes/
  rereads one deduplicated `worker_principal_lifecycle_capacity_exhausted` alert and
  rejects new provisioning or any activation/replacement without reserved slots;
  revoke, drain, count-neutral recovery, and GC remain available. Only verified
  certificate destruction and login drop release capacity. Hard-bounded candidate/
  retirement backlog blocks provisioning. The exact commands and guides are:

  ```text
  npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>
  npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id> --apply
  docs/operators/work-package-instance-replacement-v2.md
  npm run protocol:gc-work-package-principals -- --actor <operator-id>
  npm run protocol:gc-work-package-principals -- --actor <operator-id> --apply
  docs/operators/work-package-principal-lifecycle-v2.md
  ```

  Release Step 0 is a separately landable bridge before #178/S3 and before any S4
  expansion schema that retains project evidence. It replaces the legacy
  filesystem-first hard-delete route with archive-or-reject behavior, disables all
  project-management create/update/repoint/archive/delete ingress, drains all
  older routes and sessions, removes
  cascading project foreign keys in favor of retention-safe `RESTRICT|NO ACTION`,
  and installs a database hard-delete guard. Only then may the project-root journal
  and retained evidence schema expand. The project-root trigger is enabled only
  inside the post-drain cutover window,
  after v1 project ingress/credentials/sessions are disabled and S3's canonical
  TypeScript reconciler has processed every row in the expand-phase monotonic
  project-root change journal through a post-session-termination drain watermark.
  A simple PostgreSQL row trigger journals the closed
  `insert|root_update|archive` outcome vocabulary
  without paths, TypeScript calls, or reverse locks; hard delete is already
  impossible. Gaps or unprocessed outcomes block binding/activation. The root trigger never
  calls or duplicates S3. While epoch 1 it rejects root-bearing mutation and hard
  delete. At epoch 2 it covers root-bearing insert, root/path/revision/maintenance/
  archive update, and hard delete. A rootless insert is allowed only when every
  local binding/maintenance field remains null/none; attaching a root later uses
  the full protocol. Hard delete is rejected; every governed mutation requires protocol 2, a fresh exact
  registered root-writer instance whose dedicated principal equals `current_user`,
  host/key/active-generation equality, and a maintenance/reservation token plus the
  active root-writer database-credential generation. Activation's fresh statement-two snapshot
  therefore serializes with stale web writers. Old web/root processes already past
  the trigger must be drained; rollback never restores them. The host binding key
  is operator-controlled secret material and only its fingerprint is stored.
  Backup is mandatory. Loss/rotation uses a privileged two-phase row/token with
  active K1 and pending K2: disable ingress/issuance, revoke the old credential,
  drain and prove all claims/effects/reservations empty and all K1 task projections,
  local/packet markers, reviews, integrity holds, and terminal evidence coherent,
  then write restartable
  owner-level K2 generation/shadow rows under old/new hierarchy fences. Each shadow
  stores owner/source revision/K1 generation, K2 full/ancestor references, and
  verification fingerprint. After bounded complete-set verification, one constant-
  size transaction flips only the epoch's active generation/key/credential pointer,
  rotation status, and a hard-bounded authenticated K2 candidate set; it rewrites
  no owner row. Every reader/constraint resolves
  exactly that generation. Normal writers cannot cross keys; pre-promotion crash
  resumes/discards inactive shadows in bounded batches, while post-promotion
  recovery keeps K2 authoritative and cleans K1 later. Root revisions/decisions
  remain unchanged only when physical identity matches. Silent replacement is
  forbidden. Operators use only these literal checked-in commands and guide:

  ```text
  npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref <opaque-secret-ref> --actor <operator-id>
  npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref <opaque-secret-ref> --actor <operator-id> --apply
  npm run protocol:inspect-host-binding-key-rotation-v2 -- --rotation <rotation-id>
  npm run protocol:rotate-host-binding-key-v2 -- --rotation <rotation-id> --discard --actor <operator-id> --apply
  docs/operators/host-binding-key-rotation-v2.md
  ```

  Because an old DELETE route can touch the filesystem before its database write,
  cutover disables project-management ingress, revokes the v1 web database
  role/credential and terminates its sessions, drains/disables old service units,
  activates a new root-writer credential generation, then enables ingress only to
  the exact registered v2 owner. A restarted old binary cannot authenticate/read a
  project path before filesystem work. The audit binds all of this evidence. This
  governs Forge services, not unrelated processes with direct host access.

  The generic local-evidence lease is subordinate to the execution lease; packet
  audit ownership is an optional third predicate. One database-time heartbeat
  compare-and-sets execution plus generic ownership and the packet lease only when
  `packetAuditId` exists. Every heartbeat first locks the protocol epoch and exact
  run/package-pinned instance, then revalidates epoch 2, active host/key/generation,
  instance ID/state/freshness, and `current_user === database_principal`. The generic row stores live claim token/expiry separately
  from W2 recovery token/expiry; neither credential substitutes for or refreshes
  the other. Every governed repository read, assembly transition/read, prompt
  exposure, ACP submission, post-response local stage, per-file host replacement,
  and live or recovery finalization locks and revalidates the epoch → exact pinned
  live/recovery instance → `current_user` prefix before verifying the execution
  lease and generic evidence token/lease/nonterminal state. Packet runs additionally verify the exact linked claiming
  audit token/run/lease; packet-free/handoff runs never fabricate it. A truly root-
  free/no-effect handoff is the only arm without generic evidence. An
  `always_allow` boundary also reruns the
  canonical S1 `readEffectiveGrantState` and requires `phase:'approved'`,
  `source:'project-level'`, and `grantMode:'always_allow'`; the locked project
  decision supplies the revision/coverage stored under snapshot source
  `project_always_allow`. An equal/newer package denial therefore still wins.
  Revocation or override stops
  a later Forge-governed boundary but cannot recall bytes or cancel external I/O
  already started. Execution, generic, packet, and W2 tokens are database-only;
  they never enter ACP, the bounded exchange, post-claim queue payloads, logs,
  APIs, server-sent events, exports, diagnostics, errors, or artifacts. A copied
  still-live token used under another dedicated principal therefore fails before
  renewal, read, assembly, exposure, or finalization.

  Packet-free/handoff local execution has its own durable generic invocation
  intent: `not_started|invoking|returned|definitive_not_started|uncertain`, with a
  random attempt ID and database timestamps. The owner compare-and-sets
  `not_started → invoking` before any ACP input/output operation. Only the same
  still-live exact owner/attempt may compare-and-set
  `invoking → definitive_not_started`, and only from a trusted typed
  `pre_io_refusal` proving no adapter child, serialization, socket/network write,
  credential use, or repository operation began. Restart never resumes `invoking`
  as a fresh call: orphan/stale recovery always records `uncertain` and can never
  infer `definitive_not_started`; a live durable return records `returned`. Uncertain/returned work
  requires explicit local acknowledgement before retry; ordinary decline remains
  available without coercing that acknowledgement.

  Under every resource fence, the first governed repository read persists three
  versioned opaque baselines in the generic local-run record. The bounded working-
  tree scanner detects tracked, ignored, untracked, renamed, and deleted changes;
  it uses `lstat`, never follows links or opens FIFO/socket/device entries, and
  reads content only from regular files. A separate bounded Git-control snapshot
  covers resolved gitdir/common-dir config, hooks, `HEAD`/refs, index, worktree
  administration, submodule control, packed refs/reflogs, replace/grafts, shallow,
  maintenance, and alternates. A third Git-storage snapshot covers loose objects,
  packs/indexes/MIDX, commit graph, alternate stores, and every object-resolution/
  integrity file; additions of unreachable objects count as change. Git discovery
  runs through a sterile checked-in environment builder (`env -i`, fixed protected
  `HOME`/XDG directories, system/global config disabled, and Git path/config/object
  environment variables cleared). The one no-lazy-fetch predicate requires exact
  `GIT_NO_LAZY_FETCH=1` on **every** Git child, including the capability probe. An
  operational child additionally receives global `--no-lazy-fetch` immediately
  after the binary if and only if a checked release-pinned probe for that exact Git
  binary digest reports support. The probe performs no repository discovery,
  configuration, object access, or network access and records immutable
  `{gitBinaryDigest,supportsNoLazyFetch}` evidence. A missing, mismatched, or
  ambiguous probe disables local execution rather than guessing unsupported. Every
  probe and operational child runs inside a network-denied namespace with prompts
  and every Git transport disabled; the builder refuses any argument vector or
  environment that disagrees with the predicate. The non-Git parser rejects partial-clone extensions,
  promisor remotes/filters, `.promisor` packs, missing reachable promisor objects,
  and any state that could trigger lazy fetch; the first release fails such a clone
  at preflight and never contacts a remote. The first release rejects external includes,
  hooks, attributes, executable filters/diff drivers, and unresolved symlink
  targets rather than letting host configuration affect the snapshot. Linked/
  external gitdir/common directories and allowlisted alternates require ordered
  resource fences; unsupported/unbounded stores disable local execution. All three
  enforce file/byte/depth/time ceilings and matching scans/equivalent snapshot
  proof, with only narrow versioned volatile exclusions. Version 1 defaults/hard
  maxima are: working tree 100,000/500,000 files, 32 MiB/256 MiB hashed bytes,
  4/32 GiB observed bytes, depth 128/256, 60/300 seconds; Git control
  100,000/500,000 files, 64 MiB/1 GiB hashed, 4/32 GiB observed, depth 64/128,
  60/300 seconds; and Git storage 500,000/2,000,000 files, 8/64 GiB hashed,
  64/512 GiB observed, depth 32/64, 120/600 seconds. Lower configured values are
  allowed; values above the maxima are rejected. Their combined fingerprint
  feeds comparison, review, task aggregate, and success; no path/control content
  is exposed. Pre-exposure incompleteness is `preflight_failed`; post-exposure
  incompleteness is `unverifiable`. A live owner
  waits for the separately addressable ACP containment subtree to become empty and,
  before any Forge response-driven stage, computes the comparison; recovery waits
  for the complete per-run execution group empty. A changed or unverifiable result requires
  exact fingerprint-bound repository review after a valid response, failure, or
  submission uncertainty, even with `effectIntent:not_started` and no Forge host
  ledger. A valid response with such a result starts no later local stage and uses
  bounded `external_repository_change_requires_review`. The barrier blocks retry,
  reapproval, new work, and root management until reviewed or separately
  quarantined as abandoned. Only the exact fingerprint-bound
  `review_local_changes` transition and privileged quarantine may cross their own
  barrier. This lifecycle is packet-independent: packet-free and handoff-only
  local-root runs create/recover/review the same generic record without inventing
  packet audit, artifact, delivery, or CTA. Generic legacy stale recovery is
  allowed only for a truly root-free/no-effect run.

  Each project stores an internal opaque host-resource reference, authoritative
  host ID, and monotonic root-binding revision. The reference is an installation-
  keyed digest of stable host identity plus platform-normalized canonical physical
  root; alias/symlink/case variants converge, a live-project-only partial database
  uniqueness constraint uses the existing `archived_at IS NULL` lifecycle and
  rejects duplicate ownership. Durable installation-keyed hierarchy claims plus a
  deferred host-guard constraint reject ancestor/descendant live roots while
  allowing siblings, and hosts unable to prove
  identity equivalence fail closed. The binding and instance/epoch carry one
  host-binding-key fingerprint. The all-mode claim pins these values on the work
  package, including packet-free/handoff-only execution; any agent run carries an
  equality-checked internal copy, while the packet authorization snapshot carries
  only the safe root-binding revision and never the resource reference. After claim and
  before the first repository read/context assembly, the worker acquires the
  corresponding advisory resource fence with no database locks, revalidates the
  pin top-down, and retains the fence through submission, local effects, atomic
  finalization, and descendant quiescence. A dedicated host fence service under a
  separate protected operating-system principal owns the lock/durable local lease,
  protected state and socket. It authenticates kernel peer credentials plus an
  unguessable run/worker/root/group-bound capability and independently proves
  kernel group emptiness; tamper, corruption, replay, peer mismatch, service death,
  or unverifiable state becomes orphaned/disabled. The long-lived queue worker
  stays outside containment. Durable Forge control/run state moves out of project
  `.forge/task-runs` into protected service-owned host state; same-worker mode 0700
  is not protection. The service allocates a bounded pool of distinct
  `{trustedShimUser,untrustedRunUser}` pairs (default 32, configurable 1–256) and
  binds every capability to `{slotRef,slotGeneration,runId}` plus the shim UID; ACP
  never receives it. A slot is reused only after cgroup/PID-namespace emptiness,
  process/session termination, descriptor cleanup, protected-state removal, and
  credential/capability revocation have been attested; otherwise it remains
  quarantined and capacity backpressure stops new work. It creates
  a bounded non-sibling-traversable exchange directory and a non-dumpable trusted
  shim under the paired shim principal; only the shim launches the already-validated
  adapter under the untrusted run user. Inputs/outputs use
  allowlisted one-way handoff and the exchange manifest/final digest is bound to
  generic local evidence. Service lifecycle capabilities/state handles never enter
  ACP environment, arguments, inherited descriptors, or readable storage. The run
  mount namespace exposes project/exchange as `nosuid,nodev`; preflight rejects
  setuid/setgid entries and `security.capability`. Private PID/procfs, ptrace/signal
  policy, distinct UIDs, and the non-dumpable shim prevent ACP from reading or
  signalling trusted processes. A supported adapter places that shim/child, ACP, validation, response-driven work, and
  every descendant in one non-escapable group before repository access. Normal
  success exits that child and releases without terminating the queue worker.
  Inherited descriptors or process-tree guesses are insufficient, and unsupported
  or unprotected hosts disable protocol-v2 local-root execution. This containment
  proves liveness/exclusion only; ACP remains explicitly unconfined for shell,
  network, credential, and filesystem security.

  The initial supported boundary is Ubuntu 24.04/Linux 6.8+ with unified cgroup v2,
  systemd transient per-run scopes, separate service/worker/paired shim/run user IDs,
  restricted PID/mount/procfs views, `nosuid,nodev` project/exchange mounts, and Unix-
  domain-socket `SO_PEERCRED`. A checked-in preflight proves cgroup delegation,
  descendant containment/kill/emptiness, distinct identities, peer credentials,
  protected state/socket permissions, setid/capability rejection, proc/ptrace/
  signal isolation, non-dumpable shim, and restart recovery before the instance may
  advertise the adapter. macOS, Windows, non-delegated containers, and same-user
  development mode remain protocol-v2 local-root disabled pending an equivalent
  reviewed adapter.

  Reservation transactions are disjoint from the entity order. With no database
  locks, they acquire shared locks on every strict canonical ancestor and an
  exclusive candidate-root hierarchy lock. Then every plan/materialize/cleanup/
  new-project bind transaction locks epoch → connection-authenticated fresh root-
  writer instance → active binding generation/rotation → host hierarchy guard →
  reservation, validates/pins writer credential generation, and fails stale/
  draining/wrong-principal/key writers before filesystem work. Final new-project
  bind inserts the project and promotes the hierarchy claim, with no task/package/
  run locks. Existing rootless attachment or repoint to a missing destination is a
  distinct entity-first branch: after external fences it locks existing project →
  affected tasks/packages/decisions in S3 order → epoch → authenticated writer →
  generation/rotation → hierarchy guard → reservation, then atomically advances
  the root revision, performs S3 negative reconciliation for repoint, promotes the
  binding, and marks the reservation bound. Reservation-only plan/materialize/
  cleanup never request a project row; no other entity-first path acquires one.

  Existing-root create, repoint, tombstone, recursive cleanup, and every filesystem-
  management path use the same fence. A nonexistent destination first uses a
  durable reservation and prefix-aware hierarchy fence derived from authoritative host +
  binding-key fingerprint + canonical existing parent identity + normalized
  missing suffix. The route holds it across `planned|materialized`, physical fence
  acquisition, and atomic binding. Loser/crash cleanup requires both reservation
  token and created-object identity plus proof of no descendant reservation/
  binding; mismatch becomes `cleanup_required`, never recursive deletion of a
  reused or nested root. Repoint takes old/new references in canonical hierarchy
  order, revalidates top-down, and cannot commit during a pinned claim, live lease,
  `awaiting_review`, active effect, unproven containment quiescence, any recognized
  S3/S4/local-effect hold, stale/mismatched task aggregate, host review, or working-
  tree/Git-control/Git-storage review on terminal or nonterminal tasks.
  Root cleanup uses typed maintenance intent. Repoint advances the binding and
  invokes S3's `project_root_repoint` negative reconciler before commit. Deletion
  reuses `projects.archived_at` as the sole tombstone, atomically cancels every
  nonterminal task/package with bounded `project_removed`, clears only the live
  path/hierarchy binding, and retains rootRef, tasks, packages, runs, audits,
  artifacts, actions, alerts, and resolutions. Queue/progression/all-mode claims
  reject archived projects; normal queries hide tombstones and hard purge is forbidden pending separate
  retention/export architecture. No code waits for an external fence while holding
  database locks.

  A submitted response then activates monotonic effect intent/stage under the
  already-held fence. Ownership and root binding are rechecked before sandbox,
  validation, host apply, repository/completion preparation, and every atomic file
  replacement. A run-scoped host-apply ledger records each validated output entry
  `planned → applying → applied`; recovery maps crash-left `applying` to `unknown`.
  A live owner whose replacement may have succeeded but whose `applied` persistence
  fails must also durably map to `unknown` under the fence before terminalizing; if
  PostgreSQL is unavailable it remains active for recovery.
  Same-host recovery retains stale W1 as immutable claim history. The protected
  service first mints a single-use signed/MACed challenge bound to run/evidence,
  W1, proposed W2, root/group, recovery epoch, and expiry after kernel-peer
  authentication. A top-down transaction locks W1/W2 ascending after the epoch,
  requires W2's dedicated database principal to equal `current_user`, proves its
  host/key/protocol/service/adapter generation equals the run and (for
  `active|quiesced`) intent host, and stores only challenge digest plus election
  lease; same-ID/principal takeover is forbidden and `not_started` has no intent
  host. After commit the service verifies the database election through the single
  selected trust path: a service-only, separately revocable `NOINHERIT` certificate
  principal with `SELECT` only on a fixed security-barrier committed-election view.
  It uses pinned TLS, fixed `search_path`, read-only `READ COMMITTED`, and an exact
  election-ID/challenge-digest query; workers/maintenance cannot access the
  credential or view. The view returns only the matching committed, unexpired
  election tuple plus a nullable committed receipt fingerprint/version; it does
  not claim to observe protected-service burn state. Reader outage/revocation
  fails closed without burning. The service atomically test-and-burns its protected
  challenge while durably storing one replayable tuple-bound receipt, then returns
  it. A second database compare-and-set stores the fingerprint; the service
  re-queries that exact committed receipt fingerprint/version and checks its own
  unexpired receipt before idempotently granting takeover once. Crash/replay
  boundaries resume that exact election and never grant DB-only or service-only
  authority. If both database recovery lease and committed receipt expire before
  takeover, the service may first prove no takeover was granted, atomically retain
  an `expired_ungranted` protected receipt tombstone, and mint a challenge bound to
  that tombstone and a greater recovery epoch. A top-down compare-and-set appends the
  matching database election tombstone and installs the greater-epoch candidate;
  the view and service reject the old receipt/owner. Already-granted takeover cannot
  be tombstoned or re-elected, so expiry permits progress without concurrent W2s.
  Wrong/missing/stale/draining/divergent-key/insufficient-containment/unreachable
  W2 or fabricated/cross-run/expired/replayed challenge is alert-only.
  Underlying lock acquisition alone is insufficient, and state remains actionless
  until the adapter proves the complete per-run group empty and W2 revalidates its
  pin in the top-down transaction.
  A separately credentialed non-worker watchdog periodically finds expired local
  evidence leases with zero eligible recovery worker and writes one deduplicated
  bounded alert; worker heartbeats are not the only producer. Its only mutation is
  zero-argument `forge.forge_alert_unavailable_recovery_worker()`, a non-login-owned
  `SECURITY DEFINER` function with fixed `pg_catalog,forge,pg_temp` search path,
  fully qualified objects, `PUBLIC` revoked, and no caller IDs. Immutable
  `session_user` plus database state select the row; the watchdog cannot SET ROLE/
  session authorization and has only bounded-view SELECT/function EXECUTE, with no
  direct DML, heartbeat, claim, fence, repair, credential, or repository access.
  Failure records one
  bounded quiescence alert. Ledger paths/errors/resource
  references never enter packet-owned evidence. A submitted crash may retain a
  lease/worker failure code while host-ledger or repository-change evidence forces
  fingerprint-bound working-tree review.

  A valid or known-but-incoherent `metadata.packet_issuance` or
  `metadata.packet_integrity_hold` marker is an absolute S4-owned guard before
  generic candidate selection, admission refresh, readiness promotion, and
  package claim. Direct progress, sibling continuation, and
  periodic sweeps cannot clear or bypass it even when current grant coverage is
  allowed. Only S4's exact recovery route or the S3→S4 one-time resolver may
  clear `packet_issuance`; both reject `packet_integrity_hold`. Only the separately
  authorized fingerprint-bound privileged repair command may clear an integrity
  hold.
  Packet-independent `metadata.local_effect_recovery` is guarded at the same seam
  and carries only generic local-evidence identity/fingerprint plus
  `review_local_changes|acknowledge_possible_local_invocation|retry_local_execution|
  decline_local_retry`. The generic local route or
  privileged quarantine is its only owner; packet actions and generic readiness
  cannot clear it. Packet and local markers may coexist without either owner
  clearing the other.

  Stale recovery first discovers candidate generic local-run evidence and optional
  packet-audit IDs without retained row locks. Each
  candidate is then processed in a fresh top-down transaction; it never locks an
  audit/approval and reaches backward. The transaction compare-and-sets a still-
  expired local claim and optional packet claim, invalidates the tokens, fails the
  linked run and clears only that run's execution lease. Changed/unverifiable
  evidence creates local review whose next disposition is derived from the locked
  generic invocation state. Exact unchanged/not-applicable packet-free/handoff
  evidence creates explicit `retry_local_execution` only for
  `definitive_not_started`; `invoking|returned|uncertain` creates
  `local_invocation_uncertain` with `acknowledge_possible_local_invocation`.
  Packet-bearing work
  with no local barrier creates only its issuance block. Pre-quiescence remains
  running/actionless behind the resource fence. The transaction
  atomically persists terminal generic evidence plus optional audit/artifact. One
  database-owned aggregate recomputes the task's versioned local-change projection
  from the eight fixed current-authority heads per sibling package; immutable local-
  run/review/hold history is outside input cardinality. A deferred cross-row
  constraint validates every head/task mutation, and every all-mode claim relocks/
  recomputes the exact head set so stale zero/null cannot pass. It locks every sibling
  package in ascending order and returns task `running → approved` only
  when no sibling has a live execution lease or `awaiting_review`; otherwise the task remains `running`
  and recovery has no action until the shared S3/S4
  `reconcileOperatorHoldTaskDisposition`, invoked after sibling lease/review release
  and at startup/periodically, validates at least one recognized filesystem/packet/
  integrity/local-effect marker and moves only `running → approved` without
  promoting any marker. An S3-only task never requires an S4 marker. An
  `allow_once` nonce stays burned; an `always_allow` run claim can
  start a new operator-requested run only under current project coverage. Every
  existing generic stale-package path first checks for a linked v2 issuance claim;
  packet-bearing runs delegate by audit ID to this top-down transaction and never
  clear leases, write generic stale markers, or publish terminal events separately.
  A compare-and-set miss is handled only after proving run/package terminal and the
  lease cleared. A seeded terminal-audit/live-package split first requires exact
  typed audit/artifact tuple equality. Terminal failure repair copies the immutable
  failure object/delivery into the marker. Terminal success creates no failure
  marker and may reconstruct success only from matching completion,
  repository-evidence, and every required review-gate materialization (or proof no
  gate is required); missing/mismatched evidence
  enters typed packet or generic-local integrity hold that fails only the live run, clears its
  lease, blocks the package, exposes no recovery action, and requires separately
  authorized privileged repair. Release/DevOps owns one deduplicated bounded
  integrity alert, `docs/operators/local-execution-integrity-repair.md`, privileged
  `local-execution-integrity:inspect|resolve -- --alert <id>` commands, fingerprint compare-and-set, and
  append-only resolution evidence. Resolution never rewrites immutable packet
  evidence. The privileged interface is exactly:

  ```text
  npm run local-execution-integrity:inspect -- --alert <id>
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution verified_success
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution verified_failure
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution projection_recomputed
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution generic_failure_reconstructed
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution quarantined_abandoned --expected-sibling-evidence-set-fingerprint <digest> --repository-disposition reviewed
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution quarantined_abandoned --expected-sibling-evidence-set-fingerprint <digest> --repository-disposition abandoned
  ```

  No optional `--apply`, implicit resolution, or omitted fingerprint form exists.
  The two quarantine commands require both the complete alert/hold fingerprint and
  canonical sibling-evidence-set fingerprint plus an explicit literal
  `reviewed|abandoned` disposition; the command cannot derive those inputs from
  mutable current state. Packet audit is optional. Evidence-present alerts require the exact
  generic row; `missing_local_evidence` instead stores a nullable generic foreign
  key plus immutable run/package/task/project claim identity and an expected non-FK
  evidence ID, so absence itself can be persisted without inventing a row.
  Owning-host W2 terminalization writes service-authored `quiescence_proven` bound
  to its receipt/recovery epoch/final fingerprint, so packetless alerts close
  truthfully. Verified success/failure requires the exact coherent predicate. A
  proven immutable audit/artifact mismatch that can satisfy neither has one
  privileged `quarantined_abandoned` adjudication: under the complete order and
  only with no live lease/review/effect, bind every affected sibling marker,
  baseline/change fingerprint, host-ledger fingerprint, and review disposition
  into one sibling-evidence-set fingerprint. Each review is complete or the
  privileged resolution explicitly records repository disposition `abandoned`.
  Then append the resolution, cancel the held package and remaining nonterminal
  siblings, and close the task as cancelled. It retains alert/hold/audit/artifact/
  run evidence and creates no retry action. Terminal task state alone never clears
  the repository-management barrier; unresolved evidence continues to block
  every packet, packet-free, and handoff-only sibling claim plus
  repoint/tombstone/reuse. Normal exact review or privileged quarantine recomputes
  the task barrier under the same locks.
  Reason-specific resolution permits projection recomputation only from a complete
  coherent source set, generic failure reconstruction only from an evidence-present
  immutable tuple, and quiescence closure only from service-authored proof;
  missing evidence or irreconcilable immutable state requires evidence-preserving
  quarantine. Other unproven state remains held. Repair never resubmits or turns immutable
  success into retryable failure.
  Only truly root-free/no-effect runs may retain legacy generic recovery; packet-
  free/handoff local-root runs use the same authenticated W2/quiescence/comparison/
  review lifecycle without packet evidence. Review-required no-packet work advances
  after review to the stored invocation-dependent disposition. Unchanged
  `definitive_not_started` work starts at explicit retry; unchanged
  `invoking|returned|uncertain` work starts at possible-invocation acknowledgement.
  Neither branch is automatic. Every
  versioned `packet_issuance` marker has `autoRetryable:false`, immutable terminal
  delivery, separate disposition/acknowledgement fields, fingerprints, and bounded
  failure code. The normative matrix is: one-time +
  `not_exposed|submission_failed` → `reapprove_allow_once`; one-time +
  `submission_uncertain|submitted` → `review_then_reapprove_allow_once`;
  always-allow + `not_exposed|submission_failed` → `retry_execution`; and
  always-allow + `submission_uncertain|submitted` → `review_submission`.
  Review precedence is independent: any host/repository `review_required` marker,
  including definitive `submission_failed`, first exposes only
  `review_local_changes` with a deterministic next disposition. That exact action
  completes matched local reviews without changing delivery; uncertain/submitted
  work then separately requires `acknowledge_possible_submission`.
  Every marker reader/action joins the exact prior audit/artifact and generic
  local-run record, proves their typed terminal tuples equal, joins working-tree/
  Git-control/Git-storage comparison/review plus host-ledger fingerprints, and binds the marker identity to
  that failed tuple. Missing, mismatched, or success-plus-failure-marker evidence is neutral,
  non-retryable, and actionless. A marker carries independent fingerprinted
  `not_applicable|review_required|reviewed` host-apply, working-tree, Git-control,
  and Git-storage review unions plus their combined action fingerprint; audit-level
  repository review has no `abandoned` state. Local-change
  review and possible-submission acknowledgement never change delivery and are
  separate append-only actions. Retry/reapproval cannot enable a
  new claim while review is required or the ledger fingerprint changed.

  S4's generic local-effect route is the sole owner of local review,
  possible-invocation acknowledgement, retry, and ordinary decline, keyed by
  `{localRunEvidenceId,evidenceFingerprint}` and the generic action ledger. It uses
  the full order through generic evidence before optional audit. Before any action
  it proves routed task/package ownership of the exact run/evidence, task
  `approved`, package `blocked`, the exact marker/fingerprint, no live sibling
  lease or `awaiting_review`, no integrity hold, and the canonical task projection.
  Only exact review may consume the nonzero projection made solely from the reviews
  it owns; every other action requires zero. Exact replay for all four actions is
  ledger-first and returns the recorded result before requiring a still-present
  marker. Exact packet review
  atomically clears only the local marker and advances the dependent packet marker
  to its stored next disposition; exact no-packet review rotates to its stored
  `retry_local_execution|acknowledge_possible_local_invocation` disposition.
  The local marker union has separate pending-acknowledgement and acknowledged-
  retry `local_invocation_uncertain` arms. Both retain the immutable invocation
  attempt ID; the latter alone requires non-null acknowledgement actor/time.
  Fingerprints commit to reason/disposition/review, invocation state/attempt, every
  local review, and the acknowledgement null-or-actor/time tuple. Acknowledgement
  preserves uncertain invocation evidence, rotates into that schema-valid
  acknowledged arm, and only enables the later retry choice; invalid mixed fields
  fail closed. Retry moves `blocked → ready` only under a
  server-computed eligible ordinary retry policy revision/fingerprint. The decline
  action may close coherent reviewed work—including uncertain invocation—without
  forcing acknowledgement; it cancels the package through sibling-aware terminal
  policy, preserves evidence, and creates no run or wake. No local action writes
  the issuance ledger.

  S4 owns a packet-recovery route and append-only
  `filesystem_mcp_issuance_recovery_actions` table. The route locks project → task
  → every sibling package in ID order → decision → protocol epoch → historical
  claim/current recovery worker instances ascending → active binding generation/
  rotation → hierarchy guard → prior run → generic local-run evidence/task source
  set → audit → host-apply ledger/entries → all applicable artifacts by stable key
  (including the exact packet artifact) → generic then packet action rows → integrity
  alerts/resolutions → review gates, accepts a version-2 request carrying
  `{action, priorRuntimeAuditId, markerFingerprint}`, binds that identity to the
  routed task/package, CAS-validates the marker/prior audit, and records only
  `acknowledge_possible_submission|retry_execution|decline_packet_recovery`;
  acknowledgement remains available even if current grant coverage was later
  revoked. Ordinary decline requires quiescent local evidence and completed exact
  reviews, but neither current grant coverage nor possible-submission
  acknowledgement; it cancels the package, preserves delivery/evidence, and
  creates no run or wake.
  A separate always-allow `retry_execution` transition accepts either the same
  revision/coverage or a greater effective decision revision that exactly covers
  an unchanged package policy, but only when that decision's root-binding revision
  equals the locked project. A repoint revokes state one; only explicit reapproval
  can authorize a new run on the new root, and the action records prior/current
  root revisions. The canonical S1
  `readEffectiveGrantState` returns `phase:'approved'`, `source:'project-level'`,
  and `grantMode:'always_allow'`, with the locked matching project decision
  supplying the revision/fingerprint. Snapshot source `project_always_allow` is a
  separate historical vocabulary. This
  preserves the S3 denial-wins rule for equal/newer package denials. The latter is explicit operator reauthorization after
  grant replacement, never automatic retry. It records prior and authorizing
  revision/fingerprint evidence in the append-only action row, clears only the
  packet marker, moves `blocked → ready`, commits, then wakes Redis; the normal new
  claim snapshots the current decision. Missing, older, unknown, narrower, or
  policy-changed decisions fail closed. For one-time reapproval, S3 rotates
  the fresh nonce after locking every sibling package and calls S4's package-
  scoped resolver in the same transaction; package scope limits grant evaluation,
  while sibling locks enforce mandatory review. The resolver continues to prior
  protocol epoch → authenticated instances → active binding generation/rotation →
  hierarchy guard → run → generic local evidence/task current-head set → audit → host
  ledger/entries → all applicable artifacts by stable key (including the exact
  packet artifact) → generic then packet recovery actions → integrity alerts/
  resolutions → review gates, proves
  canonical typed audit/artifact equality, verifies the prior terminal marker, and writes append-only
  `resolve_after_allow_once_reapproval` evidence for the new approval decision,
  and clears only packet state atomically. Unresolved generic local evidence/
  review/task projection keeps the package blocked and creates no wake. It requires
  no active lease or sibling `awaiting_review`.
  Generic local review/retry writes only the generic ledger; possible-submission
  acknowledgement, packet retry, and one-time resolution write only the issuance
  ledger. Each ledger is checked before requiring a still-present
  marker. An exact replay of the same routed version-2
  `(audit, action, marker fingerprint)` request returns the recorded HTTP 200 result
  with no second mutation/wake; only a changed
  fingerprint or unmatched durable state returns 409. Double/stale/policy/lease
  races are compare-and-set or idempotency-ledger outcomes. The marker never
  reuses `mcpGrantBlock`/`mcpBroker` or persists a path/reason.

  Before the first packet-selection or repository-content read, the live exact
  owner persists `state:'assembling'` with a random attempt ID and database time.
  Immediately after assembly and **before any exposure**, that same owner
  compare-and-sets an immutable `state:'assembled'` snapshot with opaque non-path
  `rootRef`, bounded counts, and closed-category redaction counts. A terminal
  `state:'not_assembled'` is allowed only with a definitely pre-assembly
  `claim|preflight` stage. Crash, owner loss, or database failure while
  `assembling` becomes terminal `state:'assembly_unconfirmed'` with stage
  `assembly`, the same attempt ID, no counts or `rootRef`, and no reassembly. Live
  `assembling` never appears in a terminal artifact. Store delivery
  separately as
  `not_exposed|submitting|submission_failed|submitted|submission_uncertain`.
  Immediately before ACP I/O, ownership-CAS `not_exposed → submitting` with a
  random attempt ID and database time. Expired/crashed `submitting` becomes
  `submission_uncertain` and is never automatically replayed. A submission failure
  never rewrites an assembled packet as unassembled, and recovery never rewrites
  `assembling` as `not_assembled`. Audit/artifact adds a
  terminal discriminant: `{status:'succeeded'}` is valid only with
  `assembled+submitted`; `{status:'failed',failureCode}` uses the closed shared enum
  `authorization_changed|execution_lease_expired|local_evidence_lease_expired|
  issuance_lease_expired|worker_stopped|preflight_failed|assembly_failed|
  submission_rejected|submission_uncertain|provider_response_invalid|
  external_repository_change_requires_review|post_submission_execution_failed`.
  An already persisted bounded stage or delivery cause is primary and is never
  replaced by a later ownership loss. Otherwise the deterministic precedence is
  `authorization_changed → execution_lease_expired → local_evidence_lease_expired →
  issuance_lease_expired → delivery/stage-specific cause → worker_stopped`, where
  `worker_stopped` is residual only. All three leases are independent and no
  heartbeat may infer one from another.
  The external-change code uses assembled/submitted plus `not_started`, no host
  ledger, and required repository review; no Forge local stage begins. The last
  code is valid only with assembled/submitted evidence and exactly one
  closed stage:
  `sandbox_apply|validation|host_apply|repository_evidence|completion_preparation`.
  A normative compatibility table constrains assembly stage, delivery, terminal
  status, failure code, and conditional stage; known-invalid cross-products fail
  closed. In that table `assembly_unconfirmed/assembly + not_exposed` accepts only
  authorization/lease causes, `worker_stopped`, or `assembly_failed`, and accepts no
  counts/`rootRef`; success still requires `assembled+submitted`. A second normative effect table requires `active` only on a nonterminal
  submitted claim; permits terminal `not_started` only when no local stage/ledger
  exists; requires `quiesced` after a stage begins; requires
  `post_submission_execution_failed.failureStage` to equal the quiesced last stage;
  forbids `applying` in quiesced state; and defines two disjoint success rows:
  no local stage is `not_started` with no ledger, while local-stage success is
  `quiesced(actualLastStage)` with every declared host-write entry `applied` and no
  `planned|applying|unknown`. Both success rows require repository comparison
  `unchanged` and review `not_applicable`; changed/unverifiable evidence always
  fails as `external_repository_change_requires_review`, even after review. Intent,
  ledger, host-review, all repository baseline/change-review fingerprints, and
  task projection must match. Same-row checks plus deferred PostgreSQL cross-row
  constraints enforce the generic-evidence/optional-packet/task predicate used by
  live/recovery finalizers, repair, backfill, and every all-mode claim; Drizzle/
  parser fixtures and S6 import the same table.
  Definitive `submission_failed` is staged atomically with
  `submission_rejected` and is not later reclassified as lease expiry. There is no
  `terminalization_interrupted` code because a rolled-back atomic terminalizer
  leaves no durable evidence distinguishing it from a worker/lease failure.
  Packet-owned persistence accepts no raw/sanitized exception detail; operator copy
  is enum-derived. One packet claim
  permits one external model/ACP submission: packet-bearing AI SDK calls set
  `maxRetries:0`, adapter/provider replay after possible acceptance is disabled,
  and after an accepted but Forge-invalid response, the
  run fails with `submitted` evidence and does not use the executor's automatic
  correction loop. Every local-root ACP invocation, including packet-free and
  handoff-only execution, is also at most once per generic local-run evidence row;
  adapter retries and the validation correction loop are disabled because the
  unconfined ACP may already have changed repository state. A later call requires
  a new explicit generic retry/new run after quiescence and comparison. `rootRef` is a
  dedicated, unique project UUID. Migration adds it nullable with no default, sets
  database `DEFAULT gen_random_uuid()` in a separate bounded-lock step, then installs
  a database-owned insert bridge that fills any remaining null and a guard that
  rejects only non-null → null. Unrelated updates to legacy null rows remain legal
  during checkpointed backfill. After zero nulls, migration adds/validates the non-
  null proof and uniqueness before `SET NOT NULL`; the default and temporary guards
  remain through that mixed-version window. It is never path-derived; preview, approval, claim,
  and artifact read the same lifetime-stable value. Rotation is out of scope
  because approved-but-unclaimed snapshots would require invalidation/reapproval.
  This public packet identity is separate from the internal host-resource/root-
  binding revision pinned by a run; permitted path edits keep `rootRef`, while
  duplicate canonical host roots fail the internal uniqueness constraint.
  Free-text repository errors, file names,
  paths, host-resource references, excerpts, and contents are excluded from packet-owned audits, artifacts,
  logs, events, queues, and APIs. Live finalization, while still holding the host
  resource fence, extends the existing ownership/root-fenced run/package terminal transaction and atomically updates
  run/package/lease, audit, artifact, recovery marker, and task disposition. A
  post-submission stage failure is not auto-resubmitted; host apply may be partial,
  so separate typed actions cover prior external work and possible local changes and
  Forge never claims rollback. Review-gate materialization/decision follows the
  complete order (decision, epoch, authenticated instances, binding generation/
  rotation, hierarchy guard, run, generic evidence/task current-head set, optional
  audit, host ledgers, all artifacts, generic/packet actions, integrity rows, then
  gates) and rereads source run/artifact, package status, and lease under the
  transaction locks before compare-and-set; gate-first locking and
  pre-transaction-only freshness are forbidden. `completion_preparation` covers
  only pre-transaction work; gate/finalizer database failure rolls back with no
  such persisted cause. A v2
  writer cannot commit terminal packet evidence with a still-running linked
  package. The partial unique artifact index supplies idempotency, not
  crash-consistency by itself. This is cooperative database fencing, not
  cryptographic exactly-once disclosure; hard cancellation still belongs to #40/#60.
- **Evidence lifecycle — planned scope vs issued evidence.** Pre-run,
  `McpAdmissionDecision.evidenceRefs` carries only opaque planned-scope identifiers
  plus capability set, never paths or file contents. The bounded read-only context
  packet is assembled during execution and requires an `agentRunId`. At most one
  packet artifact may exist for a claimed run while it remains live or unquiesced;
  exactly one exists only after coherent atomic terminalization, or after an
  authorized repair proves the complete predicate. An unavailable-host claim has
  zero terminal artifacts, and this contract makes no liveness promise when
  containment emptiness or an authoritative same-host recovery worker cannot be
  proven. The idempotent terminal artifact is an `artifacts` row with:
  `artifactType:'mcp_bounded_context_packet_metadata'`, linked by
  `artifacts.agentRunId`, with `content` containing the versioned, human-readable
  metadata summary and `metadata` containing `{schemaVersion:2, workPackageId}` plus
  immutable authorization, assembly, terminal delivery, and terminal
  success/failure snapshots. A live
  `submitting` value exists only on the current audit and is converted to
  `submission_uncertain` before terminal artifact finalization. Assembled runs carry
  opaque `rootRef`, included/byte/omitted counts, and closed redaction counts;
  pre-assembly failures carry a bounded stage plus the terminal failure code and no
  fabricated counts.
  `(agentRunId, artifactType)` is the stable lookup contract; retry/upsert behavior
  must not create duplicates for one run. S4 owns a database migration adding a
  partial unique index on `(agent_run_id, artifact_type)` where
  `artifact_type = 'mcp_bounded_context_packet_metadata'`; this preserves existing
  artifact types that legitimately have multiple rows per run. The writer uses a
  conflict-safe insert/upsert whose PostgreSQL/Drizzle conflict target repeats the
  matching partial-index predicate (`targetWhere` or equivalent), and
  `web/db/schema.ts` declares the same partial unique index. A concurrent-finalizer
  test proves one row survives. S5 queries this artifact relationship directly—no
  `agent_runs` metadata column or migration is introduced. The artifact
  contains packet **metadata** only (opaque root reference, included file count, byte
  count, omitted count, and redaction summary—the ADR 0008 audit vocabulary without
  a persisted host path). File names and
  relative/absolute paths are not persisted because they can disclose sensitive
  structure even without contents.
  **File contents stay prompt-only and are not persisted**; "selected excerpts" are
  not written to an inspectable artifact. `mcpCapabilityList` imports
  `mergeCapabilityFields`; executor filesystem gating uses shared
  `coverageKeysForGrant`/`classifyCapability`.
- **Additive rollout is part of the guarantee.** First deploy the separately
  landable Step 0 bridge project-removal route that rejects hard delete (or archives
  safely) before filesystem work, disable project-management ingress, and drain every pre-
  bridge process/session. The Step 0 retention migration replaces evidence-bearing project cascades with
  `RESTRICT|NO ACTION` and installs the database hard-delete guard. Only after those
  postconditions may #178/S3 land. Keep project-management ingress closed. Only
  after #178/S3 passes may remaining S4 expansion begin. Add nullable project
  `root_ref` with no default; set `DEFAULT gen_random_uuid()` separately under a
  measured lock while ingress remains closed;
  install a narrow database-owned `BEFORE INSERT` bridge that fills any remaining
  null (including explicit null) and a `BEFORE UPDATE OF root_ref` guard rejecting
  only non-null → null. The guard allows unrelated updates to existing null rows.
  Install the expansion journal/trigger while ingress is still closed. Only after
  the default, insert bridge, re-null guard, journal, and their database tests are
  committed may legacy project ingress reopen exactly once and the mixed-version
  journal window begin.
  Build the unique non-null index concurrently, then use a durable primary-key
  checkpoint for bounded restartable backfill that changes only still-null
  `root_ref`, with lock/statement timeouts plus disk/WAL preflight. After zero nulls,
  add/validate the non-null proof and uniqueness before a short final `SET NOT NULL`;
  only then remove temporary triggers/proof. Omitted and explicit-null inserts,
  unrelated updates before their batch, re-null attempts, and concurrent old-writer
  crash/races are mandatory. Also add explicit
  unbound root revision `0`, host/key/maintenance/archive audit fields, the live
  `archived_at IS NULL` exact-root index, hierarchy claims/guard, writer-pinned
  missing-root reservations, database-maintained task local-change projection
  (`version INTEGER NOT NULL DEFAULT 0` plus nullable source-set fingerprint, where
  version 0/null is non-authoritative until aggregate backfill),
  generic local-run evidence, recovery-instance/service-receipt fields, versioned
  key-generation/owner-shadow rotation rows, monotonic expansion-window project-
  root journal, per-incarnation worker/root-writer principal registry with unique
  principals/protected heartbeat, epoch-2 membership audit, service-only committed-
  election read view/principal, host ledger, recovery/integrity tables, working-
  tree/Git-control/Git-storage evidence, epoch
  singleton, package claim pins, and the
  `running` transition trigger. The additive schema also owns authoritative
  authorization JSON/scalar mirrors plus immutable validator/guard and retained
  scoped approval FK; append-only Architect plan versions/entries/history-read
  audits plus the non-text artifact-header guard; exactly eight preallocated heads
  from shared `CURRENT_LOCAL_PROJECTION_HEAD_KINDS` per package, the 256-package/
  2,048-fixed-head cap, migration hold/remediation, and mutation-generation dedup/
  direct-DML guard. The generic pinned signer/durable-evidence/short-lived-
  transition-authorization/consumption substrate,
  checked-in verifier, dedicated principals, recorder, transition-identity guard,
  and disabled enablement singleton are already installed by Step 0 and are imported
  unchanged. Every Step 0/S3/S4/S5/S6/enablement graph or required-evidence row uses
  non-null lifecycle-valid Ed25519 key/generation/domain/envelope/signature fields;
  there is no database-derived, maintenance, or nullable-signature arm. Canonical
  transition identity is unique over manifest version, node-or-evidence kind,
  owner, exact builds, reviewed SHA, epoch-or-none, and canonical predecessor-set
  digest, so alternate receipt IDs/nonces cannot duplicate one transition.
  Keep the root default for old writers through the
  mixed window, backfill/verify every task projection through the database
  aggregate, and finish `s4_expand` only after `root_ref` is unique and NOT NULL.
  Add the two and only two database-owned plan-text readers—the audited human
  history reader and package-bound one-entry resolver—plus the dedicated ACL
  history route/read audit, non-text artifact headers, generic API/SSE/event/log
  filters, and dual application-level compatibility readers that make
  `architect_plan_entries` the only plan-text source and suppress
  legacy unkeyed prompt digests to exact count-only
  `{kind:'unknown_legacy_digest',byteCount}` or absence. No second text store is
  created. The release-pinned PostgreSQL 16 aggregate benchmark must retain p95 <=
  40 ms and p99 <= 100 ms over 1,000 warmed maximum-cardinality validations.
  Every v2 producer remains disabled through S5 deployment and both S6 gates. Do **not** enable the
  project-root trigger while legacy project routes remain live.

  Deploy dual S4 readers that keep legacy approvals non-issuable and legacy audit
  defaults `unknown_legacy`; deploy v2 processes as authenticated `candidate`,
  protected fence/containment service, and root routes disabled at epoch 1. The
  database rejects all three protocol-2 package modes before activation; a process
  flag is insufficient. The `s4_producers_disabled` step keeps every v2 writer,
  queue/project ingress, and packet issuer disabled, revokes the v1 web/root-writer
  database credential, terminates sessions, revokes legacy Redis publish/write
  credentials, closes old SSE subscriptions, and drains old web, worker, root,
  event-publisher/subscriber, and genuine pre-trigger processes. Capture the journal watermark only after credential
  revocation/session termination, then run exactly
  `npm run project-roots:reconcile-expansion -- --through <generation> --actor <operator-id> --apply`;
  binding/activation rejects any missing generation, missing outcome, or outcome
  outside the closed `insert|root_update|archive` vocabulary. Next run
  `npm run project-roots:bind-v2 -- --actor <operator-id>` and inspect its exact
  dry-run result, then run
  `npm run project-roots:bind-v2 -- --actor <operator-id> --apply`; with no database
  locks it acquires hierarchy/resource fences and compare-and-sets positive,
  non-overlapping bindings without upgrading legacy approvals. Duplicate, alias,
  ancestor/descendant, unbound, or maintenance rows remain audited blockers. With
  ingress still disabled, enable the project-root trigger; at epoch 1 it rejects
  root mutations and never calls S3. Before the `s4_producers_disabled` receipt,
  run the deterministic plan-version/entry migration. In each transaction it
  writes protected entries and replaces raw artifact content/metadata with the
  non-text header; ambiguous input becomes history-only and blocks recomputation.
  Then remove raw `promptOverlay`, `requirementContexts`, and `mcpAwareSubtasks`
  from runtime work-package metadata/API projections and create eligible references
  only from exact protected entries plus canonical bindings. Before drain, the sole
  compatibility reader recursively hides every closed prompt alias whether its
  value is a string, object, array, or nested message structure. After drain, the
  same bounded checkpointed fingerprint-CAS scrub deletes those alias/value pairs
  and legacy unkeyed `sha256` prompt snapshots or maps them only to
  `{kind:'unknown_legacy_digest',byteCount}`; it never re-keys without plaintext.
  Delete every legacy `forge:task:{taskId}:history`/`:seq` key, rotate to only the
  schema-allowlisted `forge:task-events:v2:{taskId}:history`/`:seq` namespace, and
  cursor-scan for zero old keys and zero plan/prompt/content/locator/sentinel values
  in v2. A revoked publisher must fail to recreate a key. The receipt requires
  zero raw artifact/runtime text, zero old event keys/unkeyed digests, and mixed-
  version DB/API/export/live-SSE/snapshot/replay evidence; TTL expiry is not erasure.

  Only after that exact-build S4 receipt exists may #180's compatible S5 consumers
  and #181's disabled external controller/supported-host harness deploy. Neither may
  enable ingress or issuance. They import Step 0's pinned Ed25519 key/policy,
  checked-in Node verifier, and dedicated certificate-authenticated `NOINHERIT`
  `forge_release_evidence_writer` and `forge_release_transition` principals;
  remaining S4 does not deploy or widen them. General application roles
  receive no release-table/sequence DML or recorder/consumer execution. The Node
  verifier uses one PostgreSQL 16 transaction/connection to lock/read signer policy,
  key, canonical transition identity, nonce, receipt, and predecessor rows,
  reconstruct RFC-8785/NFC canonical
  UTF-8 bytes under domain `forge:epic-172-release-evidence:v1\0`, and call Node
  `crypto.verify` for Ed25519 while locks remain held. Only then may the fixed-
  search-path SECURITY DEFINER routine recheck every non-cryptographic predicate
  and append the immutable row before the same commit. Its unique identity covers
  manifest version, node-or-evidence kind, owner, exact builds, reviewed SHA,
  epoch-or-none, and canonical predecessor-set digest, so a distinct receipt ID or
  nonce cannot duplicate the transition. No PostgreSQL crypto
  extension or network read is assumed. A graph node or required-evidence receipt
  must be recorded while its signer key/policy is valid, but after commit it is
  durable predecessor evidence and never expires. Each state transition separately
  consumes an append-only signed `forge_epic_172_transition_authorizations` attempt
  in its distinct domain, bound to exact target/source receipts, owner/build/SHA/
  epoch/operation/controller identity, nonce, issued-at, and expires-at with lifetime
  `0 < lifetime <= 30 minutes`. An expired unused attempt stays audit-only and may
  be replaced by a newly signed exact attempt without rewriting the node; it is not
  a graph node/predecessor. The consuming transaction uses `clock_timestamp()` at
  its final statement and records the authorization ID in the consumption. The controller must then produce a fresh signed
  `s6_pre_activation_green` receipt bound to the exact S4/S5 builds and predecessor
  evidence. Missing, stale, cross-build, skipped, retried, or runner-self-attested
  evidence blocks activation.

  Verify no v1 claim remains, keep every registered S3/root writer plus queue/project
  ingress and packet issuance disabled, then run these literal commands in order:

  ```text
  npm run protocol:activate-work-package-v2 -- --actor <operator-id>
  npm run protocol:activate-work-package-v2 -- --actor <operator-id> --apply
  ```

  The first reports blockers without mutation; the second uses the privileged `READ COMMITTED`
  transaction, verifies postconditions, is idempotent, and retains the activation
  audit. Activation requires one fresh candidate host/key/principal set, protected
  fence service and non-escapable per-run containment, exact root-writer credential/ingress owner, all
  live local projects positively/hierarchically bound, no reservation/rotation/
  maintenance blocker, verified task aggregates and journal/binding audit, drained
  incompatible rows, and installed integrity runbook/commands. Its final statement
  advances the epoch/active binding-generation pointer and promotes only the audited
  candidate principals. `project-roots:bind-v2` never advances the epoch. Activation
  locks/reverifies the exact pre-activation receipt and signer state, inserts a
  unique append-only consumption, and commits `s4_controlled_activation` in the
  same transaction while every writer and ingress/issuance path remains
  disabled. With that exact epoch/build still closed, #181 must produce a fresh
  signed `s6_post_activation_green` receipt bound to the exact controller run,
  S4/S5 builds, epoch, and pre-activation receipt. Only then may one #179-owned
  audited transaction lock/reverify it plus a fresh at-most-30-minute transition
  authorization and uniquely consume it, compare-and-set the
  Step 0 singleton from `disabled` to `provisional`, store the exact operation owner,
  build, SHA, epoch, database `started_at`, and exact deadline
  `started_at + interval '1560 seconds'`, opening authorization ID/digest,
  controller login/run identity, digest of the random initial token generated and
  retained locally by that controller before the opening request, lease
  generation 1, and
  `lease_expires_at = least(started_at + interval '45 seconds', expires_at)`, then enable the registered S3/root-writer
  principals from the activation snapshot, queue/project ingress, and packet
  issuance last. Every queue claim, project route, grant wake, worker claim, root
  writer, and packet issuance boundary admits only `active`, or this exact
  provisional owner while both the database deadline and controller lease are
  live, before mutation or I/O. Receipt consumption and
  enablement roll back together; a committed receipt cannot replay. Database error,
  lease/deadline expiry, or controller death denies new ingress/issuance without lowering epoch.

  Controller leases have one byte-level construction. The external controller
  generates every raw secret as exactly 32 operating-system CSPRNG bytes.
  `CONTROLLER_LEASE_DIGEST_DOMAIN_V1` is exactly the 35 UTF-8 bytes of
  `forge:epic-172-controller-lease:v1\0` (hex
  `666f7267653a657069632d3137322d636f6e74726f6c6c65722d6c656173653a763100`).
  The stored digest is the fixed 32-byte
  `SHA-256(domain_bytes || raw_secret_bytes)`, with raw concatenation and no added
  delimiter, length prefix, conversion, normalization, or hex/base64/text round
  trip. Digest/secret function arguments and the stored digest are binary `bytea`.
  The fixed non-production vector is secret hex
  `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` to digest
  hex `9889482e88c98806a17cded064e203c3dd4108af93acb8db66a5a699d87b5947`.
  `web/__tests__/__fixtures__/epic-172-controller-lease-v1.json` is the single
  language-neutral constants/vector fixture for the controller, S4 database
  helper/migration, and S6 verifier; production rejects its fixture secret.

  The owner-only fixed-search-path
  `forge.epic_172_controller_lease_digest_v1(bytea)` rejects lengths other than 32
  and returns exactly 32 bytes. Every comparison calls
  `forge.constant_time_equal_32_v1(bytea, bytea)` after locking the singleton. The
  helper rejects non-32-byte operands, scans and XOR-accumulates all 32 byte
  positions, and decides only after the loop, with no data-dependent early return.
  Opening validates a 32-byte digest. A heartbeat accepts the 32-byte raw current
  secret and 32-byte next digest only as prepared binary parameters, hashes and
  constant-time-compares the current secret, rejects `next == current`, and then
  performs its generation compare-and-set. Tests share the fixed vector and reject
  wrong domain, 0/31/33-byte secret, non-32-byte digest, bit flip, re-encoding,
  fixture-secret production use, stale/replay, swapped controller, delayed/out-of-
  order, wrong binding/generation, and `next == current`. Two concurrent identical
  heartbeats prove exactly one advances or extends the lease. Secret scans cover
  bind capture, SQL/application logs, traces, errors, audit, inspect output, Redis,
  and database state.

  The exact controller certificate login is non-superuser `NOINHERIT` with no
  `SET ROLE`/session-authorization authority. Every 10 seconds it invokes the
  fixed-search-path, `PUBLIC`-revoked heartbeat, which derives immutable
  `session_user`, locks the singleton, and verifies operation/run/opening-
  authorization digest/controller-token digest/fingerprint/generation before
  extending only to `least(clock_timestamp()+45 seconds, expires_at)`. For each
  call, the external controller generates the fresh next token locally and sends
  the current raw secret plus only the next canonical v1 digest as prepared/
  binary parameters over its direct mutually authenticated database connection.
  The heartbeat hashes and constant-time-compares the current secret and
  compare-and-sets its digest plus lease generation to the supplied next digest/
  generation; it returns no raw token. The
  presented token is consumed; reuse, theft after rotation, delay, or out-of-order
  generation cannot extend the lease. Raw current/next tokens are never durably
  stored, audited, logged, interpolated into SQL, returned by inspect, or exposed
  to worker/writer principals. Every
  provisional boundary calls the same database gate. Lease/deadline expiry lets the
  first boundary or separately credentialed watchdog atomically change the sole
  singleton to `disabled`, clear all flags, and append one non-authoritative
  `expired_disabled` transition audit. Suite/evidence/Checks failure or cancellation
  uses the exact authenticated failure transition to append `failed_disabled`; if
  it cannot commit, the lease closes within 45 seconds. The append-only audit's
  only dispositions are
  `opened|heartbeat|failed_disabled|expired_disabled|manually_disabled|promoted_active`
  and none is gate authority.

  Operators use only these provisional-window commands and the layman-readable
  `docs/operators/epic-172-provisional-enablement-v1.md` procedure:

  ```text
  npm run protocol:inspect-epic-172-provisional-enablement -- --operation <operation-id>
  npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id>
  npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id> --apply
  ```

  Disable compare-and-sets only that provisional owner/fingerprint to `disabled`,
  closes every ingress/issuance flag atomically, appends `manually_disabled`,
  retains epoch/evidence, and cannot disable another owner or active readiness.

  After durable `ingress_and_issuance_enabled`, the controller runs the separate
  host preflight plus exact `test:mcp:contract`, `test:mcp:postgres`,
  `test:mcp:issuance`, `e2e:mcp-operator`, and `test:mcp:host-boundary` suites for
  the enabled S4/S5 builds and epoch. The no-retry enabled DAG is bounded to 660
  seconds: 60 orchestration/scheduling, 30 preflight, all five suites concurrently
  in isolated namespaces within 420, 120 teardown/out-of-band destruction-reimage/
  authoritative Checks conclusion, and 30 evidence/final transition. Ten-second
  heartbeats continue throughout; the 1,560-second deadline leaves 900 seconds of
  failure/cleanup margin. It records a separate append-only signed
  required-evidence row of kind `enabled_build_tests_green`, bound to exact
  App/key/run/job, post-activation receipt, enablement evidence, manifest/executed-
  ID/result/output-scan, teardown, and destruction/reimage digests, with no skip,
  retry, or missing ID. This evidence kind is not an eleventh graph node. One final-
  readiness transaction locks/reverifies it, the enablement row, a fresh exact
  at-most-30-minute final transition authorization, and the
  controller's signed final-readiness envelope, atomically and uniquely consumes
  both the enabled-build and `ingress_and_issuance_enabled` receipts, then appends the unique
  signed retained `s5_s6_release_ready` linking both and promotes the same unexpired
  owner from `provisional` to `active` with null expiry, clears lease/token fields,
  and appends `promoted_active`. Rollback removes both
  consumptions/readiness/promotion; absent, failed, stale, expired, or mismatched
  evidence leaves readiness absent and ingress/issuance closed. No compatible-reader deployment occurs after
  activation. The checked-in procedures are
  `docs/operators/project-root-binding-v2.md` and
  `docs/operators/work-package-protocol-v2-cutover.md`; ad hoc SQL is forbidden.
  Before routine restarts, install
  `docs/operators/work-package-instance-replacement-v2.md` and run the literal dry-run
  `npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>` followed, after inspection,
  by literal apply
  `npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id> --apply`. The separate
  maintenance principal performs bounded audited epoch-2 replacement without
  replaying activation or lowering the epoch.

  After final readiness, #179 owns the separately gated restartable post-drain
  operation/later migration exposed only through these literal commands and guide:

  ```text
  npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id>
  npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id> --apply
  npm run protocol:inspect-legacy-runtime-root-scrub -- --operation <operation-id>
  docs/operators/legacy-runtime-root-scrub-v2.md
  ```

  A path-free checkpoint retains
  operation/last-key/count/state/actor/time; applied batches are intentionally not
  rolled back, and column drop requires the support window plus a zero-remaining
  inspect result. The operation clears legacy audit paths and records only
  aggregate counts; it is not an ordinary expansion migration and never derives
  `rootRef` from a path. Dry-run, first apply, every later batch, and resume lock/
  revalidate retained `s5_s6_release_ready`, its linked consumed
  `enabled_build_tests_green` receipt, exact builds/epoch/controller identity, and
  predecessor/enablement rows; absent, failed, stale, cross-bound, or incomplete
  evidence is actionless and creates no operation/checkpoint. SQL, Drizzle, and conflict predicates must match. Rollback
  keeps additive schema/v2 data and the monotonic epoch, disables ingress/issuance,
  proves every per-run containment group empty and intent terminal/held, and never
  restarts a legacy issuer/root writer. Binding-key rotation follows the privileged
  pending-key protocol, never direct rebind. #180 reads this v2 evidence and #181
  owns mixed-version, migration, discriminated multi-lease, failure-injection, finalization, and
  rollback sentinels.
- Durable Forge control/run state and ACP working exchange move out of project
  `.forge/task-runs`. Protected service-owned state is inaccessible to ACP; the
  bounded per-run exchange has a manifest/final digest in generic local evidence.
  Sandbox-generated outputs remain distinct from host-repository writes in
  artifacts without treating same-owner mode `0700` as a security boundary.

### S5 — UI and copy hardening

- New `web/lib/mcps/admission-copy.ts` contains four pure, exhaustive surface
  presenters—`admissionPresentation`, `projectMcpPresentation`,
  `catalogMcpPresentation`, and actionless `packetArtifactPresentation`—plus typed
  `packetCurrentStatePresentation` and `localRunRecoveryPresentation` current-state
  presenters for S4's live audit/packet marker and packet-independent local
  evidence. They
  share copy primitives but accept distinct truth sources; history, health,
  catalog facts, and current packet recovery are never forced into one optional
  input shape.
- The task page presents three separate facts: historical canonical decision,
  current actionable grant/broker/live-audit/lease state, and immutable terminal
  packet evidence tied
  to one exact `agentRunId` and package attempt. Current state may show that history
  is stale; it may not relabel an older decision or artifact.
- The admission presenter validates the complete tuple before mapping it. Unknown
  legacy admission values become neutral `unknown_legacy` with no retry; this
  historical compatibility state is distinct from current-state corruption.
  Then precedence is `revise_plan` → `approve_project_filesystem_context` →
  `install_or_fix_mcp` → warning-only deferred/planning → positive allowed state.
  In particular, `bounded_context_approved` plus `status:'blocked'|'warning'` and
  `install_or_fix_mcp` is unhealthy/remediation copy, not green. Green "Context
  approved" requires `status:'allowed'`, coherent unconsumed approved grant state,
  no recovery action, and `retryable:false`.
- Phase copy imports S3's closed `FilesystemGrantHoldState` rather than accepting
  optional phase/consumed/reason fields. Never-approved/proposed/not-issued →
  "Needs project context"; denied → "Context was denied"; approved+consumed →
  "One-time context approval was already used". The exact imported
  `FilesystemGrantRevocationReason` enum maps to static copy:
  `project_grant_removed` → "Project context was removed",
  `project_grant_narrowed` → "Project context no longer covers this package", and
  `project_root_repoint` → "Project root changed — approve context again". Unknown,
  raw, path-like, credential-like, or control-text reasons become actionless
  unavailable/legacy state and are never echoed. No branch parses human reason
  text.
- `planning_only` is neutral and has no CTA. Required deferred is neutral boundary
  copy plus `revise_plan`; optional deferred is neutral with no retry. All ACP copy
  says only that Forge issued no MCP handle through its channel and does not claim
  the local ACP process lacks shell, network, or credential access.
- Add `deferred`/`planning`/`legacy` neutral buckets to `statusBadgeClass`
  (`tasks/[id]/page.tsx:1203`).
- Extend `execution-design-metadata.ts` decision type/normalizer to carry `mode`,
  `recoveryAction`, the closed imported S3 hold/effective grant-state union,
  `normalizedCapabilities`, `capabilityClasses`, `evidenceRefs`
  (`unknown_legacy` for old artifacts). Validate tuple coherence and bound arrays,
  labels, identifiers, the exact closed revocation enum, and MCP errors before
  rendering. Strip
  control/bidirectional formatting characters and secret/path detail. Untrusted
  copy is rendered only as React text, never Markdown, raw HTML, routes, or DOM IDs.
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
- Broker retry additionally requires current compatibility: task exactly
  `approved`,
  package still blocked by the same versioned marker and policy fingerprint, no
  execution, local-evidence, or issuance lease, and primary action exactly
  `install_or_fix_mcp`.
  The route locks and rechecks this predicate and returns a stale-action `409`
  without enqueueing when it changed. Setup, grant, revise-plan, and issuance
  reapproval remain different actions.
- S4 issuance recovery remains separate from broker retry. One-time
  `reapprove_allow_once` targets the package grant control; post-intent
  `review_then_reapprove_allow_once` requires acknowledgement first.
  Independent review precedence applies first: any exact host/working-tree/Git-
  control/Git-storage
  `review_required` marker—including `submission_failed`—offers only
  `review_local_changes`. That action completes matched local evidence and advances
  to the deterministic delivery/grant disposition without changing delivery.
  `submission_failed` copy says “The request was not accepted”; it never says a
  provider rejected it because local adapter/TLS/transport refusal proves no such
  actor. Local-change copy is a separate sentence.
  Possible-submission acknowledgement remains a separate later action. Every
  coherent quiescent fully reviewed packet marker also offers ordinary
  `decline_packet_recovery`, including from uncertain submission without forcing
  acknowledgement; it preserves evidence and creates no run or wake.
  Always-allow `retry_execution` is available from delivery
  `not_exposed|submission_failed` with disposition `retry_execution`, or from
  delivery `submission_uncertain|submitted` only after acknowledgement changes the
  separate disposition to `reviewed_submission`. In both cases the task is
  `approved`, package policy is unchanged, execution/local-evidence/issuance leases
  are all inactive, and the server has
  classified current authorization through canonical S1 `readEffectiveGrantState`
  as the same effective project decision or a greater effective project decision
  that exactly covers the required set. S3 denial-wins still applies to an
  equal/newer package denial. Newer coverage is explicit
  reauthorization and the action records that revision; a new run snapshots it.
  Missing/narrower/unknown coverage exposes the grant control, not retry.
  A root-binding mismatch is a structured `root_changed` revocation and says
  “Project root changed — approve context again”; S5 never compares revisions or
  displays either path.
  `review_submission` records acknowledgement actor/time without changing the
  immutable delivery after local review is complete; the later retry still
  rechecks current coverage, requires every applicable host/working-tree/Git-
  control/Git-storage review `not_applicable|reviewed`, and
  requires the verified current-version task local-change projection zero/null
  with matching source fingerprint. Every
  marker has `autoRetryable:false`; unknown/stale markers expose no action and
  S4's route rechecks under the global order.
- Every mutation control carries authoritative identity. Packet retry, possible-
  submission acknowledgement, and packet decline carry S4's version-2
  `{priorRuntimeAuditId, markerFingerprint}`; generic local review, possible-
  invocation acknowledgement, retry, and decline carry
  `{localRunEvidenceId,evidenceFingerprint}` for packet and no-packet runs.
  Components never synthesize an action-only request, and all seven handlers reject
  stale/substituted identity without mutation. A recovery marker on a task that remains
  `running` because another sibling package has a live lease renders neutral
  “Waiting for active package” without an action until the shared operator-hold
  reconciler reaches exactly `approved`. An `awaiting_review` sibling
  renders “Waiting for required review” and preserves the same action suppression.
  A sibling local-change barrier suppresses every new-run/reapproval action; only
  the marker owning the exact fingerprint may expose its applicable local review,
  acknowledgement, retry, or decline action.
- S5 imports S4's packet and generic local-effect recovery-marker unions. Every known-invalid
  grant-mode/delivery/disposition/acknowledgement/failure combination is neutral
  and actionless before presentation. The server joins the exact prior audit, all
  applicable run artifacts, required generic local-run record, host ledger, and
  all working-tree/Git-control/Git-storage comparison reviews; proves typed
  terminal tuple
  equality plus every marker/host/repository/task-projection version/source
  fingerprint; and
  validates assembly/delivery/terminal/failure-stage together; the browser never
  composes independent fields into an action. Normal audit/marker repository review is exactly
  `not_applicable|review_required|reviewed`; `abandoned` exists only on the joined
  privileged quarantine resolution. A typed packet integrity hold is
  neutral, non-retryable, and has no web CTA. Incomplete success says evidence
  needs operator repair; true audit/artifact mismatch says evidence conflicts and
  is quarantined, never promising repair. Copy names Release/DevOps and the
  checked-in integrity runbook, while privileged resolution remains outside S5.
  Generic local integrity copy consumes one server-computed, fingerprinted closed
  classification from S4's exact repair predicates. Missing evidence is always
  `quarantine_only`, uses S4's nullable local row plus expected non-FK identity, and
  is never described as reconstructable. A local-evidence mismatch is either
  `reconstructable` with the one server-selected repair resolution or
  `irreconcilable` with quarantine as the remaining path; S5 never infers
  quarantine from the mismatch reason alone. Projection mismatch similarly
  distinguishes a coherent recompute predicate from irreconcilable sources, while
  quiescence incoherence distinguishes waiting for service-authored proof from an
  irreconcilable tuple. Every open integrity state is actionless and names the
  checked-in Release/DevOps runbook without exposing its command as a browser CTA.
  `local_integrity_quarantine_closed` requires one exact joined
  `quarantined_abandoned` resolution whose alert, reason, local/expected evidence
  identity, hold/classification/resolution fingerprint, quarantine-only or
  irreconcilable classification, routed project/task/package/run/optional-audit
  identity, complete sibling-evidence-set fingerprint, and
  `reviewed|abandoned` repository disposition all match, plus cancelled task and
  package. It renders “Task closed — evidence quarantined,” preserves the records,
  and returns zero actions. Missing/stale/cross-project/wrong-reason/incomplete-
  sibling/status-only state never implies closure: a coherent original hold remains
  open, and an invalid base route becomes actionless unavailable state.
  Authorized evidence/history routes render a tombstoned project as “Project
  removed — evidence retained,” preserve its original opaque rootRef/run evidence,
  expose no former path, live-root, execution, retry, reapproval, review-gate, or
  root-management control, and never relabel it when the physical
  root is reused; normal project lists hide tombstones.
- A live audit with `status:'claiming'` and **server-computed PostgreSQL-time**
  execution, generic local-evidence, and packet-issuance leases all active is first
  normalized into one discriminated claim-state union:
  preparing=`not_assembled/not_exposed`, live-only
  assembling=`assembling/not_exposed`, assembled=`assembled/not_exposed`,
  submitting=`assembled/submitting`, accepted-finalizing=`assembled/submitted`, and
  rejected-finalizing=`assembled/submission_failed`. Local failure intent is not a
  durable live phase; preflight, assembly, provider-validation, and
  post-submission failures remain on their last persisted copy until terminal
  commit. Impossible phase/assembly/delivery cross-products fail closed. Valid current phases render actionlessly. The browser never compares lease
  timestamps or derives phase itself. An expired packet or no-packet local run with an active or
  orphaned containment lease/quiescence alert renders “Waiting for worker changes
  to stop” and no action until the protected authoritative owning-host service and
  operating-system adapter prove the complete per-run execution group empty; the
  long-lived queue worker is outside that group;
  wrong/stale/divergent-key/insufficient-containment/unreachable host evidence remains
  waiting. Schema-valid expired/partial observations use typed
  `state_pending_reconciliation` and neutral “Refreshing run state” copy until S4
  persists terminal evidence. Unknown persisted status, unsupported schema, or a
  corrupt tuple uses actionless `state_unavailable`: “State unavailable—Forge
  update or operator repair required.” A no-packet local run has the same pending/
  unavailable distinction and otherwise renders only generic quiescence/review/
  possible-invocation acknowledgement/retry/decline state: no packet counts,
  audit/artifact, assembly/delivery claim, packet retry/reapproval, or submission
  acknowledgement is invented. Direct local retry additionally requires immutable
  invocation `definitive_not_started` written by the still-live exact owner/attempt
  from the trusted typed pre-I/O refusal, plus unchanged/not-applicable working-tree,
  Git-control, and Git-storage evidence. Recovery never manufactures that state.
  `invoking|returned|uncertain` always uses `local_invocation_uncertain` and requires
  exact possible-invocation acknowledgement before retry. Every local retry also
  requires task `approved`, package `blocked`, no sibling or execution/local/packet
  lease barrier, current zero task projection, and a server-computed eligible policy
  revision/fingerprint. Exhausted or disabled policy has no retry. Coherent reviewed
  state may be declined without forcing possible-invocation acknowledgement;
  evidence remains retained.
- S4 evidence uses opaque `rootRef` or the phrase "this project", never a host
  filesystem root. S5 ignores generic artifact prose and legacy path-valued `root`
  fields and renders only validated counts, byte count, omission/redaction summary,
  and discriminated assembly, terminal delivery, and terminal success/failure from
  the run-linked artifact. Success is valid only for `assembled+submitted`,
  unchanged/not-applicable working-tree, Git-control, **and** Git-storage evidence,
  and S4's no-local-stage
  `not_started` or with-local-stage `quiesced(actualLastStage)` branch; failed
  tuples must match S4's exact stage/delivery/code table. Terminal delivery is exhaustive over
  `not_exposed|submission_failed|submitted|submission_uncertain`; live
  `assembling|submitting` never appears in the artifact, terminal `not_assembled`
  accepts only `claim|preflight`, and `assembly_unconfirmed/assembly` is the sole
  post-intent terminal uncertainty. Assembly never implies ACP
  acceptance. It never
  shows selected names, root paths, relative/absolute paths, excerpts, or contents.
- `PacketTerminalDisplayProjection` is the sole input to
  `packetArtifactPresentation`. The server constructs it only after joining the
  exact run-linked artifact to its independently identified runtime audit and exact
  terminal generic local evidence ID/fingerprint,
  host-ledger review, and independent working-tree, Git-control, and Git-storage
  reviews and validating S4's complete compatibility predicate. The projection
  imports S4's exact immutable terminal assembly, terminal delivery, terminal outcome and
  failure-code/conditional-stage types, and derives only bounded terminal effect,
  host-ledger-review, and repository-review facts from S4's closed unions. It has
  no action identity, path, selected name, content, ledger entry, exception detail,
  or free-text field; fingerprints validate joins but are not copy. Invalid or
  mismatched assembly, delivery, outcome, failure stage, effect, ledger, or review
  facts become static actionless evidence-unavailable copy. The presenter always
  returns `actions:[]` and cannot authorize any S4 mutation. Mutable packet-
  recovery marker, acknowledgement, disposition, and action-ledger state remains
  exclusively in `PacketCurrentStatePresentationInput`; it is never copied into
  the immutable terminal projection.
- When terminal artifact and current recovery are loaded together, a `server-only`
  loader performs one database observation and is the sole constructor of a
  provenance-branded joined tuple. The brand and constructor are not exported to
  Client Components, request schemas, action payloads, or presenters. The tuple
  carries the immutable terminal artifact and independently loaded exact agent-run,
  runtime-audit ID, generic local-evidence ID/fingerprint, plus the separately
  validated current projection and marker-relationship values. Browser input cannot
  supply or select any of those identities.
- The relationship validator accepts only that branded tuple. A current marker must
  match exact agent run, runtime-audit ID, generic local-evidence ID, and generic
  local-evidence fingerprint before recovery failure/delivery, host review, all
  three repository reviews, and combined review fingerprint are compared. Same-run/
  different-audit, same-run/different-evidence-ID, and same-evidence-ID/different-
  fingerprint fail closed. An absent, stale, repaired, success-incompatible, or
  otherwise mismatched marker returns terminal-only: the valid immutable artifact
  still renders through actionless `packetArtifactPresentation`, but no current
  relationship, combined copy, or request identity is emitted. A separately valid
  mutable projection remains exclusively an input to
  `packetCurrentStatePresentation`; it can render independently but cannot relabel
  immutable terminal history. Only server-produced presenter outputs cross the
  browser boundary. Loader/request-boundary and mutation tests cover direct brand
  construction, browser-supplied identities, same-run/different-audit, same-run/
  different-evidence-ID, same-ID/different-fingerprint, stale, repaired, no-marker,
  and immutable tuple mismatch cases.
- S5 imports S4's closed `PacketFailureCode` enum and maps only those values to
  bounded static copy. Unknown/future codes are neutral legacy/unknown evidence,
  never untrusted free-text operator copy. Packet evidence accepts no raw or
  sanitized exception detail. A post-submission failure additionally requires its
  closed stage; copy warns about prior external work and possible repository-state
  changes, requires exact inspection of the applicable working-tree, Git-control/
  configuration, and Git-storage/history categories, and never offers automatic resubmission
  or claims rollback. `completion_preparation` is pre-transaction only; atomic
  gate/finalizer rollback never renders that cause. Packet UI consumes only the
  host ledger and every repository comparison evidence's bounded review state and
  fingerprints, never entry paths or diffs.
  `external_repository_change_requires_review` says the Agent Communication
  Protocol runtime is not a filesystem sandbox, Forge stopped before its local
  apply stages, and exact review of the affected repository-state categories is
  required; it never says the
  provider caused the detected change, exposes no path or
  raw error and no automatic resubmission.
- S5's redaction-label and parser parity tests import
  `PACKET_REDACTION_CATEGORIES`; they render every current member and derive the
  maximum key count only from `.length`. With the current 12 members, a thirteenth
  unknown-key sentinel fails closed. No fixed category ceiling may diverge from
  S4's exported array. Terminal-projection mutation fixtures independently
  vary artifact/run binding, assembly, delivery, terminal status, every failure
  code and conditional stage, bounded effect and ledger facts, and every field of
  all three repository-review domains. Each invalid cross-product returns
  actionless unavailable copy without echoing the mutated value; type-parity tests
  fail when an S4 union grows without an S5 mapping.
- Project health action precedence is total: missing→install, disabled→enable,
  auth-required→connect, configuration-required→configure, unhealthy→fix,
  unknown→refresh, healthy→no CTA, and incoherent/future→neutral unavailable. The
  catalog presenter is static and never consumes task or project action state.
- CTA outputs are discriminated unions with required action-specific handlers or
  validated targets; setup is never encoded as retry, and invalid status/action
  pairings are unrepresentable after fail-closed normalization.
  `AdmissionPresentation.actions` is a bounded zero/one/two tuple. Two actions are
  type-restricted to packet-primary + packet-decline or local-primary + local-
  decline, always in that order; cross-family, decline-first, review-plus-decline,
  setup-plus-decline, recovery-primary-only, mismatched primary/decline request
  identity, and three-action outputs are invalid. Review-required state has review
  alone, and exhausted local retry has decline alone. Packet reapproval uses its own
  exact-identity `reapprove_packet_context` focus action rather than a generic
  approval scroll. Components render one headline-labelled action group in stable
  DOM/visual/tab order on desktop and mobile, omit the group for zero actions, and
  preserve each exact request identity.
- The project remediation fragment moves focus to a programmatically focusable
  heading. Presenter tests exhaust zero/one/two action tuples and reconstructable/
  irreconcilable/missing classifications. Current-state API/loader tests prove exact
  local closure plus stale, cross-project, incomplete-sibling, missing-disposition,
  and status-only nonclosure. Playwright tests prove primary/decline coexistence,
  labelled keyboard order, mobile order, and stale-click suppression. Runbook
  fixtures prove missing evidence is quarantine-only, reconstructable mismatch uses
  only its selected repair, and irreconcilable mismatch reaches closure only with
  the exact fingerprint/sibling evidence. Tests also cover hostile and oversized
  persisted text, future enums, and multiple attempts with separate history/current/
  evidence.
- During rollout S5 dual-reads old and new producer schemas but old/incoherent
  records remain neutral and non-actionable. Rollback removes UI code only; it does
  not reinterpret or drop S2/S4 schema, and legacy path-valued evidence remains
  suppressed.

### S6 — End-to-end regression

- S6 has four evidence layers: contract invariants, PostgreSQL integration,
  thin Playwright operator flows, and a separately trusted supported-host boundary.
  They map to five timeout-bearing suite commands, six manifest partitions, and the
  separate host preflight; no browser/database fixture substitutes for host proof.
- A local-only tiny task-tracker regression uses the real authenticated approval
  route and handoff pipeline. Prompt-only context approves and advances packages;
  missing required filesystem context returns 409; coverage lost after approval
  holds the package before claim with zero attempt/run/audit/artifact and keeps the
  task operator-actionable; restoring exact coverage commits first and Redis only
  wakes/re-drives it.
- The fixed-observation preview==approval==handoff suite covers every capability
  class, requirement field and fallback, requirement-key joins, mixed subtasks,
  prohibited/unknown/deferred inputs, legacy data, and mutation sentinels. GitHub
  planning context with materialized instructions remains allowed for healthy,
  absent, missing, disabled, unhealthy, and auth-required health observations; it
  never receives an install/fix admission action or bounded packet.
- Every packet attempt for `allow_once` **or** `always_allow` uses one run-scoped
  issuance claim/token/lease. One-time grants additionally claim and burn the
  operator decision nonce; project grants snapshot locked decision revision and
  root-binding revision plus exact coverage. S6 proves protocol-v2 task, package,
  run, and local-evidence identity is non-null and exactly equal across claim,
  audit, authorization, artifact, action, and recovery rows, so `MATCH SIMPLE` and
  nullable partial-index semantics cannot bypass scope or per-run uniqueness.
  Authorization JSONB is constructed only by the fixed typed relational function;
  direct table DML is denied, and duplicate-aware raw-input parsing rejects repeated
  lexical keys before JSON/JSONB normalization. Real PostgreSQL tests exercise both transaction orderings with
  barriers and observed lock waits. Lease comparisons use database time, not a
  mocked worker clock or sleeps as correctness proof.
  Every local-root run also has distinct execution and generic local-evidence
  ownership; packet ownership is optional. S6 races all three expiry winners and
  ties. An already-persisted stage/delivery cause remains primary; otherwise the
  fixed precedence is `authorization_changed → execution_lease_expired →
  local_evidence_lease_expired → issuance_lease_expired → delivery/stage-specific
  cause → worker_stopped`, with `worker_stopped` residual. No heartbeat may infer
  one lease from another. For each lease independently, S6 copies an otherwise
  live token/run/expiry tuple to a second database connection authenticated as the
  wrong process principal and proves heartbeat, repository-read batches, packet
  assembly, prompt exposure/submission, every local stage/file replacement, and
  finalization reject it before I/O or mutation. Possession of a token never
  substitutes for the connection-authenticated pinned instance. Packet-free/
  handoff ACP calls compare-and-set durable generic invocation
  `not_started → invoking` before I/O. Only the still-live exact owner/attempt may
  persist `definitive_not_started`, from the trusted typed `pre_io_refusal` before
  adapter process launch, serialization, socket/network, credential, or repository
  I/O; only that state plus unchanged/not-applicable repository evidence permits
  direct policy-eligible retry. A `returned` state already committed by the live
  owner remains `returned`. Orphan/stale recovery always maps a surviving
  `invoking` row to `uncertain`, including a crash after the adapter returns but
  before the owner's returned-state compare-and-set; recovery never infers
  `returned` from an external boundary.
  `invoking|returned|uncertain` requires acknowledgement before retry even when
  repository evidence is unchanged; restart never makes a second call.
  One committed packet claim makes at most one external model/ACP submission;
  packet-bearing AI SDK calls use `maxRetries:0`, lower adapters do not replay
  after possible acceptance, and accepted-but-invalid output terminalizes as
  `submitted` plus terminal `provider_response_invalid` failure without the
  executor's automatic correction loop. Wire-level
  failure injection proves one request. Generic stale-running recovery delegates a
  linked v2 claim to S4 and cannot write a competing marker/event. Direct progress,
  sibling continuation, and periodic readiness cannot bypass a packet recovery or
  integrity-hold marker via generic promotion. Pairwise packet, packet-free, and
  handoff-only claims lock/recheck every sibling and establish one running
  specialist; an `awaiting_review` sibling blocks the next claim and packet action.
- The failure matrix explicitly covers pre-approval, approved/pre-handoff,
  package-claim rollback, pre/post issuance claim, assembly, staged/pre-exposure,
  prompt submission uncertainty, every closed valid-response/post-submission local
  failure stage (including partial host apply), run-lifetime resource-fence and
  operating-system containment quiescence, missing-root reservation/create races,
  project root repoint/tombstone/reuse and alias identity,
  wrong-host action suppression,
  exact registered worker/root-writer and binding-key identity, pre-submission
  repository baseline/change review, per-entry apply intent/outcome/unknown state,
  `GIT_NO_LAZY_FETCH=1`/`git --no-lazy-fetch`, promisor/network/object-write Git behavior,
  atomic live
  run/package/lease/audit/artifact finalization, exact terminal-failure repair,
  fully evidenced terminal-success repair, typed/owned integrity alert/hold and
  permanent mismatch quarantine adjudication with complete sibling evidence,
  pre-transaction completion preparation versus finalizer rollback, Redis failure,
  restart, and lease expiry. Every row states
  package/task, nonce/claim, run/artifact, allowed automation, and required operator
  action. A claimed run has at most one typed packet artifact while it remains live
  or unquiesced. Exactly one exists only after coherent atomic terminalization, or
  after an authorized repair proves the complete predicate. Preclaim, no-packet,
  losing-worker, unavailable-host, and unquiesced-live paths yield zero; no liveness
  promise applies when containment emptiness or an authoritative same-host recovery
  worker cannot be proven.
- Task local-change projection reads exactly the closed eight-value
  `CURRENT_LOCAL_PROJECTION_HEAD_KINDS` set preallocated once per package. It never
  counts append-only history. Every terminal, review, acknowledgement, decline,
  retry, quarantine, cancellation, repair, and migration transition appends its
  immutable row and advances an existing head count-neutrally by exact
  revision/fingerprint/source-FK compare-and-set. Maximum-cardinality fixtures use
  256 packages/2,048 heads and prove every recovery path remains live within the
  PostgreSQL p95/p99 budget; a ninth/unknown/duplicate/missing/cross-package head
  and package 257 fail before claim or I/O, with typed evidence-preserving migration
  remediation. The over-limit fixture proves the exact
  `active|archive_pending|legacy_archived` whole-task archive, retaining every one
  of 257 package/evidence/head identities without reparent or delete, checkpointing
  and resuming bounded batches, and leaving the original task permanently
  unclaimable. The replacement stores exact source task,
  `pending|eligible|cancelled` state, version, and fingerprints; every boundary
  rejects pending, final source archive plus `pending → eligible` is atomic, and
  rollback/cancellation retains evidence. Separate replacement tasks admit no more than 256 packages and
  exactly 2,048 heads at the cap.
- S6 imports S4's versioned authorization,
  `assembled|not_assembled|assembly_unconfirmed` terminal assembly plus live-only
  `assembling`,
  staged delivery, terminal-delivery, terminal success/failure, the discriminated
  packet-recovery marker, effect intent, host-ledger and repository-change review
  unions, typed
  packet-integrity alert/hold, and append-only
  acknowledgement/decline contracts. It never invents enums. Durable `submitting` intent
  precedes ACP I/O; stale intent becomes `submission_uncertain`. Acknowledgement
  changes disposition/actor/time, never immutable delivery. Tests cover the exact
  one-time/always-allow recovery matrix, all generic local review/possible-
  invocation acknowledgement/policy-eligible retry/decline actions, packet decline,
  stale/double actions, revocation followed
  by restoration under a greater exactly covering decision, the S3→S4 one-time
  resolver, and S5 current-state controls. The seven exact UI-route mutation
  identities are `review_local_changes`, `acknowledge_possible_local_invocation`,
  `retry_local_execution`, `decline_local_retry`, `retry_execution`,
  `acknowledge_possible_submission`, and `decline_packet_recovery`; the internal
  S3→S4 one-time-reapproval resolver is an eighth durable identity but never an
  eighth CTA. Reapproval inserts a fresh immutable approval-decision row with a
  strictly greater project-serialized positive revision and fresh nonce and
  compare-and-sets only the separate current-decision pointer; first claim, two
  sequential reapprovals, concurrent claim/reapproval, and historical queries prove
  no prior audited decision changes. Migration parity proves the old package-unique
  history index is removed/replaced and package uniqueness lives on the pointer.
  Exact replay/stale-identity tests cover all eight. Local possible-
  invocation acknowledgement must persist actor/time, retain immutable invocation
  uncertainty, rotate the fingerprint, and expose the explicit post-ack
  `retry_local_execution` marker only under current policy eligibility; ordinary
  decline remains available. Every valid and known-invalid
  assembly/delivery/effect/terminal/code/conditional-stage/ledger/fingerprint,
  grant-mode/disposition/acknowledgement/root-binding, host-review, and repository-
  review tuple
  is tested. The shared expected table forbids terminal `active`, requires
  post-effect `quiesced`, enforces caught-stage equality and fingerprint identity,
  forbids quiesced `applying`, and permits success only with a complete all-
  `applied` ledger; PostgreSQL/finalizer/repair/parser/API/S5 must agree. Retry
  under the replacement decision is explicit, reruns canonical S1
  `readEffectiveGrantState` so an equal/newer package denial still wins, requires
  the decision's current root-binding revision, records prior/current decision and
  root revisions, and leaves prior evidence
  unchanged. Recovery requests carry the version-2 prior-audit and marker identity
  bound to the routed task/package. Exact repeated recovery actions return one
  recorded success with no second wake;
  changed fingerprint/state returns 409. S5/S6 exhaustively cover durable live
  preparing, assembled, submitting, submission-rejected/finalizing, and
  accepted/finalizing phases as a discriminated assembly/delivery union; they
  never infer a failed/finalizing worker-memory phase. The terminal/current
  presenter accepts only S5's runtime-branded server join containing independent
  terminal run, runtime-audit, and generic local-evidence ID/fingerprint plus the
  separately loaded current projection/marker. Same-run/different-audit,
  different-evidence-ID, same-ID/different-fingerprint, stale, repaired, and absent
  marker cases render immutable terminal evidence only and assert no current
  relationship; browser data cannot construct the brand. Invalid cross-products fail closed. If a
  sibling lease remains live or a sibling is `awaiting_review`, the task stays `running` and recovery is actionless
  until S4's post-sibling/periodic reconciler reaches `approved`. The failure matrix imports the exact
  closed S4 `PacketFailureCode`; no test or UI invents a code or accepts raw
  exception detail. PostgreSQL barriers also cover stale recovery against
  packet-free/handoff-only claims and finalization against stale review-gate
  decisions in both orderings. Definitive submission rejection survives a
  crash/lease-expiry race without cause reclassification.
  Further barriers prove no action from before the first repository read while the
  host fence service lease or nonempty/unverifiable containment group exists;
  project management uses namespace/ordered resource fences; wrong-host `not_started`
  recovery reads only the run pin while active/quiesced also checks intent host;
  crash-left or live outcome-write uncertainty becomes `unknown`; working-tree,
  Git-control, and Git-storage reviews are independently bound to ledger and
  baseline/change fingerprints; and
  lease/worker failure still retains local-change guidance.
  Committed-election barriers require both the database recovery lease and service
  receipt to expire, prove takeover was never granted, atomically retain the
  protected `expired_ungranted` receipt tombstone, append the matching database
  election tombstone under the top-down compare-and-set, and install only the
  tombstone-bound greater recovery epoch/candidate/challenge. Tests crash before and
  after each boundary and race the old receipt against protected-service grant,
  final database compare-and-set, replacement W2, and binding generation; stale
  receipts remain historical and never authorize. Heartbeat barriers
  prove epoch → exact instance → applicable generation/rotation ordering against
  drain, claim, activation, replacement, and rotation. The watchdog's fixed
  `SECURITY DEFINER` privilege boundary is attacked through hostile search paths,
  temporary objects, caller-selected candidate/evidence/instance IDs, parameterized
  variants, direct SQL, cross-function calls, and duplicate producers. Principal
  retirement/garbage collection crashes at login/connection revocation, session
  termination, client-certificate/private-key destruction, login-role drop, and
  immutable name/incarnation tombstone boundaries without deleting/reusing identity,
  evading live references, or hiding pending/retired resource backlog from its cap
  and alert. S6 invokes exact dry run
  `npm run protocol:gc-work-package-principals -- --actor <operator-id>` and exact
  apply `npm run protocol:gc-work-package-principals -- --actor <operator-id> --apply`,
  and verifies `docs/operators/work-package-principal-lifecycle-v2.md`. Supported-host attacks cover `nosuid`/`nodev`, setid, file capabilities,
  device nodes, `/proc/<pid>/mem`, `/proc/<pid>/{maps,environ,fd}`, descriptors,
  `process_vm_readv`, `ptrace`, cross-user signals, and attempts to assume or forge
  the distinct non-dumpable trusted-shim identity or replace/proxy/inject its path,
  environment, and arguments.
  Duplicate/replay/reapproval/success-repair/gate tests import the canonical
  version-2 lock manifest and derive its relative-edge fixture. Every production mutation declares the sequence of
  row categories it actually acquires; static validation requires that sequence to
  be an ordered subsequence of the manifest, with ascending/stable
  order within repeated categories and no undeclared/reversed acquisition. Real
  PostgreSQL barriers race every adjacent pair actually acquired for grant/reconciliation,
  all-mode claim, local/packet actions, finalizer/repair, W2 election, activation/
  replacement/rotation, and project/root-management paths in both orderings. Paths
  need not acquire inapplicable rows or a fictitious full prefix. Normal actions cannot
  clear integrity holds; privileged repair is authorized, fingerprinted,
  append-only, and evidence-preserving. Generic mismatch tests distinguish an exact
  reconstructable failure tuple from irreconcilable mismatch and missing evidence;
  only the latter two require quarantine. Exact generic
  `quarantined_abandoned` closure requires the complete sibling-evidence set,
  repository disposition, and cancelled task/package before S5 renders permanent
  closure. A true packet audit/artifact mismatch has only the exact
  sibling-evidence-set-bound `quarantined_abandoned` task/package closure and never
  becomes retryable or clears another sibling's root-management barrier.
- Packet-owned evidence uses opaque `rootRef` and counts/redaction only. Unique sentinels prove
  packet/rejected text, credentials, root/selected paths, names, excerpts, and
  contents are absent from packet metadata artifacts, audits, task/package metadata and reasons,
  task logs/exports/events, API/SSE responses, run errors, diagnostics, and queue
  payloads. Every CI output is also a leakage sink. A no-tee wrapper quarantines
  child stdout/stderr, reports, summaries, annotations, and attachments before the
  live runner channel; that channel receives only fixed status codes. Only
  schema-validated sanitized UTF-8 text/JSON regenerated from path-free tuples may
  upload after scanning. Raw logs/traces/reports, screenshots, video, Document
  Object Model snapshots, diffs, dumps, archives, and all opaque/binary formats are
  non-allowlisted, remain in the disposable VM, and are destroyed. Unknown fields,
  types, keys, parse failures, non-allowlisted files, or any seeded sentinel
  suppress the complete upload and fail the controller check. Seeded post-prompt,
  live-log, annotation, compressed-image, and video failures prove no sentinel can
  reach either the live channel or an uploaded sink.
  The only raw Architect-plan source is the append-only, ACL-protected
  `architect_plan_versions` plus `architect_plan_entries` store; the current
  `adr_text/architect_plan` artifact is a non-text header. The dedicated
  `GET /api/tasks/{taskId}/architect-plan-history/{planVersion}` route returns
  entries only after current task ACL reauthorization and a committed, text-free
  `architect_plan_history_reads` audit. Unauthorized, cross-task, and wrong-stage
  reads return no bytes. General web, worker, application, reporting, migration,
  diagnostic, maintenance, and release principals have no direct `SELECT` on the
  text tables. Real-role attacks prove only the fixed-search-path, PUBLIC-revoked
  audited human-history reader and package-bound one-entry resolver can return
  text. Both logins are non-superuser, `NOINHERIT`, cannot `SET ROLE`, and lack
  session-authorization capability. The package resolver derives its registered
  worker from immutable `session_user`. The shared human web login is not a user
  identity: that reader accepts only an opaque Forge session credential plus task/
  version, hashes and locks the live database session, derives the user, checks ACL,
  and appends the audit atomically. It accepts no user ID; the prepared/binary raw
  credential is never stored, logged, audited, or returned. Two-user same-login and
  swapped/expired/revoked/fabricated/cross-task tests prove zero-byte/zero-forged-
  audit denial. Cross-reader credentials, direct SQL, `SET ROLE`, hostile search paths,
  temporary shadow objects, and cross-task/type/stage/binding calls return no
  bytes. S6 imports S4's exact eligible-reference identity and proves
  `{planArtifactId,planVersion,entryId,contentDigest}` can resolve only for the same
  project/task, package agent, canonical requirement/capability binding, plan
  version, and entry. Cross-scope, stale-replay, and current-plan-substitution
  references fail before serialization. Raw/rejected plan text and resolvable
  artifact location are absent from general live APIs, SSE, snapshots/replay,
  Redis job/retry/dead-letter payloads, and every ordinary sink. S6 exercises S4's
  bounded post-drain persisted/Redis purge and proves purged work cannot replay,
  while the authorized history reader still returns the immutable entries and audit.
  Static source parity proves no second history source, copied runtime projection,
  or S6-created production schema exists. The normal, no-command, stderr-warning,
  and both no-op handoff prompt producers are removed. Mixed-version fixtures
  expose a legacy unkeyed digest only as exact count-only
  `{kind:'unknown_legacy_digest',byteCount}` when its bounded count is valid, or
  omit the whole snapshot. Those are the only outcomes before drain, during the
  checkpointed migration, and after post-drain completion. The migration removes
  the raw digest; alternate suppression/truncation metadata, reclassification as
  keyed evidence, and invention of a keyed value without the original bytes fail.
  Before old writers drain, compatible task-log readers hide every prompt-shaped
  front-matter key/alias. The checkpointed post-drain scrub removes historical
  string, object, array/nested, and alias forms without journaling plaintext. Seeded
  direct-SQL, task-log/API/export/SSE/snapshot/replay, Redis/queue, log, error, and
  diagnostic fixtures prove zero historical plaintext remains.
  Specialist source artifacts/sandbox/host changes are a separate output
  boundary and are not used to claim that model output cannot echo context.
  Existing prompt logging remains digest/count
  only. Role-preserving providers prove actual wire-level system-role separation;
  the ACP fake proves its flattened guidance/data representation and preserves the
  non-sandbox, non-enforcement warning.
- S6 proves #179's cross-process rollout with two disjoint fixtures: a sacrificial
  pre-bridge fixture demonstrates the old route's possible irreversible filesystem-
  first loss and is never used for retention assertions; a fresh post-bridge fixture
  proves archive/conflict before filesystem work after every old route/session
  drains, retained-evidence foreign keys become `RESTRICT|NO ACTION`, and the
  database rejects hard delete before the journal window. The rootRef migration
  adds a nullable no-default column, then installs a database-owned insert bridge
  that supplies a UUID for omitted and explicitly null inserts plus the database
  UUID default for omitted values. Tests prove unrelated updates to legacy still-
  null rows remain legal during bounded backfill, while a bound row cannot be re-
  nulled. The migration creates no pre-backfill `NOT VALID` non-null helper; it
  performs restartable zero-null/unique backfill and only after zero-null proof adds
  and validates the non-null check and sets `root_ref NOT NULL`. It then deploys additive
  root-binding/key/reservation/tombstone schema and checked-in canonical host-
  binding command, typed worker/root-writer capability registry, host ledger,
  repository baseline/change review, recovery-action/integrity tables,
  terminal/effect constraint, dual readers, non-issuable legacy decisions, neutral
  legacy preview/audit interpretation, package and project-root epoch triggers,
  disabled management ingress plus v1 database-role/session revocation and
  operational drain. The same separately landable Step 0 first installs the
  generic append-only signer-policy/key/evidence/consumption store, checked-in Node
  Ed25519 verifier, canonical transition-identity constraint, disabled enablement
  singleton, and dedicated certificate-authenticated writer/transition principals.
  That substrate imports no S3 or remaining-S4 symbol and creates no graph node by
  itself; only afterward may it record the signed empty-predecessor
  `step0_retention_bridge` receipt and enable the one S3 recorder. S6 then proves the exact ten-node
  `runtimeActivationGraph`, without collapsing code delivery into runtime order:
  `step0_retention_bridge → s3_issue_178 → s4_expand →
  s4_producers_disabled → s5_compatible_consumers_deployed →
  s6_pre_activation_green → s4_controlled_activation →
  s6_post_activation_green → ingress_and_issuance_enabled →
  s5_s6_release_ready`. Compatible S5 consumers and the disabled S6 controller are
  deployed before pre-activation green and the checked-in privileged dry-run/
  `--apply` three-statement `READ COMMITTED` activation. Every writer and ingress/
  issuance path remains disabled through post-activation green; one #179-owned
  operation then consumes the signed post-activation receipt and opens the exact
  database-owned `ingress_and_issuance_enabled` provisional owner in Step 0's one
  mutable authoritative `disabled|provisional|active` singleton. It binds exact
  owner/build/SHA/epoch, `started_at`, non-extendable
  `expires_at = started_at + interval '1560 seconds'`, authenticated controller
  login and the digest of its locally generated/retained initial secret, and a database-time controller lease capped
  at `least(clock_timestamp() + interval '45 seconds', expires_at)`, then enables
  registered writers, queue/project ingress, and packet issuance last. The
  controller heartbeats every 10 seconds through its fixed `session_user`-bound
  function. Before each direct mutually authenticated database call it generates
  the next secret locally and sends current raw secret plus next digest as prepared/
  binary parameters; the function hashes/consumes the current secret and compare-
  and-sets its digest/generation to the next digest/generation without returning raw
  token. Every governed path admits only active state or the exact provisional
  owner while both deadlines are live. Stolen/stale heartbeats fail; a suite/
  evidence/Checks/database failure atomically compare-and-sets the exact owner to
  disabled and clears all flags, while controller death denies every boundary
  within 45 seconds. Expiry/manual/failure disable and final promotion append only
  non-authoritative audit dispositions; they do not invent a second state machine.
  S6 imports Step 0/S4's one manifest-backed append-only release-
  evidence store, receipt verifier, atomic-consumption operation, and pinned
  controller signing-key lifecycle; it creates no second table, mutable readiness
  flag, verifier, graph, or key state. Durable node/required-evidence receipts use
  S4's dedicated durable-release-evidence domain; transition authorizations use
  S4's separate transition-authorization domain. Both are distinct from host-
  harness attestation and bind
  schema/manifest version, evidence kind/node, owner, exact build identities and
  trusted SHA, epoch, controller App/integration and run/job, complete predecessor
  receipt set/fingerprint, applicable suite/output evidence, signing-key ID/
  generation, random single-use nonce, and issued-at. The recorder verifies issued/
  recorded database time against signer-policy validity before immutable retention;
  there is no separate signed record-by field. Accepted
  evidence remains durable for its exact node/build/SHA/epoch/predecessors and does
  not expire between separately deployed slices. It cannot authorize its successor
  alone. Each consumer requires a separate renewable, Ed25519-signed transition-
  authorization envelope for the canonical target, exact predecessor receipts,
  current key generation/policy, controller run/job, nonce, and expiry no more than
  30 minutes after issue. An expired unused attempt remains audit and a newly signed
  attempt with a new exact attempt ID/nonce may replace its authority; it never
  replaces or duplicates a node. Only an imported lifecycle-valid pinned key may sign new evidence; every Step 0/S3/S4/S5/
  S6/enablement node and required-evidence row uses that Ed25519 arm—there is no
  unsigned or nullable-signature database-maintenance authority. Future, unregistered,
  retired/revoked, wrong-generation, and host-harness keys do not gain authority.

  S6 imports S4's exact canonical transition helper/type verbatim:
  `{manifestVersion,nodeOrRequiredEvidenceKind,owner,exactBuilds,reviewedSha,
  epochOrNone,canonicalPredecessorReceiptSetDigest}`. Completed transitions are
  unique on that identity and durable evidence receipt ID; the separate
  authorization ledger makes every authorization attempt ID/nonce single-use. A
  different fresh attempt can replace expired unused authority but conflicts if the canonical
  transition already completed. Every consuming transition locks the append-only identities, validates domain,
  key, signature, bindings, current authorization expiry, nonce, non-consumption, and predecessors, then
  records consumption plus resulting evidence atomically. Concurrent double-
  consumption has one winner; rollback consumes nothing; exact replay returns the
  recorded result; changed-kind/owner/build/reviewed-SHA/epoch/predecessor replay fails. S6 attacks
  forged, expired, replayed, cross-build, wrong-predecessor/domain/key-generation
  authorizations, required-evidence-kind substitution, Step 0 epoch-none, same-
  transition distinct receipts/nonces, a delay beyond 30 minutes, and every signing-
  key rotation boundary.

  After `ingress_and_issuance_enabled`, the external controller runs the complete
  release suites against the actually enabled build and signs
  `enabled_build_tests_green`. This is required evidence inside—not a graph node
  before—`s5_s6_release_ready`. It binds the exact enabled S3/S4/S5/S6 builds,
  trusted SHA, epoch, controller App/run/job, suite-manifest/executed-ID and output/
  teardown/destruction evidence, signing-key generation, and exact enablement
  predecessor and exact provisional owner/deadline. Before that PostgreSQL deadline,
  and while the short controller lease remains live,
  final readiness atomically inserts unique consumption rows for both that fresh
  receipt and the unconsumed enablement receipt, appends one canonically unique
  signed `s5_s6_release_ready`, and compare-and-sets the same provisional operation
  to active with null expiry/lease while appending a non-authoritative `promoted_active`
  audit disposition. All writes commit or roll back together. The enabled controller
  has one database-measured 660-second deadline from provisional start:
  orchestration/scheduling ≤60 seconds; preflight ≤30 seconds; five isolated suites
  concurrently with the slowest ≤420 seconds and
  no retries; output scan, teardown, and out-of-band destruction evidence ≤120
  seconds; verification/signing/evidence/final transaction ≤30 seconds. Ten-second
  heartbeats run throughout, and the remaining 900 seconds is safety margin before
  the immutable 1,560-second outer deadline. A phase overrun or missed heartbeat
  disables the operation. Missing,
  pre-enable, stale, forged, expired, replayed,
  partial, cross-build, wrong-predecessor, runner-self-attested, or concurrently
  double-consumed evidence, a second enabled-build receipt/nonce for the same
  transition, or an expired/disabled window records no readiness or promotion. A
  graph-parity sentinel rejects
  making `enabled_build_tests_green` an eleventh node. Only after the exact final-
  readiness receipt with that nested evidence exists may #179 run the separately
  gated root-path scrub through the dry-run/apply/inspect commands and
  `docs/operators/legacy-runtime-root-scrub-v2.md`. A denial sentinel proves epoch
  2, post-activation green, ingress enablement, or an invalid/missing enabled-build
  receipt without final readiness cannot start or resume a scrub. Readiness and
  scrub dry-run/apply/resume revalidate the exact receipt chain after rollback,
  replay, and signing-key rotation. Tests also prove a
  genuine pre-trigger process must be drained; v1-shared-first forces activation
  abort, activation-first rejects v1, and packet/packet-free/handoff-only v2 claims
  succeed after cutover. Command and later-claim tests reject zero/multiple,
  unregistered, stale, draining, incompatible, divergent-key, wrong-host, and
  undrained instance rows plus unbound/maintenance/reservation roots; one fresh
  active host pins exact instance IDs, epoch host/key, fence-service/containment
  versions, root-writer credential generation, and v2 ingress owner. They prove
  actor identity, idempotency, postconditions, exact capability audit,
  operating-system containment support, and the
  Release/DevOps integrity runbook/commands. Epoch-2 root-writer replacement must
  adopt exact old reservations/maintenance pins or retain `cleanup_required` under
  its takeover ledger before ingress. Tests invoke exact replacement dry-run
  `npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>`
  and exact apply
  `npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id> --apply`, using
  `docs/operators/work-package-instance-replacement-v2.md`. Host-key rotation uses the exact documented
  dry-run/apply/inspect/discard commands and requires coherent K1 projections,
  markers, reviews, holds, and terminal evidence; ad hoc SQL is not release evidence. Rollback
  retains the forward schema/default/ledgers/evidence tombstones, proves every
  containment group empty, disables root management, and never lowers the epoch or
  restarts a legacy root writer.
  Unsupported macOS/Windows/same-user/non-delegated hosts fail preflight with epoch
  1 unchanged, perform no v2 drain or scrub, and retain truthful legacy/pre-cutover
  presentation; the suite does not turn current beta support into a Linux
  containment claim.
- CI has five timeout-bearing suite commands enforced by a process-tree deadline
  wrapper: `test:mcp:contract` (60 seconds), `test:mcp:postgres` (240),
  `test:mcp:issuance` (300), `e2e:mcp-operator` (240), and
  `test:mcp:host-boundary` (420). The reviewed manifest has six partitions:
  contract, PostgreSQL, issuance, operator desktop, operator mobile, and host
  boundary. The four-layer mapping is contract → contract command/partition,
  PostgreSQL integration → PostgreSQL and issuance commands/partitions, thin
  operator flow → one command with desktop/mobile partitions, and supported-host
  boundary → host command/partition after separate `preflight:mcp:host-boundary`.
  Database suites run desktop-only once; operator accessibility runs
  desktop and mobile. Dedicated projects/tags and generic-project `grepInvert`
  prevent duplicate execution. Wrappers prove static expected → collected → first-
  attempt executed identity, detecting deletion, untagged tests, overlap, omission,
  runtime skips, and retries.
  In the enabled proof, orchestration is a 60-second phase, preflight is a 30-second
  phase, and all five suites run
  concurrently in isolated database/Redis/filesystem/host namespaces, so 420
  seconds is the suite-DAG maximum rather than a serial sum. Teardown/output/
  destruction has 120 seconds and signing/evidence/final readiness 30 seconds, for
  one non-retryable 660-second controller deadline with continuous 10-second lease
  heartbeats and 900 seconds of outer-window margin.

  The host job uses an ephemeral single-job signed Ubuntu image only for a trusted
  merge-queue SHA or protected manual dispatch—never `pull_request_target` or
  privileged fork code. An external controller verifies and prefetches the reviewed
  SHA, digest-pinned actions/dependencies, immutable root harness, and PostgreSQL 16
  TLS fixture before starting checkout code in a separate zero-egress user/mount/
  PID/network namespace. Only the outside coordinator retains narrow GitHub status/
  cancellation connectivity; the read-only token and all secrets remain outside.
  The controller supplies one random expiring challenge/nonce bound to run/job/SHA/
  image/boot/harness/TLS identity. The immutable root harness signs the observed
  preflight envelope. The exact checkout request/verify client is
  `verify-mcp-host-boundary-attestation.mjs`; it uses the fixed root-harness socket
  and controller challenge, writes only the signed envelope, and verifies it with
  the pinned public key. Repository code can mint neither the observed attestation
  facts nor the signature. Before running scenarios, the separate host test command
  re-verifies the same signature, pinned key, and bindings. The external controller
  verifier remains independent of both checkout clients and validates signer,
  nonce, signature, every binding, expiry, and replay before the gate passes.

  A separate external-controller-owned required GitHub Check Run,
  `forge/host-boundary-controller`, is created `in_progress` for the exact SHA
  before provisioning and remains pending after runner/test-process completion.
  Only the controller's outside-checkout GitHub App may conclude it; runner,
  workflow, checkout, harness, and cleanup credentials have no `checks:write`.
  The repository ruleset pins the required check to the exact audited App
  integration/App ID; same-name Actions or foreign-App checks cannot satisfy it and
  cause configuration-drift failure. Checkout callbacks are advisory. The outside-
  checkout coordinator signs a single-use suite-result envelope over run/job/SHA/
  image/boot, suite-manifest and executed-ID digests, first-attempt exit status,
  output-scan digest, nonce, issued-at, and expiry. It never signs incomplete,
  skipped, retried, duplicated, or unscanned execution. Success requires the
  independently verified preflight and signed suite-result envelope,
  signed teardown envelope, out-of-band VM destruction/reimage, and the controller's
  signed same-run/job/SHA/boot destruction/reimage receipt. A runner-reported green
  result never concludes the required check.

  Root-harness cleanup and its separately challenge-bound signed teardown envelope
  are best-effort evidence; nonzero residue still fails the gate. VM containment is
  owned by the external controller, whose cancellation watcher and independent TTL
  destroy the VM on success, failure, runner loss, timeout, or cancellation. A
  controller-signed destruction/reimage receipt is mandatory and prevents reuse.
  Negative tests forge/replay/expire/cross-bind both envelopes, kill runner/harness
  cleanup, forge runner success and suite-result envelopes, omit a manifest ID,
  substitute a stale output-scan digest, create same-name foreign checks, drop/
  duplicate callbacks, delay the Checks API, replay a prior receipt, and prove out-of-band destruction while the external
  check remains pending and then fails unless the complete same-job evidence set
  arrives. Only the controller retries Check Run API failure. Generic test/e2e
  remains required smoke compatibility but is not a substitute for these gates.
  Unexpected skips, budget overruns, missing diagnostics, invalid attestations, or
  missing destruction/reimage proof fail CI.
- A checked-in dimension-scoped parity sentinel compares ADR 0009 with all four
  owning issue fixtures: #178 supplies S3 lock/hold/revision/journal-handoff and the
  internal S3→S4 resolver; #179 supplies S4 leases, lock tail, evidence/actions, and
  exact rollout commands; #180 supplies current-state/action presentation; #181
  supplies the four-layer/five-command/six-partition/preflight/runner mapping. It
  asserts the seven exact UI-route action identities—including
  `acknowledge_possible_submission`—plus the internal resolver as eight durable
  mutation identities, without exposing an eighth CTA. It also imports the
  canonical version-2 manifest's relative lock edges and each production mutation's applicable-row
  sequence. The complete literal command/runbook parity set is:

  ```text
  npm run project-roots:reconcile-expansion -- --through <generation> --actor <operator-id> --apply
  npm run project-roots:bind-v2 -- --actor <operator-id>
  npm run project-roots:bind-v2 -- --actor <operator-id> --apply
  npm run protocol:inspect-local-projection-overlimit -- --task <legacy-task-id>
  npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id>
  npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id> --apply
  npm run protocol:activate-work-package-v2 -- --actor <operator-id>
  npm run protocol:activate-work-package-v2 -- --actor <operator-id> --apply
  npm run protocol:inspect-epic-172-provisional-enablement -- --operation <operation-id>
  npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id>
  npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id> --apply
  npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>
  npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id> --apply
  npm run protocol:gc-work-package-principals -- --actor <operator-id>
  npm run protocol:gc-work-package-principals -- --actor <operator-id> --apply
  npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref <opaque-secret-ref> --actor <operator-id>
  npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref <opaque-secret-ref> --actor <operator-id> --apply
  npm run protocol:inspect-host-binding-key-rotation-v2 -- --rotation <rotation-id>
  npm run protocol:rotate-host-binding-key-v2 -- --rotation <rotation-id> --discard --actor <operator-id> --apply
  npm run local-execution-integrity:inspect -- --alert <id>
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution verified_success
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution verified_failure
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution projection_recomputed
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution generic_failure_reconstructed
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution quarantined_abandoned --expected-sibling-evidence-set-fingerprint <digest> --repository-disposition reviewed
  npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution quarantined_abandoned --expected-sibling-evidence-set-fingerprint <digest> --repository-disposition abandoned
  npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id>
  npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id> --apply
  npm run protocol:inspect-legacy-runtime-root-scrub -- --operation <operation-id>
  npm run protocol:inspect-host-boundary-controller -- --run <controller-run-id> --sha <sha>
  npm run protocol:verify-host-boundary-controller-ruleset -- --repository <owner/repo> --app-id <github-app-id> --check forge/host-boundary-controller
  npm run protocol:retry-host-boundary-controller-check -- --run <controller-run-id> --sha <sha> --actor <operator-id> --expected-state failed --apply
  npm run protocol:retry-host-boundary-controller-check -- --run <controller-run-id> --sha <sha> --actor <operator-id> --expected-state timed_out --apply
  npm run protocol:rotate-host-boundary-controller-key -- --pending-key-ref <opaque-secret-ref> --actor <operator-id>
  npm run protocol:rotate-host-boundary-controller-key -- --pending-key-ref <opaque-secret-ref> --actor <operator-id> --apply
  npm run protocol:inspect-host-boundary-controller-key-rotation -- --rotation <rotation-id>
  npm run protocol:rotate-host-boundary-controller-key -- --rotation <rotation-id> --discard --actor <operator-id> --apply
  docs/operators/project-root-binding-v2.md
  docs/operators/local-projection-overlimit-archive-v2.md
  docs/operators/work-package-protocol-v2-cutover.md
  docs/operators/epic-172-provisional-enablement-v1.md
  docs/operators/work-package-instance-replacement-v2.md
  docs/operators/work-package-principal-lifecycle-v2.md
  docs/operators/host-binding-key-rotation-v2.md
  docs/operators/local-execution-integrity-repair.md
  docs/operators/legacy-runtime-root-scrub-v2.md
  docs/operators/host-boundary-controller-v2.md
  ```

  Optional-option notation, prose aliases, changed placeholders, missing commands/
  guides, or ad hoc alternatives are parity failures. Any owner,
  action, lock-edge/sequence, or literal-command drift fails before executable
  suites; source constants are imported instead of reimplementing policy.
  `quarantined_abandoned` stores the exact operator-supplied sibling-evidence-set
  fingerprint and explicit repository disposition; it never recomputes or chooses
  either after request authorization. The controller interfaces and
  `docs/operators/host-boundary-controller-v2.md` are Release/DevOps-owned and are
  the only supported inspection, exact-App ruleset verification, fingerprinted
  failed-check retry, and credential rotation/discard paths.

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
