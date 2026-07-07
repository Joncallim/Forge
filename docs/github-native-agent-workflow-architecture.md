# GitHub-Native Agent Workflow — Implementation Architecture

This is the **implementation architecture map** for Epic
[#141](https://github.com/Joncallim/Forge/issues/141), not the end-user operating
guide. The plain-English workflow guide is owned by
[#147](https://github.com/Joncallim/Forge/issues/147).

Its job is to make sure the remaining features
(#144, #145, #147, #152, #153) build on **one** set of contracts, one status
model, one prompt shape, and one file layout — instead of each feature inventing
its own.

All workflow code lives under `web/scripts/github-agent-workflow/`.

## What has landed

| Issue | Feature | Where |
| --- | --- | --- |
| #142 | Issue intake validation | `core/issue-validation.ts`, `shared/issue-validation-runner.ts`, `.github/workflows/issue-intake.yml` |
| #143 | Issue-comment agent command router | `core/agent-command.ts`, `agent-command.ts`, `.github/workflows/agent-command.yml` |
| #146 | Durable agent run log | `io/agent-run-log.ts`, `contracts/agent-run-record.ts`, [`docs/github-agent-run-log.md`](./github-agent-run-log.md) |

The run log at `.forge/runs/<issue-number>/<run-id>.json` is the **source of
truth for workflow state**. Everything below reads and writes that record; it
does not add a second status store.

## What remains

| Issue | Feature | CLI (placeholder today) |
| --- | --- | --- |
| #152 | Agent PR creation contract + PR body template | — (template + docs) |
| #144 | Safe agent dispatch / bounded work-order generation | `dispatch.ts` (`forge:dispatch`) |
| #153 | Controlled Claude Code / Codex handoff adapter | `handoff.ts` (`forge:handoff`) |
| #145 | PR acceptance-criteria contract checker | `pr-contract.ts` (`forge:pr-contract`) |
| #147 | Plain-English workflow documentation | `docs/` |

The three remaining CLIs are **fail-closed placeholders**: they throw a
contract-aware message naming the owning issue and the shared modules to use,
rather than pretending a feature ran.

## Workflow states

There is exactly one status enum: `RUN_STATUS_VALUES` in `contracts/common.ts`.

| Status | Meaning |
| --- | --- |
| `requested` | Command router (#143) accepted a request and wrote a run record. |
| `handed-off` | Dispatcher (#144) produced a bounded work order / handoff package, but **no runtime has started**. |
| `running` | A real runtime adapter has started work. |
| `blocked` | The workflow refused to proceed; a `blockedReason` is recorded. |
| `pr-opened` | A pull request was linked to the run. |
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
| `common.ts` | Primitives: run id, run status + dispatch-state mapping, runtime, action, PR criterion status, source ref, handoff-artifacts shape. |
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
| `branch-names.ts` | `buildAgentBranchName` — deterministic, git-ref-safe. | #144, #153 |
| `work-order.ts` | `buildWorkOrder` / `renderWorkOrder` — canonical, bounded sections. | #144, #153 |
| `acceptance-criteria.ts` | `extractAcceptanceCriteria` — one checklist parser, reusing `core/sections.ts`. | #144, #145 |
| `pr-contract.ts` | `extractSourceIssueReference` + PR section titles. | #145, #152 |
| `handoff.ts` | `buildHandoffArtifacts` — predictable artifact paths in the existing `handoffArtifacts` shape. | #153 |
| `workflow-architecture.ts` | Ownership map + fail-closed placeholder messages. | placeholders, docs |
| `agent-command.ts`, `issue-validation.ts`, `sections.ts`, `labels.ts` | Landed behaviour. | #142/#143 |

## I/O and CLI

- `io/github-client.ts` — `fetch`-based GitHub client (no Octokit) + `GitHubClient` interface.
- `io/fake-github-client.ts` — in-memory test double.
- `io/agent-run-log.ts` — the durable run log and its git-persistence path (#146).
- `io/event.ts` — reads `GITHUB_EVENT_PATH`.
- `cli/entrypoint.ts` — `runMain` (only executes when run directly).
- `cli/bootstrap-labels.ts` — creates the six workflow labels + `needs-triage`.
- Root CLIs (`agent-command.ts`, `dispatch.ts`, `pr-contract.ts`, `handoff.ts`) — thin wiring; `forge:*` npm scripts point here.

## Why dispatch is explicit, not automatic

FORGE never runs a coding agent on every new issue. The workflow requires two
human gates before any runtime could start:

1. **Readiness** — intake validation (#142) must have applied `ready-for-agent`.
2. **Explicit request** — a maintainer with write access must comment a supported
   command (#143), which is what writes the `requested` run record.

Dispatch (#144) then only produces a **bounded work order** and moves the run to
`handed-off`. It does not execute Claude Code or Codex. This avoids an
unconstrained always-on bot and keeps every step traceable in the run log.

There is also a hard operational reason automatic PR creation stays out of scope:
GitHub's default `GITHUB_TOKEN` does not trigger downstream workflows, so an
auto-created PR would silently skip `pr-contract-check` and the label-transition
chain. Any future automation needs a PAT or GitHub App token, documented in #147.

## How #152, #144, #153, and #145 fit together

```
#152  PR body contract  ─┐  (defines the sections agents must write and #145 parses)
                         │
#144  dispatch  ─────────┼─►  work order (bounded prompt + branch name + run record: handed-off)
                         │
#153  handoff   ─────────┼─►  runtime artifacts under .forge/runs/<issue>/<run-id>/
                         │        (prompt embeds the #152 PR contract; run log records paths)
                         │
#145  PR checker ────────┘  reads the #152 sections + source-issue acceptance criteria,
                            reports claimed / missing / needs-review per criterion.
```

- **#152 comes first (or alongside #145)** because it defines the predictable PR
  body structure both #144/#153 instruct agents to produce and #145 parses. The
  shared section constants (`pr-contract-sections.ts`) exist so the template and
  the checker cannot drift.
- **#144** turns a `requested` run into a bounded work order and moves it to
  `handed-off`. It consumes `branch-names.ts`, `work-order.ts`, and
  `acceptance-criteria.ts`.
- **#153** consumes the #144 work order and emits runtime-specific handoff
  artifacts, recording their paths on the run log via the existing
  `handoffArtifacts` shape. It embeds the #152 PR contract in the generated
  prompt.
- **#145** consumes the #152 PR sections and the source issue's acceptance
  criteria (via the shared parsers) to produce a review aid — **not** proof of
  correctness, and it does not block merges by default.

## Where future runtime execution plugs in

Everything above stops at **artifact generation**. The point where a real runtime
would start is a single, isolated boundary:

- The run status crosses from `handed-off` to `running`.
- A runtime adapter (`dry-run` | `claude-code` | `codex`, per
  `AGENT_RUNTIME_VALUES`) consumes the #153 handoff package.
- For the MVP that adapter is a **human running the generated command locally**;
  a self-hosted runner or worker can later implement the same adapter interface
  without redesigning the GitHub workflow.

No secrets, prompts, transcripts, or local credentials are ever written to the
durable, repository-visible run log — only the artifact **paths** are recorded.
The prompt/metadata files themselves live in the git-ignored
`.forge/runs/<issue>/<run-id>/` directory.

## Recommended implementation sequence

1. **#152** — PR creation contract + PR body template (defines the shape #144/#153 emit and #145 parses).
2. **#144** — safe dispatch / bounded work-order generation.
3. **#153** — controlled local Claude Code / Codex handoff adapter.
4. **#145** — PR acceptance-criteria contract checker.
5. **#147** — plain-English operating guide, written once the contracts are stable.
