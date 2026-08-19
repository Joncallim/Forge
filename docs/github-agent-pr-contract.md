# GitHub Agent Pull Request Contract

Every delivery pull request in the GitHub-native agent workflow must point back
to the issue it came from. A **delivery PR** may be implementation-only or a
combined architecture+implementation PR. Architecture-first remains required for
cross-cutting changes, but Forge does not require a separate architecture PR
unless there is a concrete safety, dependency, or review reason to split the
work.

That link lets a reviewer see the original request, the acceptance criteria, the
agent run that prepared the work, the architecture evidence when applicable, the
implementation evidence, and the tests the author says they ran.

This is traceability and review support. It is not proof that the code is
correct.

## Delivery Modes

A PR should identify one delivery mode in the `Agent Run` section:

- `combined` — architecture, implementation, QA, and review progress are carried
  in one draft delivery PR. This is the normal choice when they belong to one
  coherent source issue.
- `architecture` — architecture-only by explicit scope. This does **not** satisfy
  implementation acceptance criteria unless the source issue/user explicitly
  scoped the PR to architecture only.
- `implementation` — implementation against an already accepted architecture or
  a change small enough not to require a new architecture contract.

`Architect first` is an ordering rule inside a combined PR, not a phase-specific
PR rule. Specialist agents may continue on the same branch/PR as ownership moves
from Architect to Backend/Frontend/DevOps/QA/Reviewer.

## Required Sections

Forge uses the same section names in the pull request template, generated agent
prompts, and the pull request checker:

```text
## Source Issue

Closes #<issue-number>

## Agent Run

Runtime: claude-code | codex | dry-run | manual
Run ID: <run-id or n/a>
Delivery mode: combined | architecture | implementation

## Summary

Architecture evidence: <design / ADR / invariant references or n/a>
Implementation evidence: <code / migration / behavior references or n/a>
Remaining delivery scope: <remaining work in this PR or none>

## Acceptance Criteria Validation

- [ ] <criterion> — evidence / notes

## Tests / Verification

## Risks / Follow-up
```

The shared section list lives in
`web/scripts/github-agent-workflow/contracts/pr-contract-sections.ts`. The
template renderer lives in
`web/scripts/github-agent-workflow/core/pr-contract.ts`.

## Combined PR Rules

For a combined delivery PR:

1. Establish the architecture contract before or alongside the first dependent
   implementation change.
2. Keep implementation traceable to architecture decisions/invariants and source
   acceptance criteria.
3. Keep the PR draft while implementation or required verification is incomplete.
4. Do not mark a source issue complete merely because architecture is complete
   when implementation acceptance criteria remain.
5. Keep internal slices and commits reviewable even though they share one PR.
6. QA, Security/Adversarial, migration, CI, and human approval gates remain in
   force. Combined delivery never bypasses them.
7. Update `Remaining delivery scope` as slices land so the PR says what is still
   missing instead of implying future work is complete.

## Source Issue Link

The `Source Issue` section must include one supported link phrase:

- `Closes #123`
- `Fixes #123`
- `Resolves #123`
- `Issue: #123`

`Closes`, `Fixes`, and `Resolves` use GitHub's normal closing keywords. `Issue:
#123` is available when a pull request should be linked for review but should
not automatically close the issue.

Every delivery pull request needs this link because Forge reads the source issue
to find the acceptance criteria. Without it, a reviewer has to guess what the
pull request is supposed to satisfy.

## Acceptance Criteria Validation

Agents should copy each source issue acceptance criterion into the `Acceptance
Criteria Validation` section and add short evidence or notes.

Good examples:

```text
- [x] Dispatch refuses closed issues — covered by github-agent-dispatch.test.ts.
- [x] Handoff artifacts stay git-ignored — verified with git check-ignore and unit test.
- [ ] Scheduled proof runs deduplicate — scheduler slice not implemented yet in this draft PR.
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

1. Reads the pull request body's `Source Issue` section and finds the linked
   source issue.
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

If the `Source Issue` section points at an issue that GitHub cannot load, the
checker reports that in the marker comment instead of failing the workflow.
