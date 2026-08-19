# Issue #187 Architecture Review — Round 8

Primary: `docs/architecture/issue-187-verification-goal-run-policy.md`

Status: **Two remaining execution-contract blockers found. Amendment required.**

## R8-F1 — root-anchored cwd does not automatically contain Git metadata indirection

Severity: Blocker

Angle: Git repository containment

Even when the target process inherits the correct worktree directory object, Git can intentionally resolve metadata outside that root:

- a `.git` **file** can point to another gitdir (linked worktree/submodule-style indirection);
- `.git/commondir` can redirect common metadata;
- local `.git/config` can contain `include.path` / `includeIf` pointing outside the repository;
- `.git/objects/info/alternates` can redirect object lookup;
- environment variables such as `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_INDEX_FILE` can redirect Git if inherited.

A root-anchored cwd therefore closes pathname substitution but not all Git metadata scope.

Required v1 amendment:

Before a repository can be decisively proven:

1. `<root>/.git` must be a real direct-child directory, not file/symlink; linked worktrees are explicitly unsupported v1;
2. `.git/commondir` must be absent;
3. `.git/objects/info/alternates` must be absent/empty;
4. local `.git/config` must be a bounded real file/no symlink and contain no `[include]`, `[includeIf ...]`, `include.path`, or other external config-source directive;
5. target Git invocation explicitly uses `--git-dir=.git --work-tree=.` so `core.worktree`/repository discovery cannot redirect the worktree;
6. the safe Git environment is allowlist-built rather than inherited and contains no redirecting `GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_INDEX_FILE` value;
7. known execution-capable config remains explicitly overridden/disabled as already required;
8. unsupported metadata shape -> inconclusive `unsupported_git_metadata_layout`, never path fallback.

The root command shim performs the metadata-layout check after it has anchored cwd and immediately before spawning Git; parent also captures a metadata fingerprint and post-command checks it. Concurrent metadata change -> inconclusive.

This does not claim defense against a privileged host adversary that can rewrite system binaries/kernel state; it closes repository/project-scope metadata redirection under Forge's current local threat model.

## R8-F2 — Git metadata layout/fingerprint must be proof evidence

Severity: High

Angle: Comparability

Required amendment:

Repository snapshot v1 includes a bounded `gitMetadataFingerprint` derived from the safe execution-relevant metadata contract, at least:

- `.git` directory identity;
- bounded direct local config digest after structural validation;
- HEAD/ref identity used for OID;
- index fingerprint;
- absence-state/domain for commondir/alternates;
- Git metadata contract version.

Do not store raw config content. Pre/post command mismatch invalidates result. Goal evidence-unit includes repository snapshot fingerprint and therefore captures metadata semantics.

## R8-F3 — execution binding pins OperationDefinition but not the concrete adapter contract

Severity: Blocker

Angle: Code semantic drift

The current Operation Catalog definition digest contains the logical operation definition/adapter kind, but fixed argv construction and adapter implementation live in code. A developer could change the command template/hardening semantics without changing operation id/version/definition digest. Environment build identity would show a new build, but explicit registry activation would not be required.

Required amendment:

Create a code-owned, versioned **operation execution profile** per goal-eligible operation:

```ts
type GoalOperationExecutionProfileV1 = {
  schemaVersion: 1
  operationId: string
  operationVersion: number
  adapterContractVersion: number
  commandTemplateDigest: string
  gitSafetyContractVersion: number
  deterministicVerifierContractVersion: number
  deterministicVerifierDigest: string
  rootLauncherContractVersion: number
}
```

The exact profile/digest is included in the registry entry execution binding/manifest v2.

Any semantic change to fixed argv construction, safety preamble, verifier behavior or required launcher contract changes this profile digest and makes the live registry differ from the last imported binding until the operator re-imports.

Build identity still records implementation build provenance, but it is not the only mechanism for operation-contract activation.

## R8-F4 — `--git-dir=.git --work-tree=.` must be part of the pinned command template

Severity: High

Angle: Adapter contract

For every eligible Git operation, the root shim spawns a command whose effective fixed template includes explicit repository/worktree binding plus command-specific argv. The template digest in R8-F3 covers those fixed prefixes and the required safety `-c` overrides. Model/repository text cannot alter them.

## R8-F5 — linked worktrees need a clear safe user-facing failure

Severity: Medium

Angle: Operator UX

Add closed terminal/admission code:

```text
linked_worktree_unsupported
```

and `unsupported_git_metadata_layout` for other rejected `.git` layouts. Read API/operator guide explains v1 supports ordinary non-bare standalone repositories only. A later version may add a second trusted git-metadata lease/common-dir contract.

## R8-F6 — metadata checks must not log local config contents

Severity: High

Angle: Secret leakage

Local Git config can contain credential-related values. Structural inspection/fingerprinting is in-memory and returns only safe booleans/fixed reason codes/digests. No raw config content enters logs, run events, audits, API, Redis, or failure messages.

## R8-F7 — adapter/verifier profile parity needs a source-contract test

Severity: High

Angle: Maintenance

Add a test/manifest that enumerates every `manual_only|manual_and_scheduled` goal-eligible operation and asserts it has exactly one execution profile. Mutation/version tests prove changing fixed argv/verifier/safety contract without updating the profile digest/version fails the contract suite.

## Round 8 conclusion

Round 8 found two remaining architecture blockers: Git metadata indirection and unpinned concrete adapter/verifier semantics. After amendment, run another fresh full review rather than only checking these findings.
