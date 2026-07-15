# Issue #179 Architecture: Specialist Prompt and Bounded Context Evidence

Status: corrected architecture proposal; this primary document is authoritative
Issue: #179
Parent: #172
Step 0 dependencies: #176 and #177
Remaining S4 dependencies: #178's shared grant-decision ordering, operator-hold,
lock-manifest, and lock-helper contract
Canonical policy: ADR 0009; bounded packet vocabulary: ADR 0008
Downstream readers/tests: #180, #181

The GitHub issue body now carries the aligned version-2 summary. This primary
document and ADR 0009 remain the exhaustive contract; implementation must not
reintroduce the retired version-1 fields or sequencing preserved in review history.

## Objective

Deliver only canonically admitted MCP instructions and bounded filesystem context to a specialist run. Every packet run has one fenced issuance claim; an `allow_once` packet also has one winning claim for the operator decision nonce. Success, failure, and recovery produce truthful run-linked metadata without persisting raw repository contents, names, paths, or live MCP handles.

## Boundaries

- MCP admission controls only the Forge-issued MCP channel. ACP processes are not OS sandboxes and may independently possess shell/network/environment access.
- Prompt instructions cannot be treated as enforcement.
- Packet contents are prompt-only and ephemeral; artifacts contain metadata only.
- One winning per-run packet claim is guaranteed for every packet. An `allow_once` decision additionally has one winning claim per decision nonce. PostgreSQL cannot recall bytes already read or cancel an in-flight Agent Client Protocol (ACP) submission.
- Every local-root run owns the work-package execution lease plus generic local-
  evidence lease at each Forge-governed boundary; a packet run additionally owns
  its subordinate packet claim. Packet-free execution never invents that third
  predicate.
- Step 0 consumes only #176/#177 and has no #178 or remaining-S4 import. In addition
  to the retention bridge and release-order manifest, it bootstraps the generic
  signer/durable-evidence/short-lived-transition-authorization/consumption/
  enablement-state-and-audit substrate and records the signed
  `step0_retention_bridge` receipt before S3. #178 owns
  the pre-claim operator hold, project-serialized grant decision revision, and
  canonical version-2 lock manifest/helper. Remaining S4 imports those contracts
  and owns post-claim packet recovery. #180 reads the evidence defined here; #181
  proves the integrated behavior.

## Architecture layers

### 1. Runtime instruction projection

Add one pure projection over the S2 `McpWorkPackageAdmission`:

```ts
type ExecutableMcpInstructionProjection = {
  schemaVersion: 1;
  requirementInstructions: Array<{
    requirementKey: string;
    agent: string;
    mcpId: string;
    mode: 'planning_only' | 'bounded_context_approved';
    content: string;
  }>;
  subtasks: Array<{
    subtaskId: string;
    agent: string;
    content: string;
    bindings: Array<{ capability: string; requirementKey: string }>;
  }>;
  staticBoundaryWarnings: string[];
};
```

Eligibility:

- allowed + `planning_only`;
- allowed + `bounded_context_approved`;
- narrow exception: warning + `planning_only` where every capability class is planning-only.

Exclude full Architect-authored text for deferred, unknown, blocked, missing-context, unhealthy, or mixed warnings. A subtask is emitted only when every capability binding is eligible. Rejected text is not echoed into the executable prompt; emit a static Forge-authored boundary warning instead.

There is exactly one durable source for Architect-authored plan text:
append-only `architect_plan_entries` rows belonging to one versioned Architect
plan artifact. The existing `artifacts` row becomes a non-text version header; for
`artifactType:'adr_text'` plus `metadata.stage:'architect_plan'`, its `content` is
the fixed non-sensitive string `Architect plan available in protected history`
and its metadata contains only bounded version/count/digest fields. Requirement
text, `requirementContexts`/overlay text, MCP-aware subtask text, and the visible
plan body exist only as protected entry content—not in artifact content/metadata,
`work_packages.metadata`, a cache, or an event.

`architect_plan_versions` binds `{taskId, planArtifactId, planVersion}` with a
task-scoped monotonic PostgreSQL `BIGINT` version and one entry-set digest.
JSON/runtime references encode `planVersion` only as its canonical unsigned base-10
string and compare/order through the database `BIGINT`, never a JavaScript number
or lexical ordering. Every `entryId` is 1..256 ASCII characters from
`[a-z0-9._:-]`; canonical agent/subtask components are each at most 64 characters
before composition, and over-limit/invalid components reject the plan rather than
truncate or hash into an alias.
`architect_plan_entries` is keyed by that version plus a stable scoped `entryId`,
stores one bounded `plan_body|requirement|overlay|subtask|legacy_full_plan` entry,
and is insert-only with `ON UPDATE`/`ON DELETE` rejection and exact `ON DELETE RESTRICT`
parents. New structured entries use these exact IDs:

- `plan_body:000000` for the visible plan body;
- `requirement:<requirementKey>`;
- `overlay:<requirementKey>:<canonical-agent>`; and
- `subtask:<validated-subtask-id>:<canonical-agent>`.

The ID is unique only inside its `{taskId,planVersion}` scope and never depends on
the text. `requirementKey` already contains the deterministic duplicate-occurrence
suffix; subtask IDs and canonical agents must be unique in their owning fence.
Legacy migration assigns plan versions by `(architect run created_at, run id,
artifact id)` order and maps recognized fields to the same IDs. An ambiguous
legacy fence becomes one `legacy_full_plan:<six-digit-ordinal>` entry with
`projectionEligible:false`; authorized history remains available, but every
affected package blocks for explicit plan recomputation. Migration inserts the
entries and replaces the old artifact content/raw metadata in one transaction, so
there is never a committed second text copy.

Entry bytes use Unicode Normalization Form C (NFC) for every string and RFC 8785
JSON Canonicalization Scheme serialization of
`{schemaVersion:1,taskId,planArtifactId,planVersion,entryId,entryKind,agent,
requirementKey,bindingFingerprint,content}` encoded as UTF-8. `contentDigest` is
`HMAC-SHA-256(K_plan_v1, "forge:architect-plan-entry:v1\0" || canonicalBytes)`;
the row stores the non-secret key ID and digest while the installation retains the
versioned server-private key outside PostgreSQL. Key rotation keeps verification-
only keys until no retained version/reference uses them. An entry-set digest uses
the same construction over ordered `{entryId,contentDigest}` pairs. No unkeyed
text hash is exposed as a prompt oracle.

The database enforces this boundary even against direct SQL. The non-login
migration owner alone owns `architect_plan_versions`, `architect_plan_entries`,
and their text columns. `PUBLIC`, web, worker, application, reporting, migration-
runner, and ordinary maintenance roles receive no direct `SELECT`, table DML,
sequence, view, foreign-table, or function-owner privilege that can expose entry
text. No owner-bypass view, replica/reporting grant, or generic artifact function
may select those columns. Exactly two schema-qualified `SECURITY DEFINER`
functions, both owned by that non-login owner, fixed to
`search_path = pg_catalog, forge`, and revoked from `PUBLIC`, may read them:

1. `forge.read_architect_plan_history_v1(...)` is executable only by the dedicated
   certificate-authenticated human-history web **login** principal. The login is a
   non-superuser `NOINHERIT` role with no membership in the owner, resolver, worker,
   reporting, or maintenance roles and no `SET ROLE` or session-authorization
   privilege. Immutable `session_user` proves that only this web boundary invoked
   the function, but one shared login is never treated as an end-user identity. The
   function accepts the opaque Forge session credential, task ID, and plan version—
   never a user ID, role name, or ACL result—as prepared/binary parameters. It
   hashes the credential with the database-owned session domain, locks the matching
   unexpired/non-revoked `forge_sessions` row, derives the user ID from that row,
   and reauthorizes that user, task, project, artifact type/stage, and requested
   version. The raw credential is never stored, returned, logged, audited, placed in
   SQL text, or exposed to another function. The function appends the bounded
   `architect_plan_history_reads` row in the same transaction before returning the
   authorized entry set.
2. `forge.resolve_architect_plan_entry_v1(...)` is executable only by the dedicated
   certificate-authenticated package-resolver **login** principal, also a
   non-superuser `NOINHERIT` role with no cross-membership or `SET ROLE`/session-
   authorization privilege. It accepts one package-bound opaque reference, derives
   the caller only from immutable `session_user`, and verifies the exact task,
   package, run, agent, requirement, capability bindings, version, entry, key, and
   digest before returning one eligible fragment. It cannot enumerate versions or
   entries.

Neither reader accepts caller-supplied identity, SQL, a free-form predicate, a
storage locator, or a role name; the human reader's opaque session credential is
authentication material from which PostgreSQL derives identity, not an asserted
identity. Direct-SQL tests connect as every web/worker/reporting/
maintenance principal and prove table/view/catalog discovery, `SELECT`, copied
function bodies, hostile `search_path`, temporary-object shadowing, and calling one
reader with the other reader's credential return no plan bytes. Human-reader tests
use two simultaneous users behind the same web login and prove each valid session
reads only its own authorized task; swapped, expired, revoked, cross-user, cross-
task, and fabricated credentials return zero bytes and append no read audit. The
package-reader positive test connects as its exact login. Negative variants execute
`SET ROLE` where membership exists in a hostile fixture and prove definer
`current_user` cannot widen access; production-role assertions prove both logins
remain non-superuser, `NOINHERIT`, without cross-membership, `SET ROLE`, or
`SET SESSION AUTHORIZATION`.

Runtime work packages persist only normalized policy, capability bindings, and
server-private eligible references `{planArtifactId,planVersion,entryId,
contentDigest}`. Generic package/task/artifact APIs never serialize those locators.
The task-bound internal resolver calls only
`forge.resolve_architect_plan_entry_v1` and verifies current task/package authorization,
artifact type/stage, version, entry ID/kind, digest key, package agent,
requirement, and every capability binding after canonical admission. Only that
verified eligible fragment may exist ephemerally in one executor prompt and
provider/Agent Client Protocol (ACP) wire request; the whole plan row and every
rejected, ineligible, or unrelated fragment never enters either wire. Nothing
persists the resolved fragment after that run. A missing, stale, cross-task,
unauthorized, ineligible, or digest-mismatched reference blocks and is never
repaired from runtime metadata.

S4 creates the sole human text route, backed only by
`forge.read_architect_plan_history_v1`,
`GET /api/tasks/{taskId}/architect-plan-history/{planVersion}`. It checks current
task/project ACL, exact task/version/artifact ownership, and type/stage before
reading entries. In the same database transaction it appends one bounded
`architect_plan_history_reads` row containing request ID, user/task/version,
returned entry count, entry-set digest, and database time—never text, path, IP,
user-agent, prompt, or credential data—before returning the assembled history.
The table is insert-only and retention-protected. Unauthorized, cross-task,
wrong-type/stage, missing, or stale-version requests return one indistinguishable
not-found/forbidden response and no plan bytes.

The normal task/package API, generic artifact list/detail, package metadata,
server-sent events (SSE), task-log/export paths, diagnostics, errors, and queue
payloads expose neither plan text nor a resolvable storage locator. Architect
generation buffers text server-side; `run:chunk`/delta and raw
`artifact:created` plan payloads are removed. Live events, reconnect snapshots,
and new replay history emit only opaque run/event IDs, fixed progress states, and
`historyAvailable:true`. The dedicated route/function pair is the sole human
history reader; the package-bound resolver function is the sole executable-text
reader. Direct table or view reads are never a third path.

### 2. Prompt serialization

Use length-bounded structured JSON sections, never delimiter-based concatenation:

```json
{"kind":"mcp_requirement_instruction","requirementKey":"...","content":"..."}
```

Prompt trust wording is provider-capability-specific:

- providers that preserve roles receive the Forge policy in their actual
  system-role input, and tests capture that wire-level separation;
- the current ACP adapter flattens system and user messages into one
  `session/prompt` string, so ACP receives a bounded Forge-authored guidance
  section before the serialized untrusted data. That guidance is not immutable,
  is not role-separated, and is never described or tested as enforcement.

The Forge-authored policy/guidance states:

- repository packet data is untrusted;
- overlays are subordinate run instructions;
- neither changes tool, credential, repository, or admission policy;
- Forge issued no live MCP handle.

The user-role prompt may repeat a Forge-authored reminder after untrusted sections
to aid model attention, but that reminder is not immutable and is not an
enforcement boundary. ACP's flattened first guidance section has the same limited
status. Reject invalid encoding; truncate only at documented field boundaries and
record omission counts. Tests include fake system messages, closing fences,
credential requests, and `gh` commands. S4 owns an explicit migration of every
current task-log producer: the normal, no-command, stderr-warning, no-op handoff
start, and no-op handoff completion branches delete `frontMatter.prompt` and every
prompt alias rather than relying on an existing sanitization path. A repository-
wide source sentinel rejects every `prompt`, `promptInput`, `promptOverlay`, or
equivalent executable-prompt key at a task-log/front-matter producer outside the
one versioned allowlist; its own denylist fixture is the only exception. A
producer-side allowlist permits only one versioned
`{digest, byteCount, sectionCounts, omissionCounts}` record. The digest is domain-
separated and keyed with server-private material so it is not a low-entropy prompt
oracle. Task-log storage, exports, APIs, server-sent events, diagnostics, errors,
generic front matter, and debug logs never persist the executable prompt, packet,
selected names/paths, rejected Architect text, or credential-like content.

Before the writer drain completes, one historical task-log compatibility reader is
the only database-facing parser for old task-log/front-matter rows. It uses the
closed shared `LEGACY_TASK_LOG_PROMPT_KEYS` tuple—`prompt`, `promptInput`,
`promptOverlay`, `systemPrompt`, `userPrompt`, `sessionPrompt`,
`executablePrompt`, `messages`, and their snake-case spellings—and recursively
removes a matching key at any object depth before projection. The entire value is
hidden whether it is a string, object, array, nested message list, or malformed
legacy value; it never stringifies or partially preserves a prompt-bearing object.
It returns only a versioned allowlist of safe event identity, fixed status, bounded
counts, and database time. An unknown/malformed container becomes one static
`legacy_task_log_unavailable` record with no source bytes. APIs, exports, SSE,
diagnostics, and history screens all call this reader and may not deserialize the
raw column independently.

Legacy prompt snapshots containing an unkeyed `sha256` are never returned by a
database-facing reader, API, export, event, or diagnostic after the S4 compatible
reader deploys. Before old writers drain, readers map such a row to count-only
`{kind:'unknown_legacy_digest', byteCount}` (or omit the snapshot when even the
count is invalid). After credential revocation/session termination proves the old
writers drained, a checkpointed S4 migration deletes the unkeyed digest field or
rewrites the row to that count-only form. It cannot re-key an old digest: the
plaintext is deliberately unavailable, and treating the public digest as keyed
input would preserve the oracle. New writers accept only the domain-separated,
server-private keyed form. This is the only legacy output shape: there is no
`legacyDigestSuppressed` boolean, truncation flag, surrogate digest, digest prefix,
or combined boolean/count object in the ADR, schema, readers, APIs, fixtures, or
operator copy.

After legacy database/Redis writer credentials are revoked and sessions terminate,
a bounded checkpointed scrub walks task-log and front-matter rows by immutable
primary key. Each batch records operation ID, last key, rows examined/changed,
pre/post row fingerprints, state, actor, and database time; it recursively deletes
every closed prompt key/value above, removes unkeyed digests or maps only a valid
byte count to the count-only arm, and compare-and-sets the original row fingerprint
so a concurrent change pauses rather than overwrites evidence. Crash/resume repeats
an already committed batch idempotently; rollback before a batch commit changes
nothing, while committed sanitized batches are never reconstructed from a backup
or event copy. Completion requires a full database scan plus API/export/live-SSE/
snapshot/replay probes showing zero prompt keys at every depth and zero seeded
prompt bytes. The old namespaces and credentials are then permanently rejected.

Plan-event history changes namespace at this boundary. New code writes only the
schema-validated `forge:task-events:v2:{taskId}:history`/`:seq` keys and rejects an
event type or field outside the fixed ID/progress allowlist before publish or
storage. Before `s4_producers_disabled`, operators disable legacy publishers and
SSE subscribers, revoke their Redis publish/write credentials, drain every old web
and worker process, delete all `forge:task:{taskId}:history` and
`forge:task:{taskId}:seq` keys, and prove a complete cursor scan returns zero old-
namespace keys after the drain watermark. A late legacy credential cannot recreate
them. The receipt also scans v2 values and rejects plan text, artifact content,
storage locators, prompt aliases, or seeded sentinels. Expiry alone is not erasure:
the current 86,400-second expiry is renewed by later events, so purge plus namespace
rotation is mandatory.

The serializer reuses the producer limits (`20` requirements, `40` MCP-aware subtasks, and `2,000` characters per materialized overlay) and adds a `128 KiB` UTF-8 ceiling for the complete executable MCP JSON section. It rejects an over-count collection instead of partially authorizing it. It may omit a whole optional field at a documented boundary to stay under the byte ceiling, records the field/count omission, and never slices a JSON string or capability identifier.

### 3. Capability merge and filesystem packet gate

The executor imports `mergeCapabilityFields`, `classifyCapability`, and `coverageKeysForGrant`; it owns no third policy copy.

A bounded filesystem packet may be requested only by current `bounded_read_only` filesystem capabilities with a valid approved effective grant. `filesystem.project.write` remains a planning instruction and never activates packet issuance.

## Authorization identity and immutable claim snapshot

#178 assigns every package-local or project-level filesystem decision a monotonic
PostgreSQL `BIGINT` `grantDecisionRevision` while holding the project row lock.
JSON/evidence uses its canonical base-10 string representation; ordering uses the
database integer, never JavaScript number precision or lexical comparison.
Timestamps are display data, not precedence. A new package-local `allow_once`
approval also receives an immutable UUID `grantDecisionNonce`; reapproval rotates
the nonce even when the current approval pointer is updated. The approval decision
and effective package snapshot must agree on approval ID, decision revision, and
nonce. They must also match the locked project's current internal root-binding
revision; an old-root decision is `revoked`, not issuable.

Approval authority is append-only. Every package approval, denial, revocation, or
reapproval inserts a new immutable `filesystem_mcp_grant_approvals` decision row;
no route updates a prior row's decision, capabilities, revision, nonce, actor/time,
root-binding revision, or fingerprint. The migration explicitly drops/replaces the
current schema's unique `work_package_id` index on that history table before a
second decision can be appended; package uniqueness moves to the preallocated
pointer table, while immutable decision IDs and the complete composite audit parent
key remain unique. Every reapproval allocates a strictly greater project-serialized
positive `grantDecisionRevision` as well as a fresh nonce. The mutable
`filesystem_mcp_current_decision_pointers` row is preallocated and keyed by package
and contains only the
current decision ID/revision, state fingerprint, and positive pointer generation.
While holding project → task → complete sibling package set →
`grant-approval-decision-rows:id-ascending` (decisions, then pointer), a
writer compare-and-sets the exact prior decision ID/revision/fingerprint/generation
to the new retained row. Zero or multiple updated pointers is a conflict and the
new decision plus pointer change roll back together. Project-level `always_allow`
uses the same shape: append-only `project_filesystem_grant_decisions` and one
project-owned CAS current pointer. Removing/narrowing a grant appends a negative
decision and advances the pointer; it never edits or deletes the prior positive
decision. Old audits continue to reference the exact retained decision, while new
claims must match the locked current pointer and current root binding.

Historical authorization must not be reconstructed by joining an old audit to a mutable current approval row. Each packet claim stores an immutable, bounded authorization snapshot:

```ts
type PacketAuthorizationSnapshotCommon = {
  schemaVersion: 2;
  grantDecisionRevision: string;
  rootBindingRevision: string;
  approvedCapabilities: FilesystemProjectCapability[];
  requiredCapabilities: FilesystemProjectCapability[];
  decidedByUserId: string;
  decidedAt: string;
  coverageFingerprint: string;
};

type PacketAuthorizationSnapshot = PacketAuthorizationSnapshotCommon & (
  | {
      source: 'package_allow_once';
      grantMode: 'allow_once';
      grantApprovalId: string;       // FK to this package's exact approval row
      grantDecisionNonce: string;    // immutable UUID, burned by this claim
    }
  | {
      source: 'project_always_allow';
      grantMode: 'always_allow';
      grantApprovalId: null;         // project authority is not a package approval
      grantDecisionNonce: null;      // always_allow never manufactures a nonce
    }
);
```

The fingerprint uses canonical capability, policy, decision, and root-binding
revision fields only. It never includes a path, host-resource reference, prompt,
file name, content excerpt, free-text reason, or credential.

This union is closed and executable at every layer. For every protocol-v2 context
packet, `filesystem_mcp_runtime_audits` stores authoritative
`authorization_snapshot JSONB NOT NULL` plus only these relational mirrors:
`authorization_source`, `grant_mode`, `grant_approval_id`,
`grant_decision_revision`, `grant_decision_nonce`, and
`authorization_root_binding_revision`. The mirrors exist for foreign keys,
uniqueness, and range queries; they are never an alternative history source.

A migration-owner-owned, schema-qualified
`forge.validate_packet_authorization_snapshot_v2(...)` function is `IMMUTABLE`
and has fixed `search_path = pg_catalog, forge` with `PUBLIC` execution revoked.
It accepts already-canonical JSONB plus every scalar mirror, rejects non-objects,
unknown/missing keys, invalid UUID/base-10 `BIGINT`/timestamp forms, non-canonical
or duplicate capabilities, over-limit arrays/strings, and any arm outside the two
TypeScript rows above. It does not claim to discover duplicate object keys after a
JSONB cast: PostgreSQL has already discarded that lexical evidence. It returns true
only when JSON
`source`, `grantMode`, `grantApprovalId`, `grantDecisionRevision`,
`grantDecisionNonce`, and `rootBindingRevision` equal the scalar mirrors byte-for-
canonical-byte. The protocol-v2 CHECK calls that function and additionally admits
exactly:

```sql
CHECK (
  task_id IS NOT NULL
  AND work_package_id IS NOT NULL
  AND agent_run_id IS NOT NULL
  AND local_run_evidence_id IS NOT NULL
  AND (
  (authorization_source = 'package_allow_once'
    AND grant_mode = 'allow_once'
    AND grant_approval_id IS NOT NULL
    AND grant_decision_nonce IS NOT NULL)
  OR
  (authorization_source = 'project_always_allow'
    AND grant_mode = 'always_allow'
    AND grant_approval_id IS NULL
    AND grant_decision_nonce IS NULL)
  )
)
```

Application code cannot insert or update `filesystem_mcp_runtime_audits`
directly. The only writer is the fixed-search-path, `PUBLIC`-revoked
`forge.insert_packet_authorization_snapshot_v2(...)` function. It accepts typed
relational arguments rather than JSON, locks the referenced task/package/run/local-
evidence and applicable approval/project-decision rows, constructs the canonical
JSONB internally, copies the scalar mirrors, and inserts them together. Table and
sequence DML is revoked from every web, worker, application, reporting, and general
maintenance role. The function also requires exact
`audit.task_id/work_package_id/agent_run_id/local_run_evidence_id` equality with the
locked agent run and local-evidence row; a null or cross-bound identity fails before
the audit or nonce claim can commit.

Any legacy migration or external ingress that still starts with JSON/text first
runs the checked-in duplicate-key-aware streaming parser over the original UTF-8
bytes, before `JSON.parse`, a PostgreSQL `json` operator, or any JSONB cast. A
duplicate object key, non-canonical number/string, or invalid encoding fails
closed. Existing legacy JSONB for which the original lexical bytes no longer exist
cannot prove key uniqueness and is classified `unknown_legacy`; it is never promoted
to a protocol-v2 authorization snapshot. Only the typed insert function constructs
new JSONB, so no raw caller JSON can bypass that pre-cast rule.

`filesystem_mcp_grant_approvals` retains task ID, work-package ID, decision
revision, and nonce on each append-only immutable approval decision and declares a unique
parent key
`(id, task_id, work_package_id, grant_decision_revision,
grant_decision_nonce)`. The audit's matching five columns reference that complete
key with `MATCH SIMPLE`, `ON UPDATE RESTRICT`, and exact `ON DELETE RESTRICT`.
The protocol-v2 non-null CHECK above executes first as an independent invariant, so
`MATCH SIMPLE` can never skip the package arm because a child identity is null.
The package arm therefore proves approval ID, task, package, revision, and nonce
against one retained row in PostgreSQL; the project arm skips that FK only because
its approval ID and nonce are both null. A separate update guard rejects any
change to the snapshot or its mirrors after insert, even while lifecycle fields on
the audit advance from `claiming` to a terminal state. Application roles cannot
disable either validator or guard.

The package writer additionally locks and verifies
`filesystem_mcp_current_decision_pointers.current_approval_id/revision/fingerprint`
against that same retained row before insertion. The project arm locks the
project's current decision pointer and references the retained
`project_filesystem_grant_decisions(project_id,grant_decision_revision)` parent;
the pointer may advance after the audit commits without changing historical
authority. Database guards reject update/delete of either decision table and
reject a pointer target whose package/project, revision, root binding, or
fingerprint differs from its parent.

For `package_allow_once`, the already-locked package approval row supplies the
approval ID, decision revision, nonce, actor/time, root-binding revision, approved
capabilities, and coverage fingerprint. For `project_always_allow`, authority
comes only from the already-locked project configuration decision: that row
supplies the decision revision, root-binding revision, approved capabilities,
actor/time, and coverage fingerprint; the claimed package supplies only its exact
required capability set, which must be covered. A task-scoped `always_allow`
reader and a project-detail `always_allow` reader must call the same canonical
project-decision loader and serialize byte-equivalent authority fields. No task
approval ID, package approval row, synthetic nonce, current mutable configuration
read, or package-metadata copy may substitute.

The typed constructor, SQL validator/CHECK/composite FK, Drizzle discriminated
parser, internal serializer, task API, project API, artifact API, and S5 reader import one fixture
table for these two valid rows. Every other source × mode × approval-FK-nullability
× nonce-nullability cross-product fails closed as unknown/invalid evidence and is
never normalized into a valid arm. Fixtures also substitute an otherwise valid
approval/revision/nonce from another package, task, and project; each fails at the
database boundary before a claim, nonce burn, run, audit, artifact, or event can
commit.

Required additive schema changes:

- `projects.root_ref UUID NULL` is added first with no default. A separate bounded
  migration statement sets `DEFAULT gen_random_uuid()`. Before ingress reopens, a
  narrow database-owned `BEFORE INSERT` bridge fills any remaining null—including
  an explicitly supplied null—with `pg_catalog.gen_random_uuid()`, and a separate
  `BEFORE UPDATE OF root_ref` guard rejects only non-null → null. Existing null rows
  may therefore receive unrelated updates during the restartable backfill. A
  concurrent unique non-null index plus checkpointed backfill reaches zero nulls;
  only then is a non-null proof check added and validated before the final short
  `SET NOT NULL`; the rollout section below is normative;
- `projects.root_binding_revision BIGINT NOT NULL DEFAULT 0`, where `0` is the
  sole unbound/non-issuable state, plus an internal opaque
  `host_resource_ref`, authoritative opaque `host_id`, host-binding-key
  fingerprint, and a bounded `root_maintenance_state`
  (`none|deleting|repair_required`) with nullable UUID token and expected revision.
  `host_resource_ref` is an installation-keyed digest of the host ID plus the
  platform-normalized canonical real path; it is never a packet field. Reuse the
  existing `archived_at` as the one project-removal tombstone and add only bounded
  `archived_by_user_id`/`archive_reason:'project_removed'` audit fields. A partial
  unique index on `(host_id, host_resource_ref) WHERE archived_at IS NULL AND
  host_resource_ref IS NOT NULL` rejects two live project records for one exact
  physical root, including aliases, while allowing a safely released root to be
  reused. There is no second `deleted_at` lifecycle;
- append-only `architect_plan_versions` keyed by artifact ID and unique
  `(task_id, plan_version)`, with schema version, entry count, entry-set digest,
  digest-key ID, architect run ID, and database creation time. Its artifact FK is
  `RESTRICT`, and a constraint admits only an `adr_text`/`architect_plan` non-text
  header. Append-only `architect_plan_entries` uses the composite
  `(task_id,plan_version,entry_id)` key and stores bounded kind/ordinal/agent/
  requirement/binding metadata, NFC text, digest-key ID, and canonical content
  digest. Unique ordinals plus exact entry-kind predicates prevent alias entries.
  Migration-owner update/delete guards and table grants make both tables
  insert-only. Append-only `architect_plan_history_reads` records only the bounded
  authorized-read tuple above, references the retained version with `RESTRICT`,
  and has no text/path/request-header column. A plan-artifact guard rejects raw
  plan content or MCP-design text in the header after migration;
- durable `project_host_root_hierarchy_claims` for every live root and missing-root
  reservation. Each owner stores one installation-keyed full-root reference and
  the ordered installation-keyed references for every canonical ancestor prefix.
  A deferred constraint trigger locks one host hierarchy-guard row and rejects a
  candidate whose full reference equals another live owner's full/ancestor
  reference or whose ancestor set contains another live owner's full reference.
  Sibling roots may share ancestors; ancestor/descendant roots may not. Raw paths
  and segment names never enter this table;
- durable `project_host_root_reservations` for roots that do not exist yet. Each
  row stores authoritative host ID, binding-key fingerprint, canonical existing
  parent resource identity, platform-normalized missing suffix digest, random
  reservation token, exact root-writer instance ID and database-credential
  generation for the current transition, hierarchy-claim owner ID, a restricted
  root-management-only planned path,
  `planned|materialized|bound|cleanup_required`, created-object identity when
  available, and database times. The path is never packet evidence, a task event,
  or general API/log output. Its live unique key is the host, parent identity, and
  suffix digest;
- durable `forge_worker_instances` capability/heartbeat rows with a never-reused
  process-incarnation ID, authoritative host ID, maximum worker and root-management
  writer protocols, host-fence-service and operating-system containment-adapter
  versions, host-binding-key fingerprint, last-seen database time, and
  `candidate|active|draining|drained|retired` state plus a database-time candidate
  expiry. Each incarnation has one dedicated,
  independently revocable PostgreSQL login role/client-certificate identity stored
  as `database_principal`; it is `NOINHERIT`, is not a member of a shared role that
  can `SET ROLE`, and `current_user` must equal that row in every trigger and
  recovery transaction. A transaction-local instance ID carries protocol intent
  only and never authenticates its caller. Worker and web/root-management writers
  register separately; root writers also carry the current database-credential
  generation. Drain first disables/revokes that exact principal and terminates all
  of its database sessions, then records acknowledgement. Capability history,
  principal revocation, session termination, and drain acknowledgements are
  append-only activation evidence. A database unique constraint on normalized
  `database_principal` and the never-reused incarnation ID prevents one login from
  authenticating two rows. Process principals receive no direct `INSERT`,
  `UPDATE`, or `DELETE` privilege on this registry. Operator/bootstrap code owns
  immutable principal/host/kind/capability/key/generation fields and lifecycle
  state. A non-login owner defines
  `SECURITY DEFINER forge_heartbeat_current_instance()` with a fixed
  `pg_catalog, forge` search path, schema-qualified objects, and `PUBLIC` execution
  revoked. Inside this function only, immutable `session_user` identifies the
  dedicated login; ordinary claim/root triggers continue to authenticate
  `current_user`. Process roles are non-superuser and cannot `SET SESSION
  AUTHORIZATION`. The routine accepts no caller-supplied instance ID. It first
  identifies the session principal without a retained row lock, then locks the
  protocol epoch, then exactly that instance row, then the binding generation/
  rotation row named by the locked instance. After all three locks it revalidates
  epoch pointer, principal, state, kind, active-or-pending generation, and rotation
  token, and compare-and-sets only
  `last_seen_at` from database time. A normal `candidate|active` must match the
  active credential/binding generation. A candidate explicitly named by one live
  K1→K2 rotation token may attest only its exact pending generation; it cannot
  claim or root-write before the pointer flip. A miss never extends freshness.
  The function cannot register, promote, revive, or cross rows. Drain revokes
  heartbeat/claim access and terminates sessions before its append-only
  acknowledgement;
- append-only `forge_worker_membership_changes` for epoch-2 process replacement.
  It records the disabled ingress scope, old/new instance and principal identities,
  host/key/protocol/fence/containment/credential generations, bounded audited
  candidate set, drain/revocation/session-termination proof, actor/database times,
  `planned|promoted|rolled_back`, and one compare-and-set fingerprint. The separate
  Release/DevOps maintenance principal is never a worker/root-writer principal and
  is the only caller allowed to promote a bounded replacement set. A linked
  append-only `project_root_transition_takeovers` ledger records each interrupted
  reservation/maintenance intent adopted by a replacement root writer or moved to
  `cleanup_required`. It binds old/new instances, reservation/intent token,
  physical-object identity, project/root revision, key/generation, actor/time, and
  compare-and-set result. Normal root writers cannot self-transfer;
- append-only `forge_worker_principal_tombstones` and a bounded principal-lifecycle
  operation. At most 64 unpromoted candidates per host/generation may retain a live
  login/certificate, and each expires after a validated bounded provisioning window.
  Expired/rolled-back candidates and drained instances are first revoked, have every
  session terminated, and become `retired`; they cannot heartbeat or reenter a
  replacement set. A restartable garbage collector handles at most 64 identities per
  transaction and drops the PostgreSQL login plus destroys/revokes its client
  certificate only after proving no active/candidate membership, recovery ownership,
  reservation/maintenance pin, role ownership, grant, or open session remains. The
  immutable instance row and tombstone retain the never-reused principal name,
  certificate fingerprint, membership/revocation/session proof, destroy/drop result,
  actor, and database times—never a private key. A locked installation-wide budget
  permits at most 256 undestroyed credential-resource slots (configuration may only
  lower it). It counts every candidate and retired login/certificate plus one
  pre-reserved retirement slot for each active principal, so promotion and emergency
  retirement cannot escape the cap. At the cap, the same transaction writes/rereads
  one deduplicated `worker_principal_lifecycle_capacity_exhausted` alert and rejects
  new provisioning and any activation/replacement plan lacking already-reserved
  slots; revocation, drain, count-neutral promotion/replacement, and bounded GC stay
  available. Only verified certificate destruction and login drop release a slot.
  Candidate expiry, retirement, and garbage-collection backlog are activation/
  replacement blockers at their configured hard bounds; failed provisioning cannot
  leave an unbounded credential set;
- `filesystem_mcp_grant_approvals.grant_decision_nonce UUID NULL` during
  migration plus retained `task_id`, `work_package_id`, and
  `grant_decision_revision`; every new `allow_once` write requires all five
  identity fields after cutover. Every decision row is append-only. The immutable decision has unique
  `(id,task_id,work_package_id,grant_decision_revision,grant_decision_nonce)` for
  the scoped audit FK and cannot be deleted while evidence references it;
- append-only `project_filesystem_grant_decisions`, package
  preallocated `filesystem_mcp_current_decision_pointers`, and one project current-decision pointer.
  Only the pointer rows are mutable, and only through project-serialized exact-prior
  ID/revision/fingerprint/generation compare-and-set. Decision update/delete and a
  pointer to a mismatched parent are rejected by database guards;
- a durable decision revision on the retained approval decision and current
  pointer/effective snapshot, using the #178 project-serialized revision contract;
- `work_packages.claim_protocol_version INTEGER NULL`, written by the database on
  each transition to `running` and retained as durable claim evidence, plus
  protocol-v2 `claim_worker_instance_id`, `claim_host_id`, `claim_host_resource_ref`, and
  `claim_root_binding_revision` for every local-root all-mode claim;
- nullable protocol-v2 `agent_runs.claim_worker_instance_id`, `claim_host_id`,
  `claim_host_resource_ref`, and `claim_root_binding_revision`; a created run copies
  the package pin exactly;
- `tasks.unresolved_local_change_count INTEGER NOT NULL DEFAULT 0`, nullable
  canonical `local_change_barrier_fingerprint`,
  `local_change_projection_version INTEGER NOT NULL DEFAULT 0`, and nullable
  `local_change_source_set_fingerprint`. Version `0` or a null source-set digest is
  expansion-only, non-authoritative state. Bounded audited backfill writes version
  `1` or later plus the digest, and activation makes the digest non-null.
  Projection input is not the unbounded append-only history.
  `CURRENT_LOCAL_PROJECTION_HEAD_KINDS` is the one shared closed list and contains
  exactly eight values. Every protocol-v2 package has exactly one preallocated
  current-authority head slot per value in
  `work_package_local_projection_heads`, keyed by `(work_package_id, head_kind)` for
  the closed kinds `local_run`, `local_recovery`, `packet_recovery`,
  `repository_review`, `host_apply_review`, `operator_hold`, `integrity`, and
  `terminal_disposition`. Each slot stores one nullable current source FK, positive
  head revision, bounded contribution, source fingerprint, and compare-and-set
  fingerprint. The eight rows are created before the package becomes claimable and
  cannot be inserted, deleted, retyped, or reassigned afterward. Immutable run,
  action, review, alert, resolution, and terminal history remains append-only but is
  outside the projection input cardinality.
  The canonical lock family is
  `local-run-evidence-task-projection-heads:id-ascending`; every path imports that
  exact family name and locks the applicable evidence row followed by package/head
  IDs in ascending order.

  Every state transition first appends its immutable history row, then advances the
  applicable existing head count-neutrally in the same transaction with exact prior
  revision/fingerprint compare-and-set and a retained foreign key to the new
  authoritative row. A head may point only to its declared source table/kind and
  package; an old, missing, cross-package, skipped-revision, or fingerprint-mismatched
  head aborts the transition. At the maximum 256 sibling packages, the aggregate
  reads exactly 2,048 fixed heads, never a growing history tail. A legacy task with
  more than 256 packages is put in the typed `local_projection_package_limit`
  migration hold before head backfill and changes its durable
  `local_projection_scope_state` from `active` to `archive_pending`. The only
  remediation is evidence-preserving **whole-task** archive: packages are never
  reparented, split in place, sampled, deleted, or detached from their immutable
  run/evidence/history rows. Final archive changes the task to
  `legacy_archived`, keeps every original package and relationship queryable as
  history, and makes the task permanently ineligible for protocol-v2 claims,
  projection, ingress, wakes, or root mutation. The authoritative state union is
  exactly `active|archive_pending|legacy_archived`.

  The operator first creates and reviews a separate newly planned replacement task
  with new package identities, no copied authority/evidence, at most 256 packages,
  and all eight heads preallocated per package. That task stores exact
  `legacy_archive_source_task_id`, closed
  `local_projection_replacement_state='pending'|'eligible'|'cancelled'`, positive
  state version, and source/replacement fingerprint. A replacement begins
  `pending`; every claim, wake, ingress, and root-mutation gate rejects it before
  I/O. An ordinary task has no source ID/replacement state and cannot be substituted
  into the archive. These exact interfaces are the only
  over-limit path:

  ```text
  npm run protocol:inspect-local-projection-overlimit -- --task <legacy-task-id>
  npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id>
  npm run protocol:archive-local-projection-overlimit -- --task <legacy-task-id> --replacement <replacement-task-id> --actor <operator-id> --apply
  docs/operators/local-projection-overlimit-archive-v2.md
  ```

  Inspect is read-only; archive without `--apply` is an exact dry run. Apply stores
  an operation, source/replacement fingerprints, actor, database times, and bounded
  `validated|quiesced|archived` checkpoints. It locks source and replacement tasks
  in task-ID order, then all packages and fixed head sets in ID order, rejects live
  claims/leases/reviews or a replacement over 256, closes
  ingress, and resumes idempotently after a crash. A failure before the final
  compare-and-set may roll `archive_pending` back to `active` while retaining the
  typed hold; committed batches and the final archive never delete or reparent
  evidence. The final transaction proves the unchanged complete legacy package set,
  a quiescent source, and the replacement's at-most-256 package count plus exact
  eight-head set before atomically compare-and-setting only source
  `archive_pending → legacy_archived` and replacement `pending → eligible` under
  their exact versions/fingerprints. Rollback leaves the replacement `pending`; an
  explicit normal cancellation changes only an unused pending replacement to
  `cancelled` and retains its task/package/head evidence. Runtime package creation that would exceed 256 fails
  before insertion.

  One versioned PostgreSQL aggregate function derives the task projection from the
  closed heads. An immediate head-update trigger increments a transaction-local
  task-specific mutation generation. A deferred cross-row constraint calls the
  schema-qualified assertion function once for each final
  `{taskId,mutationGeneration}` and then records that checked generation in a
  transaction-local dedup map; later triggers for the same final generation are
  no-ops. `SET CONSTRAINTS ... IMMEDIATE` followed by more source DML increments
  the generation and therefore forces a new final check. Application roles have
  no direct projection-column or head update grant. A `BEFORE UPDATE` guard additionally
  rejects direct DML unless `current_user` is the dedicated non-login,
  `NOINHERIT` owner of the fixed-search-path `SECURITY DEFINER` aggregate writer;
  application and migration callers cannot forge that execution identity with a
  transaction-local setting. Source-DML dedup never bypasses this separate guard.
  Direct head DML is likewise limited to the fixed writer and must name the newly
  appended retained source row. Terminalization,
  acknowledgement, quarantine, cancellation, integrity repair, and backfill call
  the writer while holding task, sibling packages, and the applicable evidence
  tail and eight-head set. Every all-mode claim locks that same fixed head set,
  recomputes it, and rejects missing, stale, wrong-version, over-package-limit, or mismatched projection—including a
  coherent-looking stale `0/null`;
- one `work_package_local_run_evidence` row, unique by `agent_run_id`, for every
  protocol-v2 run pinned to a local root, whether packet-bearing, packet-free, or
  handoff-only. It stores the immutable run/root/claim pin, resource-fence/group
  identity, live-owner `claim_token`/`lease_expires_at`, distinct nullable W2
  recovery-owner token/expiry, and a closed generic invocation state
  (`not_started|invoking|returned|definitive_not_started|uncertain`) with random
  attempt ID and database intent/result times. Only the still-live exact owner may
  write `invoking→definitive_not_started`, and only from the trusted typed
  `pre_io_refusal`; orphan/recovery maps `invoking` only to `uncertain`. Packet runs link this attempt to the
  packet submission-attempt ID rather than duplicating I/O truth. It stores
  working-tree, Git-control, **and Git-storage** baseline/comparison versions,
  opaque fingerprints, and an explicit
  `repository_reviews:{workingTree,gitControl,gitStorage}` map whose three typed
  states are fingerprint-bound and whose combined action digest commits to the
  complete set; post-response effect intent
  (`not_started|active|quiesced`), host-
  ledger fingerprint/review, authenticated W2 election and
  protected-service receipt fingerprints, recovery epoch, and terminal/quarantine
  state. It exists before the first repository read. Packet-free/handoff runs still
  create no packet audit or artifact; generic legacy stale recovery is forbidden
  for every locally pinned run. A packet audit references this row rather than
  owning local-effect truth;
- `filesystem_mcp_runtime_audits` fields:
  - `protocol_version`;
  - authoritative `authorization_snapshot JSONB NOT NULL`;
  - protocol-v2 `task_id`, `work_package_id`, `agent_run_id`, and
    `local_run_evidence_id`, all non-null and constrained to the same locked
    task/package/run identity;
  - scalar `authorization_source`, `grant_mode`,
    `authorization_root_binding_revision` mirrors;
  - `grant_approval_id`;
  - `grant_decision_revision`;
  - `grant_decision_nonce`;
  - `status` (`claiming|succeeded|failed`);
  - `claim_token` UUID;
  - `lease_expires_at`;
  - the schema-qualified closed-union validator, five-column retained-approval FK,
    and authorization-field update guard described above;
  - packet assembly state: live `assembling` intent or terminal
    `assembled|not_assembled|assembly_unconfirmed` evidence;
  - delivery outcome;
  - required `local_run_evidence_id` referencing the generic row for this local
    packet run; packet tuple checks require exact task/package/run equality and join
    its exact terminal local-effect evidence;
  - terminal success/failure outcome and bounded failure code/stage, with database
    checks matching the normative tuple table below.
- run-scoped `work_package_host_apply_ledgers` plus ordered entry rows. An entry
  references the existing validated output-plan entry ID/ordinal and stores only
  `planned|applying|applied|unknown`, claim/fence identity, and database times;
  packet-owned evidence never copies its path or error detail;
- append-only `work_package_local_recovery_actions` keyed by generic local-run
  evidence ID, typed action
  `review_local_changes|acknowledge_possible_local_invocation|retry_local_execution|decline_local_retry`, exact
  combined working-tree/Git-control/Git-storage/host-ledger fingerprint,
  actor/time, resulting
  marker/package/task disposition, and a unique
  `(local_run_evidence_id, action, evidence_fingerprint)` key. Packet and no-packet
  runs use this one local mutation/replay authority; stale identity is actionless;
- append-only `filesystem_mcp_issuance_recovery_actions` with actor, typed action
  (`acknowledge_possible_submission|retry_execution|decline_packet_recovery|resolve_after_allow_once_reapproval`),
  prior runtime-audit/agent-run IDs, marker fingerprint, delivery state, nullable
  prior/authorizing root-binding revision, authorizing decision
  revision/coverage fingerprint/approval ID, database time,
  and a unique `(runtime_audit_id, action, marker_fingerprint)` key.
- append-only `filesystem_mcp_integrity_alerts` and
  `filesystem_mcp_integrity_resolutions` use one closed discriminated reason/
  identity union. Evidence-present reasons require generic local-run evidence ID;
  `missing_local_evidence` instead requires immutable project/task/package/run/
  claim pins plus an expected evidence ID that is not a foreign key and requires
  `local_run_evidence_id:null`. Packet audit ID is nullable only for the closed
  branches that permit it. Alerts are uniquely fingerprinted per exact identity/
  optional audit/reason, with bounded reason,
  actor/owner, database time, prior alert ID, chosen typed
  resolution
  (`verified_success|verified_failure|projection_recomputed|generic_failure_reconstructed|quarantined_abandoned|quiescence_proven`),
  and no path or free text. `quiescence_proven` is service-authored only and binds
  the W2 receipt, recovery epoch, final generic-evidence fingerprint, and terminal
  disposition; an operator cannot fabricate it. A quarantine resolution
  additionally binds the sorted set of
  every affected sibling marker, all repository baseline/change fingerprints,
  host-ledger fingerprint, host-review disposition, and one canonical
  sibling-evidence-set fingerprint. It records repository disposition
  `reviewed|abandoned`; omission is invalid.
- before the expansion journal opens, replace evidence-bearing project/task/run/
  audit/artifact cascade deletes with retention-safe `RESTRICT|NO ACTION` and
  install a database hard-delete rejection guard. This migration may run only
  after a bridge web release rejects or archives project removal **before any
  filesystem work** and every pre-bridge web process/session has drained. A
  rejected database delete must never follow `fs.rm`;
- append-only `project_root_change_journal` rows written by a simple expand-phase
  PostgreSQL row trigger with the closed outcome vocabulary
  `insert|root_update|archive` for legacy project insert, root update, and archive.
  Hard delete is already rejected by the retention guard. Each row gets a
  monotonic generation and bounded operation/project identity;
  it stores no path and calls no TypeScript. A post-drain watermark is valid only
  after legacy credentials are revoked and sessions terminated. Binding/root-
  trigger enablement/activation require audited S3 reconciliation of every journal
  generation through that watermark;
- versioned `forge_host_binding_generations` plus owner-level
  `forge_host_binding_rotation_shadows` keyed by
  `(rotation_id, owner_kind, owner_id)`. Each shadow retains the source K1
  generation/revision/fingerprint, K2 full-root and ordered ancestor references,
  verification state/fingerprint, and compare-and-set generation. The append-only
  rotation row stores active/pending key fingerprints and credential generations,
  random token, actor/time, `preparing|rebinding|verified|promoted|rolled_back`,
  bounded checkpoints, and complete-set fingerprint. The epoch stores one active
  binding-generation pointer. Neither table stores a key;
- the generic release-authentication substrate is a **Step 0 bootstrap**, not a
  remaining-S4 expansion. Before Step 0 can record its own graph receipt, its
  separately reversible bootstrap migration installs pinned
  `forge_release_signer_keys`, the singleton signer policy/change audit,
  append-only `forge_epic_172_release_evidence`, append-only
  `forge_epic_172_transition_authorizations`, append-only
  `forge_epic_172_release_evidence_consumptions`, the checked-in Node Ed25519
  verifier, and the certificate-authenticated `NOINHERIT`
  `forge_release_evidence_writer` and `forge_release_transition` principals. The
  bootstrap is infrastructure for authenticating graph state, not an eleventh node;
  it may create no graph receipt or advance any runtime flag. The initial public key,
  key generation, GitHub App ID, ruleset fingerprint, and validity interval come
  from the reviewed Step 0 deployment envelope; private keys never enter Forge.
  Step 0 then uses the same generic recorder as every later node, with the empty
  canonical predecessor set, and `s3_issue_178` cannot proceed until that signed
  receipt is retained. Remaining S4 imports this substrate and has no migration,
  alternate recorder, unsigned bootstrap row, or second verifier;
- every graph node and required-evidence row has one lifecycle-valid Ed25519 arm
  with non-null signer key/generation, GitHub App/controller run/job, signature
  domain/version, canonical envelope digest, detached signature, random 128-bit
  nonce, and issued-at. There is no `database_maintenance` or nullable-signature
  authority arm. Local Step 0/S3/S4/S5/enablement facts are measured from locked
  database state, placed in a bounded controller envelope, signed by the pinned
  release signer, and recorded through the same verifier. Recording requires the
  key and signer policy to be valid at issued/recorded database time; after commit,
  that immutable node receipt is durable predecessor evidence and does **not**
  expire. A retiring key verifies already-retained evidence but cannot sign a new
  node after its database-time cutoff;
- `forge_epic_172_transition_authorizations` is a separate append-only store for
  short-lived permission to consume durable evidence and perform one state
  transition. Its signed domain is distinct from node evidence and binds exact
  authorization attempt ID, target node/transition identity, source receipt set,
  owner, build/SHA, epoch, operation/controller identity, signer key/generation,
  random nonce, database issued-at, and expires-at. Lifetime is greater than zero
  and at most 30 minutes. An expired unused authorization is retained as audit and
  a newly signed attempt may replace it; it never changes, refreshes, or duplicates
  a recorded graph node. Authorization rows are not graph nodes or predecessors and
  cannot prove release state. The consumption/state transaction must lock and
  reverify one unexpired exact authorization at its final statement using
  `clock_timestamp()`;
- `forge_epic_172_release_evidence` also stores a canonical
  `transition_identity_digest` over
  `{manifestVersion,nodeOrRequiredEvidenceKind,owner,exactBuilds,reviewedSha,
  epochOrNone,canonicalPredecessorReceiptSetDigest}`. That digest is `UNIQUE` and
  immutable. Receipt ID and nonce remain independently unique, but a second valid
  envelope with a different ID/nonce for the same transition identity conflicts
  before insertion. The manifest defines allowed/required fields for every graph
  node and `enabled_build_tests_green`; unknown fields, owner/build/graph mismatch,
  future issue time, a node recorded outside signer validity, missing signature,
  or wrong transition identity fail closed. Canonical signed bytes are RFC 8785
  JSON/NFC UTF-8 prefixed by
  `forge:epic-172-release-evidence:v1\0`;
- the checked-in Node verifier starts one transaction as
  `forge_release_evidence_writer`, locks signer policy/key, transition identity,
  nonce, and exact predecessors, reconstructs canonical bytes, and calls Node
  `crypto.verify` while those locks remain held. Only after success may it call the
  fixed-search-path, `PUBLIC`-revoked
  `forge.record_epic_172_release_evidence_v1`; that routine rechecks every
  non-cryptographic predicate and inserts before the same transaction commits.
  PostgreSQL 16 needs no crypto extension or network read. General web, worker,
  application, reporting, migration, and ordinary maintenance roles have no table,
  sequence, function, writer-principal, or transition-principal authority. An
  immutable-row trigger rejects update/delete even by the verifier;
- `forge_epic_172_release_evidence_consumptions` stores receipt ID, its immutable
  transition identity, exact short-lived transition-authorization ID, exact
  consumer node, activation/enablement/final-readiness operation ID, actor, and
  database time. It is unique by receipt ID and by
  `(transition_identity_digest, consumer_node)`. A transition transaction locks the
  signer policy/key, durable receipt, transition identity, exact predecessors,
  unexpired transition authorization, and both consumption keys, reverifies both
  signature domains plus key/build/SHA/epoch/source bindings and authorization
  expiry, then
  calls the only fixed-search-path `SECURITY DEFINER` consumer granted to
  `forge_release_transition`. Consumption plus the requested state transition
  commits atomically. Rollback removes both; committed consumption cannot replay,
  including through a separately signed different-nonce receipt. Final readiness
  is additionally unique by its canonical transition identity and atomically
  consumes **both** the exact `ingress_and_issuance_enabled` predecessor receipt and
  the exact `enabled_build_tests_green` receipt before appending retained
  `s5_s6_release_ready`; rollback consumes neither and appends no readiness. Every
  scrub operation stores that readiness receipt ID and revalidates both linked
  consumptions plus the matching build/epoch/predecessor set on dry-run, apply, and
  resume;
- Step 0 also creates singleton `forge_epic_172_enablement_state` with closed state
  `disabled|provisional|active`, nullable exact owner operation ID, exact
  build/SHA/epoch, opening and database-time expiry, enablement receipt ID,
  final-readiness receipt ID, controller login/run identity, exact authorization/
  token digest, positive lease generation, last-heartbeat database time, lease
  expiry, and state fingerprint. Only the transition principal may compare-and-set
  it. This is the sole authoritative enablement state and exists from Step 0 but
  remains `disabled` until node 9. The append-only
  `forge_epic_172_enablement_transition_audit` records non-authoritative
  `opened|heartbeat|failed_disabled|expired_disabled|manually_disabled|promoted_active`
  dispositions and exact prior/new singleton fingerprints; no audit disposition is
  itself a gate state;

The protocol-v2 non-null/equality CHECK is installed before these two partial
unique indexes for `operation='context_packet'` rows:

- `(agent_run_id, operation)` — one packet claim for every packet run; null cannot
  bypass it because protocol v2 forbids a null run ID;
- `(grant_approval_id, grant_decision_nonce, operation)` where the nonce is non-null — the additional one-time-decision fence.

SQL migration predicates, Drizzle schema declarations, and conflict writers must be semantically identical.

## Durable worker-protocol barrier

Mixed-worker safety uses the existing pre-read package claim boundary, not the
later runtime-audit insert and not a process-local feature flag. Add a singleton
`forge_runtime_protocol_epochs` row for `name='work_package_execution'` with
`minimum_worker_protocol`, `minimum_root_management_protocol`, nullable active host
ID, minimum host-fence-service/containment-adapter versions, active
host-binding-key fingerprint, active binding-generation pointer, active root-writer credential generation,
activation actor/time, and immutable activation
audit. It begins at protocol 1 with no active host.

An expand-phase PostgreSQL trigger runs on every work-package status transition to
`running`, a boundary every current legacy worker already traverses before the
executor can read repository context. The trigger reads the transaction-local
`forge.worker_protocol` setting (`1` when absent for legacy binaries), takes a
shared lock on the epoch row, rejects a lower protocol, and writes the observed
version to `work_packages.claim_protocol_version`. While the epoch is 1 it rejects
an observed protocol 2 before repository access; registered v2 processes remain
`candidate` and cannot claim in any mode. At epoch 2 it also requires a
transaction-local `forge.worker_instance_id`, locks that exact
`forge_worker_instances` row `FOR SHARE`, and requires `active`, database-time
freshness within 30 seconds, the epoch host, protocol 2, sufficient fence-service
and containment versions, and exact host-binding-key/generation equality. It also
requires `current_user` to equal the row's dedicated database principal and the
transaction-local ID to name that same row. A caller-controlled setting cannot
authenticate the connection. It pins the validated instance ID on the package.
One shared v2 package-claim
primitive locks project → task → every sibling package in ascending ID order,
recomputes dependency/candidate eligibility, rejects `projects.archived_at IS NOT
NULL`, proves no sibling is running or leased and none is `awaiting_review`, and
then locks the epoch, authenticated instance, active binding-generation/rotation
row and matching hierarchy guard for a local-root arm, followed by sibling runs/
local-run evidence/task-projection current-head and review tail in global order. A root-
free arm omits only the inapplicable generation/hierarchy/evidence rows. The
database-owned aggregate must exactly recompute to
the locked task's current versioned zero/null projection. Missing, stale, wrong-
version, or mismatched source evidence is an integrity hold. The primitive sets
`SET LOCAL forge.worker_protocol='2'` and
`SET LOCAL forge.worker_instance_id='<registered-instance-id>'`; the trigger reads
host, versions, and binding-key fingerprint from that locked registry row rather
than trusting parallel caller settings, but authenticates with `current_user`. It
only then attempts one conditional `running` transition. This is required for packet-bearing execution,
packet-free execution, and handoff-only mode when
`FORGE_WORK_PACKAGE_EXECUTION=0`; no direct writer may update only its preselected
package. Only the packet-bearing branch continues to the issuance audit/nonce
work below.
The trigger therefore fences a restarted old binary before *any* executor work,
not merely before a late audit. It governs cooperative Forge execution and does
not confine an ACP process or revoke other host access.

Activation is a deployment-operator/database-maintenance action, not a user-facing
web route. It uses an explicit PostgreSQL `READ COMMITTED` transaction. Statement
one locks the epoch row exclusively and finishes any wait. Statement two then uses
a fresh command snapshot to query both every `running` package with null/protocol-1
claim evidence and the complete worker-instance capability/heartbeat registry.
Any package, project binding, worker, or root-writer capability blocker aborts
without advancing. Otherwise, statement three updates the epoch to 2, pins the one
active host/minimum fence-service and containment versions/binding-key fingerprint,
active binding generation, and credential generation. More than 64 selected
candidate instances is a cutover blocker. In the same bounded data-modifying
common-table expression it changes only the audited authenticated candidate
instances to `active` and records the immutable package/project/instance
activation snapshot before commit. Candidate identities not in that snapshot stay
non-active. Queue intake and every root/packet ingress owner remain disabled until
this commit. A v1 transition that acquired the shared lock
first therefore commits and is visible to statement two, forcing activation to
abort. If activation acquired the exclusive lock first, a later v1 transition
waits, sees epoch 2, and fails. A single-statement check or a snapshot established
before the lock wait is forbidden. Activation does not lock entity rows or mutate
them, so it cannot reverse the entity order. The epoch is monotonic and never lowered.

Initial protocol-v2 execution that can read or mutate a local project is explicitly
single-active-host. Every worker and web/root-management process registers and
heartbeats one typed `candidate` `forge_worker_instances` row from operator-
controlled stable host identity using its dedicated database principal; a process
cannot self-assert a different host or another incarnation at claim or management
time. Activation requires exactly one distinct fresh candidate host, every selected
worker and root writer on that host to advertise protocol 2, the required
fence-service/containment versions, and one equal host-binding-key fingerprint.
Every stale, legacy, incompatible, divergent-key, or other-host row must have an
audited `drained` disposition.
Candidate/active instances heartbeat every 10 seconds and are fresh only when PostgreSQL
`now() - last_seen_at <= interval '30 seconds'`; an older non-drained row blocks
activation rather than being assumed dead.
The activation audit snapshots the exact never-reused instance IDs, dedicated
database principals and revocation state, kinds, host ID, binding-key
fingerprint, root-writer credential generation, versions, heartbeats, ingress
ownership, and drain evidence. Missing, stale, unreachable,
incompatible, divergent-key, or multiple-host evidence is a machine-checkable
blocker. Multi-host local execution
remains disabled until a later architecture supplies durable host-affine routing.
A later unregistered/stale/draining process, revoked principal, or process from
another host cannot bypass activation by naming a good row: the package/root-
mutation triggers bind `current_user` to the exact instance before repository
access. A stable instance ID or database principal is never reused for W2.

Cutover still requires operational drain of pre-trigger processes before epoch-2
activation; no schema change can retroactively stop a binary that was already past
the package claim when the trigger was installed. After the expand trigger has been
deployed everywhere and the drain is proven, the durable activation fence prevents
an old binary from reconnecting. Tests cover a genuine pre-trigger worker that must
be externally drained and both bridge-trigger lock orderings: v1-shared-first
forces activation to abort, while activation-exclusive-first rejects the v1
package transition with zero repository reads.

Epoch 2 therefore has a separate ongoing membership protocol; the monotonic
activation command is not reused for restarts. Release/DevOps runs the checked-in
maintenance command first as dry run and then, only after inspecting its bounded
plan, exactly:

```text
npm run protocol:replace-work-package-instance -- \
  --candidate <new-instance-id> --replaces <old-instance-id> \
  --actor <operator-id>
npm run protocol:replace-work-package-instance -- \
  --candidate <new-instance-id> --replaces <old-instance-id> \
  --actor <operator-id> --apply
docs/operators/work-package-instance-replacement-v2.md
```

The command uses the separate maintenance principal and disables only the queue or
project/root ingress owned by the affected kind. It provisions a never-reused
candidate principal outside the transaction, proves the same active host/key/
binding/credential generations and required protocol/fence/containment versions,
then locks epoch → old/new instance rows ascending. It proves the old principal is
revoked, its sessions terminated, its work drained or explicitly eligible for W2
recovery, and the bounded active set remains at most 64. One compare-and-set writes
the membership-change plan and may promote the new candidate, but the old row
remains `draining` until every pinned transition is resolved; rollback leaves the
new row `candidate`, keeps ingress disabled, and never revives the old principal.
Candidate provisioning has a database-time expiry and a hard maximum of 64 live
unpromoted credentials per host/generation. A failed or expired candidate is
ineligible immediately and enters the same revoke → terminate sessions → retire →
destroy certificate/drop login lifecycle as a drained instance. Release/DevOps
inspects and resumes bounded cleanup only through:

```text
npm run protocol:gc-work-package-principals -- --actor <operator-id>
npm run protocol:gc-work-package-principals -- --actor <operator-id> --apply
docs/operators/work-package-principal-lifecycle-v2.md
```

The first form is dry-run. Apply uses the maintenance principal, processes no more
than 64 exact tombstoned identities, is idempotent after every checkpoint, and
never removes immutable membership/tombstone evidence. Provisioning locks the
installation credential-resource budget before creating a login/certificate. The
hard total is 256 candidate/retired resources plus active retirement reservations;
at the cap it emits/rereads the deduplicated lifecycle-capacity alert and blocks any
operation that would add an unreserved resource. GC releases a slot only after both
credential resources are gone. A candidate or retirement backlog at its hard bound
blocks further provisioning instead of creating another login or certificate.

For a root-writer replacement, the maintenance command next discovers reservations
and project maintenance intents pinned to the old incarnation. With ingress still
disabled and no database locks, it acquires every old/new hierarchy/resource fence
in canonical order. Bounded canonical transactions compare-and-set the exact old
instance, credential generation, reservation/maintenance token, physical-object
identity, root/project revision, and binding generation to the replacement, or to
`cleanup_required` when safe continuation cannot be proven. Each result appends
`project_root_transition_takeovers` evidence. Stale/reused physical identity is
never deleted or adopted. Only when every pin has a terminal takeover/cleanup
result may the command mark the old row `drained`, rotate the exact ingress owner,
and resume root ingress. Normal writers cannot self-transfer, and W2 run recovery
cannot stand in for this protocol.

Abrupt W1 loss uses the literal dry-run
`npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id>` and then the literal apply
`npm run protocol:replace-work-package-instance -- --candidate <new-instance-id> --replaces <old-instance-id> --actor <operator-id> --apply` to promote a separately provisioned standby W2 on the authoritative host before the W2 election protocol runs. The operator
maintenance principal and protected fence-service verifier are outside the worker
membership set, so recovery remains possible when every previously active worker
is gone. Promotion never grants a fence lease or selects a run; the later
connection-authenticated W2 election still does both. Concurrent claims,
heartbeats, drains, membership changes, and recovery serialize at epoch/instance
rows; a revoked old principal cannot heartbeat, claim, or replay a service
challenge. The checked-in operator guide
`docs/operators/work-package-instance-replacement-v2.md` is an activation
prerequisite and covers capacity replacement, all-active-gone recovery, root-
writer restart, rollback, and audit inspection.

### Durable project-root writer barrier

The project-root trigger is enabled only inside the cutover maintenance window,
after project-management ingress is disabled, the v1 database credential and
sessions are revoked, old web/root-writer services are drained, and the canonical
S3 TypeScript reconciler has processed every expansion-window root change. It
never calls or duplicates that reconciler. While the epoch is still 1 it rejects
every root-bearing project mutation and hard delete; ingress remains disabled, so
this is a short activation barrier rather than a supported old-route mode.

At epoch 2 the trigger covers any root-bearing project insert, any update of
`local_path`, host binding, positive root-binding revision, root maintenance, or
`archived_at`/archive audit fields, and hard delete. A rootless insert is the sole
exception: `local_path`, host/resource/key binding, hierarchy owner, maintenance,
and reservation fields must all remain null/`none`; it confers no filesystem
authority. Attaching a root later is a full reservation/binding transition. Hard
delete is always rejected. Every governed transition requires
`forge.root_management_protocol='2'`, a transaction-local registered writer
instance ID, maintenance/reservation token, authoritative host ID, resource ref,
binding-key fingerprint, and a well-formed monotonic revision/tombstone transition.
It locks and validates that exact fresh active instance after the epoch row, using
the same `current_user`-to-dedicated-principal and host/key/capability checks as a
worker claim plus exact active binding-generation and root-writer credential-
generation equality. A transaction-local ID or shared credential generation cannot
stand in for caller identity. Missing or malformed state
fails before any database mutation.

Activation's exclusive epoch lock serializes statement two with this trigger.
The trigger rejects root mutation until activation commits; after activation it
accepts only registered v2 writers. The operational drain includes old web and
root-management processes already past any database boundary; rollback never
restarts them. No trigger or transaction waits for an external namespace,
resource, hierarchy, or containment fence: routes acquire it first with zero
database locks, then set the validated token/settings and enter the database
order.

The root-mutation trigger cannot undo filesystem work an old route performs before
its database statement. Cutover therefore keeps project-management ingress
disabled while it revokes the v1 web database role/credential, terminates every old
session, drains/disables the old service units, activates the epoch with a new
root-writer credential generation and the audited candidate principals, and only
then enables ingress to those exact activated v2 instances. A restarted old web
binary cannot authenticate or read a project path,
so its POST/PUT/DELETE request fails before route filesystem work. The activation
audit binds every dedicated principal, the credential generation, terminated
sessions, disabled service units, and exact ingress owner. This governs Forge-managed services; it does not claim to
sandbox an unrelated host process with direct operating-system access.

The installation host-binding key is operator-controlled secret material; only
its stable fingerprint is stored in PostgreSQL. Missing or divergent same-host key
material blocks registration, root management, activation, and claims. Backup is
a required cutover artifact. Rotation or loss is an explicit two-phase maintenance
event; a normal root writer can never cross the active-key trigger by itself.
The operator disables issuance and project ingress, revokes the active root-writer
credential, drains every instance, and proves there is no live claim, reservation,
containment lease, or effect. It also proves every task projection/current-head set,
local marker, host/repository review, integrity alert/resolution, and terminal K1
evidence is coherent and reviewed or explicitly quarantined. Unresolved K1 state
blocks promotion; evidence is never translated to K2 by changing fingerprints.
One exclusive transaction then creates a rotation
row/token and records `active K1` plus `pending K2` and its pending credential
generation without changing the active epoch key.

The checked-in Release/DevOps interface and guide are exact:

```text
npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref <opaque-secret-ref> --actor <operator-id>
npm run protocol:rotate-host-binding-key-v2 -- --pending-key-ref <opaque-secret-ref> --actor <operator-id> --apply
npm run protocol:inspect-host-binding-key-rotation-v2 -- --rotation <rotation-id>
npm run protocol:rotate-host-binding-key-v2 -- --rotation <rotation-id> --discard --actor <operator-id> --apply
docs/operators/host-binding-key-rotation-v2.md
```

The first command is dry-run. `--apply` creates or idempotently resumes the one
matching rotation/checkpoint; inspect reports bounded counts/fingerprints and no
key/path; discard is valid only before promotion. Key loss uses a restored
operator-approved secret reference and the same process; without it, issuance and
root ingress remain disabled. Missing tooling/guide/backup or an unresolved K1
barrier blocks cutover and rotation. Only the separately credentialed rotation
command may use the token. With no
database locks held it acquires the complete old/new hierarchy and resource-fence
set in canonical order. Restartable bounded transactions lock affected project
rows ascending → epoch → authenticated rotation instance → pending binding
generation → host hierarchy guard → reservations, compare-and-set K1 inputs, and
write owner-level K2 shadow rows/checkpoints. Each row binds owner kind/ID, source
K1 generation and revision, K2 full/ancestor references, and its verification
fingerprint. Missing, duplicate, stale-owner, or wrong-source rows fail complete-
set verification. Normal claims/root writers resolve only the epoch's active K1
generation and cannot observe K2 shadows as authority.

After a bounded complete-set scan proves every live project, hierarchy owner, and
reservation has exactly one verified K2 shadow and no K1/K2 hierarchy collision,
one constant-size transaction compare-and-sets only the epoch's active binding-
generation pointer, active key fingerprint, credential generation, and rotation
status to K2/`promoted` and promotes at most 64 audited K2 candidate principals.
It never rewrites project, hierarchy, reservation, or shadow rows in the authority-
switch commit. Every claim, uniqueness/hierarchy
constraint, root-management path, recovery path, and cleanup resolves exactly that
active generation. Ingress credentials and the bounded candidate set rotate only
with the pointer flip. Pending K2 candidates may use only the rotation-bound
heartbeat attestation and cannot claim or root-write. Ingress starts afterward.
Before promotion, a crash resumes
or discards the inactive generation in bounded batches. After promotion, K1 cannot
be restored; recovery keeps K2 authoritative and completes old-generation cleanup
in bounded restartable batches. Root-binding revisions and grant decisions do not
rotate because the physical root did not change; an owner revision/identity mismatch
instead becomes repair-required and revokes authority. It is never a silent
configuration replacement.

## Lock order and claim transaction

ADR 0009's
[canonical version-2 cross-slice database lock contract](../adr/0009-mcp-admission-contract.md#canonical-cross-slice-database-lock-order)
is the normative design sequence. #178/S3 owns and materializes that exact JSON
object at `web/lib/mcps/mcp-admission-lock-order-v2.json` and owns the one shared
database lock helper. Remaining S4 only imports that manifest/helper; it must not
generate, rewrite, fork, or shadow either one. Every S3/S4/S6 transaction-path
declaration imports that one runtime manifest.
A parity sentinel rejects any contract-name, version, policy, family, or ordering
drift from the ADR object. Each transaction acquires only its applicable row subset
as an ordered subsequence. It must not lock an unrelated row merely to fill a gap.
Candidate discovery and exact-replay lookup may happen without retained locks, but
every mutation reacquires its applicable rows in this order. New ledger, artifact,
action, alert, and resolution rows use the stable keys named by the contract for
uniqueness waits. Activation/drain locks the epoch and then instance rows
ascending. A
run-lifetime host-resource fence is an external precondition, not a database row:
post-claim worker revalidation, recovery, project create/repoint/tombstone, and
every filesystem-management path acquire it while holding **no** database locks,
then enter the order above. A path repoint acquires old and new opaque resource
refs in byte order. A missing-root create first uses its namespace reservation
fence. No database transaction waits for an external fence, preventing a fence↔row
cycle.

Pre-create reservations are a disjoint transaction family serialized by the
prefix-aware namespace/hierarchy fence. After acquiring that fence with zero
database locks, reservation-only planning, materialization, and cleanup lock
protocol epoch → exact connection-authenticated fresh root-writer instance →
active host-binding generation/rotation → host hierarchy guard → reservation.
Every transition revalidates active host/key/protocol/freshness/drain state,
dedicated principal, active generation, and exact root-writer credential
generation, and compare-and-sets the reservation's writer-instance/generation pin.
For a truly new project, final binding stays in this reservation-first family,
inserts the project, promotes the hierarchy owner, and marks the reservation
`bound`; it acquires no task/package/approval/run rows.

The reservation row is a terminal path-specific extension after the hierarchy
guard, not an omitted family in the delivery/recovery manifest. A reservation
transaction never continues into agent-run, evidence, audit, ledger, artifact,
action, integrity, or review-gate rows. The static path declarations and real
PostgreSQL opposing-order fixtures enforce that separation.

Attaching a root to an existing rootless project or repointing an existing project
to a nonexistent destination is a separate entity-first branch. After acquiring
all namespace/resource fences with no database lock, it locks the existing project
→ every applicable task/package/decision in the manifest's S3 subsequence → epoch
→ authenticated
writer instance → active generation/rotation → hierarchy guard → reservation. In
one transaction it compare-and-sets revision `0 → next positive` for attachment,
or current positive → next positive plus S3's negative decision reconciliation for
repoint; then it promotes the hierarchy binding and marks the reservation `bound`.
Reservation-only planning/materialization/cleanup never request a project row, and
no other entity-first path later locks a reservation. A stale, draining,
unregistered, spoofed-principal, divergent-key, or wrong-generation writer fails
before filesystem work and cannot clean up a newer owner's object.

Live health checks and other network/system probes happen before the transaction
and are not persistence inputs. Every current `ready → running` writer must call
the shared protocol-v2 package-claim primitive. In every mode it locks project →
task → all sibling packages ascending, recomputes candidate/dependency state under
lock, rejects an archived project, and proves no sibling has
`running|awaiting_review` status or a live execution lease. It then follows the
complete tail through epoch/authenticated instance, active binding generation/
rotation, the hierarchy guard for a local root, sibling runs, local-run evidence/
task-projection current-head set, ledgers, and reviews. The database aggregate must
reproduce the task's versioned zero/null projection exactly. A truly root-free
handoff omits generation/hierarchy and generic evidence because it has no root
authority; it still uses the epoch/instance claim barrier. The package status
remains the mandatory-review barrier; the task-local-change projection is the
separate all-mode host/repository evidence barrier, not a trusted cache. Gate,
acknowledgement, quarantine, cancellation, and repair change it only through the
one database function. This includes packet-free and handoff-only paths even when
there is no MCP project snapshot. For a packet-bearing package, extend that same
package/run claim transaction rather than creating an independent claim lifecycle:

1. Lock project, task, and every sibling package row in global order; recompute
   eligibility, require `root_maintenance_state:'none'` plus a populated unique
   host binding for any local root, and select the one candidate under those locks.
2. Lock the applicable approval/decision row after the package.
3. Re-read current package requirements and canonical admission. Verify exact required coverage and decision revision. For `allow_once`, also verify the approval ID + nonce is approved and unconsumed.
   The decision root-binding revision must equal the locked project and the package
   claim pin; an old-root decision is revoked.
4. The shared primitive sets transaction-local worker protocol 2 and exact instance
   ID, then locks/checks the epoch and that instance row. It proves `current_user`
   equals the row's dedicated principal, the instance is active/fresh and bound to
   the epoch host/key/generation, and pins those authoritative values.
5. For a local-root arm, lock/revalidate the epoch's active binding-generation/
   rotation row and the matching hierarchy owner/guard before any run or evidence
   row. Require the project/package pin to resolve through that locked generation.
   A root-free arm explicitly omits these inapplicable rows.
6. Lock sibling agent runs and the complete local-run evidence/task-projection
   current-head/review tail in global order.
   Recompute the database-owned task aggregate and require exact version/source
   equality plus zero/null; any stale or missing projection enters integrity hold.
7. Conditionally move the package to `running`; the trigger reuses the locked
   epoch/instance and records protocol 2 plus the instance/host/resource/root pin.
8. Create the `agent_runs` row and execution lease. For every local-root run, also
   create its unique generic local-run evidence row before commit. A truly root-free
   handoff creates neither local evidence nor packet evidence.
9. For a packet-bearing run, insert the per-run unique `claiming` audit with
   `claimToken`, `agentRunId`, `localRunEvidenceId`, database-time lease, and the
   immutable authorization snapshot. For `allow_once`, win the nonce-unique insert
   and mark that exact decision consumed using compare-and-set.
10. Commit package, run, execution lease, generic local evidence, optional packet
   claim, and optional nonce consumption together.

Only the winner proceeds. A failure at any statement rolls the whole claim transaction back: there is no running package, orphan run/evidence, issuance audit, consumed nonce, or attempt. Duplicate workers stop before repository reads. A run that does not need a packet creates neither an issuance audit nor a packet artifact, but every locally pinned run still has generic effect/repository evidence and cannot use legacy generic recovery.

## Packet-recovery admission guard

A validated `metadata.packet_issuance` or `metadata.packet_integrity_hold` marker
is an absolute S4-owned block before generic readiness calculation, admission
refresh, promotion, or package claim. `loadHandoffState`, direct
`progressWorkforce`, sibling-completion continuation, and periodic ready sweeps
must all call one S4 parser/guard before treating a `blocked` package as a
candidate. A known v2 marker with an invalid tuple also
fails closed and is never generically promoted. Current canonical grant coverage
does not clear this guard.

Only the versioned packet-recovery route or the S3→S4 one-time-reapproval resolver
may compare-and-set an exact `packet_issuance` marker away and move
`blocked → ready`. They reject `packet_integrity_hold` without mutation. An
integrity hold may be cleared only by the separately authorized, fingerprint-bound
privileged repair procedure below. Generic S2 broker retry, admission freshness,
and `promotePackageWithFreshnessCas` must preserve both kinds and blocked status. This prevents an always-allow package,
especially one with `submission_uncertain|submitted`, from rerunning without its
required operator acknowledgement/action.

The packet-independent `metadata.local_effect_recovery` marker uses the same
absolute candidate-guard seam. It carries only generic local-run evidence ID,
combined evidence fingerprint, typed local disposition, and bounded reason—no
assembly, delivery, grant, path, or packet action. Only an exact
`work_package_local_recovery_actions` mutation or privileged quarantine may change
it. Packet retry/reapproval/acknowledgement and generic readiness never do. A
packet run may carry both markers; each owner clears only its own state.

```ts
type LocalReviewReason =
  | 'host_apply_requires_review'
  | 'repository_change_requires_review'
  | 'host_and_repository_change_require_review';

type LocalEffectRecoveryMarkerV1 = {
  schemaVersion: 1;
  kind: 'local_effect_recovery';
  source: 'local-run-evidence';
  priorAgentRunId: string;
  localRunEvidenceId: string;
  evidenceFingerprint: string;
  taskDisposition: 'operator_hold';
  autoRetryable: false;
} & (
  | {
      reason: LocalReviewReason;
      disposition: 'review_local_changes';
      nextDisposition:
        | 'retry_local_execution'
        | 'acknowledge_possible_local_invocation'
        | 'dependent_packet';
      reviewState: 'review_required';
    }
  | {
      reason: LocalReviewReason;
      disposition: 'retry_local_execution';
      reviewState: 'reviewed';
    }
  | {
      reason: 'local_execution_interrupted';
      disposition: 'retry_local_execution';
      reviewState: 'not_applicable';
    }
  | {
      reason: 'local_invocation_uncertain';
      disposition: 'acknowledge_possible_local_invocation';
      reviewState: 'not_applicable' | 'reviewed';
      invocationAttemptId: string;
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      reason: 'local_invocation_uncertain';
      disposition: 'retry_local_execution';
      reviewState: 'not_applicable' | 'reviewed';
      invocationAttemptId: string;
      acknowledgedAt: string;
      acknowledgedByUserId: string;
    }
);

type LocalEffectIntegrityHoldCommonV1 = {
  schemaVersion: 1;
  kind: 'local_effect_integrity_hold';
  source: 'local-run-evidence';
  priorAgentRunId: string;
  alertId: string;
  evidenceFingerprint: string;
  taskDisposition: 'operator_hold';
  autoRetryable: false;
};

type LocalEffectIntegrityHoldV1 = LocalEffectIntegrityHoldCommonV1 & (
  | {
      reason: 'missing_local_evidence';
      localRunEvidenceId: null;
      expectedLocalRunEvidenceId: string;
      packetAuditId: string | null;
      projectId: string;
      taskId: string;
      packageId: string;
      claimIdentityFingerprint: string;
    }
  | {
      reason:
        | 'local_evidence_mismatch'
        | 'task_projection_mismatch'
        | 'quiescence_state_incoherent';
      localRunEvidenceId: string;
      expectedLocalRunEvidenceId: null;
      packetAuditId: string | null;
    }
);
```

Review-required evidence uses `disposition:'review_local_changes'` and stores the
invocation-dependent next disposition. An expired packet-free/handoff-only run
whose authenticated W2 receipt proves quiescence, whose host ledger plus every
repository comparison is exactly unchanged/not-applicable, **and** whose generic
invocation is `definitive_not_started` uses
`reason:'local_execution_interrupted'`, `disposition:'retry_local_execution'`, and
creates no packet marker. If invocation is `invoking|returned|uncertain`, the same
unchanged evidence instead uses `reason:'local_invocation_uncertain'` and
`disposition:'acknowledge_possible_local_invocation'`. Exact review of a no-packet
marker rotates its fingerprint and advances it to the stored invocation-dependent
next disposition; review itself never authorizes a new run. A packet run instead clears
the exact local marker and atomically advances its dependent packet marker to the
stored `nextDisposition`. Neither branch acknowledges external submission.
For a packet-free/handoff run whose generic invocation is `invoking|returned|
uncertain`, post-quiescence recovery uses `local_invocation_uncertain` and requires
its own acknowledgement before retry; a definitive pre-call failure may advance
directly to retry. A marker fingerprint commits to reason/disposition/review state,
the immutable generic invocation state and attempt ID, every host/repository review
fingerprint, and the acknowledgement null-or-actor/time tuple. Acknowledgement
rotates the fingerprint into the schema-valid second `local_invocation_uncertain`
arm above; it never relabels the reason as `local_execution_interrupted`. Missing,
mixed, or invented acknowledgement fields fail closed. Either coherent branch may
instead be declined/cancelled.

## Fencing lifecycle

The generic local-evidence lease is subordinate to the package execution lease;
the packet lease is an optional third predicate. One heartbeat operation renews
the execution and generic leases plus the packet lease only when `packetAuditId`
exists, under compare-and-set using PostgreSQL `now()`. Every heartbeat first
locks the protocol epoch, then the run/package-pinned worker-instance row, and
revalidates epoch 2, the unchanged active host/key/generation pointer, exact pinned
instance ID, active/fresh lifecycle state, and `current_user ===
instance.database_principal`; only then may it compare-and-set lease expiries.
Heartbeat configuration has validated minimum/maximum values and an interval
strictly below the lease duration. A worker must not renew any lease after
ownership of one required predicate or its connection-authenticated instance
authority is lost.

The worker verifies this discriminated predicate immediately before each governed
boundary:

```text
epoch.protocolVersion=2
epoch active host/key/generation equals the run/package pin
locked instance.id=package.claimWorkerInstanceId=run.workerInstanceId
instance.state=active and instance freshness > database now()
instance host/key/generation equals the epoch and run/package pin
current_user=instance.databasePrincipal
package.status=running
package.executionLease.runId=agentRunId
package.executionLease.expiresAt > database now()
localEvidence.agentRunId=agentRunId
localEvidence.claimToken matches localClaimToken
localEvidence.leaseExpiresAt > database now()
localEvidence.terminalState is null

when packetAuditId exists only:
  audit.id=packetAuditId
  audit.localRunEvidenceId=localEvidence.id
  audit.status=claiming
  audit.claimToken matches packetClaimToken
  audit.claimedByAgentRunId=agentRunId
  audit.leaseExpiresAt > database now()
```

Every governed repository read, assembly transition/read, packet exposure,
prompt submission, post-response stage, heartbeat, and live finalizer locks and
revalidates that epoch → pinned-instance principal prefix in the same transaction
before checking the execution/generic/optional-packet predicates. Recovery uses
its separately elected pinned recovery instance but proves the same
`current_user` equality. A caller-supplied instance ID or a copied still-live
execution, local-claim, packet-claim, or W2 token is therefore insufficient from a
different dedicated principal. Claim and recovery tokens are database-only bearer
material: they are excluded from ACP input, the bounded working exchange, queue
payloads after claim, task/artifact metadata, API/SSE/export output, logs,
diagnostics, and errors.

Packet, packet-free, and handoff-only local-root arms all require the execution and
generic predicates. Packet audit is optional, never fabricated. A truly root-free/
no-effect handoff is the only arm without generic evidence. Boundary failure
compare-and-sets only the predicates that exist; finalization requires the same
arm that the claim durably selected.

Boundaries:

- each repository-content read batch;
- packet exposure to prompt assembly;
- ACP prompt submission;
- immediately after ACP returns and before response-driven local work;
- entry to sandbox apply, validation, host apply, repository evidence, and
  completion preparation;
- before each host-file intent and immediately before its atomic replacement;
- atomic run/package/lease and packet-evidence finalization.

For project `always_allow`, each boundary also reruns canonical S1
`readEffectiveGrantState` under the S3 locks and requires
`source:'project-level'`, `grantMode:'always_allow'`, and `phase:'approved'`. The
locked matching project decision row must supply the expected revision and
coverage fingerprint that will be stored as snapshot
`source:'project_always_allow'`. That preserves denial-wins if a package-level denial
races the project grant. If revocation/narrowing/override committed before the
check, the worker starts no later governed read or exposure. This is cooperative
fencing: a grant change cannot recall bytes already read or cancel an external
operation that began after the previous check.

An invalid execution lease, token, expired lease, or superseded project decision prevents subsequent governed reads and persistence, but cannot revoke data already in memory.

While it owns every resource fence, the worker's first governed repository read is
a baseline operation that persists separately versioned opaque snapshots in the
generic local-run evidence row under execution/generic ownership plus optional
packet ownership:

1. The working-tree scanner covers canonical relative entry identity, type,
   metadata, and content needed to detect tracked, ignored, untracked, renamed, and
   deleted changes. It uses `lstat`, never follows symlinks, reads content only
   from regular files, represents links/special entries by bounded type/metadata,
   and never opens a FIFO, socket, or device. `.git` control paths are excluded
   only because the Git snapshots cover them; no reachable `.forge` control
   state is silently excluded.
2. A Git-control scanner resolves gitdir/common-dir and covers repository/worktree
   config, hooks, `HEAD` and resolved ref targets, index, worktree administration,
   submodule control state, packed-ref storage, reflogs, replace/grafts, shallow
   boundaries, maintenance metadata, alternates, and every other file that changes
   ref/object resolution without changing the working tree. Its independently
   versioned rules name only narrow volatile exclusions.
3. A Git-storage scanner covers loose objects; packs and indexes; multi-pack index;
   commit graph; alternates and their bounded resolved object stores; and other
   object-database files whose addition, deletion, replacement, truncation, or
   garbage collection changes repository integrity. It fingerprints opaque
   metadata/content or uses a platform filesystem snapshot/journal with equivalent
   proof. Adding unreachable objects is still a change. No exclusion is justified
   merely because an object is not currently reachable.

Forge invokes Git only through one sterile environment builder: an absolute,
release-pinned Git binary under `env -i`; protected empty `HOME` and
`XDG_CONFIG_HOME`; system/global configuration disabled; every inherited
`GIT_CONFIG_*`, object/index/worktree/common-dir/alternate, attributes, pager,
editor, credential, SSH, and askpass variable cleared; hooks, optional locks, and
automatic maintenance disabled unless the bounded command explicitly owns them.
The single Git no-lazy-fetch predicate is: **every Git child, including the
capability probe, receives exact `GIT_NO_LAZY_FETCH=1`; an operational Git child
also receives global option `--no-lazy-fetch` immediately after the binary if and
only if a checked, release-pinned capability probe for that exact binary digest
reports support.** The probe runs the pinned binary without repository discovery,
configuration, object access, or network access and records the immutable
`{gitBinaryDigest,supportsNoLazyFetch}` result. A missing, mismatched, or ambiguous
probe disables local execution; it is not interpreted as an unsupported binary.
Every probe and operational Git/scanner subprocess runs in the same network-denied
namespace, with prompts disabled and every Git transport protocol disabled. The
checked-in builder refuses to spawn any Git child if the environment variable is
absent or changed, or if its argument vector disagrees with the probed capability.
Repository access must be complete from the already-fenced local object stores;
Forge never permits a
Git command to satisfy a read through lazy fetch. Before any Git execution, the
non-Git parser rejects `extensions.partialClone`, `remote.*.promisor`, partial-clone
filters, `.promisor` pack markers, missing reachable promisor objects, or any other
configuration/state that could contact a remote object provider. The first release
therefore fails a partial clone as `preflight_failed`; it does not silently treat an
offline or partially materialized object database as a complete baseline. This
network denial applies to Forge's evidence commands, not as a claim that the later
unconfined ACP runtime lacks network access.
Before invoking Git, the control scanner parses repository/worktree config without
executing Git. External `include.path|includeIf`, external/symlinked
`core.hooksPath`, external attributes, executable filter/diff/textconv/fsmonitor/
credential helpers, and any other executable or external-path authority are
rejected or placed inside the same ordered fence and scan; the first release
chooses rejection. Worktree config, `.git/info/*`, and symlink targets are explicit
control inputs. A symlink is never accepted merely because link metadata is stable.

A linked/external gitdir or common directory receives its own ordered resource
fence and all Git-control/storage scans. An alternate object store must be inside a
separately fenced, configured bounded allowlist; otherwise protocol-v2 local
execution is unavailable before any project read.

Scanner contract version 1 persists the selected limits and allows operator values
only between 1 and these hard maxima:

| Scanner | Defaults: files / per file / total / depth / time | Hard maxima |
|---|---|---|
| working tree | 100,000 / 32 MiB / 4 GiB / 128 / 60 s | 500,000 / 256 MiB / 32 GiB / 256 / 300 s |
| Git control | 100,000 / 64 MiB / 4 GiB / 64 / 60 s | 500,000 / 1 GiB / 32 GiB / 128 / 300 s |
| Git storage | 500,000 / 8 GiB / 64 GiB / 32 / 120 s | 2,000,000 / 64 GiB / 512 GiB / 64 / 600 s |

Per-file and total-byte processing is streaming; a large pack is never buffered.
Two matching ordered passes of all three scanners—or a
platform snapshot with equivalent proof—are required for stability. The combined
comparison/review/task fingerprint commits to working-tree, Git-control, and Git-
storage snapshots. No path, file/control/object content, hook, config, or ref
appears in packet evidence or public APIs. Baseline churn, overflow,
unsupported entry metadata, or any incomplete scan stops before packet selection
or ACP exposure as `preflight_failed`. The same condition after possible exposure
produces bounded `unverifiable`, never silently unchanged. For every ACP-invoking
local run, the owner first CAS-persists generic invocation
`not_started → invoking` with a random attempt ID and database intent time under
execution/generic ownership. Only that exact still-live owner and attempt may call
the adapter or advance the invocation state. It may compare-and-set
`invoking → definitive_not_started` only when the trusted adapter boundary returns
the typed `pre_io_refusal` result while the same ownership tokens remain live; that
result attests that no adapter child, request serialization, socket/network write,
credential use, or repository operation began. A durable returned call becomes
`returned`. Crash, timeout, ownership loss, an untyped refusal, or any adapter result
that cannot prove the complete pre-I/O predicate becomes `uncertain`. Orphan/stale
recovery always maps a surviving `invoking` row to `uncertain`; it can never infer
or write `definitive_not_started`. Restart never resumes `invoking`.
For a packet-bearing run, the same attempt ID is then used when the owner
CAS-persists `delivery.state:'submitting'` with `submissionAttemptId` and database-
time `intentAt`. Only then may it perform external I/O. A
definitive pre-acceptance transport rejection may become `submission_failed`; an
accepted response becomes `submitted`. A crash, timeout, or lease expiry from
`submitting` becomes `submission_uncertain`, because PostgreSQL cannot prove what
the transport accepted. `submitting|submission_uncertain|submitted` is never
automatically resubmitted. A failure before the intent CAS is still
`not_exposed` and may follow the package's explicit retry policy without claiming
that an external request started.

One committed packet claim permits at most one external model/ACP submission.
Packet-bearing execution sets the AI SDK `generateText` option `maxRetries:0`,
requires every adapter/provider transport beneath it to disable replay after a
request may have been accepted, and bypasses the executor's current
`MAX_GENERATION_ATTEMPTS` response-validation loop after the first transport call.
If the provider accepted a response that Forge later rejects as malformed or
invalid, delivery remains `submitted`, the run terminalizes as failed, and the
operator follows the same possible-prior-work recovery path; Forge does not submit
a correction prompt on that claim. Every local-root ACP invocation—including
packet-free and handoff-only execution—is likewise at most once per generic local-
run evidence row because ACP may mutate the repository before returning a
malformed response. Packet-free generation sets adapter/provider retries to zero
and bypasses the response-validation retry loop. A malformed, invalid, uncertain,
or failed response terminalizes that run; changed/unverifiable host or repository
evidence creates exact local review. `definitive_not_started` may expose explicit
local retry without prior-invocation copy. `invoking|returned|uncertain` requires
the separate `acknowledge_possible_local_invocation` action before another run,
even when repository evidence is unchanged, because ACP may have used network or
credentials. Declining/cancelling never requires that acknowledgement. A later
invocation is a new run after the owning action and normal claim checks, never an
automatic retry inside the old run.

### Run-lifetime host-resource fence and post-submission quiescence

Forge derives an internal `hostResourceRef` from the operator-controlled stable
host ID and the platform-normalized canonical physical root. Canonicalization
resolves symlinks, applies case folding only on a case-insensitive filesystem, and
uses stable filesystem device/object identity where the host supports it. An
installation-keyed digest makes the reference opaque outside the trusted host
boundary. If Forge cannot prove that aliases converge to one identity, it disables
protocol-v2 local-root execution on that host. `hostResourceRef` is unrelated to
the random project-scoped packet `rootRef` and never appears in packet evidence,
copy, logs, queue payloads, or public APIs.

The project row owns the authoritative host ID, resource reference, and monotonic
root-binding revision. The all-mode claim transaction pins all three on the run.
After claim commit and **before the first repository read, context selection, or
packet assembly**, the worker acquires the corresponding exclusive operating-
system advisory lock in Forge-controlled host state while holding no database
locks. It then enters a short top-down transaction and revalidates the project
binding, claim, execution/generic leases, and optional packet lease. A mismatch fails before any repository bytes are
read. The worker retains this one resource fence through packet assembly,
submission, response-driven local work, atomic terminal finalization, and
descendant quiescence. Packet-free and handoff-only execution must do the same
whenever they read or mutate the local root. This is host-resource exclusion, not
distributed filesystem fencing or an ACP sandbox.

A dedicated host fence service, outside the queue worker's failure domain and
running under a separate protected operating-system principal, owns the resource
lock and durable local lease record. Its state directory and socket/API are not
readable, writable, signalable, or callable by the worker/ACP principal except
through the narrow authenticated client endpoint. Every request verifies kernel
peer credentials plus an unguessable lease capability bound to run ID, current
worker instance ID, root identity, and containment-group ID. Release always asks
the kernel adapter for emptiness; it never trusts a caller's declaration. State
tamper/corruption, peer mismatch, replay, cross-run/root token use, service death,
or unverifiable adapter state marks the lease `orphaned|disabled` and blocks root
reuse until protected-state recovery proves the exact group empty.

S4 also migrates durable Forge control/run state out of project `.forge/task-runs`
into this protected principal's host-state root. Mode `0700` under the same worker
owner is not protection from ACP. The service owns a bounded pool of preprovisioned
principal pairs `{trustedShimUser,untrustedRunUser}` (default 32, configurable
1–256). Both users are distinct from the service, queue worker, and every other
slot. The durable execution identity is `{slotRef,slotGeneration,runId}`, never a
bare reusable Unix user ID. Allocation increments the protected generation and
binds the socket capability to the trusted-shim UID plus slot generation/run/root/
group. The untrusted ACP user never receives that capability. Pool exhaustion
applies backpressure while the worker heartbeats ownership; bounded timeout fails
preflight before repository access.

A slot is reusable only after the service proves its cgroup and PID namespace empty, closes and
ingests the exchange, proves no inherited descriptors/processes, atomically deletes
every run-accessible file/socket or transfers it to the protected owner, rotates
the capability/generation, and records cleanup completion. Crash during cleanup
keeps the slot unavailable; service restart resumes from protected state. The one
bounded exchange directory is accessible only to the allocated slot generation;
the protected parent is non-searchable and sibling/historical exchanges are
inaccessible. Inputs enter through an allowlisted one-way handoff, and outputs are
accepted only through the service after type/size validation. Exchange identity,
slot generation, manifest digest, and final digest are part of generic evidence;
no path or UID is public. The lifecycle capability, state handle, and control
socket are never placed in ACP environment/arguments, inherited descriptors, or
readable storage. They exist only in the non-dumpable trusted shim and protected
service. The shim runs under its paired principal, accepts no repository-supplied
code, path, command, environment, or plugin, and launches the already-validated
adapter under the untrusted run user. The run user's mount namespace exposes the
project/exchange through `nosuid,nodev` bind mounts; preflight rejects any setuid/
setgid entry or `security.capability` extended attribute before access. Its PID
namespace/procfs view, `PR_SET_DUMPABLE=0`, ptrace policy, and UID separation
prevent ACP from reading or signalling the shim, queue worker, service, or another
slot. If the platform cannot enforce this principal/exchange boundary,
local protocol-v2 execution is disabled; a project-local reachable `.forge` tree
must instead be included in repository comparison and can never be called
protected.

The long-lived queue/control worker stays outside containment. For each run, the
service creates the authenticated trusted shim under the slot's shim principal;
that shim creates the untrusted adapter child. The service places the shim, ACP,
validation, response-driven work, and every descendant in one non-escapable
lease group before any member can access the project. The adapter—not inherited
descriptors, parent/child guesses, process names, or a best-effort process-group
scan—proves whether that complete per-run group is empty. On normal completion the
child commits/quiesces the run, exits, and the service releases only after it
independently observes the group empty; the queue worker need not exit. Execution-
child, control-channel, adapter, or service loss changes the durable lease to
`orphaned`; database recovery and root management remain actionless. On restart,
the service reacquires/retains the resource fence from protected durable state and
may release it only after the adapter proves the exact group empty. Protocol-v2
local execution is disabled on any host where a descendant can escape containment,
the protected service boundary is unavailable, or emptiness cannot be proved.

The first release-supported boundary is Ubuntu 24.04/Linux kernel 6.8 or newer
with unified cgroup v2, systemd transient per-run scopes, dedicated service/worker/
paired shim/run Unix user IDs, a private PID/mount namespace with restricted
procfs and `nosuid,nodev` project/exchange views, and a Unix-domain socket authenticated with kernel
`SO_PEERCRED`. Protected service state is root/service-owned and unreadable by the
worker/run users; the narrow socket access control list permits connection but
never substitutes for peer-credential and capability checks. The checked-in
capability preflight must prove cgroup delegation, descendant containment/kill/
emptiness, distinct users, socket peer credentials, protected state permissions,
setid/file-capability rejection, proc/ptrace/signal isolation, a non-dumpable shim,
and service restart recovery before registration advertises the adapter version.
macOS, Windows, containers without delegated cgroup v2, and ordinary same-user
development mode remain protocol-v2 local-root disabled until an equivalent
reviewed adapter exists. This is an explicit Linux-only v2 release decision, not
an automatic macOS downgrade: installer/upgrade preflight reports
`local_execution_protocol:'unsupported_host'`; the activation command refuses;
the epoch stays 1; no v2 drain, path scrub, or v2 local claim begins. Existing
operators may remain on the supported pre-cutover/legacy stream, whose UI says
plainly that local execution does not have the v2 containment guarantee, or migrate
the installation/project to a supported Linux host. The release checklist must
update the installer, health surface, operator guide, compatibility matrix, and
rollback procedure before shipping. Queued legacy work is drained or left on the
legacy stream, never silently failed by an attempted v2 activation.

This containment establishes liveness and resource exclusion only. It does not
restrict ACP shell, network, credential, or filesystem permissions and is not a
security sandbox. Prompt text likewise cannot stop equivalent direct repository
work. A live owner waits until the adapter proves the ACP subtree empty, then—before
any Forge response-driven stage—computes post-exposure working-tree, Git-control,
and Git-storage fingerprints plus the exchange digest in the generic local-run
record.
After owner loss, same-host recovery waits for the complete lease group to become
empty before computing it. A detected or unverifiable change sets fingerprint-
bound review for each changed/unverifiable repository domain to `review_required`
even when Forge's own effect intent
is `not_started` and its host-apply ledger is empty. After a valid provider response
this stops later local stages and terminalizes with bounded
`external_repository_change_requires_review`; submission-uncertain recovery keeps
its already persisted delivery-specific primary cause but the same review barrier. A new run,
reapproval, retry, unrelated acknowledgement, or root-management operation cannot
proceed until review is `reviewed` or a privileged quarantine resolution records
an authorized `abandoned` disposition. The exact fingerprint-bound
`review_local_changes` acknowledgement that atomically changes `review_required →
reviewed`, and the privileged exact quarantine transition, are the only actions
allowed to cross this barrier; otherwise the barrier would block its own
resolution.

These rules are packet-independent. Packet-free and handoff-only local-root runs
create, heartbeat, quiesce, recover, review, and terminalize the same generic
record. If such a run dies after any root access, W2 and the protected service must
prove group emptiness and complete all repository comparisons before release. Changed or
unverifiable state creates `local_effect_recovery` and the exact task barrier; it
never manufactures packet assembly/delivery evidence or a packet CTA. Only a
truly root-free/no-effect handoff may omit this lifecycle.

Project creation, root repoint, tombstone/delete, recursive filesystem cleanup,
and every other root-management path participate in the same fence and writer-
protocol contract. Existing candidate roots use their physical resource fence.
A destination that does not exist first derives a namespace identity from the
authoritative host, binding-key fingerprint, canonical existing parent physical
identity, and each platform-normalized missing suffix segment. The hierarchy fence
service takes shared locks on every strict canonical ancestor and an exclusive
lock on the complete candidate root, shallow-to-deep with opaque references as the
tie-breaker. Siblings may share ancestor locks; an ancestor/descendant pair
conflicts in either acquisition order. The route acquires that hierarchy fence
before `mkdir`, clone, or cleanup and inserts a random-token reservation plus its
full/ancestor hierarchy claim in a short transaction. It retains the hierarchy
fence through `planned → materialized`,
derives/acquires the new physical resource fence, and atomically converts the
reservation to the unique live project binding. A loser or crash recovery may
delete only an object whose reservation token **and** recorded physical object
identity still match and whose protected subtree has no other live reservation or
binding. Later path reuse, a mismatched object, or any descendant claim becomes
`cleanup_required`, never an unscoped recursive delete.

Root-management paths discover current/candidate identities without retained
database locks, acquire hierarchical namespace locks and resource fences in the
canonical order above,
then start a fresh top-down transaction. That transaction sets the epoch-2 writer
instance/maintenance settings, revalidates the old binding and revision, enforces
the exact-root unique index plus the deferred no-ancestor/no-descendant hierarchy
constraint, and rejects mutation while any pinned
claim/lease, sibling `awaiting_review`, active effect, unproven containment
quiescence, any recognized S3/S4/local-effect marker, nonzero/stale/wrong-version/
mismatched task-local-change projection, host-ledger review, or working-tree/Git-
control/Git-storage review remains. The transaction independently joins and checks
all three repository-domain fingerprints rather than trusting only the task
projection cache or combined digest. These barriers apply to
terminal and nonterminal tasks. A normal marker
must be resolved or its task explicitly cancelled without rewriting evidence.
Cancellation acquires the complete applicable tail, requires quiescent effects and
completed exact host/repository review, appends actor/reason audit, and retains
every marker/audit/artifact.

Create compare-and-sets unbound revision `0` to the next positive revision and
inserts the unique hierarchy binding. Repoint atomically advances its revision/binding
and invokes S3's `project_root_repoint` negative reconciler so old-root decisions
become revoked before commit. Project deletion is a tombstone, never a cascading
row delete. After proving no live execution, mandatory review, effect, or exact
local-change barrier, its top-down finalization atomically closes every nonterminal
task/package with bounded reason `project_removed`, sets the existing
`archived_at` plus actor/reason audit, clears `local_path` and the live host/
hierarchy binding, and releases the partial unique key while retaining the project
`rootRef`, tasks, packages, runs, audits, artifacts, actions, alerts, and resolutions.
Queue discovery, direct progression, sibling continuation, and every all-mode
claim reject an archived project even if a stale wake remains. Normal queries hide
tombstones; evidence/operator queries address them explicitly.
A hard purge is forbidden until a separate retention/export architecture exists.
Recursive cleanup first persists typed `deleting` maintenance intent, performs
filesystem work outside the database transaction while retaining the fence, and
then commits the tombstone in a fresh top-down transaction. Crash recovery
reacquires the same fence and either completes the exact intent or enters bounded
manual repair; it never guesses. No path waits for an external fence while holding
a database lock.

This root-binding protocol closes path reuse and overlap: Project B cannot claim
the same, ancestor, or descendant root while Project A owns the hierarchy/resource
fences, and the unique/hierarchy binding cannot move or be
reused until A has no live pin, containment quiescence is proven, and every exact
host/repository review or abandonment is complete. It also prevents a path edit or
tombstone cleanup from changing the repository underneath a packet being assembled.

A packet-bearing valid response is persisted as `delivery:'submitted'` before
Forge applies any response-driven local effect; packet-free generation records its
own response boundary only in the generic row, and handoff-only work has no packet
delivery field. The worker already owns the run-lifetime resource fence. Before
any response-driven or direct local effect, a short top-down transaction
revalidates the pinned binding and generic local lease plus optional packet lease,
then CAS-persists an `active` effect intent with authoritative
opaque host ID, random fence token, and current closed stage on the generic row.
The generic/optional-packet combined heartbeat remains active. Before every later stage and before each file
replacement, the worker rechecks the binding and its discriminated required
ownership predicates and
advances the durable stage under compare-and-set. Each host file uses a validated
write-plan entry and:

1. persists ledger entry `planned → applying` under the fence and ownership token;
2. performs one atomic replacement only after another ownership check;
3. persists `applying → applied` before starting the next entry.

A crash after replacement but before step 3 leaves `applying`; recovery later
maps it to `unknown`, never guesses applied/unapplied. A live owner that catches a
failed/ownership-lost step 3 has the same uncertainty: while retaining the fence it
must durably map the entry to `unknown` before terminalizing. If PostgreSQL is
unavailable it leaves intent active and the run nonterminal for fenced recovery;
it cannot report a caught terminal failure or success from memory. The ledger references the
existing output-plan entry identity/ordinal. Exact paths remain in the separate
authorized host-write/output evidence where already required for repository work;
they never enter packet audit, marker, artifact, alert, API copy, or logs.

The per-run execution child holds the resource fence through the atomic database
finalizer. If local work began, that commit sets the effect intent to `quiesced`;
a no-local-stage success truthfully remains `not_started`. The child then exits and
the protected service releases only after independent per-run group emptiness.

Stale recovery preserves the original claiming instance as immutable history but
does not require that dead process to remain fresh. A fresh worker W2 first asks
the protected service for a single-use election challenge. The service verifies
W2's kernel peer identity and binds the signed/message-authentication-code (MAC)
challenge to local-run evidence/run, W1, proposed W2, root/group, recovery epoch,
and expiry; the challenge alone grants no lease. W2 then enters a short top-down
transaction, proves its authoritative host ID equals the locked package/run pin,
locks the epoch and both W1/W2 instance rows in ascending ID order, and requires
W2 to be distinct, `active`, database-time fresh, same-host/key/protocol/fence/
containment generation, and not draining. `current_user` must equal W2's dedicated
principal; naming W2 in a setting is insufficient. For
`active|quiesced`, the pinned host must also equal `effectIntent.hostId`;
`not_started` has no intent host. The transaction compare-and-sets the generic
local-run evidence's current recovery-instance ID, database-time lease, challenge
digest/expiry, and recovery epoch, then commits. It never stores the raw service
capability. No process may reuse W1's stable instance ID or principal as W2.

With no database locks held, the service verifies the committed election through
one selected mechanism: a service-only PostgreSQL reader. A separately revocable
`NOINHERIT` client-certificate principal can `SELECT` only the fixed
`forge_committed_local_recovery_elections` security-barrier view, not base tables,
functions, registry rows, or mutation APIs. Workers and the maintenance command
cannot use or read that credential. The service connects with pinned TLS, fixed
`search_path`, `READ ONLY READ COMMITTED`, and one parameterized query keyed by the
random election ID plus challenge digest. The view returns only a committed,
unexpired row whose run/local-evidence/W1/W2/root/group/recovery-epoch/binding-
generation tuple matches, plus the nullable committed receipt fingerprint/version.
It does **not** claim to observe protected-service burn state. PostgreSQL visibility
is the election/receipt commit proof; W2-supplied state is never proof. Reader credential rotation
overlaps only inside protected service configuration, and revocation or reader/
TLS outage fails closed without burning the challenge. The service then atomically
test-and-burns its protected challenge record while durably storing one replayable
receipt bound to the same tuple, observed database election version, and bounded
receipt expiry. It returns that receipt. A rolled-back, expired, copied,
cross-run/root/W2/generation, or already burned challenge is actionless. W2
persists only the receipt fingerprint in a second top-down compare-and-set; the
service re-queries the same view for that exact committed fingerprint/version and
checks its own unexpired protected receipt before idempotently granting takeover
once. Exact replay returns the same receipt/takeover result; a different election
or tuple never does. Lock acquisition alone is never proof of quiescence: the adapter
must prove the complete per-run execution group empty. W2 then re-enters the
canonical database order, relocks W1/W2 ascending after the epoch, revalidates its
principal/freshness, recovery epoch/lease, challenge burn and receipt, and rereads
the candidate. Only then may it terminalize and expose a recovery marker; it maps
leftover `applying` entries to `unknown`, fingerprints the final ledger and every
repository snapshot, and persists `quiesced` when local work began. An actionable
marker requires effect intent `not_started|quiesced`, never `active`. Crash before
database election can discard the challenge; crash after election but before burn
resumes the same election; crash after burn but before receipt persistence replays
the protected receipt exactly once; service restart reloads burn/receipt state from
protected storage.

Receipt expiry has one explicit fail-closed re-election path. The database stores a
bounded receipt expiry in the committed election, and the view stops returning the
old election after that database time. Only after both the database recovery lease
and committed receipt have expired may the protected service prove that it never
granted takeover, atomically mark its local receipt `expired_ungranted`, and mint a
new challenge bound to that protected expiry-tombstone fingerprint and the next
recovery epoch. A fresh top-down transaction compare-and-sets the exact expired
owner/election/receipt, appends an immutable database election tombstone, increments
the recovery epoch, and stores the new candidate/challenge. The service burns the
new challenge only after its committed-election view matches both the greater epoch
and its local tombstone. If takeover was already granted, the service cannot create
`expired_ungranted`; the same owner must finish or the state remains actionless for
protected recovery. An old receipt, owner, lease, or delayed terminalizer fails the
greater-epoch compare-and-set. Thus no boundary elects a concurrent second W2 or
grants a database-only or service-only replay, while a receipt expiring before
takeover no longer strands the run forever.

A wrong-host/key/capability/principal W2, stale/draining/unregistered W2, same-ID takeover,
nonempty/unverifiable group, orphaned service lease, or unavailable authoritative
host is alert-only: recovery changes no run/package/marker state, creates no retry
action, emits one deduplicated bounded `local_run_quiescence_unproven`
integrity alert, and retries only through a fresh instance on the authoritative
owning host. Thus no actionable marker or later run can coexist with an in-flight
stale host operation.

The quiescence-alert insert is the sole path that does not own the resource fence. It
never waits for that fence while holding database locks. After a bounded failed
lease/quiescence acquisition—or after authoritative host mismatch/unavailability prevents an
attempt—it starts a short fresh transaction, follows the full applicable database
order through project → task → siblings → decision → epoch → authenticated
instances → active binding generation/rotation → hierarchy guard → run → generic
evidence/task projection → optional audit → host ledger → artifacts → actions →
alert, revalidates the
same active intent/fingerprint, inserts or rereads the unique alert, and commits
without changing run/package/lease/marker state.

A separately revocable, non-worker watchdog login owns the total-worker-loss case.
It has `SELECT` only on one bounded recovery/membership view and `EXECUTE` only on
`forge.forge_alert_unavailable_recovery_worker()`. That zero-argument function is
`SECURITY DEFINER`, owned by a distinct non-login role, uses fixed
`pg_catalog,forge,pg_temp` search path plus fully schema-qualified objects, and has
`PUBLIC` execution revoked. It derives candidate identities internally from
immutable `session_user` and database state; it accepts no caller-supplied project,
run, evidence, instance, host, generation, reason, or fingerprint. The watchdog is
non-superuser, cannot `SET ROLE` or change session authorization, and has no direct
table DML, heartbeat, claim, fence, terminalize, repair, repository-read, or
credential access. After database-time generic lease expiry, the function follows
the same order through epoch, instance rows, and generation/rotation, proves zero
eligible fresh W2 on the pinned host/generation, and inserts/rereads only the
deduplicated quiescence alert. Notification happens after commit and failed delivery
is retried from the durable alert. Duplicate watchdogs or a concurrent replacement
yield one alert and never prevent the newly active W2 from resuming normal election.

## Packet metadata staging

Before the first packet-selection or repository-content read, the live owner
compare-and-sets a durable `assembling` intent with a random assembly attempt ID and
database time under the packet arm's execution, generic-local, and packet ownership
predicates. Immediately after assembly and before prompt buffering, logging,
rendering, ACP request construction, or any other exposure, that same owner
compare-and-sets the intent to one immutable `assembled` snapshot. A crash,
ownership loss, or database failure while `assembling` becomes terminal
`assembly_unconfirmed`: Forge cannot prove whether the final byte was selected, so
it persists no counts or `rootRef`, never reassembles that claim, and never calls it
`not_assembled`. Assembly state and delivery outcome are separate so a later
submission failure cannot rewrite known assembly evidence:

```ts
type PacketFailureCode =
  | 'authorization_changed'
  | 'execution_lease_expired'
  | 'local_evidence_lease_expired'
  | 'issuance_lease_expired'
  | 'worker_stopped'
  | 'preflight_failed'
  | 'assembly_failed'
  | 'submission_rejected'
  | 'submission_uncertain'
  | 'provider_response_invalid'
  | 'external_repository_change_requires_review'
  | 'post_submission_execution_failed';

type PostSubmissionFailureStage =
  | 'sandbox_apply'
  | 'validation'
  | 'host_apply'
  | 'repository_evidence'
  | 'completion_preparation';

type LocalRunEffectIntent =
  | { state: 'not_started' }
  | {
      state: 'active';
      stage: PostSubmissionFailureStage;
      hostId: string;
      fenceToken: string;
      hostApplyLedgerFingerprint: string | null;
      startedAt: string;
    }
  | {
      state: 'quiesced';
      lastStage: PostSubmissionFailureStage;
      hostId: string;
      fenceToken: string;
      hostApplyLedgerFingerprint: string | null;
      quiescedAt: string;
    };

type HostApplyRecoveryReview =
  | { state: 'not_applicable' }
  | {
      state: 'review_required';
      ledgerFingerprint: string;
      reviewedAt: null;
      reviewedByUserId: null;
    }
  | {
      state: 'reviewed';
      ledgerFingerprint: string;
      reviewedAt: string;
      reviewedByUserId: string;
    };

type RepositoryChangeReview =
  | {
      state: 'not_applicable';
      baselineFingerprint: string | null;
      changeResult: 'not_observed' | 'unchanged';
    }
  | {
      state: 'review_required';
      baselineFingerprint: string;
      changeResult: 'changed' | 'unverifiable';
      changeFingerprint: string;
      reviewedAt: null;
      reviewedByUserId: null;
    }
  | {
      state: 'reviewed';
      baselineFingerprint: string;
      changeResult: 'changed' | 'unverifiable';
      changeFingerprint: string;
      reviewedAt: string;
      reviewedByUserId: string;
    };

const PACKET_REDACTION_CATEGORIES = [
  'private_key_blocks',
  'authorization_bearer',
  'docker_auth',
  'netrc_credentials',
  'pgpass_credentials',
  'secret_like_assignments',
  'structured_secret_keys',
  'database_urls',
  'url_userinfo',
  'well_known_token_prefixes',
  'cloud_api_tokens',
  'jwt',
] as const;

type PacketRedactionCategory = typeof PACKET_REDACTION_CATEGORIES[number];
type PacketRedactionSummary = Partial<Record<PacketRedactionCategory, number>>;

type PacketAssemblyState =
  | {
      state: 'assembled';
      rootRef: string;
      includedCount: number;
      byteCount: number;
      omittedCount: number;
      redactionSummary: PacketRedactionSummary;
    }
  | {
      state: 'not_assembled';
      failureStage: 'claim' | 'preflight';
    }
  | {
      state: 'assembling';
      assemblyAttemptId: string;
      intentAt: string;
    }
  | {
      state: 'assembly_unconfirmed';
      failureStage: 'assembly';
      assemblyAttemptId: string;
    };

type TerminalPacketAssemblyState = Exclude<
  PacketAssemblyState,
  { state: 'assembling' }
>;

// This array is the one production source for writer, database validator,
// Drizzle parser, API serializer, S5 presenter, and parity fixtures.

type PacketDeliveryOutcome =
  | { state: 'not_exposed' }
  | {
      state: 'submitting';
      submissionAttemptId: string;
      intentAt: string;
    }
  | {
      state: 'submission_failed';
    }
  | { state: 'submitted'; submittedAt: string }
  | { state: 'submission_uncertain' };

type TerminalPacketDeliveryOutcome = Exclude<
  PacketDeliveryOutcome,
  { state: 'submitting' }
>;

type PacketTerminalOutcome =
  | { status: 'succeeded' }
  | {
      status: 'failed';
      failureCode: Exclude<
        PacketFailureCode,
        'post_submission_execution_failed'
      >;
    }
  | {
      status: 'failed';
      failureCode: 'post_submission_execution_failed';
      failureStage: PostSubmissionFailureStage;
    };

type PacketIssuanceRecoveryCommon = {
  schemaVersion: 2;
  kind: 'packet_issuance';
  priorAgentRunId: string;
  priorRuntimeAuditId: string;
  recoveryFailure: Extract<PacketTerminalOutcome, { status: 'failed' }>;
  hostApplyReview: HostApplyRecoveryReview;
  repositoryReviews: {
    workingTree: RepositoryChangeReview;
    gitControl: RepositoryChangeReview;
    gitStorage: RepositoryChangeReview;
  };
  combinedRepositoryReviewFingerprint: string;
  autoRetryable: false;
  markerFingerprint: string;
  policyFingerprint: string;
  coverageFingerprint: string;
};

type PacketIssuanceRecoveryState =
  | {
      grantMode: 'allow_once';
      deliveryState: 'submission_failed';
      disposition: 'review_local_changes';
      nextDisposition: 'reapprove_allow_once';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'allow_once';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'review_local_changes';
      nextDisposition: 'review_then_reapprove_allow_once';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'submission_failed';
      disposition: 'review_local_changes';
      nextDisposition: 'retry_execution';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'review_local_changes';
      nextDisposition: 'review_submission';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'allow_once';
      deliveryState: 'not_exposed' | 'submission_failed';
      disposition: 'reapprove_allow_once';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'allow_once';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'review_then_reapprove_allow_once';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'allow_once';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'reapprove_allow_once';
      acknowledgedAt: string;
      acknowledgedByUserId: string;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'not_exposed' | 'submission_failed';
      disposition: 'retry_execution';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'review_submission';
      acknowledgedAt: null;
      acknowledgedByUserId: null;
    }
  | {
      grantMode: 'always_allow';
      deliveryState: 'submission_uncertain' | 'submitted';
      disposition: 'reviewed_submission';
      acknowledgedAt: string;
      acknowledgedByUserId: string;
    };

type PacketIssuanceRecoveryMarkerV2 =
  PacketIssuanceRecoveryCommon & PacketIssuanceRecoveryState;

type PacketIntegrityHoldV2 = {
  schemaVersion: 2;
  kind: 'packet_integrity_hold';
  priorAgentRunId: string;
  priorRuntimeAuditId: string;
  reason:
    | 'audit_artifact_mismatch'
    | 'terminal_success_materialization_incomplete';
  autoRetryable: false;
  markerFingerprint: string;
};

type LocalRunIntegrityAlertReason =
  | PacketIntegrityHoldV2['reason']
  | LocalEffectIntegrityHoldV1['reason']
  | 'local_run_quiescence_unproven';
```

The S4 producer imports `PACKET_REDACTION_CATEGORIES` and persists occurrence
counts only. It never persists a configured-pattern list, arbitrary kind string, or
producer-supplied JSON key. A schema-qualified database validation function rejects
unknown keys, non-integer/negative/over-5,000 values, more than the closed category
count, and any non-object summary before an audit or artifact can commit. The
Drizzle parser, repair/finalizer, API serializer, and S5 reader import the same
canonical category list and fail closed on an unknown key; none sanitizes or echoes
it. Thus a selected path, content, prompt, or credential sentinel cannot be encoded
as a redaction-summary key and reach an artifact, API, log, or UI.

The terminal tuple is normative. `succeeded` permits only `assembled + submitted`
and creates no recovery marker. A failed tuple permits only:

| Assembly | Delivery | Allowed failure code |
|---|---|---|
| `not_assembled/claim` | `not_exposed` | `authorization_changed`, `execution_lease_expired`, `local_evidence_lease_expired`, `issuance_lease_expired` |
| `not_assembled/preflight` | `not_exposed` | prior row plus `worker_stopped`, `preflight_failed` |
| `assembly_unconfirmed/assembly` | `not_exposed` | authorization/lease codes plus `worker_stopped`, `assembly_failed`; no counts or `rootRef` |
| `assembled` | `not_exposed` | authorization/lease codes or `worker_stopped` |
| `assembled` | `submission_failed` | `submission_rejected` |
| `assembled` | `submission_uncertain` | authorization/lease codes, `worker_stopped`, or `submission_uncertain` |
| `assembled` | `submitted` | authorization/lease codes, `worker_stopped`, `provider_response_invalid`, `external_repository_change_requires_review`, or `post_submission_execution_failed` with exactly one closed `failureStage` |

Effect intent, host ledger, terminal state, host-review state, and the three
external-runtime repository reviews form one second normative compatibility table.
The repository-review column applies independently to working tree, Git control,
and Git storage, while the combined fingerprint binds the complete map. “No entries”
means the run has no host-apply ledger entry rows; “complete” means every expected
output-plan entry is `applied`. Repository review is independently required when
the baseline comparison detects or cannot exclude an ACP-originated change.

| Durable phase | Terminal state | Effect intent | Host ledger | Host review | Repository review |
|---|---|---|---|---|---|
| Before any ACP call (`not_exposed`) | nonterminal or failed | `not_started` | no entries | `not_applicable` | `not_applicable + not_observed`; baseline may be null |
| ACP attempted before an accepted valid response, including `submission_failed|submission_uncertain` | nonterminal or failed | `not_started` | no entries | `not_applicable` | `not_applicable` only when the complete baseline comparison is unchanged; otherwise `review_required|reviewed` |
| Valid response persisted, before first Forge local stage | nonterminal or failed | `not_started` | no entries | `not_applicable` | `not_applicable` only when unchanged; otherwise `review_required|reviewed` |
| Local stage executing or live finalizer retrying | nonterminal only | `active(stage)` | `planned|applying|applied`; never `unknown` | `not_applicable` | derived independently from baseline comparison after containment quiescence |
| Caught local-stage failure | failed as `post_submission_execution_failed(failureStage)` | `quiesced(lastStage)` where `lastStage === failureStage` | no `applying`; may contain `unknown` when a completed replacement lacks a provable outcome write | `review_required` when host changes are applied or unknown, otherwise `not_applicable` | `review_required|reviewed` when changed/unverifiable, otherwise `not_applicable` |
| Recovered failure after any local stage | failed with the deterministic recovery code | `quiesced(lastStage)` | no `applying`; may contain `unknown` | `review_required|reviewed` when any host change is applied or unknown | `review_required|reviewed` when changed/unverifiable, otherwise `not_applicable` |
| Successful run with no response-driven local stage | succeeded | `not_started` | no entries | `not_applicable` | `not_applicable + unchanged` only |
| Successful run after one or more local stages | succeeded | `quiesced(actualLastStage)` | complete for a declared host-write plan, otherwise no entries; no `planned|applying|unknown` | `not_applicable` | `not_applicable + unchanged` only |

This second table belongs to the generic local-run record and applies to all local-
root modes. Packet-free and handoff-only rows omit packet assembly/delivery rather
than inventing values; their response/direct-effect boundaries map to the same
effect/ledger/review rows. Their success also requires working-tree, Git-control,
and Git-storage comparisons to be exactly unchanged and every review not
applicable.
Owner loss after any root access uses the recovered-failure rows, even when there
is no packet audit or artifact.

No terminal row may coexist with `effectIntent.state:'active'`; `quiesced` is
terminal-only. `not_started`
forbids a host ledger and host-apply review, but it does not imply that an
unconfined ACP runtime left the repository unchanged. Every `active|quiesced` intent
host ID must match the linked run's pinned host ID; recovery obtains the resource
reference and root-binding revision only from that locked run/package pin.
Every nonempty ledger has one canonical fingerprint equal to the intent and any
`review_required|reviewed` union. A reviewed fingerprint cannot authorize a
different ledger. A failed row with `submitted` may remain `not_started` only when
no local stage began; once a stage began, terminalization requires `quiesced`.
Success is admitted only by the two explicit, disjoint success rows. A changed or
unverifiable repository comparison can never succeed, even after review; it stops
Forge local stages and terminalizes failed as
`external_repository_change_requires_review`. A no-stage success never fabricates
a `lastStage`.
The same terminal transaction calls the one database function to recompute the
locked task's versioned unresolved-local-change projection from every sibling
local-run record, review, and recognized hold. Review acknowledgement, quarantine,
cancellation, integrity repair, and backfill call it under the same top-down locks.
Every all-mode claim locks that exact current-head set and recomputes the canonical source
fingerprint; stale zero/null, stale nonzero, wrong version, wrong count, or wrong
fingerprint is an integrity hold. Thus terminal package A can never leave packet,
packet-free, or handoff-only sibling B claimable while A's exact host/repository
review remains required.

The migration installs same-row checks plus deferred PostgreSQL constraint
triggers that call one versioned tuple-validation function across generic local-run
evidence, optional packet audit, ledger entries, working-tree/Git-control/Git-
storage reviews, task projection, and recognized holds before commit. Every source/task
mutation must leave the projection equal to a fresh canonical aggregate; direct
projection writes fail. Live/recovery finalizers and privileged repair call the
same predicate under the complete lock order. Drizzle
parsers and API readers import matching fixtures; S6 exhausts every allowed row
and representative forbidden cross-product. No layer may maintain a looser copy.

An already persisted bounded stage or delivery cause is primary and is never
replaced by a later ownership loss. `submission_failed` is atomically staged with
`submission_rejected`; recovery preserves that definitive pair even when a lease
later expires. Otherwise, if stale recovery must derive a cause, it uses the
deterministic order
`authorization_changed → execution_lease_expired → local_evidence_lease_expired →
issuance_lease_expired →
delivery/stage-specific cause → worker_stopped`, where `worker_stopped` is residual
only. An atomic terminalizer rollback leaves
no durable fact that distinguishes “never started” from “started then rolled
back”, so there is deliberately no `terminalization_interrupted` code; recovery
uses the last durable phase and ownership predicates. SQL checks, Drizzle parsing,
API readers, S5, and S6 accept exactly these tuples. Every known-invalid
cross-product fails closed as legacy/unknown evidence.

`post_submission_execution_failed` means Forge accepted a valid provider response
and then failed at one bounded local stage: sandbox apply, validation, host apply,
repository-evidence preparation, or completion/review-gate preparation. It is
valid only with `assembled + submitted` and requires exactly one
`PostSubmissionFailureStage`; every other failure code forbids `failureStage`.
Delivery remains `submitted`, so recovery follows the possible-prior-work path and
never automatically resubmits. A `host_apply` failure may have changed some files
before it stopped. The packet audit records only the closed stage; existing
repository/host-apply evidence remains the separate source for changed files.
The exact `review_local_changes` action covers partial local changes; the separate
`acknowledge_possible_submission` action covers prior uncertain/accepted external
submission. Both must complete when both facts apply. The operator must inspect
and resolve the working tree before choosing a new run; Forge never claims rollback.

The failure code and local-change evidence are independent. If the process dies
instead of returning a caught stage error, stale recovery may truthfully select a
lease/worker code while the monotonic effect intent/host ledger or external-runtime
change fingerprint still forces review. Therefore every crash after submission or stage entry,
including finalizer rollback followed by process death, retains possible-local-
change guidance without mislabeling the primary terminal cause.

`rootRef` is an opaque, project-scoped random identifier and is never derived from, reversible to, or displayed as an absolute/relative filesystem path. Counts are non-negative bounded integers. Redaction summaries use a closed set of category keys and bounded counts. Packet-owned failure evidence is enum-only: it never accepts raw exception text and has no “sanitized detail” field. No selected names, paths, excerpts, free-text repository errors, or file contents enter the audit, artifact, task log, debug log, event, queue payload, or API response.

`rootRef` is stored in a dedicated project UUID column. Migration first adds that
column nullable with no default, then installs database default `gen_random_uuid()`
as a separate lock-bounded step before mixed-version project ingress reopens. A
narrow database-owned insert bridge fills an explicitly supplied null, while the
update guard rejects only a previously non-null value being reset to null; it does
not reject an unrelated update to a legacy row still awaiting backfill. Once
installed, the database default is authoritative at creation and protects old
project writers that omit the new column during the mixed-version window. The
project service reads that value; preview, approval snapshots, packet claims, and
run artifacts use the same value. It is never a hash, encryption, encoding, or
other derivative of `localPath`. It stays stable for the lifetime of the project,
including across path edits. Rotation is out of scope because it would invalidate
approved-but-unclaimed snapshots; any future rotation needs its own privileged,
audited invalidation/reapproval design. Two projects never share a generated
`rootRef`, and the separate internal host-resource uniqueness rule prevents them
from simultaneously owning the same canonical physical root.

The packet keeps the existing assembly ceilings: `50` included files, `160 KiB` total included bytes, `24 KiB` per file, traversal depth `6`, `500` directory entries, and `5,000` total traversed entries. `rootRef` is at most `80` ASCII characters. Redaction summary accepts only the twelve literal `PacketRedactionCategory` keys above, at most once each, and each count is an integer `0..5,000`. Artifact human-readable content is at most `16 KiB` and is derived only from typed fields and static copy. Values outside these bounds fail closed rather than being persisted.

## Stale claim reconciliation

`reconcileStaleLocalRunEffects()` runs at startup and periodic recovery for every
expired locally pinned run; `reconcileStaleFilesystemIssuanceClaims()` is the
packet-specific continuation after that generic quiescence/evidence step.
Candidate discovery selects local-run evidence/audit IDs without retaining row
locks. It uses the authenticated fresh-W2 election, protected-service handoff, and
group-emptiness protocol above. Its terminalizing transaction:

1. locks project → task → every sibling package in ascending ID
   order → approval decision → worker-protocol epoch → historical claiming and
   current recovery worker instances in ascending ID order → active binding
   generation/rotation → hierarchy guard → agent run → generic local-run evidence
   and task-projection current-head set → optional runtime audit → host ledger/entries →
   artifacts → local/issuance actions → alerts/resolutions → review gates in global
   order;
2. compare-and-sets only the matching expired local-run evidence and, when present,
   still-`claiming` packet audit according to PostgreSQL `now()`;
3. invalidates the local recovery/optional packet token by terminal transition;
4. fails the linked running agent run and clears only that run's `executionLease`.
   Changed/unverifiable local evidence creates a structured local-review block with
   a next disposition derived from the locked generic invocation state. A packet-
   free/handoff-only run with exact unchanged/not-applicable evidence creates
   `retry_local_execution` only for `definitive_not_started`; `invoking|returned|
   uncertain` creates `local_invocation_uncertain` with
   `acknowledge_possible_local_invocation`. A packet run with no local-review barrier
   creates only its packet-issuance recovery block. A run still awaiting
   quiescence remains running/actionless and retains the resource fence;
5. derives the task's versioned unresolved-local-change projection from every
   sibling local-run record and compare-and-sets task `running → approved` only when no other sibling retains
   a live execution lease or `awaiting_review` status; otherwise the task remains `running` and the marker is
   visible but has no action until the shared operator-hold task reconciler below makes it
   `approved`;
6. atomically writes terminal local-effect evidence and, only for a packet run, the
   terminal audit plus unique packet artifact from the durable snapshot.

The no-packet unchanged branch is an explicit interrupted-run disposition, not
success and not automatic queue retry. Only a `definitive_not_started` branch may
offer the exact generic retry action directly. An `invoking|returned|uncertain`
branch must first complete possible-invocation acknowledgement. Changed/
unverifiable no-packet review rotates the same marker to that stored invocation-
dependent disposition; it does not make work ready merely because the operator
reviewed evidence. Thus every post-quiescence no-packet state
has an evidence-preserving choice: retry when policy permits, acknowledge possible
prior invocation before retry when required, or `decline_local_retry` to close
without another run. Pre-quiescence remains deliberately actionless.

The reconciler never locks an audit/approval row and then reaches backward for package, task, or project state. Competing reconcilers may discover the same ID; the top-down lock plus terminal compare-and-set chooses one winner.

The existing `recoverStaleRunningPackage` path must not mutate any protocol-v2
locally pinned package first. After unlocked discovery, it checks for generic
local-run evidence before an optional v2 issuance claim. If local evidence exists,
it delegates the candidate ID to this S4 top-down W2 transaction; packet runs then
continue through packet finalization. A compare-and-set miss is “already handled” only
after rereading under the same locks and proving the package/run are no longer
running and the execution lease is cleared. A terminal packet audit/artifact with
a still-running linked run/package is an invariant-repair branch. It first proves
canonical typed terminal-tuple equality in the audit and artifact; mismatch
enters a neutral, non-retryable integrity hold and alerts operators without
changing packet evidence or exposing a retry action. For terminal failure, repair
fails the run, clears only its lease, blocks the package, and copies the exact
immutable failure object and delivery into the marker; it never derives a
worker/lease replacement cause. For terminal success, repair creates no failure
marker. It may reconstruct the normal success-side run/package/review-gate
transition only when the matching completion artifact, repository evidence
required by the configured host-write mode, and every required review-gate
materialization (or proof that no gate is required) already exist for that run. Otherwise it enters the neutral integrity hold for
privileged manual repair. It never resubmits, creates a second artifact, rewrites
terminal evidence, or converts success into retryable failure. Only a truly root-
free/no-effect run with neither local-run evidence nor packet claim may use the
legacy generic recovery path. A packet-free or handoff-only local run retains no
packet audit/artifact/delivery or **packet** action, but still uses W2, local
evidence, exact review, task barrier, and the typed generic marker/action lifecycle
above. Execution-lease-first, local-evidence-lease-first, and issuance-lease-first
expiry therefore
converge on one generic record and, for packet runs, one S4 packet marker, failed
run/audit, and artifact using PostgreSQL time. The legacy path never clears a v2
local execution lease, writes `staleRunningRecovery`, or publishes terminal events
outside the generic/packet-specific commit.

The neutral integrity branch atomically fails only the live run with a bounded
reason, clears its lease, and applies the sibling-aware task disposition. A packet
run uses `PacketIntegrityHoldV2` for packet audit/artifact defects. Any run,
including a packet run, uses `LocalEffectIntegrityHoldV1` for generic local-
evidence/projection/quiescence defects. Evidence-present branches require the
generic row; `missing_local_evidence` instead binds immutable run/package/task/
project claim identity and an expected non-FK evidence ID with
`localRunEvidenceId:null`. Both hold families are closed, actionless, path-free
types. It does
not state that packet issuance failed, does not create an issuance-recovery action,
and exposes no web recovery CTA. Resolution is a separately authorized privileged
data-repair procedure, never a normal recovery action. The generic S4 admission
guard treats `packet_issuance`, `packet_integrity_hold`, and
`local_effect_integrity_hold` as absolute blocks.

Integrity operations are owned by Release/DevOps. Entering an integrity hold or
exceeding the bounded host-quiescence wait inserts one deduplicated
`filesystem_mcp_integrity_alerts` row with audit/run/package/task/project IDs,
closed reason, evidence fingerprint, database time, and owner; it also emits a
bounded task event after commit. No alert contains a path, exception, or evidence
payload. Before protocol-v2 activation, implementation must add
`docs/operators/local-execution-integrity-repair.md` and checked-in commands:

```text
npm run local-execution-integrity:inspect -- --alert <id>
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution verified_success
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution verified_failure
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution projection_recomputed
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution generic_failure_reconstructed
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution quarantined_abandoned --expected-sibling-evidence-set-fingerprint <digest> --repository-disposition reviewed
npm run local-execution-integrity:resolve -- --alert <id> --actor <operator-id> --expected-fingerprint <digest> --resolution quarantined_abandoned --expected-sibling-evidence-set-fingerprint <digest> --repository-disposition abandoned
```

Inspection is bounded/read-only. Resolution requires the privileged operator
role, locks in the complete order, compare-and-sets the alert/hold fingerprint,
and writes one append-only resolution row. The command parser accepts only the
literal forms above: no optional `--apply`, resolution union placeholder, omitted
fingerprint, or implicit default exists. `--expected-fingerprint` is the complete
alert/hold evidence digest. The two quarantine forms additionally require the exact
canonical sibling-evidence-set fingerprint and an explicit literal repository
disposition; neither value may be derived from current mutable state after command
parsing. Evidence-present alerts join the exact
local row and optional packet audit; the missing-evidence branch instead proves
the immutable claim identity and that the expected row is still absent. It never
invents that row. A stale, wrong-kind,
or cross-project alert ID is actionless. `verified_success` runs only the exact
success reconstruction predicate; `verified_failure` requires coherent immutable
failed audit/artifact evidence and copies it exactly. Neither option rewrites
immutable packet evidence. `projection_recomputed` is valid only for
`task_projection_mismatch` when every source row is coherent and the database
aggregate atomically rewrites version/count/barrier/source fingerprint.
`generic_failure_reconstructed` is valid only for an evidence-present local
mismatch whose immutable run/effect/ledger/repository tuple proves one exact failed
terminal state without packet evidence. `quiescence_state_incoherent` may close
automatically only through service-authored `quiescence_proven`; otherwise it is
quarantined. `missing_local_evidence` has no reconstruction path and can only use
evidence-preserving quarantine. `quarantined_abandoned` is the sole terminal
outcome for any proven immutable packet or generic mismatch that can satisfy no
repair predicate.
It requires the exact alert fingerprint, no live sibling lease, no sibling
`awaiting_review`, quiescent containment/effects, and one complete exact evidence
set for every affected sibling. Every sibling host-ledger and repository-change
review must be `not_applicable|reviewed`, or the operator must choose the separate
privileged repository disposition `abandoned`. That abandonment binds the sorted
sibling marker IDs, baseline/change fingerprints, ledger fingerprints, and current
root binding into the resolution's canonical sibling-evidence-set fingerprint.
Then one complete-order transaction writes the append-only adjudication, moves the
held package and every remaining nonterminal sibling to `cancelled`, and closes
the task as `cancelled`. It retains
the alert, hold, audit, artifact, and run unchanged, creates no recovery action,
and can never make the packet or task retryable. Readers join the resolution and
render permanent evidence quarantine/closure. If no resolution predicate is
proven, the command makes no mutation and the hold remains. A quiescence alert
resolves automatically only after owning-host recovery acquires the fence and
atomically writes service-authored `quiescence_proven` with the W2 receipt,
recovery epoch, final generic-evidence fingerprint, and coherent terminal
disposition. A crash before that commit leaves the alert open; exact replay after
commit returns the same resolution. Unauthorized, stale, duplicate, and
cross-project requests fail closed.

Terminalizing the task never clears a repository-management barrier by itself.
Any unresolved marker, host review, repository-domain review, or mismatched
sibling-evidence fingerprint blocks repoint, tombstone, cleanup, and path reuse for
terminal as well as nonterminal tasks. A normal exact `reviewed` transition or the
separate privileged quarantine disposition `abandoned` satisfies the matching
fingerprint; task terminalization by itself does not.

`reconcileOperatorHoldTaskDisposition(taskId)` owns the shared S3/S4 sibling-
convergence seam.
It runs in a new top-down transaction after any sibling releases/terminalizes its
execution lease, and at startup/periodic recovery. It locks project → task → all
sibling packages ascending, validates at least one marker from the closed
recognized operator-hold union (`filesystem_grant`, `packet_issuance`,
`packet_integrity_hold`, `local_effect_recovery`, or
`local_effect_integrity_hold`), and changes
task `running → approved` only when no sibling retains a live execution lease or
`awaiting_review` status. It
never clears/promotes any marker or wakes execution. S3-only tasks do not require
an S4 marker. This transaction must
not be called while a caller retains a package lock; post-commit invocation and the
periodic fallback preserve the global order. After commit S5 may expose the
marker-specific action.

The package marker is versioned `packet_issuance` metadata and contains only
claim/authorization fingerprints, bounded failure code, delivery state, and a
typed recovery disposition. Every issuance-recovery marker has
`autoRetryable:false`; no packet failure is inferred into the S2 broker retry
policy. A marker is not a standalone terminal record: every reader/action joins
its exact prior audit and packet artifact, proves their typed terminal tuples are
equal, binds the marker fingerprint/identity to that failed tuple, and validates
assembly + delivery + terminal status + failure code/stage together. Missing,
mismatched, or terminal-success-plus-failure-marker evidence is a neutral,
non-retryable integrity hold with no action. This matrix is normative:

Before the grant/delivery row is actionable, review precedence applies. If the
exact host-apply review or any repository-domain review is `review_required`, the marker's
only normal disposition/action is `review_local_changes`, independent of delivery
or grant mode. It stores the deterministic `nextDisposition` from the table below.
Only the matching fingerprint-bound action may change required reviews to
`reviewed`; privileged quarantine is the only abandonment alternative.

| Grant mode | Delivery at recovery | Disposition | Direct action |
|---|---|---|---|
| `allow_once` | `not_exposed|submission_failed` | `reapprove_allow_once` | fresh explicit grant/nonce through #178 |
| `allow_once` | `submission_uncertain|submitted` | `review_then_reapprove_allow_once` | acknowledge possible prior work, then fresh explicit grant/nonce |
| `always_allow` | `not_exposed|submission_failed` | `retry_execution` | explicit retry under the same decision or a newer project decision that exactly covers the unchanged package policy |
| `always_allow` | `submission_uncertain|submitted` | `review_submission` | acknowledge possible prior work before an explicit new run |

A live `submitting` claim is not yet an operator-recovery marker; stale recovery
converts it to `submission_uncertain`. The marker never reuses `mcpGrantBlock` or
`mcpBroker` and carries no human reason or path. An `allow_once` nonce remains
burned and is never reopened. An `always_allow` claim burns only that run claim;
a new run may proceed only if the canonical effective state remains approved from
the matching project-level always-allow decision. Recovery never rereads or
reassembles a prior packet.

No recovery action changes immutable `deliveryState`. Generic local recovery is
the sole owner of `review_local_changes`,
`acknowledge_possible_local_invocation`, `retry_local_execution`, and
`decline_local_retry`:

```text
POST /api/tasks/{taskId}/work-packages/{packageId}/local-effect-recovery
{
  schemaVersion: 1,
  action: review_local_changes | acknowledge_possible_local_invocation | retry_local_execution | decline_local_retry,
  localRunEvidenceId,
  evidenceFingerprint
}
```

The route authorizes the operator and follows the full applicable order: project
→ task → every sibling package ascending → approval/decision → protocol epoch →
authenticated claim/recovery instances ascending → active binding generation/
rotation → hierarchy guard → prior run → generic local-run evidence and complete
task-projection current-head set → optional runtime audit → host ledger/entries →
artifacts → generic local then issuance actions by unique key → integrity alerts/
resolutions → review gates. Before action-specific checks, it requires the routed
task/package to own the exact run/evidence, task exactly `approved`, package
exactly `blocked`, the recognized local marker/fingerprint, no active sibling
lease or `awaiting_review`, and no integrity hold. It validates W2 receipt/
quiescence, host and all repository fingerprints, and current task projection.
`review_local_changes` may accept a nonzero projection only when its locked source
set proves the entire count/fingerprint is exactly the reviews this action owns;
every other action requires canonical zero.

For **every** local action, exact replay is ledger-first: after locking the routed
identity, check `(localRunEvidenceId,action,requestEvidenceFingerprint)` before
requiring current marker presence. An exact successful row returns its recorded
status/resulting marker or disposition and `200` with no second mutation/wake;
only unmatched or cross-route identity returns `409`.

`review_local_changes` requires at least one exact `review_required` host/
repository fingerprint, changes every matched review to `reviewed`, recomputes the
task projection, and writes exactly one `work_package_local_recovery_actions` row.
For a packet run, the same transaction clears only the exact local marker and
compare-and-sets its dependent packet marker from `review_local_changes` to the
stored `nextDisposition`, rotating the packet fingerprint without acknowledging
delivery. For a packet-free/handoff-only run, it rotates the local marker to its
stored `retry_local_execution|acknowledge_possible_local_invocation` next
disposition; review itself does not make work ready. Missing or stale
dependent packet state is an integrity conflict and rolls back the complete local
review mutation. `not_applicable` is valid only when the corresponding ledger/
baseline proves no possible change.

`acknowledge_possible_local_invocation` is valid only for a no-packet
`local_invocation_uncertain` marker after all local reviews are complete. It
records database actor/time, preserves immutable invocation state, rotates the
marker to the acknowledged `local_invocation_uncertain + retry_local_execution`
union arm, commits the unchanged invocation attempt ID plus acknowledgement tuple
into the new fingerprint, and does not create a run/wake. It acknowledges
possible prior network/credential/repository work, not success.

`retry_local_execution` is valid only for a no-packet local marker after exact W2
quiescence, unchanged/not-applicable evidence or completed exact review, a current
zero task projection, no active lease/sibling review, and a server-computed
eligible ordinary retry/attempt policy revision/fingerprint. A
`local_invocation_uncertain` marker is retryable only in its acknowledged union arm
with exact immutable attempt ID, non-null actor/time, and the post-acknowledgement
fingerprint; the pre-acknowledgement arm is a conflict. It writes the generic action, clears only the local marker,
moves `blocked → ready`, and wakes once after commit; it never creates a run or
packet evidence. The route rechecks the locked retry policy; exhaustion or drift is
a bounded conflict and leaves the separate decline action available.

`decline_local_retry` is valid after W2 quiescence and all exact local reviews,
including directly from a possible-prior-invocation marker without forcing
acknowledgement. It records the generic action, clears only the local marker,
cancels the owning package, recomputes the task through the normal sibling-aware
terminal policy, preserves every evidence/alert/review row, and creates no run or
wake. This is the ordinary evidence-preserving way to close work and later permit
safe project management; privileged quarantine is not required for a coherent
reviewed state.

Separately, `acknowledge_possible_submission` is valid only for
`submission_uncertain|submitted` after all local-change reviews are complete. It
sets database-time `acknowledgedAt`/actor and changes
`review_then_reapprove_allow_once → reapprove_allow_once` or
`review_submission → reviewed_submission`. The request marker fingerprint commits
to delivery and every review fingerprint. Each compare-and-set rotates the marker
fingerprint; the action ledger keeps the prior request fingerprint for exact
replay while the next CTA carries the new fingerprint. A marker with acknowledged
fields and any other disposition is invalid and fails closed.

S4 owns the packet-only mutations behind these actions:

```text
POST /api/tasks/{taskId}/work-packages/{packageId}/packet-issuance-recovery
{
  schemaVersion: 2,
  action: retry_execution | acknowledge_possible_submission | decline_packet_recovery,
  priorRuntimeAuditId,
  markerFingerprint
}
```

The route authorizes the operator, then locks project → task → every sibling
package in ID order → current grant decision → protocol epoch → exact pinned
claim/recovery worker instances in ascending ID order → active binding generation/
rotation → hierarchy guard → prior agent run → generic local-run evidence and task-
projection current-head set → prior runtime audit → host-apply ledger and entries → all
applicable prior-run artifacts in stable order (including the exact packet
artifact) → generic local then packet recovery-action rows by unique key →
applicable integrity alerts/resolutions → review gates.
Under those locks it proves canonical typed equality between the audit and
artifact terminal tuples before reading the marker as actionable. Every action requires task
`approved`, package `blocked`, a request whose task/package route owns the exact
prior audit, the exact marker/prior-audit/delivery identity, and no active lease.
It also requires no sibling `awaiting_review`, no unresolved
host-effect/containment intent. Host-apply and all three repository review states
must be `not_applicable|reviewed` for any action that can enable a new claim;
the generic local route and privileged quarantine command are the two exact
fingerprint-bound exceptions that may resolve their own barrier.
It checks the append-only packet ledger by the complete versioned request identity before
requiring the marker to remain present, so an exact replay still returns the
recorded result after successful marker clearing. Possible-submission
acknowledgement does not require current grant coverage: the operator
must be able to resolve old evidence after the grant was revoked. The latter
changes `allow_once` to
`reapprove_allow_once` and `always_allow` disposition to `reviewed_submission`,
while keeping the package blocked.

`decline_packet_recovery` requires quiescent local evidence and all exact reviews
complete, but does not require current grant coverage or possible-submission
acknowledgement. It records the packet action, clears only the packet marker,
cancels the owning package, recomputes task terminal state, preserves audit/
artifact/delivery/review evidence, and creates no run/wake. An operator may abandon
future execution without attesting whether uncertain prior submission occurred.

`retry_execution` accepts `always_allow` only from delivery
`not_exposed|submission_failed` with disposition `retry_execution`, or delivery
`submission_uncertain|submitted` with disposition `reviewed_submission`. It then
accepts exactly one of two locked authorization states:

1. the canonical S1 `readEffectiveGrantState` result has `phase:'approved'`,
   `source:'project-level'`, and `grantMode:'always_allow'`, while the locked
   matching project decision revision and coverage fingerprint equal the prior
   authorization snapshot; or
2. that same canonical tuple is approved, the locked matching project decision
   revision is greater, the package policy fingerprint and exact required
   capability set are unchanged, and that decision covers the complete required
   set.

Both states require the authorizing decision's root-binding revision to equal the
locked current project. State 1 therefore cannot survive a repoint; state 2 can
authorize a new run on the new root only after explicit reapproval. The action row
records both prior and current root-binding revisions.

The canonical reader applies the S3 denial-wins rule, so an equal/newer package
denial, unknown legacy state, or a project row hidden by a package override cannot
be mistaken for authorization even when the project decision alone looks broad
enough.

The second state is explicit reauthorization after grant removal, narrowing, or
replacement; it is not automatic retry. The recovery-action row records both the
prior and authorizing current decision revisions and coverage fingerprints. The
old artifact/authorization snapshot remains immutable, and the normal new claim
snapshots the new decision. A missing, older, unknown, non-covering, or
policy-changed decision returns `409` without mutation. A stale marker or
mismatched prior audit also returns `409` without mutation.

Every successful possible-submission acknowledgement, packet retry, or one-time-
reapproval resolution writes one append-only
`filesystem_mcp_issuance_recovery_actions` row containing actor, action, prior
audit/run IDs, marker fingerprint, immutable delivery state, nullable authorizing
current decision revision/coverage fingerprint, prior/current root-binding
revision, resulting package status and
disposition, and database time; a unique
`(runtime_audit_id, action, marker_fingerprint)` key makes double-clicks
idempotent. For an allowed always-allow retry, the same transaction inserts that
evidence, clears only the matched packet marker, and moves package
`blocked → ready`; it never creates the new run directly. Redis wake-up is after
commit, and the normal claim path rechecks and snapshots current policy.

An exact replay of an already-committed version-2 request
`(runtimeAuditId, action, markerFingerprint)` bound to the same task/package returns
the recorded successful result with HTTP `200`; it
does not mutate or wake again. Two identical concurrent requests select one ledger
winner, and the loser rereads that row and returns the same result. A request whose
marker fingerprint or durable state differs and has no matching successful ledger
row is stale and returns `409`. This makes idempotency and stale-state rejection
separate, deterministic cases.

Fresh one-time reapproval has one explicit cross-slice integration point. After
#178 rotates the nonce under project → task → every sibling package in ID order →
approval locks, it calls an S4-owned package-scoped resolver in the same
transaction. Package scope limits grant evaluation; the caller prelocks every
sibling to enforce the task-wide review barrier. The resolver continues to
protocol epoch → authenticated claim/recovery instances ascending → active
binding generation/rotation → hierarchy guard → prior agent run → generic local-
run evidence and task-projection current-head set → prior runtime audit → host-apply
ledger/entries → all artifacts in stable order, including the exact packet
artifact → generic local then packet recovery actions → integrity alerts/
resolutions → review gates. It proves canonical typed audit/artifact tuple equality
and validates generic evidence, host review, every repository review fingerprint,
and the current zero task projection. It verifies the
exact `reapprove_allow_once` marker/fingerprint, changed fresh nonce, current
policy/root-binding revision, no active lease, and no sibling `awaiting_review`,
then clears only the packet marker. It inserts
`resolve_after_allow_once_reapproval` evidence referencing the new approval
decision; marker clearing and evidence are atomic. It never clears an S3
filesystem-grant or generic local marker. Any unresolved local marker/review/task
projection keeps the package blocked and creates no wake. Only a barrier-free
state moves `blocked → ready`. A stale marker, second reapproval, changed policy,
active lease, mismatched generic evidence, unresolved review, or integrity hold is
a compare-and-set miss. Redis wakes the task only after the combined transaction
commits and readiness is proven.

## Artifact contract

At most one packet artifact may exist for a run that acquired a packet claim.
Exactly one exists only after coherent atomic terminalization, or after an
authorized repair proves its complete predicate. A committed but still-live,
unquiesced, or unavailable-host claim has zero terminal packet artifacts, and
this contract makes no liveness promise when containment emptiness or an
authoritative same-host recovery worker cannot be proven. Runs needing no packet
have zero packet artifacts:

```text
artifactType = mcp_bounded_context_packet_metadata
lookup = (agentRunId, artifactType)
```

Add a partial unique index in SQL and `schema.ts`, and use a conflict target with the matching predicate.

Artifact metadata:

```ts
{
  schemaVersion: 2;
  workPackageId: string;
  authorization: PacketAuthorizationSnapshot;
  assembly: TerminalPacketAssemblyState;
  delivery: TerminalPacketDeliveryOutcome;
  terminal: PacketTerminalOutcome;
}
```

Artifact content is a bounded human-readable summary derived only from these persisted typed snapshots. A live packet finalizer extends the existing run/package terminal transaction: after external work completes—or after a bounded external-work stage fails—it locks in the complete order, verifies execution, generic-local, and packet ownership plus the pinned root binding, terminalizes the agent run and package/review-gate transition, clears the execution lease, writes any recovery marker and task disposition for failure, transitions the audit to terminal, and upserts the artifact in one transaction while still holding the run-lifetime resource fence. Sandbox writes, validation commands, host writes, repository-evidence preparation, and review-gate preparation happen before this transaction and each maps to the closed post-submission stage above. The transaction contains no network, Redis, filesystem, provider, or rendering work. A gate insert or other finalizer database failure rolls the whole transaction back and persists no `completion_preparation` cause; the host fence service retains exclusion while the worker retries and, on process/control loss, keeps the lease orphaned until the containment adapter proves the complete group empty. Thus a protocol-v2 writer cannot commit terminal packet evidence while leaving its linked run/package `running`. The partial unique index makes repeated or competing live/recovery finalizers idempotent; it does not replace this crash-consistency transaction. Recovery never rereads or reassembles a burned packet. The invariant-repair branch above handles legacy/manual partial state without rewriting already-terminal evidence.

## Review-gate concurrency boundary

Review-gate materialization and decisions participate in the same global order.
The finalizer and every gate-decision transaction lock project → task → package →
approval/decision → protocol epoch → authenticated claim/recovery instances
ascending → active binding generation/rotation → hierarchy guard → applicable runs
ascending → generic local-run evidence/task-projection current-head set → optional audits
ascending → host ledgers/entries by run/ordinal → all artifacts by stable key →
generic local/issuance actions → integrity alerts/resolutions → all relevant gate
rows ascending; no path
may lock a gate and then reach backward to the package. Before changing a gate or
package, the decision transaction rereads the source run, exact artifact identity,
package status, and execution-lease state under those locks. It compare-and-sets
the package/gate against those identities. A stale source run/artifact, a new live
lease, or a changed package status is a no-mutation stale decision, never approval
of newer work. Finalizer-versus-gate-decision PostgreSQL races exercise both lock
orderings and prove one coherent winner without deadlock.

## Run lifecycle integration

- Create the `agentRunId`, execution lease, generic local claim token/lease, and
  optional packet claim atomically in the existing package claim transaction.
- A successful claim must precede packet assembly.
- If no packet is required, no filesystem issuance audit is created.
- After claim, every live terminal path atomically finalizes run, package/lease,
  audit, artifact, marker, and task disposition if ownership remains valid; stale
  recovery owns finalization after ownership expiry.
- Failure after an `allow_once` claim burns the nonce. Failure of an `always_allow` run does not manufacture or burn a decision nonce.
- A failure before `assembling` is definitely `not_assembled`; an expired/crashed
  `assembling` intent becomes `assembly_unconfirmed` with no counts/`rootRef` and no
  reassembly. A pre-exposure failure returns the package to a structured blocked/
  recovery state. Persist `submitting` before ACP I/O; recovery maps an expired
  submission intent to `submission_uncertain`. Do not automatically redeliver an
  ambiguous external request.
- Sandbox-generated file artifacts remain separate from repository context metadata and host-apply evidence.

## Concurrency/failure tests

1. Two workers race one `allow_once` nonce: one run claim, one decision claim, one
   packet assembly. The winning snapshot has `source:'package_allow_once'`,
   `grantMode:'allow_once'`, this package's non-null approval FK, and its non-null
   nonce.
2. Two workers race one `always_allow` package: one per-run claim and one packet
   assembly. The snapshot has `source:'project_always_allow'`,
   `grantMode:'always_allow'`, null approval FK, and null nonce, and every authority
   field is taken from the already-locked project configuration decision. Task and
   project always-allow readers return byte-equivalent revision/root/capability/
   fingerprint fields. Exhaustive SQL/parser/task-API/project-API/artifact-API
   fixtures reject every other source/mode/FK/nonce cross-product. PostgreSQL also
   rejects every JSON-versus-scalar mismatch for source, mode, approval ID,
   revision, nonce, and root revision; malformed/extra JSON fields; mutation of a
   committed authorization field; and otherwise valid approval tuples substituted
   across package, task, or project scope. Protocol-v2 fixtures additionally prove
   `task_id`, `work_package_id`, `agent_run_id`, and `local_run_evidence_id` are all
   non-null and exactly equal to the locked audit/run/evidence tuple, so neither
   `MATCH SIMPLE` nor either partial unique index can be bypassed with nulls. Only
   the typed relational constructor may insert the canonical JSONB snapshot;
   direct table writes fail. Raw legacy/ingress text containing duplicate object
   keys fails the duplicate-aware parser before any JSON/JSONB cast, while stored
   JSONB still must equal every scalar mirror. Each constructor/FK/validator failure
   rolls back nonce consumption and all claim/run/evidence writes.
3. Claim transaction failure after each write rolls back package status, run, leases, audit, attempt, and nonce consumption.
4. Claim races reapproval and project revocation: global lock order prevents deadlock and decision revisions select the correct result.
5. Delayed owner races lease expiry/reconciler: loss of execution, generic-local,
   or optional issuance ownership prevents a later governed read or finalization.
   A second dedicated principal copies all still-live execution/local/packet or W2
   tokens before expiry and tries heartbeat, read, assembly, exposure, ACP
   submission, and finalization before and after the original principal is revoked;
   every attempt fails the epoch → pinned instance → `current_user` check and emits
   none of those tokens through ACP, exchange, queue, log, API, export, or error
   surfaces. Cross-run and cross-root copies fail identically.
6. Execution, generic-local, and issuance lease each expire first; every pair and
   all three expire together; and heartbeat races each boundary before/after every
   staged phase. A persisted stage/delivery cause always wins. Without one, fixtures
   enforce `authorization_changed → execution_lease_expired →
   local_evidence_lease_expired → issuance_lease_expired → delivery/stage-specific
   cause → worker_stopped`, with `worker_stopped` residual, and one coordinated
   terminal state survives.
7. Crash before the `assembling` intent: explicit `not_assembled` evidence with no
   fabricated zero counts. Crash after the intent but before the first read, during
   selection, after the final byte is selected, and before the assembled-snapshot
   compare-and-set commits: terminal `assembly_unconfirmed/assembly`, delivery
   `not_exposed`, no counts or `rootRef`, and no reassembly of the old claim.
8. Crash after the assembled snapshot commits but before exposure: persisted
   truthful `assembled` metadata. A terminal artifact never contains live
   `assembling`, and no recovery path maps `assembling` to `not_assembled`.
9. Crash before submission, during submission, and after submission: delivery outcome remains distinct from assembly and ambiguous submission is not redelivered automatically.
10. Failure between run/package/lease, audit, marker, task, and artifact finalization
    is impossible for v2 writers because they share one transaction;
    rollback/retry and concurrent finalizers produce one terminal run state and one
    artifact.
11. Submission crash injection covers before intent CAS, after intent/before call,
    immediately after transport acceptance, and after response/before outcome
    persistence. Only the pre-intent case can remain `not_exposed`; every expired
    `submitting` case becomes `submission_uncertain` and is not auto-replayed.
12. Reapproval after a burned nonce appends a fresh decision with a strictly greater
    project-serialized positive revision and fresh nonce and
    compare-and-sets only the package current pointer; immutable evidence and the
    prior decision do not change. Concurrent approve/deny/revoke/reapprove and
    project-grant updates produce one pointer winner, retain every attempted
    committed decision, and never let an old audit resolve through the new pointer.
13. Always-allow revocation before a later read/exposure stops that boundary; already-read bytes are not claimed to be recalled.
14. Legacy approvals/audits, mixed protocol workers, cutover, rollback, and root-path scrub follow the rollout contract below.
15. Prompt-injection fixtures remain quoted subordinate data; wire-level role
    separation is asserted only for adapters that actually preserve roles.
16. Role-preserving providers keep policy in the captured system-role wire input;
    the ACP fake instead proves the real flattened `session/prompt` wire carries
    bounded guidance plus quoted subordinate data and makes no role-separation or
    enforcement claim.
17. A packet-bearing provider response that transport accepts but Forge validation
    rejects produces exactly one external prompt call, terminal
    `{status:'failed', failureCode:'provider_response_invalid'}` plus `submitted`
    delivery evidence, and no automatic correction submission. Packet-free and
    handoff-only local-root execution also set adapter/provider retries to zero,
    bypass the response-validation correction loop, and make exactly one ACP call
    for the generic local-run evidence row.
18. Logs contain only digest/count metadata; absolute/relative paths, filenames,
    internal host-resource refs, secrets, HTML, control characters,
    raw exceptions, and rejected text do not leak through any packet-owned
    persistence/diagnostic surface.
19. Deferred optional merge overlay text is absent; static ACP non-sandbox warning
    remains. Accepted and rejected requirement/overlay/subtask sentinels exist as
    text only in insert-only `architect_plan_entries`; the artifact header contains
    fixed copy and bounded non-text fields. New and deterministically migrated
    versions prove stable scoped IDs, NFC/RFC-8785 bytes, keyed domain-separated
    entry and entry-set digests, duplicate-text handling, reordered input,
    Unicode-equivalent input, digest-key rotation, and update/delete rejection.
    Ambiguous legacy input becomes history-only `legacy_full_plan` and blocks
    projection. Runtime `work_packages` metadata contains only normalized policy/
    bindings plus server-private eligible references; normal task/package/artifact
    list/detail APIs, logs/exports, queue payloads, live pubsub, current SSE
    snapshot, v2 replay, diagnostics, and errors contain no plan text or resolvable
    locator. Legacy `run:chunk`, delta, raw `artifact:created`, and task-log plan
    producers are absent. The dedicated history route returns entries only to an
    authorized current task/project reader and commits one bounded append-only read
   audit; unauthorized, cross-task, wrong-type/stage, stale-version, and missing
   reads return no bytes. Resolver fixtures reject stale/digest/key/kind/agent/
   requirement/binding mismatches. Accepted eligible fragments alone appear
   ephemerally in the captured provider/ACP request; the whole row and rejected/
   ineligible fragments are absent from every wire and persisted sink. Real-role
   database tests prove the plan owner alone can read text tables directly; web,
   worker, application, reporting, migration, and maintenance roles fail direct
   `SELECT`, copied-query, view/catalog-discovery, and hostile search-path/temp-
   shadow attempts. Exactly the audited human-history reader and package-bound
   one-entry resolver are executable, both with fixed search paths and `PUBLIC`
   revoked; neither permits enumeration or free-form SQL. Two human users behind
   the same exact web certificate login prove that the opaque live Forge session,
   not that shared login, derives the ACL user; swapped/expired/revoked/fabricated
   credentials return no bytes or audit. A fresh package-resolver connection proves
   its distinct `session_user` path. Wrong-login, cross-reader, hostile `SET ROLE`,
   and definer-`current_user` fixtures return no bytes; catalog assertions prove
   the production logins are non-superuser `NOINHERIT`, have no cross-membership,
   and cannot `SET ROLE` or `SET SESSION AUTHORIZATION`.
20. Pure filesystem write planning hint remains present without packet.
21. Existing-project backfill, old-writer inserts during cutover, and permitted
    path rename preserve the lifetime-stable opaque `rootRef`. Concurrent project
    create/repoint attempts for the same canonical root—including symlink, alias,
    case, and filesystem-object variants—and for ancestor/descendant roots select
    one non-overlapping hierarchy binding; the loser fails closed before create,
    recursive cleanup, claim, or repository reads.
22. Every issuance failure persists `autoRetryable:false`; `always_allow`
    exposes `retry_execution` immediately only for
    `not_exposed|submission_failed` **and only when no local-change review is
    required**. Any delivery with required host/repository review first exposes
    `review_local_changes`. Post-intent states then expose
    `review_submission` with no retry; only the append-only acknowledgement may
    change disposition to `reviewed_submission`, after which the locked retry
    predicate may accept either the same decision or a newer decision that exactly
    covers unchanged package policy.
23. Packet-recovery actions race double-click, grant revocation, policy mutation,
    task/package transition, and a new lease. The append-only action row and
    marker compare-and-set select one result; Redis failure leaves committed
    `ready` truth for periodic re-drive. Post-intent `allow_once` requires
    acknowledgement and then a separate fresh #178 approval.
24. An exact action replay returns the recorded success with one ledger row and no
    second wake; a changed fingerprint/state returns `409`.
25. Normal stale-running recovery races both lease-expiry orderings and the S4
    reconciler; packet-bearing work yields only the S4 terminal transaction and no
    generic stale marker/event. Crash injection after terminal audit/artifact but
    before package/run cleanup proves the atomic writer has no such commit point;
    a seeded legacy/manual split state takes the idempotent repair branch without
    changing the artifact or resubmitting.
26. An always-allow claim is revoked and restored under a newer decision revision:
    uncovered state has no retry, restored exact coverage permits one explicit
    audited retry, the prior artifact stays unchanged, and the new run snapshots
    the new revision. An equal/newer package denial racing that restore still wins
    in the canonical reader. Older/unknown/narrower decisions and policy drift
    fail closed.
27. A stale claim with another live sibling package keeps the task `running`,
    exposes no recovery action, and becomes actionable only after the S4
    post-sibling/periodic shared operator-hold reconciler moves the task to
    `approved`. Repeat for an S3-only filesystem hold and mixed holds.
28. The versioned recovery request is bound to its routed task/package, prior
    audit, and marker fingerprint. Exact post-clear replay is `200` with one ledger
    row and no wake; substituted route IDs or identity fields are `409`.
29. An ambiguous retryable provider failure exercises the real packet-bearing AI
    SDK and adapter stack with `maxRetries:0`; wire capture proves exactly one
    external request even when provider defaults would otherwise retry.
30. Every persisted terminal **failure** has exactly one `PacketFailureCode`;
    exhaustive valid and known-invalid assembly/delivery/terminal/code tuples prove
    the parser, SQL checks, API, and UI fail closed with no free-text copy.
31. Package-epoch tests cover a genuinely pre-trigger process that must be
    operationally drained and both package bridge-trigger orderings under `READ COMMITTED`: v1 shared
    first commits and forces activation to abort; activation exclusive first
    rejects v1 with zero repository reads. Packet, packet-free, and handoff-only v2
    claims all succeed after epoch 2 and persist protocol 2.
32. Direct progress, sibling-completion continuation, and periodic readiness all
    encounter valid and malformed S4 markers. None calls generic promotion; only
    the exact S4 action/resolver clears the marker and makes the package ready.
33. Every valid grant-mode/delivery/review-precedence/disposition/acknowledgement
    marker tuple parses;
    every known-invalid cross-product is neutral and non-actionable. A successful
    acknowledgement rotates the marker fingerprint while an exact prior request
    still replays from the ledger.
34. A valid submitted response then fails independently at sandbox apply,
    validation, host apply after at least one successful file, repository-evidence
    preparation, and completion/review-gate preparation. Each case persists
    one exact `post_submission_execution_failed` stage, performs no second model
    submission, preserves separate host evidence, and requires acknowledgement of
    possible prior and partial local work. Local-change review and possible-
    submission acknowledgement are separate typed actions and neither changes
    immutable delivery.
35. Seeded terminal/live splits prove exact audit/artifact tuple equality. Failed
    splits copy the immutable failure object; a fully evidenced success split
    reconstructs only the matching success transition; mismatched or incomplete
    success enters a neutral integrity hold with no retry marker.
36. Pairwise packet, packet-free, and handoff-only claims race in both orderings.
    Every writer locks all siblings and recomputes eligibility, so one specialist
    owns a live lease. Stale recovery races both non-packet modes and never commits
    task `running → approved` beside a newly established sibling lease.
37. Atomic finalization races a stale review-gate decision in both orderings. The
    decision rereads source run/artifact, package status, and lease under top-down
    locks; it either wins coherently or makes no mutation.
38. Definitive `submission_failed + submission_rejected` persistence races a
    crash/lease expiry. Recovery preserves the staged cause rather than
    reclassifying it as lease expiry.
39. Lease expiry/recovery races before the first host replacement, between two
    replacements, and after the final replacement before evidence/finalization.
    The resource fence prevents actionable recovery while stale effects run; a crash
    after replacement/before outcome yields ledger `unknown` and mandatory
    fingerprint-bound working-tree review.
    The same result is required when the live owner catches failure or ownership
    loss on the `applying → applied` persistence step; it cannot terminalize until
    it durably maps uncertainty to `unknown`.
40. Process death after every post-submission stage and finalizer rollback proves
    monotonic effect intent preserves possible-local-change guidance even when the
    primary terminal code is lease/worker loss. No new run starts until quiescence
    and required host review are proven.
41. A sibling `awaiting_review` races a later packet/packet-free/handoff-only claim,
    packet recovery, and its review decision in both orderings. Package locks keep
    task `running`, suppress recovery actions, and start no later specialist until
    mandatory review completes.
    Repeat with terminal sibling host/repository `review_required`: the materialized
    task barrier blocks all three claim modes and every repository read until exact
    review or quarantine resolves the matching fingerprint.
42. Duplicate action, exact replay, one-time resolution, success repair, and gate
    decision races acquire host ledgers/entries, all artifacts, action rows,
    integrity alerts/resolutions, and gates in the complete tail without deadlock.
43. Every normal packet retry, acknowledgement, reapproval, S2 refresh, and generic
    promotion rejects every packet/generic-local integrity hold. Authorized repair requires the
    exact alert fingerprint, writes one resolution, and cannot rewrite evidence;
    only mismatch adjudication may cancel/close without retry. Unauthorized/stale
    attempts leave the hold unchanged.
44. Pre-transaction completion preparation failure persists its exact closed
    stage; a gate insert/finalizer transaction failure fully rolls back and
    persists no `completion_preparation` cause.
45. A packet read and host apply race project root repoint, unregister, recursive
    delete, and reuse by a second project. Run-lifetime resource fencing plus the
    pinned revision yields one owner; the management loser waits/retries or
    conflicts without reading, deleting, or overwriting the other repository.
46. Root repoints and two-root swaps acquire old/new resource refs in both byte
    orderings without deadlock. Crash after typed delete intent and after host
    cleanup is recovered exactly or enters bounded manual repair; no claim starts
    during maintenance.
47. Kill the per-run execution child, queue worker, protected host fence service,
    and control channel first, last, and simultaneously while ACP/validation descendants,
    use nested spawn/`setsid`/double-fork equivalents, and ignore normal
    termination. Recovery remains actionless until the operating-system
    containment adapter proves the complete per-run group empty. Normal success
    releases without terminating the queue worker. A fresh same-host W2 is pinned
    as recovery owner only through its dedicated database principal plus the
    service challenge/election/burn/receipt handshake. Fabricated, rolled-back,
    copied, expired, double-consumed, cross-run/root/W2, service-restart, and every
    before/after burn crash boundary is actionless or resumes exactly once. A
    different, missing, stale, divergent-key, insufficient-adapter, same-ID/
    principal takeover, or unreachable W2 is alert-only and cannot terminalize.
    The service-only read-view principal rejects worker access and verifies only a
    committed exact election; rollback, stale snapshot, credential revocation,
    TLS outage, reader restart, and credential rotation all fail closed without
    burning a challenge. Deterministic barriers exercise every re-election boundary:
    before/after database recovery-lease expiry; before/after committed-receipt
    expiry; after both expiries but before the protected service proves no grant;
    before/after the no-grant proof; before/after the protected
    `expired_ungranted` tombstone; before/after new-challenge creation; before/after
    the database compare-and-set of the exact old owner/election/receipt; before/
    after the append-only database election tombstone; before/after the greater
    recovery-epoch/candidate commit; and before/after the service verifies that
    greater epoch plus both tombstones and burns the new challenge. Crash/rollback
    is injected at every boundary, and the delayed old W2/receipt races the new W3
    before and after each commit. No-grant proof without both expiries, either
    tombstone alone, an uncommitted/unchanged epoch, or an already granted takeover
    is actionless. Re-election requires expired database lease/receipt plus the
    service's exact `expired_ungranted` tombstone and matching committed database
    tombstone at the greater epoch; the old receipt never terminalizes.
    Wrong-host recovery covers both `not_started` (run/package pin only) and
    `active|quiesced` (run/package pin plus intent host) without reading a field
    absent from the union.
48. Exhaustive assembly/delivery/terminal/effect/ledger/host-review/repository-
    review fixtures prove the two normative tables, stage equality, fingerprint
    equality, live-only `assembling`, terminal-only `assembly_unconfirmed`, no
    counts/`rootRef` on unconfirmed assembly, no terminal `active`, the disjoint no-local-stage/with-local-stage
    success branches, success only with unchanged/not-applicable repository
    evidence, and no successful row with `planned|applying|unknown`. PostgreSQL
    constraint, finalizer, repair, parser, API, and S5 results agree.
49. Activation and every later claim reject zero, unregistered, multiple, stale,
    draining, incompatible, wrong-host, divergent-binding-key, and undrained
    worker/root-writer registrations. A stale/draining Wbad cannot name fresh Wgood
    through a caller GUC; copied/replayed/cross-instance/expired credentials fail
    package claims, reservations, root mutation, and W2 election. Drain revokes
    Wbad's principal/terminates sessions before acknowledgement. One fresh single-
    host authenticated candidate set succeeds only after activation; before then
    all three protocol-2 claim modes fail with zero repository reads. Exact IDs/
    principals are pinned and the immutable activation audit reproduces the
    decision. Direct registry insert/update/delete and cross-row/protected-column
    writes are denied; two real login roles prove the fixed definer sees
    `current_user != session_user`, maps only the session login, and updates only
    its row after epoch→instance→generation/rotation locks plus post-lock
    revalidation. `PUBLIC`, function-owner, SET
    ROLE/session-authorization, cross-row, draining/revoked/stale-generation calls
    fail. Rotation-selected pending K2 can attest but cannot claim; post-flip K1
    fails immediately. Real PostgreSQL barrier tests hold the instance first and
    generation/rotation first while heartbeat races drain/replacement/activation/K2
    batch/promotion in both orderings. `pg_blocking_pids` proves the expected wait;
    the canonical helper permits no rotation→instance edge, no deadlock occurs, and
    post-lock revalidation prevents stale freshness.
50. A true audit/artifact mismatch cannot satisfy verified success or failure.
    Only exact privileged `quarantined_abandoned` closes the package/task, leaves
    immutable evidence and the alert intact, writes one resolution, and exposes no
    retry. A sibling with unknown host changes or changed/unverifiable ACP effects
    keeps root management blocked until the resolution binds its exact reviewed or
    abandoned evidence. Stale, duplicate, unauthorized, or active-sibling attempts
    do nothing.
51. Two create/clone requests race one nonexistent destination, alias/case forms,
    a symlinked parent, and existing/nonexistent ancestor/descendant destinations
    in both orderings. Crash at `planned`, materialized, physical-fence, and
    bind boundaries. Only the reservation winner creates/binds; cleanup requires
    matching token and physical object identity and never deletes a reused path.
52. Archiving/tombstoning a normal and `quarantined_abandoned` project atomically
    cancels every nonterminal task/package with `project_removed`, releases only
    the live path/root hierarchy binding, and leaves every task, package, run,
    audit, artifact, action, alert, resolution, and project `rootRef` queryable.
    Queued wakes and all three claim modes do nothing; hard delete fails.
53. Before the expansion window, the bridge legacy DELETE route is deployed and
    every pre-bridge process drained; DELETE with/without existing evidence returns
    conflict/archive before `fs.rm`. The first migration rejects cascades/direct
    hard delete and proves zero task/run/audit/artifact loss, including a process
    killed around the old file-delete boundary. Genuine legacy project POST/PUT
    writers operate only before the cutover maintenance barrier. Disabled ingress plus v1 database-role revocation/session
    termination and service drain then prevent a restarted old route from reading
    a path before filesystem work. The root trigger is enabled only afterward,
    rejects root mutations while epoch 1, and accepts only registered v2 writers
    after exact activation; it never calls the S3 TypeScript reconciler.
    New writer routes prove the exact registered instance, credential generation,
    and maintenance/reservation token.
    The same migration suite adds `root_ref` nullable with no default and separately
    sets the default under a measured lock. The narrow insert bridge assigns a UUID
    to both an omitted column and an explicitly supplied null; the update guard
    allows an unrelated update to a still-null legacy row but rejects non-null →
    null. The suite builds uniqueness concurrently, crashes/resumes checkpointed
    backfill batches, and races each insert/update case before, during, and after its
    batch without losing the unrelated update. It enforces lock/statement timeout
    and disk/WAL preflight, reaches zero null, then adds/validates the non-null proof
    and proves the final short `SET NOT NULL` neither rewrites the table nor admits a
    late null. Journal fixtures require one outcome from the closed
    `insert|root_update|archive` vocabulary for every generation. A static parity
    sentinel rejects stale `deleted_row`, `deleted-row`, or generic delete outcomes
    in schema, reconciler, activation, fixtures, and architecture contracts; the
    sentinel's own denylist fixture is the only allowlisted occurrence.
54. Seed legacy approvals with no root-at-decision evidence, including repoint and
    repoint-away/back history. Root binding never makes them issuable; explicit
    reapproval on the locked current revision is required.
55. An ACP runtime changes the working tree or only Git config, hook, ref/HEAD,
    index, linked-worktree administration, submodule control, loose object, pack/
    index/MIDX, commit graph, alternates, replace/grafts, shallow, reflog,
    maintenance state, or adds unreachable objects before
    Forge's first local stage and
    then succeeds, fails, or leaves submission uncertain. Changed or unverifiable
    baseline comparison can never succeed, requires exact review, and blocks retry,
    reapproval, new run, repoint, tombstone, and path reuse. Only the exact
    `review_local_changes` or privileged quarantine transition may cross its own
    fingerprint barrier. External include/includeIf, global/XDG/system/HOME and
    environment-injected config, external/symlinked hooks, attributes, filters,
    textconv/diff/fsmonitor/credential helpers, and alternate environment variables
    are rejected by the sterile Git builder before any Git execution. Partial-clone
    fixtures cover `extensions.partialClone`, promisor remotes/filters, `.promisor`
    packs, and missing reachable objects with a network-listener sentinel. The Git
    wrapper test uses release-pinned supported and unsupported Git binaries (or
    digest-bound deterministic shims), captures every probe and operational child,
    and rejects any child without exact `GIT_NO_LAZY_FETCH=1`. The supported result
    requires global `--no-lazy-fetch` on every operational argument vector; the
    unsupported result forbids that option; missing, mismatched, and ambiguous probe
    results fail closed. Tests assert exact argument vectors and environments, zero
    network connections, zero object-storage write syscalls, and unchanged loose-
    object, pack, index, multi-pack-index, and commit-graph bytes. Every partial-
    clone case fails preflight before repository Git execution and cannot fetch even
    when the remote would satisfy the object.
56. The exact binding-key dry-run/apply/inspect/discard commands and guide are
    invoked. Backup/loss/rotation disables issuance/root management, drains all
    instance kinds, proves containment/effects/reservations plus every K1 task
    projection, marker, review, integrity alert/resolution, and terminal record
    coherent/reviewed/quarantined, creates
    active-K1/pending-K2 rotation state, crash-tests durable owner-level shadow rows
    after every batch and complete-set verification, rejects missing/duplicate/
    stale-source rows, and flips one constant-size active-generation/key/credential
    pointer before reactivation. The flip rewrites no owner row; post-flip cleanup
    is bounded and cannot restore K1. Pending candidates attest without authority;
    key loss, missing backup, unresolved K1 review/hold, at-capacity candidates,
    and every crash around the flip remain blocked or resume exactly. No mixed
    authority becomes visible.
57. Reservation-only planning, materialization, cleanup, and new-project binding
    lock epoch → connection-authenticated fresh root-writer instance → active
    generation/rotation → hierarchy guard → reservation. Existing-project attach/
    repoint locks project and S3 entity rows first, then that tail. Activation, drain,
    and rotation races reject stale, draining, unregistered, wrong-key, or wrong-
    generation writers before filesystem work and after materialization.
58. Rootless `localPath:null` project creation succeeds after epoch 2 only with the
    complete binding/maintenance set null and grants no filesystem authority.
    Partial state fails; later attachment and repoint to a nonexistent destination
    race all-mode claims, reservation cleanup, activation, and rotation in both
    orderings without deadlock or partial authority. They atomically advance one
    revision/binding and repoint performs S3 negative reconciliation.
59. The versioned working-tree, Git-control, and Git-storage scanners never follow
    unsafe symlinks or open FIFO/socket/device entries, remain within file/byte/
    depth/time bounds for huge/churning trees/object stores, fail preflight before
    exposure when baseline proof is impossible, and produce post-exposure
    `unverifiable` plus exact review otherwise. Linked common directories and
    allowlisted alternates are separately fenced; unsupported alternates fail
    closed. For every persisted limit, just-under/at/over defaults and hard maxima,
    large streaming packfiles, loose-object counts, timeout, and churn have exact
    preflight or post-exposure-unverifiable outcomes and bounded diagnostics.
60. Unauthorized service socket calls, peer mismatch, state mutation/deletion,
    service `SIGKILL`, stale/cross-run token replay, and corrupt-state restart never
    release or reuse a root; they create protected orphaned/disabled state. ACP
    attempts against its own/sibling project `.forge/task-runs`, `../`, symlink
    aliases, and response/quiescence races cannot reach protected external control
    state; every permitted exchange mutation is bounded and digest-evidenced. Real
    host tests place worker/shim-owned setuid/setgid files and file capabilities in
    the project, attempt device access, read/ptrace/signal through procfs, and target
    the trusted shim, queue worker, service, and another slot. The `nosuid,nodev`
    mount, capability rejection, private procfs/PID namespace, distinct shim/run
    users, and non-dumpable shim fail each attack before project access or control-
    capability disclosure.
61. `submission_failed + changed|unverifiable` in both grant modes first exposes
    only `review_local_changes`; after exact review, immutable delivery remains
    `submission_failed` and the correct reapprove/retry action becomes eligible.
62. Unbound revision `0`, initial binding, legacy expansion-window create/repoint/
    repoint-away-back/archive, and an old transaction committing during
    drain are captured through the post-session-termination journal watermark.
    Crash/resume reconciliation covers every generation before binding/activation;
    no command resets a revision or makes a legacy decision issuable. Legacy hard
    delete is already blocked by the pre-window retention guard.
63. Packet-free and handoff-only local-root runs crash before/after first read,
    during a direct ACP write, between host replacement and outcome persistence,
    and with surviving descendants. Each already has generic local evidence; W2/
    quiescence/comparison/review blocks every sibling/root operation, while no
    packet audit/artifact/delivery or packet action is manufactured. Definitive
    pre-call unchanged evidence may yield generic retry; possible prior invocation
    requires its own acknowledgement first. Changed/unverifiable evidence yields
    review then the stored acknowledgement/retry disposition. Eligible, exhausted,
    and render/click-drifted retry policy plus evidence-preserving decline/cancel
    are tested. Legacy recovery rejects them.
64. Terminalization, local review, quarantine, cancellation, integrity repair, and
    backfill update the task projection through one database function. Direct task
    or source writes leaving stale zero/null, stale nonzero, wrong count/version/
    fingerprint fail at commit. Concurrent review versus all three claims rejects
    before repository reads and rollback cannot split evidence from projection.
    Instrumented fixtures prove the deferred assertion executes once for the final
    `{taskId,mutationGeneration}` even when every one of the 2,048 fixed current-
    authority heads advances, executes again after `SET CONSTRAINTS ... IMMEDIATE`
    plus later DML, and cannot let direct projection DML borrow the dedup state or
    SECURITY DEFINER identity. The shared
    `CURRENT_LOCAL_PROJECTION_HEAD_KINDS` list contains exactly eight values, and
    every protocol-v2 package has one preallocated head per value; each transition
    appends immutable history outside the cap
    and advances one head count-neutrally with revision, source FK, fingerprint,
    and compare-and-set checks. Exactly 256 sibling packages and 2,048 heads pass.
    Package 257 puts the whole legacy task into `archive_pending`. Fixtures run the
    exact inspect/archive dry-run/apply commands, crash/resume at each checkpoint,
    roll back before finalization, reject reparent/delete and a replacement over
    256, and prove every claim/wake/ingress/root mutation rejects replacement state
    `pending`. Finalization retains every source package/evidence row under
    `legacy_archived` while atomically changing the separately planned at-most-256
    replacement `pending → eligible` with its exact head set; rollback leaves it
    pending and cancellation leaves evidence. History growth alone never consumes head capacity. On the release-pinned PostgreSQL 16
    reference runner, 1,000 warmed maximum-cardinality aggregate validations,
    excluding deliberate lock wait, must be p95 <= 40 ms and p99 <= 100 ms; a
    regression in either budget blocks activation.
65. Unique sentinels in task prompt, allowed/rejected overlays, selected file/name/
    path, and credential-like text exercise normal, no-command, stderr-warning,
    no-op handoff start, and no-op handoff completion branches plus task-log export/
    API/SSE/diagnostics. Seed live pubsub, reconnect snapshot, Last-Event-ID replay,
    generic task/artifact list/detail, and a pre-upgrade
    `forge:task:{taskId}:history` key with raw plan/delta/artifact payloads. Only
    allowlisted opaque IDs/progress survive new reads. After legacy Redis publisher
    credential revocation and process drain, cursor-scan/delete proves zero legacy
    history/sequence keys, a revoked publisher cannot recreate one, v2 values scan
    clean, and reconnect cannot replay the sentinel. Only allowlisted bounded
    counts and the server-private non-reversible keyed digest survive; generic
    front matter rejects prompt aliases.
    A repository-wide source sentinel rejects every task-log/front-matter producer
    of `prompt`, `promptInput`, `promptOverlay`, or an equivalent alias outside the
    single versioned allowlist. Seeded legacy `{sha256,byteLength}` snapshots are
    count-only `{kind:'unknown_legacy_digest',byteCount}` or absent from the first
    compatible reader; fixtures reject a `legacyDigestSuppressed` boolean,
    truncation flag, digest prefix, surrogate digest, or combined legacy shape;
    seed each closed prompt alias as a string, object, array, and nested object at
    multiple depths and prove the one compatibility reader hides the entire value
    from DB-facing history/API/export/SSE/diagnostic consumers. Unknown/malformed
    containers return only `legacy_task_log_unavailable`. After old-writer drain,
    crash/resume and fingerprint-conflict fixtures prove the checkpointed scrub
    removes every alias/value and unkeyed digest without overwriting a concurrent
    row or reconstructing a committed batch,
    and mixed-version DB/API/export/SSE fixtures prove none reappears or is
    misrepresented as re-keyed. The packet writer, database validator, finalizer/repair,
    Drizzle parser, API, and S5 presenter all import
    `PACKET_REDACTION_CATEGORIES`. Each literal category/count boundary round-trips;
    an unknown key carrying a selected-path/content/prompt/credential sentinel,
    duplicate semantic key, non-integer, negative, over-5,000 count, or non-object
    summary fails closed before persistence or rendering and is absent from every
    sink.
66. Epoch-2 instance replacement exercises rolling worker and root-writer
    restarts, abrupt W1 loss, every formerly active worker gone, bounded-capacity
    replacement, dry-run/apply/rollback, and old-principal replay. The maintenance
    principal promotes only an exact same-host/current-generation candidate under
    epoch/instance locks; fresh W2 election remains a separate step. Root-writer
    death at planned/materialized/fenced/bind/deleting/post-cleanup/repair states
    invokes the maintenance takeover ledger, validates token/object/revision, and
    keeps ingress disabled until every old pin is adopted or cleanup-required.
    Candidate-expiry and retirement tests exhaust each per-host and installation-
    wide hard bound and crash after
    role/certificate provisioning, revocation, session termination, tombstone,
    certificate destruction, and role drop. Bounded GC resumes without reusing an
    identity, never drops a referenced/recovery-owning principal, and leaves no live
    login/private key after successful retirement. Concurrent provisioners serialize
    on the 256-slot budget; the cap produces one deduplicated lifecycle-capacity
    alert, rejects every unreserved addition, preserves emergency revoke/drain and
    already-reserved count-neutral recovery, and releases capacity only after both
    credential resources are verifiably gone.
67. The generic local-effect route covers packet, packet-free, and handoff-only
    review; possible-local-invocation acknowledgement; interrupted retry; ordinary
    decline/cancel; ledger-first exact replay for every action; routed ownership;
    task approved/package blocked; stale/cross-kind identity;
    Redis wake loss; and races with W2, quarantine, packet acknowledgement/retry,
    sibling claims/leases/awaiting-review, policy exhaustion, and root management.
    Review writes one generic action and zero
    issuance actions, then atomically advances only an exact dependent packet
    disposition or rotates a no-packet marker to its invocation-dependent stored
    retry/acknowledgement disposition. Exhaustive marker fixtures accept the pending
    and acknowledged `local_invocation_uncertain` union arms, require the immutable
    attempt ID, rotate the fingerprint with exact acknowledgement actor/time, and
    reject null/non-null, reason/disposition, review-state, attempt-ID, and stale-
    fingerprint cross-products. Exact post-ack replay returns the recorded marker.
68. Packet-free/handoff ACP returns malformed or invalid output, transport failure,
    or uncertainty after changing working-tree, config, refs, or Git storage. Every
    adapter and validation-loop fixture proves the durable generic
    `not_started→invoking→returned|definitive_not_started|uncertain` CAS and exactly
    one call per row. Only the still-live exact owner/attempt may write
    `definitive_not_started`, and only from a trusted typed `pre_io_refusal` that
    proves no child/serialization/socket/network/credential/repository I/O began.
    Crash before/after intent, before/after every pre-I/O-refusal predicate, socket
    write/return, duplicate queue callbacks, unchanged repository plus external-
    side-effect fake, owner loss, and W2 recovery prove orphan recovery always maps
    `invoking` to `uncertain`. Only the live typed-refusal
    `definitive_not_started` branch gets direct retry; `invoking|returned|uncertain`
    requires acknowledgement before retry and never permits a second call or
    misleading safe-retry copy.
69. Packetless and packet alerts use mandatory alert identity. Exact W2 terminal
    commit writes one service-authored `quiescence_proven` resolution; crash before/
    after resolution, stale/cross-alert identity, dashboard open-alert queries, and
    privileged manual resolution remain truthful and idempotent. Total worker loss
    before/after lease expiry uses the non-worker watchdog, deduplicates concurrent
    detection/replacement, retains failed notifications, and resumes with W2. Real
    login-role tests deny `PUBLIC`, direct table DML, SET ROLE/session authorization,
    caller IDs, temp/search-path shadowing, cross-row reasons, heartbeat/claim/repair,
    and repository reads; only the fixed fully qualified SECURITY DEFINER function
    inserts the one database-derived alert.
70. The canonical reason/identity union covers missing generic evidence, wrong run/
    root/fingerprint, stale task projection, and incoherent quiescence with and
    without a packet audit. Missing evidence has null FK plus immutable expected
    identity and quarantine only; projection recompute, exact generic failure
    reconstruction, service-only quiescence proof, and generic quarantine each
    accept only their reason-specific predicate. Every reason × packet/null audit ×
    resolution cross-product is exhausted; no branch manufactures evidence.
71. Static contract and PostgreSQL race fixtures import #178/S3's
    `web/lib/mcps/mcp-admission-lock-order-v2.json` through #178/S3's one lock-order
    helper. Remaining S4 has no generator, local copy, or second helper. A parity
    sentinel first proves the runtime object is identical to ADR
    0009's canonical contract. Every transaction declares only its applicable row
    subset; a static check proves that subset is an ordered subsequence, rejects
    reverse edges and second runtime sequences, and rejects every truncated
    recovery/reapproval/review-gate sequence that omits an applicable family. Races
    cover local review/finalization/W2/rotation/repoint/gate actions
    in both orderings and prove observed waits, no deadlock, and compare-and-set
    rejection of stale authority.
72. A release-order test imports Step 0's data-only
    `web/lib/mcps/epic-172-release-order-v1.json` through its sole
    `web/lib/mcps/epic-172-release-order.ts` validator, proves the shared node
    registry and separately named `codeDependencyGraph` and `runtimeActivationGraph` graphs
    retain their fixed meanings, and rejects cycles or a missing
    `step0_retention_bridge → s3_issue_178 → s4_expand →
    s4_producers_disabled → s5_compatible_consumers_deployed →
    s6_pre_activation_green → s4_controlled_activation →
    s6_post_activation_green → ingress_and_issuance_enabled →
    s5_s6_release_ready` edge, and proves Step 0 imports no
    S3/#178 or S4 expansion/producer symbol. The release gate refuses #178 before
    all project-management create/update/repoint/archive/delete ingress is closed
    and drained and before the bridge route/retention-FK/hard-delete-guard
    postconditions; a wording-parity sentinel rejects a narrowed "delete ingress"
    prerequisite anywhere outside its own denylist fixture. It refuses
    S4 expansion or producers before their predecessor evidence. Ownership and
    dependency validation is per manifest step, not inferred from the issue-wide
    header: `step0_retention_bridge` has exact
    `owner:{issue:179,slice:'step0'}` with issue dependencies `[176,177]`, while
    `s3_issue_178` has exact `owner:{issue:178,slice:'s3'}` and depends on the Step 0
    postconditions. The exact remaining owners are
    `owner:{issue:179,slice:'s4'}` for `s4_expand`,
    `s4_producers_disabled`, `s4_controlled_activation`, and
    `ingress_and_issuance_enabled`; `owner:{issue:180,slice:'s5'}` for
    `s5_compatible_consumers_deployed`; and `owner:{issue:181,slice:'s6'}` for
    `s6_pre_activation_green`, `s6_post_activation_green`, and
    `s5_s6_release_ready`. A header/manifest parity test rejects any ownership
    mismatch, widened Step 0 dependency, obsolete `s4_activate`, truncated chain,
    graph/evidence substitution, a copied graph/helper, or a remaining-S4 step that
    omits S3. Step 0 solely creates and versions both files; remaining S4 only
    imports them and cannot generate, rewrite, fork, shadow, or extend the helper.
    The same fixture proves Step 0 installs the signer/durable-evidence/short-lived-
    transition-authorization/consumption stores,
    checked-in verifier, dedicated principals, recorder, transition-identity guard,
    and disabled enablement singleton before its signed first receipt and before
    S3; remaining S4 imports that substrate unchanged.
73. Release-evidence PostgreSQL fixtures exhaust unknown/extra node fields, wrong
    owner/manifest/graph/build/SHA/epoch/predecessor/controller identity, duplicate
    nonce, future issue time, node recording outside signer validity, invalid or
    wrong-key/domain signature, retired-key new signature, and cross-node receipt
    substitution. Every Step 0/S3/S4/S5/S6/enablement node and required-evidence
    row must carry a lifecycle-valid non-null Ed25519 signature at recording; the suite rejects
    any nullable or database-maintenance unsigned arm. Durable-node fixtures wait
    beyond 30 minutes and prove the retained node is still valid predecessor
    evidence. Transition-authorization fixtures reject zero/over-30-minute lifetime,
    expired use, wrong source/target/operation/controller/domain, and replay; after
    expiry they accept a newly signed exact authorization without rewriting or
    duplicating the durable node. Two distinct valid receipt
    IDs or nonces for the same canonical transition identity—manifest, node or
    evidence kind, owner, exact builds, reviewed SHA, epoch, and predecessor-set
    digest—conflict, as do two activation or enablement transactions racing one
    valid receipt: exactly one identity, append-only consumption, and state
    transition commit. Failure
    after every lock/verification/consumption/state write rolls the whole
    transaction back and leaves the durable receipt retryable with a valid or newly
    issued transition authorization; committed evidence
    cannot replay. Key rotation accepts retained old evidence for verification but
    never a new old-key node after cutoff. No command consults GitHub or a file/env
    boolean inside the cutover transaction.
74. The controller records a separate append-only required-evidence row of kind
    `enabled_build_tests_green`; that kind is never an eleventh graph node. Its
    signed payload binds the exact enabled S4/S5 builds, protocol
    epoch, controller App/key/run/job, post-activation receipt,
    `ingress_and_issuance_enabled` evidence, static suite-manifest digest, executed-
    ID digest, first-attempt result, output-scan digest, teardown, and destruction/
    reimage receipt. The exact successful set is the separate host preflight plus
    `test:mcp:contract`, `test:mcp:postgres`, `test:mcp:issuance`,
    `e2e:mcp-operator`, and `test:mcp:host-boundary`, with no skip/retry/missing ID.
    Absent, failed, stale, cross-build/epoch/controller, or incomplete enabled-build
    evidence prevents final readiness. One final-readiness transaction locks and
    reverifies that row plus `ingress_and_issuance_enabled`, the exact fresh short-
    lived final transition authorization, and the controller's signed final-readiness envelope, atomically and uniquely consumes both the
    `ingress_and_issuance_enabled` receipt and enabled-build receipt, and appends
    the uniquely identified signed `s5_s6_release_ready` linking both identities;
    rollback leaves neither consumption nor readiness, while committed readiness is
    the retained non-consumable release state. Provisional-window tests use database
    time and exact owner/build/SHA/epoch/expiry/controller login/run/token digest,
    gate every ingress and issuance boundary on both the overall deadline and live
    lease, and promote only the same unexpired owner to `active`. The controller
    heartbeats every 10 seconds, each lease is at most 45 seconds and capped by the
    overall deadline; wrong login/token/generation, missed heartbeat, controller
    death, explicit suite/evidence failure, or PostgreSQL failure closes access.
    Reused, stolen-after-rotation, delayed, and out-of-order heartbeat tokens never
    extend the lease, and only the authenticated controller receives each raw next
    token. These failures close access
    without lowering the epoch. Race heartbeat with every gate, failure, watchdog,
    disable, expiry, and promotion; exactly one authoritative singleton transition
    and one append-only audit disposition win. The enabled-build happy-path fixture
    runs the exact no-retry 660-second DAG at near-cap timings—60 orchestration, 30
    preflight, five isolated suites concurrently within 420, 120 teardown/destroy/
    Checks, 30 evidence/final commit—and proves active promotion with 900 seconds of
    the fixed deadline remaining. The canonical inspect/disable commands are
    idempotent; disable cannot affect another owner or active state. For each invalid variant, legacy-root
    scrub dry-run, first apply, later batch, and resume are actionless and create no
    operation/checkpoint; exact valid readiness is rechecked and bound on every
    invocation.

Real PostgreSQL owns transaction, lock, lease, migration, index, and failure-injection evidence. Lease tests compare against database time, not a fake worker clock. #181 composes a small cross-slice sentinel set from these tests instead of maintaining a second policy implementation.

## Additive migration, cutover, and rollback

The claimed uniqueness guarantee is valid only after legacy packet issuers are drained. Deployment order is therefore part of the architecture:

1. **Freeze legacy hard delete before expansion.** First deploy a bridge project-
   removal route that rejects hard delete (or performs the existing safe archive)
   before any filesystem call. Disable project-management ingress, stop/drain every
   pre-bridge web process and database session, and prove none is between `fs.rm`
   and SQL.
   Then the separately landable Step 0 bootstrap installs the data-only release
   manifest/validator, pinned signer policy/key, generic durable-evidence/short-lived-
   transition-authorization/consumption tables, disabled enablement-state singleton,
   append-only enablement-transition audit, checked-in Node verifier, dedicated
   principals, and generic signed recorder without creating a graph row. The Step 0
   retention migration then replaces every evidence-
   bearing project/task/run/audit/artifact cascade with `RESTRICT|NO ACTION` and installs the
   database hard-delete rejection guard. Step 0 depends only on #176/#177; it
   imports no #178/S3 or remaining-S4 symbol. Keep project-management ingress
   closed after those postconditions. The external release signer signs the exact
   empty-predecessor Step 0 envelope, and the bootstrapped generic recorder retains
   it. Later slices only import the manifest and substrate. That signed Step 0
   receipt must pass before #178/S3
   lands, and #178/S3 evidence must pass before item 3 opens the remaining S4
   expansion and journal window. A database conflict after repository removal is
   forbidden.
2. **Land and prove #178/S3.** With project-management ingress still closed, land
   the decision revision, operator-hold, negative reconciliation, root-binding, and
   canonical lock-manifest/helper contracts. The already-installed generic release
   gate records the exact signed S3 build and PostgreSQL evidence using Step 0 as
   its consumed predecessor. Missing or mismatched S3 evidence rejects the
   remaining S4 schema, journal, reader, writer, and producer nodes.
3. **Expand schema.** Add project `root_ref UUID NULL` with **no default** in the
   first metadata-only step. In a separately timed, lock-bounded statement, set
   `DEFAULT gen_random_uuid()` while project-management ingress remains closed. Install
   a database-owned `BEFORE INSERT` bridge that fills any remaining null, including
   an explicitly supplied null, and a narrow `BEFORE UPDATE OF root_ref` guard that
   rejects only `OLD.root_ref IS NOT NULL AND NEW.root_ref IS NULL`. Both functions
   are schema-qualified, accept no caller identity/input, and are owned by the
   non-login migration owner with fixed search paths and `PUBLIC` execution revoked.
   The guard deliberately allows an unrelated update where an existing legacy
   `root_ref` remains null before its backfill batch. Install the expansion journal/
   trigger while ingress is still closed. Only after the default, insert bridge,
   re-null guard, journal, and their database tests are committed may legacy project
   ingress reopen exactly once for the mixed-version window. Build the unique non-null
   `root_ref` index concurrently; additive root-binding revision
   with explicit unbound default `0`,
   opaque host-resource/host identity and binding-key fingerprint,
   root-maintenance/archive audit fields, the live-only partial uniqueness and
   hierarchy-claim/guard constraints, pre-create reservation table with writer
   pins, task-local-change barrier fields/function/deferred constraints, generic
   local-run evidence/action rows, key-generation/rotation/shadow rows, the
   expansion-window project-root change journal/trigger, typed worker/root-writer
   capability/principal registry with unique principals/protected heartbeat,
   append-only epoch-2 membership changes, and the service-only committed-election
   read view/principal;
   nullable protocol-v2 nonce/revision/claim fields; authoritative authorization
   JSON plus exact scalar mirrors, schema-qualified validator, immutable-field
   guard, retained five-column approval FK, and the exact partial indexes;
   append-only Architect plan version/entry/history-read tables and non-text
   artifact-header guard; host-apply ledger/entries; append-only
   issuance-recovery action and integrity alert/resolution tables with their unique
   keys; the protocol epoch singleton; package claim-protocol/instance/recovery
   columns; working-tree/Git-control/Git-storage baseline/change evidence; and the
   rejecting package-transition trigger. Do **not** enable the
   project-root trigger while legacy project routes remain live. New
   projects receive a random reference at creation. Backfill existing projects with
   database-generated random UUIDs in bounded, restartable primary-key batches. A
   durable path-free checkpoint stores operation ID, last project key, rows updated,
   state, actor, and database time; each batch uses lock/statement timeouts and may
   pause before its preflighted disk/WAL budget. Each update changes only `root_ref`
   where it is still null, so a concurrent unrelated update is retained. Keep the
   default, insert bridge, and re-null guard through the whole mixed-version window.
   After a zero-null scan, add and validate `CHECK (root_ref IS NOT NULL) NOT VALID`,
   validate the unique index, then take the separately budgeted short metadata lock
   to set `root_ref NOT NULL`; only afterward may the temporary proof and triggers be
   removed.
   Verify every project is populated and unique before any v2
   preview/evidence producer is enabled. Do not rewrite legacy approvals with
   synthetic nonces. Do not reinterpret required legacy zero/default audit
   columns as a truthful packet snapshot.
   Backfill the task local-change projection only through the database-owned
   aggregate in bounded batches, retain its source-set/version audit, and install
   the immediate mutation-generation trigger, transaction-local final-generation
   dedup, direct-DML guard, and deferred cross-row constraint. A default `0/null`
   without verified source equality is non-authoritative and blocks activation/
   claims. Preallocate exactly eight current-authority heads for every protocol-v2
   package and backfill their revision/source-FK/fingerprint/CAS identity from
   immutable history. A task over 256 sibling packages is moved
   `active → archive_pending → legacy_archived` only through the exact whole-task
   archive commands/runbook above. Its packages and evidence remain attached and
   no backfill, archive, or claim truncates/reparents them; a separate replacement
   stores source binding, `pending|eligible|cancelled` state, version, and
   fingerprint; every boundary rejects pending, and the final archive CAS alone
   makes it eligible at at-most-256 packages with all eight heads each. The release evidence
   includes the maximum-cardinality p95/p99 budget result.
   `host_resource_ref` remains nullable during expansion because PostgreSQL cannot
   safely canonicalize host filesystems. Install the dry-run-only form of the
   checked-in host command and layman-readable procedure
   `docs/operators/project-root-binding-v2.md`; applying it is a post-drain cutover
   step below, never a live legacy bridge.
   Add the task-bound plan-entry resolver, dedicated ACL history/detail route, and
   append-only bounded read audit. New Architect artifacts are non-text headers;
   append-only plan entries are the only text store. Deploy generic task/artifact/
   SSE/log readers that hide raw text and storage locators, plus prompt readers
   that suppress legacy unkeyed digests to the one count-only legacy arm or
   absence. No migration creates a second text store or package-metadata copy.
4. **Disable every v2 producer and drain legacy writers.** Deploy dual S4 readers
   that understand v1 and v2. Every legacy filesystem approval without a stored
   root-binding revision is non-issuable, and legacy audit rows without a typed
   assembly snapshot render as `unknown_legacy`, never invented zero counts. New
   v2 worker/root-writer processes register as authenticated `candidate` rows while
   durable epoch 1 rejects every protocol-2 packet, packet-free, and handoff claim.
   Queue/project ingress, packet issuance, v2 root routes, and every other v2
   producer remain disabled. Disable legacy project-management ingress; revoke the
   v1 web/root-writer database credential, terminate its sessions, revoke legacy
   Redis publish/write credentials, close old SSE subscriptions, and drain every
   legacy or genuine pre-trigger worker, web, root-management, event-publisher, and
   subscriber process.

   After revocation and session termination, capture the journal generation and run
   exactly
   `npm run project-roots:reconcile-expansion -- --through <generation> --actor <operator-id> --apply`.
   It is bounded/restartable, imports the applicable S3 lock-order subsequence,
   records exactly one `insert|root_update|archive` outcome through the watermark,
   and retains only path-free aggregate audit. Any gap, later legacy commit, or
   command crash blocks progress. Then run
   `npm run project-roots:bind-v2 -- --actor <operator-id>` and inspect its exact
   dry-run result, followed by
   `npm run project-roots:bind-v2 -- --actor <operator-id> --apply`. It acquires
   hierarchy/resource fences outside database locks, compare-and-sets positive,
   non-overlapping host/key/hierarchy bindings, and never upgrades legacy
   approvals. Duplicate, alias, ancestor/descendant, unbound, or maintenance rows
   remain audited blockers. With ingress still disabled, enable the project-root
   trigger; at epoch 1 it rejects root mutation rather than invoking S3. The
   `s4_producers_disabled` receipt binds the exact S4 build and all drain,
   reconciliation, binding, trigger, and producer-disablement evidence. Before
   that receipt can commit, a checkpointed plan migration assigns deterministic
   task-scoped versions and stable entry IDs, writes protected entries, and in the
   same transaction replaces each legacy artifact's raw content/metadata with the
   fixed non-text header. Recognized structured fields receive eligible references
   only from their exact canonical bindings; ambiguous legacy content becomes
   history-only `legacy_full_plan` and leaves its package blocked for plan
   recomputation. Update/delete guards are enabled before the checkpoint advances.
   A second checkpoint removes raw `promptOverlay`, `requirementContexts`, and
   `mcpAwareSubtasks` from runtime work-package metadata/API projections. Before
   drain the sole compatible reader recursively hides every closed prompt alias
   whether its value is a string, object, array, or nested message structure. The
   same post-drain primary-key-checkpointed fingerprint-CAS scrub deletes all such
   alias/value pairs and every legacy unkeyed `sha256` prompt snapshot or
   maps it only to `{kind:'unknown_legacy_digest',byteCount}`; it never re-keys
   without plaintext and never emits a suppression/truncation boolean.

   With old publishers drained, delete every legacy
   `forge:task:{taskId}:history`/`:seq` key, rotate writers/readers to only
   `forge:task-events:v2:{taskId}:history`/`:seq`, and run complete cursor scans
   proving zero old keys and no plan/prompt/content/locator/sentinel field in any v2
   value. Live publish, current snapshot, Last-Event-ID replay, normal task/artifact
   APIs, logs, exports, diagnostics, errors, and queue payloads all pass the same
   seeded omission suite. An attempted write with the revoked legacy credential
   fails. Zero remaining raw artifact/runtime text, legacy event keys, unkeyed
   digest fields, and mixed-version DB/API/export/SSE evidence are mandatory parts
   of the receipt; expiry is never accepted as Redis erasure.
5. **Deploy compatible S5 and disabled S6.** Deploy #180's compatible evidence
   consumers before activation. They read v1/v2 evidence without manufacturing
   missing state. Deploy #181's external controller and supported-host harness
   disabled. Verify the already-bootstrapped Ed25519 key/App/ruleset lifecycle,
   checked-in Node verifier, dedicated evidence-writer/transition principals, and
   append-only recorder/consumer; rotate only through the signed predecessor-bound
   key lifecycle. Neither
   deployment may enable a writer, queue/project ingress, or packet issuance.
6. **Require `s6_pre_activation_green`.** The S6 controller runs the exact pre-
   activation manifest against the S4 and S5 build identities. Only one fresh,
   signed `s6_pre_activation_green` receipt for those exact builds and predecessor
   evidence may unlock controlled activation. Missing, stale, cross-build, skipped,
   retried, or runner-self-attested evidence blocks activation. Recording uses the
   dedicated verifier principal and one locked transaction to verify the canonical
   domain/key/nonce/issue/expiry/signature and exact predecessor rows with no
   network read, then appends the immutable receipt.
7. **Run controlled activation with ingress still disabled.** Verify no v1 claim
   remains, keep every registered S3/root writer, queue/project ingress, and packet
   issuer disabled, then run the two literal checked-in `web` maintenance commands
   in order:

   ```text
   npm run protocol:activate-work-package-v2 -- --actor <operator-id>
   npm run protocol:activate-work-package-v2 -- --actor <operator-id> --apply
   ```

   The first command is dry-run only and reports every blocker. The second verifies `READ COMMITTED`,
   executes the privileged three-statement activation, is idempotent, verifies
   epoch/postconditions, and retains the database activation audit. The
   layman-readable procedure is
   `docs/operators/work-package-protocol-v2-cutover.md`; ad hoc SQL is forbidden.
   Before `--apply`, the command requires exactly one fresh candidate host and proves
   every selected worker/root writer uses its dedicated live database principal,
   the one binding-key fingerprint and
   supports the host fence service plus non-escapable operating-system containment
   adapter; all stale, incompatible, divergent-key, legacy, and other-host instances
   require audited drain evidence. It snapshots those rows in the activation audit.
   Install the
   checked-in integrity inspect/repair commands and runbook. Missing capability,
   authoritative host identity, drain evidence, or runbook is a cutover blocker.
   Its final data-modifying statement atomically advances the epoch and promotes
   only the audited candidates to `active`. It records the active binding-
   generation pointer, new root-writer credential generation, and exact v2 ingress
   owner while every writer and ingress/issuance path remains disabled. It also requires
   every live local project to have a positive non-overlapping root
   binding/fingerprint, no root-maintenance intent or unresolved reservation/
   rotation; every task to have a verified current-version local-change aggregate
   with no source mismatch; and retained audit from both the through-watermark
   reconciliation and binding commands. Legacy approvals remain held.
   Only the second literal command above may advance the durable epoch;
   `project-roots:bind-v2` never does so. The activation transaction locks and
   reverifies the exact `s6_pre_activation_green` row and signer policy, inserts its
   unique append-only consumption, and commits `s4_controlled_activation` in the
   same transaction without enabling any producer or ingress path. Rollback leaves
   no consumption; the durable node remains usable with the same still-valid or a
   newly issued exact short-lived transition authorization. Committed consumption
   cannot replay. Shared-first v1 package claims cause
   activation to abort; activation-first rejects stale v1 package claims before
   repository reads.
   Before routine process restarts are permitted, install
   `docs/operators/work-package-instance-replacement-v2.md` and the exact
   `protocol:replace-work-package-instance` dry-run/apply command. Replacement uses
   the separate maintenance principal and append-only membership audit; it never
   reuses activation or lowers the epoch.
8. **Require `s6_post_activation_green`.** With the activated epoch/build and every
   writer plus ingress/issuance path still disabled, #181 reruns the exact post-
   activation manifest. Only a newly recorded signed receipt bound to that exact epoch, S4
   build, S5 build, controller run, and pre-activation receipt may unlock
   enablement. The same pinned-key, canonical-envelope, nonce, predecessor,
   dedicated-verifier-principal, and append-only durable-recording rules apply.
   The node does not expire after valid recording; opening enablement additionally
   requires a separate at-most-30-minute transition authorization bound to it.
   Missing or mismatched evidence leaves the system closed.
9. **Open one bounded provisional enablement window, then issuance last.** One
   #179-owned audited transaction locks/reverifies and uniquely consumes the exact
   post-activation receipt through the dedicated transition principal. As its
   transition result it records—but does not consume—the separately signed,
   canonically unique `ingress_and_issuance_enabled` receipt for final readiness.
   It compare-and-sets the singleton enablement state from
   `disabled` to `provisional`, writes its exact operation owner/build/SHA/epoch,
   opening database time, and the exact database-time deadline
   `started_at + interval '1560 seconds'`,
   opening transition-authorization ID/digest and controller login/run identity.
   Before requesting that signed opening transition, the external controller
   generates the initial random single-use secret locally, retains its raw value,
   and includes only its domain-separated digest in the authenticated opening
   request. The transition transaction stores that digest and initializes lease generation
   1 and `lease_expires_at = least(started_at + interval '45 seconds', expires_at)`.
   enables only the registered S3/root-writer principals from the activation
   snapshot, then queue/project ingress, and packet issuance last. Receipt
   consumptions, state, owner/expiry, and every enablement flag roll back together;
   no later slice may recreate or bypass this operation.

   Every queue claim, project create/update/repoint/archive route, filesystem-grant
   mutation that can wake work, worker claim, root writer, and packet-issuance path
   locks or reads the singleton through one database-owned gate. It admits
   `active`, or `provisional` only for the exact owner/build/SHA/epoch/controller
   while both `clock_timestamp() < lease_expires_at` and
   `clock_timestamp() < expires_at`; any null/mismatch, lease/deadline expiry,
   database read error, controller death, or disabled state rejects before mutation
   or I/O. No process
   flag or cached successful read is authority. Expiry closes all new ingress and
   issuance automatically without lowering the protocol epoch or discarding
   evidence. The graph still has exactly ten nodes:
   `ingress_and_issuance_enabled` means this signed, bounded provisional window,
   not permanent readiness.

   The exact certificate-authenticated controller login is non-superuser,
   `NOINHERIT`, and cannot `SET ROLE` or change session authorization. While
   provisional, it calls fixed-search-path, `PUBLIC`-revoked
   `forge.heartbeat_epic_172_enablement_controller_v1` every 10 seconds. The
   function derives identity from immutable `session_user`, locks the singleton,
   verifies exact operation/run, transition-authorization digest, controller-token
   digest, state fingerprint and positive lease generation. Before each direct
   mutually authenticated database heartbeat, that same external controller
   generates the fresh next secret locally and sends the current raw secret plus
   only the next secret's domain-separated digest as prepared/binary parameters.
   The function hashes the current secret, then compare-and-sets its digest plus
   lease generation to the supplied next digest/generation while advancing last-
   heartbeat/lease expiry using database time. It returns no raw secret. The presented
   token is consumed by that CAS; reuse, theft after rotation, delayed delivery, or
   an out-of-order generation fails without extending the lease. The raw current/
   current or next raw token is never stored, audited, logged, returned by inspect,
   interpolated into SQL text, or exposed to
   a worker/writer principal. A heartbeat extends the lease to at most 45 seconds
   from that database instant and never beyond the
   immutable 1,560-second deadline. Every provisional boundary uses the same
   fixed-search-path gate; an expired lease/deadline compare-and-sets the singleton
   to `disabled`, clears all flags, appends exactly one non-authoritative
   `expired_disabled` audit disposition, and rejects. The separately credentialed
   watchdog does the same while idle.

   On the first suite failure, invalid result/evidence, controller cancellation, or
   Checks failure, the controller calls
   `forge.fail_epic_172_provisional_enablement_v1` with the exact operation/token/
   expected fingerprint. That transaction reauthenticates `session_user`, changes
   only the matching provisional singleton to `disabled`, clears every flag, and
   appends `failed_disabled`; it cannot affect another owner or `active`. If the
   controller or database disappears before that commit, heartbeat expiry makes
   every gate close within 45 seconds and never after the overall deadline.

   Operators use only:

   ```text
   npm run protocol:inspect-epic-172-provisional-enablement -- --operation <operation-id>
   npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id>
   npm run protocol:disable-epic-172-provisional-enablement -- --actor <operator-id> --expected-operation <operation-id> --apply
   ```

   Disable compare-and-sets the exact provisional owner/fingerprint to `disabled`,
   clears all ingress/issuance flags atomically, and retains epoch, receipts, and
   failure evidence while appending `manually_disabled` to the non-authoritative
   audit. It is safe after expiry and cannot disable a different active operation.
   The exact recovery procedure is
   `docs/operators/epic-172-provisional-enablement-v1.md`; the general cutover
   guide links to it rather than restating the protocol.
10. **Mark final readiness and promote enablement.** Only while the exact
   provisional enablement owner still has a live controller lease and is unexpired
   may the controller run the separate host preflight and the exact five enabled-build
   suites (`test:mcp:contract`, `test:mcp:postgres`, `test:mcp:issuance`,
   `e2e:mcp-operator`, and `test:mcp:host-boundary`) against the enabled S4/S5
   builds and epoch. The enabled-run DAG has a hard 660-second success budget:
   at most 60 seconds total orchestration/scheduling, then 30 seconds host preflight,
   then all five suites concurrently in isolated runner/database/Redis namespaces
   with the longest command capped at 420 seconds, then at most 120 seconds for
   teardown, out-of-band destruction/reimage and authoritative Checks conclusion,
   then at most 30 seconds to record evidence, mint/reverify the final transition
   authorization, and commit readiness. There are no suite, job, evidence, or
   transition retries inside this window. Ten-second controller heartbeats continue
   through every stage. The 1,560-second database deadline therefore leaves an
   explicit 900-second failure/cleanup margin. With no skip, retry, missing manifest ID, leakage, or teardown/
   destruction gap, it records a separate signed, controller-owned append-only
   required-evidence row of kind
   `enabled_build_tests_green`, bound to exact App/key/run/job, build, epoch,
   post-activation receipt, provisional owner/expiry, enablement
   evidence, manifest/executed-ID/result/output-scan, teardown, and destruction
   digests. This evidence kind is not an eleventh graph node. A final-readiness
   transaction locks/reverifies both durable receipts, the exact fresh at-most-
   30-minute final transition authorization, and the exact unconsumed
   `ingress_and_issuance_enabled` receipt, the still-unexpired provisional state,
   and the controller's signed final-readiness envelope. It uniquely consumes both
   receipts, appends the unique signed `s5_s6_release_ready`, and compare-and-sets
   the same owner from `provisional` to `active` with null expiry and the final-
   readiness receipt ID while clearing controller lease/token fields and appending
   the non-authoritative `promoted_active` audit disposition. All changes commit or roll back together. Rollback
   consumes neither receipt and does not promote the window. A failed/skipped suite,
   missing/mismatched evidence, controller death, database failure, or expiry leaves
   final readiness absent; the database gate is fail-closed immediately on a
   committed failure transition/read error or within the at-most-45-second lease and the
   canonical disable command records the closure without lowering epoch. There is
   no downstream-reader deployment after activation.

After final readiness, #179 may run the separately gated legacy-path scrub through
this exact interface and guide:

   ```text
   npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id>
   npm run protocol:scrub-legacy-runtime-roots -- --actor <operator-id> --apply
   npm run protocol:inspect-legacy-runtime-root-scrub -- --operation <operation-id>
   docs/operators/legacy-runtime-root-scrub-v2.md
   ```

The first command is dry-run; repeated `--apply` resumes one bounded operation. A
path-free checkpoint records operation ID, last audit primary key, aggregate counts,
state, actor, and database time—never a path, hash, or encoded copy. Eligibility
requires durable final readiness linked to the exact consumed controller-owned
`enabled_build_tests_green` row, revoked v1 credentials/sessions, no legacy writer, and
the v2 constraint that forbids repopulation. Dry-run, initial apply, every later
batch, and resume lock/revalidate the exact readiness row, builds, epoch,
predecessors, and enabled-build payload and store that receipt ID in the operation;
missing, stale, failed, cross-build/epoch/controller, or incomplete evidence is
actionless and creates no checkpoint. This operation/later migration is
not registered with the ordinary expansion migrator. It clears legacy audit paths,
records only aggregate counts, and never derives `rootRef` from a path. Applied
batches intentionally do not roll back; column drop additionally requires the
support window, a zero-remaining inspect result, and no compatible-reader dependency.

Rollback leaves the additive schema, epoch, and v2 data in place and never lowers
the epoch. UI/readers may roll back to a compatible version, but a legacy packet
issuer must never be restarted once v2 decisions can exist. If worker rollback is
required, disable packet issuance and root management, ask the host fence service/
containment adapter to prove every active group empty, terminalize or integrity-
hold every active effect intent, drain v2 workers and root writers, and keep both
paths disabled until v2-capable processes with the same host identity,
host-binding-key fingerprint, containment/fence protocol, and ledger protocol are
restored. Rollback never reenables a legacy hard-delete or root writer.

## Implementation order

The separately landable #179 Step 0 solely creates and versions the data-only
`web/lib/mcps/epic-172-release-order-v1.json` and its one validator/helper,
`web/lib/mcps/epic-172-release-order.ts`. The JSON contains one shared node
registry with owner, required evidence, and build identity, plus separately named
`codeDependencyGraph` and `runtimeActivationGraph` edge sets. The helper validates each graph
under its fixed meaning and exposes read-only accessors. Remaining S4 imports those
files only; it never generates, rewrites, copies, forks, shadows, or adds a second
release-order helper. Step 0 also solely installs the generic pinned-signer,
Ed25519 verifier, durable-evidence/short-lived-transition-authorization/consumption,
dedicated-principal, transition-identity, bootstrap-recorder, sole authoritative
enablement singleton, and append-only enablement-transition audit described above; later
slices import it and cannot create an unsigned or alternate path.
`codeDependencyGraph` encodes
`S1 → S2 → Step 0 → S3/#178 → remaining S4 → S5 → S6` delivery order. The
normative **runtime activation** graph instead contains the acyclic chain
`step0_retention_bridge → s3_issue_178 → s4_expand →
s4_producers_disabled → s5_compatible_consumers_deployed →
s6_pre_activation_green → s4_controlled_activation →
s6_post_activation_green → ingress_and_issuance_enabled →
s5_s6_release_ready`, names each required postcondition, and is
validated before a slice can land or deploy. No prose-only dependency may weaken
that graph. This runtime activation graph is distinct from code-dependency order:
S4 code lands before S5 consumes its schema and S6 tests the integrated system,
but S4 producers and activation remain gated by deployed compatible S5 consumers
and the named S6 checks. Ownership/dependencies are evaluated per step: the manifest stores
exact `owner:{issue:179,slice:'step0'}` plus issue dependencies `[176,177]` on
`step0_retention_bridge`, and exact `owner:{issue:178,slice:'s3'}` plus the Step 0
postcondition dependency on `s3_issue_178`. Exact `owner:{issue:179,slice:'s4'}`
applies to `s4_expand`, `s4_producers_disabled`, `s4_controlled_activation`, and
`ingress_and_issuance_enabled`; exact `owner:{issue:180,slice:'s5'}` applies only
to `s5_compatible_consumers_deployed`; exact `owner:{issue:181,slice:'s6'}` applies
to `s6_pre_activation_green`, `s6_post_activation_green`, and controller attestation
`s5_s6_release_ready`. There is no joint-owner schema. Remaining S4 steps depend on
`s3_issue_178`; they do not retroactively make Step 0 depend on #178. The split
dependency metadata in this document's header must match those per-step tuples.
Tests reject obsolete `s4_activate`, any truncated chain, any copied graph/helper,
or either graph or its evidence substituted for the other.

### Code-delivery order (`codeDependencyGraph`)

0. **Step 0 — separately landable retention bridge.** Deploy the
   pre-filesystem-work archive-or-reject project-removal route; disable **all
   project-management ingress**—create, update, root attach/repoint, archive, and
   delete—and drain every pre-bridge process/session; then land the retention-safe
   `RESTRICT|NO ACTION` foreign-key conversion and database hard-delete guard.
   Prove the route/drain/FK/guard postconditions before any #178 or remaining S4
   code lands. This bridge release imports no #178/S3 decision code and no S4
   expansion, journal, reader, writer, or producer symbol. It solely creates and
   versions the data-only release-order JSON plus its one TypeScript validator with
   shared node evidence and separate `codeDependencyGraph`/`runtimeActivationGraph`
   graphs. Before recording Step 0, install the generic signed release store,
   verifier, unique transition identity, consumption ledger, dedicated principals,
   and disabled enablement state; then retain the signed empty-predecessor Step 0
   receipt. A static wording-parity sentinel rejects any Step 0 prerequisite that
   narrows this to delete ingress; only the sentinel's denylist fixture may contain
   that stale phrase.
1. **Step 1 — #178 / S3.** Land #178's decision revision, operator-hold,
   reconciliation, and applicable-subset lock-order contracts only after Step 0's
   manifest evidence passes.
2. **Step 2 — remaining S4 expansion.** Only after #178/S3 passes, add the
   expand schema/backfill, exact indexes, root-binding/reservation/
   tombstone protocol, expansion-window journal, authenticated worker/root-writer
   principal registry with unique principals/session-authenticated protected
   heartbeat, epoch-2 membership/root-transition takeover audit, service-only
   committed-election view/principal and watchdog, binding
   generations/rotation shadows, database-maintained task projection, generic
   local-run evidence, host-apply ledger, working-tree/Git-control/Git-storage
   three-domain reviews, generic invocation intent, local/issuance recovery/
   decline actions, discriminated integrity tables, executable authorization JSON/
   mirror/FK validators, append-only Architect plan version/entry/read-audit
   storage and its two session-login-authenticated database-owned readers,
   append-only grant/project decisions plus CAS current pointers, the durable-node/
   short-lived-transition-authorization split, the sole authoritative enablement
   singleton/append-only transition audit, and the over-limit whole-task archive
   state/operation,
   nullable-then-default/insert-bridge/re-null-guard root-reference lifecycle,
   worker/root-writer protocol barriers, and legacy
   readers. Keep every v2 producer disabled throughout expansion. Do not register
   the destructive root scrub in the ordinary pending migration chain yet.
3. Add the shared all-mode protocol-v2 package claim, integrated packet claim,
   execution/generic/optional-packet heartbeat, packet-recovery candidate guard,
   sibling task-state operator-hold reconciler, generic local review/
   acknowledgement/retry/decline endpoint,
   and top-down generic-local/packet stale/partial-state repair behind a database-
   disabled gate.
4. Add the dedicated ACL plan-history route/read audit, package-bound immutable
   entry resolver, deterministic legacy mapping, once-per-task/final-generation
   projection validation over eight preallocated heads per package, the 256-package/
   2,048-fixed-head cap, whole-task legacy archive commands/runbook, and p95/p99
   release budgets, and structured
   serialization with native system-role policy for role-preserving adapters and
   explicitly non-enforcing flattened guidance for ACP.
5. Replace executor capability merge/gating copies and every raw prompt/task-log/
   plan-event producer/alias with the allowlisted keyed-digest/count or ID/progress
   record. Install the recursive string/object/nested-alias compatible task-log
   reader, filter normal APIs/SSE live/snapshot/replay, rotate the Redis namespace,
   and add the post-drain checkpointed database scrub plus legacy-key purge/zero scan.
6. Move Forge control/run state out of the project, establish the protected bounded
   generation-fenced principal pool/exchange, sterile Git environment, and acquire
   project plus external gitdir/common-dir/
   alternate-store fences before any repository read. Stage all repository
   baselines and typed packet assembly metadata before
   exposure; add the fence service/containment adapter, root-management integration,
   monotonic generic invocation/effect intent, per-entry apply ledger, and authenticated
   service-challenge W2 recovery; then atomically
   finalize the run/package/lease, audit, artifacts, action/marker, gates, and task
   disposition while holding the fence.
7. Add race, restart, injection, migration, mixed-worker, rollback, release-order-
   manifest, lock-order-manifest, and failure-point tests.
8. Import Step 0's checked-in Node release-receipt verifier/recorder, short-lived
   transition-authorizer, and atomic consumer
   and add journal reconciliation/binding/activation, epoch-2 instance-
   replacement/root-transition takeover, key-rotation, legacy-root-scrub, and
   generic integrity commands/operator runbooks; exercise the real
   command under both bridge-trigger orderings and a genuine pre-trigger worker,
   and retain its database audit as release evidence.
### Runtime deployment and activation order (`runtimeActivationGraph`)

1. Deploy and prove `step0_retention_bridge`.
2. Land and prove the exact `s3_issue_178` build.
3. Deploy `s4_expand` with all v2 producers disabled.
4. Drain legacy writers, reconcile/bind roots, and retain exact
   `s4_producers_disabled` evidence.
5. Deploy compatible #180/S5 consumers and #181's disabled external
   controller/supported-host harness as `s5_compatible_consumers_deployed`.
6. Require a fresh signed `s6_pre_activation_green` receipt bound to the exact
   S4/S5 builds and predecessor evidence.
7. On supported Linux only, run controlled activation against that receipt and
   retain `s4_controlled_activation`; every writer and ingress/issuance path remains
   disabled.
8. Require fresh signed `s6_post_activation_green` evidence bound to the exact
   activated epoch, S4/S5 builds, controller run, and pre-activation receipt.
9. Through one #179-owned audited operation, consume the signed post-activation
   receipt, compare-and-set the Step 0 enablement singleton from `disabled` to one
   database-time-bounded `provisional` owner/build/SHA/epoch/expiry window with the
   exact controller login/run/authorization/token digest and at-most-45-second
   database lease, enable
   only the registered S3/root writers from the activation snapshot, then queue/
   project ingress, and packet issuance last; retain the signed
   `ingress_and_issuance_enabled` receipt. Every ingress, claim, wake, root writer,
   and issuance boundary checks both the exact overall deadline and live lease
   before I/O. Heartbeat is every 10 seconds; failure/expiry/watchdog/manual disable
   changes only the singleton to `disabled` and appends its audit disposition.
10. Only while that same provisional window and controller lease remain unexpired,
    run the no-retry 660-second enabled-build DAG with its 900-second margin. Require a separate signed
    `enabled_build_tests_green` required-evidence row proves the exact preflight/
    five-suite set and a fresh short-lived final transition authorization may #181
    verify the signed final envelope, atomically consume
    both the enablement and enabled-build receipts, append unique signed
    `s5_s6_release_ready`, and promote that exact owner from `provisional` to
    `active` with no expiry. Expiry, controller death, suite/evidence failure, or
    database failure fails closed without lowering the epoch; the canonical inspect
    and disable commands remain available. The evidence kind
    is not an eleventh graph node.

Only after final readiness exists may #179 execute the separately gated,
restartable root scrub. It is a post-drain operation/later migration, never an
expansion migration that the normal migrator could run early.

## Stop conditions

Stop if implementation would claim OS confinement, ACP role separation it does not
transport, exactly-once external submission, prompt-text enforcement, or recall of
bytes; if any local-root ACP path can submit more than once per generic run; if generic
stale recovery can mutate a linked v2 run; if any artifact/log/API needs a path or
content; if the whole live terminal state cannot be made crash-consistent; if
issuance cannot compose with the existing execution lease and #178 lock order; if
the durable epoch trigger cannot reject v1 writers before bounded reads; if legacy
issuers cannot be proven drained; if generic readiness can bypass an S4 marker; if
the finalization parser accepts a known-invalid tuple; or if S2/#178 do not expose requirement-scoped
decisions, decision revision, and structured operator-hold identity needed for
filtering and recovery; if a valid submitted response can fail without a truthful
closed stage; if a gate path locks backward or decides from pre-transaction
freshness; or if a terminal-success split can become a packet-failure retry.
Also stop if a sibling under mandatory review can be bypassed; if any normal route
can clear an integrity hold; if a true mismatch has no evidence-preserving terminal
quarantine; if the complete host-ledger/artifact/action/integrity/gate lock tail
cannot be preserved; if the canonical physical root cannot be fenced from before
its first read through descendant quiescence; if project management can bypass the
same fence; if current-host identity or single-host activation capability cannot
be proven; if terminal/effect/ledger compatibility cannot be enforced; or if an
unknown/partial host apply can expose retry without fingerprint-bound working-tree
review. Stop if nonexistent-root creation lacks a namespace reservation; if a
project deletion can cascade immutable evidence; if an exact fresh registered
worker/root-writer and binding-key fingerprint are not enforced after cutover; if
containment emptiness cannot be proved; if unconfined ACP changes are undetected or
unreviewed; or if quarantine can remove a sibling repository-review barrier.
Stop as well if a caller-set instance ID can substitute for trigger `current_user`
or definer `session_user`; if any
protocol-2 mode can claim before activation; if a stale task projection can admit a
claim; if a packet-free/handoff local-root run can use legacy recovery; if Git
control, external Git authority, or reachable `.forge` state is excluded without
protection/evidence; if W2
election lacks the protected challenge/receipt handshake; if existing-project
reservation binding reverses the entity order; if K2 promotion rewrites an
unbounded owner set or lacks durable per-owner shadows; if the post-drain journal
watermark is incomplete; or if any raw executable prompt survives in task logs,
exports, APIs, events, diagnostics, or errors.
Stop if Architect-authored plan text has any durable source other than insert-only
`architect_plan_entries`; if its artifact header, generic API/list, live event,
SSE snapshot/replay, task log/export, queue, diagnostic, error, or either Redis
namespace contains raw text or a resolvable locator; if the history route lacks a
current ACL plus append-only read audit; if any role other than the non-login owner
can directly select plan text; if there are not exactly two fixed-search-path,
`PUBLIC`-revoked readers with only audited-human-history and package-bound-resolver
semantics; if the human reader treats shared-login `session_user` as a user, accepts
an asserted user ID, logs/stores its opaque credential, or cannot deny swapped/
expired/revoked/fabricated sessions with zero bytes and audit; if the package
resolver does not derive its registered worker from immutable `session_user`; if
legacy mapping has no stable entry IDs/
canonical bytes/keyed domain digest/ambiguous-history-only branch; if the whole row
or a rejected/ineligible fragment reaches provider/ACP wire input; if old Redis
publishers/keys are not revoked, drained, purged, rotated, and zero-scanned before
`s4_producers_disabled`; if runtime work-package metadata/API retains raw
`promptOverlay`, `requirementContexts`, or `mcpAwareSubtasks` text; if a legacy
task-log reader exposes a prompt-bearing string, object, array, nested message, or
closed alias at any depth; if a legacy unkeyed prompt digest is exposed after the
compatible reader deploys, uses any
shape except count-only `unknown_legacy_digest` or absence, or survives the post-
drain checkpointed fingerprint-CAS scrub; or if a heartbeat, governed read, assembly,
exposure, or finalizer can use copied tokens without locking and revalidating the
epoch, pinned instance, and `current_user`.
Stop if authorization JSON and scalar mirrors can diverge; if an authorization
field can change after claim; if an approval from another package/task/project can
satisfy the scoped retained FK; if a source change can bypass the final-generation
projection assertion or direct-DML guard; if protocol-v2 task/package/run/local-
evidence IDs may be null or unequal; if the existing package-unique approval-
history index is not removed/replaced, if reapproval lacks a strictly greater
project-serialized revision/fresh nonce, or if direct DML can construct authorization
JSONB; if raw duplicate object keys can be lost by casting before rejection; if
packages do not have exactly eight preallocated current-authority heads, a head
advance changes the count, immutable history consumes head capacity, or package
257 is truncated instead of held for remediation; if a replacement can claim while
`pending` or become eligible outside the atomic source-archive/replacement CAS; or if the release-pinned
aggregate exceeds p95 40 ms or p99 100 ms.
Stop if Step 0 does not install the signer/evidence/transition-authorization/
consumption stores, verifier,
dedicated principals, bootstrap recorder, and disabled enablement state before its
own receipt and S3; if any release receipt lacks a non-null lifecycle-valid Ed25519
signature at recording or the pinned signer/domain/nonce/predecessor
contract; if durable recorded evidence expires or a state transition lacks a
separate exact signed at-most-30-minute unexpired authorization; if the immutable
evidence row, dedicated verifier/transition database
principals, in-transaction Node signature verification under locked signer state,
atomic append-only consumption, or rollback-safe replay semantics; if a general
application role can insert/consume evidence; if distinct receipt IDs/nonces can
duplicate one canonical transition identity; if final readiness does not atomically
consume both enablement and controller-owned `enabled_build_tests_green` receipts
for the enabled build/epoch and exact
preflight/five suites; or if legacy-root scrub dry-run/apply/resume can proceed
without revalidating that exact readiness row.
Stop if enablement is not the one authoritative `disabled|provisional|active`
database-time singleton with exact owner/build/SHA/epoch/expiry/controller login/
run/transition-authorization and token digest plus an at-most-45-second lease; if
the controller does not generate/retain the initial secret before opening, if a
heartbeat caller differs from the authenticated controller login, if PostgreSQL
returns/stores a raw token, or if token rotation is not one digest/generation CAS;
if
an append-only audit disposition becomes gate authority; if any ingress or issuance
path bypasses the overall-deadline and live-lease gate; if final
readiness cannot promote the same unexpired owner to `active`; or if expiry,
controller death beyond 45 seconds, suite/evidence failure, database failure,
inspect, or disable can leave authority open, affect another owner, or lower the
epoch; or if the exact no-retry 660-second enabled-run DAG and 900-second margin are
not enforced and tested.
Stop if process principals can mutate their authority registry or share one
normalized database principal; if epoch-2 process replacement requires lowering or
reusing initial activation; if root-writer replacement cannot adopt/abandon exact
old pins; if all-active-worker loss has no non-worker alert plus maintenance
recovery path; if the fence service trusts W2-supplied election state or any
mechanism other than the selected service-only committed-election view; if Git
object storage/history authority is outside a fenced bounded snapshot; if a
per-run principal slot can be reused without emptiness/cleanup/generation proof; if
generic invocation has no durable pre-I/O intent; if local
review writes the packet action ledger; if an unchanged packet-free owner-loss has
no explicit invocation-dependent generic acknowledgement/retry disposition; if a
no-packet alert requires an audit ID or
cannot record service-authored quiescence closure; if generic lease expiry has no
closed cause; if missing evidence requires a fabricated FK row; if a coherent
operator cannot decline/close recovery; if unsupported hosts can enter epoch 2; or
if a path-specific transaction
uses a shorter lock sequence than the canonical global order.
