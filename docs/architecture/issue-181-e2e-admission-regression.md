# Issue #181 Architecture: End-to-End MCP Admission Regression

Status: architecture proposal
Issue: #181
Parent: #172
Depends on: #177, #178, #179, #180

## Objective

Create a representative, deterministic regression suite for the failure that motivated Epic #172. The suite must exercise the real approval route and handoff pipeline, prove preview/approval/handoff parity, and cover recovery, prompt filtering, issuance evidence, and operator presentation without becoming one brittle monolithic test.

## Test architecture

Use three layers sharing typed fixtures:

1. **Contract invariant matrix** — fast tests over preview, approval evaluator, and broker adapters for fixed package + fixed health.
2. **PostgreSQL integration flows** — real route, lock, grant, recovery, nonce, audit, and artifact behavior.
3. **Thin Playwright operator flow** — only user-visible state and actions that unit/integration tests cannot prove.

Do not put the entire acceptance matrix into Playwright. Do not replace the real approve route with hand-set task states.

## Shared scenario builder

Create a reusable fixture builder, suggested location:

```text
web/__tests__/helpers/mcp-admission-scenarios.ts
```

It must create:

- project and MCP catalog/status state;
- Architect design fence;
- task/work packages;
- requirement keys and requirement-scoped overlays;
- subtask capability bindings;
- package/project grant state;
- captured health snapshot;
- expected canonical decisions and recovery actions.

Scenario IDs should be stable and table-driven. Tests assert public results, not internal helper call counts except where proving no packet/run creation.

## Layer 1: preview == approval == handoff invariant

Create or extend:

```text
web/__tests__/mcp-admission-invariant.test.ts
```

For each scenario, invoke:

- `deriveMcpGrantDecisions`;
- the same approval evaluation function used by the real route;
- `evaluateWorkPackageMcpBroker`.

Normalize only compatibility wrappers and assert equality of:

- requirementKey;
- mode;
- admissionStatus;
- recoveryAction;
- primary decision identity;
- retryable;
- grant phase;
- health observation discriminant and timestamp.

Required matrix:

- all capability classes;
- all four requirement capability fields;
- all three fallback actions;
- deny-wins over optional fallback;
- qualified/unqualified filesystem aliases;
- prototype-key resources;
- operation/resource typos;
- invalid known pairs;
- cross-MCP and unknown delivery;
- grant-only legacy state;
- current keyless raw+derived pairing;
- same-agent/same-MCP requirements with one missing context;
- ambiguous legacy overlay;
- absent health;
- mixed required-covered and optional-uncovered filesystem capabilities;
- multi-MCP subtasks with per-capability requirement bindings;
- warning-only context producing no subtask coverage.

The suite should fail clearly on the first divergent surface and print scenario ID plus canonical tuple.

## Layer 2: tiny task-tracker real route flow

Use a local task-tracker fixture with frontend, QA, docs, and reviewer packages.

### Flow A: prompt-only planning context

- Healthy GitHub safe-read requirement with requirement-scoped overlay.
- No live tool handle.
- Real `POST /api/tasks/[id]/approve` succeeds.
- Handoff advances eligible packages.
- Executable prompt contains only admitted structured instructions.

### Flow B: approval-time filesystem rejection

- Required filesystem read missing or explicitly denied.
- Real approve route returns 409.
- Task state does not flip.
- No agent run, attempt, packet audit, or handoff claim exists.

### Flow C: post-approval loss and recovery

- Approval succeeds while coverage exists.
- Project coverage is narrowed/revoked before handoff.
- Handoff holds package `blocked` before claim with zero attempts and task not failed.
- Operator restores coverage through a real grant endpoint.
- Shared reconciliation moves package to `ready` and re-drives task.

### Flow D: planning-only write

- `filesystem.project.write` remains visible in planning instructions.
- It does not require or issue a read packet.
- It does not activate stale bounded-read approval.

### Flow E: deferred required versus optional

- Required GitHub write: blocked + `revise_plan`.
- Optional + continue fallback: warning + `defer_live_mcp_feature` and approval succeeds.
- Neither produces live MCP tools.
- Adversarial merge-through-`gh` overlay text is absent from executable instructions.

### Flow F: GitHub planning context

- Healthy safe read + materialized overlay: planning-only and allowed.
- Required safe read without its own context: blocked + revise plan.

## Layer 2: grant/reconciliation concurrency

Real PostgreSQL interleavings:

- concurrent disjoint `always_allow` grants preserve union/unrelated config;
- concurrent broker metadata survives reconciliation;
- approval reads fresh locked policy after concurrent mutation;
- task and project endpoints recover identical package set;
- historical grant-blocked failed package compatibility is narrow;
- no lock-order deadlock.

## Layer 2: allow-once issuance and evidence

Tests from #179 must be composed into the product scenario rather than duplicated inconsistently:

- two workers race one decision nonce: at most one claim/packet;
- claim versus reapproval follows lock order;
- stale lease recovery invalidates token and never reopens nonce;
- delayed stale owner cannot begin later governed reads or finalize;
- reapproval rotates nonce;
- success and failure each yield exactly one typed packet metadata artifact;
- post-assembly snapshot is durable before exposure;
- pre-assembly failure is explicit;
- artifact has counts/root/redaction only, no names/paths/content;
- concurrent finalizers respect partial unique index.

Tests must state the actual guarantee: cooperative one-winning-claim and best-effort delivery, not cryptographic recall of bytes or in-flight I/O.

## Prompt/instruction assertions

Parse the structured MCP instruction block rather than substring-searching the whole prompt where possible.

Assert:

- every emitted requirement is tied to an eligible canonical decision;
- whole mixed subtask omitted if one binding is ineligible;
- deferred/unknown/blocked/non-deliverable warning Architect text absent;
- static Forge boundary warning present;
- pure planning-only filesystem write hint present;
- fake system markers and closing fences remain JSON data;
- immutable policy appears after untrusted sections;
- no raw packet content is persisted as artifact.

## Layer 3: Playwright operator flow

Keep this small:

1. Open task with planning, deferred, unhealthy, grant-required, and approved examples.
2. Verify canonical badges/copy/CTA grouping.
3. Approve project context via UI and observe held package recover.
4. Verify retry control absent for revise-plan/deferred blocks.
5. Verify packet metadata summary and no file paths/content.
6. Verify deep link to project MCP remediation and keyboard focus.

Back-end integration tests remain authoritative for concurrency and state transitions.

## Isolation and determinism

- Unique project/task IDs per test.
- Fixed clocks for health/lease timestamps.
- No external provider or network dependency.
- Local ACP fake records submitted prompt but exposes no host tools.
- Database transactions cleaned after each test.
- Queue wakeups captured by deterministic fake/isolated Redis namespace.
- Table-driven matrices may run in parallel only when fixtures are fully isolated.

## Failure diagnostics

On failure print:

- scenario ID;
- canonical package policy fingerprint;
- fixed health snapshot;
- preview tuple;
- approval tuple/HTTP response;
- handoff tuple/status;
- relevant run/audit/artifact IDs.

Never print packet contents, credentials, or raw secret-like overlay text.

## Coverage ownership

- #181 adds no production policy.
- If a scenario requires production behavior not implemented by #177–#180, fix the owning implementation PR/issue rather than adding test-only branches.
- Shared helpers must not reimplement classification or admission.

## Implementation order

1. Build shared scenario builder and invariant matrix.
2. Add real approve-route task-tracker flows.
3. Add grant recovery/concurrency flows.
4. Integrate issuance/evidence race scenarios.
5. Add prompt filtering/injection assertions.
6. Add thin Playwright presentation flow.
7. Add failure diagnostics and CI sharding if needed.

## Completion gate

The Epic regression is complete when one command exercises the contract and integration layers, while normal `npm test`, build, migrations, and Playwright remain green. The suite must fail when any one admission surface is deliberately mutated to disagree.

## Stop conditions

Stop if the test needs hand-setting approval status, external services, packet content persistence, policy reimplementation, or production-only test hooks that bypass route/transaction behavior.
