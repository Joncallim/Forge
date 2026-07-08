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
2. File a GitHub issue using the Feature, Bug, or Other template.
3. Issue intake validates the issue and applies `ready-for-agent`, or applies
   `needs-clarification` when required information is missing.
4. A maintainer comments `claude implement` or `codex implement` on the issue.
5. The command router creates a run record and applies `agent-requested`.
6. A maintainer starts the `Agent Dispatch` workflow manually with the issue
   number. Dispatch checks the issue and run record, then prepares a bounded
   work order.
7. Handoff generates `handoff.md`, `prompt.md`, and `metadata.json`.
8. The user runs Claude Code or Codex locally, or in another controlled
   environment, using the generated `prompt.md`.
9. The implementation pull request follows the PR contract.
10. The PR contract checker compares the pull request body with the source
    issue acceptance criteria and posts a review-support comment.
11. The user reviews, tests, and merges when satisfied.

## Labels

Forge uses these labels to show workflow state:

- `ready-for-agent` means the issue has enough detail for bounded agent work.
- `needs-clarification` means a human must clarify the issue before agent work.
- `agent-requested` means a maintainer asked for implementation and a run record
  exists.
- `agent-running` is reserved for a future runtime adapter that actually starts
  work.
- `agent-blocked` means Forge could not continue and posted the reason.
- `agent-pr-opened` is reserved for a future step that links a pull request back
  to the run log. The PR checker does not set it in this slice.

## Supported Request Phrases

Put one supported phrase on the first non-empty line of an issue comment:

- `claude implement`
- `codex implement`
- `review`
- `checkpoint`
- `handoff`

Today, `claude implement` and `codex implement` create implementation run
records. The other phrases are recognized so Forge can give a clear response,
but they do not start implementation in this slice.

## Dispatch States

The durable run log uses one status field:

- `requested` means the command router accepted the request.
- `handed-off` means dispatch or handoff prepared bounded work, but no runtime
  started.
- `running` is reserved for a future controlled runtime adapter.
- `blocked` means Forge refused to continue and recorded a reason.
- `pr-opened` is reserved for a future step that links a pull request to the run.
- `completed`, `failed`, and `cancelled` are terminal or administrative states.

Issue #144 used the word `accepted` for dispatch. Forge maps that to
`handed-off` in the run log so there is not a second status model.

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

## Safety Rules

- Do not run Claude Code or Codex automatically from GitHub Actions.
- Do not execute pull request code in the PR contract checker.
- Do not execute issue comments or generated prompt files.
- Do not run code from the `forge/agent-run-log` branch.
- Do not store secrets, credentials, transcripts, raw prompts, or local auth
  material in the durable run log.
- Keep workflow comments marker-based so reruns update one comment instead of
  creating duplicates.

## Troubleshooting

If dispatch says no run record exists, make sure a maintainer first commented
`claude implement` or `codex implement` and that the command router completed.

If dispatch blocks on labels, remove `needs-clarification` only after the issue
has been clarified, and make sure `ready-for-agent` is present.

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
