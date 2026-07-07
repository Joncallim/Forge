# GitHub Agent Pull Request Contract

Every implementation pull request in the GitHub-native agent workflow must point
back to the issue it came from. That link lets a reviewer see the original
request, the acceptance criteria, the agent run that prepared the work, and the
tests the author says they ran.

This is traceability and review support. It is not proof that the code is
correct.

## Required Sections

Forge uses the same section names in the pull request template, generated agent
prompts, and the pull request checker:

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

The shared section list lives in
`web/scripts/github-agent-workflow/contracts/pr-contract-sections.ts`.

## Source Issue Link

The `Source Issue` section must include one supported link phrase:

- `Closes #123`
- `Fixes #123`
- `Resolves #123`
- `Issue: #123`

`Closes`, `Fixes`, and `Resolves` use GitHub's normal closing keywords. `Issue:
#123` is available when a pull request should be linked for review but should
not automatically close the issue.

Every implementation pull request needs this link because Forge reads the source
issue to find the acceptance criteria. Without it, a reviewer has to guess what
the pull request is supposed to satisfy.

## Acceptance Criteria Validation

Agents should copy each source issue acceptance criterion into the `Acceptance
Criteria Validation` section and add short evidence or notes.

Good examples:

```text
- [x] Dispatch refuses closed issues — covered by github-agent-dispatch.test.ts.
- [x] Handoff artifacts stay git-ignored — verified with git check-ignore and unit test.
- [ ] Documentation updated — not done; follow-up needed.
```

Weak examples:

```text
- [x] Dispatch refuses closed issues — done.
- [x] Handoff artifacts stay git-ignored — implemented.
```

Those weak examples may be true, but they do not help a reviewer find the code,
test, or manual check that supports the claim.

Agents must not claim validation they did not run. If a test was skipped, the
pull request should say that plainly in `Tests / Verification`.

## How The Checker Reads It

Issue #145 adds a non-blocking pull request checker. The checker does three
things:

1. Reads the pull request body and finds the linked source issue.
2. Reads the source issue's `Acceptance Criteria` section.
3. Compares each criterion with the pull request's `Acceptance Criteria
   Validation` section.

The checker reports each criterion as:

- `claimed` when the criterion is present and has useful evidence or notes.
- `missing` when the criterion is absent from the validation section.
- `needs-review` when the criterion is mentioned but the evidence is generic,
  empty, or still looks like the template placeholder.

The checker does not block merge by default. It posts one marker-based comment
so the result updates in place instead of creating duplicate comments.

