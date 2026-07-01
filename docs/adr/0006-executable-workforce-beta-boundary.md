# ADR 0006: Executable Workforce Beta Boundary

## Status

Accepted for the #119 executable Workforce beta boundary.

## Context

ADR 0005 created durable Workforce planning records: work packages,
dependencies, harness links, approval gates, VCS summaries, and agent-run
anchors. Issue #119 moves that model from planning into opt-in specialist
execution.

The risky failure mode is presenting beta output as if Forge edited the host
repository, granted live MCP tools, ran autonomous reviewers, or prepared a pull
request. The beta needs a clear executable boundary that operators can inspect
before Forge is trusted with repository writes or PR automation.

## Decision

Forge will allow executable Workforce beta runs only inside an opt-in,
sandbox-only boundary.

### Execution Boundary

- Work-package materialization and handoff may be enabled by default, but model
  execution stays disabled unless `FORGE_WORK_PACKAGE_EXECUTION=1` or `true` is
  set.
- After Architect plan approval, Forge may execute one eligible specialist work
  package at a time. Parallel specialist execution remains out of scope.
- Forge may collect bounded read-only host-repository context before a package
  runs. That context is limited to inspectable evidence such as a bounded file
  list, selected source/context artifacts, git status evidence, previous run
  artifacts, package inputs, acceptance criteria, and review feedback. It must
  not give the specialist an unbounded filesystem view.
- Generated output is written only under the validated project root at
  `.forge/task-runs/<task-id>/<work-package-id>/attempt-<attempt-number>/`.
- Package output is treated as sandbox artifacts. It is not a host-repository
  edit, branch, commit, pull request, merge, or issue update.
- File writes must use relative paths inside the package sandbox. Absolute
  paths, path traversal, `.git`, `node_modules`, symlink targets, and local
  conflict-copy names are outside the beta boundary.
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
- host-repository writes outside `.forge/task-runs`,
- applying sandbox output back into the project tree,
- branch creation, commits, check polling, pull requests, merges, issue
  closure, or release automation,
- parallel specialist execution,
- user-edited grant scopes,
- autonomous QA, Reviewer, or Security agent-run gates,
- harness-enforced execution policy,
- default-on package execution.

## Consequences

Operators can review generated sandbox files, static validation results, repository
evidence, proposed and brokered grants, blocked reasons, prompt overlays,
review gates, rework reasons, and structured security findings before deciding
whether output is useful.

The cost is extra terminology and a stricter product boundary. That cost is
intentional: Forge should prove sequential sandbox execution and manual review
before repository writes or pull-request automation are added.
