# Issue #187 Architecture Review — Round 12

Primary architecture = `issue-187-verification-goal-run-policy.md` plus the normative Round-11 amendments.

Status: **Four material evidence/repository-profile gaps and one threat-boundary clarification found. Amendment required.**

## R12-F1 — evidence units omit symbolic HEAD / operation input state

Severity: Blocker

Angle: Evidence comparability / reliability

The new `repository.default-branch.verify@1` exposes a flaw in the current evidence-unit definition. The same commit OID can be checked out on two branch names. A run on the configured default branch can pass while a run on another branch pointing to the same commit can functionally fail.

If the repository/evidence-unit identity contains only the OID/profile/policy/environment, these two materially different states collapse into one evidence unit and are incorrectly reported as nondeterminism.

Required amendment:

- repository identity evidence records a closed symbolic-HEAD state:
  - `detached`, or
  - `symbolic` plus a **keyed** HMAC fingerprint of the canonical current branch/ref name;
- raw branch/ref names need not enter public proof evidence;
- repository snapshot fingerprint includes the symbolic-HEAD state/fingerprint;
- more generally, every `GoalOperationExecutionProfileV1` may define a bounded `verificationInputFingerprint` over trusted dynamic state that affects the deterministic verdict;
- child and aggregate evidence-unit fingerprints include that exact operation verification-input fingerprint;
- repeated evidence is comparable only when those trusted verification inputs are identical.

For `repository.default-branch.verify@1`, the verification-input fingerprint covers at least:

```text
current symbolic-HEAD state/fingerprint
configured default-branch fingerprint
project revision bound to the configured default branch
```

Thus same OID on a different branch is a different evidence unit, not unstable evidence.

## R12-F2 — `projects.default_branch` is unconstrained text and must not silently become verifier authority

Severity: High

Angle: Trusted configuration validation

The current database schema stores `projects.default_branch` as ordinary text. The new operation treats it as authoritative verifier input. Invalid/control-character/unsupported values must not become a functional mismatch or enter command construction.

Required v1 amendment:

- add one shared conservative `ProjectDefaultBranchV1` validator for proof use;
- it accepts only a bounded canonical branch-name subset sufficient for Forge's supported projects and rejects control characters, empty values, path escape-like forms and unsupported ref syntax;
- rejected value -> non-functional `project_default_branch_unsupported` and no child functional verdict;
- the expected branch is used only for in-memory deterministic comparison; it is never shell text;
- if a future implementation chooses Git `check-ref-format`, it must be a separately pinned built-in command profile using trusted DB argv, not model/repository input;
- project default-branch change during a run remains project-authority drift/inconclusive.

A later project-schema hardening PR may validate default branches more broadly, but #187 must not assume that already exists.

## R12-F3 — `extensions.worktreeConfig` adds an uninspected repository config file

Severity: Blocker

Angle: Git config containment

Git can load `$GIT_DIR/config.worktree` in addition to `.git/config` when `extensions.worktreeConfig` is enabled. The current v1 profile validates only `.git/config`. Even on the main/standalone worktree, `config.worktree` can override settings and potentially reintroduce execution/redirection semantics.

Required v1 amendment:

- `extensions.worktreeConfig=true` is unsupported for decisive v1 goal execution;
- if the key is enabled or `.git/config.worktree` is present in an effective form, repository profile returns `worktree_config_unsupported`;
- do not attempt to rewrite/disable it;
- sparse checkout was already unsupported and often enables this extension; this rule closes the config surface independently of sparse detection;
- adversarial fixture places an execution-bearing setting only in `config.worktree` and proves no target/helper executes.

A future profile may inspect both files under a more general worktree-aware metadata contract.

## R12-F4 — repository-format extensions/ref storage need a closed allowlist

Severity: Blocker

Angle: Git metadata format compatibility

The current metadata profile assumes files-based refs/config/index and explicitly supports SHA-1/SHA-256, but modern Git can use repository-format extensions that change metadata interpretation, including alternative ref storage.

Required v1 amendment:

Parse the bounded repository-format header from local config and allow only the exact supported combinations:

```text
repositoryFormatVersion 0 with no extensions              -> SHA-1 files profile
repositoryFormatVersion 1 + extensions.objectFormat=sha256 -> SHA-256 files profile
```

plus any other exact field that CI proves is required for these ordinary profiles.

Reject by default:

- `extensions.worktreeConfig`;
- partial/promisor extension;
- reftable/alternative ref storage;
- compatibility object-format/unknown transition format;
- every unknown `extensions.*` key or repository-format version.

Closed reason: `unsupported_repository_format_extension` (or a more specific existing code).

Do not infer support because the installed Git binary can open the repository. Goal proof supports only the architecture's explicitly reviewed metadata layout.

## R12-F5 — malicious same-UID concurrent `.git` mutation is not closed by the portable root shim

Severity: High

Disposition: Residual threat clarification, not a new implementation workaround

Angle: Threat model honesty

The retained project-root handle closes root-path rebinding. The root shim validates `.git` immediately before spawning Git and post-checks metadata afterwards. However, Git itself subsequently opens relative `.git` metadata. A separately running adversarial process with the same host user can theoretically replace `.git/config`, index or metadata in the narrow validation-to-open window.

Closing that against a malicious concurrent same-UID actor portably requires a stronger OS-enforced execution/container/filesystem snapshot boundary or a descriptor-addressable Git metadata design, not another pathname recheck.

Required clarification:

- v1 defends against hostile repository/worktree content at rest, rejected Git config/attribute/helper surfaces, stale workers, root-path replacement, and **ordinary** concurrent Git/worktree changes by detecting drift before/after and suppressing decisive evidence;
- v1 does **not** claim sandbox isolation against a separately running malicious same-UID process deliberately racing Git metadata after validation;
- such an actor joins privileged-host/process-memory replacement in the residual host threat class for #187;
- enabling side-effecting/broader repository code later requires the OS-enforced confined execution boundary already identified elsewhere in Forge's roadmap;
- release/security documentation must state this plainly.

This clarification prevents the architecture from overstating the root shim's guarantee.

## R12-F6 — default-branch verifier changes the evidence/history semantics and needs dedicated tests

Severity: High

Angle: Testability / downstream behavior

Add controlled fixtures:

1. same OID, configured-default symbolic branch -> pass;
2. same OID, other symbolic branch -> functional fail;
3. same OID, detached HEAD -> functional fail;
4. invalid configured default branch -> inconclusive/non-functional;
5. toggling another branch to the same OID produces a **different** evidence unit rather than `unstable`;
6. repeated pass on identical default-branch state/commit/policy/env counts one promotion-grade evidence unit;
7. project default-branch change makes prior registry/run authority stale and requires re-import/requalification according to the primary rules.

## Round 12 conclusion

The architecture still had hidden evidence-comparability and Git-format assumptions. They are bounded: add symbolic-HEAD/operation-input fingerprints, validate trusted default-branch configuration, reject worktreeConfig/unknown repository-format extensions, and state the same-UID race residual honestly. After those amendments, run a fresh full review again.