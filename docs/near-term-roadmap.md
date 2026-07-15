# FORGE Near-Term Execution Roadmap

Last updated: 2026-07-15

This document is the **execution-order view** of the FORGE roadmap. The broader product direction remains in [`docs/roadmap.md`](roadmap.md); this page answers a narrower question:

> What should FORGE finish next, and what evidence is required before moving on?

## Guiding Rule

FORGE should expand autonomy only after the current execution path is deterministic, observable, independently verifiable, and recoverable.

The near-term sequence is therefore:

```text
Finish MCP admission
  -> test the complete operator path
  -> fix observed bugs
  -> add typed deterministic operations
  -> normalize outcomes
  -> build reliability and earned autonomy
  -> resume broader Workspace expansion
```

## 1. Finish And Prove MCP Admission — Epic #172

Complete the remaining implementation and regression slices under [Epic #172](https://github.com/Joncallim/Forge/issues/172).

The operator path must demonstrate one canonical decision across:

- planning preview;
- operator approval;
- effective grant state;
- handoff admission;
- context issuance;
- recovery and revocation;
- operator-facing copy and remediation.

### Exit criteria

- Preview, approval, handoff, and recovery cannot disagree about the same MCP requirement.
- Unknown or unsafe capabilities fail closed.
- Required denied/revoked grants hold work before execution rather than consuming attempts.
- Bounded context is issued once, linked to the run, and does not leak file contents or live handles into metadata.
- Recovery and concurrent approval/issuance paths have deterministic regression coverage.
- A complete operator flow works against real PostgreSQL state.

## 2. Run Focused End-To-End And Failure Testing

After #172 lands, pause broad architecture expansion and test FORGE as a release candidate.

Test at least:

- clean install and first task;
- local and GitHub-backed projects;
- provider/ACP readiness and refusal paths;
- plan approval and revision;
- work-package execution and generated-file application;
- MCP grant approval, denial, revocation, and recovery;
- retry exhaustion and dead-letter recovery;
- QA, Reviewer, and Security gates;
- GitHub issue, dispatch, handoff, and PR-contract workflows;
- stale, malformed, missing, and contradictory evidence.

### Exit criteria

- Every observed stop has a clear operator-facing reason and recovery path.
- No workflow silently reports success after refusal, blocking, validation failure, or missing evidence.
- Duplicate execution, issuance, comments, artifacts, and state transitions are prevented or safely idempotent.
- Testing produces reproducible Bug issues with evidence rather than speculative fixes.

## 3. Fix Bugs And Harden The Release Path

Prioritize bugs discovered by real use over new platform breadth.

Fix in this order:

1. state corruption, unsafe execution, or policy bypass;
2. false-success and missing-evidence defects;
3. recovery, concurrency, and idempotency defects;
4. operator-blocking UX and unclear remediation;
5. performance and visual polish.

### Exit criteria

- Critical and high-severity bugs from the focused test cycle are closed or explicitly accepted with mitigations.
- The full release gate passes:

```bash
git diff --check
npm run lint
npx tsc --noEmit --pretty false
npm test
npm run build
```

- A documented smoke path succeeds twice from a clean or repaired environment.

## 4. Add The Deterministic Operation Catalog — Issue #201

Implement [#201 — deterministic operation catalog and typed execution harness](https://github.com/Joncallim/Forge/issues/201).

The governing rule is:

```text
Model selects an approved typed operation
  -> FORGE validates inputs, scope, and capability
  -> a deterministic adapter performs the action
  -> verification checks the result
  -> evidence and a canonical outcome are recorded
```

Models should not gain broad command authority merely because they can generate shell text.

### Initial scope

Start with a small catalog around existing low-risk FORGE behaviour:

- run an approved validation command;
- read a bounded repository context packet;
- apply a validated generated file set to an approved project root;
- retry an eligible blocked handoff;
- perform a supported GitHub mutation through the existing adapter;
- request an MCP health check.

### Exit criteria

- Agents request an operation id and typed inputs rather than executable free text.
- Unknown, unsafe, out-of-scope, or malformed inputs fail before side effects.
- Operations use typed adapters and argv/action construction rather than interpolated shell strings.
- Each run records operation version, policy decision, phase evidence, verification, and outcome.
- At least three existing FORGE behaviours are wrapped without weakening their current safety boundaries.

## 5. Normalize Outcomes — Issue #185

Implement [#185 — canonical execution outcomes and stop reasons](https://github.com/Joncallim/Forge/issues/185).

This creates the common evidence language required by reliability, Sentinel, verification goals, and autonomy.

### Exit criteria

FORGE can distinguish at least:

- transport error;
- completed;
- partial;
- refused;
- blocked;
- needs attention;
- validation failure;
- timeout or limit exhaustion;
- failed;
- cancelled.

Every outcome must include stable reason codes, retryability, evidence references, and verification state without replacing existing task, package, run, or artifact truth.

## 6. Continue Epic #184 In Evidence Order

After #201 and #185 are stable, continue [Epic #184](https://github.com/Joncallim/Forge/issues/184) in this order:

1. [#186 — capability reliability ledger](https://github.com/Joncallim/Forge/issues/186)
2. [#187 — project verification goals and scheduled proof runs](https://github.com/Joncallim/Forge/issues/187)
3. [#188 — independent Verification Workforce execution](https://github.com/Joncallim/Forge/issues/188)
4. [#189 — evidence-based earned autonomy policy engine](https://github.com/Joncallim/Forge/issues/189)
5. [#190 — Project Sentinel detection and escalation](https://github.com/Joncallim/Forge/issues/190)
6. [#191 — reliability, autonomy, and regression reporting](https://github.com/Joncallim/Forge/issues/191)

### Promotion rule

No autonomy promotion should occur until the relevant operation:

- has a stable versioned definition;
- has comparable canonical outcomes;
- has independent verification where required;
- meets minimum sample and recency requirements;
- has no unresolved critical failures or policy violations;
- remains below human, MCP, repository, and security ceilings.

## 7. Defer Broad Forge Workspace Expansion

Forge Workspace remains a valuable product direction, but broad pane and integration work should not outrun execution trust.

Resume major Workspace expansion after:

- MCP admission is proven;
- the focused test cycle is complete;
- high-priority bugs are resolved;
- typed operations and canonical outcomes exist;
- the first reliability evidence can be inspected.

Small usability improvements that directly support testing, evidence inspection, and recovery may continue. Large new surfaces, broad integrations, and general autonomous-operation UI should wait.

## Decision Filter For New Work

Before adding a new Epic or large Feature, ask:

1. Does it fix a defect or unblock the current operator path?
2. Does it make execution more deterministic, observable, verifiable, or recoverable?
3. Does it reuse existing task, work-package, run, artifact, and policy truth?
4. Can its success be demonstrated with objective evidence?
5. Would delaying it reduce risk or complexity without blocking current testing?

If the answer to the last question is yes, defer it.
