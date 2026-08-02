# Issue #179 Historical Architecture Review Amendments

Status: superseded review record.

All binding corrections from this record and the later integrated security/concurrency review are folded into `issue-179-context-packet-evidence.md`. The primary document is authoritative. This file remains only to preserve review history and must not be implemented as a separate or higher-precedence contract.

## Review round 1 findings and resolutions

### 1. Legacy approvals need an explicit nonce migration rule

Existing approval rows may predate `grantDecisionNonce`. They must not be assigned a synthetic issuable nonce during read or migration because that would create a new disclosure decision without operator action.

Required compatibility behavior:

- existing project-level `always_allow` grants remain reusable according to their current semantics and do not require a one-time nonce;
- legacy package-local `allow_once` approvals without a nonce are treated as non-issuable/consumed and require explicit reapproval;
- explicit reapproval rotates a fresh nonce and records the operator/time;
- migration may add a nullable column first, with new writes requiring non-null nonce for `allow_once`;
- readers fail closed when `allow_once` lacks a nonce.

### 2. Agent-run identity and claim ownership must be atomic

The initial proposal said to create or identify `agentRunId` before claim but did not define orphan prevention. The claim transaction must either:

1. create the `agent_runs` row and issuance claim in one transaction after package execution claim succeeds; or
2. reserve an agent-run row in the same transaction with a non-executing `claiming` state that is finalized/failed with the issuance claim.

No committed runnable agent run may exist without a successful issuance claim when a packet is required. A losing worker must not leave an orphan run or attempt.

### 3. Decision nonce is separate from runtime claim token

- `grantDecisionNonce` identifies the operator's issuable approval decision and survives worker retries only until it is claimed/burned;
- `claimToken` identifies one cooperative worker lease and is rotated only by a new claim on a new nonce;
- neither value is accepted from the model or prompt;
- audit/artifact correlation stores both but operator UI may show only bounded identifiers.

### 4. Partial unique indexes need exact migration and writer parity

The architecture requires two distinct uniqueness guarantees:

- one issuance audit per `(grantApprovalId, grantDecisionNonce)` for context-packet operation;
- one packet metadata artifact per `(agentRunId, artifactType)` for the specified artifact type.

The SQL migration, Drizzle schema declaration, and `ON CONFLICT ... WHERE` predicate must be byte-for-byte semantically aligned. Add a migration/schema parity test or introspection assertion where the repo supports it.

### 5. Lease duration and heartbeat policy must be bounded

Define configuration with validated minimum/maximum values and a heartbeat interval strictly below lease duration. A worker must not extend a lease after ownership loss. Clock-skew assumptions are database-time based where possible; use PostgreSQL `now()` for claim/expiry comparisons rather than worker wall clocks.

### 6. Packet metadata staging must precede all exposure paths

Exposure includes:

- adding packet data to prompt buffers;
- logging/debug rendering;
- ACP request construction;
- artifact rendering that could reread packet state.

The staged metadata snapshot is persisted under the fencing token immediately after assembly and before any of these paths. Debug logs never contain packet contents or selected paths.

### 7. Reconciliation ownership must not conflict with #178

The shared global order is:

```text
project → task(s ascending) → package(s ascending) → grant approval → runtime audit claim
```

#178 grant mutations may rotate a nonce only after project/task/package locks. #179 claim code must never take an audit/approval lock and then reach backward for package/task/project.

## Historical round 2 conclusion

At that review point, the amendments handled legacy approvals without manufacturing authority, tied run creation to claim ownership, separated decision and lease identities, and aligned migrations with conflict writers. A later integrated review found additional cross-slice lease, recovery, evidence-atomicity, path-leakage, and rollout gaps. Their corrections now live in the authoritative primary document.
