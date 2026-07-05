# GitHub Issue Intake Validation

Forge can validate GitHub Issues before anyone asks an agent to implement them.
The goal is simple: make sure the issue body has the sections a coding agent
needs, then mark the issue as either ready or incomplete.

## What the validator checks

The validator is deterministic. It does not use an LLM.

It looks at the issue title and body, detects the issue type, and checks whether
the required sections are present and non-empty.

Supported issue types:

- `[FEATURE]`
- `[BUG]`
- `[OTHER]`
- `[EPIC]`

Required sections:

- Feature: `Problem Statement`, `Desired Outcome`, `User Story`,
  `Requirements`, `Acceptance Criteria`, `Implementation Scope`
- Bug: `Bug Summary`, `Current Behaviour`, `Expected Behaviour`,
  `Reproduction Steps`, `Impact`, `Severity`, `Acceptance Criteria`
- Other and Epic: `Issue Type`, `Context`, `Desired Outcome`, `Tasks`,
  `Acceptance Criteria`

GitHub form placeholders such as `_No response_` count as empty.

## What the workflow does

The workflow lives at `.github/workflows/issue-intake.yml`.

It runs when an issue is:

- opened
- edited
- reopened
- labeled

For each run, Forge:

1. reads the issue,
2. validates the required sections,
3. applies `ready-for-agent` when the issue is complete,
4. applies `needs-clarification` when the issue is incomplete,
5. removes the stale opposite label, and
6. updates one marker comment instead of posting duplicates.

That marker comment explains what is missing and what the author should fix.

## Local validation

From `web/`:

```bash
npm run forge:validate-issue:local -- \
  --title "[FEATURE] Example" \
  --body-file __tests__/__fixtures__/github-agent-workflow/feature-h3-form.md
```

The command prints a JSON validation result so fixture files and real issue
drafts can be checked without waiting for GitHub Actions.

## What this does not do

This validator does not:

- route agent commands,
- dispatch Codex or Claude Code,
- check pull requests against acceptance criteria, or
- generate runtime handoff packages.

Those are handled by later GitHub-native workflow issues.
