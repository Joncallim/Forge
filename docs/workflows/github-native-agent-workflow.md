# GitHub-Native Agent Workflow

This workflow lets Forge use GitHub Issues and pull requests as the source of
truth for agent-assisted work.

GitHub stays in charge of the durable record: the request starts as an issue,
the agent request is recorded on that issue, run state is stored as JSON in the
repository, and the final code review happens in a pull request.

Forge does not automatically run Claude Code or Codex from GitHub Actions. It
prepares a bounded work order and a handoff package. A human then runs the
selected tool locally or in another controlled environment.

## Human Workflow

1. Discuss the idea in ChatGPT or another planning surface.
2. File a GitHub issue using the Feature, Bug, Other, or Epic template.
3. The issue template includes a "Forge Control Metadata" section where you set
   `Execution mode: implementation` (or `tracking`) and `Depends on: #numbers`
   (or `none`).
4. Issue intake validates the issue structure, parses the control metadata, and
   computes **semantic readiness** — checking that all dependencies are resolved
   and the issue is dispatchable.
5. If the issue is ready, `ready-for-agent` is projected as a label. If
   dependencies are blocking, `dependency-blocked` is projected. If the issue
   is a tracking umbrella, `tracking-only` is projected.
6. A maintainer comments `claude implement` or `codex implement` on the issue.
7. The command router verifies semantic readiness via the shared resolver,
   checks the durable run log for existing runs, verifies collaborator
   permission, creates a run record, and applies `agent-requested`.
8. A maintainer starts the `Agent Dispatch` workflow manually with the issue
   number. Dispatch re-checks semantic readiness, then prepares a bounded work
   order.
9. Handoff generates `handoff.md`, `prompt.md`, and `metadata.json`.
10. The user runs Claude Code or Codex locally, or in another controlled
    environment, using the generated `prompt.md`. Before starting, run
    `npm run forge:check-readiness -- --issue-number <n>` to confirm the issue
    is still dispatchable.
11. The implementation pull request follows the PR contract.
12. The PR contract checker compares the pull request body with the source
    issue acceptance criteria and posts a review-support comment.
13. The user reviews, tests, and merges when satisfied.

## Readiness

Semantic readiness is the authoritative gate for all agent operations. It is
computed by the shared `IssueReadinessResolver` from current GitHub truth —
never from labels alone.

### Readiness states

| State | Label | Meaning |
| --- | --- | --- |
| Ready | `ready-for-agent` | Issue is dispatchable: valid structure, explicit control metadata, all dependencies satisfied. |
| Needs clarification | `needs-clarification` | Issue is missing required structure, control metadata, or has unresolvable dependency syntax. |
| Dependency blocked | `dependency-blocked` | Issue has one or more open or unresolved dependencies. |
| Tracking only | `tracking-only` | Issue is a tracking umbrella (Epic) and is not implementation-dispatchable. |
| Closed | (none) | Issue is closed and cannot be dispatched. |

**Labels are projections, not authority.** Command, dispatch, handoff, and the
pre-runtime check always re-resolve current semantic truth from the shared
resolver. A stale or manually spoofed `ready-for-agent` label cannot grant
authority.

### Control metadata

Every issue (except legacy Epics) must include these lines in the body:

```
Execution mode: implementation
Depends on: none
```

Or with dependencies:

```
Execution mode: implementation
Depends on: #123, #456
```

Tracking issues use `Execution mode: tracking`. The issue forms include a
prefilled "Forge Control Metadata" textarea that emits this canonical format.

## Labels

Forge uses these labels to show workflow state:

- `ready-for-agent` — **Readiness projection**: issue is semantically ready.
- `needs-clarification` — **Readiness projection**: issue needs author correction.
- `dependency-blocked` — **Readiness projection**: issue is blocked by dependencies.
- `tracking-only` — **Readiness projection**: issue is a tracking umbrella.
- `agent-requested` — A maintainer asked for implementation and a run record exists.
- `agent-running` — Reserved for a future runtime adapter.
- `agent-blocked` — Forge could not continue and posted the reason.
- `agent-pr-opened` — Reserved for a future step linking a PR to the run log.

## Supported Request Phrases

Put one supported phrase on the first non-empty line of an issue comment:

- `claude implement`
- `codex implement`
- `review`
- `checkpoint`
- `handoff`

Today, `claude implement` and `codex implement` create implementation run
records after verifying semantic readiness and collaborator permission. The
other phrases are recognized so Forge can give a clear response, but they do
not start implementation in this slice.

## Dispatch States

The durable run log uses one status field:

- `requested` means the command router accepted the request.
- `handed-off` means dispatch or handoff prepared bounded work, but no runtime started.
- `running` is reserved for a future controlled runtime adapter.
- `blocked` means Forge refused to continue and recorded a reason.
- `pr-opened` is reserved for a future step that links a pull request to the run.
- `completed`, `failed`, and `cancelled` are terminal or administrative states.

The durable run log is the single workflow-state truth. `agent-*` labels are
projections and must not override contradictory run-log state.

## Run Log Location

Each accepted request writes one JSON file:

```text
.forge/runs/<issue-number>/<run-id>.json
```

Those JSON records are committed to the dedicated `forge/agent-run-log` branch.
Workflows still execute trusted default-branch code. When they need to read or
update run records, they use a temporary worktree for the run-log branch and do
not run code from it.

The run log stores short state and event data. It must not store secrets,
credentials, model transcripts, raw prompts, or local auth material.

## Handoff Artifacts

Handoff generates:

```text
.forge/runs/<issue-number>/<run-id>/handoff.md
.forge/runs/<issue-number>/<run-id>/prompt.md
.forge/runs/<issue-number>/<run-id>/metadata.json
```

That nested directory is git-ignored. GitHub Actions uploads it as a workflow
artifact. Local handoff generation prints the file paths.

The durable run log records only those paths. It does not commit the prompt,
handoff, or metadata files.

## Pull Request Contract

Implementation pull requests should use the repository template:

```text
## Source Issue

Closes #<issue-number>

## Agent Run

Runtime: claude-code | codex | dry-run | manual
Run ID: <run-id or n/a>

## Summary

## Acceptance Criteria Validation

- [ ] <criterion> — evidence / notes

## Tests / Verification

## Risks / Follow-up
```

The source issue link can use:

- `Closes #123`
- `Fixes #123`
- `Resolves #123`
- `Issue: #123`

Use `Issue: #123` when the PR should link the issue but should not close it.

## PR Contract Checker

The checker reads the pull request body, finds the linked source issue, extracts
the issue acceptance criteria, and posts one marker-based comment.

It reads the issue link from the `Source Issue` section only. That avoids
accidentally treating a casual phrase elsewhere in the pull request body as the
source issue.

Each criterion is reported as:

- `claimed` when the PR mentions the criterion and includes useful evidence.
- `missing` when the PR does not mention the criterion.
- `needs-review` when the PR mentions the criterion but the evidence is generic
  or still looks like a placeholder.

The checker does not block merge by default. It helps reviewers find gaps; it
does not prove the implementation is correct.

## Pre-Runtime Readiness Check

Before starting Claude Code or Codex locally, run:

```bash
npm run forge:check-readiness -- --issue-number <n>
```

This uses the same shared resolver as command, dispatch, and handoff. It exits
0 only when `dispatchable=true`. It performs no label or comment mutations and
makes no model calls.

## Full Reconciliation

To recompute readiness for all open issues (e.g., after rollout or recovery):

```bash
npm run forge:reconcile -- --dry-run   # Preview only
npm run forge:reconcile                # Apply label projections
```

Or via GitHub Actions: run the `Reconcile Readiness` workflow with
`workflow_dispatch`.

Reconciliation uses plan → validate → apply phases. No bulk mutations are
performed from an incomplete repository snapshot. Safe ordering ensures
`ready-for-agent` is never left as a false positive.

## Safety Rules

- Do not run Claude Code or Codex automatically from GitHub Actions.
- Do not execute pull request code in the PR contract checker.
- Do not execute issue comments or generated prompt files.
- Do not run code from the `forge/agent-run-log` branch.
- Do not store secrets, credentials, transcripts, raw prompts, or local auth
  material in the durable run log.
- Keep workflow comments marker-based so reruns update one comment instead of
  creating duplicates.
- Semantic readiness from the shared resolver is authority. Labels are
  projections only.
- No model call occurs anywhere in readiness evaluation, parsing, graph
  resolution, projection, or admission.

## Rollback

If the readiness resolver has a production incident:
1. **Fail closed**: disable agent admission workflows (agent-command, dispatch,
   handoff) first.
2. **Do not restore** the old `template-valid -> ready-for-agent` logic while
   admission workflows are active.
3. Repair or revert the resolver.
4. Re-enable admission workflows only after the resolver is verified.

## Troubleshooting

If dispatch says no run record exists, make sure a maintainer first commented
`claude implement` or `codex implement` and that the command router completed.

If dispatch blocks on semantic readiness, check the issue's control metadata
(`Execution mode` and `Depends on` lines) and verify all dependencies are
closed as completed.

If handoff artifacts are missing from a GitHub Actions run, check the
`Agent Handoff` workflow summary and artifact upload step. The files are
git-ignored by design and should not appear in the repository diff.

If the PR checker cannot find a source issue, add a `Source Issue` section with
`Closes #123`, `Fixes #123`, `Resolves #123`, or `Issue: #123`.

If the PR checker says the linked issue could not be loaded, check for a typo or
for a cross-repository issue link. The current checker expects a same-repository
issue.

If the PR checker marks a criterion `needs-review`, replace generic text like
"done" with a concrete file, test, screenshot, or manual verification note.

## Related Docs

- [GitHub issue intake](../github-issue-intake.md)
- [GitHub agent run log](../github-agent-run-log.md)
- [GitHub agent PR contract](../github-agent-pr-contract.md)
- [GitHub-native workflow architecture](../github-native-agent-workflow-architecture.md)
