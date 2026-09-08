# GitHub-Native Agent Workflow — Implementation Architecture

This is the **implementation architecture map** for Epic
[#141](https://github.com/Joncallim/Forge/issues/141), not the end-user operating
guide. The plain-English workflow guide is owned by
[#147](https://github.com/Joncallim/Forge/issues/147).

Its job is to show how the implemented features
(#142, #143, #144, #145, #146, #152, #153, #354) build on **one** set of
contracts, one status model, one readiness resolver, and one file layout —
instead of each feature inventing its own.

All workflow code lives under `web/scripts/github-agent-workflow/`.

## What has landed

| Issue | Feature | Where |
| --- | --- | --- |
| #142 | Issue intake structural validation | `core/issue-validation.ts`, `shared/issue-validation-runner.ts`, `.github/workflows/issue-intake.yml` |
| #143 | Issue-comment agent command router | `core/agent-command.ts`, `agent-command.ts`, `.github/workflows/agent-command.yml` |
| #146 | Durable agent run log | `io/agent-run-log.ts`, `contracts/agent-run-record.ts`, [`docs/github-agent-run-log.md`](./github-agent-run-log.md) |
| #152 | Agent PR creation contract + PR body template | `.github/pull_request_template.md`, [`docs/github-agent-pr-contract.md`](./github-agent-pr-contract.md) |
| #144 | Safe agent dispatch / bounded work-order generation | `dispatch.ts` (`forge:dispatch`), `.github/workflows/agent-dispatch.yml` |
| #153 | Controlled Claude Code / Codex handoff adapter | `handoff.ts` (`forge:handoff`), `.github/workflows/agent-handoff.yml` |
| #145 | PR acceptance-criteria contract checker | `pr-contract.ts` (`forge:pr-contract`), `.github/workflows/pr-contract-check.yml` |
| #354 | Dependency-aware readiness + tracking isolation | See readiness architecture below |

The run log at `.forge/runs/<issue-number>/<run-id>.json` is the **source of
truth for workflow state**. Everything below reads and writes that record; it
does not add a second status store.

## Readiness Architecture (#354)

### Central invariant

**Semantic readiness from the shared resolver is authority. Labels are
projections only.**

`ready-for-agent` is a cache of the computed readiness state, never an
authoritative gate. Command admission, dispatch admission, handoff admission,
and the pre-runtime readiness check all re-resolve current semantic truth from
the shared resolver. A stale, missing, or manually spoofed label cannot grant
authority.

### Readiness concepts

Forge distinguishes these concepts permanently:

| Concept | Definition | Authority |
| --- | --- | --- |
| **Structural validity** | Does the issue satisfy the Feature/Bug/Other/Epic template contract? | Pure deterministic check, no I/O |
| **Control metadata validity** | Is `Execution mode` / `Depends on` present, unambiguous, and safe? | Pure parser via visible-Markdown scanner |
| **Semantic readiness** | Is this issue actually dispatchable *now* after resolving current GitHub state? | Shared resolver (`IssueReadinessResolver`) |
| **Projection** | Labels/comments that expose semantic readiness to humans | Never authority |

### Readiness states and labels

| Semantic state | Required projection | Dispatchable |
| --- | --- | --- |
| `ready` | `ready-for-agent` | Yes |
| `needs-clarification` | `needs-clarification` | No |
| `dependency-blocked` | `dependency-blocked` | No |
| `tracking-only` | `tracking-only` | No |
| `closed` | (none) | No |

Readiness labels are mutually exclusive. `needs-triage` and all `agent-*` labels
remain outside the readiness projection set.

### Canonical control metadata

Issues use the following visible metadata lines:

```
Execution mode: implementation
Depends on: none
```

or with dependencies:

```
Execution mode: implementation
Depends on: #123, #456
```

Tracking issues use:

```
Execution mode: tracking
Depends on: none
```

Supported execution modes are exactly `implementation | tracking`. Dependencies
are same-repository positive GitHub issue numbers only. The `Depends on` value
`none` cannot be mixed with references.

### Stable readiness reason codes

All readiness decisions use typed `queue.*` reason codes (see
`contracts/issue-readiness-result.ts`). Machine consumers use these codes, not
human-readable prose.

### One shared resolver

`shared/issue-readiness-resolver.ts` is the single I/O service that computes
semantic readiness from current GitHub truth. It is used by:

1. **Intake projection** — `shared/issue-validation-runner.ts` syncs labels
2. **Agent command** — `core/agent-command.ts` before accepting a request
3. **Dispatch** — `dispatch.ts` before handing off a work order
4. **Handoff** — `handoff.ts` before generating a runtime package
5. **Pre-runtime CLI** — `cli/check-readiness.ts` (read-only, exit 0 only when dispatchable)

The resolver owns:
- Fresh target issue/dependency resolution via `GitHubClient`
- Repository snapshot for reconciliation runs
- Graph limits (MAX_DEPENDENCIES_PER_ISSUE=64, MAX_GRAPH_DEPTH=64,
  MAX_GRAPH_NODES=512, MAX_OPEN_ISSUES_SCAN=5000)
- Cycle detection via `core/dependency-graph.ts`
- Stable fail-closed result generation

### Visible-Markdown scanner

`core/visible-markdown-scanner.ts` is a bounded O(n) scanner used by both
section detection and control-metadata parsing. It ignores:
- Fenced code blocks (``` and ~~~ with 3+ fence characters)
- Indented code blocks (4+ spaces or tab)
- Blockquotes
- Multi-line HTML comments

No arbitrary text from an issue can mint authority or execute code. No model
or provider call occurs anywhere in readiness evaluation.

### Dependency semantics

| Observed dependency | Result |
| --- | --- |
| Open / reopened issue | `dependency-blocked` |
| Closed with `state_reason=completed` | Satisfied |
| Closed `not_planned` / `duplicate` | Terminal unsatisfied; author must replace/remove |
| Closed but missing/unknown reason | Fail closed (`state_unknown`) |
| Dependency is a pull request | Invalid contract |
| Dependency not found (404) | Invalid contract |
| Permission/API error | Fail closed (`inaccessible` / `lookup_failed`) |
| Self-dependency | Invalid contract |
| Cycle participation | Invalid contract |

### Run-log authority over labels

The durable run log (`#146`) is the single workflow-state truth. `agent-requested`,
`agent-running`, `agent-blocked`, and `agent-pr-opened` remain useful UX
projections but command/dispatch/handoff must not use them to override
contradictory durable run-log state.

Run admission rules:
- `requested`, `handed-off`, `running`, `pr-opened` latest runs block a new
  implementation request
- `blocked` permits a new explicit request only after fresh semantic readiness
- `completed`, `failed`, `cancelled` permit a new explicit request subject to
  fresh readiness
- If latest-run state cannot be loaded/validated, fail closed

### Event / Convergence design

| Event | Action | Actor gate |
| --- | --- | --- |
| `labeled` | Target-only readiness self-heal | None |
| `unlabeled` | Target-only readiness self-heal | None |
| `opened` | Target-only + full reconcile if trusted | write/maintain/admin |
| `edited` | Target-only + full reconcile if trusted | write/maintain/admin |
| `closed` | Target-only + full reconcile if trusted | write/maintain/admin |
| `reopened` | Target-only + full reconcile if trusted | write/maintain/admin |
| `workflow_dispatch` (reconcile) | Full repository reconciliation | Always permitted |

Full reconciliation uses plan → validate → apply phases. No bulk mutations
are performed from an incomplete snapshot.

## Workflow states

There is exactly one status enum: `RUN_STATUS_VALUES` in `contracts/common.ts`.

| Status | Meaning |
| --- | --- |
| `requested` | Command router (#143) accepted a request and wrote a run record. |
| `handed-off` | Dispatcher (#144) produced a bounded work order / handoff package, but **no runtime has started**. |
| `running` | A real runtime adapter has started work. |
| `blocked` | The workflow refused to proceed; a `blockedReason` is recorded. |
| `pr-opened` | Reserved for a future step that links a pull request to the run. |
| `completed` | The work is done. |
| `failed` | The workflow failed. |
| `cancelled` | The workflow was explicitly stopped. |

### `handed-off` vs #144's `accepted`

Issue #144's text describes the dispatch state machine with an `accepted` state.
The run-log contract already ships `handed-off`, which carries the same meaning:
*dispatch prepared a bounded work item, nothing has executed yet.* Rather than
adding a duplicate status, #144 maps its vocabulary onto the run log through
`DISPATCH_STATE_TO_RUN_STATUS` in `contracts/common.ts`:

```
requested  -> requested
accepted   -> handed-off
running    -> running
blocked    -> blocked
pr-opened  -> pr-opened
completed  -> completed
failed     -> failed
```

This is a deliberate decision to keep the run log as the single status model
(minimal change, no parallel enum). `cancelled` has no #144 equivalent and is
reserved for an explicit stop.

## Shared contracts (`contracts/`)

Feature runners must import these, not re-derive them.

| Contract file | Owns |
| --- | --- |
| `common.ts` | Primitives: run id, run status + dispatch-state mapping, runtime, action, PR criterion status, source ref, handoff-artifacts shape. Also defines `ISSUE_READINESS_MANAGED_LABELS` and full label name list including `dependency-blocked` and `tracking-only`. |
| `issue-control-metadata.ts` | Canonical execution mode + dependency schemas, `MAX_DEPENDENCIES_PER_ISSUE`, `MAX_ISSUE_BODY_BYTES`. |
| `issue-readiness-result.ts` | Shared readiness result contract, 21 stable `queue.*` reason codes, semantic state/label mapping. |
| `agent-run-record.ts` | The durable run record schema (#146). |
| `dispatch-request.ts` | The dispatch request shape (#144); its `branchName` is an `agentBranchNameSchema`. |
| `branch-name.ts` | `AGENT_BRANCH_NAME_PATTERN` + `agentBranchNameSchema` (`agent/issue-<n>[-slug]`). |
| `work-order.ts` | `WORK_ORDER_SECTION_TITLES`, bounds, and `workOrderSchema` — the bounded prompt shape (#144/#153). |
| `pr-contract-report.ts` | The PR contract report shape (#145). |
| `pr-contract-sections.ts` | `PR_CONTRACT_SECTION_TITLES`, `ISSUE_LINK_KEYWORDS`, acceptance-criteria section key (#152/#145). |
| `source-issue-reference.ts` | The `{ issueNumber, keyword, raw }` link a PR uses to point back at its issue (#145/#152). |
| `runtime-handoff.ts` | The runtime handoff manifest shape (#153). |
| `agent-command.ts`, `issue-validation-result.ts` | Landed feature contracts (#143/#142). |

> Naming note: `dispatch-request.ts`, `pr-contract-report.ts`, and
> `runtime-handoff.ts` keep their descriptive names (rather than the shorter
> `dispatch.ts` / `pr-contract.ts` / `handoff.ts` sketched in the Epic) so imports
> stay stable and the file name says what shape it holds.

## Shared behaviour (`core/`)

Pure functions and constants. **No GitHub calls, no run-log writes, no runtime
execution** — those side effects belong to the feature CLIs.

| Module | Provides | Consumed by |
| --- | --- | --- |
| `visible-markdown-scanner.ts` | Bounded O(n) scanner ignoring fenced/indented/blockquoted/HTML-commented content | `sections.ts`, `issue-control.ts` |
| `issue-control.ts` | `parseControlMetadata` — canonical `Execution mode:` / `Depends on:` parser | `issue-readiness-resolver.ts` |
| `issue-readiness.ts` | `evaluateReadiness` — pure classification from pre-resolved inputs | `issue-readiness-resolver.ts` |
| `dependency-graph.ts` | `detectCycle`, `buildReverseIndex`, `getTransitiveDependencies` with bounded traversal | `issue-readiness-resolver.ts` |
| `branch-names.ts` | `buildAgentBranchName` — deterministic, git-ref-safe. | #144, #153 |
| `work-order.ts` | `buildWorkOrder` / `renderWorkOrder` — canonical, bounded sections. | #144, #153 |
| `acceptance-criteria.ts` | `extractAcceptanceCriteria` — one checklist parser, reusing `core/sections.ts`. | #144, #145 |
| `pr-contract.ts` | `extractSourceIssueReference` + PR section titles. | #145, #152 |
| `handoff.ts` | `buildHandoffArtifacts` — predictable artifact paths in the existing `handoffArtifacts` shape. | #153 |
| `workflow-architecture.ts` | Ownership map + contract pointers for workflow docs and tests. | docs |
| `agent-command.ts`, `issue-validation.ts`, `sections.ts`, `labels.ts` | Landed behaviour. | #142/#143 |

## I/O and CLI

- `io/github-client.ts` — `fetch`-based GitHub client (no Octokit) + `GitHubClient` interface.
  Extended with `stateReason`, `updatedAt` on `GitHubIssue`, and `listOpenIssues()`.
- `io/fake-github-client.ts` — in-memory test double.
- `io/agent-run-log.ts` — the durable run log and its git-persistence path (#146).
- `io/event.ts` — reads `GITHUB_EVENT_PATH`.
- `cli/entrypoint.ts` — `runMain` (only executes when run directly).
- `cli/bootstrap-labels.ts` — creates the workflow labels including `dependency-blocked`
  and `tracking-only`.
- `cli/check-readiness.ts` — read-only preflight CLI, exit 0 only when `dispatchable=true`.
- `cli/reconcile-readiness.ts` — full reconciliation CLI with plan → validate → apply phases.
- Root CLIs (`agent-command.ts`, `dispatch.ts`, `pr-contract.ts`, `handoff.ts`,
  `validate-issue.ts`) — thin wiring; `forge:*` npm scripts point here.

## Run-log branch sync strategy

Run records are committed to the dedicated `forge/agent-run-log` branch, but
GitHub Actions must keep executing trusted default-branch code. The workflow
must not check out `forge/agent-run-log` as the job code directory and then run
scripts from it.

The safe pattern is:

1. Check out the repository default branch in the normal workspace.
2. Install dependencies and run Forge scripts from that trusted checkout.
3. Use `withRunLogBranchWorktree` from `io/agent-run-log.ts` to create a
   temporary worktree for `forge/agent-run-log`.
4. Read or update `.forge/runs/<issue>/<run-id>.json` inside that temporary
   worktree.
5. Persist only the JSON run record with `persistRunRecordToGit`.
6. Remove the temporary worktree.

This means the job can read and update the run-log branch while the executable
code path still comes from the default branch. The temporary worktree is data
access only; workflows must not run package scripts, shell commands from the
run-log checkout, or generated prompt files from it.

## Handoff artifact persistence

Handoff artifacts are generated under:

```text
.forge/runs/<issue-number>/<run-id>/handoff.md
.forge/runs/<issue-number>/<run-id>/prompt.md
.forge/runs/<issue-number>/<run-id>/metadata.json
```

That nested directory is intentionally git-ignored. Only the sibling run record
`.forge/runs/<issue-number>/<run-id>.json` is committed to the run-log branch.

When handoff runs in GitHub Actions, `.github/workflows/agent-handoff.yml`
uploads the nested directory as a workflow artifact. When handoff runs locally,
the CLI prints the local paths. In both cases Forge records only the artifact
paths in the durable run log.

Do not commit `handoff.md`, `prompt.md`, `metadata.json`, secrets, credentials,
model transcripts, or local auth material to the repository.

## Why dispatch is explicit, not automatic

FORGE never runs a coding agent on every new issue. The workflow requires
multiple gates before any runtime could start:

1. **Structural validity** — intake validation (#142) verifies the template.
2. **Control metadata** — `Execution mode` and `Depends on` must be present.
3. **Semantic readiness** — the shared resolver verifies dependencies are
   satisfied and the issue is dispatchable.
4. **Explicit request** — a maintainer with write access must comment a supported
   command (#143), which writes the `requested` run record.
5. **Permission check** — collaborator permission is verified before expensive
   semantic traversal.

Dispatch (#144) then only produces a **bounded work order** and moves the run to
`handed-off`. It does not execute Claude Code or Codex. This avoids an
unconstrained always-on bot and keeps every step traceable in the run log.

Dispatch is manual in GitHub Actions. The command router applies
`agent-requested` with the default `GITHUB_TOKEN`, and GitHub does not start new
workflow runs from events created by that token. A future GitHub App or personal
access token integration could make label-driven dispatch possible, but that is
outside this slice.

## Rollback safety

If the readiness resolver has a production incident, the correct response is to
**fail closed** — disable the agent admission workflows (agent-command, dispatch,
handoff) first, then repair or revert. Emergency rollback MUST NOT restore the
old condition `template-valid -> ready-for-agent` while agent
command/dispatch/handoff remain active.

## How #152, #144, #153, #145, and #354 fit together

```
#354  Readiness authority ──────►  shared resolver guards every admission gate
                                    │
#152  PR body contract  ─┐        │ (defines the sections agents must write
                         │        │  and #145 parses)
                         ▼        ▼
#144  dispatch  ─────────┼────►  work order (bounded prompt + branch name +
                         │        run record: handed-off)
                         │
#153  handoff   ─────────┼────►  runtime artifacts under .forge/runs/<issue>/<run-id>/
                         │        (prompt embeds the #152 PR contract;
                         │         run log records paths)
                         │
#145  PR checker ────────┘  reads the #152 sections + source-issue acceptance
                            criteria, reports claimed / missing / needs-review
                            per criterion.
```

- **#354** establishes the readiness authority that all downstream gates use.
  It adds the shared resolver, pure readiness evaluator, visible-Markdown
  scanner, control-metadata parser, and dependency-graph cycle detection.
- **#152 comes first (or alongside #145)** because it defines the predictable PR
  body structure both #144/#153 instruct agents to produce and #145 parses.
- **#144** turns a `requested` run into a bounded work order and moves it to
  `handed-off`.
- **#153** consumes the #144 work order and emits runtime-specific handoff
  artifacts.
- **#145** consumes the #152 PR sections and the source issue's acceptance
  criteria to produce a review aid.

## Where future runtime execution plugs in

Everything above stops at **artifact generation**. The point where a real runtime
would start is a single, isolated boundary:

- The run status crosses from `handed-off` to `running`.
- Before crossing, the runtime adapter MUST invoke the same shared readiness
  resolver (`cli/check-readiness.ts`) and must not trust a stored handoff
  snapshot.
- A runtime adapter (`dry-run` | `claude-code` | `codex`, per
  `AGENT_RUNTIME_VALUES`) consumes the #153 handoff package.
- For the MVP that adapter is a **human running the generated command locally**;
  a self-hosted runner or worker can later implement the same adapter interface
  without redesigning the GitHub workflow.

No secrets, prompts, transcripts, or local credentials are ever written to the
durable, repository-visible run log — only the artifact **paths** are recorded.
The prompt/metadata files themselves live in the git-ignored
`.forge/runs/<issue>/<run-id>/` directory.

## Implemented sequence

1. **#142** — Issue intake structural validation.
2. **#143** — Issue-comment agent command router.
3. **#146** — Durable agent run log.
4. **#152** — PR creation contract + PR body template.
5. **#144** — Safe dispatch / bounded work-order generation.
6. **#153** — Controlled local Claude Code / Codex handoff adapter.
7. **#145** — PR acceptance-criteria contract checker.
8. **#354** — Dependency-aware readiness + tracking isolation + shared resolver.
9. **#147** — Plain-English operating guide.
