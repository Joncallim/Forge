# Orthogonal Code Review Skill

Use this skill whenever Jonathan asks to review code, review an implementation, review a pull request, check a fix, verify a task, do another review pass, or see whether anything was missed.

Do not perform a single generic review pass. Run separate orthogonal passes with distinct objectives, then report both findings and coverage. A review is not complete just because one pass found nothing.

## Core rule

A full review is complete only when each required angle has been checked, findings are separated by angle, and unverified areas are explicitly listed. A quick review is complete when at least two relevant independent angles were checked and every omitted angle is disclosed.

## Review depth

- **Full review** — use for pull requests, implementations, merge/readiness decisions, broad fixes, security-sensitive work, or requests for a comprehensive/another sweep. Run all relevant passes below and explain any pass that is not applicable.
- **Quick review** — use only for a trivial or explicitly narrow check. Run at least two relevant independent angles, keep the report compact, and list the full-review passes not run. Escalate to full review if scope, risk, or evidence is uncertain.

Do not turn a one-line or clearly bounded check into a ceremonial ten-pass report. Do not use quick mode to weaken a PR, merge, security, or release review.

## Safety and authority

Review is read-only unless the user explicitly asks for fixes. Report findings before editing. A review recommendation never bypasses tests, continuous integration, MCP/tool admission, security policy, repository-write controls, human approval, or merge authority. Recommend merge or changes; do not claim to grant approval.

Never say:

- "No issues exist."
- "This is fully clean."
- "Nothing else can be found."

Use scoped language instead:

- "No blockers found in the inspected scope."
- "Remaining uncertainty: ..."
- "Not covered: ..."

## Required output format

### Review Verdict

Status: Blocked / Needs changes / No blockers found in inspected scope

Confidence: Low / Medium / High

Reason: One short paragraph.

### Findings

For each finding, use this structure:

- Severity: Blocker / High / Medium / Low / Nit
- Disposition: Blocking / Advisory
- Angle:
- Evidence:
- File / location:
- Why it matters:
- Suggested fix:
- Verification:

### Orthogonal Pass Coverage

| Pass | Checked | Findings | Not Covered |
|---|---:|---:|---|
| Contract / requirements | Yes/No | Count | Notes |
| Diff correctness | Yes/No | Count | Notes |
| Call-path / runtime flow | Yes/No | Count | Notes |
| State / data / persistence | Yes/No | Count | Notes |
| Error handling / recovery | Yes/No | Count | Notes |
| Tests / CI / verification | Yes/No | Count | Notes |
| Security / permissions / secrets | Yes/No | Count | Notes |
| UX / API / operator experience | Yes/No | Count | Notes |
| Regression / compatibility | Yes/No | Count | Notes |
| Evidence / release readiness | Yes/No | Count | Notes |

### Required Next Actions

List only concrete actions.

Blocking findings must be addressed before completion or merge. Advisory findings may be deferred when the residual risk and owner are explicit.

### Final Statement

If no blockers were found, use this form:

> No blockers were found in the inspected scope. This does not prove absence of defects. The remaining unchecked areas are: ...

If findings were found, use this form:

> Review found issues that should be addressed before treating this as complete.

## Review passes

### 1. Contract / requirements review

Compare the implementation against the user request, GitHub issue, acceptance criteria, README, design docs, prior review comments, and stated non-goals.

Look for missing requirements, accidental scope expansion, incorrect interpretation, incomplete edge cases, and work marked done without evidence.

Do not inspect style here unless it affects the contract.

### 2. Diff correctness review

Inspect changed files only.

Look for obvious bugs, wrong imports, dead code, inconsistent naming, broken types, incorrect assumptions, missing awaits, incorrect null handling, accidental deletion, and hidden coupling.

Do not drift into architecture unless directly caused by the diff.

### 3. Call-path / runtime flow review

Trace how the code actually runs.

Look for broken control flow, unreachable branches, invalid lifecycle ordering, async races, queue or worker timing bugs, missing initialization, cleanup gaps, duplicate execution, and incorrect retry behavior.

Prefer concrete traces over intuition.

### 4. State / data / persistence review

Review how data changes over time.

Look for stale state, incorrect database writes, missing migrations, non-idempotent updates, partial writes, incorrect cache assumptions, inconsistent source-of-truth handling, data loss, wrong serialization, and missing rollback paths.

For Forge work, pay special attention to task state, work-package state, review gates, run logs, command audits, and repository-affecting writes.

### 5. Error handling / recovery review

Assume things fail.

Look for swallowed errors, misleading success states, missing recovery paths, cleanup after failure, retry safety, timeout behavior, external command failure, API failure, partial execution, and poor operator visibility.

Ask: what happens after this fails halfway?

### 6. Tests / CI / verification review

Check whether the implementation is proven.

Look for missing tests, tests that do not assert the real behavior, tests that would pass even if broken, untested edge cases, stale snapshots, CI not running the relevant path, lint/typecheck not run, and missing manual verification.

Separate evidence actually seen, evidence claimed by the agent, and evidence still needed.

### 7. Security / permissions / secrets review

Look for secret leakage, unsafe shell execution, path traversal, overbroad file writes, missing confirmation before destructive actions, credential exposure in logs, unsafe browser or MCP access, and confused-deputy behavior.

For agent systems, check tool permissions, prompt-injection surfaces, and whether the agent can affect files it should not.

### 8. UX / API / operator experience review

Review from the human/operator perspective.

Look for confusing status messages, unclear failure states, missing logs, bad names, misleading UI, hard-to-debug output, missing documentation, unclear commands, and bad defaults.

Ask: would Jonathan know what happened and what to do next?

### 9. Regression / compatibility review

Compare against existing behavior.

Look for broken workflows, changed public APIs, changed CLI behavior, changed config defaults, migration risks, backwards-incompatible assumptions, changed file layout, and changed environment assumptions.

Do not assume a new implementation is better just because it is cleaner.

### 10. Evidence / release readiness review

Check whether the work is safe to merge, ship, or mark complete.

Look for unresolved prior findings, missing test runs, missing logs, stale docs, missing screenshots or artifacts where relevant, missing manual verification, unknown risks, and missing rollback path.

Final status must be based on evidence, not confidence alone.

## Anti-patterns

Do not:

- combine all review concerns into one broad pass
- declare the code clean without listing coverage
- rely on previous agent claims
- trust generated summaries over files, tests, logs, and diffs
- repeat the same review prompt until the model gives up
- hide uncertainty
- treat "no findings" as proof

## Follow-up review after fixes

After a fix, first run a regression pass against the previous findings. Then run fresh passes for call-path, tests, error recovery, state/persistence, and evidence readiness.

This prevents the review from only checking whether the old finding was patched and forces the reviewer to look for new issues introduced by the fix.

## Operating principle

LLM review is adversarial hypothesis generation.

Tests, CI, logs, type checks, and reproducible traces are evidence.

A good review increases confidence by making both findings and remaining uncertainty explicit.
