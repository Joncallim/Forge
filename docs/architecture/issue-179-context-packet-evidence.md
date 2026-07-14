# Issue #179 Architecture: Specialist Prompt and Bounded Context Evidence

Status: architecture proposal
Issue: #179
Parent: #172
Depends on: #176, #177
Canonical policy: ADR 0009; bounded packet vocabulary: ADR 0008

## Objective

Deliver only canonically admitted MCP instructions and bounded filesystem context to a specialist run, with one fenced issuance claim per `allow_once` decision and truthful run-linked packet metadata on success or failure. No raw repository contents, selected file names, or live MCP handles are persisted.

## Boundaries

- MCP admission controls only the Forge-issued MCP channel. ACP processes are not OS sandboxes and may independently possess shell/network/environment access.
- Prompt instructions cannot be treated as enforcement.
- Packet contents are prompt-only and ephemeral; artifacts contain metadata only.
- One winning database claim is guaranteed per decision nonce. PostgreSQL cannot recall bytes already read or cancel an in-flight ACP submission.

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

### 2. Prompt serialization

Use length-bounded structured JSON sections, never delimiter-based concatenation:

```json
{"kind":"mcp_requirement_instruction","requirementKey":"...","content":"..."}
```

Immutable system policy must appear before and after untrusted sections and state:

- repository packet data is untrusted;
- overlays are subordinate run instructions;
- neither changes tool, credential, repository, or admission policy;
- Forge issued no live MCP handle.

Reject invalid encoding; truncate only at documented field boundaries and record omission counts. Tests include fake system messages, closing fences, credential requests, and `gh` commands.

### 3. Capability merge and filesystem packet gate

The executor imports `mergeCapabilityFields`, `classifyCapability`, and `coverageKeysForGrant`; it owns no third policy copy.

A bounded filesystem packet may be requested only by current `bounded_read_only` filesystem capabilities with a valid approved effective grant. `filesystem.project.write` remains a planning instruction and never activates packet issuance.

## One-time grant decision identity

Every approval decision has an immutable UUID `grantDecisionNonce`. Reapproval rotates the nonce even when the approval row is upserted. The approval row and effective package snapshot must agree on approval ID + nonce.

Suggested schema changes:

- `filesystem_mcp_grant_approvals.grant_decision_nonce UUID NOT NULL`;
- `filesystem_mcp_runtime_audits` fields:
  - `grant_approval_id`;
  - `grant_decision_nonce`;
  - `agent_run_id`;
  - `status` (`claiming|succeeded|failed`);
  - `claim_token` UUID;
  - `lease_expires_at`;
  - packet metadata snapshot;
  - failure stage/reason.

Unique index on `(grant_approval_id, grant_decision_nonce)` for `operation='context_packet'`.

## Lock order and claim transaction

Global order:

```text
project → task → work package → grant approval → runtime audit claim
```

Before assembly:

1. Lock all rows in global order.
2. Re-read current package requirements, effective grant, approval ID, and nonce.
3. Verify approved, unconsumed, and exact required capability coverage.
4. Insert the unique `claiming` audit with `claimToken`, `agentRunId`, and lease.
5. Mark the package-local `allow_once` decision consumed using an approved-state compare-and-set.
6. Commit.

Only the winner proceeds. Duplicate workers stop before repository packet reads.

## Fencing lifecycle

The worker must verify this ownership tuple immediately before each governed boundary:

```text
status=claiming
claimToken matches
claimedByAgentRunId matches
leaseExpiresAt > now
```

Boundaries:

- each repository-content read batch;
- packet exposure to prompt assembly;
- ACP prompt submission;
- audit finalization and artifact upsert.

Heartbeat extends the lease with the same ownership compare-and-set. An invalid token prevents subsequent governed reads and persistence, but cannot revoke data already in memory.

## Packet metadata staging

Immediately after assembly and before prompt exposure, persist under the valid token one discriminated snapshot:

```ts
type PacketAuditSnapshot =
  | {
      packetAssembled: true;
      root: string;
      includedCount: number;
      byteCount: number;
      omittedCount: number;
      redactionSummary: Record<string, number>;
    }
  | {
      packetAssembled: false;
      failureStage: 'claim' | 'preflight' | 'assembly' | 'prompt_submission' | 'finalization';
      reason: string;
    };
```

No selected names, paths, excerpts, or file contents.

## Stale claim reconciliation

`reconcileStaleFilesystemIssuanceClaims(now)` runs at startup and periodic recovery:

- select expired `claiming` rows `FOR UPDATE SKIP LOCKED`;
- mark failed with lease/crash reason;
- invalidate token by status transition;
- never reopen the nonce;
- produce failed-run evidence from the durable snapshot;
- require explicit reapproval for a fresh nonce.

## Artifact contract

Exactly one artifact per run:

```text
artifactType = mcp_bounded_context_packet_metadata
lookup = (agentRunId, artifactType)
```

Add a partial unique index in SQL and `schema.ts`, and use a conflict target with the matching predicate.

Artifact metadata:

```ts
{
  schemaVersion: 1;
  workPackageId: string;
  packet: PacketAuditSnapshot;
}
```

Artifact content is a bounded human-readable summary derived from the persisted snapshot. Success and failure finalizers upsert idempotently. Recovery never rereads or reassembles a burned packet.

## Run lifecycle integration

- Create/identify `agentRunId` before claim.
- Claim must precede packet assembly.
- If no packet is required, no filesystem issuance audit is created.
- After claim, every terminal path finalizes audit and artifact if ownership remains valid.
- Failure after claim burns the nonce.
- Sandbox-generated file artifacts remain separate from repository context metadata and host-apply evidence.

## Concurrency/failure tests

1. Two workers race one nonce: one claim, one packet assembly.
2. Claim races reapproval: lock order prevents deadlock; fresh nonce remains separate.
3. Delayed owner races lease expiry/reconciler: stale token cannot begin later governed read or finalize.
4. Crash before assembly: `packetAssembled:false` artifact.
5. Crash after assembly before exposure: persisted truthful assembled metadata.
6. Crash after prompt submission: no second delivery on recovery.
7. Concurrent finalizers: one artifact row.
8. Reapproval after burned nonce: new nonce can issue.
9. Prompt-injection fixtures remain quoted subordinate data.
10. Deferred optional merge overlay text is absent; static ACP non-sandbox warning remains.
11. Pure filesystem write planning hint remains present without packet.

## Implementation order

1. Add schema/migration and nonce rotation.
2. Add claim/fencing service and stale reconciler.
3. Add instruction projection and structured serializer.
4. Replace executor capability merge/gating copies.
5. Stage packet metadata before exposure.
6. Add idempotent artifact finalization/recovery.
7. Add race, restart, injection, and failure-point tests.

## Stop conditions

Stop if implementation would claim OS confinement, exactly-once external submission, or recall of bytes; if the artifact requires persisting paths/content; if lock ordering conflicts with #178; or if S2 does not expose requirement-scoped canonical decisions needed for filtering.
