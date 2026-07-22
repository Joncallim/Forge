# ADR 0006: Executable Workforce Beta Boundary

## Status

Accepted for the #119 executable Workforce beta boundary.

## Context

ADR 0005 created durable Workforce planning records: work packages,
dependencies, harness links, approval gates, VCS summaries, and agent-run
anchors. Issue #119 moved that model from planning into specialist execution.

The risky failure mode is presenting beta output as if Forge committed changes,
granted live MCP tools, ran autonomous reviewers, or prepared a pull request.
The beta needs a clear executable boundary that operators can inspect before
Forge is trusted with commits or PR automation.

## Decision

Forge will allow executable Workforce beta runs in sandbox-only mode. Generated
files remain reviewable without giving the beta a direct host repository write
path.

### Execution Boundary

- Work-package materialization, handoff, and model execution are enabled by
  default. Host repository writes are unavailable.
- `FORGE_WORK_PACKAGE_EXECUTION=0`, `false`, `off`, `no`, or `disabled`
  disables model execution and keeps the handoff-artifact-only path.
- Leaving `FORGE_HOST_REPOSITORY_WRITES` unset, or setting it to `0`, `false`,
  `off`, `no`, or `disabled`, lets package models run successfully in
  sandbox-only mode.
- Setting `FORGE_HOST_REPOSITORY_WRITES` to an enable value such as `1` or
  `true` fails closed. The legacy `FORGE_REPOSITORY_EDITS` alias follows the
  same rule. Forge preserves generated sandbox files but does not report them
  as applied to the host repository.
- ACP-backed work-package execution is enabled after an operator configures an
  ACP provider and approves the task. ACP adapters are local processes and are
  not OS-confined by Forge. Set `FORGE_ACP_WORK_PACKAGE_EXECUTION=0`, `false`,
  `off`, `no`, or `disabled` to prevent ACP package execution.
- After Architect plan approval, Forge may execute one eligible specialist work
  package at a time. Parallel specialist execution remains out of scope.
- Forge may collect bounded read-only host-repository context before a package
  runs. That context is limited to inspectable evidence such as a bounded file
  list, selected source/context artifacts, git status evidence, previous run
  artifacts, package inputs, acceptance criteria, and review feedback. It must
  not give the specialist an unbounded filesystem view.
- Generated output is first written under the validated project root at
  `.forge/task-runs/<task-id>/<work-package-id>/attempt-<attempt-number>/`.
- Generated output remains under `.forge/task-runs` for operator review and
  manual application. Direct host application will remain unavailable until a
  later, security-reviewed slice provides an operating-system-enforced project
  boundary or hardened repository-write adapter.
- File writes must use relative paths. Absolute paths, path traversal, `.git`,
  `.forge`, `node_modules`, symlink targets, and local conflict-copy names are
  outside the beta boundary.
- Package validation requests are limited to the approved validation surface,
  currently `npm test`, `npm run build`, and `npm run lint`. In the beta,
  Forge performs static validation for those command labels against generated
  sandbox output; it does not run arbitrary package scripts.
- Repository evidence commands are limited to read-only Git status/diff
  evidence, redacted, bounded, and audited. Host package-manager validation is
  blocked in repository evidence; package validation remains inside the sandbox.

### Review Gates

QA, Reviewer, and Security gates are manual approval gates in this beta. They
are not autonomous agent-run gates unless a later slice explicitly materializes
and executes those reviewer agents.

The operator can approve a gate or send the package to rework. Reviewer approval
cannot bypass a required QA gate. Review decisions are tied to the source run
and source artifact under review; stale gates must be replaced or blocked when a
newer package attempt produces new artifacts.

High-risk work requires a `security_review` gate. High-risk surfaces include
auth, secrets, filesystem writes, command execution, MCP/tool grants, GitHub
writes, repository-write paths, prompt-injection exposure, merge automation, and
data/privacy-sensitive artifacts.

Security review output must be structured enough to support rework. Findings
should include:

- review surface,
- affected asset,
- trust boundary,
- exploit path,
- impact,
- required fix,
- evidence references,
- severity,
- confidence,
- verification state.

Structured findings may be stored as `review_finding` artifacts or gate
metadata, but the beta must not treat a bare security checkbox as sufficient for
high-risk output.

### Grant Terminology

Forge uses separate words for each grant stage:

- **Proposed grant**: an Architect-authored MCP/tool request in the plan,
  including target agents, capabilities, requirement level, fallback, and
  prompt overlays.
- **Broker decision**: Forge's admission-time evaluation of that proposal
  against the known MCP catalog, safe beta capability allowlist, project MCP
  health, fallback policy, and package-local instructions. Broker outcomes are
  allowed, warning-only, or blocked.
- **Approved grant**: an operator-accepted capability snapshot for this beta
  run. Approval records that a package may continue under the brokered
  decision; it does not issue live MCP tools.
- **Effective grant**: the final run-scoped instructions actually included in
  the specialist package prompt, such as prompt overlays, MCP-aware subtasks,
  approved capability names, fallback instructions, and blocked reasons.

For #119, runtime MCP enforcement remains `not_implemented`. Specialists do not
receive live MCP handles, credentials, or external tool grants. User-edited
grants are deferred; the UI may show proposed, brokered, approved, and
effective grant state, but operators cannot rewrite grant scopes as a supported
beta workflow.

### Harness Semantics

`agent_harnesses` are planning and routing metadata for this beta. They can
describe a role, prompt overlay, reference paths, tool policy, output schema, or
validation intent, but they are not authoritative execution-policy objects yet.

Execution may use active agent configuration and package-scoped prompt
instructions. Harness fields do not themselves grant tools, enforce reference
path access, validate output schemas, or override the sandbox command policy.

### Explicit Deferrals

The executable Workforce beta explicitly defers:

- live MCP tool issuance or runtime MCP grants,
- branch creation, commits, check polling, pull requests, merges, issue
  closure, or release automation,
- parallel specialist execution,
- user-edited grant scopes,
- autonomous QA, Reviewer, or Security agent-run gates,
- harness-enforced execution policy,
- direct host repository writes,
- remote repository writes.

## Consequences

Operators can review generated sandbox files, static validation results,
repository evidence, proposed and brokered grants, blocked reasons, prompt
overlays, review gates, rework reasons, and structured security findings before
manually applying useful output.

The cost is extra terminology and a stricter product boundary. That cost is
intentional: Forge should prove sequential execution and manual review before
commit, pull-request, or merge automation is added.
