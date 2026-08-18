# Issue #187 Normative Architecture Amendments — Round 12

Status: **Normative.** Apply this together with the primary architecture and the normative Round-11 amendments. Where more restrictive, this document wins.

## B1. Repository snapshot includes symbolic HEAD identity

Extend repository identity evidence:

```ts
type GoalHeadReferenceStateV1 =
  | { kind: 'detached' }
  | {
      kind: 'symbolic'
      refDigest: KeyedRepositoryDigestV1
    }
```

The root-anchored Git profile captures:

- exact object format;
- full HEAD OID;
- `GoalHeadReferenceStateV1`;
- strict clean state;
- metadata/index/config/profile keyed fingerprints.

`repository_snapshot_fingerprint` includes all of the above.

Raw symbolic branch/ref name is used only inside the trusted verifier/audit boundary and need not appear in public goal/reliability evidence.

## B2. Operation verification-input fingerprint

Extend every `GoalOperationExecutionProfileV1` with a versioned pure constructor for trusted dynamic inputs that affect the deterministic verdict:

```ts
type GoalVerificationInputFingerprintV1 = {
  schemaVersion: 1
  digest: KeyedRepositoryDigestV1 | `sha256:${string}`
}
```

Rules:

- constructor accepts only trusted Forge context / already-validated repository evidence; never model/goal free text;
- operation run stores the resulting fingerprint before verdict;
- child evidence-unit fingerprint includes it;
- aggregate goal evidence unit includes the ordered child verification-input fingerprints;
- if a trusted input changes during a run, authority/evidence drift wins rather than a functional verdict.

For `repository.default-branch.verify@1`, input fingerprint contains:

```text
symbolic/detached HEAD state + keyed current-ref digest
validated configured default-branch keyed digest
project revision that supplied default_branch
operation/profile contract version
```

Same commit under different current refs therefore produces different evidence units.

## B3. Conservative project-default-branch validation

Introduce one shared proof-specific validator:

```ts
type ProjectDefaultBranchV1 = string & { readonly __brand: 'ProjectDefaultBranchV1' }
```

Minimum safe rules:

- non-empty bounded UTF-8;
- single line, no control/NUL;
- not absolute/path-escape shaped;
- no leading/trailing slash/dot ambiguity or Git-special sequences rejected by the v1 conservative grammar;
- normal common branch forms such as `main`, `master`, `develop`, `release/1.2` are supported;
- unsupported but possibly Git-valid exotic branch names fail closed rather than being guessed.

The operation never passes this value to a shell. Comparison is exact after validation.

Invalid current project value -> closed non-functional code `project_default_branch_unsupported`.

If implementation uses `git check-ref-format --branch` to avoid duplicating Git grammar, that call becomes a separately pinned **built-in** preflight profile using the trusted DB value as a bounded argv element, not a repository/model input. Either approach must have source-contract and injection tests.

## B4. Closed repository format/extensions profile

Add to `GoalRepositoryProfileV1` a normalized repository-format descriptor.

Allowed v1 combinations only:

```text
formatVersion=0
  extensions = {}
  objectFormat=sha1
  refStorage=files

formatVersion=1
  extensions.objectFormat=sha256
  no other extensions
  objectFormat=sha256
  refStorage=files
```

If the exact supported Git version requires an additional harmless format marker, add it only through a Git-safety-profile version bump + CI proof.

Explicitly unsupported:

```text
extensions.worktreeConfig
extensions.partialClone / promisor state
reftable / non-files ref storage
compatibility/transition object-format extensions
unknown repositoryFormatVersion
any unknown extensions.* key
```

Unknown extension does not mean "let Git decide". It yields `unsupported_repository_format_extension` and no decisive proof.

## B5. Worktree-specific config is unsupported v1

If `extensions.worktreeConfig` is true, or the repository otherwise activates `config.worktree`, profile result is unsupported with `worktree_config_unsupported`.

Forge does not merge, rewrite or ignore that file. A later profile may support it by explicitly inspecting/fingerprinting every effective config layer.

The hostile fixture must put a helper/filter/worktree redirection only in `config.worktree` and prove v1 refuses before any helper executes.

## B6. Residual concurrent-metadata threat boundary

Amend the primary residual threat statement:

V1 is **not** an OS sandbox against a separately running malicious process with the same host identity deliberately racing `.git` metadata between Forge validation and Git's own metadata open.

What v1 does guarantee:

- repository/worktree content and static Git config/attribute/helper surfaces are treated as untrusted and checked/neutralized per the Git safety profile;
- project-root pathname replacement is prevented at target launch by the retained root lease + anchored cwd check;
- ordinary concurrent Git/index/ref/config changes are detected by pre/post fingerprints and invalidate decisive evidence;
- stale Forge workers cannot author proof after DB/local lease fencing.

What requires a future OS-confined execution boundary:

- adversarial same-UID process races against `.git` metadata after the last validation;
- privileged host/kernel/process-memory/system-binary replacement.

This residual must appear in operator/security documentation and cannot be described as solved by repeated path checks.

## B7. Closed codes/tests

Add closed codes:

```text
project_default_branch_unsupported
worktree_config_unsupported
unsupported_repository_format_extension
```

Add the Round-12 default-branch evidence-unit matrix from the review file to mandatory E2E/reliability tests.
